"""方向追踪（2026-08-26）：把选品「方向」加入追踪，记录信号随时间变化。

设计（方案 A + 可视化时间变化）：
- 追踪的是「方向/品类」（如"口红""防晒"），不是单个商品——区别于候选池的「商品」语义。
- 存 SQLite（tracked_directions.sqlite3），key = `user:<user_id>`（登录维度，跨设备跟随）。
- 每次「加入追踪」写一条 tracked_directions 记录 + 当日信号快照 tracked_snapshots。
- 查看追踪列表时，后端拉该方向的好单库趋势序列（trend_service.get_keyword_trend），
  前端用折线图展示月销/款数/均价/佣金随时间变化。
- 匿名不追踪（路由 401），前端按钮仅登录可见/可点。
"""

import sqlite3
import json
from datetime import datetime, date
from pathlib import Path
from typing import Dict, List, Optional

_DB_PATH = Path(__file__).resolve().parents[4] / "tracked_directions.sqlite3"


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
            CREATE TABLE IF NOT EXISTS tracked_directions (
                subject     TEXT NOT NULL,          -- user:<user_id>
                direction   TEXT NOT NULL,          -- 方向名（如 口红）
                keyword     TEXT NOT NULL DEFAULT '',-- 用于趋势检索的关键词
                added_at    TEXT NOT NULL,
                PRIMARY KEY (subject, direction)
            )
            """
        )
        # 信号快照：每次加入/刷新记录当日聚合信号，用于跨天对比
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tracked_snapshots (
                subject     TEXT NOT NULL,
                direction   TEXT NOT NULL,
                snap_date   TEXT NOT NULL,
                products    REAL,
                total_sales REAL,
                avg_price   REAL,
                avg_commission REAL,
                PRIMARY KEY (subject, direction, snap_date)
            )
            """
        )
        conn.commit()


_init()


def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def add(subject: str, direction: str, keyword: str = "") -> bool:
    """加入追踪（幂等 upsert）。keyword 缺省用 direction 本身。"""
    kw = (keyword or direction).strip()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT OR REPLACE INTO tracked_directions (subject, direction, keyword, added_at) "
            "VALUES (?, ?, ?, ?)",
            (subject, direction.strip(), kw, _now()),
        )
        conn.commit()
        return cur.rowcount > 0


def remove(subject: str, direction: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM tracked_directions WHERE subject=? AND direction=?",
            (subject, direction.strip()),
        )
        conn.commit()
        return cur.rowcount > 0


def list_directions(subject: str) -> List[Dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT direction, keyword, added_at FROM tracked_directions "
            "WHERE subject=? ORDER BY added_at DESC",
            (subject,),
        ).fetchall()
    return [
        {"direction": r["direction"], "keyword": r["keyword"] or r["direction"], "addedAt": r["added_at"]}
        for r in rows
    ]


def has(subject: str, direction: str) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM tracked_directions WHERE subject=? AND direction=?",
            (subject, direction.strip()),
        ).fetchone()
        return row is not None


def record_snapshot(subject: str, direction: str, signals: Dict) -> None:
    """把一次搜索的聚合信号写成当日快照（幂等）。signals 字段：products/total_sales/avg_price/avg_commission。"""
    today = date.today().isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO tracked_snapshots "
            "(subject, direction, snap_date, products, total_sales, avg_price, avg_commission) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                subject,
                direction.strip(),
                today,
                signals.get("products"),
                signals.get("total_sales"),
                signals.get("avg_price"),
                signals.get("avg_commission"),
            ),
        )
        conn.commit()


def get_snapshots(subject: str, direction: str, days: int = 60) -> List[Dict]:
    from datetime import timedelta
    since = (date.today() - timedelta(days=days)).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT snap_date, products, total_sales, avg_price, avg_commission "
            "FROM tracked_snapshots WHERE subject=? AND direction=? AND snap_date >= ? ORDER BY snap_date",
            (subject, direction.strip(), since),
        ).fetchall()
    return [
        {
            "date": r["snap_date"],
            "products": r["products"],
            "total_sales": r["total_sales"],
            "avg_price": r["avg_price"],
            "avg_commission": r["avg_commission"],
        }
        for r in rows
    ]
