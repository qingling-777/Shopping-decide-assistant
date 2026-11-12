"""公网分享服务（获客飞轮核心）。

把一次选品对话产出的「报告」存成 JSON，生成短链 share_id + 公网可访问的 HTML 页。
HTML 页自带：
  - 品牌头 + 报告标题/日期
  - 逐卡片渲染（机会 / 商品 / 风险 / 数据 / 行动 / 热点 / 趋势 / 通用）
  - 每张卡片底部「数据来源 + 可信度」溯源小字
  - 底部品牌 CTA + 「保存图片」按钮（html-to-image，把整张带溯源卡片导出为 PNG）

存储：SQLite（与订阅库同级，*.sqlite3 已被 .gitignore 忽略）。无外部依赖，纯净。

⚠️ 模板统一用 __TOKEN__ 占位符 + str.replace 拼接，避免 f-string/.format 与 CSS/JS 花括号冲突。
"""
import html
import json
import sqlite3
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional

from app.core.config import settings


class ShareService:
    def __init__(self):
        self.db_path = Path(__file__).resolve().parents[4] / "share.sqlite3"
        self._initialize_database()

    # ── 存储 ──────────────────────────────────────────────
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=30000')
        return conn

    def _initialize_database(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS shared_reports (
                    id          TEXT PRIMARY KEY,
                    owner_id    TEXT,
                    title       TEXT NOT NULL DEFAULT '美妆选品报告',
                    payload     TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    expires_at  TEXT
                )
                """
            )
            try:
                conn.execute("CREATE INDEX IF NOT EXISTS idx_share_owner ON shared_reports(owner_id)")
            except sqlite3.OperationalError:
                pass

    @staticmethod
    def _gen_id() -> str:
        # URL-safe，约 11 字符，足够短且碰撞概率极低
        return secrets.token_urlsafe(8).replace("-", "").replace("_", "")[:11] or secrets.token_hex(6)

    def create_report(self, payload: Dict, owner_id: Optional[str] = None, ttl_days: Optional[int] = None) -> str:
        share_id = self._gen_id()
        now = datetime.now()
        expires_at = None
        ttl = ttl_days if ttl_days is not None else settings.SHARE_DEFAULT_TTL_DAYS
        if ttl and ttl > 0:
            expires_at = (now + timedelta(days=ttl)).isoformat(timespec="seconds")
        title = (payload.get("title") or "美妆选品报告")[:120]
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO shared_reports (id, owner_id, title, payload, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (share_id, owner_id, title, json.dumps(payload, ensure_ascii=False), now.isoformat(timespec="seconds"), expires_at),
            )
        return share_id

    def get_report(self, share_id: str) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM shared_reports WHERE id = ?", (share_id,)).fetchone()
        if not row:
            return None
        payload = json.loads(row["payload"]) if row["payload"] else {}
        expires_at = row["expires_at"]
        expired = bool(expires_at) and datetime.now() > datetime.fromisoformat(expires_at)
        return {
            "id": row["id"],
            "owner_id": row["owner_id"],
            "title": row["title"],
            "payload": payload,
            "created_at": row["created_at"],
            "expires_at": expires_at,
            "expired": expired,
        }

    # ── 公开页渲染 ────────────────────────────────────────
    def render_public_page(self, share_id: str) -> str:
        share = self.get_report(share_id)
        if not share:
            return self._error_page("链接不存在", "该分享链接已失效或从未生成。")
        if share["expired"]:
            return self._error_page("链接已过期", "该分享链接已超过有效期，请向分享者索取最新链接。")

        payload = share["payload"]
        title = share["title"]
        created_at = share["created_at"]
        summary = payload.get("summary") or ""
        tags = payload.get("tags") or []
        cards = payload.get("cards") or []

        card_html_parts: List[str] = []
        for c in cards:
            ctype = (c.get("cardType") or c.get("type") or "generic")
            cdata = c.get("cardData") or c.get("data") or {}
            card_html_parts.append(self._render_card(str(ctype), cdata))
        cards_html = "\n".join(card_html_parts)

        tags_html = ""
        if tags:
            tags_html = '<div class="tags">' + "".join(f'<span class="tag">#{html.escape(str(t))}</span>' for t in tags[:6]) + "</div>"

        summary_html = f'<p class="summary">{html.escape(summary)}</p>' if summary else ""
        created_fmt = created_at.replace("T", " ")[:16] if created_at else ""

        cta_html = ""
        if settings.SHARE_CTA_URL:
            cta_html = (
                f'<a class="cta-btn" href="{html.escape(settings.SHARE_CTA_URL)}" target="_blank" rel="noopener">'
                f'用 AI 美妆选品顾问做选品 ›</a>'
            )

        return PUBLIC_PAGE_TEMPLATE.replace("__CSS__", PAGE_CSS) \
            .replace("__TITLE__", html.escape(title)) \
            .replace("__OG_TITLE__", html.escape(title)) \
            .replace("__OG_DESC__", html.escape((summary or "AI 美妆选品顾问 · 带数据溯源的选品报告")[:80])) \
            .replace("__CREATED__", html.escape(created_fmt)) \
            .replace("__TAGS__", tags_html) \
            .replace("__SUMMARY__", summary_html) \
            .replace("__CARDS__", cards_html) \
            .replace("__CTA__", cta_html) \
            .replace("__APP_NAME__", html.escape(settings.APP_NAME))

    # ── 单卡片渲染分发 ────────────────────────────────────
    def _render_card(self, ctype: str, data: any) -> str:
        renderer = {
            "opportunity": self._render_opportunity,
            "product": self._render_products,
            "risk": self._render_risk,
            "data_insight": self._render_data_insight,
            "next_actions": self._render_next_actions,
            "hot_category": self._render_hot_category,
            "trend": self._render_trend,
        }.get(ctype, self._render_generic)
        try:
            inner = renderer(data)
        except Exception as e:
            inner = f'<p class="note">该卡片渲染失败：{html.escape(str(e))}</p>'
        label = CARD_LABELS.get(ctype, "选品情报")
        return f'<section class="card"><div class="card-label">{html.escape(label)}</div>{inner}</section>'

    @staticmethod
    def _source_footer(data: Dict) -> str:
        src = data.get("source") or data.get("sourceLabel")
        conf = data.get("confidence")
        if not src and not conf:
            return ""
        parts = []
        if src:
            parts.append(f'数据来源：{html.escape(str(src))}')
        if conf:
            color = {"高": "#16a34a", "中": "#d97706", "低": "#dc2626"}.get(str(conf), "#6b7280")
            parts.append(f'<span style="color:{color};font-weight:600">可信度·{html.escape(str(conf))}</span>')
        return f'<div class="trace">{" · ".join(parts)}</div>'

    # ── 各卡片类型 ────────────────────────────────────────
    def _render_opportunity(self, d: Dict) -> str:
        if not isinstance(d, dict):
            return self._render_generic(d)
        title = d.get("title") or "机会方向"
        score = d.get("opportunityScore")
        comp = d.get("competitionLevel") or ""
        risk = d.get("riskLevel") or ""
        platform = d.get("suggestedPlatform") or ""
        summary = d.get("summary") or ""
        m = d.get("metrics") or {}
        rows = []
        if score is not None:
            rows.append(f'<div class="kv"><span>机会分</span><b>{html.escape(str(score))}</b></div>')
        if comp:
            rows.append(f'<div class="kv"><span>竞争强度</span><b>{html.escape(str(comp))}</b></div>')
        if risk:
            rows.append(f'<div class="kv"><span>风险等级</span><b>{html.escape(str(risk))}</b></div>')
        if platform:
            rows.append(f'<div class="kv"><span>建议平台</span><b>{html.escape(str(platform))}</b></div>')
        for k in ("productCount", "topBrands", "priceBand", "avgCommissionText", "totalSalesText"):
            if m.get(k):
                rows.append(f'<div class="kv"><span>{html.escape(str(k))}</span><b>{html.escape(str(m[k]))}</b></div>')
        rows_html = f'<div class="kvs">{"".join(rows)}</div>' if rows else ""
        summary_html = f'<p class="card-summary">{html.escape(summary)}</p>' if summary else ""
        return f'<h3 class="card-title">{html.escape(title)}</h3>' + summary_html + rows_html + self._source_footer(d)

    def _render_products(self, data: any) -> str:
        items = data if isinstance(data, list) else [data]
        tiles = []
        for it in items[:8]:
            if not isinstance(it, dict):
                continue
            img = it.get("image") or ""
            brand = it.get("brand") or ""
            title = it.get("title") or ""
            price = it.get("priceText") or ""
            ratio = it.get("commissionRatio")
            sales = it.get("sales")
            chips = []
            if ratio is not None:
                chips.append(f'<span class="chip chip-comm">佣{html.escape(str(int(round(ratio))))}%</span>')
            if sales is not None:
                chips.append(f'<span class="chip chip-sales">月销{html.escape(str(int(round(sales))))}</span>')
            chips_html = f'<div class="chips">{"".join(chips)}</div>' if chips else ""
            reason = it.get("pickReason")
            reason_html = f'<div class="pick">⭐ 推荐理由：{html.escape(str(reason))}</div>' if reason else ""
            img_html = f'<img class="pimg" src="{html.escape(img)}" alt="" loading="lazy"/>' if img else '<div class="pimg ph">无图</div>'
            brand_html = f"<div class='pbrand'>{html.escape(brand)}</div>" if brand else ""
            tiles.append(
                f'<div class="ptile">{img_html}<div class="pbody">{reason_html}'
                f'{brand_html}'
                f'<div class="ptitle">{html.escape(title)}</div>'
                f'<div class="pprice">{html.escape(price)}</div>{chips_html}</div></div>'
            )
        return f'<div class="prow">{"".join(tiles)}</div>'

    def _render_risk(self, d: Dict) -> str:
        if not isinstance(d, dict):
            return self._render_generic(d)
        risk_level = d.get("riskLevel") or "medium"
        risk_label = {"low": "低风险", "medium_low": "中低风险", "medium": "中等风险", "high": "高风险"}.get(str(risk_level), "风险")
        risks_html = self._bullet_list(d.get("risks") or [], "主要风险")
        mit_html = self._bullet_list(d.get("mitigation") or [], "应对建议")
        return f'<div class="risk-badge">{html.escape(risk_label)}</div>' + risks_html + mit_html + self._source_footer(d)

    def _render_data_insight(self, d: Dict) -> str:
        if not isinstance(d, dict):
            return self._render_generic(d)
        fields = [
            ("avgPrice", "爆款均价"), ("priceBand", "主流价格带"), ("competitionLevel", "竞争强度"),
            ("avgCommission", "平均佣金"), ("totalSales", "月销合计"),
        ]
        rows = []
        for k, label in fields:
            if d.get(k):
                rows.append(f'<div class="kv"><span>{label}</span><b>{html.escape(str(d[k]))}</b></div>')
        if d.get("productCount") is not None:
            rows.append(f'<div class="kv"><span>在售商品</span><b>{html.escape(str(d["productCount"]))} 款</b></div>')
        if d.get("brandCount") is not None:
            rows.append(f'<div class="kv"><span>覆盖品牌</span><b>{html.escape(str(d["brandCount"]))} 个</b></div>')
        rows_html = f'<div class="kvs">{"".join(rows)}</div>' if rows else f'<p class="note">{html.escape(d.get("note") or "暂无可信数据")}</p>'
        return rows_html + self._source_footer(d)

    def _render_next_actions(self, d: Dict) -> str:
        if not isinstance(d, dict):
            return self._render_generic(d)
        product = d.get("product") or ""
        now = d.get("now") or []
        this_week = d.get("this_week") or []
        next_week = d.get("next_week") or []
        head = f'<div class="na-head">🎯 下一步行动 · {html.escape(product)}</div>' if product else '<div class="na-head">🎯 下一步行动</div>'
        secs = []
        for label, items in (("现在可以做", now), ("本周要做", this_week), ("下周要做", next_week)):
            if items:
                secs.append(
                    f'<div class="na-sec"><div class="na-sec-t">{html.escape(label)}</div>'
                    + "".join(f'<div class="na-item">☐ {html.escape(str(i))}</div>' for i in items)
                    + "</div>"
                )
        return head + "".join(secs) + self._source_footer(d)

    def _render_hot_category(self, d: Dict) -> str:
        if not isinstance(d, dict):
            return self._render_generic(d)
        name = d.get("name") or ""
        tag = d.get("tag") or ""
        score = d.get("score")
        score_label = d.get("scoreLabel") or "机会分"
        parts = [f'<div class="hc-name">{html.escape(name)}</div>']
        if tag:
            parts.append(f'<div class="hc-tag">{html.escape(tag)}</div>')
        if score is not None:
            parts.append(f'<div class="hc-score">{html.escape(str(score))} <span>{html.escape(score_label)}</span></div>')
        if d.get("sourceCount") is not None:
            conf = d.get("confidence")
            conf_html = f' · 可信度{html.escape(str(conf))}' if conf else ""
            parts.append(f'<div class="hc-meta">来源 {html.escape(str(d["sourceCount"]))}{conf_html}</div>')
        return "".join(parts)

    def _render_trend(self, d: Dict) -> str:
        if not isinstance(d, dict):
            return self._render_generic(d)
        kw = d.get("keyword") or ""
        series = d.get("series") or []
        src = d.get("source") or ""
        spark = self._sparkline(series) if series else ""
        meta = f'<div class="trace">数据来源：{html.escape(src)}</div>' if src else ""
        return f'<div class="hc-name">📈 {html.escape(kw)} 近 {html.escape(str(d.get("days") or 60))} 天趋势</div>{spark}{meta}'

    @staticmethod
    def _sparkline(series: List[Dict]) -> str:
        try:
            vals = [float(p.get("total_sales") or p.get("avg_price") or 0) for p in series if isinstance(p, dict)]
            if len(vals) < 2:
                return ""
            w, h = 360, 64
            lo, hi = min(vals), max(vals)
            rng = (hi - lo) or 1
            step = w / (len(vals) - 1)
            pts = []
            for i, v in enumerate(vals):
                x = i * step
                y = h - ((v - lo) / rng) * (h - 8) - 4
                pts.append(f"{x:.1f},{y:.1f}")
            poly = " ".join(pts)
            return (
                f'<svg class="spark" viewBox="0 0 {w} {h}" preserveAspectRatio="none" width="100%" height="{h}">'
                f'<polyline points="{poly}" fill="none" stroke="#db2777" stroke-width="2" '
                f'stroke-linejoin="round" stroke-linecap="round"/></svg>'
            )
        except Exception:
            return ""

    @staticmethod
    def _bullet_list(items: List[str], title: str) -> str:
        if not items:
            return ""
        lis = "".join(f'<div class="b-item"><span class="b-dot">•</span><span>{html.escape(str(i))}</span></div>' for i in items[:4])
        return f'<div class="b-sec"><div class="b-sec-t">{html.escape(title)}</div>{lis}</div>'

    def _render_generic(self, d: Dict) -> str:
        try:
            pretty = json.dumps(d, ensure_ascii=False, indent=2)
        except Exception:
            pretty = str(d)
        return f'<pre class="generic">{html.escape(pretty)}</pre>'

    def _error_page(self, title: str, msg: str) -> str:
        return ERROR_PAGE_TEMPLATE.replace("__CSS__", PAGE_CSS) \
            .replace("__TITLE__", html.escape(title)) \
            .replace("__MSG__", html.escape(msg)) \
            .replace("__APP_NAME__", html.escape(settings.APP_NAME))


# ── 模板（纯静态，避免 f-string 与 CSS 花括号冲突，故用 __TOKEN__ + replace 拼接）──
CARD_LABELS = {
    "opportunity": "机会方向",
    "product": "好单库 · 实时选品参考",
    "risk": "风险提示",
    "data_insight": "关键数据",
    "next_actions": "下一步行动",
    "hot_category": "热门品类",
    "trend": "趋势",
}

PAGE_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #f5f3f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1f2330; padding: 16px; }
.wrap { max-width: 480px; margin: 0 auto; }
#share-card { background: #fff; border-radius: 18px; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.10); }
.brand { background: linear-gradient(135deg, #db2777, #f06292); color: #fff; padding: 18px 20px; display: flex; align-items: center; justify-content: space-between; }
.brand-l { font-weight: 700; font-size: 16px; }
.brand-r { font-size: 12px; opacity: .9; }
.head { padding: 18px 20px 6px; }
.title { font-size: 20px; font-weight: 800; line-height: 1.35; }
.meta { font-size: 12px; color: #9aa0ad; margin-top: 6px; }
.tags { margin-top: 10px; }
.tag { display: inline-block; background: #fce7f3; color: #db2777; font-size: 12px; padding: 3px 9px; border-radius: 20px; margin: 0 6px 6px 0; }
.summary { font-size: 14px; line-height: 1.7; color: #3b3f4d; padding: 12px 20px 0; }
.card { border-top: 1px solid #f0eef3; padding: 16px 20px; }
.card-label { display: inline-block; font-size: 11px; font-weight: 700; color: #db2777; background: #fce7f3; padding: 3px 10px; border-radius: 20px; margin-bottom: 12px; }
.card-title { font-size: 17px; font-weight: 700; margin-bottom: 8px; }
.card-summary { font-size: 13px; line-height: 1.7; color: #3b3f4d; margin-bottom: 10px; }
.kvs { display: flex; flex-wrap: wrap; gap: 8px; }
.kv { width: calc(50% - 4px); background: #faf7fb; border-radius: 10px; padding: 8px 10px; }
.kv span { display: block; font-size: 11px; color: #9aa0ad; margin-bottom: 2px; }
.kv b { font-size: 14px; font-weight: 700; }
.trace { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #eee; font-size: 11px; color: #9aa0ad; }
.note { font-size: 13px; color: #9aa0ad; line-height: 1.6; }
.risk-badge { display: inline-block; background: #fee2e2; color: #dc2626; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 20px; margin-bottom: 12px; }
.b-sec { margin-bottom: 12px; }
.b-sec-t { font-size: 13px; font-weight: 700; margin-bottom: 6px; color: #1f2330; }
.b-item { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.6; margin-bottom: 5px; }
.b-dot { color: #db2777; }
.prow { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; }
.ptile { min-width: 150px; width: 150px; border: 1px solid #f0eef3; border-radius: 12px; overflow: hidden; }
.pimg { width: 100%; height: 96px; background: #f3f1f5; object-fit: cover; display: block; }
.pimg.ph { display: flex; align-items: center; justify-content: center; color: #b5b0bd; font-size: 12px; }
.pbody { padding: 10px; }
.pick { font-size: 11px; color: #b45309; background: #fffbeb; border-radius: 8px; padding: 5px 7px; margin-bottom: 6px; line-height: 1.5; }
.pbrand { font-size: 11px; color: #9aa0ad; margin-bottom: 2px; }
.ptitle { font-size: 13px; font-weight: 600; line-height: 1.4; max-height: 36px; overflow: hidden; }
.pprice { font-size: 14px; font-weight: 800; color: #db2777; margin: 6px 0; }
.chips { display: flex; gap: 6px; }
.chip { font-size: 11px; padding: 2px 7px; border-radius: 8px; }
.chip-comm { background: #fce7f3; color: #db2777; }
.chip-sales { background: #e0f2fe; color: #0369a1; }
.na-head { font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.na-sec { margin-bottom: 10px; }
.na-sec-t { font-size: 12px; font-weight: 700; color: #16a34a; margin-bottom: 5px; }
.na-item { font-size: 12px; color: #555; line-height: 1.6; }
.hc-name { font-size: 15px; font-weight: 700; }
.hc-tag { font-size: 12px; color: #9aa0ad; margin-top: 2px; }
.hc-score { font-size: 20px; font-weight: 800; color: #db2777; margin-top: 6px; }
.hc-score span { font-size: 11px; color: #9aa0ad; font-weight: 500; }
.hc-meta { font-size: 11px; color: #16a34a; margin-top: 4px; }
.spark { display: block; margin: 10px 0 4px; }
.generic { font-size: 11px; background: #faf7fb; padding: 10px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.cta { padding: 18px 20px 22px; text-align: center; border-top: 1px solid #f0eef3; }
.cta-btn { display: inline-block; background: linear-gradient(135deg, #db2777, #f06292); color: #fff; font-size: 14px; font-weight: 700; padding: 11px 22px; border-radius: 24px; text-decoration: none; }
.cta-tip { font-size: 11px; color: #b5b0bd; margin-top: 10px; }
.toolbar { max-width: 480px; margin: 14px auto 0; display: flex; gap: 10px; justify-content: center; }
.btn { background: #fff; border: 1px solid #e3dde8; color: #5b5566; font-size: 13px; font-weight: 600; padding: 9px 16px; border-radius: 20px; cursor: pointer; }
.btn:active { background: #f3eef7; }
.err { max-width: 480px; margin: 60px auto; background: #fff; border-radius: 16px; padding: 40px 24px; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
.err h1 { font-size: 20px; margin-bottom: 10px; }
.err p { color: #888; font-size: 14px; }
"""

PUBLIC_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>__TITLE__ · 美妆选品报告</title>
<meta property="og:title" content="__OG_TITLE__"/>
<meta property="og:description" content="__OG_DESC__"/>
<meta property="og:type" content="website"/>
<style>__CSS__</style>
</head>
<body>
<div class="wrap">
  <div id="share-card">
    <div class="brand">
      <div class="brand-l">💄 AI 美妆选品顾问</div>
      <div class="brand-r">__APP_NAME__</div>
    </div>
    <div class="head">
      <div class="title">__TITLE__</div>
      <div class="meta">生成于 __CREATED__</div>
      __TAGS__
    </div>
    __SUMMARY__
    __CARDS__
    <div class="cta">
      __CTA__
      <div class="cta-tip">本报告由 AI 结合好单库真实商品信号生成 · 数据可溯源</div>
    </div>
  </div>
  <div class="toolbar">
    <button class="btn" onclick="saveImage()">💾 保存为图片</button>
    <button class="btn" onclick="copyLink()">🔗 复制链接</button>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js"></script>
<script>
function saveImage() {
  var node = document.getElementById('share-card');
  if (typeof htmlToImage === 'undefined') { alert('图片组件加载失败，请联网后重试或长按截图'); return; }
  htmlToImage.toPng(node, { pixelRatio: 2, cacheBust: true, backgroundColor: '#ffffff' })
    .then(function (dataUrl) {
      var a = document.createElement('a');
      a.download = '美妆选品报告.png';
      a.href = dataUrl; a.click();
    })
    .catch(function (err) { alert('保存失败（部分商品图因跨域限制无法导出）：' + err.message + '\\n可改用「复制链接」分享，或手机长按截图。'); });
}
function copyLink() { navigator.clipboard.writeText(location.href).then(function(){ alert('链接已复制'); }).catch(function(){ alert('复制失败，请手动复制地址栏链接'); }); }
</script>
</body>
</html>
"""

ERROR_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>__TITLE__</title><style>__CSS__</style></head>
<body><div class="err"><h1>__TITLE__</h1><p>__MSG__</p></div></body>
</html>
"""


_share_service = ShareService()
