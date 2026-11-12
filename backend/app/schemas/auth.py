from typing import Optional

from pydantic import BaseModel, Field, field_validator


class AuthCredentials(BaseModel):
    account: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("account")
    @classmethod
    def validate_account(cls, value: str) -> str:
        value = value.strip()
        if "@" not in value and not value.isdigit():
            raise ValueError("请输入有效的邮箱或手机号")
        return value


class RegisterRequest(AuthCredentials):
    nickname: Optional[str] = Field(default=None, max_length=50)
    invite_code: Optional[str] = Field(default=None, max_length=32, description="邀请码：带有效邀请码注册，邀请人得 ¥5 赠送")
    captcha_ticket: Optional[str] = Field(default=None, max_length=512, description="腾讯云验证码票据 ticket（开启图形验证时必填）")
    captcha_randstr: Optional[str] = Field(default=None, max_length=64, description="腾讯云验证码随机串 randstr")


class ForgotPasswordRequest(BaseModel):
    account: str = Field(min_length=3, max_length=255)


class ResetPasswordRequest(BaseModel):
    account: str = Field(min_length=3, max_length=255)
    code: str = Field(min_length=4, max_length=32)
    new_password: str = Field(min_length=8, max_length=128)


class UserResponse(BaseModel):
    id: str
    account: str
    nickname: Optional[str] = None
    is_admin: bool = False
    email_verified: bool = False
    email: Optional[str] = None  # 邮箱实名（独立绑定于账号，用于找回密码）
    created_at: str
    referral_code: Optional[str] = None  # 我的邀请码（用于「邀请得 ¥5」展示）


class SendVerifyCodeRequest(BaseModel):
    account: str = Field(min_length=3, max_length=255)


class CaptchaVerifyRequest(BaseModel):
    """腾讯云验证码票据校验请求（前端过图形验证后提交 ticket+randstr）。"""
    ticket: str = Field(min_length=1, max_length=512)
    randstr: str = Field(min_length=1, max_length=64)


class VerifyEmailRequest(BaseModel):
    account: str = Field(min_length=3, max_length=255)
    code: str = Field(min_length=4, max_length=32)


class UpdateProfileRequest(BaseModel):
    """个人资料更新（设置页）。各字段均可选，只改传了的：
    - nickname：改昵称/显示名（可清空为 null）。可与 new_password 一起传（昵称+密码一次改）。
    - 改密码：必须同时传 current_password + new_password（new_password 走最小长度校验）。
    - 改账号(邮箱/手机号)：必须传 current_password，且 new_account 走与注册相同的格式/唯一校验。
    - email：绑定邮箱实名（找回密码用），必须传 current_password，且邮箱唯一；email_clear=true 解绑。
    """
    nickname: Optional[str] = Field(default=None, max_length=50)
    current_password: Optional[str] = None
    new_password: Optional[str] = Field(default=None, min_length=8, max_length=128)
    new_account: Optional[str] = Field(default=None, max_length=255)
    email: Optional[str] = Field(default=None, max_length=255)
    email_clear: bool = False


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
