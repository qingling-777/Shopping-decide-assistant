import React, { useEffect, useRef, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Animated, Platform } from 'react-native'
import { colors, dark, radius, spacing, motion } from '../theme'
import { useTheme, EASE } from '../utils/theme'
import { useReducedMotion } from '../utils/useReducedMotion'
import { ScreenFrame } from '../components/ScreenFrame'
import { FadeInView } from '../components/Motion'
import { feedbackAPI } from '../utils/api'

const TYPES = ['选品不准', '数据滞后', '动效卡顿', '界面建议', '想要新功能', '其他']

/**
 * 反馈页（#8，中性蓝工具区）：星级选中弹簧 + 问题类型 chip 切换物理 + 提交成功态弹簧入场 ring + 勾选。
 * 无金（硬约束 5：金=会员语义，反馈页为中性工具区）。
 * 动效全锁 transform/opacity；reduce-motion 瞬显、无光标/无弹跳/无缩放（复用 useReducedMotion）。
 */
export function FeedbackScreen({ visible, onClose, user }: { visible: boolean; onClose: () => void; user?: { id?: string | null } | null }) {
  const { isDark } = useTheme()
  const reduce = useReducedMotion()
  const C = isDark ? dark : colors
  const [score, setScore] = useState(0)
  const [types, setTypes] = useState<string[]>([])
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ringScale = useRef(new Animated.Value(reduce ? 1 : 0)).current
  const checkScale = useRef(new Animated.Value(reduce ? 1 : 0)).current

  useEffect(() => {
    if (!visible) {
      setScore(0)
      setTypes([])
      setContent('')
      setSubmitting(false)
      setDone(false)
      setError(null)
      ringScale.setValue(0)
      checkScale.setValue(0)
    }
  }, [visible, ringScale, checkScale])

  useEffect(() => {
    if (done && !reduce) {
      Animated.parallel([
        Animated.timing(ringScale, { toValue: 1, duration: motion.duration.overlay, easing: EASE.springSoft, useNativeDriver: true }),
        Animated.timing(checkScale, { toValue: 1, duration: motion.duration.overlay, delay: 120, easing: EASE.springSoft, useNativeDriver: true }),
      ]).start()
    }
  }, [done, reduce, ringScale, checkScale])

  const submit = async () => {
    if (!content.trim()) {
      setError('请填写反馈内容')
      return
    }
    setSubmitting(true)
    try {
      await feedbackAPI.submit({ content: content.trim(), contact: undefined })
      setDone(true)
    } catch (e: any) {
      setError(e?.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const toggleType = (t: string) => setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="反馈">
      {!done ? (
        <ScrollView showsVerticalScrollIndicator={false}>
          <FadeInView duration={motion.duration.staggerItem} style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
            <Text style={[styles.label, { color: C.textPrimary }]}>整体体验评分</Text>
            <View style={styles.stars}>
              {[1, 2, 3, 4, 5].map((i) => (
                <StarButton key={i} filled={i <= score} onPress={() => setScore(i)} accent={C.primary} muted={C.textMuted} reduce={reduce} />
              ))}
            </View>
          </FadeInView>

          <FadeInView delay={60} duration={motion.duration.staggerItem} style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
            <Text style={[styles.label, { color: C.textPrimary }]}>问题类型</Text>
            <View style={styles.chips}>
              {TYPES.map((t) => {
                const on = types.includes(t)
                return (
                  <TouchableOpacity
                    key={t}
                    activeOpacity={0.85}
                    onPress={() => toggleType(t)}
                    style={[styles.chip, { backgroundColor: on ? C.primary : C.cardBg, borderColor: on ? C.primary : C.border }]}
                  >
                    <Text style={[styles.chipText, { color: on ? '#fff' : C.textSecondary }]}>{t}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </FadeInView>

          <FadeInView delay={120} duration={motion.duration.staggerItem} style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
            <Text style={[styles.label, { color: C.textPrimary }]}>详细描述</Text>
            <TextInput
              style={[styles.ta, { backgroundColor: C.pageBg, borderColor: C.border, color: C.textPrimary }]}
              value={content}
              onChangeText={(v) => {
                setContent(v)
                if (error) setError(null)
              }}
              placeholder="说说你的使用感受或具体建议…"
              placeholderTextColor={C.textMuted}
              multiline
              maxLength={500}
              textAlignVertical="top"
            />
            <Text style={[styles.counter, { color: C.textMuted }]}>{content.length}/500</Text>
          </FadeInView>

          {error ? <Text style={[styles.err, { color: C.danger }]}>{error}</Text> : null}
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={submit}
            disabled={submitting}
            style={[styles.submit, { opacity: submitting ? 0.6 : 1, backgroundColor: C.primary }]}
          >
            <Text style={styles.submitText}>{submitting ? '提交中…' : '提交反馈'}</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <FadeInView duration={reduce ? 0 : motion.duration.overlay} style={styles.success}>
          <Animated.View style={[styles.ring, { transform: [{ scale: ringScale }], backgroundColor: C.primary + '14' }]}>
            <Animated.Text style={[styles.check, { transform: [{ scale: checkScale }], color: C.primary }]}>✓</Animated.Text>
          </Animated.View>
          <Text style={[styles.successTitle, { color: C.textPrimary }]}>已收到你的反馈</Text>
          <Text style={[styles.successSub, { color: C.textSecondary }]}>我们会认真评估，并在后续版本中持续改进。</Text>
          <TouchableOpacity activeOpacity={0.85} onPress={onClose} style={[styles.okBtn, { backgroundColor: C.primary }]}>
            <Text style={styles.okText}>完成</Text>
          </TouchableOpacity>
        </FadeInView>
      )}
    </ScreenFrame>
  )
}

function StarButton({ filled, onPress, accent, muted, reduce }: { filled: boolean; onPress: () => void; accent: string; muted: string; reduce: boolean }) {
  const scale = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (filled && !reduce) {
      scale.setValue(0.86)
      Animated.timing(scale, { toValue: 1, duration: 320, easing: EASE.springSoft, useNativeDriver: true }).start()
    }
  }, [filled, reduce, scale])
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={styles.starBtn}>
      <Animated.Text style={[styles.star, { transform: [{ scale }], color: filled ? accent : muted }]}>★</Animated.Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 16, marginBottom: 14, backgroundColor: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.35)', ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  label: { fontSize: 13, fontWeight: '700', marginBottom: 10 },
  stars: { flexDirection: 'row', gap: 8 },
  starBtn: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  star: { fontSize: 26, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, borderWidth: 1, backgroundColor: 'rgba(255,255,255,0.60)', borderColor: 'rgba(255,255,255,0.40)', ...Platform.select({ web: { backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' } }) },
  chipText: { fontSize: 12, fontWeight: '600' },
  ta: { width: '100%', minHeight: 120, borderRadius: radius.md, borderWidth: 1, padding: 12, fontSize: 16, lineHeight: 22, outlineStyle: 'none' as any }, // ≥16 防 iOS 聚焦智能缩放；RN-Web 去掉聚焦黄圈
  counter: { textAlign: 'right', fontSize: 11, marginTop: 6 },
  err: { fontSize: 12, marginBottom: 8, textAlign: 'right' },
  submit: { borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  success: { alignItems: 'center', paddingVertical: 36 },
  ring: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  check: { fontSize: 30, fontWeight: '800' },
  successTitle: { fontSize: 17, fontWeight: '700', marginBottom: 6 },
  successSub: { fontSize: 13, textAlign: 'center', lineHeight: 18, marginBottom: 18 },
  okBtn: { paddingHorizontal: 28, paddingVertical: 11, borderRadius: radius.md },
  okText: { color: '#fff', fontSize: 14, fontWeight: '700' },
})
