import asyncio
import httpx
import re
import time
from typing import Dict, List, Optional
from urllib.parse import quote

from app.core.config import settings
# 复用 crawler_service 已验证的品牌/品类识别能力，保证 Layer ② 与 Layer ③ 线索格式一致
from app.services.crawler_service import _BEAUTY_BRANDS, _PRODUCT_TYPES, _GENERIC_PRODUCT_TYPES, _zh_norm, BeautyDataCrawler
# B 档趋势：每次搜索把当日快照写入时间序列库（itemid 是同商品追踪主键）
from app.services import trend_service
# 大淘客：单品诊断（num_iid 维度）+ 关键词搜索，与好单库互补（见 dataoke_service.py）
from app.services.dataoke_service import normalize_dataoke_item, search_goods, get_goods_comments
# Serper 联网搜索：买家口碑兜底源（大淘客评论接口未授权时，用网上公开讨论风向补位）
from app.services.search_service import search_service


# 字段容错：好单库不同套餐返回字段名略有差异，这里多候选名兜底（已实测 v3.api.haodanku.com/itemlist 字段）
_FIELD_CANDIDATES = {
    "title": ["itemtitle", "itemshorttitle", "title", "goods_title", "name", "item_title", "goods_name"],
    "price_final": ["itemendprice", "final_price", "end_price", "price", "actual_price", "coupon_price_after", "item_end_price"],
    "price_origin": ["itemprice", "goods_price", "original_price", "reserve_price", "zk_final_price", "origin_price"],
    "coupon": ["couponmoney", "coupon_money", "coupon_price", "coupon_discount", "coupon_amount", "youhui"],
    # 优惠券文案（如"满199减100"）；关键词/详情接口都返回，之前没透传，导致前端从没显示过领券信息
    "coupon_info": ["couponinfo", "coupon_condition", "couponexplain"],
    "commission_ratio": ["tkrates", "commission", "commission_ratio", "ratio", "commission_rate"],
    "commission_money": ["tkmoney", "commission_money", "commission_amount", "estimated_commission"],
    "sales": ["itemsale", "itemsale2", "todaysale", "month_sales", "sales_num", "sales", "volume", "sell_num"],
    "image": ["itempic", "pic", "main_img", "img", "item_img", "image"],
    # 注意：好单库关键词接口不含"直接商品 URL"字段（item_url/url/itemurl 等根本不存在）。
    # 唯一真实可点的商品链接是 couponurl（uland 淘客券链，有券才有）；product_id 是站内 id 不是淘宝 num_iid，
    # itemid 是加密串，都拼不出能打开的详情页。落地链接统一在 _build_product_link 里构造，无 couponurl 则过滤。
    "url": ["couponurl", "planlink"],
    "shop": ["shopname", "sellernick", "shop_title", "shop_name", "seller", "shop"],
    "brand": ["brand", "brand_name"],
    "cat": ["fqcat", "cat_name", "cid", "category_name"],
    # itemid：好单库加密串，拼不出真实详情页（见 _build_product_link 注释），但作为「同商品」追踪主键用于 B 档趋势
    "itemid": ["itemid", "goods_id", "gid"],
}


def _pick(d: Dict, key: str):
    for cand in _FIELD_CANDIDATES.get(key, [key]):
        if cand in d and d[cand] not in (None, ""):
            return d[cand]
    return None


def _build_product_link(item: Dict, title: str) -> str:
    """构造可点击的商品落地链接。

    实测关键结论：好单库关键词接口里——
      - `couponurl`(uland.taobao.com/quan/detail) 才是真实可点的商品链接（淘客券链，能正常打开宝贝页/领券购买）；
      - `product_id` 是**好单库站内 id（仅 8 位），不是淘宝 num_iid**，拿它拼 item.taobao.com/item.htm?id= 会报"宝贝不存在"；
      - `itemid` 是加密串（base64 解码是乱码），`num_iid` 字段根本不存在，都拼不出真实链接。
    所以：优先 couponurl（真实能开）；没有就返回 ""，由 _normalize 把该商品过滤出局（"查不到宝贝就不展示"）。
    """
    coupon = (item.get("couponurl") or "").strip()
    if coupon:
        return coupon
    plan = (item.get("planlink") or "").strip()
    if plan:
        return plan
    return ""


# 好单库 get_keyword_items 的 back(每页条数) 必须是白名单值，否则 code=0 报错
_ALLOWED_BACK = [1, 2, 5, 10, 20, 50, 100, 120, 200, 500, 1000]


def _snap_back(n: int) -> int:
    for v in _ALLOWED_BACK:
        if v >= n:
            return v
    return _ALLOWED_BACK[-1]


def _resolve_haodanku_cid(category: str) -> str:
    """把品类模式映射成好单库 cid。

    - general：cid=0 表示「全部类目」（全品类搜索）。
    - beauty / 空：用项目定位 cid（默认 4=美妆）。
    """
    if category == "general":
        return "0"
    return str(settings.HAODANKU_CID)


def _resolve_dataoke_cids(category: str, keyword: str) -> Optional[str]:
    """把品类模式映射成大淘客 cids（一级类目字符串）。

    - 有关键词：走搜索接口，不限制类目（cids=None）。
    - general 无关键词：全品类浏览（cids=None）。
    - beauty / 空 无关键词：用项目定位 cid（默认 3=美妆）。
    """
    if keyword:
        return None
    if category == "general":
        return None
    return str(settings.DATAOKE_CID)


def _norm_dedup_key(title: str) -> str:
    """双源合并去重键：标题归一化（去空白/标点/小写），用于剔除好单库与大淘客的重复商品。"""
    if not title:
        return ""
    t = _zh_norm(title).lower()
    for ch in " \t\n·•・-—_/()（）[]【】,，.。:：;；'\"\"":
        t = t.replace(ch, "")
    return t


