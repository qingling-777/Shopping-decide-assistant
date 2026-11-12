import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '../utils/useReducedMotion'
import { useAppState } from './useAppState'
import { motion } from '../theme'

function roundValue(v: number, decimals: number): number {
  return decimals > 0 ? Number(v.toFixed(decimals)) : Math.round(v)
}

/**
 * 数字滚动（生命力双锚点之二）：主体 600ms ease-out cubic + 尾段 200ms 弹性 overshoot 3%（价/佣/销/增速进场一次性触发）。
 * 仅动数值动画（requestAnimationFrame，零依赖）；不随滚动重复。
 * - reduce-motion：直接就位终值，不走动画。
 * - AppState 后台：暂停 rAF（elapsed 冻结），回前台恢复，避免后台空转（性能护栏 6.4）。
 * 返回当前数值，由调用方按需格式化（toFixed / 加 ¥ % 万 等）。
 */
export function useCountUp({
  to,
  duration = 600,
  decimals = 0,
}: {
  to: number
  duration?: number
  decimals?: number
}): number {
  const reduce = useReducedMotion()
  const active = useAppState()
  const [value, setValue] = useState(reduce ? to : 0)
  const rafRef = useRef<number | null>(null)
  const elapsedRef = useRef(0)
  const lastTsRef = useRef<number | null>(null)

  useEffect(() => {
    if (reduce) {
      setValue(to)
      return
    }
    // 后台（非 active）：不启动 loop，elapsed 冻结，等回前台再恢复
    if (!active) return

    const tail = motion.duration.countTail // 200ms 弹性尾
    const total = duration + tail
    const overshoot = 0.03 // 过冲 3%（2-4% 区间内）
    elapsedRef.current = 0
    lastTsRef.current = null

    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts
      const dt = ts - lastTsRef.current
      // 仅前台推进；后台帧不累加，实现暂停
      if (active) elapsedRef.current += dt
      lastTsRef.current = ts
      const e = elapsedRef.current

      let v: number
      if (e <= duration) {
        const p = Math.min(e / duration, 1)
        v = to * (1 - Math.pow(1 - p, 3)) // ease-out cubic（对应 EASE.decelerate）
      } else if (e < total) {
        const p = (e - duration) / tail
        v = to * (1 + overshoot * Math.sin(p * Math.PI)) // 弹性尾段：先过冲再回落
      } else {
        setValue(roundValue(to, decimals))
        return
      }
      setValue(roundValue(v, decimals))
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [to, duration, decimals, reduce, active])

  return value
}
