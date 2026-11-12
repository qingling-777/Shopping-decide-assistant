import React, { useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native'
import { colors, dark, radius, spacing, gradients, motion } from '../theme'
import { useTheme, EASE } from '../utils/theme'
import { useReducedMotion } from '../utils/useReducedMotion'
import { ScreenFrame } from '../components/ScreenFrame'
import { CountUp } from '../components/CountUp'
import { FadeInView } from '../components/Motion'

const SCRIPTS = [
  { h: '烂脸→稳定对比', b: '实拍 14 天记录，弱化参数，强化「素颜敢出门」的体感。' },
  { h: '成分科普反常识', b: '「修护不是猛药」切入，建立专业信任后再给购买理由。' },
  { h: '医生背书短句', b: '15 秒口播+字幕，规避绝对化用语，合规又显权威。' },
]
const TIMELINE = [
  { w: '第 1–3 天 · 种草', d: '小红书测评+成分科普铺设，积累搜索词' },
  { w: '第 4–10 天 · 放量', d: '抖音/快手短视频矩阵，A/B 测钩子' },
  { w: '第 11–18 天 · 直播', d: '达人直播转化，组合装+订阅钩子' },
]
const CHANNELS = [
  { name: '抖音', pct: 42 },
  { name: '小红书', pct: 30 },
  { name: '快手', pct: 18 },
  { name: 'B站', pct: 10 },
]

export function PlanScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [c1, c2, c3] = gradients.recommend
  const reduce = useReducedMotion()
  // 渠道预算条 scaleX 生长入场（apple ease）；reduce 直接就位
  const chanScale = useRef(new Animated.Value(reduce ? 1 : 0)).current
  useEffect(() => {
    if (reduce) {
      chanScale.setValue(1)
      return
    }
    Animated.timing(chanScale, { toValue: 1, duration: motion.duration.page, easing: EASE.apple, useNativeDriver: true }).start()
  }, [reduce, chanScale])
  return (
    <ScreenFrame visible={visible} onClose={onClose} title="推广方案">
      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.tag, { color: '#fff', backgroundColor: c1 }]}>方案</Text>
          <Text style={[styles.kicker, { color: C.textMuted }]}>敏感肌修护精华 · 30 天</Text>
        </View>
        <View style={styles.metrics}>
          <Metric label="内容脚本" value={3} suffix="" />
          <Metric label="投放周期" value={18} suffix="天" />
          <Metric label="预算建议" value={2.4} decimals={1} prefix="¥" suffix="万" />
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.tag, { color: '#fff', backgroundColor: `rgb(14,165,233)` }]}>脚本</Text>
          <Text style={[styles.kicker, { color: C.textMuted }]}>前 3 秒钩子</Text>
        </View>
        {SCRIPTS.map((s, i) => (
          <FadeInView key={i} delay={i * 60} style={styles.script}>
            <View style={[styles.sIdx, { backgroundColor: C.primary + '1F', }] }><Text style={[styles.sIdxText, { color: C.primary }]}>{i + 1}</Text></View>
            <View style={styles.sBody}>
              <Text style={[styles.sH, { color: C.textPrimary }]}>{s.h}</Text>
              <Text style={[styles.sB, { color: C.textSecondary }]}>{s.b}</Text>
            </View>
          </FadeInView>
        ))}
      </View>

      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.tag, { color: '#fff', backgroundColor: c1 }]}>节奏</Text>
          <Text style={[styles.kicker, { color: C.textMuted }]}>投放节奏</Text>
        </View>
        {TIMELINE.map((t, i) => (
          <FadeInView key={i} delay={i * 60} style={styles.tl}>
            <View style={[styles.tlDot, { backgroundColor: C.primary }]} />
            <Text style={[styles.tW, { color: C.textPrimary }]}>{t.w}</Text>
            <Text style={[styles.tD, { color: C.textMuted }]}>{t.d}</Text>
          </FadeInView>
        ))}
      </View>

      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.tag, { color: '#fff', backgroundColor: c1 }]}>渠道</Text>
          <Text style={[styles.kicker, { color: C.textMuted }]}>预算分配</Text>
        </View>
        {CHANNELS.map((ch, i) => (
          <View key={i} style={styles.chanRow}>
            <Text style={[styles.chanName, { color: C.textSecondary }]}>{ch.name}</Text>
            <View style={[styles.bar, { backgroundColor: C.borderLight }]}>
              <Animated.View style={[styles.barFill, { width: `${ch.pct}%`, backgroundColor: c1, transform: [{ scaleX: chanScale }] }]} />
            </View>
            <Text style={[styles.chanPct, { color: C.textMuted }]}>{ch.pct}%</Text>
          </View>
        ))}
        <View style={styles.btnRow}>
          <TouchableOpacity activeOpacity={0.85} style={[styles.btn, styles.btnGhost, { borderColor: C.border, backgroundColor: C.cardBg }]}>
            <Text style={[styles.btnText, { color: C.textPrimary }]}>导出方案</Text>
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.85} style={[styles.btn, styles.btnPrimary, { backgroundColor: C.primary }]}>
            <Text style={styles.btnTextLight}>生成脚本</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ScreenFrame>
  )
}

function Metric({ label, value, decimals = 0, prefix = '', suffix = '' }: { label: string; value: number; decimals?: number; prefix?: string; suffix?: string }) {
  const { colors: C } = useTheme()
  return (
    <View style={styles.metric}>
      <Text style={[styles.mNum, { color: C.primary }]}>
        <CountUp value={value} decimals={decimals} prefix={prefix} suffix={suffix} />
      </Text>
      <Text style={styles.mLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 14, marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.35)', ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  tag: { fontSize: 11, fontWeight: '800', paddingHorizontal: 9, paddingVertical: 2, borderRadius: 999 },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  metrics: { flexDirection: 'row', gap: 10 },
  metric: { flex: 1, alignItems: 'center', backgroundColor: colors.borderLight, borderRadius: radius.md, paddingVertical: 12 },
  mNum: { fontSize: 19, fontWeight: '800' },
  mLabel: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  script: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  sIdx: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sIdxText: { fontSize: 12, fontWeight: '800' },
  sBody: { flex: 1 },
  sH: { fontSize: 13, fontWeight: '700' },
  sB: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  tl: { paddingLeft: 18, paddingBottom: 14, position: 'relative' },
  tlDot: { position: 'absolute', left: 0, top: 6, width: 10, height: 10, borderRadius: 5 },
  tW: { fontSize: 13, fontWeight: '700' },
  tD: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  chanRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  chanName: { width: 56 },
  bar: { flex: 1, height: 8, borderRadius: 999, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999 },
  chanPct: { width: 38, textAlign: 'right' },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  btn: { flex: 1, paddingVertical: 11, borderRadius: radius.md, alignItems: 'center' },
  btnGhost: { borderWidth: 1 },
  btnPrimary: {},
  btnText: { fontSize: 13, fontWeight: '700' },
  btnTextLight: { fontSize: 13, fontWeight: '700', color: '#fff' },
})
