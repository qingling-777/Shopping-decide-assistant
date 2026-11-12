import React, { useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, Image, TouchableOpacity, Linking, Platform, Modal, ScrollView } from 'react-native'
import { radius, spacing, surfaceTints, darkSurfaceTints, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { introAPI } from '../../utils/api'
import { ProductCardItem, ProductIntro } from '../../utils/types'
import { HoverLift, PopInView } from '../Motion'
import { ProvenanceFooter } from './ProvenanceFooter'

export interface HotPickItem {
  id?: string | null
  title: string
  brand?: string | null
  actualPrice?: number | null
  couponPrice?: number | null
  couponConditions?: string
  commissionRate?: number | null
  monthSales?: number | null
  priceText?: string
  commissionText?: string
  salesText?: string
  mainPic?: string
  itemLink?: string
  couponLink?: string
  goodsId?: string
  dtk_id?: string | null
  shopName?: string
  sellPoint?: string
  /** 多榜单共振标记（2026-08-30）：同一商品登上 ≥2 个榜单，resonanceCount≥2，resonanceTabs 列出榜名。 */
  resonanceCount?: number | null
  resonanceTabs?: string[] | null
}

export interface HotPickData {
  title?: string
  summary?: string
  items?: HotPickItem[]
  source?: string
  confidence?: string
  /** 多榜单专题矩阵（2026-08-30 升级）：横向滑动切换专题列 + 每列默认3件/点查看更多展开。 */
  matrix?: {
    tabs?: { type: number; title: string; subtitle: string }[]
    columns?: {
      type: number
      title: string
      subtitle: string
      items: HotPickItem[]
    }[]
    /** 多榜单共振列表（2026-08-30）：跨榜交集、按共振榜数降序的商品代表项，供卡片顶部横幅直接渲染。 */
    resonance?: HotPickItem[]
  }
}

interface Props {
  data: HotPickData
  onSend?: (q: string) => void
  /** 商品介绍弹层关闭后触发，用于刷新免费次数（今日免费剩 N 次实时更新）。 */
  onIntroClosed?: () => void
}

export function HotPickCard({ data, onSend, onIntroClosed }: Props) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const T = isDark ? darkSurfaceTints : surfaceTints
  const items = data.items || []
  // 多榜单专题矩阵（2026-08-30）：有 matrix.columns 走矩阵模式，否则回落单榜
  const columns = data.matrix?.columns || []
  const hasMatrix = columns.length > 0
  // 多榜单共振（2026-08-30）：跨 6 榜交集、按共振榜数降序的商品代表项，供卡片顶部横幅渲染
  const resonance = data.matrix?.resonance || []
  const hasResonance = resonance.length > 0

  // 商品介绍：确认弹窗 → 生成 → 展示 → 关闭刷新免费次数
  const [introTarget, setIntroTarget] = useState<HotPickItem | null>(null) // 待确认的商品
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [introOpen, setIntroOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [intro, setIntro] = useState<ProductIntro | null>(null)
  const [introError, setIntroError] = useState('')

  // 矩阵模式：当前选中的专题列 index + 各列展开状态（每列默认 3 件，点「查看更多」展开）
  const [activeIndex, setActiveIndex] = useState(0)
  const [spreadTypes, setSpreadTypes] = useState<Record<number, boolean>>({})
  const [pagerWidth, setPagerWidth] = useState(0)
  const pagerRef = useRef<ScrollView>(null)
  const PREVIEW_COUNT = 3 // 每个专题列默认展示件数

  const toggleSpread = (type: number) => {
    setSpreadTypes(prev => ({ ...prev, [type]: !prev[type] }))
  }

  // 当前页索引（受 columns 数量钳制，防越界）
  const safeIndex = Math.min(Math.max(activeIndex, 0), Math.max(columns.length - 1, 0))
  // 选中的专题列：优先当前 activeIndex；否则默认第一个列
  const activeCol = columns[safeIndex] || columns[0] || null

  // 左右滑动翻页：横向 paging ScrollView 滚动时按偏移量换算当前页 index，并同步 Tab 高亮。
  // web 端无 momentum 事件，用 onScroll（节流）兼容；native 端 onMomentumScrollEnd 也一并兜底。
  const onPagerScroll = (e: any) => {
    if (!columns.length) return
    const width = e.nativeEvent.layoutMeasurement?.width || pagerWidth || 1
    const x = e.nativeEvent.contentOffset?.x || 0
    const idx = Math.round(x / width)
    setActiveIndex(Math.max(0, Math.min(idx, columns.length - 1)))
  }
  const onPagerMomentumEnd = (e: any) => onPagerScroll(e)

  // 点顶部专题 Tab：平滑滚动到对应页 + 设激活
  const jumpToIndex = (idx: number) => {
    setActiveIndex(idx)
    const x = idx * pagerWidth
    pagerRef.current?.scrollTo({ x, animated: true })
  }

  const openLink = (it: HotPickItem) => {
    // 实时榜接口的 itemLink 是不可用的加密链(item.taobao.com/item.htm?id=<加密串>，点了找不到详情)。
    // couponLink(uland 淘宝领券页，可正常打开看商品)优先；itemLink 仅为兜底。
    const target = it.couponLink || it.itemLink
    if (target) Linking.openURL(target).catch(() => {})
  }

  // 把爆品 item 映射成 introAPI 需要的 ProductCardItem 形状
  const toProduct = (it: HotPickItem): Partial<ProductCardItem> => ({
    id: it.id || it.dtk_id || it.goodsId || '',
    brand: it.brand || '',
    title: it.title,
    image: it.mainPic || '',
    priceText: it.priceText || '',
    commissionRatio: it.commissionRate,
    sales: it.monthSales,
    link: it.couponLink || it.itemLink || '',
    detailUrl: it.couponLink || it.itemLink || '',
    goodsId: it.goodsId,
  })

  const openConfirm = (it: HotPickItem) => {
    setIntroTarget(it)
    setConfirmOpen(true)
  }

  const confirmIntro = async () => {
    if (!introTarget) return
    setConfirmOpen(false)
    setIntroOpen(true)
    setLoading(true)
    setIntroError('')
    setIntro(null)
    try {
      const res = await introAPI.get(toProduct(introTarget))
      setIntro(res.intro)
      // 生成成功（无论命中缓存或新生成）都触发一次额度刷新；命中缓存不扣额，前端仍要同步最新剩余
      onIntroClosed?.()
    } catch (e: any) {
      if (e?.code === 'BALANCE_EMPTY') {
        setIntroError('每日免费介绍次数已用完，请充值后继续（该功能超出免费额度后按 token 计费）')
      } else {
        setIntroError('介绍生成失败，请检查后端')
      }
    } finally {
      setLoading(false)
    }
  }

  const closeIntro = () => {
    setIntroOpen(false)
    setIntro(null)
    onIntroClosed?.() // 关闭后实时刷新免费次数
  }

  // 单件商品行：图 + 标题 + 硬指标(佣金/券后价/月销) + 卖点 + 一单约赚 + 操作
  const renderItemRow = (it: HotPickItem, idx: number) => (
    <View key={idx} style={[S.item, idx > 0 && S.itemGap]}>
      <TouchableOpacity activeOpacity={0.85} onPress={() => openLink(it)} style={S.itemMain}>
        <View style={S.imageWrap}>
          {it.mainPic ? (
            <Image source={{ uri: it.mainPic }} style={S.image} resizeMode="cover" />
          ) : (
            <View style={[S.image, S.imagePh]}>
              <Text style={S.imagePhText}>无图</Text>
            </View>
          )}
          {/* 多榜单共振角标（2026-08-30）：登上 ≥2 榜的商品在图上打角标，醒目提示确定性更高 */}
          {it.resonanceCount && it.resonanceCount >= 2 ? (
            <View style={S.resBadge}>
              <Text style={S.resBadgeText}>多榜共振·{it.resonanceCount}榜</Text>
            </View>
          ) : null}
        </View>
        <View style={S.itemBody}>
          <Text style={S.itemTitle} numberOfLines={2}>{it.title}</Text>
          {/* 共振榜名：让推的人一眼看到这品在哪些榜都上了，便于话术引用 */}
          {it.resonanceCount && it.resonanceCount >= 2 && it.resonanceTabs?.length ? (
            <Text style={S.resTabs} numberOfLines={1}>同时登榜：{it.resonanceTabs.join('·')}</Text>
          ) : null}
          <View style={S.metricsRow}>
            {it.commissionText && it.commissionText !== '—' ? (
              <Text style={[S.metric, S.metricComm]}>佣 {it.commissionText}</Text>
            ) : null}
            {it.priceText && it.priceText !== '—' ? (
              <Text style={S.metricPrice}>券后 {it.priceText}</Text>
            ) : null}
            {it.salesText && it.salesText !== '—' ? (
              <Text style={S.metric}>月销 {it.salesText}</Text>
            ) : null}
          </View>
        </View>
      </TouchableOpacity>
      {it.sellPoint ? (
        <Text style={S.sellPoint} numberOfLines={2}>· {it.sellPoint}</Text>
      ) : null}
      {/* 佣金测算（确定性）：券后价 × 佣金率 = 一单约赚；月销高时附可出单潜量。无佣金率则不渲染 */}
      {it.commissionRate && it.actualPrice != null ? (
        <View style={S.estimateRow}>
          <Text style={S.estimate}>一单约赚 ¥{(it.actualPrice * it.commissionRate / 100).toFixed(2)}</Text>
          {it.monthSales && it.monthSales >= 3000 ? (
            <Text style={S.estimateTag}>月销 {it.salesText || it.monthSales}</Text>
          ) : null}
        </View>
      ) : null}
      <View style={S.lastRow}>
        {it.shopName ? <Text style={S.shop} numberOfLines={1}>{it.shopName}</Text> : null}
        <View style={S.actionRow}>
          <TouchableOpacity activeOpacity={0.8} onPress={() => openConfirm(it)}>
            <Text style={S.introHint}>卖点介绍 ›</Text>
          </TouchableOpacity>
          {(it.couponLink || it.itemLink) ? (
            <TouchableOpacity activeOpacity={0.8} onPress={() => openLink(it)}>
              <Text style={S.openHint}>查看 ›</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  )

  // 渲染一个专题列的商品列表（默认 PREVIEW_COUNT 件，点「查看更多」展开全部）
  // 每个分页列独立控制展开态（按 col.type 索引），互不干扰
  const renderColumnItemsFor = (col: { type: number; items: HotPickItem[] }) => {
    const colItems = col.items || []
    if (!colItems.length) return null
    const spread = spreadTypes[col.type] ?? false
    const shown = spread ? colItems : colItems.slice(0, PREVIEW_COUNT)
    return (
      <>
        {shown.map((it, idx) => renderItemRow(it, idx))}
        {colItems.length > PREVIEW_COUNT ? (
          <TouchableOpacity activeOpacity={0.85} onPress={() => toggleSpread(col.type)} style={S.spreadBtn}>
            <Text style={S.spreadText}>{spread ? '收起 ▲' : `查看更多（还有 ${colItems.length - PREVIEW_COUNT} 件）▼`}</Text>
          </TouchableOpacity>
        ) : null}
      </>
    )
  }

  return (
    <PopInView style={{ marginBottom: spacing.md }}>
    <HoverLift radius={radius.xl} style={[S.card, { backgroundColor: T.hot.bg, borderColor: T.hot.border }]}>
      {/* 头部：爆品标题 + 一句话摘要 */}
      {(data.title || data.summary) ? (
        <View style={S.header}>
          {data.title ? <Text style={S.title}>{data.title}</Text> : null}
          {data.summary ? <Text style={S.summary}>{data.summary}</Text> : null}
        </View>
      ) : null}

      {/* 多榜单共振横幅（2026-08-30）：本批有多少件同时登上多个榜单，确定性更高、优先推 */}
      {hasResonance ? (
        <View style={S.resBanner}>
          <Text style={S.resBannerText}>本批 {resonance.length} 件「多榜共振」：同时登上多个榜单，确定性更高，优先推</Text>
        </View>
      ) : null}

      {/* 爆品列表：矩阵模式（多榜单专题 Tab + 左右滑动的专题分页，每列默认3件/查看更多展开）或单榜兜底 */}
      {hasMatrix ? (
        <>
          {/* 顶部专题 Tab：点击可跳到对应分页；高亮跟随当前滑到/选中的专题 */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.tabsBar} contentContainerStyle={S.tabsContent}>
            {columns.map((col, idx) => {
              const active = activeCol?.type === col.type
              return (
                <TouchableOpacity
                  key={col.type}
                  activeOpacity={0.85}
                  onPress={() => jumpToIndex(idx)}
                  style={[S.tabChip, active && S.tabChipActive]}
                >
                  <Text style={[S.tabText, active && S.tabTextActive]}>{col.title}</Text>
                  <Text style={[S.tabSub, active && S.tabSubActive]} numberOfLines={1}>{col.subtitle}</Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>
          {/* 左右滑动翻页的专题分页：一页一个榜单专题 */}
          <ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onLayout={(e) => setPagerWidth(e.nativeEvent.layout.width)}
            onScroll={onPagerScroll}
            onMomentumScrollEnd={onPagerMomentumEnd}
            scrollEventThrottle={16}
          >
            {columns.map(col => (
              <View key={col.type} style={[S.pagerPage, { width: pagerWidth || '100%' }]}>
                <View style={[S.list, { width: '100%' }]}>
                  {renderColumnItemsFor(col)}
                </View>
              </View>
            ))}
          </ScrollView>
        </>
      ) : (
        <View style={S.list}>
          {items.map((it, i) => renderItemRow(it, i))}
        </View>
      )}

      <ProvenanceFooter source={data.source} confidence={data.confidence} />

      {/* 「确定打开商品卖点介绍」确认弹窗：让用户自行决定要不要消耗免费次数 */}
      <Modal visible={confirmOpen} transparent animationType="fade" onRequestClose={() => setConfirmOpen(false)}>
        <View style={S.overlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setConfirmOpen(false)} />
          <View style={S.confirmBox}>
            <Text style={S.confirmTitle}>打开商品卖点介绍？</Text>
            <Text style={S.confirmDesc}>将生成该商品的详细卖点介绍，消耗每日免费次数（约 0.25 次）；免费额度用完后按余额计费。</Text>
            <View style={S.confirmActions}>
              <TouchableOpacity style={[S.confirmBtn, S.confirmCancel]} activeOpacity={0.8} onPress={() => setConfirmOpen(false)}>
                <Text style={S.confirmCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.confirmBtn, S.confirmOk]} activeOpacity={0.8} onPress={confirmIntro}>
                <Text style={S.confirmOkText}>确定打开</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 商品卖点介绍弹层：展示 summary/卖点/适合人群/用法/价格定位/参考文章 */}
      <Modal visible={introOpen} transparent animationType="slide" onRequestClose={closeIntro}>
        <View style={S.overlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={closeIntro} />
          <View style={[S.sheet, S.sheetFloat]}>
            <View style={S.sheetHead}>
              <Text style={S.sheetTitle}>商品卖点介绍</Text>
              <TouchableOpacity onPress={closeIntro} activeOpacity={0.7}>
                <Text style={S.sheetClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={S.sheetBody} showsVerticalScrollIndicator={false}>
              {(introTarget?.mainPic) ? (
                <Image source={{ uri: introTarget.mainPic }} style={S.detailImage} resizeMode="cover" />
              ) : null}
              <View style={S.detailHead}>
                {introTarget?.brand ? <Text style={S.brand}>{introTarget.brand}</Text> : null}
                <Text style={S.detailTitle}>{introTarget?.title}</Text>
              </View>
              <View style={S.metaRow}>
                {introTarget?.priceText ? <Text style={[S.chip, S.chipPrice]}>{introTarget.priceText}</Text> : null}
                {introTarget?.commissionRate != null ? <Text style={[S.chip, S.chipRate]}>佣 {introTarget.commissionText || `${introTarget.commissionRate}%`}</Text> : null}
                {introTarget?.monthSales != null ? <Text style={[S.chip, S.chipSales]}>月销 {introTarget.salesText || introTarget.monthSales}</Text> : null}
              </View>

              <View style={S.introWrap}>
                {loading ? <Text style={S.loadingText}>AI 生成介绍中…</Text> : null}
                {introError ? <Text style={S.emptySub}>{introError}</Text> : null}
                {!loading && !introError && intro ? (
                  <View style={S.introBody}>
                    {intro.summary ? <Text style={S.introSummary}>{intro.summary}</Text> : null}
                    {intro.highlights && intro.highlights.length > 0 ? (
                      <View style={S.introBlock}>
                        <Text style={S.introLabel}>卖点</Text>
                        <View style={S.tagRow}>
                          {intro.highlights.map((h, i) => (
                            <Text key={i} style={S.tag}>{h}</Text>
                          ))}
                        </View>
                      </View>
                    ) : null}
                    {intro.suitableFor && intro.suitableFor.length > 0 ? (
                      <View style={S.introBlock}>
                        <Text style={S.introLabel}>适合谁</Text>
                        {intro.suitableFor.map((s, i) => (
                          <Text key={i} style={S.introBullet}>· {s}</Text>
                        ))}
                      </View>
                    ) : null}
                    {intro.howToUse ? (
                      <View style={S.introBlock}>
                        <Text style={S.introLabel}>用法</Text>
                        <Text style={S.introText}>{intro.howToUse}</Text>
                      </View>
                    ) : null}
                    {intro.pricePositioning ? (
                      <View style={S.introBlock}>
                        <Text style={S.introLabel}>价格定位</Text>
                        <Text style={S.introText}>{intro.pricePositioning}</Text>
                      </View>
                    ) : null}
                    {intro.sources && intro.sources.length > 0 ? (
                      <View style={S.introBlock}>
                        <Text style={S.introLabel}>参考文章（联网测评）</Text>
                        {intro.sources.map((s, i) => (
                          <TouchableOpacity key={i} activeOpacity={0.7} onPress={() => s.link && Linking.openURL(s.link).catch(() => {})}>
                            <Text style={S.introLink} numberOfLines={1}>· {s.title || s.link}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View style={{ height: 24 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </HoverLift>
    </PopInView>
  )
}

type ColorSet = {
  textPrimary: string
  textSecondary: string
  textMuted: string
  pageBg: string
  border: string
  borderLight: string
  primary: string
  success: string
  warning: string
  danger: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.xl,
    marginBottom: spacing.md,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(16px) saturate(130%)',
        WebkitBackdropFilter: 'blur(16px) saturate(130%)',
        boxShadow: isDark ? shadows.cardDark : shadows.card,
      },
      default: {
        shadowColor: C.textPrimary,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: isDark ? 0.40 : 0.10,
        shadowRadius: 20,
        elevation: 6,
      },
    }),
    ':hover': { transform: [{ translateY: -2 }], borderColor: C.primary + '40' },
  } as any,
  header: { marginBottom: spacing.md },
  // 多榜单共振横幅（2026-08-30）：卡片顶部高亮条，提示本批共振件数
  resBanner: {
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.warning + '55',
    backgroundColor: C.warning + '12',
  },
  resBannerText: { fontSize: 12, fontWeight: '700', color: C.warning, lineHeight: 17 },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: C.textPrimary,
    lineHeight: 26,
    marginBottom: 4,
  },
  summary: {
    fontSize: 13,
    color: C.textSecondary,
    lineHeight: 19,
  },
  list: { gap: 0 },
  // ── 多榜单专题 Tab 栏（矩阵模式）──
  tabsBar: { marginBottom: spacing.md, marginHorizontal: -spacing.xl },
  tabsContent: { paddingHorizontal: spacing.xl, gap: spacing.sm },
  // 左右滑动翻页的分页容器（一页一个专题列）
  pagerPage: { flexDirection: 'column' },
  tabChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.borderLight,
    backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.6)',
    minWidth: 92,
  },
  tabChipActive: {
    backgroundColor: C.primary + '14',
    borderColor: C.primary,
  },
  tabText: { fontSize: 13, fontWeight: '700', color: C.textSecondary },
  tabTextActive: { color: C.primary },
  tabSub: { fontSize: 10, color: C.textMuted, marginTop: 2 },
  tabSubActive: { color: C.primary + '99' },
  // ── 查看更多 / 收起按钮 ──
  spreadBtn: {
    marginTop: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.primary + '44',
    backgroundColor: C.primary + '0A',
  },
  spreadText: { fontSize: 12, fontWeight: '700', color: C.primary },
  item: {
    backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.82)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.borderLight,
    padding: spacing.sm,
  },
  itemGap: { marginTop: spacing.sm },
  itemMain: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  image: { width: 78, height: 78, borderRadius: radius.md, backgroundColor: C.pageBg },
  imagePh: { alignItems: 'center', justifyContent: 'center' },
  imagePhText: { fontSize: 11, color: C.textMuted },
  // 多榜单共振角标（2026-08-30）：图左上角覆盖「多榜共振·N榜」小药丸
  imageWrap: { position: 'relative', width: 78, height: 78, borderRadius: radius.md, overflow: 'hidden' },
  resBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: C.warning,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  resBadgeText: { fontSize: 9, fontWeight: '800', color: '#ffffff', lineHeight: 12 },
  resTabs: {
    fontSize: 10,
    fontWeight: '600',
    color: C.warning,
    marginTop: 3,
    lineHeight: 14,
  },
  itemBody: { flex: 1, justifyContent: 'center' },
  itemTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textPrimary,
    lineHeight: 18,
    marginBottom: 4,
  },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  metric: {
    fontSize: 11,
    fontWeight: '600',
    color: C.textSecondary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: C.pageBg,
    overflow: 'hidden',
  },
  metricComm: { color: C.success, backgroundColor: C.success + '12' },
  metricPrice: {
    fontSize: 11,
    fontWeight: '800',
    color: C.primary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: C.primary + '12',
    overflow: 'hidden',
  },
  sellPoint: {
    fontSize: 11,
    color: C.textSecondary,
    lineHeight: 16,
    marginTop: 6,
    marginLeft: 86,
  },
  estimateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
    marginLeft: 86,
  },
  estimate: {
    fontSize: 12,
    fontWeight: '700',
    color: C.success,
  },
  estimateTag: {
    fontSize: 11,
    fontWeight: '600',
    color: C.textSecondary,
    backgroundColor: C.pageBg,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  shop: { fontSize: 10, color: C.textMuted, marginTop: 2 },
  lastRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginLeft: 86 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  introHint: { fontSize: 11, color: C.success, fontWeight: '700', marginTop: 2 },
  openHint: { fontSize: 11, color: C.primary, fontWeight: '600', marginTop: 2 },

  // ── 商品介绍确认弹窗（Modal）──
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  confirmBox: {
    width: '86%',
    maxWidth: 380,
    backgroundColor: isDark ? '#1c1c1f' : '#ffffff',
    borderRadius: radius.xl,
    padding: spacing.xl,
    ...Platform.select({
      web: { boxShadow: shadows.card },
      default: { elevation: 12 },
    }),
  },
  confirmTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: spacing.sm,
  },
  confirmDesc: {
    fontSize: 13,
    color: C.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  confirmActions: { flexDirection: 'row', gap: spacing.md },
  confirmBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  confirmCancel: { backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.borderLight },
  confirmCancelText: { fontSize: 14, fontWeight: '600', color: C.textSecondary },
  confirmOk: { backgroundColor: C.primary },
  confirmOkText: { fontSize: 14, fontWeight: '700', color: '#ffffff' },

  // ── 商品卖点介绍弹层（Modal）──
  sheet: {
    width: '92%',
    maxWidth: 460,
    maxHeight: '82%',
    backgroundColor: isDark ? '#1c1c1f' : '#ffffff',
    borderRadius: radius.xl,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: shadows.card },
      default: { elevation: 12 },
    }),
  },
  sheetFloat: {},
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: C.borderLight,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: C.textPrimary },
  sheetClose: { fontSize: 18, color: C.textMuted, paddingHorizontal: 6 },
  sheetBody: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  detailImage: {
    width: '100%',
    height: 180,
    borderRadius: radius.lg,
    marginTop: spacing.md,
    backgroundColor: C.pageBg,
  },
  detailHead: { marginTop: spacing.md },
  brand: { fontSize: 12, fontWeight: '600', color: C.primary, marginBottom: 2 },
  detailTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary, lineHeight: 24 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: spacing.sm },
  chip: {
    fontSize: 11,
    fontWeight: '600',
    color: C.textSecondary,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: C.pageBg,
    overflow: 'hidden',
  },
  chipPrice: { color: C.primary, backgroundColor: C.primary + '12' },
  chipRate: { color: C.success, backgroundColor: C.success + '12' },
  chipSales: { color: C.textSecondary, backgroundColor: C.pageBg },
  introWrap: { marginTop: spacing.md },
  loadingText: { fontSize: 13, color: C.textSecondary },
  emptySub: { fontSize: 13, color: C.danger, lineHeight: 20 },
  introBody: {},
  introSummary: {
    fontSize: 14,
    lineHeight: 22,
    color: C.textPrimary,
    marginBottom: spacing.sm,
  },
  introBlock: { marginTop: spacing.md },
  introLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: C.textSecondary,
    marginBottom: 6,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    fontSize: 12,
    fontWeight: '600',
    color: C.primary,
    backgroundColor: C.primary + '12',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden',
  },
  introBullet: { fontSize: 13, color: C.textPrimary, lineHeight: 21 },
  introText: { fontSize: 13, color: C.textPrimary, lineHeight: 21 },
  introLink: { fontSize: 12, color: C.primary, lineHeight: 20 },
  })
}
