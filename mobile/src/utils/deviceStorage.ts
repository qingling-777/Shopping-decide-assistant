import { Platform } from 'react-native'

function uuid(): string {
  // RFC4122 v4，避免依赖 crypto.randomUUID（部分 Hermes 版本缺失）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

let deviceId: string | null = null

export const deviceStorage = {
  get(): string {
    if (deviceId) return deviceId
    if (Platform.OS === 'web') {
      try {
        const stored = localStorage.getItem('device_id')
        if (stored) {
          deviceId = stored
          return deviceId
        }
        const generated = uuid()
        localStorage.setItem('device_id', generated)
        deviceId = generated
        return deviceId
      } catch {
        // localStorage 不可用则降级到内存（每次刷新重新生成）
      }
    }
    // 原生端无持久化依赖时降级到内存（PAYWALL_DESIGN §7 已接受此重置风险）
    deviceId = uuid()
    return deviceId
  },
}
