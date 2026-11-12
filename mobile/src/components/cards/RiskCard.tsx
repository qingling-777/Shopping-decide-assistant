import React, { useMemo } from 'react'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { colors, radius, spacing, surfaceTints, darkSurfaceTints, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { RiskCard as RiskCardType } from '../../utils/types'
import { ProvenanceFooter } from './ProvenanceFooter'
import { HoverLift } from '../Motion'

const riskLabels: Record<string, string> = {
  low: '低风险',
  medium_low: '中低风险',
  medium: '中等风险',
  high: '高风险',
}

export function RiskCard({ data }: { data: RiskCardType }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const T = isDark ? darkSurfaceTints : surfaceTints
  const riskColors: Record<string, string> = {
    low: C.success,
    medium_low: '#FBBF24',
    medium: C.warning,
    high: C.danger,
  }
  const riskColor = riskColors[data.riskLevel]
  const riskLabel = riskLabels[data.riskLevel]

  return (
    <HoverLift radius={radius.lg} style={[S.card, { backgroundColor: T.risk.bg, borderColor: T.risk.border }]}>
      <View style={S.header}>
        <View style={[S.badge, { backgroundColor: riskColor + '15' }]}>
          <Text style={[S.badgeText, { color: riskColor }]}>{riskLabel}</Text>
        </View>
      </View>

      <Text style={S.title}>风险提示</Text>

      <View style={S.section}>
        <Text style={S.sectionTitle}>主要风险</Text>
        {data.risks.map((risk, idx) => (
          <View key={idx} style={S.item}>
            <View style={[S.mark, { backgroundColor: riskColor }]} />
            <Text style={S.itemText}>{risk}</Text>
          </View>
        ))}
      </View>

      <View style={S.section}>
        <Text style={S.sectionTitle}>应对建议</Text>
        {data.mitigation.map((action, idx) => (
          <View key={idx} style={S.item}>
            <View style={[S.mark, { backgroundColor: C.success }]} />
            <Text style={S.itemText}>{action}</Text>
          </View>
        ))}
      </View>

      {/* 数据溯源：每条风险/建议的真实来源（知识库条目 id + 文件名） */}
      {data.references && data.references.length > 0 ? (
        <View style={S.section}>
          <Text style={S.sectionTitle}>数据溯源</Text>
          {data.references.map((r, idx) => (
            <View key={idx} style={S.refRow}>
              <Text style={S.refDot}>·</Text>
              <View style={S.refBody}>
                <Text style={S.refSource} numberOfLines={1}>{r.source}</Text>
                {r.question ? <Text style={S.refQuestion} numberOfLines={1}>{r.question}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* 真实数据溯源 + 可信度（后端统一下发，UI 透传展示） */}
      <ProvenanceFooter source={data.source} confidence={data.confidence} defaultSource="知识库06_risk_assessment" />
    </HoverLift>
  )
}

type ColorSet = {
  textPrimary: string
  textSecondary: string
  textMuted: string
  primary: string
  success: string
  warning: string
  danger: string
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
  header: {
    marginBottom: spacing.sm,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: spacing.lg,
  },
  section: {
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textPrimary,
    marginBottom: spacing.sm,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  mark: {
    width: 3,
    height: 12,
    borderRadius: 1,
    marginTop: 4,
    marginRight: spacing.sm,
  },
  itemText: {
    flex: 1,
    fontSize: 14,
    color: C.textPrimary,
    lineHeight: 20,
  },
  refRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.xs,
  },
  refDot: {
    fontSize: 13,
    color: C.textMuted,
    marginRight: 6,
    marginTop: 1,
  },
  refBody: {
    flex: 1,
  },
  refSource: {
    fontSize: 12,
    color: C.textSecondary,
    lineHeight: 16,
  },
  refQuestion: {
    fontSize: 11,
    color: C.textMuted,
    lineHeight: 15,
    marginTop: 1,
  },
  })
}
