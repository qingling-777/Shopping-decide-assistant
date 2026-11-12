"""对话历史持久化（登录用户维度）。

设计（2026-08-26）：会话历史不再只存浏览器 localStorage——登录用户的历史存
chat_history.sqlite3（与 auth.sqlite3 同级），key 为 `user:<user_id>`；
匿名用户仍走前端 localStorage（设备维度、跨会话跟随本机）。

- 同一会话 upsert 覆盖（前端每次消息变化全量保存，幂等）。
- 列表按 updated_at 倒序；单条含完整 messages（供切换会话恢复）。
- 删除按 session_id 精确删除；clear 清空该用户全部。
- 未登录调用方（匿名）由路由层 401 拦截，本服务只处理 user 主体。
"""

import sqlite3
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

_DB_PATH = Path(__file__).resolve().parents[4] / "chat_history.sqlite3"


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
            CREATE TABLE IF NOT EXISTS chat_sessions (
                subject      TEXT NOT NULL,          -- user:<user_id>
                session_id   TEXT NOT NULL,
                title        TEXT NOT NULL DEFAULT '',
                messages     TEXT NOT NULL,          -- JSON: [{role, content, cards?, cardHint?, usage?...}]
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL,
                PRIMARY KEY (subject, session_id)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chat_sessions_subject ON chat_sessions(subject, updated_at)")
        conn.commit()


_init()


def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def list_sessions(subject: str, limit: int = 200) -> List[Dict]:
    """会话列表（不含 messages，节省流量）：id/title/created_at/updated_at。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT session_id, title, created_at, updated_at FROM chat_sessions "
            "WHERE subject=? ORDER BY updated_at DESC LIMIT ?",
            (subject, int(limit)),
        ).fetchall()
    return [
        {
            "id": r["session_id"],
            "title": r["title"] or "",
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
        }
        for r in rows
    ]


def get_session(subject: str, session_id: str) -> Optional[Dict]:
    """单会话详情（含完整 messages）。"""
    with _connect() as conn:
        row = conn.execute(
            "SELECT session_id, title, messages, created_at, updated_at FROM chat_sessions "
            "WHERE subject=? AND session_id=?",
            (subject, session_id),
        ).fetchone()
    if not row:
        return None
    try:
        messages = json.loads(row["messages"]) if row["messages"] else []
    except Exception:
        messages = []
    return {
        "id": row["session_id"],
        "title": row["title"] or "",
        "messages": messages,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def upsert_session(subject: str, session_id: str, title: str, messages: List[Dict]) -> None:
    """全量保存会话（幂等 upsert）。messages 需为可 JSON 序列化结构。"""
    now = _now()
    try:
        payload = json.dumps(messages, ensure_ascii=False, default=str)
    except Exception:
        payload = "[]"
    with _connect() as conn:
        existing = conn.execute(
            "SELECT created_at FROM chat_sessions WHERE subject=? AND session_id=?",
            (subject, session_id),
        ).fetchone()
        created = existing["created_at"] if existing else now
        conn.execute(
            "INSERT OR REPLACE INTO chat_sessions (subject, session_id, title, messages, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (subject, session_id, (title or "")[:120], payload, created, now),
        )
        conn.commit()


def delete_session(subject: str, session_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM chat_sessions WHERE subject=? AND session_id=?",
            (subject, session_id),
        )
        conn.commit()
        return cur.rowcount > 0


def clear_sessions(subject: str) -> int:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM chat_sessions WHERE subject=?", (subject,))
        conn.commit()
        return cur.rowcount