# 选品问句的意图抽取：从自然语言问题里提取一个干净的好单库搜索词。
# 优先级：品牌+品类 > 品类 > 品牌 > 功效词。抽不到返回 ""（交给频道浏览兜底）。
_SEARCH_NOUNS = [
    "美白", "抗皱", "抗老", "淡纹", "祛痘", "淡斑", "祛斑", "去闭口",
    "保湿", "控油", "舒缓", "修护", "紧致", "敏感肌", "敏感", "提亮", "去黄",
]


def _longest_match(text: str, words) -> Optional[str]:
    """按长度降序取 text 中首个命中的词，天然规避「卸妆巾」被短词「卸妆」抢先的子串误配。

    输入 words 可为任意顺序（内部按 len 降序稳定排序），只认长度最长且完整落进 text 的词。
    """
    ordered = sorted(words, key=len, reverse=True)
    return next((w for w in ordered if w in text), None)


def dict_hit_keyword(question: str) -> str:
    """仅返回词典【真实命中】的品牌/品类/名词搜索词，不做 general 粗剥。

    用途：区分「词典真命中」与「_generic_keyword 粗剥产生的残词」。general 模式下
    extract_search_keyword 会在词典未命中时走 _generic_keyword 粗剥（可能产出
    「结合网最新热度」这类把状语当产品词的残词），本函数只返回词典真命中（含
    _GENERIC_PRODUCT_TYPES 里的通用品类词），词典未命中返回 ""（供调用方改走 LLM 语义抽取）。
    """
    if not question:
        return ""
    text = _zh_norm(question)
    brand = next((b for b in _BEAUTY_BRANDS if b.lower() in text.lower()), None)
    ptype = _longest_match(text, _GENERIC_PRODUCT_TYPES + _PRODUCT_TYPES)
    noun = next((n for n in _SEARCH_NOUNS if n in text), None)
    if brand and ptype:
        return f"{brand} {ptype}"
    if ptype:
        return ptype
    if brand:
        return brand
    if noun:
        return noun
    return ""


def extract_search_keyword(question: str, category: str = "beauty") -> str:
    """同步抽取搜索词（词典优先 + 通用剥词兜底）。

    注意：本函数保持同步，仅做词典匹配与启发式剥词（无 LLM 调用），供不需要 LLM 兜底、
    或已处于事件循环内不想阻塞的场景使用。真正需要「任意品类都能抽到」的链路
    （卡片生成/主回答上下文）应调用异步版 extract_search_keyword_async（含 LLM 语义兜底）。
    """
    if not question:
        return ""
    text = _zh_norm(question)
    # 词典已按长度降序，next 取到即最长匹配，避免子串误匹配。
    brand = next((b for b in _BEAUTY_BRANDS if b.lower() in text.lower()), None)
    # 关键修复（2026-08-26）：通用品类词典含更完整的商品名（卸妆巾/洁面巾/洗脸巾），
    # 若它在 text 里命中且比 beauty 短词（卸妆/洁面/洗面）更长，必须优先用完整商品词，
    # 否则「卸妆巾」会被 beauty 的「卸妆」子串抢先，抽成大类词 → 好单库搜出不相干商品。
    # 做法：在两词典组成的合并列表里按【长度降序】取最长命中，谁长谁说了算。
    ptype = _longest_match(text, _GENERIC_PRODUCT_TYPES + _PRODUCT_TYPES)
    noun = next((n for n in _SEARCH_NOUNS if n in text), None)
    if brand and ptype:
        return f"{brand} {ptype}"
    if ptype:
        return ptype
    if brand:
        return brand
    if noun:
        return noun
    # 美妆词典没命中时，beauty 模式保持空（交给频道浏览兜底）；
    # general 模式做一次通用兜底：剥掉常见提问/语气词，取剩余的产品/品类名词短语去搜全品类。
    if category == "general":
        return _generic_keyword(question)
    return ""


async def extract_search_keyword_async(question: str, category: str = "beauty") -> str:
    """异步抽取搜索词（词典优先 + LLM 语义兜底）——通用修复（2026-08-27）。

    词典永远有盲区（如「鸡蛋/蓝牙耳机/露营帐篷」等从未人工收录的品类），
    词典未命中时用 LLM 从自然语言里抽「用户真正想搜的商品/品类词」，理解语义、无盲区。
    防护：TTL 缓存（同问题只调一次 LLM）+ 硬超时 + 失败回落 _generic_keyword，保证不空转。
    本函数是 async，必须 await（调用方均已在 async 方法内，可正确 await 不阻塞事件循环）。
    """
    if not question:
        return ""
    text = _zh_norm(question)
    brand = next((b for b in _BEAUTY_BRANDS if b.lower() in text.lower()), None)
    ptype = _longest_match(text, _GENERIC_PRODUCT_TYPES + _PRODUCT_TYPES)
    noun = next((n for n in _SEARCH_NOUNS if n in text), None)
    if brand and ptype:
        return f"{brand} {ptype}"
    if ptype:
        return ptype
    if brand:
        return brand
    if noun:
        return noun
    if category == "general":
        # 词典未命中：LLM 语义兜底优先，失败回落 _generic_keyword（保证不空、不乱搜）
        llm_kw = await _llm_extract_keyword_async(question)
        if llm_kw:
            return llm_kw
        return _generic_keyword(question)
    return ""


# general 模式兜底：去掉常见的提问前缀/语气词/标点，保留最像「产品名/品类名」的短语。
#  heuristic 但足够让全品类搜索跑起来（如「推荐个蓝牙耳机」→「蓝牙耳机」）。
_GENERIC_STOP = [
    "推荐个", "推荐一", "推荐", "帮我", "看看", "有啥", "有什么", "有哪", "哪个好", "哪款好",
    "我想做", "我想卖", "我想买", "怎么做", "怎么选", "怎么挑", "如何", "求推荐",
    "有什么", "选品", "选个", "卖什么", "做什么", "分析一下", "分析下", "了解一下",
    "想知道", "请问", "请问一下", "给我", "来个", "整一个", "整款", "整点", "一个",
    "这款", "那款", "这个", "那个", "可以", "适合", "值得", "能不能", "是不是",
    "吗", "呢", "吧", "啊", "哦", "哈", "的", "了", "下", "下吗", "一下",
    "？", "?", "。", ".", "，", ",", "、", "：", ":", "（", "）", "(", ")",
    " ", "　", "帮我看", "看下", "看一", "看看", "想", "要", "找", "上", "下",
    # 方向类追问的提问框架词：剥掉后保留「美妆个护」「敏感肌」等品类短语去搜
    # 注意：不要放「品类」——「女生用品类目」里「品」+「类」恰好构成子串「品类」，
    # 会被误删成「女生用目」，破坏品类词。改用下方的独立品类词典(extract_search_keyword)抽取。
    "里", "最近", "哪个", "哪些", "什么", "细分", "增长", "最快", "方向", "赛道",
    "好卖", "好做", "值得做", "能不能做", "前景", "潜力", "切入", "分析", "盘点",
]


