import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, Image, TouchableOpacity, ScrollView, Linking, Modal, Platform, TextInput } from 'react-native'
import { radius, spacing } from '../../theme'
import { useTheme } from '../../utils/theme'
import { ProductCandidate, ProductIntro } from '../../utils/types'
import { candidateAPI, introAPI } from '../../utils/api'
import { FadeInView, HoverLift } from '../Motion'
import { UsageReceipt } from '../UsageReceipt'

interface Props {
  items: ProductCandidate[]
  userId?: string | null
  emptyHint?: string
  onCheckDone?: () => void
}

// 平台筛选 chips。注意：商品数据里 platform 可能是「组合值」，分隔符不统一——
// 例如 "淘宝/天猫"（斜杠）或 "抖音|小红书"（竖线）。因此筛选不能用严格相等，
// 必须按 ['/','|','、'] 切分后做「包含」匹配（见 platformMatch）。
const PLATFORMS = ['淘宝', '天猫', '京东', '拼多多', '抖音', '小红书']
const COMP_LEVELS = ['低', '中', '高']

// 平台匹配：把商品 platform 按多种分隔符切成若干平台 token，命中所选 chip 即算匹配。
// 这样 "淘宝/天猫" 既能命中「淘宝」也能命中「天猫」chip；"抖音|小红书" 能命中「抖音」「小红书」。
function platformMatch(p: ProductCandidate | undefined | null, sel: string): boolean {
  if (!sel) return true
  const parts = (p?.platform || '')
    .split(/[/|、]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.includes(sel)
}

// 取排序时间（毫秒）：优先 archivedAt，其次 updatedAt；两者都没有的时间戳视为「最新」
// （例如聊天里刚推出来的乐观更新项），排到最前，符合「越新越靠上」。
function poolTimeMs(p: ProductCandidate): number {
  const t = p.archivedAt || p.updatedAt
  if (t) {
    const ms = new Date(t).getTime()
    if (!isNaN(ms)) return ms
  }
  return Number.POSITIVE_INFINITY
}

// 相对时间文案：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 / MM-DD / YYYY-MM-DD
function fmtPoolTime(p: ProductCandidate): string {
  const t = p.archivedAt || p.updatedAt
  if (!t) return ''
  const ms = new Date(t).getTime()
  if (isNaN(ms)) return ''
  const now = Date.now()
  const diff = now - ms
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(ms)
  const today = new Date()
  const sameYMD = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameYMD(d, today)) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `今天 ${hh}:${mm}`
  }
  const yest = new Date(today)
  yest.setDate(today.getDate() - 1)
  if (sameYMD(d, yest)) return '昨天'
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const DD = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() === today.getFullYear() ? `${MM}-${DD}` : `${d.getFullYear()}-${MM}-${DD}`
}

