from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from typing import Dict, List
from app.deps import get_current_user, get_identity, require_quota, require_admin
from pydantic import BaseModel
from app.schemas.chat import ChatRequest, ChatResponse
from app.services.ai_service import ai_service
from app.services.knowledge_service import knowledge_service
from app.services.crawler_service import beauty_crawler
from app.services.ingestion_service import ingestion_service
from app.services.product_service import product_service
from app.services.subscription_service import _subscription_service
from app.services import chat_history_service
from app.core.config import settings
from app.services.opportunity_service import build_opportunity_directions_from_union
from app.services.spotlight_service import build_spotlight_products
from app.services.dataoke_service import (
    get_top100,
    rank_center_tabs,
    get_rank_center_items,
    search_suggestion,
    get_friends_circle_list,
)
from app.schemas.product_import import ProductImportRequest, ProductImportResponse, ProductRecord
import asyncio
import json
import secrets

router = APIRouter()


# ── 对话历史持久化（仅登录用户；匿名仍走前端 localStorage）──
class SessionSaveRequest(BaseModel):
    session_id: str
    title: str = ""
    messages: List[Dict] = []


def _user_subject(user: Dict) -> str:
    return f"user:{user['id']}"


@router.get("/chat/sessions")
async def list_sessions(user: Dict = Depends(get_current_user), limit: int = Query(200, le=500)):
    """我的历史会话列表（登录后跨设备可见）。"""
    return {"items": chat_history_service.list_sessions(_user_subject(user), limit=limit)}


@router.get("/chat/sessions/{session_id}")
async def get_session(session_id: str, user: Dict = Depends(get_current_user)):
    """单会话完整内容（含 messages，切换会话时恢复）。"""
    item = chat_history_service.get_session(_user_subject(user), session_id)
    if not item:
        raise HTTPException(status_code=404, detail="会话不存在")
    return item


@router.put("/chat/sessions/{session_id}")
async def save_session(session_id: str, body: SessionSaveRequest, user: Dict = Depends(get_current_user)):
    """保存/覆盖一个会话（幂等 upsert，前端每次消息变化全量保存）。"""
    chat_history_service.upsert_session(
        _user_subject(user), body.session_id or session_id, body.title, body.messages
    )
    return {"status": "ok"}


@router.delete("/chat/sessions/{session_id}")
async def delete_session(session_id: str, user: Dict = Depends(get_current_user)):
    """删除一个会话。"""
    ok = chat_history_service.delete_session(_user_subject(user), session_id)
    return {"status": "ok" if ok else "not_found"}


@router.delete("/chat/sessions")
async def clear_sessions(user: Dict = Depends(get_current_user)):
    """清空我的全部历史会话。"""
    count = chat_history_service.clear_sessions(_user_subject(user))
    return {"status": "ok", "deleted": count}


class IngestUrlRequest(BaseModel):
    url: str
    source_label: str = ""


class IngestTextRequest(BaseModel):
    text: str
    source_label: str = ""


