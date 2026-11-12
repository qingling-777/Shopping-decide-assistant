import React, { useEffect, useState, useRef, useMemo } from 'react'
import { View, Text, StyleSheet, Image, TouchableOpacity, ScrollView, Linking, Platform, Modal, TextInput, NativeSyntheticEvent, NativeScrollEvent } from 'react-native'
import { colors, radius, spacing, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { ProductCardItem, ProductIntro } from '../../utils/types'
import { useWorkspaceStore, useFavorites, usePlans, getWorkspaceStore, PlanStatus, PLAN_STATUS_LABEL } from '../../store/workspace'
import { candidateAPI, planAPI, promoAPI, introAPI, monetizeAPI } from '../../utils/api'
import { ExportButtons } from '../ExportButtons'
import { UsageReceipt } from '../UsageReceipt'
import { CountUp } from '../CountUp'
import { HoverLift, PopInView } from '../Motion'
import { formatPromoPlan, safeFileName } from '../../utils/share'

interface Props {
  items: ProductCardItem[]
  userId?: string | null
  /** 顶部 spotlight 用：平滑循环自动滚动；用户手动滑动/拖拽时暂停、停后从停留位置继续。聊天对比卡不传。 */
  autoScroll?: boolean
}

// 轮播参数：与 styles.card 宽度 176、row 的 gap/padding = spacing.sm(8) 对齐
const AUTO_CARD_W = 176
const AUTO_STEP = AUTO_CARD_W + 8 // 单卡跨距 = 卡宽 + 间距
const AUTO_SPEED = 0.04 // px/ms，慢速平滑（≈40px/s，一张卡约 4s）

export function ProductCard({
 items, userId, autoScroll = false }: Props) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const scrollRef = useRef<ScrollView>(null)
  const rafRef = useRef<number | null>(null) // 自动滚动 RAF 句柄
  const lastTsRef = useRef(0) // 上一帧时间戳（算 dt）
  const userScrollingRef = useRef(false) // 用户正在接管（拖拽/滚轮/触控板）
  const currentScrollRef = useRef(0) // 当前滚动位置（自动/用户共用，作为唯一真值）
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draggingRef = useRef(false)
  const dragLastXRef = useRef(0)
  const dragScrollRef = useRef(0)
  const dragNodeRef = useRef<any>(null) // web 拖拽时的真实 DOM 滚动节点
  const maxScrollRef = useRef(0) // web 拖拽时的可滚动上限（node.scrollWidth - clientWidth）

  // 循环回卷点 = 左 padding(8) + n 张卡跨距；内容因复制一份而周期 = loopPoint
  const loopPoint = 8 + items.length * AUTO_STEP

  // 每一帧推进：pos += 速度*dt，超过 loopPoint 则回卷（内容复制一份，回卷无跳变）
  // 用 RAF + currentScrollRef 作为唯一真值，避免 Animated.loop 在 web 上每次迭代把值重置回 0（导致续滚从头开始）
  const tick = (ts: number) => {
    // 用户接管（拖拽/滚轮/滚动条）期间绝不驱动滚动，避免与用户操作打架（即便 stopAuto 有竞态也安全）
    if (userScrollingRef.current || draggingRef.current) {
      rafRef.current = requestAnimationFrame(tick)
      return
    }
    if (lastTsRef.current === 0) lastTsRef.current = ts
    const dt = ts - lastTsRef.current
    lastTsRef.current = ts
    let next = currentScrollRef.current + AUTO_SPEED * dt
    if (next >= loopPoint) next -= loopPoint
    currentScrollRef.current = next
    scrollRef.current?.scrollTo({ x: next, animated: false })
    rafRef.current = requestAnimationFrame(tick)
  }
  const startAuto = () => {
    if (rafRef.current != null) return // 已在跑，避免重复启动
    lastTsRef.current = 0
    rafRef.current = requestAnimationFrame(tick)
  }
  const stopAuto = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }

  // 从用户停留位置继续自动滚动（归一到 [0, loopPoint)，回卷无跳变）
  const resumeAuto = () => {
    if (!userScrollingRef.current) return
    userScrollingRef.current = false
    const norm = ((currentScrollRef.current % loopPoint) + loopPoint) % loopPoint
    currentScrollRef.current = norm
    scrollRef.current?.scrollTo({ x: norm, animated: false })
    startAuto()
  }
  const resetIdle = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(resumeAuto, 1200)
  }

  useEffect(() => {
    if (!autoScroll || items.length === 0) return
    currentScrollRef.current = 0
    scrollRef.current?.scrollTo({ x: 0, animated: false })
    startAuto()
    return () => {
      stopAuto()
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [autoScroll, items])

  // 检测用户滚动（滚轮/滚动条/触控板）：offset 偏离自动位置 → 视为用户接管，暂停并跟随
  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x
    if (draggingRef.current) {
      currentScrollRef.current = x
      return
    }
    if (userScrollingRef.current) {
      currentScrollRef.current = x
      resetIdle()
      return
    }
    // 自动滚动时每帧 scrollTo 会把 offset 带回 currentScrollRef；若偏离>3 说明用户抢走了
    if (Math.abs(x - currentScrollRef.current) > 3) {
      userScrollingRef.current = true
      currentScrollRef.current = x
      stopAuto()
      resetIdle()
    }
  }

  // web 鼠标拖拽平移：用 window 级 pointermove/up 监听（不依赖 pointer capture，光标移出元素也照常触发，最稳）
  const onPointerDown = (e: any) => {
    if (Platform.OS !== 'web') return
    const ne = e.nativeEvent
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    userScrollingRef.current = true
    stopAuto()
    draggingRef.current = true
    dragLastXRef.current = ne.clientX
    dragScrollRef.current = currentScrollRef.current
    const node = (scrollRef.current as any)?.getScrollableNode?.() ?? null
    dragNodeRef.current = node
    if (node) {
      node.style.cursor = 'grabbing'
      node.style.userSelect = 'none' // 拖拽时禁止文字/图片选区抢走事件
      // 记录可滚动上限，用于把拖拽目标钳制在合法范围（避免越界后 currentScrollRef 与真实位置错位）
      maxScrollRef.current = Math.max(0, node.scrollWidth - node.clientWidth)
    }
    const move = (ev: any) => {
      if (!draggingRef.current) return
      ev.preventDefault?.()
      const d = ev.clientX - dragLastXRef.current
      dragLastXRef.current = ev.clientX
      // 钳制到 [0, maxScroll]，currentScrollRef 以"我们计算出的目标值"为真值（不读 node.scrollLeft，react-native-web 下该读数不可靠，会恒为 0 导致续滚回起点）
      let nx = dragScrollRef.current - d
      if (nx < 0) nx = 0
      else if (nx > maxScrollRef.current) nx = maxScrollRef.current
      dragScrollRef.current = nx
      currentScrollRef.current = nx
      scrollRef.current?.scrollTo({ x: nx, animated: false })
    }
    const up = () => {
      if (!draggingRef.current) return
      draggingRef.current = false
      if (node) {
        node.style.cursor = 'grab'
        node.style.userSelect = ''
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragNodeRef.current = null
      resetIdle()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 原生触摸拖拽（手机）：用 RN 的 drag 事件
  const handleScrollBeginDrag = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    userScrollingRef.current = true
    stopAuto()
  }
  const handleScrollEndDrag = () => {
    if (Platform.OS === 'web') return // web 走指针/滚轮检测
    resetIdle()
  }
  const handleMomentumScrollEnd = () => {
    if (Platform.OS === 'web') return
    resetIdle()
  }

  if (!items || items.length === 0) return null

  const openLink = (link?: string) => {
    if (link) Linking.openURL(link).catch(() => {})
  }

  // 点「领券购买」：若该品绑定大淘客 num_iid(goodsId)，按需懒加载带推广位的转链（粉丝下单产生佣金）；
  // 否则回退好单库/详情页链接（无佣金）。授权门控返回空时同样回退。
  const openBuyLink = async (item: ProductCardItem) => {
    if (item.goodsId) {
      try {
        const res = await monetizeAPI.privilegeLink(item.goodsId)
        const d = res && res.data
        const link = d && (d.shortUrl || d.couponClickUrl || d.tpwd || d.itemUrl || d.url)
        if (link) {
          Linking.openURL(link).catch(() => {})
          return
        }
      } catch (e) {
        // 落到回退链接
      }
    }
    if (item.link) Linking.openURL(item.link).catch(() => {})
  }

  // 自动滚动时复制一份实现无缝循环；手动滚动时只渲染一份
  const renderItems = autoScroll ? [...items, ...items] : items

  return (
    <View style={styles.wrap}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        scrollEventThrottle={16}
        style={{ cursor: 'grab' } as any}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        onPointerDown={onPointerDown}
      >
        {renderItems.map((p, i) => (
          <ProductTile key={autoScroll ? `${p.id}__${i}` : p.id} item={p} userId={userId} index={i} onOpen={openLink} onBuy={openBuyLink} />
        ))}
      </ScrollView>
    </View>
  )
}

function ProductTile({

  item,
  userId,
  index = 0,
  onOpen,
  onBuy,
}: {
  item: ProductCardItem
  userId?: string | null
  index?: number
  onOpen: (link?: string) => void
  onBuy: (item: ProductCardItem) => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const [showDetail, setShowDetail] = useState(false)
  const [showImage, setShowImage] = useState(false)
  const [showPlans, setShowPlans] = useState(false)
  const [showComp, setShowComp] = useState(false)
  const [showPromo, setShowPromo] = useState(false)

  return (
    <PopInView delay={index * 50} style={styles.cardWrap}>
    <HoverLift radius={radius.xl2} style={styles.card}>
      {/* 点商品图 → 放大看大图（有图才放大，无图则进详情）；点标题/价格区 → 弹详情卡 */}
      <TouchableOpacity activeOpacity={0.85} onPress={() => (item.image ? setShowImage(true) : setShowDetail(true))} style={styles.imageTouch}>
        {item.image ? (
          <Image source={{ uri: item.image }} style={styles.image} resizeMode="cover" />
        ) : (
          <View style={[styles.image, styles.imagePlaceholder]}>
            <Text style={styles.imagePhText}>无图</Text>
          </View>
        )}
        {/* 推荐理由角标（AI 基于本批候选池的相对优势给出：高佣/高销/低价/综合优选） */}
        {item.pickReason ? (
          <View style={[styles.pickBadge, { pointerEvents: 'none' }]}>
            <Text style={styles.pickBadgeText} numberOfLines={1}>{item.pickReason}</Text>
          </View>
        ) : null}
      </TouchableOpacity>
      <TouchableOpacity activeOpacity={0.85} onPress={() => setShowDetail(true)} style={styles.body}>
        {/* Klarna 商品卡层级：价格(大) → 标题 → 商家 → 佣金/月销"分期"强调行 */}
        <Text style={styles.price}>{item.priceText}</Text>
        <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
        {item.brand ? <Text style={styles.brand} numberOfLines={1}>{item.brand}</Text> : null}
        <View style={styles.splitRow}>
          {item.commissionRatio != null ? (
            <Text style={styles.split}><CountUp value={item.commissionRatio} decimals={0} />% 佣金</Text>
          ) : null}
          {item.sales != null ? <Text style={styles.splitSep}>·</Text> : null}
          {item.sales != null ? (
            <Text style={styles.split}>月销 <CountUp value={item.sales} decimals={0} /></Text>
          ) : null}
          {item.commissionMoney != null ? <Text style={styles.splitSep}>·</Text> : null}
          {item.commissionMoney != null ? (
            <Text style={styles.split}>佣 ¥<CountUp value={item.commissionMoney} decimals={2} /></Text>
          ) : null}
          {item.shopType ? <Text style={styles.shopTag}>{item.shopType}</Text> : null}
        </View>
      </TouchableOpacity>

      <ProductDetailModal
        visible={showDetail}
        product={item}
        userId={userId}
        onClose={() => setShowDetail(false)}
        onOpenLink={onOpen}
        onBuy={onBuy}
        onShowPlans={() => setShowPlans(true)}
        onShowCompetitors={() => setShowComp(true)}
        onShowPromo={() => setShowPromo(true)}
      />

      {/* 子弹层：测品/竞品/方案（必须在详情卡之后渲染：RN Modal 按挂载顺序叠放，后置者在最上层，
          这样在「商品介绍」里点「+测品/查看竞品/生成推广方案」时，子弹层才叠在介绍卡前面而非后面） */}
      {userId ? (
        <PlanPicker
          visible={showPlans}
          userId={userId}
          productId={item.id}
          productTitle={item.title}
          onClose={() => setShowPlans(false)}
        />
      ) : null}

      {userId ? (
        <CompetitorModal visible={showComp} product={item} userId={userId} onClose={() => setShowComp(false)} />
      ) : null}

      {userId ? (
        <PromoModal visible={showPromo} product={item} userId={userId} onClose={() => setShowPromo(false)} />
      ) : null}

      {/* 点商品图放大看大图（全屏灯箱，点背景/✕ 关闭） */}
      <ImageViewerModal visible={showImage} image={item.image} title={item.title} onClose={() => setShowImage(false)} />
    </HoverLift>
    </PopInView>
  )
}

function ImageViewerModal({

  visible,
  image,
  title,
  onClose,
}: {
  visible: boolean
  image?: string
  title?: string
  onClose: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  if (!visible) return null
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.imgViewerBackdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={(e: any) => e.stopPropagation?.()} style={styles.imgViewerInner}>
          {image ? (
            <Image source={{ uri: image }} style={styles.imgViewerImg} resizeMode="contain" />
          ) : (
            <View style={[styles.imgViewerImg, styles.imgViewerPh]}>
              <Text style={styles.imgViewerPhText}>无图</Text>
            </View>
          )}
          {title ? <Text style={styles.imgViewerTitle} numberOfLines={2}>{title}</Text> : null}
        </TouchableOpacity>
        <TouchableOpacity style={styles.imgViewerClose} onPress={onClose} activeOpacity={0.7}>
          <Text style={styles.imgViewerCloseText}>✕</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  )
}

function ProductDetailModal({

  visible,
  product,
  userId,
  onClose,
  onOpenLink,
  onBuy,
  onShowPlans,
  onShowCompetitors,
  onShowPromo,
}: {
  visible: boolean
  product: ProductCardItem
  userId?: string | null
  onClose: () => void
  onOpenLink: (link?: string) => void
  onBuy: (item: ProductCardItem) => void
  onShowPlans: () => void
  onShowCompetitors: () => void
  onShowPromo: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const [loading, setLoading] = useState(false)
  const [intro, setIntro] = useState<ProductIntro | null>(null)
  const [introUsage, setIntroUsage] = useState<any>(null)
  const [error, setError] = useState('')
  // 「确定再生成」确认步骤：打开弹层先展示商品信息与消耗提示，用户点「确定生成」才调 introAPI（避免误触即消耗免费次数）
  const [confirming, setConfirming] = useState(true)
  // 已加进商品池的商品 id（避免每次重开都重复打后端；后端 archive 本身也是按 id 幂等 upsert）
  const archivedRef = useRef<Set<string>>(new Set())

  // 打开时：重置为「未确认」状态；仅做归档闭环，不再立即生成介绍
  useEffect(() => {
    if (!visible) return
    setConfirming(true)
    setLoading(false)
    setError('')
    setIntro(null)
    setIntroUsage(null)
    // 闭环：点开「商品介绍」即把该好单库商品加进「今日机会·商品池」（本地 + 后端候选池，幂等 upsert）
    if (!archivedRef.current.has(product.id)) {
      archivedRef.current.add(product.id)
      getWorkspaceStore().archiveProducts(userId ?? 'guest', [product])
      if (userId) candidateAPI.archive(userId, [product]).catch(() => {})
    }
  }, [visible, product.id])

  // 真正生成介绍：由「确定生成」按钮触发（不再打开即生成）
  const startGenerate = () => {
    if (loading) return
    let cancelled = false
    setLoading(true)
    setError('')
    setIntro(null)
    introAPI
      .get(product)
      .then((res) => {
        if (!cancelled) { setIntro(res.intro); setIntroUsage((res as any).usage) }
      })
      .catch((e: any) => {
        if (!cancelled) {
          // 区分业务态后端错误（余额不足）与真实服务器错误，避免误导用户「请检查后端」
          if (e?.detail?.code === 'BALANCE_EMPTY') {
            setError('余额不足，请充值后使用（该功能按 token 计费，不占每日免费额度）')
          } else {
            setError('介绍生成失败，请检查后端')
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
  }

  const openSource = (link?: string) => {
    if (link) Linking.openURL(link).catch(() => {})
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, styles.sheetFloat]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>商品介绍</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.sheetBody} showsVerticalScrollIndicator={false}>
            {product.image ? (
              <Image source={{ uri: product.image }} style={styles.detailImage} resizeMode="cover" />
            ) : null}
            <View style={styles.detailHead}>
              {product.brand ? <Text style={styles.brand}>{product.brand}</Text> : null}
              <Text style={styles.detailTitle}>{product.title}</Text>
            </View>
            <View style={styles.metaRow}>
              {product.priceText ? <Text style={[styles.chip, styles.chipPrice]}>{product.priceText}</Text> : null}
              {product.couponInfo ? <Text style={[styles.chip, styles.chipCoupon]}>{product.couponInfo}</Text> : null}
              {product.shopType ? <Text style={[styles.chip, styles.chipShop]}>{product.shopType}</Text> : null}
              {product.commissionMoney != null ? (
                <Text style={[styles.chip, styles.chipComm]}>佣¥<CountUp value={product.commissionMoney} decimals={2} /></Text>
              ) : null}
              {product.commissionRatio != null ? (
                <Text style={[styles.chip, styles.chipRate]}><CountUp value={product.commissionRatio} decimals={0} />%</Text>
              ) : null}
              {product.sales != null ? (
                <Text style={[styles.chip, styles.chipSales]}>月销<CountUp value={product.sales} decimals={0} /></Text>
              ) : null}
            </View>

            <View style={styles.introWrap}>
              {/* 确定再生成：打开弹层先展示此提示，用户点「确定生成」才调 introAPI（避免误触即消耗免费次数） */}
              {confirming && !loading && !intro ? (
                <View style={styles.confirmIntroBox}>
                  <Text style={styles.confirmIntroTitle}>确定要生成商品介绍？</Text>
                  <Text style={styles.confirmIntroDesc}>将生成该商品的详细卖点介绍，消耗每日免费次数（约 0.25 次）；免费额度用完后按余额计费。</Text>
                  <View style={styles.confirmIntroActions}>
                    <TouchableOpacity style={[styles.confirmIntroBtn, styles.confirmIntroCancel]} activeOpacity={0.8} onPress={onClose}>
                      <Text style={styles.confirmIntroCancelText}>取消</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.confirmIntroBtn, styles.confirmIntroOk]} activeOpacity={0.8} onPress={() => { setConfirming(false); startGenerate() }}>
                      <Text style={styles.confirmIntroOkText}>确定生成</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
              {loading ? <Text style={styles.loadingText}>AI 生成介绍中…</Text> : null}
              {error ? <Text style={styles.emptySub}>{error}</Text> : null}
              {!confirming && !loading && !error && !intro ? (
                <Text style={styles.emptySub}>介绍生成失败，请重试。</Text>
              ) : null}
              {!loading && !error && intro ? (
                <View style={styles.introBody}>
                  {intro.summary ? <Text style={styles.introSummary}>{intro.summary}</Text> : null}
                  {intro.highlights && intro.highlights.length > 0 ? (
                    <View style={styles.introBlock}>
                      <Text style={styles.introLabel}>卖点</Text>
                      <View style={styles.tagRow}>
                        {intro.highlights.map((h, i) => (
                          <Text key={i} style={styles.tag}>{h}</Text>
                        ))}
                      </View>
                    </View>
                  ) : null}
                  {intro.suitableFor && intro.suitableFor.length > 0 ? (
                    <View style={styles.introBlock}>
                      <Text style={styles.introLabel}>适合谁</Text>
                      {intro.suitableFor.map((s, i) => (
                        <Text key={i} style={styles.introBullet}>· {s}</Text>
                      ))}
                    </View>
                  ) : null}
                  {intro.howToUse ? (
                    <View style={styles.introBlock}>
                      <Text style={styles.introLabel}>用法</Text>
                      <Text style={styles.introText}>{intro.howToUse}</Text>
                    </View>
                  ) : null}
                  {intro.pricePositioning ? (
                    <View style={styles.introBlock}>
                      <Text style={styles.introLabel}>价格定位</Text>
                      <Text style={styles.introText}>{intro.pricePositioning}</Text>
                    </View>
                  ) : null}
                  {intro.sources && intro.sources.length > 0 ? (
                    <View style={styles.introBlock}>
                      <Text style={styles.introLabel}>参考文章（联网测评）</Text>
                      {intro.sources.map((s, i) => (
                        <TouchableOpacity key={i} activeOpacity={0.7} onPress={() => openSource(s.link)}>
                          <Text style={styles.introLink} numberOfLines={1}>· {s.title || s.link}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : null}
                  <UsageReceipt usage={introUsage} />
                </View>
              ) : null}
            </View>

            <View style={styles.buyRow}>
              <TouchableOpacity style={styles.buyBtn} activeOpacity={0.8} onPress={() => onBuy(product)}>
                <Text style={styles.buyBtnText}>购买</Text>
              </TouchableOpacity>
              {product.detailUrl ? (
                <TouchableOpacity style={styles.searchBtn} activeOpacity={0.8} onPress={() => onOpenLink(product.detailUrl)}>
                  <Text style={styles.searchBtnText}>在淘宝搜</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {userId ? (
              <View>
              <View style={styles.actionGrid}>
                <View style={[styles.actionCell, styles.actionCellLeft]}>
                  <FavoriteButton userId={userId} productId={product.id} />
                </View>
                <View style={styles.actionCell}>
                  <TouchableOpacity style={styles.planBtn} activeOpacity={0.8} onPress={onShowPlans}>
                    <Text style={styles.planBtnText}>+ 测品</Text>
                  </TouchableOpacity>
                </View>
                <View style={[styles.actionCell, styles.actionCellLeft, styles.actionCellBottom]}>
                  <TouchableOpacity style={styles.compBtn} activeOpacity={0.8} onPress={onShowCompetitors}>
                    <Text style={styles.compBtnText}>查看竞品</Text>
                  </TouchableOpacity>
                </View>
                <View style={[styles.actionCell, styles.actionCellBottom]}>
                  <TouchableOpacity style={styles.promoBtn} activeOpacity={0.8} onPress={onShowPromo}>
                    <Text style={styles.promoBtnText}>AI生成推广方案</Text>
                  </TouchableOpacity>
                </View>
              </View>
              </View>
            ) : (
              <Text style={styles.loginHint}>登录后收藏 / 测品</Text>
            )}
            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

function FavoriteButton({
 userId, productId }: { userId: string; productId: string }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const favorites = useFavorites(userId)
  const toggleFavorite = useWorkspaceStore((s) => s.toggleFavorite)
  const isFav = favorites.includes(productId)

  return (
    <TouchableOpacity
      style={[styles.favBtn, isFav && styles.favBtnActive]}
      activeOpacity={0.8}
      onPress={() => toggleFavorite(userId, productId)}
    >
      <Text style={[styles.favIcon, isFav && styles.favIconActive]}>{isFav ? '♥' : '♡'}</Text>
      <Text style={[styles.favText, isFav && styles.favTextActive]}>{isFav ? '已收藏' : '收藏'}</Text>
    </TouchableOpacity>
  )
}

function PlanPicker({

  visible,
  userId,
  productId,
  productTitle,
  onClose,
}: {
  visible: boolean
  userId: string
  productId: string
  productTitle: string
  onClose: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const plans = usePlans(userId)
  const addPlan = useWorkspaceStore((s) => s.addPlan)
  const addProductToPlan = useWorkspaceStore((s) => s.addProductToPlan)
  const [newName, setNewName] = useState('')

  const syncPlans = () => {
    const ps = getWorkspaceStore().workspaces[userId]?.plans
    if (ps) planAPI.sync(userId, ps).catch(() => {})
  }

  const handleAdd = (planId: string) => {
    addProductToPlan(userId, planId, productId)
    syncPlans()
    onClose()
  }

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) return
    const plan = addPlan(userId, { name })
    addProductToPlan(userId, plan.id, productId)
    syncPlans()
    setNewName('')
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.pickerSheet, styles.sheetFloat]}>
          <Text style={styles.pickerTitle}>加入测品计划</Text>
          <Text style={styles.pickerSub} numberOfLines={1}>「{productTitle}」</Text>

          <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
            {plans.length === 0 ? (
              <Text style={styles.pickerEmpty}>还没有计划，在下方新建一个吧</Text>
            ) : (
              plans.map((pl) => {
                const inPlan = pl.productIds.includes(productId)
                return (
                  <TouchableOpacity
                    key={pl.id}
                    style={[styles.planRow, inPlan && styles.planRowIn]}
                    activeOpacity={0.8}
                    onPress={() => handleAdd(pl.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.planRowName} numberOfLines={1}>{pl.name}</Text>
                      <Text style={styles.planRowMeta}>
                        {PLAN_STATUS_LABEL[pl.status as PlanStatus]} · {pl.productIds.length} 个商品
                      </Text>
                    </View>
                    <Text style={[styles.planRowTag, inPlan && styles.planRowTagIn]}>
                      {inPlan ? '已在计划' : '加入'}
                    </Text>
                  </TouchableOpacity>
                )
              })
            )}
          </ScrollView>

          <View style={styles.pickerNew}>
            <TextInput
              style={styles.pickerInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="新建计划名称，如：8月抗老测品"
              placeholderTextColor={C.textMuted}
            />
            <TouchableOpacity
              style={[styles.pickerCreateBtn, !newName.trim() && styles.pickerCreateDisabled]}
              activeOpacity={0.8}
              onPress={handleCreate}
              disabled={!newName.trim()}
            >
              <Text style={styles.pickerCreateText}>新建并加入</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={styles.pickerCancel} activeOpacity={0.8} onPress={onClose}>
            <Text style={styles.pickerCancelText}>取消</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}

function CompetitorModal({

  visible,
  product,
  userId,
  onClose,
}: {
  visible: boolean
  product: ProductCardItem
  userId: string
  onClose: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<ProductCardItem[]>([])
  const [error, setError] = useState('')
  const [addedIds, setAddedIds] = useState<string[]>([])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    setError('')
    setItems([])
    setAddedIds([])
    candidateAPI
      .getCompetitors(product.title, product.brand, 10)
      .then((res) => {
        if (!cancelled) setItems(res.items)
      })
      .catch(() => {
        if (!cancelled) setError('竞品加载失败，请检查后端')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [visible, product.title, product.brand])

  const handleAddCandidate = (it: ProductCardItem) => {
    // 闭环：竞品 → 加为候选（进后端商品池）
    candidateAPI.archive(userId, [it]).catch(() => {})
    setAddedIds((prev) => (prev.includes(it.id) ? prev : [...prev, it.id]))
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, styles.sheetFloat]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>同类竞品</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sheetSub} numberOfLines={1}>
            {product.brand} {product.title}
          </Text>
          <ScrollView style={styles.sheetBody} showsVerticalScrollIndicator={false}>
            {loading ? <Text style={styles.loadingText}>加载中…</Text> : null}
            {error ? <Text style={styles.emptySub}>{error}</Text> : null}
            {!loading && !error && items.length === 0 ? (
              <Text style={styles.emptySub}>没找到同类在售商品</Text>
            ) : null}
            {!loading && items.length > 0 ? (
              <View style={styles.compList}>
                {items.map((it) => (
                  <CompetitorItem
                    key={it.id}
                    item={it}
                    added={addedIds.includes(it.id)}
                    onAdd={() => handleAddCandidate(it)}
                  />
                ))}
              </View>
            ) : null}
            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

function CompetitorItem({

  item,
  added,
  onAdd,
}: {
  item: ProductCardItem
  added: boolean
  onAdd: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const openLink = (link?: string) => {
    if (link) Linking.openURL(link).catch(() => {})
  }
  return (
    <View style={styles.compItem}>
      <TouchableOpacity activeOpacity={0.85} onPress={() => openLink(item.link)} style={styles.compTap}>
        {item.image ? (
          <Image source={{ uri: item.image }} style={styles.compImage} resizeMode="cover" />
        ) : (
          <View style={[styles.compImage, styles.imagePlaceholder]}>
            <Text style={styles.imagePhText}>无图</Text>
          </View>
        )}
        <View style={styles.compBody}>
          {item.brand ? <Text style={styles.brand} numberOfLines={1}>{item.brand}</Text> : null}
          <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
          <Text style={styles.price}>{item.priceText}</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.compAddBtn, added && styles.compAddBtnDone]}
        activeOpacity={0.8}
        onPress={onAdd}
        disabled={added}
      >
        <Text style={[styles.compAddText, added && styles.compAddTextDone]}>
          {added ? '已加候选' : '加为候选'}
        </Text>
      </TouchableOpacity>
    </View>
  )
}

function PromoModal({

  visible,
  product,
  userId,
  onClose,
}: {
  visible: boolean
  product: ProductCardItem
  userId?: string | null
  onClose: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<any>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<'plan' | 'standalone' | null>(null)
  const [showPlanPicker, setShowPlanPicker] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<any>(null)
  const [confirmCost, setConfirmCost] = useState(false) // 点击后先提醒按 token 计费，确认才生成（2026-08-25）
  const [planUsage, setPlanUsage] = useState<any>(null)
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]) // 深度思考步骤（流式积累，2026-08-27）
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const plans = usePlans(userId || undefined)
  const attachPromoToPlan = useWorkspaceStore((s) => s.attachPromoToPlan)

  const openSource = (link?: string) => {
    if (link) Linking.openURL(link).catch(() => {})
  }

  useEffect(() => {
    if (!visible) {
      setConfirmCost(false)
      return
    }
    if (!confirmCost) return
    let cancelled = false
    setLoading(true)
    setError('')
    setPlan(null)
    setSaved(null)
    setShowPlanPicker(false)
    setEditing(false)
    setDraft(null)
    setThinkingSteps([])
    setThinkingOpen(false)
    const controller = candidateAPI.generatePromoPlanStream(
      {
        id: product.id,
        productName: product.title,
        brand: product.brand,
        price: product.priceText,
        commissionRatio: product.commissionRatio ?? null,
        competitionLevel: '',
        platform: '',
        sellingPoints: [],
      },
      (ev) => {
        if (cancelled) return
        if (ev.type === 'thinking' && ev.content) {
          setThinkingSteps((prev) => [...prev, ev.content as string])
        } else if (ev.type === 'plan') {
          setPlan((ev as any).plan)
          setPlanUsage((ev as any).usage)
          setLoading(false)
        } else if (ev.type === 'error') {
          setError(ev.content || '推广方案生成失败，请检查后端')
          setLoading(false)
        }
      },
    )
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [visible, confirmCost, product.id])

  const syncPlans = () => {
    if (!userId) return
    const ps = getWorkspaceStore().workspaces[userId]?.plans
    if (ps) planAPI.sync(userId, ps).catch(() => {})
  }

  const handleSaveToPlan = (planId: string) => {
    if (!userId || !plan) return
    attachPromoToPlan(userId, planId, product.id, plan)
    syncPlans()
    setShowPlanPicker(false)
    setSaved('plan')
  }

  const handleSaveStandalone = () => {
    if (!userId || !plan) return
    promoAPI
      .save({
        userId,
        productId: product.id,
        productName: product.title,
        brand: product.brand,
        price: product.priceText,
        plan,
      })
      .then(() => setSaved('standalone'))
      .catch(() => {})
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, styles.sheetFloat]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>AI 生成推广方案</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sheetSub} numberOfLines={1}>
            {product.brand} {product.title}
          </Text>
          <ScrollView style={styles.sheetBody} showsVerticalScrollIndicator={false}>
            {!confirmCost ? (
              <View style={styles.promoBlock}>
                <Text style={styles.promoLabel}>AI 生成推广方案 · 按 token 计费</Text>
                <Text style={styles.promoBody}>
                  AI 将联网核实卖点并生成完整方案（含 C 端主流推广 + B 端主流推广）。按 token 计费（售价 = 平台成本 ×5），
                  单份约 ¥0.03-0.06，同一商品只收一次（结果落库，重复查看不重复扣费）。确认生成？
                </Text>
                <TouchableOpacity
                  style={[styles.promoEditBtn, { marginTop: 10 }]}
                  activeOpacity={0.8}
                  onPress={() => setConfirmCost(true)}
                >
                  <Text style={styles.promoEditBtnText}>确认生成（按 token 计费）</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            {thinkingSteps.length > 0 ? (
              <View style={styles.thinkWrap}>
                <TouchableOpacity style={styles.thinkHeader} activeOpacity={0.8} onPress={() => setThinkingOpen((o) => !o)}>
                  <View style={styles.thinkTitleRow}>
                    <View style={styles.thinkBadge} />
                    <Text style={styles.thinkTitle}>深度思考</Text>
                    {loading ? (
                      <View style={styles.thinkLive}>
                        <View style={styles.thinkLiveDot} />
                        <Text style={styles.thinkLiveText}>分析中</Text>
                      </View>
                    ) : (
                      <Text style={styles.thinkLiveText}>已生成</Text>
                    )}
                  </View>
                  <Text style={styles.thinkToggle}>{thinkingOpen ? '收起 ▲' : `展开 ${thinkingSteps.length} 步 ▼`}</Text>
                </TouchableOpacity>
                <ScrollView
                  style={[styles.thinkScroll, thinkingOpen ? styles.thinkScrollOpen : styles.thinkScrollCollapsed]}
                  contentContainerStyle={styles.thinkScrollContent}
                  showsVerticalScrollIndicator={true}
                >
                  {thinkingSteps.map((step, i) => (
                    <View key={i} style={styles.thinkRow}>
                      <View style={styles.thinkDot} />
                      <Text style={styles.thinkStep}>{step}</Text>
                    </View>
                  ))}
                </ScrollView>
              </View>
            ) : null}
            {loading ? (
              thinkingSteps.length > 0
                ? <Text style={styles.thinkPending}>继续生成中…</Text>
                : <Text style={styles.loadingText}>AI 生成中…</Text>
            ) : null}
            {error ? <Text style={styles.emptySub}>{error}</Text> : null}
            {plan ? (
              editing && draft ? (
                <PromoEditor draft={draft} onChange={setDraft} onDone={() => { setPlan(draft); setEditing(false) }} onCancel={() => { setDraft(plan); setEditing(false) }} />
              ) : (
                <>
                  <PromoContent plan={plan} onOpenSource={openSource} />
                  <UsageReceipt usage={planUsage} />
                </>
              )
            ) : null}
            {plan && !editing && !saved ? (
              <TouchableOpacity style={styles.promoEditBtn} activeOpacity={0.8} onPress={() => { setDraft(plan); setEditing(true) }}>
                <Text style={styles.promoEditBtnText}>编辑文案</Text>
              </TouchableOpacity>
            ) : null}
            {plan && userId ? (
              <View style={styles.promoSaveWrap}>
                {saved ? (
                  <Text style={styles.promoSaved}>
                    {saved === 'plan' ? '已存入测品计划' : '已保存方案'}
                  </Text>
                ) : showPlanPicker ? (
                  <View style={styles.promoPlanPick}>
                    <Text style={styles.promoPlanPickTitle}>选择测品计划</Text>
                    {plans.length === 0 ? (
                      <Text style={styles.pickerEmpty}>还没有计划，先在「+ 测品」里建一个</Text>
                    ) : (
                      plans.map((pl) => {
                        const has = pl.promoPlans && pl.promoPlans[product.id]
                        return (
                          <TouchableOpacity
                            key={pl.id}
                            style={styles.planRow}
                            activeOpacity={0.8}
                            onPress={() => handleSaveToPlan(pl.id)}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={styles.planRowName} numberOfLines={1}>{pl.name}</Text>
                              <Text style={styles.planRowMeta}>
                                {PLAN_STATUS_LABEL[pl.status as PlanStatus]} · {pl.productIds.length} 个商品
                              </Text>
                            </View>
                            <Text style={[styles.planRowTag, has && styles.planRowTagIn]}>
                              {has ? '已存' : '存入'}
                            </Text>
                          </TouchableOpacity>
                        )
                      })
                    )}
                    <TouchableOpacity style={styles.pickerCancel} activeOpacity={0.8} onPress={() => setShowPlanPicker(false)}>
                      <Text style={styles.pickerCancelText}>取消</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={styles.promoSaveRow}>
                    <TouchableOpacity style={styles.promoSaveBtn} activeOpacity={0.8} onPress={() => setShowPlanPicker(true)}>
                      <Text style={styles.promoSaveBtnText}>存入测品计划</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.promoSaveBtn, styles.promoSaveBtnAlt]}
                      activeOpacity={0.8}
                      onPress={handleSaveStandalone}
                    >
                      <Text style={[styles.promoSaveBtnText, styles.promoSaveBtnAltText]}>仅保存方案</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ) : null}
            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

function PromoField({
 label, value }: { label: string; value?: string }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  if (!value) return null
  return (
    <View style={styles.promoBlock}>
      <Text style={styles.promoLabel}>{label}</Text>
      <Text style={styles.promoBody}>{value}</Text>
    </View>
  )
}

export function PromoContent({
 plan, onOpenSource }: { plan: any; onOpenSource?: (link?: string) => void }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const hasNew =
    plan.targetAudience || plan.influencerType || plan.openingHook || plan.commentInteraction ||
    plan.complianceRisk || plan.kpi || plan.abTest || plan.budget
  return (
    <View style={styles.promoWrap}>
      {plan.title ? <Text style={styles.promoTitle}>{plan.title}</Text> : null}

      {plan.introSummary ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>商品介绍（已联网核实）</Text>
          <Text style={styles.promoBody}>{plan.introSummary}</Text>
        </View>
      ) : null}

      {Array.isArray(plan.hooks) && plan.hooks.length > 0 ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>钩子文案</Text>
          {plan.hooks.map((h: string, i: number) => (
            <Text key={i} style={styles.promoBullet}>· {h}</Text>
          ))}
        </View>
      ) : null}

      {plan.body ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>正文</Text>
          <Text style={styles.promoBody}>{plan.body}</Text>
        </View>
      ) : null}

      {Array.isArray(plan.sellingPoints) && plan.sellingPoints.length > 0 ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>卖点话术</Text>
          {plan.sellingPoints.map((s: string, i: number) => (
            <Text key={i} style={styles.promoBullet}>· {s}</Text>
          ))}
        </View>
      ) : null}

      {hasNew ? (
        <View style={styles.promoNewBox}>
          <PromoField label="目标人群画像" value={plan.targetAudience} />
          <PromoField label="适合达人类型" value={plan.influencerType} />
          <PromoField label="开头 3 秒钩子" value={plan.openingHook} />
          <PromoField label="评论区互动引导" value={plan.commentInteraction} />
          <PromoField label="合规风险提示" value={plan.complianceRisk} />
          <PromoField label="核心 KPI" value={plan.kpi} />
          <PromoField label="A/B 测试建议" value={plan.abTest} />
          <PromoField label="预算与排期" value={plan.budget} />
        </View>
      ) : null}

      {Array.isArray(plan.platforms) && plan.platforms.length > 0 ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>平台适配</Text>
          {plan.platforms.map((p: any, i: number) => (
            <View key={i} style={styles.promoPlatform}>
              <Text style={styles.promoPlatformName}>{p.name}</Text>
              <Text style={styles.promoPlatformAngle}>{p.angle}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {plan.cEndPromotion ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>C 端主流推广（个人带货 / 淘客）</Text>
          <Text style={styles.promoBody}>{plan.cEndPromotion.mainstream}</Text>
          {Array.isArray(plan.cEndPromotion.channels) && plan.cEndPromotion.channels.length > 0 ? (
            plan.cEndPromotion.channels.map((c: string, i: number) => (
              <Text key={`c${i}`} style={styles.promoBullet}>· {c}</Text>
            ))
          ) : null}
          {Array.isArray(plan.cEndPromotion.contentAngles) && plan.cEndPromotion.contentAngles.length > 0 ? (
            plan.cEndPromotion.contentAngles.map((a: string, i: number) => (
              <Text key={`ca${i}`} style={styles.promoBullet}>· 内容角度：{a}</Text>
            ))
          ) : null}
          {plan.cEndPromotion.commissionStrategy ? (
            <Text style={styles.promoBody}>{plan.cEndPromotion.commissionStrategy}</Text>
          ) : null}
        </View>
      ) : null}

      {plan.bEndPromotion ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>B 端主流推广（商家 / 招商）</Text>
          <Text style={styles.promoBody}>{plan.bEndPromotion.mainstream}</Text>
          {Array.isArray(plan.bEndPromotion.channels) && plan.bEndPromotion.channels.length > 0 ? (
            plan.bEndPromotion.channels.map((c: string, i: number) => (
              <Text key={`b${i}`} style={styles.promoBullet}>· {c}</Text>
            ))
          ) : null}
          {plan.bEndPromotion.supplyStrategy ? (
            <Text style={styles.promoBody}>{plan.bEndPromotion.supplyStrategy}</Text>
          ) : null}
          {plan.bEndPromotion.distributionStrategy ? (
            <Text style={styles.promoBody}>{plan.bEndPromotion.distributionStrategy}</Text>
          ) : null}
        </View>
      ) : null}

      {plan.schedule ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>发布节奏</Text>
          <Text style={styles.promoBody}>{plan.schedule}</Text>
        </View>
      ) : null}

      {Array.isArray(plan.sources) && plan.sources.length > 0 ? (
        <View style={styles.promoBlock}>
          <Text style={styles.promoLabel}>参考文章（联网测评）</Text>
          {plan.sources.map((s: any, i: number) => (
            <TouchableOpacity
              key={i}
              activeOpacity={0.7}
              onPress={() => onOpenSource && onOpenSource(s.link)}
            >
              <Text style={styles.introLink} numberOfLines={1}>· {s.title || s.link}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      <ExportButtons
        getText={() => formatPromoPlan(plan)}
        filename={`推广方案_${safeFileName(plan.title || '商品')}.md`}
      />
    </View>
  )
}

// 编辑模式：AI 文案可改（标题/钩子/正文/卖点），改完回写 plan 再存方案
function EditList({

  label,
  items,
  onItem,
  onAdd,
  onRemove,
}: {
  label: string
  items: string[]
  onItem: (idx: number, val: string) => void
  onAdd: () => void
  onRemove: (idx: number) => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  return (
    <View style={styles.promoBlock}>
      <Text style={styles.promoLabel}>{label}</Text>
      {items.map((it, i) => (
        <View key={i} style={styles.editRow}>
          <TextInput
            style={styles.editInput}
            value={it}
            onChangeText={(t) => onItem(i, t)}
            placeholder={`${label}${i + 1}`}
            placeholderTextColor={C.textMuted}
          />
          <TouchableOpacity activeOpacity={0.7} onPress={() => onRemove(i)}>
            <Text style={styles.editRemove}>✕</Text>
          </TouchableOpacity>
        </View>
      ))}
      <TouchableOpacity style={styles.editAdd} activeOpacity={0.8} onPress={onAdd}>
        <Text style={styles.editAddText}>+ 加一条</Text>
      </TouchableOpacity>
    </View>
  )
}

function PromoEditor({

  draft,
  onChange,
  onDone,
  onCancel,
}: {
  draft: any
  onChange: (next: any) => void
  onDone: () => void
  onCancel: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const update = (patch: any) => onChange({ ...draft, ...patch })
  const updateArr = (key: string, idx: number, val: string) => {
    const arr = [...(draft[key] || [])]
    arr[idx] = val
    onChange({ ...draft, [key]: arr })
  }
  const addArr = (key: string) => onChange({ ...draft, [key]: [...(draft[key] || []), ''] })
  const removeArr = (key: string, idx: number) =>
    onChange({ ...draft, [key]: (draft[key] || []).filter((_: any, j: number) => j !== idx) })
  return (
    <View style={styles.promoWrap}>
      <TextInput style={styles.editInput} value={draft.title || ''} onChangeText={(t) => update({ title: t })} placeholder="推广标题" placeholderTextColor={C.textMuted} />
      <EditList
        label="钩子文案"
        items={draft.hooks || []}
        onItem={(i, v) => updateArr('hooks', i, v)}
        onAdd={() => addArr('hooks')}
        onRemove={(i) => removeArr('hooks', i)}
      />
      <TextInput
        style={[styles.editInput, styles.editBody]}
        multiline
        value={draft.body || ''}
        onChangeText={(t) => update({ body: t })}
        placeholder="正文文案"
        placeholderTextColor={C.textMuted}
      />
      <EditList
        label="卖点话术"
        items={draft.sellingPoints || []}
        onItem={(i, v) => updateArr('sellingPoints', i, v)}
        onAdd={() => addArr('sellingPoints')}
        onRemove={(i) => removeArr('sellingPoints', i)}
      />
      <View style={styles.promoSaveRow}>
        <TouchableOpacity style={styles.promoSaveBtn} activeOpacity={0.8} onPress={onCancel}>
          <Text style={styles.promoSaveBtnText}>取消</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.promoSaveBtn, styles.promoSaveBtnAlt]} activeOpacity={0.8} onPress={onDone}>
          <Text style={styles.promoSaveBtnText}>完成编辑</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
    wrap: { marginTop: spacing.sm },
    heading: {
    fontSize: 12,
    color: C.textSecondary,
    fontWeight: '600',
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
  },
  row: { paddingHorizontal: spacing.sm, gap: spacing.sm },
  cardWrap: { width: 176 },
  card: {
    backgroundColor: C.cardBg,
    borderRadius: radius.xl2,
    width: 176,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
    // Klarna 消费级 diffuse 多层柔影（高级感来源）
    ...Platform.select({
      web: { boxShadow: shadows.card },
      default: { shadowColor: C.textPrimary, shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.12, shadowRadius: 24, elevation: 8 },
    }),
  },
  imageTouch: { position: 'relative' },
  image: { width: '100%', height: 168, backgroundColor: C.pageBg },
  imagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  imagePhText: { fontSize: 12, color: C.textMuted },
  pickBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    // 去掉 right，让角标只跟随文字宽度，不再横贯图片顶部挡住封面
    backgroundColor: 'rgba(225, 88, 38, 0.9)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2.5,
    maxWidth: 88,
  },
  pickBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  body: { padding: spacing.md },
  imgViewerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  imgViewerInner: { width: '100%', maxWidth: 460, alignItems: 'center' },
  imgViewerImg: { width: '100%', height: 380, borderRadius: radius.lg, backgroundColor: '#111' },
  imgViewerPh: { alignItems: 'center', justifyContent: 'center' },
  imgViewerPhText: { color: '#fff', fontSize: 13 },
  imgViewerTitle: { color: '#fff', fontSize: 13, textAlign: 'center', marginTop: 12, opacity: 0.85 },
  imgViewerClose: { position: 'absolute', top: 44, right: 24, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  imgViewerCloseText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  brand: { fontSize: 12, fontWeight: '600', color: C.textSecondary, marginBottom: 4 },
  title: { fontSize: 13, color: C.textPrimary, lineHeight: 18, marginBottom: spacing.xs, height: 36 },
  // Klarna 消费级：价格做大做粗（20px 深品牌蓝），作为卡片第一视觉锚点
  price: { fontSize: 20, fontWeight: '800', color: C.primaryDark, marginBottom: spacing.xs, letterSpacing: -0.3 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  // Klarna "分期" 等效：佣金/月销 单行强调（蓝色 accent，替代零散小 chip）
  splitRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 3, marginTop: spacing.xs },
  split: { fontSize: 11, fontWeight: '700', color: C.primary },
  splitSep: { fontSize: 11, color: C.textMuted },
  shopTag: { fontSize: 10, color: C.textMuted, marginLeft: 'auto', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: C.borderLight, overflow: 'hidden' },
  // 中度升级：佣 chip 改品牌色蓝边蓝字（强化主蓝可见度）
  chipComm: { backgroundColor: C.primary + '0A', color: C.primary, fontWeight: '700' },
  // 去紫铁律 + 金=会员语义：月销 chip 改主蓝（与 PoolList 蓝 chip 对齐），金仅留给会员身份
  chipSales: { backgroundColor: C.primary + '12', color: C.primary, fontWeight: '700' },
  chipShop: { backgroundColor: '#EFF4FF', color: C.primaryDark },
  chipRate: { backgroundColor: C.pageBg, color: C.textMuted },
  // 2x2 操作网格：收藏 / 测品 / 查看竞品 / 生成推广方案
  actionRow: { borderTopWidth: 1, borderTopColor: C.border },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  actionCell: { width: '50%', borderBottomWidth: 1, borderBottomColor: C.borderLight },
  actionCellLeft: { borderRightWidth: 1, borderRightColor: C.borderLight },
  actionCellBottom: { borderBottomWidth: 0 },
  favBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
  },
  favBtnActive: { backgroundColor: '#FFF1F2' },
  favIcon: { fontSize: 14, color: C.textMuted },
  favIconActive: { color: C.danger },
  favText: { fontSize: 11, color: C.textSecondary },
  favTextActive: { color: C.danger, fontWeight: '600' },
  planBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    backgroundColor: C.primary + '0A',
  },
  planBtnText: { fontSize: 11, color: C.primary, fontWeight: '600' },
  compBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    backgroundColor: C.pageBg,
  },
  compBtnText: { fontSize: 11, color: C.textSecondary, fontWeight: '600' },
  promoBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    backgroundColor: C.primary + '0A',
  },
  promoBtnText: { fontSize: 11, color: C.primary, fontWeight: '600' },
  loginHint: { flex: 1, textAlign: 'center', paddingVertical: spacing.sm, fontSize: 11, color: C.textMuted },
  // 竞品项（轻量，避免嵌套完整商品卡）
  compList: { gap: spacing.sm, marginTop: spacing.sm },
  compItem: {
    flexDirection: 'row',
    backgroundColor: C.pageBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.borderLight,
    overflow: 'hidden',
  },
  compTap: { flex: 1, flexDirection: 'row', padding: spacing.sm, gap: spacing.sm },
  compImage: { width: 64, height: 64, borderRadius: 8, backgroundColor: C.cardBg },
  compBody: { flex: 1, justifyContent: 'center' },
  compAddBtn: {
    width: 72,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary + '0A',
    borderLeftWidth: 1,
    borderLeftColor: C.borderLight,
  },
  compAddBtnDone: { backgroundColor: '#ECFDF5' },
  compAddText: { fontSize: 12, color: C.primary, fontWeight: '600' },
  compAddTextDone: { color: C.success },
  // 推广方案保存入口
  promoSaveWrap: { marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: C.borderLight, paddingTop: spacing.md },
  promoSaved: { fontSize: 13, color: C.success, fontWeight: '600', textAlign: 'center' },
  promoPlanPick: { gap: spacing.sm },
  promoPlanPickTitle: { fontSize: 14, fontWeight: '700', color: C.textPrimary, marginBottom: spacing.xs },
  promoSaveRow: { flexDirection: 'row', gap: spacing.sm },
  promoSaveBtn: {
    flex: 1,
    backgroundColor: C.primary,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  promoSaveBtnAlt: { backgroundColor: C.primary + '14' },
  promoSaveBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },
  promoSaveBtnAltText: { color: C.primary },
  // PlanPicker
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  // 弹层浮在底部、作为 backdrop 的兄弟节点；点击 sheet 内部（含输入框）不会冒泡到关闭层
  sheetFloat: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  pickerSheet: {
    backgroundColor: C.cardBg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? 28 : spacing.lg,
    maxHeight: '78%',
  },
  pickerTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary },
  pickerSub: { fontSize: 13, color: C.textSecondary, marginTop: 4, marginBottom: spacing.md },
  pickerList: { maxHeight: 240 },
  pickerEmpty: { fontSize: 13, color: C.textMuted, paddingVertical: spacing.md },
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: C.borderLight,
  },
  planRowIn: { opacity: 0.6 },
  planRowName: { fontSize: 14, fontWeight: '600', color: C.textPrimary },
  planRowMeta: { fontSize: 12, color: C.textMuted, marginTop: 2 },
  planRowTag: { fontSize: 12, color: C.primary, fontWeight: '600' },
  planRowTagIn: { color: C.textMuted },
  pickerNew: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  pickerInput: {
    flex: 1,
    backgroundColor: C.pageBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 14,
    color: C.textPrimary,
  },
  pickerCreateBtn: {
    backgroundColor: C.primary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    justifyContent: 'center',
  },
  pickerCreateDisabled: { backgroundColor: C.border },
  pickerCreateText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pickerCancel: { marginTop: spacing.md, alignItems: 'center', paddingVertical: spacing.sm },
  pickerCancelText: { fontSize: 14, color: C.textSecondary },
  // 通用结果弹层（竞品 / 推广方案）
  sheet: {
    backgroundColor: C.cardBg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? 28 : spacing.lg,
    maxHeight: '82%',
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary },
  sheetClose: { fontSize: 22, color: C.textSecondary, lineHeight: 26 },
  sheetSub: { fontSize: 13, color: C.textSecondary, marginTop: 4, marginBottom: spacing.md },
  sheetBody: { maxHeight: '70%' },
  loadingText: { fontSize: 13, color: C.textMuted, paddingVertical: spacing.md },
  thinkPending: { fontSize: 13, color: C.textMuted, paddingVertical: spacing.sm, paddingLeft: spacing.xs },
  // ── 深度思考面板（推广方案，2026-08-27）──
  thinkWrap: { marginTop: spacing.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: C.border, backgroundColor: C.cardBg, overflow: 'hidden' },
  thinkHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  thinkTitleRow: { flexDirection: 'row', alignItems: 'center' },
  thinkBadge: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.textPrimary, marginRight: 6 },
  thinkTitle: { fontSize: 13, fontWeight: '700', color: C.textPrimary },
  thinkLive: { flexDirection: 'row', alignItems: 'center', marginLeft: 8 },
  thinkLiveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.success || '#22c55e', marginRight: 4 },
  thinkLiveText: { fontSize: 11, color: C.textSecondary },
  thinkToggle: { fontSize: 12, color: C.textSecondary },
  thinkScroll: { backgroundColor: C.pageBg },
  thinkScrollCollapsed: { maxHeight: 36 },
  thinkScrollOpen: { maxHeight: 180 },
  thinkScrollContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  thinkRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.xs },
  thinkDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.textPrimary, marginTop: 6, marginRight: 8 },
  thinkStep: { flex: 1, fontSize: 12, color: C.textSecondary, lineHeight: 18 },
  emptySub: { fontSize: 13, color: C.textSecondary, textAlign: 'center', paddingVertical: spacing.xl },
  // ── 确定再生成（商品介绍确认步骤）──
  confirmIntroBox: {
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.borderLight,
    padding: spacing.md,
  },
  confirmIntroTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary, marginBottom: 6 },
  confirmIntroDesc: { fontSize: 13, color: C.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  confirmIntroActions: { flexDirection: 'row', gap: spacing.sm },
  confirmIntroBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  confirmIntroCancel: { backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.borderLight },
  confirmIntroCancelText: { fontSize: 14, fontWeight: '600', color: C.textSecondary },
  confirmIntroOk: { backgroundColor: C.primary },
  confirmIntroOkText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  // 推广方案内容
  promoWrap: { gap: spacing.md },
  promoTitle: { fontSize: 17, fontWeight: '700', color: C.primary, lineHeight: 24 },
  promoBlock: { gap: spacing.xs },
  promoLabel: { fontSize: 13, fontWeight: '700', color: C.textPrimary, marginTop: spacing.xs },
  promoBullet: { fontSize: 13, color: C.textPrimary, lineHeight: 20 },
  promoBody: { fontSize: 13, color: C.textPrimary, lineHeight: 22 },
  promoPlatform: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginBottom: spacing.xs },
  promoPlatformName: { fontSize: 13, fontWeight: '700', color: C.primary, width: 56 },
  promoPlatformAngle: { flex: 1, fontSize: 13, color: C.textSecondary, lineHeight: 20 },
  // 加厚字段容器（视觉上和上方基础字段区分）
  promoNewBox: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: C.borderLight, gap: spacing.sm },
  // 编辑文案入口
  promoEditBtn: { marginTop: spacing.md, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: C.border, backgroundColor: C.pageBg },
  promoEditBtnText: { fontSize: 13, color: C.textSecondary, fontWeight: '600' },
  // 编辑模式
  editInput: {
    backgroundColor: C.pageBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 14,
    color: C.textPrimary,
  },
  editBody: { minHeight: 120, textAlignVertical: 'top', lineHeight: 20 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  editRemove: { fontSize: 16, color: C.danger, width: 24, textAlign: 'center' },
  editAdd: { alignItems: 'flex-start', marginTop: 2 },
  editAddText: { fontSize: 12, color: C.primary, fontWeight: '600' },
  // 商品详情卡（点商品图/标题弹出）
  detailImage: { width: '100%', height: 180, borderRadius: radius.lg, backgroundColor: C.pageBg, marginBottom: spacing.sm },
  detailHead: { paddingHorizontal: 2 },
  detailTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary, lineHeight: 21, marginTop: 2 },
  // 中度升级：详情弹窗的价格 chip 用品牌色蓝（与商品卡正文一致）
  chipPrice: { backgroundColor: C.primary + '14', color: C.primary, fontWeight: '800' },
  introWrap: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: C.borderLight },
  introBody: { gap: spacing.sm },
  introSummary: { fontSize: 14, fontWeight: '600', color: C.textPrimary, lineHeight: 21 },
  introBlock: { gap: 4 },
  introLabel: { fontSize: 13, fontWeight: '700', color: C.textPrimary },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { fontSize: 11, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: C.pageBg, color: C.textSecondary, overflow: 'hidden' },
  // ── 生成内容（P0）──
  formLabel: { fontSize: 12, fontWeight: '600', color: C.textSecondary, marginTop: spacing.md, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipText: { fontSize: 13, color: C.textSecondary },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  introBullet: { fontSize: 13, color: C.textPrimary, lineHeight: 20 },
  introText: { fontSize: 13, color: C.textPrimary, lineHeight: 20 },
  introLink: { fontSize: 12, color: C.primary, lineHeight: 18, marginTop: 2 },
  buyRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  buyBtn: {
    flex: 1,
    backgroundColor: C.danger,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  buyBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  searchBtn: {
    flex: 1,
    backgroundColor: C.pageBg,
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  searchBtnText: { fontSize: 14, fontWeight: '700', color: C.danger },
  chipCoupon: { backgroundColor: C.danger + '12', color: C.danger },
  buyHint: { fontSize: 11, color: C.textMuted, textAlign: 'center', marginTop: spacing.xs, lineHeight: 15 },
})
}
