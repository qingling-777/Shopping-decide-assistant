# -*- coding: utf-8 -*-
"""大淘客（dataoke.com）联盟数据接入：单品诊断 + 关键词搜索。

为何需要这一层（与好单库互补）：
  好单库无淘宝 num_iid，商户贴「淘宝/天猫商品链接」时只能识别平台、无法拉到该商品的
  实时价/佣/销，只能引导商户发商品名。大淘客持有牌淘宝客资质，提供 num_iid 维度的单品详情，
  正好补上这个洞——实现「贴链接 → 解析商品 id → 实时单品诊断」。

两跳流程（贴淘客短链/淘口令时）：
  1) tb-service/parse-content  (万能解析) ：content(链接/口令) -> goodsId(淘宝 num_iid) + 券信息
  2) open-api/goods/get_goods_detail_v2 (单品详情)：goodsId -> actualPrice/originalPrice/commissionRate/
     monthSales/shopType(1=天猫,0=淘宝)/title/couponPrice/couponConditions/shopName/mainPic/itemLink
  对于「item.taobao.com/item.htm?id=数字」完整商品页，num_iid 已在 URL 中，可直接跳过第 1 跳。

鉴权（签名算法，来自官方 Python SDK dtkApi/apiRequest/Request.py，已实测）：
  - 固定模板 sign = md5("appKey=<key>&timer=<毫秒>&nonce=<随机>&key=<secret>").upper()
    （注意：sign 不依赖业务参数，只依赖 appKey/timer/nonce/appSecret）
  - 请求把所有参数（appKey, version, signRan, timer, nonce, 业务参数）作为 GET query 发送。
  - 基础域名：openapi.dataoke.com；parse/search 在 /api/ 下，detail v2 在 /open-api/ 下。

本模块为自包含异步实现（httpx），不依赖官方同步 SDK 安装，避免阻塞事件循环与外部依赖。
"""
import asyncio
import copy
import hashlib
import random
import re
import time
from typing import Dict, List, Optional

import httpx

from app.core.config import settings
from app.services.crawler_service import _BEAUTY_BRANDS, BeautyDataCrawler

_BASE = "https://openapi.dataoke.com"
_PARSE_PATH = "/api/tb-service/parse-content"            # version v1.0.0
_SEARCH_PATH = "/api/goods/get-dtk-search-goods"          # version v2.1.2
# 单品详情：用 v1 端点（/api/goods/get-goods-details）。v2 端点（/open-api/goods/get_goods_detail_v2）
# 返回「账号未授权或授权过期」，需后台单独授权；v1 经实测已授权，字段与 v2 基本一致，优先用 v1。
_DETAIL_PATH = "/api/goods/get-goods-details"            # version v1.2.3

# 链接识别（与大淘客解析互补）：完整商品页(含 id=数字) / 淘系短链·淘客链·淘口令
_LINK_ID_RE = re.compile(
    r"(?:item\.taobao\.com|detail\.tmall\.com|trade\.taobao\.com)/item\.htm[^\s]*?[?&]id=(\d+)"
)
_TAO_RE = re.compile(
    r"(?:s\.click\.taobao\.com|uland\.taobao\.com|m\.tb\.cn|tb\.cn|a\.m\.taobao\.com|"
    r"item\.taobao\.com|detail\.tmall\.com|tmall\.com|taobao\.com)"
)


def _sign(app_key: str, app_secret: str) -> Dict[str, object]:
    """复刻官方 SDK 签名：固定模板 MD5(大写)。"""
    timer = int(time.time() * 1000)
    nonce = random.randint(100000, 999999)
    raw = f"appKey={app_key}&timer={timer}&nonce={nonce}&key={app_secret}"
    sign = hashlib.md5(raw.encode("utf-8")).hexdigest().upper()
    return {"signRan": sign, "timer": timer, "nonce": nonce}


async def _call(path: str, version: str, params: Dict) -> Optional[Dict]:
    app_key = settings.DATAOKE_APP_KEY
    app_secret = settings.DATAOKE_APP_SECRET
    if not app_key or not app_secret:
        return None
    q = {"appKey": app_key, "version": version, **_sign(app_key, app_secret)}
    q.update({k: v for k, v in params.items() if v is not None})
    try:
        # 2026-08-28 工程审查 P1 修复：verify 改由 settings.SSL_VERIFY 控制（此前 verify=False，
        # 含 AppSecret 签名的联盟请求可被中间人篡改/劫持）
        async with httpx.AsyncClient(timeout=10.0, verify=settings.SSL_VERIFY) as client:
            resp = await client.get(_BASE + path, params=q)
            return resp.json()
    except Exception as e:
        print(f"[DATAOKE] 请求失败 {path}: {e}")
        return None


# ─────────────────────────────────────────────────────────────
# 轻量 TTL 缓存：三个搜索相关 API（热搜/联想/朋友圈文案）几乎实时可复用，
# 用 UNION_CACHE_TTL 缓存降频（避免每次对话都打接口）。模块级字典即可，进程内共享。
# ─────────────────────────────────────────────────────────────
_cache: Dict[str, object] = {}


def _cache_get(key: str) -> object:
    item = _cache.get(key)
    if item is None:
        return None
    ts, val = item
    if (time.time() - ts) < settings.UNION_CACHE_TTL:
        return val
    _cache.pop(key, None)
    return None


