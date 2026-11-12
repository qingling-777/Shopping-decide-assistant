from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    APP_NAME: str = "购物决策助手"
    APP_VERSION: str = "0.1.0-mvp"
    DEBUG: bool = True
    
    API_PREFIX: str = "/api/v1"
    BACKEND_CORS_ORIGINS: List[str] = ["*"]  # MVP阶段允许所有来源
    
    # 硅基流动 AI API
    SILICONFLOW_API_KEY: str = "sk-your-key-here"
    SILICONFLOW_BASE_URL: str = "https://api.siliconflow.cn/v1"
    SILICONFLOW_MODEL: str = "deepseek-ai/DeepSeek-V4-Flash"
    # 多 key 轮换池（逗号/空格/换行分隔的多个 key）；与上面单个 SILICONFLOW_API_KEY 合并去重后随机轮换，缓解 429 限流
    SILICONFLOW_API_KEYS: str = ""
    
    # 深度思考模型（原生 reasoning_content：真实思维链流进思考面板，无需 prompt hack）
    REASONING_MODEL: str = "deepseek-ai/DeepSeek-R1"
    ENABLE_REASONING: bool = True
    REASONING_BUDGET: int = 800  # 思维链最大 token 数，控制推理长度/延迟/成本
    
    # 联网搜索
    SERPER_API_KEY: str = "your-serper-api-key-here"
    ENABLE_SEARCH: bool = False
    # 合规限速：每次搜索之间的礼貌间隔（秒），避免瞬时并发打 API
    CRAWL_DELAY: float = 1.0
    # 合规刷新：本地缓存超过该时长（小时）才重新采集，避免每次请求都打 API
    CRAWL_MAX_AGE_HOURS: float = 6.0
    # Serper 时间过滤：qdr:m=近1月 / qdr:w=近1周，保证抓到的文章较新
    CRAWL_TIME_FILTER: str = "qdr:m"

    # —— 官方/聚合联盟商品数据（Layer ③，pluggable）——
    # 当前默认好单库（haodanku.com，免备案、当天出数据）；拿到京东联盟 key 后可切 jd_union
    UNION_PROVIDER: str = "haodanku"
    HAODANKU_API_KEY: str = ""  # 好单库 apikey，留空则商品级数据自动降级为空
    # 频道浏览接口（v3 域名）；关键词搜索接口是另一个端点（v2 域名，见下）
    HAODANKU_BASE_URL: str = "https://v3.api.haodanku.com"
    HAODANKU_NAV: int = 1       # 商品分站(nav)；如返回空/报错，按好单库文档调整此值
    # 关键词搜索接口（按关键词/类目查商品，美妆选品主力用这个）
    HAODANKU_KEYWORD_URL: str = "http://v2.api.haodanku.com/get_keyword_items"
    HAODANKU_CID: int = 4       # 商品类目：4=美妆（项目定位）；0=全部
    HAODANKU_PAGE_SIZE: int = 20
    # 联盟商品数据本地缓存时长（秒），避免同一问题反复打 API
    UNION_CACHE_TTL: int = 300
    # 爆品榜（大淘客榜单）缓存：TTL 30s 让关注者每次（隔 30s）都能拿到更新版；后台每 30 分钟预拉一帧兜底
    HOT_PICK_CACHE_TTL: int = 30
    HOT_PICK_PREFETCH_INTERVAL: int = 1800  # 30 分钟（按秒）
    # 双源门面：好单库优先 + 大淘客回落/互补。默认开；大淘客 key 齐备时通用对话/卡片同时吃两家数据，
    # 好单库某关键词无结果/异常时由大淘客补齐，提升覆盖与接口韧性。关闭则按 UNION_PROVIDER 单源。
    UNION_FALLBACK: bool = True

    # —— 大淘客（dataoke.com）联盟数据：单品诊断 + 关键词搜索（与好单库互补）——
    # 核心价值：好单库无淘宝 num_iid，贴链接无法做单品诊断；大淘客有 num_iid 单品详情接口，
    # 解决「贴淘宝/天猫链接→实时价/佣/销/店铺」的洞。两跳：parse-content(链接/口令→goodsId) + get_goods_detail_v2(goodsId→明细)。
    # 各接口 version 独立（大淘客按接口版本号鉴权），详见 app/services/dataoke_service.py 注释。
    DATAOKE_APP_KEY: str = ""      # 大淘客开放平台 appKey，在 backend/.env 中配置
    DATAOKE_APP_SECRET: str = ""   # 大淘客开放平台 appSecret，在 backend/.env 中配置
    DATAOKE_PARSE_VERSION: str = "v1.0.0"      # tb-service/parse-content 淘系万能解析
    # 单品详情：v1 端点 /api/goods/get-goods-details 经实测已授权（code=0），用 v1；
    # v2 端点 /open-api/goods/get_goods_detail_v2 返回「账号未授权或授权过期」，需后台单独授权，暂不用。
    DATAOKE_DETAIL_VERSION: str = "v1.2.3"     # api/goods/get-goods-details 单品详情（v1，免额外授权）
    DATAOKE_SEARCH_VERSION: str = "v2.1.2"     # api/goods/get-dtk-search-goods 大淘客搜索
    DATAOKE_CID: int = 3                        # 大淘客一级类目：3=美妆（与好单库 cid=4 对齐项目定位）
    # 富接口版本号（各自独立鉴权）
    DATAOKE_PRICE_TREND_VERSION: str = "v1.0.0"   # api/goods/price-trend 历史券后价（已授权）
    DATAOKE_SIMILAR_VERSION: str = "v1.0.0"       # api/goods/list-similer-goods-by-open 相似品（已授权）
    DATAOKE_RANKING_VERSION: str = "v1.3.0"       # api/goods/get-ranking-list 各大榜单（已授权）
    DATAOKE_PRIVILEGE_LINK_VERSION: str = "v1.3.1"  # api/tb-service/get-privilege-link 转链(变现)
    DATAOKE_PRIVILEGE_PID: str = ""  # 转链推广位 PID（淘宝联盟），填你自己的 mm_xxx_xxx_xxx
    DATAOKE_COMMENT_VERSION: str = "v1.0.0"       # api/comment/get-comment-list 商品评论(口碑)
    # 搜索相关 API（开放平台域 openapi.dataoke.com，与现有 key 通用、无需 pmc/无额外授权，实测 code=0）
    DATAOKE_TOP100_VERSION: str = "v1.0.1"          # api/category/get-top100 热搜记录(买家榜/淘客榜)
    DATAOKE_SUGGEST_VERSION: str = "v1.0.2"         # api/goods/search-suggestion 搜索联想词
    DATAOKE_FRIENDS_CIRCLE_VERSION: str = "v1.0.0"  # api/goods/friends-circle-list 朋友圈文案(现成 C 端文案)
    # 注：privilege-link / comment 受「淘宝账号授权」门控，当前账号授权过期 -> 接口返回业务错误码，
    #     代码中统一优雅降级为 None + 明确日志「需大淘客后台重授权淘宝账号」，授权恢复后自动生效。
    # 认证
    AUTH_SECRET_KEY: str = "change-this-secret-in-production"
    AUTH_TOKEN_EXPIRE_SECONDS: int = 7 * 24 * 60 * 60
    # 密码找回验证码有效期（秒）；演示环境默认 10 分钟
    AUTH_RESET_CODE_EXPIRE_SECONDS: int = 10 * 60

    # —— 安全开关：是否允许 POST /billing/recharge 无凭证直充（2026-08-28 工程审查 P0-1 修复）——
    # MVP 期间曾用「直接到账」通道；该接口无订单/无回调/无验签，任意登录用户可零成本无限刷余额。
    # 生产环境必须保持 False，统一走 /billing/pay/orders → 支付宝回调验签 → auto_credit_alipay 入账。
    ALLOW_DIRECT_RECHARGE: bool = False

    # —— 真实邮箱验证（账号含 @ 时触发；注册后发验证码，防假账号 / 提升真实性）——
    EMAIL_VERIFY_ENABLED: bool = True           # 开启注册后邮箱验证
    EMAIL_REQUIRE_VERIFY_TO_LOGIN: bool = False # 邮箱账号未验证是否禁止登录（默认否，防 demo 账号锁死；生产可开）
    EMAIL_VERIFY_CODE_EXPIRE_SECONDS: int = 10 * 60
    VERIFY_CODE_SEND_COOLDOWN_SECONDS: int = 60 # 同一账号两次发码最小间隔
    # SMTP 通道（QQ/163 用授权码，非登录密码；企业邮箱用邮箱密码）
    SMTP_HOST: str = ""
    SMTP_PORT: int = 465
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""    # 邮箱授权码
    SMTP_FROM: str = ""        # 发件人地址；留空则用 SMTP_USER
    SMTP_USE_SSL: bool = True
    # 是否允许把验证码明文打印到服务端日志（2026-08-28 工程审查 P1 修复）。
    # 仅当 DEBUG=True 且本开关显式开启才打印，供本地 e2e 抓码；生产（DEBUG=False）无论如何不打印。
    DEV_PRINT_CODES: bool = False
    # 是否校验 HTTPS 证书（2026-08-28 工程审查 P1 修复）。此前 ai_service/dataoke_service 全局
    # verify=False，AI 请求（含 API Key 与全部对话内容）可被中间人劫持。默认开启校验；
    # 仅当企业代理使用自签证书等特殊场景，才显式设置 SSL_VERIFY=false。
    SSL_VERIFY: bool = True

    # —— 无感验证码 / 防机器人（腾讯云验证码，需第三方 key；未配置则跳过 = 演示模式）——
    # 注册 / 发码时校验 captcha_token（内含 ticket + randstr）；配置后才强制，避免 demo 账号被无 key 卡死。
    CAPTCHA_PROVIDER: str = ""    # "tencent" / ""（关闭=演示模式）
    CAPTCHA_APP_ID: int = 0       # 腾讯云验证码 CaptchaAppId（前端弹窗 + 服务端校验共用）
    CAPTCHA_SECRET_KEY: str = ""  # 腾讯云验证码 AppSecretKey（服务端校验票据，勿泄露）
    # 腾讯云账号级密钥对（用于票据校验 DescribeCaptchaResult 的 TC3 签名）
    TENCENT_SECRET_ID: str = ""
    TENCENT_SECRET_KEY: str = ""
    TENCENT_REGION: str = ""   # 验证码接口无地域，留空即可

    # —— 支付宝当面付（用户扫码付款 → 异步回调验签 → 自动加余额；2026-08-26）——
    # ALIPAY_SANDBOX=True 走沙箱网关(openapi-sandbox.dl.alipaydev.com，无真实商户资质，仅联调)；
    # ALIPAY_SANDBOX=False 走生产网关(openapi.alipay.com，需真实 app_id/密钥，真正收钱)。
    ALIPAY_SANDBOX: bool = True
    ALIPAY_APP_ID: str = ""                 # 开放平台应用 app_id
    ALIPAY_APP_PRIVATE_KEY: str = ""        # 应用私钥（PKCS8，签名用）
    ALIPAY_PUBLIC_KEY: str = ""             # 支付宝公钥（验签回调用）
    ALIPAY_NOTIFY_URL: str = ""             # 异步通知回调地址（对外可达的 http(s) URL，需 ICP 备案域名）
    ALIPAY_RETURN_URL: str = ""             # 手机网站支付(H5)完成后的同步回跳地址（展示「支付成功」页）
    ALIPAY_GATEWAY_PROD: str = "https://openapi.alipay.com/gateway.do"          # 生产网关
    ALIPAY_GATEWAY_SANDBOX: str = "https://openapi-sandbox.dl.alipaydev.com/gateway.do"  # 沙箱网关

    # —— 订阅 / 配额 / 定价（低价渗透，详见 PAYWALL_DESIGN.md）——
    FREE_DAILY_CHAT_LIMIT: int = 10        # 免费层每日 AI 选品咨询上限（设备维度，登录/退出继承同一把计数器）
    CARD_DAILY_LIMIT: int = 10          # 免费登录用户每日「卡片次数」上限（每轮对话产出卡片即计 1 次，最多 3 张/轮）；会员与匿名均不走此配额（匿名不产卡片）
    EARLY_BIRD_MONTHLY: float = 9.9        # 内测月费
    EARLY_BIRD_YEARLY: float = 99.0        # 内测年费（前 N 名终身价）
    STD_MONTHLY_MIN: float = 39.0          # 锚定标准价下限（暂未启用）
    STD_MONTHLY_MAX: float = 99.0          # 锚定标准价上限（暂未启用）
    PER_DEEP_REPORT: float = 2.0           # 深度报告按次
    PER_TEST_PLAN: float = 5.0             # 测品计划按次
    EARLY_BIRD_QUOTA: int = 200            # 早鸟名额上限（稀缺感）

    # —— 支付 / 订阅生命周期（A+B：真实支付骨架 + 生命周期）——
    # 支付通道：sandbox（模拟，无需资质，MVP 验证转化）/ wechat / alipay / stripe（待商户资质）
    PAYMENT_PROVIDER: str = "sandbox"
    # 支付总开关（2026-08-28）：False 时全局停收（充值下单直接拒绝，前端隐藏充值入口），
    # 适用于「暂缓收费、纯免费引流」阶段。恢复收费仅需置 True。
    PAYMENT_ENABLED: bool = False
    # 沙箱模拟支付是否自动开通会员：公测期改走真实经营码 + 凭证核销，故默认关闭。
    # 关闭后 /upgrade 与 /orders/{no}/settle（沙箱）均不再授予会员，杜绝「点一下就白嫖会员」。
    SANDBOX_AUTO_GRANT: bool = False
    EARLY_BIRD_MONTHLY_DAYS: int = 30      # 月费有效期天数
    EARLY_BIRD_YEARLY_DAYS: int = 365      # 年费有效期天数

    # —— 余额制（替代会员制）：预充值 + 按量扣 + 归零停答 ——
    # 公测期用「首充券 + 余额」替代会员墙：注册送首充券（充值才兑现），按量扣费，余额归零即停答（像中转 API 平台）。
    TRIAL_CREDIT_YUAN: float = 0.0          # 直接赠送体验金（已废弃，改为首充券 FIRST_RECHARGE_COUPON_YUAN，避免注册即亏损）
    FIRST_RECHARGE_COUPON_YUAN: float = 2.0  # 新用户首充券：充值才兑现的 ¥2（不充值零成本）
    MIN_RECHARGE_YUAN: float = 1.0         # 单次最小充值额（2026-08-26 由 6 降为 1：拉新试水门槛）
    INVITE_REWARD_YUAN: float = 2.0        # 邀请奖励券：被邀人注册后邀请人得 ¥2 首充券（充值才兑现，替代直接赠余额）
    COUPON_VALID_DAYS: int = 90            # 首充券有效期（天），制造紧迫感驱动首充
    RECHARGE_TIERS: dict = {1: 0, 3: 0, 6: 0.5, 10: 1, 30: 3, 68: 10, 128: 22}  # 充值档位赠金（元，2026-08-26 方案A：1/3 无赠、6 送 0.5、10 送 1、30 送 3、68 送 10、128 送 22）

    # —— 计费（硅基流动风格透明计费：用户可见 模型 / token / 花费）——
    # 每日免费事件配额：每个计费主体（user:/device:）每天前 DAILY_FREE_EVENTS 次问答免费，
    # 超出后按 token 精确计费并从余额(赠送先花→购买后花)扣除；余额归零即停答。
    # 免费额度仅对「用户可见事件」(chat 等 internal=0) 计数；卡片/联盟 API 内部核算事件不计免费额度。
    # 2026-08-28 免费引流策略：由 3 提高到 10（登录/匿名共用同一主体计数器，均生效）。
    DAILY_FREE_EVENTS: int = 10
    # 商品介绍消耗的每日免费额度权重（2026-08-26 权重制）：介绍占 0.25 次 → 满额每日可免费看 12 次。
    # 普通问答占用 1.0；介绍不按 token 计费、直接从免费额度按 0.25 扣（free_eligible=True + free_weight=0.25）。
    FREE_INTRO_WEIGHT: float = 0.25
    # 售价倍率：用户扣费 = 平台成本 × CHARGE_MULTIPLIER（成本加成定价，2026-08-25 定价讨论定案 ×5）。
    # 平台成本按 MODEL_PRICES（硅基流动实价）核算，售价用于用户扣费与账单展示，二者分离存 billing_events。
    CHARGE_MULTIPLIER: float = 5.0
    # 各模型单价（¥ / 1M tokens，输入/输出拆分）。取硅基流动公开价位的数量级近似值，便于真实成本可视化。
    # 键为 ai_service.MODEL_BRANDS 链里的具体模型名；命中不到的统一走 default。
    MODEL_PRICES: dict = {
        "deepseek-ai/DeepSeek-R1":        {"in": 4.0, "out": 16.0, "cache": 0.4},   # 平台实价（2026-08-25 用户控制台）
        "deepseek-ai/DeepSeek-V4-Flash":  {"in": 1.0, "out": 2.0, "cache": 0.02},  # 平台实价（2026-08-25）
        "deepseek-ai/DeepSeek-V4-Pro":    {"in": 12.0, "out": 24.0, "cache": 1.0},  # 平台实价（2026-08-25）
        "deepseek-ai/DeepSeek-V3":        {"in": 2.0, "out": 8.0, "cache": 0.2},   # 平台实价（2026-08-25）
        "Qwen/Qwen3.5-35B-A3B":           {"in": 0.4, "out": 3.2},   # 平台实价（<128k 档；>128k 档 1.6/12.8 未实现分级）
        "Qwen/Qwen3-32B":                 {"in": 1.0, "out": 4.0},   # 平台实价（2026-08-25；无缓存价则退化为输入价）
        "zai-org/GLM-5.2":                {"in": 8.0, "out": 28.0, "cache": 2.0},  # 平台实价（2026-08-25）
        "zai-org/GLM-4.5-Air":            {"in": 0.5, "out": 1.5},   # 估值，待平台价
        "MiniMaxAI/MiniMax-M2.5":         {"in": 2.1, "out": 8.4, "cache": 0.21},  # 平台实价（2026-08-25）
        "Pro/moonshotai/Kimi-K2.6":       {"in": 6.5, "out": 27.0, "cache": 1.1},  # 平台实价（2026-08-25）
        "Pro/zai-org/GLM-5.1":            {"in": 6.0, "out": 24.0, "cache": 1.3},  # 平台实价（<32k 档；>32k 档 8/28/cache2 未实现分级）
        "default":                        {"in": 1.0, "out": 4.0},
    }

    # —— 测试期免费模型白名单（2026-08-30）——
    # 名单内的模型调用一律不计费、不占每日免费额度（永久免费，直到从名单移除）。
    # 默认把主聊天模型 deepseek-ai/DeepSeek-V4-Flash 设为免费（测试阶段让淘客无限试用）；
    # 其余模型（R1 / V4-Pro / V3 / GLM / Kimi …）计费逻辑完全不变。
    # 测试结束恢复收费：在 .env 写 FREE_MODELS= 清空即可。
    FREE_MODELS: List[str] = ["deepseek-ai/DeepSeek-V4-Flash"]

    # —— 商品介绍（AI 商品详情）测试期免费开关（2026-08-30）——
    # True = 商品介绍完全免费（闸门直接放行、不占免费额度、不计费），直到置 False 恢复权重制
    # （每日 FREE_INTRO_WEIGHT 额度内免费、超额扣余额）。
    PRODUCT_INTRO_FREE: bool = True

    # —— 真收钱商户信息（经营码静态资产，不入 git；运营/部署时单独放置到 backend/app/static/）——
    MERCHANT_NAME: str = "示例科技有限公司"
    MERCHANT_QR_FILENAME: str = "merchant_qr.jpg"

    # —— 公网分享（获客飞轮：报告→带溯源卡片图 + 公网可访问 URL）——
    SHARE_CTA_URL: str = ""          # 分享页底部 CTA 跳转（App/落地页地址）；留空则只显示品牌文案
    SHARE_DEFAULT_TTL_DAYS: int = 0  # 0 = 不过期；>0 则分享链接 N 天后失效

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()

