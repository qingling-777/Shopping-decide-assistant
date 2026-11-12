import { useEffect, useState } from 'react'
import { AppState } from 'react-native'

/**
 * 订阅 AppState，返回是否处于前台（active）。
 * 供后台暂停所有 loop（Mesh 呼吸 / 骨架 shimmer / count-up rAF）：回前台恢复、退后台停，
 * 避免后台无谓的动画与 CPU 占用（性能护栏 6.4）。
 */
export function useAppState(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active')

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setActive(nextState === 'active')
    })
    return () => subscription.remove()
  }, [])

  return active
}
