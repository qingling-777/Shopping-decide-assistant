import React, { useMemo, useEffect, useRef, useState } from 'react'
import { View, StyleSheet, Animated, Easing } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { colors, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { useReducedMotion } from '../utils/useReducedMotion'
import { useAppState } from '../hooks/useAppState'

/**
 * 骨架屏（生命力动效之五）：占位条流光 sweep，1.4s linear infinite。
 * 仅动 transform/opacity（useNativeDriver）；reduce-motion 时停 loop，保持静态 borderLight 占位（即当前行为）。
 * 用法：<Skeleton.Block height={120} /> 或 <Skeleton.Text lines={3} />
 */
export function SkeletonBlock({
  height = 80,
  radius: r = radius.md,
  width,
  style,
}: {
  height?: number
  radius?: number
  width?: number | string
  style?: any
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [w, setW] = useState(0)
  return (
    <View
      style={[styles.block, { height, width: width ?? '100%', borderRadius: r }, style]}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
    >
      <Shimmer overlayWidth={w} />
    </View>
  )
}

export function SkeletonText({ lines = 3, style }: { lines?: number; style?: any }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  return (
    <View style={[styles.textWrap, style]}>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBlock key={i} height={12} radius={6} width={i === lines - 1 ? '60%' : '100%'} style={styles.line} />
      ))}
    </View>
  )
}

function Shimmer({ overlayWidth }: { overlayWidth: number }) {
  const { colors: C } = useTheme()
  const reduce = useReducedMotion()
  const active = useAppState()
  const translateX = useRef(new Animated.Value(-1)).current

  useEffect(() => {
    // 后台暂停：reduce-motion 或退后台时停 loop，保持静态占位（性能护栏 6.4）
    if (reduce || !active || overlayWidth <= 0) return
    const anim = Animated.loop(
      Animated.timing(translateX, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }),
    )
    anim.start()
    return () => anim.stop()
  }, [reduce, active, overlayWidth, translateX])

  if (reduce || !active || overlayWidth <= 0) return null

  const sweepWidth = Math.max(overlayWidth * 0.6, 48)
  return (
    <Animated.View
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: sweepWidth,
        transform: [{ translateX: translateX.interpolate({ inputRange: [-1, 1], outputRange: [-sweepWidth, overlayWidth] }) }],
      }}
    >
      <LinearGradient
        colors={['transparent', C.primary + '14', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  block: {
    backgroundColor: C.borderLight,
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  textWrap: {
    marginVertical: spacing.sm,
  },
  line: {
    marginBottom: spacing.sm,
  },
})
}
