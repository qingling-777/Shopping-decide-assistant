from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from app.core.config import settings
from app.deps import get_quota_subject, get_identity, require_membership, require_admin, get_current_user
from app.services.subscription_service import _subscription_service, PaymentDisabledError
from app.services.auth_service import _auth_service
from app.services.payment_service import get_payment_provider


router = APIRouter(prefix="/billing", tags=["billing"])

class ModeRequest(BaseModel):
    mode: str  # select | distribute


class ConsumeRequest(BaseModel):
    event: str  # deep_report | test_plan


class OrderRequest(BaseModel):
    plan: str  # monthly | yearly


class RechargeOrderRequest(BaseModel):
    amount: float  # 充值金额（元）
    channel: str = "wap"  # wap=手机网站H5收银台(返回pay_url) / face=当面付扫码(返回qr)


class GrantRequest(BaseModel):
    subject: Optional[str] = None  # 完整计费主体（device:<备注码> / user:<id>）；不传则对当前管理员自身开通
    plan: str = "monthly"  # monthly | yearly


class ProofRequest(BaseModel):
    plan: str = "monthly"  # monthly | yearly
    amount: Optional[float] = None  # 客户填写的付款金额（元）
    proof_ref: Optional[str] = None  # 支付宝订单号 / 转账备注（备注码）


class LinkDeviceRequest(BaseModel):
    device_id: str  # 当前客户所用设备的 X-Device-Id（前端 deviceStorage.get()）


class BanRequest(BaseModel):
    subject: str  # 完整计费主体（user:<id> / device:<id>）
    reason: str = "恶意多次调用"  # 封禁原因


@router.get("/me")
async def get_me(identity: Dict = Depends(get_identity)):
    """返回当前身份的双配额：tier / is_member / 问答剩余(登录按账号·匿名按设备) / 卡片剩余(用户维度·仅登录)。

    - 匿名：问答按设备剩余(FREE_DAILY_CHAT_LIMIT)，卡片=None（不产卡片）。
    - 会员：问答/卡片均无限 → remaining/card_remaining 为 None。
    - 免费登录：问答账号剩余 + 卡片用户剩余(CARD_DAILY_LIMIT)，跨设备一致。
    """
    device_id = identity["device_id"]
    user_id = identity["user_id"]
    is_member = identity["is_member"]
    subject = f"user:{user_id}" if user_id else f"device:{device_id}" if device_id else None
    chat_remaining = None if is_member else _subscription_service.get_chat_remaining(device_id, user_id)
    card_remaining = None if (not user_id or is_member) else _subscription_service.get_card_remaining(user_id)
    expiry = plan = status_val = None
    row = {}
    if user_id:
        row = _subscription_service._get_row(f"user:{user_id}") or {}
    # 匿名设备被核销开通时会员键在 device:<id>，回退读取以免 is_member=True 却缺 expiry/plan
    if not row and device_id:
        row = _subscription_service._get_row(f"device:{device_id}") or {}
    expiry = row.get("expiry")
    plan = row.get("plan")
    status_val = row.get("status")
    return {
        "tier": "early_bird" if is_member else "free",
        "is_member": is_member,
        "mode": "select",
        "quota_used": None if is_member else (settings.DAILY_FREE_EVENTS - chat_remaining if chat_remaining is not None else 0),
        "quota_limit": None if is_member else settings.DAILY_FREE_EVENTS,
        "remaining": chat_remaining,
        "card_remaining": card_remaining,
        "card_limit": None if (not user_id or is_member) else settings.CARD_DAILY_LIMIT,
        # 透明计费：每日免费事件配额（chat 等用户可见事件计入；内部核算事件不计）
        "daily_free_limit": settings.DAILY_FREE_EVENTS,
        "daily_free_remaining": _subscription_service.free_events_remaining(subject) if subject else 0,
        # 支付总开关：前端据此隐藏充值入口（2026-08-28 免费引流策略）
        "payment_enabled": settings.PAYMENT_ENABLED,
        "early_bird_left": _subscription_service._early_bird_left(),
        "expiry": expiry,
        "status": status_val,
        "plan": plan,
    }


