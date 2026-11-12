import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, Image, Linking, StyleSheet, ActivityIndicator, RefreshControl, Platform } from 'react-native'
import { ScreenFrame } from '../components/ScreenFrame'
import { colors, dark, radius, spacing, shadows } from '../theme'
import { useTheme } from '../utils/theme'
import { rankingAPI } from '../utils/api'

/** 榜单中心（独立页）：顶部一排榜 Tab，每个榜展示真实联盟在售商品。
 *
 * 数据源 = 后端 GET /products/rankings?type=<rankType>（复用大淘客 get-ranking-list + 归一化）。
 * 每个商品展示图文 + 佣金/券后价/月销 + 一单约赚（券后价×佣金率）。
 * 打开商品：优先跳 couponLink（uland 领券页可正常打开），itemLink 仅兜底。
 */

interface RankTab {
  type: number
  title: string
  subtitle: string
}

interface RankItem {
  title: string
  actualPrice?: number | null
  couponPrice?: number | null
  couponConditions?: string
  commissionRate?: number | null
  monthSales?: number | null
  mainPic?: string
  itemLink?: string
  couponLink?: string
  goodsId?: string
  dtk_id?: string | null
  shopName?: string
  brand?: string
  sell_point?: string
  sellPoint?: string
}

export function RankingScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const S = MemStyles(C, isDark)

  const [tabs, setTabs] = useState<RankTab[]>([])
  const [activeType, setActiveType] = useState(1)
  const [items, setItems] = useState<RankItem[]>([])
  const [rankTitle, setRankTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const tabRef = useRef<ScrollView>(null)

  const load = useCallback(async (type: number) => {
    setLoading(true)
    setError('')
    try {
      const r = await rankingAPI.get(type)
      setTabs(r.tabs || [])
      setActiveType(r.type ?? type)
      setRankTitle(r.rank_title || '')
      setItems(r.items || [])
    } catch (e) {
      setError('榜单加载失败，请稍后重试')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (visible) load(activeType)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const switchTab = useCallback((type: number) => {
    if (type === activeType) return
    setActiveType(type)
    load(type)
  }, [activeType, load])

  const fmtNum = (v: number | null | undefined, kind?: 'sales' | 'price' | 'percent') => {
    if (v == null || isNaN(v)) return '—'
    if (kind === 'sales') return v >= 10000 ? `${(v / 10000).toFixed(1)}万` : `${Math.round(v)}`
    if (kind === 'price') return `¥${Number(v).toFixed(2)}`
    if (kind === 'percent') return `${Number(v).toFixed(1)}%`
    return `${v}`
  }

  const open = (it: RankItem) => {
    const target = it.couponLink || it.itemLink
    if (target) Linking.openURL(target).catch(() => {})
  }

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="榜单中心">
      {/* 顶部说明 */}
      <View style={S.heroRow}>
        <Text style={[S.eyebrow, { color: C.textMuted }]}>RANKING CENTER</Text>
        <Text style={[S.title, { color: C.textPrimary }]}>实时联盟在售榜</Text>
        <Text style={[S.desc, { color: C.textSecondary }]}>按榜单挑品，每件给到佣金、券后价、月销与一单约赚。点商品可跳领券页。</Text>
      </View>

      {/* 榜 Tab（横向滚动）：切换榜单类型 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={S.tabRow}
      >
        {tabs.length > 0
          ? tabs.map((t) => {
            const active = t.type === activeType
            return (
              <TouchableOpacity
                key={t.type}
                activeOpacity={0.8}
                onPress={() => switchTab(t.type)}
                style={[S.tab, active && S.tabActive, { backgroundColor: active ? C.primary : C.cardBg, borderColor: active ? C.primary : C.border }]}
              >
                <Text style={[S.tabText, { color: active ? '#fff' : C.textSecondary }]}>{t.title}</Text>
                <Text style={[S.tabSub, { color: active ? 'rgba(255,255,255,0.80)' : C.textMuted }]}>{t.subtitle}</Text>
              </TouchableOpacity>
            )
          })
          : null}
      </ScrollView>

      {/* 当前榜标题 + 商品列表 */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={S.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(activeType)} tintColor={C.textMuted} />}
        showsVerticalScrollIndicator={false}
      >
        {loading && items.length === 0 ? (
          <View style={S.center}>
            <ActivityIndicator color={C.primary} />
            <Text style={{ color: C.textMuted }}>正在加载「{rankTitle || '榜单'}」…</Text>
          </View>
        ) : error ? (
          <View style={S.center}>
            <Text style={{ color: C.textMuted }}>{error}</Text>
            <TouchableOpacity onPress={() => load(activeType)} style={[S.retry, { backgroundColor: C.primary }]}>
              <Text style={S.retryText}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : items.length === 0 ? (
          <View style={S.center}>
            <Text style={{ color: C.textMuted }}>该榜单暂时没有商品数据</Text>
          </View>
        ) : (
          <>
            {rankTitle ? (
              <View style={S.rankHead}>
                <Text style={[S.rankTitle, { color: C.textPrimary }]}>{rankTitle}</Text>
                <Text style={[S.rankCount, { color: C.textMuted }]}>共 {items.length} 件</Text>
              </View>
            ) : null}
            {items.map((it, i) => (
              <RankItemRow key={i} it={it} C={C} S={S} isDark={isDark} onOpen={() => open(it)} fmtNum={fmtNum} />
            ))}
          </>
        )}
      </ScrollView>
    </ScreenFrame>
  )
}

// 单个榜单商品行（图文 + 硬指标 + 一单约赚），风格对齐 HotPickCard
function RankItemRow({ it, C, S, isDark, onOpen, fmtNum }: any) {
  const sellPoint = (it.sellPoint ?? it.sell_point) || ''
  const hasEstimate = it.commissionRate != null && it.actualPrice != null
  return (
    <View style={[S.item, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.82)', borderColor: C.borderLight }]}>
      <TouchableOpacity activeOpacity={0.85} onPress={onOpen} style={S.itemMain}>
        {it.mainPic ? (
          <Image source={{ uri: it.mainPic }} style={S.image} resizeMode="cover" />
        ) : (
          <View style={[S.image, S.imagePh]}>
            <Text style={S.imagePhText}>无图</Text>
          </View>
        )}
        <View style={S.itemBody}>
          <Text style={[S.itemTitle, { color: C.textPrimary }]} numberOfLines={2}>{it.title}</Text>
          <View style={S.metricsRow}>
            {it.commissionRate != null ? (
              <Text style={[S.metric, { color: C.success, backgroundColor: C.success + '12' }]}>佣 {fmtNum(it.commissionRate, 'percent')}</Text>
            ) : null}
            {it.actualPrice != null ? (
              <Text style={[S.metricPrice, { color: C.primary, backgroundColor: C.primary + '12' }]}>券后 {fmtNum(it.actualPrice, 'price')}</Text>
            ) : null}
            {it.monthSales != null ? (
              <Text style={[S.metric, { color: C.textSecondary, backgroundColor: C.pageBg }]}>月销 {fmtNum(it.monthSales, 'sales')}</Text>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>

      {sellPoint ? (
        <Text style={[S.sellPoint, { color: C.textSecondary }]} numberOfLines={2}>· {sellPoint}</Text>
      ) : null}

      {hasEstimate ? (
        <View style={S.estimateRow}>
          <Text style={[S.estimate, { color: C.success }]}>一单约赚 ¥{(it.actualPrice * it.commissionRate / 100).toFixed(2)}</Text>
          {it.monthSales && it.monthSales >= 3000 ? (
            <Text style={[S.estimateTag, { color: C.textSecondary, backgroundColor: C.pageBg }]}>月销 {fmtNum(it.monthSales, 'sales')}</Text>
          ) : null}
        </View>
      ) : null}

      <View style={S.lastRow}>
        {it.shopName ? <Text style={[S.shop, { color: C.textMuted }]} numberOfLines={1}>{it.shopName}</Text> : null}
        {(it.couponLink || it.itemLink) ? (
          <TouchableOpacity activeOpacity={0.8} onPress={onOpen}>
            <Text style={[S.openHint, { color: C.primary }]}>查看 ›</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  )
}

type ColorSet = {
  textPrimary: string
  textSecondary: string
  textMuted: string
  pageBg: string
  cardBg: string
  border: string
  borderLight: string
  primary: string
  success: string
}

function MemStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
    heroRow: { marginBottom: spacing.md },
    eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 4 },
    title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, marginBottom: 6 },
    desc: { fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
    // ── 榜 Tab ──
    tabRow: { gap: spacing.sm, paddingBottom: spacing.md },
    tab: {
      minWidth: 108,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      alignItems: 'center',
    },
    tabActive: { borderWidth: 1 },
    tabText: { fontSize: 13, fontWeight: '700' },
    tabSub: { fontSize: 10, marginTop: 2 },
    // ── 列表 ──
    list: { paddingBottom: 40 },
    rankHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.sm },
    rankTitle: { fontSize: 17, fontWeight: '800' },
    rankCount: { fontSize: 12 },
    item: {
      borderRadius: radius.lg,
      borderWidth: 1,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    itemMain: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    image: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: C.pageBg },
    imagePh: { alignItems: 'center', justifyContent: 'center' },
    imagePhText: { fontSize: 11, color: C.textMuted },
    itemBody: { flex: 1, justifyContent: 'center' },
    itemTitle: { fontSize: 13, fontWeight: '600', lineHeight: 18, marginBottom: 4 },
    metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
    metric: { fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
    metricPrice: { fontSize: 11, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
    sellPoint: { fontSize: 11, lineHeight: 16, marginTop: 6, marginLeft: 82 },
    estimateRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 4, marginLeft: 82 },
    estimate: { fontSize: 12, fontWeight: '700' },
    estimateTag: { fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
    shop: { fontSize: 10, marginTop: 2 },
    lastRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginLeft: 82 },
    openHint: { fontSize: 11, fontWeight: '600', marginTop: 2 },
    center: { paddingTop: 60, alignItems: 'center', gap: 8 },
    retry: { marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999 },
    retryText: { color: '#fff', fontWeight: '600' },
  })
}
