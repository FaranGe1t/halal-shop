"""
Модель товара каталога (JSON / dict).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Product:
    """Товар витрины."""

    id: str = ""
    category_id: str = ""
    name: str = ""
    price: float = 0
    image: str = ""
    in_stock: bool = True
    unit_type: str = "pcs"
    price_per_unit: str = "pcs"
    discount: int = 0
    is_weight_item: bool = False
    stock_quantity: float = 0

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Product:
        if not isinstance(data, dict):
            return cls()
        return cls(
            id=str(data.get("id") or ""),
            category_id=str(data.get("category_id") or ""),
            name=str(data.get("name") or ""),
            price=float(data.get("price") or 0),
            image=str(data.get("image") or ""),
            in_stock=bool(data.get("in_stock", True)),
            unit_type=str(data.get("unit_type") or "pcs"),
            price_per_unit=str(data.get("price_per_unit") or "pcs"),
            discount=int(data.get("discount") or 0),
            is_weight_item=bool(data.get("is_weight_item", False)),
            stock_quantity=float(data.get("stock_quantity") or 0),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "category_id": self.category_id,
            "name": self.name,
            "price": self.price,
            "image": self.image,
            "in_stock": self.in_stock,
            "unit_type": self.unit_type,
            "price_per_unit": self.price_per_unit,
            "discount": self.discount,
            "is_weight_item": self.is_weight_item,
            "stock_quantity": self.stock_quantity,
        }


def product_is_weight_item(product: dict[str, Any] | Product | None) -> bool:
    if product is None:
        return False
    if isinstance(product, Product):
        return product.is_weight_item
    if "is_weight_item" in product:
        return bool(product["is_weight_item"])
    unit = str(product.get("unit_type") or "pcs").strip().lower()
    return unit == "weight"


def normalize_stock_quantity(raw, *, is_weight: bool) -> float:
    try:
        qty = float(raw if raw is not None else 0)
    except (TypeError, ValueError):
        qty = 0.0
    if qty < 0:
        qty = 0.0
    if not is_weight:
        qty = float(int(qty))
    return qty


def sync_product_stock_fields(product: dict[str, Any]) -> dict[str, Any]:
    """Синхронизирует is_weight_item, stock_quantity и in_stock."""
    out = dict(product)
    is_weight = product_is_weight_item(out)
    out["is_weight_item"] = is_weight
    qty = normalize_stock_quantity(out.get("stock_quantity", 0), is_weight=is_weight)
    out["stock_quantity"] = qty
    if is_weight:
        out["in_stock"] = bool(out.get("in_stock", True))
    else:
        out["in_stock"] = qty > 0
    return out


def product_is_in_stock(product: dict[str, Any] | Product | None) -> bool:
    if product is None:
        return False
    if isinstance(product, Product):
        data = product.to_dict()
    else:
        data = sync_product_stock_fields(dict(product))
    return bool(data.get("in_stock"))


def _line_is_piece_item(line: dict[str, Any], product: dict[str, Any] | None) -> bool:
    if line.get("is_weight_item") is True:
        return False
    if line.get("is_weight_item") is False:
        return True
    if product is not None and product_is_weight_item(product):
        return False
    unit = str(line.get("unit_type") or (product or {}).get("unit_type") or "pcs")
    return unit.strip().lower() != "weight"


def deduct_piece_stock_for_cart(
    cart_lines: list[dict],
    *,
    products: list[dict] | None = None,
) -> bool:
    """
    Списывает штучные позиции с остатка каталога.
    Возвращает True, если каталог был изменён.
    """
    if not cart_lines:
        return False

    catalog_products = products
    if catalog_products is None:
        return False

    by_id: dict[str, dict[str, Any]] = {}
    for raw in catalog_products:
        if isinstance(raw, dict) and raw.get("id") is not None:
            by_id[str(raw.get("id"))] = raw

    changed = False
    for line in cart_lines:
        if not isinstance(line, dict):
            continue
        pid = str(line.get("id") or line.get("product_id") or "").strip()
        if not pid or pid not in by_id:
            continue

        product = by_id[pid]
        if not _line_is_piece_item(line, product):
            continue

        try:
            order_qty = int(
                round(float(line.get("quantity") or line.get("count") or 0))
            )
        except (TypeError, ValueError):
            continue
        if order_qty <= 0:
            continue

        current_stock = normalize_stock_quantity(
            product.get("stock_quantity", 0), is_weight=False
        )
        deduct_qty = min(order_qty, int(current_stock))
        new_stock = max(0, int(current_stock) - deduct_qty)

        if int(new_stock) == int(current_stock) and deduct_qty == 0:
            sync_product_stock_fields(product)
            continue

        product["stock_quantity"] = float(new_stock)
        sync_product_stock_fields(product)
        changed = True

    return changed


def normalize_discount_value(raw) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 0
    return max(0, min(99, value))


def normalize_unit_type(raw) -> str:
    value = str(raw or "pcs").strip().lower()
    return "weight" if value == "weight" else "pcs"


def normalize_product(product: object) -> dict[str, Any]:
    if not isinstance(product, dict):
        return {}
    out = dict(product)
    out["discount"] = normalize_discount_value(out.get("discount", 0))
    out["unit_type"] = normalize_unit_type(out.get("unit_type", "pcs"))
    if out["unit_type"] == "weight":
        out["is_weight_item"] = True
        if str(out.get("price_per_unit", "")).strip().lower() == "kg":
            try:
                out["price"] = round(float(out.get("price") or 0) / 10.0, 2)
            except (TypeError, ValueError):
                pass
        out["price_per_unit"] = "100g"
    else:
        out["is_weight_item"] = False
        out["price_per_unit"] = "pcs"
    return sync_product_stock_fields(out)


def normalize_products_payload(data: object) -> dict:
    if not isinstance(data, dict):
        return {"categories": [], "products": []}
    cats = data.get("categories")
    prods = data.get("products")
    products: list[dict] = []
    if isinstance(prods, list):
        for item in prods:
            if isinstance(item, dict):
                products.append(normalize_product(item))
    return {
        "categories": cats if isinstance(cats, list) else [],
        "products": products,
    }
