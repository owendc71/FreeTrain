"""SQLAlchemy models for WorkoutRunner."""
import uuid
import json
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, Boolean,
    DateTime, ForeignKey, Text, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id            = Column(String(36), primary_key=True, default=_uuid)
    email         = Column(String(254), unique=True, nullable=False, index=True)
    username      = Column(String(60),  unique=True, nullable=False, index=True)
    password_hash = Column(String(128), nullable=False)
    ftp           = Column(Integer, default=250)
    # "free" | "pro"  – reserved for subscription / ad logic
    tier          = Column(String(16), default="free", nullable=False)
    is_active     = Column(Boolean, default=True, nullable=False)
    created_at    = Column(DateTime, default=datetime.utcnow)

    workouts = relationship("Workout", back_populates="user",
                            cascade="all, delete-orphan", passive_deletes=True)
    rides    = relationship("Ride",    back_populates="user",
                            cascade="all, delete-orphan", passive_deletes=True)
    plans    = relationship("Plan",    back_populates="user",
                            cascade="all, delete-orphan", passive_deletes=True)


class Workout(Base):
    __tablename__ = "workouts"

    id             = Column(String(36), primary_key=True, default=_uuid)
    user_id        = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"),
                            nullable=False, index=True)
    name           = Column(String(200), nullable=False)
    description    = Column(String(500), default="")
    intervals_json = Column(Text, nullable=False, default="[]")
    total_duration = Column(Integer, default=0)
    created_at     = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="workouts")
    plans = relationship("Plan", back_populates="workout",
                         passive_deletes=True)

    def to_dict(self) -> dict:
        return {
            "id":             self.id,
            "name":           self.name,
            "description":    self.description,
            "intervals":      json.loads(self.intervals_json or "[]"),
            "total_duration": self.total_duration,
        }


class Ride(Base):
    __tablename__ = "rides"

    id               = Column(String(36), primary_key=True, default=_uuid)
    user_id          = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"),
                              nullable=False, index=True)
    workout_name     = Column(String(200), default="")
    date             = Column(String(32))   # ISO-8601 string
    elapsed          = Column(Integer, default=0)
    total_duration   = Column(Integer, default=0)
    avg_power        = Column(Float, default=0.0)
    normalized_power = Column(Float, default=0.0)
    intensity_factor = Column(Float, default=0.0)
    tss              = Column(Float, default=0.0)
    ftp              = Column(Integer, default=250)
    completed        = Column(Boolean, default=False)
    # large samples stored separately; omitted from list view
    power_samples    = Column(Text, default="[]")
    created_at       = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="rides")

    def to_dict(self, include_samples: bool = False) -> dict:
        d = {
            "id":               self.id,
            "workout_name":     self.workout_name,
            "date":             self.date,
            "elapsed":          self.elapsed,
            "total_duration":   self.total_duration,
            "avg_power":        self.avg_power,
            "normalized_power": self.normalized_power,
            "intensity_factor": self.intensity_factor,
            "tss":              self.tss,
            "ftp":              self.ftp,
            "completed":        self.completed,
        }
        if include_samples:
            d["power_samples"] = json.loads(self.power_samples or "[]")
        return d


class Plan(Base):
    __tablename__  = "plans"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_plan_user_date"),)

    id         = Column(String(36), primary_key=True, default=_uuid)
    user_id    = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    date       = Column(String(10), nullable=False)   # YYYY-MM-DD
    workout_id = Column(String(36), ForeignKey("workouts.id", ondelete="SET NULL"),
                        nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    user    = relationship("User",    back_populates="plans")
    workout = relationship("Workout", back_populates="plans")
