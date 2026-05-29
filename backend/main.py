"""
Халяль Маркет — Flask: статика frontend, загрузки изображений, API каталога, Telegram-бот.
Деплой: Gunicorn (main:app), PUBLIC_URL из переменных окружения.
"""

from __future__ import annotations

import sys
import os

# Добавляем корневую папку в путь
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import io

import datetime
import json
import math
import sqlite3
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import requests
import telebot
from telebot import types
from telebot.types import KeyboardButton, ReplyKeyboardMarkup, ReplyKeyboardRemove
from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory
from flask_caching import Cache
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.utils import secure_filename
from PIL import Image

from .config import (
    ENV_FILE,
    PROJECT_ROOT,
    PUBLIC_URL,
    config,
    get_app_base_url,
    get_database_path,
    get_frontend_root,
    get_products_path,
    get_uploads_dir,
    load_project_dotenv,
)
from .product_model import (
    Product,
    deduct_piece_stock_for_cart,
    normalize_discount_value,
    normalize_products_payload,
    normalize_stock_quantity,
    normalize_unit_type,
    product_is_in_stock,
    product_is_weight_item,
    sync_product_stock_fields,
)
from .cloudinary_upload import (
    upload_category_image,
    upload_product_image,
)
from .db_products import (
    delete_category_from_db,
    delete_product_from_db,
    load_categories_from_db,
    load_products_from_db,
    migrate_json_to_db,
    persist_products_document_to_db,
    save_category_to_db,
    save_product_to_db,
)

_products_catalog_cache_invalidate = None


def register_products_catalog_cache_invalidate(callback) -> None:
    global _products_catalog_cache_invalidate
    _products_catalog_cache_invalidate = callback


def persist_products_document(document: dict) -> None:
    """Сохраняет каталог в БД (вместо JSON)."""
    from .db_products import persist_products_document_to_db

    products = document.get("products") or []
    categories = document.get("categories") or []
    print(
        f"persist_products_document: {len(categories)} categories, "
        f"{len(products)} products",
        flush=True,
    )
    persist_products_document_to_db(document)
    if _products_catalog_cache_invalidate is not None:
        _products_catalog_cache_invalidate()
    print("persist_products_document: OK", flush=True)


def apply_piece_stock_deduction_for_order(cart_lines: list[dict]) -> bool:
    """Списывает штучные товары со склада после успешного оформления/оплаты."""
    document = load_products_document()
    products = document.get("products", [])
    if not isinstance(products, list):
        return False

    changed = deduct_piece_stock_for_cart(cart_lines, products=products)
    if changed:
        persist_products_document(document)
        print("📦 Остатки штучных товаров обновлены после заказа.")
    return changed

JSON_CHARSET = "utf-8"

ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
TRACKING_VIDEO_EXT = {".mp4", ".mov", ".webm"}
ALLOWED_TRACKING_MEDIA_EXT = ALLOWED_IMAGE_EXT | TRACKING_VIDEO_EXT
TRACKING_STATUS_MEDIA_KEYS = ("active", "delivery", "completed")
TRACKING_STATUS_FILENAME_PREFIX = {
    "active": "status_assembling",
    "delivery": "status_in_transit",
    "completed": "status_delivered",
}
MAP_BANNER_BASENAME = "map_banner"
# Если админ не загружал map_banner.* — пробуем эти файлы по порядку
MAP_BANNER_FALLBACK_FILES = (
    "map_banner_default.jpg",
    "delivery_status_banner.jpg",
    "banner.jpg",
)

# 7 суток — повторные открытия Mini App без повторной загрузки медиа
STATIC_CACHE_MAX_AGE = 604800
STATIC_LONG_CACHE_EXTS = {
    ".js",
    ".css",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".mp4",
    ".mov",
    ".webm",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
}


def optimize_and_save_image(
    file_storage,
    uploads_dir,
    filename_prefix,
    max_width=400,
    quality=75,
    final_filename=None,
):
    """Сохраняет изображение в WebP со сжатием и изменением размера."""
    uploads_path = Path(uploads_dir)
    uploads_path.mkdir(parents=True, exist_ok=True)
    orig = secure_filename(file_storage.filename or "") or "image"

    temp_path = uploads_path / f"temp_{uuid.uuid4().hex}_{orig}"
    file_storage.save(temp_path)

    try:
        with Image.open(temp_path) as img:
            if img.mode in ("RGBA", "P"):
                rgb_img = Image.new("RGB", img.size, (255, 255, 255))
                mask = img.split()[-1] if img.mode == "RGBA" else None
                rgb_img.paste(img, mask=mask)
                img = rgb_img
            elif img.mode != "RGB":
                img = img.convert("RGB")

            if img.width > max_width:
                ratio = max_width / img.width
                new_height = int(img.height * ratio)
                img = img.resize((max_width, new_height), Image.Resampling.LANCZOS)

            if final_filename:
                final_name = final_filename
            else:
                final_name = f"{filename_prefix}_{uuid.uuid4().hex[:10]}.webp"
            final_path = uploads_path / final_name
            img.save(final_path, "WEBP", quality=quality, method=6, optimize=True)

            if os.path.exists(temp_path):
                os.remove(temp_path)
            return f"uploads/{final_name}"

    except Exception as e:
        print(f"Ошибка оптимизации изображения: {e}")
        if final_filename:
            final_name = Path(final_filename).stem + ".jpg"
        else:
            final_name = f"{filename_prefix}_{uuid.uuid4().hex[:10]}.jpg"
        final_path = uploads_path / final_name

        if os.path.exists(temp_path):
            os.rename(temp_path, final_path)
        else:
            file_storage.save(final_path)

        return f"uploads/{final_name}"


def apply_browser_cache_headers(
    response,
    max_age: int = STATIC_CACHE_MAX_AGE,
    *,
    immutable: bool = True,
):
    """Cache-Control для статики и uploads (браузерный кэш)."""
    parts = ["public", f"max-age={max_age}"]
    if immutable:
        parts.append("immutable")
    response.headers["Cache-Control"] = ", ".join(parts)
    return response

# Пароль для раздела «Чеки» в админ-панели (можно задать в .env)
ADMIN_RECEIPTS_PASSWORD = os.getenv("ADMIN_RECEIPTS_PASSWORD", "7777").strip()

# Центральный магазин: ул. Ламаная, 2, Днепр (origin для доставки и карты)
SHOP_LATITUDE = 48.467505
SHOP_LONGITUDE = 35.052745
SHOP_ADDRESS = "ул. Ламаная, 2, Днепр"
# Обратная совместимость
SHOP_LAT = SHOP_LATITUDE
SHOP_LON = SHOP_LONGITUDE

# courier_id -> {"lat", "lon"} (live GPS — в оперативной памяти)
COURIER_POSITIONS: dict[str, dict] = {}
# order_id -> {courier_id: message_id} (сообщения «биржи» для редактирования)
ORDER_COURIER_MESSAGES: dict[str, dict[str, int]] = {}
# order_id -> chat_id клиента (кэш для Mini App, без Telegram-уведомлений)
ORDERS_CLIENTS: dict[str, int] = {}

# Статусы «курьер в пути» (в БД: delivering; legacy: delivery)
COURIER_IN_TRANSIT_STATUSES = frozenset({"delivery", "delivering"})
# Статусы, при которых курьеру показывают маршрут магазин → клиент
COURIER_ROUTE_VIEW_STATUSES = frozenset(
    {
        "paid",
        "confirmed",
        "preparing",
        "processing",
        "active",
        *COURIER_IN_TRANSIT_STATUSES,
    }
)

_backend_dir = Path(__file__).resolve().parent
db_path = get_database_path()
products_catalog_path = get_products_path()


def init_db() -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            username TEXT,
            items TEXT,
            total_price REAL,
            status TEXT,
            created_at TEXT,
            courier_id TEXT
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_id ON orders(user_id)"
    )
    cursor.execute("PRAGMA table_info(orders)")
    order_columns = {row[1] for row in cursor.fetchall()}
    if "courier_id" not in order_columns:
        cursor.execute("ALTER TABLE orders ADD COLUMN courier_id TEXT")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS couriers (
            tg_id TEXT PRIMARY KEY,
            name TEXT,
            phone TEXT,
            status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        INSERT OR IGNORE INTO couriers (tg_id, name, phone, status)
        VALUES (?, ?, ?, ?)
        """,
        ("8004084548", "Основной Курьер", "", "active"),
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS address_cache (
            address TEXT PRIMARY KEY,
            latitude REAL,
            longitude REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS promo_codes (
            code TEXT PRIMARY KEY,
            discount_percent INTEGER,
            max_uses INTEGER DEFAULT 100,
            used_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active'
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            title TEXT,
            image TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            category_id TEXT,
            name TEXT,
            price REAL,
            image TEXT,
            in_stock INTEGER DEFAULT 1,
            unit_type TEXT DEFAULT 'pcs',
            price_per_unit TEXT DEFAULT 'pcs',
            discount INTEGER DEFAULT 0,
            is_weight_item INTEGER DEFAULT 0,
            stock_quantity REAL DEFAULT 0
        )
        """
    )

    cursor.execute("PRAGMA table_info(products)")
    product_columns = {row[1] for row in cursor.fetchall()}
    for col_name, col_def in (
        ("category_id", "TEXT"),
        ("name", "TEXT"),
        ("image", "TEXT"),
        ("in_stock", "INTEGER DEFAULT 1"),
        ("unit_type", "TEXT DEFAULT 'pcs'"),
        ("price_per_unit", "TEXT DEFAULT 'pcs'"),
        ("discount", "INTEGER DEFAULT 0"),
        ("is_weight_item", "INTEGER DEFAULT 0"),
        ("stock_quantity", "REAL DEFAULT 0"),
    ):
        if col_name not in product_columns:
            cursor.execute(
                f"ALTER TABLE products ADD COLUMN {col_name} {col_def}"
            )

    conn.commit()

    # Перенос данных из JSON в БД (одноразово)
    try:
        migrate_json_to_db()
    except Exception as e:
        print(f"Миграция JSON в БД: {e}")

    promo_json_path = _backend_dir / "promocodes.json"
    if promo_json_path.is_file():
        try:
            raw_promo = json.loads(
                promo_json_path.read_text(encoding=JSON_CHARSET)
            )
            promo_list = (
                raw_promo.get("promocodes", [])
                if isinstance(raw_promo, dict)
                else []
            )
            if isinstance(promo_list, list):
                for item in promo_list:
                    if not isinstance(item, dict):
                        continue
                    code = str(item.get("code") or "").strip().upper()
                    if not code:
                        continue
                    discount_percent = normalize_discount_value(
                        item.get("discount_percent", item.get("discount", 0))
                    )
                    cursor.execute(
                        """
                        INSERT OR IGNORE INTO promo_codes (
                            code, discount_percent, max_uses, used_count, status
                        )
                        VALUES (?, ?, ?, 0, 'active')
                        """,
                        (
                            code,
                            discount_percent,
                            int(item.get("max_uses", 100) or 100),
                        ),
                    )
            conn.commit()
            print("🎟️ Промокоды из promocodes.json перенесены в SQLite")
        except Exception as promo_migrate_err:
            print(f"Ошибка миграции промокодов: {promo_migrate_err}")

    conn.commit()

    old_json_path = _backend_dir / "orders_db.json"
    if old_json_path.exists():
        try:
            with open(old_json_path, "r", encoding="utf-8") as f:
                old_orders = json.load(f)
            if isinstance(old_orders, dict):
                orders_list = old_orders.get("orders", [])
            elif isinstance(old_orders, list):
                orders_list = old_orders
            else:
                orders_list = list(old_orders.values())

            for order in orders_list:
                if not isinstance(order, dict):
                    continue
                order_id = str(order.get("id") or order.get("order_id") or "")
                if not order_id:
                    continue
                user_id = str(
                    order.get("user_id") or order.get("client_id") or ""
                )
                created_at = str(
                    order.get("created_at") or order.get("date") or ""
                )
                date_short = str(order.get("date_short") or created_at[:10])
                items_payload = {
                    "cart": order.get("cart", order.get("items", [])),
                    "address": order.get("address", ""),
                    "courier_id": order.get("courier_id"),
                    "promocode": order.get("promocode"),
                    "promocode_discount_percent": order.get(
                        "promocode_discount_percent"
                    ),
                    "date_short": date_short,
                }
                total_price = float(
                    order.get("total_price", order.get("total", 0)) or 0
                )
                courier_id_migrated = order.get("courier_id")
                cursor.execute(
                    """
                    INSERT OR IGNORE INTO orders (
                        id, user_id, username, items, total_price, status, created_at, courier_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        order_id,
                        user_id,
                        str(order.get("username", "")),
                        json.dumps(items_payload, ensure_ascii=False),
                        total_price,
                        str(order.get("status", "new")),
                        created_at,
                        str(courier_id_migrated) if courier_id_migrated else None,
                    ),
                )
            conn.commit()
            print("🎉 Старые заказы успешно мигрировали из JSON в SQLite!")
        except Exception as e:
            print(f"Ошибка миграции данных: {e}")
    conn.close()


def sync_products_table_from_catalog() -> None:
    """Синхронизирует id/price из products.json в таблицу products."""
    document = load_products_document()
    conn = sqlite3.connect(db_path)
    try:
        cursor = conn.cursor()
        for prod in document.get("products", []):
            if not isinstance(prod, dict):
                continue
            pid = str(prod.get("id") or "").strip()
            if not pid:
                continue
            try:
                price_val = float(prod.get("price", 0))
            except (TypeError, ValueError):
                price_val = 0.0
            cursor.execute(
                """
                INSERT INTO products (id, price) VALUES (?, ?)
                ON CONFLICT(id) DO UPDATE SET price = excluded.price
                """,
                (pid, price_val),
            )
        conn.commit()
    finally:
        conn.close()


def _parse_order_items_field(items_raw: str | None) -> tuple[list, dict]:
    if not items_raw:
        return [], {}
    try:
        parsed = json.loads(items_raw)
    except (TypeError, json.JSONDecodeError):
        return [], {}
    if isinstance(parsed, list):
        return parsed, {}
    if isinstance(parsed, dict):
        cart = parsed.get("cart", parsed.get("items", []))
        if not isinstance(cart, list):
            cart = []
        return cart, parsed
    return [], {}


def _row_to_order(row: sqlite3.Row | tuple) -> dict:
    if isinstance(row, sqlite3.Row):
        data = dict(row)
    else:
        data = {
            "id": row[0],
            "user_id": row[1],
            "username": row[2],
            "items": row[3],
            "total_price": row[4],
            "status": row[5],
            "created_at": row[6],
        }
    cart, extra = _parse_order_items_field(data.get("items"))
    created_at = str(data.get("created_at") or "")
    date_short = str(extra.get("date_short") or created_at[:10])
    total_price = float(data.get("total_price") or 0)
    return {
        "id": data.get("id"),
        "order_id": data.get("id"),
        "user_id": data.get("user_id"),
        "client_id": data.get("user_id"),
        "username": data.get("username") or "",
        "items": cart,
        "cart": cart,
        "total_price": total_price,
        "total": total_price,
        "status": data.get("status") or "new",
        "created_at": created_at,
        "date": created_at,
        "date_short": date_short,
        "address": extra.get("address", ""),
        "courier_id": data.get("courier_id") or extra.get("courier_id"),
        "promocode": extra.get("promocode"),
        "promocode_discount_percent": extra.get("promocode_discount_percent"),
        "courier_lat": extra.get("courier_lat"),
        "courier_lon": extra.get("courier_lon"),
        "courier_location_updated_at": extra.get("courier_location_updated_at"),
    }


def load_all_orders() -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(
            "SELECT * FROM orders ORDER BY created_at DESC"
        )
        return [_row_to_order(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def load_active_orders() -> list[dict]:
    """Заказы для админки (без отменённых/удалённых)."""
    placeholders = ",".join("?" * len(CANCELLED_ORDER_STATUSES))
    statuses_lower = tuple(s.lower() for s in CANCELLED_ORDER_STATUSES)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(
            f"""
            SELECT * FROM orders
            WHERE LOWER(COALESCE(status, '')) NOT IN ({placeholders})
            ORDER BY created_at DESC
            """,
            statuses_lower,
        )
        return [_row_to_order(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def load_cancelled_orders() -> list[dict]:
    """Архив: только cancelled / deleted."""
    placeholders = ",".join("?" * len(CANCELLED_ORDER_STATUSES))
    statuses_lower = tuple(s.lower() for s in CANCELLED_ORDER_STATUSES)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(
            f"""
            SELECT * FROM orders
            WHERE LOWER(COALESCE(status, '')) IN ({placeholders})
            ORDER BY created_at DESC
            """,
            statuses_lower,
        )
        return [_row_to_order(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def load_orders_for_admin_panel(view: str = "active") -> list[dict]:
    """active — рабочие чеки; archive|cancelled|history — отменённые."""
    v = str(view or "active").strip().lower()
    if v in ("archive", "cancelled", "history", "deleted"):
        return load_cancelled_orders()
    return load_active_orders()


def _receipts_password_valid(password: str | None) -> bool:
    if not ADMIN_RECEIPTS_PASSWORD:
        return False
    return str(password or "").strip() == ADMIN_RECEIPTS_PASSWORD


def order_as_receipt(order: dict) -> dict:
    """Заказ из БД в формате «чека» для админки."""
    cart = order.get("cart") or order.get("items") or []
    if not isinstance(cart, list):
        cart = []
    parts: list[str] = []
    for item in cart:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("title") or "Товар")
        qty = item.get("qty") if item.get("qty") is not None else item.get("quantity", 1)
        parts.append(f"{name} ×{qty}")
    return {
        "id": order.get("id"),
        "order_id": order.get("id"),
        "created_at": order.get("created_at") or "",
        "date_short": order.get("date_short") or "",
        "client_id": order.get("user_id") or order.get("client_id"),
        "username": order.get("username") or "",
        "total": order.get("total") or order.get("total_price") or 0,
        "status": order.get("status") or "",
        "address": order.get("address") or "",
        "courier_id": order.get("courier_id"),
        "promocode": order.get("promocode"),
        "items_summary": "; ".join(parts) if parts else "—",
        "items": cart,
    }


CANCELLED_ORDER_STATUSES = frozenset({"cancelled", "deleted"})


def delete_order_from_db(order_id: str) -> bool:
    """Мягкая отмена: статус cancelled, строка в БД сохраняется."""
    return cancel_order_in_db(order_id, status="cancelled")


def cancel_order_in_db(order_id: str, *, status: str = "cancelled") -> bool:
    oid = str(order_id).strip()
    if not oid:
        return False

    order = get_order_from_db(oid)
    if not order:
        return False

    cancel_status = str(status or "cancelled").strip().lower()
    if cancel_status not in CANCELLED_ORDER_STATUSES:
        cancel_status = "cancelled"

    blob = _read_order_items_blob(oid)
    blob["cancel_notify_pending"] = True
    blob["cancelled_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            cur = conn.execute(
                """
                UPDATE orders
                SET status = ?, items = ?
                WHERE id = ?
                """,
                (
                    cancel_status,
                    json.dumps(blob, ensure_ascii=False),
                    oid,
                ),
            )
            updated = cur.rowcount > 0
    finally:
        conn.close()

    return updated


def persist_order_items_blob(order_id: str, blob: dict) -> None:
    """Сохраняет JSON items заказа без смены total_price/status."""
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            conn.execute(
                "UPDATE orders SET items = ? WHERE id = ?",
                (
                    json.dumps(blob, ensure_ascii=False),
                    str(order_id).strip(),
                ),
            )
    finally:
        conn.close()


def get_courier_pool_messages(order_id: str) -> dict[str, int]:
    """ID сообщений «биржи» в ЛС курьеров: courier_tg_id -> message_id."""
    oid = str(order_id).strip()
    merged: dict[str, int] = {}
    stored = (_read_order_items_blob(oid) or {}).get("courier_pool_messages")
    if isinstance(stored, dict):
        for courier_id, msg_id in stored.items():
            try:
                merged[str(courier_id)] = int(msg_id)
            except (TypeError, ValueError):
                pass
    for courier_id, msg_id in ORDER_COURIER_MESSAGES.get(oid, {}).items():
        try:
            merged[str(courier_id)] = int(msg_id)
        except (TypeError, ValueError):
            pass
    return merged


def save_courier_pool_messages(order_id: str, messages: dict[str, int]) -> None:
    oid = str(order_id).strip()
    normalized = {str(k): int(v) for k, v in messages.items()}
    ORDER_COURIER_MESSAGES[oid] = dict(normalized)
    blob = _read_order_items_blob(oid)
    blob["courier_pool_messages"] = normalized
    persist_order_items_blob(oid, blob)


def record_courier_pool_message(
    order_id: str, courier_id: str, message_id: int
) -> None:
    msgs = get_courier_pool_messages(order_id)
    msgs[str(courier_id)] = int(message_id)
    save_courier_pool_messages(order_id, msgs)


def clear_courier_pool_messages_record(order_id: str) -> None:
    oid = str(order_id).strip()
    ORDER_COURIER_MESSAGES.pop(oid, None)
    blob = _read_order_items_blob(oid)
    if "courier_pool_messages" in blob:
        blob.pop("courier_pool_messages", None)
        persist_order_items_blob(oid, blob)


def delete_courier_pool_telegram_messages(
    bot, order_id: str, *, chat_id: int | str | None = None
) -> None:
    """
    Удаляет сообщения о заказе из чатов курьеров (ЛС или общий чат COURIER_CHAT_ID).
    """
    if bot is None:
        clear_courier_pool_messages_record(order_id)
        return

    oid = str(order_id).strip()
    messages = get_courier_pool_messages(oid)
    targets: list[tuple[int, int]] = []

    courier_chat_env = os.getenv("COURIER_CHAT_ID", "").strip()
    if courier_chat_env:
        try:
            group_chat = int(courier_chat_env)
            single_id = messages.get(str(group_chat)) or messages.get("group")
            if single_id is not None:
                targets.append((group_chat, int(single_id)))
        except ValueError:
            pass

    for courier_id, msg_id in messages.items():
        if courier_id in ("group",):
            continue
        try:
            targets.append((int(courier_id), int(msg_id)))
        except (TypeError, ValueError):
            continue

    if chat_id is not None:
        try:
            cid = int(chat_id)
            mid = messages.get(str(cid))
            if mid is not None:
                targets.append((cid, int(mid)))
        except (TypeError, ValueError):
            pass

    seen: set[tuple[int, int]] = set()
    for chat, msg_id in targets:
        key = (chat, msg_id)
        if key in seen:
            continue
        seen.add(key)
        try:
            bot.delete_message(chat, msg_id)
        except Exception as del_err:
            print(
                f"Не удалось удалить сообщение у курьера (chat={chat}, msg={msg_id}): "
                f"{del_err}",
                file=sys.stderr,
            )

    clear_courier_pool_messages_record(oid)


def upsert_courier(
    tg_id: str,
    name: str,
    phone: str = "",
    status: str = "active",
) -> None:
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO couriers (tg_id, name, phone, status)
                VALUES (?, ?, ?, ?)
                """,
                (str(tg_id).strip(), str(name).strip(), str(phone or "").strip(), status),
            )
    finally:
        conn.close()


def delete_courier_from_db(tg_id: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            conn.execute("DELETE FROM couriers WHERE tg_id = ?", (str(tg_id).strip(),))
            conn.execute(
                "UPDATE orders SET courier_id = NULL WHERE courier_id = ?",
                (str(tg_id).strip(),),
            )
    finally:
        conn.close()


def get_courier_record(tg_id: str) -> dict | None:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT tg_id, name, phone, status FROM couriers WHERE tg_id = ?",
            (str(tg_id).strip(),),
        ).fetchone()
        if not row:
            return None
        return {
            "tg_id": row["tg_id"],
            "name": row["name"],
            "phone": row["phone"] or "",
            "status": row["status"] or "active",
            "active": (row["status"] or "active") == "active",
        }
    finally:
        conn.close()


def get_couriers_list_for_api() -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT tg_id, name, phone, status FROM couriers ORDER BY name"
        ).fetchall()
        return [
            {
                "tg_id": str(row["tg_id"]),
                "name": row["name"] or "Курьер",
                "phone": row["phone"] or "",
                "active": (row["status"] or "active") == "active",
            }
            for row in rows
        ]
    finally:
        conn.close()


def get_active_couriers() -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT tg_id, name, phone, status FROM couriers WHERE status = 'active'"
        ).fetchall()
        return [
            {
                "tg_id": row["tg_id"],
                "name": row["name"] or "Курьер",
                "phone": row["phone"] or "",
                "status": row["status"] or "active",
            }
            for row in rows
        ]
    finally:
        conn.close()


