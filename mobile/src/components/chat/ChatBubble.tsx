import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Image, View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native'
import { colors, dark, radius, spacing, motion } from '../../theme'
import { useTheme, EASE } from '../../utils/theme'
import { useReducedMotion } from '../../utils/useReducedMotion'
import { FadeInView } from '../Motion'
import { ChatMessage } from '../../utils/types'
import zgoAvatar from '../../../assets/brand/zgo-ai-avatar.jpg'
import { OpportunityCard } from '../cards/OpportunityCard'
import { DataInsightCard } from '../cards/DataInsightCard'
import { RiskCard } from '../cards/RiskCard'
import { NextActionsCard } from '../cards/NextActionsCard'
import { HotCategoryCard } from '../cards/HotCategoryCard'
import { HotPickCard } from '../cards/HotPickCard'
import { ProductDirectionCard } from '../cards/ProductDirectionCard'
import { ProductCard } from '../cards/ProductCard'
import { TrendCard } from '../cards/TrendCard'
import { LinkDiagnosisCard } from '../cards/LinkDiagnosisCard'
import { ActionAdviceCard } from '../cards/ActionAdviceCard'

type BubbleStyleSet = ReturnType<typeof buildStyles>
/** buildStyles 实际用到的配色键（浅/暗共有），结构性兼容 colors 与 dark */
type ColorSet = {
  primary: string
  pageBg: string
  border: string
  textMuted: string
  textSecondary: string
  textPrimary: string
}

interface Props {
  message: ChatMessage
  streaming?: boolean
  onSend?: (text: string) => void
  onEdit?: (text: string) => void
  onRegenerate?: (msgId: string, text: string) => void
  userId?: string | null
  isMember?: boolean
  unlocking?: boolean
  onUnlock?: (msgId: string) => void
  onLogin?: () => void
  onOpenRecharge?: () => void
  /** 支付总开关（2026-08-28 免费引流策略）：false 时卡片解锁提示改为免费语义，不引导充值。 */
  paymentEnabled?: boolean
  /** 商品介绍弹层关闭后触发，刷新免费次数（今日免费剩 N 次实时更新）。 */
  onIntroClosed?: () => void
}

// 单行思考：轻量打字机（12ms/字）；回答开始(frozen)后即刻显示全文、停止动画与光标，
// 避免「回答区已出完、思考面板还在逐字流」的割裂感。终端滚动条里旧行上移、顶部被裁切省略。
const ThinkingLine = ({ text, showCursor, frozen, s }: { text: string; showCursor?: boolean; frozen?: boolean; s: BubbleStyleSet }) => {
  const [shown, setShown] = useState(frozen ? text : '')
  const [done, setDone] = useState(!!frozen)
  useEffect(() => {
    if (frozen) { setShown(text); setDone(true); return }
    let i = 0
    const id = setInterval(() => {
      i += 1
      setShown(text.slice(0, i))
      if (i >= text.length) { clearInterval(id); setDone(true) }
    }, 12)
    return () => clearInterval(id)
  }, [text, frozen])
  return (
    <View style={s.thinkingRow}>
      <View style={s.thinkingDot} />
      <Text style={s.thinkingStep}>
        {shown}
        {showCursor && !done && <Text style={s.thinkingCursor}>▍</Text>}
      </Text>
    </View>
  )
}

// 活体「分析中」指示：步骤流完、顾问文字尚未开始流出时显示（模块级）
const ThinkingDots = ({ s }: { s: BubbleStyleSet }) => {
  const [n, setN] = useState(1)
  useEffect(() => {
    const id = setInterval(() => setN(v => (v % 3) + 1), 480)
    return () => clearInterval(id)
  }, [])
  return (
    <View style={s.thinkingRow}>
      <View style={s.thinkingDot} />
      <Text style={s.thinkingStep}>正在分析{'.'.repeat(n)}</Text>
    </View>
  )
}

// 流式输出末段打字光标：opacity 1s 呼吸 loop（仅非 reduce-motion；reduce 直接就位、无光标）
const StreamCursor = ({ s }: { s: BubbleStyleSet }) => {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 500, useNativeDriver: true, easing: EASE.decelerate }),
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true, easing: EASE.standard }),
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [opacity])
  return <Text style={[s.streamCursor, { opacity }]}>▍</Text>
}

