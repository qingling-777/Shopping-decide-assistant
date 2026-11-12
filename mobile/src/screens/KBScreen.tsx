import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native'
import { colors, dark, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { ScreenFrame } from '../components/ScreenFrame'
import { HoverLift } from '../components/Motion'
import { KnowledgeList } from '../components/KnowledgeList'
import { knowledgeAPI } from '../utils/api'

type Item = { t: string; tag: string; src: string; vip: boolean; d: string; read: number }

const DATA: Item[] = [
  { t: '敏感肌修护成分库：神经酰胺/积雪草/依克多因功效比对', tag: '成分库', src: '联网测评', vip: false, d: '基于近 90 天文献与备案数据，梳理 8 类修护成分的机制、配伍禁忌与宣称边界。', read: 3 },
  { t: '2026 上半年全品类带货白皮书（抖音/快手/小红书）', tag: '行业报告', src: '行业研报', vip: true, d: '会员专享深度报告：三平台品类增速、达人结构、退货率与价格带迁移全量拆解。', read: 6 },
  { t: '竞品测评：3 款爆款修护精华的配方与卖点拆解', tag: '竞品测评', src: '联网测评', vip: false, d: '横向对比主成分浓度、质地与内容话术，提炼可复用的爆款脚本结构。', read: 4 },
  { t: '小红书「分肤质修护」声量周报（环比 +42%）', tag: '平台榜单', src: '平台数据', vip: false, d: '搜索词增速、种草笔记结构与高转化封面共性，附本周 TOP20 词表。', read: 2 },
  { t: '「医研」宣称合规边界提示（2026 修订）', tag: '法规合规', src: '合规库', vip: false, d: '汇总近期处罚案例，给出素材可说/不可说的红线清单，降低违规风险。', read: 5 },
  { t: '舒缓喷雾品类竞品价格带与佣金分布', tag: '竞品测评', src: '联盟数据', vip: true, d: '会员专享：实时联盟商品价/佣/销聚合，按品类导出候选清单。', read: 4 },
]

const CATS = ['全部', '成分库', '行业报告', '竞品测评', '平台榜单', '法规合规']

export function KBScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [cat, setCat] = useState('全部')
  const [q, setQ] = useState('')
  const list = DATA.filter((d) => (cat === '全部' || d.tag === cat) && (q.trim() === '' || d.t.includes(q.trim())))

  // 我的资料（真知识库）：打开时拉取，喂资料/删除后刷新
  const [kbItems, setKbItems] = useState<any[]>([])
  const [kbLoading, setKbLoading] = useState(false)
  const loadKb = useCallback(async () => {
    setKbLoading(true)
    try {
      const r = await knowledgeAPI.list()
      setKbItems(r?.items || [])
    } catch {
      setKbItems([])
    } finally {
      setKbLoading(false)
    }
  }, [])
  useEffect(() => {
    if (visible) loadKb()
  }, [visible, loadKb])

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="知识库">
      <View style={[styles.search, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <Text style={{ color: C.textMuted, fontSize: 14 }}>⌕</Text>
        <TextInput
          style={[styles.searchInput, { color: C.textPrimary }]}
          placeholder="搜成分 / 报告 / 竞品测评…"
          placeholderTextColor={C.textMuted}
          value={q}
          onChangeText={setQ}
        />
      </View>

      <ScrollViewHorizontal>
        {CATS.map((c) => (
          <TouchableOpacity
            key={c}
            activeOpacity={0.8}
            onPress={() => setCat(c)}
            style={[styles.chip, { backgroundColor: C.cardBg, borderColor: C.border }, cat === c && { backgroundColor: C.primary, borderColor: C.primary }]}
          >
            <Text style={[styles.chipText, { color: C.textSecondary }, cat === c && { color: '#fff' }]}>{c}</Text>
          </TouchableOpacity>
        ))}
      </ScrollViewHorizontal>

      {/* 我的资料：喂进知识库的真数据（AI 提炼 + 有效期管理） */}
      <View style={[styles.mineWrap, { borderColor: C.border }]}>
        <KnowledgeList items={kbItems} loading={kbLoading} onReload={loadKb} />
      </View>

      <Text style={[styles.kicker, { color: C.textMuted }]}>今日更新 · {DATA.length} 篇</Text>

      {list.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <Text style={[styles.emptyText, { color: C.textMuted }]}>没有匹配的资料，换个关键词或分类试试</Text>
        </View>
      ) : (
        list.map((d, i) => (
          <HoverLift key={i} style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
            <View style={styles.cardHead}>
              <Text style={[styles.cardTitle, { color: C.textPrimary }]} numberOfLines={2}>{d.t}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.tag, { color: '#fff', backgroundColor: C.primary }]}>{d.tag}</Text>
                {d.vip ? <Text style={[styles.vip, { color: C.goldDeep, backgroundColor: C.goldBg }]}>会员专享</Text> : null}
              </View>
            </View>
            <Text style={[styles.meta, { color: C.textMuted }]}>{d.src} · 约 {d.read} 分钟读</Text>
            <Text style={[styles.desc, { color: C.textSecondary }]} numberOfLines={3}>{d.d}</Text>
            <View style={styles.cardFoot}>
              <Text style={[styles.src, { color: C.textMuted }]}>来源 · {d.src}</Text>
              <Text style={[styles.open, { color: C.primary }]}>查看 ›</Text>
            </View>
          </HoverLift>
        ))
      )}
    </ScreenFrame>
  )
}

// 轻量横向滚动：用 ScrollView horizontal
function ScrollViewHorizontal({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow} style={styles.chipsScroll}>
      {children}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  mineWrap: { borderRadius: radius.lg, borderWidth: 1, padding: 14, marginBottom: 16, backgroundColor: 'rgba(255,255,255,0.50)', borderColor: 'rgba(255,255,255,0.35)', ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 14, backgroundColor: 'rgba(255,255,255,0.65)', borderColor: 'rgba(255,255,255,0.40)', ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 4px 16px rgba(59,130,246,0.10)' }, default: { elevation: 3 } }) },
  searchInput: { flex: 1, fontSize: 16, outlineStyle: 'none' as any }, // ≥16 防 iOS 聚焦智能缩放；RN-Web 去掉聚焦黄圈
  chipsScroll: { marginBottom: 14 },
  chipsRow: { gap: 8, paddingRight: 8 },
  chip: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 999, borderWidth: 1, backgroundColor: 'rgba(255,255,255,0.60)', borderColor: 'rgba(255,255,255,0.40)' },
  chipText: { fontSize: 12, fontWeight: '600' },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 6, marginHorizontal: 2, marginBottom: 10 },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 14, marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.35)', ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  cardTitle: { fontSize: 15, fontWeight: '700', lineHeight: 21, flex: 1 },
  tag: { fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  vip: { fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, marginLeft: 6 },
  meta: { fontSize: 12, marginBottom: 8 },
  desc: { fontSize: 13, lineHeight: 20 },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  src: { fontSize: 11 },
  open: { fontSize: 12, fontWeight: '700' },
  empty: { borderRadius: radius.lg, borderWidth: 1, padding: 30, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.50)', borderColor: 'rgba(255,255,255,0.35)', ...Platform.select({ web: { backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }, default: { elevation: 2 } }) },
  emptyText: { fontSize: 13 },
})
