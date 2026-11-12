import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { WorkspaceShell, WorkspaceTab } from '../components/WorkspaceShell'
import { HomeScreen } from './HomeScreen'
import { User, HotCategory, ProductCandidate, OpportunityGroup, ProductCardItem } from '../utils/types'
import { billingAPI, chatAPI, candidateAPI } from '../utils/api'
import { PoolList } from '../components/product/PoolList'
import { HotCategoryCard } from '../components/cards/HotCategoryCard'
import { ProductCard } from '../components/cards/ProductCard'
import { spacing, radius } from '../theme'
import { useTheme } from '../utils/theme'
import { useFavorites, usePlans, usePool } from '../store/workspace'

// 确定性洗牌：seed=0 保持原序；其余 seed 给出稳定但不同的排列（刷新按钮用，纯本机、不请求服务器）
function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  if (seed === 0 || arr.length === 0) return arr
  const a = [...arr]
  let s = (seed * 2654435761) >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = Math.floor((s / 4294967296) * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

interface Props {
  user?: User | null
  onLogout?: () => void
  onLogin?: () => void
  onOpenProfile?: () => void
  onOpenFeedback?: () => void
  onMembershipChanged?: () => void
  membershipTick?: number
  initialPrompt?: string | null
  onConsumePrompt?: () => void
  /** 余额不足时打开充值页（替代原「升级会员」弹窗） */
  onOpenRecharge?: () => void
  onOpenTest?: () => void
  onOpenRanking?: () => void
}

export function WorkspaceScreen({
  user,
  onLogout,
  onLogin,
  onOpenProfile,
  onOpenFeedback,
  onMembershipChanged,
  membershipTick,
  initialPrompt,
  onConsumePrompt,
  onOpenRecharge,
  onOpenTest,
  onOpenRanking,
}: Props) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('conversation')
  const [homeIntent, setHomeIntent] = useState<'diagnose' | 'promo' | null>(null)
  const [creditBalance, setCreditBalance] = useState<{ balance: number; freeRemaining?: number; estChats?: number } | null>(null)
  const [hotWords, setHotWords] = useState<string[]>([])
  const [hotWordsLoading, setHotWordsLoading] = useState(false)
  const [hotSuggestions, setHotSuggestions] = useState<{ kw: string; total?: number }[]>([])
  const [hotCopyItems, setHotCopyItems] = useState<Array<{ title?: string; circleText?: string; actualPrice?: number | null; itemLink?: string }>>([])
  const [signalsLoading, setSignalsLoading] = useState(false)
  // 功能抽屉（模块入口 + 历史对话）：由顶栏 ZGo logo 打开，HomeScreen 内渲染
  const [menuOpen, setMenuOpen] = useState(false)
  const [opportunities, setOpportunities] = useState<OpportunityGroup[]>([])
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false)
  const [opportunitiesError, setOpportunitiesError] = useState('')
  const [remotePool, setRemotePool] = useState<ProductCandidate[]>([])
  const [poolLoading, setPoolLoading] = useState(false)
  const localPool = usePool(user?.id || 'guest')
  const favorites = useFavorites(user?.id || 'guest')
  const plans = usePlans(user?.id || 'guest')

  // 机会卡片点击 → 相关商品弹层（按方向的 keyword 拉 /products/spotlight）
  const [spotDir, setSpotDir] = useState<HotCategory | null>(null)
  const [spotProducts, setSpotProducts] = useState<ProductCardItem[]>([])
  const [spotLoading, setSpotLoading] = useState(false)
  const [spotError, setSpotError] = useState('')
  // 机会页搜索（客户端按名称/类目/关键词过滤）
  const [oppSearch, setOppSearch] = useState('')
  // 机会页刷新：仅本机对机会方向做重排（不请求服务器）
  const [oppShuffleSeed, setOppShuffleSeed] = useState(0)
  // 相关商品弹层：本机搜索/洗牌状态（均不请求服务器）
  const [modalSearch, setModalSearch] = useState('')
  const [modalShuffleSeed, setModalShuffleSeed] = useState(0)

  const openSpotlight = async (item: HotCategory) => {
    const kw = (item.keyword || item.name || '').trim()
    if (!kw) return
    setSpotDir(item)
    setSpotLoading(true)
    setSpotError('')
    setSpotProducts([])
    setModalSearch('')
    setModalShuffleSeed(0)
    try {
      const res = await chatAPI.getSpotlight(kw, '', item.searchCategory || 'general')
      setSpotProducts(res.items || [])
    } catch (error) {
      console.error('相关商品加载失败', error)
      setSpotError('相关商品暂时不可用，请稍后重试')
    } finally {
      setSpotLoading(false)
    }
  }

  // 机会搜索过滤：按名称/类目/keyword 命中即保留（组为空则整组隐藏）
  // 刷新（oppShuffleSeed 变化）：仅本机对方向做重排，不请求服务器
  const filteredGroups = useMemo<OpportunityGroup[]>(() => {
    const q = oppSearch.trim().toLowerCase()
    let base = opportunities
    if (q) {
      base = opportunities
        .map((g) => ({
          ...g,
          items: g.items.filter((it) =>
            [it.name, it.category, it.keyword].filter(Boolean).some((t) => String(t).toLowerCase().includes(q)),
          ),
        }))
        .filter((g) => g.items.length > 0)
    }
    const groupsShuffled = shuffleWithSeed(base, oppShuffleSeed)
    return groupsShuffled.map((g) => ({ ...g, items: shuffleWithSeed(g.items, oppShuffleSeed) }))
  }, [opportunities, oppSearch, oppShuffleSeed])

  // 相关商品弹层展示列表：在已拉取的商品上做本机搜索过滤 + 洗牌（刷新只改 seed，不请求服务器）
  const displaySpot = useMemo<ProductCardItem[]>(() => {
    const q = modalSearch.trim().toLowerCase()
    let arr = spotProducts
    if (q) {
      arr = arr.filter((p: any) =>
        [p.title, p.name, p.brand, p.category].filter(Boolean).some((t: any) => String(t).toLowerCase().includes(q)),
      )
    }
    return shuffleWithSeed(arr, modalShuffleSeed)
  }, [spotProducts, modalSearch, modalShuffleSeed])

  const loadOpportunities = async () => {
    setOpportunitiesLoading(true)
    setOpportunitiesError('')
    try {
      const result = await chatAPI.getOpportunities()
      setOpportunities(result.groups || [])
    } catch (error) {
      console.error('加载机会失败', error)
      setOpportunitiesError('实时机会暂时不可用，请稍后重试')
    } finally {
      setOpportunitiesLoading(false)
    }
  }

  const loadPool = async () => {
    if (!user?.id) return
    setPoolLoading(true)
    try {
      const result = await candidateAPI.list(user.id)
      setRemotePool(result.items || [])
    } catch (error) {
      console.error('加载商品池失败', error)
      setRemotePool([])
    } finally {
      setPoolLoading(false)
    }
  }

  const loadCreditBalance = async () => {
    try {
      const result = await billingAPI.getBalance()
      setCreditBalance({
        balance: result.balance || 0,
        freeRemaining: result.free_remaining,
        estChats: result.est_chats,
      })
    } catch (error) {
      console.error('加载 AI 额度失败', error)
      setCreditBalance(null)
    }
  }

  const loadHotWords = async () => {
    setHotWordsLoading(true)
    try {
      const result = await chatAPI.getHotWords()
      const merged = Array.from(new Set([...(result.taobao || []), ...(result.buyer || [])])).filter(Boolean)
      setHotWords(merged.slice(0, 8))
    } catch (error) {
      console.error('加载大淘客热词失败', error)
      setHotWords([])
    } finally {
      setHotWordsLoading(false)
    }
  }

  const loadMarketSignals = async () => {
    const baseKeyword = hotWords[0] || '护肤'
    setSignalsLoading(true)
    try {
      const [suggestionResult, copyResult] = await Promise.all([
        chatAPI.getSearchSuggestions(baseKeyword, 1),
        chatAPI.getFriendsCircle(3),
      ])
      setHotSuggestions((suggestionResult.items || []).slice(0, 6))
      setHotCopyItems((copyResult.items || []).slice(0, 3))
    } catch (error) {
      console.error('加载市场信号失败', error)
      setHotSuggestions([])
      setHotCopyItems([])
    } finally {
      setSignalsLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'overview' || activeTab === 'opportunities') loadOpportunities()
  }, [activeTab])

  useEffect(() => {
    if (activeTab === 'pool') loadPool()
  }, [activeTab, user?.id])

  useEffect(() => {
    loadCreditBalance()
  }, [user?.id, membershipTick])

  useEffect(() => {
    loadHotWords()
  }, [])

  useEffect(() => {
    if (!hotWords.length) return
    loadMarketSignals()
  }, [hotWords])

  const poolItems = user?.id ? remotePool : localPool.map((item): ProductCandidate => ({
    id: item.id,
    productName: item.title,
    brand: item.brand,
    price: item.priceText,
    sourceLink: item.link,
    image: item.image,
    commissionRatio: item.commissionRatio,
    commissionMoney: item.commissionMoney,
    sales: item.sales,
    source: item.source,
    couponInfo: item.couponInfo,
    detailUrl: item.detailUrl,
    favorited: item.favorited,
  }))

  // HomeScreen 常驻挂载：切走 Tab 用 display:none 隐藏而非卸载，
  // 保证对话 state（sessions/messages）不因 Tab 切换丢失（2026-08-26 修复）。
  const conversationVisible = activeTab === 'conversation'

  return (
      <WorkspaceShell
        onOpenMenu={() => setMenuOpen(true)}
        onOpenProfile={onOpenProfile}
        userLabel={user ? user.nickname || user.account : undefined}
        footer={(
          <BottomNav
            C={C}
            activeTab={activeTab}
            onNavigate={(tab: WorkspaceTab) => setActiveTab(tab)}
            onOpenProfile={onOpenProfile}
            onOpenTest={onOpenTest}
            onOpenDiagnose={() => { setActiveTab('conversation'); setHomeIntent('diagnose') }}
          />
      )}
    >
      {/* 对话常驻（不卸载），其余 Tab 在下方按可见性渲染 */}
      <View style={[styles.tabPane, conversationVisible && styles.tabPaneActive]}>
        <HomeScreen
          user={user}
          onLogout={onLogout}
          onLogin={onLogin}
          onOpenProfile={onOpenProfile}
          onOpenFeedback={onOpenFeedback}
          onMembershipChanged={onMembershipChanged}
          membershipTick={membershipTick}
          initialPrompt={initialPrompt}
          onConsumePrompt={onConsumePrompt}
          onOpenRecharge={onOpenRecharge}
          homeIntent={homeIntent}
          onConsumeHomeIntent={() => setHomeIntent(null)}
          onSend={() => {}}
          activeTab={activeTab}
          onNavigate={(tab) => setActiveTab(tab as WorkspaceTab)}
          drawerOpen={menuOpen}
          onDrawerChange={setMenuOpen}
          onOpenFeedbackDrawer={onOpenFeedback}
        />
      </View>
      <View style={[styles.tabPane, activeTab === 'overview' && styles.tabPaneActive]}>
        <OverviewView
          C={C}
          creditBalance={creditBalance}
          poolCount={poolItems.length}
          favoriteCount={favorites.length || poolItems.filter((item) => item.favorited).length}
          planCount={plans.length}
          opportunities={opportunities}
          loading={opportunitiesLoading}
          onRefresh={loadOpportunities}
          onNavigate={setActiveTab}
          onOpenRecharge={onOpenRecharge}
          onOpenSpotlight={openSpotlight}
          onOpenDiagnose={() => { setActiveTab('conversation'); setHomeIntent('diagnose') }}
          onOpenPromo={() => { setActiveTab('conversation'); setHomeIntent('promo') }}
          onOpenTest={onOpenTest}
          onOpenRanking={onOpenRanking}
          hotWords={hotWords}
          hotWordsLoading={hotWordsLoading}
          hotSuggestions={hotSuggestions}
          hotCopyItems={hotCopyItems}
          signalsLoading={signalsLoading}
        />
      </View>
      <View style={[styles.tabPane, activeTab === 'opportunities' && styles.tabPaneActive]}>
        <OpportunityView
          C={C}
          groups={filteredGroups}
          totalCount={opportunities.reduce((n, g) => n + g.items.length, 0)}
          groupCount={opportunities.length}
          loading={opportunitiesLoading}
          error={opportunitiesError}
          search={oppSearch}
          onSearch={setOppSearch}
          onRefresh={() => setOppShuffleSeed((s) => s + 1)}
          onOpenSpotlight={openSpotlight}
        />
      </View>
      <View style={[styles.tabPane, activeTab === 'pool' && styles.tabPaneActive]}>
        <WorkspaceContent title="商品池" subtitle={user?.id ? '已归档商品与实时变动' : '本机商品与候选清单'} C={C}>
          {poolLoading ? <LoadingState C={C} label="正在加载商品池" /> : <PoolList items={poolItems} userId={user?.id} onCheckDone={loadPool} />}
        </WorkspaceContent>
      </View>
      <RelatedProductsModal
        C={C}
        visible={!!spotDir}
        dir={spotDir}
        items={displaySpot}
        loading={spotLoading}
        error={spotError}
        search={modalSearch}
        onSearch={setModalSearch}
        onReshuffle={() => setModalShuffleSeed((s) => s + 1)}
        userId={user?.id}
        onClose={() => setSpotDir(null)}
      />
    </WorkspaceShell>
  )
}