// 轻量 markdown 渲染：支持 **加粗** 与 - / * 列表（去 AI-slop，避免裸显 ** 星号）
const BOLD_RE = /\*\*(.+?)\*\*/g

function renderInline(text: string, keyBase: string, s: BubbleStyleSet): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  BOLD_RE.lastIndex = 0
  let i = 0
  while ((m = BOLD_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(<Text key={`${keyBase}-b${i}`} style={s.aiTextBold}>{m[1]}</Text>)
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function renderRichText(content: string, s: BubbleStyleSet): React.ReactNode {
  if (!content) return null
  const blocks = content.split(/\n{2,}/)
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split('\n')
        const isList = lines.length > 0 && lines.every((l) => /^\s*[-*]\s+/.test(l))
        if (isList) {
          return (
            <React.Fragment key={bi}>
              {lines.map((l, li) => {
                const item = l.replace(/^\s*[-*]\s+/, '')
                return (
                  <Text key={li}>{'· '}{renderInline(item, `b${bi}-${li}`, s)}{'\n'}</Text>
                )
              })}
              {'\n'}
            </React.Fragment>
          )
        }
        return (
          <React.Fragment key={bi}>
            {lines.map((l, li) => (
              <React.Fragment key={li}>
                {renderInline(l, `p${bi}-${li}`, s)}
                {li < lines.length - 1 ? '\n' : null}
              </React.Fragment>
            ))}
            {'\n\n'}
          </React.Fragment>
        )
      })}
    </>
  )
}

