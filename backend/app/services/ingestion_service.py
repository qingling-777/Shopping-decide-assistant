import httpx
import json
import re
import hashlib
from datetime import datetime, timedelta
from typing import Optional
from pathlib import Path
from bs4 import BeautifulSoup
from app.core.config import settings


EXTRACT_PROMPT = """你是一个美妆电商知识提炼助手。

我会给你一段来自知识博主的内容（可能是视频文字稿、文章、或用户输入的摘要）。

请从中提炼出对美妆商家有用的选品/运营/平台知识，并严格按照以下 JSON 格式输出，不要输出其他任何内容：

{
  "question": "这条知识能回答什么问题（一句话，用疑问句）",
  "question_aliases": ["同一问题的2-3种问法"],
  "answer": "完整的知识内容（150字以内，直接、具体、可执行）",
  "conclusion": "一句话结论（30字以内）",
  "tags": ["标签1", "标签2", "标签3"],
  "applicable_scenarios": ["适用场景1", "适用场景2"],
  "opinion_type": "rule 或 strategy 或 warning 或 case",
  "ttl_days": 知识有效期天数（时效性强如热点用30，经验规律用365，平台规则用90）
}

注意：
- 如果内容信息量不足，无法提炼有价值的知识，请输出 null
- 不要添加任何说明文字，只输出 JSON 或 null
"""