@router.get("/pricing")
async def get_pricing():
    """返回各层价格与权益（前端付费墙 UI 拉取）。"""
    return _subscription_service.get_pricing()


@router.get("/merchant")
async def get_merchant(request: Request):
    """返回真收钱商户信息（支付宝经营码 + 商户名），供前端升级弹窗展示。

    早期真收钱路径：用户扫码付款 → 联系运营 → 运营调用 /billing/admin/grant 手动开通。
    qr_url 用 request.base_url 拼成绝对 URL，前端可直接用于 <Image source>。
    """
    base = str(request.base_url).rstrip("/")
    return {
        "name": settings.MERCHANT_NAME,
        "qr_url": f"{base}/static/{settings.MERCHANT_QR_FILENAME}",
    }


@router.post("/link-device")
async def link_device(body: LinkDeviceRequest, user: Dict = Depends(get_current_user)):
    """登录后把本机匿名会员并入账号（跨设备跟随），并记录 device_link 映射。

    仅迁移有效 device:<id> 会员到 user:<id>；迁移后清空设备会员态，使账号成为唯一真源。
    无设备会员时仅落映射，幂等安全。前端登录恢复与登录成功后调用，随后刷新 /billing/me。
    """
    try:
        return _subscription_service.migrate_device_membership(user["id"], body.device_id)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/orders")
async def create_order(body: OrderRequest, subject: str = Depends(get_quota_subject)):
    """创建内测会员订单（pending）。沙箱 Provider 仅生成商户订单号，无 pay_url/qr。"""
    try:
        return _subscription_service.create_order(subject, body.plan)
    except ValueError as error:
        code = status.HTTP_409_CONFLICT if "名额" in str(error) else status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=code, detail=str(error)) from error


@router.post("/orders/{out_trade_no}/settle")
async def settle_order(out_trade_no: str, subject: str = Depends(get_quota_subject)):
    """支付成功结算（沙箱：由前端「模拟支付」触发；真实通道：异步回调验签后调用）。幂等。

    沙箱模拟支付已关闭时返回 403，不授予会员。
    """
    try:
        return _subscription_service.settle_order(out_trade_no)
    except PaymentDisabledError as error:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.get("/orders")
async def list_orders(subject: str = Depends(get_quota_subject)):
    """列出当前计费主体的订单（倒序）。"""
    return {"items": _subscription_service.get_orders(subject)}


class RechargeRequest(BaseModel):
    amount: float  # 充值金额（元）


@router.get("/balance")
async def get_balance(identity: Dict = Depends(get_identity)):
    """当前计费主体余额（元）+ 赠送/购买拆分 + 体验金 + 预估还能聊几次。

    匿名设备：展示本机赠送体验金(¥5，按设备首次进入赠送)，隐藏购买余额；卡片仅登录后可见，
    故提示「登录解锁」即可（见 chat 的 card_hint）。充值仅登录后开放（见 /recharge 403）。
    登录用户返回真实余额(赠送+购买)。
    """
    if not identity["user_id"]:
        device_id = identity["device_id"]
        if device_id:
            sub = _subscription_service.ensure(f"device:{device_id}")
            balance = float(sub.get("balance") or 0.0)
            gift = float(sub.get("gift_balance") or 0.0)
        else:
            balance = 0.0
            gift = 0.0
        est = int(balance / 0.0185) if balance > 0 else 0  # 按默认 V4-Flash 单次售价（~¥0.0185）估算
        return {
            "balance": round(balance, 4),
            "gift_balance": round(gift, 4),
            "paid_balance": 0.0,
            "trial_credit": settings.TRIAL_CREDIT_YUAN,
            "est_chats": max(0, est),
            "min_recharge": settings.MIN_RECHARGE_YUAN,
            "recharge_tiers": settings.RECHARGE_TIERS,
            "coupons": _subscription_service.pending_coupons(f"device:{device_id}") if device_id else [],
            "anonymous": True,
            "free_remaining": _subscription_service.free_events_remaining(f"device:{device_id}") if device_id else settings.DAILY_FREE_EVENTS,
            "daily_free_events": settings.DAILY_FREE_EVENTS,
            "payment_enabled": settings.PAYMENT_ENABLED,
        }
    subject = f"user:{identity['user_id']}"
    return _subscription_service.get_balance(subject)


