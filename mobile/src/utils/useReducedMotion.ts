import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/**
 * 读取系统「减少动态效果」偏好（P2 无障碍）。
 * 本 RN 版本的类型未导出 useReducedMotion，这里基于 AccessibilityInfo 自建，
 * 动画逻辑据此降级（关闭 spring / 缩短时长）。
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    let mounted = true
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      if (mounted) setReduced(!!v)
    })
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduced(!!v)
    })
    return () => {
      mounted = false
      // @ts-ignore 旧版本返回 EmitterSubscription，新版本返回 { remove }
      sub && sub.remove && sub.remove()
    }
  }, [])
  return reduced
}