export function ChatBubble({ message, streaming, onSend, userId, isMember, unlocking, onUnlock, onEdit, onRegenerate, onLogin, onOpenRecharge, onIntroClosed, paymentEnabled }: Props) {
  const isUser = message.role === 'user'
  const reduce = useReducedMotion()
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])

  const renderOneCard = (card: any, key: number | string) => {
    switch (card.cardType) {
      case 'next_actions':
        return <NextActionsCard key={key} data={card.cardData} />
      case 'opportunity':
        return <OpportunityCard key={key} data={card.cardData} onShowProducts={() => onSend?.(`帮我推荐 ${card.cardData.title} 的实时选品商品`)} />
      case 'data_insight':
        return <DataInsightCard key={key} data={card.cardData} />
      case 'risk':
        return <RiskCard key={key} data={card.cardData} />
      case 'product_direction':
        return <ProductDirectionCard key={key} data={card.cardData} onSend={onSend} userId={userId} />
      case 'product':
        return <ProductCard key={key} items={card.cardData} userId={userId} />
      case 'trend':
        return <TrendCard key={key} data={card.cardData} />
      case 'link_diagnosis':
        return <LinkDiagnosisCard key={key} data={card.cardData} />
      case 'action_advice':
        return <ActionAdviceCard key={key} data={card.cardData} />
      case 'hot_category':
        return (
          <View key={key} style={S.hotRow}>
            {Array.isArray(card.cardData) &&
              card.cardData.map((item: any) => (
                <HotCategoryCard
                  key={item.id}
                  item={item}
                  onPress={() => onSend?.(`帮我详细分析 ${item.name} 这个方向`)}
                  onShowProducts={() => onSend?.(`帮我推荐 ${item.name} 的实时选品商品`)}
                />
              ))}
          </View>
        )
      case 'hot_pick':
        return <HotPickCard key={key} data={card.cardData} onSend={onSend} onIntroClosed={onIntroClosed} />
      default:
        return null
    }
  }

  // 深度思考面板（终端风格折叠条）：固定高度滚动区，新行出现在底部、旧行上移、顶部被裁切省略；
  // 默认折叠为紧凑滚动条，点「展开 N 步」看完整思维链。回答开始(frozen)后所有行冻结为静态全文，
  // 不再有打字动画/光标，根除「回答区已出完、思考面板还在思考」的割裂。
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const thinkingSteps = message.thinkingSteps || []
  const scrollRef = useRef<ScrollView>(null)
  const answerStarted = !!message.content
  // 仅"流中 且 回答还没出"才显示分析中；流结束(streaming=false)或回答已开始 → 思考面板彻底静止
  const analyzing = thinkingSteps.length > 0 && !answerStarted && !!streaming
  // 回答已开始 或 流已结束 → 所有思考行冻结为静态全文（停打字/停光标），根除"回答完了还在思考"
  const frozen = answerStarted || !streaming

  // 折叠态：思考步骤变化即自动滚到底（最新行可见、顶部省略）
  useEffect(() => {
    if (!thinkingOpen && scrollRef.current) {
      scrollRef.current.scrollToEnd({ animated: true })
    }
  }, [thinkingSteps.length, thinkingOpen])

  const renderThinking = () => {
    if (thinkingSteps.length === 0) return null
    return (
      <View style={S.thinkingWrap}>
        <TouchableOpacity style={S.thinkingHeader} onPress={() => setThinkingOpen(o => !o)} activeOpacity={0.8}>
          <View style={S.thinkingTitleRow}>
            <View style={S.thinkingBadge} />
            <Text style={S.thinkingTitle}>深度思考</Text>
            {analyzing && (
              <View style={S.thinkingLive}>
                <View style={S.thinkingLiveDot} />
                <Text style={S.thinkingLiveText}>分析中</Text>
              </View>
            )}
          </View>
          <Text style={S.thinkingToggle}>{thinkingOpen ? '收起 ▲' : `展开 ${thinkingSteps.length} 步 ▼`}</Text>
        </TouchableOpacity>
        <ScrollView
          ref={scrollRef}
          style={[S.thinkingScroll, thinkingOpen ? S.thinkingScrollOpen : S.thinkingScrollCollapsed]}
          contentContainerStyle={S.thinkingScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {thinkingSteps.map((step, i) => (
            <ThinkingLine
              key={i}
              text={step}
              showCursor={i === thinkingSteps.length - 1 && analyzing}
              frozen={frozen}
              s={S}
            />
          ))}
          {analyzing && <ThinkingDots s={S} />}
        </ScrollView>
      </View>
    )
  }

  return (
    <View style={S.container}>
      {isUser ? (
        <View style={S.userWrap}>
          <View style={S.userBubble}>
            <Text style={S.userText}>{message.content}</Text>
          </View>
          {(onEdit || onRegenerate) && (
            <View style={S.userActions}>
              {onRegenerate && (
                <TouchableOpacity
                  style={S.userActionBtn}
                  onPress={() => onRegenerate(message.id, message.content)}
                  activeOpacity={0.7}
                >
                  <Text style={S.userActionText}>↻ 刷新</Text>
                </TouchableOpacity>
              )}
              {onEdit && (
                <TouchableOpacity
                  style={S.userActionBtn}
                  onPress={() => onEdit(message.content)}
                  activeOpacity={0.7}
                >
                  <Text style={S.userActionText}>✎ 修改</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      ) : (
        <View style={S.aiContainer}>
          {renderThinking()}
          {message.content ? (
        <FadeInView duration={motion.duration.staggerItem} style={S.aiRowWrap}>
          {/* AI 侧头像：ZGo 气泡星标 */}
          <Image source={zgoAvatar} style={S.aiAvatar} resizeMode="cover" />
          <View style={S.aiBubble}>
            {/* 中度升级：品牌色左边 3px 强调条（在 paddingBox 内层 absolute 叠） */}
            <View style={S.aiAccent} />
            <Text style={[S.aiText, { position: 'relative' }]}>
              {renderRichText(message.content, S)}
              {streaming && !frozen && !reduce ? <StreamCursor s={S} /> : null}
            </Text>
          </View>
        </FadeInView>
          ) : null}
          <View style={S.cards}>
            {(message.cards || []).map((c, i) => (
              <FadeInView key={typeof c === 'object' && c.cardData?.id ? c.cardData.id : `card-${i}`} delay={i * 60} style={S.cardFade}>
                {renderOneCard(c, i)}
              </FadeInView>
            ))}
          </View>

          {/* 出卡提示（方案 A：匿名 / 免费卡片额度耗尽时下发，消除静默无卡困惑） */}
          {message.cardHint ? (
            <View style={S.cardHint}>
              <View style={S.cardHintDot} />
              {unlocking ? (
                <Text style={S.cardHintText}>卡片解锁中…</Text>
              ) : (
                <>
                  <Text style={S.cardHintText}>{message.cardHint}</Text>
                  <TouchableOpacity
                    style={S.cardHintBtn}
                    onPress={() => {
                      if (isMember) onUnlock?.(message.id)
                      else if (userId) paymentEnabled ? onOpenRecharge?.() : onLogin?.()
                      else onLogin?.()
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={S.cardHintBtnText}>{isMember ? '解锁查看 ›' : (userId ? (paymentEnabled ? '充值查看 ›' : '免费额度用完 ›') : '登录查看 ›')}</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          ) : null}

          {/* 续问按钮 */}
          {message.followUpQuestions && message.followUpQuestions.length > 0 && (
            <View style={S.followUpContainer}>
              {message.followUpQuestions.map((q, idx) => (
                <FadeInView key={idx} delay={idx * 80} style={S.followUpFade}>
                  <TouchableOpacity
                    style={S.followUpBtn}
                    onPress={() => onSend?.(q)}
                    activeOpacity={0.75}
                  >
                    <Text style={S.followUpArrow}>→</Text>
                    <Text style={S.followUpText}>{q}</Text>
                  </TouchableOpacity>
                </FadeInView>
              ))}
            </View>
          )}

          {/* 计费回执（硅基流动风格透明计费）：模型 · 输入/输出 token · 花费 · 免费额度内 */}
          {message.usage && (
            <View style={S.usageRow}>
              <View style={[S.usageDot, message.usage.is_free ? S.usageDotFree : S.usageDotPaid]} />
              <Text style={S.usageText}>
                {message.usage.model ? message.usage.model.split('/').pop() : 'AI'} ·{' '}
                输入 {message.usage.tokens_in ?? 0} / 输出 {message.usage.tokens_out ?? 0} tokens
                {' · '}
                {message.usage.is_free
                  ? '免费额度内'
                  : `¥${(message.usage.cost_yuan ?? 0).toFixed(5)}`}
              </Text>
              {message.usage.free_remaining != null && (
                <Text style={S.usageFree}>· 今日免费剩 {message.usage.free_remaining}</Text>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  )
}

function buildStyles(C: ColorSet, isDark: boolean) {
  // 轻玻璃（P1）：AI 气泡 / 思考面板 / cardHint / followUp 用 12-16px 低 alpha 玻璃 + 发丝边框，正文恒落实色高对比层
  const glassCard = {
    backgroundColor: isDark ? 'rgba(15,26,46,0.72)' : 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: isDark ? 'rgba(33,48,74,0.9)' : 'rgba(226,232,240,0.9)',
    ...Platform.select({
      web: {
        backdropFilter: 'blur(12px) saturate(130%)',
        WebkitBackdropFilter: 'blur(12px) saturate(130%)',
      },
      default: {},
    }),
  }
  return StyleSheet.create({
    container: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    userBubble: {
      alignSelf: 'flex-end',
      maxWidth: '80%',
      backgroundColor: C.primary,
      borderRadius: radius.lg,
      // 中度升级：右下圆角进一步缩小（4→6），让用户气泡更"像消息"而非卡片
      borderBottomRightRadius: 6,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      // 中度升级：品牌色蓝色阴影（与 ui-life 原型一致：0 6px 16px rgba(59,130,246,.30)）
      shadowColor: C.primary,
      shadowOpacity: isDark ? 0.40 : 0.32,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    userWrap: {
      alignItems: 'flex-end',
    },
    userActions: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: 4,
    },
    userActionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: C.pageBg,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
    },
    userActionText: {
      fontSize: 12,
      color: C.primary,
      fontWeight: '600',
    },
    userText: {
      fontSize: 15,
      color: '#fff',
      lineHeight: 22,
    },
    aiContainer: {
      alignSelf: 'flex-start',
      width: '100%',
    },
    // AI 行：头像 + 气泡横向排布
    aiRowWrap: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
    },
    // AI 头像：ZGo 气泡星标圆形
    aiAvatar: {
      width: 26,
      height: 26,
      borderRadius: 13,
      marginTop: 4,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(33,48,74,0.9)' : 'rgba(226,232,240,0.9)',
    },
    thinkingWrap: {
      alignSelf: 'flex-start',
      width: '92%',
      ...glassCard,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      marginBottom: spacing.sm,
    },
    thinkingHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    thinkingTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: C.primary,
    },
    thinkingTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    thinkingBadge: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: C.textMuted,
    },
    thinkingLive: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: C.textMuted + '1A',
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    thinkingLiveDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: C.textMuted,
    },
    thinkingLiveText: {
      fontSize: 11,
      color: C.textMuted,
      fontWeight: '600',
    },
    thinkingToggle: {
      fontSize: 12,
      color: C.textMuted,
    },
    thinkingScroll: {
      marginTop: spacing.sm,
    },
    thinkingScrollCollapsed: {
      maxHeight: 64,
    },
    thinkingScrollOpen: {
      maxHeight: 220,
    },
    thinkingScrollContent: {
      paddingBottom: 2,
      gap: spacing.sm,
    },
    thinkingRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    thinkingDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: C.textMuted,
      marginTop: 6,
    },
    thinkingStep: {
      flex: 1,
      fontSize: 12.5,
      color: C.textSecondary,
      lineHeight: 18,
    },
    thinkingCursor: {
      color: C.primary,
      fontWeight: '700',
    },
    streamCursor: {
      color: C.primary,
      fontWeight: '700',
    },
    aiBubble: {
      position: 'relative',
      alignSelf: 'flex-start',
      maxWidth: '90%',
      borderRadius: radius.lg,
      overflow: 'hidden',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      marginBottom: spacing.sm,
      // P1：AI 气泡轻玻璃（文字落实色层，对比度优先）；深浅各一套
      ...glassCard,
      shadowColor: isDark ? '#000' : '#0F172A',
      shadowOpacity: isDark ? 0.35 : 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 3,
    },
    // 中度升级：AI 气泡左侧 3px 品牌色强调条（与对话工作台主蓝身份呼应）
    aiAccent: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      backgroundColor: C.primary,
    },
    aiText: {
      fontSize: 15,
      color: C.textPrimary,
      lineHeight: 22,
    },
    aiTextBold: {
      fontWeight: '700',
      color: C.textPrimary,
    },
    cards: {
      width: '100%',
    },
    cardFade: {
      width: '100%',
      marginBottom: spacing.sm,
    },
    cardHint: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      ...glassCard,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginTop: spacing.sm,
    },
    cardHintDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: C.primary,
    },
    cardHintText: {
      flex: 1,
      fontSize: 13,
      color: C.textSecondary,
      lineHeight: 18,
    },
    cardHintBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      backgroundColor: C.primary + '12',
      borderRadius: 999,
    },
    cardHintBtnText: {
      fontSize: 12.5,
      fontWeight: '600',
      color: C.primary,
    },
    // 计费回执（硅基流动风格透明计费）
    usageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      marginTop: spacing.sm,
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: isDark ? 'rgba(33,48,74,0.7)' : 'rgba(226,232,240,0.8)',
    },
    usageDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      marginRight: 6,
    },
    usageDotFree: {
      backgroundColor: '#16a34a',
    },
    usageDotPaid: {
      backgroundColor: '#b8860b',
    },
    usageText: {
      fontSize: 11.5,
      color: C.textMuted,
      fontWeight: '500',
    },
    usageFree: {
      fontSize: 11.5,
      color: C.textMuted,
      marginLeft: 4,
    },
    hotRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: spacing.sm,
      gap: spacing.sm,
    },
    followUpContainer: {
      marginTop: spacing.sm,
      paddingHorizontal: spacing.sm,
      gap: spacing.sm,
    },
    followUpFade: {
      width: '100%',
    },
    followUpBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      ...glassCard,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      gap: spacing.sm,
    },
    followUpArrow: {
      fontSize: 13,
      color: C.primary,
      fontWeight: '600',
    },
    followUpText: {
      fontSize: 13,
      color: C.textPrimary,
      flex: 1,
      lineHeight: 18,
    },
  })
}
