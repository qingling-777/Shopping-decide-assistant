import React from 'react'
import { View, ViewStyle, StyleSheet } from 'react-native'
import { colors, dark } from '../theme'
import { useTheme } from '../utils/theme'

/**
 * 深度四档阴影组（多层柔影，不脏）：深度只靠阴影/玻璃/光影表达，不碰 layout/backgroundColor。
 * - flat：静态卡片，发丝边框（默认）
 * - float：悬浮层 hover 抬升的柔和阴影
 * - raisedGlass：浮层/弹窗/会员卡多层柔影（强玻璃）
 * - overlay：遮罩层最深的投影
 * 用法：style={[DEPTH.raisedGlass, { ... }]}
 */
export const DEPTH = {
  flat: {
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: 'transparent',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  float: {
    borderWidth: 0,
    shadowColor: '#0F172A',
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  raisedGlass: {
    borderWidth: 0,
    shadowColor: '#0F172A',
    shadowOpacity: 0.18,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  overlay: {
    borderWidth: 0,
    shadowColor: '#0F172A',
    shadowOpacity: 0.28,
    shadowRadius: 34,
    shadowOffset: { width: 0, height: 16 },
    elevation: 18,
  },
} as const

export type GlowVariant = 'blue' | 'gold'

/**
 * 光晕层（统一工具）：用半透明径向柔光叠层近似（RN 无 backdrop-filter / 无 expo-blur）。
 * - blue：主蓝 → 亮蓝径向柔光，全站 hero / 主按钮 / AI 头像 / composer。
 * - gold：蓝→金光晕，**严格限定会员语境**（会员中心整页 / 升级弹窗付费强调 / 会员专享 badge 微光），
 *        中性页一律不得用 gold 光晕（硬约束 5：金=会员语义）。
 *
 * 升级路径（主理人决策 B）：若后续引入 expo-blur，可在此叠加 BlurView 替换半透明实底，光晕更真；
 * 当前不 import expo-blur（package.json 未装，强引会破坏构建）。
 */
export function Glow({
  variant = 'blue',
  size = 260,
  intensity,
  style,
}: {
  variant?: GlowVariant
  size?: number
  intensity?: number
  style?: ViewStyle
}) {
  const { isDark } = useTheme()
  const c = isDark ? dark : colors
  const halo = variant === 'gold' ? c.gold : c.primary
  const core = variant === 'gold' ? c.gold : (c as any).primaryBright ?? c.primary
  const op = intensity ?? (isDark ? 0.18 : 0.22)
  return (
    <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }, style]}>
      <View
        style={{
          position: 'absolute',
          alignSelf: 'center',
          top: -size * 0.18,
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: halo,
          opacity: op * 0.5,
        }}
      />
      <View
        style={{
          position: 'absolute',
          alignSelf: 'center',
          top: -size * 0.05,
          width: size * 0.6,
          height: size * 0.6,
          borderRadius: size * 0.3,
          backgroundColor: core,
          opacity: op,
        }}
      />
    </View>
  )
}
