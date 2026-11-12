import React, { useMemo, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, Platform, TouchableOpacity } from 'react-native'
import Svg, { Path, Circle, Line, Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg'
import { colors, radius, spacing, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { Trend } from '../../utils/types'
import { ProvenanceFooter } from './ProvenanceFooter'

// ── 工具 ──────────────────────────────────────────────
function formatSales(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return `${Math.round(n)}`
}

function fmtValue(key: string, v: number | null | undefined): string {
  if (v == null) return '—'
  if (key === 'total_sales') return formatSales(v)
  if (key === 'products') return `${Math.round(v)}`
  if (key === 'avg_price') return `¥${Math.round(v)}`
  if (key === 'avg_commission') return `${v.toFixed(1)}%`
  return `${Math.round(v)}`
}

function fmtAxis(key: string, v: number): string {
  if (key === 'total_sales') return formatSales(v)
  if (key === 'products') return `${Math.round(v)}`
  if (key === 'avg_price') return `¥${Math.round(v)}`
  if (key === 'avg_commission') return `${v.toFixed(0)}%`
  return `${Math.round(v)}`
}

const METRICS: { key: 'total_sales' | 'products' | 'avg_price' | 'avg_commission'; label: string; short: string }[] = [
  { key: 'total_sales', label: '月销合计', short: '月销' },
  { key: 'products', label: '在售款数', short: '款数' },
  { key: 'avg_price', label: '平均价', short: '均价' },
  { key: 'avg_commission', label: '平均佣金', short: '佣金' },
]

// 折线图尺寸（SVG viewBox 坐标空间）
const W = 560
const H = 170
const PAD_L = 40
const PAD_R = 12
const PAD_T = 26
const PAD_B = 24

export function TrendCard({ data }: { data: Trend }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [metric, setMetric] = useState<'total_sales' | 'products' | 'avg_price' | 'avg_commission'>('total_sales')

  const series = (data.series || []).filter((p) => p && typeof p[metric] === 'number')
  const kw = data.keyword || '该品类'

  // ── 空 / 单点降级 ──
  if (series.length === 0) {
    return (
      <View style={S.card}>
        <Text style={S.title}>{kw} 热度趋势</Text>
        <Text style={S.note}>暂未积累到该品类的历史快照，多问几次即可看到趋势曲线。</Text>
      </View>
    )
  }
  if (series.length === 1) {
    const only = series[0]
    return (
      <View style={S.card}>
        <Text style={S.title}>{kw} 热度趋势</Text>
        <View style={S.singleRow}>
          <Text style={S.singleValue}>{fmtValue(metric, only[metric])}</Text>
          <Text style={S.singleLabel}>{METRICS.find((m) => m.key === metric)?.label}（{only.date}）</Text>
        </View>
        <Text style={S.note}>数据累积中：跨天多搜几次该品类，即可生成趋势曲线。</Text>
      </View>
    )
  }

  // ── 计算折线坐标 ──
  const vals = series.map((p) => Number(p[metric]) || 0)
  const maxV = Math.max(...vals, 1)
  const minV = Math.min(...vals)
  const span = Math.max(maxV - minV, maxV * 0.15 || 1) // 防所有点相同导致除零
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const pts = series.map((p, i) => {
    const x = PAD_L + (i / Math.max(series.length - 1, 1)) * innerW
    const y = PAD_T + (1 - (Number(p[metric]) - minV) / span) * innerH
    return { x, y, date: (p.date || '').slice(5), v: Number(p[metric]) || 0, p }
  })

  // 折线 path + 面积 path
  const linePath = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(PAD_T + innerH).toFixed(1)} L${pts[0].x.toFixed(1)},${(PAD_T + innerH).toFixed(1)} Z`

  const first = pts[0]
  const last = pts[pts.length - 1]
  // 首→末涨跌（中国惯例：涨红跌绿）
  const delta = first.v > 0 ? ((last.v - first.v) / first.v) * 100 : 0
  const up = delta >= 0

  // 最高 / 最低点
  let hiIdx = 0, loIdx = 0
  pts.forEach((p, i) => { if (p.v > pts[hiIdx].v) hiIdx = i; if (p.v < pts[loIdx].v) loIdx = i })

  // 网格 Y 轴刻度（4 档）
  const gridLines = [0, 1, 2, 3].map((g) => {
    const y = PAD_T + (g / 3) * innerH
    const v = maxV - (g / 3) * span
    return { y, v }
  })

  const metricLabel = METRICS.find((m) => m.key === metric)?.label || ''

  return (
    <View style={S.card}>
      <Text style={S.title}>{kw} 热度趋势</Text>
      <Text style={S.subtitle}>
        近 {data.days || 60} 天 · 好单库在售商品
        <Text style={{ color: up ? C.danger : C.success }}> {metricLabel} {up ? '↑' : '↓'}</Text>
        {first.v > 0 ? `（首日→末日 ${up ? '+' : ''}${delta.toFixed(0)}%）` : ''}
      </Text>

      {/* 维度切换 */}
      <View style={S.metricTabs}>
        {METRICS.map((m) => (
          <TouchableOpacity
            key={m.key}
            activeOpacity={0.75}
            onPress={() => setMetric(m.key)}
            style={[S.metricTab, metric === m.key && S.metricTabActive]}
          >
            <Text style={[S.metricTabText, metric === m.key && S.metricTabTextActive]}>{m.short}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.chartScroll} contentContainerStyle={{ paddingVertical: 4 }}>
        <Svg width={Math.max(W, pts.length * 56)} height={H}>
          <Defs>
            <LinearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={up ? C.danger : C.success} stopOpacity={isDark ? 0.35 : 0.22} />
              <Stop offset="100%" stopColor={up ? C.danger : C.success} stopOpacity={0.02} />
            </LinearGradient>
          </Defs>

          {/* 网格 + Y 轴刻度 */}
          {gridLines.map((g, i) => (
            <React.Fragment key={i}>
              <Line x1={PAD_L} y1={g.y} x2={W - PAD_R} y2={g.y} stroke={C.border} strokeWidth={0.6} strokeDasharray={i === 3 ? undefined : '3,4'} />
              <SvgText x={PAD_L - 6} y={g.y + 3.5} fontSize={9} fill={C.textMuted} textAnchor="end">{fmtAxis(metric, g.v)}</SvgText>
            </React.Fragment>
          ))}

          {/* 面积 + 折线 */}
          <Path d={areaPath} fill="url(#areaGrad)" />
          <Path d={linePath} fill="none" stroke={up ? C.danger : C.success} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />

          {/* 数据点 + 数值标注 */}
          {pts.map((pt, i) => {
            const isHi = i === hiIdx
            const isLo = i === loIdx
            const dotColor = isHi ? C.danger : isLo ? C.success : C.primary
            return (
              <React.Fragment key={i}>
                <Circle cx={pt.x} cy={pt.y} r={isHi || isLo ? 4 : 2.8} fill={dotColor} />
                {/* 数值标注：最高/最低 + 首末显示，中间点也显示（小字） */}
                <SvgText
                  x={pt.x}
                  y={pt.y - 8}
                  fontSize={isHi || isLo ? 10 : 8.5}
                  fontWeight={isHi || isLo ? '700' : '400'}
                  fill={isHi || isLo ? dotColor : C.textSecondary}
                  textAnchor="middle"
                >
                  {fmtValue(metric, pt.v)}
                </SvgText>
              </React.Fragment>
            )
          })}

          {/* X 轴日期 */}
          {pts.map((pt, i) => (
            <SvgText key={`d${i}`} x={pt.x} y={H - 8} fontSize={8.5} fill={C.textMuted} textAnchor="middle">
              {pt.date}
            </SvgText>
          ))}

          {/* 首尾连线（虚线提示跨度） */}
          <Line x1={first.x} y1={first.y} x2={last.x} y2={last.y} stroke={up ? C.danger : C.success} strokeWidth={1} strokeDasharray="4,4" opacity={0.45} />
        </Svg>
      </ScrollView>

      {/* 关键数据行：最新值 / 最高 / 最低 */}
      <View style={S.statsRow}>
        <View style={S.stat}>
          <Text style={S.statLabel}>最新（{last.date}）</Text>
          <Text style={[S.statValue, { color: up ? C.danger : C.success }]}>{fmtValue(metric, last.v)}</Text>
        </View>
        <View style={S.stat}>
          <Text style={S.statLabel}>区间最高</Text>
          <Text style={[S.statValue, { color: C.danger }]}>{fmtValue(metric, pts[hiIdx].v)}</Text>
          <Text style={S.statSub}>{pts[hiIdx].date}</Text>
        </View>
        <View style={S.stat}>
          <Text style={S.statLabel}>区间最低</Text>
          <Text style={[S.statValue, { color: C.success }]}>{fmtValue(metric, pts[loIdx].v)}</Text>
          <Text style={S.statSub}>{pts[loIdx].date}</Text>
        </View>
      </View>

      <ProvenanceFooter source={data.source} note="聚合选品线索趋势，非平台真实成交数据" />
    </View>
  )
}

type ColorSet = {
  cardBg: string
  border: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  primary: string
  danger: string
  success: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  card: {
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: C.border,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(16px) saturate(130%)',
        WebkitBackdropFilter: 'blur(16px) saturate(130%)',
        boxShadow: isDark ? shadows.cardDark : shadows.card,
      },
      default: {
        shadowColor: C.textPrimary,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: isDark ? 0.40 : 0.10,
        shadowRadius: 20,
        elevation: 6,
      },
    }),
  } as any,
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: 12,
    color: C.textSecondary,
    marginBottom: spacing.md,
  },
  // 维度切换 Tab
  metricTabs: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: spacing.sm,
  },
  metricTab: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: C.primary + '0D',
    borderWidth: 1,
    borderColor: C.border,
  },
  metricTabActive: {
    backgroundColor: C.primary,
    borderColor: C.primary,
  },
  metricTabText: {
    fontSize: 11,
    fontWeight: '600',
    color: C.textSecondary,
  },
  metricTabTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  chartScroll: {
    flexDirection: 'row',
    marginBottom: spacing.md,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  stat: {
    flex: 1,
    padding: spacing.sm + 2,
    borderRadius: radius.md,
    backgroundColor: C.primary + '0A',
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 10,
    color: C.textMuted,
    marginBottom: 3,
  },
  statValue: {
    fontSize: 15,
    fontWeight: '800',
  },
  statSub: {
    fontSize: 9,
    color: C.textMuted,
    marginTop: 1,
  },
  singleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  singleValue: {
    fontSize: 22,
    fontWeight: '700',
    color: C.textPrimary,
  },
  singleLabel: {
    fontSize: 12,
    color: C.textSecondary,
  },
  note: {
    fontSize: 11,
    color: C.textMuted,
    lineHeight: 16,
  },
  })
}
