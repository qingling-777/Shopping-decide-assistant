import { Platform } from 'react-native'

// 腾讯云验证码 AppId（非敏感，需向前端公开才能弹窗；与控制台「验证管理 → 基础配置」一致）
export const CAPTCHA_APP_ID = '195936368'
// 验证码 JS 地址（2.0；用 1.0 则换 turing.captcha.qcloud.com/TCaptcha.js）
const CAPTCHA_JS_SRC = 'https://turing.captcha.qcloud.com/TJCaptcha.js'

// 全局类型声明：TencentCaptcha 是脚本注册的类
declare global {
  interface Window {
    TencentCaptcha?: any
  }
}

let cachedScript: Promise<void> | null = null

/** 动态引入验证码 JS（web 端）。非 web 平台（iOS/Android 原生）走 `captcha.show()` 由原生依赖承载，这里直接拒绝。 */
function loadCaptchaScript(): Promise<void> {
  if (Platform.OS !== 'web') return Promise.reject(new Error('验证码仅支持 Web 端调用'))
  if (cachedScript) return cachedScript
  cachedScript = new Promise((resolve, reject) => {
    const existing = document.getElementById('tencent-captcha-js')
    if (existing) return resolve()
    const script = document.createElement('script')
    script.id = 'tencent-captcha-js'
    script.src = CAPTCHA_JS_SRC
    script.onload = () => {
      // 脚本加载后，TencentCaptcha 由脚本内部动态注册（可能稍晚），继续轮询一下
      if (window.TencentCaptcha) return resolve()
      let tries = 0
      const interval = setInterval(() => {
        tries++
        if (window.TencentCaptcha || tries > 20) {
          clearInterval(interval)
          window.TencentCaptcha ? resolve() : reject(new Error('TencentCaptcha 未注册'))
        }
      }, 250)
    }
    script.onerror = () => {
      cachedScript = null
      reject(new Error('验证码脚本加载失败'))
    }
    document.body.appendChild(script)
  })
  return cachedScript
}

export interface CaptchaResult {
  ticket: string | null
  randstr: string | null
  ret: number
  errorCode?: number
  canceled?: boolean
}

// e2e 构建时置 EXPO_PUBLIC_ENABLE_CAPTCHA=false：跳过真实弹窗，直发测试票据（后端 DEBUG 模式接受 trtest_ 前缀）
function e2eBypassEnabled(): boolean {
  return typeof process !== 'undefined' && process.env && process.env.EXPO_PUBLIC_ENABLE_CAPTCHA === 'false'
}

/**
 * 弹出腾讯云图形验证码，返回票据结果。
 * - 验证通过：{ ticket, randstr, ret: 0 }
 * - 用户主动关闭：{ ret: 2, canceled: true }
 * - 加载/初始化失败：拒绝（调用方可降级处理）
 */
export function runTencentCaptcha(): Promise<CaptchaResult> {
  // e2e 测试模式（显式置 EXPO_PUBLIC_ENABLE_CAPTCHA=false）：不弹真实验证码，
  // 直接返回可被后端 DEBUG 模式接受的测试票据（后端接受 trtest_ 前缀）。
  if (e2eBypassEnabled()) {
    const ts = Date.now()
    return Promise.resolve({ ticket: `trtest_e2e_${ts}`, randstr: `@e2e${ts}`, ret: 0 })
  }
  if (Platform.OS !== 'web') {
    // 原生端（iOS/Android）：TencentCaptcha JS 需要 WebView，这里直接报错，由上层提示改用 WebView 弹窗
    return Promise.reject(new Error('验证码需在 Web 端运行'))
  }
  return new Promise((resolve, reject) => {
    loadCaptchaScript()
      .then(() => {
        const captcha = new window.TencentCaptcha(CAPTCHA_APP_ID, (res: any) => {
          if (res.ret === 0 && res.ticket) {
            resolve({ ticket: res.ticket, randstr: res.randstr, ret: 0, errorCode: res.errorCode })
          } else {
            resolve({ ticket: null, randstr: null, ret: res.ret, errorCode: res.errorCode, canceled: true })
          }
        }, { userLanguage: 'zh-cn' })
        captcha.show()
      })
      .catch((error) => reject(error))
  })
}
