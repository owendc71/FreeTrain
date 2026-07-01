"""Database engine, session factory, and Base."""
import os
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Default: SQLite in project root.  Override with DATABASE_URL env var for Postgres.
_default_url = f"sqlite:///{Path(__file__).parent.parent / 'workoutrunner.db'}"
DATABASE_URL  = os.getenv("DATABASE_URL", _default_url)

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine        = create_engine(DATABASE_URL, connect_args=_connect_args, echo=False)
SessionLocal  = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base          = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Create all tables (idempotent – safe to call on every startup)."""
    from models import Base as ModelBase  # noqa: F401 – triggers model registration
    ModelBase.metadata.create_all(bind=engine)
