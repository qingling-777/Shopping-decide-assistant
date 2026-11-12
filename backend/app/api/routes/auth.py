from typing import Dict, List
from collections import defaultdict
import time

from fastapi import APIRouter, Depends, HTTPException, status, Request

from app.deps import get_current_user
from app.schemas.auth import AuthResponse, RegisterRequest, AuthCredentials, UserResponse, ForgotPasswordRequest, ResetPasswordRequest, UpdateProfileRequest, SendVerifyCodeRequest, VerifyEmailRequest, CaptchaVerifyRequest
from app.services.auth_service import _auth_service
from app.services.captcha_service import _captcha_service
from app.services.subscription_service import _subscription_service

router = APIRouter(prefix="/auth", tags=["auth"])

# ── 登录防爆破（2026-08-28 工程审查 P1 修复）────────────────────────
# 此前登录无任何限流/失败锁定，配合弱密钥可被脚本暴力破解。轻量内存实现：
#   - IP 频率：每分钟 ≤10 次登录尝试
#   - 失败锁定：同一 账号+IP 连续失败 ≥5 次 → 锁 15 分钟；同一 IP 累计失败 ≥20 次 → 锁 15 分钟
# ⚠️ 进程内存实现，多 worker 下不共享（尽力而为）；生产建议升级 Redis/共享存储。
_LOGIN_RATE: Dict[str, List[float]] = defaultdict(list)   # ip → 请求时间戳
_LOGIN_FAILS: Dict[str, List[float]] = defaultdict(list)  # f"{ip}|{account}" → 失败时间戳
_LOGIN_FAIL_IP: Dict[str, List[float]] = defaultdict(list)  # ip → 失败时间戳
_LOGIN_RATE_WINDOW = 60.0
_LOGIN_RATE_LIMIT = 10
_LOGIN_LOCK_SECONDS = 15 * 60.0
_LOGIN_MAX_FAILS = 5
_LOGIN_IP_MAX_FAILS = 20


def _prune(d: Dict[str, List[float]], key: str, window: float) -> List[float]:
    now = time.time()
    kept = [t for t in d.get(key, []) if now - t < window]
    d[key] = kept
    return kept


def _check_login_throttle(ip: str, account: str) -> None:
    # IP 频率限制
    if len(_prune(_LOGIN_RATE, ip, _LOGIN_RATE_WINDOW)) >= _LOGIN_RATE_LIMIT:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="尝试过于频繁，请稍后再试")
    _LOGIN_RATE[ip].append(time.time())
    # 账号+IP 维度失败锁定
    key = f"{ip}|{account.strip().lower()}"
    if len(_prune(_LOGIN_FAILS, key, _LOGIN_LOCK_SECONDS)) >= _LOGIN_MAX_FAILS:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="失败次数过多，账号已临时锁定，请 15 分钟后再试")
    # IP 维度失败锁定
    if len(_prune(_LOGIN_FAIL_IP, ip, _LOGIN_LOCK_SECONDS)) >= _LOGIN_IP_MAX_FAILS:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="尝试过于频繁，IP 已临时锁定，请 15 分钟后再试")


def _record_login_fail(ip: str, account: str) -> None:
    key = f"{ip}|{account.strip().lower()}"
    _LOGIN_FAILS[key].append(time.time())
    _LOGIN_FAIL_IP[ip].append(time.time())


def _client_ip(request: Request) -> str:
    """取客户端 IP（优先 X-Forwarded-For，否则直连地址）。"""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


def _require_captcha(ticket: str | None, randstr: str | None, request: Request):
    """开启图形验证时校验票据；未开启（演示模式）直接放行。校验失败抛 400。"""
    if not _captcha_service.enabled:
        return
    if not ticket or not randstr:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="请先完成人机验证")
    result = _captcha_service.verify_ticket(ticket, randstr, _client_ip(request))
    if not result["ok"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=result["message"])


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest, req: Request):
    # 图形验证码（防机器人）：开启时先校验票据
    _require_captcha(request.captcha_ticket, request.captcha_randstr, req)
    try:
        user = _auth_service.create_user(request.account, request.password, request.nickname)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    # 邀请奖励：被邀请人带有效邀请码注册 → 邀请人 +¥5（赠送，先花）；每人仅计一次（防刷）
    if request.invite_code:
        referrer = _auth_service.get_user_by_referral_code(request.invite_code)
        if referrer and referrer["id"] != user["id"]:
            try:
                _subscription_service.apply_invite(user["id"], referrer["id"], request.invite_code.strip().upper())
            except Exception as error:
                print(f"[INVITE] 奖励发放失败(不影响注册): {error}")
    # 邮箱账号不再因注册自动发验证码（改为注册即登入）；邮箱验证码仅用于后续「个人认证」，由 `/send-verify-code` + `/verify-email` 单独触发。
    return AuthResponse(access_token=_auth_service.create_token(user), user=user)


