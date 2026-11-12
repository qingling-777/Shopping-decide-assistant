import { API_BASE_URL } from '../constants'
import { ChatRequest, ChatResponse, HotCategory, ProductCardItem, ProductCandidate, PromoPlan, ProductIntro, DeepDiagnosis, OpportunityGroup, ReferralInfo } from './types'
import { tokenStorage } from './authStorage'
import { deviceStorage } from './deviceStorage'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = tokenStorage.get()
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceStorage.get() ? { 'X-Device-Id': deviceStorage.get() } : {}),
      ...options.headers,
    },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const detail = err.detail
    // 统一抛带 status/code 的错误，调用方据此区分「余额不足/会员不足」等业务态 vs 真实服务器错误，
    // 避免把 402 余额不足误显示成「生成失败，请检查后端」。
    const apiErr = new Error(typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `HTTP ${res.status}`) as any
    apiErr.status = res.status
    apiErr.code = typeof detail === 'object' && detail ? (detail as any).code : undefined
    apiErr.detail = detail
    throw apiErr
  }
  return res.json()
}

export const chatAPI = {
  sendMessage: (body: ChatRequest) =>
    request<ChatResponse>('/chat', { method: 'POST', body: JSON.stringify(body) }),

  healthCheck: () =>
    request<{ status: string }>('/health'),

  getOpportunities: () =>
    request<{
      groups: OpportunityGroup[]
      updatedAt: string
      cadence?: string
      source: string
      method: string
      disclaimer: string
    }>('/opportunities'),

  getSpotlight: (keyword: string = '', platform: string = '', category: string = 'general') => {
    const params = new URLSearchParams()
    if (keyword) params.set('keyword', keyword)
    if (platform) params.set('platform', platform)
    if (category) params.set('category', category)
    const qs = params.toString()
    return request<{
      items: ProductCardItem[]
      updatedAt: string
      cadence?: string
      source: string
      method: string
      disclaimer: string
    }>(`/products/spotlight${qs ? `?${qs}` : ''}`)
  },

  // 实时热搜词（买家榜 + 淘客榜），供首页「跟爆款」快捷问题动态生成
  getHotWords: () =>
    request<{ buyer: string[]; taobao: string[] }>('/products/hot-words'),

  // 搜索联想词：把一个热词扩成更细的切片，便于直接找品
  getSearchSuggestions: (keyword: string, type = 1) =>
    request<{ keyword: string; type: number; items: { kw: string; total?: number }[]; source: string }>(
      `/products/search-suggestions?keyword=${encodeURIComponent(keyword)}&type=${type}`,
    ),

  // 朋友圈/社群现成文案：提供可直接引用的营销话术
  getFriendsCircle: (limit = 6) =>
    request<{ items: Array<{ title?: string; circleText?: string; actualPrice?: number | null; itemLink?: string }> }>(
      `/products/friends-circle?limit=${limit}`,
    ),
}

// 榜单中心：大淘客各大榜单（实时爆品/低价高佣/大牛爆单/社群爆品/综合热搜/美妆集散）
export const rankingAPI = {
  // 榜单 Tab 元数据 + 指定榜的商品列表（与爆品卡同字段）
  get: (type: number = 1) =>
    request<{
      tabs: { type: number; title: string; subtitle: string }[]
      type: number
      rank_title: string
      items: any[]
    }>(`/products/rankings?type=${type}`),
}

