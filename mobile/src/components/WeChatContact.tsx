import React, { useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, Platform } from 'react-native'
import { colors, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { OPERATOR_WECHAT } from '../constants'

/** 零依赖复制到剪贴板：web 用 navigator.clipboard（非安全上下文退回 textarea+execCommand），原生用 Clipboard。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    }
    const Clipboard = (require('react-native') as any).Clipboard
    if (Clipboard && Clipboard.setString) {
      Clipboard.setString(text)
      return true
    }
    return false
  } catch {
    return false
  }
}

interface Props {
  /** 标题，默认取 OPERATOR_WECHAT.label */
  title?: string
  /** 副标题提示，默认取 OPERATOR_WECHAT.hint */
  subtitle?: string
  /** 强调色：gold（默认，金色会员风）/ blue（品牌蓝，用于已去金色的充值页等） */
  accent?: 'gold' | 'blue'
}

/**
 * 会员专属微信联系方式（内嵌行，不另起白卡）：展示微信号 + 点按复制。
 * 设计为直接放进金色会员卡 / 升级弹窗内，靠发丝金线分隔，随父卡底色融合。
 * 微信号为空（未配置）时不渲染。
 */
export function WeChatContact({ title, subtitle, accent = 'gold' }: Props) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark, accent), [C, isDark, accent])
  const id = OPERATOR_WECHAT.id
  const [copied, setCopied] = useState(false)
  if (!id) return null

  const onCopy = async () => {
    const ok = await copyText(id)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }

  return (
    <View style={styles.inline}>
      <View style={styles.left}>
        <Text style={styles.title}>{title || OPERATOR_WECHAT.label}</Text>
        <Text style={styles.sub}>{subtitle || OPERATOR_WECHAT.hint}</Text>
        <View style={styles.idRow}>
          <Text style={styles.idLabel}>微信号</Text>
          <Text style={styles.idValue} selectable>{id}</Text>
        </View>
      </View>
      <TouchableOpacity style={styles.copyBtn} activeOpacity={0.8} onPress={onCopy}>
        <Text style={styles.copyBtnText}>{copied ? '已复制 ✓' : '复制'}</Text>
      </TouchableOpacity>
    </View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean, accent: 'gold' | 'blue') {
  const accentColor = accent === 'blue' ? C.primary : C.goldDeep
  const accentBorder = accent === 'blue' ? C.primary + '33' : C.goldBorder
  return {
  inline: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: accentBorder,
  },
  left: { flex: 1, marginRight: spacing.sm },
  title: { fontSize: 14, fontWeight: '700' as const, color: accentColor },
  sub: { fontSize: 12, color: C.textMuted, marginTop: 2, lineHeight: 18 },
  idRow: { flexDirection: 'row' as const, alignItems: 'center' as const, marginTop: spacing.sm, gap: 8 },
  idLabel: {
    fontSize: 11,
    color: C.textSecondary,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1,
    borderColor: accentBorder,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  idValue: { fontSize: 15, fontWeight: '700' as const, color: accentColor, letterSpacing: 0.3 },
  copyBtn: {
    backgroundColor: C.primary,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  copyBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' as const },
  }
}
