import React, { useMemo } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { colors, radius, spacing, fontSize } from '../theme'
import { useTheme } from '../utils/theme'

/**
 * 统一空态（P2）：取代各页散落的「暂无 xxx」文字，提供一致的图标占位 + 标题 + 说明 + 可选操作。
 */
export function EmptyState({
  glyph = '∅',
  title,
  hint,
  actionLabel,
  onAction,
}: {
  glyph?: string
  title: string
  hint?: string
  actionLabel?: string
  onAction?: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  return (
    <View style={styles.wrap}>
      <View style={styles.glyphWrap}>
        <Text style={styles.glyph}>{glyph}</Text>
      </View>
      <Text style={styles.title}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {actionLabel && onAction ? (
        <TouchableOpacity style={styles.action} activeOpacity={0.8} onPress={onAction}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl * 2,
    paddingHorizontal: spacing.xl,
  },
  glyphWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.primary + '10',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  glyph: { fontSize: 26, color: C.primary },
  title: { fontSize: fontSize.md, fontWeight: '700', color: C.textPrimary, textAlign: 'center' },
  hint: { fontSize: fontSize.xs, color: C.textMuted, marginTop: spacing.xs, textAlign: 'center', lineHeight: 18 },
  action: {
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: C.primary,
  },
  actionText: { fontSize: fontSize.sm, fontWeight: '700', color: '#fff' },
})
}
