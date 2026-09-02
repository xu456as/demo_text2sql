from functools import lru_cache
from pathlib import Path
import os


class Settings:
    root_dir = Path(__file__).resolve().parents[2]
    app_mode = os.getenv("APP_MODE", "demo")
    database_path = Path(os.getenv("APP_DATABASE_PATH", root_dir / "datachat.db"))
    metadata_path = Path(os.getenv("METADATA_PATH", root_dir / "config/metadata/demo-sales.yaml"))
    fixtures_path = Path(os.getenv("FIXTURES_PATH", root_dir / "config/demo-fixtures.json"))
    openai_api_key = os.getenv("OPENAI_API_KEY", "")
    openai_base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    openai_model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")
    anthropic_base_url = os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    anthropic_model = os.getenv("ANTHROPIC_MODEL", "")
    anthropic_timeout_seconds = float(os.getenv("ANTHROPIC_TIMEOUT_SECONDS", "60"))
    log_llm_payloads = os.getenv("LOG_LLM_PAYLOADS", "true").lower() in {"1", "true", "yes", "on"}
    mysql_dsn = os.getenv("MYSQL_DSN", "")
    frontend_dist = Path(os.getenv("FRONTEND_DIST", root_dir / "backend/static"))


@lru_cache
def get_settings() -> Settings:
    return Settings()