class PrivilegeLinkRequest(BaseModel):
    """按需懒加载转链：用户点「转发赚佣」时才调，避免批量预取打爆大淘客 200次/分限速。不占卡片配额。"""
    goodsId: str
    couponId: str | None = None


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest,
                      identity: Dict = Depends(get_identity),
                      _: None = Depends(require_quota)):
    chat_subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    request_id = secrets.token_hex(16)
    # 商户隔离：当前登录用户 → user:<id>；否则匿名设备 → device:<id>。
    # 该主体决定顾问回答里只参考「本人自喂的知识 + 全局静态底库」，不泄露其他商户资料。
    owner = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    # 匿名不产卡片；登录且（余额>0 或 今日免费额度内）才产卡片，与 require_quota 闸门一致。
    # 修复：新用户 0 元 + 免费额度内也能解锁卡片（此前只判 has_balance 导致免费用户出不了卡）。
    allow_cards = bool(identity["user_id"]) and _subscription_service.can_use_cards(chat_subject)

    async def generate():
        try:
            card_count = 0
            usage_info = None  # 用量回执（来自 ai_service 的 usage chunk：chat + cards）
            async for chunk in ai_service.analyze_beauty_opportunity_stream(
                user_question=request.message,
                history=request.history,
                emit_cards=allow_cards,
                owner=owner,
                category=request.category or "general",
                audience=request.audience or "C",
                model=request.model,
            ):
                # 内部用量回执：捕获主回答 + 卡片 token，供下方 record_usage 计费（不下发给前端）
                if chunk.get("type") == "usage":
                    usage_info = chunk
                    continue
                # 单品诊断卡（link_diagnosis）是核心诊断功能，不计入「选品情报卡」配额
                if chunk.get("type") == "card" and chunk.get("card_type") != "link_diagnosis":
                    card_count += 1
                yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            # 方案 A：匿名 / 额度耗尽时不下发卡但下发一条提示，消除「为什么这次没卡」的静默困惑。
            # 已登录且在免费额度内不再提示（能正常出卡）；只剩「余额不足」与「匿名未登录」两种情况。
            if not allow_cards:
                if identity["user_id"]:
                    # 已登录但免费额度耗尽且余额不足 → 提示充值解锁
                    hint_chunk = {
                        "type": "card_hint",
                        "content": "今日免费额度已用完，充值后可继续解锁实时佣金 / 竞争 / 价格带情报卡片",
                    }
                else:
                    # 匿名用户：卡片仅登录后可见 → 提示登录解锁
                    hint_chunk = {
                        "type": "card_hint",
                        "content": "登录后即可解锁实时佣金 / 竞争 / 价格带情报卡片",
                    }
                yield f"data: {json.dumps(hint_chunk, ensure_ascii=False)}\n\n"
        except Exception as error:
            # ⚠️ 2026-08-28 工程审查 P1 修复：原实现把 str(error) 原文发给前端（内部路径/模型名/第三方报错全暴露）。
            # 客户端只收固定文案，细节仅打服务端日志。
            print(f"[CHAT-STREAM] 流式回答异常: {error}")
            error_chunk = {"type": "error", "content": "回答生成失败，请稍后重试"}
            yield f"data: {json.dumps(error_chunk, ensure_ascii=False)}\n\n"
        finally:
            # 计费埋点：主回答按 token 精确计费（每日免费额度内免扣，超额扣余额 gift→paid）
            try:
                chat_usage = (usage_info or {}).get("chat") if usage_info else None
                model = (chat_usage or {}).get("model") if chat_usage else None
                tokens_in = (chat_usage or {}).get("tokens_in", 0) if chat_usage else 0
                tokens_out = (chat_usage or {}).get("tokens_out", 0) if chat_usage else 0
                tokens_cached = (chat_usage or {}).get("tokens_cached", 0) if chat_usage else 0
                receipt = _subscription_service.record_usage(
                    chat_subject, "chat", model or "", tokens_in=tokens_in, tokens_out=tokens_out,
                    tokens_cached=tokens_cached, model_brand=request.model, request_id=request_id,
                )
                billing_receipt = {
                    "type": "billing",
                    "model": receipt.get("model") or model,
                    "model_brand": receipt.get("model_brand") or request.model,
                    "tokens_in": receipt.get("tokens_in"),
                    "tokens_out": receipt.get("tokens_out"),
                    "tokens_cached": receipt.get("tokens_cached"),
                    "cost_yuan": receipt.get("cost_yuan"),
                    "is_free": receipt.get("is_free"),
                    "balance_after": receipt.get("balance_after"),
                    "free_remaining": receipt.get("free_remaining"),
                }
                yield f"data: {json.dumps(billing_receipt, ensure_ascii=False)}\n\n"
                # 卡片 LLM 内部核算事件（不计免费额度、不扣用户余额，仅落平台成本供运营报表）
                for card_u in ((usage_info or {}).get("cards") or []):
                    try:
                        cu = card_u.get("usage") or {}
                        _subscription_service.record_usage(
                            chat_subject, "card_llm", card_u.get("model") or "",
                            tokens_in=int(cu.get("prompt_tokens") or 0),
                            tokens_out=int(cu.get("completion_tokens") or 0),
                            model_brand=request.model, internal=True, request_id=request_id,
                            meta=f"event=opportunity_card",
                        )
                    except Exception as card_err:
                        print(f"[BILLING] 卡片内部核算失败(降级跳过): {card_err}")
            except Exception as error:
                print(f"[BILLING] 主回答计费失败(降级不阻断): {error}")
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat")
async def chat(request: ChatRequest,
               identity: Dict = Depends(get_identity),
               _: None = Depends(require_quota)):
    chat_subject = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    owner = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    request_id = secrets.token_hex(16)
    allow_cards = bool(identity["user_id"]) and _subscription_service.can_use_cards(chat_subject)
    chat_stats: Dict = {}
    try:
        result = await ai_service.analyze_beauty_opportunity(
            user_question=request.message,
            history=request.history,
            emit_cards=allow_cards,
            owner=owner,
            category=request.category or "general",
            audience=request.audience or "C",
            stats=chat_stats,
        )
        # 免费登录用户（无余额、仅靠免费额度）每轮产卡计 1 次；会员/匿名/有余额付费用户不计。单品诊断卡不计入配额
        if (result.get("card_type") and result.get("card_type") != "link_diagnosis"
                and identity["user_id"] and not _subscription_service.has_balance(chat_subject)):
            try:
                _subscription_service.consume_card(identity["user_id"])
            except Exception:
                pass
        # 计费埋点：主回答按 token 精确计费（每日免费额度内免扣，超额扣余额）
        usage_receipt = None
        try:
            cu = chat_stats.get("chat_usage") or {}
            model = chat_stats.get("chat_model")
            receipt = _subscription_service.record_usage(
                chat_subject, "chat", model or "", tokens_in=int(cu.get("prompt_tokens") or 0),
                tokens_out=int(cu.get("completion_tokens") or 0),
                tokens_cached=int(cu.get("prompt_cache_hit_tokens") or 0),
                model_brand=request.model, request_id=request_id,
            )
            usage_receipt = {
                "model": receipt.get("model") or model,
                "model_brand": receipt.get("model_brand") or request.model,
                "tokens_in": receipt.get("tokens_in"),
                "tokens_out": receipt.get("tokens_out"),
                "tokens_cached": receipt.get("tokens_cached"),
                "cost_yuan": receipt.get("cost_yuan"),
                "is_free": receipt.get("is_free"),
                "balance_after": receipt.get("balance_after"),
                "free_remaining": receipt.get("free_remaining"),
            }
            # 卡片 LLM 内部核算事件
            for card_u in (chat_stats.get("card_usages") or []):
                try:
                    ccu = card_u.get("usage") or {}
                    _subscription_service.record_usage(
                        chat_subject, "card_llm", card_u.get("model") or "",
                        tokens_in=int(ccu.get("prompt_tokens") or 0),
                        tokens_out=int(ccu.get("completion_tokens") or 0),
                        model_brand=request.model, internal=True, request_id=request_id,
                        meta="event=opportunity_card",
                    )
                except Exception as card_err:
                    print(f"[BILLING] 卡片内部核算失败(降级跳过): {card_err}")
        except Exception as berr:
            print(f"[BILLING] 非流式计费失败(降级不阻断): {berr}")
        return ChatResponse(
            message=result["message"],
            card_type=result.get("card_type"),
            card_data=result.get("card_data"),
            usage=usage_receipt,
        )
    except Exception as error:
        print(f"Error in chat endpoint: {error}")
        # 2026-08-28 工程审查 P1 修复：不再回传 str(error)（内部路径/模型名/第三方报错细节）
        raise HTTPException(status_code=500, detail="处理消息时出错，请稍后重试")


