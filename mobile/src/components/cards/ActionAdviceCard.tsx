import React, { useMemo } from 'react'
import { View, Text, StyleSheet, Platform } from 'react-native'
import { colors, dark, radius, spacing, surfaceTints, darkSurfaceTints, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { ActionAdvice } from '../../utils/types'

export function ActionAdviceCard({ data }: { data: ActionAdvice }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const T = isDark ? darkSurfaceTints : surfaceTints

  return (
    <View style={[S.card, { backgroundColor: T.action.bg, borderColor: T.action.border }]}>
      <Text style={S.title}>{data.actionTitle}</Text>
      <View style={S.steps}>
        {data.steps.map((step, idx) => (
          <View key={idx} style={S.stepRow}>
            <View style={S.stepNum}>
              <Text style={S.stepNumText}>{idx + 1}</Text>
            </View>
            <Text style={S.stepText}>{step}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

type ColorSet = {
  textPrimary: string
  primary: string
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
  steps: {
    gap: spacing.md,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: C.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm + 2,
    marginTop: 2,
  },
  stepNumText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  stepText: {
    flex: 1,
    fontSize: 14,
    color: C.textPrimary,
    lineHeight: 20,
  },
  })
}
