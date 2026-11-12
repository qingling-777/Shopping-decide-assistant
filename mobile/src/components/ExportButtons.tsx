import React, { useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { colors, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { copyText, downloadText } from '../utils/share'

interface Props {
  getText: () => string
  filename: string
}

// 方案导出/分享：复制文案（剪贴板）+ 下载 .md（Web Blob），纯前端、无需原生模块
export function ExportButtons({ getText, filename }: Props) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const flash = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(''), 1800)
  }

  const onCopy = async () => {
    if (busy) return
    setBusy(true)
    const ok = await copyText(getText())
    flash(ok ? '已复制 ✓' : '复制失败')
    setBusy(false)
  }

  const onDownload = () => {
    if (busy) return
    setBusy(true)
    downloadText(getText(), filename)
    flash('已下载 .md ✓')
    setBusy(false)
  }

  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.btn} activeOpacity={0.8} onPress={onCopy}>
        <Text style={styles.btnText}>复制文案</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.btn, styles.btnAlt]} activeOpacity={0.8} onPress={onDownload}>
        <Text style={styles.btnText}>下载 .md</Text>
      </TouchableOpacity>
      {msg ? <Text style={styles.msg}>{msg}</Text> : null}
    </View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  btn: {
    flex: 1,
    backgroundColor: C.primary,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  btnAlt: { backgroundColor: C.primary + '14' },
  btnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  msg: { fontSize: 12, color: C.success, fontWeight: '600' },
})
}
