"""
⚠️ DEPRECATED / 死代码（2026-08-28 工程审查确认）：本文件无任何业务 service 引用，
且 config.py 未定义其依赖的配置项（DATABASE_URL / REDIS_HOST 等），import 即 AttributeError。
请不要基于本文件接入 ORM/Redis；项目实际使用裸 sqlite3（见各 services/*_service.py）。
如需清理，确认无引用后可删除本文件及 app/models/、app/db/ 整目录。
"""

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from app.core.config import settings


engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DEBUG,
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
