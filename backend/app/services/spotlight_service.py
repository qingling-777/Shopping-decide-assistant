import asyncio
import hashlib
import time
from datetime import datetime
from typing import Dict, List, Optional

# 首页"实时好单库爆品"：直接抽真实在售商品（带商品名/品牌/图/价/佣金/销量/链接），
# 按 2 小时时间桶做确定性随机抽选，实现"每约 2 小时随机刷新一列商品"。
from app.services.union_service import union_provider
from app.services import dataoke_service  # 大淘客原始搜索（平台筛选多页拉取用）
from app.core.config import settings

# 抽选用的关键词池：按 App 模式分两个默认池（类目放开前，无关键词时回退到此）
SPOTLIGHT_KEYWORDS_BEAUTY = [
    "精华", "粉底液", "防晒霜", "口红", "面膜", "眼霜",
    "面霜", "唇釉", "气垫", "卸妆", "祛痘", "身体乳", "洗面奶", "定妆喷雾",
]
SPOTLIGHT_KEYWORDS_GENERAL = [
    "零食", "女装", "男装", "鞋靴", "数码", "家居",
    "母婴", "食品", "玩具", "箱包", "厨房", "运动",
]
SPOTLIGHT_KEYWORDS_PER_BUCKET = 6
SPOTLIGHT_N = 30
SPOTLIGHT_SEARCH_PER_KEYWORD = 15       # 默认池每个关键词的取数条数
SPOTLIGHT_SEARCH_KEYWORD = 40          # 用户明确选类目时单关键词深搜条数（多取供筛选/排序）
SPOTLIGHT_PLATFORM_PAGES = 3           # 平台筛选时大淘客翻页数（每页最多 100，最大化某平台商品量）
BUCKET_SECONDS = 2 * 3600  # 2 小时

# 按 cache_key(关键词|平台|模式|桶) 缓存，避免每次请求都打联盟接口
_cache: Dict[str, Dict] = {}


def _mulberry32(seed: int):
    s = seed & 0xFFFFFFFF

    def rng() -> float:
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = s
        t = (t ^ (t >> 15)) & 0xFFFFFFFF
        t = (t * (t | 1)) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) & 0xFFFFFFFF))
        t = (t ^ (t >> 14)) & 0xFFFFFFFF
        return ((t + 0) & 0xFFFFFFFF) / 4294967296.0

    return rng


def _seeded_shuffle(items: List, seed: int) -> List:
    rng = _mulberry32(seed)
    arr = list(items)
    for i in range(len(arr) - 1, 0, -1):
        j = int(rng() * (i + 1))
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def _stable_id(lead: Dict) -> str:
    """用 品牌|标题 生成稳定 id，使同一商品在不同时间桶都指向同一条（收藏/归档不漂移）。"""
    raw = f"{lead.get('brand') or ''}|{lead.get('context') or ''}"
    return "spot_" + hashlib.md5(raw.encode("utf-8")).hexdigest()[:12]


def _lead_to_card(lead: Dict) -> Dict:
    return {
        "id": _stable_id(lead),
        "brand": lead.get("brand") or "",
        "title": (lead.get("context") or "")[:60],
        "image": lead.get("image") or "",
        "priceText": lead.get("price_text") or "",
        "commissionRatio": lead.get("commission_ratio"),
        "commissionMoney": lead.get("commission_money"),
        "sales": lead.get("sales"),
        "link": lead.get("link") or "",
        "couponInfo": lead.get("coupon_info") or "",
        "detailUrl": lead.get("detail_url") or "",
        "source": lead.get("source") or "",
        "shopType": lead.get("shop_type") or "",
        "priceValue": lead.get("price_value"),
        "goodsId": lead.get("num_iid") or None,  # 大淘客明文 num_iid：存在走按需懒加载转链(产生佣金)，否则回退好单库详情页
    }


async def _search_dataoke_platform(keyword: str, category: str, platform: str, max_pages: int = SPOTLIGHT_PLATFORM_PAGES) -> List[Dict]:
    """平台筛选专用：直接走大淘客多页拉取（好单库无平台字段、命中即被过滤，故不混好单库）。

    大淘客「get-goods-list」接口会忽略 shopType 请求参数，无法在服务端按平台过滤，
    只能拉满后按响应里的 shop_type 客户端过滤；多页拉取以最大化某平台的商品量。
    无大淘客 key / 无结果时返回 []（不影响其余路径）。
    """
    if not (settings.DATAOKE_APP_KEY and settings.DATAOKE_APP_SECRET):
        return []
    leads: List[Dict] = []
    for page in range(1, max_pages + 1):
        try:
            raw = await dataoke_service.search_goods(keyword=keyword, max_items=100, page_id=str(page))
        except Exception as e:
            print(f"[SPOTLIGHT] 大淘客平台拉取失败(降级空): {e}")
            break
        if not raw:
            break
        for it in raw:
            n = dataoke_service.normalize_dataoke_item(it, source="大淘客")
            if n:
                leads.append(n)
        if len(raw) < 100:
            break  # 已到末页
    return [l for l in leads if (l.get("shop_type") or "") == platform]


