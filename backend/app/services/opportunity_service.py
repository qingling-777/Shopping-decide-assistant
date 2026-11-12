import asyncio
import math
import time
from datetime import datetime
from typing import Dict, List, Optional

# 机会方向现在直接用真实联盟商品数据（好单库）推导，不再依赖爬虫文本匹配。
from app.services.union_service import union_provider


# 候选方向池：name 展示用，search_keyword 用于向好单库检索真实商品信号，
# platforms 给商户平台建议。
# 全品类：覆盖美妆（基础盘）+ 食品/数码3C/家居/母婴/服饰/宠物/运动/图书 等多个一级大类。
# 每个方向带 group（一级大类，用于前端分组）+ search_category（beauty=走美妆类目 cid，
# general=全品类 cid=0）。后端按 group 分组、组内按机会分倒序取前 SELECT_PER_GROUP 个，
# 大类顺序按组内最高分倒序，6h 缓存稳定不抖动。
OPPORTUNITY_DIRECTIONS = [
    # ---------- 美妆（基础盘，search_category=beauty 走美妆类目）----------
    {
        "id": "anti_age_serum",
        "name": "抗老精华",
        "tag": "功效验证",
        "search_keyword": "精华",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "oily_skin_foundation",
        "name": "油皮粉底液",
        "tag": "持妆需求",
        "search_keyword": "粉底液",
        "category": "彩妆",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "sensitive_sunscreen",
        "name": "敏感肌防晒",
        "tag": "细分增长",
        "search_keyword": "防晒霜",
        "category": "防晒",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "affordable_lipstick",
        "name": "平价口红",
        "tag": "竞争较高",
        "search_keyword": "口红",
        "category": "彩妆",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["抖音"],
    },
    {
        "id": "repair_mask",
        "name": "修护面膜",
        "tag": "高频复购",
        "search_keyword": "面膜",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "anti_wrinkle_eye",
        "name": "抗皱眼霜",
        "tag": "客单较高",
        "search_keyword": "眼霜",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "hydra_cream",
        "name": "保湿面霜",
        "tag": "基础刚需",
        "search_keyword": "面霜",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "velvet_lip_gloss",
        "name": "镜面唇釉",
        "tag": "内容友好",
        "search_keyword": "唇釉",
        "category": "彩妆",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "cushion_bb",
        "name": "气垫BB",
        "tag": "快手妆效",
        "search_keyword": "气垫",
        "category": "彩妆",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["抖音"],
    },
    {
        "id": "makeup_remover",
        "name": "卸妆水",
        "tag": "高频消耗",
        "search_keyword": "卸妆",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "acne_serum",
        "name": "祛痘精华",
        "tag": "痛点明确",
        "search_keyword": "祛痘",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "body_lotion",
        "name": "美白身体乳",
        "tag": "季节增长",
        "search_keyword": "身体乳",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "men_cleanser",
        "name": "男士洁面",
        "tag": "增量人群",
        "search_keyword": "洗面奶",
        "category": "护肤",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["抖音"],
    },
    {
        "id": "setting_spray",
        "name": "定妆喷雾",
        "tag": "连带品",
        "search_keyword": "定妆喷雾",
        "category": "彩妆",
        "group": "美妆",
        "search_category": "beauty",
        "platforms": ["抖音"],
    },
    # ---------- 食品（search_category=general 全品类）----------
    {
        "id": "snack",
        "name": "休闲零食",
        "tag": "高频复购",
        "search_keyword": "零食",
        "category": "零食",
        "group": "食品",
        "search_category": "general",
        "platforms": ["抖音", "小红书"],
    },
    {
        "id": "coffee_drink",
        "name": "咖啡冲饮",
        "tag": "增量人群",
        "search_keyword": "咖啡",
        "category": "冲饮",
        "group": "食品",
        "search_category": "general",
        "platforms": ["小红书", "抖音"],
    },
    # ---------- 数码 3C ----------
    {
        "id": "bluetooth_earphone",
        "name": "蓝牙耳机",
        "tag": "客单较高",
        "search_keyword": "蓝牙耳机",
        "category": "耳机",
        "group": "数码3C",
        "search_category": "general",
        "platforms": ["抖音"],
    },
    {
        "id": "phone_accessory",
        "name": "手机配件",
        "tag": "高频消耗",
        "search_keyword": "手机壳",
        "category": "手机配件",
        "group": "数码3C",
        "search_category": "general",
        "platforms": ["抖音"],
    },
    # ---------- 家居日用 ----------
    {
        "id": "storage_org",
        "name": "收纳整理",
        "tag": "刚需日销",
        "search_keyword": "收纳",
        "category": "收纳",
        "group": "家居日用",
        "search_category": "general",
        "platforms": ["小红书", "抖音"],
    },
    {
        "id": "clean_tool",
        "name": "清洁工具",
        "tag": "高频复购",
        "search_keyword": "清洁",
        "category": "家清",
        "group": "家居日用",
        "search_category": "general",
        "platforms": ["抖音", "小红书"],
    },
    # ---------- 母婴亲子 ----------
    {
        "id": "toy",
        "name": "玩具",
        "tag": "内容友好",
        "search_keyword": "玩具",
        "category": "玩具",
        "group": "母婴亲子",
        "search_category": "general",
        "platforms": ["抖音", "小红书"],
    },
    {
        "id": "baby_care",
        "name": "婴童洗护",
        "tag": "增量人群",
        "search_keyword": "婴童洗护",
        "category": "婴童",
        "group": "母婴亲子",
        "search_category": "general",
        "platforms": ["小红书", "抖音"],
    },
    # ---------- 服饰鞋包 ----------
    {
        "id": "women_wear",
        "name": "女装",
        "tag": "季节增长",
        "search_keyword": "女装",
        "category": "女装",
        "group": "服饰鞋包",
        "search_category": "general",
        "platforms": ["抖音", "小红书"],
    },
    {
        "id": "sneaker",
        "name": "运动鞋",
        "tag": "内容友好",
        "search_keyword": "运动鞋",
        "category": "鞋",
        "group": "服饰鞋包",
        "search_category": "general",
        "platforms": ["抖音"],
    },
    # ---------- 宠物 ----------
    {
        "id": "pet_food",
        "name": "宠物粮",
        "tag": "高频复购",
        "search_keyword": "猫粮",
        "category": "宠物粮",
        "group": "宠物",
        "search_category": "general",
        "platforms": ["抖音", "小红书"],
    },
    {
        "id": "pet_supply",
        "name": "宠物用品",
        "tag": "增量人群",
        "search_keyword": "猫砂",
        "category": "宠物用品",
        "group": "宠物",
        "search_category": "general",
        "platforms": ["抖音"],
    },
    # ---------- 运动户外 ----------
    {
        "id": "yoga_mat",
        "name": "瑜伽垫",
        "tag": "健身增长",
        "search_keyword": "瑜伽垫",
        "category": "健身",
        "group": "运动户外",
        "search_category": "general",
        "platforms": ["小红书", "抖音"],
    },
    # ---------- 图书文娱 ----------
    {
        "id": "book",
        "name": "图书",
        "tag": "内容友好",
        "search_keyword": "图书",
        "category": "图书",
        "group": "图书文娱",
        "search_category": "general",
        "platforms": ["抖音", "小红书"],
    },
]


