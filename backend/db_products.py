"""
Работа с товарами и категориями в SQLite
"""

import json
import sqlite3
from pathlib import Path

from .config import DATABASE_PATH
from .product_model import normalize_products_payload, sync_product_stock_fields


def get_db_connection():
    """Возвращает соединение с БД."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def load_categories_from_db():
    """Загружает категории из БД."""
    conn = get_db_connection()
    try:
        cursor = conn.execute("SELECT * FROM categories ORDER BY title")
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()


def load_products_from_db():
    """Загружает товары из БД."""
    conn = get_db_connection()
    try:
        cursor = conn.execute("SELECT * FROM products ORDER BY name")
        products = []
        for row in cursor.fetchall():
            prod = dict(row)
            prod["in_stock"] = bool(prod.get("in_stock", 1))
            prod["is_weight_item"] = bool(prod.get("is_weight_item", 0))
            products.append(prod)
        return products
    finally:
        conn.close()


def save_category_to_db(category):
    """Сохраняет категорию в БД."""
    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO categories (id, title, image)
            VALUES (?, ?, ?)
            """,
            (category["id"], category["title"], category.get("image", "")),
        )
        conn.commit()
    finally:
        conn.close()


def save_product_to_db(product):
    """Сохраняет товар в БД."""
    conn = get_db_connection()
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO products (
                id, category_id, name, price, image, in_stock,
                unit_type, price_per_unit, discount, is_weight_item, stock_quantity
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                product["id"],
                product.get("category_id", ""),
                product.get("name", ""),
                float(product.get("price", 0)),
                product.get("image", ""),
                1 if product.get("in_stock", True) else 0,
                product.get("unit_type", "pcs"),
                product.get("price_per_unit", "pcs"),
                int(product.get("discount", 0)),
                1 if product.get("is_weight_item", False) else 0,
                float(product.get("stock_quantity", 0)),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def delete_product_from_db(product_id):
    """Удаляет товар из БД."""
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def delete_category_from_db(category_id):
    """Удаляет категорию и все её товары."""
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM products WHERE category_id = ?", (category_id,))
        conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def delete_all_products_from_db() -> None:
    """Удаляет ВСЕ товары из БД (осторожно!)"""
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM products")
        conn.commit()
    finally:
        conn.close()


def delete_all_categories_from_db() -> None:
    """Удаляет ВСЕ категории из БД (осторожно!)"""
    conn = get_db_connection()
    try:
        conn.execute("DELETE FROM categories")
        conn.commit()
    finally:
        conn.close()


def sync_catalog_from_document(document: dict) -> None:
    """
    Полная синхронизация каталога из документа:
    - добавляет новые
    - обновляет существующие
    - удаляет отсутствующие
    """
    normalized = normalize_products_payload(document)

    current_cats = {c["id"]: c for c in load_categories_from_db()}
    current_prods = {p["id"]: p for p in load_products_from_db()}

    new_cats = {cat["id"]: cat for cat in normalized.get("categories", [])}
    new_prods = {prod["id"]: prod for prod in normalized.get("products", [])}

    for cat_id in set(current_cats.keys()) - set(new_cats.keys()):
        delete_category_from_db(cat_id)

    for prod_id in set(current_prods.keys()) - set(new_prods.keys()):
        delete_product_from_db(prod_id)

    for cat in new_cats.values():
        save_category_to_db(cat)

    for prod in new_prods.values():
        save_product_to_db(sync_product_stock_fields(prod))

    print(
        f"✅ Синхронизация завершена: {len(new_cats)} категорий, {len(new_prods)} товаров"
    )


def persist_products_document_to_db(document: dict) -> None:
    """Сохраняет каталог в БД с синхронизацией удалений."""
    sync_catalog_from_document(document)


def migrate_json_to_db() -> None:
    """Переносит данные из products.json в БД (только если БД пустая)."""
    conn = get_db_connection()
    try:
        count = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if count > 0:
            print(f"ℹ️ В БД уже есть {count} товаров, миграция пропущена")
            return
    finally:
        conn.close()

    backend_dir = Path(__file__).resolve().parent
    json_path = backend_dir / "products.json"

    if not json_path.exists():
        print("⚠️ products.json не найден")
        return

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    persist_products_document_to_db(data)
    print("✅ Данные перенесены из products.json в SQLite")
