import asyncio
import httpx
import json
import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from pathlib import Path
from app.core.config import settings


BEAUTY_SEARCH_QUERIES = [
    {"query": "抖音美妆热销品类 月销万件 2025", "tag": "抖音热销"},
    {"query": "小红书护肤美妆热门话题 2025", "tag": "小红书热门"},
    {"query": "敏感肌护肤爆款 抖音小红书 2025", "tag": "敏感肌赛道"},
    {"query": "美妆彩妆新品爆款 2025 趋势", "tag": "彩妆趋势"},
    {"query": "防晒霜热销排行 价格区间 2025", "tag": "防晒市场"},
    {"query": "精华液爆款 成分 价格带 2025", "tag": "精华赛道"},
    {"query": "粉底液口红 热销品类 2025", "tag": "彩妆销量"},
    # —— 以下为「商品级」查询：目标是让公开摘要里出现具体品牌 + 参考价，供选品线索抽取 ——
    {"query": "防晒霜 推荐 单品 价格 2026 小红书", "tag": "防晒单品"},
    {"query": "美妆 爆款 单品 价格 测评 2026 抖音 小红书", "tag": "爆款单品"},
]

# 简繁中文归一化表：公开摘要常混有港台繁体（防曬/價格/妝），统一成简体再匹配
_ZH_TRAD2SIMP = {
    "曬": "晒", "價": "价", "錢": "钱", "顏": "颜", "無": "无", "類": "类", "為": "为",
    "麼": "么", "這": "这", "時": "时", "點": "点", "實": "实", "優": "优", "質": "质",
    "強": "强", "補": "补", "劑": "剂", "終": "终", "導": "导", "體": "体", "軟": "软",
    "細": "细", "組": "组", "幫": "帮", "開": "开", "關": "关", "豐": "丰", "妝": "妆",
    "進": "进", "過": "过", "據": "据", "專": "专", "護": "护", "膚": "肤", "號": "号",
    "數": "数", "層": "层", "總": "总", "動": "动", "網": "网", "視": "视", "說": "说",
    "話": "话", "語": "语", "購": "购", "費": "费", "輕": "轻", "週": "周", "場": "场",
    "圖": "图", "頂": "顶", "項": "项", "飛": "飞", "馬": "马", "魚": "鱼", "麗": "丽",
    "葉": "叶", "歲": "岁", "帶": "带", "參": "参", "雙": "双", "對": "对", "處": "处",
    "產": "产", "達": "达", "態": "态", "確": "确", "辦": "办", "劃": "划", "環": "环",
    "畫": "画", "夢": "梦", "歡": "欢", "當": "当", "們": "们", "來": "来", "個": "个",
    "從": "从", "給": "给", "紅": "红", "級": "级", "經": "经", "結": "结", "維": "维",
    "線": "线", "練": "练", "覽": "览", "觀": "观", "評": "评", "論": "论", "設": "设",
    "試": "试", "詳": "详", "調": "调", "變": "变", "賣": "卖", "資": "资", "軍": "军",
    "運": "运", "還": "还", "遠": "远", "選": "选", "遲": "迟", "醫": "医", "題": "题",
    "順": "顺", "風": "风", "飾": "饰", "廠": "厂", "廣": "广", "應": "应", "備": "备",
    "複": "复", "見": "见", "規": "规", "親": "亲", "農": "农", "裡": "里", "髮": "发",
    "齡": "龄", "龍": "龙", "續": "续", "統": "统", "紹": "绍", "織": "织", "納": "纳",
    "綱": "纲", "綠": "绿", "顯": "显", "覺": "觉", "認": "认", "識": "识", "誰": "谁",
    "謝": "谢", "講": "讲", "許": "许", "讀": "读",
}
_ZH_TRANS = str.maketrans(_ZH_TRAD2SIMP)


def _zh_norm(text: str) -> str:
    """繁体→简体（仅覆盖美妆/市场高频字），提升跨地区摘要匹配率。"""
    if not text:
        return ""
    return text.translate(_ZH_TRANS)