async def build_spotlight_products(keyword: str = "", platform: str = "", category: str = "general") -> Dict:
    """实时选品参考：支持按关键词(类目)放开 + 平台(淘宝/天猫)筛选。

    - keyword 非空：直接搜该类目/角度关键词（不再锁美妆），多取一些供前端筛选/排序；
    - keyword 空：按 category 选默认关键词池（美妆/全品类），每 2 小时随机抽几个关键词；
    - platform 非空("淘宝"/"天猫")：好单库无平台字段、命中即被过滤且拉满也补不了，
      故直接走大淘客多页拉取再按 shop_type 客户端过滤，以最大化该平台商品量。
    结果按 2 小时时间桶做确定性随机抽选，实现"每约 2 小时随机刷新一列商品"。
    """
    now = time.time()
    bucket = int(now // BUCKET_SECONDS)
    cache_key = f"{keyword}|{platform}|{category}|{bucket}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached  # type: ignore

    all_leads: List[Dict] = []
    if platform:
        # 平台筛选：直接走大淘客（多页拉取），不再混好单库
        if keyword:
            all_leads = await _search_dataoke_platform(keyword, category, platform, max_pages=SPOTLIGHT_PLATFORM_PAGES)
        else:
            pool = SPOTLIGHT_KEYWORDS_BEAUTY if category == "beauty" else SPOTLIGHT_KEYWORDS_GENERAL
            keywords = _seeded_shuffle(pool, bucket + 0x85EBCA6B)[:SPOTLIGHT_KEYWORDS_PER_BUCKET]
            sem = asyncio.Semaphore(4)
            for kw in keywords:
                async with sem:
                    try:
                        leads = await _search_dataoke_platform(kw, category, platform, max_pages=1)
                    except Exception:
                        leads = []
                if leads:
                    all_leads.extend(leads)
    elif keyword:
        # 有类目无平台：双源合并深搜
        try:
            all_leads = await union_provider.search_products(keyword=keyword, max_items=SPOTLIGHT_SEARCH_KEYWORD, category=category)
        except Exception:
            all_leads = []
    else:
        # 无关键词：按模式回退到默认关键词池，每桶随机抽几个关键词
        pool = SPOTLIGHT_KEYWORDS_BEAUTY if category == "beauty" else SPOTLIGHT_KEYWORDS_GENERAL
        keywords = _seeded_shuffle(pool, bucket + 0x85EBCA6B)[:SPOTLIGHT_KEYWORDS_PER_BUCKET]
        sem = asyncio.Semaphore(4)
        for kw in keywords:
            async with sem:
                try:
                    leads = await union_provider.search_products(keyword=kw, max_items=SPOTLIGHT_SEARCH_PER_KEYWORD, category=category)
                except Exception:
                    leads = []
            if leads:
                all_leads.extend(leads)

    # 按 品牌|标题 去重，保留首次出现
    seen = set()
    unique = []
    for l in all_leads:
        key = (l.get("brand"), l.get("context"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(l)

    picked = _seeded_shuffle(unique, bucket + 0x27D4EB2F)[:SPOTLIGHT_N]
    items = [_lead_to_card(l) for l in picked]

    data = {
        "items": items,
        "updatedAt": datetime.fromtimestamp(bucket * BUCKET_SECONDS).isoformat(),
        "cadence": "约每 2 小时随机刷新",
        "source": "好单库 / 大淘客（淘宝·天猫联盟商品聚合）",
        "method": "按所选类目/平台从多源实时抽取真实在售商品（含品牌/价格/佣金/销量/推广链接），每 2 小时确定性随机刷新",
        "disclaimer": "商品来自好单库/大淘客真实联盟数据，链接为淘客券链（uland.taobao.com，点开即真实宝贝、可领券购买），无券/查不到宝贝的已自动过滤，仅供选品参考。",
    }
    _cache[cache_key] = data
    # 简单限容，避免时间桶/关键词组合无限增长
    if len(_cache) > 16:
        _cache.pop(next(iter(_cache)))
    return data
