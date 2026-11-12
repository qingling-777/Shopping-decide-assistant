from typing import Dict

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings
from app.services.auth_service import _auth_service
from app.services.subscription_service import _subscription_service


_bearer = HTTPBearer(auto_error=False)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> Dict:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    user = _auth_service.verify_token(credentials.credentials)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录已过期，请重新登录")
    return user


async def get_quota_subject(request: Request) -> str:
    """解析计费主体（保留给会员管理类路由）：Bearer 登录用户 → user:<id>；否则 X-Device-Id → device:<id>；都无 → 400。

    用户订阅统一以 `user:<id>` 为键，与 is_active_member/get_card_remaining/check_card_quota/consume_card
    内部 `user:{user_id}` 的查表键保持一致（否则会员开通后 quota 逻辑认不出，是已修的真 bug）。
    设计取舍（PAYWALL_DESIGN.md §4.3/§6）：不强制登录，匿名 + 设备 ID 配额摩擦最低、最利获客。
    """
    auth = request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        user = _auth_service.verify_token(auth[7:].strip())
        if user:
            return f"user:{user['id']}"
        # token 无效：降级到设备维度（不 401，避免挡掉匿名路径）
    device_id = request.headers.get("X-Device-Id")
    if device_id:
        return f"device:{device_id.strip()}"
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="需要设备标识（请求头 X-Device-Id）或登录后携带 Authorization",
    )


async def get_identity(request: Request) -> Dict:
    """统一身份解析：返回 {user_id, is_member, device_id}。

    - 匿名（无有效 token）：user_id=None / is_member=False，但仍带 device_id（用于设备维度问答配额）。
    - 无 X-Device-Id → 400（前端恒定发送）。
    问答：登录按 user_id 计、匿名按 device_id 计（同账号跨设备一致）；卡片按 user_id 计（仅登录）。
    """
    auth = request.headers.get("Authorization")
    user_id = None
    is_member = False
    if auth and auth.lower().startswith("bearer "):
        user = _auth_service.verify_token(auth[7:].strip())
        if user:
            user_id = user["id"]
            is_member = _subscription_service.is_active_member(user_id)
    device_id = request.headers.get("X-Device-Id")
    if not device_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="需要设备标识（请求头 X-Device-Id）",
        )
    device_id = device_id.strip()
    # 匿名设备也可能被运营核销开通（device:<id> 计费主体），需一并识别会员态，
    # 否则客户付款被核销后仍显示 free（闭环断裂）。
    if not is_member:
        is_member = _subscription_service.is_member_subject(f"device:{device_id}")
    return {"user_id": user_id, "is_member": is_member, "device_id": device_id}


async def require_quota(identity: Dict = Depends(get_identity)) -> None:
    """余额制闸门（chat / content 共用）：每日免费额度剩余 OR 余额 > 0 才放行；
    两者皆无（免费额度耗尽且余额归零）→ 402 引导充值（像中转 API 平台）。
    被管理员拉黑（banned_subjects.active=1）的主体 → 403 拒绝（2026-08-30 反滥用）。"""
    chat_subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    if _subscription_service.is_banned(chat_subject):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "SUBJECT_BANNED", "message": "该账户已被管理员限制使用（异常调用），如有疑问请联系运营"},
        )
    if _subscription_service.free_events_remaining(chat_subject) > 0:
        return
    if not _subscription_service.has_balance(chat_subject):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "BALANCE_EMPTY",
                "recharge_url": "/recharge",
                "message": "免费额度已用完且余额不足，请充值后继续提问",
            },
        )


async def require_balance(identity: Dict = Depends(get_identity)) -> None:
    """付费功能闸门（推广方案等不享免费额度的按量功能）：余额 > 0 才放行，否则 402 引导充值。
    被管理员拉黑的主体 → 403 拒绝（2026-08-30 反滥用）。"""
    chat_subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    if _subscription_service.is_banned(chat_subject):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "SUBJECT_BANNED", "message": "该账户已被管理员限制使用（异常调用），如有疑问请联系运营"},
        )
    if not _subscription_service.has_balance(chat_subject):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "BALANCE_EMPTY",
                "recharge_url": "/recharge",
                "message": "余额不足，请充值后使用（该功能按 token 计费，不占每日免费额度）",
            },
        )


async def require_intro_quota(identity: Dict = Depends(get_identity)) -> None:
    """商品介绍闸门（2026-08-26 权重制）：先消耗每日免费额度（FREE_INTRO_WEIGHT=0.25），额度内放行；
    免费额度耗尽且余额<=0 → 402 引导充值。命中缓存（_usage=None）时不调用计费，不占额度。
    被管理员拉黑的主体 → 403 拒绝（2026-08-30 反滥用）。"""
    chat_subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    if _subscription_service.is_banned(chat_subject):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "SUBJECT_BANNED", "message": "该账户已被管理员限制使用（异常调用），如有疑问请联系运营"},
        )
    if settings.PRODUCT_INTRO_FREE:
        return
    if _subscription_service.free_events_remaining(chat_subject) >= settings.FREE_INTRO_WEIGHT:
        return
    if not _subscription_service.has_balance(chat_subject):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "BALANCE_EMPTY",
                "recharge_url": "/recharge",
                "message": "余额不足，请充值后使用（商品介绍按 token 计费，超出每日免费额度后需余额）",
            },
        )


async def require_membership(identity: Dict = Depends(get_identity)) -> None:
    """付费功能（深度报告 / 测品计划）闸门：未登录 → 401；非会员 → 402。"""
    if not identity["user_id"]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="请先登录后再使用会员功能",
        )
    if not identity["is_member"]:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "MEMBERSHIP_REQUIRED",
                "upgrade_url": "/pricing",
                "message": "该功能仅限会员，请升级内测会员后使用",
            },
        )


async def require_admin(user: Dict = Depends(get_current_user)) -> Dict:
    """管理员接口闸门：非管理员（或未登录）→ 403。

    用于保护运营类接口，例如 /billing/admin/grant 经营码人工核销开通，防止任意登录主体滥用。
    """
    if not user.get("is_admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要管理员权限",
        )
    return user