// 对话历史持久化（登录用户跨设备；匿名前端本地存储，不走本组接口）
export const sessionAPI = {
  // 历史会话列表（不含 messages，轻量）
  list: () =>
    request<{
      items: { id: string; title: string; createdAt: string; updatedAt: string }[]
    }>('/chat/sessions'),

  // 单会话完整内容（含 messages，切换会话时恢复）
  get: (sessionId: string) =>
    request<{
      id: string
      title: string
      messages: any[]
      createdAt: string
      updatedAt: string
    }>(`/chat/sessions/${encodeURIComponent(sessionId)}`),

  // 保存/覆盖一个会话（幂等，前端每次消息变化全量保存）
  save: (sessionId: string, title: string, messages: any[]) =>
    request<{ status: string }>(`/chat/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      body: JSON.stringify({ session_id: sessionId, title, messages }),
    }),

  // 删除单个会话
  remove: (sessionId: string) =>
    request<{ status: string }>(`/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

  // 清空全部
  clear: () =>
    request<{ status: string; deleted: number }>('/chat/sessions', { method: 'DELETE' }),
}

// 方向追踪（登录用户；方案 A + 时间可视化）
export const trackingAPI = {
  // 我的追踪方向列表（含每个方向的时间序列）
  list: () =>
    request<{
      items: {
        direction: string
        keyword: string
        addedAt: string
        tracked: boolean
        series: { date: string; products: number; total_sales: number; avg_price: number | null; avg_commission: number | null }[]
      }[]
    }>('/tracking'),

  // 加入追踪（幂等），返回该方向趋势序列
  add: (direction: string, keyword = '') =>
    request<{ status: string; direction: string; series: any[] }>('/tracking', {
      method: 'POST',
      body: JSON.stringify({ direction, keyword }),
    }),

  // 取消追踪
  remove: (direction: string) =>
    request<{ status: string }>(`/tracking/${encodeURIComponent(direction)}`, { method: 'DELETE' }),
}

export const candidateAPI = {
  // 把聊天里下发的商品卡归档进后端候选池（含 AI 富字段）
  archive: (userId: string, items: ProductCardItem[]) =>
    request<{ status: string; archived: number }>('/candidates/archive', {
      method: 'POST',
      body: JSON.stringify({ userId, items }),
    }),

  // 列出某用户的候选池
  list: (userId: string) =>
    request<{ items: ProductCandidate[] }>(`/candidates?userId=${encodeURIComponent(userId)}`),

  // 切换收藏标记
  favorite: (userId: string, id: string, favorited: boolean) =>
    request<{ status: string }>('/candidates/favorite', {
      method: 'POST',
      body: JSON.stringify({ userId, id, favorited }),
    }),

  // 查竞品：按品牌/关键词找同类在售商品
  getCompetitors: (keyword: string, brand: string, limit = 8) =>
    request<{ items: ProductCardItem[] }>(
      `/products/competitors?keyword=${encodeURIComponent(keyword)}&brand=${encodeURIComponent(brand)}&limit=${limit}`,
    ),

  // 生成结构化推广方案
  generatePromoPlan: (product: Partial<ProductCandidate>) =>
    request<{ plan: PromoPlan }>('/products/promo-plan', {
      method: 'POST',
      body: JSON.stringify({ product }),
    }),

  // 流式生成推广方案（2026-08-27：后端改 SSE，前端实时收 thinking 步骤 + 最终 plan）。
  // 返回 { abort } 便于取消；事件回调 onEvent: {type:'thinking'|'plan'|'error', ...}。
  generatePromoPlanStream: (
    product: Partial<ProductCandidate>,
    onEvent: (ev: { type: string; content?: string; plan?: PromoPlan; usage?: any; cached?: boolean }) => void,
  ) => {
    const ac = new AbortController()
    const token = tokenStorage.get()
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/products/promo-plan`, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(deviceStorage.get() ? { 'X-Device-Id': deviceStorage.get() } : {}),
          },
          body: JSON.stringify({ product }),
        })
        if (res.status === 402) {
          const err = await res.json().catch(() => ({}))
          const apiErr = new Error('余额不足，请充值后使用（该功能按 token 计费）') as any
          apiErr.status = 402
          apiErr.code = err.detail?.code || 'BALANCE_EMPTY'
          apiErr.detail = err.detail
          onEvent({ type: 'error', content: apiErr.message })
          throw apiErr
        }
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`)
        const reader = res.body?.getReader()
        if (!reader) throw new Error('No reader available')
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const events = buffer.split('\n\n')
          buffer = events.pop() || ''
          for (const event of events) {
            for (const line of event.split('\n')) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              if (!data || data === '[DONE]') continue
              try {
                const parsed = JSON.parse(data)
                onEvent(parsed)
              } catch {
                // 忽略非 JSON 行
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        if (!onEvent) throw err
      }
    })()
    return { abort: () => ac.abort() }
  },

  // 佣金/价格变动提醒：按需检查候选池商品的佣金/价格变动，返回有变动清单
  checkChanges: (userId: string) =>
    request<{ changes: any[] }>('/candidates/check-changes', {
      method: 'POST',
      body: JSON.stringify({ userId, items: [] }),
    }),
}

