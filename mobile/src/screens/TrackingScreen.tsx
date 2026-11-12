import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, RefreshControl, Platform } from 'react-native'
import { ScreenFrame } from '../components/ScreenFrame'
import { colors, dark, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { trackingAPI } from '../utils/api'

/**
 * 我的追踪（独立页）：物流包裹卡风格。
 * 从个人中心「我的追踪」进入；列表由 ProfileScreen 职责中拆分出来，保持主页金融化结构干净。
 * 卡片：状态 pill（销量上行红/回落绿/积累灰）+ 方向名当追踪号 + 圆点进度线 + 四列指标（在售/月销/均价/佣金）。
 */
export function TrackingScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [tracked, setTracked] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await trackingAPI.list()
      setTracked(r.items || [])
    } catch {
      setError('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (visible) load()
  }, [visible, load])

  const handleRemove = useCallback(
    async (direction: string) => {
      try {
        await trackingAPI.remove(direction)
        setTracked((prev) => prev.filter((it) => it.direction !== direction))
      } catch {
        // 删除失败不阻塞：静默保持原列表
      }
    },
    [],
  )

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="我的追踪">
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.textMuted} />}
      >
        <Text style={[styles.eyebrow, { color: C.textMuted }]}>方向追踪</Text>
        <Text style={[styles.title, { color: C.textPrimary }]}>持续观察的方向</Text>
        <Text style={[styles.desc, { color: C.textSecondary }]}>
          每个方向按时间记录在售、月销、均价、佣金。销量上涨标红，回落标绿，积累中为灰。
        </Text>

        {loading && tracked.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={C.primary} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={{ color: C.textMuted }}>{error}</Text>
            <TouchableOpacity onPress={load} style={[styles.retry, { backgroundColor: C.primary }]}>
              <Text style={styles.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : tracked.length === 0 ? (
          <View style={styles.center}>
            <Text style={{ color: C.textMuted, fontSize: 14 }}>还没有追踪的方向</Text>
            <Text style={{ color: C.textMuted, fontSize: 12, marginTop: 6, textAlign: 'center', lineHeight: 18 }}>
              在对话里让顾问推荐方向后，点「追踪方向」即可收入此页持续观察
            </Text>
          </View>
        ) : (
          tracked.map((item) => (
            <TrackCard key={item.direction} item={item} onRemove={() => handleRemove(item.direction)} C={C} isDark={isDark} />
          ))
        )}
      </ScrollView>
    </ScreenFrame>
  )
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    paddingBottom: 40,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
    marginBottom: 6,
  },
  desc: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: spacing.lg,
  },
  center: {
    paddingTop: 60,
    alignItems: 'center',
    gap: 8,
  },
  retry: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
  },
  // ── 物流包裹卡 ───────────────────────────────
  trackCard: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: 'transparent',
  },
  trackCardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  trackStatusPill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  trackStatusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  trackRemove: {
    fontSize: 12,
    fontWeight: '600',
  },
  trackName: {
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  trackStats: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: 4,
  },
  trackStatCol: {
    flex: 1,
  },
  trackStatVal: {
    fontSize: 15,
    fontWeight: '700',
  },
  trackStatLabel: {
    fontSize: 11,
    marginTop: 1,
  },
  // 圆点进度线
  progDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  progDotMid: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  progDotCurrent: {
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2.5,
    backgroundColor: 'transparent',
  },
  progLine: {
    flex: 1,
    height: 2,
    opacity: 0.55,
  },
})

// 趋势状态：末值相对首值 → 涨(红)/跌(绿)/平(灰)，对应中国行情涨红跌绿
function trendState(series: any[], key: string): 'up' | 'down' | 'flat' {
  const vals = (series || []).map((p) => p[key]).filter((v): v is number => typeof v === 'number')
  if (vals.length < 2) return 'flat'
  const first = vals[0]
  const last = vals[vals.length - 1]
  if (last > first) return 'up'
  if (last < first) return 'down'
  return 'flat'
}