@router.get("/opportunities")
async def get_opportunities():
    """返回基于真实联盟商品数据（好单库）推导的美妆机会方向"""
    try:
        return await build_opportunity_directions_from_union()
    except Exception as error:
        print(f"[OPPORTUNITIES] 机会评分失败: {error}")
        raise HTTPException(status_code=500, detail="机会评分失败，请稍后重试")


@router.get("/debug/mapping-health")
async def mapping_health(admin: Dict = Depends(require_admin)):
    """好单库字段映射真值校验（上线前/运维自检）。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：此前完全无鉴权，任何人可调；现仅管理员。
    """
    from app.services.union_service import validate_field_mappings
    return await validate_field_mappings()


@router.get("/products/spotlight")
async def get_spotlight(
    keyword: str = Query("", description="类目/角度关键词，非空则直接搜该类目（不再锁美妆）"),
    platform: str = Query("", description="平台筛选：淘宝 / 天猫，空为不限"),
    category: str = Query("general", description="App 模式：beauty 美妆 / general 全品类，决定无关键词时的默认池"),
):
    """首页「实时选品参考」：按类目关键词 + 平台实时抽取真实在售商品，每 2 小时随机刷新"""
    try:
        return await build_spotlight_products(keyword=keyword, platform=platform, category=category)
    except Exception as error:
        print(f"[SPOTLIGHT] 爆品抽选失败: {error}")
        raise HTTPException(status_code=500, detail="爆品抽选失败，请稍后重试")