def _cache_set(key: str, val: object) -> None:
    _cache[key] = (time.time(), val)


# ─────────────────────────────────────────────────────────────
# 爆品榜进程内缓存（方案 A，2026-08-30）：
#   - TTL 30s：关注公众号的用户每次（隔 ≥30s）问「爆品榜」都拿到**更新版**（不是固定快照），
#     同时把对 openapi.dataoke.com 的实时调用频率压到 ≤120 次/时，避免 720 次/天触发限流。
#   - 关键：缓存**深拷贝**后返回，调用方（ai_service 会改写 items 里的字段）互不污染，
#     且矩阵每次由缓存榜单重建，保证首列替换逻辑拿到干净对象。
#   - _HOT_PREFETCHED：后台每 30 分钟预拉一帧**持久兜底**存这里；API 故障/冷启动时用它兜底，
#     保证「每次拿到的是不一样的最新版」这一承诺在接口抖动时依然成立。
# ─────────────────────────────────────────────────────────────
_hot_cache: Dict[str, object] = {}
_hot_prefetched: Optional[Dict] = None
_hot_prefetch_lock = asyncio.Lock()


def _hot_cache_get(key: str) -> Optional[object]:
    item = _hot_cache.get(key)
    if item is None:
        return None
    ts, val = item
    if (time.time() - ts) < settings.HOT_PICK_CACHE_TTL:
        return copy.deepcopy(val)  # 深拷贝防止调用方就地改写污染缓存
    _hot_cache.pop(key, None)
    return None


def _hot_cache_set(key: str, val: object) -> None:
    _hot_cache[key] = (time.time(), val)


async def _prefetch_hot_pick_matrix() -> Optional[Dict]:
    """后台预拉一帧爆品矩阵存内存兜底（供外部定时任务调用）。失败返回 None 不抛。"""
    global _hot_prefetched
    try:
        async with _hot_prefetch_lock:
            matrix = await get_hot_pick_matrix(use_cache=False)
            if matrix and matrix.get("columns"):
                mat = copy.deepcopy(matrix)
                # 同时预热按榜缓存，让后续同步请求也命中
                for col in mat.get("columns", []):
                    _hot_cache_set(f"rank_center:{col['type']}:12", col.get("items") or [])
                _hot_cache_set("hot_pick_matrix", mat)
                _hot_prefetched = mat
                return mat
            return _hot_prefetched
    except Exception as e:
        print(f"[DATAOKE] 爆品榜预拉失败: {e}")
        return _hot_prefetched


def get_prefetched_hot_pick_matrix() -> Optional[Dict]:
    """读取最近一次后台预拉帧（供兜底/接口诊断）。未预拉过返回 None。"""
    return _hot_prefetched


async def parse_content(content: str) -> Optional[Dict]:
    """淘系万能解析：链接/口令 -> 商品信息（goodsId + 券/价/标题/店铺）。失败返回 None。"""
    data = await _call(_PARSE_PATH, settings.DATAOKE_PARSE_VERSION, {"content": content})
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] parse-content code={data.get('code') if data else None} "
              f"msg={data.get('msg') if data else None}")
        return None
    return data.get("data") or {}


async def get_goods_detail(goods_id: str) -> Optional[Dict]:
    """单品详情 v2：goodsId -> 实时价/佣/销/店铺类型/券。失败返回 None。"""
    data = await _call(_DETAIL_PATH, settings.DATAOKE_DETAIL_VERSION, {"goodsId": str(goods_id)})
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] get_goods_detail code={data.get('code') if data else None} "
              f"msg={data.get('msg') if data else None}")
        return None
    return data.get("data") or {}


async def search_goods(keyword: str = "", max_items: int = 20, cids: Optional[str] = None, page_id: str = "1") -> List[Dict]:
    """大淘客搜索：关键词 + 类目 -> 商品列表。返回原始商品数组（待 normalize）。

    page_id 支持翻页（"1" 起）；平台筛选场景会多页拉取以最大化某平台商品量。
    """
    params = {
        "pageId": page_id,
        "pageSize": min(max(10, max_items), 100),  # 仅支持 10/50/100
        "keyWords": keyword,
    }
    if cids:
        params["cids"] = cids
    data = await _call(_SEARCH_PATH, settings.DATAOKE_SEARCH_VERSION, params)
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] search code={data.get('code') if data else None} "
              f"msg={data.get('msg') if data else None}")
        return []
    # 实测响应结构：r["data"]["list"]（两级，文档示例写的三级 data.data.list 与实际不符）
    return (data.get("data") or {}).get("list") or []


def _to_float(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace("¥", "").replace("元", "").strip())
    except (ValueError, TypeError):
        return None


def _fmt_amount(n) -> str:
    """销量/金额紧凑格式化：>=1 万显示 x.x 万，其余取整。与 ai_service._fmt_sales 同规则。"""
    if not n:
        return "0"
    if n >= 10000:
        return f"{n / 10000:.1f}万"
    return str(int(n))


def _norm_img(url: Optional[str]) -> str:
    if not url:
        return ""
    if url.startswith("//"):
        url = "https:" + url
    return url


