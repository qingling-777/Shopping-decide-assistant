import json
import asyncio
from typing import Any, Dict, List, Optional

from datetime import datetime
from pathlib import Path

from app.core.config import settings

# 测品计划 + 推广方案持久化：落本地 JSON（按 userId 分库），不引数据库。
# 与 candidate_service 同样的「DATA_DIR + 异步锁 + JSON 读写」模式，保证跨设备一致。
DATA_DIR = Path(__file__).resolve().parent.parent / "product_data"
PLANS_FILE = DATA_DIR / "test_plans.json"
PROMO_FILE = DATA_DIR / "promo_plans.json"

_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _load(file: Path) -> Dict[str, Any]:
    if not file.exists():
        return {}
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(file: Path, data: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class PlanService:
    """测品计划（test_plans）与独立推广方案库（promo_plans）的本地 JSON 存储。"""

    # ── 测品计划 ──
    def list_plans(self, user_id: str) -> List[Dict]:
        if not user_id:
            return []
        return _load(PLANS_FILE).get(user_id, [])

    async def sync_plans(self, user_id: str, plans: List[Dict]) -> int:
        """整列替换某用户的测品计划（幂等）。前端本地变更后 fire-and-forget 调用。"""
        if not user_id:
            return 0
        plans = plans or []
        async with _lock:
            data = _load(PLANS_FILE)
            data[user_id] = plans
            _save(PLANS_FILE, data)
        return len(plans)

    async def attach_plan_promo_strategy(
        self, user_id: str, plan_id: str, strategy: Dict[str, Any]
    ) -> bool:
        """把计划级整合推广策略写回某测品计划（后端权威副本，前端拉取时会合并进本地）。"""
        if not user_id or not plan_id or not strategy:
            return False
        async with _lock:
            data = _load(PLANS_FILE)
            lst = data.get(user_id, [])
            hit = False
            for pl in lst:
                if pl.get("id") == plan_id:
                    pl["promoStrategy"] = strategy
                    pl["updatedAt"] = _now_iso()
                    hit = True
                    break
            if not hit:
                return False
            data[user_id] = lst
            _save(PLANS_FILE, data)
            return True

    # ── 独立推广方案库（不挂测品计划时单独存）──
    def list_standalone_promo(self, user_id: str) -> List[Dict]:
        if not user_id:
            return []
        return _load(PROMO_FILE).get(user_id, [])

    async def save_standalone_promo(
        self,
        user_id: str,
        item: Dict[str, Any],
    ) -> List[Dict]:
        """保存一条推广方案（按 productId 去重：同一商品覆盖最新方案）。"""
        if not user_id or not item:
            return []
        pid = item.get("productId")
        if not pid:
            return []
        async with _lock:
            data = _load(PROMO_FILE)
            lst = data.get(user_id, [])
            # 同一商品已存则覆盖（保留最新），否则追加
            existed = False
            for i, it in enumerate(lst):
                if it.get("productId") == pid:
                    lst[i] = item
                    existed = True
                    break
            if not existed:
                lst.append(item)
            data[user_id] = lst
            _save(PROMO_FILE, data)
            return lst


plan_service = PlanService()
