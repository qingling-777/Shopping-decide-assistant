import React from 'react'
import { View, Text } from 'react-native'
import { useTheme } from '../utils/theme'

// AI 模块用量回执（2026-08-25）：商品介绍 / 推广方案等按 token 计费的功能，生成后展示消耗与费用。
// usage 来自后端 record_usage 回执：{tokens_in, tokens_out, tokens_cached, cost_yuan, is_free, model?}
export function UsageReceipt({ usage, compact = false }: { usage?: any; compact?: boolean }) {
  const { colors: C } = useTheme()
  if (!usage || !usage.tokens_in) return null
  const costText = usage.is_free ? '免费额度内' : `¥${(usage.cost_yuan ?? 0).toFixed(5)}`
  return (
    <View
      style={{
        marginTop: compact ? 4 : 8,
        paddingVertical: 5,
        paddingHorizontal: 10,
        backgroundColor: C.pageBg,
        borderRadius: 8,
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ fontSize: 11, color: C.textMuted }}>
        消耗 {usage.tokens_in} in / {usage.tokens_out} out tokens
        {usage.tokens_cached ? `（缓存 ${usage.tokens_cached}）` : ''} · 费用 {costText}
      </Text>
    </View>
  )
}
