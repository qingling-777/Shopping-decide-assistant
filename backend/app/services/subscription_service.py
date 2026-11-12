import json
import secrets
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

from app.core.config import settings
from app.services.payment_service import get_payment_provider


class PaymentDisabledError(ValueError):
    """沙箱模拟支付已关闭，拒绝自动开通会员。"""


class SubscriptionService:
    """分层订阅 / 配额 / 用量计量（Phase 1，落 SQLite，不接真实支付）。

    数据模型（见 PAYWALL_DESIGN.md §4.2）：
    - subscriptions(subject PK, tier, mode, quota_used, quota_date, created_at, updated_at)
    - usage_ledger(id, subject, event_type, amount, created_at)
    - device_link(device_id PK, user_id, created_at)
    """

    def __init__(self):
        self.db_path = Path(__file__).resolve().parents[4] / "billing.sqlite3"
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        """连接计费库（2026-08-28 工程审查 P0-5/6 修复）。

        原实现为裸 sqlite3.connect(path)：默认 rollback journal（写操作独占整个 DB 文件）、无
        busy_timeout、无连接超时。生产 2 workers 并发下写锁竞争会让事件循环阻塞至多 5s。
        现统一：WAL（读不阻塞写）+ busy_timeout=30s + 连接超时 30s。
        """
        connection = sqlite3.connect(self.db_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def _now(self) -> str:
        """当前 UTC 时间戳（ISO8601，与项目现有格式 `%Y-%m-%dT%H:%M:%SZ` 一致）。"""
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def _initialize_database(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS subscriptions (
                    subject     TEXT PRIMARY KEY,
                    tier        TEXT NOT NULL DEFAULT 'free',
                    mode        TEXT NOT NULL DEFAULT 'select',
                    quota_used  INTEGER NOT NULL DEFAULT 0,
                    quota_date  TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS usage_ledger (
                    id          TEXT PRIMARY KEY,
                    subject     TEXT NOT NULL,
                    event_type  TEXT NOT NULL,
                    amount      REAL NOT NULL DEFAULT 0,
                    created_at  TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS device_link (
                    device_id   TEXT PRIMARY KEY,
                    user_id     TEXT NOT NULL,
                    created_at  TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS orders (
                    id            TEXT PRIMARY KEY,
                    subject       TEXT NOT NULL,
                    plan          TEXT NOT NULL,            -- monthly | yearly | recharge
                    amount        REAL NOT NULL,
                    currency      TEXT NOT NULL DEFAULT 'CNY',
                    status        TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|failed|expired
                    provider      TEXT NOT NULL DEFAULT 'sandbox',
                    out_trade_no  TEXT NOT NULL,
                    created_at    TEXT NOT NULL,
                    paid_at       TEXT,
                    expire_at     TEXT,
                    raw           TEXT,
                    updated_at    TEXT
                )
                """
            )
            # 2026-08-26 充值订单新增 channel（wap=手机网站H5收银台 / face=当面付扫码），老库 ALTER 补列
            try:
                connection.execute("ALTER TABLE orders ADD COLUMN channel TEXT")
            except Exception:
                pass  # 列已存在
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS payment_proofs (
                    id          TEXT PRIMARY KEY,
                    subject     TEXT NOT NULL,
                    plan        TEXT NOT NULL,
                    amount      REAL,
                    proof_ref   TEXT,
                    status      TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
                    created_at  TEXT NOT NULL,
                    reviewed_at TEXT,
                    reviewer    TEXT
                )
                """
            )
            # 邀请关系表：防重复奖励（每人仅被记一次）
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS referrals (
                    invitee_subject TEXT PRIMARY KEY,
                    referrer_subject TEXT NOT NULL,
                    code TEXT,
                    rewarded_at TEXT NOT NULL
                )
                """
            )
            # 计费流水（硅基流动风格透明计费）：每笔用户可见事件(chat) / 内部核算事件(卡片/联盟 API)
            # 各写一条；用户可见事件计入每日免费配额、超额按 token 精确扣余额；内部事件仅落平台成本供运营报表。
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS billing_events (
                    id          TEXT PRIMARY KEY,
                    subject     TEXT NOT NULL,
                    event_type  TEXT NOT NULL,          -- chat | card_data_insight | card_opportunity | card_product | card_trend | alliance_api ...
                    model       TEXT NOT NULL DEFAULT '',  -- 实际调用模型（如 deepseek-ai/DeepSeek-R1）
                    model_brand TEXT NOT NULL DEFAULT '',  -- 前端品牌键（auto/r1/deepseek...）
                    tokens_in   INTEGER NOT NULL DEFAULT 0,
                    tokens_out  INTEGER NOT NULL DEFAULT 0,
                    tokens_cached INTEGER NOT NULL DEFAULT 0, -- 缓存命中输入 token（按 cache 单价计，远低于 fresh 输入）
                    cost_yuan   REAL NOT NULL DEFAULT 0,   -- 用户扣费（售价 = 平台成本 × CHARGE_MULTIPLIER）；免费事件记名义售价供核算，不计入用户"已花费"
                    platform_cost_yuan REAL NOT NULL DEFAULT 0, -- 平台真实成本（¥，按 token×平台实价），供运营报表/成本核算
                    free_weight REAL NOT NULL DEFAULT 1.0, -- 免费事件消耗的额度权重（普通问答=1.0、商品介绍=0.25，2026-08-26 权重制）
                    is_free     INTEGER NOT NULL DEFAULT 0, -- 1=落在每日免费配额内（未计费）
                    internal    INTEGER NOT NULL DEFAULT 0, -- 1=内部核算（不计免费额度、不扣用户余额）
                    balance_after REAL NOT NULL DEFAULT 0,  -- 计费后用户余额（内部事件记当前余额快照）
                    request_id  TEXT NOT NULL DEFAULT '',
                    meta        TEXT NOT NULL DEFAULT '',   -- 备注 JSON（如联盟 API 调用次数）
                    created_at  TEXT NOT NULL
                )
                """
            )
            # 首充券：充值才兑现的抵扣券（替代直接赠送余额，避免注册即亏损；2026-08-25 定价改造）
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS coupons (
                    id          TEXT PRIMARY KEY,
                    subject     TEXT NOT NULL,
                    amount      REAL NOT NULL,
                    scope       TEXT NOT NULL DEFAULT 'first_recharge', -- first_recharge | any
                    status      TEXT NOT NULL DEFAULT 'pending',        -- pending | used | expired
                    source      TEXT NOT NULL DEFAULT 'device',         -- device | invite | bug
                    expires_at  TEXT,
                    used_at     TEXT,
                    created_at  TEXT NOT NULL
                )
                """
            )
            try:
                connection.execute("CREATE INDEX IF NOT EXISTS idx_coupons_subject ON coupons(subject, status)")
            except sqlite3.OperationalError:
                pass
            # 商品内容持久缓存（AI 生成介绍/推广方案落库，2026-08-25：替代内存缓存，重启不丢、避免重复花钱）
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS product_contents (
                    id          TEXT PRIMARY KEY,      -- 商品稳定 key（id 或 title 哈希）
                    intro       TEXT,                  -- 商品介绍 JSON
                    plan        TEXT,                  -- 推广方案 JSON
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                )
                """
            )
            try:
                connection.execute("CREATE INDEX IF NOT EXISTS idx_billing_subject ON billing_events(subject, created_at)")
            except sqlite3.OperationalError:
                pass
            # 黑名单：被管理员拉黑的计费主体（user:<id> / device:<id>），闸门拦截返回 403（2026-08-30 反滥用）
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS banned_subjects (
                    subject     TEXT PRIMARY KEY,   -- user:<id> 或 device:<id>
                    reason      TEXT NOT NULL DEFAULT '',
                    active      INTEGER NOT NULL DEFAULT 1,  -- 1=生效中；0=已解封（保留审计）
                    created_by  TEXT NOT NULL DEFAULT '',    -- 管理员 user id
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT
                )
                """
            )
            # orders.updated_at 兼容旧库
            try:
                connection.execute("ALTER TABLE orders ADD COLUMN updated_at TEXT")
            except sqlite3.OperationalError:
                pass
            # billing_events.tokens_cached 兼容旧库（缓存命中 token 拆分，2026-08-25 新增）
            try:
                connection.execute("ALTER TABLE billing_events ADD COLUMN tokens_cached INTEGER NOT NULL DEFAULT 0")
            except sqlite3.OperationalError:
                pass
            # billing_events.platform_cost_yuan 兼容旧库（成本/售价分离，2026-08-25 新增）
            try:
                connection.execute("ALTER TABLE billing_events ADD COLUMN platform_cost_yuan REAL NOT NULL DEFAULT 0")
            except sqlite3.OperationalError:
                pass
            # billing_events.free_weight 兼容旧库（免费额度权重制：问答=1.0/介绍=0.25，2026-08-26 新增）
            try:
                connection.execute("ALTER TABLE billing_events ADD COLUMN free_weight REAL NOT NULL DEFAULT 1.0")
            except sqlite3.OperationalError:
                pass
            # 兜底回填：历史行的 free_weight 若为 NULL/<=0 统一按 1.0（普通问答）处理，避免 SUM 漏算导致免费剩余虚高
            connection.execute("UPDATE billing_events SET free_weight=1.0 WHERE free_weight IS NULL OR free_weight<=0")
            # 订阅生命周期字段（兼容旧库：dev SQLite 直接 ALTER 补列）
            for col in (
                "plan TEXT",
                "paid_at TEXT",
                "expiry TEXT",
                "order_id TEXT",
                "status TEXT NOT NULL DEFAULT 'active'",
                "card_used INTEGER NOT NULL DEFAULT 0",
                "card_date TEXT",
            ):
                col_name = col.split()[0]
                try:
                    connection.execute(f"ALTER TABLE subscriptions ADD COLUMN {col}")
                except sqlite3.OperationalError:
                    pass  # 列已存在
            # 旧行补默认 status
            connection.execute("UPDATE subscriptions SET status='active' WHERE status IS NULL OR status=''")
            # 余额制：预充值 + 按量扣 + 归零停答（替代会员配额）
            try:
                connection.execute("ALTER TABLE subscriptions ADD COLUMN balance REAL DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # 列已存在
            # 赠送/购买拆分：赠送先花、购买后花（活动赠送 + 邀请奖励走 gift）
            for col in ("gift_balance REAL DEFAULT 0", "paid_balance REAL DEFAULT 0", "gift_claimed INTEGER NOT NULL DEFAULT 0"):
                try:
                    connection.execute(f"ALTER TABLE subscriptions ADD COLUMN {col}")
                except sqlite3.OperationalError:
                    pass  # 列已存在
            # 旧行回fill：flat balance 拆成 赠送(封顶体验金) + 购买(剩余)
            connection.execute(
                "UPDATE subscriptions SET gift_balance = MIN(balance, ?), paid_balance = MAX(0, balance - ?) WHERE gift_balance IS NULL OR gift_balance = 0",
                (settings.TRIAL_CREDIT_YUAN, settings.TRIAL_CREDIT_YUAN),
            )
            # gift_claimed：user 已购(paid>0)视为已领；user 仅有赠送→待登录合并一次；device 永远可合并
            connection.execute(
                "UPDATE subscriptions SET gift_claimed = 1 WHERE subject LIKE 'user:%' AND paid_balance > 0"
            )
            connection.execute(
                "UPDATE subscriptions SET gift_claimed = 0 WHERE subject LIKE 'user:%' AND paid_balance = 0"
            )
            connection.execute(
                "UPDATE subscriptions SET gift_claimed = 0 WHERE subject LIKE 'device:%'"
            )
            # 命名空间迁移：旧库里裸 user_id 行（无 user:/device: 前缀）统一改为 user:<id>，
            # 否则与 is_active_member/get_card_remaining/check_card_quota/consume_card 的 `user:{id}` 查表键不一致，
            # 会导致会员开通后 quota 逻辑认不出（已修的真 bug）。
            connection.execute(
                "UPDATE subscriptions SET subject = 'user:' || subject "
                "WHERE subject NOT LIKE 'user:%' AND subject NOT LIKE 'device:%'"
            )

    # ── 内部工具 ──────────────────────────────────────────────

    @staticmethod
    def _today() -> str:
        return time.strftime("%Y-%m-%d", time.gmtime())

    def _early_bird_left(self) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS c FROM subscriptions WHERE tier = 'early_bird'"
            ).fetchone()
        used = row["c"] if row else 0
        return max(0, settings.EARLY_BIRD_QUOTA - used)

    @staticmethod
    def _is_active_member(sub: Dict) -> bool:
        """有效会员判定：tier=='early_bird' 且 status=='active' 且 expiry >= 今天（ISO 日期字符串可直接比较）。"""
        if sub.get("tier") != "early_bird":
            return False
        if sub.get("status") != "active":
            return False
        expiry = sub.get("expiry")
        if not expiry:
            return False
        return expiry >= time.strftime("%Y-%m-%d", time.gmtime())

    # ── 首充券（充值才兑现的抵扣券，2026-08-25 定价改造：替代直接赠送余额，避免注册即亏损）──

    @staticmethod
    def _coupon_expiry() -> str:
        return (datetime.utcnow() + timedelta(days=settings.COUPON_VALID_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")

    @staticmethod
    def _insert_coupon(connection, subject: str, amount: float, source: str, scope: str = "first_recharge") -> str:
        coupon_id = secrets.token_hex(16)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        connection.execute(
            "INSERT INTO coupons (id, subject, amount, scope, status, source, expires_at, created_at) "
            "VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
            (coupon_id, subject, amount, scope, source, SubscriptionService._coupon_expiry(), now),
        )
        return coupon_id

    def issue_coupon(self, subject: str, amount: float, source: str = "device") -> Dict:
        """发一张首充券（pending）。同一主体同 source 已有 pending 券则不重复发（防薅）。"""
        if amount <= 0:
            return {"issued": False, "reason": "amount"}
        with self._connect() as connection:
            dup = connection.execute(
                "SELECT 1 FROM coupons WHERE subject=? AND source=? AND status='pending'", (subject, source)
            ).fetchone()
            if dup:
                return {"issued": False, "reason": "dup"}
            cid = self._insert_coupon(connection, subject, amount, source)
        return {"issued": True, "coupon_id": cid, "amount": amount}

    def pending_coupons(self, subject: str) -> List[Dict]:
        """未使用且未过期的券（按到期时间升序）。"""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, amount, scope, source, expires_at FROM coupons "
                "WHERE subject=? AND status='pending' AND expires_at >= ? ORDER BY expires_at ASC",
                (subject, now),
            ).fetchall()
        return [
            {"id": r["id"], "amount": float(r["amount"] or 0), "scope": r["scope"], "source": r["source"], "expires_at": r["expires_at"]}
            for r in rows
        ]

    def _apply_coupons_inline(self, connection, subject: str, now: str) -> float:
        """在调用方提供的事务连接内兑现全部未用首充券（供 recharge 单事务内联调用）。

        CAS（AND status='pending' + rowcount==1）保证并发下每张券只兑现一次。
        """
        total = 0.0
        rows = connection.execute(
            "SELECT id, amount FROM coupons WHERE subject=? AND status='pending' AND expires_at >= ? "
            "AND scope='first_recharge' ORDER BY expires_at ASC",
            (subject, now),
        ).fetchall()
        for r in rows:
            cur = connection.execute(
                "UPDATE coupons SET status='used', used_at=? WHERE id=? AND status='pending'",
                (now, r["id"]),
            )
            if cur.rowcount == 1:  # 只有真正 CAS 抢到才计入赠金
                total += float(r["amount"] or 0)
        return round(total, 4)

    def apply_coupons(self, subject: str) -> float:
        """充值入账时兑现全部未用首充券；返回总赠金，逐张标记 used（一次性，不可重复薅）。

        ⚠️ 2026-08-28 工程审查 P0-3/资金正确性修复：UPDATE 增加 `AND status='pending'` CAS 条件，
        并以 rowcount==1 判定是否真正抢到该券。此前无条件 UPDATE，并发下同一张券可被兑现两次（券双花）。
        """
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            return self._apply_coupons_inline(connection, subject, now)

    # ── 商品内容持久缓存（AI 介绍/推广方案落库，2026-08-25）──

    def get_product_content(self, key: str) -> Dict:
        """读商品内容缓存：{intro: dict|None, plan: dict|None}。"""
        with self._connect() as connection:
            row = connection.execute("SELECT intro, plan FROM product_contents WHERE id=?", (key,)).fetchone()
        if not row:
            return {"intro": None, "plan": None}
        out = {}
        try:
            out["intro"] = json.loads(row["intro"]) if row["intro"] else None
        except Exception:
            out["intro"] = None
        try:
            out["plan"] = json.loads(row["plan"]) if row["plan"] else None
        except Exception:
            out["plan"] = None
        return out

    def save_product_content(self, key: str, intro: Optional[Dict] = None, plan: Optional[Dict] = None) -> None:
        """写商品内容缓存（upsert）。"""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            row = connection.execute("SELECT 1 FROM product_contents WHERE id=?", (key,)).fetchone()
            if row:
                connection.execute(
                    "UPDATE product_contents SET intro=COALESCE(?, intro), plan=COALESCE(?, plan), updated_at=? WHERE id=?",
                    (json.dumps(intro, ensure_ascii=False) if intro is not None else None,
                     json.dumps(plan, ensure_ascii=False) if plan is not None else None, now, key),
                )
            else:
                connection.execute(
                    "INSERT INTO product_contents (id, intro, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (key, json.dumps(intro, ensure_ascii=False) if intro is not None else None,
                     json.dumps(plan, ensure_ascii=False) if plan is not None else None, now, now),
                )

    # ── 公开接口 ──────────────────────────────────────────────

    def ensure(self, subject: str) -> Dict:
        """确保订阅行存在（匿名设备首次使用时建占位行）；跨日自动归零。"""
        today = self._today()
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        is_device = subject.startswith("device:")
        # 直接赠送体验金已废弃（TRIAL_CREDIT_YUAN=0，2026-08-25 定价改造），改发首充券（充值才兑现）
        gift0 = float(settings.TRIAL_CREDIT_YUAN) if is_device else 0.0
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM subscriptions WHERE subject = ?", (subject,)
            ).fetchone()
            if not row:
                connection.execute(
                    "INSERT INTO subscriptions (subject, tier, mode, quota_used, quota_date, card_used, card_date, gift_balance, paid_balance, gift_claimed, balance, created_at, updated_at) "
                    "VALUES (?, 'free', 'select', 0, ?, 0, ?, ?, 0, ?, ?, ?, ?)",
                    (subject, today, today, gift0, 0.0, gift0, now, now),
                )
                # 设备首充券：新设备首次使用即发（充值才兑现，不充值零成本）
                if is_device and settings.FIRST_RECHARGE_COUPON_YUAN > 0:
                    try:
                        self._insert_coupon(connection, subject, float(settings.FIRST_RECHARGE_COUPON_YUAN), "device")
                    except Exception as error:
                        print(f"[COUPON] 设备首充券发放失败: {error}")
                return {
                    "subject": subject,
                    "tier": "free",
                    "mode": "select",
                    "quota_used": 0,
                    "quota_date": today,
                    "card_used": 0,
                    "card_date": today,
                    "balance": gift0,
                    "gift_balance": gift0,
                    "paid_balance": 0.0,
                    "gift_claimed": 0,
                    "created_at": now,
                    "updated_at": now,
                    "plan": None,
                    "paid_at": None,
                    "expiry": None,
                    "order_id": None,
                    "status": "active",
                }
            # 跨日归零（问答 + 卡片）
            if row["quota_date"] != today:
                connection.execute(
                    "UPDATE subscriptions SET quota_used = 0, quota_date = ?, card_used = 0, card_date = ?, updated_at = ? WHERE subject = ?",
                    (today, today, now, subject),
                )
                return {
                    "subject": subject,
                    "tier": row["tier"],
                    "mode": row["mode"],
                    "quota_used": 0,
                    "quota_date": today,
                    "card_used": 0,
                    "card_date": today,
                    "balance": row["balance"] or 0.0,
                    "gift_balance": row["gift_balance"] or 0.0,
                    "paid_balance": row["paid_balance"] or 0.0,
                    "gift_claimed": row["gift_claimed"] or 0,
                    "created_at": row["created_at"],
                    "updated_at": now,
                    "plan": row["plan"],
                    "paid_at": row["paid_at"],
                    "expiry": row["expiry"],
                    "order_id": row["order_id"],
                    "status": row["status"],
                }
            return {
                "subject": subject,
                "tier": row["tier"],
                "mode": row["mode"],
                "quota_used": row["quota_used"],
                "quota_date": row["quota_date"],
                "card_used": row["card_used"],
                "card_date": row["card_date"],
                "balance": row["balance"] or 0.0,
                "gift_balance": row["gift_balance"] or 0.0,
                "paid_balance": row["paid_balance"] or 0.0,
                "gift_claimed": row["gift_claimed"] or 0,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "plan": row["plan"],
                "paid_at": row["paid_at"],
                "expiry": row["expiry"],
                "order_id": row["order_id"],
                "status": row["status"],
            }

    def get_quota_info(self, subject: str) -> Dict:
        """GET /me 返回：tier / mode / quota_used / quota_limit / remaining / early_bird_left / expiry / status / plan。

        过期的 early_bird 自动降级回 free（写入 subscriptions.tier='free'），保证免费配额正确恢复。
        """
        sub = self.ensure(subject)
        # 过期降级：early_bird 但状态非 active 或有效期已过 → 回 free（幂等，避免反复写）
        if sub["tier"] == "early_bird" and not self._is_active_member(sub):
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with self._connect() as connection:
                connection.execute(
                    "UPDATE subscriptions SET tier='free', plan=NULL, paid_at=NULL, expiry=NULL, status='expired', updated_at=? "
                    "WHERE subject=?",
                    (now, subject),
                )
            sub = {**sub, "tier": "free", "status": "expired", "expiry": None, "plan": None, "paid_at": None}
        is_free = sub["tier"] == "free"
        quota_limit = settings.FREE_DAILY_CHAT_LIMIT if is_free else None
        remaining = (settings.FREE_DAILY_CHAT_LIMIT - sub["quota_used"]) if is_free else None
        return {
            "tier": sub["tier"],
            "mode": sub["mode"],
            "quota_used": sub["quota_used"],
            "quota_limit": quota_limit,
            "remaining": remaining,
            "balance": sub.get("balance") or 0.0,
            "early_bird_left": self._early_bird_left(),
            "expiry": sub.get("expiry"),
            "status": sub.get("status"),
            "plan": sub.get("plan"),
            "daily_free_events": settings.DAILY_FREE_EVENTS,
            "payment_enabled": settings.PAYMENT_ENABLED,
        }

    # ── 余额制（替代会员配额）：预充值 + 按量扣 + 归零停答 ──

    def has_balance(self, subject: str) -> bool:
        """余额 > 0 才放行问答；归零即停答。"""
        sub = self.ensure(subject)
        return (sub.get("balance") or 0.0) > 0

    def can_use_cards(self, subject: str) -> bool:
        """卡片解锁：登录后（余额>0 或 今日免费额度内）即可产卡，与 require_quota 闸门一致。

        修复前 allow_cards 只判 has_balance，导致「新用户 0 元 + 免费额度内」能聊天却出不了卡，
        与 free_events_remaining>0 可问答的闸门逻辑不一致。行为细化：
        - 余额 > 0 的付费用户：不限卡片次数（与 consume_card 对 has_balance 用户不计卡的逻辑一致）。
        - 余额为 0 的免费用户：仅在今日卡片次数 CARD_DAILY_LIMIT 内产卡（超额走充值解锁）。
        """
        if self.has_balance(subject):
            return True
        # 无余额：需今日还有免费问答额度，且（若为 user 主体）卡片次数未用尽
        if self.free_events_remaining(subject) <= 0:
            return False
        if subject.startswith("user:"):
            return self.check_card_quota(subject[len("user:"):])
        # 匿名 device 无卡片配额概念，但 allow_cards 外部已用 user_id 短路，这里兜底放行
        return True

    def get_balance(self, subject: str) -> Dict:
        """GET /billing/balance：余额(元) + 赠送/购买拆分 + 体验金 + 预估还能聊几次 + 今日免费剩余。"""
        sub = self.ensure(subject)
        balance = float(sub.get("balance") or 0.0)
        gift = float(sub.get("gift_balance") or 0.0)
        paid = float(sub.get("paid_balance") or 0.0)
        est = int(balance / 0.0185) if balance > 0 else 0  # 按默认 V4-Flash 单次售价（~¥0.0185）估算
        return {
            "balance": round(balance, 4),
            "gift_balance": round(gift, 4),
            "paid_balance": round(paid, 4),
            "trial_credit": settings.TRIAL_CREDIT_YUAN,
            "est_chats": max(0, est),
            "min_recharge": settings.MIN_RECHARGE_YUAN,
            "recharge_tiers": settings.RECHARGE_TIERS,
            "coupons": self.pending_coupons(subject),
            "free_remaining": self.free_events_remaining(subject),
            "daily_free_events": settings.DAILY_FREE_EVENTS,
            "payment_enabled": settings.PAYMENT_ENABLED,
        }

    def recharge(self, subject: str, amount_yuan: float) -> Dict:
        """POST /billing/recharge：入账（MVP 直接到账；真实支付由异步回调触发本方法）。

        充值一律计入 paid_balance（购买后花）。

        ⚠️ 2026-08-28 工程审查 P0-5 修复：原实现「ensure(独立连接) → 读余额(独立连接) → UPDATE(独立连接)」
        跨连接 read-modify-write，并发充值会丢失累加。现改为**单连接 + BEGIN IMMEDIATE 事务**：
        ensure 建行 + 券兑现 + 读余额 + 算新余额 + UPDATE + INSERT 流水全部同事务，累加不丢。
        """
        if amount_yuan is None or amount_yuan <= 0:
            raise ValueError("充值金额必须大于 0")
        if amount_yuan < settings.MIN_RECHARGE_YUAN:
            raise ValueError(f"单次最小充值 ¥{settings.MIN_RECHARGE_YUAN:.0f}")
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        ledger_id = secrets.token_hex(16)
        # 充值档位赠金（RECHARGE_TIERS 2026-08-26 方案A：1/3 无赠、6 送 0.5、10 送 1、30 送 3、68 送 10、128 送 22）
        # ⚠️ 2026-08-28 工程审查 P2 修复：原实现 int(amount_yuan) 截断匹配（付 6.9 元按 6 元档发赠金），
        # 现改精确匹配：仅金额恰为档位值（6.0/10.0/…，浮点等价于 int 键）才发放，6.9 不再误命中 6 元档。
        tier_bonus = float(settings.RECHARGE_TIERS.get(amount_yuan, 0) or 0)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            # ensure 建行（事务内联，原 self.ensure；并发充值不丢行）
            row = connection.execute(
                "SELECT * FROM subscriptions WHERE subject = ?", (subject,)
            ).fetchone()
            if not row:
                is_device = subject.startswith("device:")
                gift0 = float(settings.TRIAL_CREDIT_YUAN) if is_device else 0.0
                connection.execute(
                    "INSERT INTO subscriptions (subject, tier, mode, quota_used, quota_date, card_used, card_date, gift_balance, paid_balance, gift_claimed, balance, created_at, updated_at) "
                    "VALUES (?, 'free', 'select', 0, ?, 0, ?, ?, 0, ?, ?, ?, ?)",
                    (subject, now[:10], now[:10], gift0, 0.0, gift0, now, now),
                )
                if is_device and settings.FIRST_RECHARGE_COUPON_YUAN > 0:
                    try:
                        self._insert_coupon(connection, subject, float(settings.FIRST_RECHARGE_COUPON_YUAN), "device")
                    except Exception as error:
                        print(f"[COUPON] 设备首充券发放失败: {error}")
            # 兑现未用首充券（CAS，同事务，充值才生效；不充值则券一直 pending 零成本）
            coupon_bonus = self._apply_coupons_inline(connection, subject, now)
            bonus = round(tier_bonus + coupon_bonus, 4)
            credit = round(amount_yuan + bonus, 4)
            row2 = connection.execute(
                "SELECT balance, paid_balance FROM subscriptions WHERE subject=?", (subject,)
            ).fetchone()
            cur = float(row2["balance"]) if row2 and row2["balance"] is not None else 0.0
            cur_paid = float(row2["paid_balance"]) if row2 and row2["paid_balance"] is not None else 0.0
            new_balance = round(cur + credit, 4)
            new_paid = round(cur_paid + credit, 4)
            connection.execute(
                "UPDATE subscriptions SET balance=?, paid_balance=?, updated_at=? WHERE subject=?",
                (new_balance, new_paid, now, subject),
            )
            connection.execute(
                "INSERT INTO usage_ledger (id, subject, event_type, amount, created_at) VALUES (?, ?, 'recharge', ?, ?)",
                (ledger_id, subject, amount_yuan, now),
            )
            connection.execute("COMMIT")
        return {
            "status": "ok", "balance": round(new_balance, 4), "paid_balance": round(new_paid, 4),
            "recharged": amount_yuan, "tier_bonus": tier_bonus, "coupon_bonus": coupon_bonus, "bonus": bonus,
            "est_chats": int(new_balance / 0.0185) if new_balance > 0 else 0,
            "free_remaining": self.free_events_remaining(subject),
        }

    def deduct(self, subject: str, amount_yuan: float, event: str = "chat", meta: Optional[str] = None) -> Dict:
        """按量扣费：按 token 精确扣（record_usage 走 billing_events）。余额不为负。

        赠送先花、购买后花：先扣 gift_balance，不足部分再扣 paid_balance。
        """
        # 先 ensure：保证订阅行存在，否则下方 UPDATE 命中 0 行、扣费静默丢失（虽 chat 路径已先 ensure，这里兜底防直连）。
        self.ensure(subject)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        ledger_id = secrets.token_hex(16)
        with self._connect() as connection:
            row = connection.execute("SELECT balance, gift_balance, paid_balance FROM subscriptions WHERE subject=?", (subject,)).fetchone()
            cur = float(row["balance"]) if row and row["balance"] is not None else 0.0
            gift = float(row["gift_balance"]) if row and row["gift_balance"] is not None else 0.0
            paid = float(row["paid_balance"]) if row and row["paid_balance"] is not None else 0.0
            # 赠送先花、购买后花
            gift_spent = min(gift, amount_yuan)
            new_gift = gift - gift_spent
            leftover = amount_yuan - gift_spent
            new_paid = max(0.0, paid - leftover)
            new_balance = max(0.0, cur - amount_yuan)
            connection.execute(
                "UPDATE subscriptions SET balance=?, gift_balance=?, paid_balance=?, updated_at=? WHERE subject=?",
                (new_balance, new_gift, new_paid, now, subject),
            )
            connection.execute(
                "INSERT INTO usage_ledger (id, subject, event_type, amount, created_at) VALUES (?, ?, ?, ?, ?)",
                (ledger_id, subject, event, -round(amount_yuan, 4), now),
            )
        return {"status": "ok", "balance": round(new_balance, 4), "gift_balance": round(new_gift, 4), "paid_balance": round(new_paid, 4), "deducted": round(amount_yuan, 4)}

    def add_gift(self, subject: str, amount_yuan: float, reason: str = "gift") -> Dict:
        """活动赠送 / 邀请奖励等：计入 gift_balance（赠送先花、购买后花）。"""
        if amount_yuan is None or amount_yuan <= 0:
            raise ValueError("赠送金额必须大于 0")
        self.ensure(subject)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        ledger_id = secrets.token_hex(16)
        with self._connect() as connection:
            row = connection.execute("SELECT balance, gift_balance FROM subscriptions WHERE subject=?", (subject,)).fetchone()
            cur = float(row["balance"]) if row and row["balance"] is not None else 0.0
            cur_gift = float(row["gift_balance"]) if row and row["gift_balance"] is not None else 0.0
            new_gift = cur_gift + amount_yuan
            new_balance = cur + amount_yuan
            connection.execute(
                "UPDATE subscriptions SET balance=?, gift_balance=?, updated_at=? WHERE subject=?",
                (new_balance, new_gift, now, subject),
            )
            connection.execute(
                "INSERT INTO usage_ledger (id, subject, event_type, amount, created_at) VALUES (?, ?, ?, ?, ?)",
                (ledger_id, subject, reason, amount_yuan, now),
            )
        return {"status": "ok", "balance": round(new_balance, 4), "gift_balance": round(new_gift, 4), "granted": amount_yuan}

    def apply_invite(self, invitee_user_id: str, referrer_user_id: str, code: str) -> Dict:
        """邀请奖励：邀请人 +¥5 赠送（gift，先花）。每人仅被记一次（防刷）。

        invitee 带他人有效邀请码注册时调用；返回 {applied, granted?}。邀请人自身邀请自己→忽略。
        """
        invitee_sub = f"user:{invitee_user_id}"
        referrer_sub = f"user:{referrer_user_id}"
        if invitee_user_id == referrer_user_id:
            return {"applied": False, "reason": "self"}
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            if connection.execute("SELECT 1 FROM referrals WHERE invitee_subject=?", (invitee_sub,)).fetchone():
                return {"applied": False, "reason": "already"}
            connection.execute(
                "INSERT OR IGNORE INTO referrals (invitee_subject, referrer_subject, code, rewarded_at) VALUES (?, ?, ?, ?)",
                (invitee_sub, referrer_sub, code, now),
            )
        # 邀请奖励改发首充券（充值才兑现，替代直接赠余额，2026-08-25 定价改造；异常不影响注册主流程）
        try:
            self.issue_coupon(referrer_sub, float(settings.INVITE_REWARD_YUAN), "invite")
        except Exception as error:
            print(f"[INVITE] 邀请券发放失败: {error}")
        return {"applied": True, "granted": settings.INVITE_REWARD_YUAN}

    def count_invitees(self, referrer_subject: str) -> int:
        """邀请人成功邀请的人数（用于「我的邀请码」展示）。"""
        with self._connect() as connection:
            row = connection.execute("SELECT COUNT(*) AS c FROM referrals WHERE referrer_subject=?", (referrer_subject,)).fetchone()
        return row["c"] if row else 0

    def check_quota(self, subject: str, event: str = "chat") -> bool:
        """chat 配额闸门：免费或过期会员且当日已用 >= 上限 → False；有效会员 → True。"""
        sub = self.ensure(subject)
        is_member = self._is_active_member(sub)
        if event == "chat" and not is_member:
            if sub["quota_used"] >= settings.FREE_DAILY_CHAT_LIMIT:
                return False
        return True

    def consume(self, subject: str, event: str = "chat", amount: float = 0.0) -> Dict:
        """计费：chat 计 1 次配额并写账本(0)；付费事件(deep_report/test_plan)写账本(金额)。"""
        sub = self.ensure(subject)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        ledger_id = secrets.token_hex(16)
        with self._connect() as connection:
            if event == "chat":
                connection.execute(
                    "UPDATE subscriptions SET quota_used = quota_used + 1, updated_at = ? WHERE subject = ?",
                    (now, subject),
                )
            connection.execute(
                "INSERT INTO usage_ledger (id, subject, event_type, amount, created_at) VALUES (?, ?, ?, ?, ?)",
                (ledger_id, subject, event, amount, now),
            )
        return {
            "status": "ok",
            "event": event,
            "amount": amount,
            "tier": sub["tier"],
            "quota_used": sub["quota_used"] + (1 if event == "chat" else 0),
        }

    # ── 双计数器：问答=登录按账号/匿名按设备 / 卡片=用户维度（仅登录）──

    def _get_row(self, subject: str) -> Optional[Dict]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM subscriptions WHERE subject = ?", (subject,)
            ).fetchone()
            return dict(row) if row else None

    def is_active_member(self, user_id: str) -> bool:
        """按 user_id 判定有效会员（问答+卡片均无限）。匿名(user_id 空)→False。

        与 get_card_remaining/check_card_quota/consume_card 一致，统一以 `user:{user_id}` 查表。
        """
        if not user_id:
            return False
        row = self._get_row(f"user:{user_id}")
        if not row:
            return False
        return self._is_active_member(row)

    def is_member_subject(self, subject: str) -> bool:
        """按任意计费主体（user:/device:）判定有效会员。

        运营核销/直开时匿名客户以 `device:<id>` 为计费主体开通，get_identity 需据此识别会员态，
        否则客户付款被核销后仍显示 free（闭环断裂）。
        """
        if not subject:
            return False
        row = self._get_row(subject)
        if not row:
            return False
        return self._is_active_member(row)

    def get_chat_remaining(self, device_id: str, user_id: Optional[str] = None) -> int:
        """问答剩余：登录按账号维度、匿名按设备维度（免费 10/日，跨日归零）。会员无限由调用方处理。"""
        subject = f"user:{user_id}" if user_id else f"device:{device_id}"
        sub = self.ensure(subject)
        return max(0, settings.FREE_DAILY_CHAT_LIMIT - sub["quota_used"])

    def get_card_remaining(self, user_id: str) -> int:
        """用户维度卡片剩余（免费登录用户 CARD_DAILY_LIMIT/日）。会员/匿名不走此路径。"""
        sub = self.ensure(f"user:{user_id}")
        return max(0, settings.CARD_DAILY_LIMIT - sub["card_used"])

    def check_card_quota(self, user_id: str) -> bool:
        """免费登录用户卡片是否还有额度；会员→True（无限）。"""
        sub = self.ensure(f"user:{user_id}")
        if self._is_active_member(sub):
            return True
        return sub["card_used"] < settings.CARD_DAILY_LIMIT

    def consume_card(self, user_id: str) -> None:
        """免费登录用户每轮产出卡片计 1 次；会员不计。"""
        sub = self.ensure(f"user:{user_id}")
        if self._is_active_member(sub):
            return
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "UPDATE subscriptions SET card_used = card_used + 1, updated_at = ? WHERE subject = ?",
                (now, f"user:{user_id}"),
            )

    def upgrade(self, subject: str) -> Dict:
        """POST /upgrade（stub，无真实支付）：置 tier=early_bird；名额不足则抛错。"""
        if self._early_bird_left() <= 0:
            raise ValueError("内测名额已满")
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "UPDATE subscriptions SET tier = 'early_bird', updated_at = ? WHERE subject = ?",
                (now, subject),
            )
        return {
            "status": "ok",
            "tier": "early_bird",
            "early_bird_left": self._early_bird_left(),
            "message": "已升级为内测会员，AI 选品咨询不限次",
        }

    def set_mode(self, subject: str, mode: str) -> Dict:
        """POST /mode：切 select(B 参考) / distribute(C pid, Phase 2 才生效)。"""
        if mode not in ("select", "distribute"):
            raise ValueError("mode 仅支持 select 或 distribute")
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "UPDATE subscriptions SET mode = ?, updated_at = ? WHERE subject = ?",
                (mode, now, subject),
            )
        return {"status": "ok", "mode": mode}

    def link_device(self, device_id: str, user_id: str) -> Dict:
        """匿名设备 → 登录用户 映射（登录后调用，便于 later 把设备用量并入账号）。"""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO device_link (device_id, user_id, created_at) VALUES (?, ?, ?)",
                (device_id, user_id, now),
            )
        return {"status": "ok", "device_id": device_id, "user_id": user_id}

    def migrate_device_membership(self, user_id: str, device_id: str) -> Dict:
        """登录时把匿名设备的有效会员并入登录账号（跨设备跟随）。

        「登录即账号」语义：会员归属账号(user:<id>)，而非某一台设备。

        - 仅当 device:<id> 当前是有效 early_bird 会员时才迁移；否则仅落 device_link 映射、幂等安全。
        - 迁移 = 把 device 的会员属性(plan/paid_at/expiry/status)写入 user:<id>，并取两者中更晚的 expiry，
          保证不丢时长（如设备年付、账号月付 → 账号继承年付）。
        - 迁移后清空 device:<id> 的会员态（tier 回 free），使账号成为唯一真源：
          * 避免「账号取消后本机设备仍显会员」的双源不一致；
          * 避免 early_bird 名额被 device + user 重复计数（_early_bird_left 按 tier 统计）。
        - 同时写入 device_link 映射（审计 / 后续设备用量并入账号）。
        返回值：{status, migrated, plan?, expiry?} ；migrated=False 时附 reason。
        """
        user_sub = f"user:{user_id}"
        device_sub = f"device:{device_id}"
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        today = self._today()
        device_row = self._get_row(device_sub)
        user_row = self._get_row(user_sub)
        device_is_member = self._is_active_member(device_row) if device_row else False

        # ── 余额合并：device 的赠送+购买并入 user（每用户仅一次；顺带找回历史匿名充值）──
        # user 已领过(gift_claimed)或已有购买(paid>0) → 不再并赠送，避免重复薅/重复送。
        user_paid = float(user_row["paid_balance"]) if user_row and user_row.get("paid_balance") is not None else 0.0
        user_claimed = bool(user_row.get("gift_claimed")) if user_row else False
        if (not user_claimed) and user_paid == 0:
            dev_gift = float(device_row["gift_balance"]) if device_row and device_row.get("gift_balance") is not None else 0.0
            dev_paid = float(device_row["paid_balance"]) if device_row and device_row.get("paid_balance") is not None else 0.0
            if dev_gift > 0 or dev_paid > 0:
                with self._connect() as connection:
                    urow = connection.execute(
                        "SELECT gift_balance, paid_balance, balance FROM subscriptions WHERE subject=?", (user_sub,)
                    ).fetchone()
                    if urow:
                        ug = float(urow["gift_balance"]) or 0.0
                        up = float(urow["paid_balance"]) or 0.0
                        ub = float(urow["balance"]) or 0.0
                        connection.execute(
                            "UPDATE subscriptions SET gift_balance=?, paid_balance=?, balance=?, gift_claimed=1, updated_at=? WHERE subject=?",
                            (ug + dev_gift, up + dev_paid, ub + dev_gift + dev_paid, now, user_sub),
                        )
                    else:
                        connection.execute(
                            "INSERT INTO subscriptions (subject, tier, mode, quota_used, quota_date, card_used, card_date, gift_balance, paid_balance, gift_claimed, balance, created_at, updated_at) "
                            "VALUES (?, 'free', 'select', 0, ?, 0, ?, ?, ?, 1, ?, ?, ?)",
                            (user_sub, today, today, dev_gift, dev_paid, dev_gift + dev_paid, now, now),
                        )
                    connection.execute(
                        "UPDATE subscriptions SET gift_balance=0, paid_balance=0, balance=0, updated_at=? WHERE subject=?",
                        (now, device_sub),
                    )

        # 券迁移：只迁「当前这台设备」的未用首充券并入 user（登录后充值兑现；2026-08-25 定价改造）。
        # 2026-08-28 加固：账号若已持有未用首充券，则本轮不再并入——避免多台设备登录时首充券被
        # 无限累积到同一账号（此前 WHERE subject=device_sub AND status='pending' 每迁一次 +1 张，
        # e2e 用全新 device_id 反复登录同一账号会把 N 台设备的 ¥2 券全堆给该用户）。
        # 每台设备在 ensure() 最多发 1 张 pending 首充券，这里只迁当前设备，语义即「只迁当前这张」。
        try:
            with self._connect() as connection:
                connection.execute(
                    "UPDATE coupons SET subject=?"
                    " WHERE subject=? AND status='pending' AND scope='first_recharge'"
                    " AND NOT EXISTS (SELECT 1 FROM coupons c2 WHERE c2.subject=? AND c2.status='pending' AND c2.scope='first_recharge')",
                    (user_sub, device_sub, user_sub),
                )
        except Exception as error:
            print(f"[COUPON] 券迁移失败: {error}")

        # 每日免费事件迁移：device 今日已消耗的免费事件归入 user
        # 登录后不重置免费次数——匿名已用的计入用户每日上限（"每日免费次数可以继承"）
        try:
            with self._connect() as connection:
                connection.execute(
                    "UPDATE billing_events SET subject=? WHERE subject=? AND substr(created_at,1,10)=?",
                    (user_sub, device_sub, today),
                )
        except Exception as error:
            print(f"[BILLING] 免费事件迁移失败: {error}")

        def _expiry_date(sub: Optional[Dict]) -> Optional["datetime"]:
            e = sub.get("expiry") if sub else None
            if not e:
                return None
            try:
                return datetime.strptime(e, "%Y-%m-%d").date()
            except Exception:
                return None

        if not device_is_member:
            # 无设备会员可迁：仍落映射，便于审计；并返回现状
            self.link_device(device_id, user_id)
            return {"status": "ok", "migrated": False, "reason": "device_not_member"}

        device_exp = _expiry_date(device_row)
        user_is_member = self._is_active_member(user_row) if user_row else False
        user_exp = _expiry_date(user_row)

        # 账号已是更长（或相等）的有效会员 → 不覆盖，仅清空设备 + 落映射，避免缩短时长
        if user_is_member and (user_exp is not None and (device_exp is None or user_exp >= device_exp)):
            with self._connect() as connection:
                connection.execute(
                    "UPDATE subscriptions SET tier='free', plan=NULL, paid_at=NULL, expiry=NULL, status='free', updated_at=? WHERE subject=?",
                    (now, device_sub),
                )
            self.link_device(device_id, user_id)
            return {"status": "ok", "migrated": False, "reason": "user_already_better"}

        # 迁移：把 device 会员属性写入 user（取 device 的更晚 expiry），并清空 device
        plan = device_row["plan"] or "monthly"
        with self._connect() as connection:
            existing = connection.execute("SELECT 1 FROM subscriptions WHERE subject=?", (user_sub,)).fetchone()
            if existing:
                connection.execute(
                    "UPDATE subscriptions SET tier='early_bird', plan=?, paid_at=?, expiry=?, status='active', updated_at=? WHERE subject=?",
                    (plan, device_row["paid_at"], device_row["expiry"], now, user_sub),
                )
            else:
                connection.execute(
                    "INSERT INTO subscriptions (subject, tier, mode, quota_used, quota_date, created_at, updated_at, plan, paid_at, expiry, status) "
                    "VALUES (?, 'early_bird', 'select', 0, ?, ?, ?, ?, ?, ?, 'active')",
                    (user_sub, today, now, now, plan, device_row["paid_at"], device_row["expiry"]),
                )
            connection.execute(
                "UPDATE subscriptions SET tier='free', plan=NULL, paid_at=NULL, expiry=NULL, status='free', updated_at=? WHERE subject=?",
                (now, device_sub),
            )
        self.link_device(device_id, user_id)
        return {
            "status": "ok",
            "migrated": True,
            "plan": plan,
            "expiry": device_row["expiry"],
        }

    def get_pricing(self) -> Dict:
        """GET /pricing：定价结构（2026-08-25 定价改造：纯按量 ×5 + 充值档位，无订阅档）。

        结构：免费 3 次/天 + 超免费额度按 token 计费（售价 = 平台成本 × CHARGE_MULTIPLIER）+ 充值档位赠金。
        model_prices：逐模型售价明细（含输入/输出/缓存命中三档），默认模型置顶。
        """
        mk = settings.CHARGE_MULTIPLIER
        models = [
            {"model": m, "platform": p}
            for m, p in settings.MODEL_PRICES.items()
            if m != "default"
        ]
        models.sort(key=lambda x: (x["model"] != "deepseek-ai/DeepSeek-V4-Flash", x["model"]))
        return {
            "currency": "CNY",
            "payment_enabled": settings.PAYMENT_ENABLED,
            "charge_multiplier": mk,
            "daily_free_events": settings.DAILY_FREE_EVENTS,
            "min_recharge": settings.MIN_RECHARGE_YUAN,
            "recharge_tiers": settings.RECHARGE_TIERS,
            "first_recharge_coupon": settings.FIRST_RECHARGE_COUPON_YUAN,
            "price_note": (
                f"售价 = 平台成本 × {mk:.0f}（¥/1M token，输入/输出/缓存命中三档）；"
                "缓存命中输入仅 ¥0.02/1M，比全新输入便宜 50 倍；"
                "默认模型 DeepSeek-V4-Flash 单次问答约 ¥0.0185，充值 ¥1 起即可体验。"
            ),
            "model_prices": [
                {
                    "model": item["model"],
                    "default": item["model"] == "deepseek-ai/DeepSeek-V4-Flash",
                    "platform": item["platform"],
                    "sell": {k: round(v * mk, 4) for k, v in item["platform"].items()},
                }
                for item in models
            ],
            "tiers": [
                {
                    "id": "free",
                    "name": "免费",
                    "price_monthly": 0,
                    "price_yearly": 0,
                    "chat": f"每日 {settings.DAILY_FREE_EVENTS} 次免费问答",
                    "note": "免费额度用完后按量计费",
                },
                {
                    "id": "pay_as_you_go",
                    "name": "按量",
                    "price_monthly": None,
                    "price_yearly": None,
                    "chat": f"超免费额度后按 token 计费（售价 = 成本 × {mk:.0f}）",
                    "recharge": f"充值 ¥{settings.MIN_RECHARGE_YUAN:.0f} 起，充得越多送得越多",
                },
            ],
        }


    # ── 订单 / 订阅生命周期（A+B）──────────────────────────────

    def create_order(self, subject: str, plan: str) -> Dict:
        """创建内测会员订单（pending）。沙箱 Provider 仅生成商户订单号，无 pay_url。"""
        if plan not in ("monthly", "yearly"):
            raise ValueError("plan 仅支持 monthly 或 yearly")
        if self._early_bird_left() <= 0:
            raise ValueError("内测名额已满")
        amount = settings.EARLY_BIRD_MONTHLY if plan == "monthly" else settings.EARLY_BIRD_YEARLY
        provider = get_payment_provider()
        pay = provider.create_order(subject, plan, amount)
        out_trade_no = pay["out_trade_no"]
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        order_id = secrets.token_hex(16)
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO orders (id, subject, plan, amount, currency, status, provider, out_trade_no, created_at) "
                "VALUES (?, ?, ?, ?, 'CNY', 'pending', ?, ?, ?)",
                (order_id, subject, plan, amount, provider.name, out_trade_no, now),
            )
        return {
            "order_id": order_id,
            "out_trade_no": out_trade_no,
            "plan": plan,
            "amount": amount,
            "currency": "CNY",
            "status": "pending",
            "pay_url": pay.get("pay_url"),
            "qr": pay.get("qr"),
            "sandbox": pay.get("sandbox", False),
        }

    def settle_order(self, out_trade_no: str) -> Dict:
        """支付成功结算：订单置 paid，订阅升级 early_bird + 写 paid_at/expiry（按 plan 算有效期）。

        沙箱模拟支付默认不再自动开通会员（SANDBOX_AUTO_GRANT=False）：公测走真实经营码 +
        凭证核销（approve_proof）。真实通道（wechat/alipay）接入后 provider 非 sandbox，照常开通。
        """
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        today = self._today()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM orders WHERE out_trade_no = ?", (out_trade_no,)
            ).fetchone()
            if not row:
                raise ValueError("订单不存在")
            # 沙箱模拟支付且未开启自动开通：拒绝授予会员，避免「点一下就白嫖」
            if row["provider"] == "sandbox" and not settings.SANDBOX_AUTO_GRANT:
                raise PaymentDisabledError("模拟支付已关闭，请扫码经营码付款后上传凭证核销开通")
            if row["status"] == "paid":
                return self.get_quota_info(row["subject"])  # 幂等：已支付直接返回当前状态
            plan = row["plan"]
            days = settings.EARLY_BIRD_MONTHLY_DAYS if plan == "monthly" else settings.EARLY_BIRD_YEARLY_DAYS
            expire_date = (datetime.strptime(today, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")
            subject = row["subject"]
            # 确保订阅行存在：首次开通可能还没调过 /me（ensure 建行），否则下方 UPDATE 命中 0 行会静默升级失败
            sub = connection.execute("SELECT * FROM subscriptions WHERE subject = ?", (subject,)).fetchone()
            if not sub:
                connection.execute(
                    "INSERT INTO subscriptions (subject, tier, mode, quota_used, quota_date, created_at, updated_at) "
                    "VALUES (?, 'free', 'select', 0, ?, ?, ?)",
                    (subject, today, now, now),
                )
            connection.execute(
                "UPDATE subscriptions SET tier='early_bird', plan=?, paid_at=?, expiry=?, order_id=?, status='active', updated_at=? "
                "WHERE subject=?",
                (plan, now, expire_date, row["id"], now, subject),
            )
            connection.execute(
                "UPDATE orders SET status='paid', paid_at=?, expire_at=?, updated_at=? WHERE out_trade_no=?",
                (now, expire_date, now, out_trade_no),
            )
        return self.get_quota_info(row["subject"])

    def cancel(self, subject: str) -> Dict:
        """取消订阅：立即回退 free（MVP 不做退款）。"""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "UPDATE subscriptions SET tier='free', plan=NULL, paid_at=NULL, expiry=NULL, status='cancelled', updated_at=? "
                "WHERE subject=?",
                (now, subject),
            )
        return self.get_quota_info(subject)

    def create_recharge_order(self, subject: str, amount_yuan: float, channel: str = "wap") -> Dict:
        """创建「充值加余额」订单。

        channel="wap"（默认，手机网站支付 H5）：返回收银台跳转链接 pay_url，前端点击跳转；
        channel="face"（当面付扫码）：返回二维码串 qr，前端渲染二维码。
        """
        # 支付总开关（2026-08-28 免费引流策略）：关闭时禁止任何充值下单。
        if not settings.PAYMENT_ENABLED:
            raise ValueError("当前未开放充值")
        if amount_yuan is None or amount_yuan <= 0:
            raise ValueError("充值金额必须大于 0")
        if amount_yuan < settings.MIN_RECHARGE_YUAN:
            raise ValueError(f"单次最小充值 ¥{settings.MIN_RECHARGE_YUAN:.0f}")
        provider = get_payment_provider()
        pay = provider.create_order(subject, "recharge", amount_yuan, channel=channel)
        out_trade_no = pay["out_trade_no"]
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        order_id = secrets.token_hex(16)
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO orders (id, subject, plan, amount, currency, status, provider, out_trade_no, created_at, channel) "
                "VALUES (?, ?, 'recharge', ?, 'CNY', 'pending', ?, ?, ?, ?)",
                (order_id, subject, amount_yuan, provider.name, out_trade_no, now, channel),
            )
        return {
            "order_id": order_id,
            "out_trade_no": out_trade_no,
            "plan": "recharge",
            "amount": amount_yuan,
            "currency": "CNY",
            "status": "pending",
            "pay_url": pay.get("pay_url"),
            "qr": pay.get("qr"),
            "sandbox": pay.get("sandbox", False),
            "channel": channel,
        }

    def get_order(self, out_trade_no: str) -> Optional[Dict]:
        """按商户订单号取订单（供前端轮询支付状态）。"""
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM orders WHERE out_trade_no = ?", (out_trade_no,)).fetchone()
        return dict(row) if row else None

    def auto_credit_alipay(self, out_trade_no: str) -> Dict:
        """支付宝异步回调验签通过后：给订单对应主体自动加余额（充值到账）。原子幂等。

        ⚠️ 2026-08-28 工程审查 P0-4 修复：原实现「读订单 → 判已付 → recharge() → 标记 paid」是
        check-then-act，幂等守卫与状态写入之间夹着已加钱的 recharge()——支付宝重复通知或并发回调
        都会重复入账（且 billing.py 返回 "fail" 会主动招来重试，与 SQLite 写锁失败叠加后无需并发
        即可触发）。现改为**先 CAS 抢锁**：UPDATE orders SET status='paid' WHERE out_trade_no=?
        AND status!='paid'，仅当 rowcount==1（唯一一次从未支付→已支付）才执行入账，天然幂等。

        若入账本身失败（recharge 抛异常）：回滚订单为 pending 并向上抛异常 → billing.py 返回 "fail"
        → 支付宝重试 → 重新走完整入账。最坏情况是「少到账可人工核销」，绝不出现「重复到账」。
        """
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM orders WHERE out_trade_no = ?", (out_trade_no,)).fetchone()
        if not row:
            raise ValueError("订单不存在")
        if row["plan"] != "recharge":
            raise ValueError("该订单不是充值订单")
        subject = row["subject"]
        amount = float(row["amount"])
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        # CAS 抢锁：并发/重试回调中，只有第一个拿到 rowcount==1（状态从未支付变为已支付）
        with self._connect() as connection:
            cur = connection.execute(
                "UPDATE orders SET status='paid', paid_at=?, updated_at=? WHERE out_trade_no=? AND status!='paid'",
                (now, now, out_trade_no),
            )
        if cur.rowcount == 0:
            # 已被并发/重试回调处理过 → 幂等返回，不重复入账
            return {"status": "ok", "already": True, "amount": amount}
        try:
            # 抢到锁：此时才真正入账（加 paid_balance + 档位赠金 + 首充券 + 流水）
            res = self.recharge(subject, amount)
        except Exception:
            # 入账失败：回滚订单为未支付，让支付宝重试重新入账（billing.py 对异常返回 "fail"）
            with self._connect() as connection:
                connection.execute(
                    "UPDATE orders SET status='pending', paid_at=NULL WHERE out_trade_no=? AND status='paid'",
                    (out_trade_no,),
                )
            raise
        return {"status": "ok", "already": False, "amount": amount, **res, "out_trade_no": out_trade_no}

    def get_orders(self, subject: str) -> List[Dict]:
        """列出某计费主体的订单（按时间倒序）。"""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM orders WHERE subject=? ORDER BY created_at DESC", (subject,)
            ).fetchall()
        return [dict(r) for r in rows]

    def grant_manual(self, subject: str, plan: str = "monthly", days: Optional[int] = None) -> Dict:
        """运营手动开通（经营码收款后人工核销）：直接置 early_bird + 有效期。供 /billing/admin/grant 调用。

        统一以 `user:<id>` 为键（与会员/卡片查表键一致）；传入裸 id 自动补 `user:` 前缀。
        """
        if not (subject.startswith("user:") or subject.startswith("device:")):
            subject = f"user:{subject}"
        if plan not in ("monthly", "yearly"):
            raise ValueError("plan 仅支持 monthly 或 yearly")
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        today = self._today()
        if days is None:
            days = settings.EARLY_BIRD_MONTHLY_DAYS if plan == "monthly" else settings.EARLY_BIRD_YEARLY_DAYS
        expire_date = (datetime.strptime(today, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")
        with self._connect() as connection:
            sub = connection.execute("SELECT * FROM subscriptions WHERE subject=?", (subject,)).fetchone()
            if not sub:
                connection.execute(
                    "INSERT INTO subscriptions (subject, tier, mode, quota_used, quota_date, created_at, updated_at, plan, paid_at, expiry, status) "
                    "VALUES (?, 'early_bird', 'select', 0, ?, ?, ?, ?, ?, ?, 'active')",
                    (subject, today, now, now, plan, now, expire_date),
                )
            else:
                connection.execute(
                    "UPDATE subscriptions SET tier='early_bird', plan=?, paid_at=?, expiry=?, status='active', updated_at=? "
                    "WHERE subject=?",
                    (plan, now, expire_date, now, subject),
                )
        return self.get_quota_info(subject)

    # ── 经营码支付凭证（人工核销闭环）────────────────────────
    def submit_proof(self, subject: str, plan: str, amount: Optional[float], proof_ref: Optional[str]) -> Dict:
        """客户扫码付款后上传支付凭证：自动绑定 subject（后端从请求头取，不依赖客户填写，杜绝冒领）。

        经营码是静态个人码、无回调，靠此把「付款」与「客户身份」关联起来；落一条 pending 记录，
        等管理员在 /billing/admin/proofs 核对经营码账单后核销开通。
        """
        if plan not in ("monthly", "yearly"):
            raise ValueError("plan 仅支持 monthly 或 yearly")
        proof_id = secrets.token_hex(16)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO payment_proofs (id, subject, plan, amount, proof_ref, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, 'pending', ?)",
                (proof_id, subject, plan, amount, proof_ref, now),
            )
        return {"proof_id": proof_id, "status": "pending"}

    def list_proofs(self, status: Optional[str] = None) -> List[Dict]:
        """管理员看待开通凭证列表（默认全部，可按 status 过滤 pending/approved/rejected）。"""
        with self._connect() as connection:
            if status:
                rows = connection.execute(
                    "SELECT * FROM payment_proofs WHERE status=? ORDER BY created_at DESC", (status,)
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM payment_proofs ORDER BY created_at DESC"
                ).fetchall()
        return [dict(r) for r in rows]

    def approve_proof(self, proof_id: str, reviewer: str) -> Dict:
        """管理员核销：凭证置 approved，内部复用 grant_manual 开通会员。幂等（已处理则报错）。"""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM payment_proofs WHERE id=?", (proof_id,)).fetchone()
            if not row:
                raise ValueError("凭证不存在")
            if row["status"] != "pending":
                raise ValueError("该凭证已处理")
            connection.execute(
                "UPDATE payment_proofs SET status='approved', reviewed_at=?, reviewer=? WHERE id=?",
                (now, reviewer, proof_id),
            )
            subject = row["subject"]
            plan = row["plan"]
        return self.grant_manual(subject, plan)

    def reject_proof(self, proof_id: str, reviewer: str) -> Dict:
        """管理员驳回：凭证置 rejected（不开通会员）。"""
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM payment_proofs WHERE id=?", (proof_id,)).fetchone()
            if not row:
                raise ValueError("凭证不存在")
            if row["status"] != "pending":
                raise ValueError("该凭证已处理")
            connection.execute(
                "UPDATE payment_proofs SET status='rejected', reviewed_at=?, reviewer=? WHERE id=?",
                (now, reviewer, proof_id),
            )
        return {"proof_id": proof_id, "status": "rejected"}


    # ── 透明计费（硅基流动风格）：用户可见事件 + 内部核算事件 ──

    @staticmethod
    def _compute_cost(model: str, tokens_in: int, tokens_out: int, tokens_cached: int = 0) -> float:
        """按模型单价（¥/1M token，in/out 拆分）算本次花费；缓存命中 token 走 cache 单价（未配置则退化为输入价）。

        与硅基流动计费口径一致：fresh 输入 × in 价 + 缓存命中 × cache 价 + 输出 × out 价。
        命中不到列表的模型走 default。
        """
        price = settings.MODEL_PRICES.get(model) or settings.MODEL_PRICES["default"]
        t_in = int(tokens_in or 0)
        t_cached = max(0, min(int(tokens_cached or 0), t_in))  # 缓存命中不可能超过总输入
        t_fresh = t_in - t_cached
        cache_price = price.get("cache") if price.get("cache") is not None else price["in"]
        return (t_fresh * price["in"] + t_cached * cache_price + int(tokens_out or 0) * price["out"]) / 1_000_000

    def free_events_remaining(self, subject: str) -> float:
        """今日剩余免费额度（权重制，2026-08-26）：只统计实际使用免费额度的 is_free=1 事件，按 free_weight 求和扣减。

        普通问答每消耗 1.0、商品介绍每消耗 0.25，故返回值可为小数（如 2.75）。
        """
        today = self._today()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COALESCE(SUM(free_weight),0) AS w FROM billing_events "
                "WHERE subject=? AND internal=0 AND is_free=1 AND substr(created_at,1,10)=?",
                (subject, today),
            ).fetchone()
        used = float(row["w"]) if row else 0.0
        return max(0.0, round(float(settings.DAILY_FREE_EVENTS) - used, 4))

    def record_usage(
        self,
        subject: str,
        event_type: str,
        model: str,
        tokens_in: int = 0,
        tokens_out: int = 0,
        tokens_cached: int = 0,
        model_brand: Optional[str] = None,
        internal: bool = False,
        request_id: Optional[str] = None,
        meta: Optional[str] = None,
        charge_multiplier: Optional[float] = None,
        free_eligible: bool = True,
        free_weight: float = 1.0,
    ) -> Dict:
        """原子计费：写一条 billing_events，并（用户可见事件）计每日免费配额、（超额）按 token 扣余额。

        - 免费额度（权重制，2026-08-26）：今日累计已用权重 < DAILY_FREE_EVENTS 且剩余 >= free_weight → is_free=True，不计费
          （free_eligible=False 的功能不享受免费额度；free_weight 指该事件消耗的额度权重，普通问答 1.0/商品介绍 0.25）。
        - 超额且余额>0：按 token 精确扣 gift→paid（赠送先花、购买后花），balance_after 递减。
        - 超额且余额<=0：blocked=True，本次不扣费（闸门已提前挡住，这里双保险），前端应引导充值。
        - 内部事件(internal=True)：不计免费额度、不扣用户余额，仅落平台成本（卡片 LLM / 联盟 API）供运营报表。
        - charge_multiplier：售价倍率（默认 CHARGE_MULTIPLIER；商品介绍按 ×3、推广方案按 ×5 等可自定义）。
        返回结构含 status / is_free / cost_yuan / tokens_in/out / model / free_remaining，供下发用量回执。

        ⚠️ 2026-08-28 工程审查 P0-5/H4 修复（原 docstring 自称"原子计费"，实为 5 个独立连接
        read-modify-write，并发丢失更新；且余额不足本次成本时 clamp 后 cost_yuan 仍记名义价，
        报表虚高）：
        1) 免费额度判定 + ensure 建行 + 读余额 + UPDATE + INSERT 全部收进**同一个连接 + BEGIN
           IMMEDIATE 事务**，消除跨连接读-改-写竞态（丢失更新 / 免费额度超额发放）。
        2) 余额不足本次成本时按**实际可扣金额**记账（cost_yuan=min(cur,cost)，扣光余额），
           不再出现「balance_after=0 但 cost_yuan=名义价」的报表失真。
        """
        today = self._today()
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        event_id = secrets.token_hex(16)
        # 平台成本（硅基流动实价）与用户售价分离：售价 = 成本 × 倍率（默认 CHARGE_MULTIPLIER，成本加成定价）
        platform_cost = self._compute_cost(model, tokens_in, tokens_out, tokens_cached)
        cost = round(platform_cost * (charge_multiplier if charge_multiplier is not None else settings.CHARGE_MULTIPLIER), 6)
        fw = max(0.0, float(free_weight or 0.0))
        is_free = False
        blocked = False
        balance_after = 0.0
        new_gift = new_paid = None
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            # ① 免费额度判定（事务内读，避免并发超额；原 free_events_remaining 的 SUM 内联）
            free_remaining_inline = 0.0
            if not internal and free_eligible:
                row_w = connection.execute(
                    "SELECT COALESCE(SUM(free_weight),0) AS w FROM billing_events "
                    "WHERE subject=? AND internal=0 AND is_free=1 AND substr(created_at,1,10)=?",
                    (subject, today),
                ).fetchone()
                used_w = float(row_w["w"]) if row_w else 0.0
                free_remaining_inline = max(0.0, round(float(settings.DAILY_FREE_EVENTS) - used_w, 4))
                is_free = free_remaining_inline >= fw
                # 模型测试期永久免费（白名单 FREE_MODELS）：命中则不计费、不占每日免费额度（仅用户可见事件）
                if not internal and settings.FREE_MODELS and ((model or "") in settings.FREE_MODELS or (model_brand or "") in settings.FREE_MODELS):
                    is_free = True
                    fw = 0.0
                    cost = 0.0
            # ② ensure 建行（事务内内联，原 self.ensure 的 SELECT/INSERT 同连接）
            sub_row = connection.execute(
                "SELECT * FROM subscriptions WHERE subject=?", (subject,)
            ).fetchone()
            if not sub_row:
                is_device = subject.startswith("device:")
                gift0 = float(settings.TRIAL_CREDIT_YUAN) if is_device else 0.0
                connection.execute(
                    "INSERT INTO subscriptions (subject, tier, mode, quota_used, quota_date, card_used, card_date, gift_balance, paid_balance, gift_claimed, balance, created_at, updated_at) "
                    "VALUES (?, 'free', 'select', 0, ?, 0, ?, ?, 0, ?, ?, ?, ?)",
                    (subject, today, today, gift0, 0.0, gift0, now, now),
                )
                if is_device and settings.FIRST_RECHARGE_COUPON_YUAN > 0:
                    try:
                        self._insert_coupon(connection, subject, float(settings.FIRST_RECHARGE_COUPON_YUAN), "device")
                    except Exception as error:
                        print(f"[COUPON] 设备首充券发放失败: {error}")
                sub_row = {
                    "subject": subject, "tier": "free", "mode": "select", "quota_used": 0,
                    "quota_date": today, "card_used": 0, "card_date": today,
                    "gift_balance": gift0, "paid_balance": 0.0, "gift_claimed": 0,
                    "balance": gift0, "created_at": now, "updated_at": now,
                }
            sub_row = dict(sub_row)
            balance_after = float(sub_row.get("balance") or 0.0)
            # ③ 计算扣款（含 H4：余额不足时按实际可扣金额记账）
            if not internal and not is_free and cost > 0:
                cur = float(sub_row.get("balance") or 0.0)
                gift = float(sub_row.get("gift_balance") or 0.0)
                paid = float(sub_row.get("paid_balance") or 0.0)
                if cur <= 0:
                    blocked = True
                    cost = 0.0
                else:
                    actual = min(cur, cost)   # 实际可扣金额（余额不足则扣光，成本记实际值）
                    gift_spent = min(gift, actual)
                    new_gift = gift - gift_spent
                    leftover = actual - gift_spent
                    new_paid = max(0.0, paid - leftover)
                    balance_after = max(0.0, cur - actual)
                    cost = actual             # cost_yuan 记实际扣款（修复报表虚高）
            # ④ 写（与读同事务，消除丢失更新）
            if not internal and not is_free and not blocked and cost > 0:
                connection.execute(
                    "UPDATE subscriptions SET balance=?, gift_balance=?, paid_balance=?, updated_at=? WHERE subject=?",
                    (balance_after, new_gift, new_paid, now, subject),
                )
            elif not internal and is_free:
                # 免费事件仍计每日配额（quota_used 镜像，按 free_weight 累加），供 /me 展示与历史兼容
                connection.execute(
                    "UPDATE subscriptions SET quota_used = quota_used + ?, updated_at=? WHERE subject=?",
                    (fw, now, subject),
                )
            connection.execute(
                "INSERT INTO billing_events (id, subject, event_type, model, model_brand, tokens_in, tokens_out, tokens_cached, cost_yuan, platform_cost_yuan, free_weight, is_free, internal, balance_after, request_id, meta, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    event_id, subject, event_type, model or "", model_brand or "",
                    int(tokens_in or 0), int(tokens_out or 0), int(tokens_cached or 0), round(cost, 6), round(platform_cost, 6),
                    fw, 1 if is_free else 0, 1 if internal else 0, round(balance_after, 6),
                    request_id or "", meta or "", now,
                ),
            )
            connection.execute("COMMIT")
        free_remaining = self.free_events_remaining(subject) if not internal else None
        return {
            "status": "blocked" if blocked else "ok",
            "event_id": event_id,
            "event_type": event_type,
            "model": model,
            "model_brand": model_brand,
            "tokens_in": int(tokens_in or 0),
            "tokens_out": int(tokens_out or 0),
            "tokens_cached": int(tokens_cached or 0),
            "cost_yuan": round(cost, 6),
            "platform_cost_yuan": round(platform_cost, 6),
            "is_free": is_free,
            "internal": internal,
            "balance_after": round(balance_after, 6),
            "free_remaining": free_remaining,
            "free_weight": fw,
        }

    def get_events(self, subject: str, limit: int = 50, offset: int = 0) -> Dict:
        """GET /billing/events：当前主体的消耗明细（倒序，分页）。"""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM billing_events WHERE subject=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (subject, limit, offset),
            ).fetchall()
            total_row = connection.execute(
                "SELECT COUNT(*) AS c FROM billing_events WHERE subject=?", (subject,)
            ).fetchone()
        items = [
            {
                "id": r["id"],
                "event_type": r["event_type"],
                "model": r["model"],
                "model_brand": r["model_brand"],
                "tokens_in": r["tokens_in"],
                "tokens_out": r["tokens_out"],
                "tokens_cached": r["tokens_cached"],
                "cost_yuan": round(float(r["cost_yuan"] or 0), 6),
                "platform_cost_yuan": round(float(r["platform_cost_yuan"] or 0), 6),
                "is_free": bool(r["is_free"]),
                "internal": bool(r["internal"]),
                "balance_after": round(float(r["balance_after"] or 0), 6),
                "request_id": r["request_id"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
        return {"items": items, "total": total_row["c"] if total_row else 0, "limit": limit, "offset": offset}

    def is_banned(self, subject: str) -> bool:
        """黑名单拦截：subject 是否在生效中的封禁列表（banned_subjects.active=1）。"""
        if not subject:
            return False
        with self._connect() as connection:
            row = connection.execute(
                "SELECT 1 AS hit FROM banned_subjects WHERE subject=? AND active=1", (subject,)
            ).fetchone()
        return bool(row)

    def _get_user_map(self) -> Dict[str, dict]:
        """读 auth.sqlite3 的 users 表 → {id: {account, nickname, is_active, is_admin}}。

        users 表在独立的 auth 库（非 billing.sqlite3），报表需要跨库补账号信息时用。
        auth 库缺列 / 打不开时降级为空 dict（仅展示 subject，不带账号/昵称）。
        """
        try:
            auth_conn = sqlite3.connect(Path(__file__).resolve().parents[4] / "auth.sqlite3", timeout=30.0)
            auth_conn.row_factory = sqlite3.Row
            auth_conn.execute("PRAGMA busy_timeout=30000")
            rows = auth_conn.execute(
                "SELECT id, account, nickname, is_active, is_admin FROM users"
            ).fetchall()
            auth_conn.close()
            return {r["id"]: dict(r) for r in rows}
        except sqlite3.OperationalError:
            return {}

    def ban_subject(self, subject: str, reason: str, created_by: str) -> bool:
        """拉黑计费主体：写 banned_subjects；已存在则更新 reason/active=1。返回是否为新封禁。"""
        now = self._now()
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT 1 AS hit FROM banned_subjects WHERE subject=?", (subject,)
            ).fetchone()
            if existing:
                connection.execute(
                    "UPDATE banned_subjects SET reason=?, active=1, updated_at=?, created_by=? WHERE subject=?",
                    (reason, now, created_by, subject),
                )
                return False
            connection.execute(
                "INSERT INTO banned_subjects(subject, reason, active, created_by, created_at) VALUES(?,?,1,?,?)",
                (subject, reason, created_by, now),
            )
            return True

    def unban_subject(self, subject: str, created_by: str) -> bool:
        """解封计费主体：active=0 保留审计。返回是否存在该记录。"""
        now = self._now()
        with self._connect() as connection:
            cur = connection.execute(
                "UPDATE banned_subjects SET active=0, updated_at=? WHERE subject=?", (now, subject)
            )
            return cur.rowcount > 0

    def list_banned(self) -> List[Dict]:
        """管理员查看生效中的黑名单（含账号信息）。"""
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT b.subject, b.reason, b.created_at, b.created_by "
                "FROM banned_subjects b WHERE b.active=1 ORDER BY b.created_at DESC"
            ).fetchall()
        user_map = self._get_user_map()
        out = []
        for r in rows:
            item = {
                "subject": r["subject"],
                "reason": r["reason"] or "",
                "created_at": r["created_at"],
                "created_by": r["created_by"] or "",
                "account": "",
                "nickname": "",
            }
            if r["subject"].startswith("user:"):
                u = user_map.get(r["subject"][5:])
                if u:
                    item["account"] = u.get("account") or ""
                    item["nickname"] = u.get("nickname") or ""
            out.append(item)
        return out

    def get_admin_accounts_report(self, min_events: int = 0) -> Dict:
        """管理员账户报表（2026-08-30 反滥用）：按计费主体 + 模型拆分调用次数，用户/设备分开列出。

        - 每行 = subject × model × event_type 的聚合（内部核算事件 internal=1 不参与，仅统计用户实际调用）。
        - 用户主体(user:<id>) 额外 join users 表拿 account/nickname；设备主体(device:<id>) 保持匿名哈希。
        - 提供 free/paid 拆分与费用汇总，便于识别"恶意多次调用"（如超高频、单模型刷量）。
        """
        with self._connect() as connection:
            # 主体级摘要（每个 subject 总调用次数 / 花费 / 最近调用时间 / 是否免费为主）
            per_subject = connection.execute(
                "SELECT subject, COUNT(*) AS n, "
                "COALESCE(SUM(CASE WHEN is_free=1 THEN 1 ELSE 0 END),0) AS free_n, "
                "COALESCE(SUM(CASE WHEN is_free=0 THEN 1 ELSE 0 END),0) AS paid_n, "
                "COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout, "
                "COALESCE(SUM(cost_yuan),0) AS cost, "
                "COALESCE(SUM(platform_cost_yuan),0) AS plat_cost, "
                "MAX(created_at) AS last_at "
                "FROM billing_events WHERE internal=0 "
                "GROUP BY subject ORDER BY n DESC"
            ).fetchall()
            # subject × model 拆分
            per_model = connection.execute(
                "SELECT subject, model, COUNT(*) AS n, "
                "COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout, "
                "COALESCE(SUM(cost_yuan),0) AS cost "
                "FROM billing_events WHERE internal=0 "
                "GROUP BY subject, model ORDER BY n DESC"
            ).fetchall()
            # 用户账号对照（user:<id> → account/nickname/is_active/is_admin）
            # users 表在 auth.sqlite3（独立库），用 _get_user_map() 单独读取，避免跨库 JOIN。
            user_map: Dict[str, dict] = self._get_user_map()

        def decorate(subject: str, n: int, free_n: int, paid_n: int, tin: int, tout: int,
                     cost: float, plat_cost: float, last_at: str) -> Dict:
            kind = "user" if subject.startswith("user:") else "device"
            base: Dict = {
                "subject": subject,
                "kind": kind,
                "events": n,
                "free_events": int(free_n),
                "paid_events": int(paid_n),
                "tokens_in": int(tin),
                "tokens_out": int(tout),
                "cost_yuan": round(float(cost), 6),
                "platform_cost_yuan": round(float(plat_cost), 6),
                "last_at": last_at,
                "banned": self.is_banned(subject),
            }
            if kind == "user":
                uid = subject[len("user:"):]
                u = user_map.get(uid)
                base["account"] = u["account"] if u else ""
                base["nickname"] = u["nickname"] if u else ""
                base["is_active"] = bool(u["is_active"]) if u else False
                base["is_admin"] = bool(u["is_admin"]) if u else False
            else:
                base["account"] = ""
                base["nickname"] = ""
                base["is_active"] = True
                base["is_admin"] = False
            return base

        accounts = [decorate(r["subject"], r["n"], r["free_n"] or 0, r["paid_n"] or 0,
                             r["tin"] or 0, r["tout"] or 0, r["cost"] or 0, r["plat_cost"] or 0,
                             r["last_at"] or "") for r in per_subject]
        accounts = [a for a in accounts if min_events <= 0 or a["events"] >= min_events]

        # subject×model 折行，附着到对应账户
        model_rows = {}
        for r in per_model:
            model_rows.setdefault(r["subject"], []).append({
                "model": r["model"] or "unknown",
                "events": r["n"],
                "tokens_in": int(r["tin"] or 0),
                "tokens_out": int(r["tout"] or 0),
                "cost_yuan": round(float(r["cost"] or 0), 6),
            })
        for a in accounts:
            a["by_model"] = model_rows.get(a["subject"], [])

        total_events = sum(a["events"] for a in accounts)
        return {
            "total_accounts": len(accounts),
            "user_accounts": sum(1 for a in accounts if a["kind"] == "user"),
            "device_accounts": sum(1 for a in accounts if a["kind"] == "device"),
            "banned_accounts": sum(1 for a in accounts if a["banned"]),
            "total_events": total_events,
            "min_events": min_events,
            "accounts": accounts,
        }

    def get_usage_summary(self, subject: str) -> Dict:
        """GET /billing/me 补充：用户可见事件汇总（事件数 / 免费数 / 付费花费 / token / 免费剩余）。

        已花费(total_cost_yuan) 只统计用户真正扣钱的事件（is_free=0）：
        免费事件有名义成本（平台真实支出）但不计费，不能算进用户"已花费"（否则免费额度内会虚增金额）。
        """
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS n, "
                "COALESCE(SUM(CASE WHEN is_free=0 THEN cost_yuan ELSE 0 END),0) AS cost, "
                "COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout "
                "FROM billing_events WHERE subject=? AND internal=0",
                (subject,),
            ).fetchone()
            free = connection.execute(
                "SELECT COUNT(*) AS c FROM billing_events WHERE subject=? AND internal=0 AND is_free=1", (subject,)
            ).fetchone()["c"]
        n = row["n"] if row else 0
        return {
            "events": n,
            "free_events": free,
            "paid_events": n - free,
            "total_cost_yuan": round(float(row["cost"] or 0), 6),
            "tokens_in": int(row["tin"] or 0),
            "tokens_out": int(row["tout"] or 0),
            "free_remaining": self.free_events_remaining(subject),
        }

    def get_ops_report(self) -> Dict:
        """GET /billing/admin/report：运营报表（收入 / 用户消耗 / 平台成本 / 毛利 / ARPU / 按模型·事件拆分）。"""
        with self._connect() as connection:
            user = connection.execute(
                "SELECT COUNT(DISTINCT subject) AS users, COALESCE(SUM(cost_yuan),0) AS cost, "
                "COALESCE(SUM(platform_cost_yuan),0) AS plat_cost, COUNT(*) AS n "
                "FROM billing_events WHERE internal=0",
            ).fetchone()
            plat = connection.execute(
                "SELECT COALESCE(SUM(platform_cost_yuan),0) AS cost, COUNT(*) AS n FROM billing_events WHERE internal=1"
            ).fetchone()
            rev = connection.execute(
                "SELECT COALESCE(SUM(amount),0) AS amt FROM usage_ledger WHERE amount > 0"
            ).fetchone()
            by_model = connection.execute(
                "SELECT model, COALESCE(SUM(platform_cost_yuan),0) AS cost, COALESCE(SUM(tokens_in),0) AS tin, "
                "COALESCE(SUM(tokens_out),0) AS tout, COUNT(*) AS n FROM billing_events GROUP BY model ORDER BY cost DESC"
            ).fetchall()
            by_event = connection.execute(
                "SELECT event_type, COALESCE(SUM(platform_cost_yuan),0) AS cost, COUNT(*) AS n FROM billing_events GROUP BY event_type ORDER BY cost DESC"
            ).fetchall()
            # 充值统计（usage_ledger event_type=recharge）
            recharge = connection.execute(
                "SELECT COUNT(*) AS n, COUNT(DISTINCT subject) AS users, COALESCE(SUM(amount),0) AS amt "
                "FROM usage_ledger WHERE event_type='recharge'"
            ).fetchone()
            # 首充券统计
            coupons = connection.execute(
                "SELECT COUNT(*) AS total, "
                "COALESCE(SUM(CASE WHEN status='used' THEN 1 ELSE 0 END),0) AS used_n, "
                "COALESCE(SUM(CASE WHEN status='used' THEN amount ELSE 0 END),0) AS used_amt "
                "FROM coupons"
            ).fetchone()
            # 免费/付费事件 + 付费用户
            evs = connection.execute(
                "SELECT COALESCE(SUM(CASE WHEN is_free=1 THEN 1 ELSE 0 END),0) AS free_n, "
                "COALESCE(SUM(CASE WHEN is_free=0 THEN 1 ELSE 0 END),0) AS paid_n "
                "FROM billing_events WHERE internal=0"
            ).fetchone()
            paid_users = connection.execute(
                "SELECT COUNT(DISTINCT subject) AS n FROM billing_events WHERE internal=0 AND is_free=0"
            ).fetchone()
            # 近 7 天每日充值（升序）
            daily = connection.execute(
                "SELECT substr(created_at,1,10) AS d, COALESCE(SUM(amount),0) AS amt "
                "FROM usage_ledger WHERE event_type='recharge' GROUP BY d ORDER BY d ASC LIMIT 7"
            ).fetchall()
        users = user["users"] if user else 0
        revenue = float(rev["amt"] or 0) if rev else 0.0
        user_cost = float(user["cost"] or 0) if user else 0.0
        user_plat = float(user["plat_cost"] or 0) if user else 0.0
        plat_cost = float(plat["cost"] or 0) if plat else 0.0
        rc = recharge if recharge else {"n": 0, "users": 0, "amt": 0.0}
        cp = coupons if coupons else {"total": 0, "used_n": 0, "used_amt": 0.0}
        ev = evs if evs else {"free_n": 0, "paid_n": 0}
        pu = paid_users["n"] if paid_users else 0
        return {
            "total_revenue_yuan": round(revenue, 2),
            "user_charge_yuan": round(user_cost, 6),           # 用户已付（售价口径）
            "platform_cost_yuan": round(user_plat + plat_cost, 6),  # 平台真实成本（对话+卡片）
            "gross_profit_yuan": round(revenue - user_plat - plat_cost, 6),
            "active_users": users,
            "user_events": user["n"] if user else 0,
            "internal_events": plat["n"] if plat else 0,
            "arpu_yuan": round(revenue / users, 2) if users else 0.0,
            "recharge_count": rc["n"],
            "recharge_users": rc["users"],
            "recharge_amount_yuan": round(float(rc["amt"] or 0), 2),
            "coupon_issued": cp["total"],
            "coupon_used": cp["used_n"],
            "coupon_used_amount_yuan": round(float(cp["used_amt"] or 0), 2),
            "free_events": ev["free_n"],
            "paid_events": ev["paid_n"],
            "paid_users": pu,
            "pay_rate": round(pu / users, 4) if users else 0.0,  # 付费用户占比（口径：产生过扣费事件）
            "daily_recharge": [
                {"date": r["d"], "amount_yuan": round(float(r["amt"] or 0), 2)} for r in daily
            ],
            "by_model": [
                {"model": r["model"] or "unknown", "cost_yuan": round(float(r["cost"]), 6),
                 "tokens_in": int(r["tin"] or 0), "tokens_out": int(r["tout"] or 0), "events": r["n"]}
                for r in by_model
            ],
            "by_event": [
                {"event_type": r["event_type"], "cost_yuan": round(float(r["cost"]), 6), "events": r["n"]}
                for r in by_event
            ],
        }


_subscription_service = SubscriptionService()
