import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List


class KnowledgeService:
    def __init__(self):
        self.knowledge_dir = Path(__file__).resolve().parent.parent / "knowledge"
        self.dynamic_dir = Path(__file__).resolve().parent.parent / "knowledge_dynamic"
        self.dynamic_dir.mkdir(exist_ok=True)
        self.documents = self._load_documents()

    def _load_documents(self) -> List[Dict]:
        documents: List[Dict] = []
        today = datetime.now().strftime("%Y-%m-%d")

        # 静态知识库
        if self.knowledge_dir.exists():
            for file_path in sorted(self.knowledge_dir.glob("*.json")):
                try:
                    data = json.loads(file_path.read_text(encoding="utf-8"))
                    # 兼容两种结构：① 顶层 list（如 01_entry_judgment.json）；
                    # ② {module, knowledge_items:[...]} 带元数据的封装格式（如 06_risk_assessment.json）。
                    # 否则整文件会被静默跳过，导致该文件的知识从未进入检索。
                    items = data if isinstance(data, list) else (data.get("knowledge_items") or [])
                    for item in items:
                        if isinstance(item, dict):
                            item.setdefault("source", file_path.name)
                            documents.append(item)
                except Exception as error:
                    print(f"[KNOWLEDGE] Failed to load {file_path.name}: {error}")

        # 动态知识库（跳过过期条目）
        dynamic_count = 0
        expired_count = 0
        for file_path in sorted(self.dynamic_dir.glob("*.json")):
            try:
                item = json.loads(file_path.read_text(encoding="utf-8"))
                if isinstance(item, dict):
                    expire_at = item.get("expire_at", "")
                    if expire_at and expire_at < today:
                        expired_count += 1
                        continue
                    documents.append(item)
                    dynamic_count += 1
            except Exception as error:
                print(f"[KNOWLEDGE] Failed to load dynamic {file_path.name}: {error}")

        print(f"[KNOWLEDGE] Loaded {len(documents)} docs ({dynamic_count} dynamic, {expired_count} expired/skipped)")
        return documents

    def refresh(self) -> None:
        self.documents = self._load_documents()

    @property
    def dynamic_count(self) -> int:
        return sum(1 for d in self.documents if d.get("source") == "dynamic")

    def _doc_matches_category(self, doc: Dict, category) -> bool:
        """品类过滤：决定一份知识是否在当前模式下进入检索。

        - category 为 None/空：不限制（兼容系统/历史调用，返回全量）。
        - "beauty"：美妆模式——含美妆 RAG（无 category 字段的历史文档视为美妆）+ category 显式
          为 "beauty"/"all" 的文档；排除 general 专属文档。
        - "general"：全品类模式——仅含 category 为 "general"/"all" 的文档；排除美妆专属文档。
        """
        if category in (None, ""):
            return True
        doc_cat = doc.get("category")
        if category == "beauty":
            return doc_cat in (None, "beauty", "all")
        if category == "general":
            return doc_cat in ("general", "all")
        return doc_cat == category

    def _doc_matches_audience(self, doc: Dict, audience) -> bool:
        """受众过滤：决定一份知识是否喂给当前受众。

        关键修复（Bug A：「选了C端像B端」）：现有 `backend/app/knowledge/*.json`
        10 个文件、若干条目全部是 B 端（商家选品/招商/铺货）视角，没有 `audience`
        字段——按「无字段即 B」回填，避免 C 端被 B 端 RAG 污染（商家话术混入
        C 端回答，产生「选了C端像B端」的体验割裂）。

        规则：
        - audience 为 None/空：不限制（兼容系统/历史调用）。
        - "C"（C端/个人带货）：仅返回 audience 显式标 "C" 或 "all" 的文档；
          无字段的旧文档视为 B，**不**喂给 C 端。
        - "B"（B端/商家）：返回 audience 为 "B"/"all"/None（无字段旧文档归 B）的文档。
        - 其他值：仅返回 audience 与之精确匹配的文档。
        """
        if audience in (None, ""):
            return True
        doc_aud = doc.get("audience")
        if audience == "C":
            return doc_aud in ("C", "all")
        if audience == "B":
            # 无字段旧文档视为 B（向后兼容），B/all/None 全部喂给 B 端
            return doc_aud in (None, "B", "all")
        return doc_aud == audience

    def retrieve(self, query: str, top_k: int = 4, owner: str = None, category=None, audience: str = None) -> List[Dict]:
        query_lower = query.lower()
        scored: List[tuple[int, Dict]] = []

        for doc in self.documents:
            # 商户隔离：动态自喂知识按 owner 过滤；静态底库（无 owner 字段）任何人可用。
            # owner=None（系统/爬虫调用）时不返回任何商户私有知识，仅全局底库。
            doc_owner = doc.get("owner")
            if doc_owner is not None:
                if owner is None or doc_owner != owner:
                    continue
            # 品类过滤：beauty 取美妆 RAG，general 取佣金/联盟通用知识，互不串台
            if not self._doc_matches_category(doc, category):
                continue
            # 受众过滤（Bug A）：C 端不喂 B 端 RAG，杜绝「选C端像B端」
            if not self._doc_matches_audience(doc, audience):
                continue
            score = 0
            question = str(doc.get("question", ""))
            answer = str(doc.get("answer", ""))
            tags = [str(tag) for tag in doc.get("tags", [])]
            scenarios = [str(s) for s in doc.get("applicable_scenarios", [])]

            haystack = " ".join([question, answer, " ".join(tags), " ".join(scenarios)]).lower()

            for tag in tags:
                if tag.lower() in query_lower:
                    score += 3

            for scenario in scenarios:
                if scenario.lower() in query_lower:
                    score += 2

            if question.lower() in query_lower or query_lower in question.lower():
                score += 2

            for token in query_lower.split():
                token = token.strip()
                if token and token in haystack:
                    score += 1

            if score > 0:
                scored.append((score, doc))

        scored.sort(key=lambda item: item[0], reverse=True)
        return [doc for _, doc in scored[:top_k]]

    def format_context(self, query: str, top_k: int = 4, owner: str = None, category=None, audience: str = None) -> str:
        docs = self.retrieve(query, top_k=top_k, owner=owner, category=category, audience=audience)
        if not docs:
            return ""

        sections = []
        for index, doc in enumerate(docs, start=1):
            question = doc.get("question", f"知识片段 {index}")
            answer = doc.get("answer", "")
            source = doc.get("source", "unknown")
            sections.append(f"[{index}] {question}（来源: {source}）\n{answer}")

        return "\n\n".join(sections)


knowledge_service = KnowledgeService()