def _generic_keyword(question: str) -> str:
    q = (question or "").strip()
    if not q:
        return ""
    # 只取第一句（避免把续问/解释带进搜索词）
    q = q.split("？")[0].split("?")[0].split("。")[0].split(".")[0].split("，")[0].split(",")[0]
    q = _zh_norm(q)
    for w in _GENERIC_STOP:
        q = q.replace(w, "")
    q = q.strip(" 　，。、？?!！:：()（）-—_/\\")
    if len(q) < 2:
        return ""
    return q[:20]


# ─────────────────────────────────────────────────────────────
# LLM 语义抽取兜底（2026-08-27，通用修复：根治词典盲区）
# 词典未命中（如「鸡蛋」「蓝牙耳机」「露营帐篷」等从未人工收录的品类）时，
# 用 LLM 从自然语言里抽「用户真正想搜的商品/品类词」。LLM 理解语义，无盲区。
# 防护：进程内 TTL 缓存（同问题只调一次 LLM）+ 硬超时 + 失败回落 _generic_keyword。
# 惰性 import ai_service（union_service 被 ai_service 引用，顶层 import 会循环依赖）。
# ─────────────────────────────────────────────────────────────
_llm_kw_cache: Dict[str, tuple] = {}  # (ts, kw)；_LLM_KW_TTL 内命中复用
_LLM_KW_TTL = 3600  # 1 小时：同一问题抽词结果很稳定，值得缓存（防并发反复打 LLM）


def _get_llm_kw_cache(key: str) -> Optional[str]:
    import time as _t
    item = _llm_kw_cache.get(key)
    if item is None:
        return None
    ts, val = item
    if (_t.time() - ts) < _LLM_KW_TTL:
        return val
    _llm_kw_cache.pop(key, None)
    return None


def _llm_extract_keyword(question: str) -> str:
    """同步包装：仅供不支持 async 的调试/临时调用。生产链路请用 extract_search_keyword_async。

    说明：LLM 抽取是异步 IO，本同步版本无法真正 await（会丢失 LLM 结果），
    因此这里直接返回 ""（交给 _generic_keyword 兜底），并打印一次提示，
    避免任何同步调用点因「拿不到结果」而误以为抽词成功。
    """
    print("[UNION] _llm_extract_keyword 是同步版本（无 LLM 效果）；请走 async extract_search_keyword_async")
    return ""


async def _llm_extract_keyword_async(question: str) -> str:
    """LLM 语义抽取兜底（async）：从自然语言问题里抽一个干净的商品/品类搜索词。

    只返回「可信的商品词」，否则返回 ""（交给 _generic_keyword 兜底），
    失败/超时/无 ai_service 一律返回 ""，绝不让抽词失败拖垮主链路。
    """
    if not question:
        return ""
    q = (question or "").strip()[:60]
    cached = _get_llm_kw_cache(q)
    if cached is not None:
        return cached
    # 惰性导入，避免循环依赖
    try:
        from app.services.ai_service import ai_service
    except Exception:
        return ""
    try:
        prompt = (
            "你是电商选品的搜索词提取助手。请从用户这句话里，提取出「用户想要查的**商品/品类**」搜索词，"
            "用于去电商联盟平台搜商品。\n"
            "如果是场景描述（如'结合最新热度分析鸡蛋带货'），只提取品类实体（如：鸡蛋）。\n"
            "如果没有明确的商品词，返回 {\"kw\": \"\"}。\n"
            "只返回一个 JSON 对象，格式 {\"kw\": \"商品词\"}，不要任何解释、多余字段、标点或代码块。\n"
            f"用户：{q}"
        )
        # _chat_json 内置 timeout=4.0 硬超时，失败/超时返回 None（不会无限挂起）。
        # 注意：_chat_json 会 json.loads 输出，所以 prompt 必须让它返回合法 JSON。
        result = await ai_service._chat_json(
            [{"role": "user", "content": prompt}],
            temperature=0.0,
            timeout=4.0,
            model="deepseek-ai/DeepSeek-V3",
        )
        if isinstance(result, dict):
            kw = (result.get("kw") or "").strip()
        elif isinstance(result, str):
            # 极少数模型返回纯文本（未走 json.loads），提取第一个候选
            kw = result.strip()
            # 去掉可能的引号/包裹符
            kw = re.sub(r"[\"'“”]+", "", kw)
        else:
            kw = ""
        # 清洗：去掉引号/包裹符，只保留干净商品词
        kw = re.sub(r"[，。、\s\"'“”]+", "", kw or "")
        if kw and len(kw) <= 20 and kw != q:
            _llm_kw_cache[q] = (time.time(), kw)
            return kw
        # 极短/无效词不缓存（可能是 LLM 空/乱答），回落到明确失败
        return ""
    except Exception as e:
        print(f"[UNION] LLM 抽取关键词失败，回落通用兜底: {e}")
        return ""


def _to_float(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace("¥", "").replace("元", "").strip())
    except (ValueError, TypeError):
        return None


