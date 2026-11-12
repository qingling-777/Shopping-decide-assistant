import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native'
import { colors, dark, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { API_BASE_URL } from '../constants'
import { tokenStorage } from '../utils/authStorage'
import { deviceStorage } from '../utils/deviceStorage'
import { ScreenFrame } from '../components/ScreenFrame'

interface UsageEvent {
  id: string
  event_type: string
  model: string
  model_brand: string
  tokens_in: number
  tokens_out: number
  cost_yuan: number
  is_free: boolean
  internal: boolean
  balance_after: number
  created_at: string
}

interface UsageSummary {
  events: number
  free_events: number
  paid_events: number
  total_cost_yuan: number
  tokens_in: number
  tokens_out: number
  free_remaining: number
}

interface UsageData {
  items: UsageEvent[]
  total: number
  summary: UsageSummary
}

const EVENT_LABEL: Record<string, string> = {
  chat: '问答',
  card_llm: '卡片生成',
  card_data_insight: '数据卡',
  card_opportunity: '机会卡',
  card_product: '商品卡',
  card_trend: '趋势卡',
}

const MODEL_COLORS = [colors.primary, colors.success, colors.warning, colors.gold, colors.danger, colors.textMuted]

type UsageChartSegment = {
  model: string
  label: string
  tokens: number
  color: string
}

type UsageChartDay = {
  dayKey: string
  label: string
  total: number
  segments: UsageChartSegment[]
}

type UsageChartModel = {
  model: string
  label: string
  total: number
  share: number
  color: string
}

type UsageChartData = {
  days: UsageChartDay[]
  models: UsageChartModel[]
  maxTotal: number
  peakDay: UsageChartDay | null
  totalTokens: number
}

function toDayKey(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return (iso || '').slice(0, 10)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function formatDayLabel(dayKey: string): string {
  return dayKey.slice(5).replace('-', '/')
}

function formatTokenCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`
  return String(Math.round(value))
}

function buildUsageChart(items: UsageEvent[]): UsageChartData {
  const dayMap = new Map<string, Map<string, number>>()
  const modelMap = new Map<string, { total: number; lastSeen: string }>()

  for (const ev of items) {
    if (ev.internal) continue
    const tokens = Math.max(0, Math.round((ev.tokens_in || 0) + (ev.tokens_out || 0)))
    if (!tokens) continue
    const dayKey = toDayKey(ev.created_at)
    const model = ev.model ? ev.model.split('/').pop() || ev.model : 'AI'
    if (!dayMap.has(dayKey)) dayMap.set(dayKey, new Map())
    const dayBucket = dayMap.get(dayKey)!
    dayBucket.set(model, (dayBucket.get(model) || 0) + tokens)

    const modelBucket = modelMap.get(model) || { total: 0, lastSeen: dayKey }
    modelBucket.total += tokens
    modelBucket.lastSeen = dayKey
    modelMap.set(model, modelBucket)
  }

  const totalTokens = Array.from(modelMap.values()).reduce((sum, item) => sum + item.total, 0)
  const models = Array.from(modelMap.entries())
    .map(([model, meta], index) => ({
      model,
      label: model,
      total: meta.total,
      share: totalTokens > 0 ? meta.total / totalTokens : 0,
      color: MODEL_COLORS[index % MODEL_COLORS.length],
    }))
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model, 'zh-Hans-CN'))

  const dayKeys = Array.from(dayMap.keys()).sort()
  const recentDayKeys = dayKeys.slice(-7)
  const days = recentDayKeys.map((dayKey) => {
    const modelCounts = dayMap.get(dayKey) || new Map<string, number>()
    const segments = models
      .map((model) => ({
        model: model.model,
        label: model.label,
        tokens: modelCounts.get(model.model) || 0,
        color: model.color,
      }))
      .filter((seg) => seg.tokens > 0)
    const total = segments.reduce((sum, seg) => sum + seg.tokens, 0)
    return {
      dayKey,
      label: formatDayLabel(dayKey),
      total,
      segments,
    }
  })

  const maxTotal = Math.max(...days.map((day) => day.total), 1)
  const peakDay = days.reduce<UsageChartDay | null>((best, day) => {
    if (!best || day.total > best.total) return day
    return best
  }, null)

  return { days, models, maxTotal, peakDay, totalTokens }
}

export function UsageScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_URL}/billing/events?limit=50`, {
        headers: {
          Authorization: `Bearer ${tokenStorage.get() || ''}`,
          'X-Device-Id': deviceStorage.get() || '',
        },
      })
      if (!res.ok) throw new Error(`加载失败 (${res.status})`)
      const json = await res.json()
      setData(json)
    } catch (e: any) {
      setError(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (visible) load()
  }, [visible])

  const summary = data?.summary
  const chart = useMemo(() => buildUsageChart(data?.items || []), [data])
  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  const modelShort = (m?: string) => (m ? m.split('/').pop() || m : 'AI')

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="我的消耗明细">
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.textMuted} />}
      >
        {/* 汇总卡（硅基流动风格透明计费） */}
        {summary && (
          <View
            style={{
              backgroundColor: C.cardBg,
              borderRadius: radius.lg,
              padding: spacing.lg,
              marginBottom: spacing.lg,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(33,48,74,0.8)' : 'rgba(226,232,240,0.9)',
            }}
          >
            <Text style={{ fontSize: 13, color: C.textMuted, marginBottom: 10 }}>
              透明计费 · 你每次问答都能看到用了什么模型、多少 token、花了多少
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <SummaryStat label="总事件" value={String(summary.events)} C={C} />
              <SummaryStat label="免费" value={String(summary.free_events)} C={C} />
              <SummaryStat label="已花费" value={`¥${summary.total_cost_yuan.toFixed(4)}`} C={C} />
              <SummaryStat label="今日免费剩" value={String(summary.free_remaining)} C={C} />
            </View>
            <View
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTopWidth: 1,
                borderTopColor: isDark ? 'rgba(33,48,74,0.6)' : 'rgba(226,232,240,0.8)',
                flexDirection: 'row',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ fontSize: 12, color: C.textMuted }}>累计输入 {summary.tokens_in} tokens</Text>
              <Text style={{ fontSize: 12, color: C.textMuted }}>累计输出 {summary.tokens_out} tokens</Text>
            </View>
          </View>
        )}

        {data ? <UsageTokenChart chart={chart} C={C} isDark={isDark} /> : null}

        {loading && !data ? (
          <View style={{ paddingTop: 60, alignItems: 'center' }}>
            <ActivityIndicator color={C.primary} />
          </View>
        ) : error ? (
          <View style={{ paddingTop: 40, alignItems: 'center' }}>
            <Text style={{ color: C.textMuted }}>{error}</Text>
            <TouchableOpacity onPress={load} style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: C.primary, borderRadius: 999 }}>
              <Text style={{ color: '#fff', fontWeight: '600' }}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : (
          (data?.items.length ?? 0) === 0 ? (
            <View style={{ paddingTop: 50, alignItems: 'center' }}>
              <Text style={{ color: C.textMuted, fontSize: 14 }}>还没有消耗记录，去聊一聊吧</Text>
            </View>
          ) : (
            <View>
              {data!.items.map((ev) => (
                <View
                  key={ev.id}
                  style={{
                    backgroundColor: C.cardBg,
                    borderRadius: radius.md,
                    padding: spacing.md,
                    marginBottom: spacing.sm,
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(33,48,74,0.7)' : 'rgba(226,232,240,0.9)',
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: C.textPrimary }}>
                      {EVENT_LABEL[ev.event_type] || ev.event_type} · {modelShort(ev.model)}
                    </Text>
                    <View
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 2,
                        borderRadius: 999,
                        backgroundColor: ev.is_free ? '#16a34a' + '1a' : '#b8860b' + '1a',
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '700',
                          color: ev.is_free ? '#16a34a' : '#b8860b',
                        }}
                      >
                        {ev.is_free ? '免费额度内' : `¥${ev.cost_yuan.toFixed(5)}`}
                      </Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
                    <Text style={{ fontSize: 12, color: C.textMuted }}>
                      输入 {ev.tokens_in} / 输出 {ev.tokens_out} tokens
                    </Text>
                    <Text style={{ fontSize: 12, color: C.textMuted }}>{fmtTime(ev.created_at)}</Text>
                  </View>
                </View>
              ))}
              <Text style={{ textAlign: 'center', color: C.textMuted, fontSize: 12, marginTop: 8 }}>
                共 {data!.total} 条 · 内部核算事件不在此展示
              </Text>
            </View>
          )
        )}
      </ScrollView>
    </ScreenFrame>
  )
}

