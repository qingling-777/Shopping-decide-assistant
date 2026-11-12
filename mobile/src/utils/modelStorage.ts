import { Platform } from 'react-native'

// 用户选择的回答模型品牌（auto / deepseek / qwen / r1），持久化以便跨会话记住偏好。
// 原生端无 localStorage 时降级为内存态（仅当前会话有效），web 端用 localStorage 持久化。
const KEY = 'sa_model_brand'
let cached: string | null = null

export const modelStorage = {
  get(): string {
    if (cached) return cached
    if (Platform.OS === 'web') {
      try {
        const v = localStorage.getItem(KEY)
        if (v) {
          cached = v
          return v
        }
      } catch {
        // localStorage 不可用则降级到内存
      }
    }
    return 'auto'
  },
  set(v: string) {
    cached = v
    if (Platform.OS === 'web') {
      try {
        localStorage.setItem(KEY, v)
      } catch {
        // 忽略写入失败
      }
    }
  },
}
