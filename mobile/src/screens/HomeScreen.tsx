import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Platform, SafeAreaView, Modal, Animated, Image, Linking } from 'react-native'
import { useReducedMotion } from '../utils/useReducedMotion'
import { radius, spacing, fontSize, elevation, motion } from '../theme'
import { useTheme } from '../utils/theme'
import { API_BASE_URL } from '../constants'
import { MERCHANT_FAQ } from '../constants/merchantFaq'
import { ProductCard } from '../components/cards/ProductCard'
import { ChatBubble } from '../components/chat/ChatBubble'
import { FadeInView, PressableScale, PopInView } from '../components/Motion'
import { SkeletonBlock } from '../components/Skeleton'
import { ChatMessage, QuickChip, ProductCardItem, DeepDiagnosis, ChatCardItem } from '../utils/types'
import { chatAPI, billingAPI, candidateAPI, shareAPI, diagnoseAPI, sessionAPI } from '../utils/api'
import { copyText } from '../utils/share'
import { tokenStorage } from '../utils/authStorage'
import { deviceStorage } from '../utils/deviceStorage'
import { MODEL_BRANDS } from '../utils/models'
import { modelStorage } from '../utils/modelStorage'
import { ModelIcon } from '../components/ModelIcon'
import { User, ProductCandidate } from '../utils/types'
import { usePool, getWorkspaceStore } from '../store/workspace'
import { PoolList } from '../components/product/PoolList'
import { EmptyState } from '../components/EmptyState'
import { MeshBackground } from '../components/MeshBackground'
import { ConversationInput } from '../components/conversation/ConversationInput'
import { ConversationSidebar } from '../components/conversation/ConversationSidebar'
import { WelcomeSection } from '../components/conversation/WelcomeSection'
import { UsageReceipt } from '../components/UsageReceipt'
import { useWorkspaceStore } from '../store/workspace'

interface Props {
  onSend: (text: string) => void
  user?: User | null
  onLogout?: () => void
  onLogin?: () => void
  onOpenProfile?: () => void
  /** 会员态变化时通知父级（用于跨组件同步用量/会员态，例如从「我的」续费后回首页刷新） */
  onMembershipChanged?: () => void
  /** 父级会员态信号：变化时触发用量刷新（来自「我的」续费/取消） */
  membershipTick?: number
  /** 外部发起的顾问提问（如「我的」里点商家常问），非空时自动发出并清空 */
  initialPrompt?: string | null
  /** initialPrompt 已消费后回调（父级据此清空） */
  onConsumePrompt?: () => void
  /** 打开意见反馈屏（#8，新屏复用 ScreenFrame） */
  onOpenFeedback?: () => void
  /** 余额不足时打开充值页（替代原「升级会员」弹窗） */
  onOpenRecharge?: () => void
  /** 工作台首页快捷动作：diagnose / promo */
  homeIntent?: 'diagnose' | 'promo' | null
  /** 快捷动作已消费后回调，父级据此清空 */
  onConsumeHomeIntent?: () => void
  /** 当前激活 Tab（用于抽屉模块入口高亮） */
  activeTab?: string
  /** 抽屉模块入口点击切 Tab（父级 setActiveTab） */
  onNavigate?: (tab: string) => void
  /** 功能抽屉打开状态（父级 menuOpen），驱动侧栏动画与显隐 */
  drawerOpen?: boolean
  /** 请求父级切换抽屉开合（openSidebar/closeSidebar 内部调用，同步父级状态） */
  onDrawerChange?: (open: boolean) => void
  /** 抽屉内「意见反馈」入口（复用 onOpenFeedback，避免重复 props） */
  onOpenFeedbackDrawer?: () => void
}

interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 卡片数据 → 上下文摘要：把上一轮 AI 回复里的卡片数据精简成文本，
// 追加到 history 中该条 AI 消息的 content 末尾，让后端下一次构建 prompt 时
// 能把这些「上一张卡」的真实数据（爆品/机会/数据洞察）注入给 AI 参考决策。
// 只在【发送请求时】临时拼装，不改动展示用的 messages[].content，避免污染界面。
// ─────────────────────────────────────────────────────────────────────────────
function cardToContextSummary(card: ChatCardItem): string {
  const d = card.cardData
  if (!d) return ''
  let lines: string[] = []
  const push = (s: string) => { if (s) lines.push(s) }

  switch (card.cardType) {
    case 'hot_pick': {
      const items: any[] = d.items || []
      if (!items.length) break
      push(`【上一轮我给出的爆品卡数据】`)
      items.slice(0, 6).forEach((it, i) => {
        const pieces = [
          it.title ? `标题:${it.title}` : '',
          it.priceText ? `券后:${it.priceText}` : '',
          it.commissionText ? `佣金:${it.commissionText}` : '',
          it.monthSales != null ? `月销:${it.monthSales}` : '',
          it.sellPoint ? `卖点:${it.sellPoint}` : '',
        ].filter(Boolean).join('，')
        if (pieces) push(`  ${i + 1}. ${pieces}`)
      })
      break
    }
    case 'product': {
      const items: any[] = Array.isArray(d) ? d : (d.items || [])
      if (!items.length) break
      push(`【上一轮我给出的实时选品商品卡数据】`)
      items.slice(0, 6).forEach((it, i) => {
        const pieces = [
          it.title ? `标题:${it.title}` : '',
          it.priceText ? `价:${it.priceText}` : '',
          it.commissionRatio != null ? `佣金:${it.commissionRatio}%` : '',
          it.sales != null ? `销量:${it.sales}` : '',
        ].filter(Boolean).join('，')
        if (pieces) push(`  ${i + 1}. ${pieces}`)
      })
      break
    }
    case 'opportunity': {
      push(`【上一轮我给出的机会评估卡】`)
      if (d.title) push(`  品类:${d.title}`)
      if (d.opportunityScore != null) push(`  机会指数:${d.opportunityScore}`)
      if (d.competitionLevel) push(`  竞争:${d.competitionLevel}`)
      if (d.summary) push(`  判断:${d.summary}`)
      break
    }
    case 'data_insight': {
      push(`【上一轮我给出的市场数据卡】`)
      if (d.priceBand) push(`  价格带:${d.priceBand}`)
      if (d.avgCommission) push(`  ${d.avgCommission}`)
      if (d.totalSales) push(`  ${d.totalSales}`)
      if (d.productCount != null) push(`  在售线索:${d.productCount} 条`)
      if (d.competitionLevel) push(`  竞争:${d.competitionLevel}`)
      break
    }
    case 'product_direction': {
      push(`【上一轮我给出的方向卡】`)
      if (d.directionName) push(`  方向:${d.directionName}`)
      if (d.priceRange) push(`  价格带:${d.priceRange}`)
      if (Array.isArray(d.keySellingPoints)) push(`  卖点:${d.keySellingPoints.join('；')}`)
      break
    }
    case 'risk': {
      if (d.title) push(`【上一轮我给出的风险卡】${d.title}`)
      if (Array.isArray(d.risks)) push(`  风险:${d.risks.join('；')}`)
      if (Array.isArray(d.mitigation)) push(`  规避:${d.mitigation.join('；')}`)
      break
    }
    case 'trend': {
      if (d.title) push(`【上一轮我给出的趋势卡】${d.title}`)
      if (d.summary) push(`  ${d.summary}`)
      break
    }
    default:
      // 其他卡型：尽量输出 title/summary 一行的通用摘要
      if (d.title || d.summary) {
        push(`【上一轮卡片数据】${d.title || ''}${d.summary ? (d.title ? '；' : '') + d.summary : ''}`)
      }
  }
  return lines.join('\n')
}

// 构造带「卡片上下文」的 history：对含 cards 的 AI 消息，把卡片摘要追加到 content 末尾
function serializeHistoryWithCards(msgs: ChatMessage[]): { role: string; content: string }[] {
  return msgs
    .filter((m) => m.content)
    .map((m) => {
      let content = m.content
      if (m.cards && m.cards.length > 0) {
        const cardSummaries = Array.isArray(m.cards)
          ? m.cards.map((c) => cardToContextSummary(c)).filter(Boolean).join('\n')
          : ''
        if (cardSummaries) content = `${content}\n\n${cardSummaries}`
      }
      return { role: m.role, content }
    })
}

// 实时选品参考筛选 chips
const SPOT_CATEGORY_CHIPS: { key: string; label: string }[] = [
  { key: '', label: '推荐' },
  { key: '护肤', label: '护肤' },
  { key: '彩妆', label: '彩妆' },
  { key: '防晒', label: '防晒' },
  { key: '面膜', label: '面膜' },
  { key: '口红', label: '口红' },
  { key: '零食', label: '零食' },
  { key: '女装', label: '女装' },
  { key: '数码', label: '数码' },
  { key: '家居', label: '家居' },
  { key: '母婴', label: '母婴' },
  { key: '食品', label: '食品' },
]
const SPOT_PLATFORM_CHIPS: { key: string; label: string }[] = [
  { key: '', label: '全部' },
  { key: '天猫', label: '天猫' },
  { key: '淘宝', label: '淘宝' },
]
const SPOT_SORT_CHIPS: { key: 'default' | 'sales' | 'commission' | 'price'; label: string }[] = [
  { key: 'default', label: '综合' },
  { key: 'sales', label: '销量' },
  { key: 'commission', label: '佣金' },
  { key: 'price', label: '价格' },
]

