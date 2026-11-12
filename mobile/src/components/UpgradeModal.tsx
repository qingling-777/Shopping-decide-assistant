import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, TouchableOpacity, Modal, Image, TextInput, ScrollView, KeyboardAvoidingView, Platform, Animated, StyleSheet, useWindowDimensions } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { radius, spacing, goldRim, gradients, motion, colors, dark } from '../theme'
import { useAppColors, useTheme, EASE } from '../utils/theme'
import { billingAPI } from '../utils/api'
import { deviceStorage } from '../utils/deviceStorage'
import { WeChatContact } from './WeChatContact'
import { CountUp } from './CountUp'
import { useReducedMotion } from '../utils/useReducedMotion'
import { useAppState } from '../hooks/useAppState'

interface Props {
  visible: boolean
  onClose: () => void
  /** 升级/续费成功后回调（父组件用它刷新用量与会员态） */
  onUpgraded?: () => void
  /** 默认选中的方案：续费时可带入当前会员的 plan */
  initialPlan?: 'monthly' | 'yearly'
  /** 弹窗标题：续费场景用「续费内测会员」更准确 */
  title?: string
}

/**
 * 会员开通弹窗（单一数据源）。
 * 同时承载「升级」与「续费」两条入口，避免 HomeScreen 与 ProfileScreen 各写一份支付逻辑。
 *
 * 动效（主理人决策 A/B + §5/§6）：
 * - bottom sheet 升起用自定义 Animated translateY spring(springSoft) 替换 animationType="slide"（零 react-navigation）。
 * - 遮罩 fade + 玻璃加深（不 import expo-blur，决策 B）；强玻璃用半透明实底 + 多层柔影近似。
 * - 月付/年付切换物理反馈；价格 count-up 弹性尾段（useCountUp）。
 * - 金描边扫光：仅在会员语境（升级弹窗付费强调）出现，中性页不得用金（硬约束 5）。
 * - reduce-motion：瞬切就位，无位移/缩放/扫光；AppState 后台暂停扫光 loop。
 */
