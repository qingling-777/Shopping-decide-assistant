import React, { useMemo, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { colors, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { SkeletonText } from './Skeleton'
import { knowledgeAPI } from '../utils/api'

type KnowledgeItem = {
  id: string
  question: string
  source_label: string
  created_at: string
  expire_at: string
  ttl_days: number
  status: string
}

export function KnowledgeList({
  items,
  loading,
  onReload,
}: {
  items: KnowledgeItem[]
  loading: boolean
  onReload: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [showForm, setShowForm] = useState(false)
  const [text, setText] = useState('')
  const [sourceLabel, setSourceLabel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const handleAdd = async () => {
    const t = text.trim()
    if (!t) {
      setErr('请先粘贴资料内容：把你的品类笔记 / 测评文字稿 / 博主文章正文贴进来即可')
      return
    }
    setSubmitting(true)
    try {
      const r = await knowledgeAPI.ingestText(t, sourceLabel.trim() || undefined)
      if (r.status === 'skip') {
        setErr('未提炼到有效知识：' + (r.reason || '内容信息量不足，换更具体的内容再试'))
      } else {
        setErr(null)
        setText('')
        setSourceLabel('')
        setShowForm(false)
        onReload()
      }
    } catch (e: any) {
      setErr('保存失败：' + (e?.message || '请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    setBusyId(id)
    try {
      await knowledgeAPI.remove(id)
      onReload()
    } catch (e: any) {
      setErr('删除失败：' + (e?.message || '请稍后重试'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm }}>
        <Text style={{ fontSize: 13, color: C.textMuted }}>
          你喂的品类资料会进入选品顾问的知识库，回答时优先参考
        </Text>
        <TouchableOpacity
          style={{ backgroundColor: C.primary, borderRadius: radius.md, paddingVertical: 6, paddingHorizontal: 12 }}
          activeOpacity={0.85}
          onPress={() => setShowForm((v) => !v)}
        >
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{showForm ? '收起' : '新增资料'}</Text>
        </TouchableOpacity>
      </View>

      {showForm ? (
        <View style={{ backgroundColor: C.cardBg, borderRadius: radius.lg, borderWidth: 1, borderColor: C.border, padding: spacing.md, marginBottom: spacing.md }}>
          <Text style={{ fontSize: 13, color: C.textPrimary, fontWeight: '600', marginBottom: 6 }}>资料内容</Text>
          <TextInput
            style={{ backgroundColor: C.pageBg, borderRadius: radius.md, borderWidth: 1, borderColor: C.border, padding: spacing.sm, fontSize: 14, color: C.textPrimary, minHeight: 120, textAlignVertical: 'top', outlineStyle: 'none' as any }}
            placeholder="粘贴品类笔记 / 测评文字稿 / 博主文章正文…"
            placeholderTextColor={C.textMuted}
            value={text}
            onChangeText={(v) => { setText(v); if (err) setErr(null) }}
            multiline
          />
          <Text style={{ fontSize: 13, color: C.textPrimary, fontWeight: '600', marginBottom: 6, marginTop: spacing.sm }}>来源标签（选填）</Text>
          <TextInput
            style={{ backgroundColor: C.pageBg, borderRadius: radius.md, borderWidth: 1, borderColor: C.border, padding: spacing.sm, fontSize: 14, color: C.textPrimary, outlineStyle: 'none' as any }}
            placeholder="如：某博主防晒测评、内部选品笔记"
            placeholderTextColor={C.textMuted}
            value={sourceLabel}
            onChangeText={(v) => { setSourceLabel(v); if (err) setErr(null) }}
          />
          {err ? <Text style={styles.errText}>{err}</Text> : null}
          <TouchableOpacity
            style={[styles.addBtn, submitting && { opacity: 0.6 }]}
            activeOpacity={0.85}
            disabled={submitting}
            onPress={handleAdd}
          >
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.addBtnText}>保存并提炼</Text>}
          </TouchableOpacity>
          <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 8, lineHeight: 16 }}>
            保存后会用 AI 从内容里提炼出可检索的知识点（品牌/成分/打法/避坑），自动进入知识库。
          </Text>
        </View>
      ) : null}

      {loading ? (
        <View style={{ paddingVertical: spacing.md }}>
          <SkeletonText lines={3} />
        </View>
      ) : items.length === 0 ? (
        <View style={{ paddingVertical: spacing.xl, alignItems: 'center' }}>
          <Text style={{ fontSize: 13, color: C.textMuted }}>还没有资料，点「新增资料」喂第一条品类笔记</Text>
        </View>
      ) : (
        <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
          {items.map((it) => (
            <View key={it.id} style={styles.item}>
              <View style={{ flex: 1, paddingRight: spacing.sm }}>
                <Text style={{ fontSize: 14, color: C.textPrimary, fontWeight: '600' }} numberOfLines={2}>
                  {it.question || '(未命名知识点)'}
                </Text>
                <Text style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                  {it.source_label ? `来源：${it.source_label} · ` : ''}
                  {it.created_at} 入库 · 有效期至 {it.expire_at}
                  {it.status === 'expired' ? '（已过期）' : ''}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.delBtn}
                activeOpacity={0.8}
                disabled={busyId === it.id}
                onPress={() => handleDelete(it.id)}
              >
                {busyId === it.id ? <ActivityIndicator color={C.textSecondary} /> : <Text style={styles.delBtnText}>删除</Text>}
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  addBtn: { backgroundColor: C.primary, borderRadius: radius.lg, paddingVertical: spacing.sm + 2, alignItems: 'center', marginTop: spacing.md },
  addBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  errText: { color: '#e5484d', fontSize: 12, lineHeight: 17, marginTop: 8, marginBottom: 2 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  delBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: C.border },
  delBtnText: { color: C.textSecondary, fontSize: 13, fontWeight: '600' },
})
}
