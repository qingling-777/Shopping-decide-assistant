import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from fastapi.responses import HTMLResponse

from app.core.config import settings
from app.api.routes import chat, auth, candidates, plans, trends, billing, share, content, diagnose, feedback, tracking
from app.services.share_service import _share_service
from app.services.admin_service import render_admin_page

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    debug=settings.DEBUG
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 静态资源（支付收款码等真收钱资产，运营/部署时单独放置，不入 git）
_static_dir = Path(__file__).parent / "app" / "static"
_static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

app.include_router(chat.router, prefix=f"{settings.API_PREFIX}", tags=["chat"])
app.include_router(auth.router, prefix=f"{settings.API_PREFIX}")
app.include_router(candidates.router, prefix=f"{settings.API_PREFIX}", tags=["candidates"])
app.include_router(plans.router, prefix=f"{settings.API_PREFIX}", tags=["plans"])
app.include_router(trends.router, prefix=f"{settings.API_PREFIX}", tags=["trends"])
app.include_router(billing.router, prefix=f"{settings.API_PREFIX}", tags=["billing"])
app.include_router(share.router, prefix=f"{settings.API_PREFIX}", tags=["share"])
app.include_router(content.router, prefix=f"{settings.API_PREFIX}", tags=["content"])
app.include_router(diagnose.router, prefix=f"{settings.API_PREFIX}", tags=["diagnose"])
app.include_router(feedback.router, prefix=f"{settings.API_PREFIX}", tags=["feedback"])
app.include_router(tracking.router, prefix=f"{settings.API_PREFIX}", tags=["tracking"])


@app.get("/share/{share_id}", response_class=HTMLResponse)
def public_share_page(share_id: str):
    """公网分享页（获客飞轮落地页）：带溯源卡片图 + 保存图片 + 复制链接。"""
    return _share_service.render_public_page(share_id)


@app.get("/admin", response_class=HTMLResponse)
def admin_page():
    """运营管理后台：登录 + 待开通凭证核销/驳回 + 直接开通。所有写操作经 require_admin 鉴权。"""
    return render_admin_page()


async def _daily_crawl_task():
    """每天凌晨2点自动采集美妆市场数据"""
    from app.services.crawler_service import beauty_crawler
    while True:
        try:
            now = asyncio.get_event_loop().time()
            # 等到下一个整点后延迟，简化为每24小时跑一次
            await asyncio.sleep(24 * 60 * 60)
            print("[SCHEDULER] 开始自动采集美妆市场数据...")
            await beauty_crawler.crawl_all()
            print("[SCHEDULER] 自动采集完成")
        except Exception as e:
            print(f"[SCHEDULER] 定时任务出错: {e}")
            await asyncio.sleep(60)  # 出错后1分钟重试


async def _trend_poll_task():
    """B 档：每 6 小时重查近期出现过的选品关键词，把好单库当日快照写入趋势库。

    这样即使没有商家实时浏览，时间序列也会持续生长；配合 union_service 在每次搜索时
    落快照，双保险。无好单库 key 时 search_products 返回空，record_leads 为 no-op。
    """
    from app.services import trend_service
    from app.services.union_service import union_provider
    while True:
        try:
            await asyncio.sleep(6 * 60 * 60)
            print("[TREND POLL] 开始重查近期关键词以更新趋势库...")
            for kw in trend_service.distinct_keywords(limit=20):
                leads = await union_provider.search_products(keyword=kw, max_items=12)
                trend_service.record_leads(kw, leads)
            print("[TREND POLL] 趋势库更新完成")
        except Exception as e:
            print(f"[TREND POLL] 出错: {e}")
            await asyncio.sleep(300)


async def _hot_pick_prefetch_task():
    """爆品榜预拉（方案 A）：每 30 分钟拉一帧多榜单专题矩阵存内存兜底。

    目的：
      - 关注公众号的用户每次问「爆品榜」能拿到**不一样的最新版**（缓存 TTL 30s 负责「每次更新」，
        但接口抖动时靠这帧兜底，「有的是不同版本」依然成立）；
      - 平时用 TTL 缓存控频（≤120 次/时打大淘客，避免 720 次/天触发限流），
        预拉本身也复用该缓存（真实网络调用被压到每 30 分钟一次全量）。
    """
    from app.services.dataoke_service import _prefetch_hot_pick_matrix
    while True:
        try:
            await asyncio.sleep(settings.HOT_PICK_PREFETCH_INTERVAL)
            print("[HOT PICK PREFETCH] 开始预拉爆品矩阵（每30分钟）...")
            mat = await _prefetch_hot_pick_matrix()
            print(f"[HOT PICK PREFETCH] 预拉完成，列数={len(mat.get('columns', [])) if mat else 0}")
        except Exception as e:
            print(f"[HOT PICK PREFETCH] 出错: {e}")
            await asyncio.sleep(300)


@app.on_event("startup")
async def startup_event():
    from app.services.crawler_service import beauty_crawler
    from pathlib import Path

    print("=" * 60)
    print(f"[START] {settings.APP_NAME} v{settings.APP_VERSION}")
    print(f"[DOCS]  http://localhost:8082/docs")
    print(f"[API]   http://localhost:8082{settings.API_PREFIX}/health")
    print("=" * 60)

    # 启动时检查是否有今天的数据，没有则立即采集
    data_dir = Path("app/crawled_data")
    from datetime import datetime
    today_file = data_dir / f"beauty_data_{datetime.now().strftime('%Y%m%d')}.json"
    if not today_file.exists():
        print("[STARTUP] 未找到今日数据，开始初始采集...")
        asyncio.create_task(beauty_crawler.crawl_all())
    else:
        print("[STARTUP] 今日数据已存在，跳过采集")

    # 启动定时任务
    asyncio.create_task(_daily_crawl_task())
    print("[SCHEDULER] 定时采集任务已启动（每24小时更新一次）")

    # 启动 B 档趋势轮询（每6小时重查近期关键词，持续累积销量/价格时间序列）
    asyncio.create_task(_trend_poll_task())
    print("[TREND POLL] 趋势轮询任务已启动（每6小时更新一次）")

    # 启动爆品榜预拉（方案 A：每30分钟拉一帧专题矩阵存内存兜底，配合 TTL 30s 缓存实现「每次拿到最新版」）
    asyncio.create_task(_hot_pick_prefetch_task())
    print("[HOT PICK PREFETCH] 爆品榜预拉任务已启动（每30分钟更新一次）")

    # 启动时清理过期动态知识
    from app.services.ingestion_service import ingestion_service
    cleanup_result = ingestion_service.cleanup_expired()
    if cleanup_result["removed"] > 0:
        print(f"[STARTUP] 清理过期动态知识 {cleanup_result['removed']} 条")
        knowledge_service.refresh()

    # 预热「机会方向」缓存（6h 窗口）：让首个用户请求直接命中缓存，避免冷启动好单库取数阻塞首屏（任务 #106）
    from app.services.opportunity_service import build_opportunity_directions_from_union
    asyncio.create_task(build_opportunity_directions_from_union())
    print("[STARTUP] 机会方向缓存预热任务已启动")


@app.get("/")
async def root():
    return {
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "status": "running",
        "docs": "/docs",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8082,
        reload=False
    )
