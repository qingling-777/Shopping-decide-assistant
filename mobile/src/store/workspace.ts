import { create } from 'zustand'
import { Platform } from 'react-native'
import { ProductCardItem } from '../utils/types'

/**
 * 用户工作区（选品工作台）状态。
 * 按 userId 分库存储：pool（商品池/自动归档）、favorites（收藏商品 id）、plans（测品计划）。
 * 持久化：因未安装 @react-native-async-storage/async-storage，
 * web 端用 localStorage，native 端用内存（进程内有效）。
 */

export interface SavedProduct {
  id: string
  brand: string
  title: string
  image: string
  priceText: string
  commissionRatio?: number | null
  commissionMoney?: number | null
  sales?: number | null
  link: string
  couponInfo?: string
  detailUrl?: string
  source?: string
  favorited: boolean
  favoritedAt?: number
  archivedAt: number
}

export type PlanStatus = 'planning' | 'testing' | 'done' | 'paused'

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  planning: '待启动',
  testing: '测品中',
  done: '已完成',
  paused: '已暂停',
}

export interface TestPlan {
  id: string
  name: string
  direction?: string
  note?: string
  status: PlanStatus
  productIds: string[]
  promoPlans?: Record<string, any>
  promoStrategy?: any
  createdAt: number
  updatedAt: number
}

interface UserWorkspace {
  pool: SavedProduct[]
  favorites: string[]
  plans: TestPlan[]
}

interface WorkspaceState {
  workspaces: Record<string, UserWorkspace>

  // 自动归档：把聊天里出现的商品卡合并进商品池（按 id 去重，保留已收藏状态）
  archiveProducts: (userId: string, items: ProductCardItem[]) => void
  // 从商品池移除（取消归档）
  removeProduct: (userId: string, productId: string) => void
  // 收藏切换
  toggleFavorite: (userId: string, productId: string) => void
  // 计划
  addPlan: (userId: string, payload: { name: string; direction?: string; note?: string }) => TestPlan
  addProductToPlan: (userId: string, planId: string, productId: string) => void
  removeProductFromPlan: (userId: string, planId: string, productId: string) => void
  updatePlanStatus: (userId: string, planId: string, status: PlanStatus) => void
  removePlan: (userId: string, planId: string) => void
  // 后端拉取后合并到本地（按 id 去重，优先 updatedAt 较新者，合并 promoPlans）。
  // 关键：绝不删除本地已有的乐观写入计划，避免「打开即拉取」把刚新建的计划覆盖掉。
  mergePlans: (userId: string, plans: TestPlan[]) => void
  // 把一条推广方案挂到某测品计划的指定商品上（闭环：生成方案 → 存入测品计划）
  attachPromoToPlan: (userId: string, planId: string, productId: string, plan: any) => void
  // 把计划级整合推广策略挂到某测品计划（闭环：生成策略 → 存入测品计划）
  attachPlanPromoStrategy: (userId: string, planId: string, strategy: any) => void
}

const STORAGE_KEY = 'sa_workspace_v1'

function emptyWorkspace(): UserWorkspace {
  return { pool: [], favorites: [], plans: [] }
}

function loadWorkspaces(): Record<string, UserWorkspace> {
  if (Platform.OS !== 'web') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persistWorkspaces(workspaces: Record<string, UserWorkspace>) {
  if (Platform.OS !== 'web') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces))
  } catch {
    // 存储不可用时静默忽略（内存态仍可用）
  }
}

function getUserWs(state: WorkspaceState, userId: string): UserWorkspace {
  return state.workspaces[userId] || emptyWorkspace()
}

function withUserWs(
  state: WorkspaceState,
  userId: string,
  next: UserWorkspace,
): Partial<WorkspaceState> {
  const workspaces = { ...state.workspaces, [userId]: next }
  persistWorkspaces(workspaces)
  return { workspaces }
}

/**
 * 合并两条同 id 计划：优先 updatedAt 较新者作为基底，promoPlans 双向合并（不丢任一侧方案）。
 * 用于后端拉取与本地乐观写入的协调，保证新建/编辑不被「打开即拉取」的快照覆盖。
 */
