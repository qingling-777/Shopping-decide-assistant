import React from 'react'
import { View, StyleSheet, useColorScheme } from 'react-native'
import { colors, dark } from '../theme'

/**
 * 背景层（纯净白底）：浅色 = 纯 #FFFFFF，暗色 = 深色 pageBg。
 * 全站对齐参考图（Treedi 风格）：去掉彩色动态光斑/渐变，回归留白与发丝边框分层。
 * 保留组件 API（goldMesh 参数）以免调用方改动，但不再渲染金色光斑。
 */
export function MeshBackground({ goldMesh = false }: { goldMesh?: boolean }) {
  const isDark = useColorScheme() === 'dark'
  const bg = isDark ? dark.pageBg : colors.pageBg
  return (
    <View style={[StyleSheet.absoluteFill, styles.fill]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: bg }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: {
    pointerEvents: 'none' as any,
  },
})
