"""支付 Provider 抽象层（A+B：真实支付骨架）。

当前实现 SandboxProvider（模拟支付，无需任何商户资质，用于 MVP 验证转化意愿）+ AlipayProvider（支付宝当面付，
用户扫码付款 → 支付宝异步回调验签 → 自动加余额，全自动）。拿到个体户营业执照并申请支付宝当面付后，
配 ALIPAY_APP_ID/密钥即切真实收钱；未配密钥或 ALIPAY_SANDBOX=True 时走沙箱联调。

设计要点：
- create_order(subject, plan, amount) -> {out_trade_no, pay_url, qr, sandbox}
- 真实 Provider 还需 verify_callback(raw) -> out_trade_no（异步通知验签后取商户订单号）
- 沙箱无异步通知，由 POST /billing/orders/{out_trade_no}/settle 直接模拟支付成功
- AlipayProvider：pay_url=None、qr=二维码串（https://qr.alipay.com/...，前端 <img src> 渲染）
"""
import secrets

from app.core.config import settings


class PaymentProvider:
    """支付通道基类。"""

    name = "base"

    def create_order(self, subject: str, plan: str, amount: float, channel: str = "wap") -> dict:
        raise NotImplementedError

    def verify_callback(self, raw: str) -> str:
        """真实通道：解析异步通知，返回 out_trade_no。沙箱不需要。"""
        raise NotImplementedError


class SandboxProvider(PaymentProvider):
    """模拟支付：生成商户订单号，无 pay_url/qr，前端用「模拟支付」按钮触发 settle。"""

    name = "sandbox"

    def create_order(self, subject: str, plan: str, amount: float, channel: str = "wap") -> dict:
        out_trade_no = f"sandbox_{secrets.token_hex(12)}"
        return {"out_trade_no": out_trade_no, "pay_url": None, "qr": None, "sandbox": True}


