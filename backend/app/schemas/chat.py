from pydantic import BaseModel
from typing import Optional, Any, Dict


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []
    user_id: Optional[str] = None
    # 品类模式：beauty=美妆专业问答(带美妆RAG)；general=全品类宽泛问答(带佣金/联盟通用知识)。
    # 默认 general 对齐新前端（HomeScreen 默认 category='general'，全品类选品是主场景）；
    # 路由用 `category or "general"` 兜底，故默认值改为 general 后非美妆问题不再被 beauty 兜底吃住。
    category: Optional[str] = "general"
    # 受众模式：C=消费者端/个人带货（达人、内容创作者，默认）；B=商家企业端/招商铺货（品牌方、工厂、产业带、渠道招商）。
    # 决定 AI 回答的视角与话术侧重（C端偏种草/佣金玩法，B端偏招商/铺货/供应链）。
    audience: Optional[str] = "C"
    # 模型品牌：auto=沿用默认（当前默认开推理→R1）；deepseek=DeepSeek V3；qwen=Qwen2.5；r1=DeepSeek-R1 推理。
    # 后端按品牌解析具体模型 + 兜底链（见 ai_service.MODEL_BRANDS）。
    model: Optional[str] = None


class ShoppingIntent(BaseModel):
    intent: str  # "price_compare" | "product_advice" | "chat"
    product_name: Optional[str] = None
    product_keywords: list[str] = []
    platforms: list[str] = ["taobao", "jd", "pdd"]
    reply: str


class ChatResponse(BaseModel):
    message: str
    card_type: Optional[str] = None  # "product_decision" | None
    card_data: Optional[Any] = None
    # 计费回执（硅基流动风格透明计费）：本次主回答用了什么模型、多少 token、花费多少、是否免费
    usage: Optional[Dict] = None
