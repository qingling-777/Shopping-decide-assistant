import { Platform } from 'react-native'

// API 基址解析优先级：
// 1) EXPO_PUBLIC_API_BASE_URL 显式注入（原生端/CI 构建时用）
// 2) Web 端本地开发：localhost / 127.0.0.1 下直接连后端 `http://localhost:8082/api/v1`
//    （Expo Web 本地没有反代时，`window.location.origin/api/v1` 会命中前端 HTML，导致 JSON 解析失败）。
// 3) Web 端线上同域部署：`${window.location.origin}/api/v1`
// 4) 其他情况回退本地 `http://localhost:8082/api/v1`
export const API_BASE_URL = (() => {
  const fromEnv = typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_API_BASE_URL
  if (fromEnv) return fromEnv
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window && window.location) {
    const host = window.location.hostname
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:8082/api/v1'
    }
    return `${window.location.origin}/api/v1`
  }
  return 'http://localhost:8082/api/v1'
})()

export const PLATFORM_LABELS: Record<string, string> = {
  taobao: '淘宝/天猫',
  jd: '京东',
  pdd: '拼多多',
}
export const PLATFORM_COLORS: Record<string, string> = {
  taobao: '#FF6600',
  jd: '#E1251B',
  pdd: '#E02E24',
}

export const ADVICE_COLORS: Record<string, string> = {
  '值得买': '#22c55e',
  '可以考虑': '#f59e0b',
  '可以再等等': '#ef4444',
}

// 运营联系方式（会员专属微信）：在此一处配置，会员状态卡与升级弹窗两处复用。
// 上线前把 id 改成你的真实微信号即可（id 为空则不渲染联系方式入口）。
export const OPERATOR_WECHAT = {
  id: '', // ← 替换为你的微信号；留空则不渲染联系方式入口
  label: '会员专属微信',
  hint: '复制后打开微信 → 添加朋友 → 搜索微信号',
}