@router.get("/referral-code")
async def get_referral_code(user: Dict = Depends(get_current_user)):
    """我的邀请码 + 已邀请人数（仅登录可见）。

    邀请人每成功邀请 1 人得 ¥2 首充券（充值才兑现，2026-08-25 定价改造）；奖励在受邀人带本码注册时由 /auth/register 自动发放。
    """
    code = _auth_service.get_referral_code(user["id"])
    invitees = _subscription_service.count_invitees(f"user:{user['id']}")
    return {
        "referral_code": code,
        "invitees": invitees,
        "reward_yuan": settings.INVITE_REWARD_YUAN,
    }


@router.get("/events")
async def list_events(identity: Dict = Depends(get_identity), limit: int = 50, offset: int = 0):
    """我的消耗明细（硅基流动风格透明计费）：当前主体的计费流水（模型 / 输入·输出 token / 花费 / 是否免费 / 时间）。

    分页：limit 默认 50，offset 默认 0。内部核算事件(internal=1，如卡片 LLM) 默认不返回，仅本人可见的
    用户事件；如需看全量（含内部）可加 ?include_internal=1（仍仅本人）。
    """
    subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}" if identity["device_id"] else None
    if not subject:
        return {"items": [], "total": 0, "limit": limit, "offset": offset}
    data = _subscription_service.get_events(subject, limit=limit, offset=offset)
    summary = _subscription_service.get_usage_summary(subject)
    return {**data, "summary": summary}


@router.get("/admin/report")
async def ops_report(admin: dict = Depends(require_admin)):
    """运营报表（仅管理员）：总收入 / 用户总消耗 / 平台总成本 / 毛利 / 活跃用户 / ARPU / 按模型·事件拆分。"""
    return _subscription_service.get_ops_report()


@router.get("/admin/accounts")
async def admin_accounts(min_events: int = 0, admin: dict = Depends(require_admin)):
    """账户调用报表（仅管理员）：按计费主体 x 模型拆分调用次数，用户/设备分开列出。

    用于识别恶意/异常多次调用：min_events 可过滤最低调用次数（只显示高频主体），
    每行附 free/paid 拆分、token、费用、是否已封禁、对应账号/昵称（user 主体 join users 表）。
    """
    try:
        return _subscription_service.get_admin_accounts_report(min_events=min_events)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.get("/admin/banned")
async def admin_banned(admin: dict = Depends(require_admin)):
    """生效中的黑名单（仅管理员）：供前端展示 / 解封操作。"""
    return {"items": _subscription_service.list_banned()}


@router.post("/admin/ban")
async def admin_ban(body: BanRequest, admin: dict = Depends(require_admin)):
    """拉黑计费主体（仅管理员）：写入 banned_subjects，此后该主体所有计费闸门返回 429/403。

    用于拦截恶意多次调用（超高频 / 单模型刷量 / 薅免费额度）。解封走 POST /billing/admin/unban。
    """
    subject = body.subject.strip()
    if not (subject.startswith("user:") or subject.startswith("device:")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="subject 需以 device: 或 user: 开头（如 device:<备注码> 或 user:<id>）",
        )
    newly = _subscription_service.ban_subject(subject, body.reason, created_by=f"user:{admin['id']}")
    return {"subject": subject, "reason": body.reason, "newly_banned": newly, "banned": True}


