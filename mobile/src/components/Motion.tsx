import React, { useEffect, useRef } from 'react'
import {
  Animated,
  View,
  ViewStyle,
  StyleProp,
  Pressable,
  StyleSheet,
  useColorScheme,
} from 'react-native'
import { motion, radius, colors, dark } from '../theme'
import { EASE } from '../utils/theme'
import { useReducedMotion } from '../utils/useReducedMotion'

/**
 * 弹簧参数（Apple/Klarna 物理感）：
 * - SPRING_SNAP：轻微过冲后 settle（常规卡片/列表进场）
 * - SPRING_POP：明显过冲（商品卡/hero/关键结果卡进场，Klarna 的"说话即出"弹感）
 */
export const SPRING_SNAP = { tension: 70, friction: 9 }
export const SPRING_POP = { tension: 130, friction: 8 }

/**
 * 进场渐入 + 弹簧过冲（双轨动效）：opacity 0→1 + translateY→0 + scale 0.97(或 0.9)→1 轻微 overshoot。
 * - pop=true：更强过冲（商品卡/关键结果卡）；默认：轻微 pop（通用安全）。
 * - delay 用于列表 stagger（每项 +60~100ms）；duration 可覆盖。
 * - reduce-motion：直接就位、无动画。
 * 仅动 transform/opacity（useNativeDriver）。
 */
export function FadeInView({
  delay = 0,
  duration,
  style,
  children,
  pop = false,
}: {
  delay?: number
  duration?: number
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
  pop?: boolean
}) {
  const reduce = useReducedMotion()
  const opacity = useRef(new Animated.Value(reduce ? 1 : 0)).current
  const translateY = useRef(new Animated.Value(reduce ? 0 : motion.enterTranslateY)).current
  const scale = useRef(new Animated.Value(reduce ? 1 : pop ? 0.9 : 0.97)).current

  useEffect(() => {
    if (reduce) {
      opacity.setValue(1)
      translateY.setValue(0)
      scale.setValue(1)
      return
    }
    const d = duration ?? motion.duration.staggerItem
    const spring = pop ? SPRING_POP : SPRING_SNAP
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: d, delay, easing: EASE.decelerate, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: d, delay, easing: EASE.springSoft, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, delay, ...spring, useNativeDriver: true }),
    ]).start()
  }, [delay, duration, reduce, opacity, translateY, scale, pop])

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY }, { scale }] }]}>
      {children}
    </Animated.View>
  )
}

/**
 * 弹簧过冲入场（Klarna "说话即出"弹感）：scale 0.9→1 + translateY→0 明显 overshoot。
 * 用于商品卡 / 关键结果卡 / hero。reduce-motion 直接就位。
 */
export function PopInView({
  delay = 0,
  style,
  children,
}: {
  delay?: number
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}) {
  return (
    <FadeInView delay={delay} pop style={style}>
      {children}
    </FadeInView>
  )
}

/** 蓝柔光叠层颜色：浅色主蓝 / 暗色亮蓝（光晕副色）。 */
function glowColor(isDark: boolean): string {
  return isDark ? 'rgba(96,165,250,0.12)' : 'rgba(59,130,246,0.10)'
}

/**
 * 悬停抬升 + 蓝柔光描边（卡片磁性 hover 的 RN 实现）：
 * - hover:hover 设备抬升 -4px(浅)/-5px(暗) + scale 1.02 + 蓝柔光叠层（web :hover 经 Pressable onHoverIn/Out 触发）。
 * - 弹簧过冲：进入时用 SPRING_SNAP 让抬升"弹一下"（Klarna 触感），退出用 timing 快速回位。
 * - reduce-motion：仅瞬显柔光高光，无位移（硬约束：动效全锁 transform/opacity）。
 * - 触摸设备不触发 hover，回退为静态。
 */