@router.get("/products/hot-words")
async def get_hot_words():
    """首页快捷问题「跟爆款」组用：实时热搜词（买家榜 + 淘客榜），来源大淘客 get-top100。失败降级空列表。"""
    try:
        buyer_words, taobao_words = await asyncio.gather(get_top100(1), get_top100(2))
        return {"buyer": buyer_words, "taobao": taobao_words}
    except Exception as error:
        print(f"[HOT-WORDS] 热搜词获取失败: {error}")
        raise HTTPException(status_code=500, detail="热搜词获取失败，请稍后重试")


@router.get("/products/rankings")
async def get_rankings(
    type: int = Query(1, description="榜单类型 rankType（1实时爆品/15低价高佣/14大牛爆单/9社群爆品/7综合热搜/12美妆集散）"),
):
    """榜单中心：按榜单类型拉取真实联盟在售商品（复用大淘客 get-ranking-list + 归一化）。

    返回顶部 tab 元数据（rank_center_tabs）与当前榜商品列表（与爆品卡同字段，可直接渲染）。
    榜单名由后端按实测数据特征校准，避免前端标错。失败降级空列表 + 元数据。
    """
    try:
        tabs = rank_center_tabs()
        items = await get_rank_center_items(rank_type=type)
        meta = next((t for t in tabs if t["type"] == type), None)
        return {"tabs": tabs, "type": type, "rank_title": (meta or {}).get("title", ""), "items": items}
    except Exception as error:
        print(f"[RANKINGS] 榜单获取失败 type={type}: {error}")
        raise HTTPException(status_code=500, detail="榜单获取失败，请稍后重试")


@router.get("/products/search-suggestions")
async def get_search_suggestions(
    keyword: str = Query("", description="搜索关键词，用于拉大淘客联想词"),
    suggest_type: int = Query(1, ge=1, le=3, description="联想词来源：1大淘客/2联盟/3超级"),
):
    """搜索联想词：把用户当前热词展开成更细的切片，便于直接找品。"""
    if not keyword.strip():
        return {"keyword": "", "type": suggest_type, "items": [], "source": "大淘客"}
    try:
        items = await search_suggestion(keyword, suggest_type=suggest_type)
        return {"keyword": keyword, "type": suggest_type, "items": items, "source": "大淘客"}
    except Exception as error:
        print(f"[SUGGESTIONS] 联想词获取失败 keyword={keyword}: {error}")
        raise HTTPException(status_code=500, detail="搜索联想词获取失败，请稍后重试")


