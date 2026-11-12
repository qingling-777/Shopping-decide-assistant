// 模型品牌定义：与后端 ai_service.MODEL_BRANDS 的品牌键保持一致。
// 前端只负责 UI 切换与持久化，具体模型 + 兜底链由后端按 key 解析。
export interface ModelBrand {
  key: string
  label: string
  hint?: string
  /** 胶囊顶栏紧凑显示的短名（Gemini 风格，如 Flash / Qwen3.5 / GLM5.2），避免长名撑爆 */
  short?: string
}

export const MODEL_BRANDS: ModelBrand[] = [
  { key: 'auto', label: 'DeepSeek V4-Flash', hint: '推荐 · 对话与卡片同模型', short: 'Flash' },
  { key: 'r1', label: 'R1 推理', hint: '深度求索', short: 'R1' },
  { key: 'deepseek-pro', label: 'DeepSeek V4 Pro', hint: '深度求索·强力', short: 'V4 Pro' },
  { key: 'qwen', label: 'Qwen 3.5', hint: '阿里通义', short: 'Qwen3.5' },
  { key: 'glm', label: 'GLM 5.2', hint: '智谱AI', short: 'GLM5.2' },
  { key: 'glm-pro', label: 'GLM 5.1 Pro', hint: '智谱AI·高级档', short: 'GLM5.1' },
  { key: 'kimi', label: 'Kimi K2.6 Pro', hint: '月之暗面·高级档', short: 'Kimi' },
  { key: 'minimax', label: 'MiniMax M2.5', hint: 'MiniMax', short: 'MiniMax' },
]

export const DEFAULT_MODEL = 'auto'

/**
 * 各模型品牌的官方图标（本地资产，来自 LobeHub lobe-icons 开放图标库）。
 * 通过 require 引入本地 PNG，浅色背景用 light/ 版彩色图标，深色背景用 dark/ 版。
 * 注意：Kimi 官方 logo 为白色图形（仅右上角一小蓝点），浅色背景需配深色图标，
 * 故 kimi 在 light 主题下使用 dark/ 深色图形，其余品牌 light 用彩色、dark 用深色版。
 */
import deepseekLight from '../../assets/models/deepseek.png'
import qwenLight from '../../assets/models/qwen.png'
import zhipuLight from '../../assets/models/zhipu.png'
import minimaxLight from '../../assets/models/minimax.png'
import deepseekDark from '../../assets/models/dark/deepseek.png'
import qwenDark from '../../assets/models/dark/qwen.png'
import zhipuDark from '../../assets/models/dark/zhipu.png'
import kimiDark from '../../assets/models/dark/kimi.png'
import minimaxDark from '../../assets/models/dark/minimax.png'

export interface ModelIconSet {
  key: string
  light: number
  dark: number
  /** 图标所在的品牌色圆形底（用于浅色下不够醒目的品牌，如 Kimi） */
  brandBg?: string
}

// 品牌图标源（light/dark 各一套）；kimi 的 light 用 dark 图形（白logo浅底不可见）
const _iconMap: Record<string, { light: number; dark: number; brandBg?: string }> = {
  auto:       { light: deepseekLight, dark: deepseekDark },
  r1:         { light: deepseekLight, dark: deepseekDark },
  'deepseek-pro': { light: deepseekLight, dark: deepseekDark },
  qwen:       { light: qwenLight, dark: qwenDark },
  glm:        { light: zhipuLight, dark: zhipuDark },
  'glm-pro':  { light: zhipuLight, dark: zhipuDark },
  kimi:       { light: kimiDark, dark: kimiDark, brandBg: '#16213A' }, // Kimi 白色 logo 需深底
  minimax:    { light: minimaxLight, dark: minimaxDark },
}

/** 按品牌 key 取当前主题下的图标源 */
export function modelIconKey(key: string): ModelIconSet | null {
  const m = _iconMap[key]
  if (!m) return null
  return { key, light: m.light, dark: m.dark, brandBg: m.brandBg }
}
