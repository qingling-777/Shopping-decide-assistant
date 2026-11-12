import React, { useMemo } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing } from '../../theme'
import { useTheme } from '../../utils/theme'

interface ProvenanceFooterProps {
  /** 数据来源（知识库条目 / 联盟数据源名）。缺省时回退 defaultSource。 */
  source?: string
  /** 可信度：高 / 中 / 低。 */
  confidence?: string
  /** 附加说明（如竞争强度推导口径、趋势口径等非官方数据提示）。 */
  note?: string
  /** source 缺省时的兜底文案。 */
  defaultSource?: string
}

const DEFAULT_SOURCE = '好单库（淘宝/天猫联盟商品聚合）'

/**
 * 统一的卡片溯源 / 可信度脚注：所有结果卡底部共用，保证来源标注口径一致。
 * 布局：上行 [来源（左，可截断） · 可信度（右）] + 可选 note 说明行。
 */
export function ProvenanceFooter({ source, confidence, note, defaultSource = DEFAULT_SOURCE }: ProvenanceFooterProps) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const confidenceColor =
    confidence === '高' ? C.success : confidence === '低' ? C.warning : C.primary

  return (
    <View style={S.footer}>
      <View style={S.row}>
        <Text style={S.source} numberOfLines={1}>
          {source || defaultSource}
        </Text>
        {confidence ? (
          <Text style={[S.confidence, { color: confidenceColor }]}>可信度 {confidence}</Text>
        ) : null}
      </View>
      {note ? <Text style={S.note}>{note}</Text> : null}
    </View>
  )
}

type ColorSet = {
  border: string
  textMuted: string
  primary: string
  success: string
  warning: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  footer: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  source: {
    fontSize: 11,
    color: C.textMuted,
    flex: 1,
    marginRight: spacing.sm,
  },
  confidence: {
    fontSize: 11,
    fontWeight: '600',
  },
  note: {
    fontSize: 11,
    color: C.textMuted,
    lineHeight: 16,
    marginTop: spacing.xs,
  },
  })
}