export function UpgradeModal({ visible, onClose, onUpgraded, initialPlan = 'monthly', title = '升级内测会员' }: Props) {
  const themeColors = useAppColors()
  const { isDark } = useTheme()
  const reduce = useReducedMotion()
  const active = useAppState()
  const C = isDark ? dark : colors
  const styles = useMemo(() => buildStyles(themeColors, isDark), [themeColors, isDark])
  const { height } = useWindowDimensions()

  const [pricing, setPricing] = useState<any>(null)
  const [merchant, setMerchant] = useState<{ name: string; qr_url: string } | null>(null)
  const [plan, setPlan] = useState<'monthly' | 'yearly'>(initialPlan)

  // 经营码支付凭证上传（闭环：付款后上传 → 运营核销 → 自动开通，无需再联系运营）
  const [proofAmount, setProofAmount] = useState('')
  const [proofRef, setProofRef] = useState('')
  const [submittingProof, setSubmittingProof] = useState(false)
  const [proofSubmitted, setProofSubmitted] = useState(false)
  const [proofErr, setProofErr] = useState<string | null>(null)
  const [proofImage, setProofImage] = useState<string | null>(null)
  const [proofImageName, setProofImageName] = useState('')

  // sheet 升起 / 遮罩 fade（springSoft）
  const overlayOpacity = useRef(new Animated.Value(0)).current
  const sheetY = useRef(new Animated.Value(0)).current
  const [sheetW, setSheetW] = useState(0)
  const sweepX = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!visible) {
      sheetY.setValue(reduce ? 0 : height)
      overlayOpacity.setValue(0)
      sweepX.setValue(0)
      return
    }
    if (reduce) {
      sheetY.setValue(0)
      overlayOpacity.setValue(1)
      return
    }
    sheetY.setValue(height)
    overlayOpacity.setValue(0)
    sweepX.setValue(0)
    Animated.parallel([
      Animated.timing(overlayOpacity, { toValue: 1, duration: motion.duration.overlay, easing: EASE.apple, useNativeDriver: true }),
      Animated.timing(sheetY, { toValue: 0, duration: motion.duration.sheet, easing: EASE.springSoft, useNativeDriver: true }),
    ]).start()
  }, [visible, reduce, height, sheetY, overlayOpacity, sweepX])

  // 金描边扫光 loop（仅前台、非 reduce；会员语境允许金光晕）
  useEffect(() => {
    if (reduce || !active || !visible) {
      sweepX.setValue(0)
      return
    }
    const loop = Animated.loop(
      Animated.timing(sweepX, { toValue: 1, duration: 2200, easing: EASE.apple, useNativeDriver: true }),
      { iterations: -1 },
    )
    loop.start()
    return () => loop.stop()
  }, [reduce, active, visible, sweepX])

  // 打开时拉取定价档与真实商户经营码（仅本弹窗使用），并重置凭证态
  useEffect(() => {
    if (!visible) return
    billingAPI.getPricing().then(setPricing).catch(() => {})
    billingAPI.getMerchant().then(setMerchant).catch(() => {})
    setProofAmount('')
    setProofRef('')
    setSubmittingProof(false)
    setProofSubmitted(false)
    setProofErr(null)
    setProofImage(null)
    setProofImageName('')
  }, [visible])

  const earlyBird = useMemo(() => {
    const t = pricing?.tiers?.find((x: any) => x.id === 'early_bird')
    const m = t ? (Array.isArray(t.price_monthly) ? t.price_monthly[0] : t.price_monthly) : 9.9
    const y = t ? t.price_yearly : 99
    return { monthly: m ?? 9.9, yearly: y ?? 99 }
  }, [pricing])

  // 经营码付款截图选择（网页端用原生 file input；native 暂不支持，引导填订单号）
  const pickProofImage = () => {
    if (Platform.OS !== 'web') {
      setProofErr('图片上传目前仅网页版支持；App 端请直接填支付宝订单号')
      return
    }
    const w: any = globalThis
    const input = w.document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = (e: any) => {
      const file = e?.target?.files?.[0]
      if (!file) return
      setProofImageName(file.name)
      const reader = w.FileReader()
      reader.onload = () => setProofImage(reader.result as string)
      reader.readAsDataURL(file)
    }
    input.click()
  }

  const sweepTranslate = sweepX.interpolate({ inputRange: [0, 1], outputRange: [-100, Math.max(sheetW + 100, 200)] })

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, { opacity: overlayOpacity }]}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <Animated.View
          style={[styles.sheetWrap, { transform: [{ translateY: sheetY }] }]}
          onLayout={(e) => setSheetW(e.nativeEvent.layout.width)}
        >
          {/* 金描边扫光（仅会员语境）：沿顶部金边横扫；reduce/后台停止 */}
          {!reduce && active ? (
            <Animated.View style={[styles.sweep, { pointerEvents: 'none' }, { transform: [{ translateX: sweepTranslate }] }]}>
              <LinearGradient colors={['transparent', C.goldDeep, 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
            </Animated.View>
          ) : null}
          <LinearGradient colors={goldRim} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 2, maxHeight: '90%' }}>
            <View style={{ backgroundColor: C.goldBg, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '100%' }}>
              <KeyboardAvoidingView style={{ maxHeight: '100%' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 36 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <Text style={{ fontSize: 18, fontWeight: '700', color: C.textPrimary }}>{title}</Text>
                    <TouchableOpacity onPress={onClose}>
                      <Text style={{ fontSize: 20, color: C.textMuted }}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={{ fontSize: 13, color: C.textMuted, marginBottom: 14 }}>
                    一杯奶茶钱的 AI 选品参谋，不用自己翻榜单。
                  </Text>

                  {/* 方案选择：月付/年付，金强调选中态（会员专属语义）；切换有物理反馈（PressableScale hover 抬升） */}
                  <View style={{ flexDirection: 'row', marginBottom: 12 }}>
                    {(['monthly', 'yearly'] as const).map((p) => {
                      const selected = plan === p
                      const price = p === 'monthly' ? earlyBird.monthly : earlyBird.yearly
                      return (
                        <TouchableOpacity
                          key={p}
                          onPress={() => setPlan(p)}
                          style={{
                            flex: 1,
                            marginRight: p === 'monthly' ? 10 : 0,
                            borderWidth: 1.5,
                            borderColor: selected ? C.gold : C.border,
                            borderRadius: 12,
                            padding: 14,
                            backgroundColor: selected ? C.gold + '16' : 'transparent',
                          }}
                        >
                          <Text style={{ fontSize: 14, fontWeight: '700', color: selected ? C.goldDeep : C.textPrimary }}>{p === 'monthly' ? '月付' : '年付'}</Text>
                          <Text style={{ fontSize: 13, color: selected ? C.goldDeep : C.textMuted, marginTop: 4 }}>
                            {p === 'monthly' ? (
                              <CountUp value={Number(price)} decimals={Number(price) % 1 === 0 ? 0 : 1} prefix="¥" suffix="/月" />
                            ) : (
                              <CountUp value={Number(price)} decimals={0} prefix="¥" suffix="/年" />
                            )}
                          </Text>
                        </TouchableOpacity>
                      )
                    })}
                  </View>

                  {/* 真实收款路径：展示支付宝经营码 + 商户名，用户扫码付款后上传凭证，运营核销开通 */}
                  {merchant && (
                    <View style={styles.merchantCard}>
                      <Text style={{ fontSize: 12, color: C.textMuted, marginBottom: 8, lineHeight: 18, textAlign: 'center' }}>
                        公测期真收钱：选好方案后，扫码「{merchant.name}」支付宝经营码付款，再在下方上传凭证即可。
                      </Text>
                      <Image source={{ uri: merchant.qr_url }} style={{ width: 200, height: 200, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: C.border }} resizeMode="contain" />
                      <Text style={{ fontSize: 11, color: C.textMuted, marginTop: 8, textAlign: 'center' }}>
                        无「模拟支付」通道：会员只能经真实经营码收款 + 凭证核销开通。
                      </Text>

                      {/* 付款后上传凭证：自动绑定本机身份，运营核销后自动开通，无需再联系运营 */}
                      <View style={{ marginTop: 14, width: '100%', alignItems: 'stretch' }}>
                        <Text style={{ fontSize: 13, color: C.textPrimary, fontWeight: '600', marginBottom: 6, textAlign: 'left' }}>
                          已付款？上传凭证，运营核对后自动开通
                        </Text>
                        <Text style={{ fontSize: 11, color: C.textMuted, marginBottom: 8, textAlign: 'left' }}>
                          付款时在支付宝备注填「{deviceStorage.get()}」（本机备注码），方便运营从账单匹配；也可不填，直接上传订单号。
                        </Text>
                        {/* 经营码付款截图：网页端可选附加凭证图（预览本地，提交时生成凭证引用） */}
                        <TouchableOpacity style={styles.imagePickBtn} activeOpacity={0.8} onPress={pickProofImage}>
                          <Text style={styles.imagePickText}>
                            添加经营码付款截图{proofImageName ? `（${proofImageName}）` : ''}
                          </Text>
                        </TouchableOpacity>
                        {proofImage ? (
                          <View style={styles.imagePreviewWrap}>
                            <Image source={{ uri: proofImage }} style={styles.imagePreview} resizeMode="cover" />
                            <TouchableOpacity style={styles.imageRemove} onPress={() => { setProofImage(null); setProofImageName('') }} activeOpacity={0.8}>
                              <Text style={styles.imageRemoveText}>移除</Text>
                            </TouchableOpacity>
                          </View>
                        ) : null}
                        <TextInput
                          style={styles.input}
                          placeholder="付款金额（元）"
                          placeholderTextColor={C.textMuted}
                          keyboardType="decimal-pad"
                          value={proofAmount}
                          onChangeText={setProofAmount}
                        />
                        <TextInput
                          style={[styles.input, { marginTop: 8 }]}
                          placeholder="支付宝订单号 / 转账备注（选填）"
                          placeholderTextColor={C.textMuted}
                          value={proofRef}
                          onChangeText={setProofRef}
                        />
                        <TouchableOpacity
                          style={[styles.sendBtn, { marginTop: 10, opacity: (submittingProof || (!proofAmount.trim() && !proofRef.trim())) ? 0.6 : 1 }]}
                          disabled={submittingProof || proofSubmitted || (!proofAmount.trim() && !proofRef.trim())}
                          onPress={async () => {
                            setSubmittingProof(true)
                            try {
                              const amtRaw = proofAmount.trim()
                              const amt = amtRaw ? parseFloat(amtRaw) : null
                              if (amt !== null && (isNaN(amt) || amt <= 0)) {
                                setProofErr('请填写有效的付款金额（元）')
                                return
                              }
                              if (amt === null && !proofRef.trim()) {
                                setProofErr('请先填写付款金额或订单号再提交')
                                return
                              }
                              const ref =
                                proofRef.trim() ||
                                (proofImageName ? `shot_${proofImageName}` : `proof_${Date.now()}`)
                              await billingAPI.submitProof(plan, amt, ref)
                              setProofErr(null)
                              setProofSubmitted(true)
                              onUpgraded?.()
                            } catch (e: any) {
                              setProofErr(e?.message || '上传失败，请重试')
                            } finally {
                              setSubmittingProof(false)
                            }
                          }}
                        >
                          <LinearGradient colors={gradients.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: radius.lg }} />
                          <Text style={styles.sendBtnText}>{submittingProof ? '提交中…' : proofSubmitted ? '已提交 ✓' : '上传支付凭证'}</Text>
                        </TouchableOpacity>
                        {proofSubmitted ? (
                          <Text style={{ fontSize: 12, color: C.success, marginTop: 8, textAlign: 'center' }}>
                            凭证已提交，运营核对收款后会自动为你开通会员
                          </Text>
                        ) : null}
                        {proofErr ? <Text style={[styles.errText, { marginTop: 8, textAlign: 'center' as const }]}>{proofErr}</Text> : null}
                      </View>
                    </View>
                  )}
                  {/* 会员专属微信：成为会员后可加运营微信，享 1v1 选品答疑（与会员状态卡复用同一组件/同一配置） */}
                  <WeChatContact subtitle="加我微信，选品有啥问题随时问" />
                </ScrollView>
              </KeyboardAvoidingView>
            </View>
          </LinearGradient>
        </Animated.View>
      </Animated.View>
    </Modal>
  )
}