class UnionProductProvider:
    """联盟商品数据 Provider 抽象：搜索商品 -> 归一化线索 -> 注入 AI prompt。

    子类只需实现 _raw_search；基类负责字段容错、品牌/品类识别、缓存、格式化。
    """

    name: str = "union"

    def __init__(self):
        self._cache: Dict[str, tuple] = {}
        self._comments_cache: Dict[str, tuple] = {}  # 单商品买家评论缓存（dtk_id -> 归一化评论）
        self._reviews_cache: Dict[str, tuple] = {}   # format_buyer_reviews 整块缓存
        self._lock = asyncio.Lock()

    async def search_products(self, keyword: str = "", max_items: int = 12, category: str = "beauty") -> List[Dict]:
        """返回归一化商品线索（含价格/佣金/销量/链接）。无 key 或异常时返回空列表（优雅降级）。

        category: "beauty"=美妆(默认，对齐项目定位)；"general"=全品类(好单库 cid=0 / 大淘客不限类目)。

        2026-08-26 补「逐级缩短回退」：当顶级关联词(如「拖地湿巾」)在上游无数据时，
        自动按 去尾字 逐级缩小(拖地湿→拖地→拖)重试，命中即返回。这与 _select_comparison_products
        原本的缩短逻辑一致，但统一收敛到 search_products，让 数据卡/趋势卡/产品卡 全部受益。
        仅当 keyword 较长(>2)且首次为空时才回退，避免短词/空词的无谓重试。
        """
        cache_key = f"{keyword}|{category}|{max_items}"
        async with self._lock:
            hit = self._cache.get(cache_key)
            if hit and (time.time() - hit[0]) < settings.UNION_CACHE_TTL:
                return hit[1]

        leads = await self._raw_and_norm(keyword=keyword, max_items=max_items, category=category)
        # 长复合词无数据 → 逐级缩短回退（拖地湿巾 → 拖地湿 → 拖地 → 拖）
        if not leads and len(keyword) > 2:
            _t = keyword
            while len(_t) > 2 and not leads:
                _t = _t[:-1]
                leads = await self._raw_and_norm(keyword=_t, max_items=max_items, category=category)
            # 回退命中时，用实际命中的关键词更新缓存主键，避免下次重复回退
            if leads:
                keyword = _t

        async with self._lock:
            self._cache[cache_key] = (time.time(), leads)
        return leads

    async def _raw_and_norm(self, keyword: str = "", max_items: int = 12, category: str = "beauty") -> List[Dict]:
        """_raw_search + _normalize + 排序取前 max_items（search_products 的回退复用）。"""
        raw = await self._raw_search(keyword=keyword, max_items=max_items, category=category)
        leads = [self._normalize(item) for item in raw]
        leads = [l for l in leads if l]  # 丢弃归一化失败的
        # B 档趋势：把本次搜索结果写成「当日快照」，跨天积累成时间序列（无 key/无数据时为 no-op）
        try:
            trend_service.record_leads(keyword, leads)
        except Exception as e:
            print(f"[UNION] 趋势快照写入失败（降级，不影响选品）: {e}")
        # 按"有价格 > 佣金高 > 销量高"排序，优先呈现信息完整的商品
        leads.sort(key=lambda l: (l.get("price_value") is not None, l.get("commission_money") or 0, l.get("sales") or 0), reverse=True)
        return leads[:max_items]

    def _normalize(self, item: Dict) -> Optional[Dict]:
        if not item:
            return None
        title = _zh_norm(str(_pick(item, "title") or ""))
        if not title:
            return None
        price_final = _to_float(_pick(item, "price_final"))
        price_origin = _to_float(_pick(item, "price_origin"))
        coupon = _to_float(_pick(item, "coupon"))
        commission_ratio = _to_float(_pick(item, "commission_ratio"))
        commission_money = _to_float(_pick(item, "commission_money"))
        sales = _to_float(_pick(item, "sales"))
        itemid = _pick(item, "itemid")
        link = _build_product_link(item, title)
        if not link:
            # 查不到真实宝贝（无 product_id 也无 couponurl）→ 过滤掉，不进选品列表
            return None
        # 优惠券文案：好单库 couponinfo 字段常是裸数字（如"620"），不如券额可读；
        # 优先用券额拼"领券减X元"，若原始 couponinfo 含中文（如"满199减100"）则用原文，否则留空。
        coupon_info_raw = _pick(item, "coupon_info")
        if coupon_info_raw and any(ch in str(coupon_info_raw) for ch in ("减", "满", "券", "元")):
            coupon_info = str(coupon_info_raw)
        elif coupon and coupon > 0:
            coupon_info = f"领券减{coupon:.0f}元"
        else:
            coupon_info = ""
        # 好单库只给 uland 券链，给不出真实淘宝 num_iid/宝贝详情页 URL。
        # 下钻看商品用"淘宝搜索商品名"兜底（真实可打开、能看到商品），券链仍作为 affiliate 主路径。
        detail_url = f"https://s.taobao.com/search?q={quote(title)}"
        image = _pick(item, "image") or ""
        brand = _pick(item, "brand")
        if not brand:
            # 从标题按品牌词典识别
            for b in _BEAUTY_BRANDS:
                if b.lower() in title.lower():
                    brand = b
                    break
        ptype = BeautyDataCrawler._find_product_type(title)

        # 参考价文案：优先券后价，其次原价
        if price_final is not None:
            price_text = f"券后¥{price_final:.2f}" + (f"（原¥{price_origin:.2f}）" if price_origin else "")
        elif price_origin is not None:
            price_text = f"¥{price_origin:.2f}"
        else:
            price_text = ""
        comm_text = ""
        if commission_ratio is not None:
            comm_text += f"佣金{commission_ratio:.0f}%"
        if commission_money is not None:
            comm_text += f"≈¥{commission_money:.2f}"
        sales_text = f"月销{int(sales)}" if sales is not None else ""
        return {
            "brand": brand or "",
            "product_type": ptype or "",
            "price_text": price_text,
            "price_value": price_final or price_origin,
            "commission_ratio": commission_ratio,
            "commission_money": commission_money,
            "sales": sales,
            "itemid": itemid,
            "image": image,
            "link": link,
            "coupon_info": coupon_info,
            "detail_url": detail_url,
            "source": self.name,
            "shop_type": "",  # 好单库不返回平台(天猫/淘宝)字段，留空（平台筛选时会被过滤）
            "context": title[:120],
        }

    async def format_product_leads(self, keyword: str = "", category: str = "beauty") -> str:
        """把商品线索格式化为可注入 AI prompt 的文本（优先于 Serper 爬虫线索）。"""
        leads = await self.search_products(keyword=keyword, max_items=8, category=category)
        if not leads:
            return ""
        lines = []
        for l in leads:
            bits = []
            if l["brand"]:
                bits.append(l["brand"])
            if l["product_type"]:
                bits.append(l["product_type"])
            name = " ".join(bits) if bits else "商品"
            extra = "｜".join(x for x in [l["price_text"], l["commission_ratio"] and f"佣金{l['commission_ratio']:.0f}%", l["sales"] and f"月销{int(l['sales'])}"] if x)
            line = f"- {name}"
            if extra:
                line += f"｜{extra}"
            if l["link"]:
                line += f"（{l['link']}）"
            lines.append(line)
        header = "\n\n[联盟商品数据（多平台聚合，含价格/佣金/销量/推广链接，非平台成交原始数据，仅供选品参考）]\n"
        return header + "\n".join(lines)

    async def compute_market_signals(self, keyword: str = "", max_items: int = 300, category: str = "beauty") -> Dict:
        """从归一化商品线索聚合出"机会方向"卡片可用的真实市场信号。无数据返回空 dict。"""
        leads = await self.search_products(keyword=keyword, max_items=max_items, category=category)
        if not leads:
            return {}
        prices = [l["price_value"] for l in leads if l.get("price_value") is not None]
        comms = [l["commission_ratio"] for l in leads if l.get("commission_ratio") is not None]
        comm_money = [l["commission_money"] for l in leads if l.get("commission_money") is not None]
        sales = [l["sales"] for l in leads if l.get("sales") is not None]
        brand_counter: Dict[str, int] = {}
        for l in leads:
            b = l.get("brand")
            if b:  # 只统计有真实品牌的，避免把无牌商品算成"其他"品牌
                brand_counter[b] = brand_counter.get(b, 0) + 1
        top_brands = sorted(brand_counter.items(), key=lambda x: -x[1])[:3]

        def _median(xs):
            xs = sorted(xs)
            n = len(xs)
            return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2

        price_band = f"¥{min(prices):.0f}-{max(prices):.0f}" if prices else ""
        # 真实来源统计：卡片 source 标注用（好单库 apikey 为空时实际只有大淘客出数据，
        # 之前写死「好单库」会误导；这里按 lead 的真实 source 字段统计）
        src_counter: Dict[str, int] = {}
        for l in leads:
            s = l.get("source") or "未知"
            src_counter[s] = src_counter.get(s, 0) + 1
        src_label = "、".join(f"{k}×{v}" for k, v in sorted(src_counter.items(), key=lambda x: -x[1]))
        return {
            "product_count": len(leads),
            "distinct_brands": len(brand_counter),
            "top_brands": [b for b, _ in top_brands],
            "price_min": min(prices) if prices else None,
            "price_max": max(prices) if prices else None,
            "price_median": _median(prices) if prices else None,
            "price_band": price_band,
            "avg_commission_ratio": round(sum(comms) / len(comms), 1) if comms else None,
            "avg_commission_money": round(sum(comm_money) / len(comm_money), 2) if comm_money else None,
            "total_sales": int(sum(sales)) if sales else None,
            "avg_sales": int(sum(sales) / len(sales)) if sales else None,
            "source_counts": src_counter,
            "source_label": f"{src_label}（淘宝/天猫联盟商品）" if src_label else "",
        }

    async def format_market_signals(self, keyword: str = "", max_items: int = 300, category: str = "beauty") -> str:
        """把聚合市场信号格式化为可注入 AI 正文的短文案。

        用于补「匿名/非卡片用户拿不到机会方向卡」的缺口：让通用对话里问某品类市场面
        （价格带/佣金/销量/竞争）时，正文也能带上真实数字。一次 compute_market_signals 调用，
        结果走 search_products 缓存近乎零成本。无数据返回空串。
        """
        signals = await self.compute_market_signals(keyword=keyword, max_items=max_items, category=category)
        if not signals or not signals.get("product_count"):
            return ""
        parts = []
        if signals.get("price_band"):
            med = signals.get("price_median")
            parts.append(f"价格带 {signals['price_band']}" + (f"（中位¥{med:.0f}）" if med is not None else ""))
        if signals.get("avg_commission_ratio") is not None:
            cm = signals.get("avg_commission_money")
            parts.append(f"平均佣金 {signals['avg_commission_ratio']:.0f}%" + (f"（≈¥{cm:.2f}/单）" if cm is not None else ""))
        if signals.get("total_sales") is not None:
            parts.append(f"近30天总销量约 {signals['total_sales']:,}（均值 {signals['avg_sales']:,}）")
        if signals.get("product_count"):
            parts.append(f"在售选品线索 {signals['product_count']} 条")
        if signals.get("distinct_brands"):
            parts.append(f"覆盖品牌 {signals['distinct_brands']} 个")
        if signals.get("top_brands"):
            parts.append(f"头部品牌：{'、'.join(signals['top_brands'])}")
        if not parts:
            return ""
        label = "市场聚合信号" if category == "general" else f"美妆市场聚合信号"
        return (
            f"\n[{label}（{keyword}）]\n"
            + "；".join(parts)
            + "\n（以上来自公开联盟商品聚合，非平台真实成交数据，仅供选品参考）"
        )

    async def get_buyer_comments(self, dtk_id, max_per_product: int = 5) -> List[Dict]:
        """取单个大淘客商品的买家评论（口碑）。dtk_id 是大淘客内部数字 id。

        封装 get_goods_comments + TTL 缓存；受「淘宝账号授权」门控——授权过期时接口返回业务错误码，
        这里优雅降级为 []（不抛错、不污染选品）。返回归一化后的 [{content, rate}]。
        """
        if not dtk_id:
            return []
        cache_key = str(dtk_id)
        async with self._lock:
            hit = self._comments_cache.get(cache_key)
            if hit and (time.time() - hit[0]) < settings.UNION_CACHE_TTL:
                return hit[1]
        try:
            raw_list = await get_goods_comments(dtk_id=dtk_id)
        except Exception as e:
            print(f"[UNION] 买家评论拉取异常（降级为空）: {e}")
            raw_list = None
        comments = []
        if raw_list:
            for c in raw_list[:max_per_product]:
                txt = (c.get("content") or c.get("text") or "").strip()
                if not txt:
                    continue
                rate = c.get("star") or c.get("score") or c.get("rate")
                comments.append({"content": txt, "rate": rate})
        async with self._lock:
            self._comments_cache[cache_key] = (time.time(), comments)
        return comments

    async def format_buyer_reviews(self, keyword: str = "", max_items: int = 6, sample: int = 2, category: str = "beauty") -> str:
        """对双源 top 大淘客商品取样评论，格式化为可注入 AI 正文的「买家口碑」块。

        数据源优先级：大淘客 per-SKU 评论（授权后自动启用，最精确） > Serper 网上公开讨论风向兜底。
        - 大淘客评论接口受「淘宝账号授权/套餐权限」门控：基础套餐无该 tab -> get_buyer_comments 恒空，
          此时自动落 Serper 兜底（搜「{keyword} 真实评价/吐槽/回购」），保证买家口碑块不恒空。
        - 两路都失败/无结果 -> 返回空串（AI 自然无买家口碑可引，不编造）。整块带缓存。
        """
        cache_key = f"rev|{keyword}|{max_items}|{sample}"
        async with self._lock:
            hit = self._reviews_cache.get(cache_key)
            if hit and (time.time() - hit[0]) < settings.UNION_CACHE_TTL:
                return hit[1]
        leads = await self.search_products(keyword=keyword, max_items=max_items, category=category)
        # 仅大淘库商品（带 dtk_id）能拉到 per-SKU 评论
        dtk_leads = [l for l in leads if l.get("dtk_id")]
        text = ""
        if dtk_leads:
            tasks = [self.get_buyer_comments(dtk_id=l["dtk_id"], max_per_product=sample) for l in dtk_leads]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            blocks = []
            for l, res in zip(dtk_leads, results):
                if isinstance(res, Exception) or not res:
                    continue
                name = (f"{l.get('brand', '')} {l.get('product_type', '')}").strip() or (l.get("context") or "")[:30]
                lines = [f"- {name}："]
                for i, c in enumerate(res[:sample], 1):
                    rate = c.get("rate")
                    lines.append(f"  {i}. {c['content']}" + (f"（{rate}星）" if rate else ""))
                blocks.append("\n".join(lines))
            if blocks:
                text = (
                    f"\n[买家口碑（大淘客商品评论，取样前 {sample} 条/商品，共 {len(blocks)} 个商品）]\n"
                    + "\n".join(blocks)
                    + "\n（评论来自大淘客商品评论接口，为买家公开评价摘要，非平台官方好评率）"
                )
        # 大淘客评论为空（未授权/基础套餐无权限）-> Serper 社媒风向兜底，保证买家口碑块不恒空
        if not text:
            text = await self._format_social_reviews(keyword=keyword, sample=sample)
        async with self._lock:
            self._reviews_cache[cache_key] = (time.time(), text)
        return text

    async def _format_social_reviews(self, keyword: str = "", sample: int = 2) -> str:
        """Serper 兜底：搜该品类「真实评价/吐槽/回购」类公开讨论，格式化为买家口碑块。

        大淘客评论接口未授权（基础套餐无该权限）时，用社媒风向补位，保证买家口碑块有真实内容。
        失败/无结果返回空串（AI 自然无买家口碑可引，不编造）。
        """
        if not keyword:
            return ""
        try:
            results = await search_service.search(
                f"{keyword} 买家真实评价 使用吐槽 回购 口碑", max_results=3
            )
        except Exception as e:
            print(f"[UNION] 社媒口碑搜索异常（降级为空）: {e}")
            return ""
        if not results:
            return ""
        lines = []
        for i, r in enumerate(results[:sample], 1):
            snippet = (r.get("content") or "").strip()
            title = (r.get("title") or "").strip()
            if not snippet and not title:
                continue
            head = title if title else "网上讨论"
            body = snippet[:160] if snippet else ""
            lines.append(f"  {i}. {head}" + (f"：{body}" if body else ""))
        if not lines:
            return ""
        return (
            f"\n[买家口碑（网上公开讨论风向，Serper 联网检索）]\n"
            + "\n".join(lines)
            + "\n（以上为网上公开测评/讨论摘要，来自小红书、知乎、什么值得买等平台的买家反馈风向，非单品精确评论；引用时用「网上反馈/有人提到」自然表达）"
        )

    async def _raw_search(self, keyword: str = "", max_items: int = 12, category: str = "") -> List[Dict]:
        raise NotImplementedError


