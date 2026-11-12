import React, { useMemo } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { radius, spacing } from '../../theme'
import { useTheme } from '../../utils/theme'
import { createGlassCard } from '../../styles/glassStyles'
import { ProductCard } from '../cards/ProductCard'
import { ProductCardItem } from '../../utils/types'

interface Props {
  products: ProductCardItem[]
  userId?: string
  category: 'general' | 'beauty'
  onPoolPress?: () => void
}

/**
 * AI 推荐商品栏（玻璃态）
 * 贴在输入区上方，实时跟随 AI 推荐更新
 */
export function RecommendationBar({ products, userId, category, onPoolPress }: Props) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  if (products.length === 0) return null

  return (
    <View style={[styles.recoWrap, createGlassCard('medium', radius.lg, isDark)]}>
      <View style={styles.recoHead}>
        <View style={styles.recoDot} />
        <Text style={styles.recoHeadText}>AI 正在推荐 · {products.length} 件</Text>
        {category === 'beauty' && onPoolPress ? (
          <TouchableOpacity activeOpacity={0.7} onPress={onPoolPress}>
            <Text style={styles.recoHeadHint}>进机会池 ›</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.recoHeadHint}>左右滑动查看 ›</Text>
        )}
      </View>
      <ProductCard items={products} userId={userId} autoScroll />
    </View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  recoWrap: {
    marginBottom: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  recoHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    gap: spacing.xs,
  },
  recoDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.primary,
  },
  recoHeadText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: C.textPrimary,
  },
  recoHeadHint: {
    fontSize: 11,
    color: C.primary,
    fontWeight: '600',
  },
  })
}