function fmtNum(v: number | null | undefined, key?: string): string {
  if (v == null) return '—'
  if (key === 'total_sales') return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${Math.round(v)}`
  if (key === 'avg_price') return `¥${Math.round(v)}`
  if (key === 'avg_commission') return `${Number(v).toFixed(1)}%`
  return `${Math.round(v)}`
}

function fmtDate(iso: string | undefined | null): string {
  if (!iso) return ''
  return iso.slice(5).replace('-', '/') // "2026-08-27" → "08/27"
}

// 圆点进度线：起点圆点 → (可选中间点) → 当前圆点，两端配时间戳 + 起止标签
function DirectionProgress({ series, color, C }: { series: any[]; color: string; C: any }) {
  const count = (series || []).length
  const firstDate = series && series[0] ? series[0].date : null
  const lastDate = series && series[count - 1] ? series[count - 1].date : null
  const hasMid = count > 2
  return (
    <View style={{ marginVertical: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={[styles.progDot, { backgroundColor: color }]} />
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
          <View style={[styles.progLine, { backgroundColor: color }]} />
          {hasMid && <View style={[styles.progDot, styles.progDotMid, { backgroundColor: color }]} />}
          {hasMid && <View style={[styles.progLine, { backgroundColor: color }]} />}
        </View>
        <View style={[styles.progDot, styles.progDotCurrent, { borderColor: color }]} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 }}>
        <Text style={{ fontSize: 10, color: C.textMuted }}>首次追踪</Text>
        <Text style={{ fontSize: 10, color: C.textMuted }}>最近更新</Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 1 }}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: C.textSecondary }}>{fmtDate(firstDate)}</Text>
        <Text style={{ fontSize: 11, fontWeight: '600', color: C.textSecondary }}>{fmtDate(lastDate)}</Text>
      </View>
    </View>
  )
}

// 追踪方向：包裹卡（状态 pill + 方向名当追踪号 + 圆点进度线 + 指标行 + 取消）
function TrackCard({ item, onRemove, C }: { item: any; onRemove: () => void; C: any; isDark: boolean }) {
  const series = item.series || []
  const totalUp = trendState(series, 'total_sales')
  const color = totalUp === 'up' ? (C.danger || '#EF4444') : totalUp === 'down' ? (C.success || '#10B981') : (C.textMuted || '#94A3B8')
  const statusLabel = totalUp === 'up' ? '销量上行' : totalUp === 'down' ? '销量回落' : '数据积累'
  const statusText = totalUp === 'up' ? C.danger : totalUp === 'down' ? C.success : C.textSecondary
  return (
    <View style={[styles.trackCard, { backgroundColor: C.cardBg, borderColor: C.border }]}>
      <View style={styles.trackCardHead}>
        <View style={[styles.trackStatusPill, { backgroundColor: statusText + '14' }]}>
          <Text style={[styles.trackStatusText, { color: statusText }]}>{statusLabel}</Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={onRemove}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[styles.trackRemove, { color: C.danger || '#f44336' }]}>取消</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.trackName, { color: C.textPrimary }]} numberOfLines={1}>{item.direction}</Text>

      <DirectionProgress series={series} color={color} C={C} />

      <View style={styles.trackStats}>
        <View style={styles.trackStatCol}>
          <Text style={[styles.trackStatVal, { color: C.textPrimary }]}>{fmtNum(lastNum(series, 'products'), 'products')}</Text>
          <Text style={[styles.trackStatLabel, { color: C.textMuted }]}>在售</Text>
        </View>
        <View style={styles.trackStatCol}>
          <Text style={[styles.trackStatVal, { color: C.textPrimary }]}>{fmtNum(lastNum(series, 'total_sales'), 'total_sales')}</Text>
          <Text style={[styles.trackStatLabel, { color: C.textMuted }]}>月销</Text>
        </View>
        <View style={styles.trackStatCol}>
          <Text style={[styles.trackStatVal, { color: C.textPrimary }]}>{fmtNum(lastNum(series, 'avg_price'), 'avg_price')}</Text>
          <Text style={[styles.trackStatLabel, { color: C.textMuted }]}>均价</Text>
        </View>
        <View style={styles.trackStatCol}>
          <Text style={[styles.trackStatVal, { color: C.textPrimary }]}>{fmtNum(lastNum(series, 'avg_commission'), 'avg_commission')}</Text>
          <Text style={[styles.trackStatLabel, { color: C.textMuted }]}>佣金</Text>
        </View>
      </View>
    </View>
  )
}

function lastNum(series: any[], key: string): number | null {
  if (!series || series.length === 0) return null
  const v = series[series.length - 1]?.[key]
  return typeof v === 'number' ? v : null
}
