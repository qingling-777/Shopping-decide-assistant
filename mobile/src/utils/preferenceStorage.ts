import { Platform } from 'react-native'

// 偏好设置（设置页开关）持久化：web 用 localStorage，native 用内存变量。
// 与 authStorage.tokenStorage 同构，保证刷新后开关状态保持。
let nativePrefs: Record<string, boolean> = {}

const prefStorage = {
  get(key: string, fallback: boolean): boolean {
    if (Platform.OS === 'web') {
      try {
        const raw = localStorage.getItem(`pref:${key}`)
        if (raw == null) return fallback
        return raw === '1'
      } catch {
        return fallback
      }
    }
    return nativePrefs[key] ?? fallback
  },
  set(key: string, value: boolean) {
    if (Platform.OS === 'web') {
      try {
        localStorage.setItem(`pref:${key}`, value ? '1' : '0')
      } catch {
        // localStorage 不可用（隐私模式/限额），静默降级为内存态
      }
    } else {
      nativePrefs[key] = value
    }
  },
}

export default prefStorage
