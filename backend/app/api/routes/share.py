"""分享路由。

- POST /api/v1/share  创建分享（无需付费配额；匿名按设备、登录按 user 记录 owner）
- GET  /share/{id}    公开页（在 main.py 挂载，无 API 前缀，纯 HTML）

前端分享流：把当前对话产出的「报告」{title, summary, tags, cards} POST 上来 → 拿 share_id
+ 公网 URL；公网页自带带溯源卡片图 + 保存图片 + 复制链接，形成获客飞轮。
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.deps import get_identity
from app.services.share_service import _share_service

router = APIRouter()


class ShareCard(BaseModel):
    cardType: str
    cardData: Any = None


class ShareCreateRequest(BaseModel):
    title: str = "美妆选品报告"
    summary: str = ""
    tags: List[str] = []
    cards: List[ShareCard] = []
    ttl_days: Optional[int] = None  # None → 用 settings.SHARE_DEFAULT_TTL_DAYS


@router.post("/share")
async def create_share(req: ShareCreateRequest, request: Request, identity: Dict = Depends(get_identity)):
    owner = identity.get("user_id") or f"device:{identity['device_id']}"
    payload = {
        "title": req.title,
        "summary": req.summary,
        "tags": req.tags,
        "cards": [c.model_dump() for c in req.cards],
    }
    share_id = _share_service.create_report(payload, owner_id=owner, ttl_days=req.ttl_days)
    base = str(request.base_url).rstrip("/")
    url = f"{base}/share/{share_id}"
    return {"share_id": share_id, "url": url}
