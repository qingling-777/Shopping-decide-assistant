import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { ScreenFrame } from '../components/ScreenFrame'
import { colors, dark, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { feedbackAPI, AdminFeedbackItem } from '../utils/api'

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'handled', label: '已处理' },
]

function fmtTime(iso?: string | null): string {
  if (!iso) return '—'
  // 后端返回 UTC：2026-08-27T12:00:00Z → 转本地
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

/**
 * 管理员反馈查看页（#8 中性蓝工具区）：按状态过滤 + 列表 + 标记已处理。
 * 仅管理员可见（入口由 ProfileScreen 的 is_admin 分支给出）；复用 FeedbackScreen 中性工具区风格（无金）。
 */
export function AdminFeedbackScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [filter, setFilter] = useState('')
  const [items, setItems] = useState<AdminFeedbackItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [handling, setHandling] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await feedbackAPI.adminList(filter || undefined)
      setItems(res.items || [])
    } catch (e: any) {
      setError(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    if (visible) load()
  }, [visible, load])

  const handle = async (id: string) => {
    setHandling(id)
    try {
      await feedbackAPI.adminHandle(id)
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: 'handled' as const } : it)))
    } catch (e: any) {
      setError(e?.message || '操作失败')
    } finally {
      setHandling(null)
    }
  }

  const filtered = items // items 已按后端 status 过滤（adminList 传了 status），前端再做兜底合并展示

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="反馈查看（管理员）">
      <View style={styles.header}>
        <Text style={[styles.title, { color: C.textPrimary }]}>用户反馈</Text>
        <Text style={[styles.subtitle, { color: C.textSecondary }]}>
          共 {filtered.length} 条 · {items.filter((i) => i.status === 'pending').length} 条待处理
        </Text>
      </View>

      {/* 状态过滤 */}
      <View style={styles.filters}>
        {FILTERS.map((f) => {
          const on = filter === f.key
          return (
            <TouchableOpacity
              key={f.key}
              activeOpacity={0.85}
              onPress={() => setFilter(f.key)}
              style={[styles.filterChip, { backgroundColor: on ? C.primary : C.cardBg, borderColor: on ? C.primary : C.border }]}
            >
              <Text style={[styles.filterText, { color: on ? '#fff' : C.textSecondary }]}>{f.label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>

      {error ? <Text style={[styles.error, { color: C.danger }]}>{error}</Text> : null}

      {loading && items.length === 0 ? (
        <Text style={[styles.empty, { color: C.textMuted }]}>加载中…</Text>
      ) : filtered.length === 0 ? (
        <Text style={[styles.empty, { color: C.textMuted }]}>暂无反馈</Text>
      ) : (
        <View style={styles.list}>
          {filtered.map((it) => (
            <View
              key={it.id}
              style={[styles.card, { backgroundColor: C.cardBg, borderColor: it.status === 'pending' ? `${C.primary}33` : C.border }]}
            >
              <View style={styles.cardHead}>
                <View style={[styles.subjectTag, { backgroundColor: subjectLabel(it.subject).bg }]}>
                  <Text style={[styles.subjectTagText, { color: subjectLabel(it.subject).color }]}>
                    {subjectLabel(it.subject).tag}
                  </Text>
                </View>
                {it.status === 'pending' ? (
                  <View style={[styles.statusTag, { backgroundColor: '#F59E0B' + '12' }]}>
                    <Text style={[styles.statusTagText, { color: '#D97706' }]}>待处理</Text>
                  </View>
                ) : (
                  <View style={[styles.statusTag, { backgroundColor: C.success + '12' }]}>
                    <Text style={[styles.statusTagText, { color: C.success }]}>已处理</Text>
                  </View>
                )}
                <Text style={[styles.time, { color: C.textMuted }]}>{fmtTime(it.created_at)}</Text>
              </View>

              <Text style={[styles.content, { color: C.textPrimary }]}>{it.content}</Text>

              {it.contact ? (
                <Text style={[styles.contact, { color: C.textSecondary }]}>联系方式：{it.contact}</Text>
              ) : null}
              {it.handler ? (
                <Text style={[styles.contact, { color: C.textMuted }]}>
                  处理人：{it.handler} · {fmtTime(it.handled_at)}
                </Text>
              ) : null}

              {it.status === 'pending' ? (
                <TouchableOpacity
                  activeOpacity={0.85}
                  disabled={handling === it.id}
                  onPress={() => handle(it.id)}
                  style={[styles.handleBtn, { backgroundColor: C.primary, opacity: handling === it.id ? 0.6 : 1 }]}
                >
                  <Text style={styles.handleText}>{handling === it.id ? '处理中…' : '标记已处理'}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </ScreenFrame>
  )
}

const styles = StyleSheet.create({
  header: { marginBottom: spacing.md },
  title: { fontSize: 17, fontWeight: '700', marginBottom: 2, letterSpacing: -0.2 },
  subtitle: { fontSize: 12 },
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
  content: { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  contact: { fontSize: 12, marginBottom: 2 },
  handleBtn: { marginTop: 8, paddingVertical: 9, borderRadius: radius.md, alignItems: 'center' },
  handleText: { color: '#fff', fontSize: 13, fontWeight: '700' },
})