export function PoolList({ items, userId, emptyHint, onCheckDone }: Props) {
  const [checking, setChecking] = useState(false)
  const [checkMsg, setCheckMsg] = useState('')
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const runCheck = () => {
    if (!userId || checking) return
    setChecking(true)
    setCheckMsg('')
    candidateAPI
      .checkChanges(userId)
      .then((res) => {
        const n = res.changes?.length || 0
        setCheckMsg(n > 0 ? `发现 ${n} 个商品佣金变动` : '暂无佣金变动')
        onCheckDone && onCheckDone()
      })
      .catch(() => setCheckMsg('检查失败'))
      .finally(() => {
        setChecking(false)
        setTimeout(() => setCheckMsg(''), 3000)
      })
  }
  const [query, setQuery] = useState('')
  const [plat, setPlat] = useState('')
  const [comp, setComp] = useState('')
  const [comm, setComm] = useState(0)
  // 对比模式：勾选 2-3 个商品并排比较
  const [compareMode, setCompareMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  // 按归档时间倒序：越新越靠前（无时间戳的乐观项视为最新，排最前）
  const sorted = useMemo(() => {
    const arr = items.slice()
    arr.sort((a, b) => poolTimeMs(b) - poolTimeMs(a))
    return arr
  }, [items])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sorted.filter((p) => {
      if (!platformMatch(p, plat)) return false
      if (comp && p.competitionLevel !== comp) return false
      if (comm && (p.commissionRatio ?? 0) < comm) return false
      if (q) {
        const hay = `${p.productName || ''} ${p.brand || ''} ${(p.directionTags || []).join(' ')} ${(p.sellingPoints || []).join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [sorted, query, plat, comp, comm])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 3) return prev // 最多 3 个
      return [...prev, id]
    })
  }

  const exitCompare = () => {
    setCompareMode(false)
    setSelected([])
  }

  const compareItems = selected
    .map((id) => items.find((p) => p.id === id))
    .filter((p): p is ProductCandidate => !!p)

  if (items.length === 0) {
    return (
      <View style={styles.emptyBox}>
        <Text style={styles.emptyTitle}>商品池为空</Text>
        <Text style={styles.emptySub}>{emptyHint || '在聊天里问 AI 分析某个带货方向，出现的商品会自动归档到这里（含 AI 方向标签/竞争等级/卖点）'}</Text>
      </View>
    )
  }

  return (
    <View style={styles.list}>
      {/* 搜索 + 筛选 */}
      <View style={styles.filterBar}>
        <View style={styles.searchBox}>
          <TextInput
            style={styles.searchInput}
            placeholder="搜商品名 / 品牌 / 方向"
            placeholderTextColor={C.textMuted}
            value={query}
            onChangeText={setQuery}
          />
          {query ? (
            <TouchableOpacity onPress={() => setQuery('')} activeOpacity={0.7}>
              <Text style={styles.searchClear}>✕</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterChips}>
          <TouchableOpacity style={[styles.fChip, !plat && styles.fChipOn]} onPress={() => setPlat('')}>
            <Text style={[styles.fChipText, !plat && styles.fChipTextOn]}>全部平台</Text>
          </TouchableOpacity>
          {PLATFORMS.map((x) => (
            <TouchableOpacity key={x} style={[styles.fChip, plat === x && styles.fChipOn]} onPress={() => setPlat(plat === x ? '' : x)}>
              <Text style={[styles.fChipText, plat === x && styles.fChipTextOn]}>{x}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterChips}>
          <TouchableOpacity style={[styles.fChip, !comp && styles.fChipOn]} onPress={() => setComp('')}>
            <Text style={[styles.fChipText, !comp && styles.fChipTextOn]}>竞争不限</Text>
          </TouchableOpacity>
          {COMP_LEVELS.map((x) => (
            <TouchableOpacity key={x} style={[styles.fChip, comp === x && styles.fChipOn]} onPress={() => setComp(comp === x ? '' : x)}>
              <Text style={[styles.fChipText, comp === x && styles.fChipTextOn]}>{x}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.fChip, comm === 30 && styles.fChipOn]} onPress={() => setComm(comm === 30 ? 0 : 30)}>
            <Text style={[styles.fChipText, comm === 30 && styles.fChipTextOn]}>佣≥30%</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.fChip, comm === 40 && styles.fChipOn]} onPress={() => setComm(comm === 40 ? 0 : 40)}>
            <Text style={[styles.fChipText, comm === 40 && styles.fChipTextOn]}>佣≥40%</Text>
          </TouchableOpacity>
        </ScrollView>
          <TouchableOpacity
            style={[styles.compareToggle, compareMode && styles.compareToggleOn]}
            activeOpacity={0.8}
            onPress={() => (compareMode ? exitCompare() : setCompareMode(true))}
          >
            <Text style={[styles.compareToggleText, compareMode && styles.compareToggleTextOn]}>
              {compareMode ? '取消对比' : '对比'}
            </Text>
          </TouchableOpacity>
          {userId ? (
            <TouchableOpacity style={styles.checkBtn} activeOpacity={0.8} onPress={runCheck} disabled={checking}>
              <Text style={styles.checkBtnText}>{checking ? '检查中…' : '检查变动'}</Text>
            </TouchableOpacity>
          ) : null}
          {checkMsg ? <Text style={styles.checkMsg}>{checkMsg}</Text> : null}
        </View>

      {filtered.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>没有匹配的商品</Text>
          <Text style={styles.emptySub}>换个关键词，或点「全部平台 / 竞争不限」清空筛选</Text>
        </View>
      ) : (
        filtered.map((p, i) => (
          <PoolRow
            key={p.id}
            index={i}
            item={p}
            userId={userId}
            compareMode={compareMode}
            selected={selected.includes(p.id)}
            onToggleSelect={() => toggleSelect(p.id)}
          />
        ))
      )}

      {/* 对比选择条 */}
      {compareMode ? (
        <View style={styles.compareBar}>
          <Text style={styles.compareBarText}>已选 {selected.length}/3</Text>
          <TouchableOpacity
            style={[styles.compareGo, selected.length < 2 && styles.compareGoDis]}
            activeOpacity={0.8}
            disabled={selected.length < 2}
            onPress={() => setCompareMode(false)}
          >
            <Text style={styles.compareGoText}>开始对比</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* 对比表弹层 */}
      {compareItems.length >= 2 ? <CompareSheet items={compareItems} onClose={exitCompare} /> : null}
    </View>
  )
}

function PoolRow({
  index,
  item,
  userId,
  compareMode,
  selected,
  onToggleSelect,
}: {
  index?: number
  item: ProductCandidate
  userId?: string | null
  compareMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [fav, setFav] = useState<boolean>(!!item.favorited)
  const [busy, setBusy] = useState(false)
  const [showIntro, setShowIntro] = useState(false)

  const toggleFav = () => {
    if (!userId || busy) return
    const next = !fav
    setFav(next)
    setBusy(true)
    candidateAPI
      .favorite(userId, item.id, next)
      .catch(() => setFav(!next))
      .finally(() => setBusy(false))
  }

  const onTap = () => {
    if (compareMode) {
      onToggleSelect && onToggleSelect()
      return
    }
    setShowIntro(true)
  }

  return (
    <FadeInView delay={Math.min(index ?? 0, 12) * 40} style={[styles.row, selected && styles.rowSel]}>
      {compareMode ? (
        <TouchableOpacity style={styles.checkWrap} activeOpacity={0.7} onPress={onTap}>
          <View style={[styles.check, selected && styles.checkOn]}>
            {selected ? <Text style={styles.checkMark}>✓</Text> : null}
          </View>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity style={styles.tap} activeOpacity={0.85} onPress={onTap}>
        <HoverLift radius={radius.md} hoverLift={false}>
          {item.image ? (
            <Image source={{ uri: item.image }} style={styles.img} resizeMode="cover" />
          ) : (
            <View style={[styles.img, styles.imgPh]}>
              <Text style={styles.imgPhText}>无图</Text>
            </View>
          )}
        </HoverLift>
        <View style={styles.body}>
          <View style={styles.topRow}>
            {item.brand ? <Text style={styles.brand} numberOfLines={1}>{item.brand}</Text> : <View style={{ flex: 1 }} />}
            {fmtPoolTime(item) ? <Text style={styles.timeText}>{fmtPoolTime(item)}</Text> : null}
          </View>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={2}>{item.productName || item.brand || '商品'}</Text>
            {Array.isArray(item.changes) && item.changes.length > 0 ? (
              <View style={styles.alertBadge}>
                <Text style={styles.alertBadgeText}>佣金变动</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.metaRow}>
            {item.price ? <Text style={styles.price}>{item.price}</Text> : null}
            {item.commissionRatio != null ? <Text style={styles.comm}>佣{item.commissionRatio.toFixed(0)}%</Text> : null}
            {item.sales != null ? <Text style={styles.sales}>月销{Math.round(item.sales)}</Text> : null}
          </View>
          <View style={styles.chipRow}>
            {item.platform ? <Text style={[styles.chip, styles.chipPlat]}>{item.platform}</Text> : null}
            {item.competitionLevel ? <Text style={[styles.chip, styles.chipComp]}>竞争{item.competitionLevel}</Text> : null}
          </View>
          {Array.isArray(item.directionTags) && item.directionTags.length > 0 ? (
            <View style={styles.tagRow}>
              {item.directionTags.slice(0, 3).map((t, i) => (
                <Text key={i} style={styles.tag}>{t}</Text>
              ))}
            </View>
          ) : null}
          {Array.isArray(item.sellingPoints) && item.sellingPoints.length > 0 ? (
            <Text style={styles.points} numberOfLines={2}>卖点：{item.sellingPoints.join('、')}</Text>
          ) : null}
        </View>
      </TouchableOpacity>
      {compareMode ? null : (
        <TouchableOpacity
          style={[styles.favBtn, fav && styles.favBtnActive]}
          activeOpacity={0.8}
          onPress={toggleFav}
        >
          <Text style={[styles.favText, fav && styles.favTextActive]}>{fav ? '已收藏' : '收藏'}</Text>
        </TouchableOpacity>
      )}
      <PoolIntroModal visible={showIntro} item={item} onClose={() => setShowIntro(false)} />
    </FadeInView>
  )
}

// 商品介绍弹层（复用 introAPI，与商品卡详情一致：AI 介绍 + 联网真实测评来源 + 去购买）
function PoolIntroModal({ visible, item, onClose }: { visible: boolean; item: ProductCandidate; onClose: () => void }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [loading, setLoading] = useState(false)
  const [intro, setIntro] = useState<ProductIntro | null>(null)
  const [introUsage, setIntroUsage] = useState<any>(null)
  const [error, setError] = useState('')
  // 「确定再生成」确认步骤：打开弹层先展示商品信息与消耗提示，用户点「确定生成」才调 introAPI（避免误触即消耗免费次数）
  const [confirming, setConfirming] = useState(true)

  // 关闭时重置为未确认状态（下次打开需重新确认）
  useEffect(() => {
    if (!visible) { setConfirming(true); setLoading(false); setIntro(null); setError(''); setIntroUsage(null) }
  }, [visible])

  // 真正生成介绍：由「确定生成」按钮触发（不再打开即生成）
  const startGenerate = () => {
    if (loading) return
    let cancelled = false
    setLoading(true)
    setError('')
    setIntro(null)
    setIntroUsage(null)
    introAPI
      .get({
        id: item.id,
        title: item.productName,
        brand: item.brand,
        priceText: item.price,
        image: item.image,
        commissionRatio: item.commissionRatio ?? null,
        sales: item.sales ?? null,
        link: item.sourceLink,
        source: item.source,
      })
      .then((res) => {
        if (!cancelled) { setIntro(res.intro); setIntroUsage((res as any).usage) }
      })
      .catch((e: any) => {
        if (!cancelled) {
          // 区分业务态后端错误（余额不足）与真实服务器错误
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
            {item.image ? (
              <Image source={{ uri: item.image }} style={styles.detailImage} resizeMode="cover" />
            ) : null}
            <View style={styles.detailHead}>
              {item.brand ? <Text style={styles.brand}>{item.brand}</Text> : null}
              <Text style={styles.detailTitle}>{item.productName || item.brand || '商品'}</Text>
            </View>
            <View style={styles.metaRow}>
              {item.price ? <Text style={[styles.chip, styles.chipPrice]}>{item.price}</Text> : null}
              {item.commissionRatio != null ? (
                <Text style={[styles.chip, styles.chipComm]}>佣{item.commissionRatio.toFixed(0)}%</Text>
              ) : null}
              {item.sales != null ? <Text style={[styles.chip, styles.chipSales]}>月销{Math.round(item.sales)}</Text> : null}
              {item.couponInfo ? <Text style={[styles.chip, styles.chipCoupon]}>{item.couponInfo}</Text> : null}
            </View>

            <View style={styles.introWrap}>
              {/* 确定再生成：打开弹层先展示此提示，用户点「确定生成」才调 introAPI（避免误触即消耗免费次数） */}
              {confirming && !loading && !intro ? (
                <View style={styles.confirmBox}>
                  <Text style={styles.confirmTitle}>确定要生成商品介绍？</Text>
                  <Text style={styles.confirmDesc}>将生成该商品的详细卖点介绍，消耗每日免费次数（约 0.25 次）；免费额度用完后按余额计费。</Text>
                  <View style={styles.confirmActions}>
                    <TouchableOpacity style={[styles.confirmBtn, styles.confirmCancel]} activeOpacity={0.8} onPress={onClose}>
                      <Text style={styles.confirmCancelText}>取消</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.confirmBtn, styles.confirmOk]} activeOpacity={0.8} onPress={() => { setConfirming(false); startGenerate() }}>
                      <Text style={styles.confirmOkText}>确定生成</Text>
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
                      <Text style={styles.introLabel}>核心卖点</Text>
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
                  <UsageReceipt usage={introUsage} compact />
                </View>
              ) : null}
            </View>

            <View style={styles.buyRow}>
              <TouchableOpacity style={styles.buyBtn} activeOpacity={0.8} onPress={() => openSource(item.sourceLink)}>
                <Text style={styles.buyBtnText}>领券购买</Text>
              </TouchableOpacity>
              {item.detailUrl ? (
                <TouchableOpacity style={styles.searchBtn} activeOpacity={0.8} onPress={() => openSource(item.detailUrl)}>
                  <Text style={styles.searchBtnText}>在淘宝搜</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <Text style={styles.buyHint}>提示：淘宝 App 内登录后，领券页里才会出现宝贝详情页入口</Text>
            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

// 商品对比表：勾选 2-3 个商品并排比价/佣/销/竞争/平台/方向/卖点
function CompareSheet({ items, onClose }: { items: ProductCandidate[]; onClose: () => void }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const rows: { label: string; get: (p: ProductCandidate) => string }[] = [
    { label: '品牌', get: (p) => p.brand || '-' },
    { label: '价格', get: (p) => p.price || '-' },
    { label: '佣金', get: (p) => (p.commissionRatio != null ? `${p.commissionRatio.toFixed(0)}%` : '-') },
    { label: '月销', get: (p) => (p.sales != null ? String(Math.round(p.sales)) : '-') },
    { label: '平台', get: (p) => p.platform || '-' },
    { label: '竞争', get: (p) => p.competitionLevel || '-' },
    { label: '方向', get: (p) => (Array.isArray(p.directionTags) ? p.directionTags.join('、') : '-') },
    { label: '卖点', get: (p) => (Array.isArray(p.sellingPoints) ? p.sellingPoints.join('、') : '-') },
  ]
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, styles.sheetFloat]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>商品对比（{items.length}）</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.cmpScroll}>
            <View style={styles.cmpTable}>
              <View style={styles.cmpRow}>
                <View style={styles.cmpLabel}>
                  <Text style={styles.cmpLabelText}>商品</Text>
                </View>
                {items.map((p) => (
                  <View key={p.id} style={styles.cmpCol}>
                    {p.image ? <Image source={{ uri: p.image }} style={styles.cmpImg} resizeMode="cover" /> : null}
                    <Text style={styles.cmpName} numberOfLines={2}>{p.productName || p.brand || '商品'}</Text>
                  </View>
                ))}
              </View>
              {rows.map((r) => (
                <View key={r.label} style={styles.cmpRow}>
                  <View style={styles.cmpLabel}>
                    <Text style={styles.cmpLabelText}>{r.label}</Text>
                  </View>
                  {items.map((p) => (
                    <View key={p.id} style={styles.cmpCol}>
                      <Text style={styles.cmpVal} numberOfLines={3}>{r.get(p)}</Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
          <View style={{ height: 20 }} />
        </View>
      </View>
    </Modal>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  list: { gap: spacing.sm },
  // 搜索 + 筛选
  filterBar: { gap: spacing.xs, marginBottom: spacing.xs },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: spacing.sm,
    gap: 6,
  },
  searchInput: { flex: 1, fontSize: 13, color: C.textPrimary, paddingVertical: spacing.sm, outlineStyle: 'none' as any },
  searchClear: { fontSize: 14, color: C.textMuted, paddingHorizontal: 4 },
  filterChips: { flexGrow: 0 },
  fChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.borderLight,
    backgroundColor: C.cardBg,
    marginRight: 6,
  },
  fChipOn: { backgroundColor: C.primary, borderColor: C.primary },
  fChipText: { fontSize: 12, color: C.textSecondary },
  fChipTextOn: { color: '#fff', fontWeight: '600' },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
    paddingHorizontal: spacing.lg,
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.borderLight,
    marginTop: spacing.sm,
  },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: C.textPrimary, marginBottom: spacing.sm },
  emptySub: { fontSize: 13, color: C.textSecondary, textAlign: 'center', lineHeight: 20 },
  row: {
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
    flexDirection: 'row',
    ...Platform.select({
      web: { boxShadow: '0 1px 3px rgba(15,23,42,0.06)' },
      default: { shadowColor: '#0F172A', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2 },
    }),
  },
  tap: { flex: 1, flexDirection: 'row', padding: spacing.sm, gap: spacing.sm },
  img: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.borderLight },
  imgPh: { alignItems: 'center', justifyContent: 'center' },
  imgPhText: { fontSize: 11, color: C.textMuted },
  body: { flex: 1 },
  brand: { fontSize: 12, fontWeight: '700', color: C.primary, marginBottom: 2 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs, marginBottom: 2 },
  timeText: { fontSize: 10.5, color: C.textMuted, flexShrink: 0 },
  name: { fontSize: 13, color: C.textPrimary, lineHeight: 18, marginBottom: spacing.xs },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  price: { fontSize: 15, fontWeight: '700', color: C.danger },
  comm: { fontSize: 11.5, fontWeight: '600', color: C.success },
  sales: { fontSize: 11.5, color: C.textSecondary },
  chipRow: { flexDirection: 'row', gap: 6, marginTop: spacing.xs },
  chip: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  chipPlat: { backgroundColor: '#EFF6FF', color: '#3B82F6' },
  chipComp: { backgroundColor: '#FEF3C7', color: '#B45309' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: spacing.xs },
  tag: { fontSize: 10, color: C.textSecondary, backgroundColor: C.pageBg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  points: { fontSize: 11, color: C.textMuted, marginTop: spacing.xs, lineHeight: 16 },
  favBtn: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: C.borderLight,
  },
  favBtnActive: { backgroundColor: '#FFF1F2' },
  favText: { fontSize: 12, color: C.textSecondary, fontWeight: '500' },
  favTextActive: { color: C.danger, fontWeight: '700' },
  // 商品介绍弹层（与商品卡详情一致的结构：关闭层 absoluteFill + sheet 置顶，避免点内部冒泡关闭）
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheetFloat: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: C.cardBg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? 28 : spacing.lg,
    maxHeight: '82%',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary },
  sheetClose: { fontSize: 22, color: C.textSecondary, lineHeight: 26 },
  sheetBody: { maxHeight: '70%' },
  detailImage: { width: '100%', height: 180, borderRadius: radius.lg, backgroundColor: C.pageBg, marginBottom: spacing.sm },
  detailHead: { paddingHorizontal: 2 },
  detailTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary, lineHeight: 21, marginTop: 2 },
  chipPrice: { backgroundColor: C.danger + '12', color: C.danger },
  chipComm: { backgroundColor: C.success + '16', color: C.success },
  chipSales: { backgroundColor: C.primary + '12', color: C.primary },
  introWrap: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: C.borderLight },
  introBody: { gap: spacing.sm },
  introSummary: { fontSize: 14, fontWeight: '600', color: C.textPrimary, lineHeight: 21 },
  introBlock: { gap: 4 },
  introLabel: { fontSize: 13, fontWeight: '700', color: C.textPrimary },
  introBullet: { fontSize: 13, color: C.textPrimary, lineHeight: 20 },
  introText: { fontSize: 13, color: C.textPrimary, lineHeight: 20 },
  introLink: { fontSize: 12, color: C.primary, lineHeight: 18, marginTop: 2 },
  loadingText: { fontSize: 13, color: C.textMuted, paddingVertical: spacing.md },
  // ── 确定再生成（商品介绍确认步骤）──
  confirmBox: {
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.borderLight,
    padding: spacing.md,
  },
  confirmTitle: { fontSize: 15, fontWeight: '700', color: C.textPrimary, marginBottom: 6 },
  confirmDesc: { fontSize: 13, color: C.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  confirmActions: { flexDirection: 'row', gap: spacing.sm },
  confirmBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  confirmCancel: { backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.borderLight },
  confirmCancelText: { fontSize: 14, fontWeight: '600', color: C.textSecondary },
  confirmOk: { backgroundColor: C.primary },
  confirmOkText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  buyBtn: {
    flex: 1,
    marginTop: spacing.md,
    backgroundColor: C.danger,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  buyBtnText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  buyRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  searchBtn: {
    flex: 1,
    backgroundColor: C.cardBg,
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  searchBtnText: { fontSize: 14, fontWeight: '700', color: C.danger },
  chipCoupon: { backgroundColor: C.danger + '12', color: C.danger },
  buyHint: { fontSize: 11, color: C.textMuted, textAlign: 'center', marginTop: spacing.xs, lineHeight: 15 },
  // 对比模式
  compareToggle: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.primary,
    backgroundColor: C.cardBg,
    marginTop: 2,
  },
  compareToggleOn: { backgroundColor: C.primary },
  compareToggleText: { fontSize: 12, fontWeight: '600', color: C.primary },
  compareToggleTextOn: { color: '#fff' },
  checkBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.danger,
    backgroundColor: C.cardBg,
    marginTop: 2,
  },
  checkBtnText: { fontSize: 12, fontWeight: '600', color: C.danger },
  checkMsg: { fontSize: 12, color: C.danger, fontWeight: '600', marginTop: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  alertBadge: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginTop: 2,
  },
  alertBadgeText: { fontSize: 9, fontWeight: '700', color: C.danger },
  rowSel: { borderColor: C.primary, borderWidth: 1.5 },
  checkWrap: { justifyContent: 'center', paddingLeft: spacing.sm },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: C.primary, borderColor: C.primary },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  compareBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  compareBarText: { fontSize: 13, color: C.textPrimary, fontWeight: '600' },
  compareGo: { backgroundColor: C.primary, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  compareGoDis: { backgroundColor: C.border },
  compareGoText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  // 对比表
  cmpScroll: { maxHeight: '70%' },
  cmpTable: { paddingBottom: spacing.sm },
  cmpRow: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderBottomColor: C.borderLight },
  cmpLabel: { width: 56, paddingVertical: spacing.sm, paddingRight: spacing.xs, justifyContent: 'center' },
  cmpLabelText: { fontSize: 12, fontWeight: '700', color: C.textSecondary },
  cmpCol: { width: 130, padding: spacing.sm, borderLeftWidth: 1, borderLeftColor: C.borderLight },
  cmpImg: { width: '100%', height: 64, borderRadius: radius.md, backgroundColor: C.pageBg, marginBottom: 4 },
  cmpName: { fontSize: 12, fontWeight: '600', color: C.textPrimary, lineHeight: 16 },
  cmpVal: { fontSize: 12, color: C.textPrimary, lineHeight: 17 },
  })
}