# 美妆品牌词典（用于从公开摘要中抽取商品线索）；按长度降序避免子串误匹配
_BEAUTY_BRANDS = sorted(
    {
        # 国际高端
        "海蓝之谜", "赫莲娜", "雅诗兰黛", "兰蔻", "SK-II", "SKII", "香奈儿", "迪奥",
        "圣罗兰", "YSL", "阿玛尼", "纪梵希", "植村秀", "MAC", "魅可", "修丽可",
        "资生堂", "安热沙", "ANESSA", "理肤泉", "雅漾", "兰芝", "悦诗风吟", "芙丽芳丝",
        "蜜丝婷", "Mistine", "Fenty Beauty", "毛戈平",
        # 国货头部 / 功效护肤
        "珀莱雅", "薇诺娜", "欧莱雅", "玉兰油", "玉泽", "至本", "润百颜", "夸迪", "米蓓尔",
        "韩束", "自然堂", "百雀羚", "欧诗漫", "相宜本草", "一叶子", "温碧泉", "绽妍",
        "溪木源", "花西子", "完美日记", "橘朵", "彩棠", "皮可熊", "彩漾", "玛丽黛佳",
        "YES!IC", "毛戈平", "卡姿兰", "美宝莲", "花知晓",
        # 防晒 / 垂类
        "曼秀雷敦", "娜丽丝", "UNNY", "怡思丁", "碧柔", "蜜丝婷", "修丽可", "薇诺娜",
        "珀莱雅", "安热沙", "资生堂", "理肤泉",
        # 底妆 / 工具
        "KATO", "KATE", "DPDP", "PUCO", "三资堂", "蒂洛薇", "柏瑞美", "PL", "受受",
        # 洗护
        "丝塔芙", "玉泽",
    },
    key=len,
    reverse=True,
)

# 商品品类词（用于抽取商品类型线索）；含繁体变体以覆盖港台来源
_PRODUCT_TYPES = sorted(
    {
        "防晒霜", "防晒乳", "防晒喷雾", "防晒", "防曬霜", "防曬乳", "防曬噴霧", "防曬",
        "精华液", "精华", "精華液", "精華", "粉底液", "粉底", "气垫", "气墊",
        "口红", "唇釉", "唇泥", "唇彩", "面膜", "面霜", "水乳", "眼霜", "洗发水",
        "护发素", "香水", "底妆", "彩妆", "彩妝", "腮红", "散粉", "卸妆", "卸妆水", "卸妆油", "卸妆膏", "洁面",
        "爽肤水", "乳液", "精华水", "面护", "护肤", "化妆水", "化妆水", "隔离霜",
        "遮瑕", "眉笔", "眼影", "定妆", "素颜霜", "身体乳", "护手霜",
    },
    key=len,
    reverse=True,
)