def _map_parse_bonus(parse: Dict, goods_id: str) -> Optional[Dict]:
    """parse-content 字段名与 detail 不同，统一映射成 detail 风格以便复用 normalize。"""
    info = parse.get("originInfo") or {}
    title = parse.get("title") or info.get("title")
    if not title:
        return None
    return {
        "goodsId": goods_id,
        "title": title,
        "actualPrice": info.get("price"),
        "couponPrice": info.get("amount"),
        "couponConditions": info.get("startFee"),
        "commissionRate": parse.get("commissionRate"),
        "shopName": parse.get("shopName") or info.get("shopName"),
        "mainPic": parse.get("image") or info.get("image"),
        "itemLink": parse.get("originUrl") or info.get("itemLink"),
        "shopType": None,
    }


def normalize_dataoke_item(raw: Dict, source: str = "大淘客") -> Optional[Dict]:
    """把大淘客原始商品（detail / search / parse-bonus 映射后）归一化到与 union_service._normalize 一致的字段形状。

    关键差异（相对好单库）：
      - itemid == 淘宝明文 num_iid（好单库是加密串、拼不出详情页）；
      - 额外暴露 shop / shop_type / num_iid，供单品诊断更丰富呈现与跨源关联。
    """
    if not raw:
        return None
    title = (raw.get("title") or raw.get("dtitle") or "").strip()
    if not title:
        return None
    actual = _to_float(raw.get("actualPrice"))
    original = _to_float(raw.get("originalPrice"))
    coupon_price = _to_float(raw.get("couponPrice"))
    coupon_cond = raw.get("couponConditions")
    commission_ratio = _to_float(raw.get("commissionRate"))
    month_sales = _to_float(raw.get("monthSales"))
    goods_id = str(raw.get("goodsId") or raw.get("num_iid") or "")
    dtk_id = raw.get("id")  # 大淘客内部数字 id（price-trend/similar/comment 必填，goodsId 不行）
    shop_type = raw.get("shopType")
    shop_cn = "天猫" if shop_type == 1 else ("淘宝" if shop_type == 0 else "")
    shop_name = raw.get("shopName") or ""
    main_pic = _norm_img(raw.get("mainPic"))
    item_link = raw.get("itemLink") or (f"https://item.taobao.com/item.htm?id={goods_id}" if goods_id else "")

    if coupon_price and coupon_cond:
        coupon_info = f"满{coupon_cond}减{coupon_price:.0f}元"
    elif coupon_price:
        coupon_info = f"领券减{coupon_price:.0f}元"
    else:
        coupon_info = ""

    if actual is not None:
        price_text = f"券后¥{actual:.2f}" + (f"（原¥{original:.2f}）" if original else "")
    elif original is not None:
        price_text = f"¥{original:.2f}"
    else:
        price_text = ""

    commission_money = round(actual * commission_ratio / 100, 2) if (actual is not None and commission_ratio is not None) else None

    brand = raw.get("brandName")
    if not brand:
        for b in _BEAUTY_BRANDS:
            if b.lower() in title.lower():
                brand = b
                break
    ptype = BeautyDataCrawler._find_product_type(title)

    return {
        "brand": brand or "",
        "product_type": ptype or "",
        "price_text": price_text,
        "price_value": actual or original,
        "commission_ratio": commission_ratio,
        "commission_money": commission_money,
        "sales": month_sales,
        "itemid": goods_id,
        "num_iid": goods_id,
        "dtk_id": dtk_id,
        "image": main_pic,
        "link": item_link,
        "coupon_info": coupon_info,
        "detail_url": item_link,
        "shop": shop_name,
        "shop_type": shop_cn,
        "source": source,
        "context": title[:120],
    }


# ─────────────────────────────────────────────────────────────
# 搜索相关 API（开放平台域，现有 key 通用、无 pmc/无额外授权，实测 code=0）：
#   - 热搜记录 get-top100（买家榜/淘客榜实时热词，选品市场情报）
#   - 搜索联想词 search-suggestion（用户真实搜索切片 + 库内商品数）
#   - 朋友圈文案 friends-circle-list（现成 C 端营销文案，附商品价/佣/销）
# 三者均只读、可缓存、失败优雅降级为 []/""（不抛）。朋友圈文案商品复用 normalize_dataoke_item。
# ─────────────────────────────────────────────────────────────
_TOP100_PATH = "/api/category/get-top100"                  # v1.0.1  热搜记录
_SUGGEST_PATH = "/api/goods/search-suggestion"             # v1.0.2  搜索联想词
_FRIENDS_CIRCLE_PATH = "/api/goods/friends-circle-list"    # v1.0.0  朋友圈文案


async def get_top100(hot_type: int = 1) -> List[str]:
    """热搜记录：type=1买家热搜榜/2淘客热搜榜 -> 热搜词列表（经实测各 100 词）。失败返回 []。

    买家榜偏日用百货、淘客榜美妆密集，是「现在什么品类在火」的实时市场情报。
    """
    cache_key = f"top100:{hot_type}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached  # type: ignore
    data = await _call(_TOP100_PATH, settings.DATAOKE_TOP100_VERSION, {"type": hot_type})
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] top100 code={data.get('code') if data else None} msg={data.get('msg') if data else None}")
        return []
    words = (data.get("data") or {}).get("hotWords") or []
    words = [w for w in words if w]
    _cache_set(cache_key, words)
    return words


