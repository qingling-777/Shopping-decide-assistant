import React, { useEffect, useMemo, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing } from 'react-native'
import { spacing, radius, motion } from '../../theme'
import { useTheme } from '../../utils/theme'
import { EASE } from '../../utils/theme'
import { useReducedMotion } from '../../utils/useReducedMotion'

interface ScenarioGroup {
  key: string
  title: string
  prompts: Array<{ label: string; prompt: string }>
}

interface Props {
  category: 'general' | 'beauty'
  audience?: 'C' | 'B'
  scenarioGroups: ScenarioGroup[]
  loading?: boolean
  /** 批次标识：每次轮换/切品类变化时重播进场动画（用于每 20s 换一批的视觉反馈） */
  seed?: number
  onPromptPress: (prompt: string) => void
  onDiagnosisPress: () => void
}

/** 每个场景组的语义配色（浅染底 + 同色发丝边框 + 强调色，Refactoring UI 手法） */
const GROUP_TINTS: Record<string, { bg: string; border: string; accent: string; label: string }> = {
  online_opportunity: { bg: '#EFF6FF', border: '#BFDBFE', accent: '#2563EB', label: '看机会' },
  online_competition: { bg: '#FEF2F2', border: '#FECACA', accent: '#DC2626', label: '判竞争' },
  online_commission: { bg: '#F0FDF4', border: '#BBF7D0', accent: '#16A34A', label: '算佣金' },
  online_action: { bg: '#FFFBEB', border: '#FDE68A', accent: '#D97706', label: '给建议' },
}

/** 单段缓浮进场：opacity 0→1（线性匀速渐显）+ translateY welcomeEnterY→0（ease-out 落定缓收），reduce-motion 直接就位。仅动 transform/opacity。 */
function FloatIn({
  delay = 0,
  duration = motion.welcomeDuration,
  enterY = motion.welcomeEnterY,
  children,
  style,
}: {
  delay?: number
  duration?: number
  enterY?: number
  children?: React.ReactNode
  style?: any
}) {
  const reduce = useReducedMotion()
  const opacity = useRef(new Animated.Value(reduce ? 1 : 0)).current
  const ty = useRef(new Animated.Value(reduce ? 0 : enterY)).current
  useEffect(() => {
    if (reduce) {
      opacity.setValue(1)
      ty.setValue(0)
      return
    }
    Animated.parallel([
      // opacity 线性匀速：全程由 0→1 同样速率，视觉上是「整块缓缓浮现」而非前段猛冲
      Animated.timing(opacity, { toValue: 1, duration, delay, easing: Easing.linear, useNativeDriver: true }),
      // translateY use ease-out：向下位移先行、落定时缓收（符合「上浮落定」的物理感）
      Animated.timing(ty, { toValue: 0, duration, delay, easing: EASE.decelerate, useNativeDriver: true }),
    ]).start()
  }, [reduce, delay, duration, enterY, opacity, ty])
  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY: ty }] }]}>{children}</Animated.View>
  )
}

/**
 * 欢迎区组件（空状态）
 * 文本导引 hero + 场景分组卡片网格（每张卡自带语义染色 accent，替代裸露的成排小药丸）
 * 动效：hero 文字缓浮 + 卡片/chip stagger 上浮；seed 变化（每 20s 换批/切品类）时重播进场。
 */
