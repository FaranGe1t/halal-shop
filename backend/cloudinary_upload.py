import os
import sys

import cloudinary
import cloudinary.api
import cloudinary.uploader


def _cloudinary_log(message: str) -> None:
    try:
        print(message, flush=True)
    except UnicodeEncodeError:
        print(message.encode("ascii", "replace").decode("ascii"), flush=True)


def init_cloudinary():
    """Инициализация Cloudinary из переменных окружения."""
    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME", "").strip()
    api_key = os.getenv("CLOUDINARY_API_KEY", "").strip()
    api_secret = os.getenv("CLOUDINARY_API_SECRET", "").strip()

    _cloudinary_log(
        f"🔍 Cloudinary check: cloud_name={cloud_name}, "
        f"api_key={api_key[:5] if api_key else 'None'}..., "
        f"has_secret={bool(api_secret)}"
    )

    if not cloud_name or not api_key or not api_secret:
        _cloudinary_log("⚠️ Cloudinary не настроен: отсутствуют переменные окружения")
        return False

    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )
    _cloudinary_log(f"✅ Cloudinary инициализирован (cloud_name: {cloud_name})")
    return True


def upload_product_image(image_file, product_id):
    """
    Загружает картинку товара в Cloudinary.
    Возвращает URL картинки.
    """
    try:
        upload_result = cloudinary.uploader.upload(
            image_file,
            folder=f"halal_shop/products/{product_id}",
            transformation=[
                {"width": 400, "height": 400, "crop": "limit"},
                {"quality": "auto"},
                {"fetch_format": "auto"},
            ],
            use_filename=True,
            unique_filename=True,
        )
        return upload_result["secure_url"]
    except Exception as e:
        print(f"Ошибка загрузки в Cloudinary: {e}")
        return None


def upload_category_image(image_file, category_id):
    """Загружает картинку категории."""
    try:
        upload_result = cloudinary.uploader.upload(
            image_file,
            folder=f"halal_shop/categories/{category_id}",
            transformation=[
                {"width": 100, "height": 100, "crop": "limit"},
                {"quality": "auto"},
            ],
            use_filename=True,
            unique_filename=True,
        )
        return upload_result["secure_url"]
    except Exception as e:
        print(f"Ошибка загрузки категории: {e}")
        return None


def delete_product_images(product_id):
    """Удаляет все картинки товара."""
    try:
        cloudinary.api.delete_resources_by_prefix(
            f"halal_shop/products/{product_id}"
        )
        cloudinary.api.delete_folder(f"halal_shop/products/{product_id}")
        return True
    except Exception as e:
        print(f"Ошибка удаления: {e}")
        return False
