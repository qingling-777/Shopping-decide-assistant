from typing import Any, Dict, List, Optional
import json

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.core.config import settings
from app.deps import get_identity, require_balance, require_intro_quota, get_current_user
from app.services.candidate_service import candidate_service
from app.services.subscription_service import _subscription_service

router = APIRouter()


class ArchiveItem(BaseModel):
    id: str
    brand: str = ""
    title: str = ""
    image: str = ""
    priceText: str = ""
    commissionRatio: Optional[float] = None
    commissionMoney: Optional[float] = None
    sales: Optional[float] = None
    link: str = ""
    source: str = ""
    couponInfo: str = ""
    detailUrl: str = ""


class ArchiveRequest(BaseModel):
    userId: str
    items: List[ArchiveItem]


class FavoriteRequest(BaseModel):
    userId: str
    id: str
    favorited: bool = True


class PromoRequest(BaseModel):
    product: Dict[str, Any]


@router.post("/candidates/archive")
async def archive(req: ArchiveRequest, user: Dict = Depends(get_current_user)):
    """把 /chat/stream 下发的商品卡归档进候选池（含 AI 富字段）。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：此前信任请求体中的 userId（IDOR，可读写任意用户数据），
    现强制从登录令牌取 user_id，请求体 userId 忽略。
    """
    archived = await candidate_service.archive_candidates(user["id"], [it.model_dump() for it in req.items])
    return {"status": "ok", "archived": archived}


@router.get("/candidates")
async def list_candidates(user: Dict = Depends(get_current_user)):
    """列出当前登录用户的候选池（商品名/品牌/价格/方向标签/竞争等级/卖点/平台/来源链接/更新时间/收藏标记）。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：userId 改从令牌取，不再接受查询参数（此前 IDOR 可读任意用户数据）。
    """
    return {"items": candidate_service.list_candidates(user["id"])}


@router.post("/candidates/favorite")
async def favorite(req: FavoriteRequest, user: Dict = Depends(get_current_user)):
    """切换收藏标记。⚠️ 2026-08-28 P0-3 修复：userId 从令牌取，请求体忽略。"""
    await candidate_service.set_favorite(user["id"], req.id, req.favorited)
    return {"status": "ok"}


@router.get("/products/competitors")
async def competitors(keyword: str = "", brand: str = "", limit: int = 8):
    """查竞品：按品牌/关键词找同类在售商品。"""
    items = await candidate_service.get_competitors(keyword=keyword, brand=brand, limit=limit)
    return {"items": items}


@router.post("/candidates/check-changes")
async def check_changes(req: ArchiveRequest, user: Dict = Depends(get_current_user)):
    """佣金/价格变动提醒：按需检查当前用户候选池商品的佣金/价格相对基线的变动。

    ⚠️ 2026-08-28 P0-3 修复：userId 从令牌取，请求体忽略。
    """
    changes = await candidate_service.check_changes(user["id"])
    return {"changes": changes}


@router.post("/products/promo-plan")
async def promo_plan(req: PromoRequest, identity: Dict = Depends(get_identity), _: None = Depends(require_balance)):
    """生成「AI 生成推广方案」：按 token ×5（原倍数）收费，不占每日免费额度（2026-08-25）。

    2026-08-27 改为流式 SSE：生成过程中下发 type=thinking（深度思考步骤），最终下发 type=plan（完整方案+用量回执）。
    LLM 用量聚合（方案 + 内嵌商品介绍）写入 billing_events（promo_plan 事件），余额不足 402。
    """

    async def generate():
        subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
        try:
            async for ev in candidate_service._generate_promo_plan_stream(req.product):
                if ev.get("type") == "thinking":
                    yield f"data: {json.dumps({'type': 'thinking', 'content': ev['content']}, ensure_ascii=False)}\n\n"
                elif ev.get("type") == "plan":
                    plan = ev["plan"]
                    usage = ev.get("usage")
                    receipt = None
                    if usage:
                        receipt = _subscription_service.record_usage(
                            subject, "promo_plan", usage.get("model") or "", tokens_in=usage.get("tokens_in", 0),
                            tokens_out=usage.get("tokens_out", 0), tokens_cached=usage.get("tokens_cached", 0),
                            model_brand="promo_plan", request_id="",
                            charge_multiplier=None,  # 原倍数（×5）
                            free_eligible=False,     # 付费功能不占免费额度
                            meta="event=promo_plan",
                        )
                    plan.pop("_usage", None)
                    plan.pop("_cached", None)
                    payload = {"type": "plan", "plan": plan, "usage": receipt, "cached": bool(ev.get("cached"))}
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    return
        except Exception as e:
            print(f"[PROMO-PLAN] 流式生成异常: {e}")
            yield f"data: {json.dumps({'type': 'error', 'content': '推广方案生成失败，请稍后重试'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/products/intro")
async def product_intro(req: PromoRequest, identity: Dict = Depends(get_identity), _: None = Depends(require_intro_quota)):
    """生成商品介绍：好单库字段 + 联网真实测评文章，LLM 合成，按 token ×1.5 收费（2026-08-25 用户调整为 1.5 倍）。

    2026-08-26 权重制改造：商品介绍不再强制要求余额，而是**先消耗每日免费额度**（free_weight=0.25，每日 3.0 权重可看 12 次）；
    免费额度耗尽后再按 token 从余额扣（×1.5）。结果落库持久缓存（product_contents），命中缓存不重复收费；
    免费额度内返回 is_free=True、cost=名义售价；额度耗尽且余额不足 → 402。
    """
    intro = await candidate_service.generate_product_intro(req.product)
    usage = intro.pop("_usage", None)
    receipt = None
    if usage:
        subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
        receipt = _subscription_service.record_usage(
            subject, "product_intro", usage.get("model") or "", tokens_in=usage.get("tokens_in", 0),
            tokens_out=usage.get("tokens_out", 0), tokens_cached=usage.get("tokens_cached", 0),
            model_brand="product_intro", request_id="",
            charge_multiplier=0.0 if settings.PRODUCT_INTRO_FREE else 1.5,   # 免费期不计费；否则按 token ×1.5（2026-08-25 由 ×3 下调）
            free_eligible=True,      # 权重制：介绍占每日免费额度（free_weight=0.25），额度内免费
            free_weight=0.0 if settings.PRODUCT_INTRO_FREE else settings.FREE_INTRO_WEIGHT,
            meta="event=product_intro",
        )
    return {"intro": intro, "usage": receipt}
