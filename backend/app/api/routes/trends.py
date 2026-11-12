from typing import Dict, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.deps import require_admin
from app.services import trend_service
from app.services.union_service import union_provider

router = APIRouter()


class SnapshotRequest(BaseModel):
    keyword: str = ""


@router.get("/products/{item_id}/trend")
async def product_trend(item_id: str, days: int = 30):
    """单个商品的销量/价格随时间变化（真·需求走向）。"""
    return {
        "item_id": item_id,
        "days": days,
        "series": trend_service.get_product_trend(item_id, days),
        "source": "好单库",
    }


@router.get("/trends")
async def keyword_trend(keyword: str = "", days: int = 30):
    """某关键词（如『防晒』）按日的聚合趋势：在售数/月销合计/均价/平均佣金。"""
    if not keyword:
        return {"keyword": "", "days": days, "series": [], "note": "keyword 必填", "source": "好单库"}
    return {
        "keyword": keyword,
        "days": days,
        "series": trend_service.get_keyword_trend(keyword, days),
        "source": "好单库",
    }


@router.post("/trends/snapshot")
async def snapshot(req: SnapshotRequest, admin: Dict = Depends(require_admin)):
    """手动触发一次快照：立刻用该关键词查好单库并写入当日趋势库（也供后台轮询复用）。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：此前无鉴权，任何人可触发外部 API 查询并写库；现仅管理员。
    """
    if not req.keyword:
        return {"status": "error", "msg": "keyword 必填"}
    leads = await union_provider.search_products(keyword=req.keyword, max_items=12)
    recorded = trend_service.record_leads(req.keyword, leads)
    return {"status": "ok", "keyword": req.keyword, "recorded": recorded}