@router.get("/products/friends-circle")
async def get_friends_circle(limit: int = Query(6, ge=1, le=20)):
    """朋友圈/社群现成文案：用于内容页直接取一句可发素材。"""
    try:
        items = await get_friends_circle_list(page_id=1, page_size=max(limit * 2, 10))
        return {"items": items[:limit], "source": "大淘客"}
    except Exception as error:
        print(f"[FRIENDS-CIRCLE] 文案获取失败: {error}")
        raise HTTPException(status_code=500, detail="朋友圈文案获取失败，请稍后重试")


@router.post("/products/import", response_model=ProductImportResponse)
async def import_product(request: ProductImportRequest, identity: Dict = Depends(get_identity)):
    """商品导入（登录用户可用）。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：此前完全无鉴权；import_url 有外部抓取成本，现要求登录。
    """
    try:
        product = await product_service.import_url(request.url)
        return {"status": "ok", "product": product}
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@router.get("/products")
async def list_products():
    return {"items": product_service.list_products()}


@router.post("/products/privilege-link")
async def privilege_link(request: PrivilegeLinkRequest, identity: Dict = Depends(get_identity)):
    """按需懒加载转链（C 端佣金变现关键入口）：goodsId -> 带 pid 的推广链接。

    用户在卡片上点「转发赚佣」时才调本接口，走大淘客 get_privilege_link。
    受淘宝授权门控：未授权时返回 data=None（前端提示「授权已过期」），不报错。
    不消耗卡片配额、不计数，纯变现动作。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：此前完全无鉴权，任何人可消耗联盟 PID 转链额度；现要求登录。
    """
    from app.services.dataoke_service import get_privilege_link
    try:
        data = await get_privilege_link(request.goodsId, coupon_id=request.couponId)
    except Exception as error:
        print(f"[PRIVILEGE-LINK] 转链异常: {error}")
        # 2026-08-28 工程审查 P1 修复：error 字段不再回传内部细节
        return {"success": False, "data": None, "error": "转链失败，请稍后重试"}
    return {"success": True, "data": data}


@router.get("/health")
async def health_check():
    return {
        "status": "ok",
        "message": "美妆选品助手后端正常运行",
        "knowledge_documents": len(knowledge_service.documents),
    }


@router.post("/knowledge/reload")
async def reload_knowledge(admin: Dict = Depends(require_admin)):
    """重载知识库（管理维护操作）。⚠️ 2026-08-28 P0-3 修复：此前无鉴权，现仅管理员。"""
    try:
        old_count = len(knowledge_service.documents)
        knowledge_service.refresh()
        new_count = len(knowledge_service.documents)
        return {"status": "ok", "message": "知识库已重新加载", "old_count": old_count, "new_count": new_count}
    except Exception as error:
        print(f"[KNOWLEDGE] 重载失败: {error}")
        raise HTTPException(status_code=500, detail="重新加载知识库时出错，请稍后重试")


@router.post("/crawler/run")
async def run_crawler(admin: Dict = Depends(require_admin)):
    """手动触发爬虫，采集公开美妆数据（有外部 API 成本）。

    ⚠️ 2026-08-28 P0-3 修复：此前无鉴权，任何人可触发消耗外部配额；现仅管理员。
    """
    try:
        data = await beauty_crawler.crawl_all()
        categories = data.get("categories", {})
        total = sum(len(v) for v in categories.values())
        return {
            "status": "ok",
            "message": f"爬取完成，共采集 {total} 条美妆市场数据",
            "summary": {tag: len(items) for tag, items in categories.items()}
        }
    except Exception as error:
        print(f"[CRAWLER] 爬取失败: {error}")
        raise HTTPException(status_code=500, detail="爬取失败，请稍后重试")