function UsageTokenChart({ chart, C, isDark }: { chart: UsageChartData; C: any; isDark: boolean }) {
  if (!chart.days.length) return null
  return (
    <View
      style={{
        backgroundColor: C.cardBg,
        borderRadius: radius.lg,
        padding: spacing.lg,
        marginBottom: spacing.lg,
        borderWidth: 1,
        borderColor: isDark ? 'rgba(33,48,74,0.8)' : 'rgba(226,232,240,0.9)',
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 14, fontWeight: '800', color: C.textPrimary }}>token 随日期用量图</Text>
          <Text style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
            近 {chart.days.length} 天 · 按模型分色堆叠
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: C.textPrimary }}>{formatTokenCount(chart.totalTokens)}</Text>
          <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>累计 tokens</Text>
        </View>
      </View>

      {chart.peakDay ? (
        <Text style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
          峰值 {chart.peakDay.label} · {formatTokenCount(chart.peakDay.total)} tokens
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, minHeight: 176, paddingTop: 4, paddingBottom: 6 }}>
        {chart.days.map((day) => {
          const total = Math.max(day.total, 1)
          return (
            <View key={day.dayKey} style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
              <Text style={{ fontSize: 10, color: C.textSecondary, marginBottom: 4 }} numberOfLines={1}>
                {formatTokenCount(day.total)}
              </Text>
              <View style={{ height: 110, justifyContent: 'flex-end', alignItems: 'stretch', width: '100%' }}>
                <View
                  style={{
                    height: Math.max(10, Math.round((day.total / chart.maxTotal) * 100)),
                    borderRadius: 10,
                    overflow: 'hidden',
                    backgroundColor: C.borderLight || C.border,
                  }}
                >
                  {day.segments.map((seg) => {
                    const segmentHeight = Math.max(6, Math.round((seg.tokens / total) * 100))
                    return <View key={`${day.dayKey}-${seg.model}`} style={{ height: `${segmentHeight}%`, backgroundColor: seg.color }} />
                  })}
                </View>
              </View>
              <Text style={{ fontSize: 10, color: C.textMuted, marginTop: 6 }} numberOfLines={1}>
                {day.label}
              </Text>
            </View>
          )
        })}
      </View>

      {chart.models.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
          {chart.models.map((model) => (
            <View key={model.model} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: '48%' }}>
              <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: model.color }} />
              <Text style={{ fontSize: 12, color: C.textMuted, flexShrink: 1 }} numberOfLines={1}>
                {model.label} · {formatTokenCount(model.total)} tokens · {Math.round(model.share * 100)}%
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

function SummaryStat({ label, value, C }: { label: string; value: string; C: any }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ fontSize: 16, fontWeight: '800', color: C.textPrimary }}>{value}</Text>
      <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{label}</Text>
    </View>
  )
}
