import React, { useMemo, useState } from 'react'
import { View, Text, StyleSheet, Image, TouchableOpacity, Platform } from 'react-native'
import { colors, radius, spacing, surfaceTints, darkSurfaceTints, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { OpportunityCard as OpportunityCardType } from '../../utils/types'
import { CountUp } from '../CountUp'
import { HoverLift } from '../Motion'

export function OpportunityCard({ data, onShowProducts }: { data: OpportunityCardType; onShowProducts?: () => void }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const T = isDark ? darkSurfaceTints : surfaceTints
  const riskLabels: Record<string, { label: string; color: string }> = {
    low: { label: '低风险', color: C.success },
    medium_low: { label: '中低风险', color: '#34D399' },
    medium: { label: '中等风险', color: C.warning },
    high: { label: '高风险', color: C.danger },
  }
  const risk = riskLabels[data.riskLevel]

  // ── 收益测算（L1 确定性）：基于真实平均单佣金额，用户可调「预计月成交单数」滑杆 ──
  // 只有拿到真实 avgCommissionMoney（¥/单）才启用，否则整块不渲染（避免编造数字）。
  const perOrder = data.metrics?.avgCommissionMoney
  const [monthOrders, setMonthOrders] = useState(200)
  const hasRevenue = typeof perOrder === 'number' && perOrder > 0
  const monthlyRevenue = useMemo(() => (hasRevenue ? Math.round(perOrder * monthOrders) : 0), [hasRevenue, perOrder, monthOrders])
  // 四个档位供快速点选
  const orderPresets = [50, 100, 200, 500]

  return (
    <HoverLift radius={radius.lg} style={[S.card, { backgroundColor: T.opportunity.bg, borderColor: T.opportunity.border }]}>
      {/* 顶部：标题 + 机会分（编辑式，去渐变/白字/大投影，分数已收敛为中性小字） */}
      <View style={S.header}>
        <View style={S.headText}>
          <Text style={S.title}>{data.title}</Text>
          <Text style={S.platform}>{data.suggestedPlatform}</Text>
        </View>
        <View style={S.scoreBox}>
          <CountUp value={data.opportunityScore} style={S.scoreNum} />
          <Text style={S.scoreLabel}>分</Text>
        </View>
      </View>

      {data.coverImage ? (
        <Image source={{ uri: data.coverImage }} style={S.cover} resizeMode="cover" />
      ) : null}

      <Text style={S.summary}>{data.summary}</Text>

      {/* 真实数据依据 */}
      {data.metrics ? (
        <View style={S.metrics}>
          <Text style={S.metricsHead}>数据依据 · {data.metrics.source}</Text>
          <View style={S.metricsRow}>
            <Text style={S.metricsText}>在售 <CountUp value={data.metrics.productCount} /> 款</Text>
            <Text style={S.metricsText}>价格带 {data.metrics.priceBand}</Text>
          </View>
          {data.metrics.topBrands.length > 0 ? (
            <Text style={S.metricsText}>头部品牌：{data.metrics.topBrands.join('、')}</Text>
          ) : null}
          <View style={S.metricsRow}>
            {data.metrics.avgCommissionText ? (
              <Text style={S.metricsText}>{data.metrics.avgCommissionText}</Text>
            ) : null}
            {data.metrics.totalSalesText ? (
              <Text style={S.metricsText}>{data.metrics.totalSalesText}</Text>
            ) : null}
          </View>
          {data.metrics.competitionNote ? (
            <Text style={S.metricsNote}>{data.metrics.competitionNote}</Text>
          ) : null}
        </View>
      ) : null}

      {/* 机会分依据：由真实信号确定性推导的加分/减分明细（竞争/佣金/销量），非 LLM 编造 */}
      {data.scoreFactors && data.scoreFactors.length > 0 ? (
        <View style={S.scoreBasis}>
          <Text style={S.basisHead}>机会分依据</Text>
          {data.scoreFactors.map((f, i) => {
            const plus = f.delta >= 0
            return (
              <View key={i} style={S.basisRow}>
                <View style={[S.basisBadge, { backgroundColor: (plus ? C.success : C.warning) + '15' }]}>
                  <Text style={[S.basisDelta, { color: plus ? C.success : C.warning }]}>
                    {plus ? '+' : ''}
                    {f.delta}
                  </Text>
                </View>
                <View style={S.basisBody}>
                  <Text style={S.basisLabel}>{f.label}</Text>
                  {f.detail ? <Text style={S.basisDetail}>{f.detail}</Text> : null}
                </View>
              </View>
            )
          })}
        </View>
      ) : null}

      {/* 收益预估（L1 确定性）：真实单佣金额 × 可调月单量 → 预估月收益，无真实数据不渲染 */}
      {hasRevenue ? (
        <View style={S.revenue}>
          <View style={S.revenueHead}>
            <Text style={S.revenueTitle}>收益预估 · 按真实单佣测算</Text>
            <Text style={S.revenuePer}>每单约 ¥{perOrder.toFixed(2)}</Text>
          </View>
          <View style={S.revenueBody}>
            <View style={S.revenueLine}>
              <Text style={S.revenueLabel}>预计月成交单数</Text>
              <Text style={S.revenueValue}>{monthOrders} 单</Text>
            </View>
            <View style={S.presetRow}>
              {orderPresets.map((p) => {
                const active = p === monthOrders
                return (
                  <TouchableOpacity key={p} activeOpacity={0.7} onPress={() => setMonthOrders(p)} style={[S.presetChip, active && S.presetChipActive]}>
                    <Text style={[S.presetText, active && S.presetTextActive]}>{p} 单</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
            <View style={S.revenueTotal}>
              <Text style={S.revenueTotalLabel}>预估月收益</Text>
              <Text style={S.revenueTotalValue}>
                <Text style={S.revenueCurrency}>¥</Text>
                <Text style={S.revenueNum}>{monthlyRevenue.toLocaleString()}</Text>
              </Text>
            </View>
            <Text style={S.revenueNote}>按该赛道真实平均单佣 ¥{perOrder.toFixed(2)}/单 测算，实际以你的出单与转化率为准</Text>
          </View>
        </View>
      ) : null}

      {/* 底部标签（描边芯片，去半透明白） */}
      <View style={S.tags}>
        <View style={S.tag}>
          <Text style={S.tagText}>竞争 {data.competitionLevel}</Text>
        </View>
        <View style={S.tag}>
          <Text style={S.tagText}>{risk.label}</Text>
        </View>
      </View>

      {onShowProducts ? (
        <TouchableOpacity style={S.actionBtn} activeOpacity={0.8} onPress={onShowProducts}>
          <Text style={S.actionBtnText}>看实时选品商品 ›</Text>
        </TouchableOpacity>
      ) : null}
    </HoverLift>
  )
}

type ColorSet = {
  textPrimary: string
  textSecondary: string
  textMuted: string
  pageBg: string
  border: string
  borderLight: string
  primary: string
  success: string
  warning: string
  danger: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.xl,
    marginBottom: spacing.md,
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
    // 生命力：hover 抬升 + 主蓝柔光（web）；reduce-motion 下仅保留边框高光，无位移
    ':hover': { transform: [{ translateY: -2 }], borderColor: C.primary + '40' },
  } as any,
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  headText: { flex: 1, marginRight: spacing.md },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: C.textPrimary,
    lineHeight: 26,
    marginBottom: 4,
  },
  platform: {
    fontSize: 13,
    color: C.textSecondary,
  },
  scoreBox: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  scoreNum: {
    fontSize: 26,
    fontWeight: '700',
    color: C.textPrimary,
    lineHeight: 32,
  },
  scoreLabel: {
    fontSize: 11,
    color: C.textMuted,
    marginTop: 2,
  },
  cover: {
    width: '100%',
    height: 120,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    backgroundColor: C.pageBg,
  },
  summary: {
    fontSize: 14,
    color: C.textPrimary,
    lineHeight: 21,
    marginBottom: spacing.md,
  },
  metrics: {
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.borderLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  metricsHead: {
    fontSize: 12,
    color: C.textSecondary,
    fontWeight: '600',
    marginBottom: 6,
  },
  metricsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: 4,
  },
  metricsText: {
    fontSize: 12,
    color: C.textPrimary,
    lineHeight: 18,
  },
  metricsNote: {
    fontSize: 11,
    color: C.textMuted,
    lineHeight: 16,
    marginTop: 6,
  },
  scoreBasis: {
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  basisHead: {
    fontSize: 13,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: spacing.sm,
  },
  basisRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  basisBadge: {
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    paddingVertical: 3,
    marginRight: spacing.sm,
  },
  basisDelta: {
    fontSize: 13,
    fontWeight: '700',
  },
  basisBody: {
    flex: 1,
  },
  basisLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textPrimary,
  },
  basisDetail: {
    fontSize: 11,
    color: C.textMuted,
    lineHeight: 15,
    marginTop: 1,
  },
  tags: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  tag: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  tagText: {
    fontSize: 12,
    color: C.textPrimary,
    fontWeight: '500',
  },
  actionBtn: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    backgroundColor: C.primary + '12',
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: C.primary,
  },
  // ── 收益预估区块 ──
  revenue: {
    backgroundColor: C.primary + '08',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.primary + '24',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  revenueHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  revenueTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: C.textSecondary,
  },
  revenuePer: {
    fontSize: 13,
    fontWeight: '700',
    color: C.success,
  },
  revenueBody: {},
  revenueLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  revenueLabel: {
    fontSize: 12,
    color: C.textSecondary,
  },
  revenueValue: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textPrimary,
  },
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  presetChip: {
    backgroundColor: C.primary + '0F',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  presetChipActive: {
    backgroundColor: C.primary,
    borderColor: C.primary,
  },
  presetText: {
    fontSize: 12,
    color: C.textSecondary,
    fontWeight: '500',
  },
  presetTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  revenueTotal: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: C.borderLight,
  },
  revenueTotalLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textSecondary,
  },
  revenueTotalValue: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  revenueCurrency: {
    fontSize: 15,
    fontWeight: '700',
    color: C.success,
  },
  revenueNum: {
    fontSize: 22,
    fontWeight: '700',
    color: C.success,
  },
  revenueNote: {
    fontSize: 11,
    color: C.textMuted,
    lineHeight: 15,
    marginTop: 8,
  },
  })
}