function RelatedProductsModal({ C, visible, dir, items, loading, error, search, onSearch, onReshuffle, userId, onClose }: any) {
  if (!visible) return null
  const listEmpty = !loading && !error && items.length === 0
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={stylesFor(C).pickerBackdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <View style={[stylesFor(C).sheet, stylesFor(C).sheetFloat, { maxHeight: '88%' }]}>
          <View style={stylesFor(C).sheetHead}>
            <View style={{ flex: 1, marginRight: spacing.sm }}>
              <Text style={stylesFor(C).sheetTitle}>{dir?.name || '相关商品'}</Text>
              {dir?.category ? <Text style={stylesFor(C).muted}>{dir.category} · 实时联盟在售商品</Text> : null}
            </View>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={stylesFor(C).sheetClose}>✕</Text>
            </TouchableOpacity>
          </View>
          {/* 本机搜索 + 刷新（均不请求服务器） */}
          <View style={stylesFor(C).sheetToolbar}>
            <View style={stylesFor(C).sheetSearchBox}>
              <TextInput
                style={stylesFor(C).sheetSearchInput}
                value={search}
                onChangeText={onSearch}
                placeholder="在结果中搜索，如 品牌 / 关键词"
                placeholderTextColor={C.textMuted}
                returnKeyType="search"
                clearButtonMode="while-editing"
              />
            </View>
            <TouchableOpacity style={stylesFor(C).sheetRefreshBtn} activeOpacity={0.8} onPress={onReshuffle}>
              <Text style={stylesFor(C).sheetRefreshText}>刷新</Text>
            </TouchableOpacity>
          </View>
          {loading ? (
            <LoadingState C={C} label="正在加载相关商品" />
          ) : error ? (
            <EmptyState C={C} text={error} />
          ) : listEmpty ? (
            <EmptyState C={C} text={search ? '没有匹配的商品' : '没找到相关在售商品'} />
          ) : (
            <ProductCard items={items} userId={userId} autoScroll={false} />
          )}
        </View>
      </View>
    </Modal>
  )
}

