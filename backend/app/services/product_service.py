import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

import httpx
from bs4 import BeautifulSoup

# 各平台「网站首页 / 反爬壳页」的标题特征，用于判断抓取到的页面是否为真实商品页。
# 匿名请求被拦截时，这些站点仍会返回带网站名标题的壳页，必须识别出来，避免把垃圾当真数据写入数据集。
_GENERIC_TITLE_PREFIXES: Dict[str, list] = {
    "taobao": ["淘宝网 -", "淘宝网-", "tmall.com", "淘宝(tmall)"],
    "jd": ["京东(jd.com)", "京东jd.com", "京东-专业的综合", "京东(jd"],
    "pdd": ["拼多多商城", "拼多多 -", "拼多多-", "拼多多官网"],
    "xiaohongshu": ["小红书 -", "小红书-"],
}
_GENERIC_TITLE_EXACT: Dict[str, set] = {
    "taobao": {"淘宝网", "淘宝", "taobao", "tmall"},
    "jd": {"京东", "京东商城", "jd.com", "jd"},
    "pdd": {"拼多多", "pdd", "拼多多商城"},
    "xiaohongshu": {"小红书", "xhs"},
}


class ProductService:
    def __init__(self):
        self.data_dir = Path(__file__).parent.parent / "product_data"
        self.data_dir.mkdir(exist_ok=True)

    @staticmethod
    def parse_link(text: str) -> Optional[Dict[str, str]]:
        """识别用户粘贴的商品链接或淘宝口令。"""
        tb_command = re.search(r"[￥$€]([a-zA-Z0-9]+)[￥$€]", text)
        if tb_command:
            return {"platform": "taobao", "type": "command", "value": tb_command.group(0)}

        url_match = re.search(r"https?://[^\s]+", text)
        if not url_match:
            return None
        url = url_match.group(0).rstrip("，。；;）)")
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        query = parse_qs(parsed.query)

        if "taobao.com" in host or "tmall.com" in host or host.endswith("tb.cn"):
            product_id = (query.get("id") or [None])[0]
            return {"platform": "taobao", "type": "url", "value": url, "product_id": product_id or ""}
        if "jd.com" in host or host == "3.cn":
            match = re.search(r"/(\d+)\.html", parsed.path)
            return {"platform": "jd", "type": "url", "value": url, "product_id": (match.group(1) if match else "")}
        if "yangkeduo.com" in host or "pinduoduo.com" in host:
            product_id = (query.get("goods_id") or query.get("goodsId") or [""])[0]
            return {"platform": "pdd", "type": "url", "value": url, "product_id": product_id}
        if "xiaohongshu.com" in host or "xhslink.com" in host:
            return {"platform": "xiaohongshu", "type": "url", "value": url, "product_id": parsed.path.rstrip("/").split("/")[-1]}
        return None

    @staticmethod
    def _clean_text(value: Optional[str]) -> str:
        return re.sub(r"\s+", " ", value or "").strip()

    @classmethod
    def _extract_json_ld(cls, soup: BeautifulSoup) -> Dict[str, Any]:
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                payload = json.loads(script.string or script.get_text())
                candidates = payload if isinstance(payload, list) else [payload]
                for item in candidates:
                    item_type = item.get("@type")
                    if isinstance(item_type, list):
                        is_product = "Product" in item_type
                    else:
                        is_product = item_type == "Product"
                    if isinstance(item, dict) and is_product:
                        return item
            except (json.JSONDecodeError, TypeError):
                continue
        return {}

    @classmethod
    def _extract_product(cls, html: str, link: Dict[str, str]) -> Dict[str, Any]:
        soup = BeautifulSoup(html, "lxml")
        json_ld = cls._extract_json_ld(soup)
        offers = json_ld.get("offers", {}) if isinstance(json_ld, dict) else {}
        if isinstance(offers, list):
            offers = offers[0] if offers else {}

        meta = {
            tag.get("property") or tag.get("name"): tag.get("content", "")
            for tag in soup.select("meta[property], meta[name]")
            if tag.get("content")
        }
        title = cls._clean_text(
            json_ld.get("name")
            or meta.get("og:title")
            or meta.get("twitter:title")
            or (soup.title.get_text(" ", strip=True) if soup.title else "")
        )
        image = json_ld.get("image") or meta.get("og:image")
        if isinstance(image, list):
            image = image[0] if image else None
        price = offers.get("price") if isinstance(offers, dict) else None
        currency = offers.get("priceCurrency", "CNY") if isinstance(offers, dict) else "CNY"
        shop = cls._clean_text(meta.get("og:site_name") or meta.get("application-name"))

        return {
            "id": f"{link['platform']}_{link.get('product_id') or abs(hash(link['value']))}",
            "platform": link["platform"],
            "platform_product_id": link.get("product_id") or None,
            "source_url": link["value"],
            "title": title[:500],
            "price": str(price) if price is not None else None,
            "currency": currency,
            "image_url": image,
            "shop_name": shop or None,
            "brand": cls._clean_text(json_ld.get("brand", {}).get("name") if isinstance(json_ld.get("brand"), dict) else json_ld.get("brand")) or None,
            "description": cls._clean_text(json_ld.get("description") or meta.get("description"))[:1000] or None,
            "data_source": "user_submitted_public_page",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "field_status": {
                "title": bool(title),
                "price": price is not None,
                "image_url": bool(image),
                "brand": bool(json_ld.get("brand")),
                "shop_name": bool(shop),
            },
        }

    @classmethod
    def _is_generic_title(cls, title: Optional[str], platform: str) -> bool:
        """判断标题是否为网站首页/反爬壳页的标题（而非真实商品标题）。"""
        if not title:
            return True
        t = title.strip().lower()
        for prefix in _GENERIC_TITLE_PREFIXES.get(platform, []):
            if t.startswith(prefix.lower()):
                return True
        return t in _GENERIC_TITLE_EXACT.get(platform, set())

    async def import_url(self, raw_url: str) -> Dict[str, Any]:
        link = self.parse_link(raw_url)
        if not link or link.get("type") == "command":
            raise ValueError("请粘贴淘宝、京东、拼多多或小红书的商品网页链接")

        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; BeautySelectionAssistant/1.0)",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                response = await client.get(link["value"], headers=headers)
                response.raise_for_status()
        except httpx.HTTPError as error:
            raise ValueError(f"商品页面暂时无法访问：{error}") from error

        product = self._extract_product(response.text, link)

        title_is_generic = self._is_generic_title(product["title"], link["platform"])
        has_core_field = any(
            [
                product.get("price") is not None,
                product.get("brand"),
                product.get("shop_name"),
            ]
        )
        if title_is_generic or not has_core_field:
            reasons = []
            if title_is_generic:
                reasons.append(
                    f"页面标题是网站首页/反爬壳页（标题为「{product.get('title') or '无'}」）"
                )
            if not has_core_field:
                reasons.append("未提取到价格/品牌/店铺等商品关键信息")
            raise ValueError(
                "链接未抓到有效商品数据（"
                + "；".join(reasons)
                + "）。这类页面通常需要登录或限制了公开访问，"
                "建议换用官方开放平台 API 或带浏览器登录态抓取。"
            )

        output = self.data_dir / f"{product['id']}.json"
        output.write_text(json.dumps(product, ensure_ascii=False, indent=2), encoding="utf-8")
        return product

    def list_products(self) -> list[Dict[str, Any]]:
        products = []
        for path in sorted(self.data_dir.glob("*.json"), reverse=True):
            try:
                products.append(json.loads(path.read_text(encoding="utf-8")))
            except json.JSONDecodeError:
                continue
        return products

    @staticmethod
    def detect_platform(text: str) -> Optional[str]:
        parsed = ProductService.parse_link(text)
        return parsed["platform"] if parsed else None


product_service = ProductService()
