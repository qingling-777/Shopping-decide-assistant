export interface User {
  id: string
  account: string
  nickname?: string | null
  is_admin?: boolean
  is_member?: boolean
  email_verified?: boolean
  email?: string | null
  created_at: string
  referral_code?: string | null
}

export interface AuthResponse {
  access_token: string
  token_type: string
  user: User
}

// GET /billing/referral-code：我的邀请码 + 邀请数据
export interface ReferralInfo {
  referral_code: string | null
  invitees: number
  reward_yuan: number
}


export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  cards?: ChatCardItem[]
  followUpQuestions?: string[]
  thinkingSteps?: string[]
  cardHint?: string
  // 计费回执（硅基流动风格透明计费）：本次回答用了什么模型、多少 token、花费多少、是否免费
  usage?: MessageUsage | null
}

export interface MessageUsage {
  model?: string | null
  model_brand?: string | null
  tokens_in?: number
  tokens_out?: number
  cost_yuan?: number
  is_free?: boolean
  balance_after?: number
  free_remaining?: number
}

export interface ChatCardItem {
  cardType: string
  cardData: any
}

export interface ProductCardItem {
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
  pickReason?: string
  shopType?: string        // 平台：天猫 / 淘宝（好单库无此字段时为空）
  priceValue?: number | null  // 数值价（券后优先），供前端按价格排序
  // 大淘客明文 num_iid：存在时点「领券购买」走按需懒加载转链（带推广位、产生佣金），否则走好单库详情页
  goodsId?: string | null
}

// 贴链接单品诊断卡（大淘客实时联盟数据）
export interface LinkDiagnosisSimilar {
  id: string
  title: string
  priceText: string
  commissionRatio?: number | null
  sales?: number | null
  link?: string
}

export interface LinkDiagnosisComment {
  content: string
  rate?: number | string | null
}

export interface LinkDiagnosisCard {
  title: string
  image: string
  platform: string          // 天猫 / 淘宝
  shopType: string
  shop: string
  priceText: string
  couponInfo: string
  commissionRatio?: number | null
  commissionMoney?: number | null
  sales?: number | null
  goodsId?: string | null   // 前端按需懒加载转链用
  quickVerdict: string[]
  priceTrend?: {
    current?: number | null
    min?: number | null
    max?: number | null
    avg?: number | null
    sample_count?: number
    points?: { date: string; price: number }[]
  } | null
  similar: LinkDiagnosisSimilar[]
  ranking?: { rank_type: number; rank_name: string; rank: number | string } | null
  privilegeAvailable: boolean
  comments: LinkDiagnosisComment[]
  source: string
}

export interface ChatRequest {
  message: string
  history?: { role: string; content: string }[]
  // 品类模式：general=全品类宽泛问答(带佣金/联盟通用知识)，为默认；beauty=美妆专业问答(带美妆RAG，部件暂隐藏)。
  category?: string
  // 受众模式：C=消费者端/个人带货（默认）；B=商家企业端/招商铺货。
  audience?: string
  // 模型品牌：auto=默认（DeepSeek-V4-Flash 单一非推理）；r1 / deepseek / qwen 等。后端按品牌解析具体模型 + 兜底链。
  model?: string
}

export interface ChatResponse {
  message: string
  card_type?: string | null
  card_data?: any
}

export type GradientType = 'strong_recommend' | 'recommend' | 'cautious' | 'observe' | 'not_recommend'
export type Platform = 'douyin' | 'kuaishou' | 'xiaohongshu' | 'all'
export type RiskLevel = 'low' | 'medium_low' | 'medium' | 'high'

// ── P0：单品深度诊断 ──
export interface MarketSignals {
  product_count?: number
  distinct_brands?: number
  top_brands?: string[]
  price_min?: number
  price_max?: number
  price_median?: number
  price_band?: string
  avg_commission_ratio?: number
  avg_commission_money?: number
  total_sales?: number
  avg_sales?: number
}

export interface DiagnosisCompetitor {
  brand: string
  title: string
  price_text: string
  commission_ratio?: number | null
  sales?: number | null
  link: string
}

export interface DeepDiagnosis {
  productName: string
  keyword: string
  platform: string
  signals: MarketSignals | null
  competitors: DiagnosisCompetitor[]
  summary: string
  opportunityScore: number
  competition: string
  risk: string
  contentAngles: string[]
  nextSteps: string[]
  usage?: any
}

export interface OpportunityCard {
  id: string
  title: string
  opportunityScore: number
  competitionLevel: string
  riskLevel: RiskLevel
  suggestedPlatform: string
  summary: string
  gradientType: GradientType
  coverImage?: string
  metrics?: OpportunityMetrics
  scoreFactors?: { label: string; delta: number; detail?: string }[]
}

