from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import get_identity, require_quota
from app.services.content_service import content_service
from app.services.subscription_service import _subscription_service


router = APIRouter()


class ContentRequest(BaseModel):
    product_name: str
    platform: str = "xiaohongshu"  # xiaohongshu | douyin
    content_type: str = "copy"       # copy | script | title | selling_points
    price_text: Optional[str] = None
    commission_ratio: Optional[float] = None
    sales: Optional[int] = None
    coupon_info: Optional[str] = None
    context: Optional[str] = None


@router.post("/content/generate")
async def generate_content(request: ContentRequest, identity: dict = Depends(get_identity), _: None = Depends(require_quota)):
    """一键生成能发的内容（种草文案/口播脚本/标题/卖点卡）。

    配额：会员无限；免费/匿名按设备维度每日免费次数（与问答同源 quota）。
    """
    name = (request.product_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="请填写商品名/品类名")
    if request.platform not in ("xiaohongshu", "douyin"):
        request.platform = "xiaohongshu"
    if request.content_type not in ("copy", "script", "title", "selling_points"):
        request.content_type = "copy"
    extra = {
        "price_text": request.price_text,
        "commission_ratio": request.commission_ratio,
        "sales": request.sales,
        "coupon_info": request.coupon_info,
        "context": request.context,
    }
    try:
        result = await content_service.generate_content(name, request.platform, request.content_type, extra)
    except Exception as error:  # noqa: BLE001
        print(f"[CONTENT] 生成失败: {error}")
        raise HTTPException(status_code=500, detail="内容生成失败，请稍后重试")

    # 免费/匿名按设备维度、登录按账号维度计 1 次 quota（会员不计，与问答同源）
    if not identity["is_member"]:
        try:
            _subscription_service.consume(
                f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}",
                "chat",
            )
        except Exception:  # noqa: BLE001
            pass
    return {"success": True, **result}
