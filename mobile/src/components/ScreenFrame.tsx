import React, { useEffect, useRef } from 'react'
import { View, Text, ScrollView, TouchableOpacity, Modal, StyleSheet, Animated, useWindowDimensions } from 'react-native'
import { colors, dark, glass, radius, spacing, motion } from '../theme'
import { useTheme, EASE } from '../utils/theme'
import { useReducedMotion } from '../utils/useReducedMotion'
import { useAppState } from '../hooks/useAppState'
import { AppHeader, IconButton, BrandLogo } from './AppHeader'
import { GlassBackground } from './GlassBackground'
import { DEPTH } from './Glow'
import zgoMark from '../../assets/brand/zgo-mark.jpg'

/**
 * 统一全屏页面外壳：Modal 背板 + 玻璃背景 + 强玻璃顶栏 + 滚动内容。
 * 5 个新页面（知识库 / 推广方案 / 测品计划 / 设置 / 会员中心）共用，避免重复样板。
 * 响应式：内容层 maxWidth 560 居中，窄屏占满、宽屏居中不拉伸。
 *
 * 转场（主理人决策 A）：项目零 react-navigation，全屏靠 RN Modal + ScreenFrame。
 * sheet 升起用自定义 Animated translateY spring(springSoft) 替换 animationType="slide"；
 * overlay 用 fade + 玻璃遮罩（见 Glow 的强玻璃说明）。reduce-motion 全部 opacity 0→1 瞬切(≤120ms)，无位移/缩放/遮罩滑动。
 * 升级路径（决策 B）：强玻璃用 glass.* 半透明分层实底 + 多层柔影(DEPTH.raisedGlass) 近似，不 import expo-blur（未装，强引破坏构建）。
 */
export function ScreenFrame({
  visible,
  onClose,
  title,
  member,
  children,
}: {
  visible: boolean
  onClose: () => void
  title: React.ReactNode
  member?: boolean
  children: React.ReactNode
}) {
  const { isDark } = useTheme()
  const reduce = useReducedMotion()
  const active = useAppState()
  const C = isDark ? dark : colors
  const { height } = useWindowDimensions()

  const overlayOpacity = useRef(new Animated.Value(0)).current
  const sheetY = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!visible) {
      // 关闭：复位（父组件控制 Modal 卸载，离开动画简化为瞬隐）
      sheetY.setValue(reduce ? 0 : height)
      overlayOpacity.setValue(0)
      return
    }
    if (reduce) {
      // reduce-motion：瞬切就位，无位移/缩放
      sheetY.setValue(0)
      overlayOpacity.setValue(1)
      return
    }
    sheetY.setValue(height)
    overlayOpacity.setValue(0)
    Animated.parallel([
      Animated.timing(overlayOpacity, { toValue: 1, duration: motion.duration.overlay, easing: EASE.apple, useNativeDriver: true }),
      Animated.timing(sheetY, { toValue: 0, duration: motion.duration.sheet, easing: EASE.springSoft, useNativeDriver: true }),
    ]).start()
  }, [visible, reduce, height, active, sheetY, overlayOpacity])

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <TouchableOpacity
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(7,10,18,0.28)', opacity: overlayOpacity }]}
        activeOpacity={1}
        onPress={onClose}
      />
      <Animated.View style={[styles.sheet, { backgroundColor: isDark ? glass.dark.bg : glass.light.bg, transform: [{ translateY: sheetY }] }]}>
        <GlassBackground />
        <AppHeader
          member={member}
          left={<BrandLogo size={28} image={zgoMark} />}
          title={<Text style={[styles.title, { color: C.textPrimary }]}>{title}</Text>}
          right={<IconButton glyph="✕" label="关闭" onPress={onClose} />}
          // 强玻璃：半透明分层实底（glass.*）+ 多层柔影(raised-glass)；不 import expo-blur（决策 B）
          glassed
          style={DEPTH.raisedGlass as any}
        />
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      </Animated.View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  title: { fontSize: 17, fontWeight: '700' },
  scroll: { flex: 1 },
  content: {
    padding: spacing.lg,
    paddingBottom: 40,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
})