async def search_suggestion(key_words: str, suggest_type: int = 1) -> List[Dict]:
    """搜索联想词：keyWords + type(1大淘客/2联盟/3超级) -> [{kw, total}]（total=库内商品数）。失败返回 []。"""
    if not key_words:
        return []
    cache_key = f"suggest:{suggest_type}:{key_words}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached  # type: ignore
    data = await _call(_SUGGEST_PATH, settings.DATAOKE_SUGGEST_VERSION,
                       {"keyWords": key_words, "type": suggest_type})
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] suggest code={data.get('code') if data else None} msg={data.get('msg') if data else None}")
        return []
    raw = data.get("data") or []
    if isinstance(raw, dict):
        raw = raw.get("list") or []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kw = item.get("kw") or item.get("keyWords") or item.get("keyword")
        if kw:
            out.append({"kw": kw, "total": item.get("total")})
    _cache_set(cache_key, out)
    return out


async def get_friends_circle_list(page_id: int = 1, page_size: int = 20) -> List[Dict]:
    """朋友圈文案：无业务参数 -> 商品列表（含现成 C 端文案 circleText + 价/佣/销/图/链）。失败返回 []。

    每条字段与大淘客商品同 schema，可复用 normalize_dataoke_item 归一化后出单品卡/线索。
    """
    cache_key = f"friends:{page_id}:{page_size}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached  # type: ignore
    data = await _call(_FRIENDS_CIRCLE_PATH, settings.DATAOKE_FRIENDS_CIRCLE_VERSION,
                       {"pageId": str(page_id), "pageSize": min(max(10, page_size), 100)})
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] friends-circle code={data.get('code') if data else None} msg={data.get('msg') if data else None}")
        return []
    raw = data.get("data") or {}
    if isinstance(raw, dict):
        raw = raw.get("list") or []
    _cache_set(cache_key, raw)
    return raw


def format_hot_words_for_ai(buyer_words: List[str], taobao_words: List[str], limit: int = 30) -> str:
    """把买家榜/淘客榜热词格式化为 prompt 注入块（来源大淘客实时热搜）。两者皆空返回 ''。"""
    if not buyer_words and not taobao_words:
        return ""
    b = buyer_words[:limit]
    t = taobao_words[:limit]
    if not b and not t:
        return ""
    return (
        f"\n[当前热搜词（买家榜前{len(b)} / 淘客榜前{len(t)}，来源大淘客实时热搜）]\n"
        f"- 买家榜：{'、'.join(b)}\n"
        f"- 淘客榜：{'、'.join(t)}\n"
        "（若用户问选品方向/市场，可结合热搜词自然点出 2–3 个搜索热度在涨的品类，作为「市场正在关注」的佐证；"
        "不要逐条罗列，也不要说「根据热搜榜」这类来源话术，自然融入判断即可。）"
    )


def format_suggestions_for_ai(suggestions: List[Dict], keyword: str = "", limit: int = 8) -> str:
    """把联想词格式化为 prompt 注入块（用户真实的搜索切片 + 库内商品数）。空返回 ''。"""
    if not suggestions:
        return ""
    items = [s for s in suggestions[:limit] if isinstance(s, dict) and s.get("kw")]
    if not items:
        return ""
    lines = "\n".join(
        f"- {s['kw']}（淘宝联盟库内约 {s['total']} 个商品）" for s in items
    )
    kw_hint = f"（用户若搜「{keyword}」）" if keyword else ""
    return (
        f"\n[搜索联想词{kw_hint}，来源大淘客，代表用户真实的搜索细分切片]\n"
        f"{lines}\n"
        "（联想词反映用户真实的搜索角度，可在回答里自然提示用户还能从这些细分方向切入；不要机械罗列，"
        "作为选品切片的佐证融入即可。）"
    )


def format_friends_circle_for_ai(items: List[Dict], limit: int = 6) -> str:
    """把朋友圈文案商品格式化为 prompt 注入块（现成 C 端营销文案 + 价/佣/销），供 AI 在选品建议里自然附上可用文案。空返回 ''。"""
    if not items:
        return ""
    picks = []
    for it in items[:limit]:
        if not isinstance(it, dict):
            continue
        title = (it.get("title") or "").strip()
        copy = (it.get("circleText") or "").strip()
        price = _to_float(it.get("actualPrice"))
        if not title or not copy:
            continue
        price_txt = f"券后¥{price:.2f}" if price is not None else ""
        picks.append(f"- 《{title}》{price_txt}：{copy}")
    if not picks:
        return ""
    return (
        "\n[朋友圈/社群现成文案（来源大淘客，选品报告中若要给商户「可直接发朋友圈的话术」可从中摘取）]\n"
        + "\n".join(picks)
        + "\n（仅在用户明确要「发朋友圈/社群/小红书文案」时引用，自然摘 1–2 句给商户；不要主动大段搬运。）"
    )


# ─────────────────────────────────────────────────────────────
# 富接口（价格趋势 / 相似品 / 榜单 / 转链 / 评论）：与单品诊断互补，丰富呈现
# 注意：comment / privilege-link 受「淘宝账号授权」门控，当前账号授权过期 ->
#       接口返回业务错误码，这里统一优雅降级为 None + 明确日志「需后台重授权」。
# 其余三个（price-trend / similar / ranking）经实测已授权（code=0），立即可用。
# ─────────────────────────────────────────────────────────────
_PRICE_TREND_PATH = "/api/goods/price-trend"                 # v1.0.0  历史券后价
_SIMILAR_PATH = "/api/goods/list-similer-goods-by-open"      # v1.0.0  相似品/高佣替代
_RANKING_PATH = "/api/goods/get-ranking-list"                # v1.3.0  各大榜单
_PRIVILEGE_LINK_PATH = "/api/tb-service/get-privilege-link"  # v1.3.1  转链(变现)
_COMMENT_PATH = "/api/comment/get-comment-list"              # v1.0.0  商品评论(口碑)

