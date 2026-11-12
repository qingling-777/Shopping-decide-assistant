# 购物决策助手 · Shopping Decide Assistant

> 面向**带货选品**场景的 AI 决策助手：输入一个商品链接或一句模糊需求，输出**能不能做、赚多少、怎么起量**的结构化判断，而不是一段泛泛而谈的文案。

后端 FastAPI + 前端 React Native (Expo) Web，含完整的**流式对话、卡片路由、按量计费、邀请/券体系、分享裂变、运营后台**。

> 本项目是真实上线产品的开源版本，已移除全部生产凭据、用户数据与商业标识。仅供学习与二次开发参考。

---

## 它解决什么问题

带货/选品的人每天面对的是同一类问题：

- 这个品现在还能不能进？竞争是不是已经烂了？
- 佣金率 15% 听着不错，一单到底赚多少？
- 手上没货源，从哪找还在涨的品？
- 商家问「帮我铺货」，和我自己带货，答案完全不是一回事。

通用聊天模型答不好这类问题：它不知道实时佣金、不知道榜单、也不区分你是**个人带货**还是**商家招商**。本项目的做法是把这三件事拆开处理：

1. **实时数据注入** — 好单库 / 大淘客双源拉商品、佣金、销量、榜单
2. **受众分流** — `C`（个人带货）与 `B`（商家招商）走不同的 system prompt 与知识库
3. **结构化出卡** — 该给商品卡就给商品卡，该给机会判断就给机会卡，闲聊时一张卡都不给

---

## 功能特性

### 对话与卡片

| 能力 | 说明 |
|---|---|
| SSE 流式对话 | 逐字输出，含思维链面板（原生 `reasoning_content`） |
| 卡片路由 | 8 类卡片：爆品榜、机会分析、风险、趋势、商品、品类、下一步行动、数据洞察 |
| 多轮指代承接 | 「那第二个呢」能正确接住上一轮卡片里的商品，且不重复出卡 |
| 无关问题不出卡 | 市场类强/弱关键词分级判断，闲聊与通用问答不触发卡片 |
| 商品链接诊断 | 贴淘宝/天猫链接 → 实时价、佣金、销量、店铺、历史券后价 |

### 账号与商业化

- 手机号/邮箱注册，腾讯云验证码，JWT 鉴权
- **设备级匿名可用**，登录后自动合并 device → user 的历史与余额
- **权重制计费**：普通问答 `1.0`、商品介绍 `0.25`；每日免费额度用尽后按 token 精算扣费
- 余额分 **gift（赠送）先扣 → paid（充值）后扣**，归零停答（HTTP 402）
- 首充券 / 邀请券（充值才兑现，90 天有效），充值档位赠金
- 支付宝当面付 + 手机网站支付，回调 CAS 抢锁防重复入账

### 运营

- 管理后台：账户用量报表（按 subject × model 拆分）、封禁/解封
- 方向追踪：把用户问过的品类沉淀成趋势
- 公网分享页：报告生成带溯源的可分享链接

---

## 技术栈

**后端** Python 3.10+ · FastAPI · Pydantic v2 · SQLite (WAL) · httpx · 支付宝 SDK · 腾讯云 SDK
**前端** React Native 0.86 · Expo 57 · React 19 · TypeScript · Zustand · react-native-svg · react-native-web

无重型中间件依赖：数据库是 SQLite（开 WAL + `BEGIN IMMEDIATE` 保证计费一致性），缓存走进程内 + 可选的 Redis。

---

## 架构

```
mobile/ (Expo Web / RN)
   │  SSE /chat/stream  ─────────────┐
   │  REST  /auth /billing /tracking │
   ▼                                 ▼
backend/main.py ──────────────► app/api/routes/*     (11 组路由)
                                      │
                                      ▼
                               app/services/*        (22 个服务)
                    ┌─────────────┬───────────┬──────────────┐
                    ▼             ▼           ▼              ▼
              ai_service    union/dataoke  subscription   tracking
              (LLM 链)      (联盟数据)     (计费/余额)     (方向沉淀)
                    │             │           │
                    ▼             ▼           ▼
              SiliconFlow    好单库/大淘客   SQLite
```

