import asyncio
import random
import httpx
import json
import re
import math
import time
from typing import Any, Dict, List, Optional
from app.core.config import settings
from app.services.knowledge_service import knowledge_service
from app.services.search_service import search_service
from app.services.crawler_service import beauty_crawler
from app.services.union_service import union_provider, extract_search_keyword, extract_search_keyword_async, dict_hit_keyword
# 大淘客单品诊断：贴淘宝/天猫链接 -> 解析 num_iid -> 实时价/佣/销/店铺（补好单库无 num_iid 的洞）
from app.services.dataoke_service import (
    diagnose_by_link,
    get_price_trend, normalize_price_trend,
    get_similar_goods, get_ranking_list, rank_type_name, get_hot_pick_items,
    get_privilege_link, get_goods_comments, get_hot_pick_matrix,
    get_top100, search_suggestion, get_friends_circle_list,
    format_hot_words_for_ai, format_suggestions_for_ai, format_friends_circle_for_ai,
)
from app.services.opportunity_service import build_opportunity_directions_from_union
from app.services import trend_service


# 全品类（general）模式系统提示：覆盖全品类选品/带货，强调淘宝客/联盟佣金与选品方法论，
# 不绑定美妆语境。风格与美妆提示保持一致（自然、不堆标题、不提实现机制）。
_GENERAL_SYSTEM_PROMPT = (
    "你是一个通用的电商选品与带货 AI 顾问，帮助抖音、快手、小红书、视频号、淘宝等平台的"
    "商家和达人做选品决策、理解佣金与联盟带货机制。你覆盖全品类（美妆、服饰、食品、家居、数码、母婴等），"
    "不局限于某一行业。\n\n"
    "你的回答要求：\n"
    "1. 优先基于业务常识与下方可参考的知识（佣金/联盟通用玩法、选品方法论）给出判断，不要空泛。\n"
    "2. 如果现有信息不足，可以结合通用行业经验补充，但要明确保持谨慎。\n"
    "3. 回答风格自然、直接、像真人顾问，不要堆砌标题和过度格式化。\n"
    "4. 当用户问到赛道、平台、价格带、佣金、测品、风险时，尽量给出可执行建议。\n"
    "5. 不要提及你的实现方式，不要解释信息来源机制。\n"
    "6. 禁止出现：结合知识库、根据知识库、知识库的判断、基于知识库、检索结果显示、搜索结果、联网搜索。\n"
    "7. 不要用资料显示、信息表明、内容提到、上文提到这类生硬话术。\n"
    "8. 可以使用：我的判断是、更稳妥的看法是、这个方向成立但前提是、如果你现在入场我会优先看这几个点、目前看、最近。\n"
    "9. 如果有最新信息，自然融入回答，说最近、目前、这段时间。\n"
    "10. 佣金与联盟带货相关的问题（淘宝客/抖音精选联盟/快手磁力建站/知买等）：结合下方「佣金/联盟通用知识」给出清晰解释，"
    "说明佣金是怎么算的、不同平台的佣金结构差异、怎么选高佣且好转化的品、佣金与退货的关系等；用「佣金」「联盟」等自然表述，不提来源。\n"
    "11. 若下方提供了具体产品清单（含价格/佣金/销量/推广链接），优先据此给出具体、可落地的选品建议，并自然引用产品名与价格带，不要泛泛而谈；"
    "可提示这些清单只是选品参考、最终以平台实际为准。\n"
    "12. 禁止 AI 套话与机器腔：不要用「整体来看/总的来说/值得注意的是/综合而言/总而言之/本质上/换言之/毫无疑问/值得一提的是」这类开场；"
    "不要「首先…其次…最后」公式化枚举；不要出现「为您/为您推荐/您可以考虑」这类客服腔；破折号（——）不要连用或滥用。"
    "语气像真人顾问在微信里跟老板聊：简短、有判断、敢下结论、不绕弯。\n"
    "13. 若下方提供了「市场聚合信号」或「买家口碑」，请在回答里自然带 1–2 句真实数据或反馈"
    "（如某品类的价格带、平均佣金、月销规模、买家评价点），像跟老板同步情报；用「最近」「这段时间」「买家反馈」这类自然表达，"
    "严禁出现「联网搜索/根据资料显示/检索结果显示/搜索结果」等话术；聚合数据只是公开联盟商品的选品线索，非平台真实成交数据，最终以平台实际为准。\n"
    "14. 若用户点名了某个具体商品但下方[联盟商品数据]里并没有这个单品本身、只有同品类竞品，"
    "你必须在回答里明确说明「以下为该品类竞品（来自公开联盟商品库），非该单品自身数据」；不得编造该单品的规格、价格、销量、佣金等未给出的信息。\n"
)

# 受众模式（C端/B端）：决定 AI 回答的视角与话术侧重，让「同一个带货方向」给出不同侧重的答案。
# C=消费者端/个人带货（达人、内容创作者）；B=商家企业端/招商铺货（品牌方、工厂、产业带、渠道招商）。
AUDIENCE_GUIDANCE = {
    "C": (
        "\n\n[受众模式：C端 / 消费者端 — 必读]\n"
        "你现在服务的对象是中国市场的**个人带货者、内容创作者**（抖音 / 快手 / 小红书 / 视频号 / 淘宝客等）。\n"
        "回答必须站在这个视角：帮达人把货卖给终端消费者。重点交付：佣金率与佣金空间、客单价与转化、"
        "种草 / 短视频 / 图文内容打法、个人 IP 与粉丝运营、哪些品类更适合 C 端消费者下单、各平台（抖音/小红书/视频号/淘宝客）怎么玩。\n"
        "语气用「你这条内容怎么发、佣金怎么赚、粉丝为什么买」；严禁使用招商 / 供应链 / 批发 / 铺货 / 代理 / 分销 这类 B 端口径。\n"
        "若用户问的是某个带货方向，请明确从「C 端选品 + 内容种草」角度给可执行建议，并在结尾用一句点明「以上是面向个人带货（C端）的思路」。\n"
    ),
    "B": (
        "\n\n[受众模式：B端 / 商家企业端 — 必读]\n"
        "你现在服务的对象是中国市场的**品牌方、工厂、产业带商家、渠道招商方**。\n"
        "回答必须站在这个视角：帮商家把货铺出去、找渠道、做招商。重点交付：供货价与利润空间、招商政策与代理 / 分销体系、"
        "一件代发与铺货、私域与批量采购、1688 / 拼多多批发 / 产业带等渠道怎么对接、怎么谈渠道与招商。\n"
        "语气用「怎么招商、怎么铺货、供应链怎么排、渠道怎么谈、利润怎么留」；严禁使用个人种草 / 佣金玩法 / 粉丝运营 这类 C 端口径。\n"
        "若用户问的是某个带货方向，请明确从「B 端供货 + 渠道招商」角度给可执行建议，并在结尾用一句点明「以上是面向商家招商铺货（B端）的思路」。\n"
    ),
}


# Bug A 修复（实时复现「选了C端像B端」）：原 beauty 底 prompt 写死"帮助抖音/快手/小红书的
# 商家做选品决策"，27 条全是 B 端商家口径；即使尾部追加 AUDIENCE_GUIDANCE[C] 也压不过
# 底 prompt 的体量，且美妆 RAG 全是 B 端，被一起喂给 C 端，最终 AI 用 商家话术回答 C 端问题。
# 这里给 audience=C 一份独立的 beauty 底 prompt，保留同样的反 AI 套话/数据/口碑/朋友圈文案
# 规则（第 1–16 条，与 B 端同源以保体验一致），仅把"服务对象""核心交付""禁用口径"翻成
# C 端个人带货者视角，尾部不再追加 AUDIENCE_GUIDANCE[C]（避免重复）。B 端继续走旧 商家底 prompt。
_BEAUTY_C_SYSTEM_PROMPT = (
    "你是一个面向中国 C 端个人带货者（抖音/快手/小红书/视频号/淘宝客内容创作者）的美妆选品顾问。\n\n"
    "你的回答要求：\n"
    "1. 优先基于业务知识给出判断，不要空泛。\n"
    "2. 如果现有信息不足，可以结合通用行业经验补充，但要明确保持谨慎。\n"
    "3. 回答风格自然、直接、像真人顾问，不要堆砌标题和过度格式化。\n"
    "4. 当用户问到赛道、平台、价格带、内容打法、风险时，尽量给出可执行建议。\n"
    "5. 不要提及你的实现方式，不要解释信息来源机制。\n"
    "6. 禁止出现：结合知识库、根据知识库、知识库的判断、基于知识库、检索结果显示、搜索结果、联网搜索。\n"
    "7. 不要用资料显示、信息表明、内容提到、上文提到这类生硬话术。\n"
    "8. 可以使用：我的判断是、更稳妥的看法是、这个方向成立但前提是、如果你现在入场我会优先看这几个点、目前看、最近。\n"
    "9. 如果有最新信息，自然融入回答，说最近、目前、这段时间。\n"
    "10. 如果下方提供了具体产品清单（含价格/佣金/销量/推广链接），优先据此给出具体、可落地的选品建议，并自然引用产品名与价格带，不要泛泛而谈；可提示这些清单只是选品参考、最终以平台实际为准。\n"
    "11. 禁止 AI 套话与机器腔：不要用「整体来看/总的来说/值得注意的是/综合而言/总而言之/本质上/换言之/毫无疑问/值得一提的是」这类开场；不要「首先…其次…最后」公式化枚举；"
    "不要出现「为您/为您推荐/您可以考虑」这类客服腔；破折号（——）不要连用或滥用。语气像真人顾问在微信里跟达人聊：简短、有判断、敢下结论、不绕弯。\n"
    "12. 若下方提供了「美妆市场数据」（来自公开平台小红书/抖音等的讨论与测评摘要），请在回答里自然带 1–2 句最近网上的真实反馈或口碑风向"
    "（如某品类在社媒的讨论点、用户关心的点），像跟达人同步情报；用「最近」「这段时间」「网上反馈」这类自然表达，严禁出现「联网搜索/根据资料显示/检索结果显示/搜索结果」等话术。\n"
    "13. 若下方提供了标注了日期的「美妆市场数据 / 美妆市场聚合信号」，引用时可用「最近」「这段时间」自然带出时效感，"
    "但不要把聚合数据说成平台实时成交数据；聚合信号里的价格带/佣金/销量只是公开联盟商品的选品线索，最终以平台实际为准。\n"
    "14. 若下方提供了「买家口碑」（可能来自大淘客商品评论，或网上公开讨论/测评摘要），请在回答里自然带 1–2 句真实买家反馈"
    "（如某个具体好评点、吐槽点、回购点），像跟达人同步情报；用「买家反馈」「评论里」「有人提到」「网上反馈」这类自然表达，"
    "严禁出现「大淘客评论/联网搜索/根据资料显示/检索结果显示」等话术；若未提供买家口碑则不要编造买家评价或好评率。\n"
    "15. 若下方提供了「朋友圈/社群现成文案」（来自大淘客），仅在用户明确要发朋友圈/社群/小红书文案时，自然摘 1–2 句给达人；"
    "不要主动大段搬运，不要说「根据大淘客文案」这类来源话术，融入建议即可；未提供则不编造营销文案。\n"
    "16. 若用户点名了某个具体商品（如「修可芙粉底液」）但下方[联盟商品数据]里并没有这个单品本身、只有同品类竞品，"
    "你必须在回答里明确说明「以下为该品类竞品（来自好单库/大淘客），非该单品自身数据」；"
    "不得编造该单品的规格、价格、销量、佣金等未给出的信息；若引用口碑/社媒论断，统一标注「网上反馈」，不得伪造成该单品的真实评价。\n"
    "17. 你的视角是 C 端个人带货者：核心交付是「佣金率/佣金空间、客单价/转化率、适合什么内容打法（种草/测评/对比/教程）、个人 IP 怎么用、哪个平台（抖音/小红书/视频号/淘宝客）更适合、买家真实反馈与避雷点」。"
    "严禁使用招商/供应链/批发/铺货/代理/分销/一件代发/1688 批发 这类 B 端商家口径；不要谈供货价、招商政策、渠道对接、私域批量采购。"
    "若用户问的是某个带货方向，请明确从「C 端选品 + 内容种草」角度给可执行建议，并在结尾用一句点明「以上是面向个人带货（C端）的思路」。\n"
)