def _derive_competition(signals: Dict) -> str:
    """由真实商品数/品牌数推导竞争强度（确定性，不靠 LLM）。"""
    n = signals.get("product_count", 0)
    d = signals.get("distinct_brands", 0)
    if n >= 20 and d >= 12:
        return "高"
    if n >= 12 and d >= 7:
        return "中高"
    if n >= 6:
        return "中等"
    return "中低"


def _derive_score(signals: Dict) -> int:
    """由真实销量/佣金/竞争推导机会指数（确定性，0-100）。"""
    score = 45.0
    total = signals.get("total_sales") or 0
    if total > 0:
        score += min(25.0, max(0.0, (math.log10(total) - 2) * 8))
    ratio = signals.get("avg_commission_ratio")
    if ratio is not None:
        score += min(20.0, ratio * 0.8)
    comp = _derive_competition(signals)
    score += {"高": -15, "中高": -8, "中等": -2, "中低": 3}.get(comp, 0)
    return int(max(30, min(96, round(score))))


def _tag_and_gradient(score: int):
    if score >= 85:
        return "强机会", "strong_recommend"
    if score >= 75:
        return "值得验证", "recommend"
    if score >= 60:
        return "谨慎观察", "cautious"
    return "竞争偏高", "observe"


def _fmt_sales(n) -> str:
    if not n:
        return "0"
    if n >= 10000:
        return f"{n / 10000:.1f}万"
    return str(int(n))