def get_order_assignment(order_id: str) -> tuple[str | None, str | None]:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT courier_id, status FROM orders WHERE id = ?",
            (str(order_id).strip(),),
        ).fetchone()
        if not row:
            return None, None
        courier_id = row[0] if row[0] not in (None, "") else None
        return courier_id, str(row[1] or "")
    finally:
        conn.close()


def assign_courier_to_order(order_id: str, courier_id: str, status: str = "delivery") -> bool:
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            cur = conn.execute(
                """
                UPDATE orders
                SET courier_id = ?, status = ?
                WHERE id = ?
                """,
                (str(courier_id).strip(), str(status), str(order_id).strip()),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


def load_orders_for_user(user_id: str) -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(
            """
            SELECT * FROM orders
            WHERE user_id = ?
            ORDER BY created_at DESC
            """,
            (str(user_id).strip(),),
        )
        return [_row_to_order(row) for row in cursor.fetchall()]
    finally:
        conn.close()


UNFINISHED_ORDER_STATUSES = (
    "pending_weight_verification",
    "awaiting_payment",
    "delivering",
    "confirmed",
    "paid",
    "preparing",
    # фактические статусы в БД (эквиваленты delivering / confirmed):
    "delivery",
    "processing",
    "active",
    "new",
)

COURIER_POOL_ORDER_STATUSES = (
    "paid",
    "confirmed",
    "preparing",
    "processing",
)


def get_latest_order_for_user(user_id: str) -> dict | None:
    """Самый свежий заказ пользователя (любой статус)."""
    uid = str(user_id or "").strip()
    if not uid:
        return None

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT id, status
            FROM orders
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (uid,),
        ).fetchone()
        if not row:
            return None
        return {
            "order_id": str(row["id"]),
            "status": str(row["status"] or ""),
        }
    finally:
        conn.close()


def consume_cancel_notify_pending(order_id: str) -> bool:
    """
    True, если клиенту ещё не показывали отмену заказа админом.
    Сбрасывает флаг cancel_notify_pending в items (одноразово).
    """
    oid = str(order_id or "").strip()
    if not oid:
        return False

    blob = _read_order_items_blob(oid)
    if not blob.get("cancel_notify_pending"):
        return False

    blob["cancel_notify_pending"] = False
    blob["cancel_notify_shown_at"] = datetime.datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            conn.execute(
                "UPDATE orders SET items = ? WHERE id = ?",
                (json.dumps(blob, ensure_ascii=False), oid),
            )
    finally:
        conn.close()
    return True


def find_latest_unfinished_order_for_user(user_id: str) -> dict | None:
    """Самый свежий незавершённый заказ пользователя или None."""
    uid = str(user_id or "").strip()
    if not uid:
        return None

    placeholders = ",".join("?" * len(UNFINISHED_ORDER_STATUSES))
    statuses_lower = tuple(s.lower() for s in UNFINISHED_ORDER_STATUSES)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            f"""
            SELECT id, status
            FROM orders
            WHERE user_id = ?
              AND LOWER(status) IN ({placeholders})
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (uid, *statuses_lower),
        ).fetchone()
        if not row:
            return None
        return {
            "order_id": str(row["id"]),
            "status": str(row["status"] or ""),
        }
    finally:
        conn.close()


def build_courier_location_keyboard(order_id: str | None = None) -> ReplyKeyboardMarkup:
    """Reply-клавиатура «Поехали» с request_location (геопозиция в один клик)."""
    courier_keyboard = ReplyKeyboardMarkup(
        row_width=1, resize_keyboard=True, one_time_keyboard=True
    )
    label = (
        f"🚀 Поехали! (Заказ №{order_id})"
        if order_id
        else "🚀 Поехали! (Включить геопозицию)"
    )
    courier_keyboard.add(
        KeyboardButton(text=label, request_location=True)
    )
    return courier_keyboard


def parse_order_id_from_poekhali_button(text: str | None) -> str | None:
    """Извлекает order_id из «🚀 Поехали! (Заказ №123)»."""
    if not text:
        return None
    match = re.search(r"Заказ\s*№\s*(\S+)", str(text), re.IGNORECASE)
    return match.group(1).strip() if match else None

# viewbox Nominatim: left, top, right, bottom (ограничение поиска рамкой Днепра)
DNIPRO_VIEWBOX = "34.80,48.60,35.30,48.35"

# Локальный кэш в памяти: {"рабочая 160 днепр": (48.432, 35.012)}
_address_memory_cache: dict[str, tuple[float, float]] = {}
_geocode_network_lock = threading.Lock()
_last_nominatim_request_at = 0.0

GOOGLE_GEOCODE_API_KEY = config.GOOGLE_MAPS_API_KEY


def _normalize_geocode_key(address_text: str) -> str:
    clean_address = " ".join(str(address_text).strip().lower().split())
    if (
        "днепр" not in clean_address
        and "dnipro" not in clean_address
        and "дніпро" not in clean_address
    ):
        clean_address += ", днепр, украина"
    return clean_address


def _read_address_sqlite_cache(clean_key: str) -> tuple[float, float] | None:
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                """
                SELECT latitude, longitude
                FROM address_cache
                WHERE address = ?
                """,
                (clean_key,),
            ).fetchone()
            if row:
                return float(row[0]), float(row[1])
        finally:
            conn.close()
    except Exception as cache_err:
        print(f"Ошибка чтения SQLite-кэша адреса: {cache_err}")
    return None


def _persist_address_cache(clean_key: str, lat: float, lng: float) -> None:
    _address_memory_cache[clean_key] = (lat, lng)
    try:
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO address_cache (
                    address, latitude, longitude
                )
                VALUES (?, ?, ?)
                """,
                (clean_key, lat, lng),
            )
    except Exception as cache_err:
        print(f"Ошибка записи SQLite-кэша адреса: {cache_err}")


def _geocode_via_google(
    clean_address: str, original_address: str
) -> tuple[float, float] | None:
    if not GOOGLE_GEOCODE_API_KEY:
        return None
    try:
        url = (
            "https://maps.googleapis.com/maps/api/geocode/json"
            f"?address={quote(clean_address)}"
            f"&key={GOOGLE_GEOCODE_API_KEY}"
            "&region=ua"
            "&language=uk"
        )
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        data = response.json()
        status = data.get("status")
        if status == "OK" and data.get("results"):
            location = data["results"][0]["geometry"]["location"]
            lat = float(location["lat"])
            lng = float(location["lng"])
            print(f"[GOOGLE API] Успешно геокодирован адрес: {original_address!r}")
            return lat, lng
        print(
            f"[GOOGLE API] Статус {status!r} для адреса {original_address!r}: "
            f"{data.get('error_message', '')}"
        )
    except Exception as exc:
        print(f"Ошибка Google геокодера для {original_address!r}: {exc}")
    return None


def _geocode_via_nominatim(
    clean_address: str, original_address: str
) -> tuple[float, float] | None:
    global _last_nominatim_request_at
    try:
        elapsed = time.monotonic() - _last_nominatim_request_at
        if elapsed < 1.05:
            time.sleep(1.05 - elapsed)
        url = (
            "https://nominatim.openstreetmap.org/search?"
            f"format=json&q={quote(clean_address)}"
            f"&viewbox={DNIPRO_VIEWBOX}&bounded=1&limit=1"
        )
        headers = {"User-Agent": "HalalMarketDniproBot/1.0"}
        response = requests.get(url, headers=headers, timeout=5)
        _last_nominatim_request_at = time.monotonic()
        response.raise_for_status()
        data = response.json()
        if data:
            lat = float(data[0]["lat"])
            lng = float(data[0]["lon"])
            print(f"[NOMINATIM] Резервное геокодирование: {original_address!r}")
            return lat, lng
    except Exception as exc:
        print(f"Ошибка Nominatim для {original_address!r}: {exc}")
    return None


def geocode_address(address_text: str) -> tuple[float, float]:
    """
    Геокодирование с кэшем (память + SQLite), Google API и резервом Nominatim.
    При полном сбое — координаты магазина (ул. Ламаная, 2), чтобы не ломать заказ.
    """
    if not str(address_text).strip():
        print("[WARNING] Пустой адрес. Возвращаем Ламаную 2.")
        return SHOP_LATITUDE, SHOP_LONGITUDE

    clean_address = _normalize_geocode_key(address_text)

    if clean_address in _address_memory_cache:
        print(f"[КЭШ] Координаты найдены в памяти для: {address_text!r}")
        return _address_memory_cache[clean_address]

    sqlite_coords = _read_address_sqlite_cache(clean_address)
    if sqlite_coords:
        _address_memory_cache[clean_address] = sqlite_coords
        print(f"[КЭШ] Координаты найдены в SQLite для: {address_text!r}")
        return sqlite_coords

    with _geocode_network_lock:
        if clean_address in _address_memory_cache:
            return _address_memory_cache[clean_address]

        coords = _geocode_via_google(clean_address, address_text)
        if coords is None:
            coords = _geocode_via_nominatim(clean_address, address_text)
        if coords is not None:
            _persist_address_cache(clean_address, coords[0], coords[1])
            return coords

    print(
        f"[WARNING] Геокодирование не удалось для {address_text!r}. "
        f"Возвращаем {SHOP_ADDRESS}."
    )
    return SHOP_LATITUDE, SHOP_LONGITUDE


def coords_near_shop(
    lat: float | None,
    lon: float | None,
    *,
    epsilon: float = 1e-5,
) -> bool:
    if lat is None or lon is None:
        return False
    try:
        return (
            abs(float(lat) - SHOP_LATITUDE) < epsilon
            and abs(float(lon) - SHOP_LONGITUDE) < epsilon
        )
    except (TypeError, ValueError):
        return False


def get_coordinates(address: str) -> tuple[float | None, float | None]:
    """Совместимость: пустой адрес → None; иначе geocode_address."""
    if not address or not str(address).strip():
        return None, None
    lat, lng = geocode_address(address)
    if coords_near_shop(lat, lng):
        return None, None
    return lat, lng


def shop_route_origin() -> dict:
    """Начальная точка маршрута (магазин на Ламаной 2)."""
    return {
        "shop_latitude": SHOP_LATITUDE,
        "shop_longitude": SHOP_LONGITUDE,
        "shop_address": SHOP_ADDRESS,
        "route_origin": "shop",
    }


def get_order_delivery_coords(order_id: str) -> tuple[float | None, float | None]:
    """Конечная точка маршрута — координаты клиента из заказа."""
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT items FROM orders WHERE id = ?",
                (str(order_id).strip(),),
            ).fetchone()
        finally:
            conn.close()
        if not row:
            return None, None
        _, extra = _parse_order_items_field(row[0])
        lat_raw = extra.get("client_lat")
        lon_raw = extra.get("client_lon")
        if lat_raw is None or lon_raw is None:
            return None, None
        lat, lon = float(lat_raw), float(lon_raw)
        if coords_near_shop(lat, lon) or (lat == 0 and lon == 0):
            return None, None
        return lat, lon
    except (TypeError, ValueError):
        return None, None


def order_allows_courier_route_view(order_id: str) -> bool:
    """Курьер по прямой ссылке может видеть точки А (магазин) и Б (клиент)."""
    oid = str(order_id or "").strip()
    if not oid or not order_is_courier_delivery(oid):
        return False
    _, status = get_order_assignment(oid)
    if status is None:
        return False
    st = str(status).lower()
    if st in CANCELLED_ORDER_STATUSES or st == "completed":
        return False
    return st in COURIER_ROUTE_VIEW_STATUSES


def order_status_route_payload(order_id: str) -> dict:
    """Координаты origin/destination для фронтенда и карты."""
    payload = dict(shop_route_origin())
    client_lat, client_lon = resolve_order_client_coordinates(order_id)
    payload["client_latitude"] = client_lat
    payload["client_longitude"] = client_lon
    payload["client_lat"] = client_lat
    payload["client_lon"] = client_lon
    payload["route_destination"] = "client" if client_lat is not None else None
    order = get_order_from_db(order_id)
    if order:
        addr = str(order.get("address") or "").strip()
        if addr:
            payload["address"] = addr
            payload["delivery_address"] = addr
    return payload


def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Расстояние между двумя точками в километрах (формула гаверсинуса)."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


MAX_DELIVERY_RADIUS_KM = 8.0
FREE_DELIVERY_MIN_TOTAL = 700
DELIVERY_FEE_UAH = 100


def is_courier_delivery(delivery_method: str, order_text: str) -> bool:
    if delivery_method in ("courier", "delivery"):
        return True
    return "Курьер" in (order_text or "")


def extract_delivery_address(data: dict, order_text: str) -> str:
    addr = str(data.get("delivery_address") or "").strip()
    if addr:
        return addr
    match = re.search(r"🏠 Адрес:\s*(.+?)(?:\n|$)", order_text or "")
    return match.group(1).strip() if match else ""


def is_weight_product(product: dict) -> bool:
    return normalize_unit_type(product.get("unit_type")) == "weight"


def product_unit_price(product: dict) -> float:
    """Unit price: per piece (pcs) or per 100 g (weight)."""
    base_price = float(product.get("price") or 0)
    discount = normalize_discount_value(product.get("discount", 0))
    if discount > 0:
        return base_price * (1 - discount / 100)
    return base_price


def format_weight_label(grams: float) -> str:
    g = int(round(max(0, grams)))
    if g >= 1000:
        if g % 1000 == 0:
            return f"Вес: {g // 1000} кг"
        kg = g / 1000.0
        kg_text = f"{kg:.1f}".rstrip("0").rstrip(".")
        return f"Вес: {kg_text} кг"
    return f"Вес: {g} г"


def cart_line_amount(
    product: dict | None,
    item: dict,
) -> tuple[float, str]:
    """
    Returns (line_total_uah, quantity_label_for_order_line).
    quantity/count: pieces for pcs, grams for weight.
    """
    unit_type = normalize_unit_type(
        (product or {}).get("unit_type") or item.get("unit_type")
    )
    qty_raw = item.get("quantity", item.get("count", 1))

    if unit_type == "weight":
        try:
            grams = float(qty_raw)
        except (TypeError, ValueError):
            grams = 500.0
        grams = max(1.0, grams)
        if not product:
            return 0.0, format_weight_label(grams)
        actual_price_per_100g = product_unit_price(product)
        line_total = (actual_price_per_100g / 100.0) * grams
        return line_total, format_weight_label(grams)

    try:
        qty = max(1, int(qty_raw))
    except (TypeError, ValueError):
        qty = 1
    if not product:
        return 0.0, f"x{qty}"
    unit_price = product_unit_price(product)
    line_total = unit_price * qty
    return line_total, f"x{qty}"


def load_products_document() -> dict:
    """Загружает каталог из БД."""
    return {
        "categories": load_categories_from_db(),
        "products": load_products_from_db(),
    }


def normalize_promo_code(code: str) -> str:
    return str(code or "").strip().upper()


def _promocode_row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "code": row["code"],
        "discount_percent": int(row["discount_percent"] or 0),
        "max_uses": int(row["max_uses"] if row["max_uses"] is not None else 100),
        "used_count": int(row["used_count"] or 0),
        "status": row["status"] or "active",
    }


def fetch_promocode_row(code: str, conn: sqlite3.Connection | None = None) -> dict | None:
    normalized = normalize_promo_code(code)
    if not normalized:
        return None

    own_conn = conn is None
    if own_conn:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT code, discount_percent, max_uses, used_count, status
            FROM promo_codes
            WHERE code = ?
            """,
            (normalized,),
        ).fetchone()
        if not row:
            return None
        return _promocode_row_to_dict(row)
    finally:
        if own_conn:
            conn.close()


def promocode_is_usable(promo: dict) -> bool:
    if not promo:
        return False
    status = str(promo.get("status") or "active")
    used_count = int(promo.get("used_count") or 0)
    max_uses = int(promo.get("max_uses") if promo.get("max_uses") is not None else 100)
    return status == "active" and used_count < max_uses


def validate_promocode_for_use(code: str) -> tuple[bool, int, str | None]:
    promo = fetch_promocode_row(code)
    if not promo:
        return False, 0, "Промокод не существует"
    if not promocode_is_usable(promo):
        return (
            False,
            0,
            "Срок действия этого промокода истёк или лимит использований исчерпан",
        )
    return True, int(promo.get("discount_percent") or 0), None


def lookup_promocode(code: str) -> dict | None:
    promo = fetch_promocode_row(code)
    if not promo or not promocode_is_usable(promo):
        return None
    return promo


def list_promocodes_for_admin() -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT code, discount_percent, max_uses, used_count, status
            FROM promo_codes
            ORDER BY code
            """
        ).fetchall()
        return [_promocode_row_to_dict(row) for row in rows]
    finally:
        conn.close()


def upsert_promocode(
    code: str,
    discount_percent: int,
    *,
    max_uses: int = 100,
    status: str = "active",
) -> None:
    normalized = normalize_promo_code(code)
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO promo_codes (
                    code, discount_percent, max_uses, used_count, status
                )
                VALUES (?, ?, ?, 0, ?)
                ON CONFLICT(code) DO UPDATE SET
                    discount_percent = excluded.discount_percent,
                    max_uses = excluded.max_uses,
                    status = excluded.status
                """,
                (
                    normalized,
                    int(discount_percent),
                    int(max_uses),
                    str(status or "active"),
                ),
            )
    finally:
        conn.close()


def delete_promocode_from_db(code: str) -> bool:
    normalized = normalize_promo_code(code)
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            cur = conn.execute(
                "DELETE FROM promo_codes WHERE code = ?",
                (normalized,),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


def increment_promocode_used_count(conn: sqlite3.Connection, code: str) -> bool:
    normalized = normalize_promo_code(code)
    if not normalized:
        return False
    cur = conn.execute(
        """
        UPDATE promo_codes
        SET used_count = used_count + 1
        WHERE code = ?
          AND status = 'active'
          AND used_count < max_uses
        """,
        (normalized,),
    )
    return cur.rowcount == 1


def validate_piece_item_stock(product: dict, requested_qty: int | float) -> str | None:
    """
    Проверка остатка для штучного товара.
    Возвращает текст ошибки или None, если количества на складе достаточно.
    """
    if not product or product_is_weight_item(product):
        return None
    try:
        qty = max(1, int(round(float(requested_qty))))
    except (TypeError, ValueError):
        qty = 1
    stock_qty = int(
        normalize_stock_quantity(product.get("stock_quantity", 0), is_weight=False)
    )
    if stock_qty < qty:
        name = str(product.get("name") or product.get("id") or "Товар")
        return (
            f"Товара '{name}' недостаточно на складе. "
            f"Доступно: {stock_qty} шт."
        )
    return None


def validate_piece_items_stock(
    cart_items: list,
    products_by_id: dict[str, dict],
) -> str | None:
    """Проверяет остатки всех штучных позиций корзины перед созданием заказа."""
    for item in cart_items:
        if not isinstance(item, dict):
            continue
        product_id = str(
            item.get("id") or item.get("product_id") or ""
        ).strip()
        if not product_id:
            continue
        product = products_by_id.get(product_id)
        if not product:
            continue
        qty_raw = item.get("quantity", item.get("count", 1))
        err = validate_piece_item_stock(product, qty_raw)
        if err:
            return err
    return None


def validate_and_reprice_cart(
    cart: list,
    products_by_id: dict[str, dict],
) -> tuple[float, list[dict], list[str]]:
    """
    Пересчёт корзины только по ценам из каталога на сервере.
    Игнорирует price/discount с клиента. Требует наличие каждого товара в каталоге.
    """
    calculated_total_price = 0.0
    validated_items: list[dict] = []
    items_lines: list[str] = []
    index = 0

    for client_item in cart:
        if not isinstance(client_item, dict):
            continue

        product_id = str(
            client_item.get("id") or client_item.get("product_id") or ""
        ).strip()
        if not product_id:
            raise ValueError("В корзине есть позиция без ID товара")

        product = products_by_id.get(product_id)
        if not product:
            raise ValueError(f"Товар с ID {product_id} не найден в каталоге")

        if not product_is_in_stock(product):
            name = str(product.get("name") or product_id)
            raise ValueError(f"Товар «{name}» отсутствует в наличии")

        db_price = float(product.get("price") or 0)
        db_discount = normalize_discount_value(product.get("discount", 0))
        unit_type = normalize_unit_type(product.get("unit_type", "pcs"))

        if db_discount > 0:
            actual_unit_price = db_price * (1 - db_discount / 100)
        else:
            actual_unit_price = db_price

        qty_raw = client_item.get("count", client_item.get("quantity", 1))
        try:
            quantity = float(qty_raw)
        except (TypeError, ValueError):
            quantity = 1.0

        if unit_type == "weight":
            quantity = max(1.0, quantity)
            item_cost = (actual_unit_price / 100.0) * quantity
            qty_label = format_weight_label(quantity)
            qty_store = quantity
        else:
            quantity = max(1, int(round(quantity)))
            stock_err = validate_piece_item_stock(product, quantity)
            if stock_err:
                raise ValueError(stock_err)
            item_cost = actual_unit_price * quantity
            qty_label = f"x{int(quantity)}"
            qty_store = int(quantity)

        calculated_total_price += item_cost

        is_weight = product_is_weight_item(product)
        validated_item = {
            "id": product_id,
            "name": str(product.get("name") or "Товар"),
            "price": round(actual_unit_price, 2),
            "base_price": round(db_price, 2),
            "discount": db_discount,
            "unit_type": unit_type,
            "is_weight_item": is_weight,
            "price_per_unit": product.get(
                "price_per_unit", "100g" if unit_type == "weight" else "pcs"
            ),
            "quantity": qty_store,
            "count": qty_store,
            "total_item_price": round(item_cost, 2),
        }
        validated_items.append(validated_item)

        index += 1
        name = validated_item["name"]
        if unit_type == "weight":
            line = (
                f"{index}. {name} — {qty_label} — {format_uah(item_cost)} ₴"
            )
        else:
            line = f"{index}. {name} {qty_label} — {format_uah(item_cost)} ₴"
        if db_discount > 0:
            line += f" (-{db_discount}%)"
        items_lines.append(line)

    if not validated_items:
        raise ValueError("Корзина пуста")

    return round(calculated_total_price, 2), validated_items, items_lines


def validated_cart_has_weight_items(
    validated_items: list[dict],
    products_by_id: dict[str, dict],
) -> bool:
    for item in validated_items:
        pid = str(item.get("id") or "")
        product = products_by_id.get(pid)
        if product is not None and product_is_weight_item(product):
            return True
        if item.get("is_weight_item") is True:
            return True
        if normalize_unit_type(item.get("unit_type")) == "weight":
            return True
    return False


def calculate_cart_goods(
    cart: list,
    products_by_id: dict[str, dict],
) -> tuple[float, list[str]]:
    total, _, lines = validate_and_reprice_cart(cart, products_by_id)
    return total, lines


def apply_promocode_to_subtotal(subtotal: float, promocode: str) -> tuple[float, str | None, int]:
    promo = lookup_promocode(promocode)
    if not promo:
        return subtotal, None, 0
    percent = normalize_discount_value(promo.get("discount_percent", 0))
    if percent <= 0:
        return subtotal, str(promo.get("code") or "").strip().upper(), 0
    code = str(promo.get("code") or promocode).strip().upper()
    return subtotal * (1 - percent / 100), code, percent


def update_order_text_goods_and_total(
    order_text: str,
    items_lines: list[str],
    goods_total: float,
    *,
    promocode: str | None = None,
    promocode_percent: int = 0,
) -> str:
    text = strip_previous_delivery_lines(order_text or "")
    text = re.sub(r"\n🏷️ Промокод[^\n]*", "", text)
    if items_lines:
        items_block = "\n".join(items_lines)
        if re.search(r"\n🛒 Товары:\s*\n", text):
            text = re.sub(
                r"(\n🛒 Товары:\s*\n)(.*?)(\n💰 Итого:)",
                lambda m: f"{m.group(1)}{items_block}{m.group(3)}",
                text,
                count=1,
                flags=re.DOTALL,
            )
        else:
            text = f"{text.rstrip()}\n\n🛒 Товары:\n{items_block}\n💰 Итого: {format_uah(goods_total)} ₴"
    promo_line = ""
    if promocode and promocode_percent > 0:
        promo_line = f"\n🏷️ Промокод {promocode}: −{promocode_percent}%"
    if re.search(r"\n💰 Итого:", text):
        total_line = f"\n💰 Итого: {format_uah(goods_total)} ₴{promo_line}"
        text = re.sub(
            r"\n💰 Итого:\s*[\d.,]+\s*₴",
            lambda _m: total_line,
            text,
            count=1,
        )
    else:
        text = f"{text.rstrip()}\n💰 Итого: {format_uah(goods_total)} ₴{promo_line}"
    return text


def parse_goods_total(order_text: str, data: dict) -> float:
    raw = data.get("order_total")
    if raw is not None and raw != "":
        try:
            return float(raw)
        except (TypeError, ValueError):
            pass
    match = re.search(r"💰 Итого:\s*([\d.,]+)\s*₴", order_text or "")
    if match:
        try:
            return float(match.group(1).replace(",", "."))
        except ValueError:
            pass
    return 0.0


def save_order_to_db(
    order_id,
    data,
    order_text,
    client_chat_id,
    status="processing",
    username: str = "",
):
    try:
        cart = data.get("cart", [])
        if not cart and "items" in data:
            cart = data.get("items", [])

        total_price = parse_goods_total(order_text, data)
        created_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        date_short = datetime.datetime.now().strftime("%Y-%m-%d")
        items_payload = {
            "cart": cart if isinstance(cart, list) else [],
            "address": extract_delivery_address(data, order_text),
            "courier_id": None,
            "promocode": data.get("promocode"),
            "promocode_discount_percent": data.get("promocode_discount_percent"),
            "date_short": date_short,
        }

        conn = sqlite3.connect(db_path)
        try:
            with conn:
                conn.execute(
                    """
                    INSERT INTO orders (
                        id, user_id, username, items, total_price, status, created_at, courier_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(order_id),
                        str(client_chat_id) if client_chat_id is not None else "",
                        str(username or data.get("username") or ""),
                        json.dumps(items_payload, ensure_ascii=False),
                        float(total_price),
                        str(status),
                        created_at,
                        None,
                    ),
                )
        finally:
            conn.close()
    except Exception as e:
        print(f"Ошибка сохранения заказа в БД: {e}")


