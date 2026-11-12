import React from 'react'
import { Text } from 'react-native'
import { useCountUp } from '../hooks/useCountUp'

/**
 * 数字滚动展示组件（生命力双锚点之二）：价/佣/销/增速等数值进场一次性滚动到终值，≤600ms。
 * 直接复用 useCountUp；reduce-motion 时静态显示终值。可像普通 <Text> 一样内嵌到句子里。
 */
export function CountUp({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  duration = 600,
  style,
}: {
  value: number
  decimals?: number
  prefix?: string
  suffix?: string
  duration?: number
  style?: any
}) {
  const v = useCountUp({ to: value, decimals, duration })
  return (
    <Text style={style}>
      {prefix}
      {v}
      {suffix}
    </Text>
  )
}
