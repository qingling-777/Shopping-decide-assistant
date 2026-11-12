import React, { useEffect, useRef, useMemo } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform, Image, Animated } from 'react-native'
import { colors, radius, spacing, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { useReducedMotion } from '../../utils/useReducedMotion'
import { HotCategory } from '../../utils/types'
import { CountUp } from '../CountUp'
import { HoverLift } from '../Motion'

export function HotCategoryCard({ item, onPress, onShowProducts }: { item: HotCategory; onPress: () => void; onShowProducts?: () => void }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  // 强调色统一用品牌墨蓝，不再按 gradientType 上色（去渐变 AI 味）
  const confidenceColor = item.confidence === '高' ? C.success : item.confidence === '低' ? C.warning : C.primary

  // 生命力·榜单轻弹：进场轻微 spring（scale 0.9→1 + opacity），≤200ms 量级的克制回弹；reduce-motion 直接就位
  const reduce = useReducedMotion()
  const spring = useRef(new Animated.Value(reduce ? 1 : 0.9)).current
  useEffect(() => {
    if (reduce) {
      spring.setValue(1)
      return
    }
    Animated.spring(spring, { toValue: 1, tension: 200, friction: 14, useNativeDriver: true }).start()
  }, [reduce, spring])

  return (
    <Animated.View style={{ transform: [{ scale: spring }], opacity: spring }}>
      <HoverLift radius={radius.lg} hoverLift>
        <TouchableOpacity style={S.card} onPress={onPress} activeOpacity={0.8}>
      {item.coverImage ? (
        <Image source={{ uri: item.coverImage }} style={S.cover} resizeMode="cover" />
      ) : null}
      <View style={S.body}>
        <Text style={S.name} numberOfLines={1}>{item.name}</Text>
        <Text style={S.tag} numberOfLines={1}>{item.tag}</Text>
        <View style={S.scoreRow}>
          <CountUp value={item.score} style={S.score} />
          <Text style={S.scoreUnit}> 分</Text>
        </View>
        <Text style={S.scoreLabel}>{item.scoreLabel || '机会分'}</Text>
        {item.sourceCount !== undefined && (
          <Text style={[S.meta, { color: confidenceColor }]}>来源 {item.sourceCount} · 可信度{item.confidence}</Text>
        )}
        {onShowProducts ? (
          <TouchableOpacity
            style={S.actionBtn}
            activeOpacity={0.8}
            onPress={(e) => { (e as any).stopPropagation?.(); onShowProducts() }}
          >
            <Text style={S.actionBtnText}>看实时选品商品 ›</Text>
          </TouchableOpacity>
        ) : null}
      </View>
        </TouchableOpacity>
      </HoverLift>
    </Animated.View>
  )
}

type ColorSet = {
  cardBg: string
  border: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  primary: string
  success: string
  warning: string
  pageBg: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  card: {
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    width: 150,
    marginRight: spacing.sm + 4,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
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
  cover: {
    width: '100%',
    height: 84,
    backgroundColor: C.pageBg,
  },
  body: {
    padding: spacing.md,
  },
  name: { fontSize: 13, fontWeight: '600', color: C.textPrimary, marginBottom: 2 },
  tag: { fontSize: 11, color: C.textSecondary, marginBottom: spacing.xs },
  scoreRow: { flexDirection: 'row', alignItems: 'baseline' },
  score: { fontSize: 16, fontWeight: '700', color: C.textPrimary },
  scoreUnit: { fontSize: 11, color: C.textMuted },
  scoreLabel: { fontSize: 10, color: C.textMuted, marginTop: 1 },
  meta: { fontSize: 10, marginTop: spacing.sm },
  actionBtn: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    backgroundColor: C.primary + '12',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  actionBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: C.primary,
  },
  })
}