_RANK_TYPE_NAMES = {
    1: "实时榜", 2: "全天榜", 3: "热推榜", 4: "复购榜",
    5: "热词飙升榜", 6: "热词排行榜", 7: "综合热搜榜",
}

# 榜单中心正式中文名（2026-08-30 实测各 rankType 数据特征校准，避免标错）：
#   - rankType=1 实时榜：榜内商品为今日正在推广/热销的品，与爆品卡同源（均价¥25.9/佣19.2%）。
#   - rankType=15 低价高佣榜：均价¥13.5 / 佣22.7%，客单低、佣金率高，典型低价引流。
#   - rankType=14 大牛爆单榜：佣金最高(24.4%)且月销最高(40.1万)，爆单标杆。
#   - rankType=9  社群爆品榜：高佣(21.1%)高销(32.8万)，社群团长爱推的品。
#   - rankType=7  综合热搜榜：客单较高(¥37.7)，搜索热度驱动的综合榜。
#   - rankType=12 美妆集散榜：美妆/日用密集（均价¥30.4），类目集中。
# (rankType=8 与 1 数据完全一致，重复榜不采用；4/5/6/16+ 实测为空，不采用。)
_RANK_CENTER_META = [
    {"type": 1,  "title": "实时爆品榜", "subtitle": "今日真在卖的爆品"},
    {"type": 15, "title": "低价高佣榜", "subtitle": "低客单·高佣金引流"},
    {"type": 14, "title": "大牛爆单榜", "subtitle": "最高佣·最高月销"},
    {"type": 9,  "title": "社群爆品榜", "subtitle": "团长爱推的高佣高销"},
    {"type": 7,  "title": "综合热搜榜", "subtitle": "搜索热度驱动的带量"},
    {"type": 12, "title": "美妆集散榜", "subtitle": "美妆日用品类集中"},
]

# 多榜单共振阈值：同一商品登上 ≥2 个榜单即视为「多榜共振」（更稳的爆品信号）。
MIN_RESONANCE_TABS = 2


async def get_price_trend(dtk_id) -> Optional[Dict]:
    """历史券后价趋势：大淘客内部数字 id -> 原始 dict（含 historicalPrice 时间序列）。失败返回 None。"""
    if not dtk_id:
        return None
    data = await _call(_PRICE_TREND_PATH, settings.DATAOKE_PRICE_TREND_VERSION, {"id": str(dtk_id)})
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] price-trend code={data.get('code') if data else None} msg={data.get('msg') if data else None}")
        return None
    return data.get("data") or {}


def normalize_price_trend(raw: Dict) -> Optional[Dict]:
    """把 price-trend 原始 dict 归一化为简单趋势摘要（供诊断文案直接渲染）。"""
    if not raw:
        return None
    hist = raw.get("historicalPrice") or []
    points = [{"date": h.get("date"), "price": _to_float(h.get("actualPrice"))}
              for h in hist if _to_float(h.get("actualPrice")) is not None]
    prices = [p["price"] for p in points]
    coupon_price = _to_float(raw.get("couponPrice"))
    coupon_cond = raw.get("couponConditions")
    if coupon_price and coupon_cond:
        coupon_info = f"满{coupon_cond}减{coupon_price:.0f}元"
    elif coupon_price:
        coupon_info = f"领券减{coupon_price:.0f}元"
    else:
        coupon_info = ""
    return {
        "title": (raw.get("title") or raw.get("dtitle") or "").strip(),
        "current": points[-1]["price"] if points else None,
        "min": min(prices) if prices else None,
        "max": max(prices) if prices else None,
        "avg": round(sum(prices) / len(prices), 2) if prices else None,
        "sample_count": len(points),
        "points": points,
        "coupon_info": coupon_info,
        "original_price": _to_float(raw.get("originalPrice")),
        "commission_ratio": _to_float(raw.get("commissionRate")),
    }


async def get_similar_goods(dtk_id, size: int = 10) -> List[Dict]:
    """相似品/高佣替代：大淘客内部数字 id -> 相似商品列表（原始，待 normalize）。失败返回 []。"""
    if not dtk_id:
        return []
    data = await _call(_SIMILAR_PATH, settings.DATAOKE_SIMILAR_VERSION,
                       {"id": str(dtk_id), "size": min(max(1, size), 100)})
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] similar code={data.get('code') if data else None} msg={data.get('msg') if data else None}")
        return []
    return data.get("data") or []


async def get_ranking_list(rank_type: int = 1, cid: Optional[int] = None,
                           page_id: int = 1, page_size: int = 20) -> List[Dict]:
    """各大榜单：rankType(1-7) + 可选 cid(类目) -> 榜单商品列表（原始，待 normalize）。失败返回 []。"""
    params = {"rankType": rank_type, "pageId": str(page_id), "pageSize": min(max(10, page_size), 50)}
    if cid is not None:
        params["cid"] = cid
    data = await _call(_RANKING_PATH, settings.DATAOKE_RANKING_VERSION, params)
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] ranking code={data.get('code') if data else None} msg={data.get('msg') if data else None}")
        return []
    return data.get("data") or []


