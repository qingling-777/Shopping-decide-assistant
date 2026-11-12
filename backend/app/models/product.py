"""
⚠️ DEPRECATED / 死代码（2026-08-28 工程审查确认）：本文件无任何业务 service 引用，
且 config.py 未定义其依赖的配置项（DATABASE_URL / REDIS_HOST 等），import 即 AttributeError。
请不要基于本文件接入 ORM/Redis；项目实际使用裸 sqlite3（见各 services/*_service.py）。
如需清理，确认无引用后可删除本文件及 app/models/、app/db/ 整目录。
"""

from sqlalchemy import Column, String, Numeric, DateTime, Text, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
import uuid
from app.db.database import Base


class Product(Base):
    __tablename__ = "products"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    platform = Column(String(20), nullable=False)
    platform_product_id = Column(String(100), nullable=False)
    title = Column(String(500), nullable=False)
    image_url = Column(Text, nullable=True)
    category = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class PriceRecord(Base):
    __tablename__ = "price_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False)
    platform = Column(String(20), nullable=False)
    price = Column(Numeric(10, 2), nullable=False)
    promotion_price = Column(Numeric(10, 2), nullable=True)
    coupon_info = Column(Text, nullable=True)
    shop_name = Column(String(200), nullable=True)
    recorded_at = Column(DateTime(timezone=True), server_default=func.now())


class Favorite(Base):
    __tablename__ = "favorites"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PriceAlert(Base):
    __tablename__ = "price_alerts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    product_id = Column(UUID(as_uuid=True), ForeignKey("products.id"), nullable=False)
    target_price = Column(Numeric(10, 2), nullable=False)
    status = Column(String(20), default="active")  # active / triggered / cancelled
    created_at = Column(DateTime(timezone=True), server_default=func.now())
