import React, { useState, useMemo } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Image, Linking, ScrollView, Platform } from 'react-native'
import { colors, radius, spacing, surfaceTints, darkSurfaceTints, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { LinkDiagnosisCard as LinkDiagnosisData } from '../../utils/types'
import { monetizeAPI } from '../../utils/api'
import { ProvenanceFooter } from './ProvenanceFooter'

type CardStyleSet = ReturnType<typeof buildStyles>
type ColorSet = {
  cardBg: string
  pageBg: string
  border: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  primary: string
  success: string
  warning: string
  danger: string
}

// 价格趋势：用 View 画依赖无关的迷你柱图（无需 react-native-svg）
function PriceSparkline({ points, s, C }: { points: { date: string; price: number }[]; s: CardStyleSet; C: ColorSet }) {
  if (!points || points.length < 2) return null
  const prices = points.map((p) => p.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const up = prices[prices.length - 1] >= prices[0]
  const lineColor = up ? C.primary : C.warning
  return (
    <View style={s.sparkWrap}>
      <View style={s.sparkRow}>
        {prices.map((p, i) => {
          const h = 10 + Math.round(((p - min) / span) * 30)
          return <View key={i} style={[s.sparkBar, { height: h, backgroundColor: lineColor }]} />
        })}
      </View>
      <Text style={s.sparkCaption}>
        {up ? '近采样价格整体上行' : '近采样价格整体下行'}（{points.length} 次采样）
      </Text>
    </View>
  )
}

export function LinkDiagnosisCard({ data }: { data: LinkDiagnosisData }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const T = isDark ? darkSurfaceTints : surfaceTints
  const [privMsg, setPrivMsg] = useState('')
  const [loadingPriv, setLoadingPriv] = useState(false)

  const chips: { label: string; value: string }[] = []
  if (data.priceText) chips.push({ label: '价格', value: data.priceText })
  if (data.couponInfo) chips.push({ label: '券', value: data.couponInfo })
  if (data.commissionRatio != null)
    chips.push({ label: '佣金', value: `${data.commissionRatio}%${data.commissionMoney != null ? ` ≈¥${data.commissionMoney.toFixed(2)}` : ''}` })
  if (data.sales != null) chips.push({ label: '月销', value: `${Math.round(data.sales)}` })

  const onEarn = async () => {
    if (!data.goodsId) {
      setPrivMsg('该品未绑定推广位，暂不能生成分发链接')
      return
    }
    setLoadingPriv(true)
    setPrivMsg('')
    try {
      const res = await monetizeAPI.privilegeLink(data.goodsId)
      const d = res && res.data
      const link = d && (d.shortUrl || d.couponClickUrl || d.tpwd || d.itemUrl || d.url)
      if (link) {
        Linking.openURL(link).catch(() => {})
        setPrivMsg('已用推广位打开，订单归因可在淘宝联盟后台查看')
      } else {
        setPrivMsg('推广位授权已过期，去大淘客后台重授权淘宝账号后自动开通')
      }
    } catch (e) {
      setPrivMsg('转链生成失败，请稍后重试')
    } finally {
      setLoadingPriv(false)
    }
  }

  return (
    <View style={S.card}>
      {/* 头部：平台标签 + 商品名 */}
      <View style={S.head}>
        <View style={[S.platformTag, data.platform === '天猫' ? S.platformTmall : S.platformTaobao]}>
          <Text style={S.platformText}>{data.platform}</Text>
        </View>
        <Text style={S.title} numberOfLines={2}>{data.title}</Text>
      </View>

      {data.image ? (
        <Image source={{ uri: data.image }} style={S.image} resizeMode="cover" />
      ) : null}

      {/* 价 / 佣 / 销 速览 chips */}
      {chips.length > 0 ? (
        <View style={S.chips}>
          {chips.map((c, i) => (
            <View key={i} style={S.chip}>
              <Text style={S.chipLabel}>{c.label}</Text>
              <Text style={S.chipValue}>{c.value}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {data.shop ? (
        <Text style={S.shop}>店铺：{data.shop}</Text>
      ) : null}

      {/* 快速判断（确定性规则） */}
      {data.quickVerdict && data.quickVerdict.length > 0 ? (
        <View style={[S.section, { backgroundColor: T.opportunity.bg, borderColor: T.opportunity.border }]}>
          <Text style={S.sectionTitle}>快速判断</Text>
          {data.quickVerdict.map((v, i) => (
            <Text key={i} style={S.verdictLine}>· {v}</Text>
          ))}
        </View>
      ) : null}

      {/* 历史券后价趋势 */}
      {data.priceTrend && data.priceTrend.sample_count ? (
        <View style={S.section}>
          <Text style={S.sectionTitle}>历史券后价（大淘客）</Text>
          <View style={S.trendRow}>
            {data.priceTrend.min != null ? <Text style={S.trendStat}>最低 ¥{data.priceTrend.min}</Text> : null}
            {data.priceTrend.current != null ? <Text style={S.trendStat}>当前 ¥{data.priceTrend.current}</Text> : null}
            {data.priceTrend.max != null ? <Text style={S.trendStat}>最高 ¥{data.priceTrend.max}</Text> : null}
            {data.priceTrend.avg != null ? <Text style={S.trendStat}>均价 ¥{data.priceTrend.avg}</Text> : null}
          </View>
          <PriceSparkline points={data.priceTrend.points || []} s={S} C={C} />
        </View>
      ) : null}

      {/* 榜单上榜 */}
      {data.ranking ? (
        <View style={[S.rankBadge, { backgroundColor: T.opportunity.bg, borderColor: T.opportunity.border }]}>
          <Text style={S.rankText}>已上榜美妆「{data.ranking.rank_name}」第 {data.ranking.rank} 名，属当前流量红利品类</Text>
        </View>
      ) : null}

      {/* 相似高佣替代 */}
      {data.similar && data.similar.length > 0 ? (
        <View style={S.section}>
          <Text style={S.sectionTitle}>高佣替代（大淘客相似品）</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.simScroll}>
            {data.similar.map((s, i) => (
              <TouchableOpacity
                key={i}
                style={S.simCard}
                activeOpacity={0.8}
                onPress={() => s.link ? Linking.openURL(s.link).catch(() => {}) : {}}
              >
                <Text style={S.simTitle} numberOfLines={2}>{s.title}</Text>
                <View style={S.simMeta}>
                  {s.priceText ? <Text style={S.simPrice}>{s.priceText}</Text> : null}
                  {s.commissionRatio != null ? <Text style={S.simComm}>佣 {s.commissionRatio}%</Text> : null}
                </View>
                {s.sales != null ? <Text style={S.simSales}>月销 {Math.round(s.sales)}</Text> : null}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* 变现 CTA：按需懒加载转链 */}
      <TouchableOpacity
        style={[S.earnBtn, loadingPriv && S.earnBtnLoading]}
        activeOpacity={0.8}
        onPress={onEarn}
        disabled={loadingPriv}
      >
        <Text style={S.earnBtnText}>{loadingPriv ? '生成推广链接…' : '生成推广链接'}</Text>
      </TouchableOpacity>
      {privMsg ? <Text style={S.earnMsg}>{privMsg}</Text> : null}

      {/* 买家口碑 */}
      {data.comments && data.comments.length > 0 ? (
        <View style={S.section}>
          <Text style={S.sectionTitle}>买家口碑（取样前 2 条）</Text>
          {data.comments.map((c, i) => (
            <View key={i} style={S.commentRow}>
              <Text style={S.commentText} numberOfLines={3}>{c.content}</Text>
              {c.rate ? <Text style={S.commentRate}>{c.rate} 星</Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      {/* 溯源脚注 */}
      <ProvenanceFooter
        source={data.source}
        note="价/佣/销/店铺/趋势逐条来自接口返回，非估算"
        defaultSource="大淘客实时联盟数据"
      />
    </View>
  )
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  card: {
    backgroundColor: isDark ? '#0D1424' : '#FFFFFF',
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: isDark ? 'rgba(33,48,74,0.9)' : 'rgba(226,232,240,0.9)',
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
    // 中度升级：hover 抬升 + 主蓝柔光（web）
    ':hover': { transform: [{ translateY: -2 }], borderColor: C.primary + '40' },
  } as any,
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  platformTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginTop: 2,
  },
  platformTmall: { backgroundColor: C.danger + '14' },
  platformTaobao: { backgroundColor: C.warning + '18' },
  platformText: {
    fontSize: 12,
    fontWeight: '700',
    color: C.textPrimary,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: C.textPrimary,
    lineHeight: 22,
  },
  image: {
    width: '100%',
    height: 150,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    backgroundColor: C.pageBg,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  chip: {
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  chipLabel: {
    fontSize: 11,
    color: C.textSecondary,
  },
  chipValue: {
    fontSize: 13,
    fontWeight: '700',
    color: C.textPrimary,
    marginTop: 2,
  },
  shop: {
    fontSize: 12,
    color: C.textSecondary,
    marginBottom: spacing.sm,
  },
  section: {
    backgroundColor: C.pageBg,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: C.border,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: spacing.sm,
  },
  verdictLine: {
    fontSize: 13,
    color: C.textSecondary,
    lineHeight: 19,
  },
  trendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  trendStat: {
    fontSize: 12,
    fontWeight: '600',
    color: C.textPrimary,
  },
  sparkWrap: {
    marginTop: spacing.sm,
  },
  sparkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: 42,
    paddingHorizontal: 2,
  },
  sparkBar: {
    flex: 1,
    borderRadius: 2,
    minWidth: 3,
  },
  sparkCaption: {
    fontSize: 11,
    color: C.textMuted,
    marginTop: 4,
  },
  rankBadge: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
  },
  rankText: {
    fontSize: 13,
    color: C.textPrimary,
    lineHeight: 19,
  },
  simScroll: {
    marginTop: 2,
  },
  simCard: {
    width: 130,
    backgroundColor: C.cardBg,
    borderRadius: radius.md,
    padding: spacing.md,
    marginRight: spacing.sm,
    borderWidth: 1,
    borderColor: C.border,
  },
  simTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: C.textPrimary,
    lineHeight: 16,
    height: 32,
  },
  simMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
  },
  simPrice: {
    fontSize: 12,
    fontWeight: '700',
    color: C.primary,
  },
  simComm: {
    fontSize: 12,
    fontWeight: '700',
    color: C.success,
  },
  simSales: {
    fontSize: 11,
    color: C.textSecondary,
    marginTop: 4,
  },
  earnBtn: {
    marginTop: spacing.lg,
    backgroundColor: C.primary,
    borderRadius: radius.lg,
    paddingVertical: spacing.md + 2,
    alignItems: 'center',
  },
  earnBtnLoading: {
    opacity: 0.6,
  },
  earnBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  earnMsg: {
    fontSize: 12,
    color: C.textSecondary,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  commentRow: {
    marginBottom: spacing.sm,
  },
  commentText: {
    fontSize: 12.5,
    color: C.textSecondary,
    lineHeight: 18,
  },
  commentRate: {
    fontSize: 11,
    color: C.warning,
    marginTop: 2,
  },
  })
}