def rank_type_name(rank_type: int) -> str:
    return _RANK_TYPE_NAMES.get(rank_type, f"榜单{rank_type}")


async def get_hot_pick_items(page_size: int = 8, cid: Optional[int] = None) -> List[Dict]:
    """爆品卡数据源：拉「实时榜」(rankType=1，今天真在卖的品) 并归一化。

    返回结构化爆品列表，每项含 title/actualPrice/couponPrice/commissionRate/monthSales/
    mainPic/itemLink/shopName/dtk_id，供爆品卡直接渲染。失败或空返回 []（爆品卡据此降级）。
    """
    raw = await get_ranking_list(rank_type=1, page_id=1, page_size=min(max(page_size, 5), 20), cid=cid)
    items: List[Dict] = []
    for it in raw:
        norm = normalize_dataoke_item(it, source="大淘客")
        if not norm:
            continue
        # normalize_dataoke_item 返回的是 context/image/link 等字段（非 title/actualPrice），
        # 此处映射回爆品卡统一字段名，并保证 title/价/佣/销/图/链可读。
        commission = norm.get("commission_ratio")
        month_sales = norm.get("sales")
        actual = norm.get("price_value")
        items.append({
            "title": norm.get("context") or (it.get("title") or "").strip(),
            "actualPrice": actual,
            "originalPrice": it.get("originalPrice"),
            "couponPrice": _to_float(it.get("couponPrice")),
            "couponConditions": it.get("couponConditions"),
            "commissionRate": commission,
            "monthSales": month_sales,
            "mainPic": norm.get("image") or it.get("mainPic"),
            # 实时榜接口的 goodsId 是加密串（num_iid 为 None），拼出的 item.taobao.com/item.htm?id=<加密串>
            # 是无效链接、点了找不到详情页（8/27 用户实测）。透出 couponLink（uland 领券页，可正常打开）
            # 与明文 goodsId，让前端优先跳可用的领券链接；itemLink 仅作兜底。dtk_id 供单品诊断做跨源关联。
            "itemLink": norm.get("link") or it.get("itemLink"),
            "couponLink": it.get("couponLink") or "",
            "goodsId": it.get("goodsId") or "",
            "shopName": norm.get("shop") or it.get("shopName"),
            "dispatch": norm.get("shop_type"),
            "dtk_id": norm.get("dtk_id") or it.get("id"),
            "brand": norm.get("brand") or "",
        })
    return items


def rank_center_tabs() -> List[Dict]:
    """榜单中心可用的榜 Tab 清单（含中文名/副标题，已按实测数据校准，规避标错）。"""
    return _RANK_CENTER_META


async def get_rank_center_items(rank_type: int, page_size: int = 20) -> List[Dict]:
    """榜单中心数据源：按 rankType 拉榜并归一化，字段与 get_hot_pick_items 一致，供前端直接渲染。

    - 每个商品透出 title/actualPrice/couponPrice/commissionRate/monthSales/mainPic/
      itemLink/couponLink/goodsId/dtk_id/shopName/brand/sell_point 等。
    - 实时榜等 goodsId 为加密串：前端优先跳 couponLink(uland 领券页)，itemLink 仅兜底。
    - 30s TTL 缓存：同 rankType 在 TTL 内直接命中，不再打大淘客；返回**深拷贝**，
      调用方改写不影响缓存里的原始对象（ai_service 归一化时会就地改 items 字段）。
    """
    cache_key = f"rank_center:{rank_type}:{page_size}"
    cached = _hot_cache_get(cache_key)
    if cached is not None:
        return cached  # type: ignore
    raw = await get_ranking_list(rank_type=rank_type, page_id=1, page_size=min(max(page_size, 10), 50))
    items: List[Dict] = []
    for it in raw:
        norm = normalize_dataoke_item(it, source="大淘客")
        if not norm:
            continue
        commission = norm.get("commission_ratio")
        month_sales = norm.get("sales")
        actual = norm.get("price_value")
        title = norm.get("context") or (it.get("title") or "").strip()
        # sell_point：确定性卖点（与爆品卡同规则），供前端直接展示
        sell_point = ""
        if commission is not None:
            if commission >= 20:
                sell_point = "佣金≥20%，利润空间足"
            elif commission >= 10:
                sell_point = "佣金≥10%，走量有赚"
        if month_sales is not None:
            if month_sales >= 50000:
                sell_point = (sell_point + "、月销5万+，已验证热度").strip("、")
            elif month_sales >= 5000:
                sell_point = (sell_point + "、月销5000+，小爆潜质").strip("、")
        if actual is not None:
            if actual >= 100:
                sell_point = (sell_point + "、客单高").strip("、")
            elif actual < 30:
                sell_point = (sell_point + "、低价引流").strip("、")
        # 无任何阈值命中或卖点过短时，回退到通用兜底（避免「低价引流」单维度过短卖点）
        if len(sell_point) < 6:
            sell_point = "榜单热门品，先小批测再放量"
        items.append({
            "title": title,
            "actualPrice": actual,
            "originalPrice": it.get("originalPrice"),
            "couponPrice": _to_float(it.get("couponPrice")),
            "couponConditions": it.get("couponConditions"),
            "commissionRate": commission,
            "monthSales": month_sales,
            "priceText": f"¥{actual:.2f}" if actual is not None else "—",
            "commissionText": f"{commission:.1f}%" if commission else "—",
            "salesText": _fmt_amount(month_sales) if month_sales else "—",
            "mainPic": norm.get("image") or it.get("mainPic"),
            "itemLink": norm.get("link") or it.get("itemLink"),
            "couponLink": it.get("couponLink") or "",
            "goodsId": it.get("goodsId") or "",
            "shopName": norm.get("shop") or it.get("shopName"),
            "dispatch": norm.get("shop_type"),
            "dtk_id": norm.get("dtk_id") or it.get("id"),
            "brand": norm.get("brand") or "",
            # 前端接口统一读驼峰 sellPoint（清单中心曾用下划线 sell_point 导致卖点不显示，此处修正）
            "sellPoint": sell_point,
        })
    if cache_key and items:
        # 存深拷贝：调用方（ai_service 归一化/改写字段）改的是返回的独立副本，不污染缓存里的原始对象
        _hot_cache_set(cache_key, copy.deepcopy(items))
    return items