@router.get("/crawler/data")
async def get_crawler_data(admin: Dict = Depends(require_admin)):
    """读取爬虫数据（内部维护）。⚠️ 2026-08-28 P0-3 修复：现仅管理员。"""
    try:
        data = beauty_crawler.load_latest()
        if not data:
            return {"status": "empty", "message": "还没有爬取数据，请先调用 /crawler/run"}
        return {"status": "ok", "data": data}
    except Exception as error:
        print(f"[CRAWLER] 读取数据失败: {error}")
        raise HTTPException(status_code=500, detail="读取爬虫数据失败，请稍后重试")


# ─────────────────────────────────────────
# 知识摄取接口
# ─────────────────────────────────────────

@router.post("/knowledge/ingest/url")
async def ingest_url(request: IngestUrlRequest, identity: Dict = Depends(get_identity)):
    """从URL摄取知识（博主文章、测评页面等）；按当前商户主体隔离"""
    owner = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    try:
        result = await ingestion_service.ingest_url(request.url, source_label=request.source_label, owner=owner)
        if result["status"] == "ok":
            knowledge_service.refresh()
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as error:
        print(f"[KNOWLEDGE] 摄取失败: {error}")
        raise HTTPException(status_code=500, detail="摄取失败，请稍后重试")


@router.post("/knowledge/ingest/text")
async def ingest_text(request: IngestTextRequest, identity: Dict = Depends(get_identity)):
    """从纯文本摄取知识（视频文字稿、手动摘要等）；按当前商户主体隔离"""
    owner = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    try:
        result = await ingestion_service.ingest_text(request.text, source_label=request.source_label, owner=owner)
        if result["status"] == "ok":
            knowledge_service.refresh()
        return result
    except Exception as error:
        print(f"[KNOWLEDGE] 摄取失败: {error}")
        raise HTTPException(status_code=500, detail="摄取失败，请稍后重试")


@router.get("/knowledge/dynamic")
async def list_dynamic_knowledge(identity: Dict = Depends(get_identity)):
    """查看当前商户自喂的动态知识条目及过期状态（仅本人可见）"""
    owner = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    items = ingestion_service.list_dynamic(owner=owner)
    active = [i for i in items if i["status"] == "active"]
    expired = [i for i in items if i["status"] == "expired"]
    return {
        "total": len(items),
        "active": len(active),
        "expired": len(expired),
        "items": items,
    }


@router.post("/knowledge/cleanup")
async def cleanup_knowledge(admin: Dict = Depends(require_admin)):
    """清理过期的动态知识条目（全局维护任务，按过期时间而非商户）。

    ⚠️ 2026-08-28 工程审查 P0-3 修复：此前完全无鉴权，任何人可删除全局知识；现仅管理员。
    """
    result = ingestion_service.cleanup_expired()
    if result["removed"] > 0:
        knowledge_service.refresh()
    return {
        "status": "ok",
        "message": f"清理完成：删除 {result['removed']} 条过期知识，保留 {result['kept']} 条",
        **result,
    }


@router.delete("/knowledge/dynamic/{knowledge_id}")
async def delete_dynamic_knowledge(knowledge_id: str, identity: Dict = Depends(get_identity)):
    """手动删除某条动态知识（仅创建者本人可删，其他商户删返回 403）"""
    owner = f"user:{identity['user_id']}" if identity["user_id"] else f"device:{identity['device_id']}"
    outcome = ingestion_service.delete_dynamic(knowledge_id, owner=owner)
    if outcome == "not_found":
        raise HTTPException(status_code=404, detail="知识条目不存在")
    if outcome == "forbidden":
        raise HTTPException(status_code=403, detail="无权删除其他商户的知识条目")
    knowledge_service.refresh()
    return {"status": "ok", "message": f"已删除 {knowledge_id}"}
