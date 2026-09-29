import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _flag(value: str | None, default: bool = False) -> bool:
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        e = os.environ.get
        self.port = int(e("PORT", "8000"))
        extra = [o.strip() for o in e("FRONTEND_ORIGIN", "").split(",") if o.strip()]
        self.cors_origins = sorted(set(extra + [
            "http://localhost:3000", "http://127.0.0.1:3000",
            "http://localhost:3001", "http://127.0.0.1:3001",
        ]))
        self.ai_provider = e("AI_PROVIDER", "mock").strip().lower()
        self.anthropic_key = e("ANTHROPIC_API_KEY", "")
        self.anthropic_model = e("ANTHROPIC_MODEL", "claude-sonnet-5-5")
        self.gemini_key = e("GEMINI_API_KEY", "")
        self.gemini_model = e("GEMINI_MODEL", "gemini-2.0-flash")
        self.demo_mode = _flag(e("DEMO_MODE"), False)
        self.max_population = int(e("MAX_POPULATION_SIZE", "100000"))
        self.max_upload_bytes = int(float(e("MAX_UPLOAD_SIZE_MB", "10")) * 1024 * 1024)
        self.storage_dir = BASE_DIR / "storage"
        self.storage_dir.mkdir(exist_ok=True)


settings = Settings()
