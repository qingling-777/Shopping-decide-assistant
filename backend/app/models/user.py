"""
⚠️ DEPRECATED / 死代码（2026-08-28 工程审查确认）：本文件无任何业务 service 引用，
且 config.py 未定义其依赖的配置项（DATABASE_URL / REDIS_HOST 等），import 即 AttributeError。
请不要基于本文件接入 ORM/Redis；项目实际使用裸 sqlite3（见各 services/*_service.py）。
如需清理，确认无引用后可删除本文件及 app/models/、app/db/ 整目录。
"""

from sqlalchemy import Column, String, Boolean, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
import uuid
from app.db.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    phone = Column(String(20), unique=True, nullable=True)
    email = Column(String(255), unique=True, nullable=True)
    nickname = Column(String(50), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
