import React, { useEffect, useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { colors, dark, radius, spacing, gradients, motion } from '../theme'
import { useTheme } from '../utils/theme'
import { ScreenFrame } from '../components/ScreenFrame'
import { FadeInView, HoverLift } from '../components/Motion'
import { CountUp } from '../components/CountUp'
import { ChatMessage } from '../utils/types'

/** 本机会话（与 ReportModal 同源：localStorage chat_sessions） */
interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

function loadSessions(): ChatSession[] {
  if (typeof localStorage === 'undefined') return []
  const keys = ['chat_sessions', 'chat_sessions_anonymous']
  let all: ChatSession[] = []
  for (const k of keys) {
    try {
      const arr = JSON.parse(localStorage.getItem(k) || '[]')
      if (Array.isArray(arr)) all = all.concat(arr)
    } catch {
      /* ignore */
    }
  }
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

/**
 * 选品报告详情（#9，中性蓝 + 金"深度报告·会员专享" badge 微光）：hero 渐变卡视差 + 指标 count-up 弹性尾段 + 金 badge 微光 + 风险/链接 hover 磁性。
 * 金仅用于"会员专享" badge（硬约束 5：金=会员语义）。全站蓝系用主蓝→亮蓝。
 */
export function SelectionReportScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [c1, c2, c3] = gradients.hero

  // 历史对话生成报告（原 ReportModal 能力合入）：打开时读本机会话
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [active, setActive] = useState<ChatSession | null>(null)
  useEffect(() => {
    if (!visible) {
      setActive(null)
      return
    }
    setSessions(loadSessions())
  }, [visible])

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="选品报告">
      {/* 会话报告（真数据）：从本机对话记录生成 */}
      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.tag, { color: '#fff', backgroundColor: c1 }]}>历史</Text>
          <Text style={[styles.kicker, { color: C.textMuted }]}>从对话生成报告</Text>
        </View>
        {active ? (
          <View>
            <TouchableOpacity activeOpacity={0.8} onPress={() => setActive(null)} style={styles.backRow}>
              <Text style={[styles.backText, { color: C.primary }]}>‹ 返回列表</Text>
            </TouchableOpacity>
            <Text style={[styles.reportTitle, { color: C.textPrimary }]}>{active.title || '未命名对话'}</Text>
            <ScrollView style={styles.reportList}>
              {active.messages.map((m, i) => (
                <View key={m.id || i} style={[styles.msgBlock, { borderColor: C.borderLight }]}>
                  <Text style={[styles.msgRole, m.role === 'user' ? { color: C.primary } : { color: C.goldDeep }]}>
                    {m.role === 'user' ? '你' : 'AI 选品顾问'}
                  </Text>
                  {m.content ? <Text style={[styles.msgContent, { color: C.textPrimary }]}>{m.content}</Text> : null}
                  {(m.cards || []).map((c: any, ci: number) => (
                    <View key={ci} style={[styles.cardChip, { backgroundColor: C.pageBg }]}>
                      <Text style={[styles.cardChipType, { color: C.textSecondary }]}>{c.cardType || '卡片'}</Text>
                      {c.cardData?.title ? <Text style={[styles.cardChipTitle, { color: C.textPrimary }]} numberOfLines={1}>{c.cardData.title}</Text> : null}
                    </View>
                  ))}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : sessions.length > 0 ? (
          <ScrollView style={styles.reportList}>
            {sessions.map((s) => (
              <TouchableOpacity key={s.id} activeOpacity={0.8} onPress={() => setActive(s)} style={[styles.sessRow, { borderBottomColor: C.borderLight }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.sessTitle, { color: C.textPrimary }]} numberOfLines={1}>{s.title || '未命名对话'}</Text>
                  <Text style={[styles.sessSub, { color: C.textMuted }]}>{s.messages?.length || 0} 条消息 · {new Date(s.updatedAt || 0).toLocaleString()}</Text>
                </View>
                <Text style={[styles.sessArrow, { color: C.textMuted }]}>›</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        ) : (
          <Text style={[styles.note, { color: C.textSecondary }]}>还没有可导出的对话。在首页和 AI 聊一轮选品，这里的记录就能生成报告。</Text>
        )}
      </View>

      {/* hero 渐变卡（蓝系，主蓝→亮蓝） */}
      <FadeInView duration={motion.duration.staggerItem} style={[styles.hero, { backgroundColor: C.primary }]}>
        <LinearGradient colors={gradients.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <Text style={styles.heroTitle}>敏感肌修护精华</Text>
        <Text style={styles.heroSub}>2026-08 选品深度报告 · 基于三平台公开带货数据</Text>
        {/* 金 badge：仅"深度报告·会员专享"语义（金=会员边界） */}
        <View style={[styles.goldBadge, { backgroundColor: C.gold, shadowColor: C.gold }]}>
          <Text style={styles.goldBadgeText}>深度报告 · 会员专享</Text>
        </View>
      </FadeInView>

      {/* 核心指标：count-up 弹性尾段（useCountUp） */}
      <FadeInView delay={60} duration={motion.duration.staggerItem} style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.tag, { color: '#fff', backgroundColor: c2 }]}>概览</Text>
          <Text style={[styles.kicker, { color: C.textMuted }]}>核心指标</Text>
        </View>
        <View style={styles.metrics}>
          <View style={styles.metric}>
            <Text style={[styles.mNum, { color: C.primary }]}>
              <CountUp value={89} prefix="¥" />–<CountUp value={159} prefix="¥" />
            </Text>
            <Text style={[styles.mLabel, { color: C.textMuted }]}>价格带</Text>
          </View>
          <View style={styles.metric}>
            <Text style={[styles.mNum, { color: C.primary }]}>
              <CountUp value={32} suffix="%" />
            </Text>
            <Text style={[styles.mLabel, { color: C.textMuted }]}>佣金率</Text>
          </View>
          <View style={styles.metric}>
            <Text style={[styles.mNum, { color: C.primary }]}>
              <CountUp value={8.6} decimals={1} suffix="万" />
            </Text>
            <Text style={[styles.mLabel, { color: C.textMuted }]}>月销</Text>
          </View>
        </View>
      </FadeInView>

      <HoverLift>
        <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <View style={styles.cardHead}>
            <Text style={[styles.tag, { color: '#fff', backgroundColor: c1 }]}>方向</Text>
            <Text style={[styles.kicker, { color: C.textMuted }]}>选品结论</Text>
          </View>
          <Row k="推荐价格带" v="89–159 元" C={C} />
          <Row k="目标人群" v="25–35 岁 · 敏感肌" C={C} />
          <Row k="适合平台" v="抖音·快手·小红书" C={C} />
          <Text style={[styles.note, { color: C.textSecondary }]}>内容打法：成分科普 + 真人实测对比 + 医生背书短视频，先种草后直播转化。</Text>
        </View>
      </HoverLift>

      <HoverLift>
        <View style={[styles.card, styles.risk, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <View style={styles.cardHead}>
            <Text style={[styles.tag, { color: '#fff', backgroundColor: C.danger }]}>风险</Text>
            <Text style={[styles.kicker, { color: C.textMuted }]}>需关注</Text>
          </View>
          <Text style={[styles.note, { color: C.textSecondary }]}>赛道新入局商家月增 23%，同质化推高获客成本；「医研」宣称合规边界收紧，素材需规避绝对化用语。</Text>
        </View>
      </HoverLift>

      <HoverLift>
        <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <View style={styles.cardHead}>
            <Text style={[styles.tag, { color: '#fff', backgroundColor: c1 }]}>测评</Text>
            <Text style={[styles.kicker, { color: C.textMuted }]}>联网测评摘要</Text>
          </View>
          <Text style={[styles.note, { color: C.textSecondary }]}>第三方皮肤测试显示 14 天泛红下降 38%；复购窗口集中在第 21–28 天，适合组合装与订阅钩子。</Text>
        </View>
      </HoverLift>

      <HoverLift>
        <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <View style={styles.cardHead}>
            <Text style={[styles.tag, { color: '#fff', backgroundColor: c1 }]}>推广</Text>
            <Text style={[styles.kicker, { color: C.textMuted }]}>附推广方案</Text>
          </View>
          <LinkRow label="30 天推广方案（脚本/节奏/渠道）" C={C} />
          <LinkRow label="参考商品与竞品链接" sub="12 条" C={C} last />
        </View>
      </HoverLift>

      <View style={styles.btnRow}>
        <TouchableOpacity activeOpacity={0.85} style={[styles.btn, styles.btnGhost, { borderColor: C.border, backgroundColor: C.cardBg }]}>
          <Text style={[styles.btnText, { color: C.textPrimary }]}>导出 PDF</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.85} style={[styles.btn, styles.btnPrimary, { backgroundColor: C.primary }]}>
          <Text style={styles.btnTextLight}>加入追踪</Text>
        </TouchableOpacity>
      </View>
    </ScreenFrame>
  )
}

function Row({ k, v, C }: { k: string; v: string; C: any }) {
  return (
    <View style={[styles.row, { borderBottomColor: C.borderLight }]}>
      <Text style={[styles.rk, { color: C.textSecondary }]}>{k}</Text>
      <Text style={[styles.rv, { color: C.textPrimary }]}>{v}</Text>
    </View>
  )
}

function LinkRow({ label, sub, C, last }: { label: string; sub?: string; C: any; last?: boolean }) {
  return (
    <TouchableOpacity activeOpacity={0.8} style={[styles.link, !last && { borderBottomColor: C.borderLight }]}>
      <Text style={[styles.linkLabel, { color: C.textPrimary }]}>{label}</Text>
      <Text style={[styles.linkArrow, { color: C.primary }]}>{sub ? `${sub} ›` : '查看 ›'}</Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  hero: { borderRadius: radius.lg, padding: 16, marginBottom: 14, overflow: 'hidden', shadowColor: colors.primary, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
  heroTitle: { color: '#fff', fontSize: 19, fontWeight: '800' },
  heroSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12, marginTop: 4 },
  goldBadge: { alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  goldBadgeText: { color: '#4a3a12', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 14, marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.35)', ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  tag: { fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  metrics: { flexDirection: 'row', gap: 10 },
  metric: { flex: 1, alignItems: 'center', backgroundColor: colors.borderLight, borderRadius: radius.md, paddingVertical: 12 },
  mNum: { fontSize: 19, fontWeight: '800' },
  mLabel: { fontSize: 11, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1 },
  rk: { fontSize: 13 },
  rv: { fontSize: 13, fontWeight: '700' },
  note: { fontSize: 13, lineHeight: 20, marginTop: 4 },
  risk: { borderLeftWidth: 3, borderLeftColor: colors.danger },
  link: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1 },
  linkLabel: { fontSize: 13, flex: 1 },
  linkArrow: { fontSize: 12, fontWeight: '700' },
  backRow: { paddingVertical: 6 },
  backText: { fontSize: 13, fontWeight: '600' },
  reportTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  reportList: { maxHeight: 320 },
  msgBlock: { marginBottom: 14, paddingLeft: 10, borderLeftWidth: 2 },
  msgRole: { fontSize: 12, fontWeight: '700', marginBottom: 4 },
  msgContent: { fontSize: 13, lineHeight: 19 },
  cardChip: { flexDirection: 'row', alignItems: 'center', marginTop: 6, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  cardChipType: { fontSize: 11, marginRight: 8 },
  cardChipTitle: { fontSize: 12, flex: 1 },
  sessRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1 },
  sessTitle: { fontSize: 14, fontWeight: '600', marginBottom: 2 },
  sessSub: { fontSize: 11 },
  sessArrow: { fontSize: 18, marginLeft: 8 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  btn: { flex: 1, paddingVertical: 11, borderRadius: radius.md, alignItems: 'center' },
  btnGhost: { borderWidth: 1 },
  btnPrimary: {},
  btnText: { fontSize: 13, fontWeight: '700' },
  btnTextLight: { fontSize: 13, fontWeight: '700', color: '#fff' },
})