def update_order_in_db(order_id: str, **updates) -> None:
    try:
        order = get_order_from_db(order_id)
        if not order:
            return

        new_status = updates.get("status", order.get("status"))
        new_courier_id = updates.get("courier_id", order.get("courier_id"))
        blob = _read_order_items_blob(order_id)
        items_payload = {
            "cart": order.get("cart", []),
            "address": order.get("address", ""),
            "courier_id": new_courier_id,
            "promocode": order.get("promocode"),
            "promocode_discount_percent": order.get("promocode_discount_percent"),
            "date_short": order.get("date_short", ""),
        }
        for key in (
            "courier_lat",
            "courier_lon",
            "courier_location_updated_at",
            "client_lat",
            "client_lon",
            "courier_pool_messages",
        ):
            if key in blob:
                items_payload[key] = blob[key]

        conn = sqlite3.connect(db_path)
        try:
            with conn:
                conn.execute(
                    """
                    UPDATE orders
                    SET status = ?, items = ?, courier_id = ?
                    WHERE id = ?
                    """,
                    (
                        str(new_status),
                        json.dumps(items_payload, ensure_ascii=False),
                        str(new_courier_id) if new_courier_id else None,
                        str(order_id),
                    ),
                )
        finally:
            conn.close()
    except Exception as e:
        print(f"Ошибка обновления заказа в БД: {e}")


