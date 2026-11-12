"""用户反馈（意见反馈）服务：存储 + 管理员列表/处理。

- 用户侧：POST /api/v1/feedback（subject 由后端从请求头自动解析 user:/device:，不依赖用户填写）
- 管理员侧：GET /api/v1/feedback/admin/feedbacks、POST /api/v1/feedback/admin/feedbacks/{id}/handle
- 落 SQLite（feedback.sqlite3），与订阅库隔离。
"""

import secrets
import sqlite3
import time
from pathlib import Path
from typing import Dict, List, Optional


class FeedbacksService:
    def __init__(self):
        self.db_path = Path(__file__).resolve().parents[4] / "feedback.sqlite3"
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA busy_timeout=30000')
        return connection

    def _initialize_database(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS feedbacks (
                    id          TEXT PRIMARY KEY,
                    subject     TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    contact     TEXT,
                    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | handled
                    created_at  TEXT NOT NULL,
                    handled_at  TEXT,
                    handler     TEXT
                )
                """
            )

    def submit(self, subject: str, content: str, contact: Optional[str] = None) -> Dict:
        """用户提交反馈。content 必填；contact 选填（便于管理员回复）。"""
        content = (content or "").strip()
        if not content:
            raise ValueError("反馈内容不能为空")
        if len(content) > 2000:
            content = content[:2000]
        contact = (contact or "").strip() or None
        if contact and len(contact) > 200:
            contact = contact[:200]
        feedback_id = secrets.token_hex(8)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO feedbacks (id, subject, content, contact, status, created_at) VALUES (?,?,?,?,?,?)",
                (feedback_id, subject, content, contact, "pending", now),
            )
        return {
            "id": feedback_id,
            "subject": subject,
            "content": content,
            "contact": contact,
            "status": "pending",
            "created_at": now,
        }

    def list(self, status: Optional[str] = None) -> List[Dict]:
        with self._connect() as connection:
            if status:
                rows = connection.execute(
                    "SELECT * FROM feedbacks WHERE status=? ORDER BY created_at DESC", (status,)
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM feedbacks ORDER BY created_at DESC"
                ).fetchall()
        return [dict(r) for r in rows]

    def mark_handled(self, feedback_id: str, admin_id: str) -> Dict:
        """管理员标记反馈为已处理（pending → handled）。"""
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM feedbacks WHERE id=?", (feedback_id,)).fetchone()
            if not row:
                raise ValueError("反馈不存在")
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            connection.execute(
                "UPDATE feedbacks SET status='handled', handled_at=?, handler=? WHERE id=?",
                (now, admin_id, feedback_id),
            )
        return {"id": feedback_id, "status": "handled", "handled_at": now, "handler": admin_id}


_feedback_service = FeedbacksService()