**关键设计**

- `ai_service` 维护模型链（主模型 → 兜底），逐级 failover，失败自动降级
- 卡片类型由 `_detect_card_type` 决定：先判是否市场问题 → 再判品类/商品命中 → 再判动词意图，避免「要一批在售商品」被误判成机会分析
- 计费统一走 `record_usage`：免费额度内 `is_free=1` 不扣钱，超额按 `MODEL_PRICES` × `CHARGE_MULTIPLIER` 扣余额
- 单连接 + `BEGIN IMMEDIATE` 串行化写，避免并发扣费出现负余额

---

## 快速开始

### 1. 后端

```bash
cd backend
python -m venv venv

# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
cp .env.example .env        # 然后填入 SILICONFLOW_API_KEY 与 AUTH_SECRET_KEY
python -m uvicorn main:app --host 0.0.0.0 --port 8082
```

接口文档：http://localhost:8082/docs

### 2. 前端

```bash
cd mobile
npm install
npx expo start --web
```

默认连 `http://localhost:8082/api/v1`。要指向别的后端：

```bash
EXPO_PUBLIC_API_BASE_URL=http://your-host:8082/api/v1 npx expo start --web
```

### 3. 最小可用配置

只跑通对话，至少需要：

| 变量 | 用途 |
|---|---|
| `AUTH_SECRET_KEY` | JWT 签名，必须 ≥32 位随机串 |
| `SILICONFLOW_API_KEY` | LLM 调用 |

商品卡片需要 `HAODANKU_API_KEY` 或 `DATAOKE_APP_KEY/SECRET`；不配也能启动，只是商品级数据降级为空。

---

## 项目结构

```
.
├── backend/
│   ├── main.py                 # 应用入口，挂载 11 组路由
│   ├── requirements.txt
│   ├── .env.example
│   ├── tests/                  # 资金一致性测试
│   └── app/
│       ├── api/routes/         # auth chat billing candidates plans trends
│       │                       # content share diagnose feedback tracking
│       ├── core/config.py      # 全部配置项（Pydantic Settings）
│       ├── db/                 # SQLite / Redis 连接
│       ├── models/ schemas/    # ORM 与 Pydantic 模型
│       ├── services/           # 22 个业务服务
│       └── knowledge/          # 选品方法论知识库（JSON）
└── mobile/
    ├── App.tsx
    └── src/
        ├── components/cards/   # 8 类卡片组件
        ├── components/chat/    # 气泡、思维链、流式渲染
        ├── screens/            # 17 个页面（含 3 个管理后台）
        ├── store/              # Zustand
        └── utils/api.ts        # SSE 解析 + 全部接口封装
```

---

## 配置要点

完整清单见 `backend/.env.example`。几个容易踩的点：

- **`BACKEND_CORS_ORIGINS` 不能用 `"*"`** —— 后端 `allow_credentials=True`，浏览器会直接拦截
- **`AUTH_SECRET_KEY` 长度 <32 会在 `DEBUG=False` 时直接抛错**，这是刻意设计（防止默认密钥上线）
- **`ALLOW_DIRECT_RECHARGE` 必须保持 `False`** —— 这是无验签直充后门，只用于本地调试
- **收款码等静态资产不入库**，放到 `backend/app/static/` 由部署方自行提供

---

## 合规与免责

- 商品数据来自第三方联盟平台（好单库 / 大淘客），使用需自行申请并遵守其服务条款
- 淘宝联盟推广位（PID）、支付宝商户资质需自行申请
- AI 生成内容不构成投资或经营建议，实际选品决策请自行核实
- 请勿用于爬取平台数据、伪造交易或规避平台规则

---

## License

MIT — 见 [LICENSE](LICENSE)
