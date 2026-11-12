import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import Svg, { Circle, G } from 'react-native-svg'
import { ScreenFrame } from '../components/ScreenFrame'
import { colors, radius, spacing, dark } from '../theme'
import { useTheme } from '../utils/theme'
import { billingAPI } from '../utils/api'

/**
 * 管理员运营分析页（对标 Analytics 极简金融风格）。
 * 视觉语言：顶部分段胶囊（概览/收入/模型/事件）+ 中央圆环图 + 右侧图例 + 核心大数字 + 下方列表行，
 * 全页以品牌单一强调蓝 #3B82F6 克制使用，其余走中性灰阶。
 * 数据源：GET /billing/admin/report（仅管理员可见，入口由 ProfileScreen 的 is_admin 分支给出）。
 */

type TabKey = 'overview' | 'income' | 'model' | 'event'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'income', label: '收入' },
  { key: 'model', label: '模型' },
  { key: 'event', label: '事件' },
]

// 已知模型映射（优先精确命中，未命中走下面的归一化兜底）
const MODEL_LABEL: Record<string, string> = {
  'deepseek-ai/DeepSeek-V4-Flash': 'V4-Flash',
  'deepseek-ai/DeepSeek-V4-Pro': 'V4-Pro',
  'deepseek-ai/DeepSeek-R1': 'R1',
  'deepseek-ai/DeepSeek-V3': 'V3',
  'Qwen/Qwen3.5-35B-A3B': 'Qwen3.5',
  'zai-org/GLM-5.2': 'GLM5.2',
  'Pro/zai-org/GLM-5.1': 'GLM5.1',
  'zai-org/GLM-5.1': 'GLM5.1',
  'moonshotai/Kimi-K2.7-Code': 'Kimi K2.7',
  'moonshotai/Kimi-K2.6': 'Kimi K2.6',
  'Pro/moonshotai/Kimi-K2.6': 'Kimi K2.6',
}

