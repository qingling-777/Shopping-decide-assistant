import json
import re
from typing import Dict, List, Optional

from app.services.ai_service import ai_service


# 平台中文名（内容调性各异）
_PLATFORM_CN = {
    "xiaohongshu": "小红书",
    "douyin": "抖音",
}
_TYPE_CN = {
    "copy": "种草笔记",
    "script": "口播脚本",
    "title": "标题",
    "selling_points": "卖点卡",
}
# 各内容类型的生成指令（决定「copy」字段的形态）
_TYPE_INSTRUCTION = {
    "copy": (
        "写成一篇可直接发布的小红书种草笔记正文：用 emoji 分段、有真实测评感、"
        "第一人称口吻，自然植入商品名与价格/佣金信息，不硬广；正文里用 \\n 换行。"
    ),
    "script": (
        "写成一段可直接念的口播脚本：开头 1 句强钩子抓停留，中段讲痛点+产品解法，"
        "结尾给促单/引导下单；用 [开头钩子][痛点][产品][促单] 小标题分段，纯口语可朗读。"
    ),
    "title": (
        "给出 4 个爆款标题，每个标题一行（不要编号），含数字/情绪词/利益点，"
        "让商家直接复制就能用；不要解释。"
    ),
    "selling_points": (
        "提炼 6 条核心卖点，每条一行（不要编号），每条≤18字，适合直接做成卖点图/口播提词；"
        "基于商品真实卖点，不编虚的。"
    ),
}

_SYSTEM = (
    "你是资深美妆内容操盘手，擅长把选品情报写成能直接发的平台内容。\n"
    "要求：① 口语化、有画面感、不堆砌形容词；② 自然植入商品名/价格/佣金，不硬广；\n"
    "③ 遵守平台调性（小红书重真实测评感+分段 emoji，抖音重钩子开头+节奏）；\n"
    "④ hashtags 字段必须是独立数组（2-3 个，如 [\"#早C晚A\",\"#精华推荐\"]），即使正文已含话题也要在此字段单独给一份；\n"
    "⑤ 不要提「知识库/AI/数据来源/根据提示」等技术细节，像真人操盘手写的内容。\n"
    "⑥ 禁止营销腔套话：不要「赶紧冲/闭眼入/墙裂推荐/挖到宝了/绝绝子/谁用谁香」这类喊麦式表达；破折号（——）不要连用；"
    "开头别总套「姐妹们！」套路，按平台自然起；像真人用过才写的，有具体感受而不是全员种草。\n"
    "输出严格 JSON，不要 markdown 代码块包裹：{\"copy\": \"<正文>\", \"hashtags\": [\"#标签1\",\"#标签2\"]}"
)


class ContentService:
    async def generate_content(
        self,
        product_name: str,
        platform: str = "xiaohongshu",
        content_type: str = "copy",
        extra: Optional[Dict] = None,
    ) -> Dict:
        """生成平台适配的「能发内容」：种草文案/口播脚本/标题/卖点卡。

        返回 {platform, contentType, productName, copy, hashtags}。
        不依赖具体商品对象：product_name 必填，extra 可带 price_text/commission_ratio/sales/coupon_info/context 增强文案真实感。
        """
        platform = platform or "xiaohongshu"
        content_type = content_type or "copy"
        name = (product_name or "").strip()
        if not name:
            raise ValueError("商品名不能为空")
        platform_cn = _PLATFORM_CN.get(platform, "小红书")
        type_cn = _TYPE_CN.get(content_type, "种草笔记")
        type_instr = _TYPE_INSTRUCTION.get(content_type, _TYPE_INSTRUCTION["copy"])

        # 商品真实上下文（来自好单库字段），让文案有价/佣/销而不是空泛
        bits: List[str] = []
        ex = extra or {}
        if ex.get("price_text"):
            bits.append(f"参考价：{ex['price_text']}")
        if ex.get("commission_ratio") is not None:
            bits.append(f"佣金比例：{float(ex['commission_ratio']):.0f}%")
        if ex.get("sales") is not None:
            bits.append(f"月销：{int(ex['sales'])}")
        if ex.get("coupon_info"):
            bits.append(f"优惠：{ex['coupon_info']}")
        if ex.get("context"):
            bits.append(f"商品描述：{ex['context']}")
        ctx = "\n".join(bits)

        user_prompt = (
            f"请为以下美妆商品生成一份【{platform_cn}平台】的【{type_cn}】，直接可发布、不要任何解释文字：\n\n"
            f"商品：{name}\n{ctx}\n\n"
            f"生成要求：{type_instr}\n\n"
            "输出严格 JSON（不要 ```json 包裹）：{\"copy\": \"<正文，含必要 \\n 换行>\", \"hashtags\": [\"#标签1\", \"#标签2\"]}。"
            "注意：hashtags 必须是独立数组（2-3 个），不要只把话题写进 copy 里而让 hashtags 为空。"
        )
        messages = [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user_prompt},
        ]
        resp = await ai_service.chat(messages, temperature=0.85, max_tokens=1500)
        text = resp["choices"][0]["message"]["content"]
        data = self._parse(text)
        return {
            "platform": platform,
            "contentType": content_type,
            "productName": name,
            "copy": data.get("copy", "").strip(),
            "hashtags": data.get("hashtags", []) or [],
        }

    @staticmethod
    def _parse(text: str) -> Dict:
        """容错解析 LLM 返回的 JSON：去 ```json 包裹，失败则整段当文案。"""
        t = (text or "").strip()
        if t.startswith("```"):
            t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
            t = re.sub(r"\n?```$", "", t).strip()
        try:
            obj = json.loads(t)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
        # 兜底：整段当正文
        return {"copy": text, "hashtags": []}


content_service = ContentService()