class AIService:
    def __init__(self):
        # 多 key 轮换池：单个 SILICONFLOW_API_KEY 与 SILICONFLOW_API_KEYS（逗号分隔）合并去重，
        # 调用时随机选 key，429 时轮换到其它 key，缓解单 key 限流。
        raw_keys = [settings.SILICONFLOW_API_KEY]
        if settings.SILICONFLOW_API_KEYS:
            raw_keys += [k for k in re.split(r"[,\s]+", settings.SILICONFLOW_API_KEYS) if k]
        self.api_keys = [k.strip() for k in raw_keys if k and k.strip() and k.strip() != "sk-your-key-here"]
        if not self.api_keys:
            self.api_keys = ["sk-your-key-here"]  # 无有效 key：保留原行为（硅基流动返回 401）
        self.api_key = self.api_keys[0]
        self.base_url = settings.SILICONFLOW_BASE_URL
        self.model = settings.SILICONFLOW_MODEL
        self.reasoning_model = settings.REASONING_MODEL
        self.enable_reasoning = settings.ENABLE_REASONING
        self.enable_search = settings.ENABLE_SEARCH
        # 模型品牌 → 具体模型 + 兜底链。reasoning=True 走推理消息构建（R1 不接 system prompt）。
        # chain 中多个模型按顺序兜底：前一个调用失败（尚未产出内容）则切下一个。
        self.MODEL_BRANDS = {
            # 默认：单一 DeepSeek-V4-Flash（非推理），便于消费统计可预期、可核对。
            # 已删去原先的 R1+V4-Flash 混合（"混合"会导致对话走 R1、卡片走 V4-Flash，模型不一致、计费难核对）。
            "auto":         {"reasoning": False, "chain": ["deepseek-ai/DeepSeek-V4-Flash"]},
            "r1":           {"reasoning": True, "chain": ["deepseek-ai/DeepSeek-R1"]},
            "deepseek":     {"reasoning": False, "chain": ["deepseek-ai/DeepSeek-V4-Flash", "deepseek-ai/DeepSeek-V3"]},
            "deepseek-pro": {"reasoning": False, "chain": ["deepseek-ai/DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V4-Flash"]},
            "qwen":         {"reasoning": False, "chain": ["Qwen/Qwen3.5-35B-A3B", "Qwen/Qwen3-32B"]},
            "glm":          {"reasoning": False, "chain": ["zai-org/GLM-5.2", "Pro/zai-org/GLM-5.1"]},
            "glm-pro":      {"reasoning": False, "chain": ["Pro/zai-org/GLM-5.1"]},
            "minimax":      {"reasoning": False, "chain": ["MiniMaxAI/MiniMax-M2.5"]},
            "kimi":         {"reasoning": False, "chain": ["Pro/moonshotai/Kimi-K2.6"]},
        }

    def _pick_key(self, exclude: set = None) -> str:
        """从 key 池随机选一个；exclude 非空且池>1 时避开已用过的 key（429 轮换用）。"""
        pool = self.api_keys
        if exclude and len(pool) > 1:
            cands = [k for k in pool if k not in exclude]
            if cands:
                return random.choice(cands)
        return random.choice(pool)

    async def chat(self, messages: List[Dict[str, str]], stream: bool = False, temperature: float = 0.7, model: str = None, max_tokens: int = 2000) -> Dict:
        payload = {"model": model or self.model, "messages": messages, "stream": stream, "temperature": temperature, "max_tokens": max_tokens}
        used: set = set()
        attempts = max(3, min(len(self.api_keys) + 1, 6))
        for attempt in range(attempts):
            key = self._pick_key(used)
            used.add(key)
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            try:
                # 2026-08-28 工程审查 P1 修复：verify 改由 settings.SSL_VERIFY 控制（默认校验，此前 verify=False
                # 使含 API Key 与全部对话内容的流量可被中间人劫持）；300s 单值超时收敛为 连接10s/读取60s，
                # 避免慢请求长期占用 worker。
                async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), verify=settings.SSL_VERIFY) as client:
                    response = await client.post(f"{self.base_url}/chat/completions", headers=headers, json=payload)
                    response.raise_for_status()
                    return response.json()
            except httpx.HTTPStatusError as e:
                code = e.response.status_code
                # 429 限流 或 上游瞬时 5xx（500/502/503/504）：退避后换 key 重试，扛过短暂抖动
                if code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                    if code == 429:
                        try:
                            ra = int(e.response.headers.get("Retry-After", "2"))
                        except (TypeError, ValueError):
                            ra = 2
                        await asyncio.sleep(min(ra, 30))
                    else:
                        await asyncio.sleep(2)
                    continue
                if code == 429:
                    raise RuntimeError("AI 服务暂时繁忙（限流），请稍后再试")
                raise RuntimeError("AI 服务暂时不可用（上游异常），请稍后重试")
            except httpx.RequestError as e:
                if attempt < attempts - 1:
                    await asyncio.sleep(2)
                    continue
                raise
        raise RuntimeError("AI 服务暂时繁忙，请稍后再试")

    async def chat_stream(self, messages: List[Dict[str, str]], temperature: float = 0.7, model: str = None, max_tokens: int = 1200, thinking_budget: int = None):
        # stream_options.include_usage=True：强制 SiliconFlow 在流式最后一个 chunk 返回 usage（prompt_tokens/completion_tokens），
        # 否则流式默认不带 usage → 计费拿到 0 token / ¥0（漏记）。这是消费统计能正确的前提。
        payload = {"model": model or self.model, "messages": messages, "stream": True, "temperature": temperature, "max_tokens": max_tokens,
                   "stream_options": {"include_usage": True}}
        if thinking_budget is not None:
            payload["thinking_budget"] = thinking_budget
        # Qwen3/3.5/3.6 系列是原生思考型模型：reasoning 不受 thinking_budget 约束，
        # 会把 max_tokens 预算吃光导致正文为空（2026-08-25 用户反馈修复）。直接关闭思考，保证回答稳定。
        if (model or self.model).startswith("Qwen/Qwen3"):
            payload["enable_thinking"] = False
        used: set = set()
        attempts = max(3, min(len(self.api_keys) + 1, 6))
        for attempt in range(attempts):
            key = self._pick_key(used)
            used.add(key)
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            try:
                # 同 168 行：SSL_VERIFY 控制证书校验；超时连接10s/读取60s（流式按帧读，读取超时按 60s 分段兜底）
                async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), verify=settings.SSL_VERIFY) as client:
                    async with client.stream("POST", f"{self.base_url}/chat/completions", headers=headers, json=payload) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if not line.startswith("data: "):
                                # 跳过 SSE 注释行（以 : 开头，如 : ping / keep-alive 心跳）与空行，
                                # 否则会复用上一条 data 导致重复 yield（回答每个字出现两次）
                                continue
                            data = line[6:]
                            if data == "[DONE]":
                                break
                            try:
                                yield json.loads(data)
                            except json.JSONDecodeError:
                                continue
                        return
            except httpx.HTTPStatusError as e:
                code = e.response.status_code
                # 429 限流 或 上游瞬时 5xx（500/502/503/504）：退避后换 key 重试，扛过短暂抖动
                if code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                    if code == 429:
                        try:
                            ra = int(e.response.headers.get("Retry-After", "2"))
                        except (TypeError, ValueError):
                            ra = 2
                        await asyncio.sleep(min(ra, 30))
                    else:
                        await asyncio.sleep(2)
                    continue
                if code == 429:
                    raise RuntimeError("AI 服务暂时繁忙（限流），请稍后再试")
                raise RuntimeError("AI 服务暂时不可用（上游异常），请稍后重试")
            except httpx.RequestError as e:
                if attempt < attempts - 1:
                    await asyncio.sleep(2)
                    continue
                raise

    def _resolve_brand(self, brand: Optional[str]):
        """把前端传来的品牌键解析为 (reasoning_flag, model_chain)。

        - 未知 / None / 空：回退到 auto（默认 = 单一 DeepSeek-V4-Flash，非推理，2026-08-25 已删 R1 混合）。
        - 已知品牌：返回其 reasoning 标志与模型链（链内按顺序兜底）。
        """
        spec = self.MODEL_BRANDS.get(brand) if brand else None
        if not spec or not spec.get("chain"):
            spec = self.MODEL_BRANDS["auto"]
        return spec["reasoning"], list(spec["chain"])

    async def _chat_stream_chain(self, messages, model_chain, temperature: float = 0.7, max_tokens: int = 1200, thinking_budget: int = None, stats: dict = None):
        """跨模型兜底流式生成：依次尝试 model_chain 里的模型，前一个调用失败（尚未产出内容）则切换下一个。

        已产出内容后中途失败不兜底（重发会重复前缀），直接抛出。
        stats: 可选字典，流式结束时把最终的 usage（prompt_tokens/completion_tokens）与实际使用的 model 写入，
        供计费埋点读取（硅基流动风格透明计费）。
        """
        last_err = None
        for model in model_chain:
            yielded = False
            try:
                async for chunk in self.chat_stream(messages, temperature=temperature, model=model, max_tokens=max_tokens, thinking_budget=thinking_budget):
                    yielded = True
                    if stats is not None and isinstance(chunk, dict) and chunk.get("usage"):
                        stats["usage"] = chunk["usage"]
                        stats["model"] = model
                    yield chunk
                return
            except Exception as e:
                last_err = e
                if yielded:
                    raise
                print(f"[MODEL] 模型 {model} 调用失败，切换兜底: {e}")
                continue
        raise last_err or RuntimeError("所有候选模型均不可用")

    async def _chat_json(self, messages: List[Dict[str, str]], temperature: float = 0.7,
                         timeout: float = 15.0, model: str = None, stats: dict = None) -> Optional[Dict]:
        """非流式 LLM 调用，带硬超时：免费档 SiliconFlow 排队时不会无限挂起。
        失败/超时返回 None，调用方自行回落到确定性数据。
        model: 显式指定模型（避免并发下 self.model 竞态）；stats: 把本次 token 用量写入 stats['card_usages'] 供计费核算。"""
        try:
            resp = await asyncio.wait_for(
                self.chat(messages, temperature=temperature, max_tokens=2000, model=model),
                timeout=timeout,
            )
            usage = resp.get("usage") if isinstance(resp, dict) else None
            if stats is not None:
                stats.setdefault("card_usages", []).append({"model": model or self.model, "usage": usage})
            raw = resp["choices"][0]["message"]["content"].strip()
            if "```" in raw:
                raw = raw.split("```")[1].lstrip("json")
            else:
                raw = re.sub(r"^```json\s*|^```\s*|\s*```$", "", raw, flags=re.MULTILINE).strip()
            return json.loads(raw)
        except Exception as e:
            print(f"[CARD] LLM JSON 调用失败/超时: {e}")
            return None

    async def _build_system_prompt(self, user_question: str, owner: str = None, link_parse_failed: bool = False, category: str = "beauty", audience: str = "C", product_hints: list = None, suppress_product_leads: bool = False) -> str:
        # 卡片类问题直接用真实联盟/知识库数据，跳过慢爬虫 + Serper 搜索，显著缩短首 token 延迟
        is_card_question = self._detect_card_type(user_question) != "none"

        # 知识库按商户隔离 + 品类过滤：仅本人自喂的动态知识 + 全局静态底库进入 prompt；
        # category 决定取哪套底库（beauty=美妆RAG，general=佣金/联盟通用知识）。owner=None 不泄露商户私有知识
        knowledge_context = knowledge_service.format_context(user_question, top_k=4, owner=owner, category=category, audience=audience)
        search_context = ""
        if not is_card_question and self._should_search(user_question):
            print(f"[SEARCH] Triggering search for: {user_question}")
            search_results = await search_service.search(user_question, max_results=3)
            if search_results:
                search_context = search_service.format_search_results(search_results)
                print(f"[SEARCH] Added {len(search_results)} search results to context")

        # 联网测评/口碑（仅美妆模式）：读本地缓存语料（快，不实时爬——实时爬由后台每日任务负责），
        # 卡片类问题【也注入】，让选品/商品推荐真正带上「最近网上的测评与口碑风向」。
        # 非卡片问题额外保底一次 freshness（通常 no-op，因每日后台已爬）。
        # general（全品类）模式不加载美妆爬虫语料——那是美妆专属 RAG 数据，与全品类无关。
        crawler_context = ""
        if category != "general":
            crawler_context = beauty_crawler.format_for_ai(keyword=user_question)
            if not is_card_question:
                await beauty_crawler.ensure_fresh()
        # 热门商品线索：优先用联盟商品数据（好单库/大淘客等，含价格/佣金/销量/链接）。
        # 关键：从自然语言问题里抽取干净选品词（"推荐个防晒霜"→"防晒"；general 模式兜底抽取产品名词），
        # 否则整句喂给好单库会返回 0 条、AI 用不上。抽不到则传空走频道浏览兜底；仍空则降级 Serper 线索。
        # suppress_product_leads=True（爆品/多榜共振意图）：实时榜已是权威商品源，压掉联盟静态样例，
        # 防止 product_candidates.json 里的陈旧商品(花西子/广州酒家…)污染正文、让 LLM 答非所问。
        search_kw = await extract_search_keyword_async(user_question, category=category)
        product_leads_context = ""
        if not suppress_product_leads:
            product_leads_context = await union_provider.format_product_leads(keyword=search_kw, category=category)
            if not product_leads_context and category != "general":
                product_leads_context = await beauty_crawler.format_product_leads(keyword=user_question)

        # 聚合市场信号：问某品类/赛道的市场面（价格带/佣金/销量/竞争）时，把聚合信号并进正文，
        # 让 AI 正文自然带真实数字——既强化登录用户正文，也补匿名用户（无卡片）拿不到真实数字的缺口。
        # compute_market_signals 走 search_products 缓存，近乎零成本。
        market_signals_context = ""
        if search_kw and self._is_market_question(user_question):
            market_signals_context = await union_provider.format_market_signals(keyword=search_kw, max_items=300, category=category)

        # 买家口碑：问某品类/商品的市场面或口碑（价格带/佣金/销量/竞争/评价）时，对双源 top 大淘客
        # 商品取样真实买家评论并进正文，让对话（含卡片问题主回答）自然带真实买家反馈。
        # 受「淘宝账号授权」门控——授权过期时恒空，AI 自然不引、不编造。compute_market_signals 已
        # 走 search_products 缓存，评论走各自缓存，近乎零增量成本（命中缓存时）。
        buyer_reviews_context = ""
        if search_kw and self._is_market_question(user_question):
            buyer_reviews_context = await union_provider.format_buyer_reviews(keyword=search_kw, max_items=6, sample=2, category=category)

        # 热搜记录：问选品方向/市场面时，把大淘客实时热搜词并进正文，让 AI 自然点出「市场正在关注」的品类。
        # 买家榜偏日用、淘客榜美妆密集，是现成的市场情报；get_top100 带 300s 缓存，零增量成本。
        hot_words_context = ""
        if self._is_market_question(user_question):
            try:
                buyer_words, taobao_words = await asyncio.gather(
                    get_top100(1), get_top100(2)
                )
                hot_words_context = format_hot_words_for_ai(buyer_words, taobao_words)
            except Exception as e:
                print(f"[DATAOKE] hot_words 注入失败(降级跳过): {e}")

        # 搜索联想词：用户问题含品类/商品词时，把大淘客联想词（用户真实搜索切片 + 库内商品数）并进正文，
        # 让 AI 自然提示用户还能从哪些细分方向切入。带 300s 缓存。
        suggestion_context = ""
        if search_kw and self._is_market_question(user_question):
            try:
                suggestions = await search_suggestion(key_words=search_kw, suggest_type=1)
                suggestion_context = format_suggestions_for_ai(suggestions, keyword=search_kw)
            except Exception as e:
                print(f"[DATAOKE] suggest 注入失败(降级跳过): {e}")

        # 朋友圈文案：问选品方向/市场面时，把大淘客现成 C 端营销文案并进正文，
        # 让 AI 在用户要「发朋友圈/社群文案」时自然摘 1–2 句给商户。带 300s 缓存。
        friends_circle_context = ""
        if self._is_market_question(user_question):
            try:
                fc_items = await get_friends_circle_list(page_id=1, page_size=20)
                friends_circle_context = format_friends_circle_for_ai(fc_items)
            except Exception as e:
                print(f"[DATAOKE] friends_circle 注入失败(降级跳过): {e}")

        # B 档趋势：用户问「热度/走向/趋势」时，把该关键词的时间序列注入 prompt，让 AI 直接解释数据
        trend_context = ""
        if self._is_trend_question(user_question):
            tk = await extract_search_keyword_async(user_question)
            if tk:
                trend_context = trend_service.format_trend_for_ai(tk, days=60)

        # 系统提示按品类模式分流：general=全品类通用顾问（含佣金/联盟知识）；beauty=美妆专业顾问（含美妆RAG）
        if category == "general":
            prompt = _GENERAL_SYSTEM_PROMPT
        elif audience == "C":
            # Bug A 修复：C 端用独立 C 端底 prompt（不再用 商家底 prompt + 尾部追加，避免底 prompt 商家体量压过 C 端指引 + 美妆 RAG 全是 B 端被一起喂给 C 端造成「选C端像B端」）
            prompt = _BEAUTY_C_SYSTEM_PROMPT
        else:
            prompt = (
            "你是一个专业的美妆选品 AI 顾问，帮助抖音、快手、小红书的商家做选品决策。\n\n"
            "你的回答要求：\n"
            "1. 优先基于业务知识给出判断，不要空泛。\n"
            "2. 如果现有信息不足，可以结合通用行业经验补充，但要明确保持谨慎。\n"
            "3. 回答风格自然、直接、像真人顾问，不要堆砌标题和过度格式化。\n"
            "4. 当用户问到赛道、平台、价格带、测品、风险时，尽量给出可执行建议。\n"
            "5. 不要提及你的实现方式，不要解释信息来源机制。\n"
            "6. 禁止出现：结合知识库、根据知识库、知识库的判断、基于知识库、检索结果显示、搜索结果、联网搜索。\n"
            "7. 不要用资料显示、信息表明、内容提到、上文提到这类生硬话术。\n"
            "8. 可以使用：我的判断是、更稳妥的看法是、这个方向成立但前提是、如果你现在入场我会优先看这几个点、目前看、最近。\n"
            "9. 如果有最新信息，自然融入回答，说最近、目前、这段时间。\n"
            "10. 如果下方提供了具体产品清单（含价格/佣金/销量/推广链接），优先据此给出具体、可落地的选品建议，并自然引用产品名与价格带，不要泛泛而谈；可提示这些清单只是选品参考、最终以平台实际为准。\n"
            "11. 禁止 AI 套话与机器腔：不要用「整体来看/总的来说/值得注意的是/综合而言/总而言之/本质上/换言之/毫无疑问/值得一提的是」这类开场；不要「首先…其次…最后」公式化枚举；"
            "不要出现「为您/为您推荐/您可以考虑」这类客服腔；破折号（——）不要连用或滥用。语气像真人顾问在微信里跟老板聊：简短、有判断、敢下结论、不绕弯。"
            "12. 若下方提供了「美妆市场数据」（来自公开平台小红书/抖音等的讨论与测评摘要），请在回答里自然带 1–2 句最近网上的真实反馈或口碑风向"
            "（如某品类在社媒的讨论点、用户关心的点），像跟老板同步情报；用「最近」「这段时间」「网上反馈」这类自然表达，严禁出现「联网搜索/根据资料显示/检索结果显示/搜索结果」等话术。"
            "13. 若下方提供了标注了日期的「美妆市场数据 / 美妆市场聚合信号」，引用时可用「最近」「这段时间」自然带出时效感，"
            "但不要把聚合数据说成平台实时成交数据；聚合信号里的价格带/佣金/销量只是公开联盟商品的选品线索，最终以平台实际为准。"
            "14. 若下方提供了「买家口碑」（可能来自大淘客商品评论，或网上公开讨论/测评摘要），请在回答里自然带 1–2 句真实买家反馈"
            "（如某个具体好评点、吐槽点、回购点），像跟老板同步情报；用「买家反馈」「评论里」「有人提到」「网上反馈」这类自然表达，"
            "严禁出现「大淘客评论/联网搜索/根据资料显示/检索结果显示」等话术；若未提供买家口碑则不要编造买家评价或好评率。"
            "15. 若下方提供了「朋友圈/社群现成文案」（来自大淘客），仅在用户明确要发朋友圈/社群/小红书文案时，自然摘 1–2 句给商户；"
            "不要主动大段搬运，不要说「根据大淘客文案」这类来源话术，融入建议即可；未提供则不编造营销文案。"
            "16. 若用户点名了某个具体商品（如「修可芙粉底液」）但下方[联盟商品数据]里并没有这个单品本身、只有同品类竞品，"
            "你必须在回答里明确说明「以下为该品类竞品（来自好单库/大淘客），非该单品自身数据」；"
            "不得编造该单品的规格、价格、销量、佣金等未给出的信息；若引用口碑/社媒论断，统一标注「网上反馈」，不得伪造成该单品的真实评价。"
        )

        # 受众模式：C 端的视角/口径/禁用词已在 _BEAUTY_C_SYSTEM_PROMPT 第 17 条内嵌，此处仅给 B 端追加商家口径指引，
        # 避免 C 端重复堆叠 + B 端漏掉口径说明（影响对话回答，不影响卡片逻辑）。
        if audience == "B":
            prompt += AUDIENCE_GUIDANCE["B"]

        # 链接未解析硬引导（仅当消息含淘宝/天猫链接但系统没拿到该商品真实数据时注入）：
        # 禁止臆测链接对应商品、禁止挪用其他品牌冒充、禁止对其做单品分析，直接引导发商品名。
        if link_parse_failed:
            prompt += (
                "\n\n[重要·链接未解析] 用户在消息里附了一个淘宝/天猫商品链接，但系统未能解析出该链接对应商品的真实数据"
                "（拿不到价格/佣金/销量）。请勿臆测该链接对应哪个商品，不要从下方[联盟商品数据]里挑其他品牌去充当「这个链接的商品」做单品分析；"
                "直接在回答里自然点一句识别到了他的商品页、但拉不到实时数据，并引导他把**商品名**发来（或发带 id= 的完整链接），"
                "我再用好单库跑一份选品诊断。若下方恰好有同品类竞品数据可参考，可明确标注「以下是同品类竞品参考，非该链接单品数据」后简要带出，"
                "但绝不可把它说成「该链接商品」本身。"
            )

        if knowledge_context:
            prompt += f"\n\n以下是本次可参考的知识库内容，请优先参考：\n{knowledge_context}"
        if crawler_context:
            prompt += f"\n{crawler_context}"
        if product_leads_context:
            prompt += f"\n{product_leads_context}"
        if market_signals_context:
            prompt += f"\n{market_signals_context}"
        if buyer_reviews_context:
            prompt += f"\n{buyer_reviews_context}"
        if hot_words_context:
            prompt += f"\n{hot_words_context}"
        if suggestion_context:
            prompt += f"\n{suggestion_context}"
        if friends_circle_context:
            prompt += f"\n{friends_circle_context}"
        if trend_context:
            prompt += (
                f"{trend_context}\n"
                "（如用户问到该品类的热度/走向，请基于上方趋势数据用自然语言解释：是上升还是下滑、"
                "拐点大概在何时、可能受什么驱动；并明确说明这是好单库聚合的选品线索趋势，非平台真实成交数据。）"
            )
        if search_context:
            prompt += f"\n{search_context}"

        # 商品候选注入（预取+注入对齐方案）：把「即将出现在商品卡里的真实在售商品」直接喂给 LLM，
        # 强制正文推荐与卡片严格一致——根治「AI 正文推荐 A、卡片显示 B」以及「正文推荐了却没有卡」。
        # product_hints=None 表示本次未走预取（不注入）；传 [] 表示已搜但好单库为空（引导不编造）；
        # 非空则要求 AI 只能在这些商品里挑。
        if product_hints is not None:
            if product_hints:
                hints_block = self._format_product_hints(product_hints)
                prompt += (
                    "\n\n[本次推荐商品候选·实时在售]\n"
                    "以下是系统已为你筛选的真实在售商品（来自联盟数据，含品牌/标题/价格/佣金/销量/推广链接）：\n"
                    f"{hints_block}\n"
                    "当你需要给出「推荐哪款 / 买什么 / 哪个好 / 值得买」类结论时，必须遵守：\n"
                    "- 必须且只能从上述列表中选取商品来推荐，逐一点名并说明适合人群与推荐理由；\n"
                    "- 严禁编造、联想或替用户脑补列表中不存在的品牌、型号或单品；\n"
                    "- 自然引用商品名、价格带与佣金，像真人顾问在微信里跟老板聊；\n"
                    "- 这些商品会同时以「商品卡」形式展示给用户，正文与卡片必须一一对应，不要另起炉灶推荐别的东西。"
                )
            else:
                prompt += (
                    "\n\n[本次推荐商品候选]\n"
                    "系统按该词未能匹配到实时在售商品（联盟数据为空）。"
                    "请勿在回答中编造具体品牌或单品，改为给出该品类的通用选购标准与避坑要点，"
                    "并自然说明「暂时没匹配到在售商品，可以换个说法再试」。"
                )
        return prompt

    def _format_product_hints(self, items: list) -> str:
        """把好单库选品集格式化为喂给 LLM 的候选清单（编号 + 关键字段）。"""
        lines = []
        for i, it in enumerate(items or [], start=1):
            if not isinstance(it, dict):
                continue
            brand = (it.get("brand") or "").strip()
            title = (it.get("title") or "").strip()
            name = f"{brand} {title}".strip() or f"商品{i}"
            parts = [name]
            price = it.get("priceText") or ""
            if price:
                parts.append(f"价格{price}")
            cr = it.get("commissionRatio")
            cm = it.get("commissionMoney")
            if cr is not None:
                parts.append(f"佣金{cr}%")
            elif cm is not None:
                parts.append(f"佣金¥{cm}")
            sales = it.get("sales")
            if sales is not None:
                parts.append(f"月销{sales}")
            link = it.get("link") or ""
            if link:
                parts.append(f"推广:{link}")
            # 多榜单共振注记：同一商品登上多个榜单，确定性更高（仅 hot_pick 卡携带该字段，其它卡忽略）
            rc = it.get("resonanceCount")
            rtabs = it.get("resonanceTabs")
            if rc and isinstance(rc, int) and rc >= 2:
                if isinstance(rtabs, list) and rtabs:
                    parts.append(f"多榜共振({rc}榜：{'/'.join(rtabs)})")
                else:
                    parts.append(f"多榜共振({rc}榜)")
            lines.append(f"{i}. {'，'.join(parts)}")
        return "\n".join(lines) if lines else "（无候选商品）"

    def _hot_pick_to_hints(self, hot_card: dict) -> list:
        """把爆品卡(hot_pick)的 items 转成 _format_product_hints 可用的候选结构。

        hot_pick 卡字段为 title/actualPrice/commissionRate/monthSales/itemLink/couponPrice，
        而 _format_product_hints 期望 brand/title/priceText/commissionRatio/commissionMoney/sales/link。
        这里做字段桥接，保证正文 LLM 能直接引用实时榜爆品（与卡片一一对应）。
        """
        hints = []
        for it in (hot_card or {}).get("items", []):
            if not isinstance(it, dict) or not (it.get("title") or "").strip():
                continue
            title = (it.get("title") or "").strip()
            hints.append({
                "brand": "",
                "title": title,
                "priceText": it.get("priceText") or (f"¥{it.get('actualPrice')}" if it.get("actualPrice") is not None else ""),
                "commissionRatio": it.get("commissionRate"),
                "sales": it.get("monthSales"),
                "link": it.get("itemLink") or "",
                # 多榜单共振：透传给 _format_product_hints 渲染「（N榜共振）」注记，正文可点名
                "resonanceCount": it.get("resonanceCount"),
                "resonanceTabs": it.get("resonanceTabs"),
            })
        return hints

    def _sanitize_reply(self, text: str) -> str:
        replacements = {
            "根据知识库的判断": "目前的判断是",
            "知识库的判断": "目前的判断",
            "基于知识库": "目前看",
            "结合知识库": "结合现有判断",
            "根据知识库": "根据现有判断",
            "知识库显示": "目前判断显示",
            "检索结果显示": "目前看",
            "从上下文看": "目前看",
            "根据提供的资料": "根据现有信息",
            "根据提供的信息": "根据现有信息",
            "参考资料显示": "目前看",
            "从资料来看": "目前看",
            "综合上述信息": "综合来看",
            "资料显示": "目前看",
            "信息表明": "目前看",
            "搜索结果显示": "目前看",
            "联网搜索": "最近了解到",
        }
        cleaned = text
        for old, new in replacements.items():
            cleaned = cleaned.replace(old, new)
        return cleaned

    # ─────────────────────────────────────────────────────────────
    # 商户链接处理（识别+引导方案）
    # 好单库无淘宝 num_iid：贴链接无法在好单库精确匹配到该商品、拉不到实时价/佣，
    # 只能识别平台 + 还原真实商品页 + 引导商户发商品名以跑好单库诊断。
    # ─────────────────────────────────────────────────────────────
    def _detect_product_link(self, text: str) -> Optional[Dict[str, str]]:
        """识别淘宝/天猫商品链接。

        返回 {platform, item_id, real_url, short}：
        - 完整商品页（带 id=数字）→ 可还原真实商品页，short=False
        - 淘系短链/淘客链（无 id）→ 识别了平台但打不开，short=True，real_url 为空
        非淘系链接或无链接 → 返回 None（走正常选品流程）。
        """
        if not text:
            return None
        # 1) 完整商品页（含 id=数字）→ 可还原真实商品页
        m = re.search(r"(?:item\.taobao\.com|detail\.tmall\.com|trade\.taobao\.com)/item\.htm[^\s]*?[?&]id=(\d+)", text)
        if m:
            item_id = m.group(1)
            platform = "tmall" if "tmall" in m.group(0).lower() else "taobao"
            real_url = (
                f"https://detail.tmall.com/item.htm?id={item_id}"
                if platform == "tmall"
                else f"https://item.taobao.com/item.htm?id={item_id}"
            )
            return {"platform": platform, "item_id": item_id, "real_url": real_url, "short": False}
        # 2) 淘系链接但无 id（短链 / 淘客链）→ 识别了平台但打不开
        if re.search(
            r"(?:s\.click\.taobao\.com|uland\.taobao\.com|m\.tb\.cn|tb\.cn|a\.m\.taobao\.com|"
            r"item\.taobao\.com|detail\.tmall\.com|tmall\.com|taobao\.com)",
            text,
        ):
            platform = "tmall" if "tmall" in text.lower() else "taobao"
            return {"platform": platform, "item_id": "", "real_url": "", "short": True}
        return None

    def _link_context_note(self, link: Dict[str, str], kw: str) -> str:
        """链接+品类/商品名、但单品诊断失败（拿不到该链接商品真实数据）时的注入提示。

        注意：本方法只在「链接已识别、但 _try_link_diagnosis 返回空（未拿到该商品真实数据）」时到达，
        因此绝不能让模型对该链接商品做单品分析、也不能用其他品牌冒充它。
        """
        platform_cn = "天猫" if link["platform"] == "tmall" else "淘宝"
        page = link["real_url"] or "（短链，无法还原真实页）"
        note = (
            f"\n\n[用户附带了一个{platform_cn}商品链接]"
            f"用户还发了一个{platform_cn}商品页链接：{page}（已自动识别平台）。"
            "系统未能解析出该链接对应商品的真实数据（好单库/大淘客都拿不到它的价格/佣金/销量），"
            "因此不要对该链接商品做任何单品分析，也不要从下方数据里挑别的品牌冒充它。"
        )
        if kw:
            note += (
                f"\n若下方[联盟商品数据]里恰好有「{kw}」同品类的真实竞品，你可明确标注"
                f"「以下是同品类竞品参考（来自好单库/大淘客），非该链接单品数据」后简要带出价格带/佣金/销量作为参考；"
                f"若没有真实数据，则直接引导用户发**商品名**或带 id= 的完整链接，再用好单库跑选品诊断。"
            )
        else:
            note += (
                "\n直接在回答开头自然点一句识别到了他的商品页、但拉不到实时数据，"
                "并引导他把**商品名**发来（或发带 id= 的完整链接），我再用好单库跑一份选品诊断。"
            )
        note += "\n不要说「无法处理这个链接」，也不要解释技术细节。"
        return note

    def _build_link_guide_text(self, link: Dict[str, str]) -> str:
        """裸链接（无品类/商品名）的本地引导文案，不调 LLM。"""
        platform_cn = "天猫" if link["platform"] == "tmall" else "淘宝"
        if link.get("short"):
            return (
                f"你发的是一个{platform_cn}商品链接（短链/淘客链），我这边直接打不开，也拿不到它的商品 id。\n\n"
                "要帮你判断「这个品值不值得做」，二选一告诉我即可：\n"
                "1）把**完整商品页链接**发来（地址栏里 item.taobao.com/item.htm?id= 或 "
                "detail.tmall.com/item.htm?id= 这种带 id 的）；\n"
                "2）或者直接说它的**品类或商品名**（如「防晒霜」「XX 精华」）。\n\n"
                "我就能用好单库跑一份选品诊断：价格带 / 佣金 / 销量 / 竞争强度 / 机会指数，"
                "告诉你同品类里这条品有没有空间。"
            )
        return (
            f"识别到你发的是一个{platform_cn}商品链接，已还原商品页：\n{link['real_url']}\n\n"
            "不过好单库（淘宝/天猫联盟数据）里没有这个商品的淘宝 id（num_iid），"
            "我**没法用链接直接拉到它的实时价格、佣金和销量做单品诊断**。\n\n"
            "想判断「这个品值不值得做、同品类竞争和价格带怎么样」，直接告诉我它的"
            "**品类或商品名**就行，比如「防晒霜」「XX 精华」这类具体词——\n"
            "我马上用（好单库）跑一份选品诊断：价格带 / 佣金 / 销量 / 竞争强度 / 机会指数，"
            "并把这条品放到同品类里看它在不在机会区。"
        )

    async def _emit_link_guide(self, link: Dict[str, str]):
        """裸链接引导：不调 LLM，本地即时返回识别结果 + 续问。"""
        yield {"type": "text", "content": self._build_link_guide_text(link)}
        yield {
            "type": "follow_up",
            "questions": [
                "这个品类竞争强吗？",
                "同品类一般佣金多少？",
                "新手适合从哪个价位带切入？",
            ],
        }

    # ─────────────────────────────────────────────────────────────
    # 大淘客单品诊断（贴链接缺口修复）：好单库无 num_iid，大淘客有 -> 实时单品数据
    # ─────────────────────────────────────────────────────────────
    async def _try_link_diagnosis(self, user_question: str) -> Optional[Dict]:
        """尝试用大淘客对贴来的链接做单品诊断。无 key/解析失败/接口异常 -> None（降级到原有引导）。"""
        try:
            product = await diagnose_by_link(user_question)
            if product and product.get("dtk_id"):
                # 富化：价格趋势 + 相似高佣替代 + 转链(变现) + 口碑(评论)，全部 best-effort
                product = await self._enrich_link_diagnosis(product)
            return product
        except Exception as e:
            print(f"[DATAOKE] 单品诊断异常（降级到引导）: {e}")
            return None

    async def _enrich_link_diagnosis(self, product: Dict) -> Dict:
        """单品诊断富化：价格趋势 + 相似高佣替代 + 榜单上榜检测 + 转链(变现) + 口碑(评论)。

        全部 best-effort：任一富接口失败（含受淘宝授权门控的转链/评论）不影响主诊断返回。
        可用富接口（price-trend/similar/ranking）当前账号已授权，立即可用；
        受门控的 privilege-link/comment 当前返回 None，后台重授权后自动生效。
        """
        dtk_id = product.get("dtk_id")
        goods_id = product.get("num_iid")

        # 可用富接口（已授权）：价格趋势 + 相似高佣替代，并行取数
        pt, sims = await asyncio.gather(
            get_price_trend(dtk_id),
            get_similar_goods(dtk_id, size=8),
        )
        product["price_trend"] = normalize_price_trend(pt) if pt else None
        if sims:
            sim_norm = [normalize_dataoke_item(s) for s in sims]
            sim_norm = [s for s in sim_norm if s]
            # 按佣金降序取前 3 作「高佣替代」建议
            sim_norm.sort(key=lambda x: (x.get("commission_ratio") or 0), reverse=True)
            product["similar"] = sim_norm[:3]

        # 榜单上榜检测（实时榜 cid=3 美妆）：命中 goodsId 则报告排名
        try:
            ranking = await get_ranking_list(rank_type=1, cid=settings.DATAOKE_CID, page_size=20)
            if ranking and goods_id:
                for it in ranking:
                    if str(it.get("goodsId")) == str(goods_id):
                        product["ranking"] = {
                            "rank_type": 1,
                            "rank_name": rank_type_name(1),
                            "rank": it.get("ranking") or it.get("num"),
                        }
                        break
        except Exception as e:
            print(f"[DATAOKE] ranking 上榜检测异常(忽略): {e}")

        # 变现/口碑（受淘宝授权门控，当前降级 None，授权恢复后自动生效）
        product["privilege_link"] = await get_privilege_link(goods_id)
        product["comments"] = await get_goods_comments(dtk_id=dtk_id)
        return product

    def _format_link_diagnosis(self, product: Dict) -> str:
        """把大淘客归一化单品数据格式化为可直接回复的诊断文案，带 SeaClaw 式「逐条溯源 + 不编造」。"""
        p = product
        shop_cn = p.get("shop_type") or ""
        platform_cn = ("天猫" if shop_cn == "天猫" else "淘宝") if shop_cn else "淘宝/天猫"
        lines = [f"识别到你发的{platform_cn}商品，已用大淘客拉到它的实时选品数据：", ""]
        if p.get("context"):
            lines.append(f"商品：{p['context']}")
        if p.get("shop"):
            lines.append(f"店铺：{p['shop']}（{shop_cn or '淘宝/天猫'}）")
        if p.get("price_text"):
            lines.append(f"价格：{p['price_text']}")
        if p.get("coupon_info"):
            lines.append(f"优惠券：{p['coupon_info']}")
        if p.get("commission_ratio") is not None:
            cm = f" ≈¥{p['commission_money']:.2f}" if p.get("commission_money") is not None else ""
            lines.append(f"佣金：{p['commission_ratio']:.0f}%{cm}")
        else:
            lines.append("佣金：大淘客未返回（以实际转链为准）")
        if p.get("sales") is not None:
            lines.append(f"月销：{int(p['sales'])}")
        else:
            lines.append("月销：大淘客未返回")

        # 简单判读（确定性规则，非 LLM 编造）
        read = []
        if p.get("commission_ratio") is not None:
            r = p["commission_ratio"]
            read.append("佣金" + ("偏高（≥20%，适合佣金驱动型内容）" if r >= 20 else ("中等（10–20%）" if r >= 10 else "偏低（<10%，更靠走量）")))
        if p.get("sales") is not None:
            s = p["sales"]
            read.append("销量" + ("已是爆品（月销>1万，入场竞争会非常激烈）" if s > 10000 else ("中等热度（1000–1万）" if s >= 1000 else "偏冷启动（<1000，有空间但需先种草）")))
        if read:
            lines.append("")
            lines.append("快速判断：" + "；".join(read) + "。")

        # 富化①：历史券后价趋势
        pt = p.get("price_trend")
        if pt and pt.get("sample_count"):
            bits = []
            if pt.get("min") is not None:
                bits.append(f"最低¥{pt['min']:.0f}")
            if pt.get("current") is not None:
                bits.append(f"当前¥{pt['current']:.0f}")
            if pt.get("max") is not None:
                bits.append(f"最高¥{pt['max']:.0f}")
            trend = f"历史券后价（近 {pt['sample_count']} 次采样）：" + " / ".join(bits)
            if pt.get("avg") is not None:
                trend += f"（均价¥{pt['avg']:.0f}）"
            lines.append("")
            lines.append(trend + "。")

        # 富化②：相似品 / 高佣替代
        sims = p.get("similar") or []
        if sims:
            lines.append("")
            lines.append("相似品 / 高佣替代（大淘客）：")
            for i, s in enumerate(sims[:3], 1):
                bits = [s.get("context") or ""]
                if s.get("price_text"):
                    bits.append(s["price_text"])
                if s.get("commission_ratio") is not None:
                    bits.append(f"佣{s['commission_ratio']:.0f}%")
                if s.get("sales") is not None:
                    bits.append(f"月销{int(s['sales'])}")
                lines.append(f"{i}. {'｜'.join([b for b in bits if b])}")

        # 富化③：榜单上榜
        rk = p.get("ranking")
        if rk:
            lines.append("")
            lines.append(f"上榜情况：已进入美妆「{rk.get('rank_name')}」第 {rk.get('rank')} 名，属于当前流量红利品类。")

        # 富化④：可分发转链（变现入口）
        pl = p.get("privilege_link")
        if pl:
            link = (pl.get("shortUrl") or pl.get("couponClickUrl")
                    or pl.get("itemUrl") or pl.get("url") or pl.get("tpwd"))
            if link:
                lines.append("")
                lines.append(f"可分发转链（带推广位，粉丝通过它下单即产生佣金）：{link}")
        else:
            lines.append("")
            lines.append("可分发转链：当前大淘客淘宝授权已过期，转链暂不可用；"
                         "后台重授权后自动开通——这是 C 端佣金变现入口。")

        # 富化⑤：口碑（评论，受授权门控；有数据才展示）
        comments = p.get("comments") or []
        if comments:
            lines.append("")
            lines.append("买家口碑（大淘客评论，取样前 2 条）：")
            for i, c in enumerate(comments[:2], 1):
                txt = (c.get("content") or c.get("text") or "").strip()
                rate = c.get("star") or c.get("score") or c.get("rate")
                if txt:
                    lines.append(f"{i}. {txt}" + (f"（{rate}星）" if rate else ""))

        lines.append("")
        lines.append("（以上为【大淘客】实时联盟数据，价/佣/销/店铺/趋势逐条来自接口返回、非估算；"
                     "最终以淘宝/天猫实际页面为准。）")
        return "\n".join(lines)

    def _link_diagnosis_followups(self) -> List[str]:
        return [
            "这条品同品类竞争强吗？",
            "价格还在降吗？现在是不是好进场点？",
            "有能直接发出去的分发链接吗？",
        ]

    def _quick_verdict(self, p: Dict) -> List[str]:
        """确定性快速判断（非 LLM 编造）：佣金 + 销量两维。"""
        read = []
        if p.get("commission_ratio") is not None:
            r = p["commission_ratio"]
            read.append("佣金" + ("偏高（≥20%，适合佣金驱动型内容）" if r >= 20
                       else ("中等（10–20%）" if r >= 10 else "偏低（<10%，更靠走量）")))
        if p.get("sales") is not None:
            s = int(p["sales"])
            read.append("销量" + ("已是爆品（月销>1万，入场竞争会非常激烈）" if s > 10000
                       else ("中等热度（1000–1万）" if s >= 1000 else "偏冷启动（<1000，有空间但需先种草）")))
        return read

    def _build_link_diagnosis_card(self, product: Dict) -> Dict:
        """单品诊断结构化卡数据：供前端 LinkDiagnosisCard 渲染（图/价佣销/趋势/相似替代/转链）。"""
        p = product
        shop_cn = p.get("shop_type") or ""
        platform_cn = ("天猫" if shop_cn == "天猫" else "淘宝") if shop_cn else "淘宝/天猫"
        similar = []
        for s in (p.get("similar") or [])[:3]:
            if not s:
                continue
            similar.append({
                "id": s.get("dtk_id") or s.get("num_iid") or "",
                "title": (s.get("context") or "")[:60],
                "priceText": s.get("price_text") or "",
                "commissionRatio": s.get("commission_ratio"),
                "sales": s.get("sales"),
                "link": s.get("link") or "",
            })
        comments = []
        for c in (p.get("comments") or [])[:2]:
            txt = (c.get("content") or c.get("text") or "").strip()
            if txt:
                comments.append({
                    "content": txt,
                    "rate": c.get("star") or c.get("score") or c.get("rate"),
                })
        return {
            "title": (p.get("context") or "")[:80],
            "image": p.get("image") or "",
            "platform": platform_cn,
            "shopType": shop_cn,
            "shop": p.get("shop") or "",
            "priceText": p.get("price_text") or "",
            "couponInfo": p.get("coupon_info") or "",
            "commissionRatio": p.get("commission_ratio"),
            "commissionMoney": p.get("commission_money"),
            "sales": p.get("sales"),
            "goodsId": p.get("num_iid"),            # 前端按需懒加载转链用
            "quickVerdict": self._quick_verdict(p),
            "priceTrend": p.get("price_trend"),     # 含 points 时间序列，前端画 sparkline
            "similar": similar,
            "ranking": p.get("ranking"),
            "privilegeAvailable": bool(p.get("privilege_link")),
            "comments": comments,
            "source": "大淘客实时联盟数据",
        }

    def _link_diagnosis_result(self, product: Dict) -> Dict:
        """非流式：贴链接单品诊断的统一返回结构。"""
        return {
            "success": True,
            "message": self._format_link_diagnosis(product),
            "card_type": "link_diagnosis",
            "card_data": self._build_link_diagnosis_card(product),
            "product": product,
            "follow_up": self._link_diagnosis_followups(),
        }

    async def _yield_link_diagnosis(self, product: Dict):
        """流式：逐块产出单品诊断文本 + 结构化卡 + 续问。"""
        yield {"type": "text", "content": self._format_link_diagnosis(product)}
        yield {"type": "card", "card_type": "link_diagnosis",
               "card_data": self._build_link_diagnosis_card(product)}
        yield {"type": "follow_up", "questions": self._link_diagnosis_followups()}

    # ─────────────────────────────────────────────────────────────
    # 单品深度诊断（P0：商户按商品名深入看某条品值不值得做）
    # 真实数据：好单库 compute_market_signals（价/佣/销/竞争）+ 知识库风险；LLM 补叙述。
    # 无固定 num_iid：以「商品名/品类词」下钻同品类联盟数据，给出该品的定位判断。
    # ─────────────────────────────────────────────────────────────
    async def diagnose_product(self, product_name: str, platform: str = "all") -> Dict:
        """按商品名做单品深度诊断：真实市场信号 + 知识库风险 + LLM 叙述，返回整合深诊 JSON。

        返回 {productName, keyword, signals, competitors, summary, opportunityScore,
              competition, risk, contentAngles, nextSteps, _usage?}。无好单库 key 时 signals/competitors 为空，
        仍由 LLM 基于商品名给出定性判断（优雅降级）。
        _usage 供 /diagnose 路由按 token 计费并落 billing_events；降级解析失败也保留真实 LLM 用量。
        """
        kw = extract_search_keyword(product_name) or (product_name or "").strip()
        # 真实市场信号（好单库聚合，含价格带/均价佣金/总销量/品牌数）
        signals = await union_provider.compute_market_signals(keyword=kw, max_items=300)
        # 同品类在售竞品明细（前 6，作为诊断里的「竞争参照」）
        leads = await union_provider.search_products(keyword=kw, max_items=6)
        competitors = [
            {
                "brand": l.get("brand") or "",
                "title": (l.get("context") or "")[:60],
                "price_text": l.get("price_text") or "",
                "commission_ratio": l.get("commission_ratio"),
                "sales": l.get("sales"),
                "link": l.get("link") or "",
            }
            for l in leads
        ]
        # 知识库风险（按商品名/品类检索）
        risk_ctx = knowledge_service.format_context(product_name, top_k=3)

        signals_text = json.dumps(signals, ensure_ascii=False) if signals else "（暂无联盟实时数据，以下为定性判断）"
        comp_text = ""
        if competitors:
            comp_lines = []
            for c in competitors:
                bits = [x for x in [c["brand"], c["price_text"],
                                    (f"佣{c['commission_ratio']:.0f}%" if c["commission_ratio"] is not None else ""),
                                    (f"月销{int(c['sales'])}" if c["sales"] is not None else "")] if x]
                comp_lines.append(f"- {c['title']}｜{'｜'.join(bits)}")
            comp_text = "\n[同品类在售竞品（联盟）]\n" + "\n".join(comp_lines)

        user_prompt = (
            f"请基于下方真实数据，对美妆商品「{product_name}」做一份单品深度诊断，判断它值不值得做。"
            "输出严格 JSON（不要 markdown 代码块包裹），含以下字段：\n"
            "{\n"
            '  "summary": "一句话结论（这品当前值不值得做、适合什么打法）",\n'
            '  "opportunityScore": 0-100的整数（综合机会指数，数据不足时给保守保守估值并说明），\n'
            '  "competition": "竞争强度与格局（品牌集中度/价格内卷/是否还有差异空间）",\n'
            '  "risk": "主要风险与坑（品退/合规/季节性/供应链等）",\n'
            '  "contentAngles": ["内容切入角度1", "角度2", "角度3"],\n'
            '  "nextSteps": ["落地步骤1", "步骤2", "步骤3"]\n'
            "}\n\n"
            f"[真实市场信号（联盟聚合，价/佣/销/品牌数）]\n{signals_text}\n{comp_text}\n"
            + (f"\n[知识库风险提示]\n{risk_ctx}\n" if risk_ctx else "")
            + "\n注意：机会指数要结合真实信号给，不要虚高；若信号缺失明确说明是定性判断。"
        )
        system_prompt = (
            "你是专业的美妆选品诊断顾问，帮助抖音/快手/小红书商家判断单条商品值不值得做。"
            "基于真实市场信号（价格带/佣金/销量/品牌竞争）做判断，并自然融入知识库风险提示。"
            "风格直接、可执行，像真人顾问；不要提「知识库/AI/数据来源」等技术细节。"
            "禁止 AI 套话：不要「整体来看/值得注意的是/综合而言/首先其次最后」公式化枚举；破折号（——）不要滥用；"
            "summary/risk/competition 用口语、敢下结论、像真人顾问当面口述，不是写报告。"
            "输出严格 JSON。"
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        resp = await self.chat(messages, temperature=0.5, max_tokens=1500)
        text = resp["choices"][0]["message"]["content"]
        usage = resp.get("usage") or {}
        data = self._parse_diagnose(text)

        # opportunityScore 夹紧到 0-100 整数
        try:
            score = int(round(float(data.get("opportunityScore", 0))))
            score = max(0, min(100, score))
        except (TypeError, ValueError):
            score = 0
        return {
            "productName": product_name,
            "keyword": kw,
            "platform": platform,
            "signals": signals,
            "competitors": competitors,
            "summary": data.get("summary", ""),
            "opportunityScore": score,
            "competition": data.get("competition", ""),
            "risk": data.get("risk", ""),
            "contentAngles": data.get("contentAngles", []) or [],
            "nextSteps": data.get("nextSteps", []) or [],
            "_usage": {
                "model": resp.get("model") or self.model or "unknown",
                "tokens_in": int(usage.get("prompt_tokens") or 0),
                "tokens_out": int(usage.get("completion_tokens") or 0),
                "tokens_cached": int(usage.get("prompt_cache_hit_tokens") or 0),
            },
        }

    @staticmethod
    def _parse_diagnose(text: str) -> Dict:
        """容错解析深诊 JSON：去 ```json 包裹，失败返回空 dict（上层给保守默认值）。"""
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
        return {}

    # ─────────────────────────────────────────
    # 上下文压缩 / 出卡决策 / 续问（成本控制相关）
    # ─────────────────────────────────────────

    def _window_history(self, history: List[Dict], keep_last: int = 12) -> List[Dict]:
        """滑动窗口：只保留最近若干轮，但始终保留首条（推理模式下首条 user 消息可能挂着 sys_prompt）。
        避免多轮后 prompt = N×sys_prompt + 全量历史 的 token 膨胀。"""
        if not history:
            return []
        msgs = [h if isinstance(h, dict) else (h.model_dump() if hasattr(h, "model_dump") else h) for h in history]
        if len(msgs) <= keep_last:
            return msgs
        # 首条（可能含 sys_prompt）+ 最近 keep_last-1 条
        return [msgs[0]] + msgs[-(keep_last - 1):]

    def _build_reasoning_messages(self, user_question: str, history: List[Dict], sys_prompt: str) -> List[Dict]:
        """推理模型(R1)不支持 system prompt：把 sys_prompt 仅拼进【最旧一条保留的 user 消息】，
        而非每一轮都拼（否则多轮后 sys_prompt 重复 N 次）。新 user 消息保持纯净。"""
        hist = self._window_history(history, keep_last=12)
        new_user = {"role": "user", "content": user_question}
        if not hist:
            return [{"role": "user", "content": f"{sys_prompt}\n\n{user_question}"}]
        first = dict(hist[0])
        if first.get("role") == "user":
            first["content"] = f"{sys_prompt}\n\n{first['content']}"
        else:
            # 历史首条异常（非 user）→ 在头部补一条挂 sys_prompt 的 user 消息
            return [{"role": "user", "content": f"{sys_prompt}\n\n{user_question}"}] + list(hist[1:])
        return [first] + list(hist[1:]) + [new_user]

    def _build_normal_messages(self, user_question: str, history: List[Dict], sys_prompt: str) -> List[Dict]:
        """非推理模式：sys_prompt 作 system 消息（仅一次）+ 窗口化 history + 新 user 消息。"""
        hist = self._window_history(history, keep_last=12)
        return [{"role": "system", "content": sys_prompt}] + hist + [{"role": "user", "content": user_question}]

    # 2026-08-26：hot_category 已改为真实数据驱动（build_opportunity_directions_from_union，全品类方向
    # 如婴童洗护/玩具/图书），不再硬编码美妆语境 → general 模式不再抑制，热品类卡全品类可出。
    _BEAUTY_FLAVORED_CARDS: set = set()

    # 指代/承接词：这些产品/这几件/这些/它们/上文/刚才/里面/从收入看/哪个最值得/最值得推广 等
    # 2026-08-27 扩充「爆品/这款/详细情况/分析一下」类指向明确单卡商品的承接词，让
    # 「帮我分析一下这个爆品的详细情况」这类追问也续用上文爆品卡明细（否则会重新拉实时榜）。
    _REFERENTIAL_MARKERS: tuple = (
        "这些产品", "这些商品", "这几件", "这些里面", "这些里", "它们", "上文", "刚才",
        "刚才那", "上一轮", "你推荐的", "你给的", "你上面", "从收入", "收入看", "最值得推广",
        "哪个最值得", "哪些最值得", "最值得", "哪个佣金", "哪件佣金", "这里面", "这几款",
        "这些款", "这一批", "这批", "上一条", "刚才推荐", "你说的这些",
        # 面向单卡/单商品的承接（扩到 2026-08-27 用户「这个爆品/这款/详细情况」场景）
        "这个爆品", "这款产品", "这款", "这件", "这个商品", "那个爆品", "刚才那批",
        "分析一下这个", "详细情况", "详细分析", "分析这个", "这个的",
    )

    def _referential_followup(self, user_question: str, history: list = None) -> Optional[Dict]:
        """判断本次提问是否是对「刚给出的商品集卡(爆品/商品卡)」的指代承接追问。

        是 → 返回「仅正文、不出卡」的 plan（primary/effective_primary=none、product/trend=False），
        但带上文商品明细(_prior_items)，让正文 prompt 仍基于这批商品做对话推理（供 _product_hints 复用），
        卡片侧因 primary=none 不会下发——用户 2026-08-27 决策：承接追问只走对话，别再补卡；
        否 → 返回 None，让 _plan_cards 走正常关键词检测（独立的咨询问题照常出对应卡）。

        ⚠️ 根源：用户对刚出的爆品卡追问「这些产品哪个最值得」「帮我分析一下这个爆品的详细情况」时，
        指代词指向的是上文那批真实商品，而非新方向。若按孤立关键词重新 detect 会错配成空卡/「美妆选品方向」；
        且承接时商品就是刚才展示的那批，无需再出卡（出卡反而刷屏）。故命中承接一律纯对话 + 复用上文商品喂正文。"""
        q = (user_question or "").strip()
        if not q or not history:
            return None
        # 必须含指代/承接词（否则是独立新问题，正常 detect）
        if not any(m in q for m in self._REFERENTIAL_MARKERS):
            return None
        # 向前找最近一条 assistant 消息里的「上一轮我给出的...卡」数据标记
        prior = self._last_card_in_history(history)
        if prior is None:
            return None
        prior_type, prior_items, prior_label = prior
        # 只对「商品集类」卡续用：指代「这些产品/这几件」必须指向上文真实可点的商品集合
        # （爆品卡/实时选品商品卡）。若上文是结论卡(机会/数据/方向/风险/趋势)，用户说的
        # 「这些产品」无实物可指——交还正常关键词检测(可能问的是新方向)，避免误承接。
        if prior_type not in ("hot_pick", "product"):
            return None
        if not prior_items:
            return None
        # 承接追问：卡片全部停发(primary/effective=none)，仅保留正文+复用商品喂 prompt
        plan: Dict[str, object] = {
            "primary": "none",
            "effective_primary": "none",
            "product": False,
            "trend": False,
            # 携带上文商品明细：正文 prompt 据此继续分析同一批商品(不与 LLM 正文脱节)
            "_prior_items": prior_items,
            "_prior_label": prior_label,
            "_referential": True,
        }
        return plan

    def _last_card_in_history(self, history: list) -> Optional[tuple]:
        """从 history 里向前找最近一条 assistant 消息的「上一轮我给出的...卡」标记。

        返回 (card_type, items, label) 或 None。items 是卡片里的商品明细列表（供复用）。
        标记文本由前端 cardToContextSummary 注入，形如：
          【上一轮我给出的爆品卡数据】\n  1. 标题:..，券后:..，佣金:..，月销:..，卖点:..
          【上一轮我给出的实时选品商品卡数据】\n  1. 标题:..，价:..，佣金:..，销量:..
          【上一轮我给出的机会评估卡】品类:..，机会指数:..
        card_type 按标记推断：爆品卡→hot_pick；实时选品商品卡→product；市场数据卡→data_insight；
        机会评估卡→opportunity；方向卡→product_direction；风险卡→risk；趋势卡→trend。"""
        if not history:
            return None
        # history 传入形态：路由层 request.history 是 list[ChatMessage]（pydantic 模型，非 dict）。
        # 统一归一化：ChatMessage 有 role/content 属性；普通 dict 直接 .get。
        def _norm(m):
            if isinstance(m, dict):
                return m
            # pydantic BaseModel：读属性
            try:
                extra = {}
                if hasattr(m, "model_dump"):
                    try:
                        extra = m.model_dump(exclude={"role", "content"})
                    except Exception:
                        extra = {}
                return {"role": m.role, "content": m.content or "", **extra}
            except Exception:
                return None
        # 前端 cardToContextSummary 注入的完整标记（须与 mobile/src/screens/HomeScreen.tsx 完全一致）：
        label_to_type = {
            "爆品卡数据": "hot_pick",
            "实时选品商品卡数据": "product",
            "市场数据卡": "data_insight",
            "机会评估卡": "opportunity",
            "方向卡": "product_direction",
            "风险卡": "risk",
            "趋势卡": "trend",
        }
        for m in reversed(history):
            _m = _norm(m)
            if not _m:
                continue
            if _m.get("role") != "assistant":
                continue
            content = _m.get("content") or ""
            for marker, ctype in label_to_type.items():
                if f"【上一轮我给出的{marker}】" in content:
                    # 解析商品明细行（「1. 标题:..，券后:..」），供卡片生成器复用
                    items = self._parse_card_items(content, ctype)
                    return (ctype, items, marker)
        return None

    @staticmethod
    def _parse_card_items(content: str, card_type: str) -> list:
        """从「上一轮我给出的...卡」注入文本里拆出商品明细（用于复用同一批商品）。

        行形如「  1. 标题:xxx，券后:¥19.90，佣金:45.0%，月销:90000，卖点:xxx」。
        按「，」切 key:value 对。返回 list[dict]，成功解析出标题才算一条。"""
        import re as _re
        items = []
        for raw in content.split("\n"):
            line = raw.strip()
            # 只挑「1. 标题:..」这种商品明细行（数字序号开头）
            m = _re.match(r"^\d+\.\s+(.+)$", line)
            if not m:
                continue
            body = m.group(1)
            if "标题:" not in body:
                continue
            fields: Dict[str, str] = {}
            for seg in body.replace("”，", "，").split("，"):
                seg = seg.strip()
                if "：" in seg:
                    k, v = seg.split("：", 1)
                    fields[k.strip()] = v.strip()
                elif ":" in seg:
                    k, v = seg.split(":", 1)
                    fields[k.strip()] = v.strip()
            if not fields.get("标题"):
                continue
            item: Dict[str, object] = {"title": fields.get("标题")}
            # 各卡型字段映射（尽力而为；无用字段留空即可）
            if card_type in ("hot_pick", "product"):
                if fields.get("券后"): item["priceText"] = fields["券后"].lstrip("¥")
                if fields.get("佣金"):
                    item["commissionText"] = fields["佣金"]
                    raw_c = fields["佣金"].replace("%", "")
                    try: item["commissionRate"] = float(raw_c)
                    except ValueError: pass
                if fields.get("月销"):
                    raw_s = fields["月销"].replace(",", "")
                    try: item["monthSales"] = float(raw_s)
                    except ValueError: pass
                if fields.get("卖点"): item["sellPoint"] = fields["卖点"]
                if fields.get("销量"):
                    raw_s = fields["销量"].replace(",", "")
                    try: item["sales"] = float(raw_s)
                    except ValueError: pass
            if card_type == "opportunity":
                if fields.get("机会指数"):
                    try: item["opportunityScore"] = float(fields["机会指数"].replace("分", ""))
                    except ValueError: pass
                if fields.get("竞争"): item["competitionLevel"] = fields["竞争"]
                if fields.get("品类"): item["title"] = fields["品类"]
                if fields.get("判断"): item["summary"] = fields["判断"]
            items.append(item)
        return items

    async def _plan_cards(self, user_question: str, category: str = "beauty", history: list = None) -> Dict[str, object]:
        """统一的出卡决策（流式/非流式共用，消除重复分支）：
        返回 primary(检测到的主卡型)、effective_primary(primary 缺失时的兜底)、product/trend 是否附带。

        category=="general" 时：仅抑制 hot_category 卡（其内部提示仍硬编码美妆语境，由 product_direction 承接）；
        opportunity/data_insight/risk/product_direction/action_advice 等与品类无关或已通用化的卡型正常出，
        并保留由真实联盟数据驱动、与品类无关的产品对比卡(product)与趋势卡(trend)。
        —— 2026-08-27 修复「这些产品」追问错配：用户接上一条商品集卡(爆品/商品卡)追问「这些产品哪个最值得//
        从收入看/这几件里佣金最高」时，问题用指代词指向刚才的卡片，_detect_card_type 按孤立关键词会重新
        detect 成 opportunity(空卡)/data_insight(空卡)/或回退到硬编码「美妆选品方向」，与 LLM 正文(读 history
        里的卡片数据推理)完全错配。此处加指代探测：命中指代 + history 最近一条 AI 消息含「上一轮我给出的...
        卡」标记 → 续用上文卡型 + 复用其商品明细。"""
        # 专有指令（卡片内按钮下发，2026-08-26）：「看实时选品商品」= 只要商品卡，
        # 不再重复触发机会/数据等主卡，避免「点按钮又出一张一样的卡」的体验问题。
        if "实时选品商品" in (user_question or "") or (user_question or "").startswith("!products:"):
            return {"primary": "none", "effective_primary": "none", "product": True, "trend": False}
        # 指代追问：问题里含指代词/承接词 + 上文有商品集卡 → 续用上文卡型，避免重新 detect 成空卡/错配
        refer = self._referential_followup(user_question, history)
        if refer is not None:
            print(f"[CARD] 指代追问命中的承接 plan: primary={refer['primary']} prior_items={len(refer.get('_prior_items') or [])}")
            return refer
        raw_primary = self._detect_card_type(user_question)
        kw = await self._resolve_direction_keyword(user_question, history, category)
        # 产品对比卡：有可识别的品类/方向意图（含从历史回退）就附，确保「推荐这个方向的商品」类追问也能出卡
        # 爆品卡（hot_pick）本身就是具体商品集合，不再附加对比商品卡，避免重复出卡；
        # 且爆品卡的数据源是「实时榜」，与 extract_search_keyword 抽出的词（可能含「今天/爆款」等非品类残词）
        # 无关——若让 product=True 去预取垃圾词，好单库搜空会回填 [] 进文字 prompt，把「帮用户问爆品」
        # 引导成「暂时没匹配到在售商品」，造成「卡片有货、正文说没货」的矛盾。故 hot_pick 一律强制 product=False。
        product = (raw_primary != "none" and raw_primary != "hot_pick") or (bool(kw) and raw_primary != "hot_pick")
        primary = raw_primary
        if category == "general" and primary in self._BEAUTY_FLAVORED_CARDS:
            primary = "none"
        # Bug B 修复（可用性测试 P1#3）：未命中具体卡型时，先看行动词（→next_actions），
        # 再看市场面词（→data_insight 兜底）——确保自然问法"好不好卖/还能做吗/值不值得做/市场怎么样"
        # 也能出卡，而不是只给纯文本。data_insight 生成器无真实数据时也会返回低置信度兜底字典，保证卡片一定下发。
        if primary != "none":
            effective = primary
        elif self._need_action_card(user_question):
            effective = "next_actions"
        elif self._is_market_question(user_question):
            effective = "data_insight"
        else:
            effective = "none"
        return {
            "primary": primary,
            "effective_primary": effective,
            "product": product,
            "trend": self._is_trend_question(user_question),
        }

    def _deterministic_followups(self, user_question: str, card_type: str) -> list:
        """基于问题类型确定性生成 3 个续问 —— 零额外 LLM 调用，省成本（替代每轮一次的独立 follow_up 模型调用）。"""
        q = (user_question or "").strip()
        kw = extract_search_keyword(q) if q else ""
        kw = kw or "这个方向"
        pools = {
            "hot_pick": [
                "这几件里佣金最高的是哪个？",
                "帮我分析一下这个爆品的详细情况",
                "还有没有其他品类今天也好卖？",
            ],
            "opportunity": [
                f"{kw}的佣金空间具体怎么算？",
                "同类目里竞争更小的细分方向有哪些？",
                "新手入场最低预算大概多少？",
            ],
            "risk": [
                "这个风险有没有具体的规避打法？",
                "哪些品类当前最容易踩坑？",
                "怎么判断一个品是不是已经红海？",
            ],
            "data_insight": [
                "这个价格带里哪个价位段最好卖？",
                "月销和佣金怎么平衡来选品？",
                "数据口径和竞品怎么对齐？",
            ],
            "trend": [
                "这个趋势还能持续多久？",
                "哪些平台这个赛道起量最快？",
                "现在入场还来得及吗？",
            ],
            "hot_category": [
                "这些品类里哪个最适合新手？",
                "选一个方向帮我做详细分析",
                "哪个品类佣金最高？",
            ],
            "next_actions": [
                "第一步我具体该怎么落地？",
                "测品阶段要准备多少预算？",
                "怎么快速验证这个方向能不能跑？",
            ],
            "product": [
                "这款和同价位竞品比强在哪？",
                "怎么把它做成能跑的内容？",
                "适合什么人群去推？",
            ],
            "link_diagnosis": [
                "这款的券后价历史低点是多少？",
                "怎么生成能赚佣的转发链接？",
                "同类目里有没有更高佣的替代品？",
            ],
            "product_direction": [
                f"{kw}适合什么目标人群？",
                "这个方向价格带怎么定最稳？",
                "用哪个平台起量最快？",
            ],
            "action_advice": [
                "第一步具体怎么落地？",
                "测品阶段要准备多少预算？",
                "怎么判断这个方向跑不跑得通？",
            ],
        }
        return pools.get(card_type) or [
            f"帮我推荐{kw}的实时选品商品",
            f"{kw}的风险有哪些？",
            "新手入场最低预算多少？",
        ]

    async def analyze_beauty_opportunity(self, user_question: str, history: List[Dict] = None, emit_cards: bool = True, owner: str = None, category: str = "beauty", audience: str = "C", model: Optional[str] = None, stats: dict = None) -> Dict:
        print(f"[DEBUG] Non-stream API called for: {user_question[:50]}... (category={category})")
        # ── 商户链接处理：识别淘宝/天猫链接 → 大淘客单品诊断（有 key 且可解析则直接诊断，否则降级引导）──
        link = self._detect_product_link(user_question)
        link_parse_failed = False
        if link:
            product = await self._try_link_diagnosis(user_question)
            if product:
                return self._link_diagnosis_result(product)
            link_parse_failed = True
            link_kw = await extract_search_keyword_async(user_question, category=category)
            if not link_kw:
                # 裸链接（无品类/商品名）且无大淘客诊断 → 不调 LLM，本地即时引导，省成本且反馈快
                return {
                    "success": True,
                    "message": self._build_link_guide_text(link),
                    "card_type": None,
                    "card_data": None,
                    "follow_up": [
                        "这个品类竞争强吗？",
                        "同品类一般佣金多少？",
                        "新手适合从哪个价位带切入？",
                    ],
                }
        # 预取+注入（与流式同源）：推荐类问题先把商品卡候选查出来注入 prompt，正文只在这些商品里推荐
        # 爆品/指代承接类问题：正文必须基于实时在售商品（多榜共振榜），与是否出卡无关——
        # 匿名用户(emit_cards=False)也必须注入真实商品候选（同流式路径 2026-08-30 修复）。
        _product_hints = None
        _is_hot_pick_intent = False
        _refer = self._referential_followup(user_question, history)
        if _refer is not None and _refer.get("_prior_items"):
            _product_hints = self._hot_pick_to_hints({"items": _refer["_prior_items"]})
        else:
            _raw_card_type = self._detect_card_type(user_question)
            if _raw_card_type == "hot_pick":
                _is_hot_pick_intent = True
                try:
                    hot = await self._generate_hot_pick_card(user_question, category=category, stats=stats)
                    _product_hints = self._hot_pick_to_hints(hot)
                except Exception as e:
                    print(f"[CARD] 非流式爆品卡候选注入失败(降级 None): {e}")
                    _product_hints = None
            elif emit_cards:
                _plan0 = await self._plan_cards(user_question, category=category, history=history)
                if _plan0.get("_referential") and _plan0.get("_prior_items"):
                    # 承接追问（指代上文爆品/商品卡）：只走正文、不出卡。复用上文那批商品注入 prompt，
                    # 让 LLM 继续基于同一批商品做决策——与流式路径一致。
                    _product_hints = self._hot_pick_to_hints({"items": _plan0["_prior_items"]})
                elif _plan0["primary"] == "hot_pick":
                    # 爆品卡：正文与卡片一一对应（同流式），用实时榜爆品注入，不从抽词搜索走。
                    # 指代追问(_prior_items)复用同一批商品，避免重新取榜导致正文与上文脱节。
                    try:
                        if _plan0.get("_prior_items"):
                            _product_hints = self._hot_pick_to_hints({"items": _plan0["_prior_items"]})
                        else:
                            hot = await self._generate_hot_pick_card(user_question, category=category, stats=stats)
                            _product_hints = self._hot_pick_to_hints(hot)
                    except Exception as e:
                        print(f"[CARD] 非流式爆品卡候选注入失败(降级 None): {e}")
                        _product_hints = None
                elif _plan0["product"]:
                    try:
                        _product_hints = await asyncio.wait_for(
                            self._select_comparison_products(user_question, n=6, category=category, history=history),
                            timeout=8.0,
                        )
                    except Exception as e:
                        print(f"[CARD] 非流式预取对比商品失败(降级空): {e}")
                        _product_hints = []
        system_prompt = await self._build_system_prompt(
            user_question, owner=owner, link_parse_failed=link_parse_failed,
            category=category, audience=audience, product_hints=_product_hints,
            suppress_product_leads=_is_hot_pick_intent,
        )
        if link and link_kw:
            system_prompt += self._link_context_note(link, link_kw)
        messages = self._build_normal_messages(user_question, history, system_prompt)
        try:
            _, model_chain = self._resolve_brand(model)
            response = await self.chat(messages, temperature=0.7, model=model_chain[0])
            if stats is not None:
                stats["chat_usage"] = response.get("usage") if isinstance(response, dict) else None
                stats["chat_model"] = model_chain[0]
            ai_reply = self._sanitize_reply(response["choices"][0]["message"]["content"])
            # 匿名态不产卡片（与流式路径一致）
            if not emit_cards:
                return {"success": True, "message": ai_reply, "card_type": None, "card_data": None}
            # 非流式仅补一张主卡（与流式策展同源），保持轻量；推荐类问题优先展示预取的在售商品集
            plan = await self._plan_cards(user_question, category=category, history=history)
            if plan["product"] and _product_hints:
                return {"success": True, "message": ai_reply, "card_type": "product", "card_data": _product_hints}
            card_type = plan["effective_primary"] if plan["effective_primary"] != "none" else None
            card_data = None
            if card_type:
                try:
                    card_data = await self._generate_primary_card(card_type, user_question, category=category, stats=stats, prior_items=plan.get("_prior_items"))
                except Exception as error:
                    print(f"[CARD] 非流式生成 {card_type} 异常: {error}")
                    card_data = None
            # 搜空守门：非流式下「依赖真实搜索商品」的卡型没搜到商品时，不返回商品卡
            if card_data is not None and self._is_empty_product_card(card_type, card_data):
                card_type, card_data = None, None
            return {"success": True, "message": ai_reply, "card_type": card_type, "card_data": card_data}
        except Exception as error:
            print(f"[ERROR] AI call failed: {error}")
            import traceback
            traceback.print_exc()
            raise

    async def analyze_beauty_opportunity_stream(self, user_question: str, history: List[Dict] = None, emit_cards: bool = True, owner: str = None, category: str = "beauty", audience: str = "C", model: Optional[str] = None):
        print(f"[STREAM] Starting stream for: {user_question[:50]}... (category={category}, audience={audience})")
        # ── 商户链接处理：识别淘宝/天猫链接 → 大淘客单品诊断（有 key 且可解析则直接诊断，否则降级引导）──
        link = self._detect_product_link(user_question)
        link_parse_failed = False
        if link:
            product = await self._try_link_diagnosis(user_question)
            if product:
                async for chunk in self._yield_link_diagnosis(product):
                    yield chunk
                return
            link_parse_failed = True
            link_kw = await extract_search_keyword_async(user_question, category=category)
            if not link_kw:
                # 裸链接（无品类/商品名）且无大淘客诊断 → 不调 LLM，本地即时引导，省成本且反馈快
                async for chunk in self._emit_link_guide(link):
                    yield chunk
                return
        # 预取+注入：推荐类问题先把「将出现在商品卡里的真实在售商品」查出来注入 prompt，
        # 让 LLM 正文只在这些商品里推荐——根治正文与卡片不一致、以及「正文推荐了却没卡」。
        # 仅 emit_cards(登录且有卡) 才预取省匿名成本；好单库超 8s 降级为空（LLM 转通用选购建议）。
        # 先立即下发占位思考步，保证预取期间 SSE 连接持续有数据、不被代理 read-timeout 掐断。
        yield {"type": "thinking", "content": "正在理解你的选品需求…"}
        # 爆品/指代承接类问题：正文必须基于实时在售商品（多榜共振榜），与是否出卡无关——
        # 匿名用户(emit_cards=False)也必须注入真实商品候选，否则会退化成读 RAG/联盟静态样例
        # (花西子/广州酒家…)而答非所问（2026-08-30 生产实测复现）。
        # 仅「对比商品卡」这类需按词搜好单库的场景保留 emit_cards 门控以省匿名成本。
        _product_hints: list = None
        _is_hot_pick_intent = False
        _refer = self._referential_followup(user_question, history)
        if _refer is not None and _refer.get("_prior_items"):
            # 承接追问：复用上文那批真实商品作为正文候选（不出卡）
            _product_hints = self._hot_pick_to_hints({"items": _refer["_prior_items"]})
        else:
            _raw_card_type = self._detect_card_type(user_question)
            if _raw_card_type == "hot_pick":
                _is_hot_pick_intent = True
                # 实时榜即权威商品源：无论是否出卡都注入，保证匿名/登录正文与真实在售一致
                try:
                    hot = await self._generate_hot_pick_card(user_question, category=category, stats=None)
                    _product_hints = self._hot_pick_to_hints(hot)
                except Exception as e:
                    print(f"[CARD] 爆品卡候选注入失败(降级 None): {e}")
                    _product_hints = None
            elif emit_cards:
                _plan0 = await self._plan_cards(user_question, category=category, history=history)
                if _plan0.get("_referential") and _plan0.get("_prior_items"):
                    # 承接追问（指代上文爆品/商品卡）：只走正文、不出卡。把上文那批商品注入正文 prompt，
                    # 让 LLM 继续基于同一批商品做决策/分析——避免承接时正文与「上一轮展示的商品」脱节。
                    _product_hints = self._hot_pick_to_hints({"items": _plan0["_prior_items"]})
                elif _plan0["primary"] == "hot_pick":
                    # 爆品卡：正文必须与卡片一一对应。直接用实时榜爆品卡的真实商品注入文字 prompt，
                    # 让 LLM 正文也只在这 6 件里推荐——根治「正文说居家小电器、卡片却是奶酪/纸巾」的矛盾。
                    # 不复用 _select_comparison_products（它按 extract_search_keyword 抽词，抽到「今天爆款」
                    # 这类残词会搜空回填 []，把「帮用户找爆品」误导成「没匹配到在售商品」）。
                    # 2026-08-27 指代追问：若 _plan0 带上了文商品明细(_prior_items)，直接复用同一批商品，
                    # 不再重新取实时榜——保证「这些产品哪个最值得」追问时正文与卡片都指同一批商品。
                    try:
                        if _plan0.get("_prior_items"):
                            _product_hints = self._hot_pick_to_hints({"items": _plan0["_prior_items"]})
                        else:
                            hot = await self._generate_hot_pick_card(user_question, category=category, stats=None)
                            _product_hints = self._hot_pick_to_hints(hot)
                    except Exception as e:
                        print(f"[CARD] 爆品卡候选注入失败(降级 None): {e}")
                        _product_hints = None
                elif _plan0["product"]:
                    try:
                        _product_hints = await asyncio.wait_for(
                            self._select_comparison_products(user_question, n=6, category=category, history=history),
                            timeout=8.0,
                        )
                    except Exception as e:
                        print(f"[CARD] 预取对比商品失败(降级空): {e}")
                        _product_hints = []
        # hot_pick 意图：实时榜是唯一权威商品源，压掉联盟静态样例(product_leads)防止污染正文
        sys_prompt = await self._build_system_prompt(
            user_question, owner=owner, link_parse_failed=link_parse_failed,
            category=category, audience=audience, product_hints=_product_hints,
            suppress_product_leads=_is_hot_pick_intent,
        )
        if link and link_kw:
            sys_prompt += self._link_context_note(link, link_kw)

        # 推理模型（DeepSeek-R1）原生输出 reasoning_content：R1 不建议用 system prompt，
        # 故把人设/规则拼进【最旧一条保留的 user 消息】(sys_prompt 仅出现一次，避免多轮膨胀)；
        # 非推理模式用 system 消息（同样仅一次）。history 走滑动窗口截断。
        reasoning_flag, model_chain = self._resolve_brand(model)
        if reasoning_flag:
            messages = self._build_reasoning_messages(user_question, history, sys_prompt)
            chat_temp = 0.6
            chat_budget = settings.REASONING_BUDGET
        else:
            messages = self._build_normal_messages(user_question, history, sys_prompt)
            chat_temp = 0.7
            # 思考型非推理模型（Qwen3.5-35B 等）原生也会输出超长 reasoning_content，
            # 若不限制 thinking_budget 会把 max_tokens 预算吃光 → 正文为空（2026-08-25 修复）。
            # 统一限流思考长度，保证正文始终有预算。
            chat_budget = settings.REASONING_BUDGET
        try:
            # （占位思考步已在上方预取前下发，保证预取期间 SSE 不断流）

            # 计费埋点：累积主回答 + 卡片的 token 用量，末尾下发 usage chunk 供后端 record_usage
            stream_stats: Dict = {}

            # ── 选品卡片数据预取：与下方 LLM 文本流式输出【并行】执行（任务 #106 核心优化）──
            # 卡片类型由 user_question 确定性推导（不依赖 LLM 输出），故可先于文本流启动好单库/知识库取数，
            # 把端到端延迟从「文本 + 卡片串行」降到 max(文本流, 卡片取数)。
            effective_primary_type = "none"
            gen_keys: List[str] = []
            gen_coros: List[Any] = []
            if emit_cards:
                plan = await self._plan_cards(user_question, category=category, history=history)
                print(f"[CARD] Detected primary card type: {plan['primary']} (category={category})")
                effective_primary_type = plan["effective_primary"]
                if plan["primary"] != "none":
                    gen_keys.append("primary")
                    gen_coros.append(self._generate_primary_card(plan["primary"], user_question, category=category, stats=stream_stats, prior_items=plan.get("_prior_items")))
                elif plan["effective_primary"] != "none":
                    # fallback：方向类问题默认给 next_actions
                    gen_keys.append("primary")
                    gen_coros.append(self._generate_action_card(user_question, category=category, stats=stream_stats))
                if plan["product"]:
                    gen_keys.append("product")
                    # 复用上方已预取的候选（不再二次查好单库），用已完成协程包一层供 _collect_cards 读取
                    async def _ready(v):
                        return v
                    gen_coros.append(_ready(_product_hints if _product_hints is not None else []))
                # 主卡已是 trend 时不再重复生成 trend 卡（_generate_primary_card 的 trend 分支已产出）
                if plan["trend"] and plan["primary"] != "trend":
                    gen_keys.append("trend")
                    gen_coros.append(self._generate_trend_card(user_question, category=category))
            # 卡片 LLM 用量也并入 stream_stats（供内部核算事件）
            stream_stats["_emit_cards"] = emit_cards
            card_gather = asyncio.gather(*gen_coros, return_exceptions=True) if gen_coros else None

            # 续问改为确定性生成（见流末 _deterministic_followups），不再每轮发一次独立 LLM 调用

            # 收齐 + 策展卡片（最多 3 张 + 去重 + 按相关度排序），返回列表供下发
            async def _collect_cards():
                _gen_results: Dict[str, object] = {}
                if card_gather is not None:
                    _outs = await card_gather
                    for key, out in zip(gen_keys, _outs):
                        if isinstance(out, Exception):
                            print(f"[CARD] 生成 {key} 异常: {out}")
                            continue
                        _gen_results[key] = out
                built: List[Dict] = []
                if not emit_cards:
                    return built
                primary_data = _gen_results.get("primary")
                # 兜底：真实数据/LLM 都失败也不让卡片彻底消失（避免「回答结束但卡片没出」）
                if primary_data is None and effective_primary_type not in ("none",):
                    primary_data = self._safe_primary_fallback(effective_primary_type, user_question)
                # 搜空守门：凡「依赖真实搜索商品」的卡型，若实际没搜到商品明细，
                # 就不下发商品卡（避免「问鸡蛋却返回无关图书/浏览类目泛品」）。
                if primary_data is not None and not self._is_empty_product_card(effective_primary_type, primary_data):
                    built.append({"card_type": effective_primary_type, "card_data": primary_data})
                if _gen_results.get("product") and not self._is_empty_product_card("product", _gen_results["product"]):
                    built.append({"card_type": "product", "card_data": _gen_results["product"]})
                if _gen_results.get("trend") and not self._is_empty_product_card("trend", _gen_results["trend"]):
                    built.append({"card_type": "trend", "card_data": _gen_results["trend"]})
                _order = {"next_actions": 0, "data_insight": 0, "opportunity": 0, "hot_category": 0,
                          "risk": 0, "product_direction": 0, "action_advice": 0, "hot_pick": 0, "product": 1, "trend": 2}
                _seen = set()
                _deduped = []
                for c in sorted(built, key=lambda c: -1 if c["card_type"] == effective_primary_type else _order.get(c["card_type"], 9)):
                    if c["card_type"] in _seen:
                        continue
                    _seen.add(c["card_type"])
                    _deduped.append(c)
                return _deduped[:3]

            # 流式输出：推理模型把 reasoning_content 流进思考面板，content 流进正式回答
            rbuf = ""
            cards_emitted = False
            # 卡片与正文【并行】生成（card_gather 已在上方启动）。这里只建一个任务，绝不在正文流里
            # 阻塞等待卡片取数——否则好单库慢时整段正文会被冻住，且 SSE 出现长静默空窗，易被 nginx
            # proxy_read_timeout 掐断，导致「对话结束但卡片没了」（会员出卡慢、慢了就吞卡的根因）。
            card_task = asyncio.create_task(_collect_cards()) if emit_cards else None
            # 主回答流加【空闲超时】：若 LLM 长时间(>120s)无新 chunk（含 reasoning_content），
            # 视为挂起并提前结束 + 下发错误提示，避免 SSE 永久开着、前端 isLoading 卡死。
            agen = self._chat_stream_chain(messages, model_chain, chat_temp, 4096, chat_budget, stats=stream_stats)
            try:
                while True:
                    try:
                        chunk = await asyncio.wait_for(agen.__anext__(), timeout=120.0)
                    except asyncio.TimeoutError:
                        print("[STREAM] 主回答流空闲超时(>120s 无新 chunk)，提前结束并提示")
                        yield {"type": "error", "content": "生成超时，请稍后重试"}
                        break
                    except StopAsyncIteration:
                        break
                    if "choices" not in chunk or len(chunk["choices"]) == 0:
                        continue
                    delta = chunk["choices"][0].get("delta", {})
                    rc = delta.get("reasoning_content")
                    if rc:
                        rbuf += rc
                        while "\n" in rbuf:
                            line, rbuf = rbuf.split("\n", 1)
                            line = line.strip()
                            if line:
                                yield {"type": "thinking", "content": line}
                    cc = delta.get("content")
                    if cc:
                        yield {"type": "text", "content": self._sanitize_reply(cc)}
                        # 【8/28 交互微调】卡片仍提前并行生成（见上方 card_gather），
                        # 但【不在正文流中途插入】——等正文完全吐露完毕后再统一下发，
                        # 前端「文字吐露完再出卡」，避免正文播到一半卡片突然蹦出来。
                        # 卡片取数时序完全交给流末的「正文结束后统一下发」逻辑处理。
            finally:
                try:
                    await agen.aclose()
                except Exception:
                    pass
            # 推理残行（无结尾换行）补齐成最后一条思考步骤
            if rbuf.strip():
                yield {"type": "thinking", "content": rbuf.strip()}
            # 正文流结束后统一下发卡片：正文绝不被卡片取数阻塞。用 wait_for 兜底超时（15s），
            # 好单库超过 15s 即改发确定性兜底卡——保证卡片一定下发，且静默空窗 < 代理超时，杜绝被吞。
            if card_task is not None and not cards_emitted:
                try:
                    built_cards = await asyncio.wait_for(card_task, timeout=15.0)
                except asyncio.TimeoutError:
                    print("[CARD] 卡片取数超时(>15s)，改发兜底卡片，避免被代理超时吞掉")
                    built_cards = self._safe_card_fallback_list(user_question, effective_primary_type)
                except Exception as e:
                    print(f"[CARD] 卡片收集异常: {e}")
                    built_cards = self._safe_card_fallback_list(user_question, effective_primary_type)
                cards_emitted = True
                for c in built_cards:
                    yield {"type": "card", "card_type": c["card_type"], "card_data": c["card_data"]}

            # 续问：基于问题类型确定性生成（零额外 LLM 调用，省成本）
            follow_ups = self._deterministic_followups(user_question, effective_primary_type)
            yield {"type": "follow_up", "questions": follow_ups}

            # 用量回执（内部用，不下发给前端展示）：主回答 + 卡片 LLM 的 token 用量，供后端 record_usage 计费
            _cu = stream_stats.get("usage") or {}
            _usage_payload = {
                "type": "usage",
                "chat": (
                    {"model": stream_stats.get("model"),
                     "tokens_in": int(_cu.get("prompt_tokens") or 0),
                     "tokens_out": int(_cu.get("completion_tokens") or 0),
                     "tokens_cached": int(_cu.get("prompt_cache_hit_tokens") or 0)}
                    if _cu else None
                ),
                "cards": stream_stats.get("card_usages", []),
            }
            yield _usage_payload

        except Exception as error:
            print(f"[STREAM] Error: {error}")
            yield {"type": "error", "content": str(error)}

    def _detect_card_type(self, text: str) -> str:
        """根据问题类型返回最合适的卡片类型。

        优先级：具体意图(risk/data_insight/hot_category/product_direction/opportunity/
        action_advice/next_actions) 优先于泛化趋势信号；trend 仅作兜底卡型。
        关键改进（Bug B / 可用性测试 P1#3）：为自然问法加同义归并——
        "好不好卖/还能做吗/值不值得做/市场机会/竞品/前景/行情/佣金多少/退货"等高频自然表达
        之前纯关键词匹配会漏掉，导致"问了但没对应卡"。现在每组关键词都补了自然口语同义。
        趋势时间序列的上下文注入由 _plan_cards 单独调用 _is_trend_question 控制，不受本函数卡型影响。"""
        # 爆品推荐（2026-08-26 新增，高意图优先）：「今天推什么卖」这类要具体可卖品的问法，
        # 直接命中 hot_pick（实时榜爆品卡），而不是落到机会卡只给方向。
        if any(kw in text for kw in [
            "爆品", "爆款", "今天推荐什么", "今天推什么", "什么好卖", "什么卖得好",
            "在卖什么", "现在卖什么", "推几个", "推荐几个", "卖什么好", "今天卖什么",
            "今天有什么", "买什么好卖", "爆单", "热卖推荐", "今日推荐",
        ]):
            return "hot_pick"
        # 直接要一批在售商品（找/给/列/来/要 N 个商品、哪些商品、什么商品）→ 走实时榜爆品卡，
        # 返回真实在售商品。否则会落到「机会卡 + 对比商品卡」，抽关键词搜空后回填
        # 「暂时没匹配到在售商品，换个说法再试」的死文案（2026-08-30 修复用户反馈的失败问答）。
        # 例：「帮我找今天适合社群推广的30个商品」「给我几个能推的商品」「哪些商品好卖」
        if "商品" in text and re.search(r'(找|给|列|来|要|拿|挑|选|推荐)[^。，！？；：、\n]{0,18}?商品', text):
            return "hot_pick"
        if "哪些商品" in text or "什么商品" in text or "啥商品" in text:
            return "hot_pick"
        if any(kw in text for kw in [
            "风险", "危险", "踩坑", "亏损", "失败", "问题", "注意",
            "退货", "翻车", "合规", "备案", "成分安全", "致敏", "违规", "禁限",
        ]):
            return "risk"
        if any(kw in text for kw in [
            "数据", "销量", "价格带", "竞争强度", "市场规模",
            "佣金", "佣金率", "卖得", "市场怎么样", "行情", "数据怎么样",
            "佣金多少", "竞争", "规模", "月销", "客单价", "转化率",
        ]):
            return "data_insight"
        if any(kw in text for kw in [
            "热门", "热销", "爆款", "哪个品类", "什么品类", "推荐方向", "哪些赛道",
            "好卖", "什么好卖", "哪个赚钱", "蓝海",
        ]):
            return "hot_category"
        if any(kw in text for kw in [
            "详细分析", "深度分析", "方向详情", "怎么切入", "怎么打这个方向", "拆解一下",
            "竞品", "对手", "对标", "差异化", "切入点", "怎么打", "竞争格局", "方向对比", "打法",
        ]):
            return "product_direction"
        if any(kw in text for kw in [
            "机会", "值得", "入场", "适合", "能不能做", "有没有前景", "潜力",
            "好不好卖", "好不好做", "还能做吗", "值不值得做", "能赚钱吗", "市场机会",
            "有没有搞头", "前景", "行情", "能不能赚钱", "赚不赚钱", "还来得及吗",
            "能不能入场", "能入场吗", "值得入场",
        ]):
            return "opportunity"
        if any(kw in text for kw in [
            "推荐", "哪款", "哪支", "哪瓶", "哪个好", "值得买", "怎么挑", "怎么选",
            "买什么", "求推荐", "挑哪", "选哪个",
        ]):
            return "opportunity"
        if any(kw in text for kw in [
            "执行清单", "落地清单", "行动清单", "分步指南", "手把手教", "具体落地",
            "操作清单", "落地方案", "怎么落地", "执行方案", "落地", "策略",
        ]):
            return "action_advice"
        if any(kw in text for kw in [
            "怎么做", "下一步", "计划", "步骤", "如何开始", "测品", "选品",
            "怎么开始", "新手", "小白", "如何入手",
        ]):
            return "next_actions"
        if self._is_trend_question(text):
            return "trend"
        return "none"

    async def _generate_primary_card(self, card_type: str, user_question: str, category: str = "beauty", stats: dict = None, prior_items: list = None):
        """按主卡类型分派到对应的 _generate_* 方法（便于并发 gather）。stats: 把卡片 LLM 用量写入供计费核算。

        prior_items: 指代追问时由 _referential_followup 带上的「上文商品集卡明细」。对依赖真实商品明细的
        卡型(hot_pick/product/trend)，直接以这批复用的商品作为 card_data，不再重新取数——
        保证卡片与 LLM 正文(读 history 卡片数据推理的同一批商品)严格一致，杜绝「卡片错配成美妆/空卡」。"""
        # 指代追问复用上文商品明细：先按规则生成，再对商品集卡型整体覆盖 card_data
        if card_type == "next_actions":
            return await self._generate_action_card(user_question, category=category, stats=stats)
        if card_type == "hot_pick":
            card = await self._generate_hot_pick_card(user_question, category=category, stats=stats)
            if prior_items:
                # 指代追问：复用上文同一批商品，标题/摘要改为「续接上一批」，避免误导成全新实时榜
                n = len(prior_items)
                card["items"] = prior_items
                card["title"] = "刚才这批爆品 · 详细分析"
                card["summary"] = f"承接上文的这 {n} 件爆品，佣金 & 券后价如下，可针对性分析/推广"
                card["source"] = "承接上一轮爆品卡（复用已展示商品）"
            return card
        if card_type == "data_insight":
            return await self._generate_data_insight_card(user_question, category=category)
        if card_type == "opportunity":
            return await self._generate_opportunity_card(user_question, category=category, stats=stats)
        if card_type == "hot_category":
            return await self._generate_hot_category_cards(user_question, category=category)
        if card_type == "risk":
            return await self._generate_risk_card(user_question, category=category)
        if card_type == "product_direction":
            return await self._generate_product_direction_card(user_question, category=category)
        if card_type == "action_advice":
            return await self._generate_action_advice_card(user_question, category=category)
        if card_type == "trend":
            # 主卡类型为 trend（_detect_card_type 会把趋势问法归为 trend）时，
            # 直接复用 _generate_trend_card 的真实时间序列，避免走到 _safe_primary_fallback
            # 的「通用降级」卡把真实趋势数据挤掉（2026-08-25 修复）。
            card = await self._generate_trend_card(user_question, category=category)
            if prior_items:
                # trend 卡 data 结构与商品卡不同，仅当真实商品类趋势序列有 items 时替换
                pass
            return card
        return None

    def _need_action_card(self, text: str) -> bool:
        keywords = ["入场", "值得", "适合", "能做", "方向", "赛道", "选品", "测品", "怎么做", "下一步",
                    "怎么开始", "新手", "小白", "如何入手", "怎么落地", "落地"]
        return any(kw in text for kw in keywords)

    def _is_trend_question(self, text: str) -> bool:
        """判断用户是否在问热度走向/趋势（B 档呈现与 AI 解释触发条件）。

        只保留强趋势语义词；刻意去掉"最近/表现/变化/起来没/有没有起来"等高频泛化时间词，
        否则它们会污染 trend 卡型与趋势上下文注入，把风险/机会/数据等更具体意图挤掉
        （卡型优先级见 _detect_card_type）。真正需要时间序列的用户会用"趋势/走势/涨/跌"等表达。"""
        keywords = ["趋势", "走向", "热度", "涨", "跌", "近期", "走势", "环比", "同比",
                    "火了", "飙升", "曲线", "下滑", "上升"]
        return any(kw in text for kw in keywords)

    def _should_search(self, text: str) -> bool:
        keywords = ["最新", "现在", "当前", "今年", "2025", "2024", "2026", "热门", "趋势", "排行", "数据", "市场", "竞品", "对比", "价格", "销量", "火吗", "火了"]
        return any(kw in text for kw in keywords)

    def _is_market_question(self, text: str) -> bool:
        """判断用户是否在问某品类/赛道的市场面（价格带/佣金/销量/竞争/机会），此类问题需要聚合信号进正文。

        ⚠️ 2026-08-27 修复「无关问题也出美妆卡」：原关键词含「怎么样/分析/盘点/口碑/评价」等弱指代词，
        「今天天气怎么样」「1+1等于几」这类完全无关的问题也会被兜底成 data_insight 卡。
        现在区分两档：
        - 强市场词（市场/行情/价格带/佣金/销量/好卖/竞争/规模/品类/赛道/选品/机会/前景…）：单独命中即可判定；
        - 弱指代词（怎么样/分析/盘点/口碑/评价/评论/反馈/吐槽/好评/买家/数据/卖什么/做什么…）：
          必须【同时】能从问题抽到真实品类/商品词（extract_search_keyword 非空），否则视为无关闲聊，不出卡。
        这样「防晒霜怎么样」「面膜这个方向风险大吗」仍出卡，但「今天天气怎么样」不再出卡。"""
        strong = ["类目", "赛道", "市场", "行情", "价格带", "佣金", "销量", "好卖", "好做", "机会",
                  "品类", "选品", "值得做", "能不能做", "前景", "潜力", "竞争", "规模",
                  "好不好卖", "好不好做", "还能做吗", "值不值得做", "市场机会", "竞品",
                  "市场怎么样", "数据怎么样", "市场行情", "佣金多少"]
        if any(kw in text for kw in strong):
            return True
        # 弱指代词：必须已有真实品类/商品指向，否则是无关闲聊（今天天气怎么样/1+1等于几）
        weak = ["怎么样", "分析", "盘点", "口碑", "评价", "买家", "评论", "反馈", "吐槽",
                "好评", "数据", "卖什么", "做什么"]
        if any(kw in text for kw in weak):
            # 抽词命中真实品类/商品词（非宽泛残词）才视为市场问题
            return bool(extract_search_keyword(text))
        return False

    async def _generate_data_insight_card(self, user_question: str, category: str = "beauty") -> Dict:
        """数据卡改为真实数据驱动：只用联盟真实市场信号（价格带/佣金/销量/品牌数/竞争），
        不编搜索热度/内容增长/平台拆分等无真实来源的数字。无真实信号降级标 confidence:低。"""
        kw = await extract_search_keyword_async(user_question, category=category)
        signals: Dict = {}
        if kw:
            try:
                signals = await union_provider.compute_market_signals(keyword=kw, max_items=300, category=category)
            except Exception as e:
                print(f"[CARD] data_insight 取真实信号失败: {e}")
                signals = {}
        # 类目浏览兜底：关键词搜索搜空时（宽泛品类词如「宠物」「家居」大淘客搜索接口经常
        # 返回空），退回同类目浏览（keyword=""，general→全品类 / beauty→美妆），
        # 避免回退到「暂未取到真实联盟商品数据」死文案。数据仍是真实联盟商品，仅口径从
        # 「该词精确搜索」放宽为「同类目浏览」。
        browse_fallback = False
        if not signals:
            try:
                browse = await union_provider.compute_market_signals(keyword="", max_items=300, category=category)
                if browse:
                    signals = browse
                    browse_fallback = True
            except Exception as e:
                print(f"[CARD] data_insight 类目浏览兜底失败: {e}")
        if not signals:
            return {
                "avgPrice": "",
                "priceBand": "",
                "competitionLevel": "",
                "source": "好单库（淘宝/天猫联盟商品聚合）",
                "confidence": "低",
                "note": "暂未取到该品类的真实联盟商品数据，无法给出可信价格带",
            }

        competition = self._derive_competition(signals)
        # 60 天均价趋势（trend_service 时间序列，供前端 sparkline + 环比）
        trend = []
        if kw:
            try:
                series = trend_service.get_keyword_trend(kw, days=60)
                if series:
                    trend = [
                        {"date": p.get("date"), "avgPrice": p.get("avg_price"), "totalSales": p.get("total_sales")}
                        for p in series
                    ]
            except Exception as e:
                print(f"[CARD] data_insight 取趋势失败: {e}")
                trend = []
        card = {
            "avgPrice": f"¥{signals['price_median']:.0f}" if signals.get("price_median") else signals.get("price_band", ""),
            "priceBand": signals.get("price_band", ""),
            "competitionLevel": competition,
            "productCount": signals.get("product_count", 0),
            "brandCount": signals.get("distinct_brands", 0),
            "avgCommission": f"平均佣金{signals['avg_commission_ratio']}%" if signals.get("avg_commission_ratio") is not None else "",
            "totalSales": f"月销合计约{self._fmt_sales(signals['total_sales'])}" if signals.get("total_sales") else "",
            "source": signals.get("source_label") or "好单库（淘宝/天猫联盟商品聚合）",
            "confidence": "高" if signals.get("product_count", 0) >= 12 else "中",
            "competitionNote": "竞争强度由联盟在售商品数/品牌数推导，非平台官方数据",
            "trend": trend,
        }
        if browse_fallback:
            card["note"] = "该品类词精确搜索暂无数据，以上为该类目浏览的联盟商品真实价格带（口径放宽）"
        return card

    async def _generate_opportunity_card(self, user_question: str, category: str = "beauty", stats: dict = None) -> Dict:
        """生成机会评估卡片：优先用真实联盟数据算出市场信号，再让 LLM 基于真实数字给判断。"""
        kw = await extract_search_keyword_async(user_question, category=category)
        signals: Dict = {}
        if kw:
            try:
                signals = await union_provider.compute_market_signals(keyword=kw, max_items=300, category=category)
            except Exception as e:
                print(f"[CARD] 机会卡取真实信号失败: {e}")
                signals = {}
        # 类目浏览兜底：与数据卡一致，关键词搜空时退回同类目浏览（真实数据，口径放宽）
        browse_fallback = False
        if not signals:
            try:
                browse = await union_provider.compute_market_signals(keyword="", max_items=300, category=category)
                if browse:
                    signals = browse
                    browse_fallback = True
            except Exception as e:
                print(f"[CARD] 机会卡类目浏览兜底失败: {e}")

        has_data = bool(signals)
        competition_level = self._derive_competition(signals) if has_data else ""
        data_score, score_factors = self._derive_opportunity_score(signals) if has_data else (None, [])

        # 真实信号文本：注入 prompt，要求 LLM 基于真实数字判断、不得编造
        signals_text = ""
        if has_data:
            lines = [
                f"【真实联盟商品数据（{signals.get('source_label') or '淘宝/天猫联盟'}）】",
                f"- 在售商品数：{signals['product_count']} 款，覆盖品牌 {signals['distinct_brands']} 个",
                f"- 头部品牌：{'、'.join(signals['top_brands'])}",
                f"- 价格带：{signals['price_band']}"
                + (f"（中位¥{signals['price_median']:.0f}）" if signals.get("price_median") else ""),
            ]
            if signals.get("avg_commission_ratio") is not None:
                lines.append(f"- 平均佣金：{signals['avg_commission_ratio']}%（约¥{signals['avg_commission_money']}/单）")
            if signals.get("total_sales"):
                lines.append(f"- 月销合计：约{self._fmt_sales(signals['total_sales'])}，均值约{self._fmt_sales(signals['avg_sales'])}/款")
            lines.append(f"- 数据推导竞争强度：{competition_level or '未知'}")
            if data_score is not None:
                lines.append(f"- 数据推导机会指数基准：{data_score}")
            if browse_fallback:
                lines.append("- 注：该品类词精确搜索暂无数据，以上为该类目浏览的真实联盟商品口径")
            signals_text = "\n".join(lines) + "\n"

        prompt = (
            "根据用户问题，结合下方真实商品数据，生成一张美妆选品机会评估卡，严格按JSON返回，不要其他内容：\n"
            '{"id":"opp_1","title":"赛道名称（8字以内，用用户问的具体品类，如防晒霜/精华）","opportunityScore":75,'
            '"competitionLevel":"中等","riskLevel":"medium_low","suggestedPlatform":"抖音+小红书",'
            '"summary":"一句话核心判断（40字以内，要点出真实数据里的关键信号：价格带/佣金/头部品牌/竞争）","gradientType":"recommend"}\n\n'
            "gradientType 可选值：strong_recommend/recommend/cautious/observe/not_recommend\n"
            "riskLevel 可选值：low/medium_low/medium/high\n"
            "硬性要求：\n"
            "1. title 必须是对应用户问的具体品类（如用户问防晒霜就写防晒霜），不要写泛泛的'美妆选品方向'。\n"
            "2. summary 必须基于下方真实数据给出判断，自然提到价格带/佣金/头部品牌/竞争里的真实要素，不得编造数据。\n"
            "3. opportunityScore 要与真实信号一致（销量高、佣金高、竞争适中→分数高；竞争极高则调低）。\n"
            "4. competitionLevel 要与数据推导的竞争强度基本一致。\n"
            f"用户问题：{user_question}\n\n"
            f"{signals_text}"
            "要求：opportunityScore 在 0-100 之间，summary 要直接给判断。只返回JSON。"
        )

        data = await self._chat_json([{"role": "user", "content": prompt}], temperature=0.4, timeout=12, stats=stats)

        if not data:
            data = self._opportunity_fallback(user_question, signals, competition_level, data_score)

        # 真实数据优先：分数与竞争强度用数据推导值覆盖，保证不被 LLM 带偏
        if has_data:
            if data_score is not None:
                data["opportunityScore"] = data_score
            if competition_level:
                data["competitionLevel"] = competition_level
            data["scoreFactors"] = score_factors
            data["metrics"] = {
                "productCount": signals["product_count"],
                "topBrands": signals["top_brands"],
                "priceBand": signals["price_band"],
                "avgCommissionText": f"平均佣金{signals['avg_commission_ratio']}%" if signals.get("avg_commission_ratio") is not None else "",
                "totalSalesText": f"月销合计约{self._fmt_sales(signals['total_sales'])}" if signals.get("total_sales") else "",
                # 数字型（供前端确定性收益测算）：平均单佣金额(¥)/平均佣金率(%)
                "avgCommissionMoney": signals.get("avg_commission_money"),
                "avgCommissionRatio": signals.get("avg_commission_ratio"),
                "source": signals.get("source_label") or "联盟商品数据",
                "competitionNote": "竞争强度由联盟在售商品数/品牌数推导，非平台官方数据",
            }

        # 给机会卡加一张真实商品配图（best-effort）
        cover = await self._attach_cover(data.get("title") or kw or user_question)
        if cover:
            data["coverImage"] = cover
        # 统一真实数据溯源标注（前端空字段不渲染，有则展示）
        data["source"] = signals.get("source_label") if has_data else "联盟商品数据（淘宝/天猫）"
        data["confidence"] = "高" if has_data else "低"
        if has_data:
            data["competitionNote"] = "竞争强度由联盟在售商品数/品牌数推导，非平台官方数据"
        return data

    async def _generate_hot_pick_card(self, user_question: str, category: str = "beauty", stats: dict = None) -> Dict:
        """爆品卡生成器（2026-08-26 新增，2026-08-30 升级为多榜单专题矩阵）：拉大淘客多榜专题列。

        每件爆品给硬指标（佣金率/券后价/月销）+ 一个确定性派生的推荐卖点，不依赖 LLM
        （避免 LLM 超时导致整卡失败，机会卡已实测出现 LLM 超时）。items 空时降级为通用兜底。

        返回结构（兼容新旧消费方）：
          - items[]  ：首列（实时榜）物品，供 _hot_pick_to_hints 给正文 LLM 注入 + 旧逻辑兼容
          - matrix   ：多榜单专题矩阵 {tabs, columns}，供前端爆品卡「横向滑动切换专题 + 查看更多」
          - title/summary/source/confidence：卡片头部与口径
        """
        # 多榜单专题矩阵：6 个榜单主题各归一化为一列（每列默认取 12 件，前端可展开）
        matrix: Dict = {"tabs": [], "columns": []}
        try:
            matrix = await get_hot_pick_matrix()
        except Exception as e:
            print(f"[CARD] 爆品卡矩阵拉取失败(降级单榜): {e}")
            matrix = {"tabs": [], "columns": []}

        # 首列兜底：优先用矩阵里的「实时爆品榜」(type=1)，没有则单独拉实时榜
        if matrix.get("columns"):
            first_col = next((c for c in matrix["columns"] if c["type"] == 1), matrix["columns"][0])
            items = first_col.get("items") or []
            # 若无实时榜列，把首个非空列作为主列（供正文注入）
            if first_col.get("type") != 1:
                items = items or []
        else:
            items = await get_hot_pick_items(page_size=8, cid=None)
            # items 为空时退回美妆类目榜单（与项目美妆定位一致）
            if not items and category == "beauty":
                try:
                    items = await get_hot_pick_items(page_size=8, cid=settings.DATAOKE_CID)
                except Exception as e:
                    print(f"[CARD] 爆品卡美妆榜兜底失败: {e}")
        if not items:
            return self._safe_primary_fallback("hot_pick", user_question)

        # 取「今日热搜词」作为维度（best-effort，失败不影响卡片）
        hot_words: List[str] = []
        try:
            hot_words = await get_top100(hot_type=1)
        except Exception:
            hot_words = []

        # 首列实时榜物品：全部保留（不再截断前6件），让正文 LLM 与卡片一一对应
        out_items = []
        for it in items:
            title = (it.get("title") or "").strip()[:46]
            actual = it.get("actualPrice")
            commission = it.get("commissionRate")
            month_sales = it.get("monthSales")
            price_text = it.get("priceText") or (f"¥{actual:.2f}" if actual is not None else "—")
            comm_text = it.get("commissionText") or (f"{commission:.1f}%" if commission else "—")
            sales_text = it.get("salesText") or self._fmt_sales(month_sales) if month_sales else "—"
            # 卖点：优先用矩阵已派生的 sellPoint，但过短（<6 字符）或空时用派生逻辑补全，
            # 保证每件商品卖点饱满（如「低价引流」单独太单薄，补成「低价好卖，引流款」）。
            sell_point = (it.get("sellPoint") or "").strip()
            if len(sell_point) < 6:
                sell_points: List[str] = []
                if commission and commission >= 20:
                    sell_points.append(f"佣金{comm_text}，利润空间足")
                elif commission and commission >= 10:
                    sell_points.append(f"佣金{comm_text}，走量有赚")
                if month_sales and month_sales >= 50000:
                    sell_points.append(f"月销{sales_text}，已验证热度")
                elif month_sales and month_sales >= 5000:
                    sell_points.append(f"月销{sales_text}，有小爆潜质")
                if actual is not None and actual >= 100:
                    sell_points.append("客单高，适合直播/内容讲解")
                elif actual is not None and actual < 30:
                    sell_points.append("低价好卖，引流款")
                if not sell_points:
                    sell_points.append("实时榜热门品，可先小批测")
                sell_point = "；".join(sell_points)
            out_items.append({
                # id / brand 供前端调 /products/intro 生成「商品介绍」：
                #   - id 用大淘客数字 dtk_id（_product_key 按 id 稳定缓存，跨请求命中不重复收费）
                #   - 实时榜无品牌字段时先用空串占位（generate_product_intro 会用 title 兜底检索）
                "id": it.get("dtk_id") or it.get("goodsId") or "",
                "brand": it.get("brand") or "",
                "title": title,
                "actualPrice": actual,
                "couponPrice": it.get("couponPrice"),
                "couponConditions": it.get("couponConditions"),
                "commissionRate": commission,
                "monthSales": month_sales,
                "priceText": price_text,
                "commissionText": comm_text,
                "salesText": sales_text,
                "mainPic": it.get("mainPic"),
                "itemLink": it.get("itemLink"),
                "couponLink": it.get("couponLink"),
                "goodsId": it.get("goodsId"),
                "dtk_id": it.get("dtk_id"),
                "shopName": it.get("shopName"),
                "sellPoint": sell_point,
                # 多榜单共振标记（来自 dataoke_service.get_hot_pick_matrix 的共振检测）：
                # 同一商品登上 ≥2 个榜单 → resonanceCount≥2 且 resonanceTabs 列出榜名，前端打角标、正文可点名。
                "resonanceCount": it.get("resonanceCount"),
                "resonanceTabs": it.get("resonanceTabs"),
            })

        # 若矩阵有列，把首列物品替换成上面规范的 out_items（其余列保持 get_rank_center_items 的归一化结果）
        if matrix.get("columns"):
            for col in matrix["columns"]:
                if col["type"] == 1:
                    col["items"] = out_items
                    break
            else:
                # 没有 type=1 列（异常）→ 用 out_items 占位首列
                matrix["columns"][0]["items"] = out_items

        n = len(out_items)
        summary = f"今天实时榜热卖的 {n} 件，佣金 & 券后价如下，可直接拿去发"
        if hot_words:
            summary += f"。当前热搜方向：{'、'.join(hot_words[:5])}"
        # 多榜单共振：登上 ≥2 榜的商品确定性更高，优先推（共振标记已透传到 items/matrix）
        n_res = sum(1 for x in out_items if (x.get("resonanceCount") or 0) >= 2)
        if n_res:
            summary += f"。其中 {n_res} 件同时登上多个榜单（多榜共振），确定性更高，优先推。"
        return {
            "title": "今日爆品 · 实时榜",
            "summary": summary,
            "items": out_items,
            # 多榜单专题矩阵（前端横向滑动切换专题 + 查看更多）
            "matrix": matrix,
            "source": "大淘客实时榜（rankType=1）",
            "confidence": "高" if items else "低",
        }

    def _derive_competition(self, signals: Dict) -> str:
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

    def _derive_opportunity_score(self, signals: Dict):
        """由真实销量/佣金/竞争推导机会指数（确定性，0-100），并返回加分/减分明细。

        明细用于前端「机会分依据」可视化：基础分 + 销量热度 + 佣金空间 + 竞争强度。
        各 factor 的 delta 之和 = 收敛前的原始分；最终 card 上的 opportunityScore 已按 30-96 夹紧。
        """
        factors: List[Dict] = []
        base = 45.0
        factors.append({"label": "基础分", "delta": round(base, 1), "detail": "选品赛道基线"})
        score = base

        total = signals.get("total_sales") or 0
        if total > 0:
            d = min(25.0, max(0.0, (math.log10(total) - 2) * 8))
            score += d
            factors.append({"label": "销量热度", "delta": round(d, 1), "detail": f"月销约{self._fmt_sales(total)}"})

        ratio = signals.get("avg_commission_ratio")
        if ratio is not None:
            d = min(20.0, ratio * 0.8)
            score += d
            factors.append({"label": "佣金空间", "delta": round(d, 1), "detail": f"平均佣{ratio}%"})

        comp = self._derive_competition(signals)
        d = {"高": -15, "中高": -8, "中等": -2, "中低": 3}.get(comp, 0)
        score += d
        factors.append({"label": "竞争强度", "delta": d, "detail": f"竞争{comp}"})

        final = int(max(30, min(96, round(score))))
        return final, factors

    def _fmt_sales(self, n) -> str:
        if not n:
            return "0"
        if n >= 10000:
            return f"{n / 10000:.1f}万"
        return str(int(n))

    def _opportunity_fallback(self, user_question: str, signals: Dict, competition_level: str, data_score) -> Dict:
        kw = extract_search_keyword(user_question) or "美妆选品方向"
        if signals:
            summary = (
                f"{kw}在售{signals['product_count']}款，价格带{signals['price_band']}，"
                f"平均佣金{signals.get('avg_commission_ratio')}%，头部品牌{'、'.join(signals['top_brands'])}，竞争{competition_level}。"
            )
        else:
            summary = "有入场空间，建议从细分人群切入"
        return {
            "id": "opp_1",
            "title": kw,
            "opportunityScore": data_score or 70,
            "competitionLevel": competition_level or "中等",
            "riskLevel": "medium",
            "suggestedPlatform": "抖音+小红书",
            "summary": summary[:40],
            "gradientType": "cautious",
        }

    def _safe_primary_fallback(self, card_type: str, user_question: str) -> Dict:
        """卡片生成（真实数据/LLM）全失败时的最终降级：保证 detected 类型至少有一张卡，
        绝不静默消失。字段从简，前端空字段不渲染，有则展示。"""
        kw = extract_search_keyword(user_question) or "这个方向"
        if card_type == "hot_pick":
            return {
                "title": "今日爆品 · 实时榜",
                "items": [],
                "summary": "暂未取到实时爆品数据（榜单接口可能限流），稍后再试或换个问法",
                "source": "大淘客实时榜（降级）",
                "confidence": "低",
            }
        if card_type == "opportunity":
            return self._opportunity_fallback(user_question, {}, "", None)
        if card_type == "risk":
            return {
                "title": kw,
                "risks": ["选品前请先查备案、看成分、辨宣传（详见知识库 06_risk_assessment）"],
                "mitigation": ["通过化妆品监管 APP 核对产品备案信息", "确认功效/成分/使用部位与备案一致", "避免医疗化/速效化/全能化等高风险宣传"],
                "confidence": "低",
                "riskLevel": "medium",
                "source": "知识库结构化风险条目（降级）",
            }
        if card_type == "data_insight":
            return {
                "avgPrice": "", "priceBand": "", "competitionLevel": "",
                "source": "联盟商品数据（淘宝/天猫）",
                "confidence": "低",
                "note": "暂未取到该品类的真实联盟商品数据，无法给出可信价格带",
            }
        if card_type == "next_actions":
            # 必须与 ChatBubble 映射的 NextActionsCard 形状一致（product/now/this_week/next_week 三数组齐全），
            # 否则兜底卡下发给 next_actions 卡型时 data.this_week.map 会崩溃。
            return {
                "product": "这个方向",
                "now": ["先用联盟数据看真实价格带/佣金", "挑 1-2 个细分人群测品", "跑通内容分发再放量"],
                "this_week": ["小批量 50 单测 7 天，记录点击率/加购/转化", "按 ROI 排序优先放量佣金≥15% 且月销稳定的款"],
                "next_week": ["跑通的单品加预算放量，未跑通的下架", "扩充 2-3 个相邻细分品类，分散风险"],
                "confidence": "低",
                "source": "通用选品步骤（降级）",
            }
        if card_type == "hot_category":
            return []
        if card_type == "product_direction":
            return {
                "id": "dir_1",
                "directionName": kw,
                "category": "选品方向",
                "priceRange": "暂无可信号数据，建议先用联盟数据确认价格带",
                "targetUsers": "内容平台 18-35 岁选品人群",
                "keySellingPoints": ["先小批量测品验证需求", "从细分人群切入避开红海", "绑定真实佣金/销量选品"],
                "suitablePlatforms": ["xiaohongshu", "douyin"],
                "contentAngles": ["成分/功效科普建立专业感", "真实测评对比突出性价比", "人群场景种草绑定使用场景"],
            }
        if card_type == "action_advice":
            return {
                "actionTitle": f"{kw}·落地执行清单",
                "steps": ["先用联盟数据看真实价格带/佣金", "挑 1-2 个细分人群测品", "小批量 50 单测 7 天记录转化",
                          "按 ROI 放量佣金≥15% 且月销稳定的款", "跑通后加预算，未跑通下架"],
            }
        return {
            "title": kw,
            "summary": "建议先用真实联盟数据确认价格带与竞争再决定是否入场",
            "confidence": "低",
            "source": "通用降级",
        }

    def _safe_card_fallback_list(self, user_question: str, effective_primary_type: str) -> List[Dict]:
        """取数整体超时/异常时的最后兜底：至少给主卡一张确定性降级卡，绝不让卡片静默消失。"""
        if effective_primary_type in ("none",):
            return []
        try:
            pd = self._safe_primary_fallback(effective_primary_type, user_question)
        except Exception:
            return []
        if not pd:
            return []
        return [{"card_type": effective_primary_type, "card_data": pd}]

    async def _generate_hot_category_cards(self, user_question: str, category: str = "beauty") -> list:
        """热门品类卡改为真实数据驱动：直接复用好单库方向管线（每个方向都是真实商品信号推导的分），
        删除原 LLM 编的 60-95 假分。返回 HotCategoryCard 兼容的真实方向卡列表。"""
        try:
            data = await build_opportunity_directions_from_union()
            # 注意：union 返回结构是 {groups:[{group, items:[...]}]}，顶层没有 items 键，
            # 必须展平 groups 才能拿到方向卡；之前错读 data.get("items") 恒为 []，导致热品类卡永远空白。
            items = [it for g in data.get("groups", []) for it in g.get("items", [])]
        except Exception as e:
            print(f"[CARD] hot_category 取真实方向失败: {e}")
            items = []
        if not items:
            return []
        # 统一真实数据溯源标注（前端空字段不渲染，有则展示）
        for it in items:
            it.setdefault("source", "联盟商品数据（淘宝/天猫）")
        return items

    async def _generate_risk_card(self, user_question: str, category: str = "beauty") -> Dict:
        """风险卡（2026-08-26 改版）：纯真实联盟数据驱动，**不再检索知识库 RAG**。
        风险/建议全部从好单库真实商品信号（竞争/价格/佣金/销量集中度）确定性派生，
        不展示知识库条目溯源；无真实数据时降级为通用提示并标 confidence:低。"""
        risks: List[str] = []
        mitigation: List[str] = []
        references: List[Dict] = []

        # 真实竞争/价格/佣金信号（唯一数据源：好单库搜索，非 RAG）
        kw = await extract_search_keyword_async(user_question)
        signals: Dict = {}
        if kw:
            try:
                signals = await union_provider.compute_market_signals(keyword=kw, max_items=300)
            except Exception as e:
                print(f"[CARD] risk 取真实信号失败: {e}")
                signals = {}
        has_data = bool(signals)
        competition = self._derive_competition(signals) if has_data else ""
        risk_level = self._competition_to_risk_level(competition) if competition else "medium"

        # 1) 竞争风险（真实数据派生，置顶）
        if has_data and competition in ("高", "中高"):
            risks.append(
                f"该品类在好单库在售{signals['product_count']}款、覆盖{signals['distinct_brands']}个品牌，"
                f"竞争{competition}，易陷入价格战与同质化"
            )
        elif has_data and competition:
            risks.append(f"当前竞争{competition}，头部品牌挤压明显，新入局需找准细分人群")
        if has_data and signals.get("distinct_brands") and signals.get("product_count"):
            top_share = signals["distinct_brands"] / max(signals["product_count"], 1)
            if top_share < 0.5 and signals["product_count"] >= 10:
                risks.append(f"在售款数多但品牌分散（{signals['distinct_brands']}/{signals['product_count']}），缺乏统治性头部，爆款难以持续")
        if has_data and signals.get("avg_commission_ratio") is not None:
            if signals["avg_commission_ratio"] < 10:
                risks.append(f"平均佣金仅{signals['avg_commission_ratio']:.1f}%，利润空间薄，投流后易倒挂")

        # 2) 应对建议（由真实信号反推的确定性动作，不引知识库）
        if has_data:
            if competition in ("高", "中高"):
                mitigation.append("避开头部品牌正面竞争，锁定细分人群/场景做差异化")
            if signals.get("avg_commission_ratio") is not None and signals["avg_commission_ratio"] < 15:
                mitigation.append("优先选佣金≥15% 的款测品，按 ROI 淘汰低效品")
            if signals.get("price_band"):
                mitigation.append(f"锚定主流价格带 {signals['price_band']} 上架，先小批量 50 单测 7 天验证转化")
            mitigation.append("用真实佣金/销量数据做初筛，避免只凭内容热度选品")

        # 3) 置信度：有真实信号即高；无数据才降级
        confidence = "高" if has_data else "低"
        if not risks:
            risks = ["该品类暂无充分真实商品信号，先搜一次实时在售数据再判断入场风险"]
            confidence = "低"
        if not mitigation:
            mitigation = [
                "先用好单库搜该品类实时在售数据，确认价格带与佣金",
                "小批量测品验证转化后再放量",
                "关注头部品牌与价格带集中度，避免同质化入场",
            ]

        return {
            "riskLevel": risk_level,
            "risks": risks[:4],
            "mitigation": mitigation[:4],
            "source": signals.get("source_label") or "联盟商品数据（淘宝/天猫）" if has_data else "通用选品提示（降级）",
            "references": references,
            "confidence": confidence,
        }

    def _competition_to_risk_level(self, competition: str) -> str:
        """由真实竞争强度映射风险等级（确定性，前端 RiskCard 枚举 low/medium_low/medium/high）。"""
        return {"高": "high", "中高": "medium", "中等": "medium_low", "中低": "low"}.get(competition, "medium")

    async def _generate_action_card(self, user_question: str, category: str = "beauty", stats: dict = None) -> Dict:
        """行动卡改为真实数据驱动：挂钩本问真实商品/方向，用真实价格/佣金给出具体可落地的动作。
        无真实商品时降级给通用步骤并标 confidence:低。"""
        kw = await extract_search_keyword_async(user_question, category=category)
        product = kw or ("全品类选品方向" if category == "general" else "美妆选品方向")
        now: List[str] = []
        this_week: List[str] = []
        next_week: List[str] = []
        if kw:
            try:
                leads = await union_provider.search_products(keyword=kw, max_items=5, category=category)
            except Exception as e:
                print(f"[CARD] next_actions 取真实商品失败: {e}")
                leads = []
            if leads:
                top = leads[0]
                pname = (top.get("context") or "")[:30] or product
                price = top.get("price_text") or ""
                ratio = f"佣{top['commission_ratio']:.0f}%" if top.get("commission_ratio") is not None else ""
                comm_m = f"≈¥{top['commission_money']:.0f}" if top.get("commission_money") is not None else ""
                now = [
                    f"从联盟数据挑 3-5 款「{kw}」真实在售品（券后价/佣金/销量齐全）做初筛",
                    f"把「{pname}」（{price}·{ratio}{comm_m}）加入测品清单",
                    "确认目标人群与内容角度，避免与头部品牌正面打价格战",
                ]
                this_week = [
                    "小批量 50 单测 7 天，记录点击率/加购/转化",
                    "按 ROI 排序：优先放量佣金≥15% 且月销稳定的款",
                    "准备小红书/抖音种草内容，先内容验证再投流",
                ]
                next_week = [
                    "跑通的单品加预算放量，未跑通的下架",
                    "复盘佣金与退货，剔除高佣低复购款",
                    "扩充 2-3 个相邻细分品类，分散风险",
                ]
                product = f"{kw}（参考：{pname} 等{len(leads)}款真实在售）"

        if not now:
            now = ["去小红书搜相关话题热度", "记录点赞最高的10篇笔记", "分析竞品卖点与内容角度"]
            this_week = ["找3-5个主要竞品详细研究", "确定自己的差异化定位", "计算首批需要多少预算"]
            next_week = ["联系供应商询价", "准备测品样品", "找2-3个素人博主合作"]
        return {
            "product": product,
            "now": now,
            "this_week": this_week,
            "next_week": next_week,
            "source": "联盟商品数据（淘宝/天猫）" if kw else "",
            "confidence": "高" if kw else "低",
        }

    async def _generate_trend_card(self, user_question: str, category: str = "beauty") -> Optional[Dict]:
        """B 档：拉该关键词的时间序列，作为趋势卡片数据下发（前端画趋势图）。无数据返回 None。

        兜底：若历史快照为空（用户首次问该关键词），主动搜一次好单库把当日快照写入时间序列库，
        本次即可至少画出单点，避免「趋势卡完全不显示」。
        """
        kw = await extract_search_keyword_async(user_question, category=category)
        if not kw:
            return None
        series = trend_service.get_keyword_trend(kw, days=60)
        if not series:
            try:
                await union_provider.search_products(keyword=kw, max_items=300, category=category)
                series = trend_service.get_keyword_trend(kw, days=60)
            except Exception as e:
                print(f"[CARD] trend 兜底快照写入失败: {e}")
        if not series:
            return None
        return {"keyword": kw, "days": 60, "series": series, "source": "联盟商品数据（淘宝/天猫）"}

    def _to_product_card(self, lead: Dict, idx: int) -> Dict:
        """把好单库商品线索转成前端商品卡片数据（含图片 URL、价格、佣金、销量、推广链接）。"""
        return {
            "id": f"prod_{idx}",
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
        }

    # ─────────────────────────────────────────────────────────────
    # 对话后商品对比卡片的「选卡」逻辑：从好单库大池里挑出可比精选集
    # ─────────────────────────────────────────────────────────────
    async def _generate_product_direction_card(self, user_question: str, category: str = "beauty") -> Dict:
        """方向详情卡：承接热品类卡「详细分析某方向」的追问，用真实联盟信号（价格带/佣金/竞争）拼装，
        结构品类无关，全品类/美妆下都出。字段严格对齐前端 ProductDirection 接口
        （id/directionName/category/priceRange/targetUsers/keySellingPoints[]/suitablePlatforms[]/contentAngles[]）。"""
        kw = await extract_search_keyword_async(user_question, category=category) or await self._resolve_direction_keyword(user_question, category=category) or "这个方向"
        signals: Dict = {}
        try:
            signals = await union_provider.compute_market_signals(keyword=kw, max_items=300, category=category)
        except Exception as e:
            print(f"[CARD] product_direction 取真实信号失败: {e}")
            signals = {}

        cat_label = {"beauty": "美妆个护", "general": "全品类"}.get(category, category)
        price_band = signals.get("price_band") or ""
        price_range = price_band if price_band else "暂无可信号数据，建议先用联盟数据确认价格带"

        competition = self._derive_competition(signals) if signals else ""
        ratio = signals.get("avg_commission_ratio")
        # 真实信号派生卖点（确定性，不靠 LLM 编）
        selling: List[str] = []
        if price_band:
            selling.append(f"价格带{price_band}，内容种草易锚定价位")
        if competition in ("高", "中高"):
            selling.append("竞争激烈，需打细分人群差异化避免价格战")
        elif competition:
            selling.append(f"竞争{competition}，尚可正面入场")
        if ratio is not None:
            selling.append(f"平均佣金{ratio}%，变现效率可观")
        if not selling:
            selling = ["先小批量测品验证真实需求", "从细分人群切入避开红海", "绑定真实佣金/销量选品"]

        # 平台：美妆偏小红书+抖音；全品类加快手下沉；竞争高时补快手
        if category == "beauty":
            platforms: List[str] = ["xiaohongshu", "douyin"]
        else:
            platforms = ["douyin", "xiaohongshu", "kuaishou"]
        if competition in ("高", "中高") and "kuaishou" not in platforms:
            platforms.append("kuaishou")

        angles: List[str] = [
            f"成分/功效科普：讲清「{kw}」的核心成分与适用场景，建立专业信任",
            "真实测评对比：横向对比 2-3 款，突出性价比与差异点",
            "人群场景种草：绑定通勤/熬夜/换季等具体使用场景",
            "避坑指南：列出常见选购误区，降低用户决策成本",
        ]
        target = f"关注「{kw}」的 18-35 岁内容消费人群，愿为功效/成分与真实测评买单"
        if not signals:
            target = "内容平台 18-35 岁选品人群（暂无可信号，建议先测品）"

        return {
            "id": "dir_1",
            "directionName": kw,
            "category": cat_label,
            "priceRange": price_range,
            "targetUsers": target,
            "keySellingPoints": selling,
            "suitablePlatforms": platforms,
            "contentAngles": angles,
        }

    async def _generate_action_advice_card(self, user_question: str, category: str = "beauty") -> Dict:
        """执行建议卡（轻量步骤清单）：复用 next_actions 的真实商品/方向步骤逻辑，
        扁平化成 actionTitle + steps[]，对接前端 ActionAdvice 接口，让 ChatBubble 中原 death 的
        action_advice 分支变成可达。字段：actionTitle:str, steps:string[]。"""
        base = await self._generate_action_card(user_question, category=category)
        product = base.get("product") or "这个方向"
        now = base.get("now") or []
        this_week = base.get("this_week") or []
        next_week = base.get("next_week") or []
        steps: List[str] = []
        steps += [f"立即：{x}" for x in now]
        steps += [f"本周：{x}" for x in this_week]
        steps += [f"下周：{x}" for x in next_week]
        if not steps:
            steps = ["先用联盟数据看真实价格带/佣金", "挑 1-2 个细分人群测品", "小批量 50 单测 7 天记录转化",
                     "按 ROI 放量佣金≥15% 且月销稳定的款", "跑通后加预算，未跑通下架"]
        return {
            "actionTitle": f"{product}·落地执行清单",
            "steps": steps,
        }

    async def _resolve_direction_keyword(self, user_question: str, history: list = None, category: str = "beauty") -> str:
        """解析选品方向关键词：优先从当前问题提取；提取不到时，从对话历史回退。

        回退覆盖两类指代，确保「推荐这个方向的商品」类追问一定能拿到可搜词：
        1) 用户上一句就是具体方向（如「敏感肌精华最近哪个方向好」）→ 从历史 user 消息取词；
        2) 用户问得含糊（如「帮我选个方向」），真正方向是 AI 在上一条 assistant 回复里推荐的
           （如「建议做敏感肌修护」）→ 扫描 assistant 消息也能取到「敏感肌」；
        3) 方向很抽象（如「美妆个护里哪个细分品类增长最快」）beauty 词典无命中 → 退一步用 general
           模式剥掉提问词取剩余短语（「美妆个护」）去搜，宁可出泛方向商品卡也不空着。

        本函数是 async：词典命中走快路径；词典未命中（category=general 语义兜底）时用
        LLM 抽取真实商品/品类词（理解「鸡蛋/蓝牙耳机」等词典盲区），避免 product 对比卡搜到
        无关商品。同步抽词已由 extract_search_keyword 完成，此处仅在其未命中时叠加 LLM 兜底。

        关键（2026-08-27）：general 模式下 extract_search_keyword 的 _generic_keyword 粗剥词
        可能产生「结合网最新热度」这类残词（剥提问词时把状语也当产品词），词典会把它当"命中"返回。
        必须先校验词典词是否真实命中品类词库（brand/ptype/noun），命中才直接信；否则认为词典未命中，
        交给 LLM 语义抽取，LLM 失败再退回粗剥词兜底（保证不空，但优先语义正确）。"""
        # 1) 词典真实命中（品牌/品类/名词 + 非通用剥词）→ 直接返回
        kw = dict_hit_keyword(user_question)
        if kw:
            return kw
        # 2) 词典未真实命中 → LLM 语义兜底（理解自然语言里的真实商品/品类，跨词典盲区）
        if category == "general":
            llm_kw = await extract_search_keyword_async(user_question, category="general")
            if llm_kw:
                return llm_kw
            # LLM 失败 → 退回 general 粗剥词（保证搜词不空，但已尽力语义优先）
            fallback = extract_search_keyword(user_question, category="general")
            if fallback:
                return fallback
        if history:
            for m in reversed(history):
                if not isinstance(m, dict):
                    continue
                content = (m.get("content") or "").strip()
                if not content:
                    continue
                role = m.get("role")
                hkw = extract_search_keyword(content, category=category)
                if not hkw and role == "user":
                    # 仅 user 消息做 general 兜底（剥提问词取抽象方向的品类短语），
                    # assistant 消息偏噪声，只取 beauty 词典里的方向词，避免把闲聊喂进搜索
                    hkw = extract_search_keyword(content, category="general")
                if hkw:
                    return hkw
        return ""

    # 选品方向/商品词里的「宽泛/状语」词：抽词后用它们做标题相关度校验时剔除，
    # 避免「超级马里奥限定手办」被好单库宽匹配返成「超级洗衣机」这类无关品。
    _KW_NOISE = set("""
        超级 限定 手办 哪里 买 推荐 最新 热度 分析 现在 是否 值得 带货 好吗 好不好
        最近 怎么样 前景 行情 市场 机会 入场 这个 那个 一款 哪个 哪些 什么 我想要 我想做
        有没有 适合 新手 看看 帮我 请问 一下 一天 一年 过来 结合 网上 说 呢 吗 吧 啊
        爆 款 爆品 热卖 好卖 卖点 利润 佣金 销量 评价 口碑 趋势 方向 品类 选 上 做 卖
    """.split())

    # 大类方位词：用户搜「美妆个护/日化/食品」这类【方向】而非具体商品时，
    # 搜到的真实商品标题（如「遮瑕液」）不含方位词，不应被相关度校验误杀。
    _CATEGORY_WORDS: set = set("""
        美妆 个护 日化 日用 食品 零食 家电 数码 家居 母婴 玩具 图书 宠物 服饰 鞋靴
        箱包 运动 户外 健身 保健 医药 文具 厨具 卫浴 收纳 清洁 洗护 护理 彩妆 护肤
        饰品 珠宝 钟表 眼镜 汽车 五金 建材 绿植 生鲜 水果 蔬菜 粮油 调味 饮料 酒水
    """.split())

    def _kw_core(self, kw: str) -> List[str]:
        """从搜索词提取「实质词根」列表（剔除宽泛/状语词），用于商品标题相关度校验。
        - 返回非空：商品标题须命中任一实质词根才视为相关；
        - 返回空：说明整词都是宽泛词（如「美妆个护」这类方向短语），不做相关度钳制，
          避免把「敏感肌」「美妆」等泛方向词也剔没，导致该品的真实品类商品被误杀。
        每个实质段会展开其「≥2 字连续子串」，让「蓝牙耳机」也能靠「耳机」命中标题，
        避免整词不被标题完整包含就被误杀（好单库标题常只含品类短词如「耳机」）。
        若剩余段本身是【大类方位词】（美妆/个护/日用/食品/家电等，用户搜的是方向而非具体品），
        则视为宽泛、返回空 → 不钳制该方向的真实商品（避免「美妆个护」把「遮瑕液」误杀）。"""
        if not kw:
            return []
        parts = re.findall(r"[\u4e00-\u9fa5]{2,}", kw)
        seen: set = set()
        out: List[str] = []
        for p in parts:
            # 逐级剥掉噪声词，保留剩余名词片段
            seg = re.sub(r"|".join(map(re.escape, sorted(self._KW_NOISE, key=len, reverse=True))), "", p)
            seg = seg.strip()
            if len(seg) < 2:
                continue
            # 剩余段本身为「大类方位词」（用户搜「美妆个护」方向而非「防晒霜」具体品）→ 整词宽泛，不钳制
            if any(cat in seg for cat in self._CATEGORY_WORDS):
                return []
            # 展开 ≥2 字连续子串（蓝牙耳机 → 蓝牙/蓝牙耳机/牙耳机/耳机）
            for i in range(len(seg)):
                for j in range(i + 2, len(seg) + 1):
                    sub = seg[i:j]
                    if sub not in seen:
                        seen.add(sub)
                        out.append(sub)
        return out

    def _title_matches_kw(self, title: str, kw: str) -> bool:
        """商品标题与搜索词的相关度：标题须包含 kw 的任一实质词根（≥2 字）。
        - kw 无实质词根（全宽泛词如「美妆个护」）→ 通过（不钳制，避免误杀泛方向品类）；
        - 标题空 → 通过（交给上游 image/佣金门槛），不强杀无标题的线索（可能缺失 title 字段）。"""
        core = self._kw_core(kw)
        if not core:
            return True
        t = (title or "").replace(" ", "")
        # 标题任一实质词根命中即相关
        return any(c in t for c in core)

    async def _select_comparison_products(self, user_question: str, n: int = 6, category: str = "beauty", history: list = None) -> List[Dict]:
        """精选『可比商品对比集』：质量门槛 + 去重 + 确定性综合分 + 品牌多样 spread + 稳定 id。

        返回可直接 yield 成 card_type='product' 的 ProductCardItem 列表（每张附 pickReason）。
        """
        kw = await self._resolve_direction_keyword(user_question, history, category)
        if not kw:
            return []
        # 1) 拉大池（比最终展示多，才有挑选空间做 spread）。
        #    精确词无结果时逐级缩短（去尾部字）做宽泛兜底——避免「方向词太泛（如『美妆个护』）
        #    好单库搜不到」时空卡；缩短到『美妆』往往能命中真实商品。
        pool: List[Dict] = []
        tries = [kw]
        _t = kw
        while len(_t) > 2:
            _t = _t[:-1]
            tries.append(_t)
        for tk in tries:
            try:
                pool = await union_provider.search_products(keyword=tk, max_items=30, category=category)
            except Exception as e:
                print(f"[CARD] 对比商品取数失败: {e}")
                pool = []
            if pool:
                kw = tk
                break
        if not pool:
            return []
        # 2) 质量门槛：图片必填 + 佣金/销量至少其一（无图/无佣无销的卡只会拉低信任）
        pool = [
            l for l in pool
            if l.get("image") and (
                l.get("commission_money") is not None
                or l.get("commission_ratio") is not None
                or l.get("sales") is not None
            )
        ]
        # 2.5) 相关度校验：好单库对「超级马里奥限定手办」这类词常做宽匹配，把「超级洗衣机」
        #     也当成命中。这里只有标题命中关键词【实质词根】才保留，否则视为搜空 → 不返商品卡。
        #     注意缩短回退记录的是打中的词(kw=tk)，故用打中词校验。
        if self._kw_core(kw):
            pool = [l for l in pool if self._title_matches_kw(l.get("context") or l.get("title") or "", kw)]
        if not pool:
            return []
        # 3) 去重（itemid 优先，其次 link，再次标题）
        seen: set = set()
        dedup: List[Dict] = []
        for l in pool:
            key = l.get("itemid") or l.get("link") or l.get("context") or ""
            if key and key in seen:
                continue
            seen.add(key)
            dedup.append(l)
        # 4) 确定性综合分 + 5) 品牌多样 spread（保证高佣/高销/低价都有代表）
        scored = self._score_leads(dedup)
        chosen = self._pick_spread(scored, n)
        # 6) 稳定 id（itemid）+ pickReason → ProductCardItem
        cards: List[Dict] = []
        for lead, reason in chosen:
            card = self._to_product_card(lead, 0)
            card["id"] = self._stable_product_id(lead)
            card["pickReason"] = reason
            cards.append(card)
        return cards

    def _is_empty_product_card(self, card_type: str, card_data) -> bool:
        """搜空守门：判断某卡型是否因「没搜到真实商品」而不应下发。

        只对**依赖真实联盟搜索商品明细**的卡型生效：
          - product      ：card_data 是商品列表（_select_comparison_products 返回 List），空列表/空 dict → 搜空
          - hot_pick     ：card_data 是 dict，items[] 为空 → 无真实爆品
          - trend        ：card_data 是 dict，data[] 为空 → 无趋势数据
        其余摘要型卡（opportunity/data_insight/next_actions/risk/product_direction/action_advice）
        本质是「判断/建议」，不渲染商品明细，搜空时应正常下发（其内部已按低置信度降级文案），
        不回退成「删掉整张卡」——否则用户会看到「回答很硬核但没有卡」。
        """
        if card_type not in ("product", "hot_pick", "trend"):
            return False
        # product 卡：card_data 是列表
        if card_type == "product":
            if not card_data:
                return True
            if isinstance(card_data, (list, tuple)):
                return len(card_data) == 0
            if isinstance(card_data, dict):
                return not (card_data.get("items") or card_data.get("products") or card_data.get("data"))
            return False
        # hot_pick / trend：card_data 是 dict，看 items/data 是否为空
        if isinstance(card_data, dict):
            items = card_data.get("items") or card_data.get("data") or []
            return len(items) == 0
        return len(card_data) == 0 if isinstance(card_data, (list, tuple)) else False

    def _stable_product_id(self, lead: Dict) -> str:
        """稳定商品 id：用归一化 lead 的 itemid（好单库同商品追踪主键），跨问题一致→候选池幂等去重正确。
        无 itemid 时退化为 link/标题哈希，仍比原 prod_{idx} 稳定。"""
        iid = lead.get("itemid")
        if iid:
            return f"haodanku_{iid}"
        link = lead.get("link") or ""
        if link:
            return f"haodanku_{abs(hash(link))}"
        return f"haodanku_{abs(hash(lead.get('context') or ''))}"

    def _score_leads(self, leads: List[Dict]) -> List[tuple]:
        """确定性综合分（0-100）：佣金金额 + 销量 + 价格带契合（中低价更利于新商家测品切入）。"""
        comms = [l["commission_money"] for l in leads if l.get("commission_money") is not None]
        sales = [l["sales"] for l in leads if l.get("sales") is not None]
        prices = [l["price_value"] for l in leads if l.get("price_value") is not None]

        def _norm(v, arr):
            if not arr:
                return 0.0
            lo, hi = min(arr), max(arr)
            return 0.5 if hi == lo else (v - lo) / (hi - lo)

        scored = []
        for l in leads:
            s = 0.0
            if l.get("commission_money") is not None:
                s += 40 * _norm(l["commission_money"], comms)
            if l.get("sales") is not None:
                s += 35 * _norm(l["sales"], sales)
            if l.get("price_value") is not None and prices:
                # 价格越低越利于新商家切入，给高分
                s += 25 * (1 - _norm(l["price_value"], prices))
            scored.append((l, round(s, 1)))
        return scored

    def _lead_key(self, lead: Dict):
        return lead.get("itemid") or lead.get("link") or id(lead)

    def _pick_spread(self, scored: List[tuple], n: int) -> List[tuple]:
        """greedy 精选：先保底 3 个角色代表（最高佣/最高销/最低价），再按综合分贪心补，
        品牌不重复优先；最后放宽品牌限制补满 n 张。"""
        if not scored:
            return []
        best_comm = max(scored, key=lambda x: x[0].get("commission_money") or -1)
        best_sales = max(scored, key=lambda x: x[0].get("sales") or -1)
        best_price = min(scored, key=lambda x: x[0].get("price_value") or 1e18)
        # 角色代表按稳定 key 记录（dict 不可哈希，不能用 tuple 作 key）
        role_reason = {}
        for rep, tag in ((best_comm, "高佣金"), (best_sales, "高销量"), (best_price, "低价位")):
            role_reason[self._lead_key(rep[0])] = tag

        chosen: List[tuple] = []
        chosen_keys: set = set()
        reasons: Dict = {}
        for rep in (best_comm, best_sales, best_price):
            k = self._lead_key(rep[0])
            if k in chosen_keys:
                continue
            chosen_keys.add(k)
            chosen.append(rep)
            reasons[k] = role_reason[k]

        seen_brand = {(c[0].get("brand") or "").lower() for c in chosen}

        # 相对阈值（基于本批候选池），让 pickReason 真实反映『相比其他候选好在哪』
        comm_ratios = [l["commission_ratio"] for l, _ in scored if l.get("commission_ratio") is not None]
        sales_vals = [l["sales"] for l, _ in scored if l.get("sales") is not None]
        price_vals = [l["price_value"] for l, _ in scored if l.get("price_value") is not None]
        stats = {
            "comm_ratio_max": max(comm_ratios) if comm_ratios else 0.0,
            "sales_max": max(sales_vals) if sales_vals else 0.0,
            "price_min": min(price_vals) if price_vals else 0.0,
        }

        def _fill(prefer_brand_diverse: bool):
            for lead, score in sorted(scored, key=lambda x: -x[1]):
                if len(chosen) >= n:
                    return
                k = self._lead_key(lead)
                if k in chosen_keys:
                    continue
                brand = (lead.get("brand") or "").lower()
                if prefer_brand_diverse and brand and brand in seen_brand:
                    continue
                chosen.append((lead, score))
                chosen_keys.add(k)
                seen_brand.add(brand)
                reasons[k] = self._auto_reason(lead, stats)

        _fill(prefer_brand_diverse=True)   # 先尽量不同品牌
        _fill(prefer_brand_diverse=False)  # 还没满则放宽品牌限制补齐
        return [(lead, reasons.get(self._lead_key(lead), self._auto_reason(lead, stats))) for lead, score in chosen[:n]]

    def _auto_reason(self, lead: Dict, stats: Dict) -> str:
        """非角色保底卡的自动标签：相对本批候选池给可解释的『为什么进对比』。"""
        bits = []
        cmax = stats.get("comm_ratio_max") or 0.0
        smax = stats.get("sales_max") or 0.0
        pmin = stats.get("price_min") or 0.0
        if lead.get("commission_ratio") is not None and cmax and lead["commission_ratio"] >= cmax * 0.85:
            bits.append("高佣")
        if lead.get("sales") is not None and smax and lead["sales"] >= smax * 0.6:
            bits.append("高销")
        if lead.get("price_value") is not None and pmin and lead["price_value"] <= pmin * 1.3:
            bits.append("低价")
        if bits:
            return "/".join(bits)
        return "综合优选"

    async def _attach_cover(self, keyword: str) -> Optional[str]:
        """为好单库相关关键词取一张真实商品图，用作分析卡的配图（best-effort）。"""
        if not keyword:
            return None
        try:
            leads = await union_provider.search_products(keyword=keyword, max_items=1)
            for l in leads:
                if l.get("image"):
                    return l["image"]
        except Exception as e:
            print(f"[COVER] 取配图失败: {e}")
        return None

    # _generate_follow_up 已移除：续问改由 _deterministic_followups 确定性生成，省去每轮一次 LLM 调用。


ai_service = AIService()