@router.post("/captcha-verify")
async def captcha_verify(request: CaptchaVerifyRequest, req: Request):
    """单独校验图形验证码票据（前端过验证后调用，用于注册前预校验或拿到校验状态）。"""
    if not _captcha_service.enabled:
        return {"status": "ok", "message": "演示模式（未启用图形验证码）", "ok": True}
    result = _captcha_service.verify_ticket(request.ticket, request.randstr, _client_ip(req))
    if not result["ok"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=result["message"])
    return {"status": "ok", "message": result["message"], "ok": True, "code": result["code"]}


@router.post("/login", response_model=AuthResponse)
async def login(request: AuthCredentials, req: Request):
    """登录。2026-08-28 工程审查 P1 修复：加 IP 频率限制 + 失败锁定（5 次/15 分钟）。"""
    ip = _client_ip(req)
    _check_login_throttle(ip, request.account)
    user = _auth_service.authenticate(request.account, request.password)
    if not user:
        _record_login_fail(ip, request.account)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号或密码错误")
    return AuthResponse(access_token=_auth_service.create_token(user), user=user)


@router.post("/forgot-password")
async def forgot_password(request: ForgotPasswordRequest):
    """申请密码找回：生成并投递验证码（无论账号是否存在都返回 ok，防枚举）。"""
    _auth_service.request_password_reset(request.account)
    return {"status": "ok", "message": "若该账号已注册，重置验证码已发送（演示环境请查看服务端日志获取验证码）"}


@router.post("/reset-password", response_model=AuthResponse)
async def reset_password(request: ResetPasswordRequest):
    """用验证码重置密码；成功直接返回新 token 实现自动登录。"""
    user = _auth_service.reset_password(request.account, request.code, request.new_password)
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="验证码无效或已过期，请重新获取")
    return AuthResponse(access_token=_auth_service.create_token(user), user=user)


@router.post("/send-verify-code")
async def send_verify_code(request: SendVerifyCodeRequest):
    """发送邮箱验证码（注册后真实性验证）。60 秒冷却防轰炸。"""
    result = _auth_service.request_email_verify_code(request.account)
    if result == "not_email":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="手机号账号无需邮箱验证")
    if result.startswith("cooldown:"):
        retry_after = int(result.split(":", 1)[1])
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=f"发送过于频繁，请 {retry_after} 秒后再试")
    # 无论账号是否存在都返回 ok（防枚举）
    return {"status": "ok", "message": "若该邮箱已注册，验证码已发送（演示环境请查看服务端日志获取验证码）"}


@router.post("/verify-email", response_model=UserResponse)
async def verify_email(request: VerifyEmailRequest):
    """校验邮箱验证码 → 标记邮箱已验证。成功返回更新后的用户。"""
    ok = _auth_service.verify_email(request.account, request.code)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="验证码无效或已过期，请重新获取")
    user = _auth_service.get_user_by_account(request.account)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    return user


@router.get("/me", response_model=UserResponse)
async def me(user=Depends(get_current_user)):
    return user


@router.patch("/me", response_model=UserResponse)
async def update_me(request: UpdateProfileRequest, user=Depends(get_current_user)):
    """更新个人资料（设置页）：昵称 / 密码 / 邮箱实名。改密码、改账号、绑定邮箱需 current_password 校验。"""
    try:
        updated = _auth_service.update_user(
            user["id"],
            nickname=request.nickname,
            current_password=request.current_password,
            new_password=request.new_password,
            new_account=request.new_account,
            email=request.email,
            email_clear=request.email_clear,
        )
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    return updated


@router.post("/logout")
async def logout(user=Depends(get_current_user)):
    return {"status": "ok", "message": "已退出登录"}
