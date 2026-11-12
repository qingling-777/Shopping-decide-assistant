"""B 档：商品需求热度（真·销量/价格趋势）时间序列层。

数据来源：好单库（union_service 在每次搜索后把当日快照写入本库）。
存储：trends.sqlite3（与 auth.sqlite3 同级），表 product_snapshots 按 (date, itemid) 幂等 upsert，
即「同一商品每天一条」，跨天自然形成时间序列。无好单库 key / 无历史时所有查询返回空，调用方降级。

合规：序列来自好单库聚合的选品线索（月销/券后价/佣金），对外称「好单库销量/价格趋势」，
不得声称是平台真实成交数据（见 crawler_service 合规说明）。
"""

import sqlite3
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional

_DB_PATH = Path(__file__).resolve().parents[4] / "trends.sqlite3"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=30000')
    return conn


def _init() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_snapshots (
                date             TEXT NOT NULL,
                itemid           TEXT NOT NULL,
                title            TEXT,
                sales            REAL,
                price            REAL,
                commission_ratio REAL,
                keyword          TEXT,
                PRIMARY KEY (date, itemid)
            )
            """
        )


_init()


def record_leads(keyword: str, leads: List[Dict]) -> int:
    """把一次搜索返回的商品线索写成「当日快照」。同一 (date,itemid) 重复写入会覆盖（幂等）。

    历史如何积累：商家每次用某关键词选品 → union_service 调本函数 → 该日每个 itemid 一条；
    跨天再搜 → 新日期一条 → 时间序列自然长出来。后台轮询（main.py）则保证无用户活动时也更新。
    """
    today = date.today().isoformat()
    count = 0
    with _connect() as conn:
        for l in leads:
            iid = l.get("itemid")
            if not iid:
                continue  # 没 itemid 无法做同商品追踪，跳过
            conn.execute(
                "INSERT OR REPLACE INTO product_snapshots "
                "(date, itemid, title, sales, price, commission_ratio, keyword) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    today,
                    str(iid),
                    (l.get("context") or "")[:120],
                    l.get("sales"),
                    l.get("price_value"),
                    l.get("commission_ratio"),
                    keyword or "",
                ),
            )
            count += 1
    return count


def get_product_trend(itemid: str, days: int = 30) -> List[Dict]:
    """单个商品的销量/价格随时间变化（真·需求走向）。"""
    since = (date.today() - timedelta(days=days)).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT date, itemid, title, sales, price, commission_ratio "
            "FROM product_snapshots WHERE itemid = ? AND date >= ? ORDER BY date",
            (str(itemid), since),
        ).fetchall()
    return [dict(r) for r in rows]


def get_keyword_trend(keyword: str, days: int = 30) -> List[Dict]:
    """某关键词（如『防晒』）按日的聚合趋势：每日在售商品数、月销合计、均价、平均佣金。"""
    since = (date.today() - timedelta(days=days)).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT date, COUNT(*) AS products, SUM(sales) AS total_sales, "
            "AVG(price) AS avg_price, AVG(commission_ratio) AS avg_commission "
            "FROM product_snapshots WHERE keyword = ? AND date >= ? "
            "GROUP BY date ORDER BY date",
            (keyword, since),
        ).fetchall()
    return [dict(r) for r in rows]


def distinct_keywords(limit: int = 20) -> List[str]:
    """后台轮询用：取最近出现过的去重关键词。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT keyword FROM product_snapshots WHERE keyword <> '' "
            "ORDER BY MAX(date) DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [r["keyword"] for r in rows]


def format_trend_for_ai(keyword: str, days: int = 30) -> str:
    """把关键词趋势压成一段文本，注入 AI system prompt，让模型据此『解释数据』。"""
    series = get_keyword_trend(keyword, days)
    if not series:
        return ""
    lines = []
    for r in series:
        ts = int(r["total_sales"] or 0)
        price = f"均价¥{r['avg_price']:.0f}" if r["avg_price"] else "均价-"
        lines.append(f"{r['date']}: 在售{r['products']}款, 月销合计{ts}, {price}")
    first, last = series[0], series[-1]
    f_sales = first["total_sales"] or 0
    l_sales = last["total_sales"] or 0
    pct = f"{(l_sales - f_sales) / f_sales * 100:+.0f}%" if f_sales else "N/A"
    header = f"\n\n[趋势数据（好单库聚合，{keyword}，近{days}天，按日快照）]\n"
    body = "\n".join(lines)
    summary = (
        f"\n首日→末日：在售商品数 {first['products']}→{last['products']}款，"
        f"月销合计 {int(f_sales)}→{int(l_sales)}（{pct}）"
    )
    return header + body + summary