// 模型展示名归一化：剥掉 Pro/ 等档位前缀与供应商前缀，只留核心名
function modelName(key: string): string {
  if (MODEL_LABEL[key]) return MODEL_LABEL[key]
  // 归一化：剥掉 Pro/ 档位前缀 + 供应商前缀，只留核心名；Qwen 带参数量后缀时精简
  let name = key
    .replace(/^Pro\//, '')
    .replace(/^deepseek-ai\//, '')
    .replace(/^zai-org\//, '')
    .replace(/^moonshotai\//, '')
    .replace(/^Qwen\//, '')
    .replace(/-35B-A3B$/i, '')
  return name || key
}

// 事件类型友好短名
const EVENT_LABEL: Record<string, string> = {
  chat: '问答',
  card_llm: '卡片生成',
  card_data_insight: '数据卡',
  card_opportunity: '机会卡',
  card_product: '商品卡',
  card_trend: '趋势卡',
  deep_diagnosis: '深度诊断',
  alliance_api: '联盟 API',
  recharge: '充值',
  product_intro: '商品介绍',
  promo_plan: '推广方案',
  hot_pick: '爆品推荐',
}

const DONUT_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#0EA5E9', '#C9A24B', '#64748B']

interface OpsReport {
  total_revenue_yuan?: number
  user_charge_yuan?: number
  platform_cost_yuan?: number
  gross_profit_yuan?: number
  active_users?: number
  user_events?: number
  internal_events?: number
  arpu_yuan?: number
  recharge_count?: number
  recharge_users?: number
  recharge_amount_yuan?: number
  coupon_issued?: number
  coupon_used?: number
  coupon_used_amount_yuan?: number
  free_events?: number
  paid_events?: number
  paid_users?: number
  pay_rate?: number
  daily_recharge?: { date: string; amount_yuan: number }[]
  by_model?: { model: string; cost_yuan: number; tokens_in: number; tokens_out: number; events: number }[]
  by_event?: { event_type: string; cost_yuan: number; events: number }[]
}

function fmtYuan(value: number | undefined | null): string {
  const n = Number(value ?? 0)
  if (n >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  return n.toFixed(2)
}

function fmtCompact(n: number | undefined | null): string {
  const v = Number(n ?? 0)
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`
  return `${Math.round(v)}`
}

// ── 概览：核心大数字卡 ──────────────────────────────
function HeroMetric({ label, value, sub, emphasis, C }: { label: string; value: string; sub?: string; emphasis?: boolean; C: any }) {
  return (
    <View style={[styles.heroMetric, emphasis && { borderColor: `${C.primary}44`, backgroundColor: `${C.primary}0A` }]}>
      <Text style={[styles.heroMetricValue, { color: emphasis ? C.primary : C.textPrimary }]}>{value}</Text>
      <Text style={[styles.heroMetricLabel, { color: C.textSecondary }]}>{label}</Text>
      {sub ? <Text style={[styles.heroMetricSub, { color: C.textMuted }]}>{sub}</Text> : null}
    </View>
  )
}

// ── 概览/收入：近 7 天充值柱状图 ────────────────────
function RechargeBars({ daily, C }: { daily: { date: string; amount_yuan: number }[]; C: any }) {
  if (!Array.isArray(daily) || daily.length === 0) return null
  const max = Math.max(...daily.map((d) => d.amount_yuan || 0), 1)
  const peakIdx = daily.reduce((best, d, i) => (d.amount_yuan > (daily[best]?.amount_yuan || 0) ? i : best), 0)
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: C.textPrimary }]}>近 7 天充值</Text>
        <Text style={[styles.sectionHint, { color: C.textMuted }]}>峰值 {fmtYuan(daily[peakIdx]?.amount_yuan)} 元</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 110 }}>
        {daily.map((d, i) => {
          const h = Math.max(8, Math.round((d.amount_yuan / max) * 100))
          const isPeak = i === peakIdx
          return (
            <View key={d.date} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
              <Text style={{ fontSize: 10, color: C.textMuted, marginBottom: 3 }} numberOfLines={1}>
                {fmtYuan(d.amount_yuan)}
              </Text>
              <View
                style={{
                  width: '100%',
                  height: h,
                  borderRadius: 6,
                  backgroundColor: isPeak ? C.primary : `${C.primary}88`,
                }}
              />
              <Text style={{ fontSize: 10, color: C.textMuted, marginTop: 4 }} numberOfLines={1}>
                {d.date.slice(5).replace('-', '/')}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

// ── 模型：成本占比圆环图 + 图例 ─────────────────────
function ModelDonut({ list, C, isDark }: { list: { model: string; cost_yuan: number }[]; C: any; isDark: boolean }) {
  const total = useMemo(() => list.reduce((s, m) => s + (m.cost_yuan || 0), 0), [list])
  if (list.length === 0) return null

  const size = 168
  const stroke = 20
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const circ = 2 * Math.PI * r
  const gap = 3 // 段间隙（px）

  let offsetAcc = 0
  const segs = list.map((m, i) => {
    const share = total > 0 ? (m.cost_yuan || 0) / total : 0
    const len = Math.max(0, share * circ - gap)
    const seg = { color: DONUT_COLORS[i % DONUT_COLORS.length], len, dashoffset: -offsetAcc, share, name: modelName(m.model), cost: m.cost_yuan || 0 }
    offsetAcc += share * circ
    return seg
  })

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={[styles.sectionTitle, { color: C.textPrimary }]}>模型成本占比</Text>
        <Text style={[styles.sectionHint, { color: C.textMuted }]}>{list.length} 个模型</Text>
      </View>
      <View style={styles.donutRow}>
        <View style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={size} height={size}>
            <G rotation={-90} origin={`${cx}, ${cy}`}>
              <Circle cx={cx} cy={cy} r={r} stroke={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)'} strokeWidth={stroke} fill="none" />
              {segs.map((s, i) => (
                <Circle
                  key={i}
                  cx={cx}
                  cy={cy}
                  r={r}
                  stroke={s.color}
                  strokeWidth={stroke}
                  fill="none"
                  strokeDasharray={`${s.len} ${circ - s.len}`}
                  strokeDashoffset={s.dashoffset}
                  strokeLinecap="round"
                />
              ))}
            </G>
          </Svg>
          <View style={styles.donutCenter}>
            <Text style={[styles.donutCenterValue, { color: C.textPrimary }]}>¥{fmtYuan(total)}</Text>
            <Text style={[styles.donutCenterLabel, { color: C.textMuted }]}>平台成本</Text>
          </View>
        </View>

        <View style={styles.donutLegend}>
          {segs.slice(0, 5).map((s, i) => (
            <View key={i} style={styles.legendRow}>
              <View style={[styles.legendDot, { backgroundColor: s.color }]} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.legendName, { color: C.textPrimary }]} numberOfLines={1}>{s.name}</Text>
                <Text style={[styles.legendCost, { color: C.textMuted }]}>¥{fmtYuan(s.cost)}</Text>
              </View>
              <Text style={[styles.legendShare, { color: C.textSecondary }]}>{(s.share * 100).toFixed(0)}%</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  )
}

// ── 通用：横向条占比 ────────────────────────────────
function ShareBars({ rows, C, isDark }: { rows: { key: string; label: string; value: number; display: string; color?: string }[]; C: any; isDark: boolean }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <View style={styles.section}>
      {rows.slice(0, 6).map((r, i) => (
        <View key={r.key} style={{ marginBottom: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
            <Text style={{ fontSize: 11, color: C.textSecondary, flexShrink: 1 }} numberOfLines={1}>{r.label}</Text>
            <Text style={{ fontSize: 11, color: C.textMuted }}>{r.display}</Text>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.06)', overflow: 'hidden' }}>
            <View
              style={{
                width: `${Math.max(2, Math.round((r.value / max) * 100))}%`,
                height: '100%',
                borderRadius: 4,
                backgroundColor: r.color || DONUT_COLORS[i % DONUT_COLORS.length],
              }}
            />
          </View>
        </View>
      ))}
    </View>
  )
}

// ── 通用：统计行列表 ────────────────────────────────
function StatList({ rows, C }: { rows: { label: string; value: string; sub?: string; emphasis?: boolean }[]; C: any }) {
  return (
    <View style={styles.statList}>
      {rows.map((r, i) => (
        <View key={i} style={[styles.statRow, i < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(148,163,184,0.18)' }]}>
          <Text style={[styles.statLabel, { color: C.textSecondary }]}>{r.label}</Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.statValue, { color: r.emphasis ? C.primary : C.textPrimary }, r.emphasis && { fontWeight: '700' }]}>{r.value}</Text>
            {r.sub ? <Text style={[styles.statSub, { color: C.textMuted }]}>{r.sub}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  )
}

/**
 * 管理员运营分析页。四个分段 Tab，对标 Analytics：中央圆环 + 图例 + 核心数字 + 列表行。
 */
export function AdminAnalyticsScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [tab, setTab] = useState<TabKey>('overview')
  const [ops, setOps] = useState<OpsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await billingAPI.getOpsReport()
      setOps(res as unknown as OpsReport)
    } catch (e: any) {
      setError(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (visible) load()
  }, [visible, load])

  const revenue = ops?.recharge_amount_yuan ?? 0
  const cost = ops?.platform_cost_yuan ?? 0
  const gross = ops?.gross_profit_yuan ?? 0
  const costShare = revenue > 0 ? Math.min(100, Math.max(0, ((cost / revenue) * 100))) : 0
  const grossShare = Math.max(0, 100 - costShare)

  const modelRows = (ops?.by_model || []).map((m) => ({
    key: m.model,
    label: `${modelName(m.model)} · ${m.events || 0} 次`,
    value: m.cost_yuan || 0,
    display: `${fmtYuan(m.cost_yuan)} / ${m.tokens_in ? fmtCompact(m.tokens_in) : 0} tok`,
  }))

  const eventRows = (ops?.by_event || []).map((e) => ({
    key: e.event_type,
    label: EVENT_LABEL[e.event_type] || e.event_type,
    value: e.events || 0,
    display: `${e.events || 0} 次`,
  }))

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="运营分析">
      <View style={{ marginBottom: spacing.md }}>
        <Text style={[styles.title, { color: C.textPrimary }]}>运营数据</Text>
        <Text style={[styles.subtitle, { color: C.textSecondary }]}>收入 · 成本 · 毛利 · 充值 · 模型与事件构成</Text>
      </View>

      {/* 顶部分段胶囊 */}
      <View style={[styles.segmented, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)' }]}>
        {TABS.map((t) => {
          const on = tab === t.key
          return (
            <TouchableOpacity
              key={t.key}
              activeOpacity={0.85}
              onPress={() => setTab(t.key)}
              style={[styles.segment, on && { backgroundColor: C.primary }]}
            >
              <Text style={[styles.segmentText, { color: on ? '#fff' : C.textSecondary }, on && { fontWeight: '700' }]}>{t.label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {error ? <Text style={[styles.error, { color: C.danger }]}>{error}</Text> : null}
      {loading && !ops ? <Text style={[styles.empty, { color: C.textMuted }]}>加载中…</Text> : null}

      {ops && tab === 'overview' && (
        <View style={styles.tabBody}>
          {/* 核心大数字：总收入 hero + 三小卡 */}
          <View style={styles.heroCard}>
            <Text style={[styles.heroLabel, { color: C.textSecondary }]}>充值收入</Text>
            <Text style={[styles.heroValue, { color: C.textPrimary }]}>¥{fmtYuan(revenue)}</Text>
            <View style={styles.heroSubRow}>
              <Text style={[styles.heroSub, { color: C.textMuted }]}>累计 {fmtYuan(ops.total_revenue_yuan)} 元</Text>
              <Text style={[styles.heroSub, { color: C.textMuted }]}>成本 ¥{fmtYuan(cost)}</Text>
            </View>
          </View>

          <View style={styles.metricGrid}>
            <HeroMetric label="毛利" value={`¥${fmtYuan(gross)}`} sub={`${grossShare.toFixed(0)}%`} emphasis C={C} />
            <HeroMetric label="ARPU" value={`¥${fmtYuan(ops.arpu_yuan)}`} sub="人均充值" C={C} />
            <HeroMetric label="付费率" value={`${((ops.pay_rate ?? 0) * 100).toFixed(1)}%`} sub={`${ops.paid_users ?? 0} 付费`} C={C} />
            <HeroMetric label="活跃用户" value={fmtCompact(ops.active_users)} sub="总数" C={C} />
          </View>

          {/* 收入结构条 */}
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={[styles.sectionTitle, { color: C.textPrimary }]}>收入结构</Text>
              <Text style={[styles.sectionHint, { color: C.textMuted }]}>每 ¥1 充值的去向</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: 6 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: C.textSecondary }}>平台成本</Text>
                <Text style={{ fontSize: 12, fontWeight: '700', color: C.textMuted }}>{costShare.toFixed(0)}%</Text>
              </View>
              <View style={{ flex: 1, alignItems: 'flex-end' }}>
                <Text style={{ fontSize: 11, color: C.textSecondary, textAlign: 'right' }}>毛利占比</Text>
                <Text style={{ fontSize: 12, fontWeight: '700', color: C.primary }}>{grossShare.toFixed(0)}%</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: C.borderLight }}>
              {costShare > 0 && <View style={{ width: `${costShare}%`, backgroundColor: isDark ? '#64748B' : '#94A3B8' }} />}
              {grossShare > 0 && <View style={{ width: `${grossShare}%`, backgroundColor: C.primary }} />}
            </View>
          </View>

          {/* 用户/付费/券 明细列表 */}
          <StatList
            C={C}
            rows={[
              { label: '充值人数', value: `${ops.recharge_users ?? 0} 人` },
              { label: '付费用户', value: `${ops.paid_users ?? 0} 人`, sub: `${ops.free_events ?? 0} 次免费 / ${ops.paid_events ?? 0} 次付费` },
              { label: '券发放 / 兑现', value: `${ops.coupon_issued ?? 0} / ${ops.coupon_used ?? 0}`, sub: `兑现 ¥${fmtYuan(ops.coupon_used_amount_yuan)}` },
            ]}
          />
        </View>
      )}

      {ops && tab === 'income' && (
        <View style={styles.tabBody}>
          <HeroMetric label="总收入" value={`¥${fmtYuan(ops.total_revenue_yuan)}`} emphasis C={C} />
          <View style={styles.metricGrid}>
            <HeroMetric label="充值收入" value={`¥${fmtYuan(revenue)}`} C={C} />
            <HeroMetric label="平台成本" value={`¥${fmtYuan(cost)}`} C={C} />
            <HeroMetric label="毛利" value={`¥${fmtYuan(gross)}`} emphasis C={C} />
            <HeroMetric label="ARPU" value={`¥${fmtYuan(ops.arpu_yuan)}`} C={C} />
          </View>
          <RechargeBars daily={ops.daily_recharge || []} C={C} />
        </View>
      )}

      {ops && tab === 'model' && (
        <View style={styles.tabBody}>
          <ModelDonut list={ops.by_model || []} C={C} isDark={isDark} />
          <Text style={[styles.listTitle, { color: C.textPrimary }]}>模型成本明细</Text>
          <ShareBars rows={modelRows} C={C} isDark={isDark} />
        </View>
      )}

      {ops && tab === 'event' && (
        <View style={styles.tabBody}>
          <Text style={[styles.listTitle, { color: C.textPrimary }]}>事件构成</Text>
          <ShareBars rows={eventRows} C={C} isDark={isDark} />
          <StatList
            C={C}
            rows={[
              { label: '用户事件', value: fmtCompact(ops.user_events), sub: '外部用户产生的计费事件' },
              { label: '内部事件', value: fmtCompact(ops.internal_events), sub: '系统/运营内部调用' },
              { label: '免费 / 付费', value: `${ops.free_events ?? 0} / ${ops.paid_events ?? 0}`, sub: `付费事件占 ${((ops.paid_events ?? 0) / Math.max((ops.paid_events ?? 0) + (ops.free_events ?? 0), 1) * 100).toFixed(0)}%` },
            ]}
          />
        </View>
      )}
    </ScreenFrame>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: 19, fontWeight: '700', letterSpacing: -0.2, marginBottom: 2 },
  subtitle: { fontSize: 12, marginBottom: spacing.md },
  segmented: { flexDirection: 'row', padding: 4, borderRadius: 999, marginBottom: spacing.lg },
  segment: { flex: 1, paddingVertical: 8, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 13, fontWeight: '600' },
  error: { fontSize: 12, marginBottom: 10 },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 40 },
  tabBody: { gap: spacing.lg },
  heroCard: {
    padding: spacing.lg,
    borderRadius: radius.xl2,
    backgroundColor: 'rgba(59,130,246,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.16)',
  },
  heroLabel: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  heroValue: { fontSize: 32, fontWeight: '800', letterSpacing: -0.5, marginBottom: 8 },
  heroSubRow: { flexDirection: 'row', gap: spacing.md },
  heroSub: { fontSize: 12 },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  heroMetric: {
    width: '48.5%',
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.18)',
  },
  heroMetricValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.3, marginBottom: 2 },
  heroMetricLabel: { fontSize: 12 },
  heroMetricSub: { fontSize: 11, marginTop: 2 },
  section: { padding: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(148,163,184,0.16)' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  sectionHint: { fontSize: 11 },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  donutCenter: { position: 'absolute', alignItems: 'center', justifyContent: 'center', width: 168, height: 168 },
  donutCenterValue: { fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  donutCenterLabel: { fontSize: 11, marginTop: 1 },
  donutLegend: { flex: 1, gap: 8 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendName: { fontSize: 12, fontWeight: '600' },
  legendCost: { fontSize: 10 },
  legendShare: { fontSize: 13, fontWeight: '700' },
  listTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  statList: { borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(148,163,184,0.16)', overflow: 'hidden', paddingHorizontal: spacing.md },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.md },
  statLabel: { fontSize: 13 },
  statValue: { fontSize: 15, fontWeight: '600' },
  statSub: { fontSize: 11, marginTop: 1 },
})
