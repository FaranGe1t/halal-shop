import os

from dotenv import load_dotenv

load_dotenv()


class BotConfig:
    BOT_TOKEN: str = os.getenv("BOT_TOKEN", "").strip()
    ADMIN_ID: str = os.getenv("ADMIN_ID", "").strip()
    # Google Maps / Places / Geocoding (ключ из Google Cloud Console)
    GOOGLE_MAPS_API_KEY: str = (
        os.getenv("GOOGLE_MAPS_API_KEY", os.getenv("GOOGLE_API_KEY", "")).strip()
    )

    @property
    def google_maps_api_key(self) -> str:
        """Алиас для единообразного доступа в коде."""
        return self.GOOGLE_MAPS_API_KEY


config = BotConfig()
