import base64
import hashlib
import hmac
import json
import secrets
import smtplib
import sqlite3
import time
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr
from pathlib import Path
from typing import Dict, Optional

from app.core.config import settings


class AuthService:
    def __init__(self):
        self.db_path = Path(__file__).resolve().parents[4] / "auth.sqlite3"
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        # 某些本地磁盘/挂载环境对 WAL 支持不稳定，避免后端因初始化阶段的 PRAGMA 直接退出。
        try:
            connection.execute('PRAGMA journal_mode=WAL')
        except sqlite3.OperationalError:
            pass
        connection.execute('PRAGMA busy_timeout=30000')
        return connection

    def _initialize_database(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    account TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    nickname TEXT,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )
                """
            )
            # 管理员标记（兼容旧库：列已存在时 ALTER 会报 OperationalError，忽略即可）
            try:
                connection.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
            except sqlite3.OperationalError:
                pass
            # 邀请码（全局唯一，用于邀请奖励）
            try:
                connection.execute("ALTER TABLE users ADD COLUMN referral_code TEXT")
            except sqlite3.OperationalError:
                pass
            # 邮箱已验证标记（0=未验证 1=已验证；纯手机号账号恒 0，不参与邮箱验证）
            try:
                connection.execute("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0")
            except sqlite3.OperationalError:
                pass
            # 邮箱实名（独立绑定于登录账号，用于找回密码；可为空=未绑定）
            try:
                connection.execute("ALTER TABLE users ADD COLUMN email TEXT")
            except sqlite3.OperationalError:
                pass
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)")
            # 邮箱实名唯一（NULL 不参与唯一冲突，允许多个未绑定账号）
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
            # 回写：没有邀请码、或仍残留"账号即邀请码"旧方案（referral_code==账号）的用户，
            # 统一补成随机固定邀请码（8 位 hex，全局唯一）。逐行生成+提交，碰撞重试。
            rows = connection.execute(
                "SELECT id FROM users WHERE referral_code IS NULL OR LOWER(referral_code) = LOWER(account)"
            ).fetchall()
            for r in rows:
                try:
                    connection.execute("UPDATE users SET referral_code = ? WHERE id = ?", (self._gen_referral_code(), r["id"]))
                    connection.commit()
                except sqlite3.IntegrityError:
                    try:
                        connection.execute("UPDATE users SET referral_code = ? WHERE id = ?", (self._gen_referral_code(), r["id"]))
                        connection.commit()
                    except sqlite3.IntegrityError:
                        pass
            # 密码找回验证码表：账号维度，单条覆盖（重复申请刷新验证码）
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS password_resets (
                    account TEXT PRIMARY KEY,
                    code_hash TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
                """
            )
            # 邮箱验证码表：账号维度，单条覆盖（重复发码刷新验证码 + 冷却倒计时）
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS email_verifies (
                    account TEXT PRIMARY KEY,
                    code_hash TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    sent_at INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
                """
            )

    @staticmethod
    def normalize_account(account: str) -> str:
        return account.strip().lower()

    @staticmethod
    def _hash_password(password: str, salt: Optional[bytes] = None) -> str:
        salt = salt or secrets.token_bytes(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 240_000)
        return f"pbkdf2_sha256$240000${salt.hex()}${digest.hex()}"

    @staticmethod
    def _verify_password(password: str, encoded: str) -> bool:
        try:
            algorithm, iterations, salt_hex, digest_hex = encoded.split("$", 3)
            if algorithm != "pbkdf2_sha256":
                return False
            salt = bytes.fromhex(salt_hex)
            expected = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iterations))
            return hmac.compare_digest(expected.hex(), digest_hex)
        except (ValueError, TypeError):
            return False

    def _gen_referral_code(self) -> str:
        # 随机固定邀请码：注册时生成一次、之后不变；8 位 hex，全局唯一（碰撞则重抽）。
        while True:
            code = secrets.token_hex(4).upper()
            if not self.get_user_by_referral_code(code):
                return code

    def create_user(self, account: str, password: str, nickname: Optional[str] = None) -> Dict:
        account = self.normalize_account(account)
        with self._connect() as connection:
            if connection.execute("SELECT 1 FROM users WHERE account = ?", (account,)).fetchone():
                raise ValueError("账号已注册")
        user_id = secrets.token_hex(16)
        # 邀请码：随机生成一次、之后固定不变（好友注册时填此码，邀请人得 ¥5）
        referral_code = self._gen_referral_code()
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        # 昵称未填 → 随机分配（如「用户_8F3A2B」），保证登录后有展示名
        display_nickname = (nickname or "").strip() or self._random_nickname()
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO users (id, account, password_hash, nickname, created_at, referral_code) VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, account, self._hash_password(password), display_nickname, created_at, referral_code),
            )
        return {"id": user_id, "account": account, "nickname": display_nickname, "created_at": created_at, "referral_code": referral_code}

    @staticmethod
    def _random_nickname() -> str:
        """随机分配昵称：中文前缀 + 4 位 hex，避免重复且可读。"""
        return f"用户_{secrets.token_hex(2).upper()}"

    def get_user_by_referral_code(self, code: str) -> Optional[Dict]:
        if not code:
            return None
        # 随机 hex 邀请码，按大写精确匹配（好友输入大小写均可）
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, account, nickname, is_admin, email_verified, email, created_at FROM users WHERE referral_code = ? AND is_active = 1",
                (code.strip().upper(),),
            ).fetchone()
        return self._public_user(row) if row else None

    def get_referral_code(self, user_id: str) -> Optional[str]:
        with self._connect() as connection:
            row = connection.execute("SELECT referral_code FROM users WHERE id = ? AND is_active = 1", (user_id,)).fetchone()
        return row["referral_code"] if row else None

    def get_user_by_account(self, account: str) -> Optional[Dict]:
        """按账号（邮箱/手机号）取公开用户；不存在或未激活返回 None。"""
        account = self.normalize_account(account)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, account, nickname, is_admin, email_verified, email, created_at FROM users WHERE account = ? AND is_active = 1",
                (account,),
            ).fetchone()
        return self._public_user(row) if row else None

    def authenticate(self, account: str, password: str) -> Optional[Dict]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, account, password_hash, nickname, is_admin, email_verified, email, created_at FROM users WHERE account = ? AND is_active = 1",
                (self.normalize_account(account),),
            ).fetchone()
        if not row or not self._verify_password(password, row["password_hash"]):
            return None
        return self._public_user(row)

    @staticmethod
    def _public_user(row) -> Dict:
        # email_verified 列可能不存在于旧库（ALTER 失败），用 row.keys() 判断
        ev = row["email_verified"] if "email_verified" in row.keys() else 0
        # email（邮箱实名）列可能不存在于旧库
        email = row["email"] if "email" in row.keys() else None
        return {
            "id": row["id"],
            "account": row["account"],
            "nickname": row["nickname"],
            "is_admin": bool(row["is_admin"]),
            "email_verified": bool(ev),
            "email": email,
            "created_at": row["created_at"],
        }

    def get_user_by_email(self, email: str) -> Optional[Dict]:
        """按绑定邮箱实名查用户（找回密码用）。邮箱不存在或未激活返回 None。"""
        email = self.normalize_account(email)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, account, nickname, email, is_admin, email_verified, created_at FROM users WHERE email = ? AND is_active = 1",
                (email,),
            ).fetchone()
        return self._public_user(row) if row else None

    # ─────────────────────────────────────────
    # 密码找回（验证码机制；支持「登录账号 或 绑定邮箱实名」发起，验证码优先投递绑定邮箱）
    # ─────────────────────────────────────────

    def _find_user_by_account_or_email(self, query: str) -> Optional[Dict]:
        """按登录账号 或 绑定邮箱实名 查找用户（找回密码用，支持两种标识）。"""
        q = self.normalize_account(query)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, account, nickname, email, is_admin, email_verified, created_at FROM users WHERE account = ? AND is_active = 1",
                (q,),
            ).fetchone()
            if not row:
                row = connection.execute(
                    "SELECT id, account, nickname, email, is_admin, email_verified, created_at FROM users WHERE email = ? AND is_active = 1",
                    (q,),
                ).fetchone()
        return self._public_user(row) if row else None

    def request_password_reset(self, query: str) -> str:
        """申请密码找回：生成 6 位验证码并「发送」。

        入参可以是登录账号 或 绑定的邮箱实名。返回 'ok' 无论是否存在（防枚举），
        仅当匹配到真实用户才生成/存储/投递验证码。验证码统一以「登录账号」为键存储，
        投递优先发往绑定邮箱实名，其次按账号本身是否含 @ 判断邮箱/手机，
        否则降到服务端日志（演示/联调）。生产应接入邮件/短信通道，见 `_send_reset_code`。
        """
        query = self.normalize_account(query)
        user = self._find_user_by_account_or_email(query)
        if not user:
            return "ok"  # 账号不存在：静默返回，不泄露是否存在
        lookup_account = user["account"]  # 统一以登录账号为 password_resets 键
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_at = int(time.time()) + settings.AUTH_RESET_CODE_EXPIRE_SECONDS
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO password_resets (account, code_hash, expires_at, attempts, created_at) "
                "VALUES (?, ?, ?, 0, ?) "
                "ON CONFLICT(account) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, created_at=excluded.created_at",
                (lookup_account, self._hash_password(code), expires_at, created_at),
            )
        self._send_reset_code(user, code)
        return "ok"

    def is_email(self, account: str) -> bool:
        """是否为邮箱账号（含 @）。纯手机号账号不参与邮箱验证。"""
        return "@" in account

    def _send_email(self, to: str, subject: str, body: str) -> bool:
        """经 SMTP 真实发送邮件；未配置 SMTP 或发送失败返回 False。

        配置了 SMTP_HOST + SMTP_USER + SMTP_PASSWORD 时走真实投递（QQ/163 用授权码），
        否则降级为打印到服务端控制台（演示/联调可读），方便无 key 环境下联调验证码流程。
        """
        host = settings.SMTP_HOST
        if not host or not settings.SMTP_USER or not settings.SMTP_PASSWORD:
            # ⚠️ 2026-08-28 工程审查 P1 修复：不再无条件打印含验证码的 body（日志泄露可接管任意账号）。
            # 仅 DEBUG + DEV_PRINT_CODES 显式开启才打印完整邮件内容；否则只提示 SMTP 未配置。
            if settings.DEBUG and settings.DEV_PRINT_CODES:
                print(f"[EMAIL][演示降级] to={to} subject={subject}\n{body}")
            else:
                print("[EMAIL] SMTP 未配置，验证码无法投递（生产环境必须配置 SMTP_HOST/USER/PASSWORD）")
            return False
        try:
            from_addr = settings.SMTP_FROM or settings.SMTP_USER
            msg = MIMEText(body, "plain", "utf-8")
            msg["Subject"] = Header(subject, "utf-8")
            msg["From"] = formataddr((str(Header("选品助手", "utf-8")), from_addr))
            msg["To"] = to
            if settings.SMTP_USE_SSL:
                server = smtplib.SMTP_SSL(host, settings.SMTP_PORT, timeout=10)
            else:
                server = smtplib.SMTP(host, settings.SMTP_PORT, timeout=10)
                server.starttls()
            server.set_debuglevel(0)
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            server.sendmail(from_addr, [to], msg.as_string())
            server.quit()
            return True
        except Exception as error:
            print(f"[EMAIL] SMTP 发送失败: {error}")
            return False

    def _send_reset_code(self, user: Dict, code: str) -> None:
        # 投递优先级：绑定邮箱实名 > 账号本身是邮箱（含 @）> 服务端日志（演示/联调）。
        # 生产接入邮件/短信服务商时按需替换；绑定邮箱（email）是找回密码的首选通道。
        body = f"你的验证码是：{code}（10 分钟内有效）。如非本人操作请忽略。"
        deliver_via_email = self.is_email(user["account"]) or bool(user.get("email"))
        sent = False
        if deliver_via_email:
            to = user.get("email") or user["account"]  # 优先级：绑定邮箱 > 账号本身
            sent = self._send_email(to, "【选品助手】密码重置验证码", body)
        if not sent:
            # ⚠️ 2026-08-28 工程审查 P1 修复：原实现无条件打印验证码（生产也会落日志，可接管账号）。
            # 现仅 DEBUG + DEV_PRINT_CODES 显式开启才打印；生产只提示通道未就绪。
            if settings.DEBUG and settings.DEV_PRINT_CODES:
                print(f"[RESET CODE] account={user['account']} email={user.get('email')} code={code} "
                      f"（演示环境：验证码已打印到服务端日志；生产请接入邮件/短信通道）")
            else:
                print(f"[RESET CODE] 验证码已生成但无法投递（account={user['account']} 无可用通道，生产请配置 SMTP）")
        elif settings.DEBUG and settings.DEV_PRINT_CODES:
            # 仅开发模式补打一条，便于 e2e 从服务端日志抓取验证码闭环；生产 DEBUG=False 不打印
            print(f"[RESET CODE] account={user['account']} email={user.get('email')} code={code} "
                  f"（DEBUG 日志，生产不打印）")

    def _resolve_reset_account(self, query: str) -> str:
        """把找回密码输入标识（登录账号 或 绑定邮箱）归一化到 password_resets 的账号键。"""
        q = self.normalize_account(query)
        user = self._find_user_by_account_or_email(q)
        return user["account"] if user else q

    def verify_reset_code(self, query: str, code: str) -> bool:
        """校验验证码：存在、未过期、尝试次数未超限、且匹配。query 可为账号或绑定邮箱。"""
        account = self._resolve_reset_account(query)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT code_hash, expires_at, attempts FROM password_resets WHERE account = ?", (account,)
            ).fetchone()
        if not row:
            return False
        if int(row["expires_at"]) < int(time.time()):
            return False
        if row["attempts"] >= 5:
            return False
        if not self._verify_password(code, row["code_hash"]):
            with self._connect() as connection:
                connection.execute("UPDATE password_resets SET attempts = attempts + 1 WHERE account = ?", (account,))
            return False
        return True

    def reset_password(self, query: str, code: str, new_password: str) -> Optional[Dict]:
        """校验验证码后重置密码，成功返回用户字典（用于自动登录），失败返回 None。query 可为账号或绑定邮箱。"""
        if not self.verify_reset_code(query, code):
            return None
        account = self._resolve_reset_account(query)
        with self._connect() as connection:
            connection.execute(
                "UPDATE users SET password_hash = ? WHERE account = ? AND is_active = 1",
                (self._hash_password(new_password), account),
            )
            connection.execute("DELETE FROM password_resets WHERE account = ?", (account,))
            row = connection.execute(
                "SELECT id, account, nickname, is_admin, email_verified, email, created_at FROM users WHERE account = ? AND is_active = 1",
                (account,),
            ).fetchone()
        return self._public_user(row) if row else None

    # ─────────────────────────────────────────
    # 邮箱验证（注册后真实性验证；复用验证码机制）
    # ─────────────────────────────────────────

    def request_email_verify_code(self, account: str) -> str:
        """申请邮箱验证码：生成 6 位验证码并「发送」。

        仅对「已注册的邮箱账号」生效（防枚举）；60 秒冷却防轰炸。
        返回 dict：{"status": "ok"} 或 {"status": "cooldown", "retry_after": N} 或 {"status": "not_email"}。
        """
        account = self.normalize_account(account)
        if not self.is_email(account):
            return "not_email"
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id FROM users WHERE account = ? AND is_active = 1", (account,)
            ).fetchone()
        if not row:
            return "ok"  # 账号不存在：静默返回，不泄露是否存在
        # 冷却：距上次发码 >= 60s 才允许重发
        now = int(time.time())
        with self._connect() as connection:
            last = connection.execute(
                "SELECT sent_at FROM email_verifies WHERE account = ?", (account,)
            ).fetchone()
            if last and last["sent_at"] and (now - int(last["sent_at"])) < settings.VERIFY_CODE_SEND_COOLDOWN_SECONDS:
                retry_after = settings.VERIFY_CODE_SEND_COOLDOWN_SECONDS - (now - int(last["sent_at"]))
                return f"cooldown:{retry_after}"
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_at = now + settings.EMAIL_VERIFY_CODE_EXPIRE_SECONDS
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO email_verifies (account, code_hash, expires_at, attempts, sent_at, created_at) "
                "VALUES (?, ?, ?, 0, ?, ?) "
                "ON CONFLICT(account) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at, created_at=excluded.created_at",
                (account, self._hash_password(code), expires_at, now, created_at),
            )
        body = f"你的【选品助手】邮箱验证码是：{code}（{settings.EMAIL_VERIFY_CODE_EXPIRE_SECONDS // 60} 分钟内有效）。如非本人操作请忽略。"
        sent = self._send_email(account, "【选品助手】邮箱验证码", body)
        if not sent:
            # ⚠️ 2026-08-28 工程审查 P1 修复：原实现无条件打印验证码；现仅 DEBUG + DEV_PRINT_CODES 才打印。
            if settings.DEBUG and settings.DEV_PRINT_CODES:
                print(f"[EMAIL VERIFY CODE] account={account} code={code} "
                      f"（演示环境：验证码已打印到服务端日志；生产请配置 SMTP）")
            else:
                print(f"[EMAIL VERIFY CODE] 验证码已生成但无法投递（account={account} 无可用通道，生产请配置 SMTP）")
        elif settings.DEBUG and settings.DEV_PRINT_CODES:
            # 仅开发模式补打一条，便于 e2e 从服务端日志抓取验证码闭环；生产 DEBUG=False 不打印
            print(f"[EMAIL VERIFY CODE] account={account} code={code} （DEBUG 日志，生产不打印）")
        return "ok"

    def verify_email(self, account: str, code: str) -> bool:
        """校验邮箱验证码：存在、未过期、尝试次数未超限、匹配 → 标记邮箱已验证。"""
        account = self.normalize_account(account)
        if not self.is_email(account):
            return False
        with self._connect() as connection:
            row = connection.execute(
                "SELECT code_hash, expires_at, attempts FROM email_verifies WHERE account = ?", (account,)
            ).fetchone()
        if not row:
            return False
        if int(row["expires_at"]) < int(time.time()):
            return False
        if row["attempts"] >= 5:
            return False
        if not self._verify_password(code, row["code_hash"]):
            with self._connect() as connection:
                connection.execute("UPDATE email_verifies SET attempts = attempts + 1 WHERE account = ?", (account,))
            return False
        with self._connect() as connection:
            connection.execute("UPDATE users SET email_verified = 1 WHERE account = ? AND is_active = 1", (account,))
            connection.execute("DELETE FROM email_verifies WHERE account = ?", (account,))
        return True

    def get_user(self, user_id: str) -> Optional[Dict]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, account, nickname, is_admin, email_verified, email, created_at FROM users WHERE id = ? AND is_active = 1",
                (user_id,),
            ).fetchone()
        return self._public_user(row) if row else None
    def update_user(
        self,
        user_id: str,
        nickname: Optional[str] = None,
        current_password: Optional[str] = None,
        new_password: Optional[str] = None,
        new_account: Optional[str] = None,
        email: Optional[str] = None,
        email_clear: bool = False,
    ) -> Optional[Dict]:
        """个人资料更新（设置页）。各字段可选，只更新传了的：
        - nickname：改昵称（可清空为 None）。可与 new_password 同提交（昵称+密码一次改）。
        - 改密码：必须 current_password + new_password，校验当前密码。
        - 改账号：必须 current_password，且新账号走格式/唯一校验（邀请码是独立随机 hex，不受账号变更影响）。
        - email（邮箱实名）：绑定独立邮箱用于找回密码，必须 current_password，且邮箱唯一；email_clear=True 解绑。
        返回更新后的公开用户；无任何有效更新则返回原用户。
        """
        cur = self.get_user(user_id)
        if not cur:
            return None
        updates: Dict[str, object] = {}
        pw_pending = False  # 本次是否涉及密码更改（需 current_password 校验）
        # 昵称
        if nickname is not None:
            updates["nickname"] = nickname or None
        # 密码
        if new_password:
            if not current_password:
                raise ValueError("修改密码需先验证当前密码")
            row = self._get_password_hash(user_id)
            if not row or not self._verify_password(current_password, row["password_hash"]):
                raise ValueError("当前密码错误")
            updates["password_hash"] = self._hash_password(new_password)
            pw_pending = True
        # 账号
        if new_account:
            if not current_password:
                raise ValueError("修改账号需先验证当前密码")
            norm = self.normalize_account(new_account)
            if "@" not in norm and not norm.isdigit():
                raise ValueError("请输入有效的邮箱或手机号")
            with self._connect() as connection:
                if connection.execute("SELECT 1 FROM users WHERE account = ? AND id != ?", (norm, user_id)).fetchone():
                    raise ValueError("该账号已被注册")
            updates["account"] = norm
        # 邮箱实名（绑定/解绑）
        if email_clear:
            if not current_password:
                raise ValueError("解绑邮箱需先验证当前密码")
            self._verify_current_pw(user_id, current_password)
            updates["email"] = None
        elif email is not None:
            if not current_password:
                raise ValueError("绑定邮箱需先验证当前密码")
            self._verify_current_pw(user_id, current_password)
            norm_email = self.normalize_account(email)
            if not self.is_email(norm_email):
                raise ValueError("请输入有效的邮箱地址")
            with self._connect() as connection:
                if connection.execute("SELECT 1 FROM users WHERE email = ? AND id != ?", (norm_email, user_id)).fetchone():
                    raise ValueError("该邮箱已被其他账号绑定")
            updates["email"] = norm_email
        if not updates:
            return cur
        clause = ", ".join(f"{k} = ?" for k in updates)
        with self._connect() as connection:
            connection.execute(f"UPDATE users SET {clause} WHERE id = ?", (*updates.values(), user_id))
        return self.get_user(user_id)

    def _verify_current_pw(self, user_id: str, current_password: str) -> None:
        """校验当前密码，错误抛 ValueError。用于改账号/邮箱实名等需要二次验证的操作。"""
        row = self._get_password_hash(user_id)
        if not row or not self._verify_password(current_password, row["password_hash"]):
            raise ValueError("当前密码错误")

    def _get_password_hash(self, user_id: str) -> Optional[Dict]:
        with self._connect() as connection:
            return connection.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()

    @staticmethod
    def _encode(value: Dict) -> str:
        payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        return base64.urlsafe_b64encode(payload).decode().rstrip("=")

    def create_token(self, user: Dict) -> str:
        header = self._encode({"alg": "HS256", "typ": "JWT"})
        payload = self._encode({"sub": user["id"], "exp": int(time.time()) + settings.AUTH_TOKEN_EXPIRE_SECONDS})
        unsigned = f"{header}.{payload}"
        signature = hmac.new(settings.AUTH_SECRET_KEY.encode(), unsigned.encode(), hashlib.sha256).digest()
        return f"{unsigned}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"

    def verify_token(self, token: str) -> Optional[Dict]:
        try:
            header, payload, signature = token.split(".", 2)
            unsigned = f"{header}.{payload}"
            expected = hmac.new(settings.AUTH_SECRET_KEY.encode(), unsigned.encode(), hashlib.sha256).digest()
            actual = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
            if not hmac.compare_digest(expected, actual):
                return None
            data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            if int(data.get("exp", 0)) < int(time.time()):
                return None
            return self.get_user(data.get("sub", ""))
        except (ValueError, TypeError, json.JSONDecodeError):
            return None


_auth_service = AuthService()
