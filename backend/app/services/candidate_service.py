import json
import asyncio
import hashlib
import re
from typing import Any, Dict, List, Optional

from datetime import datetime
from pathlib import Path

from app.core.config import settings
from app.services.union_service import union_provider, extract_search_keyword
from app.services.ai_service import ai_service
from app.services.crawler_service import beauty_crawler
from app.services.subscription_service import _subscription_service

# 选品候选池：落本地 JSON（按 userId 分库），不引数据库。
DATA_DIR = Path(__file__).resolve().parent.parent / "product_data"
CANDIDATES_FILE = DATA_DIR / "product_candidates.json"

_lock = asyncio.Lock()

# 商品介绍缓存：按 product.id 缓存（同一商品只打一次 LLM+联网）；已改为 DB 持久缓存为主（2026-08-25），
# 进程内缓存仅作二次加速（防 DB 读放大）。
_intro_cache: Dict[str, Dict] = {}


def _product_key(product: Dict[str, Any]) -> str:
    """商品稳定 key：优先 id；无 id 用 title+brand 的 md5（跨请求稳定，用于持久缓存）。

    2026-08-27 修复：id 可能为大淘客数字 dtk_id（int），需先转 str 再 strip，否则 .strip() 撞 int 报
    AttributeError。常见触发：爆品卡商品调 /products/intro 生成介绍（id=dtk_id 为 int）。
    """
    pid = str((product.get("id") or "")).strip()
    if pid:
        return pid
    raw = f"{product.get('title') or ''}|{product.get('brand') or ''}"
    return "h_" + hashlib.md5(raw.encode("utf-8")).hexdigest()


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _load_all() -> Dict[str, List[Dict]]:
    if not CANDIDATES_FILE.exists():
        return {}
    try:
        return json.loads(CANDIDATES_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_all(data: Dict[str, List[Dict]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CANDIDATES_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _derive_platform(link: str, source: str) -> str:
    """从链接/来源粗略推断主推平台（best-effort，AI 富字段会再覆盖）。"""
    s = (link or "").lower()
    if "jingdong" in s or "jd.com" in s:
        return "京东"
    if "pinduoduo" in s or "pdd" in s:
        return "拼多多"
    if "douyin" in s or "tiktok" in s:
        return "抖音"
    if "uland.taobao" in s or "taobao" in s or "tmall" in s:
        return "淘宝/天猫"
    return "淘宝/天猫"


async def _enrich_batch(items: List[Dict]) -> List[Dict]:
    """一次性 LLM 调用，给一批商品补 方向标签/卖点/竞争等级/平台。best-effort。"""
    if not items:
        return [{} for _ in items]
    try:
        brief = [
            {
                "idx": i,
                "name": it.get("title") or it.get("brand") or "商品",
                "brand": it.get("brand") or "",
                "price": it.get("priceText") or "",
            }
            for i, it in enumerate(items)
        ]
        prompt = (
            "你是美妆选品顾问。下面是用户聊出来的候选商品，请逐条补全选品分析字段，"
            "严格返回一个 JSON 数组，长度与输入一致、顺序一致，不要其他内容：\n"
            "语气直接具体，不用「整体来看/值得注意的是/综合而言」等套话，不用「为您/您可以考虑」客服腔；"
            "directionTags/sellingPoints 要像真人选品老兵写的，具体不空泛。\n"
            '[{"idx":0,"directionTags":["方向标签1","方向标签2"],"sellingPoints":["卖点1","卖点2"],'
            '"competitionLevel":"低|中|中高|高","platform":"淘宝/天猫|抖音|小红书|京东|拼多多"}, ...]\n\n'
            "要求：directionTags 是选品方向/人群/功效标签（2-4 个，具体）；sellingPoints 是可用于推广的核心卖点"
            "（2-3 个，具体不空泛）；competitionLevel 按同类在售商品的竞争激烈程度判断；"
            "platform 是该商品主要适合推广的平台。\n"
            f"商品：{json.dumps(brief, ensure_ascii=False)}"
        )
        resp = await ai_service.chat([{"role": "user", "content": prompt}], temperature=0.5)
        raw = resp["choices"][0]["message"]["content"].strip()
        raw = raw.split("```")[1].lstrip("json") if "```" in raw else raw
        enriched = json.loads(raw)
        if isinstance(enriched, list):
            by_idx = {e.get("idx"): e for e in enriched if isinstance(e, dict)}
            return [by_idx.get(i, {}) for i in range(len(items))]
    except Exception as e:
        print(f"[CANDIDATE] AI 富字段失败（降级留空）: {e}")
    return [{} for _ in items]


def _lead_to_card(lead: Dict, idx: int) -> Dict:
    """把好单库归一化线索转成前端 ProductCardItem 形状。"""
    return {
        "id": f"comp_{idx}",
        "brand": lead.get("brand") or "",
        "title": (lead.get("context") or "")[:60],
        "image": lead.get("image") or "",
        "priceText": lead.get("price_text") or "",
        "commissionRatio": lead.get("commission_ratio"),
        "commissionMoney": lead.get("commission_money"),
        "sales": lead.get("sales"),
        "link": lead.get("link") or "",
        "source": lead.get("source") or "",
        "couponInfo": lead.get("coupon_info") or "",
        "detailUrl": lead.get("detail_url") or "",
    }


class CandidateService:
    """选品候选池：本地 JSON 存储 + AI 富字段 + 查竞品 + 生成推广方案。"""

    async def archive_candidates(self, user_id: str, items: List[Dict]) -> int:
        """把聊天里下发的商品卡批量归档进候选池（按 id 去重，AI 补富字段）。"""
        if not user_id or not items:
            return 0
        items = [it for it in items if it and it.get("id")]
        if not items:
            return 0
        enriched = await _enrich_batch(items)
        async with _lock:
            data = _load_all()
            user_list = data.get(user_id, [])
            by_id = {c["id"]: c for c in user_list}
            now = _now_iso()
            for it, en in zip(items, enriched):
                cid = it["id"]
                cand = by_id.get(cid) or {"id": cid, "favorited": False, "archivedAt": now}
                cand.update(
                    {
                        "productName": it.get("title") or "",
                        "brand": it.get("brand") or "",
                        "price": it.get("priceText") or "",
                        "sourceLink": it.get("link") or "",
                        "image": it.get("image") or "",
        "commissionRatio": it.get("commissionRatio"),
        "commissionMoney": it.get("commissionMoney"),
        "sales": it.get("sales"),
        "source": it.get("source") or "",
        "couponInfo": it.get("couponInfo") or "",
        "detailUrl": it.get("detailUrl") or "",
        "updatedAt": now,
                        # AI 富字段：本次有值才覆盖，保留历史（en 为空时不破坏已有）
                        "directionTags": en.get("directionTags") or cand.get("directionTags") or [],
                        "sellingPoints": en.get("sellingPoints") or cand.get("sellingPoints") or [],
                        "competitionLevel": en.get("competitionLevel") or cand.get("competitionLevel") or "",
                        "platform": en.get("platform")
                        or cand.get("platform")
                        or _derive_platform(it.get("link", ""), it.get("source", "")),
                    }
                )
                by_id[cid] = cand
            data[user_id] = list(by_id.values())
            _save_all(data)
        return len(items)

    def list_candidates(self, user_id: str) -> List[Dict]:
        if not user_id:
            return []
        return _load_all().get(user_id, [])

    async def set_favorite(self, user_id: str, candidate_id: str, favorited: bool) -> None:
        if not user_id or not candidate_id:
            return
        async with _lock:
            data = _load_all()
            lst = data.get(user_id, [])
            hit = False
            for c in lst:
                if c.get("id") == candidate_id:
                    c["favorited"] = bool(favorited)
                    c["updatedAt"] = _now_iso()
                    hit = True
                    break
            if not hit:
                return
            data[user_id] = lst
            _save_all(data)

    async def get_competitors(self, keyword: str = "", brand: str = "", limit: int = 8) -> List[Dict]:
        """查竞品：从商品标题/品牌提炼干净品类词，调好单库找同类在售商品。

        根因：好单库关键词接口对长描述性标题几乎不命中，对品类名词（口红/散粉）命中好、
        对纯品牌名常返回空。前端传的是 60 字截断长标题，brand 又常为空，于是 kw=长标题
        → 0~1 条。这里优先用 extract_search_keyword 把标题洗成「品牌+品类/品类/功效词」，
        再用纯品牌、短截标题兜底，多词召回后按链接去重，确保竞品足量。
        """
        title = (keyword or "").strip()
        brand_clean = (brand or "").strip()
        # 候选搜索词：品类/功效词优先，纯品牌次之，短截标题兜底
        kw_candidates: List[str] = []
        cat_kw = extract_search_keyword(title)
        if cat_kw:
            kw_candidates.append(cat_kw)
            # "品牌 品类"组合词之外，再单独把品类词加进来扩召回（好单库对品类词命中最好）
            if " " in cat_kw:
                kw_candidates.append(cat_kw.split(" ", 1)[1])
        if brand_clean:
            kw_candidates.append(brand_clean)
        if title:
            kw_candidates.append(title[:16])
        # 保序去重，避免同一词重复搜
        seen: set = set()
        search_words: List[str] = []
        for w in kw_candidates:
            if w and w not in seen:
                seen.add(w)
                search_words.append(w)
        if not search_words:
            return []
        merged: List[Dict] = []
        seen_link: set = set()
        target = max(4, limit)
        for w in search_words:
            try:
                leads = await union_provider.search_products(keyword=w, max_items=target)
            except Exception as e:
                print(f"[CANDIDATE] 查竞品失败({w}): {e}")
                leads = []
            for l in leads:
                key = l.get("link") or l.get("context") or ""
                if key and key in seen_link:
                    continue
                seen_link.add(key)
                merged.append(l)
                if len(merged) >= target:
                    break
            if len(merged) >= target:
                break
        return [_lead_to_card(l, i) for i, l in enumerate(merged[:target])]

    async def generate_promo_plan(self, product: Dict[str, Any]) -> Dict:
        """生成「加厚」的单品推广方案（非流式，兼容旧调用）。

        内部委托流式生成器 _generate_promo_plan_stream，只收集最终的 plan 返回。
        2026-08-27：新增流式接口 gen 阶段思考步骤（前端「深度思考」面板），本方法保持不变。
        """
        async for ev in self._generate_promo_plan_stream(product):
            if ev.get("type") == "plan":
                return ev["plan"]
        # 理论上必会 yield plan；兜底空方案
        return {"title": "推广方案", "hooks": [], "body": ""}

    async def _generate_promo_plan_stream(self, product: Dict[str, Any]):
        """流式生成推广方案，并在关键阶段 yield 思考步骤（type=thinking），最后 yield 完整计划（type=plan）。

        前端据此实时展示「深度思考」面板。事件结构：
          {"type":"thinking","content":"联网核实卖点…"}  ← 生成阶段
          {"type":"plan","plan":{...},"usage":{...}|null,"cached":bool}  ← 最终方案 + 用量回执
        计费逻辑与旧版一致：聚合 intro+plan 的 LLM 用量，路由负责 record_usage。
        """
        name = product.get("title") or product.get("productName") or product.get("brand") or "该商品"
        brand = product.get("brand") or ""
        price = product.get("price") or product.get("priceText") or ""
        selling = product.get("sellingPoints") or []
        platform = product.get("platform") or ""
        comm = product.get("commissionRatio")
        comm_text = f"约{comm}%" if comm is not None else ""
        competition = product.get("competitionLevel") or ""

        # 0) 持久缓存优先（DB）：同一商品不重复花钱生成
        key = _product_key(product)
        cached = _subscription_service.get_product_content(key)
        if cached.get("plan"):
            plan = dict(cached["plan"])
            plan["_cached"] = True
            yield {"type": "thinking", "content": "命中缓存，直接加载已生成方案…"}
            yield {"type": "plan", "plan": plan, "usage": None, "cached": True}
            return

        yield {"type": "thinking", "content": "开始整理商品信息（好单库佣金/价格/竞品数据）…"}

        # 1) 复用商品介绍（好单库字段 + 联网真实测评），拿到 summary/highlights/suitableFor/sources
        intro_summary = ""
        intro_highlights: List[str] = []
        intro_suitable: List[str] = []
        sources: List[Dict] = []
        intro_usage: Dict = {}
        try:
            yield {"type": "thinking", "content": "正在联网核实商品真实卖点与测评…"}
            intro = await self.generate_product_intro(product)
            intro_summary = intro.get("summary") or ""
            intro_highlights = intro.get("highlights") or []
            intro_suitable = intro.get("suitableFor") or []
            sources = intro.get("sources") or []
            intro_usage = intro.get("_usage") or {}
            yield {"type": "thinking", "content": "卖点核实完成，已锁定核心卖点与适合人群。"}
        except Exception as e:
            print(f"[CANDIDATE] 推广方案内嵌商品介绍失败（降级跳过）: {e}")
            yield {"type": "thinking", "content": "联网核实受限，改用商品基础字段生成。"}

        yield {"type": "thinking", "content": "正在分析佣金比例、价格带与竞品强度…"}

        # 2) 把真实数据拼进 prompt
        facts = (
            f"商品：{name}｜品牌：{brand}｜价格：{price}"
            + (f"｜佣金比例：{comm_text}" if comm_text else "")
            + (f"｜竞品强度：{competition}" if competition else "")
            + (f"｜主推平台：{platform}" if platform else "")
        )
        if selling:
            facts += f"｜已知卖点：{'、'.join(selling)}"
        if intro_summary:
            facts += f"\n商品介绍（已联网核实）：{intro_summary}"
        if intro_highlights:
            facts += f"\n核心卖点（已核实）：{'、'.join(intro_highlights)}"
        if intro_suitable:
            facts += f"\n适合人群（已核实）：{'、'.join(intro_suitable)}"

        prompt = (
            "你是资深电商带货操盘手（同时精通 C 端个人带货与 B 端商家招商）。基于下方『商品信息』（含好单库真实佣金/价格/竞品数据，及联网核实的卖点/测评）"
            "，生成一套可直接落地执行的单品推广方案，严格按 JSON 返回，不要其他内容：\n"
            '{"title":"推广标题（吸睛、≤20字）",'
            '"hooks":["钩子文案1","钩子文案2","钩子文案3"],'
            '"body":"正文文案（180-280字，口语化像真人种草，自然带出价格/佣金卖点/已核实卖点）",'
            '"sellingPoints":["卖点话术1","卖点话术2","卖点话术3"],'
            '"targetAudience":"目标人群画像（年龄/肤质/痛点/消费力，2-3句）",'
            '"influencerType":"适合的达人类型与人设（如：成分党测评博主/平价好物素人）",'
            '"openingHook":"开头3秒钩子（单句、强冲突或强利益点）",'
            '"commentInteraction":"评论区互动引导（引导提问/晒单/领券的话术）",'
            '"complianceRisk":"合规风险提示（绝对化用语/功效宣称/化妆品广告法红线）",'
            '"kpi":"核心KPI与合格线（如：点击率≥3%、7日ROI≥1.2）",'
            '"abTest":"A/B测试建议（两个可对照的选题/封面/口播方向）",'
            '"budget":"预算与排期建议（如：测品期3天投200元/条，跑出爆款再加码）",'
            '"platforms":[{"name":"抖音","angle":"该平台的内容角度与节奏"},{"name":"小红书","angle":"该平台的内容角度与节奏"}],'
            '"schedule":"建议发布节奏（如：每天1条短视频+3篇图文，连测7天）",'
            '"cEndPromotion":{'
            '"mainstream":"C端主流推广总述（个人带货/淘客视角：内容种草+佣金带货，1句）",'
            '"channels":["C端主推平台与玩法1（抖音精选联盟/快手/小红书/视频号/淘宝客）","玩法2"],'
            '"contentAngles":["C端内容角度1（种草/测评/剧情/直播切片）","角度2"],'
            '"commissionStrategy":"佣金转化策略（选高佣品、佣金话术、粉丝运营、起量节奏，1-2句）"},'
            '"bEndPromotion":{'
            '"mainstream":"B端主流推广总述（商家/招商视角：招商铺货+渠道分销，1句）",'
            '"channels":["B端渠道1（1688/拼多多批发/产业带/代理分销/一件代发）","渠道2"],'
            '"supplyStrategy":"供货价与利润空间、招商政策、铺货策略（1-2句）",'
            '"distributionStrategy":"代理/分销体系搭建、渠道拓展建议（1-2句）"}}\n\n'
            f"{facts}\n"
            "要求：\n"
            "1. 文案真实不夸张，避免『最/第一/绝对』等绝对化用词，功效宣称要可佐证。\n"
            "2. targetAudience/influencerType/openingHook/complianceRisk/kpi/abTest/budget 都要具体可落地，不要空泛。\n"
            "3. cEndPromotion 要覆盖 C 端主流推广（抖音/快手/小红书/视频号/淘宝客的内容种草与佣金带货玩法），"
            "bEndPromotion 要覆盖 B 端主流推广（1688/拼多多批发/产业带/代理分销/一件代发的招商铺货玩法），两端都要具体可执行。\n"
            "4. 卖点要引用『已核实卖点』，不要凭空编造数据。\n"
            "5. 只返回 JSON。"
        )
        yield {"type": "thinking", "content": "正在撰写 C 端与 B 端完整推广方案…"}
        try:
            # 加速（2026-08-26）：方案生成改走 DeepSeek-V3（实测单次 ~1.6s，而默认 V4-Flash ~13.7s，
            # 完整方案输出 2015 tokens 从 ~113s 降到 ~15-20s，且 V3 单价更低）。
            # 理由：推广方案是「结构化模板 + 真实数据填充」，不需要 V4-Flash 的深度推理，V3 足够且快得多。
            resp = await ai_service.chat(
                [{"role": "user", "content": prompt}], temperature=0.7, model="deepseek-ai/DeepSeek-V3"
            )
            raw = resp["choices"][0]["message"]["content"].strip()
            raw = raw.split("```")[1].lstrip("json") if "```" in raw else raw
            plan = json.loads(raw)
            if isinstance(plan, dict):
                # 用量聚合：本方案 LLM + 内嵌商品介绍 LLM（路由据此按 token 计费，原倍数 ×5）
                u = resp.get("usage") or {}
                plan["_usage"] = {
                    "model": resp.get("model") or "unknown",
                    "tokens_in": int(u.get("prompt_tokens") or 0) + int(intro_usage.get("tokens_in") or 0),
                    "tokens_out": int(u.get("completion_tokens") or 0) + int(intro_usage.get("tokens_out") or 0),
                    "tokens_cached": int(u.get("prompt_cache_hit_tokens") or 0) + int(intro_usage.get("tokens_cached") or 0),
                }
                # 透传联网来源 + 已核实卖点，让前端能展示「引用了哪些测评」
                plan["introSummary"] = intro_summary
                plan["introHighlights"] = intro_highlights
                plan["sources"] = sources
                # 落库（去 _usage）
                save_copy = {k: v for k, v in plan.items() if k != "_usage"}
                _subscription_service.save_product_content(key, plan=save_copy)
                yield {"type": "thinking", "content": "推广方案生成完成。"}
                yield {"type": "plan", "plan": plan, "usage": plan.get("_usage"), "cached": False}
                return
        except Exception as e:
            print(f"[CANDIDATE] 生成推广方案失败（降级）: {e}")

        # 降级模板（同样补齐新字段，保证前端不缺字段）
        fallback_plan = {
            "title": f"{name} 推广方案",
            "hooks": ["这个价位的实力派，先码住", "用了一周，说说真实感受", "同价位里它凭什么被反复回购"],
            "body": f"最近在用的{name}（{brand}），价格{price}{('，佣金' + comm_text) if comm_text else ''}，整体体验在线，"
            f"适合想入门又不想踩坑的朋友。先从小样/单品试起，跑通再囤。",
            "sellingPoints": selling or intro_highlights or ["性价比在线", "适合新手", "复购率高"],
            "targetAudience": (intro_suitable and "、".join(intro_suitable)) or "泛美妆人群，偏入门/性价比敏感型",
            "influencerType": "平价好物素人 / 成分党测评博主",
            "openingHook": f"这个价位的{name}，到底值不值得冲？",
            "commentInteraction": "评论区扣『想要』，抽3位送同款小样",
            "complianceRisk": "避免『最有效/第一』等绝对化用语；功效宣称需有依据，不承诺医疗效果",
            "kpi": "短视频点击率≥3%、7日ROI≥1.2 即视为跑通",
            "abTest": "对照方向A（价格利益点）vs 方向B（真实测评对比），看哪类开头点击更高",
            "budget": "测品期3天、每条投200元测流，跑出爆款再加权投放",
            "platforms": [
                {"name": "抖音", "angle": "短视频实测 + 口播种草，强调价格与效果"},
                {"name": "小红书", "angle": "图文测评 + 真实体验，强调成分与肤感"},
            ],
            "schedule": "每天 1 条短视频 + 3 篇图文，连测 7 天看转化",
            "cEndPromotion": {
                "mainstream": "C 端主流推广：内容种草 + 佣金带货，主推抖音/快手/小红书/视频号/淘宝客",
                "channels": ["抖音精选联盟（短视频+直播切片）", "小红书种草（图文+测评）", "视频号/淘宝客（私域+社群）"],
                "contentAngles": ["真实测评/成分党种草", "价格利益点/性价比对比"],
                "commissionStrategy": "选高佣且好转化的品，佣金话术前置，配合粉丝运营与直播切片放量",
            },
            "bEndPromotion": {
                "mainstream": "B 端主流推广：招商铺货 + 渠道分销，主攻 1688/拼多多批发/产业带",
                "channels": ["1688 批发/一件代发", "拼多多批发/产业带对接", "代理分销/社群团长"],
                "supplyStrategy": "给出有竞争力的供货价与利润空间，设计招商政策（首批拿样/阶梯返点）",
                "distributionStrategy": "搭建代理分销体系，先跑通 2-3 个渠道样板再复制扩张",
            },
            "introSummary": intro_summary,
            "introHighlights": intro_highlights,
            "sources": sources,
        }
        yield {"type": "thinking", "content": "生成遇到波动，改用兜底模板保证方案可用…"}
        _subscription_service.save_product_content(key, plan=fallback_plan)
        yield {"type": "plan", "plan": fallback_plan, "usage": None, "cached": False}

    async def generate_product_intro(self, product: Dict[str, Any]) -> Dict:
        """生成商品介绍：基于好单库字段 + 联网真实测评文章，让 LLM 合成结构化介绍。

        返回：{summary, highlights[], suitableFor[], howToUse, pricePositioning, sources[], _usage?}
        - 落库：product_contents 表按商品 key 持久缓存（重启不丢、避免重复花钱，2026-08-25）。
        - _usage：本次 LLM 用量 {model, tokens_in, tokens_out, tokens_cached}（路由据此按 token 计费）；
          命中缓存时 _usage 为 None（不重复收费）。
        """
        key = _product_key(product)
        # 1) 持久缓存优先（DB），进程内缓存二次加速
        cached = _subscription_service.get_product_content(key)
        if cached.get("intro"):
            intro = dict(cached["intro"])
            intro["_cached"] = True
            return intro
        if key in _intro_cache:
            intro = dict(_intro_cache[key])
            intro["_cached"] = True
            return intro

        name = product.get("title") or product.get("productName") or product.get("brand") or "该商品"
        brand = product.get("brand") or ""
        price = product.get("priceText") or product.get("price") or ""
        comm = product.get("commissionRatio")
        comm_text = f"佣金约{comm}%" if comm is not None else ""

        # 2) 联网检索真实测评/文章（无 key 则 sources 为空，降级 AI-only）
        kw = extract_search_keyword(name) or (brand or name)[:20]
        query = f"{kw} 测评 真实使用感受 怎么样"
        sources: List[Dict] = []
        try:
            results = await beauty_crawler.search_product_articles(query, num=5)
            sources = [{"title": r.get("title", ""), "link": r.get("link", "")} for r in results if r.get("link")]
        except Exception as e:
            print(f"[CANDIDATE] 商品介绍联网检索失败: {e}")
            sources = []

        web_context = ""
        if sources:
            lines = [f"{i}. {r.get('title', '')}：{r.get('snippet', '')}" for i, r in enumerate(results[:5], 1)]
            web_context = "\n".join(lines)

        # 3) 让 LLM 基于「好单库字段 + 真实文章」合成介绍
        prompt = (
            "你是资深美妆选品顾问。基于下方『商品信息』和『网上真实测评/文章』，为商户生成一份商品介绍，"
            "严格按 JSON 返回，不要其他内容：\n"
            '{"summary":"一句话介绍（这是什么、核心定位，30字内）",'
            '"highlights":["核心卖点1","核心卖点2","核心卖点3"],'
            '"suitableFor":["适合人群/肤质1","适合人群/肤质2"],'
            '"howToUse":"用法与注意事项（口语化，1-2句）",'
            '"pricePositioning":"价格定位（结合好单库价格，1句）"}\n\n'
            f"商品信息：{name}｜品牌：{brand}｜价格：{price}" + (f"｜{comm_text}" if comm_text else "") + "\n"
        )
        if web_context:
            prompt += (
                f"\n网上真实测评/文章（用于佐证，不要照搬、要自然融入）：\n{web_context}\n"
            )
        prompt += (
            "\n要求：\n"
            "1. 介绍要基于真实信息，不编造数据；网上文章不足时可用通用美妆经验补充但保持谨慎。\n"
            "2. highlights 是消费者最关心的 2-3 个卖点，具体不空泛。\n"
            "3. suitableFor 写清适合的人群/肤质/场景。\n"
            "4. 不要出现『根据知识库/检索结果显示/联网搜索』等生硬话术。\n"
            "5. 只返回 JSON。\n"
            "6. 不要 AI 套话：避免「整体来看/值得注意的是/综合而言/为您」等表达，破折号（——）不要滥用；"
            "像真人操盘手口述，具体、有判断。"
        )

        try:
            # 加速（2026-08-26）：商品介绍改走 DeepSeek-V3（比默认 V4-Flash 快 8 倍+，单价更低）。
            # 介绍是「字段抽取 + 真实数据整理」型任务，V4-Flash 的深度推理收益有限，V3 足够快。
            resp = await ai_service.chat(
                [{"role": "user", "content": prompt}], temperature=0.6, model="deepseek-ai/DeepSeek-V3"
            )
            raw = resp["choices"][0]["message"]["content"].strip()
            raw = raw.split("```")[1].lstrip("json") if "```" in raw else raw
            intro = json.loads(raw)
            if isinstance(intro, dict):
                intro["sources"] = sources
                usage = (resp.get("usage") or {})
                intro["_usage"] = {
                    "model": resp.get("model") or "unknown",
                    "tokens_in": int(usage.get("prompt_tokens") or 0),
                    "tokens_out": int(usage.get("completion_tokens") or 0),
                    "tokens_cached": int(usage.get("prompt_cache_hit_tokens") or 0),
                }
                # 落库（去 _usage，避免把计费元数据存进缓存）
                save_copy = {k: v for k, v in intro.items() if k != "_usage"}
                _subscription_service.save_product_content(key, intro=save_copy)
                _intro_cache[key] = save_copy
                return intro
        except Exception as e:
            print(f"[CANDIDATE] 生成商品介绍失败（降级）: {e}")

        # 降级：好单库字段拼一份最小介绍
        fallback = {
            "summary": f"{name}（{brand}），价格{price or '待定'}，可作为选品候选。",
            "highlights": ["具体卖点待补充（生成失败）"],
            "suitableFor": [],
            "howToUse": "",
            "pricePositioning": price or "",
            "sources": sources,
        }
        _subscription_service.save_product_content(key, intro=fallback)
        _intro_cache[key] = fallback
        return fallback


    async def check_changes(self, user_id: str) -> List[Dict]:
        """佣金/价格变动提醒（按需，前端点「检查变动」时触发）：

        对候选池每个商品，用其品牌/标题提炼干净品类词去好单库找当前在售同类，取最匹配一条
        的佣金/价格作为「当前市场值」，与归档时存的基线（commissionRatio/price）做差。
        差超过阈值（佣金±5个百分点、或价格±8%）则标记 changed，并把最新值写回候选（updatedAt 更新）。
        返回有变动的商品清单（空数组=无变动）。
        说明：好单库不暴露单品实时详情接口，这里用「同类在售最优匹配」近似，定位是市场变动信号而非逐件精确对账。
        注意：好单库竞品接口不返回价格（price 恒为 null），故价格变动分支（flag_price）当前不会触发，仅佣金变动生效；
        若日后接入能返回真实价格的来源（商品详情/转链 API），价格±8% 分支会自动可用，无需改此处逻辑。
        """
        if not user_id:
            return []
        async with _lock:
            data = _load_all()
            lst = data.get(user_id, [])
            if not lst:
                return []
            changed: List[Dict] = []
            dirty = False
            for c in lst:
                if not c.get("id"):
                    continue
                base_comm = c.get("commissionRatio")
                base_price = c.get("price") or ""
                title = (c.get("productName") or c.get("brand") or "")
                brand = c.get("brand") or ""
                try:
                    comps = await self.get_competitors(keyword=title, brand=brand, limit=6)
                except Exception as e:
                    print(f"[CANDIDATE] 检查变动查竞品失败({title}): {e}")
                    comps = []
                best = self._best_match(c, comps)
                cur_comm = best.get("commissionRatio") if best else None
                cur_price = best.get("price") if best else None
                if best is None:
                    continue
                flag_comm = (
                    isinstance(base_comm, (int, float))
                    and isinstance(cur_comm, (int, float))
                    and abs(float(cur_comm) - float(base_comm)) >= 5
                )
                base_price_num = self._price_num(base_price)
                cur_price_num = self._price_num(cur_price)
                flag_price = (
                    base_price_num is not None
                    and cur_price_num is not None
                    and base_price_num > 0
                    and abs(cur_price_num - base_price_num) / base_price_num >= 0.08
                )
                if flag_comm or flag_price:
                    rec = {
                        "id": c["id"],
                        "productName": c.get("productName") or c.get("brand") or "商品",
                        "commOld": base_comm,
                        "commNew": cur_comm,
                        "priceOld": base_price,
                        "priceNew": cur_price,
                        "commChanged": bool(flag_comm),
                        "priceChanged": bool(flag_price),
                    }
                    changed.append(rec)
                    # 把最新市场值写回候选，作为下一轮基线
                    if flag_comm and cur_comm is not None:
                        c["commissionRatio"] = cur_comm
                    if flag_price and cur_price:
                        c["price"] = cur_price
                    c["updatedAt"] = _now_iso()
                    # 在候选上打变动标记，让前端「佣/价变动」徽标能持久显示
                    c["changes"] = [rec]
                    dirty = True
                else:
                    # 本轮该商品市场值已与基线一致 → 清掉旧提醒标记（徽标自动消失）
                    if c.get("changes"):
                        c["changes"] = []
                        dirty = True
            if changed or dirty:
                data[user_id] = lst
                _save_all(data)
            return changed

    @staticmethod
    def _price_num(price: Any) -> Optional[float]:
        if price is None:
            return None
        s = str(price).replace(",", "").replace("￥", "").replace("¥", "")
        m = None
        for token in s.split():
            mm = re.search(r"(\d+(?:\.\d+)?)", token)
            if mm:
                m = mm
                break
        if m:
            try:
                return float(m.group(1))
            except Exception:
                return None
        return None

    @staticmethod
    def _best_match(cand: Dict, comps: List[Dict]) -> Optional[Dict]:
        """从竞品列表里挑与候选最匹配的一条（同品牌优先，否则取第一个有佣/价的）。"""
        if not comps:
            return None
        brand = (cand.get("brand") or "").strip()
        if brand:
            for cp in comps:
                if (cp.get("brand") or "").strip() and (cp.get("brand") or "").strip() == brand:
                    return cp
        # 退而求其次：有佣金或价格的第一条
        for cp in comps:
            if cp.get("commissionRatio") is not None or cp.get("price"):
                return cp
        return comps[0]

    async def generate_plan_promo_strategy(
        self, plan: Dict[str, Any], products: List[Dict[str, Any]]
    ) -> Dict:
        """生成「计划级」整合推广策略：把测品计划里的多个商品统筹成一套打法。

        输入：
          plan     —— {id, name, direction?, note?, status, productIds[]}
          products —— 计划内商品的富字段列表（含 name/brand/price/commissionRatio/
                       competitionLevel/platform/sellingPoints），由前端透传。
        输出整合策略字段：overview / theme / sequence / budgetSplit / risk /
                       kpi / contentCalendar / platforms。失败降级给出最小可用策略。
        """
        plan_name = plan.get("name") or "测品计划"
        direction = plan.get("direction") or plan.get("note") or ""
        product_lines = []
        for i, p in enumerate(products):
            nm = p.get("title") or p.get("productName") or p.get("brand") or f"商品{i+1}"
            bits = [nm]
            if p.get("brand"):
                bits.append(f"品牌:{p.get('brand')}")
            if p.get("price"):
                bits.append(f"价格:{p.get('price')}")
            comm = p.get("commissionRatio")
            if comm is not None:
                bits.append(f"佣金:{comm}%")
            if p.get("competitionLevel"):
                bits.append(f"竞品:{p.get('competitionLevel')}")
            if p.get("platform"):
                bits.append(f"平台:{p.get('platform')}")
            if p.get("sellingPoints"):
                bits.append("卖点:" + "、".join(p.get("sellingPoints")))
            product_lines.append("· " + "｜".join(bits))
        product_block = "\n".join(product_lines) if product_lines else "（计划内暂无商品明细）"
        prompt = (
            "你是美妆带货操盘手。下面是一份『测品计划』及其包含的商品（含好单库真实佣金/价格/竞品数据）。"
            "请站在计划全局，把多个商品统筹成一套整合推广策略，严格按 JSON 返回，不要其他内容：\n"
            '{"overview":"一句话计划定位（这个计划要打什么、给谁）",'
            '"theme":"统一主题与人设（贯穿所有商品的内容主线）",'
            '"sequence":["打品顺序建议1(先打哪款、为什么)","打品顺序建议2",...],'
            '"budgetSplit":"预算分配建议（按商品/阶段分配，含每款测试期投入）",'
            '"risk":"整体风险与合规提示（同质化/功效宣称/排期）",'
            '"kpi":"计划级KPI（整体ROI/起量目标/合格线）",'
            '"contentCalendar":"建议内容日历（如：第1-3天测品蓄水、第4-7天爆款加码）",'
            '"platforms":["主推平台组合与分工1","主推平台组合与分工2"]}\n\n'
            f"计划名称：{plan_name}"
            + (f"｜方向：{direction}" if direction else "")
            + f"\n计划内商品（{len(products)} 个）：\n{product_block}\n"
            "要求：sequence 按「哪款先打、为什么」排优先序；budgetSplit 要具体有数；"
            "risk 结合竞品强度；所有字段可落地、不空泛。只返回 JSON。"
        )
        try:
            resp = await ai_service.chat([{"role": "user", "content": prompt}], temperature=0.6)
            raw = resp["choices"][0]["message"]["content"].strip()
            raw = raw.split("```")[1].lstrip("json") if "```" in raw else raw
            strategy = json.loads(raw)
            if isinstance(strategy, dict):
                strategy["planName"] = plan_name
                strategy["generatedAt"] = _now_iso()
                return strategy
        except Exception as e:
            print(f"[CANDIDATE] 生成计划级推广策略失败（降级）: {e}")
        # 降级
        return {
            "overview": f"{plan_name}：先小预算测品跑通单款，再复制打法扩量",
            "theme": direction or "平价好物真实测评",
            "sequence": [f"先打「{p.get('title') or p.get('brand') or '商品' + str(i+1)}」测流（信息最完整、佣金最高者优先）" for i, p in enumerate(products[:3])]
            or ["先打信息最完整、佣金最高的单款"],
            "budgetSplit": "测品期每款投150-200元/条测流，跑出ROI≥1.2的爆款再加码到500-800元/条",
            "risk": "避免同质化混剪；功效宣称需有据，不踩化妆品广告法红线",
            "kpi": "计划整体7日ROI≥1.2、至少跑出1个稳定起量单品",
            "contentCalendar": "第1-3天测品蓄水（多选题测流）；第4-7天爆款加码；第8天复盘定扩量清单",
            "platforms": ["抖音：短视频强转化主阵地", "小红书：图文种草蓄水"],
            "planName": plan_name,
            "generatedAt": _now_iso(),
        }


candidate_service = CandidateService()