def _resonance_key(it: Dict) -> str:
    """跨榜单稳定标识（用于求交集算共振）：优先 dtk_id（大淘客内部数字 id，各榜一致且可靠）。

    - goodsId/num_iid 在实时榜(type=1)是加密串，拼不出有效详情、且无法稳定跨榜匹配，故不可用；
    - dtk_id = raw.get("id") 是各榜一致的数字 id，是共振检测唯一可靠键；
    - 仅当缺 dtk_id 时，用归一化标题（去空白转小写）做兜底匹配。
    """
    k = str(it.get("dtk_id") or "").strip()
    if k:
        return f"id:{k}"
    title = (it.get("title") or "").strip()
    if title:
        return "t:" + re.sub(r"\s+", "", title.lower())
    return ""


async def get_hot_pick_matrix(use_cache: bool = True) -> Dict:
    """爆品卡「多榜单专题矩阵」数据源：把多个榜单主题各归一化为一个专题列。

    每一列 = 一个榜单主题（实时爆品/低价高佣/大牛爆单/社群爆品/综合热搜/美妆集散），
    每个专题默认取前 N 件、提供完整归一化字段（含 sellPoint/priceText/commissionText/salesText），
    供前端爆品卡做「横向滑动切换专题列 + 点查看更多展开同榜更多」。
    返回 {"tabs": [...], "columns": [...]}；某榜失败/空时跳过该列，避免整列为空。

    - 单榜拉取失败或为空 → 跳过该专题列（get_rank_center_items 已做归一化+卖点派生）
    - 全为空时返回空列，前端据此无卡降级（复用爆品卡的空卡逻辑）
    - 30s TTL 缓存：命中直接返回深拷贝（不再打 6 个榜）；TTL 内每次拿到的是**同一帧**，
      跨 30s 边界则重建（配合后台每 30 分钟预拉，让关注者每次能拿到更新版）。
    - use_cache=False：跳过读缓存走实时拉取（仅供后台预拉用，预拉成功会回填缓存）。
    - API 故障时回退到最近预拉帧（_hot_prefetched），保证「有的是不同版本」。
    """
    if use_cache:
        cached = _hot_cache_get("hot_pick_matrix")
        if cached is not None:
            return cached  # type: ignore

    columns: List[Dict] = []
    # 各专题列每个榜默认取多少件（前端可点「查看更多」展开，这里取足量供前端分段展示）
    column_page_size = 12
    # 若整体优先用后台预拉帧（避免冷启动全量打 API），但预拉帧可能未包含新榜，需按需补齐。
    # 这里直接实时拉各榜（rank_center 层已有 30s 缓存），异常时用预拉帧兜底。
    for tab in _RANK_CENTER_META:
        rt = tab["type"]
        try:
            items = await get_rank_center_items(rank_type=rt, page_size=column_page_size)
        except Exception as e:
            print(f"[DATAOKE] hot_pick_matrix 榜[{rt}]拉取异常: {e}")
            continue
        if not items:
            continue
        columns.append({
            "type": rt,
            "title": tab["title"],
            "subtitle": tab["subtitle"],
            "items": items,
        })

    # ── 多榜单共振检测（2026-08-30 新增，低成本验证）──────────────
    # 跨 6 榜取商品交集：同一商品若登上 ≥MIN_RESONANCE_TABS 个榜单，即「多榜单共振」，
    # 视为更稳的爆品信号（多维度交叉验证：实时热度 + 高佣 + 社群团长 + 搜索热度等）。
    # columns 里的 items 是 rank_center 缓存的对象引用，共振标记会就地改写 → 先深拷贝整列，
    # 避免污染 rank_center 缓存（其它入口复用同一缓存），也保证本矩阵可独立演化。
    columns = copy.deepcopy(columns)
    _res_key_to_tabs: Dict[str, List[str]] = {}
    _res_key_to_item: Dict[str, Dict] = {}
    for _col in columns:
        _seen = set()
        for _it in _col["items"]:
            _k = _resonance_key(_it)
            if not _k or _k in _seen:
                continue
            _seen.add(_k)
            _res_key_to_tabs.setdefault(_k, []).append(_col["title"])
            if _k not in _res_key_to_item:
                _res_key_to_item[_k] = _it
    _resonance: List[Dict] = []
    for _k, _tabs in _res_key_to_tabs.items():
        if len(_tabs) < MIN_RESONANCE_TABS:
            continue
        _cnt = len(_tabs)
        # 在它出现的每个列副本上都打共振标记（columns 已深拷贝，互不干扰）
        for _col in columns:
            for _it in _col["items"]:
                if _resonance_key(_it) == _k:
                    _it["resonanceCount"] = _cnt
                    _it["resonanceTabs"] = list(_tabs)
        # 顶层共振列表收录代表项（带共振标记），供前端「多榜共振」专区直接渲染
        _rep = dict(_res_key_to_item[_k])
        _rep["resonanceCount"] = _cnt
        _rep["resonanceTabs"] = list(_tabs)
        _resonance.append(_rep)
    # 按共振榜数降序、再按月销降序，确定性排序
    _resonance.sort(key=lambda x: (x.get("resonanceCount", 0), _to_float(x.get("monthSales")) or 0), reverse=True)

    matrix: Dict = {"tabs": [{"type": t["type"], "title": t["title"], "subtitle": t["subtitle"]} for t in _RANK_CENTER_META],
                    "columns": columns,
                    "resonance": _resonance}
    if use_cache:
        if columns:
            _hot_cache_set("hot_pick_matrix", copy.deepcopy(matrix))
        elif _hot_prefetched is not None and _hot_prefetched.get("columns"):
            # 实时全空（API 抖/key 失效）→ 用最近预拉帧兜底，保证用户仍能拿到一版
            print("[DATAOKE] hot_pick_matrix 实时拉取全空，回退到后台预拉帧")
            matrix = copy.deepcopy(_hot_prefetched)
    return matrix