@router.post("/admin/unban")
async def admin_unban(body: BanRequest, admin: dict = Depends(require_admin)):
    """解封计费主体（仅管理员）：active=0 保留审计记录。"""
    subject = body.subject.strip()
    if not (subject.startswith("user:") or subject.startswith("device:")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="subject 需以 device: 或 user: 开头（如 device:<备注码> 或 user:<id>）",
        )
    updated = _subscription_service.unban_subject(subject, created_by=f"user:{admin['id']}")
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="该主体不存在于封禁记录")
    return {"subject": subject, "updated": True, "banned": False}


@router.post("/recharge")
async def recharge(body: RechargeRequest, identity: Dict = Depends(get_identity)):
    """充值入账（MVP 直接到账；真实支付由异步回调触发本接口）。

    ⚠️ 2026-08-28 工程审查 P0-1 修复：本接口无订单/无回调/无验签，任意登录用户可零成本无限刷余额。
    生产环境（ALLOW_DIRECT_RECHARGE=False，默认）一律拒绝，统一走 /billing/pay/orders →
    支付宝异步回调验签 → auto_credit_alipay 入账。仅本地 DEBUG 调试可临时打开开关。
    """
    if not settings.ALLOW_DIRECT_RECHARGE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="直充通道已关闭：请通过「支付下单」完成充值（POST /billing/pay/orders），付款到账后自动入账",
        )
    if not identity["user_id"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="请先登录后再充值（匿名访客暂不支持充值）",
        )
    subject = f"user:{identity['user_id']}"
    try:
        return _subscription_service.recharge(subject, body.amount)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/pay/orders")
async def create_pay_order(body: RechargeOrderRequest, identity: Dict = Depends(get_identity)):
    """创建「充值加余额」支付订单。

    channel=wap（默认）：手机网站支付 H5，返回收银台跳转链接 pay_url，前端点击跳转付款；
    channel=face：当面付扫码，返回二维码串 qr，前端渲染扫码。
    仅登录用户可下单；匿名禁止。支付宝异步回调 /billing/pay/alipay-notify 验签通过后自动加余额。
    """
    if not identity["user_id"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="请先登录后再充值（匿名访客暂不支持）")
    subject = f"user:{identity['user_id']}"
    try:
        return _subscription_service.create_recharge_order(subject, body.amount, channel=body.channel)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.get("/pay/orders/{out_trade_no}")
async def get_pay_order(out_trade_no: str, subject: str = Depends(get_quota_subject)):
    """查询充值订单状态（前端轮询：pending → paid）。仅订单所属主体可查。"""
    order = _subscription_service.get_order(out_trade_no)
    if not order:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="订单不存在")
    if order["subject"] != subject:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权查看该订单")
    return {"out_trade_no": order["out_trade_no"], "status": order["status"], "amount": order["amount"], "plan": order["plan"]}


@router.post("/pay/alipay-notify")
async def alipay_notify(request: Request):
    """支付宝异步回调：验签 → 自动加余额。

    支付宝以 application/x-www-form-urlencoded POST 回调，表单字段为通知键值（含 sign/sign_type）。
    验签成功且入账成功返回 "success"（否则支付宝重试）。必须返回纯文本 "success"，不能带 JSON。
    """
    try:
        form = await request.form()
        data = {k: v for k, v in form.items()}
        provider = get_payment_provider()
        out_trade_no = provider.verify_callback(data)  # 验签，验签失败抛异常
        if not out_trade_no:
            raise ValueError("回调缺少 out_trade_no")
        notify_status = data.get("trade_status", "")
        # 仅交易成功/完成才入账；其他状态（待支付/已关闭等）不处理
        if notify_status in ("TRADE_SUCCESS", "TRADE_FINISHED"):
            _subscription_service.auto_credit_alipay(out_trade_no)
        return "success"
    except Exception as error:
        print(f"[ALIPAY-NOTIFY] 处理失败: {error}")
        return "fail"


