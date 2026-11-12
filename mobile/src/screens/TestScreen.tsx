import React, { useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native'
import { colors, dark, radius, spacing, motion } from '../theme'
import { useTheme, EASE } from '../utils/theme'
import { useReducedMotion } from '../utils/useReducedMotion'
import { ScreenFrame } from '../components/ScreenFrame'
import { FadeInView } from '../components/Motion'

const TASKS = [
  { name: '敏感肌修护精华 · 达人 A', meta: '寄样 08-18 · 回收截止 08-28 · 2 位达人', stat: '进行中', tone: 'doing' as const },
  { name: '舒缓喷雾 · 达人 B/C', meta: '计划 08-23 寄出 · 周期 10 天', stat: '待寄样', tone: 'wait' as const },
  { name: '屏障面霜 · 达人 D', meta: '08-15 回收 · 转化 6.8% · 已入库', stat: '已回收', tone: 'done' as const },
  { name: '修护面膜 · 达人 E', meta: '08-12 回收 · 转化 5.1% · 已入库', stat: '已回收', tone: 'done' as const },
]
const FLOW = ['选品确认', '寄样', '达人实测', '回收入库']

export function TestScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const reduce = useReducedMotion()
  // 进度条 scaleX 生长入场（apple ease）；reduce 直接就位
  const progressScale = useRef(new Animated.Value(reduce ? 1 : 0)).current
  useEffect(() => {
    if (reduce) {
      progressScale.setValue(1)
      return
    }
    Animated.timing(progressScale, { toValue: 1, duration: motion.duration.page, easing: EASE.apple, useNativeDriver: true }).start()
  }, [reduce, progressScale])
  return (
    <ScreenFrame visible={visible} onClose={onClose} title="测品计划">
      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.kicker, { color: C.textMuted }]}>本月测品进度</Text>
          <Text style={[styles.pct, { color: C.primary }]}>62%</Text>
        </View>
        <View style={[styles.pBar, { backgroundColor: C.borderLight }]}>
          <Animated.View style={[styles.pBarFill, { width: '62%', backgroundColor: C.primary, transform: [{ scaleX: progressScale }] }]} />
        </View>
        <Text style={[styles.meta, { color: C.textMuted }]}>已完成 8 / 计划 13 个品 · 剩余 5 个待寄样</Text>
      </View>

      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.kicker, { color: C.textMuted }]}>测品任务</Text>
        </View>
        {TASKS.map((t, i) => (
          <FadeInView key={i} delay={i * 60} style={[styles.task, i < TASKS.length - 1 && { borderBottomWidth: 1, borderBottomColor: C.borderLight }]}>
            <View style={[styles.tStat, t.tone === 'doing' && { backgroundColor: C.primary + '24', }, t.tone === 'wait' && { backgroundColor: C.borderLight }, t.tone === 'done' && { backgroundColor: C.success + '24' }]}>
              <Text style={[styles.tStatText, t.tone === 'doing' && { color: C.primary }, t.tone === 'wait' && { color: C.textMuted }, t.tone === 'done' && { color: C.success }]}>{t.stat}</Text>
            </View>
            <View style={styles.tBody}>
              <Text style={[styles.tName, { color: C.textPrimary }]}>{t.name}</Text>
              <Text style={[styles.tMeta, { color: C.textMuted }]}>{t.meta}</Text>
            </View>
          </FadeInView>
        ))}
      </View>

      <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <View style={styles.cardHead}>
          <Text style={[styles.kicker, { color: C.textMuted }]}>标准流程</Text>
        </View>
        {FLOW.map((f, i) => (
          <View key={i} style={styles.tl}>
            <View style={[styles.tlDot, { backgroundColor: C.primary }]} />
            <Text style={[styles.tW, { color: C.textPrimary }]}>{i + 1} · {f}</Text>
            <Text style={[styles.tD, { color: C.textMuted }]}>
              {i === 0 && '从选品报告勾选待测品，生成测品单'}
              {i === 1 && '系统对接供应链，自动生成寄样单'}
              {i === 2 && '周期内回收实测素材与转化数据'}
              {i === 3 && '结论回流知识库，更新选品评分'}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.btnRow}>
        <TouchableOpacity activeOpacity={0.85} style={[styles.btn, styles.btnGhost, { borderColor: C.border, backgroundColor: C.cardBg }]}>
          <Text style={[styles.btnText, { color: C.textPrimary }]}>导出测品单</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.85} style={[styles.btn, styles.btnPrimary, { backgroundColor: C.primary }]}>
          <Text style={styles.btnTextLight}>新建测品</Text>
        </TouchableOpacity>
      </View>
    </ScreenFrame>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 14, marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.35)', ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  pct: { fontSize: 13, fontWeight: '800' },
  pBar: { height: 8, borderRadius: 999, overflow: 'hidden' },
  pBarFill: { height: '100%', borderRadius: 999 },
  meta: { fontSize: 12, marginTop: 8 },
  task: { flexDirection: 'row', gap: 10, paddingVertical: 11 },
  tStat: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start', marginTop: 2 },
  tStatText: { fontSize: 10, fontWeight: '800' },
  tBody: { flex: 1 },
  tName: { fontSize: 13, fontWeight: '700' },
  tMeta: { fontSize: 12, marginTop: 2 },
  tl: { paddingLeft: 18, paddingBottom: 14, position: 'relative' },
  tlDot: { position: 'absolute', left: 0, top: 6, width: 10, height: 10, borderRadius: 5 },
  tW: { fontSize: 13, fontWeight: '700' },
  tD: { fontSize: 12, marginTop: 2 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  btn: { flex: 1, paddingVertical: 11, borderRadius: radius.md, alignItems: 'center' },
  btnGhost: { borderWidth: 1 },
  btnPrimary: {},
  btnText: { fontSize: 13, fontWeight: '700' },
  btnTextLight: { fontSize: 13, fontWeight: '700', color: '#fff' },
})