async def get_privilege_link(goods_id, coupon_id: str = None, pid: str = None) -> Optional[Dict]:
    """高效转链（C 端佣金变现关键）：goodsId -> 带 pid 的推广链接。受淘宝授权门控，未授权时优雅降级 None。

    pid 优先用入参，缺省回落到 settings.DATAOKE_PRIVILEGE_PID（大淘客后台默认转链位），
    再缺省则由大淘客用应用绑定 pid。授权恢复后转链自动带上该 pid -> 佣金进对应推广位。
    """
    if not goods_id:
        return None
    pid = pid or settings.DATAOKE_PRIVILEGE_PID or None
    params = {"goodsId": str(goods_id), "couponId": coupon_id, "pid": pid}
    data = await _call(_PRIVILEGE_LINK_PATH, settings.DATAOKE_PRIVILEGE_LINK_VERSION, params)
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] privilege-link code={data.get('code') if data else None} "
              f"msg={data.get('msg') if data else None}（转链需大淘客后台重授权淘宝账号，授权恢复后自动生效）")
        return None
    return data.get("data") or {}


async def get_goods_comments(dtk_id=None, goods_id=None,
                             ctype: int = 0, sort: int = 0, haoping_type: int = 0) -> Optional[List[Dict]]:
    """商品评论(口碑)：id 或 goodsId -> 评论列表。受淘宝授权/有无评论影响，失败优雅降级 None。"""
    if not dtk_id and not goods_id:
        return None
    params = {"type": ctype, "sort": sort, "haopingType": haoping_type}
    if dtk_id:
        params["id"] = str(dtk_id)
    else:
        params["goodsId"] = str(goods_id)
    data = await _call(_COMMENT_PATH, settings.DATAOKE_COMMENT_VERSION, params)
    if not data or data.get("code") != 0:
        print(f"[DATAOKE] comment code={data.get('code') if data else None} "
              f"msg={data.get('msg') if data else None}（评论需在后台授权淘宝账号，且商品需有评论）")
        return None
    d = data.get("data")
    if isinstance(d, dict):
        return d.get("list") or d.get("comments") or []
    return d if isinstance(d, list) else None


async def diagnose_by_link(text: str) -> Optional[Dict]:
    """贴链接单品诊断（核心缺口修复）：文本 -> 归一化单品 dict（含 num_iid）。

    流程：
      - 完整商品页(含 id=数字) -> 直接取 num_iid -> get_goods_detail_v2
      - 淘客短链/淘口令 -> parse_content -> goodsId -> get_goods_detail_v2
      - 均无 / 无 key / 接口失败 -> None（调用方降级到原有引导逻辑）
    """
    if not text:
        return None
    if not settings.DATAOKE_APP_KEY or not settings.DATAOKE_APP_SECRET:
        return None

    m = _LINK_ID_RE.search(text)
    goods_id = m.group(1) if m else None
    parse_bonus = None
    if not goods_id and _TAO_RE.search(text):
        parse_bonus = await parse_content(text)
        if parse_bonus:
            goods_id = parse_bonus.get("goodsId")

    if not goods_id:
        return None

    detail = await get_goods_detail(goods_id)
    if detail:
        # parse-content 的券/标题可能更全，做兜底补全
        if parse_bonus:
            for k in ("couponPrice", "couponConditions", "title", "shopName", "mainPic", "itemLink"):
                if not detail.get(k) and parse_bonus.get(k):
                    detail[k] = parse_bonus[k]
        return normalize_dataoke_item(detail)

    # detail 失败：若 parse-content 已带回价/佣/销（二合一券链接常见），用其兜底
    if parse_bonus:
        mapped = _map_parse_bonus(parse_bonus, goods_id)
        if mapped:
            return normalize_dataoke_item(mapped)
    return None
