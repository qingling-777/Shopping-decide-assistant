from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.deps import get_current_user
from app.services.plan_service import plan_service
from app.services.candidate_service import candidate_service

router = APIRouter()


class PlansSyncRequest(BaseModel):
    userId: str  # 兼容保留（忽略，一律以登录令牌为准，2026-08-28 P0-3）
    plans: List[Dict[str, Any]]


class PromoSaveRequest(BaseModel):
    userId: str  # 兼容保留（忽略）
    productId: str
    productName: Optional[str] = ""
    brand: Optional[str] = ""
    price: Optional[str] = ""
    plan: Dict[str, Any]


@router.get("/plans")
async def list_plans(user: Dict = Depends(get_current_user)):
    """列出当前登录用户的测品计划（含每个计划挂的推广方案）。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：userId 改从登录令牌取，不再接受查询参数（此前 IDOR 可读任意用户数据）。
    """
    return {"items": plan_service.list_plans(user["id"])}


@router.post("/plans/sync")
async def sync_plans(req: PlansSyncRequest, user: Dict = Depends(get_current_user)):
    """整列覆盖当前登录用户的测品计划（前端本地变更后同步，幂等）。P0-3：userId 从令牌取。"""
    count = await plan_service.sync_plans(user["id"], req.plans)
    return {"status": "ok", "count": count}


class PlanPromoStrategyRequest(BaseModel):
    userId: str  # 兼容保留（忽略）
    planId: str
    planName: str = ""
    direction: str = ""
    products: List[Dict[str, Any]] = []


@router.post("/plans/promo-strategy")
async def generate_plan_promo_strategy(req: PlanPromoStrategyRequest, user: Dict = Depends(get_current_user)):
    """生成计划级整合推广策略：把计划内多个商品统筹成一套打法，并写回计划。P0-3：userId 从令牌取。"""
    strategy = await candidate_service.generate_plan_promo_strategy(
        {
            "id": req.planId,
            "name": req.planName,
            "direction": req.direction,
        },
        req.products,
    )
    await plan_service.attach_plan_promo_strategy(user["id"], req.planId, strategy)
    return {"status": "ok", "strategy": strategy}


@router.post("/products/promo-plan/save")
async def save_promo_plan(req: PromoSaveRequest, user: Dict = Depends(get_current_user)):
    """保存一条推广方案（不挂测品计划时单独存档，按 productId 去重）。P0-3：userId 从令牌取。"""
    item = {
        "id": f"promo_{req.productId}",
        "productId": req.productId,
        "productName": req.productName or "",
        "brand": req.brand or "",
        "price": req.price or "",
        "plan": req.plan,
    }
    await plan_service.save_standalone_promo(user["id"], item)
    return {"status": "ok"}


@router.get("/products/promo-plan/saved")
async def list_saved_promo(user: Dict = Depends(get_current_user)):
    """列出当前登录用户已保存的推广方案。P0-3：userId 从令牌取。"""
    return {"items": plan_service.list_standalone_promo(user["id"])}
