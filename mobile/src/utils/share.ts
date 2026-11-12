// 方案导出/分享工具：Web 端复制文案 + 下载 Markdown 文件（纯前端，无需原生模块）
import type { PromoPlan, PlanPromoStrategy } from './types'

// Web 全局（RN 类型里没有 document/navigator，用 globalThis as any 规避 TS 报错）
const g: any = globalThis

export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (g.navigator && g.navigator.clipboard && g.navigator.clipboard.writeText) {
      await g.navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

export const downloadText = (text: string, filename: string): void => {
  try {
    if (!g.document || !g.Blob || !g.URL) return
    const blob = new g.Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = g.URL.createObjectURL(blob)
    const a = g.document.createElement('a')
    a.href = url
    a.download = filename
    g.document.body.appendChild(a)
    a.click()
    g.document.body.removeChild(a)
    g.URL.revokeObjectURL(url)
  } catch {
    /* ignore */
  }
}

const lines = (arr?: string[]) => (Array.isArray(arr) && arr.length ? arr.filter(Boolean).join('\n') : '')

// 单品推广方案 → Markdown
export const formatPromoPlan = (plan: PromoPlan): string => {
  const out: string[] = []
  out.push(`# 推广方案：${plan.title || '商品'}`)
  out.push('')
  if (plan.introSummary) {
    out.push(`## 商品介绍`)
    out.push(plan.introSummary)
    out.push('')
  }
  if (plan.introHighlights && plan.introHighlights.length) {
    out.push(`### 核心卖点`)
    plan.introHighlights.forEach((h) => out.push(`- ${h}`))
    out.push('')
  }
  if (plan.targetAudience) {
    out.push(`## 目标人群`)
    out.push(plan.targetAudience)
    out.push('')
  }
  if (plan.influencerType) {
    out.push(`## 达人类型`)
    out.push(plan.influencerType)
    out.push('')
  }
  if (plan.openingHook) {
    out.push(`## 开头钩子`)
    out.push(plan.openingHook)
    out.push('')
  }
  if (plan.hooks && plan.hooks.length) {
    out.push(`## 标题钩子`)
    plan.hooks.forEach((h) => out.push(`- ${h}`))
    out.push('')
  }
  if (plan.body) {
    out.push(`## 正文`)
    out.push(plan.body)
    out.push('')
  }
  if (plan.sellingPoints && plan.sellingPoints.length) {
    out.push(`## 卖点`)
    plan.sellingPoints.forEach((s) => out.push(`- ${s}`))
    out.push('')
  }
  if (plan.commentInteraction) {
    out.push(`## 互动引导`)
    out.push(plan.commentInteraction)
    out.push('')
  }
  if (plan.platforms && plan.platforms.length) {
    out.push(`## 主推平台`)
    plan.platforms.forEach((p) => out.push(`- ${p.name}${p.angle ? `：${p.angle}` : ''}`))
    out.push('')
  }
  if (plan.schedule) {
    out.push(`## 发布节奏`)
    out.push(plan.schedule)
    out.push('')
  }
  if (plan.complianceRisk) {
    out.push(`## 合规风险`)
    out.push(plan.complianceRisk)
    out.push('')
  }
  if (plan.kpi) {
    out.push(`## KPI`)
    out.push(plan.kpi)
    out.push('')
  }
  if (plan.abTest) {
    out.push(`## A/B 测试`)
    out.push(plan.abTest)
    out.push('')
  }
  if (plan.budget) {
    out.push(`## 预算`)
    out.push(plan.budget)
    out.push('')
  }
  if (plan.sources && plan.sources.length) {
    out.push(`## 参考来源（联网测评）`)
    plan.sources.forEach((s) => out.push(`- ${s.title || s.link}${s.link ? ` ${s.link}` : ''}`))
    out.push('')
  }
  return out.join('\n').trim() + '\n'
}

// 计划级整合推广策略 → Markdown
export const formatStrategy = (s: PlanPromoStrategy): string => {
  const out: string[] = []
  out.push(`# 计划级整合推广策略：${s.planName || '测品计划'}`)
  out.push('')
  if (s.overview) {
    out.push(`## 定位`)
    out.push(s.overview)
    out.push('')
  }
  if (s.theme) {
    out.push(`## 主题`)
    out.push(s.theme)
    out.push('')
  }
  if (s.sequence && s.sequence.length) {
    out.push(`## 打品顺序`)
    s.sequence.forEach((x) => out.push(`- ${x}`))
    out.push('')
  }
  if (s.budgetSplit) {
    out.push(`## 预算分配`)
    out.push(s.budgetSplit)
    out.push('')
  }
  if (s.risk) {
    out.push(`## 风险与合规`)
    out.push(s.risk)
    out.push('')
  }
  if (s.kpi) {
    out.push(`## 计划级 KPI`)
    out.push(s.kpi)
    out.push('')
  }
  if (s.contentCalendar) {
    out.push(`## 内容日历`)
    out.push(s.contentCalendar)
    out.push('')
  }
  if (s.platforms && s.platforms.length) {
    out.push(`## 主推平台`)
    s.platforms.forEach((p) => out.push(`- ${p}`))
    out.push('')
  }
  return out.join('\n').trim() + '\n'
}

// 安全的文件名（去掉路径/特殊字符）
export const safeFileName = (name: string): string =>
  (name || '方案')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 40) || '方案'