export function WelcomeSection({
  category,
  audience = 'C',
  scenarioGroups,
  loading = false,
  seed = 0,
  onPromptPress,
  onDiagnosisPress,
}: Props) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const isB = audience === 'B'
  // 批次标识：仅用于给「问题卡片区块」的 key，批变化(每20s换批/切品类)时重挂载、重播此区块动画；
  // hero 文字固定在根上，只在首次挂载时缓浮一次，避免每 20s 标题也跟着闪。
  const batchKey = `${category}-${audience}-${seed}`
  return (
    <View style={styles.welcomeSection}>
      {/* 大号居中问候 + 副标题。loading 时不渲染（避免动画提前播完）；就绪后随卡片一起从无到有浮现，刷新才看得见 */}
      {!loading && (
        <FloatIn delay={0} style={styles.hero}>
          <Text style={styles.heroTitle}>
            {isB ? '想做哪个方向的招商铺货？' : (category === 'general' ? '想做哪个品类的选品？' : '想深耕哪个带货方向？')}
          </Text>
          <Text style={styles.heroSub}>我帮你判断值不值得入场 · 支持实时数据</Text>
        </FloatIn>
      )}

      <View key={batchKey} style={styles.grid}>
        {loading ? (
          // loading：保留同布局的轻占位（等高卡片 + 灰条），避免「替换感」；就绪后由 FloatIn 分层进入
          <View style={styles.loadingCards}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.card, styles.loadingCard]}>
                <View style={[styles.badgePlaceholder, { width: 52 + i * 6 }]} />
                <View style={styles.loadingBar} />
                <View style={[styles.loadingBar, { width: '70%' }]} />
              </View>
            ))}
          </View>
        ) : (
          scenarioGroups.map((group, gi) => {
            const tint = GROUP_TINTS[group.key]
            const t = tint || GROUP_TINTS.online_opportunity
            return (
              <FloatIn key={group.key} delay={60 + gi * 120} style={styles.card}>
                {/* 卡头：语义色小标签 + 组标题 */}
                <View style={styles.cardHead}>
                  <View style={[styles.badge, { backgroundColor: t.accent }]}>
                    <Text style={styles.badgeText}>{t.label}</Text>
                  </View>
                  <Text style={styles.cardTitle}>{group.title}</Text>
                </View>
                {/* 组内问题：2 列网格，等高等宽、不横向滚动；chip 逐个上浮 */}
                <View style={styles.chipGrid}>
                  {group.prompts.map((p, pi) => (
                    <FloatIn key={p.label} delay={200 + gi * 120 + pi * 80} style={styles.chip}>
                      <TouchableOpacity
                        onPress={() => onPromptPress(p.prompt)}
                        activeOpacity={0.7}
                        style={styles.chipTouch}
                      >
                        <Text style={styles.chipText} numberOfLines={1}>{p.label}</Text>
                      </TouchableOpacity>
                    </FloatIn>
                  ))}
                </View>
              </FloatIn>
            )
          })
        )}
      </View>

      <FloatIn delay={140 + scenarioGroups.length * 120} style={styles.diagCta}>
        <TouchableOpacity
          style={styles.diagCtaRow}
          activeOpacity={0.85}
          onPress={onDiagnosisPress}
        >
          <Text style={styles.diagCtaIcon}>＋</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.diagCtaText}>单品深度诊断</Text>
            <Text style={styles.diagCtaSub}>输入单品，一键分析卖点 / 价格定位 / 竞争</Text>
          </View>
          <Text style={styles.diagCtaArrow}>›</Text>
        </TouchableOpacity>
      </FloatIn>
    </View>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  welcomeSection: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xl,
  },
  // 大号居中问候
  hero: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: C.textPrimary,
    lineHeight: 38,
    textAlign: 'center',
    letterSpacing: -0.3,
  },
  heroSub: {
    fontSize: 13.5,
    color: C.textSecondary,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  loadingCards: {
    gap: spacing.md,
  },
  loadingCard: {
    minHeight: 64,
    justifyContent: 'center',
  },
  badgePlaceholder: {
    height: 18,
    borderRadius: 6,
    backgroundColor: C.border,
    marginBottom: spacing.sm + 2,
  },
  loadingBar: {
    height: 12,
    borderRadius: 6,
    backgroundColor: C.border,
    marginBottom: spacing.sm,
    width: '90%',
  },
  loading: {
    fontSize: 13,
    color: C.textMuted,
    paddingVertical: spacing.lg,
    textAlign: 'center',
  },
  // 场景分组卡片网格：纵向堆叠、整宽卡片，替代裸露成排小药丸
  grid: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: spacing.md,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: C.textPrimary,
  },
  // 组内问题：2 列等宽网格（不横向滚动，全部可见）
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    width: '47%',
    flexGrow: 1,
  },
  chipTouch: {
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: C.pageBg,
    borderWidth: 1,
    borderColor: C.border,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textSecondary,
  },
  diagCta: {
    marginTop: spacing.lg,
    backgroundColor: C.primary + '10',
    borderWidth: 1,
    borderColor: C.primary + '30',
    borderRadius: radius.lg,
  },
  diagCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  diagCtaIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    textAlign: 'center',
    lineHeight: 30,
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
    backgroundColor: C.primary,
  },
  diagCtaText: {
    fontSize: 15,
    fontWeight: '700',
    color: C.primary,
    marginBottom: 2,
  },
  diagCtaSub: {
    fontSize: 12,
    color: C.textSecondary,
    lineHeight: 18,
  },
  diagCtaArrow: {
    fontSize: 24,
    color: C.primary + '80',
    fontWeight: '600',
    marginLeft: 'auto',
  },
  })
}
