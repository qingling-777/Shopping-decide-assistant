from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import get_current_user
from app.services import tracking_service, trend_service
from app.services.union_service import union_provider

router = APIRouter()


class TrackRequest(BaseModel):
    direction: str
    keyword: str = ""


def _subject(user: Dict) -> str:
    return f"user:{user['id']}"


@router.get("/tracking")
async def list_tracking(user: Dict = Depends(get_current_user)):
    """我的追踪方向列表（含每个方向的时间序列，供前端折线图可视化）。"""
    subject = _subject(user)
    items = tracking_service.list_directions(subject)
    # 每个方向附加好单库趋势序列（trend_service 的 keyword 趋势）
    result = []
    for it in items:
        kw = it["keyword"]
        series = trend_service.get_keyword_trend(kw, days=60)
        result.append({
            "direction": it["direction"],
            "keyword": kw,
            "addedAt": it["addedAt"],
            "series": series,
            "tracked": True,
        })
    return {"items": result}


@router.post("/tracking")
async def add_tracking(body: TrackRequest, user: Dict = Depends(get_current_user)):
    """加入追踪（幂等）：记录方向 + 当日信号快照，并返回该方向趋势序列。"""
    direction = body.direction.strip()
    if not direction:
        raise HTTPException(status_code=400, detail="方向名不能为空")
    subject = _subject(user)
    kw = (body.keyword or direction).strip()
    tracking_service.add(subject, direction, kw)
    # 拉一次真实信号写快照（失败不阻断，快照为 best-effort）
    try:
        leads = await union_provider.search_products(keyword=kw, max_items=20)
        if leads:
            sales = [l.get("sales") or 0 for l in leads]
            prices = [l.get("price_value") for l in leads if l.get("price_value")]
            ratios = [l.get("commission_ratio") for l in leads if l.get("commission_ratio") is not None]
            tracking_service.record_snapshot(subject, direction, {
                "products": len(leads),
                "total_sales": sum(sales),
                "avg_price": round(sum(prices) / len(prices), 1) if prices else None,
                "avg_commission": round(sum(ratios) / len(ratios), 2) if ratios else None,
            })
    except Exception as e:
        print(f"[TRACKING] 快照写入失败(降级): {e}")
    series = trend_service.get_keyword_trend(kw, days=60)
    return {"status": "ok", "direction": direction, "series": series}


@router.delete("/tracking/{direction}")
async def remove_tracking(direction: str, user: Dict = Depends(get_current_user)):
    """取消追踪。"""
    ok = tracking_service.remove(_subject(user), direction)
    return {"status": "ok" if ok else "not_found"}


@router.get("/tracking/{direction}/trend")
async def tracking_trend(direction: str, days: int = 60, user: Dict = Depends(get_current_user)):
    """单方向时间序列（月销/款数/均价/佣金），供追踪列表卡片展开折线图。"""
    subject = _subject(user)
    items = tracking_service.list_directions(subject)
    match = next((i for i in items if i["direction"] == direction), None)
    if not match:
        raise HTTPException(status_code=404, detail="未追踪该方向")
    kw = match["keyword"]
    return {
        "direction": direction,
        "keyword": kw,
        "series": trend_service.get_keyword_trend(kw, days=days),
        "source": "好单库聚合",
    }