function OverviewView({ C, creditBalance, poolCount, favoriteCount, planCount, opportunities, loading, onRefresh, onNavigate, onOpenRecharge, onOpenSpotlight, onOpenDiagnose, onOpenPromo, onOpenTest, onOpenRanking, hotWords, hotWordsLoading, hotSuggestions, hotCopyItems, signalsLoading }: any) {
  const [platform, setPlatform] = useState('xiaohongshu')
  const [category, setCategory] = useState('all')
  const [goal, setGoal] = useState('low_competition')
  const preview = opportunities.flatMap((g: OpportunityGroup) => g.items).slice(0, 5)
  const hotWordChips = (hotWords || []).slice(0, 8)
  const suggestionChips = (hotSuggestions || []).slice(0, 6)
  const copyItems = (hotCopyItems || []).slice(0, 3)
  const platforms = [
    { key: 'xiaohongshu', label: '小红书' },
    { key: 'douyin', label: '抖音' },
    { key: 'wechat_video', label: '视频号' },
    { key: 'private_group', label: '社群' },
  ]
  const categories = [
    { key: 'all', label: '全部' },
    { key: 'beauty', label: '美妆' },
    { key: 'food', label: '食品' },
    { key: 'pet', label: '宠物' },
    { key: 'home', label: '家居' },
    { key: 'fashion', label: '服饰' },
  ]
  const goals = [
    { key: 'high_commission', label: '高佣金' },
    { key: 'low_competition', label: '低竞争' },
    { key: 'beginner', label: '新手友好' },
    { key: 'content_seed', label: '适合种草' },
  ]
  return (
    <ScrollView contentContainerStyle={stylesFor(C).page} showsVerticalScrollIndicator={false}>
      <View style={stylesFor(C).hero}>
        <View style={stylesFor(C).heroTop}>
          <View style={{ flex: 1 }}>
            <Text style={stylesFor(C).eyebrow}>AI 选品与测品工作台</Text>
            <Text style={stylesFor(C).title}>今天找什么品</Text>
            <Text style={stylesFor(C).subtitle}>先发现机会，再判断值不值得测，最后生成内容并放进测品计划。</Text>
          </View>
          <TouchableOpacity style={stylesFor(C).creditBox} activeOpacity={0.8} onPress={onOpenRecharge}>
            <Text style={stylesFor(C).creditLabel}>AI 额度</Text>
            <Text style={stylesFor(C).creditValue}>{creditBalance ? `¥${Number(creditBalance.balance || 0).toFixed(2)}` : '--'}</Text>
            <Text style={stylesFor(C).creditHint}>{creditBalance?.freeRemaining ? `免费 ${creditBalance.freeRemaining} 次` : '充值'}</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={stylesFor(C).hotPanel}>
        <View style={stylesFor(C).hotPanelHead}>
          <Text style={stylesFor(C).sectionTitle}>大淘客实时热搜</Text>
          <TouchableOpacity onPress={onOpenRanking} activeOpacity={0.8}>
            <Text style={stylesFor(C).link}>打开榜单中心</Text>
          </TouchableOpacity>
        </View>
        <Text style={stylesFor(C).muted}>{hotWordsLoading ? '正在同步买家榜 / 淘客榜热词…' : '点热词直接看相关在售商品，榜单中心看完整实时榜。'}</Text>
        <View style={stylesFor(C).hotChipRow}>
          {hotWordChips.length > 0 ? hotWordChips.map((word: string) => (
            <TouchableOpacity
              key={word}
              style={stylesFor(C).hotChip}
              activeOpacity={0.8}
              onPress={() => onOpenSpotlight({ id: word, name: word, tag: '热搜词', score: 0, gradientType: 'recommend', keyword: word, searchCategory: 'general' })}
            >
              <Text style={stylesFor(C).hotChipText} numberOfLines={1}>{word}</Text>
            </TouchableOpacity>
          )) : (
            <Text style={stylesFor(C).hotEmpty}>暂时没有热词数据</Text>
          )}
        </View>
        <View style={stylesFor(C).subSignalBlock}>
          <View style={stylesFor(C).hotPanelHead}>
            <Text style={stylesFor(C).subSignalTitle}>搜索联想词</Text>
            <Text style={stylesFor(C).subSignalHint}>{signalsLoading ? '同步中…' : '可直接拿来找细分词'}</Text>
          </View>
          <View style={stylesFor(C).hotChipRow}>
            {suggestionChips.length > 0 ? suggestionChips.map((item: { kw: string; total?: number | null }) => (
              <TouchableOpacity
                key={item.kw}
                style={stylesFor(C).hotChipSoft}
                activeOpacity={0.8}
                onPress={() => onOpenSpotlight({ id: item.kw, name: item.kw, tag: '联想词', score: 0, gradientType: 'recommend', keyword: item.kw, searchCategory: 'general' })}
              >
                <Text style={stylesFor(C).hotChipTextSoft} numberOfLines={1}>
                  {item.kw}{item.total != null ? ` · ${item.total}` : ''}
                </Text>
              </TouchableOpacity>
            )) : (
              <Text style={stylesFor(C).hotEmpty}>暂时没有联想词</Text>
            )}
          </View>
        </View>
        <View style={stylesFor(C).subSignalBlock}>
          <View style={stylesFor(C).hotPanelHead}>
            <Text style={stylesFor(C).subSignalTitle}>现成朋友圈文案</Text>
            <Text style={stylesFor(C).subSignalHint}>可直接挪去发圈</Text>
          </View>
          {copyItems.length > 0 ? copyItems.map((item: { title?: string; circleText?: string }, idx: number) => (
            <View key={`${item.title || 'copy'}-${idx}`} style={stylesFor(C).copyCard}>
              <Text style={stylesFor(C).copyTitle} numberOfLines={1}>{item.title || '未命名商品'}</Text>
              <Text style={stylesFor(C).copyText} numberOfLines={2}>{item.circleText || '暂无文案'}</Text>
            </View>
          )) : (
            <Text style={stylesFor(C).hotEmpty}>暂时没有朋友圈文案</Text>
          )}
        </View>
      </View>
      <View style={stylesFor(C).filterPanel}>
        <FilterRow C={C} label="平台" items={platforms} value={platform} onChange={setPlatform} />
        <FilterRow C={C} label="品类" items={categories} value={category} onChange={setCategory} />
        <FilterRow C={C} label="目标" items={goals} value={goal} onChange={setGoal} />
      </View>
      <SectionHeader title="今日推荐方向" action="换一批" onPress={onRefresh} C={C} />
      {loading ? <LoadingState C={C} label="正在同步实时机会" /> : preview.length === 0 ? <EmptyState C={C} text="暂时没有实时机会数据，可先手动诊断一个商品链接" /> : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
          {preview.map((item: HotCategory) => <HotCategoryCard key={item.id} item={item} onPress={() => onOpenSpotlight(item)} />)}
        </ScrollView>
      )}
      <SectionHeader title="下一步" C={C} />
      <View style={stylesFor(C).actionGrid}>
        <Action label="开始商品诊断" description="输入商品链接或名称，先做一次明确判断" onPress={onOpenDiagnose} C={C} />
        <Action label="生成测试内容" description="基于诊断结果写标题、钩子和口播稿" onPress={onOpenPromo} C={C} />
        <Action label="加入测品计划" description={`${planCount || poolCount} 个商品可继续记录发布与数据`} onPress={onOpenTest} C={C} />
        <Action label="打开榜单中心" description="看大淘客实时榜单，按榜挑品更快" onPress={onOpenRanking} C={C} />
      </View>
    </ScrollView>
  )
}