@router.post("/cancel")
async def cancel_subscription(subject: str = Depends(get_quota_subject)):
    """取消订阅：立即回退 free（MVP 不做退款）。"""
    return _subscription_service.cancel(subject)


@router.post("/admin/grant")
async def admin_grant(body: GrantRequest, admin: dict = Depends(require_admin)):
    """运营手动开通（经营码收款后人工核销）：仅管理员可调用。

    早期真收钱走经营码（静态码，无 API/回调），由运营在后台核对收款后调用本接口开通会员。
    subject 不传则对当前管理员自身开通（便于自测）；传入则对指定主体开通。
    subject 须为完整计费主体（device:<备注码> / user:<id>），不要再带前缀——此前误写成
    `user:{subject}` 会把 `device:xxx` 拼成 `user:device:xxx`，导致客户拿不到会员。
    """
    if body.subject:
        if not (body.subject.startswith("device:") or body.subject.startswith("user:")):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="subject 需以 device: 或 user: 开头（如 device:<备注码> 或 user:<id>）",
            )
        target = body.subject
    else:
        target = f"user:{admin['id']}"
    try:
        return _subscription_service.grant_manual(target, body.plan)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/proof")
async def submit_proof(body: ProofRequest, subject: str = Depends(get_quota_subject)):
    """客户扫码付款后上传支付凭证（经营码静态码无回调，靠此关联身份）。

    subject 由后端从请求头自动取（user:/device:），不依赖客户填写，杜绝冒领；管理员核销时直接开通对应主体。
    """
    try:
        return _subscription_service.submit_proof(subject, body.plan, body.amount, body.proof_ref)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.get("/admin/proofs")
async def list_proofs(status: Optional[str] = None, admin: dict = Depends(require_admin)):
    """管理员看待开通凭证列表（pending 待核销；可按 status 过滤）。"""
    return {"items": _subscription_service.list_proofs(status)}


@router.post("/admin/proofs/{proof_id}/approve")
async def approve_proof(proof_id: str, admin: dict = Depends(require_admin)):
    """管理员核销：内部复用 grant_manual 开通会员，凭证置 approved。客户无需再联系运营。"""
    try:
        return _subscription_service.approve_proof(proof_id, admin["id"])
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/admin/proofs/{proof_id}/reject")
async def reject_proof(proof_id: str, admin: dict = Depends(require_admin)):
    """管理员驳回：凭证置 rejected（不开通会员）。"""
    try:
        return _subscription_service.reject_proof(proof_id, admin["id"])
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/upgrade")
async def upgrade(subject: str = Depends(get_quota_subject)):
    """兼容别名：沙箱「一键下单 + 模拟支付」即时升级。公测期已关闭模拟开通，改走真实经营码 + 凭证核销。

    真实支付环境请走 /billing/orders 下单流程（SANDBOX_AUTO_GRANT=False 时本接口直接 501）。
    """
    if not settings.SANDBOX_AUTO_GRANT:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="模拟支付已关闭，请扫码经营码付款后上传凭证核销开通",
        )
    order = _subscription_service.create_order(subject, "monthly")
    return _subscription_service.settle_order(order["out_trade_no"])


@router.post("/mode")
async def set_mode(body: ModeRequest, subject: str = Depends(get_quota_subject)):
    """切换链接归因模式：select(B 参考) / distribute(C pid, Phase 2 才生效)。"""
    try:
        return _subscription_service.set_mode(subject, body.mode)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.post("/usage/consume")
async def consume_usage(
    body: ConsumeRequest,
    identity: Dict = Depends(get_identity),
    _: None = Depends(require_membership),
):
    """内部计费：deep_report(¥2) / test_plan(¥5) 写账本；免费层已被 require_membership 挡下（未登录→401）。"""
    if body.event == "deep_report":
        amount = settings.PER_DEEP_REPORT
    elif body.event == "test_plan":
        amount = settings.PER_TEST_PLAN
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="未知计费事件")
    return _subscription_service.consume(f"user:{identity['user_id']}", body.event, amount)
