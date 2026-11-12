from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import get_identity, require_balance
from app.services.ai_service import ai_service
from app.services.subscription_service import _subscription_service


router = APIRouter()


class DiagnoseRequest(BaseModel):
    product_name: str
    platform: str = "all"  # all | douyin | xiaohongshu | kuaishou


@router.post("/diagnose")
async def diagnose(request: DiagnoseRequest, identity: dict = Depends(get_identity), _: None = Depends(require_balance)):
    """单品深度诊断：余额制按 token 计费，不占每日免费额度。

    闸门：余额 > 0，否则 402 引导充值。无好单库 key 时仍给定性诊断（signals/competitors 为空）。
    """
    name = (request.product_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写商品名/品类名")
    try:
        result = await ai_service.diagnose_product(name, request.platform)
    except Exception as error:  # noqa: BLE001
        print(f"[DIAGNOSE] 诊断失败: {error}")
        raise HTTPException(status_code=500, detail="单品诊断失败，请稍后重试")

    subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    usage = result.pop("_usage", None)
    receipt = None
    if usage:
        receipt = _subscription_service.record_usage(
            subject,
            "deep_diagnosis",
            usage.get("model") or "",
            tokens_in=usage.get("tokens_in", 0),
            tokens_out=usage.get("tokens_out", 0),
            tokens_cached=usage.get("tokens_cached", 0),
            model_brand="deep_diagnosis",
            request_id="",
            charge_multiplier=None,  # 默认售价倍率 ×5
            free_eligible=False,     # 付费功能不占每日免费额度
            meta="event=deep_diagnosis",
        )
    return {"success": True, **result, "usage": receipt}