class HaodankuProvider(UnionProductProvider):
    """好单库（haodanku.com）实现：免备案、当天出数据，覆盖淘宝/京东/拼多多/抖音商品。"""

    name = "好单库"

    async def _raw_search(self, keyword: str = "", max_items: int = 12, category: str = "") -> List[Dict]:
        apikey = settings.HAODANKU_API_KEY
        if not apikey:
            print("[UNION] 好单库 apikey 未配置，跳过商品级数据（AI 仅用 Serper 趋势线索）。")
            return []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                if keyword:
                    # 关键词搜索走 v2 域名 get_keyword_items（itemlist 会忽略 keyword，是频道浏览接口）
                    # 好单库文档要求 keyword 二次 urlencode：先编码一次再编码一次，直接用拼好的 query
                    # category 语义=模式：general→cid=0(全部类目)；beauty/空→项目定位 cid(4=美妆)
                    cid = _resolve_haodanku_cid(category)
                    # 2026-08-26 扩容：max_items>20 时按 min_id 翻页拉满（min_id 是上页最后一条 id，
                    # 响应里返回；每页最多 HAODANKU_PAGE_SIZE=20）。翻页失败/无 min_id 则降级单页。
                    keyword_2x = quote(quote(keyword, safe=""), safe="")
                    goods: list = []
                    page_min_id: int = 1
                    page_cnt = 0
                    max_pages = max(1, min(5, (max_items + settings.HAODANKU_PAGE_SIZE - 1) // settings.HAODANKU_PAGE_SIZE))
                    while page_cnt < max_pages:
                        page_cnt += 1
                        back = _snap_back(settings.HAODANKU_PAGE_SIZE)
                        url = (
                            f"{settings.HAODANKU_KEYWORD_URL}"
                            f"?apikey={apikey}&keyword={keyword_2x}"
                            f"&cid={cid}&back={back}&sort=4&min_id={page_min_id}"
                        )
                        try:
                            resp = await client.get(url)
                            resp.raise_for_status()
                            data = resp.json()
                        except Exception as e:
                            print(f"[UNION] 好单库翻页请求失败: {e}")
                            break
                        code = data.get("code")
                        if code not in (1, None):
                            print(f"[UNION] 好单库关键词接口 code={code} msg={data.get('msg')} keyword={keyword}")
                            break
                        page_goods = data.get("data") or []
                        if not isinstance(page_goods, list) or not page_goods:
                            break
                        goods.extend(page_goods)
                        # 翻页：好单库响应自带 min_id（下一页起点），直接用；无则停止
                        nxt = data.get("min_id")
                        try:
                            nxt = int(nxt) if nxt is not None else None
                        except (TypeError, ValueError):
                            nxt = None
                        if not nxt or len(page_goods) < settings.HAODANKU_PAGE_SIZE:
                            break
                        page_min_id = nxt
                        if len(goods) >= max_items:
                            break
                else:
                    # 无关键词：频道浏览（v3 域名 itemlist）
                    params = {
                        "apikey": apikey,
                        "nav": settings.HAODANKU_NAV,
                        "page": 1,
                        "page_size": min(max_items, settings.HAODANKU_PAGE_SIZE),
                        "sort": 1,  # 1=销量优先
                    }
                    resp = await client.get(f"{settings.HAODANKU_BASE_URL}/itemlist", params=params)
                    resp.raise_for_status()
                    data = resp.json()
        except Exception as e:
            print(f"[UNION] 好单库请求失败: {e}")
            return []

        if keyword:
            # 关键词接口返回结构：{code, min_id, msg, total, data:[...]}
            code = data.get("code")
            if code not in (1, None):
                # code!=1 多为 key 无效/超频/无数据，打印 msg 便于排查
                print(f"[UNION] 好单库关键词接口 code={code} msg={data.get('msg')} keyword={keyword}")
            goods = goods or (data.get("data") or [])
        else:
            # 频道接口返回结构：{code, msg, data:{goods_list:[...]}}
            goods = data.get("data", {}).get("goods_list") if isinstance(data.get("data"), dict) else data.get("goods_list")
            if not goods:
                goods = data.get("goods_list") or data.get("data") or []
            if isinstance(goods, dict):
                goods = goods.get("goods_list") or []
        return goods if isinstance(goods, list) else []


class DataokeProvider(UnionProductProvider):
    """大淘客（dataoke.com）实现：持牌淘宝客，有 num_iid 单品详情 + 自带搜索。

    与好单库互补：好单库无 num_iid（贴链接做不了单品诊断），大淘客有；
    好单库销量聚合强、字段全，作为默认主源。两者可经 UNION_PROVIDER 切换。
    """

    name = "大淘客"

    async def _raw_search(self, keyword: str = "", max_items: int = 12, category: str = "") -> List[Dict]:
        if not settings.DATAOKE_APP_KEY or not settings.DATAOKE_APP_SECRET:
            print("[UNION] 大淘客 key 未配置，跳过商品级数据。")
            return []
        try:
            # 有关键词走搜索（不限类目）；无关键词按模式决定浏览类目：
            # general→全品类(cids=None)；beauty/空→项目定位美妆类目(cid=3)
            cids = _resolve_dataoke_cids(category, keyword)
            # 2026-08-26 扩容：max_items>100 时按 pageId 翻页拉满（大淘客每页最多 100 条）
            goods: list = []
            page = 1
            max_pages = max(1, min(5, (max_items + 99) // 100))  # 最多 5 页 = 500 条
            while page <= max_pages:
                page_items = await search_goods(keyword=keyword, max_items=min(100, max_items), cids=cids, page_id=str(page))
                if not page_items:
                    break
                goods.extend(page_items)
                if len(page_items) < 100 or len(goods) >= max_items:
                    break
                page += 1
            return goods
        except Exception as e:
            print(f"[UNION] 大淘客请求失败: {e}")
            return []

    def _normalize(self, item: Dict) -> Optional[Dict]:
        # 大淘客字段名与好单库不同，走 dataoke_service 的统一归一化（产出含 shop/num_iid）
        return normalize_dataoke_item(item, source=self.name)


class MergedUnionProvider(UnionProductProvider):
    """双源门面：好单库优先 + 大淘客回落/互补。

    通用对话与 7 张卡的唯一商品入口（search_products / compute_market_signals / format_product_leads
    全走 union_provider）。默认好单库为优先源；好单库某关键词无结果或异常时，用大淘客补齐，
    提升覆盖与接口韧性。两源各自经自身 _normalize 归一化后，按标题去重合并，保留来源标记 source。
    """

    name = "双源(好单库+大淘客)"

    def __init__(self):
        super().__init__()
        self.primary = HaodankuProvider()
        self.secondary = DataokeProvider()

    async def search_products(self, keyword: str = "", max_items: int = 12, category: str = "beauty") -> List[Dict]:
        cache_key = f"{keyword}|{category}|{max_items}"
        async with self._lock:
            hit = self._cache.get(cache_key)
            if hit and (time.time() - hit[0]) < settings.UNION_CACHE_TTL:
                return hit[1]

        merged = await self._merge_raw(keyword, max_items, category)
        # 长复合词无数据 → 逐级缩短回退（拖地湿巾 → 拖地湿 → 拖地 → 拖），与基类逻辑一致
        if not merged and len(keyword) > 2:
            _t = keyword
            while len(_t) > 2 and not merged:
                _t = _t[:-1]
                merged = await self._merge_raw(_t, max_items, category)
            if merged:
                keyword = _t

        async with self._lock:
            self._cache[cache_key] = (time.time(), merged)
        return merged

    async def _merge_raw(self, keyword: str, max_items: int, category: str) -> List[Dict]:
        """双源并行拉取 + 去重合并（供 search_products 与缩短回退复用）。"""
        # 双源并行拉取（好单库优先 + 大淘客互补），各自翻页拉满后按标题去重合并
        primary_raw, secondary_raw = await asyncio.gather(
            self.primary._raw_search(keyword=keyword, max_items=max_items, category=category),
            self.secondary._raw_search(keyword=keyword, max_items=max_items, category=category),
        )
        primary_leads = [l for l in (self.primary._normalize(it) for it in primary_raw) if l]
        secondary_leads = [l for l in (self.secondary._normalize(it) for it in secondary_raw) if l]

        # 合并去重：好单库优先，大淘客补未被覆盖的（按标题归一化键判重）
        seen = set()
        merged = []
        for l in primary_leads + secondary_leads:
            key = _norm_dedup_key(l.get("context") or "")
            if key in seen:
                continue
            seen.add(key)
            merged.append(l)

        # B 档趋势：合并结果写当日快照（无 key/无数据时为 no-op）
        try:
            trend_service.record_leads(keyword, merged)
        except Exception as e:
            print(f"[UNION] 合并趋势快照写入失败（降级，不影响选品）: {e}")

        merged.sort(key=lambda l: (l.get("price_value") is not None, l.get("commission_money") or 0, l.get("sales") or 0), reverse=True)
        return merged[:max_items]


# Provider 工厂：拿到京东联盟 key 后，在 config 把 UNION_PROVIDER 改成 jd_union 即可无缝切换；
# 大淘客作为好单库互补源，设 UNION_PROVIDER=dataoke 即切换（单品诊断能力不依赖此开关，始终可用）
_PROVIDERS = {"haodanku": HaodankuProvider, "dataoke": DataokeProvider}


def get_union_provider() -> UnionProductProvider:
    # 双源门面（好单库优先 + 大淘客回落）：开启且大淘客 key 齐备时启用；
    # 即使好单库未配 key，也会用大淘客兜底，避免通用对话/卡片完全没有商品数据。
    if settings.UNION_FALLBACK and settings.DATAOKE_APP_KEY and settings.DATAOKE_APP_SECRET:
        return MergedUnionProvider()
    cls = _PROVIDERS.get(settings.UNION_PROVIDER, HaodankuProvider)
    return cls()


union_provider = get_union_provider()


# ─────────────────────────────────────────────────────────────────────────────
# 字段映射真值表（2026-08-19 好单库线上实测确认，供校验与 onboarding 参考）
#   好单库原始字段        -> 归一化字段           说明
#   itemsale   (月销)     -> sales               近 30 天销量，非实时 GMV
#   tkrates    (佣金%)    -> commission_ratio
#   tkmoney    (佣金¥)    -> commission_money
#   itemendprice(券后价)  -> price_value / price_text
#   itemprice  (原价)     -> 原价（price_text 中展示）
#   couponmoney (券额)    -> coupon_info
# ⚠️ 好单库「无」竞争强度原始字段：所有卡片的 competition / competitionLevel 均由本服务
#    基于在售商品数(product_count)+品牌数(distinct_brands)确定性推导（_derive_competition），
#    非平台官方数据，前端须明确标注为「推导值」。
# ─────────────────────────────────────────────────────────────────────────────

# 校验时要求样本里至少出现一次非空的原始字段
_EXPECTED_RAW_FIELDS = ["itemsale", "tkrates", "tkmoney", "itemendprice", "itemprice", "couponmoney"]


async def validate_field_mappings(sample_keyword: str = "防晒", max_items: int = 10) -> Dict:
    """好单库字段映射真值校验：拉一批真实原始字段，确认关键映射未因 API 变更而静默失效。

    返回 ok / missing_raw_fields / missing_derived_fields，供上线前自检与运维监控。
    """
    try:
        raw = await HaodankuProvider()._raw_search(keyword=sample_keyword, max_items=max_items)
    except Exception as e:  # 拉取失败也判为不通过，避免静默放行
        return {"ok": False, "error": f"好单库拉取失败: {e}", "missing_raw_fields": list(_EXPECTED_RAW_FIELDS)}

    if not raw:
        return {"ok": False, "error": "好单库返回空（key 失效/无数据/超频）", "missing_raw_fields": list(_EXPECTED_RAW_FIELDS)}

    missing_raw = []
    for f in _EXPECTED_RAW_FIELDS:
        present = any(str(it.get(f, "")).strip() not in ("", "0", "0.0", "None") for it in raw)
        if not present:
            missing_raw.append(f)

    # 走归一化，确认派生关键字段（销量/佣金/价格）能正确取出
    leads = await union_provider.search_products(keyword=sample_keyword, max_items=max_items)
    missing_derived = []
    if not any(l.get("sales") is not None for l in leads):
        missing_derived.append("sales")
    if not any(l.get("commission_money") is not None for l in leads):
        missing_derived.append("commission_money")
    if not any(l.get("price_value") is not None for l in leads):
        missing_derived.append("price_value")

    ok = not missing_raw and not missing_derived
    sample = raw[0] if raw else {}
    return {
        "ok": ok,
        "sample_keyword": sample_keyword,
        "sample_count": len(raw),
        "missing_raw_fields": missing_raw,
        "missing_derived_fields": missing_derived,
        "raw_sample_keys": sorted(sample.keys())[:40],
    }
