"""
⚠️ DEPRECATED / 死代码（2026-08-28 工程审查确认）：本文件无任何业务 service 引用，
且 config.py 未定义其依赖的配置项（DATABASE_URL / REDIS_HOST 等），import 即 AttributeError。
请不要基于本文件接入 ORM/Redis；项目实际使用裸 sqlite3（见各 services/*_service.py）。
如需清理，确认无引用后可删除本文件及 app/models/、app/db/ 整目录。
"""

import redis.asyncio as aioredis
from app.core.config import settings

redis_client: aioredis.Redis | None = None


async def get_redis() -> aioredis.Redis:
    global redis_client
    if redis_client is None:
        redis_client = aioredis.Redis(
            host=settings.REDIS_HOST,
            port=settings.REDIS_PORT,
            db=settings.REDIS_DB,
            decode_responses=True,
        )
    return redis_client


async def close_redis():
    global redis_client
    if redis_client:
        await redis_client.close()
        redis_client = None