function OpportunityView({ C, groups, totalCount, groupCount, loading, error, search, onSearch, onRefresh, onOpenSpotlight }: any) {
  const total = groups.reduce((n: number, g: OpportunityGroup) => n + g.items.length, 0)
  return (
    <ScrollView contentContainerStyle={stylesFor(C).page} showsVerticalScrollIndicator={false}>
      <WorkspaceContent title="机会" subtitle="按大类分组的实时选品方向" C={C}>
        <View style={stylesFor(C).toolbar}>
          <Text style={stylesFor(C).muted}>
            {loading ? '同步中…' : totalCount ? `已同步 ${totalCount} 个方向 · ${groupCount} 大类` : '等待实时数据'}
          </Text>
          <TouchableOpacity style={stylesFor(C).outlineButton} onPress={onRefresh} disabled={loading}>
            <Text style={stylesFor(C).outlineButtonText}>{loading ? '同步中…' : '刷新'}</Text>
          </TouchableOpacity>
        </View>
        <View style={stylesFor(C).searchRow}>
          <TextInput
            style={stylesFor(C).searchInput}
            value={search}
            onChangeText={onSearch}
            placeholder="搜索方向，如 面膜 / 咖啡 / 运动鞋"
            placeholderTextColor={C.textMuted}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
        {error ? <EmptyState C={C} text={error} /> : loading ? <LoadingState C={C} label="正在同步实时机会" /> : groups.length === 0 ? <EmptyState C={C} text={search ? '没有匹配的方向' : '暂无机会数据'} /> : groups.map((g: OpportunityGroup) => (
          <View key={g.group} style={{ marginBottom: spacing.lg }}>
            <SectionHeader title={g.group} C={C} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
              {g.items.map((item: HotCategory) => (
                <HotCategoryCard
                  key={item.id}
                  item={item}
                  onPress={() => onOpenSpotlight(item)}
                  onShowProducts={() => onOpenSpotlight(item)}
                />
              ))}
            </ScrollView>
          </View>
        ))}
      </WorkspaceContent>
    </ScrollView>
  )
}