# 全品类商品品类词（general 模式选品搜索用）：覆盖美妆之外的常见带货品类。
# 关键修复：原 _PRODUCT_TYPES 只有美妆词（含「洁面」但无「洗面奶」），导致
# 「买个洗面奶你推荐一个」这类自然语言抽不到品类词、退化为整句垃圾词，
# 好单库搜空 → 商品卡消失。这里补齐常见 全品类 名词，让选品词抽取稳。
_GENERIC_PRODUCT_TYPES = sorted(
    {
        # 个护清洁
        "洗面奶", "洁面乳", "洁面慕斯", "洗面", "洁面", "沐浴露", "洗发水", "护发素",
        "牙膏", "牙刷", "漱口水", "纸巾", "抽纸", "洗衣液", "洗衣凝珠", "香皂", "洗手液",
        "洗脸巾", "棉柔巾", "卸妆巾", "湿巾", "洁面巾", "一次性毛巾", "纯棉洗脸巾",
        # 个护清洁·复合/细分品（2026-08-26 补：复合词缺失会导致 _longest_match 只抽到次级词丢修饰，搜偏）
        "一次性洗脸巾", "加厚洗脸巾", "婴儿湿巾", "厨房湿巾", "酒精湿巾", "卸妆湿巾",
        "拖地湿巾", "湿厕纸", "洗脸棉柔巾", "洗脸扑", "化妆棉", "卸妆棉", "棉柔巾",
        "发膜", "护手霜", "身体乳", "身体磨砂膏", "沐浴油", "洗发膏", "肥皂", "洗衣粉",
        "洗洁精", "洗洁精", "垃圾袋", "保鲜膜", "保鲜袋", "保鲜盒", "厨房纸", "懒人抹布",
        "除螨喷雾", "驱蚊液", "防晒衣", "干发帽", "浴帽", "一次性内裤", "香氛",
        # 食品饮料·复合/细分品
        "无糖饮料", "气泡水", "椰汁", "能量棒", "蛋白棒", "代餐奶昔", "水果麦片",
        "冻干水果", "肉松", "卤味", "鸭脖", "鸡胸肉", "低脂轻食", "坚果礼盒", "咖啡液",
        "冲饮燕麦", "低卡零食", "自热火锅", "方便速食", "牛肉干", "果冻", "瓜子",
        "宠物零食", "猫零食", "狗零食", "猫罐头", "猫抓板", "猫爬架", "逗猫棒",
        "狗狗零食", "狗罐头", "婴儿奶粉", "宝宝辅食", "宝宝霜", "儿童玩具", "婴儿湿巾",
        # 家居日用·复合/细分品
        "置物架", "鞋架", "衣架", "挂钩", "抽屉收纳盒", "收纳箱", "收纳袋", "防尘罩",
        "乳胶枕", "香薰蜡烛", "氛围灯", "懒人沙发", "落地衣架", "地毯", "窗帘",
        "行李箱", "旅行收纳袋", "化妆品收纳", "彩妆收纳盒", "拖地湿巾", "蟑螂药",
        # 数码·复合/细分品
        "直播支架", "手机支架", "自拍杆", "补光灯", "电竞椅", "电脑桌", "显示器支架",
        "无线充电器", "智能手表", "智能音箱", "机械键盘", "桌面收纳", "办公椅",
        # 母婴宠物·复合/细分品
        "宠物牵引绳", "自动喂食器", "猫咪用品", "狗狗用品", "婴儿辅食", "婴童装",
        "儿童牙刷", "儿童水杯", "儿童餐具", "宝宝护肤", "尿不湿", "拉拉裤", "隔尿垫",
        # 服饰鞋包·复合/细分品
        "运动内衣", "鲨鱼裤", "打底裤", "阔腿裤", "瑜伽裤", "冲锋衣", "防晒服", "防晒衣",
        "卫衣", "T恤", "牛仔", "工装裤", "帆布包", "登山鞋", "运动袜", "棒球帽",
        "女性内衣", "男性内裤", "儿童内衣", "情侣装", "亲子装", "半身裙", "连衣裙",
        # 运动户外·复合/细分品
        "瑜伽服", "跳绳", "露营灯", "折叠椅", "帐篷", "钓鱼竿", "健身器材",
        # 文具图书·细分品
        "中性笔", "圆珠笔", "马克笔", "便利贴", "文件夹", "书包",
        # 饰品/其他
        "手链", "项链", "耳环", "发夹", "手机壳", "保温杯", "雨伞", "折叠伞", "太阳镜", "墨镜",
        # 独立品类/赛道词（用户常说的「品类名」而非具体单品，用于频道浏览式搜索）。
        # 关键修复：原词典只有具体单品词，缺独立品类词，导致
        # 「宠物赛道值不值得进」「女生用品类目现在市场怎么样」「家居类目」这类高频问法
        # 抽不到品类词 → beauty 模式退化为 ""、general 模式退化成整句垃圾词 →
        # 好单库(大淘客)搜空/搜偏 → 数据卡回退到「暂未取到真实联盟数据」兜底。
        # 这里补齐常见 独立品类/赛道名，让选品词抽取稳，直接拿到真实价格带。
        "宠物用品", "宠物", "猫用品", "狗用品", "猫咪", "狗狗",
        "家居用品", "家居", "日用百货", "日用品", "生活日用", "收纳用品", "收纳",
        "母婴用品", "母婴", "孕婴", "婴童", "童品",
        "女生用品", "女性用品", "私护", "卫生巾",
        "保健品", "营养品", "滋补品", "养生",
        "生鲜", "水果", "蔬菜", "海鲜",
        "益智玩具", "玩具", "童玩",
        "文胸", "内衣", "内裤",
        "数码产品", "数码", "家电", "家用电器", "小家电",
        "服饰", "服装", "穿搭",
        "鞋包", "箱包",
        "运动", "户外", "健身",
        "食品饮料", "食品", "饮品",
        "个人护理", "个护", "清洁",
        "美妆个护", "美妆",
    },
    key=len,
    reverse=True,
)

# 价格正则：覆盖 ¥/RM/NT$/HK$/US$、X元(含 X元/50ml)、参考价/活动价/价格：X元
_PRICE_RE = re.compile(
    r"(?:¥|RMB|RM|NT\$|HK\$|US\$)\s?\d+(?:\.\d+)?"
    r"|\d+(?:\.\d+)?\s*元(?:/\s*\d+\s*(?:ml|g|片|支|瓶|ML|G))?"
    r"|\d+(?:\.\d+)?\s*块"
    r"|(?:参考价|活动价|价格|價格)\s*[:：]?\s*\d+(?:\.\d+)?\s*元",
    re.IGNORECASE,
)
_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


