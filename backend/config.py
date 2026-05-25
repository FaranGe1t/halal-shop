import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent

# Путь к базе данных
DATABASE_PATH = BACKEND_DIR / "shop_database.db"

# URL для Telegram Mini App (задаётся через переменную окружения)
PUBLIC_URL = os.getenv("PUBLIC_URL", "https://halal-shop-1.onrender.com")


def get_app_base_url() -> str:
    return PUBLIC_URL.rstrip("/")


def load_project_dotenv() -> None:
    # Для Render эта функция не нужна
    pass


# Конфиг для бота
class Config:
    BOT_TOKEN = os.getenv("BOT_TOKEN", "")
    ADMIN_ID = os.getenv("ADMIN_ID", "")
    GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")
    HOST = "0.0.0.0"
    PORT = int(os.getenv("PORT", "8080"))


config = Config()

# Дополнительные переменные, которые могут понадобиться
ENV_FILE = None


def get_database_path() -> Path:
    custom = os.getenv("DATABASE_PATH", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    return DATABASE_PATH.resolve()


def get_frontend_root() -> Path:
    custom = os.getenv("FRONTEND_DIR", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    return (PROJECT_ROOT / "frontend").resolve()


def get_uploads_dir() -> Path:
    custom = os.getenv("UPLOADS_DIR", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    if os.getenv("RENDER", "").strip().lower() in ("true", "1", "yes"):
        return (BACKEND_DIR / "uploads").resolve()
    return (get_frontend_root() / "uploads").resolve()


def get_products_path() -> Path:
    custom = os.getenv("PRODUCTS_JSON", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()
    return (BACKEND_DIR / "products.json").resolve()
