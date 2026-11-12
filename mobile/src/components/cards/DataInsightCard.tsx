import React, { useMemo } from 'react'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { colors, radius, spacing, surfaceTints, darkSurfaceTints, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { DataInsight } from '../../utils/types'
import { ProvenanceFooter } from './ProvenanceFooter'
import { HoverLift } from '../Motion'

type CardStyleSet = ReturnType<typeof buildStyles>

function formatPrice(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `¥${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}`
}

function sampleTrend(values: number[], maxPoints = 12) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length === 0) return []
  if (clean.length <= maxPoints) {
    return clean.map((value, index) => ({ value, index, isStart: index === 0, isEnd: index === clean.length - 1 }))
  }

  const sampled = [] as { value: number; index: number; isStart: boolean; isEnd: boolean }[]
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i * (clean.length - 1)) / (maxPoints - 1))
    sampled.push({
      value: clean[index],
      index,
      isStart: i === 0,
      isEnd: i === maxPoints - 1,
    })
  }
  return sampled
}

function TrendSparkline({ values, s, C }: { values: number[]; s: CardStyleSet; C: ColorSet }) {
  if (!values.length) return null
  const points = sampleTrend(values)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const lastIndex = points.length - 1
  const maxIndex = points.findIndex((p) => p.value === max)
  const minIndex = points.findIndex((p) => p.value === min)

  return (
    <View style={s.sparkCard}>
      <View style={s.sparkRow}>
        {points.map((p, i) => {
          const h = 12 + Math.round(((p.value - min) / span) * 34)
          const isLast = i === lastIndex
          const isHigh = i === maxIndex
          const isLow = i === minIndex
          const showLabel = isLast || isHigh || isLow || p.isStart
          const labelColor = isHigh ? C.warning : isLow ? C.success : C.primary
          const barColor = isLast ? C.primary : isHigh ? C.warning : isLow ? C.success : C.primary
          return (
            <View key={`${p.index}-${i}`} style={s.sparkCol}>
              <Text style={[s.sparkValueTag, { color: showLabel ? labelColor : C.textSecondary }]} numberOfLines={1}>
                {showLabel ? formatPrice(p.value) : ' '}
              </Text>
              <View style={s.sparkTrack}>
                <View
                  style={[
                    s.sparkBar,
                    {
                      height: h,
                      backgroundColor: barColor,
                      opacity: showLabel ? 1 : 0.45,
                    },
                  ]}
                />
                {isLast ? <View style={[s.sparkDot, { backgroundColor: C.primary }]} /> : null}
              </View>
              <Text style={[s.sparkLabel, { color: showLabel ? C.textSecondary : 'transparent' }]} numberOfLines={1}>
                {isHigh ? '高点' : isLow ? '低点' : isLast ? '当前' : p.isStart ? '起点' : ' '}
              </Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

export function DataInsightCard({ data }: { data: DataInsight }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const T = isDark ? darkSurfaceTints : surfaceTints
  // 只渲染后端真实下发的字段（好单库真实信号），空字段不展示，避免"空格异常"。
  const metrics: { label: string; value: string }[] = []
  if (data.avgPrice) metrics.push({ label: '爆款均价', value: data.avgPrice })
  if (data.priceBand) metrics.push({ label: '主流价格带', value: data.priceBand })
  if (data.competitionLevel) metrics.push({ label: '竞争强度', value: data.competitionLevel })
  if (data.avgCommission) metrics.push({ label: '平均佣金', value: data.avgCommission })
  if (data.totalSales) metrics.push({ label: '月销合计', value: data.totalSales })
  if (data.productCount !== undefined) metrics.push({ label: '在售商品', value: `${data.productCount} 款` })
  if (data.brandCount !== undefined) metrics.push({ label: '覆盖品牌', value: `${data.brandCount} 个` })

  const trendValues = (data.trend || []).map((p) => p.avgPrice).filter((v): v is number => v != null)
  const trendPoints = trendValues.length
  const trendFirst = trendPoints > 0 ? trendValues[0] : null
  const trendLast = trendPoints > 0 ? trendValues[trendPoints - 1] : null
  const trendHigh = trendPoints > 0 ? Math.max(...trendValues) : null
  const trendLow = trendPoints > 0 ? Math.min(...trendValues) : null
  const trendDelta = trendFirst != null && trendLast != null ? trendLast - trendFirst : null
  const momPct = trendFirst && trendLast ? ((trendLast - trendFirst) / trendFirst) * 100 : null
  const trendTone = (() => {
    if (momPct == null) return '暂无足够趋势数据'
    if (momPct >= 8) return '走强'
    if (momPct <= -8) return '回落'
    return '震荡'
  })()
  const trendSummary = (() => {
    if (momPct == null || trendFirst == null || trendLast == null) return '趋势样本不足，先看当前价格带。'
    const prefix = momPct >= 0 ? '近 60 天均价上行' : '近 60 天均价下行'
    const delta = trendDelta != null ? `${trendDelta >= 0 ? '+' : ''}${formatPrice(Math.abs(trendDelta))}` : ''
    return `${prefix} ${momPct >= 0 ? '+' : ''}${momPct.toFixed(1)}%，首尾变化 ${delta}`
  })()

  return (
    <HoverLift radius={radius.lg} style={[S.card, { backgroundColor: T.data.bg, borderColor: T.data.border }]}>
      <Text style={S.title}>数据</Text>

      {metrics.length > 0 ? (
        <View style={S.grid}>
          {metrics.map((m, idx) => (
            <View key={idx} style={S.metricBox}>
              <Text style={S.metricLabel}>{m.label}</Text>
              <Text style={S.metricValue}>{m.value}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={S.empty}>{data.note || '暂未取到该品类的真实联盟商品数据，无法给出可信价格带'}</Text>
      )}

      {data.trend && data.trend.length >= 2 ? (
        <View style={S.trendBox}>
          <View style={S.trendSummary}>
            <View style={S.trendSummaryHead}>
              <Text style={S.trendTitle}>近 60 天均价走势</Text>
              <Text style={[S.trendTone, { color: momPct != null ? (momPct >= 0 ? C.warning : C.success) : C.textSecondary }]}>
                {trendTone}
              </Text>
            </View>

            <View style={S.trendSummaryRow}>
              <View style={S.trendLeadValue}>
                <Text style={S.trendLeadNumber}>{trendLast != null ? formatPrice(trendLast) : '—'}</Text>
                <Text style={S.trendLeadLabel}>当前均价</Text>
              </View>

              <View style={S.trendLeadMeta}>
                {momPct != null ? (
                  <Text style={[S.trendMom, { color: momPct >= 0 ? C.warning : C.success }]}>
                    环比 {momPct >= 0 ? '+' : ''}{momPct.toFixed(1)}%
                  </Text>
                ) : null}
                <Text style={S.trendNarrative}>{trendSummary}</Text>
              </View>
            </View>
          </View>

          <View style={S.trendStatsRow}>
            <View style={S.trendStat}>
              <Text style={S.trendStatLabel}>高点</Text>
              <Text style={S.trendStatValue}>{trendHigh != null ? formatPrice(trendHigh) : '—'}</Text>
            </View>
            <View style={S.trendStat}>
              <Text style={S.trendStatLabel}>低点</Text>
              <Text style={S.trendStatValue}>{trendLow != null ? formatPrice(trendLow) : '—'}</Text>
            </View>
            <View style={S.trendStat}>
              <Text style={S.trendStatLabel}>首尾差</Text>
              <Text style={S.trendStatValue}>{trendDelta != null ? `${trendDelta >= 0 ? '+' : ''}${formatPrice(Math.abs(trendDelta))}` : '—'}</Text>
            </View>
            <View style={S.trendStat}>
              <Text style={S.trendStatLabel}>样本数</Text>
              <Text style={S.trendStatValue}>{trendPoints} 天</Text>
            </View>
          </View>

          <TrendSparkline values={trendValues} s={S} C={C} />
        </View>
      ) : null}

      {/* 真实数据溯源 + 可信度（后端统一下发，UI 透传展示） */}
      <ProvenanceFooter source={data.source} confidence={data.confidence} note={data.competitionNote} />
    </HoverLift>
  )
}

type ColorSet = {
  textPrimary: string
  textSecondary: string
  pageBg: string
  cardBg: string
  border: string
  primary: string
  success: string
  warning: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
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
    // 中度升级：hover 抬升 + 主蓝柔光（web）
    ':hover': { transform: [{ translateY: -2 }], borderColor: C.primary + '40' },
  } as any,
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: spacing.lg,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  metricBox: {
    width: '47%',
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  metricLabel: {
    fontSize: 12,
    color: C.textSecondary,
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: '700',
    color: C.textPrimary,
  },
  empty: {
    fontSize: 13,
    color: C.textSecondary,
    lineHeight: 20,
  },
  trendBox: {
    marginTop: spacing.md,
    backgroundColor: C.cardBg,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: C.border,
  },
  trendSummary: {
    marginBottom: spacing.md,
  },
  trendSummaryHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  trendTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: C.textPrimary,
  },
  trendTone: {
    fontSize: 12,
    fontWeight: '700',
  },
  trendSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  trendLeadValue: {
    minWidth: 86,
  },
  trendLeadNumber: {
    fontSize: 23,
    fontWeight: '700',
    color: C.textPrimary,
    lineHeight: 28,
  },
  trendLeadLabel: {
    fontSize: 11,
    color: C.textSecondary,
    marginTop: 2,
  },
  trendLeadMeta: {
    flex: 1,
    minWidth: 0,
  },
  trendMom: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  trendNarrative: {
    fontSize: 11,
    color: C.textSecondary,
    lineHeight: 17,
  },
  trendStatsRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  trendStat: {
    flex: 1,
    minWidth: 0,
    backgroundColor: C.pageBg,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  trendStatLabel: {
    fontSize: 10,
    color: C.textSecondary,
    marginBottom: 2,
  },
  trendStatValue: {
    fontSize: 12,
    fontWeight: '700',
    color: C.textPrimary,
  },
  sparkCard: {
    paddingTop: spacing.xs,
  },
  sparkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
    minHeight: 76,
    paddingHorizontal: 2,
  },
  sparkCol: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  sparkValueTag: {
    fontSize: 10,
    lineHeight: 13,
    height: 13,
  },
  sparkTrack: {
    width: '100%',
    height: 48,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  sparkBar: {
    width: '70%',
    minWidth: 4,
    maxWidth: 14,
    borderRadius: 3,
    backgroundColor: C.primary,
  },
  sparkDot: {
    position: 'absolute',
    bottom: -3,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: C.cardBg,
  },
  sparkLabel: {
    fontSize: 10,
    lineHeight: 13,
    height: 13,
    marginTop: 3,
  },
  })
}