def _read_order_items_blob(order_id: str) -> dict:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT items FROM orders WHERE id = ?",
            (str(order_id).strip(),),
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return {}
    try:
        parsed = json.loads(row[0])
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def persist_order_cart_and_total(
    order_id: str,
    cart: list[dict],
    total_price: float,
    *,
    status: str | None = None,
    extra_patch: dict | None = None,
) -> None:
    blob = _read_order_items_blob(order_id)
    if extra_patch:
        blob.update(extra_patch)
    blob["cart"] = cart

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            if status is not None:
                conn.execute(
                    """
                    UPDATE orders
                    SET items = ?, total_price = ?, status = ?
                    WHERE id = ?
                    """,
                    (
                        json.dumps(blob, ensure_ascii=False),
                        float(total_price),
                        str(status),
                        str(order_id).strip(),
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE orders
                    SET items = ?, total_price = ?
                    WHERE id = ?
                    """,
                    (
                        json.dumps(blob, ensure_ascii=False),
                        float(total_price),
                        str(order_id).strip(),
                    ),
                )
    finally:
        conn.close()


def apply_weight_adjustments_to_cart(
    cart: list[dict],
    adjustments: list,
    products_by_id: dict[str, dict],
) -> list[dict]:
    """Применяет фактический вес (граммы) к весовым позициям корзины."""
    adj_by_id: dict[str, float] = {}
    for raw in adjustments:
        if not isinstance(raw, dict):
            continue
        pid = str(
            raw.get("id")
            or raw.get("product_id")
            or raw.get("item_id")
            or ""
        ).strip()
        if not pid:
            continue
        qty_raw = raw.get("quantity", raw.get("weight", raw.get("weight_grams")))
        if qty_raw is None and raw.get("actual_quantity") is not None:
            try:
                qty_raw = float(raw["actual_quantity"]) * 1000.0
            except (TypeError, ValueError):
                qty_raw = None
        try:
            grams = float(qty_raw)
        except (TypeError, ValueError):
            continue
        if grams > 0:
            adj_by_id[pid] = grams

    updated: list[dict] = []
    for line in cart:
        if not isinstance(line, dict):
            continue
        item = dict(line)
        pid = str(item.get("id") or "")
        product = products_by_id.get(pid)
        is_weight = (
            item.get("is_weight_item") is True
            or (product is not None and product_is_weight_item(product))
            or normalize_unit_type(item.get("unit_type")) == "weight"
        )
        if is_weight and pid in adj_by_id:
            grams = adj_by_id[pid]
            item["quantity"] = grams
            item["count"] = grams
            item["actual_quantity"] = round(grams / 1000.0, 3)
            item["is_weight_item"] = True
        updated.append(item)
    return updated


def admin_update_order_weights(
    order_id: str,
    adjustments: list,
) -> dict:
    """
    Обновляет фактический вес позиций, пересчитывает чек и переводит заказ
    из pending_weight_verification в awaiting_payment.
    """
    order_id = str(order_id or "").strip()
    if not order_id:
        raise ValueError("Missing order_id")

    if not isinstance(adjustments, list) or not adjustments:
        raise ValueError("Missing items weights array")

    order = get_order_from_db(order_id)
    if not order:
        raise LookupError("Order not found")

    current_status = str(order.get("status") or "")
    if current_status != "pending_weight_verification":
        raise ValueError(
            "Заказ не ожидает подтверждения веса "
            f"(текущий статус: {current_status})"
        )

    store_doc = load_products_document()
    products_by_id = {
        str(p.get("id")): p
        for p in store_doc.get("products", [])
        if isinstance(p, dict) and p.get("id") is not None
    }

    cart = order.get("cart") or []
    if not isinstance(cart, list):
        cart = []

    adjusted_cart = apply_weight_adjustments_to_cart(
        cart, adjustments, products_by_id
    )

    new_subtotal, validated_items, items_lines = validate_and_reprice_cart(
        adjusted_cart, products_by_id
    )

    promo_code = order.get("promocode")
    promo_percent = int(order.get("promocode_discount_percent") or 0)
    final_total = new_subtotal
    if promo_code and promo_percent > 0:
        final_total, _, _ = apply_promocode_to_subtotal(
            new_subtotal, str(promo_code)
        )

    items_blob = _read_order_items_blob(order_id)
    order_text = str(items_blob.get("order_text_snapshot") or "")
    if order_text:
        order_text = update_order_text_goods_and_total(
            order_text,
            items_lines,
            final_total,
            promocode=str(promo_code) if promo_code else None,
            promocode_percent=promo_percent,
        )

    persist_order_cart_and_total(
        order_id,
        validated_items,
        final_total,
        status="awaiting_payment",
        extra_patch={
            "order_text_snapshot": order_text,
            "has_weight_items": True,
            "weights_confirmed": True,
        },
    )

    return {
        "order_id": order_id,
        "status": "awaiting_payment",
        "new_total_price": final_total,
        "total_price": final_total,
        "cart": validated_items,
        "items_lines": items_lines,
    }


def get_order_from_db(order_id: str) -> dict | None:
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            cursor = conn.execute(
                "SELECT * FROM orders WHERE id = ?",
                (str(order_id),),
            )
            row = cursor.fetchone()
            return _row_to_order(row) if row else None
        finally:
            conn.close()
    except Exception:
        pass
    return None


def format_uah(amount: float) -> str:
    rounded = round(amount * 100) / 100
    if abs(rounded - round(rounded)) < 1e-9:
        return f"{int(round(rounded))}"
    return f"{rounded:.2f}".rstrip("0").rstrip(".")


def is_courier_user(user_id: int | None) -> bool:
    if user_id is None:
        return False
    record = get_courier_record(str(user_id))
    return bool(record and record.get("status") == "active")


def get_courier_name(courier_id: str) -> str:
    record = get_courier_record(courier_id)
    return str((record or {}).get("name") or "Курьер")


def update_courier_position(user_id: int, lat: float, lon: float) -> None:
    COURIER_POSITIONS[str(user_id)] = {"lat": lat, "lon": lon}


def get_courier_delivering_order_id(courier_id: str) -> str | None:
    """Заказ курьера в статусе «в пути» (delivering / delivery)."""
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT id FROM orders
            WHERE courier_id = ?
              AND LOWER(status) IN ('delivery', 'delivering')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (str(courier_id).strip(),),
        ).fetchone()
        return str(row[0]) if row else None
    finally:
        conn.close()


def get_active_delivering_order_by_courier(courier_id: str) -> dict | None:
    """Активный заказ курьера в статусе delivering / delivery."""
    order_id = get_courier_delivering_order_id(courier_id)
    if not order_id:
        return None
    return get_order_from_db(order_id)


def get_courier_poekhali_pending_order(courier_id: str) -> dict | None:
    """
    Заказ курьера перед стартом «Поехали» (принят, ожидает выезд):
    active / paid / delivery.
    """
    cid = str(courier_id).strip()
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT id FROM orders
            WHERE courier_id = ?
              AND LOWER(status) IN ('active', 'paid', 'delivery')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (cid,),
        ).fetchone()
        if not row:
            return None
        return get_order_from_db(str(row[0]))
    finally:
        conn.close()


COURIER_COORDS_DB_MAX_RETRIES = 3
COURIER_COORDS_DB_RETRY_BASE_SEC = 0.2


def _commit_order_courier_coordinates_tx(
    oid: str,
    lat_f: float,
    lon_f: float,
    updated_at: str,
) -> str | None:
    """
    Одна транзакция SQLite: courier_lat/lon в items.
    Возвращает courier_id (может быть ""), None если заказ не найден.
    """
    conn = sqlite3.connect(db_path, timeout=15.0)
    try:
        conn.execute("PRAGMA busy_timeout = 5000")
        with conn:
            row = conn.execute(
                "SELECT items, courier_id FROM orders WHERE id = ?",
                (oid,),
            ).fetchone()
            if not row:
                return None

            items_raw, courier_id = row[0], row[1]
            try:
                blob = json.loads(items_raw) if items_raw else {}
            except (TypeError, json.JSONDecodeError):
                blob = {}
            if not isinstance(blob, dict):
                blob = {}

            blob["courier_lat"] = lat_f
            blob["courier_lon"] = lon_f
            blob["courier_location_updated_at"] = updated_at
            if coords_near_shop(blob.get("lat"), blob.get("lon")):
                blob.pop("lat", None)
                blob.pop("lon", None)

            cur = conn.execute(
                "UPDATE orders SET items = ? WHERE id = ?",
                (json.dumps(blob, ensure_ascii=False), oid),
            )
            if cur.rowcount < 1:
                raise sqlite3.DatabaseError(
                    f"UPDATE orders items: 0 rows for order {oid}"
                )
        return str(courier_id) if courier_id not in (None, "") else ""
    finally:
        conn.close()


def save_order_courier_coordinates(order_id: str, lat: float, lon: float) -> bool:
    """
    Жёстко перезаписывает фактические координаты курьера в JSON items заказа (commit)
    и в оперативном кэше COURIER_POSITIONS. До 3 попыток при ошибках SQLite.
    """
    oid = str(order_id or "").strip()
    if not oid:
        return False

    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return False

    updated_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    courier_id: str | None = None
    last_error: Exception | None = None

    for attempt in range(1, COURIER_COORDS_DB_MAX_RETRIES + 1):
        try:
            courier_id = _commit_order_courier_coordinates_tx(
                oid, lat_f, lon_f, updated_at
            )
            if courier_id is None:
                print(
                    f"save_order_courier_coordinates: заказ {oid} не найден",
                    file=sys.stderr,
                )
                return False
            last_error = None
            break
        except (sqlite3.OperationalError, sqlite3.DatabaseError, OSError) as db_err:
            last_error = db_err
            print(
                f"save_order_courier_coordinates: попытка {attempt}/"
                f"{COURIER_COORDS_DB_MAX_RETRIES} заказ {oid}: {db_err}",
                file=sys.stderr,
            )
            if attempt < COURIER_COORDS_DB_MAX_RETRIES:
                delay = COURIER_COORDS_DB_RETRY_BASE_SEC * (2 ** (attempt - 1))
                time.sleep(delay)

    if last_error is not None:
        return False

    if courier_id:
        try:
            update_courier_position(int(courier_id), lat_f, lon_f)
        except (TypeError, ValueError) as pos_err:
            print(
                f"save_order_courier_coordinates: кэш GPS курьера {courier_id}: {pos_err}",
                file=sys.stderr,
            )

    print(
        f"📍 ФАКТ-ГЕО: Заказ №{oid} обновлен реальными координатами курьера: {lat_f}, {lon_f}"
    )
    return True


def update_order_courier_coordinates(order_id: str, lat, lon) -> bool:
    """Быстрое обновление GPS курьера: оперативный кэш + courier_lat/lon в заказе."""
    oid = str(order_id or "").strip()
    if not oid:
        return False
    if not get_order_from_db(oid):
        return False
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return False
    return save_order_courier_coordinates(oid, lat_f, lon_f)


def persist_courier_live_location_to_db(
    courier_id: str,
    lat: float,
    lon: float,
    *,
    order_id: str | None = None,
) -> str | None:
    """Live GPS: оперативный кэш + courier_lat/lon в JSON items заказа."""
    cid = str(courier_id).strip()
    update_courier_position(int(cid), lat, lon)

    oid = str(order_id).strip() if order_id else None
    if not oid:
        oid = get_courier_delivering_order_id(cid)
    if not oid:
        return None

    if update_order_courier_coordinates(oid, lat, lon):
        return oid
    return None


def resolve_order_courier_coordinates(
    order_id: str, courier_id: str | None = None
) -> tuple[float | None, float | None]:
    """
    Актуальные координаты курьера для API: courier_lat/lon из items заказа
    (обновляются /api/courier/update_location), без подмены координатами магазина.
    """
    oid = str(order_id or "").strip()
    if not oid:
        return None, None

    blob = _read_order_items_blob(oid)
    try:
        clat = blob.get("courier_lat")
        clon = blob.get("courier_lon")
        if clat is not None and clon is not None:
            lat_f, lon_f = float(clat), float(clon)
            if courier_id:
                try:
                    update_courier_position(int(courier_id), lat_f, lon_f)
                except (TypeError, ValueError):
                    pass
            return lat_f, lon_f
    except (TypeError, ValueError):
        pass

    if courier_id:
        pos = COURIER_POSITIONS.get(str(courier_id), {})
        try:
            mlat = pos.get("lat")
            mlon = pos.get("lon")
            if mlat is not None and mlon is not None:
                lat_f, lon_f = float(mlat), float(mlon)
                if not coords_near_shop(lat_f, lon_f):
                    return lat_f, lon_f
        except (TypeError, ValueError):
            pass
    return None, None


def get_courier_position_for_order(
    courier_id: str | None, order_id: str
) -> tuple[float | None, float | None]:
    """GPS курьера для трекинга (совместимость — см. resolve_order_courier_coordinates)."""
    return resolve_order_courier_coordinates(order_id, courier_id)


def build_accept_order_keyboard(order_id: str) -> types.InlineKeyboardMarkup:
    keyboard = types.InlineKeyboardMarkup()
    keyboard.add(
        types.InlineKeyboardButton(
            text="Принять заказ 🤝",
            callback_data=f"accept_order_{order_id}",
        )
    )
    return keyboard


def order_is_courier_delivery(order_id: str) -> bool:
    order = get_order_from_db(order_id)
    if not order:
        return False
    items_blob = _read_order_items_blob(order_id)
    address = str(order.get("address") or items_blob.get("address") or "").strip()
    return bool(address)


def update_order_status_only(order_id: str, status: str) -> bool:
    """Обновляет статус заказа и сразу коммитит транзакцию (SQLite)."""
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            cur = conn.execute(
                "UPDATE orders SET status = ? WHERE id = ?",
                (str(status), str(order_id).strip()),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


def notify_couriers_about_delivery_order(
    bot,
    order_id: str,
    *,
    order_text: str | None = None,
    client_chat_id: int | str | None = None,
) -> int:
    """Рассылает курьерам кнопку «Принять заказ» для оплаченной доставки."""
    if bot is None or not order_is_courier_delivery(order_id):
        return 0

    oid = str(order_id).strip()
    if not order_text:
        items_blob = _read_order_items_blob(oid)
        order_text = str(items_blob.get("order_text_snapshot") or "").strip()
    if not order_text:
        order = get_order_from_db(oid)
        order_text = f"Заказ №{oid}"
        if order:
            cart = order.get("cart") or []
            if isinstance(cart, list) and cart:
                parts = [
                    f"{it.get('name', 'Товар')} × {it.get('quantity', 1)}"
                    for it in cart
                    if isinstance(it, dict)
                ]
                if parts:
                    order_text = f"Заказ №{oid}\n" + "\n".join(parts)

    courier_message = (
        f"🚚 Новый заказ на доставку (№{oid}):\n\n{order_text}\n\n"
        "Нажмите «Принять заказ», чтобы закрепить доставку за собой."
    )

    accept_keyboard = build_accept_order_keyboard(oid)
    save_courier_pool_messages(oid, {})
    sent_count = 0

    for courier in get_active_couriers():
        courier_id = str(courier["tg_id"])
        try:
            sent = bot.send_message(
                int(courier_id),
                courier_message,
                reply_markup=accept_keyboard,
            )
            record_courier_pool_message(oid, courier_id, sent.message_id)
            sent_count += 1
            print(f"🔥 Заказ №{oid} отправлен курьеру {courier_id}")
        except Exception as courier_err:
            print(
                f"Не удалось уведомить курьера {courier_id}: {courier_err}",
                file=sys.stderr,
            )
    return sent_count


def load_courier_pool_orders() -> list[dict]:
    """Заказы, доступные курьерам для принятия (оплачены, без назначенного курьера)."""
    placeholders = ",".join("?" * len(COURIER_POOL_ORDER_STATUSES))
    statuses_lower = tuple(s.lower() for s in COURIER_POOL_ORDER_STATUSES)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            f"""
            SELECT * FROM orders
            WHERE LOWER(status) IN ({placeholders})
              AND (courier_id IS NULL OR TRIM(COALESCE(courier_id, '')) = '')
            ORDER BY created_at DESC
            """,
            statuses_lower,
        ).fetchall()
        result: list[dict] = []
        for row in rows:
            order = _row_to_order(row)
            oid = str(order.get("id") or "")
            if oid and order_is_courier_delivery(oid):
                result.append(order)
        return result
    finally:
        conn.close()


def build_complete_order_keyboard(order_id: str) -> types.InlineKeyboardMarkup:
    keyboard = types.InlineKeyboardMarkup()
    keyboard.add(
        types.InlineKeyboardButton(
            text="📦 Выполнено",
            callback_data=f"complete_order_{order_id}",
        )
    )
    return keyboard


def build_track_order_url(
    public_url: str,
    order_id: str,
    *,
    lat: float | None = None,
    lon: float | None = None,
    courier_view: bool = False,
) -> str:
    """Ссылка Mini App: экран карты трекинга заказа (клиент или курьер)."""
    base = public_url.rstrip("/")
    sep = "&" if "?" in base else "?"
    url = f"{base}{sep}track_order=1&order_id={quote(str(order_id))}"
    if courier_view:
        url += "&courier_view=1"
    if lat is not None and lon is not None:
        url += f"&client_lat={lat}&client_lon={lon}"
    return url


def build_courier_tracking_map_url(public_url: str, order_id: str) -> str:
    """Карта трекинга для курьера («Поехали» → Mini App, не витрина магазина)."""
    client_lat, client_lon = resolve_order_client_coordinates(order_id)
    return build_track_order_url(
        public_url,
        order_id,
        lat=client_lat,
        lon=client_lon,
        courier_view=True,
    )


def build_courier_delivery_webapp_url(public_url: str, order_id: str) -> str:
    """Обратная совместимость: редирект на карту трекинга."""
    return build_courier_tracking_map_url(public_url, order_id)


def build_courier_fast_go_webapp_url(
    order_id: str,
    public_url: str | None = None,
    client_address: str | None = None,
) -> str | None:
    """Обратная совместимость: тот же URL, что у inline-кнопки «Поехали» (без Mini App)."""
    _ = client_address
    return build_courier_go_button_url(order_id, public_url)


def build_courier_fast_start_webapp_url(
    order_id: str,
    public_url: str | None = None,
    client_address: str | None = None,
) -> str | None:
    """Обратная совместимость → GET /api/courier/go/<order_id>."""
    return build_courier_go_button_url(order_id, public_url)


def build_courier_after_accept_keyboard(
    order_id: str,
    public_url: str | None = None,
    client_address: str | None = None,
) -> types.InlineKeyboardMarkup:
    """После принятия заказа: «Поехали» (навигатор) + «Выполнено»."""
    _ = client_address
    return build_courier_go_inline_keyboard(order_id, public_url)


def build_track_order_keyboard(
    public_url: str, lat: float, lon: float, order_id: str
) -> types.InlineKeyboardMarkup:
    track_url = build_track_order_url(
        public_url, order_id, lat=lat, lon=lon
    )
    keyboard = types.InlineKeyboardMarkup()
    keyboard.add(
        types.InlineKeyboardButton(
            text="Отследить заказ 🚚",
            web_app=types.WebAppInfo(url=track_url),
        )
    )
    return keyboard


def notify_client_order_submitted(
    bot,
    user_chat_id,
    order_id: str,
    public_url: str,
    *,
    client_lat: float | None = None,
    client_lon: float | None = None,
    initial_status: str = "",
) -> None:
    """Сообщение клиенту с кнопкой Mini App — якорь для возврата к заказу."""
    if bot is None or user_chat_id in (None, ""):
        return

    try:
        chat_id = int(user_chat_id)
    except (TypeError, ValueError):
        return

    base = str(public_url or resolve_public_base_url()).strip().rstrip("/")
    if not base:
        print(
            "notify_client_order_submitted: PUBLIC_URL не задан — сообщение клиенту пропущено",
            file=sys.stderr,
        )
        return

    lat = (
        float(client_lat)
        if client_lat is not None
        else SHOP_LATITUDE
    )
    lon = (
        float(client_lon)
        if client_lon is not None
        else SHOP_LONGITUDE
    )
    markup = build_track_order_keyboard(base, lat, lon, str(order_id))

    status_lower = str(initial_status or "").lower()
    status_hint = ""
    if status_lower == "pending_weight_verification":
        status_hint = (
            "\n\n⚖️ В заказе есть весовые товары — ожидаем подтверждение веса."
        )
    elif status_lower == "awaiting_payment":
        status_hint = "\n\n💳 Ожидается подтверждение оплаты."

    try:
        bot.send_message(
            chat_id,
            f"✅ Заказ №{order_id} оформлен!{status_hint}\n\n"
            "Нажмите кнопку ниже, чтобы отслеживать статус заказа.",
            reply_markup=markup,
        )
    except Exception as client_err:
        print(
            f"Не удалось отправить клиенту уведомление о заказе №{order_id}: {client_err}",
            file=sys.stderr,
        )


def escape_html(text: str) -> str:
    """Экранирование для Telegram parse_mode=HTML."""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def get_order_client_chat_id(order_id: str) -> int | None:
    cached = ORDERS_CLIENTS.get(str(order_id))
    if cached is not None:
        return int(cached)
    order = get_order_from_db(order_id)
    if not order:
        return None
    user_id = order.get("user_id")
    if user_id in (None, ""):
        return None
    try:
        chat_id = int(user_id)
        ORDERS_CLIENTS[str(order_id)] = chat_id
        return chat_id
    except (TypeError, ValueError):
        return None


def resolve_order_client_coordinates(
    order_id: str,
) -> tuple[float | None, float | None]:
    """Координаты клиента из заказа (items) или повторное геокодирование адреса."""
    client_lat, client_lon = get_order_delivery_coords(order_id)
    if client_lat is not None and client_lon is not None:
        return client_lat, client_lon

    order = get_order_from_db(order_id)
    address = str((order or {}).get("address") or "").strip()
    if address:
        lat, lon = get_coordinates(address)
        if lat is not None and lon is not None and not coords_near_shop(lat, lon):
            return lat, lon
    return None, None


def build_google_maps_route_url(
    origin_lat: float,
    origin_lon: float,
    dest_lat: float,
    dest_lon: float,
    *,
    navigate: bool = True,
) -> str:
    """Google Maps Directions: маршрут origin → destination."""
    url = (
        "https://www.google.com/maps/dir/?api=1"
        f"&origin={origin_lat},{origin_lon}"
        f"&destination={dest_lat},{dest_lon}"
        "&travelmode=driving"
    )
    if navigate:
        url += "&dir_action=navigate"
    return url


def build_google_maps_navigate_to_destination_url(
    dest_lat: float,
    dest_lon: float,
    *,
    navigate: bool = True,
) -> str:
    """
    Маршрут до клиента без origin — Google Maps берёт текущую GPS телефона курьера.
    """
    url = (
        "https://www.google.com/maps/dir/?api=1"
        f"&destination={dest_lat},{dest_lon}"
        "&travelmode=driving"
    )
    if navigate:
        url += "&dir_action=navigate"
    return url


def build_google_maps_navigate_to_address_url(
    address: str,
    *,
    origin_lat: float | None = None,
    origin_lon: float | None = None,
    navigate: bool = True,
) -> str:
    """Маршрут до адреса; origin опционален (иначе — текущая GPS телефона)."""
    dest = quote(str(address).strip())
    url = f"https://www.google.com/maps/dir/?api=1&destination={dest}&travelmode=driving"
    if origin_lat is not None and origin_lon is not None:
        url = (
            "https://www.google.com/maps/dir/?api=1"
            f"&origin={origin_lat},{origin_lon}"
            f"&destination={dest}"
            "&travelmode=driving"
        )
    if navigate:
        url += "&dir_action=navigate"
    return url


def resolve_courier_route_origin(
    order_id: str | None = None,
    order: dict | None = None,
    courier_id: str | None = None,
    *,
    prefer_lat: float | None = None,
    prefer_lon: float | None = None,
) -> tuple[float, float]:
    """Точка старта маршрута: текущая GPS курьера, иначе координаты магазина."""
    if prefer_lat is not None and prefer_lon is not None:
        try:
            return float(prefer_lat), float(prefer_lon)
        except (TypeError, ValueError):
            pass

    oid = str(order_id or "").strip()
    record = order
    if record is None and oid:
        record = get_order_from_db(oid)

    cid = courier_id
    if cid in (None, "") and record:
        cid = record.get("courier_id")

    if record:
        try:
            clat = record.get("courier_lat")
            clon = record.get("courier_lon")
            if clat is not None and clon is not None:
                return float(clat), float(clon)
        except (TypeError, ValueError):
            pass

    if oid:
        cou_lat, cou_lon = resolve_order_courier_coordinates(
            oid, str(cid) if cid not in (None, "") else None
        )
        if cou_lat is not None and cou_lon is not None:
            return cou_lat, cou_lon

    if cid not in (None, ""):
        pos = COURIER_POSITIONS.get(str(cid), {})
        try:
            mlat = pos.get("lat")
            mlon = pos.get("lon")
            if mlat is not None and mlon is not None:
                return float(mlat), float(mlon)
        except (TypeError, ValueError):
            pass

    return SHOP_LATITUDE, SHOP_LONGITUDE


def resolve_courier_navigator_url_for_order(
    order_id: str,
    *,
    courier_lat: float | None = None,
    courier_lon: float | None = None,
) -> str | None:
    """Маршрут Google Maps до клиента (без точки старта «магазин»)."""
    order = get_order_from_db(str(order_id).strip())
    if not order:
        return None
    return build_courier_go_maps_url(
        order,
        order_id,
        courier_lat=courier_lat,
        courier_lon=courier_lon,
    )


def resolve_public_base_url() -> str:
    """Базовый HTTPS-URL Mini App (PUBLIC_URL в окружении / .env)."""
    return os.getenv("PUBLIC_URL", "").strip().rstrip("/")


def build_courier_go_button_url(order_id: str, public_url: str | None = None) -> str | None:
    """URL «Поехали» → мгновенный 302 в Google Maps (без Mini App)."""
    base = (public_url or resolve_public_base_url()).strip().rstrip("/")
    if not base:
        return None
    oid = quote(str(order_id).strip(), safe="")
    return f"{base}/go/{oid}"


def resolve_courier_navigation_origin(
    order_id: str | None,
    order: dict,
    courier_id: str | None = None,
    *,
    prefer_lat: float | None = None,
    prefer_lon: float | None = None,
) -> tuple[float | None, float | None]:
    """
    Точка старта навигатора: только реальная GPS курьера.
    Координаты магазина не используются.
    """
    lat, lon = resolve_courier_go_start_coordinates(
        str(order_id or "").strip(),
        order,
        courier_id,
        prefer_lat=prefer_lat,
        prefer_lon=prefer_lon,
    )
    if lat is None or lon is None:
        return None, None
    if coords_near_shop(lat, lon):
        return None, None
    return lat, lon


def build_courier_go_maps_url(
    order: dict,
    order_id: str | None = None,
    *,
    courier_lat: float | None = None,
    courier_lon: float | None = None,
) -> str:
    """
    Google Maps до клиента от GPS курьера.
    Если GPS курьера нет — маршрут без origin (телефон подставит текущую позицию).
    """
    oid = str(order_id or order.get("id") or order.get("order_id") or "").strip()
    cid = order.get("courier_id")
    origin_lat, origin_lon = resolve_courier_navigation_origin(
        oid or None,
        order,
        str(cid) if cid not in (None, "") else None,
        prefer_lat=courier_lat,
        prefer_lon=courier_lon,
    )
    client_lat, client_lon = (
        resolve_order_client_coordinates(oid) if oid else (None, None)
    )

    if client_lat is not None and client_lon is not None:
        if origin_lat is not None and origin_lon is not None:
            return build_google_maps_route_url(
                origin_lat,
                origin_lon,
                client_lat,
                client_lon,
                navigate=True,
            )
        return build_google_maps_navigate_to_destination_url(
            client_lat, client_lon, navigate=True
        )

    address = str(order.get("address") or "").strip()
    if address:
        return build_google_maps_navigate_to_address_url(
            address,
            origin_lat=origin_lat,
            origin_lon=origin_lon,
            navigate=True,
        )

    if origin_lat is not None and origin_lon is not None:
        return (
            "https://www.google.com/maps/search/?api=1"
            f"&query={origin_lat},{origin_lon}"
        )
    return "https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate"


def apply_courier_go_delivery_start(
    order_id: str,
    order: dict | None = None,
    *,
    courier_lat: float | None = None,
    courier_lon: float | None = None,
) -> dict:
    """Статус delivering + сохранение GPS курьера для карты клиента."""
    oid = str(order_id).strip()
    record = order if order is not None else get_order_from_db(oid)
    if not record:
        raise ValueError("order_not_found")

    courier_id = record.get("courier_id")
    if courier_id not in (None, ""):
        assign_courier_to_order(oid, str(courier_id), status="delivering")
    else:
        update_order_status_only(oid, "delivering")

    if courier_lat is not None and courier_lon is not None:
        try:
            lat_f = float(courier_lat)
            lon_f = float(courier_lon)
            if not save_order_courier_coordinates(oid, lat_f, lon_f):
                print(
                    f"apply_courier_go_delivery_start: GPS не сохранён для заказа {oid}",
                    file=sys.stderr,
                )
            elif courier_id not in (None, ""):
                update_courier_position(int(courier_id), lat_f, lon_f)
        except (TypeError, ValueError) as coord_err:
            print(
                f"apply_courier_go_delivery_start: неверные координаты: {coord_err}",
                file=sys.stderr,
            )

    return record


def resolve_courier_go_start_coordinates(
    order_id: str,
    order: dict,
    courier_id: str | None,
    *,
    prefer_lat: float | None = None,
    prefer_lon: float | None = None,
) -> tuple[float | None, float | None]:
    """GPS для старта «Поехали»: аргументы → заказ → кэш курьера."""
    if prefer_lat is not None and prefer_lon is not None:
        try:
            return float(prefer_lat), float(prefer_lon)
        except (TypeError, ValueError):
            pass

    oid = str(order_id or "").strip()
    if oid:
        clat, clon = resolve_order_courier_coordinates(
            oid, str(courier_id) if courier_id not in (None, "") else None
        )
        if clat is not None and clon is not None:
            return clat, clon

    cid = str(courier_id or order.get("courier_id") or "").strip()
    if cid:
        pos = COURIER_POSITIONS.get(cid, {})
        try:
            mlat = pos.get("lat")
            mlon = pos.get("lon")
            if mlat is not None and mlon is not None:
                return float(mlat), float(mlon)
        except (TypeError, ValueError):
            pass

    return None, None


def courier_go_start_delivery(
    order_id: str,
    *,
    courier_id: str | None = None,
    courier_lat: float | None = None,
    courier_lon: float | None = None,
    bot=None,
    public_url: str | None = None,
    notify_courier_hint: bool = False,
) -> tuple[dict, str, bool]:
    """
    Один клик «Поехали»: delivering, GPS клиенту, уведомление клиенту, URL Google Maps.
    Возвращает (order, maps_url, coords_saved).
    """
    oid = str(order_id).strip()
    order = get_order_from_db(oid)
    if not order:
        raise ValueError("order_not_found")

    cid = str(courier_id or order.get("courier_id") or "").strip()
    lat, lon = resolve_courier_go_start_coordinates(
        oid, order, cid or None, prefer_lat=courier_lat, prefer_lon=courier_lon
    )
    coords_saved = lat is not None and lon is not None

    order = apply_courier_go_delivery_start(
        oid,
        order,
        courier_lat=lat,
        courier_lon=lon,
    )

    base = str(public_url or resolve_public_base_url() or "").strip()
    notify_client_courier_departed(
        bot,
        oid,
        base,
        has_courier_location=coords_saved,
    )
    if notify_courier_hint and bot is not None and not coords_saved:
        notify_courier_live_location_after_go(
            bot, oid, courier_chat_id=int(cid) if cid else None
        )

    maps_url = build_courier_go_maps_url(
        order,
        oid,
        courier_lat=lat,
        courier_lon=lon,
    )
    return order, maps_url, coords_saved


def build_courier_go_inline_keyboard(
    order_id: str,
    public_url: str | None = None,
) -> types.InlineKeyboardMarkup:
    """
    «Поехали» — прямая ссылка на Google Maps (1 тап, без Mini App).
    Старт доставки на сервере — через /go/<order_id> в том же URL (редирект).
    """
    keyboard = types.InlineKeyboardMarkup(row_width=1)
    order = get_order_from_db(str(order_id).strip()) or {}
    go_url = (
        build_courier_go_button_url(order_id, public_url)
        or build_courier_go_maps_url(order, order_id)
    )
    keyboard.add(
        types.InlineKeyboardButton(
            text="🚀 ПОЕХАЛИ! (Навигатор)",
            url=go_url,
        )
    )
    keyboard.add(
        types.InlineKeyboardButton(
            text="📦 Выполнено",
            callback_data=f"complete_order_{order_id}",
        )
    )
    return keyboard


def try_mark_courier_departure_client_notified(order_id: str) -> bool:
    """True, если клиенту ещё не отправляли уведомление о выезде курьера."""
    oid = str(order_id or "").strip()
    if not oid:
        return False

    blob = _read_order_items_blob(oid)
    if blob.get("courier_departure_client_notified"):
        return False

    blob["courier_departure_client_notified"] = True
    blob["courier_departure_client_notified_at"] = datetime.datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            conn.execute(
                "UPDATE orders SET items = ? WHERE id = ?",
                (json.dumps(blob, ensure_ascii=False), oid),
            )
    finally:
        conn.close()
    return True


def notify_courier_live_location_after_go(
    bot,
    order_id: str,
    *,
    courier_chat_id: str | int | None = None,
) -> None:
    """Подсказка курьеру, если авто-GPS не удалось (ручная трансляция в чат)."""
    if bot is None:
        return

    chat_id = courier_chat_id
    if chat_id is None:
        order = get_order_from_db(str(order_id).strip())
        if not order:
            return
        cid = order.get("courier_id")
        if cid in (None, ""):
            return
        try:
            chat_id = int(cid)
        except (TypeError, ValueError):
            return

    try:
        chat_id = int(chat_id)
    except (TypeError, ValueError):
        return

    oid = str(order_id).strip()
    try:
        bot.send_message(
            chat_id,
            f"✅ Заказ №{oid} — вы в пути.\n\n"
            "📍 Чтобы клиент видел вас на карте в реальном времени:\n"
            "📎 (скрепка) → Геопозиция → Транслировать (на 1 час)",
            disable_web_page_preview=True,
        )
    except Exception as notify_err:
        print(
            f"notify_courier_live_location_after_go: заказ {oid}: {notify_err}",
            file=sys.stderr,
        )


def notify_client_courier_departed(
    bot,
    order_id: str,
    public_url: str,
    *,
    has_courier_location: bool = False,
) -> None:
    """Telegram: клиенту о выезде курьера и кнопка отслеживания на карте."""
    if bot is None or not try_mark_courier_departure_client_notified(order_id):
        return

    client_chat_id = get_order_client_chat_id(order_id)
    if client_chat_id is None:
        return

    base = str(public_url or "").strip().rstrip("/")
    if not base:
        return

    client_lat, client_lon = resolve_order_client_coordinates(order_id)
    track_url = build_track_order_url(
        base, order_id, lat=client_lat, lon=client_lon
    )
    markup = types.InlineKeyboardMarkup()
    markup.add(
        types.InlineKeyboardButton(
            text="🗺️ Отследить заказ на карте",
            web_app=types.WebAppInfo(url=track_url),
        )
    )

    location_hint = (
        " Курьер уже отображается на карте."
        if has_courier_location
        else ""
    )
    try:
        bot.send_message(
            int(client_chat_id),
            f"🚗 Курьер выехал с вашим заказом №{order_id}!{location_hint}\n\n"
            "Нажмите кнопку ниже, чтобы открыть карту отслеживания.",
            reply_markup=markup,
        )
    except Exception as notify_err:
        print(
            f"notify_client_courier_departed: заказ {order_id}: {notify_err}",
            file=sys.stderr,
        )


def render_courier_go_geolocation_html(
    order_id: str, maps_url: str | None = None
) -> str:
    """
    Лёгкая страница «Поехали» (не магазин):
    авто-GPS → клиенту на карту → Google Maps, фоновые обновления координат.
    """
    oid_js = json.dumps(str(order_id).strip())
    _ = maps_url
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Поехали</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
body{{font-family:system-ui,sans-serif;margin:2rem;text-align:center;background:#0d0d0d;color:#eee}}
p{{line-height:1.45;font-size:15px;margin:0 0 10px}}
small{{color:rgba(255,255,255,.45);font-size:12px}}
</style>
</head>
<body>
<p id="status">Запрашиваем геопозицию…</p>
<small id="hint">Разрешите доступ к GPS — координаты уйдут клиенту автоматически</small>
<script>
(function () {{
  if ("serviceWorker" in navigator) {{
    navigator.serviceWorker.getRegistrations().then(function (regs) {{
      regs.forEach(function (r) {{ r.unregister(); }});
    }}).catch(function () {{}});
  }}
}})();

const orderId = {oid_js};
const postUrl = "/api/courier/go/" + encodeURIComponent(orderId);
const updateUrl = "/api/courier/update_location";
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const tg = window.Telegram && window.Telegram.WebApp;
let gpsWatchId = null;
let gpsIntervalId = null;
let mapsOpened = false;
let trackingActive = false;

function courierIdFromTg() {{
  try {{
    const id = tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id;
    return id != null ? String(id) : "";
  }} catch (e) {{
    return "";
  }}
}}

function buildPayload(lat, lon) {{
  const body = {{ order_id: orderId, lat: lat, lon: lon }};
  const cid = courierIdFromTg();
  if (cid) {{
    body.courier_id = cid;
    body.user_id = cid;
  }}
  return JSON.stringify(body);
}}

function pushLocation(lat, lon, useBeacon) {{
  const payload = buildPayload(lat, lon);
  if (useBeacon && navigator.sendBeacon) {{
    try {{
      navigator.sendBeacon(
        updateUrl,
        new Blob([payload], {{ type: "application/json" }})
      );
      return;
    }} catch (e) {{}}
  }}
  fetch(updateUrl, {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: payload,
    keepalive: true,
  }}).catch(function () {{}});
}}

function openMaps(redirectUrl) {{
  if (!redirectUrl || mapsOpened) return;
  mapsOpened = true;
  if (tg && typeof tg.openMapsUrl === "function") {{
    tg.openMapsUrl(redirectUrl);
  }} else if (tg && typeof tg.openLink === "function") {{
    tg.openLink(redirectUrl);
  }} else {{
    window.location.href = redirectUrl;
  }}
}}

function startGpsBroadcast() {{
  if (trackingActive) return;
  trackingActive = true;
  hintEl.textContent = "Геопозиция передаётся клиенту автоматически";

  if (navigator.geolocation) {{
    gpsWatchId = navigator.geolocation.watchPosition(
      function (pos) {{
        pushLocation(pos.coords.latitude, pos.coords.longitude, document.hidden);
      }},
      function () {{}},
      {{ enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 }}
    );
  }}

  gpsIntervalId = setInterval(function () {{
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      function (pos) {{
        pushLocation(pos.coords.latitude, pos.coords.longitude, document.hidden);
      }},
      function () {{}},
      {{ enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 }}
    );
  }}, 10000);
}}

function postStart(payload) {{
  return fetch(postUrl, {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: JSON.stringify(payload || {{}}),
  }}).then(function (r) {{
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }});
}}

function onCoords(coords) {{
  const body = coords
    ? {{ lat: coords.latitude, lon: coords.longitude }}
    : {{}};
  if (coords) {{
    pushLocation(coords.latitude, coords.longitude, false);
    startGpsBroadcast();
  }}
  statusEl.textContent = "Строим маршрут и открываем карты…";
  postStart(body)
    .then(function (data) {{
      statusEl.textContent = "Маршрут готов. Открываем Google Maps…";
      openMaps(data.redirect);
    }})
    .catch(function () {{
      statusEl.textContent = "Ошибка связи. Нажмите «Поехали» ещё раз.";
    }});
}}

function onGeoError() {{
  statusEl.textContent = "GPS недоступен. Открываем навигатор без точки старта…";
  onCoords(null);
}}

function requestBrowserGeo() {{
  if (!navigator.geolocation) {{
    onGeoError();
    return;
  }}
  statusEl.textContent = "Определяем вашу геопозицию…";
  navigator.geolocation.getCurrentPosition(
    function (pos) {{ onCoords(pos.coords); }},
    onGeoError,
    {{ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }}
  );
}}

function requestTelegramGeo() {{
  const lm = tg && tg.LocationManager;
  if (!lm || typeof lm.init !== "function") {{
    requestBrowserGeo();
    return;
  }}
  statusEl.textContent = "Запрашиваем GPS через Telegram…";
  lm.init(function (state) {{
    if (!state || !state.isInited) {{
      requestBrowserGeo();
      return;
    }}
    if (typeof lm.getLocation !== "function") {{
      requestBrowserGeo();
      return;
    }}
    lm.getLocation(function (loc) {{
      if (loc && loc.latitude != null && loc.longitude != null) {{
        onCoords({{ latitude: loc.latitude, longitude: loc.longitude }});
      }} else {{
        requestBrowserGeo();
      }}
    }});
  }});
}}

document.addEventListener("visibilitychange", function () {{
  if (!trackingActive || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    function (pos) {{
      pushLocation(pos.coords.latitude, pos.coords.longitude, true);
    }},
    function () {{}},
    {{ enableHighAccuracy: true, maximumAge: 3000, timeout: 12000 }}
  );
}});

if (tg && typeof tg.ready === "function") {{
  tg.ready();
  if (typeof tg.expand === "function") tg.expand();
}}

requestTelegramGeo();
</script>
</body>
</html>"""


def build_courier_start_delivery_webapp_url(
    order_id: str, public_url: str | None = None
) -> str | None:
    """Обратная совместимость → GET /api/courier/go/<order_id>."""
    return build_courier_go_button_url(order_id, public_url)


def build_google_maps_navigation_url(
    client_lat: float,
    client_lon: float,
    *,
    order_id: str | None = None,
    courier_id: str | None = None,
) -> str:
    """Google Maps: маршрут от GPS курьера до клиента (fallback — магазин)."""
    origin_lat, origin_lon = resolve_courier_route_origin(
        order_id, courier_id=courier_id
    )
    return build_google_maps_route_url(
        origin_lat,
        origin_lon,
        client_lat,
        client_lon,
    )


def build_courier_navigation_keyboard(
    navigation_url: str,
) -> types.InlineKeyboardMarkup:
    keyboard = types.InlineKeyboardMarkup()
    keyboard.add(
        types.InlineKeyboardButton(
            text="🧭 Открыть навигатор (В путь)",
            url=navigation_url,
        )
    )
    return keyboard


def get_courier_assigned_order(courier_id: str) -> tuple[str | None, str | None]:
    """Активный заказ курьера (active/delivery), самый свежий."""
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            """
            SELECT id, status FROM orders
            WHERE courier_id = ? AND LOWER(status) IN ('active', 'delivery', 'delivering')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (str(courier_id).strip(),),
        ).fetchone()
        if not row:
            return None, None
        return str(row[0]), str(row[1] or "")
    finally:
        conn.close()


def courier_start_delivery_core(
    bot,
    courier_id: str,
    public_url: str,
    *,
    order_id: str | None = None,
    reply_chat_id: int | None = None,
    courier_lat: float | None = None,
    courier_lon: float | None = None,
    send_courier_nav_message: bool = False,
) -> dict:
    """
    Старт доставки («Поехали»): статус delivering в БД, карта трекинга для курьера.
    Клиенту — только обновление Mini App (без bot.send_message).
    """
    result: dict = {
        "success": False,
        "status": "error",
        "order_id": None,
        "navigation_url": None,
        "tracking_url": None,
    }

    try:
        courier_id = str(courier_id).strip()
        order_status: str | None = None

        if order_id:
            order_id = str(order_id).strip()
            assigned_courier, order_status = get_order_assignment(order_id)
            if order_status is None:
                return result
            if assigned_courier and str(assigned_courier) != courier_id:
                print(
                    f"courier_start_delivery: заказ {order_id} у другого курьера",
                    file=sys.stderr,
                )
                return result
        else:
            order_id, order_status = get_courier_assigned_order(courier_id)

        if not order_id or str(order_status or "").lower() not in (
            "active",
            *COURIER_IN_TRANSIT_STATUSES,
        ):
            return result

        result["order_id"] = order_id
        starting_delivery = str(order_status or "").lower() == "active"

        if courier_lat is not None and courier_lon is not None:
            try:
                save_order_courier_coordinates(
                    order_id, float(courier_lat), float(courier_lon)
                )
                update_courier_position(int(courier_id), courier_lat, courier_lon)
            except Exception as pos_err:
                print(
                    f"Не удалось сохранить геопозицию курьера: {pos_err}",
                    file=sys.stderr,
                )

        try:
            status_updated = assign_courier_to_order(
                order_id, courier_id, status="delivering"
            )
        except Exception as db_err:
            print(
                f"Ошибка БД при смене статуса заказа №{order_id}: {db_err}",
                file=sys.stderr,
            )
            status_updated = False

        if not status_updated:
            print(
                f"Не удалось обновить статус заказа №{order_id} на delivering",
                file=sys.stderr,
            )

        result["success"] = True
        result["status"] = "success"

        client_lat, client_lon = resolve_order_client_coordinates(order_id)
        navigation_url = None
        tracking_url = None
        if public_url:
            tracking_url = build_courier_tracking_map_url(public_url, order_id)
            result["tracking_url"] = tracking_url
        if client_lat is not None and client_lon is not None:
            navigation_url = build_google_maps_navigation_url(
                client_lat,
                client_lon,
                order_id=order_id,
                courier_id=courier_id,
            )
            result["navigation_url"] = navigation_url

        if (
            send_courier_nav_message
            and reply_chat_id is not None
            and bot is not None
            and (tracking_url or navigation_url)
        ):
            try:
                markup = types.InlineKeyboardMarkup()
                if navigation_url:
                    markup.add(
                        types.InlineKeyboardButton(
                            text="🧭 Google Maps (В путь)",
                            url=navigation_url,
                        )
                    )
                if tracking_url:
                    markup.add(
                        types.InlineKeyboardButton(
                            text="🗺️ Карта в Mini App",
                            web_app=types.WebAppInfo(url=tracking_url),
                        )
                    )
                if starting_delivery:
                    courier_text = (
                        "🚀 Заказ в статусе «В пути».\n\n"
                        "Откройте навигатор Google Maps по кнопке ниже."
                    )
                else:
                    courier_text = (
                        "Навигатор и карта трекинга доступны по кнопкам ниже."
                    )
                bot.send_message(
                    int(reply_chat_id),
                    courier_text,
                    reply_markup=markup,
                )
            except Exception as courier_msg_err:
                print(
                    f"Не удалось отправить ссылки курьеру {courier_id}: "
                    f"{courier_msg_err}",
                    file=sys.stderr,
                )

        return result

    except Exception as exc:
        print(
            f"courier_start_delivery_core: неожиданная ошибка: {exc}",
            file=sys.stderr,
        )
        if result.get("order_id"):
            result["status"] = "success"
            result["success"] = True
        return result


def process_courier_delivery_start(
    bot,
    courier_id: str,
    public_url: str,
    *,
    reply_chat_id: int | None = None,
) -> bool:
    """Обёртка для обработчика геопозиции в Telegram-боте."""
    payload = courier_start_delivery_core(
        bot,
        courier_id,
        public_url,
        reply_chat_id=reply_chat_id,
        send_courier_nav_message=reply_chat_id is not None,
    )
    return bool(payload.get("success"))


def parse_client_coords(data: dict) -> tuple[float | None, float | None]:
    lat_raw = data.get("client_lat")
    lon_raw = data.get("client_lon")
    if lat_raw is None or lon_raw is None:
        return None, None
    try:
        return float(lat_raw), float(lon_raw)
    except (TypeError, ValueError):
        return None, None


def strip_previous_delivery_lines(order_text: str) -> str:
    base = (order_text or "").rstrip()
    base = re.sub(r"\n📍 Расстояние:.*(?=\n|$)", "", base)
    base = re.sub(r"\n📍 Расстояние от магазина:.*(?=\n|$)", "", base)
    base = re.sub(r"\n🚚 Доставка:.*(?=\n|$)", "", base)
    base = re.sub(r"\n🚚 Стоимость доставки:.*(?=\n|$)", "", base)
    base = re.sub(r"\n💰 Итого к оплате \(с учетом доставки\):.*(?=\n|$)", "", base)
    base = re.sub(r"\n💰 Итого с доставкой:.*(?=\n|$)", "", base)
    base = re.sub(r"\n💰 Итого:\s*[\d.,]+\s*₴\s*$", "", base.rstrip()).rstrip()
    return base


def build_delivery_receipt_block(
    distance_km: float, delivery_label: str, final_total: float
) -> str:
    distance_display = round(distance_km, 2)
    return (
        f"📍 Расстояние: {distance_display} км\n"
        f"🚚 Доставка: {delivery_label}\n"
        f"💰 Итого к оплате (с учетом доставки): {format_uah(final_total)} грн"
    )


def apply_dnipro_delivery_to_order(
    order_text: str,
    delivery_address: str,
    total_products_price: float,
    *,
    client_lat: float | None = None,
    client_lon: float | None = None,
) -> tuple[str, str | None, str | None, float | None, float | None]:
    """
    Расчёт доставки по Днепру: радиус 8 км, доставка 100 ₴ или бесплатно от 700 ₴.
    Возвращает (текст заказа, заметка клиенту, ошибка, lat, lon).
    """
    lat: float | None = None
    lon: float | None = None

    if client_lat is not None and client_lon is not None:
        lat = float(client_lat)
        lon = float(client_lon)
        print(
            f"Координаты из JSON (фронтенд): {delivery_address!r} -> {lat}, {lon}"
        )
    else:
        lat, lon = get_coordinates(delivery_address)
        if lat is not None and lon is not None:
            print(
                f"Координаты из геокодера (резерв): {delivery_address!r} -> {lat}, {lon}"
            )

    if lat is None or lon is None:
        err = "Не удалось определить адрес в Днепре. Уточните адрес доставки."
        print(f"Геокодирование не удалось: {delivery_address!r}", file=sys.stderr)
        return order_text, None, err, None, None

    # Origin: магазин (Ламаная 2) → Destination: адрес клиента
    distance = calculate_distance(
        SHOP_LATITUDE, SHOP_LONGITUDE, float(lat), float(lon)
    )
    distance_rounded = round(distance, 2)
    print(
        f"Доставка ({SHOP_ADDRESS} -> {delivery_address!r}): "
        f"{distance_rounded} км"
    )

    if distance > MAX_DELIVERY_RADIUS_KM:
        err = (
            f"Доставка недоступна. Ваш адрес находится в {distance_rounded} км "
            "от магазина, а мы доставляем строго в радиусе 8 км."
        )
        return order_text, None, err, None, None

    if total_products_price < FREE_DELIVERY_MIN_TOTAL:
        delivery_cost = DELIVERY_FEE_UAH
        delivery_label = f"{format_uah(delivery_cost)} грн"
    else:
        delivery_cost = 0
        delivery_label = "БЕСПЛАТНО"

    final_total = total_products_price + delivery_cost
    receipt_block = build_delivery_receipt_block(
        distance_rounded, delivery_label, final_total
    )

    updated_order = f"{strip_previous_delivery_lines(order_text)}\n{receipt_block}"
    return updated_order, receipt_block, None, lat, lon


def deliver_order_notifications(
    bot: telebot.TeleBot,
    admin_id: str,
    order_text: str,
    *,
    chat_id: int | str | None = None,
    username: str | None = None,
) -> tuple[bool, str | None]:
    """
    Пересылает заказ админу в Telegram. Клиент видит чек только в Mini App.
    Возвращает (успех, текст_ошибки).
    """
    admin_raw = str(admin_id or "").strip()
    if not admin_raw:
        return False, "ADMIN_ID не настроен на сервере"

    try:
        clean_admin_id = int(
            admin_raw.replace('"', "").replace("'", "").strip()
        )
    except ValueError:
        return False, "Некорректный ADMIN_ID на сервере"

    username_info = f"🔗 Аккаунт: @{username}\n" if username else ""
    user_id_line = (
        f"🆔 ID пользователя: {chat_id}\n" if chat_id is not None else ""
    )
    admin_message = f"🔔 {order_text}\n{username_info}{user_id_line}"

    print(f"Попытка отправки админу на ID: {clean_admin_id}")
    try:
        bot.send_message(clean_admin_id, admin_message)
        print("🔥 Заказ успешно доставлен в ЛС админу!")
        return True, None
    except Exception as send_err:
        print(
            f"❌ Ошибка bot.send_message админу ({clean_admin_id}): {send_err}",
            file=sys.stderr,
        )
        return False, f"Не удалось отправить заказ администратору: {send_err}"


def menu_web_app_url(public_url: str, admin_id: str) -> str:
    """
    Добавляет ?admin=<ADMIN_ID> к URL Mini App (или &admin= при уже имеющемся query).
    """
    base = public_url.rstrip("/")
    joiner = "&" if "?" in base else "?"
    return f"{base}{joiner}admin={quote(str(admin_id).strip(), safe='')}"


def tracking_status_media_config_path(uploads_dir: Path) -> Path:
    return uploads_dir / "tracking_status_media.json"


def read_tracking_status_media_config(uploads_dir: Path) -> dict[str, str]:
    path = tracking_status_media_config_path(uploads_dir)
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding=JSON_CHARSET))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key in TRACKING_STATUS_MEDIA_KEYS:
        val = str(raw.get(key) or "").strip()
        if val:
            out[key] = val
    return out


def write_tracking_status_media_config(
    uploads_dir: Path, config: dict[str, str]
) -> None:
    path = tracking_status_media_config_path(uploads_dir)
    filtered = {
        key: str(config.get(key) or "").strip()
        for key in TRACKING_STATUS_MEDIA_KEYS
        if str(config.get(key) or "").strip()
    }
    path.write_text(
        json.dumps(filtered, ensure_ascii=False, indent=2),
        encoding=JSON_CHARSET,
    )


def _uploads_rel_to_file(uploads_dir: Path, rel_path: str) -> Path | None:
    rel = str(rel_path or "").strip().replace("\\", "/")
    if not rel.startswith("uploads/"):
        return None
    fname = Path(rel).name
    if not fname or ".." in fname:
        return None
    target = (uploads_dir / fname).resolve()
    try:
        target.relative_to(uploads_dir.resolve())
    except ValueError:
        return None
    return target


def remove_tracking_media_file(uploads_dir: Path, rel_path: str) -> None:
    target = _uploads_rel_to_file(uploads_dir, rel_path)
    if target is None or not target.is_file():
        return
    try:
        target.unlink()
    except OSError as exc:
        print(f"Не удалось удалить медиа трекинга {target}: {exc}", file=sys.stderr)


def tracking_media_type_from_ext(ext: str) -> str:
    return "video" if str(ext or "").lower() in TRACKING_VIDEO_EXT else "image"


def tracking_media_type_from_filename(filename: str) -> str:
    return tracking_media_type_from_ext(Path(filename).suffix)


def remove_tracking_media_files_for_status(uploads_dir: Path, status: str) -> None:
    key = str(status or "").strip().lower()
    if key not in TRACKING_STATUS_MEDIA_KEYS:
        return
    prefix = TRACKING_STATUS_FILENAME_PREFIX.get(key, "")
    patterns = [f"{prefix}.*", f"tracking_{key}_*"] if prefix else [f"tracking_{key}_*"]
    seen: set[Path] = set()
    for pattern in patterns:
        for path in uploads_dir.glob(pattern):
            if not path.is_file():
                continue
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            try:
                resolved.unlink()
            except OSError as exc:
                print(
                    f"Не удалось удалить медиа трекинга {resolved}: {exc}",
                    file=sys.stderr,
                )


def find_tracking_media_rel(uploads_dir: Path, status: str) -> str:
    key = str(status or "").strip().lower()
    if key not in TRACKING_STATUS_MEDIA_KEYS:
        return ""

    rel = read_tracking_status_media_config(uploads_dir).get(key, "")
    if rel:
        target = _uploads_rel_to_file(uploads_dir, rel)
        if target is not None and target.is_file():
            return rel

    prefix = TRACKING_STATUS_FILENAME_PREFIX.get(key, "")
    if not prefix:
        return ""

    for path in sorted(uploads_dir.glob(f"{prefix}.*")):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext in ALLOWED_TRACKING_MEDIA_EXT:
            return f"uploads/{path.name}"
    return ""


def resolve_tracking_media_info(uploads_dir: Path, status: str) -> dict[str, str]:
    rel = find_tracking_media_rel(uploads_dir, status)
    if not rel:
        return {"media_url": "", "media_filename": "", "media_type": ""}

    filename = Path(rel).name
    media_type = tracking_media_type_from_filename(filename)
    return {
        "media_url": f"/uploads/{filename}",
        "media_filename": filename,
        "media_type": media_type,
    }


def resolve_tracking_media_url(uploads_dir: Path, status: str) -> str:
    return resolve_tracking_media_info(uploads_dir, status).get("media_url", "")


def remove_map_banner_files(uploads_dir: Path) -> None:
    for path in uploads_dir.glob(f"{MAP_BANNER_BASENAME}.*"):
        if not path.is_file():
            continue
        try:
            path.unlink()
        except OSError as exc:
            print(f"Не удалось удалить map_banner {path}: {exc}", file=sys.stderr)


def find_map_banner_rel(uploads_dir: Path) -> str:
    """Активный баннер карт, загруженный админом (map_banner.{ext})."""
    for path in sorted(uploads_dir.glob(f"{MAP_BANNER_BASENAME}.*")):
        if not path.is_file():
            continue
        if path.suffix.lower() in ALLOWED_TRACKING_MEDIA_EXT:
            return f"uploads/{path.name}"
    return ""


def find_map_banner_fallback_rel(uploads_dir: Path) -> str:
    for name in MAP_BANNER_FALLBACK_FILES:
        candidate = uploads_dir / name
        if candidate.is_file():
            return f"uploads/{name}"
    return ""


def _map_banner_info_from_rel(rel: str, *, is_fallback: bool) -> dict[str, str]:
    filename = Path(rel).name
    return {
        "ok": True,
        "media_url": f"/uploads/{filename}",
        "media_filename": filename,
        "media_type": tracking_media_type_from_filename(filename),
        "is_fallback": is_fallback,
    }


def resolve_map_banner_info(uploads_dir: Path) -> dict[str, str]:
    """
    Медиа над картой трекинга: сначала map_banner.* от админа,
    иначе запасной файл из MAP_BANNER_FALLBACK_FILES.
    """
    rel = find_map_banner_rel(uploads_dir)
    if rel:
        return _map_banner_info_from_rel(rel, is_fallback=False)

    fallback_rel = find_map_banner_fallback_rel(uploads_dir)
    if fallback_rel:
        return _map_banner_info_from_rel(fallback_rel, is_fallback=True)

    return {
        "ok": True,
        "media_url": "",
        "media_filename": "",
        "media_type": "",
        "is_fallback": True,
    }


def save_map_banner_upload(
    uploads_dir: Path,
    file_storage,
    save_image=None,
) -> tuple[dict[str, str] | None, str | None]:
    """
    Сохраняет map_banner.{оригинальное_расширение}, удаляя предыдущие map_banner.*.
    Возвращает (media_info, error_message).
    """
    if file_storage is None or not getattr(file_storage, "filename", None):
        return None, "Missing media file"

    orig = secure_filename(file_storage.filename or "") or "media"
    ext = Path(orig).suffix.lower()
    if ext not in ALLOWED_TRACKING_MEDIA_EXT:
        return (
            None,
            "Invalid media type. Allowed: jpg, jpeg, png, gif, webp, mp4, mov, webm",
        )

    remove_map_banner_files(uploads_dir)

    if ext in ALLOWED_IMAGE_EXT:
        try:
            if save_image is not None:
                rel = save_image(
                    file_storage,
                    prefix=MAP_BANNER_BASENAME,
                    max_width=1000,
                    final_filename=f"{MAP_BANNER_BASENAME}.webp",
                )
                if not rel:
                    return None, "Failed to save image"
            else:
                optimize_and_save_image(
                    file_storage,
                    uploads_dir,
                    MAP_BANNER_BASENAME,
                    max_width=1000,
                    quality=70,
                    final_filename=f"{MAP_BANNER_BASENAME}.webp",
                )
        except OSError as exc:
            return None, str(exc)
        return resolve_map_banner_info(uploads_dir), None

    fname = f"{MAP_BANNER_BASENAME}{ext}"
    dest = uploads_dir / fname
    try:
        file_storage.save(dest)
    except OSError as exc:
        return None, str(exc)

    return resolve_map_banner_info(uploads_dir), None


_RUNTIME_CONFIG_MARKER = "<!--RUNTIME_CONFIG-->"
_INDEX_HTML_GOOGLE_KEY_PLACEHOLDER = "__GOOGLE_MAPS_API_KEY__"


_INLINE_INITIAL_PRODUCTS_MARKER = "<!--INLINE_INITIAL_PRODUCTS-->"


def get_public_runtime_config() -> dict[str, str]:
    """Публичные настройки для фронтенда (без секретов бота)."""
    api_key = (config.GOOGLE_MAPS_API_KEY or "").strip()
    if api_key in ("", "YOUR_KEY_HERE", _INDEX_HTML_GOOGLE_KEY_PLACEHOLDER):
        api_key = ""
    return {"googleMapsApiKey": api_key}


def inject_runtime_public_config(html: str) -> str:
    """Встраивает window.__RUNTIME_CONFIG__ из GOOGLE_MAPS_API_KEY (.env)."""
    payload = json.dumps(get_public_runtime_config(), ensure_ascii=False)
    payload = payload.replace("</", "<\\/")
    script = f'<script id="runtime-public-config">window.__RUNTIME_CONFIG__={payload};</script>'
    if _RUNTIME_CONFIG_MARKER in html:
        return html.replace(_RUNTIME_CONFIG_MARKER, script, 1)
    return html.replace("<head>", f"<head>\n{script}\n", 1)


def inject_inline_initial_products(html: str, products_path: Path | None = None) -> str:
    """Встраивает каталог из БД в HTML."""
    if _INLINE_INITIAL_PRODUCTS_MARKER not in html:
        return html

    document = load_products_document()
    payload = json.dumps(document, ensure_ascii=False)
    payload = payload.replace("</", "<\\/")

    script = f"<script>window.__INITIAL_PRODUCTS__={payload};</script>"
    return html.replace(_INLINE_INITIAL_PRODUCTS_MARKER, script, 1)


def render_index_html(frontend_root: Path, products_path: Path | None = None) -> str:
    """Подставляет runtime-конфиг (GOOGLE_MAPS_API_KEY) и inline-каталог в index.html."""
    index_path = (frontend_root / "index.html").resolve()
    if not index_path.is_file():
        raise FileNotFoundError(
            f"Не найден {index_path} (frontend_root={frontend_root}, cwd={Path.cwd()})"
        )
    html = index_path.read_text(encoding="utf-8")
    html = inject_inline_initial_products(html, products_path)
    html = inject_runtime_public_config(html)
    # Удаляем устаревший тег с плейсхолдером, если остался в шаблоне
    return re.sub(
        r'\s*<script[^>]*maps\.googleapis\.com/maps/api/js[^>]*>\s*</script>\s*',
        "\n",
        html,
        count=1,
        flags=re.IGNORECASE,
    )


def _get_telegram_bot(app: Flask):
    """Бот из app.config или временный экземпляр по BOT_TOKEN (Render web без worker)."""
    bot = app.config.get("TELEGRAM_BOT")
    if bot is None and config.BOT_TOKEN:
        bot = telebot.TeleBot(config.BOT_TOKEN)
        print("Временный бот создан для отправки сообщения", file=sys.stderr)
    return bot


def create_app(
    frontend_root: Path,
    uploads_dir: Path,
    products_path: Path,
    admin_id: str,
    db_path_arg: Path | None = None,
) -> Flask:
    frontend_root = frontend_root.resolve()
    uploads_dir = uploads_dir.resolve()
    products_path = products_path.resolve()
    global db_path, products_catalog_path
    if db_path_arg is not None:
        db_path = db_path_arg.resolve()
    products_catalog_path = products_path.resolve()
    admin_normalized = str(admin_id).strip()

    uploads_dir.mkdir(parents=True, exist_ok=True)

    # Инициализация Cloudinary
    from .cloudinary_upload import init_cloudinary

    init_cloudinary()

    app = Flask(__name__)

    @app.get("/health")
    def health_check():
        return {"status": "ok", "service": "halal-shop"}

    @app.get("/api/health")
    def api_health():
        return {"status": "ok"}

    @app.route("/uploads/<path:filename>")
    def serve_upload(filename):
        """Отдаёт файлы из frontend/uploads (и из настроенной папки uploads)."""
        frontend_uploads = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "frontend", "uploads"
        )
        if not os.path.exists(frontend_uploads):
            os.makedirs(frontend_uploads, exist_ok=True)

        if ".." in filename.replace("\\", "/"):
            abort(404)
        safe_name = Path(filename).name
        if not safe_name:
            abort(404)

        for base_dir in (str(uploads_dir), frontend_uploads):
            file_path = os.path.join(base_dir, safe_name)
            if os.path.isfile(file_path):
                response = send_from_directory(base_dir, safe_name)
                ext = Path(safe_name).suffix.lower()
                if ext in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".mov", ".webm"}:
                    response.headers["Cache-Control"] = (
                        "public, max-age=31536000, immutable"
                    )
                return response
        abort(404)

    app.config["PUBLIC_URL"] = get_app_base_url()
    app.config["FRONTEND_ROOT"] = str(frontend_root)
    app.config["UPLOADS_DIR"] = str(uploads_dir)
    app.config["DATABASE_PATH"] = str(db_path)
    cache = Cache(app, config={"CACHE_TYPE": "SimpleCache"})

    def _products_list_cache_key(*args, **kwargs) -> str:
        return "products_list"

    def _invalidate_products_cache() -> None:
        cache.delete("products_list")

    register_products_catalog_cache_invalidate(_invalidate_products_cache)

    limiter = Limiter(
        get_remote_address,
        app=app,
        default_limits=["200 per day", "50 per hour"],
        storage_uri="memory://",
    )

    @app.errorhandler(429)
    def ratelimit_handler(e):
        return (
            jsonify(
                {
                    "ok": False,
                    "success": False,
                    "error": "Слишком много запросов. Пожалуйста, подождите минуту.",
                }
            ),
            429,
        )

    app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024  # 32 MB (видео для трекинга)
    app.config["UPLOAD_FOLDER"] = str(uploads_dir)

    def _inside_frontend(target: Path) -> bool:
        try:
            target.resolve().relative_to(frontend_root)
            return True
        except ValueError:
            return False

    @app.get("/")
    def serve_index():
        html = render_index_html(frontend_root, products_path)
        return Response(
            html,
            mimetype="text/html; charset=utf-8",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/api/config/public")
    def api_public_config():
        """Публичный конфиг для Mini App (Google Maps API key из окружения)."""
        return jsonify({"ok": True, **get_public_runtime_config()})

    @app.get("/api/products")
    @cache.cached(
        timeout=60,
        key_prefix="products_list",
        make_cache_key=_products_list_cache_key,
    )
    def api_products():
        """
        Всегда 200 и валидная структура { categories, products } из SQLite.
        """
        try:
            document = load_products_document()
        except Exception:
            document = {"categories": [], "products": []}

        resp = app.response_class(
            response=json.dumps(document, ensure_ascii=False, indent=2),
            status=200,
            mimetype="application/json; charset=utf-8",
        )
        resp.charset = JSON_CHARSET
        return resp

    def _save_upload(
        file_storage,
        prefix: str = "img",
        max_width: int = 400,
        final_filename: str | None = None,
    ) -> str | None:
        """Сохраняет изображение в Cloudinary вместо локальной папки."""
        if file_storage is None or file_storage.filename in ("", None):
            return None

        if prefix == "category":
            category_id = final_filename or f"cat_{int(time.time() * 1000)}"
            return upload_category_image(file_storage, category_id)
        product_id = final_filename or f"prod_{int(time.time() * 1000)}"
        return upload_product_image(file_storage, product_id)

    def _load_document_from_disk() -> dict:
        """Загружает каталог из БД (вместо JSON)."""
        return load_products_document()

    def _persist_document(document: dict) -> None:
        persist_products_document(document)

    def _admin_request_allowed() -> tuple[dict, str] | tuple[None, None]:
        if not admin_normalized:
            return None, None
        data = request.get_json(silent=True) or {}
        uid = str(data.get("user_id", "")).strip()
        if uid != admin_normalized:
            return None, None
        return data, uid

    def _product_id_from_payload(data: dict) -> str:
        return str(data.get("id") or data.get("product_id") or "").strip()

    def _try_remove_product_image(image_path: str | None) -> None:
        if not image_path:
            return
        rel = str(image_path).strip().replace("\\", "/")
        if not rel.startswith("uploads/"):
            return
        target = uploads_dir / Path(rel).name
        if target.is_file():
            try:
                target.unlink()
            except OSError:
                pass

    def _placeholder_category_image(title: str) -> str:
        t = quote((title or "?")[:12], safe="")
        return f"https://placehold.co/100x100?text={t}"

    def _placeholder_product_image() -> str:
        return "https://placehold.co/150x150"

    def _apply_uploads_to_document(document: dict, files_map) -> None:
        """
        Ожидаемые имена полей файлов:
          image_category_<category_id>
          image_product_<product_id>
        где id совпадают с полями id в JSON после сохранения клиента.
        """
        if not files_map:
            return

        for key, fs in files_map.items():
            if not key or fs is None or not getattr(fs, "filename", None):
                continue

            if key.startswith("image_category_"):
                rel_url = _save_upload(fs, prefix="category")
            elif key.startswith("image_product_"):
                rel_url = _save_upload(fs, prefix="product")
            else:
                rel_url = _save_upload(fs, prefix="product")
            if not rel_url:
                continue

            if key.startswith("image_category_"):
                cid = key[len("image_category_") :]
                for cat in document["categories"]:
                    if str(cat.get("id")) == cid:
                        cat["image"] = rel_url
                        break

            elif key.startswith("image_product_"):
                pid = key[len("image_product_") :]
                for prod in document["products"]:
                    if str(prod.get("id")) == pid:
                        prod["image"] = rel_url
                        break

    @app.post("/api/save_products")
    @limiter.limit("20 per minute")
    def api_save_products():
        print("=" * 50, flush=True)
        print("🚀 ВЫЗОВ API /api/save_products", flush=True)
        print(f"Content-Type: {request.content_type}", flush=True)
        print(
            f"Form data keys: {list(request.form.keys()) if request.form else 'None'}",
            flush=True,
        )
        print(
            f"Files keys: {list(request.files.keys()) if request.files else 'None'}",
            flush=True,
        )
        print("=" * 50, flush=True)
        if not admin_normalized:
            print("save_products: ADMIN_ID not configured", flush=True)
            return jsonify({"ok": False, "error": "ADMIN_ID is not configured"}), 403

        if request.content_type and "multipart/form-data" in request.content_type:
            op = (request.form.get("operation") or "").strip()
            print(f"save_products: multipart operation={op!r}", flush=True)

            if op == "add_category":
                uid = str(request.form.get("user_id", "")).strip()
                if uid != admin_normalized:
                    return jsonify({"ok": False, "error": "Forbidden"}), 403
                title = (
                    request.form.get("category_title")
                    or request.form.get("title")
                    or ""
                ).strip()
                if not title:
                    return jsonify({"ok": False, "error": "Missing category title"}), 400
                fs = request.files.get("image") or request.files.get("file")
                document = _load_document_from_disk()
                cat_id = f"cat_{int(time.time() * 1000)}"
                rel = _save_upload(fs, prefix="category") if fs else None
                image_url = rel or _placeholder_category_image(title)
                document["categories"].append(
                    {"id": cat_id, "title": title, "image": image_url}
                )
                try:
                    _persist_document(document)
                except OSError as exc:
                    return jsonify({"ok": False, "error": str(exc)}), 500
                return jsonify({"ok": True})

            if op == "add_product":
                uid = str(request.form.get("user_id", "")).strip()
                print(f"save_products add_product: user_id={uid!r}", flush=True)
                if uid != admin_normalized:
                    print("save_products add_product: Forbidden (user_id)", flush=True)
                    return jsonify({"ok": False, "error": "Forbidden"}), 403
                category_id = str(request.form.get("category_id", "")).strip()
                name = (request.form.get("name") or "").strip()
                price_raw = request.form.get("price")
                try:
                    price = float(price_raw)
                except (TypeError, ValueError):
                    print(f"save_products add_product: Invalid price {price_raw!r}", flush=True)
                    return jsonify({"ok": False, "error": "Invalid price"}), 400
                if price < 0:
                    return jsonify({"ok": False, "error": "Invalid price"}), 400
                if not name:
                    print("save_products add_product: Missing name", flush=True)
                    return jsonify({"ok": False, "error": "Missing product name"}), 400
                if not category_id:
                    print("save_products add_product: Missing category_id", flush=True)
                    return jsonify({"ok": False, "error": "Missing category_id"}), 400

                document = _load_document_from_disk()
                if not any(
                    str(c.get("id")) == category_id for c in document["categories"]
                ):
                    print(
                        f"save_products add_product: Unknown category {category_id!r}",
                        flush=True,
                    )
                    return jsonify({"ok": False, "error": "Unknown category"}), 400

                fs = request.files.get("image") or request.files.get("file")
                prod_id = f"prod_{int(time.time() * 1000)}"
                rel = _save_upload(fs, prefix="product") if fs else None
                image_url = rel or _placeholder_product_image()
                unit_type = normalize_unit_type(request.form.get("unit_type"))
                is_weight = unit_type == "weight"
                new_product = Product(
                    id=prod_id,
                    category_id=category_id,
                    name=name,
                    price=price,
                    image=image_url,
                    unit_type=unit_type,
                    price_per_unit="100g" if is_weight else "pcs",
                    is_weight_item=is_weight,
                    stock_quantity=0,
                    in_stock=True if is_weight else False,
                )
                document["products"].append(
                    sync_product_stock_fields(new_product.to_dict())
                )
                print(
                    f"save_products add_product: persisting id={prod_id!r} "
                    f"name={name!r} image={image_url!r}",
                    flush=True,
                )
                try:
                    _persist_document(document)
                except OSError as exc:
                    print(f"save_products add_product: OSError {exc!r}", flush=True)
                    return jsonify({"ok": False, "error": str(exc)}), 500
                except Exception as exc:
                    print(f"save_products add_product: ERROR {exc!r}", flush=True)
                    raise
                print(f"save_products add_product: OK id={prod_id!r}", flush=True)
                return jsonify({"ok": True})

            raw_json = request.form.get("payload") or request.form.get("data") or ""
            if not raw_json.strip():
                return jsonify(
                    {"ok": False, "error": "Missing form field `payload` (JSON string)"}
                ), 400
            try:
                payload = json.loads(raw_json)
            except json.JSONDecodeError:
                return jsonify({"ok": False, "error": "Invalid JSON in `payload`"}), 400
            files_map = request.files
        else:
            payload = request.get_json(force=True, silent=False)
            if not isinstance(payload, dict):
                return jsonify({"ok": False, "error": "Expected JSON object"}), 400
            files_map = None

        if str(payload.get("user_id", "")).strip() != admin_normalized:
            print("save_products: Forbidden (JSON user_id)", flush=True)
            return jsonify({"ok": False, "error": "Forbidden"}), 403

        categories = payload.get("categories")
        products = payload.get("products")
        if not isinstance(categories, list):
            return jsonify({"ok": False, "error": "Expected `categories` array"}), 400
        if not isinstance(products, list):
            return jsonify({"ok": False, "error": "Expected `products` array"}), 400

        document = {"categories": categories, "products": products}
        print(
            f"save_products JSON: {len(categories)} categories, {len(products)} products",
            flush=True,
        )

        if files_map:
            _apply_uploads_to_document(document, files_map)

        persist_products_document_to_db(document)
        cache.delete("products_list")
        print("save_products JSON: OK", flush=True)
        return jsonify({"ok": True})

    @app.post("/api/admin/toggle_stock")
    @limiter.limit("10 per minute")
    def api_admin_toggle_stock():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403

        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        product_id = _product_id_from_payload(data)
        if not product_id:
            return jsonify({"success": False, "error": "Missing product id"}), 400

        document = _load_document_from_disk()
        found = False
        for prod in document["products"]:
            if str(prod.get("id")) == product_id:
                if not product_is_weight_item(prod):
                    return jsonify(
                        {
                            "success": False,
                            "error": "Для штучного товара укажите количество на складе",
                        }
                    ), 400
                prod["in_stock"] = not bool(prod.get("in_stock", True))
                sync_product_stock_fields(prod)
                found = True
                break

        if not found:
            return jsonify({"success": False, "error": "Product not found"}), 404

        try:
            _persist_document(document)
        except OSError as exc:
            return jsonify({"success": False, "error": str(exc)}), 500

        cache.delete("products_list")
        print(f"toggle_stock: {product_id!r} by admin {uid!r}")
        return jsonify({"success": True})

    @app.post("/api/admin/set_stock_quantity")
    @limiter.limit("20 per minute")
    def api_admin_set_stock_quantity():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403

        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        product_id = _product_id_from_payload(data)
        if not product_id:
            return jsonify({"success": False, "error": "Missing product id"}), 400

        try:
            stock_quantity = max(0, int(float(data.get("stock_quantity", 0))))
        except (TypeError, ValueError):
            return jsonify(
                {"success": False, "error": "Invalid stock_quantity"}
            ), 400

        document = _load_document_from_disk()
        found = False
        for prod in document["products"]:
            if str(prod.get("id")) == product_id:
                if product_is_weight_item(prod):
                    return jsonify(
                        {
                            "success": False,
                            "error": "Для весового товара используйте переключатель наличия",
                        }
                    ), 400
                prod["stock_quantity"] = stock_quantity
                prod["is_weight_item"] = False
                sync_product_stock_fields(prod)
                found = True
                break

        if not found:
            return jsonify({"success": False, "error": "Product not found"}), 404

        try:
            _persist_document(document)
        except OSError as exc:
            return jsonify({"success": False, "error": str(exc)}), 500

        cache.delete("products_list")
        print(
            f"set_stock_quantity: {product_id!r} -> {stock_quantity} by admin {uid!r}"
        )
        return jsonify({"success": True, "stock_quantity": stock_quantity})

    @app.post("/api/admin/delete_product")
    @limiter.limit("10 per minute")
    def api_admin_delete_product():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403

        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        product_id = _product_id_from_payload(data)
        if not product_id:
            return jsonify({"success": False, "error": "Missing product id"}), 400

        document = _load_document_from_disk()
        removed_image: str | None = None
        remaining: list[dict] = []
        for prod in document["products"]:
            if str(prod.get("id")) == product_id:
                removed_image = prod.get("image")
                continue
            remaining.append(prod)

        if len(remaining) == len(document["products"]):
            return jsonify({"success": False, "error": "Product not found"}), 404

        document["products"] = remaining
        try:
            _persist_document(document)
            _try_remove_product_image(
                str(removed_image) if removed_image is not None else None
            )
        except OSError as exc:
            return jsonify({"success": False, "error": str(exc)}), 500

        cache.delete("products_list")
        print(f"delete_product: {product_id!r} by admin {uid!r}")
        return jsonify({"success": True})

    def _resolve_banner_path() -> str:
        for name in ("banner.webp", "banner.jpg"):
            if (uploads_dir / name).is_file():
                return f"uploads/{name}"
        default_file = uploads_dir / "default_banner.jpg"
        if default_file.is_file():
            return "uploads/default_banner.jpg"
        return ""

    @app.get("/api/get_banner")
    def api_get_banner():
        path = _resolve_banner_path()
        print(f"GET /api/get_banner -> {path!r}")
        return jsonify({"path": path})

    @app.get("/api/get_map_banner")
    def api_get_map_banner():
        """Медиа-баннер над картой трекинга (фото/видео) или fallback."""
        info = resolve_map_banner_info(uploads_dir)
        return jsonify(info)

    def _upload_map_banner_handler():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403

        uid = str(request.form.get("user_id", "")).strip()
        if uid != admin_normalized:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        fs = (
            request.files.get("media")
            or request.files.get("file")
            or request.files.get("banner")
        )
        media_info, err = save_map_banner_upload(uploads_dir, fs, _save_upload)
        if err:
            status = 400 if "Invalid" in err or "Missing" in err else 500
            return jsonify({"success": False, "error": err}), status

        print(
            f"map_banner -> {media_info.get('media_filename')!r} "
            f"({media_info.get('media_type')}) by admin {uid!r}"
        )
        return jsonify(
            {
                "success": True,
                "path": f"uploads/{media_info.get('media_filename', '')}",
                **media_info,
            }
        )

    @app.post("/api/upload_map_banner")
    @limiter.limit("20 per minute")
    def api_upload_map_banner():
        """Загрузка медиа-баннера для карт (только админ)."""
        return _upload_map_banner_handler()

    @app.post("/api/upload_banner")
    @limiter.limit("10 per minute")
    def api_upload_banner():
        print("=== POST /api/upload_banner ===")
        uid = str(request.form.get("user_id", "")).strip()
        print(f"user_id={uid!r}, ожидаемый admin={admin_normalized!r}")

        if not admin_normalized:
            print("Отказ: ADMIN_ID не настроен", file=sys.stderr)
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403

        if uid != admin_normalized:
            print(f"Отказ upload_banner: не админ (user_id={uid!r})", file=sys.stderr)
            return jsonify({"success": False, "error": "Forbidden"}), 403

        fs = request.files.get("banner")
        if fs is None or not getattr(fs, "filename", None):
            print("Отказ: файл banner не передан", file=sys.stderr)
            return jsonify({"success": False, "error": "Missing banner file"}), 400

        orig = secure_filename(fs.filename or "") or "banner"
        ext = Path(orig).suffix.lower()
        if ext not in ALLOWED_IMAGE_EXT:
            print(f"Отказ: недопустимое расширение {ext!r}", file=sys.stderr)
            return jsonify({"success": False, "error": "Invalid image type"}), 400

        for old_name in ("banner.jpg", "banner.webp"):
            old_path = uploads_dir / old_name
            if old_path.is_file():
                try:
                    old_path.unlink()
                except OSError:
                    pass

        try:
            image_url = _save_upload(
                fs,
                prefix="banner",
                max_width=1000,
                final_filename="banner.webp",
            )
            if not image_url:
                return jsonify(
                    {"success": False, "error": "Failed to save banner"}
                ), 500
        except OSError as exc:
            print(f"Ошибка сохранения баннера: {exc}", file=sys.stderr)
            return jsonify({"success": False, "error": str(exc)}), 500

        print(f"Баннер сохранён: {image_url}")
        return jsonify({"success": True, "path": image_url})

    @app.get("/api/admin/map_banner")
    def api_admin_get_map_banner():
        if not _admin_query_allowed():
            return jsonify({"success": False, "error": "Forbidden"}), 403
        info = resolve_map_banner_info(uploads_dir)
        return jsonify({"success": True, **info})

    @app.post("/api/admin/upload_map_banner")
    @limiter.limit("20 per minute")
    def api_admin_upload_map_banner():
        """Алиас для совместимости с админкой."""
        return _upload_map_banner_handler()

    def _admin_json_allowed() -> tuple[dict, str] | tuple[None, None]:
        if not admin_normalized:
            return None, None
        data = request.get_json(silent=True) or {}
        uid = str(data.get("user_id", "")).strip()
        if uid != admin_normalized:
            return None, None
        return data, uid

    def _admin_query_allowed() -> bool:
        if not admin_normalized:
            return False
        uid = str(request.args.get("user_id", "")).strip()
        return uid == admin_normalized

    @app.get("/api/admin/couriers")
    def api_admin_couriers():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403
        if not _admin_query_allowed():
            return jsonify({"success": False, "error": "Forbidden"}), 403
        return jsonify({"success": True, "couriers": get_couriers_list_for_api()}), 200

    @app.post("/api/admin/add_courier")
    @limiter.limit("10 per minute")
    def api_admin_add_courier():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403
        data, uid = _admin_json_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        courier_id = str(data.get("id", "")).strip()
        name = str(data.get("name", "")).strip()
        phone = str(data.get("phone", "")).strip()
        if not courier_id or not name:
            return jsonify(
                {"success": False, "error": "Missing id or name"}
            ), 400
        try:
            int(courier_id)
        except ValueError:
            return jsonify(
                {"success": False, "error": "Invalid courier id"}
            ), 400

        upsert_courier(courier_id, name, phone=phone, status="active")
        print(f"add_courier: {courier_id!r} ({name!r}) by admin {uid!r}")
        return jsonify({"success": True})

    @app.post("/api/admin/delete_courier")
    @limiter.limit("10 per minute")
    def api_admin_delete_courier():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403
        data, uid = _admin_json_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        courier_id = str(data.get("id", "")).strip()
        if not courier_id:
            return jsonify({"success": False, "error": "Missing id"}), 400

        delete_courier_from_db(courier_id)
        COURIER_POSITIONS.pop(courier_id, None)
        print(f"delete_courier: {courier_id!r} by admin {uid!r}")
        return jsonify({"success": True})

    @app.post("/api/admin/assign_courier")
    @limiter.limit("10 per minute")
    def api_admin_assign_courier():
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403
        data, uid = _admin_json_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        order_id = str(data.get("order_id") or data.get("id") or "").strip()
        courier_id = str(
            data.get("courier_id") or data.get("tg_id") or ""
        ).strip()
        if not order_id or not courier_id:
            return jsonify(
                {"success": False, "error": "Missing order_id or courier_id"}
            ), 400

        if not get_order_from_db(order_id):
            return jsonify({"success": False, "error": "Order not found"}), 404

        courier = get_courier_record(courier_id)
        if not courier:
            return jsonify({"success": False, "error": "Courier not found"}), 404

        if not assign_courier_to_order(order_id, courier_id, status="delivery"):
            return jsonify(
                {"success": False, "error": "Failed to assign courier"}
            ), 500

        bot = _get_telegram_bot(app)
        if bot is not None:
            courier_name = courier.get("name") or "Курьер"
            courier_phone = courier.get("phone") or ""
            phone_line = f"\n📞 Телефон: {courier_phone}" if courier_phone else ""
            try:
                bot.send_message(
                    int(courier_id),
                    f"🚚 Вам назначен заказ №{order_id}\n"
                    f"Курьер: {courier_name}{phone_line}",
                )
            except Exception as notify_err:
                print(
                    f"assign_courier: notify failed for {courier_id!r}: {notify_err}",
                    file=sys.stderr,
                )

        print(f"assign_courier: order {order_id!r} -> {courier_id!r} by admin {uid!r}")
        return jsonify({"success": True})

    @app.get("/api/admin/stats")
    def api_admin_stats():
        if not _admin_query_allowed():
            return jsonify({"success": False, "error": "Forbidden"}), 403
        orders = load_all_orders()

        today_str = datetime.datetime.now().strftime("%Y-%m-%d")
        revenue_today = sum(
            o["total"]
            for o in orders
            if o.get("date_short") == today_str and o.get("status") == "completed"
        )
        revenue_total = sum(
            o["total"] for o in orders if o.get("status") == "completed"
        )

        top_products = {}
        for o in orders:
            for item in o.get("cart", []):
                name = item.get("name") or item.get("title")
                count = int(item.get("count", 1) or item.get("quantity", 1))
                if name:
                    top_products[name] = top_products.get(name, 0) + count
        sorted_tops = sorted(top_products.items(), key=lambda x: x[1], reverse=True)[
            :5
        ]

        processing_cnt = sum(1 for o in orders if o.get("status") == "processing")
        active_cnt = sum(1 for o in orders if o.get("status") == "active")
        completed_cnt = sum(1 for o in orders if o.get("status") == "completed")

        return jsonify(
            {
                "success": True,
                "stats": {
                    "revenue_today": revenue_today,
                    "revenue_total": revenue_total,
                    "counts": {
                        "processing": processing_cnt,
                        "active": active_cnt,
                        "completed": completed_cnt,
                    },
                    "top_products": sorted_tops,
                },
            }
        )

    @app.post("/api/admin/edit_product")
    @limiter.limit("10 per minute")
    def api_admin_edit_product():
        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403
        pid = str(data.get("id", "")).strip()
        new_name = str(data.get("name", "")).strip()
        new_price = float(data.get("price", 0))
        unit_type_raw = data.get("unit_type")

        document = _load_document_from_disk()
        for p in document["products"]:
            if str(p.get("id")) == pid:
                if new_name:
                    p["name"] = new_name
                p["price"] = new_price
                if unit_type_raw is not None and str(unit_type_raw).strip():
                    unit_type = normalize_unit_type(unit_type_raw)
                    p["unit_type"] = unit_type
                    p["is_weight_item"] = unit_type == "weight"
                    p["price_per_unit"] = "100g" if unit_type == "weight" else "pcs"
                sync_product_stock_fields(p)
                break
        _persist_document(document)
        cache.delete("products_list")
        print(f"edit_product: {pid!r} by admin {uid!r}")
        return jsonify({"success": True})

    @app.post("/api/admin/set_discount")
    @limiter.limit("10 per minute")
    def api_admin_set_discount():
        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        pid = str(data.get("id") or data.get("product_id") or "").strip()
        if not pid:
            return jsonify({"success": False, "error": "Missing product id"}), 400

        discount = normalize_discount_value(data.get("discount", 0))

        document = _load_document_from_disk()
        found = False
        for product in document["products"]:
            if str(product.get("id")) == pid:
                product["discount"] = discount
                found = True
                break

        if not found:
            return jsonify({"success": False, "error": "Product not found"}), 404

        _persist_document(document)
        cache.delete("products_list")
        print(f"set_discount: {pid!r} -> {discount}% by admin {uid!r}")
        return jsonify({"success": True, "id": pid, "discount": discount})

    @app.post("/api/admin/update_price")
    @limiter.limit("10 per minute")
    def api_admin_update_price():
        if not admin_normalized:
            return jsonify({"ok": False, "error": "ADMIN_ID is not configured"}), 403

        data, uid = _admin_json_allowed()
        if data is None:
            return jsonify({"ok": False, "error": "Forbidden"}), 403

        product_id = str(data.get("product_id") or data.get("id") or "").strip()
        if not product_id:
            return jsonify({"ok": False, "error": "Missing product_id"}), 400

        if data.get("new_price") is None:
            return jsonify({"ok": False, "error": "Missing new_price"}), 400

        try:
            new_price = float(data.get("new_price"))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "Invalid new_price"}), 400

        if new_price <= 0:
            return jsonify(
                {"ok": False, "error": "new_price must be a positive number"}
            ), 400

        document = _load_document_from_disk()
        found = False
        for product in document["products"]:
            if str(product.get("id")) == product_id:
                found = True
                break

        if not found:
            return jsonify({"ok": False, "error": "Product not found"}), 404

        conn = sqlite3.connect(db_path)
        try:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE products SET price = ? WHERE id = ?",
                (new_price, product_id),
            )
            if cursor.rowcount == 0:
                cursor.execute(
                    "INSERT INTO products (id, price) VALUES (?, ?)",
                    (product_id, new_price),
                )
            conn.commit()
        except sqlite3.Error as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500
        finally:
            conn.close()

        cache.delete("products_list")

        for product in document["products"]:
            if str(product.get("id")) == product_id:
                product["price"] = new_price
                break

        try:
            _persist_document(document)
        except OSError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 500

        print(f"update_price: {product_id!r} -> {new_price} by admin {uid!r}")
        return jsonify({"ok": True, "message": "Цена успешно обновлена"})

    @app.get("/api/admin/promocodes")
    def api_admin_promocodes():
        if not _admin_query_allowed():
            return jsonify({"success": False, "error": "Forbidden"}), 403
        return jsonify({"success": True, "promocodes": list_promocodes_for_admin()})

    @app.post("/api/admin/add_promocode")
    @limiter.limit("10 per minute")
    def api_admin_add_promocode():
        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        code = normalize_promo_code(data.get("code") or "")
        if not code:
            return jsonify({"success": False, "error": "Missing code"}), 400

        discount_percent = normalize_discount_value(
            data.get("discount_percent", data.get("discount", 0))
        )
        if discount_percent <= 0:
            return (
                jsonify(
                    {"success": False, "error": "discount_percent must be > 0"}
                ),
                400,
            )

        try:
            max_uses = int(data.get("max_uses", 100))
        except (TypeError, ValueError):
            max_uses = 100
        if max_uses < 1:
            return (
                jsonify({"success": False, "error": "max_uses must be >= 1"}),
                400,
            )

        existing = fetch_promocode_row(code)
        upsert_promocode(
            code,
            discount_percent,
            max_uses=max_uses,
            status=str(data.get("status") or "active"),
        )
        action = "updated" if existing else "created"
        print(
            f"add_promocode: {action} {code!r} ({discount_percent}%, max={max_uses}) "
            f"by admin {uid!r}"
        )
        return jsonify({"success": True, "updated": existing is not None})

    @app.post("/api/admin/delete_promocode")
    @limiter.limit("10 per minute")
    def api_admin_delete_promocode():
        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        code = normalize_promo_code(data.get("code") or "")
        if not code:
            return jsonify({"success": False, "error": "Missing code"}), 400

        if not delete_promocode_from_db(code):
            return jsonify({"success": False, "error": "Promocode not found"}), 404

        print(f"delete_promocode: {code!r} by admin {uid!r}")
        return jsonify({"success": True})

    @app.post("/api/check_admin")
    def api_check_admin():
        data = request.get_json(silent=True) or {}
        user_id = str(data.get("user_id") or "").strip()
        admin_id = str(os.getenv("ADMIN_ID") or "").strip()
        if admin_id and user_id == admin_id:
            return jsonify({"is_admin": True})
        return jsonify({"is_admin": False})

    def _validate_promocode_response(code: str):
        ok, percent, error = validate_promocode_for_use(code)
        normalized = normalize_promo_code(code)
        if not ok:
            return jsonify(
                {
                    "ok": False,
                    "success": False,
                    "error": error,
                }
            ), 200
        return jsonify(
            {
                "ok": True,
                "success": True,
                "discount_percent": percent,
                "code": normalized,
            }
        ), 200

    @app.post("/api/validate_promocode")
    def api_validate_promocode():
        data = request.get_json(silent=True) or {}
        code = str(data.get("code") or "").strip()
        return _validate_promocode_response(code)

    @app.post("/api/validate_promo")
    def api_validate_promo():
        data = request.get_json(silent=True) or {}
        code = str(data.get("code") or data.get("promocode") or "").strip()
        return _validate_promocode_response(code)

    @app.post("/api/admin/broadcast")
    @limiter.limit("10 per minute")
    def api_admin_broadcast():
        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403
        text = data.get("text", "").strip()
        if not text:
            return jsonify({"success": False, "error": "Empty text"}), 400

        bot = _get_telegram_bot(app)
        if bot is None:
            return jsonify(
                {
                    "success": False,
                    "error": "Бот не инициализирован и BOT_TOKEN не задан",
                }
            ), 503

        orders = load_all_orders()

        user_ids = list(
            {int(o["client_id"]) for o in orders if o.get("client_id")}
        )

        success_count = 0
        for user_id in user_ids:
            try:
                bot.send_message(user_id, text)
                success_count += 1
                time.sleep(0.05)
            except Exception:
                pass

        print(f"broadcast: sent to {success_count} users by admin {uid!r}")
        return jsonify({"success": True, "sent_to": success_count})

    @app.post("/api/order/confirm_payment")
    @limiter.limit("10 per minute")
    def api_order_confirm_payment():
        data = request.get_json(silent=True) or {}
        order_id = str(data.get("order_id") or "").strip()
        user_id = str(data.get("user_id") or data.get("chat_id") or "").strip()

        if not order_id:
            return jsonify({"ok": False, "error": "Missing order_id"}), 400
        if not user_id:
            return jsonify({"ok": False, "error": "Missing user_id"}), 400

        order = get_order_from_db(order_id)
        if not order:
            return jsonify({"ok": False, "error": "Order not found"}), 404

        if str(order.get("user_id") or "") != user_id:
            return jsonify({"ok": False, "error": "Forbidden"}), 403

        current_status = str(order.get("status") or "")
        if current_status != "awaiting_payment":
            return jsonify(
                {
                    "ok": False,
                    "error": (
                        f"Заказ не ожидает оплаты (статус: {current_status})"
                    ),
                }
            ), 400

        if not update_order_status_only(order_id, "paid"):
            return jsonify(
                {"ok": False, "error": "Не удалось обновить статус заказа"}
            ), 500

        bot = _get_telegram_bot(app)
        items_blob = _read_order_items_blob(order_id)
        order_text = str(items_blob.get("order_text_snapshot") or "")
        try:
            notify_couriers_about_delivery_order(
                bot,
                order_id,
                order_text=order_text,
                client_chat_id=user_id,
            )
        except Exception as notify_err:
            print(
                f"confirm_payment: уведомление курьеров по {order_id!r}: {notify_err}",
                file=sys.stderr,
            )

        print(f"confirm_payment: order {order_id!r} -> paid by user {user_id!r}")
        return jsonify(
            {
                "ok": True,
                "success": True,
                "order_id": order_id,
                "status": "paid",
                "total_price": float(order.get("total_price") or 0),
                "is_paid": True,
            }
        ), 200

    def _build_order_status_payload(order_id: str, *, courier_view: bool) -> tuple[dict, int]:
        order_id = str(order_id).strip()
        courier_id, order_status = get_order_assignment(order_id)
        route_info = order_status_route_payload(order_id)
        courier_route_mode = bool(
            courier_view and order_allows_courier_route_view(order_id)
        )

        if order_status is None:
            payload = {
                "ok": True,
                "order_id": order_id,
                "status": "unknown",
                "courier_id": None,
                "has_location": False,
                "courier_route_mode": courier_route_mode,
                "can_track_courier": courier_route_mode,
                **route_info,
            }
            return payload, 200

        order_record = get_order_from_db(order_id)
        items_blob = _read_order_items_blob(order_id)

        courier_lat = order_record.get("courier_lat") if order_record else None
        courier_lon = order_record.get("courier_lon") if order_record else None
        try:
            if courier_lat is not None and courier_lon is not None:
                courier_lat = float(courier_lat)
                courier_lon = float(courier_lon)
        except (TypeError, ValueError):
            courier_lat, courier_lon = None, None

        if courier_lat is None or courier_lon is None:
            courier_lat, courier_lon = resolve_order_courier_coordinates(
                order_id, courier_id
            )

        has_location = courier_lat is not None and courier_lon is not None
        status_lower = str(order_status or "").lower()
        can_track = status_lower in COURIER_IN_TRANSIT_STATUSES or courier_route_mode
        payload = {
            "ok": True,
            "order_id": order_id,
            "status": order_status,
            "courier_id": courier_id,
            "has_location": has_location,
            "lat": courier_lat,
            "lon": courier_lon,
            "courier_lat": courier_lat,
            "courier_lon": courier_lon,
            "has_weight_items": bool(items_blob.get("has_weight_items")),
            "total_price": float(order_record.get("total_price") or 0)
            if order_record
            else 0,
            "awaiting_payment": order_status == "awaiting_payment",
            "is_paid": order_status
            not in ("pending_weight_verification", "awaiting_payment", "unknown"),
            "can_track_courier": can_track,
            "courier_route_mode": courier_route_mode,
            **route_info,
        }
        if order_record and isinstance(order_record.get("cart"), list):
            payload["cart"] = order_record["cart"]
        media_info = resolve_tracking_media_info(uploads_dir, order_status)
        media_url = media_info.get("media_url") or ""
        if media_url:
            payload["media_url"] = media_url
            payload["media_type"] = media_info.get("media_type") or ""
            payload["media_filename"] = media_info.get("media_filename") or ""
            payload["media"] = media_url
            payload["banner"] = media_url
        return payload, 200

    @app.get("/api/order/check_cancelled")
    def api_order_check_cancelled():
        """Проверяет, не был ли заказ отменён администратором."""
        order_id = str(request.args.get("order_id", "")).strip()
        user_id = str(request.args.get("user_id", "")).strip()

        if not order_id or not user_id:
            return jsonify({"cancelled": False, "error": "Missing parameters"}), 400

        order = get_order_from_db(order_id)
        if not order:
            return jsonify({"cancelled": True, "order_not_found": True}), 200

        if str(order.get("user_id") or "") != user_id:
            return jsonify({"cancelled": False, "unauthorized": True}), 403

        status = str(order.get("status") or "").lower()
        is_cancelled = (
            status in CANCELLED_ORDER_STATUSES
            or status == "cancelled"
            or status == "deleted"
        )

        return jsonify(
            {
                "cancelled": is_cancelled,
                "order_id": order_id,
                "status": status,
            }
        ), 200

    @app.get("/api/order_status")
    @app.get("/api/orders/status")
    def api_order_status():
        order_id = str(request.args.get("order_id", "")).strip()
        if not order_id:
            return jsonify({"ok": False, "error": "Missing order_id"}), 400

        courier_view = str(request.args.get("courier_view", "")).lower() in (
            "1",
            "true",
            "yes",
        )
        payload, status_code = _build_order_status_payload(
            order_id, courier_view=courier_view
        )
        return jsonify(payload), status_code

    @app.route("/api/get_deliveryman_location", methods=["GET"])
    def get_deliveryman_location():
        order_id = str(request.args.get("order_id", "")).strip()
        if not order_id:
            return jsonify(
                {"lat": None, "lon": None, "error": "Missing order_id"}
            ), 400

        route_info = order_status_route_payload(order_id)
        courier_id, order_status = get_order_assignment(order_id)
        if not courier_id:
            return jsonify(
                {
                    "lat": None,
                    "lon": None,
                    "status": "pending",
                    **route_info,
                }
            ), 200
        if order_status == "completed":
            return jsonify(
                {
                    "lat": None,
                    "lon": None,
                    "status": "completed",
                    **route_info,
                }
            ), 200

        clat, clon = get_courier_position_for_order(courier_id, order_id)
        return jsonify(
            {
                "lat": clat,
                "lon": clon,
                "courier_lat": clat,
                "courier_lon": clon,
                "status": order_status or "in_progress",
                **route_info,
            }
        ), 200

    @app.get("/api/courier/orders")
    def api_courier_orders():
        """
        Список заказов, готовых к принятию курьером (оплачены, без курьера).
        Query: courier_id или user_id — Telegram ID курьера.
        """
        courier_id = str(
            request.args.get("courier_id") or request.args.get("user_id") or ""
        ).strip()
        if not courier_id:
            return jsonify({"success": False, "error": "Missing courier_id"}), 400

        try:
            if not is_courier_user(int(courier_id)):
                return jsonify({"success": False, "error": "Forbidden"}), 403
        except (TypeError, ValueError):
            return jsonify({"success": False, "error": "Invalid courier_id"}), 400

        orders = load_courier_pool_orders()
        return jsonify(
            {
                "success": True,
                "orders": orders,
                "count": len(orders),
            }
        ), 200

    def _courier_go_http_response(
        oid: str,
        *,
        courier_lat: float | None = None,
        courier_lon: float | None = None,
        as_json: bool = False,
        force_geo_page: bool = False,
    ):
        """Старт «Поехали»: JSON/редирект с GPS или HTML авто-трекинга (по умолчанию)."""
        order = get_order_from_db(oid)
        if not order:
            if as_json:
                return jsonify({"status": "error", "message": "Order not found"}), 404
            abort(404)

        if str(order.get("status") or "").lower() == "completed":
            if as_json:
                return jsonify({"status": "error", "message": "Order completed"}), 410
            abort(410)

        has_coords = courier_lat is not None and courier_lon is not None
        if force_geo_page or (not as_json and not has_coords):
            return Response(
                render_courier_go_geolocation_html(oid),
                mimetype="text/html; charset=utf-8",
                headers={"Cache-Control": "no-store, no-cache"},
            )

        public_url = resolve_public_base_url()
        bot = _get_telegram_bot(app)
        try:
            _order, maps_url, _coords_saved = courier_go_start_delivery(
                oid,
                courier_lat=courier_lat,
                courier_lon=courier_lon,
                bot=bot,
                public_url=public_url,
            )
        except ValueError:
            if as_json:
                return jsonify({"status": "error", "message": "Order not found"}), 404
            abort(404)

        if as_json:
            return jsonify({"status": "success", "redirect": maps_url}), 200

        return redirect(maps_url, code=302)

    @app.get("/go/<order_id>")
    @limiter.limit("60 per minute")
    def courier_go_short_redirect(order_id: str):
        """«Поехали»: авто-GPS + маршрут в Google Maps (без витрины магазина)."""
        return _courier_go_http_response(str(order_id).strip(), force_geo_page=True)

    @app.route("/api/courier/go/<order_id>", methods=["GET", "POST"])
    @limiter.limit("60 per minute")
    def api_courier_go_redirect(order_id: str):
        """
        «Поехали»: delivering + GPS клиенту + Google Maps.
        GET — HTML авто-GPS; POST — JSON; ?lat&lon — прямой редирект в Maps.
        """
        oid = str(order_id).strip()

        if request.method == "POST":
            data = request.get_json(silent=True) or {}
            courier_lat = courier_lon = None
            lat_raw = data.get("lat")
            lon_raw = data.get("lon")
            if lat_raw is not None and lon_raw is not None:
                try:
                    courier_lat = float(lat_raw)
                    courier_lon = float(lon_raw)
                except (TypeError, ValueError):
                    return (
                        jsonify({"status": "error", "message": "Invalid coordinates"}),
                        400,
                    )
            return _courier_go_http_response(
                oid,
                courier_lat=courier_lat,
                courier_lon=courier_lon,
                as_json=True,
            )

        lat_q = request.args.get("lat")
        lon_q = request.args.get("lon")
        if lat_q is not None and lon_q is not None:
            try:
                courier_lat = float(lat_q)
                courier_lon = float(lon_q)
            except (TypeError, ValueError):
                abort(400)
            return _courier_go_http_response(
                oid,
                courier_lat=courier_lat,
                courier_lon=courier_lon,
            )

        return _courier_go_http_response(oid, force_geo_page=True)

    @app.post("/api/courier/start_delivery")
    @limiter.limit("30 per minute")
    def api_courier_start_delivery():
        """
        WebApp / API: старт доставки курьером («Поехали»).
        Статус в БД обновляется всегда; ошибки Telegram не ломают ответ.
        """
        data = request.json or {}
        courier_id = str(
            data.get("courier_id") or data.get("user_id") or ""
        ).strip()
        order_id = str(data.get("order_id") or "").strip() or None

        navigation_url = None
        tracking_url = None
        resolved_order_id = order_id
        public_url = resolve_public_base_url()

        try:
            courier_uid = int(courier_id) if courier_id else None
        except (TypeError, ValueError):
            courier_uid = None

        try:
            if courier_uid is not None and is_courier_user(courier_uid):
                bot = _get_telegram_bot(app)

                lat_raw = data.get("lat") if data.get("lat") is not None else data.get("courier_lat")
                lon_raw = data.get("lon") if data.get("lon") is not None else data.get("courier_lon")
                courier_lat = courier_lon = None
                try:
                    if lat_raw is not None and lon_raw is not None:
                        courier_lat = float(lat_raw)
                        courier_lon = float(lon_raw)
                except (TypeError, ValueError):
                    courier_lat = courier_lon = None

                payload = courier_start_delivery_core(
                    bot,
                    courier_id,
                    public_url,
                    order_id=order_id,
                    courier_lat=courier_lat,
                    courier_lon=courier_lon,
                )
                navigation_url = payload.get("navigation_url")
                tracking_url = payload.get("tracking_url")
                resolved_order_id = payload.get("order_id") or order_id
        except Exception as api_err:
            print(
                f"api_courier_start_delivery: {api_err}",
                file=sys.stderr,
            )

        if resolved_order_id and public_url and not tracking_url:
            tracking_url = build_courier_tracking_map_url(
                public_url, str(resolved_order_id)
            )

        return jsonify(
            {
                "status": "success",
                "navigation_url": navigation_url,
                "tracking_url": tracking_url,
                "order_id": resolved_order_id,
            }
        ), 200

    @app.post("/api/courier/update_location_and_status")
    @limiter.limit("60 per minute")
    def api_courier_update_location_and_status():
        """
        Быстрый старт курьера: статус delivering + courier_lat/lon в заказе (commit в БД).
        """
        data = request.json or {}
        order_id = str(data.get("order_id", "")).strip()
        lat = data.get("lat")
        lon = data.get("lon")

        if not order_id:
            return jsonify({"status": "error", "message": "Missing order_id"}), 400

        order = get_order_from_db(order_id)
        if not order:
            return jsonify({"status": "error", "message": "Order not found"}), 404

        courier_id = str(
            data.get("courier_id")
            or data.get("user_id")
            or order.get("courier_id")
            or ""
        ).strip()
        if courier_id:
            assign_courier_to_order(order_id, courier_id, status="delivering")
        else:
            update_order_status_only(order_id, "delivering")

        if lat is not None and lon is not None:
            try:
                lat_f = float(lat)
                lon_f = float(lon)
            except (TypeError, ValueError):
                return jsonify({"status": "error", "message": "Invalid coordinates"}), 400

            coords_saved = save_order_courier_coordinates(order_id, lat_f, lon_f)
            if not coords_saved:
                print(
                    f"api_courier_update_location_and_status: не удалось сохранить GPS "
                    f"для заказа {order_id} после {COURIER_COORDS_DB_MAX_RETRIES} попыток",
                    file=sys.stderr,
                )
                return (
                    jsonify(
                        {
                            "status": "error",
                            "message": "Не удалось сохранить геопозицию курьера",
                        }
                    ),
                    500,
                )

            print(
                f"🚀 Заказ {order_id} в пути! Первые координаты курьера получены: "
                f"{lat_f}, {lon_f}"
            )
        else:
            print(f"🚀 Заказ {order_id} в пути! (координаты не переданы)")

        return jsonify({"status": "success", "order_id": order_id}), 200

    @app.post("/api/courier/update_location")
    @limiter.limit("120 per minute")
    def api_courier_update_location():
        """Фоновое GPS курьера: courier_lat/lon в БД + статус delivering."""
        data = request.json or {}
        order_id = str(data.get("order_id", "")).strip()
        lat = data.get("lat")
        lon = data.get("lon")

        if not order_id or lat is None or lon is None:
            return jsonify({"status": "error", "message": "Missing fields"}), 400

        order = get_order_from_db(order_id)
        if not order:
            return jsonify({"status": "error", "message": "Заказ не найден"}), 404

        try:
            lat_f = float(lat)
            lon_f = float(lon)

            if str(order.get("status") or "").lower() != "delivering":
                courier_id = str(
                    data.get("courier_id")
                    or data.get("user_id")
                    or order.get("courier_id")
                    or ""
                ).strip()
                if courier_id:
                    assign_courier_to_order(
                        order_id, courier_id, status="delivering"
                    )
                else:
                    update_order_status_only(order_id, "delivering")

            if not save_order_courier_coordinates(order_id, lat_f, lon_f):
                return jsonify({"status": "error"}), 500

            return jsonify({"status": "success"}), 200
        except Exception as e:
            print(f"Ошибка сохранения GPS: {e}", file=sys.stderr)
            return jsonify({"status": "error"}), 500

    @app.get("/api/admin/orders")
    def api_admin_orders():
        if not _admin_query_allowed():
            return jsonify({"success": False, "error": "Forbidden"}), 403
        view = str(request.args.get("view") or "active").strip().lower()
        orders = load_orders_for_admin_panel(view)
        return jsonify(
            {
                "success": True,
                "orders": orders,
                "view": view if view in ("archive", "cancelled", "history") else "active",
                "count": len(orders),
            }
        )

    @app.post("/api/admin/orders/<order_id>/update_weights")
    @limiter.limit("20 per minute")
    def api_admin_orders_update_weights(order_id: str):
        """
        Принимает фактические веса от админа, пересчитывает чек и переводит заказ
        в статус awaiting_payment.
        Тело запроса: { "user_id": "...", "items": [{ "item_id"|"id", "quantity"|"actual_quantity" }, ...] }
        """
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403

        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        order_id = str(order_id or "").strip()
        if not order_id:
            return jsonify({"success": False, "error": "Missing order_id"}), 400

        adjustments = data.get("items") or data.get("weights") or []

        try:
            result = admin_update_order_weights(order_id, adjustments)
        except LookupError:
            return jsonify({"success": False, "error": "Order not found"}), 404
        except ValueError as exc:
            return jsonify({"success": False, "error": str(exc)}), 400

        final_total = float(result["new_total_price"])
        bot = _get_telegram_bot(app)
        if bot is not None and admin_normalized:
            try:
                admin_id = int(str(admin_normalized).strip())
                bot.send_message(
                    admin_id,
                    f"⚖️ Веса подтверждены для заказа №{order_id}.\n"
                    f"Новая сумма: {format_uah(final_total)} грн\n"
                    f"Статус: awaiting_payment",
                )
            except Exception:
                pass

        print(
            f"update_weights: order {order_id!r} -> {format_uah(final_total)} грн "
            f"by admin {uid!r}"
        )
        return jsonify(
            {
                "success": True,
                "new_total_price": final_total,
                "order_id": order_id,
                "status": result["status"],
                "total_price": final_total,
            }
        )

    @app.post("/api/admin/receipts")
    @limiter.limit("20 per minute")
    def api_admin_receipts():
        data = request.json or {}
        if not _receipts_password_valid(data.get("password")):
            return jsonify(
                {"status": "error", "message": "Неверный пароль"}
            ), 403

        view = str(data.get("view") or "active").strip().lower()
        orders = load_orders_for_admin_panel(view)
        receipts = [order_as_receipt(o) for o in orders]
        return jsonify(
            {
                "status": "success",
                "receipts": receipts,
                "view": view if view in ("archive", "cancelled", "history") else "active",
                "count": len(receipts),
            }
        )

    @app.post("/api/admin/delete_receipt")
    @limiter.limit("20 per minute")
    def api_admin_delete_receipt():
        data = request.json or {}
        if not _receipts_password_valid(data.get("password")):
            return jsonify({"status": "error", "message": "Неверный пароль"}), 403

        receipt_id = str(
            data.get("id") or data.get("order_id") or data.get("receipt_id") or ""
        ).strip()
        if not receipt_id:
            return jsonify({"status": "error", "message": "Missing receipt id"}), 400

        if not cancel_order_in_db(receipt_id, status="cancelled"):
            return jsonify({"status": "error", "message": "Чек не найден"}), 404

        bot = _get_telegram_bot(app)
        if bot is not None:
            try:
                order = get_order_from_db(receipt_id)
                if order:
                    client_chat_id = order.get("user_id")
                    if client_chat_id:
                        cancel_message = (
                            f"❌ Ваш заказ №{receipt_id} был ОТМЕНЁН администратором.\n\n"
                            "Причина: заказ отменён магазином.\n\n"
                            "Вы можете сделать новый заказ, нажав на кнопку «Магазин»."
                        )
                        bot.send_message(int(client_chat_id), cancel_message)
                        print(
                            f"📧 Уведомление об отмене отправлено клиенту {client_chat_id}"
                        )
            except Exception as notify_err:
                print(
                    f"Не удалось уведомить клиента об отмене: {notify_err}",
                    file=sys.stderr,
                )

            try:
                delete_courier_pool_telegram_messages(bot, receipt_id)
            except Exception as purge_err:
                print(
                    f"delete_receipt: очистка чата курьеров: {purge_err}",
                    file=sys.stderr,
                )

        print(f"delete_receipt: order {receipt_id!r} -> cancelled")
        return jsonify(
            {"status": "success", "order_id": receipt_id, "new_status": "cancelled"}
        )

    @app.post("/api/admin/orders/<order_id>/delete")
    @limiter.limit("20 per minute")
    def api_admin_orders_delete(order_id: str):
        """Мягкое удаление заказа админом + очистка сообщений у курьеров."""
        if not admin_normalized:
            return jsonify(
                {"success": False, "error": "ADMIN_ID is not configured"}
            ), 403
        data, uid = _admin_request_allowed()
        if data is None:
            return jsonify({"success": False, "error": "Forbidden"}), 403

        oid = str(order_id or "").strip()
        if not oid:
            return jsonify({"success": False, "error": "Missing order_id"}), 400

        if not cancel_order_in_db(oid, status="cancelled"):
            return jsonify({"success": False, "error": "Order not found"}), 404

        bot = _get_telegram_bot(app)
        try:
            delete_courier_pool_telegram_messages(bot, oid)
        except Exception as purge_err:
            print(
                f"admin delete order: не удалось очистить чат курьеров: {purge_err}",
                file=sys.stderr,
            )

        print(f"admin delete order: {oid!r} by admin {uid!r}")
        return jsonify(
            {"success": True, "order_id": oid, "new_status": "cancelled"}
        )

    @app.get("/api/user/orders")
    def api_user_orders():
        user_id = str(request.args.get("user_id", "")).strip()
        if not user_id:
            return jsonify({"success": False, "error": "Missing user_id"}), 400
        return jsonify(
            {"success": True, "orders": load_orders_for_user(user_id)}
        )

    @app.get("/api/orders/active")
    def api_orders_active():
        """
        Проверка незавершённого заказа клиента.
        Query: user_id — Telegram ID.
        """
        user_id = str(request.args.get("user_id", "")).strip()
        if not user_id:
            return jsonify({"error": "Missing user_id"}), 400

        latest_order = get_latest_order_for_user(user_id)
        if latest_order:
            latest_status = str(latest_order.get("status") or "").lower()
            if latest_status in CANCELLED_ORDER_STATUSES:
                order_id = str(latest_order["order_id"])
                if consume_cancel_notify_pending(order_id):
                    return jsonify(
                        {
                            "has_active": False,
                            "was_cancelled": True,
                            "order_id": order_id,
                        }
                    ), 200

        active_order = find_latest_unfinished_order_for_user(user_id)
        if not active_order:
            return jsonify({"has_active": False}), 200

        return jsonify(
            {
                "has_active": True,
                "order_id": active_order["order_id"],
                "status": active_order["status"],
            }
        ), 200

    @app.route("/api/submit_order", methods=["POST"])
    @limiter.limit("5 per minute")
    def submit_order():
        try:
            # Пытаемся получить бота из конфига
            bot = app.config.get("TELEGRAM_BOT")

            # Если бота нет, создаем временного для отправки уведомлений
            if bot is None and config.BOT_TOKEN:
                import telebot
                bot = telebot.TeleBot(config.BOT_TOKEN)
                print("📱 Временный бот создан для отправки уведомления о заказе")
            elif bot is None:
                return jsonify(
                    {
                        "success": False,
                        "error": "Бот не инициализирован и BOT_TOKEN не задан",
                    }
                ), 503

            ADMIN_ID = app.config.get("ADMIN_ID", admin_normalized)

            data = request.json or {}
            order_text = str(data.get("order_text") or "")
            user_chat_id = data.get("chat_id")
            delivery_method = str(data.get("delivery_method") or "").strip()
            delivery_address = extract_delivery_address(data, order_text)
            promocode_raw = str(data.get("promocode") or "").strip()

            cart_raw = data.get("cart")
            if cart_raw is None:
                cart_raw = data.get("items")
            cart = cart_raw if isinstance(cart_raw, list) else []

            store_doc = load_products_document()
            products_by_id = {
                str(p.get("id")): p
                for p in store_doc.get("products", [])
                if isinstance(p, dict) and p.get("id") is not None
            }

            if not cart:
                return (
                    jsonify({"success": False, "error": "Корзина пуста"}),
                    400,
                )

            try:
                calculated_total_price, validated_items, items_lines = (
                    validate_and_reprice_cart(cart, products_by_id)
                )
            except ValueError as pricing_err:
                return (
                    jsonify({"success": False, "error": str(pricing_err)}),
                    400,
                )

            stock_err = validate_piece_items_stock(validated_items, products_by_id)
            if stock_err:
                return jsonify({"success": False, "error": stock_err}), 400

            cart = validated_items
            goods_subtotal = calculated_total_price
            has_weight_items = validated_cart_has_weight_items(
                validated_items, products_by_id
            )
            initial_status = (
                "pending_weight_verification"
                if has_weight_items
                else "awaiting_payment"
            )

            promo_code_used: str | None = None
            promo_percent_used = 0
            if promocode_raw:
                promo_ok, promo_percent_used, promo_err = validate_promocode_for_use(
                    promocode_raw
                )
                if not promo_ok:
                    return (
                        jsonify({"success": False, "error": promo_err}),
                        200,
                    )
                goods_subtotal, promo_code_used, promo_percent_used = (
                    apply_promocode_to_subtotal(goods_subtotal, promocode_raw)
                )
                if not promo_code_used:
                    return (
                        jsonify(
                            {
                                "success": False,
                                "error": "Промокод не существует",
                            }
                        ),
                        200,
                    )

            order_text = update_order_text_goods_and_total(
                order_text,
                items_lines,
                goods_subtotal,
                promocode=promo_code_used,
                promocode_percent=promo_percent_used,
            )

            data["order_total"] = goods_subtotal
            data["cart"] = validated_items
            if promo_code_used:
                data["promocode"] = promo_code_used
                data["promocode_discount_percent"] = promo_percent_used

            print("=== ПОЛУЧЕН ЗАКАЗ ЧЕРЕЗ API ===")
            print(f"User Chat ID: {user_chat_id}")

            order_id = str(int(time.time()))

            if user_chat_id is not None and str(user_chat_id).strip():
                try:
                    ORDERS_CLIENTS[order_id] = int(user_chat_id)
                except (TypeError, ValueError):
                    pass

            user_delivery_note = None
            client_lat: float | None = None
            client_lon: float | None = None
            is_delivery = delivery_method in ("delivery", "courier") or is_courier_delivery(
                delivery_method, order_text
            )
            if is_delivery and delivery_address:
                total_products_price = float(goods_subtotal)

                lat = data.get("client_lat")
                lon = data.get("client_lon")
                preset_lat, preset_lon = None, None
                if lat is not None and lon is not None:
                    try:
                        preset_lat = float(lat)
                        preset_lon = float(lon)
                    except (TypeError, ValueError):
                        preset_lat, preset_lon = None, None

                (
                    order_text,
                    user_delivery_note,
                    delivery_err,
                    client_lat,
                    client_lon,
                ) = apply_dnipro_delivery_to_order(
                    order_text,
                    delivery_address,
                    total_products_price,
                    client_lat=preset_lat,
                    client_lon=preset_lon,
                )
                if delivery_err:
                    return jsonify({"success": False, "error": delivery_err}), 200

            username = str(data.get("username") or "").strip()
            if not username:
                try:
                    chat = bot.get_chat(int(user_chat_id)) if user_chat_id else None
                    if chat and getattr(chat, "username", None):
                        username = str(chat.username)
                except Exception:
                    username = ""

            created_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            date_short = datetime.datetime.now().strftime("%Y-%m-%d")
            items_payload = {
                "cart": validated_items,
                "address": extract_delivery_address(data, order_text),
                "courier_id": None,
                "promocode": data.get("promocode"),
                "promocode_discount_percent": data.get(
                    "promocode_discount_percent"
                ),
                "date_short": date_short,
                "shop_latitude": SHOP_LATITUDE,
                "shop_longitude": SHOP_LONGITUDE,
                "has_weight_items": has_weight_items,
                "order_text_snapshot": order_text,
            }
            if client_lat is not None and client_lon is not None:
                items_payload["client_lat"] = client_lat
                items_payload["client_lon"] = client_lon
            total_price = float(goods_subtotal)

            conn = sqlite3.connect(db_path)
            try:
                with conn:
                    if promo_code_used:
                        promo_row = fetch_promocode_row(promo_code_used, conn=conn)
                        if not promo_row or not promocode_is_usable(promo_row):
                            return (
                                jsonify(
                                    {
                                        "success": False,
                                        "error": "Срок действия этого промокода истёк или лимит использований исчерпан",
                                    }
                                ),
                                200,
                            )
                        if not increment_promocode_used_count(conn, promo_code_used):
                            return (
                                jsonify(
                                    {
                                        "success": False,
                                        "error": "Срок действия этого промокода истёк или лимит использований исчерпан",
                                    }
                                ),
                                200,
                            )

                    conn.execute(
                        """
                        INSERT INTO orders (
                            id, user_id, username, items, total_price, status, created_at, courier_id
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            str(order_id),
                            str(user_chat_id) if user_chat_id is not None else "",
                            username,
                            json.dumps(items_payload, ensure_ascii=False),
                            total_price,
                            initial_status,
                            created_at,
                            None,
                        ),
                    )
            finally:
                conn.close()

            stock_deducted = False
            try:
                stock_deducted = apply_piece_stock_deduction_for_order(validated_items)
                if stock_deducted:
                    items_payload["stock_deducted"] = True
                    persist_order_cart_and_total(
                        order_id,
                        validated_items,
                        total_price,
                        extra_patch={"stock_deducted": True},
                    )
            except Exception as stock_exc:
                print(
                    f"Не удалось списать остатки по заказу {order_id}: {stock_exc}",
                    file=sys.stderr,
                )

            try:
                clean_admin_id = int(
                    str(ADMIN_ID).replace('"', "").replace("'", "").strip()
                )

                admin_message = f"🔔 {order_text}"
                if has_weight_items:
                    admin_message += (
                        "\n\n⚖️ В заказе есть весовые товары — статус: "
                        "ожидает подтверждения веса (pending_weight_verification)."
                    )
                if user_chat_id:
                    admin_message += f"\n🆔 ID пользователя: {user_chat_id}"

                bot.send_message(clean_admin_id, admin_message)
                print("🔥 Заказ успешно доставлен в ЛС админу!")

                public_url = resolve_public_base_url()
                notify_client_order_submitted(
                    bot,
                    user_chat_id,
                    order_id,
                    public_url,
                    client_lat=client_lat,
                    client_lon=client_lon,
                    initial_status=initial_status,
                )

                if is_delivery and initial_status not in (
                    "pending_weight_verification",
                    "awaiting_payment",
                ):
                    notify_couriers_about_delivery_order(
                        bot,
                        order_id,
                        order_text=order_text,
                        client_chat_id=user_chat_id,
                    )
            except Exception as notify_err:
                print(
                    "Предупреждение: не удалось отправить уведомления в Telegram:",
                    notify_err,
                    file=sys.stderr,
                )

            return jsonify(
                {
                    "success": True,
                    "order_id": order_id,
                    "status": initial_status,
                    "has_weight_items": has_weight_items,
                    "total_price": total_price,
                    "awaiting_payment": initial_status == "awaiting_payment",
                    **shop_route_origin(),
                    "client_latitude": client_lat,
                    "client_longitude": client_lon,
                }
            ), 200

        except Exception as e:
            print(f"❌ ОШИБКА ПРИ ОБРАБОТКЕ ЗАКАЗА ЧЕРЕЗ API: {e}")
            return jsonify({"success": False, "error": str(e)}), 500

    @app.get("/<path:requested>")
    def serve_frontend_static(requested: str):
        if requested.startswith("api/") or requested.startswith("go/"):
            abort(404)
        target = (frontend_root / requested).resolve()
        if not _inside_frontend(target) or not target.is_file():
            abort(404)
        if target.name == "index.html":
            html = render_index_html(frontend_root, products_path)
            return Response(
                html,
                mimetype="text/html; charset=utf-8",
                headers={"Cache-Control": "no-cache"},
            )
        response = send_from_directory(target.parent, target.name)
        if target.name == "sw.js":
            response.headers["Cache-Control"] = "no-cache"
            response.mimetype = "application/javascript"
            return response
        ext = target.suffix.lower()
        if ext in (".html", ".htm"):
            response.headers["Cache-Control"] = "no-cache"
            return response
        if ext in STATIC_LONG_CACHE_EXTS:
            return apply_browser_cache_headers(response)
        return response

    return app


def _project_paths() -> tuple[Path, Path, Path, Path, Path]:
    frontend_root = get_frontend_root()
    uploads_dir = get_uploads_dir()
    products_path = get_products_path()
    sqlite_db_path = get_database_path()
    backend_dir = Path(__file__).resolve().parent
    return frontend_root, uploads_dir, products_path, sqlite_db_path, backend_dir


def create_application() -> Flask:
    """WSGI-приложение для Gunicorn / Render (backend.main:app)."""
    load_project_dotenv()
    global db_path, products_catalog_path

    frontend_root, uploads_dir, products_path, sqlite_db_path, _ = _project_paths()
    db_path = sqlite_db_path.resolve()
    products_catalog_path = products_path.resolve()

    uploads_dir.mkdir(parents=True, exist_ok=True)
    sqlite_db_path.parent.mkdir(parents=True, exist_ok=True)

    index_file = frontend_root / "index.html"
    if not index_file.is_file():
        raise RuntimeError(
            "Не найден frontend/index.html. "
            f"frontend_root={frontend_root}, project_root={PROJECT_ROOT}, "
            f"cwd={Path.cwd()}, __file__={Path(__file__).resolve()}"
        )

    application = create_app(
        frontend_root,
        uploads_dir,
        products_path,
        config.ADMIN_ID,
        sqlite_db_path,
    )
    application.config["PUBLIC_URL"] = get_app_base_url()
    init_db()
    return application


# Точка входа Gunicorn: gunicorn main:app --bind 0.0.0.0:$PORT
app = create_application()


def main() -> None:
    """Long polling Telegram-бота (отдельный worker / локальный запуск)."""
    token = config.BOT_TOKEN
    if not token:
        print(
            "Ошибка: в файле backend/.env не задан BOT_TOKEN. "
            "Вставьте токен от @BotFather и запустите снова.",
            file=sys.stderr,
        )
        sys.exit(1)

    public_url = os.getenv("PUBLIC_URL", "").strip().rstrip("/")
    if public_url:
        app.config["PUBLIC_URL"] = public_url
        print(f"\nPUBLIC_URL: {public_url}\n")
    else:
        print(
            "⚠️ PUBLIC_URL не задан — Mini App и ссылки курьера не будут работать.",
            file=sys.stderr,
        )

    bot = telebot.TeleBot(token)
    app.config["TELEGRAM_BOT"] = bot
    app.config["ADMIN_ID"] = config.ADMIN_ID

    try:
        @bot.callback_query_handler(
            func=lambda call: bool(
                call.data and str(call.data).startswith("courier_go_")
            )
        )
        def handle_courier_go(call):
            """Legacy callback «Поехали» → страница авто-GPS /go/ (не магазин)."""
            order_id = str(call.data)[len("courier_go_") :].strip()
            courier_id = str(call.from_user.id)

            if not is_courier_user(call.from_user.id):
                bot.answer_callback_query(
                    call.id, "❌ Вы не зарегистрированы как курьер.", show_alert=True
                )
                return

            order = get_order_from_db(order_id)
            if not order:
                bot.answer_callback_query(
                    call.id, "❌ Заказ не найден.", show_alert=True
                )
                return

            if str(order.get("status") or "").lower() == "completed":
                bot.answer_callback_query(
                    call.id, "❌ Заказ уже выполнен.", show_alert=True
                )
                return

            assigned = str(order.get("courier_id") or "").strip()
            if assigned and assigned != courier_id:
                bot.answer_callback_query(
                    call.id,
                    "❌ Этот заказ закреплён за другим курьером.",
                    show_alert=True,
                )
                return

            tunnel = public_url
            open_url = build_courier_go_button_url(order_id, tunnel)
            if not open_url:
                bot.answer_callback_query(
                    call.id, "❌ Не настроен PUBLIC_URL.", show_alert=True
                )
                return
            try:
                bot.answer_callback_query(call.id, url=open_url)
            except Exception as cb_err:
                print(
                    f"handle_courier_go: answer_callback_query url: {cb_err}",
                    file=sys.stderr,
                )
                try:
                    bot.answer_callback_query(
                        call.id, "🚀 Нажмите «ПОЕХАЛИ!» в сообщении выше."
                    )
                except Exception:
                    pass

        @bot.callback_query_handler(
            func=lambda call: bool(
                call.data and str(call.data).startswith("accept_order_")
            )
        )
        def handle_accept_order(call):
            order_id = str(call.data)[len("accept_order_") :]
            accepter_id = str(call.from_user.id)
            accepter_name = get_courier_name(accepter_id)

            if not is_courier_user(call.from_user.id):
                bot.answer_callback_query(
                    call.id, "❌ Вы не зарегистрированы как курьер.", show_alert=True
                )
                return

            existing_courier, order_status = get_order_assignment(order_id)
            if order_status == "completed":
                bot.answer_callback_query(
                    call.id,
                    "❌ Этот заказ уже выполнен.",
                    show_alert=True,
                )
                return
            if order_status in ("pending_weight_verification", "awaiting_payment"):
                bot.answer_callback_query(
                    call.id,
                    "❌ Заказ ещё не оплачен.",
                    show_alert=True,
                )
                return
            pool_statuses = {s.lower() for s in COURIER_POOL_ORDER_STATUSES}
            if (
                order_status
                and str(order_status).lower() not in pool_statuses
                and order_status != "active"
                and not existing_courier
            ):
                bot.answer_callback_query(
                    call.id,
                    f"❌ Заказ недоступен (статус: {order_status}).",
                    show_alert=True,
                )
                return
            if existing_courier and str(existing_courier) != accepter_id:
                bot.answer_callback_query(
                    call.id,
                    "❌ Этот заказ уже принял другой курьер!",
                    show_alert=True,
                )
                return

            assign_courier_to_order(order_id, accepter_id, status="active")
            bot.answer_callback_query(
                call.id, f"✅ Заказ №{order_id} закреплён за вами!"
            )

            order_record = get_order_from_db(order_id)
            order_text_for_addr = ""
            order_data_for_addr: dict = {}
            if order_record:
                order_data_for_addr = {"delivery_address": order_record.get("address")}
                order_text_for_addr = str(order_record.get("address") or "")
            address = extract_delivery_address(
                order_data_for_addr, order_text_for_addr
            )
            if not address and call.message and call.message.text:
                address = extract_delivery_address({}, call.message.text)

            try:
                tunnel = public_url
                reply_markup = build_courier_go_inline_keyboard(
                    order_id, tunnel
                )

                courier_message = (
                    f"✅ Заказ №{order_id} ваш!\n\n"
                    f"📍 Адрес клиента: {address if address else '—'}\n\n"
                    "🚀 Нажмите «ПОЕХАЛИ!» — разрешите GPS: координаты сразу "
                    "уйдут клиенту и откроется Google Maps с маршрутом до адреса."
                )
                if not resolve_courier_navigator_url_for_order(order_id):
                    courier_message += (
                        "\n\n⚠️ Координаты клиента не найдены — "
                        "уточните адрес у администратора."
                    )

                bot.send_message(
                    call.message.chat.id,
                    courier_message,
                    reply_markup=reply_markup,
                    disable_web_page_preview=True,
                )
            except Exception as send_err:
                print(f"Не удалось отправить курьеру: {send_err}", file=sys.stderr)

            taken_text = f"Заказ №{order_id} взят курьером {accepter_name}"
            messages_map = ORDER_COURIER_MESSAGES.get(order_id, {})

            for courier_id, msg_id in messages_map.items():
                chat_id = int(courier_id)
                try:
                    if courier_id == accepter_id:
                        bot.edit_message_text(
                            f"✅ {taken_text}\n\nВы везёте этот заказ.",
                            chat_id,
                            msg_id,
                            reply_markup=None,
                        )
                    else:
                        bot.edit_message_text(taken_text, chat_id, msg_id, reply_markup=None)
                except Exception as edit_err:
                    print(
                        f"Не удалось обновить сообщение курьеру {courier_id}: {edit_err}",
                        file=sys.stderr,
                    )

        @bot.callback_query_handler(
            func=lambda call: bool(
                call.data and str(call.data).startswith("complete_order_")
            )
        )
        def handle_complete_order(call):
            order_id = str(call.data).replace("complete_order_", "", 1)
            courier_id = str(call.from_user.id)

            assigned_courier, order_status = get_order_assignment(order_id)
            if not assigned_courier or order_status == "completed":
                bot.answer_callback_query(
                    call.id,
                    "❌ Заказ не найден или уже завершён.",
                    show_alert=True,
                )
                return

            if str(assigned_courier) != courier_id:
                bot.answer_callback_query(
                    call.id,
                    "❌ Вы не можете завершить этот заказ",
                    show_alert=True,
                )
                return

            update_order_in_db(order_id, status="completed")
            bot.answer_callback_query(call.id, "✅ Заказ отмечен как выполнен!")

            try:
                delete_courier_pool_telegram_messages(
                    bot, order_id, chat_id=call.message.chat.id
                )
            except Exception as purge_err:
                print(
                    f"complete_order: очистка чата курьеров: {purge_err}",
                    file=sys.stderr,
                )

            try:
                base_text = call.message.text or f"Заказ №{order_id}"
                bot.edit_message_text(
                    f"{base_text}\n\n🏁 СТАТУС: Выполнен",
                    call.message.chat.id,
                    call.message.message_id,
                    reply_markup=None,
                )
            except Exception as edit_err:
                print(
                    f"Не удалось обновить сообщение о завершении: {edit_err}",
                    file=sys.stderr,
                )

            try:
                bot.delete_message(call.message.chat.id, call.message.message_id)
            except Exception:
                pass

        @bot.edited_message_handler(content_types=["location"])
        def handle_live_location_update(message):
            """Telegram Live Location — обновление courier_lat/lon в активном заказе."""
            try:
                if not message.location:
                    return
                if not message.from_user or not is_courier_user(
                    message.from_user.id
                ):
                    return

                courier_id = str(message.from_user.id)
                lat = float(message.location.latitude)
                lon = float(message.location.longitude)

                order = get_active_delivering_order_by_courier(courier_id)
                if order:
                    order_id = str(
                        order.get("id") or order.get("order_id") or ""
                    ).strip()
                    if order_id and save_order_courier_coordinates(
                        order_id, lat, lon
                    ):
                        print(
                            f"📍 Live GPS курьера {courier_id}, заказ {order_id}: "
                            f"{lat}, {lon}"
                        )
                    return

                order_id = persist_courier_live_location_to_db(
                    courier_id, lat, lon
                )
                if order_id:
                    print(
                        f"📍 Координаты курьера {courier_id} обновлены "
                        f"для заказа {order_id}: {lat}, {lon}"
                    )
                else:
                    print(
                        f"🛰️ Live GPS курьера {courier_id}: {lat}, {lon} "
                        "(нет заказа в статусе delivering)"
                    )
            except Exception as loc_err:
                print(
                    f"Ошибка Live Location курьера: {loc_err}",
                    file=sys.stderr,
                )

        @bot.message_handler(content_types=["location"])
        def handle_courier_location_trigger(message):
            """Геопозиция по Reply-кнопке «🚀 Поехали!» — старт доставки + навигатор."""
            try:
                if not message.location:
                    return
                if not message.from_user or not is_courier_user(
                    message.from_user.id
                ):
                    return

                courier_id = str(message.from_user.id)
                lat = float(message.location.latitude)
                lon = float(message.location.longitude)

                order_id = parse_order_id_from_poekhali_button(
                    getattr(message, "text", None)
                )
                order = (
                    get_order_from_db(order_id) if order_id else None
                ) or get_courier_poekhali_pending_order(courier_id)

                if not order:
                    return

                order_id = str(order.get("id") or order.get("order_id") or "").strip()
                if not order_id:
                    return

                assigned = str(order.get("courier_id") or "").strip()
                if assigned and assigned != courier_id:
                    bot.send_message(
                        message.chat.id,
                        "❌ Этот заказ закреплён за другим курьером.",
                    )
                    return

                assign_courier_to_order(order_id, courier_id, status="delivering")
                coords_saved = save_order_courier_coordinates(order_id, lat, lon)
                update_courier_position(int(courier_id), lat, lon)

                print(
                    f"📍 Курьер нажал 'Поехали'. Заказ {order_id} переведен в доставку. "
                    f"Старт с координат: {lat}, {lon}"
                    + ("" if coords_saved else " (БД: координаты не сохранены)")
                )

                client_address = str(order.get("address") or "").strip()
                google_maps_url = resolve_courier_navigator_url_for_order(order_id)
                if not google_maps_url and client_address:
                    google_maps_url = (
                        "https://www.google.com/maps/dir/?api=1"
                        f"&origin={lat},{lon}"
                        f"&destination={quote(client_address)}"
                        "&travelmode=driving&dir_action=navigate"
                    )

                try:
                    bot.send_message(
                        message.chat.id,
                        "⌨️",
                        reply_markup=ReplyKeyboardRemove(),
                    )
                except Exception:
                    pass

                inline_markup = types.InlineKeyboardMarkup()
                if google_maps_url:
                    inline_markup.add(
                        types.InlineKeyboardButton(
                            text="🗺️ Открыть навигатор Google Maps",
                            url=google_maps_url,
                        )
                    )
                inline_markup.add(
                    types.InlineKeyboardButton(
                        text="📦 Выполнено",
                        callback_data=f"complete_order_{order_id}",
                    )
                )

                if coords_saved:
                    nav_text = (
                        "✅ Сессия доставки запущена!\n"
                        "Клиент уже видит вас на карте.\n\n"
                        "Нажмите кнопку ниже, чтобы открыть маршрут:"
                    )
                else:
                    nav_text = (
                        "✅ Заказ в доставке.\n\n"
                        "⚠️ Не удалось сохранить геопозицию в базу. "
                        "Отправьте геопозицию ещё раз (📎 → Геопозиция) "
                        "или включите трансляцию на 1 час.\n\n"
                        "Нажмите кнопку ниже, чтобы открыть маршрут:"
                    )
                if google_maps_url:
                    nav_text += f"\n\n{google_maps_url}"

                bot.send_message(
                    message.chat.id,
                    nav_text,
                    reply_markup=inline_markup,
                    disable_web_page_preview=True,
                )

                if coords_saved:
                    bot.send_message(
                        message.chat.id,
                        "📍 Чтобы клиент видел вас на карте, пожалуйста, включите "
                        "трансляцию геопозиции в этот чат: Нажмите 📎 (скрепка) -> "
                        "Геопозиция -> Транслировать 1 час.",
                    )

                tunnel_url = public_url
                courier_start_delivery_core(
                    bot,
                    courier_id,
                    tunnel_url,
                    order_id=order_id,
                    courier_lat=lat if coords_saved else None,
                    courier_lon=lon if coords_saved else None,
                    send_courier_nav_message=False,
                )
            except Exception as loc_err:
                print(
                    f"Ошибка handle_courier_location_trigger: {loc_err}",
                    file=sys.stderr,
                )

        @bot.message_handler(content_types=["web_app_data"])
        def handle_web_app_data(message):
            try:
                order_text = message.web_app_data.data
                username = (
                    message.from_user.username if message.from_user else None
                )
                ok, err = deliver_order_notifications(
                    bot,
                    config.ADMIN_ID,
                    order_text,
                    chat_id=message.chat.id,
                    username=username,
                )
                if not ok:
                    print(
                        f"❌ КРИТИЧЕСКАЯ ОШИБКА ОТПРАВКИ АДМИНУ (web_app_data): {err}",
                        file=sys.stderr,
                    )
            except Exception as e:
                print(
                    f"❌ КРИТИЧЕСКАЯ ОШИБКА ОТПРАВКИ АДМИНУ: {e}",
                    file=sys.stderr,
                )

        if public_url:
            web_app_link = menu_web_app_url(public_url, config.ADMIN_ID)
            bot.set_chat_menu_button(
                menu_button=types.MenuButtonWebApp(
                    type="web_app",
                    text="🛍️ Магазин",
                    web_app=types.WebAppInfo(url=web_app_link),
                ),
            )
            print("Нижняя кнопка «Магазин» обновлена (PUBLIC_URL).")
        else:
            print(
                "Кнопка меню Mini App не обновлена: задайте PUBLIC_URL.",
                file=sys.stderr,
            )

        if not str(config.ADMIN_ID).strip():
            print(
                "Внимание: ADMIN_ID пустой — POST /api/save_products будет отклонён.",
                file=sys.stderr,
            )

        print("Бот Telegram (polling). Остановка: Ctrl+C.")
        bot.infinity_polling()
    except KeyboardInterrupt:
        print("\nОстановка бота.")


if __name__ == "__main__":
    run_mode = os.getenv("RUN_MODE", "bot").strip().lower()
    if run_mode == "flask":
        port = int(os.getenv("PORT", "8080"))
        host = os.getenv("HOST", "0.0.0.0")
        print(f"Flask dev-сервер: http://{host}:{port}")
        app.run(host=host, port=port, threaded=True, use_reloader=False)
    else:
        main()