export interface OpportunityMetrics {
  productCount: number
  topBrands: string[]
  priceBand: string
  avgCommissionText: string
  totalSalesText: string
  source: string
  competitionNote?: string
  /** 平均单佣金额（¥/单），供确定性收益测算 */
  avgCommissionMoney?: number | null
  /** 平均佣金率（%） */
  avgCommissionRatio?: number | null
}

export interface ProductDirection {
  id: string
  directionName: string
  category: string
  priceRange: string
  targetUsers: string
  keySellingPoints: string[]
  suitablePlatforms: Platform[]
  contentAngles: string[]
  opportunity: OpportunityCard
}

export interface RadarItem {
  id: string
  rank: number
  directionName: string
  opportunityScore: number
  heatGrowth: number
  suggestedPlatforms: string[]
  riskLevel: RiskLevel
  category: string
}

export interface QuickChip {
  id: string
  label: string
  prompt: string
}

export interface HotCategory {
  id: string
  name: string
  tag: string
  score: number
  gradientType: GradientType
  category?: string
  group?: string
  // 原始搜索词（后端 search_keyword）：点卡片时对 /products/spotlight 拉相关商品更准
  keyword?: string
  searchCategory?: string
  suggestedPlatforms?: string[]
  dataDate?: string
  sourceCount?: number
  evidenceCount?: number
  confidence?: string
  scoreLabel?: string
  coverImage?: string
}

export interface OpportunityGroup {
  group: string
  items: HotCategory[]
}

export interface DataInsight {
  avgPrice: string
  priceBand: string
  competitionLevel: string
  productCount?: number
  brandCount?: number
  avgCommission?: string
  totalSales?: string
  source?: string
  confidence?: string
  note?: string
  competitionNote?: string
  trend?: { date: string; avgPrice?: number | null; totalSales?: number | null }[]
}

export interface TrendPoint {
  date: string
  products: number
  total_sales: number
  avg_price: number | null
  avg_commission: number | null
}

export interface Trend {
  keyword: string
  days: number
  series: TrendPoint[]
  source?: string
}

export interface ActionAdvice {
  actionTitle: string
  steps: string[]
}

export interface RiskCard {
  riskLevel: RiskLevel
  risks: string[]
  mitigation: string[]
  source?: string
  confidence?: string
  references?: { id: string; source: string; question: string }[]
}

// 后端 product_candidates 富字段候选（含 AI 补的方向标签/竞争等级/卖点/平台）
export interface ProductCandidate {
  id: string
  productName: string
  brand: string
  price: string
  sourceLink: string
  image?: string
  commissionRatio?: number | null
  commissionMoney?: number | null
  sales?: number | null
  source?: string
  couponInfo?: string
  detailUrl?: string
  directionTags?: string[]
  sellingPoints?: string[]
  competitionLevel?: string
  platform?: string
  updatedAt?: string
  archivedAt?: string
  favorited?: boolean
  // 佣金/价格变动提醒：后端 check-changes 写入的变动标记（命中时存最近一条 rec）
  changes?: Array<{
    id?: string
    productName?: string
    commOld: number | null
    commNew: number | null
    priceOld: string | null
    priceNew: string | null
    commChanged: boolean
    priceChanged: boolean
  }>
}

export interface PromoPlan {
  title: string
  hooks?: string[]
  body: string
  sellingPoints?: string[]
  // 加厚字段（后端结合商品介绍/联网测评/佣金/价格/竞品生成）
  targetAudience?: string
  influencerType?: string
  openingHook?: string
  commentInteraction?: string
  complianceRisk?: string
  kpi?: string
  abTest?: string
  budget?: string
  platforms?: { name: string; angle: string }[]
  schedule?: string
  // 透传：已核实的商品介绍摘要/卖点 + 联网测评来源
  introSummary?: string
  introHighlights?: string[]
  sources?: { title: string; link: string }[]
}

// 计划级整合推广策略（把测品计划内多个商品统筹成一套打法）
export interface PlanPromoStrategy {
  overview?: string
  theme?: string
  sequence?: string[]
  budgetSplit?: string
  risk?: string
  kpi?: string
  contentCalendar?: string
  platforms?: string[]
  planName?: string
  generatedAt?: string
}

// 后端商品介绍（好单库字段 + 联网真实测评文章，LLM 合成）
export interface ProductIntro {
  summary: string
  highlights?: string[]
  suitableFor?: string[]
  howToUse?: string
  pricePositioning?: string
  sources?: { title: string; link: string }[]
}
