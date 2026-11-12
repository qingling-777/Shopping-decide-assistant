import React, { useMemo } from 'react'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { colors, radius, spacing, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { ProvenanceFooter } from './ProvenanceFooter'

interface NextActionsCardProps {
  data: {
    product: string
    now: string[]
    this_week: string[]
    next_week: string[]
    source?: string
    confidence?: string
  }
}

export function NextActionsCard({ data }: NextActionsCardProps) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const phases = [
    { key: 'now', label: '现在可以做', color: C.success, items: data.now },
    { key: 'this_week', label: '本周要做', color: C.warning, items: data.this_week },
    { key: 'next_week', label: '下周要做', color: C.primary, items: data.next_week },
  ]

  return (
    <View style={S.container}>
      <View style={S.header}>
        <Text style={S.headerTitle}>下一步行动</Text>
        <Text style={S.headerSub} numberOfLines={1}>
          {data.product}
        </Text>
      </View>

      {/* 竖向时间轴：三阶段 + 发丝 rail + 节点 + 发丝方框（去装饰图标 / 绿底） */}
      <View style={S.timeline}>
        {phases.map((p, i) => (
          <View key={p.key} style={S.phase}>
            <View style={S.rail}>
              <View style={[S.node, { backgroundColor: p.color }]} />
              {i < phases.length - 1 ? <View style={S.railLine} /> : null}
            </View>
            <View style={S.phaseBody}>
              <Text style={S.phaseLabel}>{p.label}</Text>
              {p.items.map((it, idx) => (
                <View key={idx} style={S.item}>
                  <View style={S.check} />
                  <Text style={S.itemText}>{it}</Text>
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>

      {/* 真实数据溯源 + 可信度（后端统一下发，UI 透传展示） */}
      <ProvenanceFooter source={data.source} confidence={data.confidence} />
    </View>
  )
}

type ColorSet = {
  cardBg: string
  border: string
  textPrimary: string
  textSecondary: string
  primary: string
  success: string
  warning: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  container: {
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: spacing.lg,
    marginTop: spacing.md,
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
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: spacing.lg,
    gap: 8,
  },
  headerTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary },
  headerSub: { fontSize: 13, color: C.textSecondary, flex: 1 },
  timeline: { gap: spacing.md },
  phase: { flexDirection: 'row', alignItems: 'stretch' },
  rail: {
    width: 16,
    alignItems: 'center',
  },
  node: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginTop: 4,
  },
  railLine: {
    flex: 1,
    width: 1,
    backgroundColor: C.border,
    marginTop: 4,
  },
  phaseBody: { flex: 1, marginLeft: spacing.sm, marginBottom: spacing.xs },
  phaseLabel: { fontSize: 14, fontWeight: '600', color: C.textPrimary, marginBottom: spacing.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  check: {
    width: 13,
    height: 13,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: C.border,
    marginTop: 3,
    marginRight: 8,
  },
  itemText: { fontSize: 13, color: C.textSecondary, flex: 1, lineHeight: 20 },
  })
}
