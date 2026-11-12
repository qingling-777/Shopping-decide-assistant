import React from 'react'
import { Image, View, StyleSheet } from 'react-native'
import { modelIconKey } from '../utils/models'
import { useTheme } from '../utils/theme'

/**
 * 模型品牌图标（本地官方 logo）。
 * - 浅色主题用彩色图标、深色主题用深色版图标；
 * - 对浅色下不醒目的品牌（Kimi 白 logo），在其后垫一层品牌色圆形底。
 * 样式克制、尺寸统一，用于模型选择 pill 与选择弹层。
 */
export function ModelIcon({ model, size = 18, rounded = false }: { model: string; size?: number; rounded?: boolean }) {
  const { isDark } = useTheme()
  const icon = modelIconKey(model)
  if (!icon) return null
  const src = isDark ? icon.dark : icon.light
  // Kimi 等需深色底衬托的图标：垫品牌色圆形底
  if (icon.brandBg && !isDark) {
    return (
      <View style={[styles.brandCircle, { width: size, height: size, borderRadius: size / 2, backgroundColor: icon.brandBg }]}>
        <Image source={src} style={[styles.img, { width: size * 0.62, height: size * 0.62 }]} resizeMode="contain" />
      </View>
    )
  }
  if (rounded) {
    return (
      <View style={[styles.brandCircle, { width: size, height: size, borderRadius: size / 2, backgroundColor: icon.brandBg || '#f0f4ff' }]}>
        <Image source={src} style={[styles.img, { width: size * 0.62, height: size * 0.62 }]} resizeMode="contain" />
      </View>
    )
  }
  return <Image source={src} style={[styles.img, { width: size, height: size }]} resizeMode="contain" />
}

const styles = StyleSheet.create({
  img: { width: 18, height: 18 },
  brandCircle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
})