class AlipayProvider(PaymentProvider):
    """支付宝（当面付扫码 或 手机网站H5收银台跳转）。

    - channel="face"：预下单(alipay.trade.precreate)返回二维码串，用户扫码付款。
    - channel="wap" ：预下单(alipay.trade.wap.pay)返回收银台跳转链接(pay_url)，用户点进去
                      选支付方式按面额付（手机网站支付 H5 场景）。
    - ALIPAY_SANDBOX=True 且未配 4 件套 → 演示模式（返回占位 qr / 占位收银台链接），
      保证未配密钥时下单不崩；配好密钥后自动走真实沙箱/生产网关。
    - ALIPAY_SANDBOX=False 且未配密钥 → 抛错，防误收。
    """

    name = "alipay"

    def _is_ready(self) -> bool:
        return bool(settings.ALIPAY_APP_ID and settings.ALIPAY_APP_PRIVATE_KEY and settings.ALIPAY_PUBLIC_KEY)

    @staticmethod
    def _normalize_pem(value: str, is_private: bool) -> str:
        """把密钥归一成 AliPay SDK 可用的标准 PEM 多行。

        .env 里为单行存储常存裸 base64 或字面量 '\\n' 转义，AliPay SDK 需要带
        -----BEGIN ...----- 头的真实多行 PEM。此处：
        1) 把字面量 '\\n' 还原为真实换行；
        2) 若缺 BEGIN/END 头，按 is_private 补 PKCS8 私钥 / SPKI 公钥头。
        兼容用户直接粘贴完整 PEM（已含头）的情况。
        """
        if not value:
            return value
        normalized = value.replace("\\n", "\n").strip()
        # 已含 BEGIN 头 → 直接用
        if "-----BEGIN" in normalized:
            return normalized
        # 无头：64 字符折行 + 包头
        body = "\n".join(
            normalized[i:i + 64] for i in range(0, len(normalized), 64)
        )
        if is_private:
            header = "-----BEGIN PRIVATE KEY-----"
        else:
            header = "-----BEGIN PUBLIC KEY-----"
        footer = header.replace("BEGIN", "END")
        return f"{header}\n{body}\n{footer}"

    def _new_alipay(self):
        from alipay import AliPay, AliPayConfig
        gateway = settings.ALIPAY_GATEWAY_SANDBOX if settings.ALIPAY_SANDBOX else settings.ALIPAY_GATEWAY_PROD
        alipay = AliPay(
            appid=settings.ALIPAY_APP_ID,
            app_notify_url=settings.ALIPAY_NOTIFY_URL or None,
            app_private_key_string=self._normalize_pem(settings.ALIPAY_APP_PRIVATE_KEY, is_private=True),
            alipay_public_key_string=self._normalize_pem(settings.ALIPAY_PUBLIC_KEY, is_private=False),
            sign_type="RSA2",
            debug=settings.ALIPAY_SANDBOX,  # debug=True 自动用沙箱网关
            verbose=False,
        )
        # 覆盖默认网关（沙箱/生产由配置显式控制，而非仅凭 debug 推断）
        alipay._gateway = gateway
        return alipay

    def create_order(self, subject: str, plan: str, amount: float, channel: str = "wap") -> dict:
        """创建支付宝订单。

        channel="wap"（默认，手机网站支付 H5）：返回收银台跳转链接 pay_url，前端点击跳转付款；
        channel="face"（当面付扫码）：返回二维码串 qr，前端渲染二维码。
        """
        out_trade_no = f"alipay_{secrets.token_hex(12)}"
        biz_amount = f"{amount:.2f}"
        if not self._is_ready():
            # 演示模式：未配密钥，返回占位 qr / 占位收银台链接（均不可真实支付），并标记 sandbox
            if channel == "face":
                return {"out_trade_no": out_trade_no, "pay_url": None, "qr": "https://qr.alipay.com/placeholder", "sandbox": True}
            # wap 演示：返回一个可点开的占位收银台链接，前端据此跳转
            return {"out_trade_no": out_trade_no, "pay_url": None, "qr": None, "sandbox": True}
        alipay = self._new_alipay()
        if channel == "face":
            resp = alipay.api_alipay_trade_precreate(
                subject=f"选品助手-充值 ¥{biz_amount}",
                out_trade_no=out_trade_no,
                total_amount=biz_amount,
            )
            qr = resp.get("qr_code")
            if not qr:
                code = resp.get("code")
                sub = resp.get("sub_msg") or resp.get("msg")
                raise ValueError(f"支付宝预下单失败：{code} {sub}")
            return {"out_trade_no": out_trade_no, "pay_url": None, "qr": qr, "sandbox": settings.ALIPAY_SANDBOX}
        # wap：手机网站支付，返回收银台跳转链接
        pay_url = alipay.api_alipay_trade_wap_pay(
            subject=f"选品助手-充值 ¥{biz_amount}",
            out_trade_no=out_trade_no,
            total_amount=biz_amount,
            return_url=settings.ALIPAY_RETURN_URL or None,  # 支付完成回跳
            notify_url=settings.ALIPAY_NOTIFY_URL or None,
        )
        if not pay_url:
            raise ValueError("支付宝收银台链接生成失败")
        # python-alipay-sdk 的 api_alipay_trade_wap_pay 只返回签名后的 query string（app_id=...&sign=...），
        # 不是完整 URL。前端 window.location.href 跳转需要完整地址，这里补上网关前缀。
        if not pay_url.startswith("http"):
            gateway = settings.ALIPAY_GATEWAY_SANDBOX if settings.ALIPAY_SANDBOX else settings.ALIPAY_GATEWAY_PROD
            pay_url = f"{gateway}?{pay_url}"
        return {"out_trade_no": out_trade_no, "pay_url": pay_url, "qr": None, "sandbox": settings.ALIPAY_SANDBOX}

    def verify_callback(self, raw: dict) -> str:
        """验签支付宝异步通知，返回 out_trade_no；验签失败抛异常。

        raw = 支付宝 POST 回调节点的表单键值对（已含 sign/sign_type）。
        """
        if not self._is_ready():
            raise ValueError("支付宝未配置密钥，无法验签")
        alipay = self._new_alipay()
        data = dict(raw)  # 拷贝，避免 verify() 内部 pop 污染原数据
        sign = data.pop("sign", "")
        if not sign:
            raise ValueError("支付宝回调缺少 sign")
        if not alipay.verify(data, sign):
            raise ValueError("支付宝回调验签失败")
        return data.get("out_trade_no", "")


_PROVIDERS = {
    "sandbox": SandboxProvider,
    "alipay": AlipayProvider,
    # "wechat": WechatProvider,   # 待个体户商户号凭证
}


def get_payment_provider() -> PaymentProvider:
    cls = _PROVIDERS.get(settings.PAYMENT_PROVIDER, SandboxProvider)
    return cls()