async def _build_one(direction: Dict, sem: asyncio.Semaphore) -> Dict:
    """单个方向：取真实联盟信号 -> 推导分数/竞争 -> 取一张真实配图。"""
    kw = direction["search_keyword"]
    async with sem:
        signals = await union_provider.compute_market_signals(
            keyword=kw, max_items=300, category=direction.get("search_category", "general")
        )
    has_data = bool(signals)

    if has_data:
        score = _derive_score(signals)
        competition = _derive_competition(signals)
        tag, gradient = _tag_and_gradient(score)
        confidence = "高" if signals.get("product_count", 0) >= 12 else "中"
    else:
        # 无真实数据：给保守基线分，明确标低可信度，不编造数字
        score = 55
        competition = "未知"
        tag, gradient = "待验证", "observe"
        confidence = "低"

    # best-effort 真实商品配图（已带缓存）
    cover = None
    try:
        leads = await union_provider.search_products(keyword=kw, max_items=1)
        if leads and leads[0].get("image"):
            cover = leads[0]["image"]
    except Exception:
        cover = None

    metrics = None
    if has_data:
        metrics = {
            "productCount": signals.get("product_count", 0),
            "topBrands": signals.get("top_brands", []),
            "priceBand": signals.get("price_band", "") or "",
            "avgCommissionText": (
                f"平均佣金{signals['avg_commission_ratio']}%"
                if signals.get("avg_commission_ratio") is not None else ""
            ),
            "totalSalesText": (
                f"月销合计约{_fmt_sales(signals['total_sales'])}"
                if signals.get("total_sales") else ""
            ),
            "competition": competition,
            "source": "好单库",
            "competitionNote": "竞争强度由好单库在售商品数/品牌数推导，非平台官方数据",
        }

    return {
        "id": direction["id"],
        "name": direction["name"],
        "tag": tag,
        "score": score,
        "gradientType": gradient,
        "category": direction["category"],
        "group": direction.get("group", ""),
        # 原始搜索词：前端点卡片时直接用它对 /products/spotlight 拉相关商品（比 name 更准）
        "keyword": kw,
        "searchCategory": direction.get("search_category", "general"),
        "suggestedPlatforms": direction["platforms"],
        "dataDate": datetime.now().strftime("%Y-%m-%d"),
        "sourceCount": signals.get("product_count", 0) if has_data else 0,
        "evidenceCount": signals.get("distinct_brands", 0) if has_data else 0,
        "confidence": confidence,
        "scoreLabel": "真实数据机会分",
        "coverImage": cover,
        "metrics": metrics,
    }


# 稳定刷新窗口（约 6 小时一桶）：同一窗口内结果稳定（不闪烁）
STABLE_WINDOW = 6 * 3600
# 每个一级大类展示的方向数（组内按机会分倒序取前 N）
SELECT_PER_GROUP = 2

# 服务端缓存：按 6 小时窗口缓存，窗口内结果稳定。
_cache: Dict[str, object] = {"bucket": -1, "data": None}


async def build_opportunity_directions_from_union() -> Dict:
    """基于真实联盟商品数据推导近期机会方向，按一级大类分组。

    全品类：方向池覆盖美妆/食品/数码/家居/母婴/服饰/宠物/运动/图书等多个一级大类，
    每个方向带 group（一级大类）与 search_category（beauty=美妆类目 / general=全品类）。
    分组：按 group 聚合，组内按机会分倒序（稳定 tiebreak: id）取前 SELECT_PER_GROUP 个；
    大类顺序按组内最高分倒序，强机会大类排前。缓存按 6 小时窗口刷新，兼顾稳定与新鲜度。
    """
    now = time.time()
    bucket = int(now // STABLE_WINDOW)
    cached = _cache.get("data")
    if cached is not None and _cache.get("bucket") == bucket:
        return cached  # type: ignore

    # 限制并发，避免一次性打太多好单库请求触发限频
    sem = asyncio.Semaphore(4)
    # 构建方向池全部方向（每个方向并发查好单库真实信号）
    results = await asyncio.gather(*[_build_one(d, sem) for d in OPPORTUNITY_DIRECTIONS])

    # 按一级大类分组，组内按分数倒序（确定性 tiebreak: id），每组取前 SELECT_PER_GROUP
    groups_map: Dict[str, List[Dict]] = {}
    for r in results:
        groups_map.setdefault(r.get("group") or "其他", []).append(r)
    groups = []
    for g, items in groups_map.items():
        items.sort(key=lambda x: (-x["score"], x["id"]))
        groups.append({"group": g, "items": items[:SELECT_PER_GROUP]})
    # 大类顺序：按组内最高分倒序，保证强机会大类在前且稳定
    groups.sort(key=lambda grp: -max(i["score"] for i in grp["items"]))

    bucket_start = datetime.fromtimestamp(bucket * STABLE_WINDOW)
    data = {
        "groups": groups,
        "updatedAt": bucket_start.isoformat(),
        "cadence": "约每 6 小时刷新（稳定不抖动）",
        "source": "好单库（淘宝/天猫联盟商品聚合，全品类）",
        "method": "机会分由真实在售商品数、品牌数、价格带、平均佣金、月销确定性推导（销量信号+佣金空间+竞争强度）；按一级大类分组，各组取分数最高的方向稳定展示",
        "disclaimer": "分数与竞争强度均基于好单库真实联盟商品数据推导：竞争强度为在售商品数/品牌数推算值，非平台官方数据；不等同平台实时 GMV，仅供选品参考。",
    }
    _cache["bucket"] = bucket
    _cache["data"] = data
    return data