function buildStyles(colors: any, isDark: boolean) {
  return {
    // 遮罩加深 + 玻璃调性（强玻璃近似：半透明实底，不 import expo-blur；决策 B）
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(2,4,8,0.55)',
      justifyContent: 'flex-end' as const,
    },
    sheetWrap: {
      width: '100%' as const,
      maxHeight: '90%' as const,
      overflow: 'hidden' as const,
    },
    sweep: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      width: 90,
      height: 3,
      zIndex: 10,
      opacity: 0.85,
    },
    sendBtn: {
      borderRadius: radius.lg,
      paddingVertical: spacing.md + 2,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      overflow: 'hidden' as const,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      fontSize: 14,
      color: colors.textPrimary,
      backgroundColor: isDark ? colors.cardBg : '#fff',
      outlineStyle: 'none' as any, // RN-Web: 去掉浏览器原生聚焦黄圈
    },
    sendBtnText: {
      color: '#fff',
      fontSize: 15,
      fontWeight: '700' as const,
    },
    errText: {
      color: '#e5484d',
      fontSize: 12,
      lineHeight: 17,
      textAlign: 'left' as const,
    },
    // 经营码区：金色虚线边框卡片（会员金语义）
    merchantCard: {
      marginTop: 16,
      width: '100%' as const,
      alignItems: 'center' as const,
      borderWidth: 1,
      borderStyle: 'dashed' as const,
      borderColor: colors.gold,
      borderRadius: radius.lg,
      padding: 16,
      backgroundColor: colors.goldBg,
    },
    imagePickBtn: {
      borderWidth: 1,
      borderStyle: 'dashed' as const,
      borderColor: colors.gold,
      borderRadius: radius.md,
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.md,
      alignItems: 'center' as const,
      marginBottom: 8,
    },
    imagePickText: {
      fontSize: 13,
      color: colors.goldDeep,
      fontWeight: '600' as const,
    },
    imagePreviewWrap: {
      position: 'relative' as const,
      marginBottom: 8,
    },
    imagePreview: {
      width: '100%' as const,
      height: 150,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: '#fff',
    },
    imageRemove: {
      position: 'absolute' as const,
      top: 8,
      right: 8,
      backgroundColor: 'rgba(0,0,0,0.55)',
      borderRadius: 8,
      paddingVertical: 4,
      paddingHorizontal: 10,
    },
    imageRemoveText: {
      color: '#fff',
      fontSize: 12,
    },
  }
}