# ── 启动自检：签名密钥安全（2026-08-28 工程审查 P0-2 修复）────────────────────
# 此前 AUTH_SECRET_KEY 带默认占位值且 .env 未覆盖，生产实际使用公开可知的密钥，
# 已知 user_id 者可自签令牌接管账号。这里强制：占位值或长度不足一律视为未配置。
_SECRET_PLACEHOLDERS = ("", "change-this-secret-in-production", "changeme", "secret", "your-secret-key")
if settings.AUTH_SECRET_KEY in _SECRET_PLACEHOLDERS or len(settings.AUTH_SECRET_KEY) < 32:
    if settings.DEBUG:
        print(
            "[SECURITY-WARN] AUTH_SECRET_KEY 未显式配置（占位值或长度 < 32），JWT 签名可被伪造。"
            "本地开发可继续；请尽快在 backend/.env 写入随机密钥（python -c \"import secrets; print(secrets.token_urlsafe(64))\"）。"
        )
    else:
        raise RuntimeError(
            "[SECURITY-BLOCK] AUTH_SECRET_KEY 未显式配置：生产环境禁止使用默认签名密钥。\n"
            "请生成随机密钥并写入 backend/.env：\n"
            "  python -c \"import secrets; print(secrets.token_urlsafe(64))\""
        )

# 生产配置检查（2026-08-28 工程审查 P2）：非 DEBUG 时必须收敛 CORS / 关闭调试开关
if not settings.DEBUG:
    if settings.BACKEND_CORS_ORIGINS == ["*"]:
        print(
            "[SECURITY-WARN] 生产环境 BACKEND_CORS_ORIGINS 仍为通配符 [\"*\"]，"
            "建议在 .env 收敛为实际域名白名单（如 BACKEND_CORS_ORIGINS=[\"https://你的域名\"]）。"
        )
    if settings.CAPTCHA_PROVIDER == "":
        print("[SECURITY-WARN] 生产环境未启用图形验证码（CAPTCHA_PROVIDER 为空），注册/发码无防机器人校验。")