export function HoverLift({
  children,
  style,
  radius: r = radius.md,
  hoverLift = true,
}: {
  children?: React.ReactNode
  style?: StyleProp<ViewStyle>
  radius?: number
  hoverLift?: boolean
}) {
  const reduce = useReducedMotion()
  const isDark = useColorScheme() === 'dark'
  const translateY = useRef(new Animated.Value(0)).current
  const scale = useRef(new Animated.Value(1)).current
  const glow = useRef(new Animated.Value(0)).current
  const liftPx = isDark ? -5 : -4

  const setHover = (on: boolean) => {
    if (reduce) {
      Animated.timing(glow, { toValue: on ? 0.6 : 0, duration: motion.duration.fast, useNativeDriver: true }).start()
      return
    }
    Animated.parallel([
      on && hoverLift
        ? Animated.spring(translateY, { toValue: liftPx, ...SPRING_SNAP, useNativeDriver: true })
        : Animated.timing(translateY, { toValue: 0, duration: motion.duration.mid, easing: EASE.standard, useNativeDriver: true }),
      on
        ? Animated.spring(scale, { toValue: 1.02, ...SPRING_SNAP, useNativeDriver: true })
        : Animated.timing(scale, { toValue: 1, duration: motion.duration.mid, easing: EASE.standard, useNativeDriver: true }),
      Animated.timing(glow, { toValue: on ? 1 : 0, duration: motion.duration.mid, useNativeDriver: true }),
    ]).start()
  }

  return (
    <Pressable onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)} style={[styles.hoverWrap, style]}>
      <Animated.View style={{ transform: [{ translateY }, { scale }] }}>{children}</Animated.View>
      <Animated.View
        style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }, { opacity: glow, backgroundColor: glowColor(isDark), borderRadius: r }]}
      />
    </Pressable>
  )
}

/**
 * 按压缩放反馈（press-scale .97）：替代单纯 activeOpacity 变淡，给关键 CTA 更明确的触感。
 * - 松开时用弹簧回位（SPRING_SNAP），给"按下去再弹回来"的 settle 手感。
 * - hover 变体：hover:hover 设备额外抬升 + 蓝柔光叠层。
 * - reduce-motion：退化为普通 Pressable（无缩放/无位移）。
 * 仅动 transform/opacity（useNativeDriver）。
 */
export function PressableScale({
  style,
  children,
  onPress,
  hover,
  radius: r = radius.md,
  disabled,
  accessibilityRole,
  accessibilityLabel,
  hitSlop,
}: {
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
  onPress?: () => void
  hover?: boolean
  radius?: number
  disabled?: boolean
  accessibilityRole?: any
  accessibilityLabel?: string
  hitSlop?: any
}) {
  const reduce = useReducedMotion()
  const isDark = useColorScheme() === 'dark'
  const scale = useRef(new Animated.Value(1)).current
  const translateY = useRef(new Animated.Value(0)).current
  const glow = useRef(new Animated.Value(0)).current
  const liftPx = isDark ? -5 : -4

  const animateScale = (to: number, settle = false) => {
    if (reduce) return
    if (settle && to === 1) {
      Animated.spring(scale, { toValue: 1, ...SPRING_SNAP, useNativeDriver: true }).start()
      return
    }
    Animated.timing(scale, { toValue: to, duration: motion.duration.fast, easing: EASE.standard, useNativeDriver: true }).start()
  }
  const setHover = (on: boolean) => {
    if (reduce) {
      Animated.timing(glow, { toValue: on ? 0.6 : 0, duration: motion.duration.fast, useNativeDriver: true }).start()
      return
    }
    Animated.parallel([
      on && hover
        ? Animated.spring(translateY, { toValue: liftPx, ...SPRING_SNAP, useNativeDriver: true })
        : Animated.timing(translateY, { toValue: 0, duration: motion.duration.mid, easing: EASE.standard, useNativeDriver: true }),
      Animated.timing(glow, { toValue: on ? 1 : 0, duration: motion.duration.mid, useNativeDriver: true }),
    ]).start()
  }

  return (
    <Pressable
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      hitSlop={hitSlop}
      onPressIn={() => animateScale(motion.pressScale)}
      onPressOut={() => animateScale(1, true)}
      onHoverIn={() => hover && setHover(true)}
      onHoverOut={() => hover && setHover(false)}
      onPress={onPress}
    >
      <Animated.View style={[style, { transform: [{ scale }, { translateY }] }]}>{children}</Animated.View>
      {hover ? (
        <Animated.View
          style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }, { opacity: glow, backgroundColor: glowColor(isDark), borderRadius: r }]}
        />
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  hoverWrap: {
    position: 'relative',
  },
})

// 兼容旧引用：PressableScale / HoverLift 已覆盖磁性 hover 需求
export const cardHoverGlow = { light: 'rgba(59, 130, 246, 0.06)', dark: 'rgba(96, 165, 250, 0.18)' }
export const blueInk = (isDark: boolean) => (isDark ? dark.blueInk : colors.primary)
