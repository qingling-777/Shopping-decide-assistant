import { Platform, ViewStyle, TextStyle } from 'react-native'
import { glass, shadows, dark } from '../theme'

/**
 * 统一玻璃态样式系统
 * 三档玻璃效果 + 标准颜色 + 阴影规范
 * blur 收敛到主题令牌（P2-1）：strong=24(overlayBlur) / medium=20 / light=12，
 * 与 theme.glass 分级唯一来源对齐，消灭 40/20/12 三值漂移。
 */

// 玻璃效果档位（blur 已对齐 theme.glass：strong→overlayBlur 24；light→softBlur 12）
export const GLASS_LEVELS = {
  strong: {
    blur: glass.overlayBlur,
    opacity: 0.72,
    saturate: glass.overlaySaturate,
  },
  medium: {
    blur: 20,
    opacity: 0.60,
    saturate: 150,
  },
  light: {
    blur: glass.softBlur,
    opacity: 0.55,
    saturate: 130,
  },
} as const

// 半透明白色系
export const GLASS_COLORS = {
  bg70: 'rgba(255,255,255,0.70)', // 强玻璃
  bg65: 'rgba(255,255,255,0.65)', // 搜索/输入
  bg60: 'rgba(255,255,255,0.60)', // 表单卡/按钮
  bg55: 'rgba(255,255,255,0.55)', // 内容卡片
  bg50: 'rgba(255,255,255,0.50)', // 空状态
  
  border40: 'rgba(255,255,255,0.40)', // 标准边框
  border35: 'rgba(255,255,255,0.35)', // 卡片边框
  border30: 'rgba(255,255,255,0.30)', // 顶栏边框
  border25: 'rgba(255,255,255,0.25)', // 激活态边框
} as const

// 蓝色半透明（品牌元素）
export const GLASS_BLUE = {
  bg12: 'rgba(59,130,246,0.12)', // 快捷问题底
  bg08: 'rgba(59,130,246,0.08)', // 提示底
  border25: 'rgba(59,130,246,0.25)', // 边框
  shadow: '#3B82F6', // 阴影颜色
} as const

// 玻璃卡片样式生成器（isDark：暗色玻璃底 + 暗色发丝边框，对齐 theme.glassCardDark）
export function createGlassCard(level: keyof typeof GLASS_LEVELS = 'medium', borderRadius: number = 16, isDark: boolean = false): ViewStyle {
  const { blur, opacity, saturate } = GLASS_LEVELS[level]
  
  return {
    backgroundColor: isDark ? `rgba(15,26,46,${(opacity + 0.04).toFixed(2)})` : `rgba(255,255,255,${opacity})`,
    borderRadius,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(33,48,74,0.60)' : GLASS_COLORS.border35,
    ...Platform.select({
      web: {
        backdropFilter: `blur(${blur}px) saturate(${saturate}%)`,
        WebkitBackdropFilter: `blur(${blur}px) saturate(${saturate}%)`,
        boxShadow: isDark ? shadows.cardDark : shadows.card,
      } as any,
      default: {
        elevation: level === 'strong' ? 12 : level === 'medium' ? 4 : 2,
      },
    }),
  }
}

// 玻璃输入框样式
export function createGlassInput(borderRadius: number = 999, isDark: boolean = false): ViewStyle {
  return {
    backgroundColor: isDark ? 'rgba(15,26,46,0.66)' : GLASS_COLORS.bg65,
    borderRadius,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(33,48,74,0.60)' : GLASS_COLORS.border40,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px) saturate(150%)',
        WebkitBackdropFilter: 'blur(20px) saturate(150%)',
        boxShadow: isDark ? shadows.cardDark : '0 4px 16px rgba(59,130,246,0.10)',
      } as any,
      default: {
        elevation: 3,
      },
    }),
  }
}

// 玻璃按钮样式（轻量）
export function createGlassButton(borderRadius: number = 999, isDark: boolean = false): ViewStyle {
  return {
    backgroundColor: isDark ? 'rgba(59,130,246,0.14)' : GLASS_BLUE.bg12,
    borderRadius,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(96,165,250,0.35)' : GLASS_BLUE.border25,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow: '0 2px 6px rgba(59,130,246,0.08)',
      } as any,
      default: {
        elevation: 2,
      },
    }),
  }
}

// 玻璃面板样式（强玻璃，用于侧边栏/弹层）
export function createGlassPanel(borderRadius: number = 16, isDark: boolean = false): ViewStyle {
  return {
    backgroundColor: isDark ? 'rgba(15,26,46,0.76)' : GLASS_COLORS.bg70,
    borderRadius,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(33,48,74,0.60)' : GLASS_COLORS.border30,
    ...Platform.select({
      web: {
        backdropFilter: `blur(${glass.overlayBlur}px) saturate(${glass.overlaySaturate}%)`,
        WebkitBackdropFilter: `blur(${glass.overlayBlur}px) saturate(${glass.overlaySaturate}%)`,
        boxShadow: isDark ? shadows.floatingDark : '4px 0 32px rgba(59,130,246,0.15), 0 0 0 1px rgba(255,255,255,0.30)',
      } as any,
      default: {
        shadowColor: GLASS_BLUE.shadow,
        shadowOffset: { width: 4, height: 0 },
        shadowOpacity: 0.15,
        shadowRadius: 24,
        elevation: 20,
      },
    }),
  }
}

// 底部输入面板样式（最强玻璃）
export function createBottomPanel(borderRadius: number = 0, isDark: boolean = false): ViewStyle {
  return {
    backgroundColor: isDark ? 'rgba(15,26,46,0.74)' : GLASS_COLORS.bg70,
    borderTopLeftRadius: borderRadius,
    borderTopRightRadius: borderRadius,
    borderTopWidth: 1,
    borderTopColor: isDark ? 'rgba(33,48,74,0.60)' : GLASS_COLORS.border30,
    ...Platform.select({
      web: {
        backdropFilter: `blur(${glass.overlayBlur}px) saturate(${glass.overlaySaturate}%)`,
        WebkitBackdropFilter: `blur(${glass.overlayBlur}px) saturate(${glass.overlaySaturate}%)`,
        boxShadow: isDark ? shadows.floatingDark : '0 -4px 24px rgba(59,130,246,0.08)',
      } as any,
      default: {
        shadowColor: GLASS_BLUE.shadow,
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.08,
        shadowRadius: 16,
        elevation: 16,
      },
    }),
  }
}
