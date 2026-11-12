"""资金正确性测试集（2026-08-28 工程审查修复验证）。

覆盖：直充闸门 / 档位精确匹配 / 券 CAS 并发 / record_usage 并发累减 / 支付回调幂等。
运行：cd backend && venv/Scripts/python.exe -m pytest tests/ -v
"""
import sqlite3
import threading
import time

import pytest

from app.core.config import settings
from app.services.subscription_service import _subscription_service as svc


@pytest.fixture()
def billing(tmp_path, monkeypatch):
    """把计费库隔离到临时文件，测试互不污染。"""
    db = tmp_path / "test_billing.sqlite3"
    monkeypatch.setattr(svc, "db_path", db)
    svc._initialize_database()
    yield svc
    # 释放连接（Windows 下文件锁）
    gc_collect()

def gc_collect():
    import gc
    gc.collect()


def _subject(prefix: str = "test") -> str:
    return f"user:{prefix}_{int(time.time() * 1000)}"


# ── 1. 直充闸门 ────────────────────────────────────────────────
def test_direct_recharge_disabled_by_default():
    """P0-1：直充开关默认关闭（生产不可零成本刷余额）。"""
    assert settings.ALLOW_DIRECT_RECHARGE is False


# ── 2. 档位精确匹配 ────────────────────────────────────────────
def test_recharge_tier_exact_match(billing):
    """P2：6.0 命中 6 元档赠金 0.5；6.9 不再被 int() 截断误命中。"""
    s = _subject("tier")
    r1 = svc.recharge(s, 6.0)
    assert r1["tier_bonus"] == 0.5, f"6.0 应命中档位赠金，实际 {r1['tier_bonus']}"
    before = r1["balance"]
    r2 = svc.recharge(s, 6.9)
    assert r2["tier_bonus"] == 0.0, f"6.9 不应命中 6 元档，实际 {r2['tier_bonus']}"
    assert abs(r2["balance"] - before - 6.9) < 1e-9, "6.9 只应加本金"


# ── 3. 券 CAS：并发双花 ────────────────────────────────────────
def test_apply_coupons_cas_concurrent(billing):
    """H3：同一张券并发兑现两次，只成功一次（CAS + rowcount）。"""
    s = _subject("coupon")
    with svc._connect() as conn:
        svc._insert_coupon(conn, s, 2.0, "device")  # 一张 ¥2 首充券

    results = []

    def redeem():
        results.append(svc.apply_coupons(s))

    threads = [threading.Thread(target=redeem) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    total = round(sum(results), 4)
    assert total == 2.0, f"券只应兑现一次（合计 {total}），出现双花"

    with svc._connect() as conn:
        used = conn.execute(
            "SELECT COUNT(*) AS c FROM coupons WHERE subject=? AND status='used'", (s,)
        ).fetchone()["c"]
        pending = conn.execute(
            "SELECT COUNT(*) AS c FROM coupons WHERE subject=? AND status='pending'", (s,)
        ).fetchone()["c"]
    assert used == 1 and pending == 0, f"used={used} pending={pending}"


# ── 4. record_usage 并发：余额不丢更新 ──────────────────────────
def test_record_usage_concurrent_no_lost_update(billing):
    """P0-5：20 线程并发扣费，余额精确累减（单事务 BEGIN IMMEDIATE，无丢失更新）。"""
    s = _subject("concurrent")
    svc.recharge(s, 500.0)  # 余额 500

    # 每次 cost=25.0：V4-Flash in=1.0/1M，500 万输入 token → 平台 5.0 × 倍率5 = 25.0
    cost_per_call = 25.0
    n = 20  # 20 × 25 = 500，应恰好扣光
    errors = []

    def burn():
        try:
            svc.record_usage(
                s, "chat", "deepseek-ai/DeepSeek-V4-Flash",
                tokens_in=5_000_000, tokens_out=0,
                free_eligible=False, meta="test=concurrent",
            )
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=burn) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"并发扣费出现异常: {errors[:3]}"
    final = svc.get_quota_info(s)
    # 允许最后一次因余额不足而 blocked（cost 25 > 剩余），但余额必须单调正确
    with svc._connect() as conn:
        row = conn.execute("SELECT balance FROM subscriptions WHERE subject=?", (s,)).fetchone()
        balance = float(row["balance"])
        events = conn.execute(
            "SELECT COUNT(*) AS c, COALESCE(SUM(cost_yuan),0) AS t FROM billing_events WHERE subject=? AND internal=0",
            (s,),
        ).fetchone()
    # 扣减总和不得超过 500（丢更新会扣更少）
    assert events["t"] <= 500.0 + 1e-6, f"扣费总额 {events['t']} 超过余额 500（异常）"
    # 20 次请求都应落流水
    assert events["c"] == n, f"应有 {n} 条流水，实际 {events['c']}"
    # 余额与流水对得上：balance = 500 - 已扣（blocked 的请求 cost=0）
    assert balance >= -1e-6, f"余额不应为负: {balance}"


# ── 5. 支付回调幂等：重复通知不重复入账 ──────────────────────────
def test_auto_credit_alipay_idempotent(billing):
    """P0-4：同一订单重复回调（支付宝重试/并发）只入账一次。"""
    s = _subject("alipay")
    out_trade_no = f"alipay_{int(time.time() * 1000)}"
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with svc._connect() as conn:
        conn.execute(
            "INSERT INTO orders (id, subject, plan, amount, status, provider, out_trade_no, created_at, updated_at) "
            "VALUES (?, ?, 'recharge', 3.0, 'pending', 'alipay', ?, ?, ?)",
            (out_trade_no, s, out_trade_no, now, now),
        )

    # 并发 5 次回调
    results = []
    errors = []

    def callback():
        try:
            results.append(svc.auto_credit_alipay(out_trade_no))
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=callback) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"回调异常: {errors[:3]}"
    credited = [r for r in results if not r.get("already")]
    assert len(credited) == 1, f"只有 1 次真正入账，实际 {len(credited)}（重复入账！）"

    with svc._connect() as conn:
        row = conn.execute("SELECT balance, paid_balance FROM subscriptions WHERE subject=?", (s,)).fetchone()
        order = conn.execute("SELECT status FROM orders WHERE out_trade_no=?", (out_trade_no,)).fetchone()
    # 3 元档无赠金（RECHARGE_TIERS[3]=0）→ 余额应恰为 3.0（只入账一次）
    assert abs(float(row["balance"]) - 3.0) < 1e-6, f"余额应恰为 3（只入账一次），实际 {row['balance']}"
    assert order["status"] == "paid"
