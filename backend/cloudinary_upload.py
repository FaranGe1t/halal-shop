import os

import cloudinary
import cloudinary.api
import cloudinary.uploader


def init_cloudinary():
    """Инициализация Cloudinary из переменных окружения."""
    cloudinary.config(
        cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
        api_key=os.getenv("CLOUDINARY_API_KEY"),
        api_secret=os.getenv("CLOUDINARY_API_SECRET"),
        secure=True,
    )


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
