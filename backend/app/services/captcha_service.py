"""腾讯云验证码（Captcha）服务器端票据校验。

接入文档：https://cloud.tencent.com/document/product/1110/75489
票据校验接口：https://cloud.tencent.com/document/product/1110/36926

前端用 TencentCaptcha 拿到 ticket + randstr 后，后端需二次核查票据结果
（未接入票据校验会被黑产轻易伪造，失去人机对抗效果）。

校验接口走腾讯云官方 SDK 的 DescribeCaptchaResult（TC3 签名由 SDK 内部处理），
避免手写签名出错。依赖：tencentcloud-sdk-python（已加入 requirements.txt）。
"""

from typing import Dict

from app.core.config import settings

# 常见业务返回码（见接入文档输出参数 CaptchaCode）
CAPTCHA_OK = 1                 # 验证通过
CAPTCHA_TICKET_REUSED = 9      # ticket 被重复使用
CAPTCHA_TICKET_EXPIRED = 8     # ticket 已过期（5 分钟有效）


class CaptchaService:
    """简单封装：verify_ticket(ticket, randstr, user_ip) -> Dict。"""

    @property
    def enabled(self) -> bool:
        """CAPTCHA_PROVIDER=tencent 且四个密钥都配置了才真正校验；否则为演示模式直接放行。"""
        return bool(
            settings.CAPTCHA_PROVIDER == "tencent"
            and settings.CAPTCHA_APP_ID
            and settings.CAPTCHA_SECRET_KEY
            and settings.TENCENT_SECRET_ID
            and settings.TENCENT_SECRET_KEY
        )

    def verify_ticket(self, ticket: str, randstr: str, user_ip: str) -> Dict:
        """校验一张票据，返回结构化结果：

        {
          "ok": bool,           # 是否放行（验证通过、或演示模式下固定 True）
          "code": int,          # 腾讯云业务码（无密钥/未启用时为 1，视同通过）
          "message": str,       # 人类可读说明
          "mode": str,          # "tencent" 或 "demo"
        }
        """
        if not self.enabled:
            # 演示模式：未配置密钥不拦截，避免 demo 账号被卡死
            return {"ok": True, "code": CAPTCHA_OK, "message": "演示模式（未配置腾讯云验证码）", "mode": "demo"}

        # 联调/测试（DEBUG=True）：接受 trtest_ 前缀的测试票据，方便无真实弹窗环境跑 e2e。
        # 生产 DEBUG=False 一律拒绝，保证人机对抗不被打穿。
        if settings.DEBUG and ticket and ticket.startswith("trtest_"):
            return {"ok": True, "code": CAPTCHA_OK, "message": "测试票据（DEBUG 演示）", "mode": "demo"}

        # 惰性 import：仅当启用时才引入 SDK，避免未安装 SDK 时服务无法启动
        from tencentcloud.common import credential
        from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
        from tencentcloud.common.profile.client_profile import ClientProfile
        from tencentcloud.common.profile.http_profile import HttpProfile
        from tencentcloud.captcha.v20190722 import captcha_client, models

        try:
            cred = credential.Credential(settings.TENCENT_SECRET_ID, settings.TENCENT_SECRET_KEY)
            http_profile = HttpProfile(endpoint="captcha.tencentcloudapi.com", reqTimeout=15)
            client = captcha_client.CaptchaClient(
                cred, settings.TENCENT_REGION, ClientProfile(httpProfile=http_profile)
            )
            request = models.DescribeCaptchaResultRequest()
            request.CaptchaAppId = settings.CAPTCHA_APP_ID
            request.CaptchaType = 9
            request.Ticket = ticket
            request.Randstr = randstr
            request.UserIp = user_ip or "127.0.0.1"
            request.AppSecretKey = settings.CAPTCHA_SECRET_KEY
            response = client.DescribeCaptchaResult(request)
        except TencentCloudSDKException as error:
            # 鉴权/网络等调用失败：不放行，避免黑产钻空子；给出明确错误便于排查
            return {"ok": False, "code": -1, "message": f"验证码校验调用失败: {error.get_code()} {error.get_message()}", "mode": "tencent"}
        except Exception as error:
            return {"ok": False, "code": -1, "message": f"验证码校验异常: {error}", "mode": "tencent"}

        code = int(response.CaptchaCode)
        msg = response.CaptchaMsg or ""
        if code == CAPTCHA_OK:
            return {"ok": True, "code": code, "message": "验证通过", "mode": "tencent"}
        # 容灾票据（trerror_ 前缀 / code=21）：网络差导致的自动容灾，业务侧可跳过
        if code == 21:
            return {"ok": True, "code": code, "message": "容灾票据（网络波动自动兜底）", "mode": "tencent"}
        return {"ok": False, "code": code, "message": msg or f"验证码校验失败(code={code})", "mode": "tencent"}


_captcha_service = CaptchaService()
