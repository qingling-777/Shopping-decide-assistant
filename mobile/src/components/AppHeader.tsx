import React from 'react'
import { Image, View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native'
import { colors, dark, glass, radius, spacing, gradients } from '../theme'
import { useTheme } from '../utils/theme'
import zgoMark from '../../assets/brand/zgo-mark.jpg'

/** 最小可触控尺寸（WCAG/人机工程基准）。所有导航操作都至少 44×44。 */
export const TAP = 44

/**
 * 品牌 logo：ZGo 品牌标（圆形裁切图片）为主，渐变方块 + 文字兜底。
 * 对话主页顶栏用 zgo-mark 图片体现 ZGo（智Go）品牌识别。
 */
export function BrandLogo({ size = 28, text = 'AI', image }: { size?: number; text?: string; image?: any }) {
  // 有品牌图时：圆形裁切显示 ZGo 星芒标
  if (image) {
    return (
      <View
        style={[
          styles.logoImage,
          {
            width: size,
            height: size,
            borderRadius: Math.round(size / 2),
          },
        ]}
      >
        <Image source={image} style={{ width: size, height: size, borderRadius: Math.round(size / 2) }} resizeMode="cover" />
      </View>
    )
  }
  const [c1, c2, c3] = gradients.recommend
  return (
    <View
      style={[
        styles.logo,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.32),
          // 渐变用 inline style 近似（RN web 与 native 通用）；native 端可后续接 expo-linear-gradient
          backgroundColor: c1,
        },
      ]}
    >
      <Text style={[styles.logoText, { fontSize: Math.round(size * 0.43) }]}>{text}</Text>
    </View>
  )
}

/**
 * 统一图标按钮：44×44 触控区 + 单一字形语言（☰ ✕ ↗ ✎ 等符号字，非彩色 emoji）。
 * accessibilityLabel 保证读屏清晰，弥补无文字标签时的语义缺失。
 */
export function IconButton({
  glyph,
  label,
  onPress,
  active,
  style,
}: {
  glyph: string
  label: string
  onPress: () => void
  active?: boolean
  style?: any
}) {
  const { isDark } = useTheme()
  const accent = isDark ? dark.primary : colors.primary
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      activeOpacity={0.6}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={[styles.iconBtn, active && { backgroundColor: accent + '1A' }, style]}
    >
      <Text style={[styles.iconGlyph, active && { color: accent }]}>{glyph}</Text>
    </TouchableOpacity>
  )
}

/**
 * 会员入口金 chip：通往会员中心（金空间）的桥。
 * gold = 会员专属语义（DESIGN_SPEC 铁律）。
 */
export function MemberChip({
  onPress,
  label = '充值 / 余额',
}: {
  onPress: () => void
  label?: string
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.memberChip}
    >
      <Text style={styles.memberChipText}>{label}</Text>
      <Text style={styles.memberChipChev}>›</Text>
    </TouchableOpacity>
  )
}

/**
 * 共享顶栏：中度品牌化升级。
 * - bordered=true（默认）：玻璃底 + 2px 蓝色底线（与 ui-life 原型一致，对话主页/我的页用）
 * - bordered=false：纯透明（嵌入卡片顶部用）
 * HomeScreen 与 ProfileScreen 共用，统一标题层级与右侧操作规格。
 */
export function AppHeader({
  left,
  title,
  right,
  member,
  bordered = true,
  glassed,
  style,
}: {
  left?: React.ReactNode
  title?: React.ReactNode
  right?: React.ReactNode
  member?: boolean
  bordered?: boolean
  /** 显式指定玻璃底（默认 bordered=true 时启用） */
  glassed?: boolean
  style?: any
}) {
  const { isDark } = useTheme()
  const useGlass = glassed ?? bordered
  return (
    <View
      style={[
        styles.header,
        member && styles.headerMember,
        useGlass && (isDark ? styles.headerGlassDark : styles.headerGlassLight),
        bordered && styles.headerBordered,
        style,
      ]}
    >
      <View style={styles.headerLeft}>{left}</View>
      <View style={styles.headerTitle}>{title}</View>
      <View style={styles.headerRight}>{right}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    backgroundColor: 'transparent',
  },
  headerMember: {
    backgroundColor: 'transparent',
  },
  // 浅色玻璃底 - 增强版
  headerGlassLight: {
    backgroundColor: 'rgba(255,255,255,0.65)',
    ...Platform.select({
      web: {
        backdropFilter: 'blur(24px) saturate(170%)',
        WebkitBackdropFilter: 'blur(24px) saturate(170%)',
      },
    }),
  },
  // 暗色玻璃底
  headerGlassDark: {
    backgroundColor: glass.dark.bg,
  },
  // 2px 蓝色底线：对话主页品牌识别
  headerBordered: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.30)',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerTitle: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  iconBtn: {
    width: TAP,
    height: TAP,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: {
    fontSize: 20,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  // 品牌 logo 渐变方块 - 增强版
  logo: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    ...Platform.select({
      web: {
        boxShadow: '0 4px 16px rgba(37,99,235,0.35)',
      },
    }),
  },
  // 品牌 logo 图片容器：圆形裁切 ZGo 星芒标
  logoImage: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    shadowColor: colors.primary,
    shadowOpacity: 0.30,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
    ...Platform.select({
      web: {
        boxShadow: '0 3px 12px rgba(37,99,235,0.28)',
      },
    }),
  },
  logoText: {
    color: '#FFFFFF',
    fontWeight: '800',
    letterSpacing: 0.02,
  },
  // 会员金 chip：金空间桥（DESIGN_SPEC §5.2 三重 cue 之一）
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(212,169,75,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(212,169,75,0.55)',
  },
  memberChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.goldDeep,
  },
  memberChipChev: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.goldDeep,
    marginLeft: 1,
  },
})