function WorkspaceContent({ title, subtitle, C, children }: any) {
  return <ScrollView contentContainerStyle={stylesFor(C).page} showsVerticalScrollIndicator={false}><View style={stylesFor(C).hero}><Text style={stylesFor(C).title}>{title}</Text><Text style={stylesFor(C).subtitle}>{subtitle}</Text></View>{children}</ScrollView>
}

function Metric({ label, value, onPress, C }: any) {
  return <TouchableOpacity style={stylesFor(C).metric} onPress={onPress} activeOpacity={0.8}><Text style={stylesFor(C).metricValue}>{value}</Text><Text style={stylesFor(C).metricLabel}>{label}</Text></TouchableOpacity>
}

function FilterRow({ C, label, items, value, onChange }: any) {
  return (
    <View style={stylesFor(C).filterRow}>
      <Text style={stylesFor(C).filterLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={stylesFor(C).chipTrack}>
        {items.map((item: any) => {
          const active = item.key === value
          return (
            <TouchableOpacity key={item.key} style={[stylesFor(C).chip, active && stylesFor(C).chipActive]} onPress={() => onChange(item.key)} activeOpacity={0.8}>
              <Text style={[stylesFor(C).chipText, active && stylesFor(C).chipTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          )
        })}
      </ScrollView>
    </View>
  )
}

function Action({ label, description, onPress, C }: any) {
  return <TouchableOpacity style={stylesFor(C).action} onPress={onPress} activeOpacity={0.8}><Text style={stylesFor(C).actionLabel}>{label}</Text><Text style={stylesFor(C).actionDescription}>{description}</Text></TouchableOpacity>
}

function SectionHeader({ title, action, onPress, C }: any) {
  return <View style={stylesFor(C).sectionHeader}><Text style={stylesFor(C).sectionTitle}>{title}</Text>{action ? <TouchableOpacity onPress={onPress}><Text style={stylesFor(C).link}>{action}</Text></TouchableOpacity> : null}</View>
}

function LoadingState({ C, label }: any) {
  return <View style={stylesFor(C).state}><ActivityIndicator color={C.primary} /><Text style={stylesFor(C).muted}>{label}</Text></View>
}

function EmptyState({ C, text }: any) {
  return <View style={stylesFor(C).empty}><Text style={stylesFor(C).muted}>{text}</Text></View>
}

function BottomNav({ C, activeTab, onNavigate, onOpenProfile, onOpenTest, onOpenDiagnose }: any) {
  const items = [
    { key: 'overview', label: '机会', icon: '⌁', onPress: () => onNavigate('overview') },
    { key: 'conversation', label: '诊断', icon: '+', onPress: onOpenDiagnose || (() => onNavigate('conversation')) },
    { key: 'pool', label: '测品', icon: '✓', onPress: onOpenTest || (() => onNavigate('pool')) },
    { key: 'mine', label: '我的', icon: '•', onPress: onOpenProfile },
  ]
  return (
    <View style={stylesFor(C).bottomNav}>
      {items.map((item) => {
        const active = item.key === activeTab
        return (
          <TouchableOpacity key={item.key} style={stylesFor(C).bottomNavItem} onPress={item.onPress} activeOpacity={0.8}>
            <Text style={[stylesFor(C).bottomNavIcon, active && stylesFor(C).bottomNavIconActive]}>{item.icon}</Text>
            <Text style={[stylesFor(C).bottomNavText, active && stylesFor(C).bottomNavTextActive]}>{item.label}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

function stylesFor(C: any) {
  return StyleSheet.create({
    page: { padding: spacing.md, paddingBottom: spacing.xl * 3 },
    hero: { padding: spacing.lg, borderRadius: radius.lg, backgroundColor: C.cardBg, borderWidth: 1, borderColor: C.border, marginBottom: spacing.md },
    heroTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    eyebrow: { color: C.primary, fontSize: 10, fontWeight: '800', marginBottom: spacing.xs },
    title: { color: C.textPrimary, fontSize: 22, fontWeight: '800', marginBottom: spacing.xs },
    subtitle: { color: C.textSecondary, fontSize: 13, lineHeight: 20 },
    creditBox: { minWidth: 92, padding: spacing.sm, borderRadius: radius.md, backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.border, alignItems: 'flex-start' },
    creditLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700' },
    creditValue: { color: C.primary, fontSize: 17, fontWeight: '800', marginTop: 2 },
    creditHint: { color: C.textSecondary, fontSize: 11, fontWeight: '700', marginTop: 2 },
    filterPanel: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: C.cardBg, borderWidth: 1, borderColor: C.border, marginBottom: spacing.md, gap: spacing.sm },
    filterRow: { gap: spacing.xs },
    filterLabel: { color: C.textSecondary, fontSize: 12, fontWeight: '800' },
    chipTrack: { gap: spacing.xs, paddingRight: spacing.md },
    chip: { paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: radius.md, backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.border },
    chipActive: { backgroundColor: C.primary, borderColor: C.primary },
    chipText: { color: C.textSecondary, fontSize: 12, fontWeight: '700' },
    chipTextActive: { color: '#fff' },
    metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
    metric: { width: '48%', minHeight: 92, padding: spacing.md, borderRadius: radius.lg, backgroundColor: C.cardBg, borderWidth: 1, borderColor: C.border, justifyContent: 'center' },
    metricValue: { color: C.primary, fontSize: 26, fontWeight: '800' },
    metricLabel: { color: C.textSecondary, fontSize: 12, marginTop: 4 },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm, marginTop: spacing.sm },
    sectionTitle: { color: C.textPrimary, fontSize: 17, fontWeight: '800' },
    link: { color: C.primary, fontSize: 12, fontWeight: '700' },
    hotPanel: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: C.cardBg, borderWidth: 1, borderColor: C.border, marginBottom: spacing.md },
    hotPanelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
    hotChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
    hotChip: { paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: radius.md, backgroundColor: C.primary + '10', borderWidth: 1, borderColor: C.primary + '24' },
    hotChipText: { color: C.primary, fontSize: 12, fontWeight: '700' },
    hotChipSoft: { paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: radius.md, backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.border },
    hotChipTextSoft: { color: C.textSecondary, fontSize: 12, fontWeight: '700' },
    hotEmpty: { color: C.textMuted, fontSize: 12, marginTop: spacing.xs },
    subSignalBlock: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: C.border },
    subSignalTitle: { color: C.textPrimary, fontSize: 13, fontWeight: '800' },
    subSignalHint: { color: C.textMuted, fontSize: 11, fontWeight: '600' },
    copyCard: { marginTop: spacing.sm, padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: C.border, backgroundColor: C.pageBg },
    copyTitle: { color: C.textPrimary, fontSize: 12, fontWeight: '700' },
    copyText: { color: C.textSecondary, fontSize: 11.5, lineHeight: 16, marginTop: 4 },
    actionGrid: { gap: spacing.sm },
    action: { padding: spacing.md, borderRadius: radius.lg, backgroundColor: C.cardBg, borderWidth: 1, borderColor: C.border },
    actionLabel: { color: C.textPrimary, fontSize: 14, fontWeight: '700' },
    actionDescription: { color: C.textMuted, fontSize: 12, marginTop: 4 },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
    outlineButton: { borderWidth: 1, borderColor: C.primary, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 7 },
    outlineButtonText: { color: C.primary, fontSize: 12, fontWeight: '700' },
    // 机会页搜索框
    searchRow: { marginBottom: spacing.md },
    searchInput: {
      backgroundColor: C.pageBg,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      fontSize: 13,
      color: C.textPrimary,
    },
    muted: { color: C.textMuted, fontSize: 13, lineHeight: 20 },
    state: { minHeight: 100, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
    empty: { padding: spacing.lg, borderRadius: radius.lg, backgroundColor: C.cardBg, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
    // 相关商品弹层（底部 sheet）
    pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: C.cardBg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: Platform.OS === 'ios' ? 28 : spacing.lg,
    },
    sheetFloat: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    sheetHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: spacing.md },
    sheetTitle: { fontSize: 17, fontWeight: '700', color: C.textPrimary },
    sheetClose: { fontSize: 22, color: C.textSecondary, lineHeight: 26 },
    // 弹层内本机搜索 + 刷新
    sheetToolbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
    sheetSearchBox: { flex: 1, backgroundColor: C.pageBg, borderWidth: 1, borderColor: C.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
    sheetSearchInput: { fontSize: 16, color: C.textPrimary, outlineStyle: 'none' as any }, // ≥16 防 iOS 聚焦智能缩放；RN-Web 去掉聚焦黄圈
    sheetRefreshBtn: { borderWidth: 1, borderColor: C.primary, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
    sheetRefreshText: { color: C.primary, fontSize: 12, fontWeight: '700' },
    bottomNav: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-around',
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.sm,
      paddingBottom: Platform.OS === 'ios' ? 22 : spacing.sm,
      backgroundColor: C.cardBg,
      borderTopWidth: 1,
      borderTopColor: C.border,
    },
    bottomNavItem: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 2 },
    bottomNavIcon: { color: C.textMuted, fontSize: 17, fontWeight: '800', lineHeight: 18 },
    bottomNavIconActive: { color: C.primary },
    bottomNavText: { color: C.textMuted, fontSize: 11, fontWeight: '700' },
    bottomNavTextActive: { color: C.primary },
  })
}

const styles = StyleSheet.create({})

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
    placeholder: { flex: 1, padding: spacing.xl },
    // Tab 面板常驻容器：非激活时隐藏（display:none），激活时显示（2026-08-26 修复对话丢失）
    tabPane: {
      display: 'none',
    },
    tabPaneActive: {
      display: 'flex',
      flex: 1,
    },
  })
}