export const planAPI = {
  // 列出某用户测品计划（含每个计划挂的推广方案）
  list: (userId: string) =>
    request<{ items: any[] }>(`/plans?userId=${encodeURIComponent(userId)}`),

  // 整列同步（本地变更后 fire-and-forget 覆盖后端，幂等）
  sync: (userId: string, plans: any[]) =>
    request<{ status: string; count: number }>('/plans/sync', {
      method: 'POST',
      body: JSON.stringify({ userId, plans }),
    }),
}

export const promoAPI = {
  // 保存一条推广方案（不挂测品计划时单独存档，按 productId 去重）
  save: (payload: {
    userId: string
    productId: string
    productName?: string
    brand?: string
    price?: string
    plan: any
  }) =>
    request<{ status: string }>('/products/promo-plan/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // 列出已保存的推广方案
  saved: (userId: string) =>
    request<{ items: any[] }>(`/products/promo-plan/saved?userId=${encodeURIComponent(userId)}`),
}

export const introAPI = {
  // 生成商品介绍（好单库字段 + 联网真实测评文章，后端按商品 id 缓存）
  get: (product: Partial<ProductCardItem>) =>
    request<{ intro: ProductIntro }>('/products/intro', {
      method: 'POST',
      body: JSON.stringify({ product }),
    }),
}

export const planPromoAPI = {
  // 生成计划级整合推广策略，并写回该测品计划（plan.promoStrategy）
  generate: (payload: {
    userId: string
    planId: string
    planName?: string
    direction?: string
    products: any[]
  }) =>
    request<{ status: string; strategy: any }>('/plans/promo-strategy', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
}

export const shareAPI = {
  // 创建公网分享：把当前对话产出的报告（标题/摘要/标签/卡片）存后端，返回 share_id + 公网 URL
  create: (body: {
    title: string
    summary?: string
    tags?: string[]
    cards: Array<{ cardType: string; cardData: any }>
    ttl_days?: number | null
  }) =>
    request<{ share_id: string; url: string }>('/share', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

export const billingAPI = {
  // 当前计费主体用量（tier / quota_used / remaining / early_bird_left / expiry / status / plan）
  getMe: () => request<{
    tier: string
    mode: string
    quota_used: number
    quota_limit: number | null
    remaining: number | null
    early_bird_left: number
    expiry: string | null
    status: string | null
    plan: string | null
  }>('/billing/me'),

  // 付费墙定价（2026-08-25 定价改造：免费 + 按量 + 模型售价明细 + 充值档位）
  getPricing: () =>
    request<{
      currency: string
      payment_enabled: boolean
      charge_multiplier: number
      daily_free_events: number
      min_recharge: number
      recharge_tiers: Record<string, number>
      first_recharge_coupon: number
      price_note: string
      model_prices: Array<{
        model: string
        default: boolean
        platform: Record<string, number>
        sell: Record<string, number>
      }>
      tiers: Array<{
        id: string
        name: string
        price_monthly: number | number[] | null
        price_yearly: number | null
        chat: string
        deep_report: string | false
        test_plan: string | false
        competitor: string
        link: string
      }>
    }>('/billing/pricing'),

  // 真收钱商户信息（支付宝经营码 + 商户名），供升级弹窗展示
  getMerchant: () => request<{ name: string; qr_url: string }>('/billing/merchant'),

  // 创建内测会员订单（pending）；沙箱返回 sandbox=true、无 pay_url/qr
  createOrder: (plan: 'monthly' | 'yearly') =>
    request<{
      order_id: string
      out_trade_no: string
      plan: string
      amount: number
      currency: string
      status: string
      pay_url: string | null
      qr: string | null
      sandbox: boolean
    }>('/billing/orders', { method: 'POST', body: JSON.stringify({ plan }) }),

  // 沙箱模拟支付成功结算（真实通道由异步回调触发）；幂等
  settleOrder: (outTradeNo: string) =>
    request<{
      tier: string
      mode: string
      quota_used: number
      quota_limit: number | null
      remaining: number | null
      early_bird_left: number
      expiry: string | null
      status: string | null
      plan: string | null
    }>(`/billing/orders/${outTradeNo}/settle`, { method: 'POST' }),

  // 列出当前计费主体订单
  getOrders: () => request<{ items: Array<any> }>('/billing/orders'),

  // 取消订阅（立即回 free，MVP 不退款）
  cancel: () =>
    request<{
      tier: string
      mode: string
      quota_used: number
      quota_limit: number | null
      remaining: number | null
      early_bird_left: number
      expiry: string | null
      status: string | null
      plan: string | null
    }>('/billing/cancel', { method: 'POST' }),

  // 运营手动开通（经营码收款后核销）；早期真收钱走经营码，运营核对后调用
  grantManually: (plan: 'monthly' | 'yearly' = 'monthly', subject?: string) =>
    request<any>('/billing/admin/grant', {
      method: 'POST',
      body: JSON.stringify(subject ? { subject, plan } : { plan }),
    }),

  // 运营报表（管理员）：收入 / 平台成本 / 毛利 / 充值 / 券 / 付费用户 / 每日趋势 / 按模型拆分
  getOpsReport: () =>
    request<{
      total_revenue_yuan: number
      user_charge_yuan: number
      platform_cost_yuan: number
      gross_profit_yuan: number
      active_users: number
      user_events: number
      internal_events: number
      arpu_yuan: number
      recharge_count: number
      recharge_users: number
      recharge_amount_yuan: number
      coupon_issued: number
      coupon_used: number
      coupon_used_amount_yuan: number
      free_events: number
      paid_events: number
      paid_users: number
      pay_rate: number
      daily_recharge: Array<{ date: string; amount_yuan: number }>
      by_model: Array<{ model: string; cost_yuan: number; tokens_in: number; tokens_out: number; events: number }>
      by_event: Array<{ event_type: string; cost_yuan: number; events: number }>
    }>('/billing/admin/report'),

  // 客户上传经营码支付凭证（自动绑定本机/账号身份，无需再联系运营）
  submitProof: (plan: 'monthly' | 'yearly', amount?: number | null, proofRef?: string | null) =>
    request<{ proof_id: string; status: string }>('/billing/proof', {
      method: 'POST',
      body: JSON.stringify({ plan, amount: amount ?? null, proof_ref: proofRef ?? null }),
    }),

  // 切换链接归因模式 select / distribute
  setMode: (mode: string) =>
    request<{ status: string; mode: string }>('/billing/mode', { method: 'POST', body: JSON.stringify({ mode }) }),

  // 登录后把本机匿名会员并入账号（跨设备跟随），并返回迁移结果
  linkDevice: (deviceId: string) =>
    request<{
      status: string
      migrated: boolean
      reason?: string
      plan?: string
      expiry?: string
    }>('/billing/link-device', { method: 'POST', body: JSON.stringify({ device_id: deviceId }) }),

  // 余额（元）+ 首充券 + 充值档位 + 预估还能聊几次（替代会员「剩余次数」）
  getBalance: () =>
    request<{
      balance: number
      trial_credit: number
      est_chats: number
      min_recharge: number
      recharge_tiers?: Record<string, number>
      coupons?: { id: string; amount: number; scope?: string; source?: string; expires_at?: string }[]
      free_remaining?: number
      daily_free_events?: number
      payment_enabled?: boolean
    }>('/billing/balance'),

  // 充值入账（MVP 直接到账；真实微信支付由异步回调触发本接口）。amount 单位：元
  recharge: (amount: number) =>
    request<{ status: string; balance: number; recharged: number; est_chats?: number; free_remaining?: number }>('/billing/recharge', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    }),

  // 创建充值支付订单：channel=wap(手机网站H5收银台,返回pay_url) / face(当面付扫码,返回qr)。
  // 用户选完面额后点支付、按所选面额付款；支付宝异步回调 /billing/pay/alipay-notify 自动加余额，
  // 前端拿到 pay_url 后跳转收银台（演示/沙箱下 pay_url 为空则展示模拟收银台）。
  createRechargeOrder: (amount: number, channel: 'wap' | 'face' = 'wap') =>
    request<{
      order_id: string
      out_trade_no: string
      plan: string
      amount: number
      currency: string
      status: string
      pay_url: string | null
      qr: string | null
      sandbox: boolean
      channel: string
    }>('/billing/pay/orders', {
      method: 'POST',
      body: JSON.stringify({ amount, channel }),
    }),

  // 查询充值订单状态（前端轮询：pending → paid）。仅订单所属主体可查。
  getPayOrder: (outTradeNo: string) =>
    request<{ out_trade_no: string; status: string; amount: number; plan: string }>(
      `/billing/pay/orders/${encodeURIComponent(outTradeNo)}`,
    ),

  // 我的邀请码 + 已邀请人数（登录后）。邀请人每成功邀请 1 人得 ¥5 赠送
  getReferralCode: () =>
    request<ReferralInfo>('/billing/referral-code'),

  // 管理员账户调用报表（反滥用）：按计费主体 × 模型拆分调用次数，用户/设备分开，标 banned/禁高频
  getAccounts: (minEvents: number = 0) =>
    request<{
      total_accounts: number
      user_accounts: number
      device_accounts: number
      banned_accounts: number
      total_events: number
      min_events: number
      accounts: Array<{
        subject: string
        kind: 'user' | 'device'
        events: number
        free_events: number
        paid_events: number
        tokens_in: number
        tokens_out: number
        cost_yuan: number
        platform_cost_yuan: number
        last_at: string
        banned: boolean
        account: string
        nickname: string
        is_active: boolean
        is_admin: boolean
        by_model: Array<{ model: string; events: number; tokens_in: number; tokens_out: number; cost_yuan: number }>
      }>
    }>(`/billing/admin/accounts?min_events=${minEvents}`),

  // 管理员查看生效中的黑名单（含账号信息）
  listBanned: () =>
    request<{
      items: Array<{ subject: string; reason: string; created_at: string; created_by: string; account: string; nickname: string }>
    }>('/billing/admin/banned'),

  // 管理员拉黑计费主体（subject 须 user:<id> / device:<id> 完整形式）
  banSubject: (subject: string, reason: string = '恶意多次调用') =>
    request<{ subject: string; reason: string; newly_banned: boolean; banned: boolean }>(
      '/billing/admin/ban',
      { method: 'POST', body: JSON.stringify({ subject, reason }) },
    ),

  // 管理员解封计费主体
  unbanSubject: (subject: string) =>
    request<{ subject: string; updated: boolean; banned: boolean }>(
      '/billing/admin/unban',
      { method: 'POST', body: JSON.stringify({ subject }) },
    ),
}

export const diagnoseAPI = {
  // 单品深度诊断（余额制按 token 计费；余额不足返回 402）
  diagnose: (body: { product_name: string; platform?: string }) =>
    request<{ success: boolean } & DeepDiagnosis>('/diagnose', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

// 变现（C 端佣金）：按需懒加载转链。点「转发赚佣」时才调，不占卡片配额；受淘宝授权门控时 data=null
export const monetizeAPI = {
  privilegeLink: (goodsId: string, couponId?: string | null) =>
    request<{ success: boolean; data: any | null }>('/products/privilege-link', {
      method: 'POST',
      body: JSON.stringify({ goodsId, couponId: couponId ?? null }),
    }),
}

// 知识库（商家自喂品类资料）：列表 / 摄取文本 / 删除
export const knowledgeAPI = {
  list: () =>
    request<{
      total: number
      active: number
      expired: number
      items: {
        id: string
        question: string
        source_label: string
        created_at: string
        expire_at: string
        ttl_days: number
        status: string
      }[]
    }>('/knowledge/dynamic'),

  ingestText: (text: string, source_label?: string) =>
    request<{ status: string; id?: string; question?: string; ttl_days?: number; reason?: string }>(
      '/knowledge/ingest/text',
      { method: 'POST', body: JSON.stringify({ text, source_label: source_label ?? '' }) }
    ),

  remove: (id: string) =>
    request<{ status: string; message: string }>(`/knowledge/dynamic/${id}`, { method: 'DELETE' }),
}

// 用户意见反馈：提交后管理员在后台（GET /admin → 用户反馈）可见并处理
export const feedbackAPI = {
  // 提交反馈（content 必填，contact 选填联系方式）；匿名用户也走设备维度身份，无需登录
  submit: (body: { content: string; contact?: string }) =>
    request<{ id: string; subject: string; status: string; created_at: string }>('/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // 管理员：查看用户反馈列表（status 可选 pending|handled；空则返回全部）
  adminList: (status?: string) =>
    request<{ items: AdminFeedbackItem[] }>(`/feedback/admin/feedbacks${status ? `?status=${status}` : ''}`),

  // 管理员：标记单条反馈为已处理
  adminHandle: (id: string) =>
    request<{ id: string; status: string; handled_at: string; handler: string }>(
      `/feedback/admin/feedbacks/${encodeURIComponent(id)}/handle`,
      { method: 'POST' },
    ),
}

// 管理员侧的反馈条目结构
export interface AdminFeedbackItem {
  id: string
  subject: string
  content: string
  contact?: string | null
  status: 'pending' | 'handled'
  created_at: string
  handled_at?: string | null
  handler?: string | null
}
