import React from 'react'
import { View, StyleSheet } from 'react-native'
import { useTheme } from '../utils/theme'

/**
 * 背景层（纯净白底）：浅色 = 纯 #FFFFFF，暗色 = 深色 pageBg。
 * 全站对齐参考图（Treedi 风格）：去掉渐变底色 + 动态光斑 + 网格光晕，回归留白与发丝边框分层。
 * 保留组件 API（同 MeshBackground），供工作台外壳 / 全屏页共用，保证全站背景一致。
 */
export function GlassBackground() {
  const { colors: C, isDark } = useTheme()
  return (
    <View style={[StyleSheet.absoluteFill, styles.background]} pointerEvents="none">
      <View style={[StyleSheet.absoluteFill, { backgroundColor: C.pageBg }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  background: {
    zIndex: 0,
  },
})
