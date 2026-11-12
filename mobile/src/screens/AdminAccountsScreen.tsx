import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native'
import { ScreenFrame } from '../components/ScreenFrame'
import { colors, dark, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { billingAPI } from '../utils/api'

const FREQ_FILTERS: { key: number; label: string }[] = [
  { key: 0, label: '全部' },
  { key: 10, label: '≥10 次' },
  { key: 30, label: '≥30 次' },
  { key: 100, label: '≥100 次' },
]

function fmtTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function subjectLabel(subject: string): { tag: string; color: string; bg: string } {
  if (subject.startsWith('user:')) return { tag: '登录用户', color: colors.primary, bg: colors.primary + '12' }
  if (subject.startsWith('device:')) return { tag: '匿名设备', color: '#D97706', bg: '#F59E0B' + '12' }
  return { tag: subject, color: colors.textSecondary, bg: 'rgba(0,0,0,0.05)' }
}

// 模型展示名归一化：剥掉 Pro/ 等档位前缀与供应商前缀，只留核心名
function modelName(key: string): string {
  let name = key
    .replace(/^Pro\//, '')
    .replace(/^deepseek-ai\//, '')
    .replace(/^zai-org\//, '')
    .replace(/^moonshotai\//, '')
    .replace(/^Qwen\//, '')
    .replace(/-35B-A3B$/i, '')
  return name || key
}

function fmtYuan(v: number): string {
  return '¥' + (Math.round(v * 100) / 100).toFixed(2)
}

interface AccountRow {
  subject: string
  kind: 'user' | 'device'
  events: number
  free_events: number
  paid_events: number
  tokens_in: number
  tokens_out: number
  cost_yuan: number
  platform_cost_yuan: number
  last_at: string
  banned: boolean
  account: string
  nickname: string
  is_active: boolean
  is_admin: boolean
  by_model: Array<{ model: string; events: number; tokens_in: number; tokens_out: number; cost_yuan: number }>
}

interface Report {
  total_accounts: number
  user_accounts: number
  device_accounts: number
  banned_accounts: number
  total_events: number
  min_events: number
  accounts: AccountRow[]
}

/**
 * 管理员账户调用报表页（反滥用）：每个计费主体分别调用了多少次模型、按模型拆分、是否封禁，
 * 并提供一键拉黑/解封。仅管理员可见（入口由 ProfileScreen 的 is_admin 分支给出）。
 */
export function AdminAccountsScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [minEvents, setMinEvents] = useState(0)
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [handling, setHandling] = useState<string | null>(null) // 正在拉黑/解封的 subject
  const [confirmSubject, setConfirmSubject] = useState<string | null>(null) // 待确认拉黑的 subject
  const [expandModel, setExpandModel] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await billingAPI.getAccounts(minEvents)
      setReport(res)
    } catch (e: any) {
      setError(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [minEvents])

  useEffect(() => {
    if (visible) load()
  }, [visible, load])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }

  const doBan = async (subject: string) => {
    setHandling(subject)
    setConfirmSubject(null)
    try {
      const res = await billingAPI.banSubject(subject)
      flash(res.newly_banned ? `已拉黑 ${subject}` : `${subject} 已在黑名单`)
      await load()
    } catch (e: any) {
      setError(e?.message || '拉黑失败')
    } finally {
      setHandling(null)
    }
  }

  const doUnban = async (subject: string) => {
    setHandling(subject)
    try {
      await billingAPI.unbanSubject(subject)
      flash(`已解封 ${subject}`)
      await load()
    } catch (e: any) {
      setError(e?.message || '解封失败')
    } finally {
      setHandling(null)
    }
  }

  const toggleModel = (subject: string) => {
    setExpandModel((prev) => {
      const next = new Set(prev)
      if (next.has(subject)) next.delete(subject)
      else next.add(subject)
      return next
    })
  }

  const stats = report
    ? [
        { label: '账户总数', value: report.total_accounts, color: C.textPrimary },
        { label: '登录用户', value: report.user_accounts, color: C.primary },
        { label: '匿名设备', value: report.device_accounts, color: '#D97706' },
        { label: '已封禁', value: report.banned_accounts, color: C.danger },
      ]
    : []

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="账户调用报表（管理员）">
      <View style={styles.header}>
        <Text style={[styles.title, { color: C.textPrimary }]}>账户调用报表</Text>
        <Text style={[styles.subtitle, { color: C.textSecondary }]}>
          {report ? `共 ${report.total_events} 次调用` : '识别异常高频调用，按需拉黑'} · 仅管理员可见
        </Text>
      </View>

      {/* 统计卡 */}
      {report && (
        <View style={styles.statRow}>
          {stats.map((s) => (
            <View key={s.label} style={[styles.statCard, { backgroundColor: C.cardBg, borderColor: C.border }]}>
              <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
              <Text style={[styles.statLabel, { color: C.textSecondary }]}>{s.label}</Text>
            </View>
          ))}
        </View>
      )}

      {/* 高频过滤 */}
      <View style={styles.filters}>
        {FREQ_FILTERS.map((f) => {
          const on = minEvents === f.key
          return (
            <TouchableOpacity
              key={f.key}
              activeOpacity={0.85}
              onPress={() => setMinEvents(f.key)}
              style={[styles.filterChip, { backgroundColor: on ? C.primary : C.cardBg, borderColor: on ? C.primary : C.border }]}
            >
              <Text style={[styles.filterText, { color: on ? '#fff' : C.textSecondary }]}>{f.label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {error ? <Text style={[styles.error, { color: C.danger }]}>{error}</Text> : null}

      {loading && !report ? (
        <Text style={[styles.empty, { color: C.textMuted }]}>加载中…</Text>
      ) : !report || report.accounts.length === 0 ? (
        <Text style={[styles.empty, { color: C.textMuted }]}>暂无调用记录</Text>
      ) : (
        <View style={styles.list}>
          {report.accounts.map((a) => {
            const label = subjectLabel(a.subject)
            const showModel = expandModel.has(a.subject)
            const confirming = confirmSubject === a.subject
            const isHandling = handling === a.subject
            return (
              <View
                key={a.subject}
                style={[
                  styles.card,
                  { backgroundColor: C.cardBg, borderColor: a.banned ? C.danger + '44' : C.border },
                  a.banned && { backgroundColor: isDark ? 'rgba(248,113,113,0.08)' : '#FEF2F2' },
                ]}
              >
                <View style={styles.cardHead}>
                  <View style={[styles.subjectTag, { backgroundColor: label.bg }]}>
                    <Text style={[styles.subjectTagText, { color: label.color }]}>{label.tag}</Text>
                  </View>
                  {a.banned ? (
                    <View style={[styles.statusTag, { backgroundColor: C.danger + '14' }]}>
                      <Text style={[styles.statusTagText, { color: C.danger }]}>已封禁</Text>
                    </View>
                  ) : null}
                  {a.kind === 'user' && a.is_admin ? (
                    <View style={[styles.statusTag, { backgroundColor: C.primary + '14' }]}>
                      <Text style={[styles.statusTagText, { color: C.primary }]}>管理员</Text>
                    </View>
                  ) : null}
                  <Text style={[styles.time, { color: C.textMuted }]}>{fmtTime(a.last_at)}</Text>
                </View>

                {/* 身份行 */}
                <View style={styles.identity}>
                  {a.kind === 'user' ? (
                    <Text style={[styles.identityText, { color: C.textPrimary }]} numberOfLines={1}>
                      {a.nickname || a.account || '(未命名)'}
                      {a.account ? <Text style={[styles.identitySub, { color: C.textMuted }]}> · {a.account}</Text> : null}
                    </Text>
                  ) : (
                    <Text style={[styles.identityText, { color: C.textSecondary }]} numberOfLines={1}>
                      {a.subject}
                    </Text>
                  )}
                </View>

                {/* 调用次数大数字 + 免费/付费拆分 */}
                <View style={styles.metricRow}>
                  <View>
                    <Text style={[styles.bigNum, { color: C.textPrimary }]}>{a.events}</Text>
                    <Text style={[styles.metricSub, { color: C.textSecondary }]}>次调用</Text>
                  </View>
                  <View style={styles.metricSplit}>
                    <Text style={[styles.metricSplitItem, { color: C.textSecondary }]}>
                      免费 <Text style={{ color: C.textPrimary, fontWeight: '700' }}>{a.free_events}</Text> · 付费{' '}
                      <Text style={{ color: C.textPrimary, fontWeight: '700' }}>{a.paid_events}</Text>
                    </Text>
                    <Text style={[styles.metricSplitItem, { color: C.textMuted }]}>
                      成本 {fmtYuan(a.cost_yuan)} · 平台 {fmtYuan(a.platform_cost_yuan)}
                    </Text>
                  </View>
                </View>

                {/* 模型明细展开 */}
                {a.by_model.length > 0 ? (
                  <TouchableOpacity activeOpacity={0.85} onPress={() => toggleModel(a.subject)} style={styles.modelToggle}>
                    <Text style={[styles.modelToggleText, { color: C.primary }]}>
                      {showModel ? '收起模型明细' : `展开模型明细（${a.by_model.length}）`}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {showModel ? (
                  <View style={[styles.modelBox, { borderColor: C.border }]}>
                    {a.by_model.map((m) => (
                      <View key={m.model} style={styles.modelLine}>
                        <Text style={[styles.modelName, { color: C.textPrimary }]}>{modelName(m.model)}</Text>
                        <Text style={[styles.modelEvents, { color: C.textSecondary }]}>{m.events} 次</Text>
                        <Text style={[styles.modelCost, { color: C.textMuted }]}>{fmtYuan(m.cost_yuan)}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}

                {/* 操作：拉黑 / 解封 */}
                {a.banned ? (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    disabled={isHandling}
                    onPress={() => doUnban(a.subject)}
                    style={[styles.unbanBtn, { backgroundColor: C.success, opacity: isHandling ? 0.6 : 1 }]}
                  >
                    <Text style={styles.actionText}>{isHandling ? '处理中…' : '解封'}</Text>
                  </TouchableOpacity>
                ) : confirming ? (
                  <View style={styles.confirmBox}>
                    <Text style={[styles.confirmText, { color: C.textSecondary }]}>确认拉黑该主体（异常调用）？</Text>
                    <View style={styles.confirmBtns}>
                      <TouchableOpacity
                        activeOpacity={0.85}
                        disabled={isHandling}
                        onPress={() => doBan(a.subject)}
                        style={[styles.confirmDanger, { opacity: isHandling ? 0.6 : 1 }]}
                      >
                        <Text style={styles.actionText}>{isHandling ? '处理中…' : '确认拉黑'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity activeOpacity={0.85} disabled={isHandling} onPress={() => setConfirmSubject(null)} style={[styles.confirmCancel, { borderColor: C.border }]}>
                        <Text style={[styles.confirmCancelText, { color: C.textSecondary }]}>取消</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    disabled={isHandling}
                    onPress={() => setConfirmSubject(a.subject)}
                    style={[styles.banBtn, { borderColor: C.danger, opacity: isHandling ? 0.6 : 1 }]}
                  >
                    <Text style={[styles.banText, { color: C.danger }]}>拉黑</Text>
                  </TouchableOpacity>
                )}
              </View>
            )
          })}
        </View>
      )}

      {toast ? (
        <View style={[styles.toast, { backgroundColor: isDark ? '#0D1424' : '#0F172A' }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </ScreenFrame>
  )
}

const styles = StyleSheet.create({
  header: { marginBottom: spacing.md },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 2, letterSpacing: -0.2 },
  subtitle: { fontSize: 12 },
  statRow: { flexDirection: 'row', gap: 8, marginBottom: spacing.md },
  statCard: { flex: 1, borderRadius: radius.lg, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 10, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  statLabel: { fontSize: 11, marginTop: 2 },
  filters: { flexDirection: 'row', gap: 8, marginBottom: spacing.md },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  filterText: { fontSize: 12, fontWeight: '600' },
  error: { fontSize: 12, marginBottom: 10 },
  empty: { fontSize: 13, textAlign: 'center', paddingVertical: 40 },
  list: { gap: spacing.md },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  subjectTag: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 },
  subjectTagText: { fontSize: 11, fontWeight: '700' },
  statusTag: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 },
  statusTagText: { fontSize: 11, fontWeight: '700' },
  time: { fontSize: 11, marginLeft: 'auto' },
  identity: { marginBottom: 10 },
  identityText: { fontSize: 14, fontWeight: '700' },
  identitySub: { fontSize: 12, fontWeight: '400' },
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  bigNum: { fontSize: 28, fontWeight: '800', lineHeight: 32, letterSpacing: -0.5 },
  metricSub: { fontSize: 11, marginTop: -2 },
  metricSplit: { flex: 1, gap: 2 },
  metricSplitItem: { fontSize: 12 },
  modelToggle: { marginTop: 10 },
  modelToggleText: { fontSize: 12, fontWeight: '600' },
  modelBox: { marginTop: 8, borderWidth: 1, borderRadius: radius.md, padding: 8, gap: 4 },
  modelLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modelName: { fontSize: 12, fontWeight: '600', flex: 1 },
  modelEvents: { fontSize: 12, marginRight: 10 },
  modelCost: { fontSize: 12, width: 76, textAlign: 'right' },
  banBtn: { marginTop: 10, paddingVertical: 9, borderRadius: radius.md, alignItems: 'center', borderWidth: 1, backgroundColor: 'transparent' },
  banText: { fontSize: 13, fontWeight: '700' },
  unbanBtn: { marginTop: 10, paddingVertical: 9, borderRadius: radius.md, alignItems: 'center' },
  actionText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  confirmBox: { marginTop: 10 },
  confirmText: { fontSize: 12, marginBottom: 8 },
  confirmBtns: { flexDirection: 'row', gap: 8 },
  confirmDanger: { flex: 1, paddingVertical: 9, borderRadius: radius.md, alignItems: 'center', backgroundColor: '#EF4444' },
  confirmCancel: { flex: 1, paddingVertical: 9, borderRadius: radius.md, alignItems: 'center', borderWidth: 1, backgroundColor: 'transparent' },
  confirmCancelText: { fontSize: 13, fontWeight: '700' },
  toast: { position: 'absolute', bottom: 24, left: 16, right: 16, paddingVertical: 11, paddingHorizontal: 16, borderRadius: radius.md, alignItems: 'center', shadowColor: '#0F172A', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  toastText: { color: '#fff', fontSize: 13, fontWeight: '600' },
})