function mergePlan(local: TestPlan, remote: TestPlan): TestPlan {
  const localNewer = (local.updatedAt || 0) >= (remote.updatedAt || 0)
  const base = localNewer ? local : remote
  const promoPlans = { ...(remote.promoPlans || {}), ...(local.promoPlans || {}) }
  // promoStrategy：任一侧非空都保留（避免「打开即拉取」把刚生成的计划级策略清掉）
  const promoStrategy = local.promoStrategy || remote.promoStrategy || undefined
  return { ...base, promoPlans, promoStrategy }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: loadWorkspaces(),

  archiveProducts: (userId, items) => {
    if (!userId || !items || items.length === 0) return
    set((state) => {
      const ws = getUserWs(state, userId)
      const byId = new Map(ws.pool.map((p) => [p.id, p]))
      const now = Date.now()
      for (const it of items) {
        if (!it || !it.id) continue
        const existing = byId.get(it.id)
        if (existing) continue // 已归档则保留（含收藏状态）
        byId.set(it.id, {
          id: it.id,
          brand: it.brand || '',
          title: it.title || '',
          image: it.image || '',
          priceText: it.priceText || '',
          commissionRatio: it.commissionRatio ?? null,
          commissionMoney: it.commissionMoney ?? null,
          sales: it.sales ?? null,
          link: it.link || '',
          couponInfo: it.couponInfo || '',
          detailUrl: it.detailUrl || '',
          source: it.source,
          favorited: false,
          archivedAt: now,
        })
      }
      const next: UserWorkspace = { ...ws, pool: Array.from(byId.values()) }
      return withUserWs(state, userId, next)
    })
  },

  removeProduct: (userId, productId) => {
    if (!userId || !productId) return
    set((state) => {
      const ws = getUserWs(state, userId)
      const pool = ws.pool.filter((p) => p.id !== productId)
      const favorites = pool.filter((p) => p.favorited).map((p) => p.id)
      const next: UserWorkspace = { ...ws, pool, favorites }
      return withUserWs(state, userId, next)
    })
  },

  toggleFavorite: (userId, productId) => {
    if (!userId || !productId) return
    set((state) => {
      const ws = getUserWs(state, userId)
      const pool = ws.pool.map((p) => {
        if (p.id !== productId) return p
        const favorited = !p.favorited
        return { ...p, favorited, favoritedAt: favorited ? Date.now() : undefined }
      })
      const favorites = pool.filter((p) => p.favorited).map((p) => p.id)
      const next: UserWorkspace = { ...ws, pool, favorites }
      return withUserWs(state, userId, next)
    })
  },

  addPlan: (userId, payload) => {
    const plan: TestPlan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: payload.name.trim() || '未命名计划',
      direction: payload.direction,
      note: payload.note,
      status: 'planning',
      productIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    set((state) => {
      const ws = getUserWs(state, userId)
      const next: UserWorkspace = { ...ws, plans: [plan, ...ws.plans] }
      return withUserWs(state, userId, next)
    })
    return plan
  },

  addProductToPlan: (userId, planId, productId) => {
    if (!userId || !planId || !productId) return
    set((state) => {
      const ws = getUserWs(state, userId)
      const plans = ws.plans.map((pl) =>
        pl.id === planId && !pl.productIds.includes(productId)
          ? { ...pl, productIds: [...pl.productIds, productId], updatedAt: Date.now() }
          : pl,
      )
      const next: UserWorkspace = { ...ws, plans }
      return withUserWs(state, userId, next)
    })
  },

  removeProductFromPlan: (userId, planId, productId) => {
    set((state) => {
      const ws = getUserWs(state, userId)
      const plans = ws.plans.map((pl) =>
        pl.id === planId
          ? { ...pl, productIds: pl.productIds.filter((id) => id !== productId), updatedAt: Date.now() }
          : pl,
      )
      const next: UserWorkspace = { ...ws, plans }
      return withUserWs(state, userId, next)
    })
  },

  updatePlanStatus: (userId, planId, status) => {
    set((state) => {
      const ws = getUserWs(state, userId)
      const plans = ws.plans.map((pl) =>
        pl.id === planId ? { ...pl, status, updatedAt: Date.now() } : pl,
      )
      const next: UserWorkspace = { ...ws, plans }
      return withUserWs(state, userId, next)
    })
  },

  removePlan: (userId, planId) => {
    set((state) => {
      const ws = getUserWs(state, userId)
      const next: UserWorkspace = { ...ws, plans: ws.plans.filter((pl) => pl.id !== planId) }
      return withUserWs(state, userId, next)
    })
  },

  mergePlans: (userId, plans) => {
    if (!userId) return
    set((state) => {
      const ws = getUserWs(state, userId)
      const local = ws.plans
      // 远端无数据（新用户/首次拉取）：保留本地乐观写入，绝不覆盖
      if (!plans || plans.length === 0) return {}
      const byId = new Map<string, TestPlan>()
      for (const p of local) byId.set(p.id, p)
      for (const r of plans) {
        const existing = byId.get(r.id)
        if (existing) byId.set(r.id, mergePlan(existing, r))
        else byId.set(r.id, r)
      }
      const next: UserWorkspace = { ...ws, plans: Array.from(byId.values()) }
      return withUserWs(state, userId, next)
    })
  },

  attachPromoToPlan: (userId, planId, productId, plan) => {
    if (!userId || !planId || !productId) return
    set((state) => {
      const ws = getUserWs(state, userId)
      const plans = ws.plans.map((pl) =>
        pl.id === planId
          ? { ...pl, promoPlans: { ...(pl.promoPlans || {}), [productId]: plan }, updatedAt: Date.now() }
          : pl,
      )
      const next: UserWorkspace = { ...ws, plans }
      return withUserWs(state, userId, next)
    })
  },

  attachPlanPromoStrategy: (userId, planId, strategy) => {
    if (!userId || !planId || !strategy) return
    set((state) => {
      const ws = getUserWs(state, userId)
      const plans = ws.plans.map((pl) =>
        pl.id === planId ? { ...pl, promoStrategy: strategy, updatedAt: Date.now() } : pl,
      )
      const next: UserWorkspace = { ...ws, plans }
      return withUserWs(state, userId, next)
    })
  },
}))

// ---- 选择器 ----
// 注意：必须用模块级常量兜底，不能每次返回字面量 []，否则 zustand 的
// useSyncExternalStore 会判定快照每次都变，触发无限重渲染（Maximum update depth）。
const EMPTY_POOL: SavedProduct[] = []
const EMPTY_FAV: string[] = []
const EMPTY_PLANS: TestPlan[] = []

export const usePool = (userId?: string | null) =>
  useWorkspaceStore((s) => (userId ? s.workspaces[userId]?.pool ?? EMPTY_POOL : EMPTY_POOL))

export const useFavorites = (userId?: string | null) =>
  useWorkspaceStore((s) => (userId ? s.workspaces[userId]?.favorites ?? EMPTY_FAV : EMPTY_FAV))

export const usePlans = (userId?: string | null) =>
  useWorkspaceStore((s) => (userId ? s.workspaces[userId]?.plans ?? EMPTY_PLANS : EMPTY_PLANS))

// 非响应式读取（用于命令式上下文，如 SSE 流回调）
export const getWorkspaceStore = () => useWorkspaceStore.getState()