class BeautyDataCrawler:
    """美妆公开数据采集服务（基于 Serper 定向搜索）。

    合规说明：
    - 仅通过 Serper 官方搜索 API 获取**公开网页的索引元数据**（标题 / 摘要 / 链接），
      不抓取目标站点、不解析电商详情页、不采集任何个人数据。
    - 查询之间按 CRAWL_DELAY 做礼貌间隔，避免瞬时并发；失败时静默跳过单条，不重试轰炸。
    - 数据仅用于趋势/热度参考，对外表述不得声称是平台「真实成交」数据。
    """

    def __init__(self):
        self.api_key = settings.SERPER_API_KEY
        self.crawl_delay = settings.CRAWL_DELAY
        self.max_age_hours = settings.CRAWL_MAX_AGE_HOURS
        self.time_filter = settings.CRAWL_TIME_FILTER
        self._lock = asyncio.Lock()
        self.data_dir = Path(__file__).parent.parent / "crawled_data"
        self.data_dir.mkdir(exist_ok=True)

    async def _serper_search(self, query: str, num: int = 5, time_filter: str = None) -> List[Dict]:
        if not self.api_key or self.api_key == "your-serper-api-key-here":
            return []
        try:
            payload = {"q": query, "num": num, "gl": "cn", "hl": "zh-cn"}
            if time_filter:
                payload["tbs"] = time_filter
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    "https://google.serper.dev/search",
                    headers={"X-API-KEY": self.api_key, "Content-Type": "application/json"},
                    json=payload
                )
                response.raise_for_status()
                data = response.json()
                results = []
                for item in data.get("organic", [])[:num]:
                    results.append({
                        "title": item.get("title", ""),
                        "snippet": item.get("snippet", ""),
                        "link": item.get("link", ""),
                    })
                return results
        except Exception as e:
            print(f"[CRAWLER] Serper search failed ({query[:20]}...): {e}")
            return []

    async def search_product_articles(self, query: str, num: int = 5) -> List[Dict]:
        """商品级联网检索：返回公开文章/测评的标题、摘要、链接，用于给商品介绍做真实依据。

        与 crawl_all 的区别：crawl_all 爬的是固定美妆市场趋势榜单；本方法针对**单个商品**
        做定向检索，返回 organic 结果（title/snippet/link）。无 Serper key 时返回空（调用方降级）。
        """
        return await self._serper_search(query, num=num, time_filter=self.time_filter)

    async def crawl_all(self) -> Dict:
        """采集所有美妆市场数据"""
        print("[CRAWLER] Starting beauty market data crawl...")
        all_data = {}

        for item in BEAUTY_SEARCH_QUERIES:
            results = await self._serper_search(item["query"], num=5, time_filter=self.time_filter)
            all_data[item["tag"]] = results
            print(f"[CRAWLER] {item['tag']}: {len(results)} results")
            await asyncio.sleep(self.crawl_delay)

        data = {
            "crawled_at": datetime.now().isoformat(),
            "source": "Serper",
            "categories": all_data,
        }

        output_file = self.data_dir / f"beauty_data_{datetime.now().strftime('%Y%m%d')}.json"
        # 缓存写入是 best-effort：被外部进程锁住/无写权限时降级，绝不阻断调用方（否则会让整条聊天回答失败）
        try:
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[CRAWLER] 缓存写入失败（降级，不影响本次返回）: {e}")

        total = sum(len(v) for v in all_data.values())
        print(f"[CRAWLER] Done: {total} total items")
        return data

    def load_latest(self) -> Dict:
        """加载最新的采集数据（读取失败降级返回空，不阻断调用方）"""
        try:
            files = sorted(self.data_dir.glob("beauty_data_*.json"), reverse=True)
            if not files:
                return {}
            with open(files[0], "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[CRAWLER] 读取缓存失败（降级返回空）: {e}")
            return {}

    def format_for_ai(self, keyword: str = "") -> str:
        """格式化爬取数据注入 AI prompt"""
        data = self.load_latest()
        if not data:
            return ""

        crawled_at = data.get("crawled_at", "")[:10]
        categories = data.get("categories", {})
        if not categories:
            return ""

        relevant = []
        kws = keyword.split() if keyword else []

        for tag, items in categories.items():
            for item in items:
                text = item.get("title", "") + item.get("snippet", "")
                if not kws or any(kw in text for kw in kws):
                    title = item.get("title", "")[:50]
                    snippet = item.get("snippet", "")[:80]
                    relevant.append(f"[{tag}] {title}: {snippet}")

        if not relevant:
            # 关键词无匹配时取各品类前2条
            for tag, items in categories.items():
                for item in items[:2]:
                    title = item.get("title", "")[:50]
                    snippet = item.get("snippet", "")[:60]
                    relevant.append(f"[{tag}] {title}: {snippet}")

        if not relevant:
            return ""

        header = f"\n\n[美妆市场数据 {crawled_at}]\n"
        body = "\n".join(relevant[:8])
        return header + body

    async def extract_product_leads(self, keyword: str = "", max_items: int = 12) -> List[Dict]:
        """从已采集的公开摘要中抽取具体商品线索（品牌 + 品类 + 参考价）。

        注意：线索来自公开报道/榜单摘要，并非平台成交数据，仅作选品参考。
        keyword 命中时只返回相关线索；若公开数据里没有该品类的具体商品，则返回空（不编造、不污染）。
        """
        data = await self.get_fresh_data()
        categories = data.get("categories", {})
        leads: List[Dict] = []
        seen = set()
        for tag, items in categories.items():
            for item in items:
                text = _zh_norm((item.get("title", "") or "") + "。" + (item.get("snippet", "") or ""))
                brands = [b for b in _BEAUTY_BRANDS if b.lower() in text.lower()]
                if not brands:
                    continue
                price_text, price_val = self._find_price(text)
                ptype = self._find_product_type(text)
                for brand in brands:
                    key = (brand, ptype, price_text)
                    if key in seen:
                        continue
                    seen.add(key)
                    leads.append({
                        "brand": brand,
                        "product_type": ptype,
                        "price_text": price_text,
                        "price_value": price_val,
                        "source_tag": tag,
                        "link": item.get("link", ""),
                        "context": _zh_norm(item.get("snippet", "") or "")[:120],
                    })
        if keyword:
            norm_kw = _zh_norm(keyword)
            kws = norm_kw.split()
            filtered = [
                l for l in leads
                if any(
                    kw in (l["brand"] + (l["product_type"] or "") + (l["source_tag"] or "") + (l["context"] or ""))
                    for kw in kws
                )
            ]
            # 命中即返回相关线索；命中为空则如实返回空（不回退到无关品牌）
            leads = filtered
        leads.sort(key=lambda l: (l["price_value"] is not None, l["brand"]), reverse=True)
        return leads[:max_items]

    def _find_price(self, text: str):
        text = _zh_norm(text)
        m = _PRICE_RE.search(text)
        if not m:
            return None, None
        txt = m.group(0)
        num = _NUM_RE.search(txt)
        val = float(num.group(0)) if num else None
        return txt, val

    @staticmethod
    def _find_product_type(text: str) -> Optional[str]:
        text = _zh_norm(text)
        for t in _PRODUCT_TYPES:
            if t in text:
                return t
        return None

    async def format_product_leads(self, keyword: str = "") -> str:
        """把商品线索格式化为可注入 AI prompt 的文本。"""
        leads = await self.extract_product_leads(keyword=keyword, max_items=8)
        if not leads:
            return ""
        lines = []
        for l in leads:
            price = f"参考价 {l['price_text']}" if l["price_text"] else "价格未提及"
            ptype = l["product_type"] or "商品"
            lines.append(f"- {l['brand']} {ptype}｜{price}（来源：{l['source_tag']}）")
        header = "\n\n[热门商品线索（公开报道整理，非平台成交数据，仅供选品参考）]\n"
        return header + "\n".join(lines)


    async def ensure_fresh(self, max_age_hours: float = None) -> bool:
        """本地缓存缺失或超过时效才重新采集（合规：不每次请求都打 API）。返回是否发生了刷新。"""
        max_age = self.max_age_hours if max_age_hours is None else max_age_hours
        async with self._lock:
            data = self.load_latest()
            if data and self._is_fresh(data.get("crawled_at"), max_age):
                return False
            await self.crawl_all()
            return True

    async def get_fresh_data(self, max_age_hours: float = None) -> Dict:
        """返回最新美妆市场数据；过期则先刷新。"""
        await self.ensure_fresh(max_age_hours)
        return self.load_latest()

    @staticmethod
    def _is_fresh(crawled_at: str, max_age_hours: float) -> bool:
        if not crawled_at:
            return False
        try:
            ts = datetime.fromisoformat(crawled_at)
        except ValueError:
            return False
        age_hours = (datetime.now() - ts).total_seconds() / 3600.0
        return age_hours <= max_age_hours


beauty_crawler = BeautyDataCrawler()