class IngestionService:
    """内容摄取服务：从URL或文本中提炼知识并存入动态知识库"""

    def __init__(self):
        self.dynamic_dir = Path(__file__).parent.parent / "knowledge_dynamic"
        self.dynamic_dir.mkdir(exist_ok=True)
        self.api_key = settings.SILICONFLOW_API_KEY
        self.base_url = settings.SILICONFLOW_BASE_URL

    # ─────────────────────────────────────────
    # 1. 内容获取
    # ─────────────────────────────────────────

    async def fetch_url(self, url: str) -> str:
        """从 URL 获取网页正文"""
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, "lxml")

                # 移除无用标签
                for tag in soup(["script", "style", "nav", "footer", "header", "aside", "ad"]):
                    tag.decompose()

                # 优先取文章正文
                body = (
                    soup.find("article")
                    or soup.find("main")
                    or soup.find(class_=re.compile(r"content|article|post|body", re.I))
                    or soup.body
                )
                text = body.get_text(separator="\n", strip=True) if body else ""
                # 清理多余空行，截取前3000字
                lines = [l.strip() for l in text.splitlines() if l.strip()]
                return "\n".join(lines)[:3000]
        except Exception as e:
            raise ValueError(f"无法获取URL内容: {e}")

    # ─────────────────────────────────────────
    # 2. AI 提炼
    # ─────────────────────────────────────────

    async def extract_knowledge(self, raw_text: str, source_label: str = "") -> Optional[dict]:
        """用 AI 从原始文本中提炼结构化知识"""
        if len(raw_text.strip()) < 50:
            return None

        user_content = f"来源：{source_label}\n\n内容：\n{raw_text[:2500]}"

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                    json={
                        "model": settings.SILICONFLOW_MODEL,
                        "messages": [
                            {"role": "system", "content": EXTRACT_PROMPT},
                            {"role": "user", "content": user_content},
                        ],
                        "temperature": 0.3,
                        "max_tokens": 600,
                    },
                )
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"].strip()

                if content.lower() == "null" or not content:
                    return None

                # 去掉可能的 markdown 代码块
                content = re.sub(r"^```json\s*|^```\s*|\s*```$", "", content, flags=re.MULTILINE).strip()
                extracted = json.loads(content)
                return extracted
        except json.JSONDecodeError:
            return None
        except Exception as e:
            raise ValueError(f"AI提炼失败: {e}")

    # ─────────────────────────────────────────
    # 3. 保存到动态知识库
    # ─────────────────────────────────────────

    def save_to_dynamic(self, knowledge: dict, source_url: str = "", source_label: str = "", owner: str = None) -> str:
        """保存提炼后的知识到动态知识库文件。

        owner: 商户隔离主体（user:<id> 或 device:<id>）；None 表示全局共享（系统/历史条目）。
        每条自喂知识都打上 owner，检索/列表/删除均按 owner 隔离，其他商户看不到也用不到。
        """
        now = datetime.now()
        ttl_days = int(knowledge.get("ttl_days", 90))
        expire_at = (now + timedelta(days=ttl_days)).strftime("%Y-%m-%d")

        # 生成唯一 ID
        raw_id = f"{knowledge.get('question', '')}_{now.isoformat()}"
        knowledge_id = "dynamic_" + hashlib.md5(raw_id.encode()).hexdigest()[:8]

        record = {
            "id": knowledge_id,
            "question": knowledge.get("question", ""),
            "question_aliases": knowledge.get("question_aliases", []),
            "answer": knowledge.get("answer", ""),
            "conclusion": knowledge.get("conclusion", ""),
            "tags": knowledge.get("tags", []),
            "applicable_scenarios": knowledge.get("applicable_scenarios", []),
            "opinion_type": knowledge.get("opinion_type", "strategy"),
            "source": "dynamic",
            "source_url": source_url,
            "source_label": source_label,
            "owner": owner,
            "created_at": now.strftime("%Y-%m-%d"),
            "expire_at": expire_at,
            "ttl_days": ttl_days,
        }

        # 每条知识独立存一个 JSON 文件，便于单独淘汰
        file_path = self.dynamic_dir / f"{knowledge_id}.json"
        file_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return knowledge_id

    # ─────────────────────────────────────────
    # 4. 统一入口
    # ─────────────────────────────────────────

    async def ingest_url(self, url: str, source_label: str = "", owner: str = None) -> dict:
        """从 URL 摄取知识（owner 隔离：打上商户主体）"""
        raw_text = await self.fetch_url(url)
        label = source_label or url[:60]
        extracted = await self.extract_knowledge(raw_text, source_label=label)
        if not extracted:
            return {"status": "skip", "reason": "内容信息量不足，未提炼到有效知识"}
        kid = self.save_to_dynamic(extracted, source_url=url, source_label=label, owner=owner)
        return {"status": "ok", "id": kid, "question": extracted.get("question", ""), "expire_at": extracted.get("ttl_days", 90)}

    async def ingest_text(self, text: str, source_label: str = "", owner: str = None) -> dict:
        """从纯文本摄取知识（视频文字稿、手动摘要等；owner 隔离：打上商户主体）"""
        extracted = await self.extract_knowledge(text, source_label=source_label)
        if not extracted:
            return {"status": "skip", "reason": "内容信息量不足，未提炼到有效知识"}
        kid = self.save_to_dynamic(extracted, source_label=source_label, owner=owner)
        return {"status": "ok", "id": kid, "question": extracted.get("question", ""), "ttl_days": extracted.get("ttl_days", 90)}

    # ─────────────────────────────────────────
    # 5. 淘汰机制
    # ─────────────────────────────────────────

    def cleanup_expired(self) -> dict:
        """清理过期的动态知识"""
        today = datetime.now().strftime("%Y-%m-%d")
        removed = []
        kept = []

        for f in self.dynamic_dir.glob("*.json"):
            try:
                record = json.loads(f.read_text(encoding="utf-8"))
                expire_at = record.get("expire_at", "")
                if expire_at and expire_at < today:
                    f.unlink()
                    removed.append({"id": record.get("id"), "question": record.get("question", "")[:40], "expired": expire_at})
                else:
                    kept.append(record.get("id"))
            except Exception:
                pass

        return {"removed": len(removed), "kept": len(kept), "details": removed}

    def list_dynamic(self, owner: str = None) -> list:
        """列出动态知识条目（含过期状态）。

        owner 给定时仅返回该商户自喂的条目（owner 完全匹配）；owner=None 返回全部（系统/管理视角）。
        """
        today = datetime.now().strftime("%Y-%m-%d")
        items = []
        for f in sorted(self.dynamic_dir.glob("*.json")):
            try:
                record = json.loads(f.read_text(encoding="utf-8"))
                # owner 隔离：指定商户时只取它自己喂的（无 owner 字段的历史/共享条目不计入他人列表）
                if owner is not None and record.get("owner") != owner:
                    continue
                expire_at = record.get("expire_at", "")
                items.append({
                    "id": record.get("id"),
                    "question": record.get("question", ""),
                    "source_label": record.get("source_label", ""),
                    "owner": record.get("owner"),
                    "created_at": record.get("created_at", ""),
                    "expire_at": expire_at,
                    "ttl_days": record.get("ttl_days", 90),
                    "status": "expired" if expire_at < today else "active",
                })
            except Exception:
                pass
        return items

    def delete_dynamic(self, knowledge_id: str, owner: str = None) -> str:
        """删除某条动态知识，带商户归属校验。

        返回：
          "not_found"  文件不存在
          "forbidden"  该条属于其他商户，当前 owner 无权删除（owner=None 视为全局/管理员可删）
          "ok"         已删除
        """
        file_path = self.dynamic_dir / f"{knowledge_id}.json"
        if not file_path.exists():
            return "not_found"
        if owner is not None:
            try:
                record = json.loads(file_path.read_text(encoding="utf-8"))
            except Exception:
                record = {}
            rec_owner = record.get("owner")
            # 有 owner 的条目仅本人可删；无 owner 的历史/共享条目（owner=None）不允许普通商户删（需管理员）
            if rec_owner is not None and rec_owner != owner:
                return "forbidden"
        file_path.unlink()
        return "ok"


ingestion_service = IngestionService()