export function HomeScreen({ onSend, user, onLogout, onLogin, onOpenProfile, onMembershipChanged, membershipTick, initialPrompt, onConsumePrompt, onOpenFeedback, onOpenRecharge, homeIntent, onConsumeHomeIntent, activeTab, onNavigate, drawerOpen, onDrawerChange, onOpenFeedbackDrawer }: Props) {
  const [input, setInput] = useState('')
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    if (Platform.OS === 'web') {
      try {
        const key = user?.id ? `chat_sessions_${user.id}` : 'chat_sessions'
        const saved = localStorage.getItem(key)
        return saved ? JSON.parse(saved) : []
      } catch {
        return []
      }
    }
    return []
  })
  // 重新打开软件即空白新对话：当前会话仅内存态，不跨会话恢复（旧对话保留在「历史对话」侧栏）。
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(false)
  const sidebarAnim = useRef(new Animated.Value(-300)).current
  const reduceMotion = useReducedMotion()
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  // ---- composer 流畅动态化（光标式面板）----
  // 输入框自适应高度：随内容行数平滑增高（Animated，弹簧 bounce）。
  const inputH = useRef(new Animated.Value(40)).current
  // 面板聚焦态：聚焦时轻微上浮 + 阴影/玻璃感增强。
  const composerFocus = useRef(new Animated.Value(0)).current
  // 发送钮变形：空(麦克风)→有字(箭头)→生成中(停止)→答完(重发)。用单个进度值驱动 morph 过渡。
  const sendProgress = useRef(new Animated.Value(0)).current
  // 建议区展开/收起：高度折叠动画 + chips stagger 入场。
  const chipsAnim = useRef(new Animated.Value(0)).current

  const setInputHeight = (lines: number) => {
    const target = Math.min(40 + (lines - 1) * 22, 132) // 单行40，每行+22，最大132（~5行）
    if (reduceMotion) { inputH.setValue(target); return }
    Animated.spring(inputH, { toValue: target, useNativeDriver: false, tension: 130, friction: 11 }).start()
  }
  const setFocus = (on: boolean) => {
    if (reduceMotion) { composerFocus.setValue(on ? 1 : 0); return }
    Animated.spring(composerFocus, { toValue: on ? 1 : 0, useNativeDriver: true, tension: 90, friction: 11 }).start()
  }
  const toggleChips = (open: boolean) => {
    setChipsExpanded(open)
    if (reduceMotion) { chipsAnim.setValue(open ? 1 : 0); return }
    Animated.spring(chipsAnim, { toValue: open ? 1 : 0, useNativeDriver: true, tension: 100, friction: 12 }).start()
  }
  // 功能抽屉：由父级 menuOpen（顶栏 logo 触发）驱动，内部按钮只通过 onDrawerChange 请求父级切换；
  // 动画统一在 useEffect(drawerOpen) 里做，避免双源动画打架。
  const openSidebar = () => onDrawerChange?.(true)
  const closeSidebar = () => onDrawerChange?.(false)

  useEffect(() => {
    if (drawerOpen) {
      setShowSidebar(true)
      if (reduceMotion) { sidebarAnim.setValue(0); return }
      Animated.spring(sidebarAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }).start()
    } else {
      if (reduceMotion) { sidebarAnim.setValue(-300); setShowSidebar(false); return }
      Animated.timing(sidebarAnim, {
        toValue: -300,
        duration: 200,
        useNativeDriver: true,
      }).start(() => setShowSidebar(false))
    }
  }, [drawerOpen])
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [genSlow, setGenSlow] = useState(false)
  const [chipSeed, setChipSeed] = useState(0)
  const [welcomeSeed, setWelcomeSeed] = useState(() => Math.floor(Math.random() * 1000000))
  const [chipsExpanded, setChipsExpanded] = useState(false)
  const [showActions, setShowActions] = useState(false)
  const [spotlight, setSpotlight] = useState<ProductCardItem[]>([])
  const [spotlightMeta, setSpotlightMeta] = useState<{ updatedAt: string; cadence?: string } | null>(null)
  const [spotLoading, setSpotLoading] = useState(false)
  // 实时选品参考：自由搜索框（提交时写入 spotKeyword 并刷新；与类目 chips 共用一套拉取逻辑）
  const [spotSearchInput, setSpotSearchInput] = useState('')
  // 实时选品参考：类目/平台/排序筛选
  const [spotKeyword, setSpotKeyword] = useState('')  // 类目关键词，空=按模式默认池
  const [spotPlatform, setSpotPlatform] = useState('')  // 平台：'' / 淘宝 / 天猫
  const [spotSort, setSpotSort] = useState<'default' | 'sales' | 'commission' | 'price'>('default')
  // 方案 B：实时热搜词（买家榜 + 淘客榜），供「跟爆款」快捷问题动态生成
  const [hotWords, setHotWords] = useState<string[]>([])
  const [hotWordsLoading, setHotWordsLoading] = useState(true)
  const chatScrollRef = useRef<ScrollView>(null)
  const [atBottom, setAtBottom] = useState(true)
  const inputRef = useRef<TextInput | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const genSlowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceRecRef = useRef<any>(null)
  const [voiceListening, setVoiceListening] = useState(false)
  const [view, setView] = useState<'chat' | 'pool'>('chat')
  // 品类模式：general=全品类宽泛问答(带佣金/联盟通用知识) 为默认；beauty=美妆专业问答(带美妆RAG)
  const [category, setCategory] = useState<'beauty' | 'general'>('general')
  // 受众模式：C=消费者端/个人带货（默认）；B=商家企业端/招商铺货。决定 AI 回答视角（种草/佣金 vs 招商/铺货）
  const [audience, setAudience] = useState<'C' | 'B'>('C')
  // 回答模型品牌：auto / deepseek / qwen / r1，记忆到本地（刷新后仍生效）
  const [model, setModel] = useState<string>(modelStorage.get())
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [candItems, setCandItems] = useState<ProductCandidate[]>([])
  const [candLoading, setCandLoading] = useState(false)
  // —— 付费墙：余额制（替代会员制） ——
  const [quotaInfo, setQuotaInfo] = useState<{ tier: string; remaining: number | null; expiry: string | null; status: string | null; plan: string | null; daily_free_remaining?: number | null } | null>(null)
  // 余额（元）+ 预估还能聊几次：驱动「会员/卡片解锁」语义（余额>0 即视为可用，含体验金）
  const [balance, setBalance] = useState(0)
  const [estChats, setEstChats] = useState(0)
  // 支付总开关（2026-08-28 免费引流策略）：false 时隐藏充值引导、改为纯免费语义
  const [paymentEnabled, setPaymentEnabled] = useState(true)
  const [dailyFree, setDailyFree] = useState(10)
  // P0：单品深度诊断（对用户展示为 AI 额度，明细页保留 token 透明账单）
  const [showDiagnose, setShowDiagnose] = useState(false)
  const [diagName, setDiagName] = useState('')
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagResult, setDiagResult] = useState<DeepDiagnosis | null>(null)
  const [diagError, setDiagError] = useState('')
  // AI 生成推广方案（绑定商品诊断/商品名，按 AI 额度消耗，结果落库）
  const [showPromoHome, setShowPromoHome] = useState(false)
  const [promoName, setPromoName] = useState('')
  const [promoConfirm, setPromoConfirm] = useState(false)
  const [promoLoading, setPromoLoading] = useState(false)
  const [promoError, setPromoError] = useState('')
  const [promoPlan, setPromoPlan] = useState<any>(null)
  const [promoUsage, setPromoUsage] = useState<any>(null)
  const addPlan = useWorkspaceStore((s) => s.addPlan)
  const attachPlanPromoStrategy = useWorkspaceStore((s) => s.attachPlanPromoStrategy)
  // 未登录提示条：提醒登录后才会呈现 AI 选品卡片（可手动关闭，本次会话内隐藏）
  const [hideLoginHint, setHideLoginHint] = useState(false)
  // 实时选品参考：默认折叠（点击表头展开），呼应「元素省略、点击展开」的极简风格
  const [hotCollapsed, setHotCollapsed] = useState(true)
  // 实时选品参考：展开/收起的平滑高度动画（0=收起 1=展开），高度由内容 onLayout 测量
  const hotAnim = useRef(new Animated.Value(0)).current
  const [hotContentH, setHotContentH] = useState(0)
  const toggleHot = (open: boolean) => {
    setHotCollapsed(!open)
    if (reduceMotion) { hotAnim.setValue(open ? 1 : 0); return }
    Animated.spring(hotAnim, { toValue: open ? 1 : 0, useNativeDriver: true, tension: 72, friction: 11 }).start()
  }

  // 公网分享（获客飞轮）：把当前对话的选品卡片汇编成报告，存后端拿公网 URL
  const [shareState, setShareState] = useState<{
    open: boolean
    loading: boolean
    url: string | null
    error: string | null
    empty: boolean
    copied: boolean
  }>({ open: false, loading: false, url: null, error: null, empty: false, copied: false })

  const refreshQuota = () => {
    billingAPI.getMe().then(setQuotaInfo).catch(() => {})
    billingAPI.getBalance().then((r) => {
      setBalance(r.balance ?? 0)
      setEstChats(r.est_chats ?? 0)
      if (typeof r.payment_enabled === 'boolean') setPaymentEnabled(r.payment_enabled)
      if (r.daily_free_events) setDailyFree(r.daily_free_events)
    }).catch(() => {})
  }
  const localPool = usePool(user?.id ?? 'guest')
  // 未登录时把本地商品池映射成候选结构，供同一套 PoolList 渲染
  const localAsCandidates = useMemo<ProductCandidate[]>(
    () =>
      localPool.map((p) => ({
        id: p.id,
        productName: p.title,
        brand: p.brand,
        // 本地池 archivedAt 是毫秒时间戳，转成 ISO 字符串，供商品池按时间倒序 + 相对时间显示
        archivedAt: typeof p.archivedAt === 'number' ? new Date(p.archivedAt).toISOString() : undefined,
        price: p.priceText,
        sourceLink: p.link,
        image: p.image,
        commissionRatio: p.commissionRatio,
        commissionMoney: p.commissionMoney,
        sales: p.sales,
        source: p.source,
        couponInfo: p.couponInfo,
        detailUrl: p.detailUrl,
        favorited: p.favorited,
      })),
    [localPool],
  )

  const currentSession = sessions.find(s => s.id === currentSessionId)
  const messages = currentSession?.messages || []

  // 自动滚动到底部
  useEffect(() => {
    if (messages.length > 0 && chatScrollRef.current) {
      setTimeout(() => {
        chatScrollRef.current?.scrollToEnd({ animated: true })
      }, 100)
    }
  }, [messages.length])

  // 滚动定位：跟踪是否贴近底部（用于圆形跳转钮的方向）
  const onChatScroll = (e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height
    setAtBottom(distFromBottom < 40)
  }
  // 圆形跳转钮：非底部→瞬间到底；已底部→瞬间回顶
  const handleScrollFab = () => {
    const sv = chatScrollRef.current
    if (!sv) return
    if (atBottom) sv.scrollTo({ y: 0, animated: false })
    else sv.scrollToEnd({ animated: false })
  }

  // 历史会话键：登录按账号(user_id)、匿名按设备 —— 与配额维度一致。
  // 登录用户历史存后端（跨设备、清缓存不丢）；匿名仍存 localStorage（设备维度）。
  const storageKey = user?.id ? `chat_sessions_${user.id}` : 'chat_sessions'

  // 登录后：从后端加载历史（真源），并把本机 localStorage 里「后端还没有」的会话上传合并
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    sessionAPI
      .list()
      .then(async ({ items }) => {
        // 后端已有 id 集合
        const remote = new Map<string, { id: string; title: string }>()
        items.forEach((s) => remote.set(s.id, s))
        // 本地（登录键）可能残留上次未同步成功的会话 → 补传后端
        try {
          const local = JSON.parse(localStorage.getItem(storageKey) || '[]') as ChatSession[]
          for (const s of local) {
            if (!remote.has(s.id) && s.messages && s.messages.length > 0) {
              await sessionAPI.save(s.id, s.title, s.messages)
              remote.set(s.id, { id: s.id, title: s.title })
            }
          }
        } catch { /* 本地解析失败忽略 */ }
        if (cancelled) return
        setSessions((prev) => {
          const byId = new Map<string, ChatSession>()
          // 后端会话为真源（含 messages 的本地会话优先，保证当前对话完整）
          items.forEach((s) => {
            const local = prev.find((p) => p.id === s.id)
            if (local) { byId.set(s.id, local); return }
            byId.set(s.id, { id: s.id, title: s.title, messages: [], createdAt: 0, updatedAt: Date.parse(s.updatedAt) || 0 })
          })
          // 后端没有的本地会话（如登录前游客产生的、刚上传的）补回
          prev.forEach((s) => { if (!byId.has(s.id)) byId.set(s.id, s) })
          return Array.from(byId.values())
        })
      })
      .catch(() => { /* 后端不可用则保留本地会话 */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // 匿名：从 localStorage 载入历史（登录/登出切换账号时合并而非覆盖）
  useEffect(() => {
    if (Platform.OS !== 'web' || user?.id) return
    try {
      const saved = localStorage.getItem(storageKey)
      const savedSessions: ChatSession[] = saved ? JSON.parse(saved) : []
      setSessions((prev) => {
        const byId = new Map<string, ChatSession>()
        savedSessions.forEach((s) => byId.set(s.id, s))
        prev.forEach((s) => { if (!byId.has(s.id)) byId.set(s.id, s) })
        return Array.from(byId.values())
      })
    } catch {
      // 解析失败则保留内存会话，不做清空
    }
  }, [storageKey, user?.id])

  // 会话历史持久化：登录 → 防抖保存到后端（跨设备）；匿名 → localStorage
  // 当前会话仅内存态 —— 重新打开软件即空白新对话，旧对话在侧栏可找回。
  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (user?.id) {
      // 登录用户：全量防抖同步到后端（500ms 合并写，避免每轮消息都打接口）
      const timer = setTimeout(() => {
        sessions.forEach((s) => {
          if (s.messages && s.messages.length > 0) {
            sessionAPI.save(s.id, s.title, s.messages).catch(() => {})
          }
        })
      }, 500)
      return () => clearTimeout(timer)
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(sessions))
    } catch (error) {
      console.error('Failed to save sessions:', error)
    }
  }, [sessions, storageKey, user?.id])

  const refreshSpotlight = useCallback(() => {
    setSpotLoading(true)
    chatAPI.getSpotlight(spotKeyword, spotPlatform, category)
      .then((result) => {
        setSpotlight(result.items)
        setSpotlightMeta({ updatedAt: result.updatedAt, cadence: result.cadence })
      })
      .catch((error) => {
        console.error('Failed to load spotlight:', error)
        setSpotlight([])
      })
      .finally(() => setSpotLoading(false))
  }, [spotKeyword, spotPlatform, category])

  // 刷新：仅在本机对已有商品做洗牌重排（再推荐一批），不请求服务器，避免打上游接口（好单库/大淘客有限频）
  const shuffleSpotlight = useCallback(() => {
    setSpotlight((prev) => {
      const arr = [...(prev || [])]
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t
      }
      return arr
    })
  }, [])

  // 排序：平台筛选已后端做；销量/佣金/价格在前端对展示列表排序
  const displayItems = useMemo<ProductCardItem[]>(() => {
    if (spotSort === 'default' || spotlight.length === 0) return spotlight
    const arr = [...spotlight]
    if (spotSort === 'sales') arr.sort((a, b) => (b.sales ?? 0) - (a.sales ?? 0))
    else if (spotSort === 'commission') arr.sort((a, b) => (b.commissionMoney ?? 0) - (a.commissionMoney ?? 0))
    else if (spotSort === 'price') arr.sort((a, b) => (a.priceValue ?? Infinity) - (b.priceValue ?? Infinity))
    return arr
  }, [spotlight, spotSort])

  // 实时选品参考：筛选变化即重拉；每 2 小时兜底刷新一次
  useEffect(() => {
    refreshSpotlight()
    const id = setInterval(refreshSpotlight, 2 * 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [refreshSpotlight])

  // 方案 B：实时热搜词（买家榜 + 淘客榜），合并去重，供「跟爆款」快捷问题动态生成；每 2 小时兜底刷新
  const refreshHotWords = useCallback(() => {
    chatAPI.getHotWords()
      .then((r) => {
        const merged = Array.from(new Set([...(r.taobao || []), ...(r.buyer || [])])).filter(Boolean)
        setHotWords(merged)
      })
      .catch((error) => {
        console.error('Failed to load hot words:', error)
        setHotWords([])
      })
      .finally(() => setHotWordsLoading(false))
  }, [])
  useEffect(() => {
    refreshHotWords()
    const id = setInterval(refreshHotWords, 2 * 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [refreshHotWords])

  // 付费墙：挂载即拉取当前用量（余额/体验金由 /billing/balance 提供）
  useEffect(() => {
    refreshQuota()
  }, [])

  // 退出登录后：设备维度配额刷新 + 余额强制归 0（账号余额不随设备走，退出即清零显示）
  useEffect(() => {
    if (!user) {
      billingAPI.getMe().then(setQuotaInfo).catch(() => {})
      setBalance(0)
      setEstChats(0)
    }
  }, [user])

  // 会员态变化（如从「我的」续费/取消）后同步刷新首页用量与会员态
  useEffect(() => {
    refreshQuota()
  }, [membershipTick])

  // 欢迎区问题自动轮换：空态时每 20s 换一批（用 welcomeSeed 重洗 buildScenarioGroups），
  // 进入对话（有消息）后停止；切品类/受众已单独重置 seed，这里只做定时滚动。
  useEffect(() => {
    if (messages.length > 0) return
    const id = setInterval(() => setWelcomeSeed((s) => s + 1), 20000)
    return () => clearInterval(id)
  }, [messages.length])

  // 外部发起的顾问提问（「我的」里点商家常问）：自动发出后通知父级清空，避免重复触发
  useEffect(() => {
    if (!initialPrompt || !initialPrompt.trim()) return
    if (isLoading) return // 上一条还在生成时跳过，等 isLoading 变 false 本 effect 会重跑再发
    handleSend(initialPrompt)
    onConsumePrompt?.()
  }, [initialPrompt, isLoading])

  useEffect(() => {
    if (!homeIntent) return
    if (homeIntent === 'diagnose') setShowDiagnose(true)
    if (homeIntent === 'promo') setShowPromoHome(true)
    onConsumeHomeIntent?.()
  }, [homeIntent])

  const refreshCandidates = () => {
    if (!user) return
    setCandLoading(true)
    candidateAPI
      .list(user.id)
      .then((r) => {
        // 后端尚未落盘（AI 富字段仍在跑）时返回空，保留已有/乐观项，避免被清空
        setCandItems((prev) => (r.items && r.items.length > 0 ? r.items : prev))
      })
      .catch(() => {})
      .finally(() => setCandLoading(false))
  }

  useEffect(() => {
    if (view === 'pool' && user) refreshCandidates()
  }, [view, user])

  // 每约 2 小时重新拉取，配合后端 2 小时时间桶，自动刷新一列随机好单库商品
  useEffect(() => {
    const id = setInterval(refreshSpotlight, 2 * 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // 快捷问题：随当前视图 + 品类动态生成（不再每条消息后随机洗牌）
  const contextChips = useMemo(
    () => buildContextChips(view, candItems, chipSeed, category, hotWords, audience),
    [view, candItems, chipSeed, category, hotWords, audience]
  )

  const createNewSession = (firstMessage: string) => {
    const newSession: ChatSession = {
      id: Date.now().toString(),
      title: firstMessage.slice(0, 30),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setSessions(prev => [newSession, ...prev])
    setCurrentSessionId(newSession.id)
    return newSession.id
  }

  const updateSessionMessages = (sessionId: string, newMessages: ChatMessage[]) => {
    setSessions(prev => prev.map(s => 
      s.id === sessionId 
        ? { ...s, messages: newMessages, updatedAt: Date.now() }
        : s
    ))
  }

  const switchSession = (sessionId: string) => {
    setCurrentSessionId(sessionId)
    // 登录用户：从后端拉取该会话完整消息（列表接口不含 messages）
    const sess = sessions.find((s) => s.id === sessionId)
    if (user?.id && sess && (!sess.messages || sess.messages.length === 0)) {
      sessionAPI.get(sessionId)
        .then((detail) => {
          setSessions((prev) => prev.map((s) =>
            s.id === sessionId
              ? { ...s, title: detail.title || s.title, messages: detail.messages || [] }
              : s
          ))
        })
        .catch(() => { /* 拉取失败保留空会话，用户可继续对话 */ })
    }
    closeSidebar()
  }

  const deleteSession = (sessionId: string) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId))
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null)
    }
    // 登录用户：同步删除后端记录（跨设备生效）
    if (user?.id) {
      sessionAPI.remove(sessionId).catch(() => {})
    }
  }

  const clearHistory = () => {
    if (currentSessionId) {
      deleteSession(currentSessionId)
    }
    setCurrentSessionId(null)
    setWelcomeSeed(Math.floor(Math.random() * 1000000))
  }
  const handleSend = (textOverride?: string, replaceFromMsgId?: string) => {
    const text = (textOverride || input).trim()
    if (!text || isLoading) return

    onSend(text)

    // 如果没有当前会话，创建新会话
    let sessionId = currentSessionId
    if (!sessionId) {
      sessionId = createNewSession(text)
    }

    // 刷新/重生成：截掉目标用户消息及其之后的回复，原地替换（不重复堆叠）
    let baseMessages = messages
    if (replaceFromMsgId) {
      const idx = messages.findIndex((m) => m.id === replaceFromMsgId)
      if (idx >= 0) baseMessages = messages.slice(0, idx)
    }

    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: text, timestamp: Date.now() }
    const aiMsgId = (Date.now() + 1).toString()
    const aiMsg: ChatMessage = { id: aiMsgId, role: 'assistant', content: '', timestamp: Date.now() }

    const newMessages = [...baseMessages, userMsg, aiMsg]
    updateSessionMessages(sessionId, newMessages)
    setInput('')
    setIsLoading(true)
    setGenSlow(false)
    if (genSlowTimer.current) clearTimeout(genSlowTimer.current)
    genSlowTimer.current = setTimeout(() => setGenSlow(true), 90000)

    const ac = new AbortController()
    abortRef.current = ac

    let queue: string[] = []
    let displayed = ''
    let running = true

    const processQueue = () => {
      if (queue.length > 0) {
        displayed += queue.splice(0, Math.min(3, queue.length)).join('')
        setSessions(prev => prev.map(s => 
          s.id === sessionId 
            ? { ...s, messages: s.messages.map(msg => msg.id === aiMsgId ? { ...msg, content: displayed } : msg) }
            : s
        ))
      }
      if (queue.length > 0 || running) setTimeout(processQueue, 24)
    }

    processQueue()

    fetch(`${API_BASE_URL}/chat/stream`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenStorage.get() || ''}`,
        'X-Device-Id': deviceStorage.get(),
      },
      body: JSON.stringify({
        message: text,
        history: serializeHistoryWithCards(baseMessages),
        category,
        audience,
        model,
      }),
    })
      .then(async (response) => {
        if (response.status === 402) {
          refreshQuota()
          if (paymentEnabled) {
            if (user) onOpenRecharge?.()
            else onLogin?.()
          }
          throw new Error('QUOTA_EXCEEDED')
        }
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
        const reader = response.body?.getReader()
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
                if (parsed.type === 'text' && typeof parsed.content === 'string') queue.push(...parsed.content.split(''))
                if (parsed.type === 'thinking' && typeof parsed.content === 'string') {
                  setSessions(prev => prev.map(s =>
                    s.id === sessionId
                      ? { ...s, messages: s.messages.map(msg => msg.id === aiMsgId ? { ...msg, thinkingSteps: [...(msg.thinkingSteps || []), parsed.content] } : msg) }
                      : s
                  ))
                }
                if (parsed.type === 'card') {
                  setSessions(prev => prev.map(s =>
                    s.id === sessionId
                      ? { ...s, messages: s.messages.map(msg => msg.id === aiMsgId ? { ...msg, cards: [...(msg.cards || []), { cardType: parsed.card_type, cardData: parsed.card_data }] } : msg) }
                      : s
                  ))
                  // 自动归档：聊天中出现的好单库商品卡，归入商品池（去重）
                  if (parsed.card_type === 'product' && Array.isArray(parsed.card_data) && parsed.card_data.length > 0) {
                    const archiveId = user?.id ?? 'guest'
                    // 本地池：无论是否登录都归档（未登录用 guest 工作区，web 持久化到 localStorage）
                    getWorkspaceStore().archiveProducts(archiveId, parsed.card_data)
                    if (user) {
                      // 后端候选池（含 AI 富字段，跨设备）：fire-and-forget
                      candidateAPI.archive(user.id, parsed.card_data).catch(() => {})
                      // 乐观更新：先把原始商品卡并入候选池视图，后端落盘后再刷新覆盖
                      setCandItems((prev) => {
                        const known = new Set(prev.map((c) => c.id))
                        const mapped = parsed.card_data
                          .filter((d: any) => d && d.id && !known.has(d.id))
                          .map((d: any) => ({
                            id: d.id,
                            productName: d.title,
                            // 乐观插入时打上当前时间，保证在商品池里排到最前（最新）
                            archivedAt: new Date().toISOString(),
                            brand: d.brand,
                            price: d.priceText,
                            sourceLink: d.link,
                            image: d.image,
                            commissionRatio: d.commissionRatio,
                            commissionMoney: d.commissionMoney,
                            sales: d.sales,
                            source: d.source,
                            couponInfo: d.couponInfo,
                            detailUrl: d.detailUrl,
                          }))
                        return mapped.length ? [...prev, ...mapped] : prev
                      })
                    }
                    if (view === 'pool') {
                      if (user) refreshCandidates()
                      // 未登录：本地池由 usePool 订阅自动刷新，无需手动
                    }
                  }
                }
                if (parsed.type === 'follow_up' && Array.isArray(parsed.questions)) {
                  setSessions(prev => prev.map(s =>
                    s.id === sessionId
                      ? { ...s, messages: s.messages.map(msg => msg.id === aiMsgId ? { ...msg, followUpQuestions: parsed.questions } : msg) }
                      : s
                  ))
                }
                if (parsed.type === 'card_hint' && typeof parsed.content === 'string') {
                  setSessions(prev => prev.map(s =>
                    s.id === sessionId
                      ? { ...s, messages: s.messages.map(msg => msg.id === aiMsgId ? { ...msg, cardHint: parsed.content } : msg) }
                      : s
                  ))
                }
                if (parsed.type === 'billing' && parsed.model) {
                  // 硅基流动风格透明计费回执：把本次回答的模型 / token / 花费挂到 AI 消息底部展示
                  setSessions(prev => prev.map(s =>
                    s.id === sessionId
                      ? { ...s, messages: s.messages.map(msg => msg.id === aiMsgId ? {
                          ...msg,
                          usage: {
                            model: parsed.model,
                            model_brand: parsed.model_brand,
                            tokens_in: parsed.tokens_in,
                            tokens_out: parsed.tokens_out,
                            cost_yuan: parsed.cost_yuan,
                            is_free: parsed.is_free,
                            balance_after: parsed.balance_after,
                            free_remaining: parsed.free_remaining,
                          },
                        } : msg) }
                      : s
                  ))
                }
                if (parsed.type === 'error') queue.push(...`\n\n[错误: ${parsed.content}]`.split(''))
              } catch (error) {
                console.error('Parse error:', error)
              }
            }
          }
        }

        running = false
        setIsLoading(false)
        setGenSlow(false)
        refreshQuota()
      })
      .catch((error) => {
        console.error('Stream error:', error)
        running = false
        setIsLoading(false)
        setGenSlow(false)
        setSessions(prev => prev.map(s =>
          s.id === sessionId
            ? { ...s, messages: s.messages.map(msg => msg.id === aiMsgId ? { ...msg, content: displayed || '抱歉，连接失败了。请检查后端是否正常运行。' } : msg) }
            : s
        ))
      })
  }

  // 修改：把原用户消息填回输入框，聚焦等用户二次发送（按当前内容重新生成）
  const handleEdit = (text: string) => {
    setInput(text)
    inputRef.current?.focus()
  }

  // 停止生成：abort 当前 fetch（流式中断，catch 会把 isLoading 置回 false）
  const handleStop = () => {
    abortRef.current?.abort()
    setGenSlow(false)
  }

  // 语音识别：浏览器 Web Speech API（仅 web 构建可用；需 HTTPS 安全上下文浏览器才授权麦克风）
  const getSpeechRec = (): any => {
    if (Platform.OS !== 'web') return null
    const w = globalThis as any
    return w.SpeechRecognition || w.webkitSpeechRecognition || null
  }
  const voiceSupported = !!getSpeechRec()
  const startVoice = () => {
    const SR = getSpeechRec()
    if (!SR) { inputRef.current?.focus(); return }
    const rec = new SR()
    rec.lang = 'zh-CN'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e: any) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      setInput(text)
    }
    rec.onerror = () => setVoiceListening(false)
    rec.onend = () => setVoiceListening(false)
    voiceRecRef.current = rec
    setVoiceListening(true)
    try { rec.start() } catch { setVoiceListening(false) }
  }
  const stopVoice = () => {
    try { voiceRecRef.current?.stop() } catch {}
    setVoiceListening(false)
  }
  useEffect(() => () => { try { voiceRecRef.current?.stop?.() } catch {} }, [])

  // 公网分享：汇编当前对话的选品卡片 → 调后端建分享 → 弹公网链接
  const handleShare = async () => {
    const cards: Array<{ cardType: string; cardData: any }> = []
    let summary = ''
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      if (m.cards && m.cards.length) {
        for (const c of m.cards) cards.push({ cardType: c.cardType, cardData: c.cardData })
      }
      if (!summary && m.content) summary = m.content.replace(/\s+/g, ' ').slice(0, 200)
    }
    if (cards.length === 0) {
      setShareState({ open: true, loading: false, url: null, error: null, empty: true, copied: false })
      return
    }
    setShareState({ open: true, loading: true, url: null, error: null, empty: false, copied: false })
    try {
      const res = await shareAPI.create({ title: '全品类选品报告', summary, cards, tags: [] })
      setShareState({ open: true, loading: false, url: res.url, error: null, empty: false, copied: false })
    } catch (e: any) {
      setShareState({ open: true, loading: false, url: null, error: e?.message || '分享失败', empty: false, copied: false })
    }
  }

  const createTestPlanFromCurrent = useCallback((name?: string, note?: string, strategy?: any) => {
    const userId = user?.id || 'guest'
    const plan = addPlan(userId, {
      name: name?.trim() || promoName?.trim() || diagResult?.productName || '新测品计划',
      direction: diagResult?.keyword || promoName?.trim() || diagResult?.productName || undefined,
      note: note?.trim() || diagResult?.summary || promoPlan?.body || undefined,
    })
    if (strategy) attachPlanPromoStrategy(userId, plan.id, strategy)
    return plan
  }, [addPlan, attachPlanPromoStrategy, user?.id, promoName, diagResult, promoPlan])

  const handleCopyShare = async () => {
    if (!shareState.url) return
    const ok = await copyText(shareState.url)
    if (ok) {
      setShareState((s) => ({ ...s, copied: true }))
      setTimeout(() => setShareState((s) => ({ ...s, copied: false })), 1500)
    }
  }

  // —— 登录/成为会员后自动解锁此前被锁的卡片 ——
  // 安全策略：锁定态下后端不发卡片数据（仅发 card_hint），所以「解锁」是按原问题重新拉取卡片；
  // 仅会员可拉到（后端 allow_cards），免费/匿名拿不到，付费墙数据不泄露。
  const [unlockingIds, setUnlockingIds] = useState<Set<string>>(() => new Set())
  const unlockedRef = useRef<Set<string>>(new Set())
  // 余额制：余额>0（含体验金）即视为「可用」语义，等价于原会员——驱动金环主题与卡片解锁
  const hasBalance = balance > 0
  const freeLeft = quotaInfo?.daily_free_remaining ?? 0
  const usable = hasBalance || freeLeft > 0
  // 提前声明，供下方自动解锁 effect 引用（isGuestMember 在更下方沿用）
  const isMember = !!(quotaInfo && quotaInfo.tier !== 'free') || hasBalance

  const unlockMessageCards = useCallback(
    (sessionId: string, aiMsgId: string, question: string, history: { role: string; content: string }[]) => {
      setUnlockingIds((prev) => new Set(prev).add(aiMsgId))
      fetch(`${API_BASE_URL}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenStorage.get() || ''}`,
          'X-Device-Id': deviceStorage.get(),
        },
        body: JSON.stringify({ message: question, history, category, audience, model }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
          const reader = response.body?.getReader()
          if (!reader) throw new Error('No reader available')
          const decoder = new TextDecoder()
          let buffer = ''
          const collected: { cardType: string; cardData: any }[] = []
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
                  if (parsed.type === 'card') collected.push({ cardType: parsed.card_type, cardData: parsed.card_data })
                } catch { /* 忽略解析异常的行 */ }
              }
            }
          }
          setSessions((prev) => prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, cards: [...(m.cards || []), ...collected], cardHint: collected.length > 0 ? undefined : m.cardHint }
                      : m
                  ),
                }
              : s
          ))
          // 自动归档商品卡到商品池（去重，与正常对话一致）
          const productCard = collected.find((c) => c.cardType === 'product')
          if (productCard && Array.isArray(productCard.cardData) && productCard.cardData.length > 0) {
            const archiveId = user?.id ?? 'guest'
            getWorkspaceStore().archiveProducts(archiveId, productCard.cardData)
            if (user) candidateAPI.archive(user.id, productCard.cardData).catch(() => {})
          }
        })
        .catch(() => { /* 解锁失败静默：保留原提示，用户可再次点击解锁 */ })
        .finally(() => setUnlockingIds((prev) => { const n = new Set(prev); n.delete(aiMsgId); return n }))
    },
    [category, audience, user]
  )

  const handleUnlock = useCallback(
    (aiMsgId: string) => {
      const sess = sessions.find((s) => s.id === currentSessionId)
      if (!sess) return
      const msgs = sess.messages
      const idx = msgs.findIndex((m) => m.id === aiMsgId)
      if (idx < 0) return
      let question = ''
      for (let i = idx - 1; i >= 0; i--) {
        if (msgs[i].role === 'user' && msgs[i].content) { question = msgs[i].content; break }
      }
      if (!question) return
      const history = msgs.slice(0, idx).filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }))
      unlockMessageCards(sess.id, aiMsgId, question, history)
    },
    [sessions, currentSessionId, unlockMessageCards]
  )

  // 会员态变为 true 或切换会话时，自动解锁当前会话里此前被锁的卡片（每个消息只尝试一次）
  useEffect(() => {
    if (!isMember) return
    const sess = sessions.find((s) => s.id === currentSessionId)
    if (!sess) return
    sess.messages.forEach((m) => {
      if (
        m.role === 'assistant' &&
        m.cardHint &&
        (!m.cards || m.cards.length === 0) &&
        !unlockedRef.current.has(m.id)
      ) {
        unlockedRef.current.add(m.id)
        handleUnlock(m.id)
      }
    })
  }, [isMember, currentSessionId, sessions, handleUnlock])

  // 最后一条用户消息：用于 composer 在「答完」态把右侧圆钮变「重新生成」
  const lastUserMsg = messages.filter((m) => m.role === 'user').pop() || null
  // 右侧圆形按钮随对话状态变形（参考 ChatGPT 手机端）：语音(空) → 发送(有字) → 停止(生成中) → 重新生成(答完)
  const composerButton = (() => {
    const canSend = input.trim().length > 0
    const isStop = isLoading || voiceListening
    const sendIcon = isStop ? (isLoading ? '■' : '●') : canSend ? '↑' : lastUserMsg ? '↻' : '⊙'
    const sendAction = isStop
      ? (isLoading ? handleStop : stopVoice)
      : canSend
        ? () => handleSend()
        : lastUserMsg
          ? () => handleSend(lastUserMsg.content, lastUserMsg.id)
          : (voiceSupported ? startVoice : () => inputRef.current?.focus())
    return (
      <Animated.View style={{ transform: [{ scale: sendProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }) }] }}>
        <PressableScale
          onPress={sendAction}
          style={[styles.morphBtn, isStop ? styles.morphStop : canSend ? styles.morphSend : lastUserMsg ? styles.morphSend : styles.morphVoice]}
          radius={999}
          accessibilityRole="button"
          accessibilityLabel={isLoading ? '停止生成' : canSend ? '发送' : '语音输入'}
        >
          <Text style={styles.morphIcon}>{sendIcon}</Text>
        </PressableScale>
      </Animated.View>
    )
  })()

  // 独立语音图标钮（Gemini 思路：麦克风用图标省略，输入文字/空态都可点语音）：
  // 空态时主发送钮已是语音入口，此处仅在输入文字或可重发时显示独立的麦克风钮，避免与空态入口重复。
  const voiceIconBtn = (() => {
    if (isLoading) return null
    if (voiceListening) {
      // 收听中：显示麦克风「收听…」态（红色脉冲），点它停止
      return (
        <PressableScale onPress={stopVoice} style={styles.toolIconBtn} radius={999} accessibilityRole="button" accessibilityLabel="停止语音">
          <Text style={styles.toolIcon}>●</Text>
        </PressableScale>
      )
    }
    if (input.trim().length > 0) {
      // 有文字时：独立的语音图标钮（发送钮负责发送，互不干扰）；用几何声波符号 ≋（非彩色 emoji）
      return (
        <PressableScale onPress={voiceSupported ? startVoice : () => inputRef.current?.focus()} style={styles.toolIconBtn} radius={999} accessibilityRole="button" accessibilityLabel="语音输入">
          <Text style={styles.toolIcon}>≋</Text>
        </PressableScale>
      )
    }
    return null
  })()

  // 发送钮状态变形驱动：输入非空/可重发/生成中时，进度值推向 1（微放大脉冲）；
  // 空态复位到 0。用弹簧让状态切换有"就绪/释放"的弹性过渡。
  const sendActive = isLoading || voiceListening || input.trim().length > 0 || !!lastUserMsg
  useEffect(() => {
    if (reduceMotion) { sendProgress.setValue(sendActive ? 1 : 0); return }
    Animated.spring(sendProgress, { toValue: sendActive ? 1 : 0, useNativeDriver: true, tension: 140, friction: 10 }).start()
  }, [sendActive, reduceMotion, sendProgress])
  // 未登录但本设备被核销开通会员（经营码闭环）：标记为「本机会员」，UI 上区别于登录会员，
  // 避免「没登录却显示会员」的困惑——它仍是真会员（本设备可用），只是未绑定到账号
  const isGuestMember = isMember && !user
  return (
    <SafeAreaView style={[styles.safe, isMember && styles.safeMember]}>
      <MeshBackground goldMesh={!!isMember} />
      <ScrollView ref={chatScrollRef} style={[styles.scroll, isMember && styles.scrollMember]} contentContainerStyle={[styles.scrollContent, isMember && styles.scrollContentMember, { paddingBottom: 155 }]} showsVerticalScrollIndicator={false} onScroll={onChatScroll} scrollEventThrottle={16}>
        
        {!user && !hideLoginHint && (
          <View style={styles.loginHint}>
            <TouchableOpacity style={styles.loginHintBody} onPress={() => onLogin?.()} activeOpacity={0.85}>
              <Text style={styles.loginHintText}>
                未登录：AI 仅给文字建议，<Text style={styles.loginHintStrong}>登录后</Text>才会生成选品卡片（爆品 · 机会 · 趋势）
              </Text>
              <Text style={styles.loginHintCta}>去登录 ›</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.loginHintClose} onPress={() => setHideLoginHint(true)} activeOpacity={0.7}>
              <Text style={styles.loginHintCloseText}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {view === 'chat' ? (
        <>
        <View style={styles.hotSection}>
          <TouchableOpacity style={[styles.hotHeader, styles.hotHeaderBtn]} activeOpacity={0.75} onPress={() => toggleHot(hotCollapsed)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.hotTitle}>实时选品参考</Text>
              {spotlightMeta && (
                <Text style={styles.hotMeta}>
                  真实联盟商品 · 更新于 {spotlightMeta.updatedAt.slice(0, 10)}
                  {spotlightMeta.cadence ? ` · ${spotlightMeta.cadence}` : ''}
                </Text>
              )}
            </View>
            {/* 折叠/展开 caret：默认收成一个标题行，点击展开筛选 + 商品 */}
            <View style={styles.hotToggleWrap}>
              <Text style={styles.hotToggleCaret}>{hotCollapsed ? '▸ 展开' : '▾ 收起'}</Text>
            </View>
          </TouchableOpacity>

          {/* 展开区：平滑高度动画（点击表头慢慢拉下来/收回去），高度由内层内容 onLayout 测量，overflow hidden 裁切 */}
          <Animated.View
            style={[styles.hotPanel, { height: hotAnim.interpolate({ inputRange: [0, 1], outputRange: [0, hotContentH] }), opacity: hotAnim }]}
          >
          {/* 内层测量容器：不受外层 height:0 裁切，如实上报内容自然高度；外层据此做高度动画 */}
          <View
            onLayout={(e) => { const h = e.nativeEvent.layout.height; if (h > 0 && h !== hotContentH) setHotContentH(h) }}
          >
          {/* 搜索 + 刷新：搜索框提交即按关键词拉真实在售商品；刷新手动重拉（每 2h 仍有兜底自动刷新） */}
          <View style={styles.hotSearchRow}>
            <View style={styles.hotSearchBox}>
              <TextInput
                style={styles.hotSearchInput}
                value={spotSearchInput}
                onChangeText={setSpotSearchInput}
                placeholder="搜索商品，如 面膜 / 咖啡 / 运动鞋"
                placeholderTextColor={C.textMuted}
                returnKeyType="search"
                onSubmitEditing={() => setSpotKeyword(spotSearchInput.trim())}
                clearButtonMode="while-editing"
              />
            </View>
            <TouchableOpacity style={styles.hotRefreshBtn} activeOpacity={0.8} onPress={shuffleSpotlight}>
              <Text style={styles.hotRefreshBtnText}>刷新</Text>
            </TouchableOpacity>
          </View>

          {/* 筛选面板：玻璃态卡片包裹，分区清晰 */}
          <View style={styles.spotFilterPanel}>
            {/* 类目筛选 */}
            <View style={styles.spotFilterSection}>
              <Text style={styles.spotFilterLabel}>类目</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.spotChipScroll}>
                {SPOT_CATEGORY_CHIPS.map((c) => (
                  <TouchableOpacity
                    key={c.key}
                    style={[styles.spotChip, spotKeyword === c.key && styles.spotChipActive]}
                    onPress={() => setSpotKeyword(spotKeyword === c.key ? '' : c.key)}
                  >
                    <Text style={[styles.spotChipText, spotKeyword === c.key && styles.spotChipTextActive]}>{c.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* 平台 + 排序：横向排列 */}
            <View style={styles.spotFilterBottom}>
              <View style={styles.spotFilterSection}>
                <Text style={styles.spotFilterLabel}>平台</Text>
                <View style={styles.spotChipGroup}>
                  {SPOT_PLATFORM_CHIPS.map((p) => (
                    <TouchableOpacity
                      key={p.key}
                      style={[styles.spotChip, spotPlatform === p.key && styles.spotChipActive]}
                      onPress={() => setSpotPlatform(spotPlatform === p.key ? '' : p.key)}
                    >
                      <Text style={[styles.spotChipText, spotPlatform === p.key && styles.spotChipTextActive]}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.spotFilterSection}>
                <Text style={styles.spotFilterLabel}>排序</Text>
                <View style={styles.spotChipGroup}>
                  {SPOT_SORT_CHIPS.map((s) => (
                    <TouchableOpacity
                      key={s.key}
                      style={[styles.spotChip, spotSort === s.key && styles.spotChipActive]}
                      onPress={() => setSpotSort(s.key)}
                    >
                      <Text style={[styles.spotChipText, spotSort === s.key && styles.spotChipTextActive]}>{s.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          </View>

          {displayItems.length > 0 ? (
            <ProductCard items={displayItems} userId={user?.id} autoScroll />
          ) : spotLoading ? (
            // 生命力·骨架 Shimmer：首屏拉取实时选品参考时的占位（流光 sweep），reduce-motion 时静态
            <View style={styles.skeletonRow}>
              {[0, 1, 2, 3].map((i) => (
                <SkeletonBlock key={i} height={200} width={150} radius={radius.lg} />
              ))}
            </View>
          ) : (
            <Text style={styles.hotEmpty}>暂无商品数据，请稍后刷新</Text>
          )}
          </View>
          </Animated.View>
        </View>

        {messages.length === 0 && (
          <WelcomeSection
            category={category}
            audience={audience}
            scenarioGroups={buildScenarioGroups(category, hotWords, welcomeSeed, audience)}
            loading={hotWordsLoading}
            seed={welcomeSeed}
            onPromptPress={handleSend}
            onDiagnosisPress={() => setShowDiagnose(true)}
          />
        )}

        {messages.length > 0 && (
          <View style={styles.chatContainer}>
            {messages.map((msg, idx) => (
              <FadeInView
                key={msg.id}
                delay={Math.min(idx, 12) * motion.stagger}
                style={{ width: '100%' }}
              >
                <ChatBubble
                  message={msg}
                  streaming={isLoading}
                  onSend={handleSend}
                  userId={user?.id}
                  isMember={isMember}
                  unlocking={unlockingIds.has(msg.id)}
                  onUnlock={handleUnlock}
                  onLogin={onLogin}
                  onOpenRecharge={() => onOpenRecharge?.()}
                  paymentEnabled={paymentEnabled}
                  onEdit={handleEdit}
                  onRegenerate={(id, t) => handleSend(t, id)}
                  onIntroClosed={refreshQuota}
                />
              </FadeInView>
            ))}
            {isLoading && <View style={styles.loading}><View style={styles.dot} /><View style={[styles.dot, styles.dot2]} /><View style={[styles.dot, styles.dot3]} /></View>}
          </View>
        )}
        </>
        ) : (
          <View style={styles.poolSection}>
            <View style={styles.poolHead}>
              <View style={styles.poolHeadTop}>
                <Text style={styles.poolTitle}>今日机会 · 商品池</Text>
                <View style={styles.poolCount}>
                  <Text style={styles.poolCountText}>{user ? candItems.length : localPool.length}</Text>
                </View>
              </View>
              <Text style={styles.poolSub}>
                {user ? '后端归档（含 AI 方向标签 / 竞争等级 / 卖点）' : '未登录：显示本地商品池'}
              </Text>
            </View>
            {candLoading ? (
              <View style={styles.skeletonCol}>
                <SkeletonBlock height={72} radius={radius.lg} />
                <SkeletonBlock height={72} radius={radius.lg} />
              </View>
            ) : null}
            {user ? (
              <PoolList
                items={candItems}
                userId={user?.id}
                emptyHint="在聊天里问 AI 分析某个带货方向，出现的商品会自动归档到这里"
                onCheckDone={refreshCandidates}
              />
            ) : (
              <PoolList items={localAsCandidates} userId={null} emptyHint="登录后，聊出来的商品会自动归档进后端商品池" />
            )}
          </View>
        )}

        <View style={{ height: 84 }} />
      </ScrollView>

      <ConversationSidebar
        visible={showSidebar}
        onClose={closeSidebar}
        sessions={sessions}
        currentSessionId={currentSessionId}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSessionSelect={switchSession}
        onNewChat={() => { clearHistory(); closeSidebar() }}
        onDeleteSession={deleteSession}
        sidebarAnim={sidebarAnim}
        activeTab={activeTab}
        onNavigate={onNavigate}
        onOpenFeedback={onOpenFeedbackDrawer || onOpenFeedback}
      />

      <View style={[styles.bottomPanel, isMember && styles.bottomPanelMember]}>
        {/* 顶行：用量提示（左） + 建议问题展开（右）合并到一行，省竖向空间 */}
        {(quotaInfo || contextChips.length > 0) && (
          <View style={styles.metaRow}>
            {quotaInfo && (
              <PressableScale
                style={styles.usageRow}
                onPress={() => { user ? onOpenRecharge?.() : onLogin?.() }}
                radius={8}
                accessibilityRole="button"
              >
                <View style={[styles.usageDot, usable && styles.usageDotGold]} />
                <Text style={[styles.usageText, usable && styles.usageTextGold]}>
                  {!paymentEnabled ? (
                    !user
                      ? (freeLeft > 0 ? `今日免费剩 ${freeLeft} 次 · 登录解锁更多` : '今日免费额度已用完 · 明天再来')
                      : (freeLeft > 0 ? `今日免费剩 ${freeLeft} 次 · 免费畅用` : '今日免费额度已用完 · 明天再来')
                  ) : (
                    !user
                      ? (freeLeft > 0
                          ? `今日免费剩 ${freeLeft} 次 · 登录解锁更多`
                          : '今日免费额度已用完 · 登录充值继续')
                      : (freeLeft > 0
                          ? `今日免费剩 ${freeLeft} 次 · 充值解锁更多`
                          : hasBalance
                            ? `余额 ¥${balance.toFixed(2)} · 约还能聊 ${estChats} 次`
                            : '余额不足 · 充值后继续')
                  )}
                </Text>
                <Text style={styles.usageAction}>{!paymentEnabled ? (user ? '免费' : '登录 ›') : (user ? (usable ? '充值 ›' : '去充值 ›') : '登录 ›')}</Text>
              </PressableScale>
            )}
            {contextChips.length > 0 && (
              <PressableScale style={styles.chipsToggle} onPress={() => toggleChips(!chipsExpanded)} radius={6}>
                <Text style={styles.chipsToggleText}>{chipsExpanded ? '收起建议 ▴' : '试试这样问 ▾'}</Text>
              </PressableScale>
            )}
          </View>
        )}

        {/* 建议问题：仅展开时显示，默认收起不占竖向空间；用 spring 折叠/展开 + chips stagger 滑入 */}
        {contextChips.length > 0 && (
          <Animated.View style={[styles.quickWrap, { height: chipsAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 40] }) }]}>
            {chipsExpanded && (
              <Animated.ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.quickContent}
                style={{ opacity: chipsAnim }}
              >
                {contextChips.map((chip, i) => (
                  <PressableScale key={chip.id} style={styles.quickChip} onPress={() => handleSend(chip.prompt)} radius={999} hover>
                    <Text style={styles.quickChipText}>{chip.label}</Text>
                  </PressableScale>
                ))}
                <PressableScale key="__refresh" style={[styles.quickChip, styles.quickChipRefresh]} onPress={() => setChipSeed((s) => s + 1)} radius={999} hover>
                  <Text style={[styles.quickChipText, styles.quickChipRefreshText]}>换一批</Text>
                </PressableScale>
              </Animated.ScrollView>
            )}
          </Animated.View>
        )}

        {isLoading && genSlow && (
          <Text style={styles.genSlowText}>生成较慢，可点右侧停止按钮重试</Text>
        )}

        {/* 光标式输入面板（Cursor/Gemini 风）：单胶囊输入行，模型/受众设置收纳到 ＋ 面板 */}
        <Animated.View
          style={[
            styles.inputCapsule,
            {
              transform: [{ translateY: composerFocus.interpolate({ inputRange: [0, 1], outputRange: [0, -2] }) }],
              borderColor: composerFocus.interpolate({ inputRange: [0, 1], outputRange: [C.border, C.primary] }),
              shadowColor: C.primary,
              shadowOpacity: composerFocus.interpolate({ inputRange: [0, 1], outputRange: [0.04, 0.18] }),
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
            },
          ]}
        >
          {/* 输入行：＋ 快捷操作(含对话设置) · 多行自适应输入 · 右侧圆形按钮随状态变形 */}
          <View style={styles.capsuleInputRow}>
            <PressableScale style={styles.plusBtn} onPress={() => setShowActions(true)} radius={999} accessibilityRole="button" accessibilityLabel="快捷操作">
              <Text style={styles.plusText}>＋</Text>
            </PressableScale>
            <Animated.View style={{ flex: 1, height: inputH }}>
              <TextInput
                ref={inputRef}
                style={[styles.input, { height: '100%' }]}
                value={input}
                onChangeText={(t) => { setInput(t); setInputHeight(t.split('\n').length) }}
                onFocus={() => setFocus(true)}
                onBlur={() => setFocus(false)}
                placeholder={audience === 'B' ? '问问 AI：想把货铺给哪些渠道？' : (category === 'general' ? '问问 AI：想做哪个品类的带货？' : '问问 AI：哪个带货方向更容易起量？')}
                placeholderTextColor={C.textMuted}
                returnKeyType="send"
                onSubmitEditing={() => handleSend()}
                onKeyPress={(e) => {
                  // 回车发送、Shift+回车换行（多行输入下的标准交互）
                  const ne: any = e.nativeEvent
                  if (ne.key === 'Enter' && !ne.shiftKey) {
                    ne.preventDefault?.()
                    if (input.trim()) handleSend()
                  }
                }}
                blurOnSubmit={false}
                multiline
                editable={true}
                autoComplete="off"
              />
            </Animated.View>
            {voiceIconBtn}
            {composerButton}
          </View>
        </Animated.View>

        {/* AI 决策免责声明：始终显示在输入框下方，提示用户 AI 建议需自行判断 */}
        <Text style={styles.disclaimerText}>以上为 AI 生成内容，选品决策请谨慎参考、自行核实</Text>
      </View>

      {/* 圆形跳转钮：瞬间到底（↑回顶 / ↓到底），仅在可滚动内容时显示 */}
      {(messages.length > 0 || view === 'pool') && (
        <TouchableOpacity style={styles.scrollFab} onPress={handleScrollFab} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={atBottom ? '回到顶部' : '跳到底部'}>
          <Text style={styles.scrollFabIcon}>{atBottom ? '↑' : '↓'}</Text>
        </TouchableOpacity>
      )}

      {/* ＋ 快捷操作面板（仿 ChatGPT 左键菜单）：单品深度诊断 / 分享选品报告 */}
      <Modal visible={showActions} transparent animationType="fade" onRequestClose={() => setShowActions(false)}>
        <TouchableOpacity style={styles.actionBackdrop} activeOpacity={1} onPress={() => setShowActions(false)}>
          <View style={styles.actionSheet} onStartShouldSetResponder={() => true}>
            <Text style={styles.actionTitle}>快捷操作</Text>
            {/* 对话设置：回答模型 + 品类 + 受众（从输入胶囊收纳至此，点击可展开/切换） */}
            <View style={styles.composerSettings}>
              <Text style={styles.composerSettingsLabel}>对话设置</Text>
              <View style={styles.composerSettingsRow}>
                <PressableScale style={styles.composerSettingPill} onPress={() => setModelPickerOpen(true)} radius={999} hover>
                  <ModelIcon model={model} size={16} />
                  <Text style={styles.composerSettingText} numberOfLines={1}>{MODEL_BRANDS.find((b) => b.key === model)?.short ?? 'Flash'}</Text>
                  <Text style={styles.modelPillCaret}>▾</Text>
                </PressableScale>
                <View style={styles.composerSettingDivider} />
                <PressableScale style={[styles.composerSettingChip, category === 'general' && styles.composerSettingChipActive]} onPress={() => { setCategory('general'); setWelcomeSeed(Math.floor(Math.random() * 1000000)) }} radius={999}>
                  <Text style={[styles.composerSettingChipText, category === 'general' && styles.composerSettingChipTextActive]}>全品类</Text>
                </PressableScale>
                <PressableScale style={[styles.composerSettingChip, category === 'beauty' && styles.composerSettingChipActive]} onPress={() => { setCategory('beauty'); setWelcomeSeed(Math.floor(Math.random() * 1000000)) }} radius={999}>
                  <Text style={[styles.composerSettingChipText, category === 'beauty' && styles.composerSettingChipTextActive]}>美妆</Text>
                </PressableScale>
                <View style={styles.composerSettingDivider} />
                <PressableScale style={[styles.composerSettingChip, audience === 'C' && styles.composerSettingChipActive]} onPress={() => { setAudience('C'); setWelcomeSeed(Math.floor(Math.random() * 1000000)) }} radius={999}>
                  <Text style={[styles.composerSettingChipText, audience === 'C' && styles.composerSettingChipTextActive]}>C端</Text>
                </PressableScale>
                <PressableScale style={[styles.composerSettingChip, audience === 'B' && styles.composerSettingChipActive]} onPress={() => { setAudience('B'); setWelcomeSeed(Math.floor(Math.random() * 1000000)) }} radius={999}>
                  <Text style={[styles.composerSettingChipText, audience === 'B' && styles.composerSettingChipTextActive]}>B端</Text>
                </PressableScale>
              </View>
            </View>
            <TouchableOpacity style={styles.actionItem} activeOpacity={0.7} onPress={() => { setShowActions(false); setShowDiagnose(true) }}>
              <Text style={styles.actionItemText}>单品深度诊断</Text>
              <Text style={styles.actionItemSub}>输入商品名，结合好单库实时价/佣/销判断值不值得做 · 按 token 计费（成本×5）</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem} activeOpacity={0.7} onPress={() => { setShowActions(false); setShowPromoHome(true) }}>
              <Text style={styles.actionItemText}>AI 生成推广方案</Text>
              <Text style={styles.actionItemSub}>输入商品名，AI 生成 C 端 + B 端主流推广方案 · 按 token 计费（成本×5），结果落库</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem} activeOpacity={0.7} onPress={() => { setShowActions(false); handleShare() }}>
              <Text style={styles.actionItemText}>分享选品报告</Text>
              <Text style={styles.actionItemSub}>汇编当前对话卡片，生成可公网访问的链接</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionItem, styles.actionItemDisabled]} activeOpacity={0.5} onPress={() => setShowActions(false)}>
              <Text style={[styles.actionItemText, styles.actionItemTextDisabled]}>图片 / 拍照（即将上线）</Text>
            </TouchableOpacity>
            <Text style={styles.actionItemSub}>AI 生成功能按 token 计费：商品介绍 ×1.5 / 单品深度诊断 ×5 / 推广方案 ×5，同一商品只收一次（结果落库），每日前 3 次问答免费。</Text>
            <TouchableOpacity style={styles.actionCancel} activeOpacity={0.7} onPress={() => setShowActions(false)}>
              <Text style={styles.actionCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 公网分享弹窗：把当前对话汇编成带溯源的选品报告，生成可公网访问的链接（分享飞轮入口） */}
      <Modal visible={shareState.open} transparent animationType="fade" onRequestClose={() => setShareState((s) => ({ ...s, open: false }))}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <View style={{ backgroundColor: C.cardBg, borderRadius: 16, padding: 22, width: '100%', maxWidth: 340 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.textPrimary, marginBottom: 12 }}>分享选品报告</Text>
            {shareState.loading && (
              <Text style={{ fontSize: 13, color: C.textMuted }}>正在生成公网链接…</Text>
            )}
            {!shareState.loading && shareState.url && (
              <>
                <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20, marginBottom: 10 }}>
                  链接已生成，可发给同行/客户，打开即见带数据溯源的选品报告：
                </Text>
                <View style={{ backgroundColor: C.pageBg, borderRadius: 10, padding: 10, marginBottom: 12 }}>
                  <Text selectable style={{ fontSize: 12, color: C.primary }}>{shareState.url}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity onPress={handleCopyShare} style={{ flex: 1, backgroundColor: C.primary, borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{shareState.copied ? '已复制 ✓' : '复制链接'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => Linking.openURL(shareState.url!)} style={{ flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingVertical: 10, alignItems: 'center' }}>
                    <Text style={{ color: C.textSecondary, fontSize: 14, fontWeight: '600' }}>打开预览</Text>
                  </TouchableOpacity>
                </View>
                <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 12, lineHeight: 16 }}>
                  提示：打开链接后点「保存为图片」可导出带溯源的卡片图，方便发朋友圈/社群。
                </Text>
              </>
            )}
            {!shareState.loading && shareState.empty && (
              <Text style={{ fontSize: 13, color: C.textMuted, lineHeight: 20 }}>
                当前对话还没有选品卡片，先和 AI 聊一轮、生成卡片后再分享吧～
              </Text>
            )}
            {!shareState.loading && shareState.error && (
              <Text style={{ fontSize: 13, color: '#e5484d', lineHeight: 20 }}>{shareState.error}</Text>
            )}
            <TouchableOpacity onPress={() => setShareState((s) => ({ ...s, open: false }))} style={{ marginTop: 16, alignSelf: 'flex-end' }}>
              <Text style={{ fontSize: 14, color: C.textMuted }}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 单品深度诊断：输入商品名 → 调 /diagnose → 展示深诊报告与 token/费用回执 */}
      <Modal visible={showDiagnose} transparent animationType="fade" onRequestClose={() => setShowDiagnose(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: C.cardBg, borderRadius: 16, padding: 20, width: '100%', maxWidth: 400, maxHeight: '88%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.textPrimary }}>单品深度诊断</Text>
              <TouchableOpacity onPress={() => setShowDiagnose(false)} activeOpacity={0.7}>
                <Text style={{ fontSize: 16, color: C.textMuted }}>✕</Text>
              </TouchableOpacity>
            </View>

            {!diagResult ? (
              <>
                <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20, marginBottom: 10 }}>
                  输入商品名或品类（如「早C晚A精华」「XX 防晒霜」），AI 结合好单库实时价/佣/销与知识库风险，判断这条品值不值得做。按 token 计费（售价=平台成本×5），不占每日免费额度。
                </Text>
                <TextInput
                  style={{ backgroundColor: C.pageBg, borderRadius: 10, padding: 12, fontSize: 16, color: C.textPrimary, borderWidth: 1, borderColor: C.border }}
                  value={diagName}
                  onChangeText={setDiagName}
                  placeholder="商品名 / 品类，如：早C晚A精华"
                  placeholderTextColor={C.textMuted}
                />
                {diagError ? <Text style={{ fontSize: 13, color: '#e5484d', marginTop: 8 }}>{diagError}</Text> : null}

                {!user ? (
                  <TouchableOpacity style={{ backgroundColor: C.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 }} activeOpacity={0.85} onPress={() => onLogin?.()}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>登录后使用</Text>
                  </TouchableOpacity>
                ) : !hasBalance ? (
                  <TouchableOpacity style={{ backgroundColor: C.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 }} activeOpacity={0.85} onPress={() => { if (paymentEnabled) onOpenRecharge?.(); setDiagError(paymentEnabled ? '' : '今日免费额度已用完，深度诊断暂不可用（明天再来）') }}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{paymentEnabled ? '充值后诊断（按 token 计费）' : '免费额度已用完 · 今天不可用'}</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.diagGo, !diagName.trim() && styles.diagGoDisabled]}
                    activeOpacity={0.85}
                    disabled={!diagName.trim() || diagLoading}
                    onPress={async () => {
                      setDiagLoading(true)
                      setDiagError('')
                      try {
                        const res = await diagnoseAPI.diagnose({ product_name: diagName.trim() })
                        setDiagResult(res)
                      } catch (e: any) {
                        setDiagError(e?.message || '诊断失败，请稍后重试')
                      } finally {
                        setDiagLoading(false)
                      }
                    }}
                  >
                    <Text style={styles.diagGoText}>{diagLoading ? 'AI 诊断中…' : '开始诊断'}</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <ScrollView style={{ maxHeight: '80%' }} showsVerticalScrollIndicator={false}>
                {/* 机会指数 + 一句话结论 */}
                <UsageReceipt usage={diagResult.usage} />
                <View style={styles.diagScoreRow}>
                  <View style={styles.diagScoreBox}>
                    <Text style={styles.diagScoreNum}>{diagResult.opportunityScore}</Text>
                    <Text style={styles.diagScoreLabel}>机会指数</Text>
                  </View>
                  <View style={{ flex: 1, paddingLeft: 14 }}>
                    <Text style={styles.diagSummary}>{diagResult.summary}</Text>
                    {diagResult.keyword && diagResult.keyword !== diagResult.productName ? (
                      <Text style={styles.diagKw}>下钻词：{diagResult.keyword}</Text>
                    ) : null}
                  </View>
                </View>

                {/* 真实市场信号（好单库） */}
                {diagResult.signals && diagResult.signals.product_count ? (
                  <View style={styles.diagBlock}>
                    <Text style={styles.diagBlockTitle}>真实市场信号（好单库）</Text>
                    <View style={styles.diagSignalRow}>
                      {diagResult.signals.price_band ? <Text style={styles.diagSignal}>价格带 {diagResult.signals.price_band}</Text> : null}
                      {diagResult.signals.avg_commission_ratio != null ? <Text style={styles.diagSignal}>均佣 {diagResult.signals.avg_commission_ratio}%</Text> : null}
                      {diagResult.signals.total_sales != null ? <Text style={styles.diagSignal}>总销 {diagResult.signals.total_sales}</Text> : null}
                      {diagResult.signals.top_brands && diagResult.signals.top_brands.length ? <Text style={styles.diagSignal}>头部 {diagResult.signals.top_brands.slice(0, 3).join('/')}</Text> : null}
                    </View>
                    <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>注：好单库聚合的选品线索，非平台真实成交数据</Text>
                  </View>
                ) : null}

                <View style={styles.diagBlock}>
                  <Text style={styles.diagBlockTitle}>竞争与格局</Text>
                  <Text style={styles.diagBody}>{diagResult.competition}</Text>
                </View>
                <View style={styles.diagBlock}>
                  <Text style={styles.diagBlockTitle}>风险与坑</Text>
                  <Text style={styles.diagBody}>{diagResult.risk}</Text>
                </View>
                {diagResult.contentAngles.length ? (
                  <View style={styles.diagBlock}>
                    <Text style={styles.diagBlockTitle}>内容切入角度</Text>
                    {diagResult.contentAngles.map((a, i) => (
                      <Text key={i} style={styles.diagBullet}>· {a}</Text>
                    ))}
                  </View>
                ) : null}
                {diagResult.nextSteps.length ? (
                  <View style={styles.diagBlock}>
                    <Text style={styles.diagBlockTitle}>落地步骤</Text>
                    {diagResult.nextSteps.map((s, i) => (
                      <Text key={i} style={styles.diagBullet}>{i + 1}. {s}</Text>
                    ))}
                  </View>
                ) : null}
                {diagResult.competitors.length ? (
                  <View style={styles.diagBlock}>
                    <Text style={styles.diagBlockTitle}>同品类在售竞品</Text>
                    {diagResult.competitors.slice(0, 5).map((c, i) => (
                      <View key={i} style={styles.diagCompRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.diagCompTitle} numberOfLines={1}>{c.brand} {c.title}</Text>
                          <Text style={styles.diagCompMeta}>{[c.price_text, c.commission_ratio != null ? `佣${c.commission_ratio}%` : '', c.sales != null ? `月销${c.sales}` : ''].filter(Boolean).join(' · ')}</Text>
                        </View>
                        {c.link ? <TouchableOpacity onPress={() => Linking.openURL(c.link).catch(() => {})}><Text style={styles.diagCompLink}>看</Text></TouchableOpacity> : null}
                      </View>
                    ))}
                  </View>
                ) : null}

                <View style={styles.diagActionRow}>
                  <TouchableOpacity
                    style={[styles.diagActionBtn, { backgroundColor: C.pageBg, borderColor: C.border }]}
                    activeOpacity={0.8}
                    onPress={() => {
                      setShowDiagnose(false)
                      setDiagResult(null)
                      setPromoName(diagResult.productName)
                      setShowPromoHome(true)
                    }}
                  >
                    <Text style={[styles.diagActionText, { color: C.textPrimary }]}>生成测试内容</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.diagActionBtn, { backgroundColor: C.primary }]}
                    activeOpacity={0.8}
                    onPress={() => {
                      createTestPlanFromCurrent(diagResult.productName, diagResult.summary, diagResult)
                      setShowDiagnose(false)
                    }}
                  >
                    <Text style={[styles.diagActionText, { color: '#fff' }]}>加入测品计划</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity style={{ marginTop: 8, alignSelf: 'flex-end' }} activeOpacity={0.7} onPress={() => { setDiagResult(null); setDiagName('') }}>
                  <Text style={{ fontSize: 13, color: C.primary }}>再诊断一个 ›</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* AI 生成推广方案（首页入口：输入商品名 → 确认计费 → 生成 C/B 端方案，按 token ×5 计费、结果落库，2026-08-25） */}
      <Modal visible={showPromoHome} transparent animationType="fade" onRequestClose={() => { setShowPromoHome(false); setPromoConfirm(false); setPromoPlan(null); setPromoError('') }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
          <View style={{ backgroundColor: C.cardBg, borderRadius: 16, padding: 20, width: '100%', maxWidth: 400, maxHeight: '88%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.textPrimary }}>AI 生成推广方案</Text>
              <TouchableOpacity onPress={() => { setShowPromoHome(false); setPromoConfirm(false); setPromoPlan(null); setPromoError('') }} activeOpacity={0.7}>
                <Text style={{ fontSize: 16, color: C.textMuted }}>✕</Text>
              </TouchableOpacity>
            </View>

            {!promoConfirm ? (
              <>
                <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20, marginBottom: 10 }}>
                  输入商品名/品类（如「早C晚A精华」「XX 防晒霜」），AI 联网核实卖点，生成包含 C 端主流推广（内容种草/佣金带货）与 B 端主流推广（招商铺货/渠道分销）的完整方案。
                </Text>
                <TextInput
                  style={{ backgroundColor: C.pageBg, borderRadius: 10, padding: 12, fontSize: 16, color: C.textPrimary, borderWidth: 1, borderColor: C.border, marginBottom: 12 }}
                  placeholder="商品名 / 品类名"
                  placeholderTextColor={C.textMuted}
                  value={promoName}
                  onChangeText={setPromoName}
                />
                <Text style={{ fontSize: 12, color: C.textMuted, lineHeight: 18, marginBottom: 12 }}>
                  按 token 计费（售价 = 平台成本 ×5，单份约 ¥0.03-0.06）；同一商品只收一次，结果落库可重复查看；余额不足会提示充值。
                </Text>
                <TouchableOpacity
                  style={{ backgroundColor: C.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center' }}
                  activeOpacity={0.85}
                  onPress={() => {
                    if (!promoName.trim()) return
                    setPromoConfirm(true)
                    setPromoLoading(true)
                    setPromoError('')
                    candidateAPI
                      .generatePromoPlan({ id: 'h_' + promoName.trim(), productName: promoName.trim(), brand: '', price: '', commissionRatio: null, competitionLevel: '', platform: '', sellingPoints: [] })
                      .then((res) => { setPromoPlan(res.plan); setPromoUsage((res as any).usage) })
                      .catch((e) => {
                        const msg = (e?.detail?.code === 'BALANCE_EMPTY') ? '余额不足，请充值后使用（该功能按 token 计费）' : '生成失败，请稍后重试'
                        setPromoError(msg)
                      })
                      .finally(() => setPromoLoading(false))
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>确认生成（按 token 计费）</Text>
                </TouchableOpacity>
              </>
            ) : (
              <ScrollView style={{ maxHeight: 520 }} showsVerticalScrollIndicator={false}>
                {promoLoading ? <Text style={{ fontSize: 13, color: C.textMuted }}>AI 生成中…（联网核实卖点 + 组装 C/B 端方案，约 10-30 秒）</Text> : null}
                {promoError ? <Text style={{ fontSize: 13, color: '#e5484d', lineHeight: 20 }}>{promoError}</Text> : null}
                {promoPlan ? (
                  <View>
                    {promoPlan.title ? <Text style={{ fontSize: 15, fontWeight: '700', color: C.textPrimary, marginBottom: 8 }}>{promoPlan.title}</Text> : null}
                    {Array.isArray(promoPlan.hooks) ? (
                      <View style={{ marginBottom: 10 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: C.textSecondary }}>钩子文案</Text>
                        {promoPlan.hooks.map((h: string, i: number) => <Text key={i} style={{ fontSize: 13, color: C.textPrimary, lineHeight: 20 }}>· {h}</Text>)}
                      </View>
                    ) : null}
                    {promoPlan.body ? <Text style={{ fontSize: 13, color: C.textPrimary, lineHeight: 22, marginBottom: 10 }}>{promoPlan.body}</Text> : null}
                    {promoUsage ? (
                      <View style={{ marginBottom: 10 }}>
                        <Text style={{ fontSize: 11, color: C.textMuted }}>
                          消耗 {promoUsage.tokens_in} in / {promoUsage.tokens_out} out tokens{promoUsage.tokens_cached ? `（缓存 ${promoUsage.tokens_cached}）` : ''} · 费用 {promoUsage.is_free ? '免费额度内' : `¥${(promoUsage.cost_yuan ?? 0).toFixed(5)}`}
                        </Text>
                      </View>
                    ) : null}
                    {promoPlan.cEndPromotion ? (
                      <View style={{ backgroundColor: C.pageBg, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: C.primary, marginBottom: 4 }}>C 端主流推广（个人带货 / 淘客）</Text>
                        <Text style={{ fontSize: 13, color: C.textPrimary, lineHeight: 20 }}>{promoPlan.cEndPromotion.mainstream}</Text>
                        {Array.isArray(promoPlan.cEndPromotion.channels) ? promoPlan.cEndPromotion.channels.map((c: string, i: number) => <Text key={i} style={{ fontSize: 13, color: C.textPrimary, lineHeight: 20 }}>· {c}</Text>) : null}
                        {promoPlan.cEndPromotion.commissionStrategy ? <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>{promoPlan.cEndPromotion.commissionStrategy}</Text> : null}
                      </View>
                    ) : null}
                    {promoPlan.bEndPromotion ? (
                      <View style={{ backgroundColor: C.pageBg, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                        <Text style={{ fontSize: 13, fontWeight: '700', color: C.primary, marginBottom: 4 }}>B 端主流推广（商家 / 招商）</Text>
                        <Text style={{ fontSize: 13, color: C.textPrimary, lineHeight: 20 }}>{promoPlan.bEndPromotion.mainstream}</Text>
                        {Array.isArray(promoPlan.bEndPromotion.channels) ? promoPlan.bEndPromotion.channels.map((c: string, i: number) => <Text key={i} style={{ fontSize: 13, color: C.textPrimary, lineHeight: 20 }}>· {c}</Text>) : null}
                        {promoPlan.bEndPromotion.supplyStrategy ? <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>{promoPlan.bEndPromotion.supplyStrategy}</Text> : null}
                        {promoPlan.bEndPromotion.distributionStrategy ? <Text style={{ fontSize: 13, color: C.textSecondary, lineHeight: 20 }}>{promoPlan.bEndPromotion.distributionStrategy}</Text> : null}
                      </View>
                    ) : null}
                    <View style={styles.promoActionRow}>
                      <TouchableOpacity
                        style={[styles.promoActionBtn, { backgroundColor: C.pageBg, borderColor: C.border }]}
                        activeOpacity={0.8}
                        onPress={() => createTestPlanFromCurrent(promoName, promoPlan.body || promoPlan.title, promoPlan)}
                      >
                        <Text style={[styles.promoActionText, { color: C.textPrimary }]}>加入测品计划</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.promoActionBtn, { backgroundColor: C.primary }]}
                        activeOpacity={0.8}
                        onPress={() => { setPromoConfirm(false); setPromoPlan(null); setPromoName('') }}
                      >
                        <Text style={[styles.promoActionText, { color: '#fff' }]}>重新生成</Text>
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity style={{ marginTop: 8, alignSelf: 'flex-end' }} activeOpacity={0.7} onPress={() => { setPromoConfirm(false); setPromoPlan(null); setPromoName('') }}>
                      <Text style={{ fontSize: 13, color: C.primary }}>再生成一个 ›</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* 模型品牌选择弹层（紧凑下拉，避免占用输入区空间） */}
      <Modal visible={modelPickerOpen} transparent animationType="fade" onRequestClose={() => setModelPickerOpen(false)}>
        <TouchableOpacity style={styles.sheetMask} activeOpacity={1} onPress={() => setModelPickerOpen(false)}>
          <View style={styles.sheet} onStartShouldSetResponder={() => true}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>选择回答模型</Text>
            <ScrollView style={styles.sheetList}>
              {MODEL_BRANDS.map((b) => (
                <TouchableOpacity
                  key={b.key}
                  style={[styles.sheetItem, model === b.key && styles.sheetItemActive]}
                  activeOpacity={0.8}
                  onPress={() => { setModel(b.key); modelStorage.set(b.key); setModelPickerOpen(false) }}
                >
                  <View style={styles.sheetItemIcon}>
                    <ModelIcon model={b.key} size={24} rounded />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sheetItemText, model === b.key && styles.sheetItemTextActive]}>{b.label}</Text>
                    {b.hint ? <Text style={styles.sheetItemHint}>{b.hint}</Text> : null}
                  </View>
                  {model === b.key ? <Text style={styles.sheetCheck}>✓</Text> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  )
}

// 快捷问题：场景化分组（选方向 / 跟爆款 / 算佣金 / 定打法），跟随全品类/美妆切换
type ScenarioPrompt = { label: string; prompt: string }
type ScenarioGroup = { key: string; title: string; prompts: ScenarioPrompt[] }

const SCENARIO_GROUPS: Record<'general' | 'beauty', ScenarioGroup[]> = {
  general: [
    {
      key: 'dir', title: '选方向', prompts: [
        { label: '选个新手友好的品类', prompt: '帮我选一个适合新手、佣金空间不错的带货品类方向，并说明为什么' },
        { label: '还有什么蓝海方向', prompt: '现在电商带货还有什么蓝海 / 低竞争的品类方向值得做？' },
        { label: '500 块怎么起步', prompt: '我只有 500 块启动资金，适合做什么品类、怎么用联盟带货起步？' },
        { label: '四季什么品好卖', prompt: '按季节看，一年四季分别什么品类更好卖、现在该提前备什么？' },
      ],
    },
    {
      key: 'hot', title: '跟爆款', prompts: [
        { label: '今日各品类爆款榜', prompt: '给我今日各品类（美妆 / 零食 / 女装 / 家居等）的爆款榜 Top20' },
        { label: '这个类目还能做吗', prompt: '最近口红这个类目为什么火？现在入场还来得及吗，竞争怎么样' },
      ],
    },
    {
      key: 'comm', title: '算佣金', prompts: [
        { label: '哪个品类佣金最高', prompt: '帮我对比主流带货品类的联盟佣金水平，哪个最划算、最适合新手' },
        { label: '怎么用联盟链接带货', prompt: '怎么用联盟链接 / 淘客带货变现？佣金怎么结算' },
        { label: '佣金坑位费怎么谈', prompt: '找主播带货时，佣金和坑位费一般怎么谈、新手怎么避免被坑？' },
        { label: '退货扣佣金吗', prompt: '联盟带货的佣金会被退货扣吗？实际到手怎么算？' },
      ],
    },
    {
      key: 'plan', title: '定打法', prompts: [
        { label: '抖音还是小红书', prompt: '我适合做抖音还是小红书带货？各自起量逻辑有什么不同' },
        { label: '给我 7 天测品计划', prompt: '给我一个 7 天测品计划模板，包含选品、内容、数据复盘' },
        { label: '新手第一单发什么', prompt: '我是纯新手，第一条带货内容应该发什么、发在哪个平台？' },
        { label: '没量怎么调方向', prompt: '上架一周了没量，怎么看数据判断是品不行还是内容不行？' },
      ],
    },
  ],
  // [beauty-only] 以下 quick questions 仅 category==='beauty' 时渲染，general 模式不显示；
  // 新增「全品类 / C端」通用问题请加到上方 general 组，勿在此混入口径。
  beauty: [
    {
      key: 'dir', title: '选方向', prompts: [
        { label: '选个新手友好的美妆方向', prompt: '帮我选一个适合新手起量、佣金不错的美妆方向（如护肤 / 彩妆 / 个护），并说明理由' },
        { label: '美妆还有什么蓝海', prompt: '现在美妆里还有什么低竞争、有利润空间的细分方向？' },
        { label: '护肤还是彩妆好起量', prompt: '新手做护肤和做彩妆，哪个更容易起量、佣金更高？' },
        { label: '男士美妆能做吗', prompt: '男士护肤 / 男士彩妆现在值得做吗，竞争和机会怎么样？' },
      ],
    },
    {
      key: 'hot', title: '跟爆款', prompts: [
        { label: '今日美妆爆款榜', prompt: '给我今日美妆爆款榜 Top20，按销量和佣金综合排序' },
        { label: '这个类目还能做吗', prompt: '最近防晒霜这个类目为什么火？现在入场还来得及吗，竞争怎么样' },
      ],
    },
    {
      key: 'comm', title: '算佣金', prompts: [
        { label: '哪个美妆品类佣金高', prompt: '对比护肤 / 彩妆 / 个护的联盟佣金水平，哪个最划算' },
        { label: '美妆怎么用淘客带货', prompt: '美妆怎么用淘客 / 联盟链接带货变现？' },
        { label: '大促佣金更高吗', prompt: '618 / 双11 美妆佣金和券通常会更高吗，怎么借大促冲量？' },
        { label: '样品怎么低成本拿', prompt: '新手想测美妆品，怎么低成本拿到样品、避免压货？' },
      ],
    },
    {
      key: 'plan', title: '定打法', prompts: [
        { label: '抖音还是小红书', prompt: '美妆我适合做抖音还是小红书？各自起量逻辑有什么不同' },
        { label: '给我 7 天测品计划', prompt: '给我一个美妆 7 天测品计划，含选品、内容、复盘' },
        { label: '美妆内容怎么拍', prompt: '美妆带货内容（测评 / 种草 / 教程）新手怎么拍更容易出单？' },
        { label: '怎么判断品靠不靠谱', prompt: '拿到一个美妆品，怎么看成分 / 资质 / 口碑判断它值不值得带？' },
      ],
    },
  ],
}

// B 端静态场景分组（招商铺货口径）：仅作为「无热词 / 热词未加载」时的 fallback 使用，
// 话术与 C 端 SCENARIO_GROUPS 完全区分（供货价 / 渠道 / 代理 / 分销 / 铺货），保证 B 端看到的是招商视角。
const SCENARIO_GROUPS_B: Record<'general' | 'beauty', ScenarioGroup[]> = {
  general: [
    {
      key: 'dir', title: '选方向', prompts: [
        { label: '选个好招商的品类', prompt: '帮我选一个适合招商铺货、利润空间不错的品类方向，并说明为什么' },
        { label: '还有什么蓝海渠道', prompt: '现在电商还有什么低竞争、适合招商铺货的蓝海渠道方向值得做？' },
        { label: '500 块怎么起步招商', prompt: '我只有 500 块启动资金，适合做什么品类的招商铺货、怎么用代理分销起步？' },
        { label: '四季什么品好铺', prompt: '按季节看，一年四季分别什么品类更好铺货、现在该提前备什么渠道？' },
      ],
    },
    {
      key: 'hot', title: '跟爆款', prompts: [
        { label: '今日各品类爆款榜', prompt: '给我今日各品类（美妆 / 零食 / 女装 / 家居等）的爆款榜 Top20，从招商铺货视角看需求和利润' },
        { label: '这个类目还能招商吗', prompt: '最近口红这个类目为什么火？现在做招商铺货还来得及吗，竞争和利润怎么样' },
      ],
    },
    {
      key: 'comm', title: '算利润', prompts: [
        { label: '哪个品类供货利润高', prompt: '帮我对比主流品类的供货利润空间，哪个最划算、最适合招商铺货' },
        { label: '怎么谈渠道代理', prompt: '怎么用代理 / 分销体系把货铺出去？渠道政策怎么谈、新手怎么避免被坑？' },
        { label: '坑位费怎么谈', prompt: '找主播带货时，坑位费和佣金一般怎么谈、利润怎么留？' },
        { label: '退货谁承担', prompt: '招商铺货的货如果被退，成本和损失一般怎么分摊、实际利润怎么算？' },
      ],
    },
    {
      key: 'plan', title: '定打法', prompts: [
        { label: '抖音还是小红书铺', prompt: '我适合做抖音还是小红书招商铺货？各自渠道逻辑有什么不同' },
        { label: '给我 7 天招商计划', prompt: '给我一个 7 天招商铺货计划模板，包含选品、渠道、数据复盘' },
        { label: '新手第一单铺什么', prompt: '我是纯新手商家，第一批货应该铺什么品类、铺在哪个渠道？' },
        { label: '没量怎么调渠道', prompt: '铺了一周没量，怎么看数据判断是品不行还是渠道不行？' },
      ],
    },
  ],
  beauty: [
    {
      key: 'dir', title: '选方向', prompts: [
        { label: '选个好招商的美妆方向', prompt: '帮我选一个适合招商铺货、利润不错的美妆方向（护肤 / 彩妆 / 个护），并说明理由' },
        { label: '美妆还有什么蓝海', prompt: '现在美妆里还有什么低竞争、有利润空间的细分招商方向？' },
        { label: '护肤还是彩妆好铺', prompt: '新手做护肤和做彩妆招商，哪个利润更高、更好铺货？' },
        { label: '男士美妆能招商吗', prompt: '男士护肤 / 男士彩妆现在值得招商铺货吗，竞争和机会怎么样？' },
      ],
    },
    {
      key: 'hot', title: '跟爆款', prompts: [
        { label: '今日美妆爆款榜', prompt: '给我今日美妆爆款榜 Top20，从招商铺货视角按销量和利润综合排序' },
        { label: '这个类目还能招商吗', prompt: '最近防晒霜这个类目为什么火？现在做招商铺货还来得及吗，竞争和利润怎么样' },
      ],
    },
    {
      key: 'comm', title: '算利润', prompts: [
        { label: '哪个美妆品类利润高', prompt: '对比护肤 / 彩妆 / 个护的供货利润空间，哪个最划算' },
        { label: '美妆怎么谈渠道', prompt: '美妆怎么用代理 / 分销 / 一件代发把货铺出去？渠道政策怎么谈' },
        { label: '大促利润更高吗', prompt: '618 / 双11 美妆供货利润和渠道政策通常会更好吗，怎么借大促冲量？' },
        { label: '样品怎么低成本拿', prompt: '新手想测美妆品，怎么低成本拿到样品、避免压货？' },
      ],
    },
    {
      key: 'plan', title: '定打法', prompts: [
        { label: '抖音还是小红书铺', prompt: '美妆我适合做抖音还是小红书招商铺货？各自渠道逻辑有什么不同' },
        { label: '给我 7 天招商计划', prompt: '给我一个美妆 7 天招商铺货计划，含选品、渠道、复盘' },
        { label: '美妆怎么铺货', prompt: '美妆招商铺货（代理 / 分销 / 一件代发）新手怎么铺更容易出货？' },
        { label: '怎么判断品靠不靠谱', prompt: '拿到一个美妆品，怎么看成分 / 资质 / 渠道判断它值不值得铺？' },
      ],
    },
  ],
}

function truncName(name: string, n = 10): string {
  const s = (name || '').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

// 场景分组：把「跟爆款」组用实时热搜词动态替换（方案 B 叠加），无热词时回退静态文案。
// 受众模式：C=个人带货（佣金/种草/粉丝，默认）；B=商家招商（供货价/渠道/铺货）。
// 同一批热词按受众切换提问视角与话术，避免「选了 B端 却还是 C端 带货口吻」。
function buildScenarioGroups(
  category: 'general' | 'beauty',
  hotWords: string[],
  seed = 0,
  audience: 'C' | 'B' = 'C'
): ScenarioGroup[] {
  // 无热词（或热词未加载）时回退到静态场景分组，按品类 + 受众切换话术，
  // 保证欢迎区 / 底部快捷条始终有内容，且 C/B 受众看到的是不同视角。
  if (!hotWords.length) {
    const fallback = audience === 'B' ? SCENARIO_GROUPS_B[category] : SCENARIO_GROUPS[category]
    return fallback || []
  }
  let state = (seed || 1) >>> 0
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
  const shuffled = [...hotWords]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const words = shuffled.slice(0, 12)
  const isB = audience === 'B'
  const suffix = isB
    ? (category === 'beauty' ? '美妆铺货' : '铺货')
    : (category === 'beauty' ? '美妆带货' : '带货')
  const groups: ScenarioGroup[] = isB
    ? [
        { key: 'online_opportunity', title: '招商机会', prompts: words.slice(0, 3).map((word) => ({ label: `${truncName(word, 10)}值得招商吗`, prompt: `结合网上最新热度，分析${word}现在是否值得招商铺货，说明市场需求、竞争强度、利润空间和渠道建议。` })) },
        { key: 'online_competition', title: '竞争判断', prompts: words.slice(3, 6).map((word) => ({ label: `${truncName(word, 10)}竞争怎么切`, prompt: `根据网上最新趋势，判断${word}的竞争强度、增长阶段和适合切入的细分渠道或代理方向。` })) },
        { key: 'online_commission', title: '利润渠道', prompts: words.slice(6, 9).map((word) => ({ label: `${truncName(word, 10)}怎么铺货`, prompt: `围绕${word}，结合当前网上热度，给我供货价、利润空间、渠道政策和铺货建议。` })) },
        { key: 'online_action', title: '行动建议', prompts: words.slice(9, 12).map((word) => ({ label: `${truncName(word, 10)}怎么起步`, prompt: `我想把${word}${suffix}，请结合最新网上信息给我一套招商铺货与渠道拓展的起步方案。` })) },
      ]
    : [
        { key: 'online_opportunity', title: '实时机会', prompts: words.slice(0, 3).map((word) => ({ label: `${truncName(word, 10)}值得做吗`, prompt: `结合网上最新热度，分析${word}现在是否值得做${suffix}，说明需求、竞争、佣金和入场建议。` })) },
        { key: 'online_competition', title: '竞争判断', prompts: words.slice(3, 6).map((word) => ({ label: `${truncName(word, 10)}竞争怎么样`, prompt: `根据网上最新趋势，判断${word}的竞争强度、增长阶段和适合切入的细分方向。` })) },
        { key: 'online_commission', title: '佣金转化', prompts: words.slice(6, 9).map((word) => ({ label: `${truncName(word, 10)}佣金怎么做`, prompt: `围绕${word}，结合当前网上热度，给我佣金、客单价、转化和选品建议。` })) },
        { key: 'online_action', title: '行动建议', prompts: words.slice(9, 12).map((word) => ({ label: `${truncName(word, 10)}怎么起步`, prompt: `我想做${word}${suffix}，请结合最新网上信息给我一个低成本起步和7天验证方案。` })) },
      ]
  return groups.filter((group) => group.prompts.length > 0)
}

// 对话/池子视图底部的折叠快捷条：跟随品类切换，取场景化问题（chat）或池子专属问题（pool）
function buildContextChips(
  view: 'chat' | 'pool',
  candItems: ProductCandidate[],
  seed: number,
  category: 'general' | 'beauty',
  hotWords: string[],
  audience: 'C' | 'B' = 'C'
): QuickChip[] {
  const chips: QuickChip[] = []
  if (view === 'pool') {
    if (candItems.length > 0) {
      const byComm = [...candItems].sort((a, b) => (b.commissionRatio ?? 0) - (a.commissionRatio ?? 0))[0]
      const full = (byComm && (byComm.productName || byComm.brand)) || '这个商品'
      chips.push({ id: 'pool_promo', label: `给「${truncName(full)}」写推广方案`, prompt: `给「${full}」写一份单品推广方案，包含 C 端主流推广（内容种草/佣金带货）与 B 端主流推广（招商铺货/渠道分销）` })
      chips.push({ id: 'pool_compare', label: '对比我池里的商品', prompt: '把今日机会商品池里的商品按佣金/价格/竞争做个横向对比，帮我排个测品优先级' })
      chips.push({ id: 'pool_order', label: '按佣金排测品顺序', prompt: '按佣金从高到低，给我一个测品顺序建议，并说明为什么这么排' })
    } else {
      chips.push({ id: 'pool_empty', label: '怎么把商品加进池子', prompt: '怎么把聊出来的商品自动加进今日机会商品池？' })
    }
    chips.push({ id: 'pool_newbie', label: '哪个方向适合新手', prompt: '现在电商带货里哪个方向最适合新手起量？' })
    return chips.slice(0, 4)
  }

  // 首页/对话：扁平化当前品类的场景化问题（跟爆款组由实时热词替换），按 seed 洗牌取前 6（供「换一批」）
  const groups = buildScenarioGroups(category, hotWords, 0, audience)
  const flat: QuickChip[] = groups.flatMap((g) =>
    g.prompts.map((p) => ({ id: `s_${g.key}_${p.label}`, label: p.label, prompt: p.prompt }))
  )
  let s = seed + 1
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  const arr = [...flat]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr.slice(0, 6)
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.pageBg, margin: 0, padding: 0 },
  // 会员态：中性蓝白底（C.pageBg），不复用金渐变——金仅限会员中心桥 chip 等会员徽标语义（硬约束⑤）
  safeMember: { backgroundColor: C.pageBg },
  scrollMember: { backgroundColor: 'transparent' },
  scrollContentMember: { backgroundColor: 'transparent' },
  // 底部面板沿用中性描边，去金描边（硬约束⑤：中性页不得出现金描边）
  bottomPanelMember: { backgroundColor: 'transparent', borderTopColor: C.border },
  scroll: { flex: 1, backgroundColor: 'transparent' },
  // 底部留白：给绝对定位 bottomPanel（灵感折叠条+用量提示+单胶囊输入框≈150px）让位，避免最后一条消息被遮
  scrollContent: { paddingBottom: 155, backgroundColor: 'transparent' },
  // 圆形跳转钮（瞬间到顶/底）：悬浮在 composer 上方右下角
  scrollFab: {
    position: 'absolute',
    right: 16,
    bottom: 168,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
    ...Platform.select({
      web: { boxShadow: '0 4px 12px rgba(0,0,0,0.18)' },
      default: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 8 },
    }),
  },
  scrollFabIcon: { color: '#fff', fontSize: 20, fontWeight: '700', lineHeight: 24 },
  navbar: { position: 'relative', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 0, paddingTop: spacing.lg, paddingBottom: spacing.sm, zIndex: 20 },
  navTitle: { fontSize: fontSize.lg, fontWeight: '700', color: C.primaryDark },
  // 中度升级：顶栏品牌区 = logo + 标题 + "对话工作台"蓝色空间标识（三重 cue：蓝条/工作台/会员金桥）
  navTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  spaceTag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(37,99,235,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(37,99,235,0.28)',
    marginLeft: 2,
  },
  spaceTagText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.04, color: C.primary },
  avatarBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.primary + '20', alignItems: 'center', justifyContent: 'center' },
  loginPill: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: radius.lg, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  loginText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  accountMenu: { position: 'absolute', top: 52, right: 0, width: 180, backgroundColor: C.cardBg, borderRadius: radius.md, padding: spacing.sm, zIndex: 10, ...elevation.float, borderWidth: 1, borderColor: C.border },
  accountText: { color: C.textSecondary, fontSize: fontSize.xs, marginBottom: spacing.sm, paddingHorizontal: spacing.xs },
  accountItem: { paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, borderRadius: radius.sm },
  accountItemText: { color: C.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  logoutText: { color: C.danger, fontSize: fontSize.sm, fontWeight: '600' },
  avatarText: { fontSize: fontSize.sm, color: C.primary, fontWeight: '600' },
  newChatBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.lg, backgroundColor: C.primary + '12' },
  newChatGlyph: { fontSize: 18, color: C.primary, fontWeight: '700' },
  newChatText: { fontSize: fontSize.sm, color: C.primary, fontWeight: '700' },
  hotSection: { backgroundColor: C.cardBg, borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: spacing.md },
  // 展开区容器：高度由 hotAnim 插值驱动，overflow hidden 裁切实现「慢慢拉下/收回」
  hotPanel: { overflow: 'hidden' },
  hotHeader: { paddingHorizontal: spacing.md, marginBottom: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  // 折叠态表头（可点击整行展开/收起）
  hotHeaderBtn: { marginBottom: 0, cursor: 'pointer' as any },
  hotToggleWrap: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, marginRight: spacing.xs },
  hotToggleCaret: { fontSize: 12, color: C.primary, fontWeight: '600' },
  hotTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary },
  hotMeta: { fontSize: 11, color: C.textMuted, marginTop: 3 },
  // 实时选品参考：搜索 + 刷新（在标题下方、筛选面板上方）
  hotSearchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  hotSearchBox: { flex: 1, backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  hotSearchInput: { fontSize: 16, color: C.textPrimary, outlineStyle: 'none' as any }, // ≥16 防 iOS 聚焦智能缩放；去掉浏览器原生聚焦黄圈
  hotRefreshBtn: { borderWidth: 1, borderColor: C.primary, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  hotRefreshBtnText: { color: C.primary, fontSize: 12, fontWeight: '700' },
  hotEmpty: { paddingHorizontal: spacing.md, color: C.textMuted, fontSize: 13 },
  skeletonRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  skeletonCol: { paddingHorizontal: spacing.md, gap: spacing.sm, paddingVertical: spacing.sm },
  // 实时选品参考筛选 - 玻璃态面板
  spotFilterPanel: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.30)',
    borderRadius: 16,
    padding: spacing.md,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px) saturate(150%)',
        WebkitBackdropFilter: 'blur(20px) saturate(150%)',
        boxShadow: '0 4px 16px rgba(59,130,246,0.10)',
      },
      default: {
        elevation: 4,
      },
    }),
  },
  spotFilterSection: {
    flex: 1,
  },
  spotFilterLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: C.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  spotFilterBottom: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  spotFilterRow: { paddingHorizontal: spacing.md, marginTop: spacing.xs },
  spotChipScroll: { gap: 8, paddingVertical: 2 },
  spotChipGroup: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', flex: 1 },
  spotChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(59,130,246,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.20)',
    ...Platform.select({
      web: {
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 2px 6px rgba(59,130,246,0.06)',
      },
      default: {
        elevation: 2,
      },
    }),
  },
  // 选中态：蓝底白字 + 强烈品牌阴影
  spotChipActive: {
    backgroundColor: C.primary,
    borderColor: C.primary,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 4px 12px rgba(59,130,246,0.35), 0 2px 4px rgba(59,130,246,0.20)',
      },
      default: {
        shadowColor: C.primary,
        shadowOpacity: 0.35,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
      },
    }),
  },
  spotChipText: { fontSize: 13, fontWeight: '600', color: C.primary },
  spotChipTextActive: { color: '#fff', fontWeight: '700' },
  hotContent: { paddingHorizontal: spacing.md },
  // 顶部分段切换（品类模式）：iOS 风 —— 灰底轨道 + 白色滑块
  segTrack: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: C.borderLight,
    borderRadius: radius.lg,
    padding: 3,
  },
  segSeg: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: radius.lg - 4,
  },
  segSegActive: {
    backgroundColor: C.cardBg,
    shadowColor: C.textPrimary,
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  segText: { fontSize: 13.5, fontWeight: '600', color: C.textSecondary },
  segTextActive: { color: C.primaryDark, fontWeight: '700' },
  // 美妆专属：对话 / 今日机会·商品池（iOS 风分段控件：浅灰轨道 + 白色滑块 + 微阴影）
  viewSegTrack: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: C.borderLight,
    borderRadius: radius.lg,
    padding: 3,
  },
  viewSeg: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: radius.lg - 4,
  },
  viewSegActive: {
    backgroundColor: C.cardBg,
    shadowColor: C.textPrimary,
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  viewSegText: { fontSize: 13, fontWeight: '600', color: C.textSecondary },
  viewSegTextActive: { color: C.primaryDark, fontWeight: '700' },
  // 主题（全品类/美妆）：内联在「问问 AI」输入栏里的小型切换
  themeInline: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.borderLight, borderRadius: 999, padding: 2 },
  // 控制行：品类 + 受众 + 模型，单行紧凑排布
  themeDivider: { width: 1, height: 14, backgroundColor: C.border, marginHorizontal: 2, opacity: 0.6 },
  themeChip: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: 999 },
  themeChipActive: { backgroundColor: C.cardBg },
  // 模型品牌切换：紧凑下拉触发条（与品类/受众同一行右侧）
  modelPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.borderLight, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  modelPillValue: { fontSize: 11.5, color: C.textPrimary, fontWeight: '700', maxWidth: 130 },
  modelPillCaret: { fontSize: 11, color: C.textSecondary, marginLeft: 3 },
  // AI 决策免责声明：输入框下方的小字提示，用户需自行核实判断
  disclaimerText: { fontSize: 11, color: C.textMuted, textAlign: 'center', marginTop: 6, paddingBottom: 2 },
  // 模型选择弹层（底部 sheet）
  sheetMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.cardBg, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8, paddingBottom: 24, maxHeight: '72%' },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginBottom: 8 },
  sheetTitle: { fontSize: 14, fontWeight: '700', color: C.textPrimary, textAlign: 'center', marginBottom: 8 },
  sheetList: { maxHeight: 340 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 18 },
  sheetItemActive: { backgroundColor: C.goldBg },
  sheetItemIcon: { marginRight: 12, justifyContent: 'center' },
  sheetItemText: { fontSize: 15, color: C.textPrimary, fontWeight: '600' },
  sheetItemTextActive: { color: C.goldDeep, fontWeight: '700' },
  sheetItemHint: { fontSize: 11.5, color: C.textMuted, marginTop: 2 },
  sheetCheck: { fontSize: 16, color: C.goldDeep, fontWeight: '700', marginLeft: 10 },
  themeChipText: { fontSize: 11.5, color: C.textSecondary, fontWeight: '600' },
  themeChipTextActive: { color: C.primaryDark, fontWeight: '700' },
  // 未登录提示条：玻璃态
  loginHint: { 
    position: 'relative', 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: 'rgba(59,130,246,0.08)', 
    borderWidth: 1, 
    borderColor: 'rgba(59,130,246,0.25)', 
    borderRadius: radius.md, 
    paddingHorizontal: spacing.md, 
    paddingVertical: spacing.sm, 
    marginHorizontal: spacing.md, 
    marginBottom: spacing.sm,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      },
    }),
  },
  loginHintBody: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  loginHintText: { flex: 1, fontSize: 12.5, color: C.textSecondary, lineHeight: 18 },
  loginHintStrong: { color: C.primary, fontWeight: '700' },
  loginHintCta: { fontSize: 12.5, color: C.primary, fontWeight: '700' },
  loginHintClose: { paddingHorizontal: spacing.sm, paddingVertical: 2, marginLeft: spacing.sm },
  loginHintCloseText: { fontSize: 14, color: C.textMuted, fontWeight: '600' },
  // 商品池视图
  poolSection: { paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  poolHead: {
    marginBottom: spacing.sm,
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    borderLeftWidth: 3,
    borderLeftColor: C.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  poolHeadTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  poolTitle: { fontSize: 16, fontWeight: '700', color: C.textPrimary },
  poolCount: { backgroundColor: C.primary + '14', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, minWidth: 26, alignItems: 'center' },
  poolCountText: { fontSize: 13, fontWeight: '700', color: C.primary },
  poolSub: { fontSize: 12, color: C.textMuted, marginTop: 4 },
  loadingText: { fontSize: 13, color: C.textMuted, paddingVertical: spacing.md },
  welcomeSection: { paddingHorizontal: spacing.md, paddingVertical: spacing.xl },
  welcomeTitle: { fontSize: 26, fontWeight: '700', color: C.textPrimary, lineHeight: 36 },
  welcomeSub: { fontSize: 13, color: C.textSecondary, marginTop: spacing.sm, lineHeight: 20 },
  // 快捷问题：欢迎区场景分组（方案 A + 滚动样式）——每组标题 + 横向滚动 chips 行
  scenarioWrap: { marginTop: spacing.lg },
  scenarioHead: { fontSize: 13, fontWeight: '700', color: C.textSecondary, marginBottom: spacing.xs },
  scenarioRow: { marginBottom: spacing.sm },
  scenarioRowTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: 6,
    borderLeftWidth: 3,
    borderLeftColor: C.primary,
    paddingLeft: 8,
  },
  scenarioChipScroll: { paddingRight: spacing.md, gap: spacing.xs },
  scenarioChip: { marginRight: 0 },
  // 单品深度诊断 CTA：玻璃态
  diagCta: {
    marginTop: spacing.lg,
    backgroundColor: isDark ? 'rgba(15,26,46,0.66)' : 'rgba(255,255,255,0.60)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.30)',
    borderRadius: 16,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    alignItems: 'flex-start',
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        boxShadow: '0 4px 16px rgba(59,130,246,0.12)',
      },
      default: {
        elevation: 4,
      },
    }),
  },
  diagCtaText: { fontSize: 15, fontWeight: '700', color: C.primary },
  diagCtaSub: { fontSize: 12, color: C.textMuted, marginTop: 4 },
  diagGo: { backgroundColor: C.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  diagGoDisabled: { opacity: 0.5 },
  diagGoText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  diagScoreRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  diagScoreBox: { width: 72, height: 72, borderRadius: 14, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  diagScoreNum: { fontSize: 28, fontWeight: '800', color: '#fff' },
  diagScoreLabel: { fontSize: 11, color: '#fff', opacity: 0.9, marginTop: 2 },
  diagSummary: { fontSize: 14, fontWeight: '600', color: C.textPrimary, lineHeight: 21 },
  diagKw: { fontSize: 11, color: C.textMuted, marginTop: 4 },
  diagBlock: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border },
  diagBlockTitle: { fontSize: 13, fontWeight: '700', color: C.textPrimary, marginBottom: 6 },
  diagBody: { fontSize: 13, color: C.textSecondary, lineHeight: 20 },
  diagBullet: { fontSize: 13, color: C.textSecondary, lineHeight: 20 },
  diagSignalRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  diagSignal: { fontSize: 12, color: C.textPrimary, backgroundColor: C.pageBg, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8 },
  diagCompRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  diagCompTitle: { fontSize: 12, color: C.textPrimary, fontWeight: '600' },
  diagCompMeta: { fontSize: 11, color: C.textMuted, marginTop: 2 },
  diagCompLink: { fontSize: 12, color: C.primary, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4 },
  diagActionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 14 },
  diagActionBtn: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  diagActionText: { fontSize: 13, fontWeight: '700' },
  promoActionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 6 },
  promoActionBtn: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  promoActionText: { fontSize: 13, fontWeight: '700' },
  chatContainer: { paddingTop: spacing.lg },
  loading: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.textMuted },
  dot2: { opacity: 0.7 },
  dot3: { opacity: 0.5 },
  // 建议问题条：紧凑单行横滑，去掉原来厚重的圆角卡片边框，降低纵向占用
  quickBar: { marginBottom: spacing.xs },
  // 建议区折叠容器：动态高度动画（收起 0 / 展开 40），内部 overflow hidden 平滑过渡
  quickWrap: { marginBottom: spacing.xs, overflow: 'hidden' },
  quickContent: { paddingRight: spacing.md, gap: spacing.xs, alignItems: 'center' },
  // 快捷问题 chip：玻璃态
  quickChip: { 
    backgroundColor: 'rgba(59,130,246,0.12)', 
    paddingHorizontal: spacing.md, 
    paddingVertical: 6, 
    borderRadius: 999, 
    borderWidth: 1, 
    borderColor: 'rgba(59,130,246,0.25)', 
    marginRight: spacing.xs,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 2px 6px rgba(59,130,246,0.08)',
      },
    }),
  },
  quickChipText: { fontSize: 12.5, color: C.primary, fontWeight: '500' },
  quickChipRefresh: { backgroundColor: 'transparent', borderStyle: 'dashed', borderColor: C.textMuted + '80', paddingHorizontal: spacing.md, paddingVertical: 6 },
  quickChipRefreshText: { color: C.textMuted, fontWeight: '600' },
  // 跟随商品卡：玻璃态
  recoWrap: {
    backgroundColor: isDark ? 'rgba(15,26,46,0.62)' : 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(33,48,74,0.60)' : 'rgba(255,255,255,0.30)',
    borderRadius: 16,
    padding: spacing.sm,
    marginBottom: spacing.xs,
    ...Platform.select({
      web: { 
        backdropFilter: 'blur(20px) saturate(150%)',
        WebkitBackdropFilter: 'blur(20px) saturate(150%)',
        boxShadow: '0 8px 32px rgba(59,130,246,0.12), 0 2px 8px rgba(15,23,42,0.04)',
      },
      default: { 
        shadowColor: '#3B82F6', 
        shadowOffset: { width: 0, height: 4 }, 
        shadowOpacity: 0.12, 
        shadowRadius: 16, 
        elevation: 8,
      },
    }),
  },
  recoHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 6 },
  recoDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: C.primary },
  recoHeadText: { fontSize: 12.5, fontWeight: '700', color: C.textPrimary },
  recoHeadHint: { fontSize: 11.5, color: C.primary, fontWeight: '600' },
  // 底部 composer：玻璃态增强版
  bottomPanel: { 
    position: 'absolute', 
    bottom: 0, 
    left: 0, 
    right: 0, 
    backgroundColor: isDark ? 'rgba(15,26,46,0.72)' : 'rgba(255,255,255,0.70)', 
    borderTopWidth: 1, 
    borderTopColor: isDark ? 'rgba(33,48,74,0.60)' : 'rgba(255,255,255,0.30)', 
    paddingHorizontal: spacing.md, 
    paddingTop: 4, 
    paddingBottom: Platform.OS === 'ios' ? 18 : 4,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(24px) saturate(170%)',
        WebkitBackdropFilter: 'blur(24px) saturate(170%)',
        boxShadow: '0 -4px 24px rgba(59,130,246,0.08)',
      },
      default: {
        elevation: 12,
      },
    }),
  },
  // 用量 / 会员提示 + 建议问题展开：合并到顶行，省竖向空间
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  usageRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  usageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.textMuted, marginRight: 6 },
  usageDotGold: { backgroundColor: C.goldDeep },
  usageText: { fontSize: 11.5, color: C.textMuted, fontWeight: '500' },
  usageTextGold: { color: C.goldDeep },
  genSlowText: { fontSize: 11.5, color: C.textMuted, paddingVertical: 2 },
  usageAction: { fontSize: 11.5, color: C.primary, fontWeight: '700', marginLeft: 6 },
  // 单胶囊输入框：玻璃态
  // 光标式输入面板：纵向容器，内部「胶囊顶栏(模型+品类)」+「输入行」两段
  inputCapsule: { 
    flexDirection: 'column', 
    alignItems: 'stretch', 
    backgroundColor: isDark ? 'rgba(15,26,46,0.66)' : 'rgba(255,255,255,0.60)', 
    borderRadius: radius.xl, 
    borderWidth: 1, 
    borderColor: isDark ? 'rgba(33,48,74,0.70)' : 'rgba(255,255,255,0.40)', 
    paddingLeft: spacing.xs, 
    paddingRight: spacing.xs, 
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        boxShadow: '0 2px 8px rgba(15,23,42,0.04)',
      },
      default: {
        elevation: 2,
      },
    }),
  },
  // 胶囊内顶栏：模型选择器 + 品类/受众 chip，横向排布（Cursor 风格镶嵌）
  capsuleTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 4 },
  // 输入行：＋ · 多行输入 · 右侧圆形按钮（横向）
  capsuleInputRow: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, fontSize: 16, color: C.textPrimary, paddingVertical: 6, minHeight: 34, outlineStyle: 'none' as any }, // ≥16 防 iOS 聚焦智能缩放
  plusBtn: { width: 34, height: 34, borderRadius: 999, backgroundColor: C.primary + '10', alignItems: 'center', justifyContent: 'center', marginRight: spacing.xs },
  plusText: { color: C.primary, fontSize: 20, fontWeight: '500', lineHeight: 22, textAlign: 'center' },
  morphBtn: { width: 40, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginLeft: spacing.xs },
  morphSend: { backgroundColor: C.primaryDark, ...Platform.select({ web: { boxShadow: '0 2px 8px rgba(30,64,175,0.35)' }, default: { elevation: 3 } }) },
  morphStop: { backgroundColor: '#e5484d' },
  morphVoice: { backgroundColor: C.primary, ...Platform.select({ web: { boxShadow: '0 2px 8px rgba(59,130,246,0.30)' }, default: { elevation: 2 } }) },
  morphIcon: { color: '#fff', fontSize: 17, fontWeight: '700', textAlign: 'center', lineHeight: 20 },
  // 工具图标钮（Gemini 风格：麦克风/图片等低频功能用图标省略，不占文字）
  toolIconBtn: { width: 34, height: 34, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginLeft: spacing.xs, backgroundColor: C.borderLight },
  toolIcon: { color: C.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 18 },
  chipsToggle: { paddingVertical: 2, paddingLeft: spacing.md },
  chipsToggleText: { fontSize: 12.5, color: C.textMuted, fontWeight: '500' },
  actionBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  actionSheet: { backgroundColor: C.cardBg, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: Platform.OS === 'ios' ? 32 : 16 },
  actionTitle: { fontSize: 13, color: C.textMuted, marginBottom: 12, textAlign: 'center' },
  // ＋ 面板顶部「对话设置」：模型 + 品类 + 受众，从输入胶囊收纳，点击可切换/展开
  composerSettings: {
    backgroundColor: isDark ? 'rgba(15,26,46,0.5)' : 'rgba(59,130,246,0.04)',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  composerSettingsLabel: { fontSize: 12, fontWeight: '700', color: C.textSecondary, marginBottom: spacing.sm },
  composerSettingsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  composerSettingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: C.primary + '12',
  },
  composerSettingText: { fontSize: 12, fontWeight: '700', color: C.primary },
  composerSettingDivider: { width: 1, height: 18, backgroundColor: C.border },
  composerSettingChip: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'transparent',
  },
  composerSettingChipActive: { backgroundColor: C.primary + '12' },
  composerSettingChipText: { fontSize: 12, fontWeight: '600', color: C.textMuted },
  composerSettingChipTextActive: { color: C.primary, fontWeight: '700' },
  actionItem: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.border },
  actionItemText: { fontSize: 15, fontWeight: '600', color: C.textPrimary },
  actionItemSub: { fontSize: 12, color: C.textMuted, marginTop: 3 },
  actionItemDisabled: { opacity: 0.45 },
  actionItemTextDisabled: { color: C.textMuted },
  actionCancel: { marginTop: 12, backgroundColor: C.pageBg, borderRadius: 12, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  actionCancelText: { fontSize: 15, fontWeight: '600', color: C.textPrimary },
  modalOverlay: { flex: 1, flexDirection: 'row' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.3)' },
  sidebar: { 
    width: 300, 
    backgroundColor: isDark ? 'rgba(15,26,46,0.72)' : 'rgba(255,255,255,0.70)', 
    borderTopRightRadius: 16, 
    borderBottomRightRadius: 16, 
    ...Platform.select({ 
      web: { 
        backdropFilter: 'blur(24px) saturate(170%)',
        WebkitBackdropFilter: 'blur(24px) saturate(170%)',
        boxShadow: '4px 0 32px rgba(59,130,246,0.15), 0 0 0 1px rgba(255,255,255,0.30)',
      }, 
      default: { 
        shadowColor: '#3B82F6', 
        shadowOffset: { width: 4, height: 0 }, 
        shadowOpacity: 0.15, 
        shadowRadius: 24, 
        elevation: 20,
      },
    }),
  },
  sidebarHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: C.border },
  sidebarTitle: { fontSize: 18, fontWeight: '700', color: C.textPrimary },
  closeBtn: { fontSize: 24, color: C.textSecondary, lineHeight: 28 },
  searchBox: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: C.border },
  searchInput: { backgroundColor: C.pageBg, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2, fontSize: 16, color: C.textPrimary, borderWidth: 1, borderColor: C.border, outlineStyle: 'none' as any }, // ≥16 防 iOS 聚焦智能缩放；去掉浏览器原生聚焦黄圈
  sessionList: { flex: 1 },
  sessionItem: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: C.border, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sessionItemActive: { backgroundColor: C.primary + '08' },
  sessionTitle: { fontSize: 14, fontWeight: '600', color: C.textPrimary, marginBottom: 4 },
  sessionTime: { fontSize: 12, color: C.textMuted },
  deleteBtn: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  deleteBtnText: { fontSize: 12, color: C.danger || '#f44336' },
  })
}
