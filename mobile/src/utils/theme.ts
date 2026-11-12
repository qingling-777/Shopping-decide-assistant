import { useColorScheme } from 'react-native'
import { Easing } from 'react-native'
import { colors, dark, motion, glass } from '../theme'
import { useReducedMotion } from './useReducedMotion'

/** 当前生效的配色（随系统深色模式切换）。默认亮色。 */
export function useAppColors() {
  const scheme = useColorScheme()
  return scheme === 'dark' ? dark : colors
}

/** 当前主题（配色 + 是否暗色 + 玻璃令牌）。组件统一从这里取，便于后续扩展。 */
export function useTheme() {
  const isDark = useColorScheme() === 'dark'
  const reduceMotion = useReducedMotion()
  return {
    colors: isDark ? dark : colors,
    isDark,
    glass: isDark ? glass.dark : glass.light,
    reduceMotion,
  }
}

/** RN Animated 缓动（对应 motion.ease 的 CSS 曲线）。 */
export const EASE = {
  standard: Easing.bezier(0.4, 0, 0.2, 1),
  decelerate: Easing.bezier(0, 0, 0.2, 1),
  spring: Easing.bezier(0.34, 1.56, 0.64, 1),
  springSoft: Easing.bezier(0.32, 1.3, 0.64, 1), // 沉弹 ~6-8% overshoot（sheet/会员金卡/磁性回弹）
  apple: Easing.bezier(0.22, 1, 0.36, 1),         // 沉无过冲（转场/sheet/overlay/push）
}

/** 轨道 B 时长常量（核心交互）：底部 sheet 升起 / 页面转场 / 浮层 / stagger 单段 / count-up 弹性尾。 */
export const DURATION = {
  page: motion.duration.page,
  sheet: motion.duration.sheet,
  overlay: motion.duration.overlay,
  staggerItem: motion.duration.staggerItem,
  countTail: motion.duration.countTail,
  fast: motion.duration.fast,
  mid: motion.duration.mid,
  slow: motion.duration.slow,
}

/**
 * 动效分档（统一开关，禁止每处手写）：full=双轨全开；reduced=仅瞬显/静态。
 * 组件统一读 useReducedMotion()，此处仅公布常量便于非组件上下文复用。
 */
export type MotionTier = 'full' | 'reduced'
export const MOTION_TIER: MotionTier = 'full'

/** 进场动画时长（克制）：reduce-motion 时归零。 */
export function enterDuration(reduceMotion: boolean) {
  return reduceMotion ? 0 : motion.duration.mid
}

/** 轨道 B 时长（物理感）：reduce-motion 时归零，避免位移/缩放/遮罩滑动。 */
export function trackDuration(reduceMotion: boolean, ms: number) {
  return reduceMotion ? 0 : ms
}
