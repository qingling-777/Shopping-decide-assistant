import React, { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, TextInput, ActivityIndicator, Animated, Platform } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Circle } from 'react-native-svg'
import { colors, dark, radius, spacing, motion } from '../theme'
import { useTheme, EASE } from '../utils/theme'
import { useReducedMotion } from '../utils/useReducedMotion'
import { ScreenFrame } from '../components/ScreenFrame'
import { WeChatContact } from '../components/WeChatContact'
import { CountUp } from '../components/CountUp'
import { FadeInView } from '../components/Motion'
import { Modal } from 'react-native'
import { billingAPI } from '../utils/api'

// 充值预设档（元）+ 档位赠金（元）：2026-08-26 方案A —— 1/3 无赠、6 送 0.5、10 送 1、30 送 3、68 送 10、128 送 22
const PRESETS = [1, 3, 6, 10, 30, 68, 128]
const PRESET_BONUS: Record<number, number> = { 1: 0, 3: 0, 6: 0.5, 10: 1, 30: 3, 68: 10, 128: 22 }

export function RechargeScreen({
  visible,
  onClose,
  user,
  onRecharged,
}: {
  visible: boolean
  onClose: () => void
  user?: { nickname?: string | null } | null
  onRecharged?: () => void
}) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [balance, setBalance] = useState(0)
  const [estChats, setEstChats] = useState(0)
  const [couponTotal, setCouponTotal] = useState(0)
  const [minRecharge, setMinRecharge] = useState(1)
  const [freeRemaining, setFreeRemaining] = useState<number | null>(null)
  const [dailyFree, setDailyFree] = useState(3)
  const [priceNote, setPriceNote] = useState('')
  const [modelPrices, setModelPrices] = useState<Array<{ model: string; default: boolean; sell: Record<string, number> }>>([])
  const [priceOpen, setPriceOpen] = useState(false)
  // 支付总开关（2026-08-28 免费引流策略）：后端返回 payment_enabled=false 时隐藏充值 UI
  const [paymentEnabled, setPaymentEnabled] = useState(true)
  const [preset, setPreset] = useState<number>(PRESETS[0])
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState(false)
  const reduce = useReducedMotion()
  // 支付方式选择 + H5 收银台：选面额 → 选支付途径(支付宝/微信) → 按面额跳转收银台付款
  const [payMethod, setPayMethod] = useState<'alipay' | 'wechat'>('alipay')
  const [cashier, setCashier] = useState<{ amount: number; pay_url: string | null; out_trade_no: string } | null>(null)

  // hero 卡精弹簧入场（0.92→1 带轻微 overshoot≈1.04）；进度条 scaleX 生长；reduce 直接就位
  const heroScale = useRef(new Animated.Value(reduce ? 1 : 0.92)).current

  useEffect(() => {
    if (reduce) {
      heroScale.setValue(1)
      return
    }
    Animated.spring(heroScale, { toValue: 1, friction: 12, tension: 120, useNativeDriver: true }).start()
  }, [reduce, heroScale])

  const loadBalance = async () => {
    try {
      const r = await billingAPI.getBalance()
      setBalance(r.balance ?? 0)
      setEstChats(r.est_chats ?? 0)
      setMinRecharge(r.min_recharge ?? 1)
      setFreeRemaining(r.free_remaining ?? null)
      if (r.daily_free_events) setDailyFree(r.daily_free_events)
      if (typeof r.payment_enabled === 'boolean') setPaymentEnabled(r.payment_enabled)
      const coupons: any[] = r.coupons ?? []
      setCouponTotal(coupons.reduce((s: number, c: any) => s + (c.amount ?? 0), 0))
      if (r.min_recharge && PRESETS[0] < r.min_recharge) setPreset(r.min_recharge)
    } catch {
      // 余额拉取失败不阻塞页面；用户仍可尝试充值
    }
  }

  useEffect(() => {
    if (visible) {
      setErr('')
      setOk(false)
      loadBalance()
      billingAPI.getPricing().then((p: any) => {
        setPriceNote(p?.price_note ?? '')
        setModelPrices(p?.model_prices ?? [])
      }).catch(() => {})
    }
  }, [visible])

  const effectiveAmount = custom ? Number(custom) : preset

  // 走真实 H5 收银台：下单拿 pay_url → 跳转支付宝付款（金额 = 所选面额）
  const handlePay = async () => {
    setErr('')
    setOk(false)
    if (!user) {
      setErr('请先登录后再充值')
      return
    }
    if (!effectiveAmount || Number.isNaN(effectiveAmount) || effectiveAmount <= 0) {
      setErr('请输入有效的充值金额')
      return
    }
    if (effectiveAmount < minRecharge) {
      setErr(`单次最小充值 ¥${minRecharge}`)
      return
    }
    setLoading(true)
    try {
      const r = await billingAPI.createRechargeOrder(effectiveAmount, 'wap')
      // 真实/沙箱(H5)：拿到收银台跳转链接 → 直接跳转
      if (r.pay_url) {
        // Web 端 window.location 跳转；原生端用 Linking 打开（占位，后续接 Linking）
        if (Platform.OS === 'web') {
          window.location.href = r.pay_url
        } else {
          const { Linking } = require('react-native')
          Linking.openURL(r.pay_url).catch(() => {})
        }
        return
      }
      // 演示模式（未配支付宝密钥，pay_url 为空）：展示模拟收银台供截图/演示
      setCashier({ amount: effectiveAmount, pay_url: null, out_trade_no: r.out_trade_no })
    } catch (e: any) {
      setErr(e?.message || '下单失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  // 演示/沙箱收银台里点「确认支付」：模拟到账（若后端配了真实支付则走轮询）
  const handleCashierConfirm = async () => {
    if (!cashier) return
    setLoading(true)
    setErr('')
    try {
      const r = await billingAPI.recharge(cashier.amount)
      setBalance(r.balance ?? 0)
      setEstChats(r.est_chats ?? Math.max(0, Math.floor((r.balance || 0) / 0.0185)))
      setOk(true)
      setCustom('')
      setPreset(cashier.amount >= minRecharge ? cashier.amount : PRESETS[0])
      setCashier(null)
      try {
        const rb = await billingAPI.getBalance()
        setFreeRemaining(rb.free_remaining ?? null)
        if (rb.daily_free_events) setDailyFree(rb.daily_free_events)
      } catch { /* 静默 */ }
      onRecharged?.()
    } catch (e: any) {
      setErr(e?.message || '支付失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  const lowBalance = balance <= 0

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="充值 / 余额" member>
      {/* 当前余额 hero 卡：深蓝渐变 + 白色数据环（今日免费剩余）+ 白色大数字余额 */}
      <Animated.View style={[styles.heroWrap, { transform: [{ scale: heroScale }] }]}>
        <LinearGradient
          colors={isDark ? ['#0B1B3A', '#10265A', '#16347A'] : ['#1E40AF', '#1D4ED8', '#2563EB']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          {/* 顶部：当前余额 + 状态标签 */}
          <View style={styles.heroTop}>
            <Text style={styles.heroEyebrow}>当前余额</Text>
            <View style={[styles.heroTag, { backgroundColor: lowBalance ? '#e5484d' : 'rgba(255,255,255,0.16)' }]}>
              <Text style={styles.heroTagText}>{lowBalance ? '已欠费' : '可用'}</Text>
            </View>
          </View>

          {/* 中部：白环（今日免费剩余）+ 余额大数字 */}
          <View style={styles.heroMid}>
            <FreeRing
              remaining={typeof freeRemaining === 'number' ? freeRemaining : dailyFree}
              total={dailyFree || 3}
              C={C}
            />
            <View style={styles.heroBalanceCol}>
              <View style={styles.balanceRow}>
                <Text style={styles.balanceCur}>¥</Text>
                <Text style={styles.balanceNum}>
                  <CountUp value={balance} decimals={2} />
                </Text>
              </View>
              <Text style={styles.balanceSub}>
                约还能聊 <Text style={styles.cu}><CountUp value={estChats} /></Text> 次
              </Text>
            </View>
          </View>

        </LinearGradient>
      </Animated.View>

      {/* 支付暂停空态（2026-08-28 免费引流策略）：后端 payment_enabled=false 时隐藏整段充值 UI */}
      {!paymentEnabled && (
        <View style={[styles.trialBox, { backgroundColor: C.primary + '08', borderColor: C.primary + '2E', marginBottom: 0 }]}>
          <Text style={[styles.pausedTitle, { color: C.textPrimary }]}>暂缓收费 · 免费畅用</Text>
          <Text style={[styles.trialTxt, { color: C.textSecondary, marginTop: 6 }]}>
            当前为免费引流阶段，暂未开放充值。每个账号每天可免费使用 <Text style={{ fontWeight: '800', color: C.primary }}>{dailyFree} 次</Text>，今日还剩 <Text style={{ fontWeight: '800', color: C.primary }}>{freeRemaining ?? dailyFree} 次</Text>，无需付费即可体验全部功能。
          </Text>
        </View>
      )}

      {/* 充值档位（支付暂停时隐藏） */}
      {paymentEnabled && <Text style={[styles.sec, { color: C.primary }]}>选择充值金额</Text>}
      {paymentEnabled && (
        <View style={styles.presGrid}>
        {PRESETS.map((p) => (
          <FadeInView key={p} delay={PRESETS.indexOf(p) * 40} style={[styles.presCard, { backgroundColor: C.cardBg, borderColor: C.border }]}>
            <TouchableOpacity
              activeOpacity={0.8}
              style={[styles.presInner, !custom && preset === p && { backgroundColor: C.primary + '0D', borderColor: C.primary }]}
              onPress={() => {
                setPreset(p)
                setCustom('')
                setErr('')
                setOk(false)
              }}
            >
              <Text style={[styles.presNum, { color: custom ? C.textPrimary : preset === p ? C.primary : C.textPrimary }]}>¥{p}</Text>
              {PRESET_BONUS[p] ? (
                <Text style={[styles.presEst, { color: C.primary, fontWeight: '700' }]}>送 ¥{PRESET_BONUS[p]}</Text>
              ) : (
                <Text style={[styles.presEst, { color: C.textMuted }]}>约 {Math.floor(p / 0.0185)} 次</Text>
              )}
            </TouchableOpacity>
          </FadeInView>
        ))}
        </View>
      )}

      {/* 自定义金额（支付暂停时隐藏） */}
      {paymentEnabled && (
      <View style={[styles.customWrap, { backgroundColor: C.cardBg, borderColor: C.border }]}>
        <Text style={[styles.customLabel, { color: C.textMuted }]}>自定义</Text>
        <Text style={[styles.customCur, { color: C.textPrimary }]}>¥</Text>
        <TextInput
          style={[styles.customInput, { color: C.textPrimary }]}
          keyboardType="decimal-pad"
          placeholder={`最低 ${minRecharge}`}
          placeholderTextColor={C.textMuted}
          value={custom}
          onChangeText={(t) => {
            setCustom(t.replace(/[^0-9.]/g, ''))
            setErr('')
            setOk(false)
          }}
        />
      </View>
      )}

      {/* 支付方式选择：列表 + 蓝色圆勾（对标 Payment Methods 参考图，简化：仅支付宝可用，微信未开通整行禁灰） */}
      {paymentEnabled && <Text style={[styles.sec, { color: C.primary }]}>选择支付方式</Text>}
      {paymentEnabled && (
      <View style={styles.payList}>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[
            styles.payRow,
            { backgroundColor: C.cardBg, borderColor: payMethod === 'alipay' ? C.primary : C.border },
            payMethod === 'alipay' && { backgroundColor: C.primary + '0A' },
          ]}
          onPress={() => { setPayMethod('alipay'); setErr(''); setOk(false) }}
        >
          <View style={[styles.payRowIcon, { backgroundColor: '#1677FF' }]}>
            <Text style={styles.payRowIconText}>支</Text>
          </View>
          <View style={styles.payRowInfo}>
            <Text style={[styles.payRowName, { color: C.textPrimary }]}>支付宝</Text>
            <Text style={[styles.payRowDesc, { color: C.textMuted }]}>手机网站支付 · 收银台</Text>
          </View>
          {payMethod === 'alipay' && (
            <View style={[styles.payRowCheck, { backgroundColor: C.primary }]}>
              <Text style={styles.payRowCheckInner}>✓</Text>
            </View>
          )}
        </TouchableOpacity>
        <View style={[styles.payRow, { backgroundColor: C.cardBg, borderColor: C.border, opacity: 0.62 }]}>
          <View style={[styles.payRowIcon, { backgroundColor: '#B8C4D6' }]}>
            <Text style={styles.payRowIconText}>微</Text>
          </View>
          <View style={styles.payRowInfo}>
            <Text style={[styles.payRowName, { color: C.textMuted }]}>微信支付</Text>
            <Text style={[styles.payRowDesc, { color: C.textMuted }]}>暂未开通 · 敬请期待</Text>
          </View>
          <View style={[styles.payRowTag, { borderColor: C.border }]}>
            <Text style={[styles.payRowTagText, { color: C.textMuted }]}>未开通</Text>
          </View>
        </View>
      </View>
      )}

      {/* 支付按钮：全宽蓝色（微信不可用，恒为支付宝）；支付暂停时隐藏 */}
      {paymentEnabled && (
      <TouchableOpacity
        activeOpacity={0.85}
        style={[styles.payBtn, { backgroundColor: loading ? C.border : '#1677FF' }]}
        disabled={loading}
        onPress={handlePay}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.payBtnText}>支付宝支付 ¥{effectiveAmount || minRecharge} 充值</Text>
        )}
      </TouchableOpacity>
      )}

      {err ? <Text style={[styles.errText, { color: '#e5484d' }]}>{err}</Text> : null}
      {ok ? <Text style={[styles.okText, { color: C.primary }]}>充值成功，余额已到账 ✓</Text> : null}

      {/* 新用户礼券 + 档位赠金说明（支付暂停时不展示充值引导文案） */}
      <View style={[styles.trialBox, { backgroundColor: C.primary + '0A', borderColor: C.primary + '2E' }]}>
        <Text style={[styles.trialTxt, { color: C.textSecondary }]}>
          {paymentEnabled ? (
            couponTotal > 0 ? (
              <>
                你有 <Text style={{ fontWeight: '800', color: C.primary }}>¥{couponTotal}</Text> 新用户礼券（打开应用即得），充值任一笔自动兑现；今日免费剩 {freeRemaining ?? dailyFree} 次，超量按 token 计费。
              </>
            ) : (
              <>今日免费剩 {freeRemaining ?? dailyFree} 次{freeRemaining === 0 ? '（已用完，充值继续）' : ''}，超量按 token 计费；充得越多送得越多，余额用尽后充值继续。</>
            )
          ) : (
            <>免费引流阶段：今日还剩 <Text style={{ fontWeight: '800', color: C.primary }}>{freeRemaining ?? dailyFree}</Text> 次免费额度，用完次日自动恢复。</>
          )}
        </Text>
      </View>

      {/* 价格说明（token 售价集中展示，2026-08-25） */}
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => setPriceOpen(!priceOpen)}
        style={[styles.customWrap, { backgroundColor: C.cardBg, borderColor: C.border, marginTop: 10 }]}
      >
        <Text style={[styles.customLabel, { color: C.textMuted }]}>token 计价说明</Text>
        <Text style={[styles.customCur, { color: C.primary }]}>{priceOpen ? '▾' : '▸'}</Text>
      </TouchableOpacity>
      {priceOpen && (
        <View style={[styles.trialBox, { backgroundColor: C.cardBg, borderColor: C.border, marginTop: 8 }]}>
          {priceNote ? <Text style={[styles.trialTxt, { color: C.textSecondary, fontSize: 12 }]}>{priceNote}</Text> : null}
          {modelPrices.map((mp) => {
            const s = mp.sell || {}
            return (
              <View key={mp.model} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: C.border }}>
                <Text style={[styles.trialTxt, { color: mp.default ? C.primary : C.textPrimary, fontWeight: mp.default ? '700' : '400' }]}>
                  {mp.default ? '★ ' : ''}{mp.model.split('/').pop()}
                </Text>
                <Text style={[styles.trialTxt, { color: C.textMuted, fontSize: 12 }]}>
                  进 ¥{Number(s.in ?? 0).toFixed(2)}/M · 出 ¥{Number(s.out ?? 0).toFixed(2)}/M{s.cache != null ? ` · 缓存 ¥${Number(s.cache).toFixed(2)}/M` : ''}
                </Text>
              </View>
            )
          })}
          <Text style={[styles.trialTxt, { color: C.textMuted, fontSize: 11, marginTop: 6 }]}>单位：¥/百万 token；售价 = 平台成本 × 5。默认模型（★）单次问答约 ¥0.0185。</Text>
        </View>
      )}

      {/* 充值专属微信 */}
      <WeChatContact subtitle="充值 / 余额有任何问题随时问" accent="blue" />

      {/* 模拟支付宝收银台（演示/沙箱模式：未配支付宝密钥时，前端展示收银台形态供截图/演示） */}
      <Modal visible={!!cashier} transparent animationType="fade" onRequestClose={() => setCashier(null)}>
        <View style={styles.cashierOverlay}>
          <View style={[styles.cashierSheet, { backgroundColor: C.cardBg, borderColor: C.border }]}>
            <View style={[styles.cashierHeader, { backgroundColor: '#1677FF' }]}>
              <Text style={styles.cashierHeaderTitle}>收银台</Text>
              <TouchableOpacity onPress={() => setCashier(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={styles.cashierClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={[styles.cashierLabel, { color: C.textMuted }]}>订单金额（按所选面额）</Text>
            <Text style={[styles.cashierAmount, { color: C.textPrimary }]}>¥{cashier?.amount ?? 0}</Text>
            <View style={[styles.cashierOrder, { borderTopColor: C.border, borderBottomColor: C.border }]}>
              <Text style={[styles.cashierOrderKv, { color: C.textMuted }]}>商户</Text>
              <Text style={[styles.cashierOrderVal, { color: C.textPrimary }]}>选品助手</Text>
            </View>
            <View style={[styles.cashierOrder, { borderBottomColor: C.border }]}>
              <Text style={[styles.cashierOrderKv, { color: C.textMuted }]}>商品</Text>
              <Text style={[styles.cashierOrderVal, { color: C.textPrimary }]}>余额充值 ¥{cashier?.amount ?? 0}</Text>
            </View>
            {cashier?.pay_url === null && (
              <Text style={[styles.cashierDemoTag, { color: C.textMuted }]}>演示模式：未配置支付宝密钥，点击下方确认按钮模拟到账</Text>
            )}
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.cashierConfirm, { backgroundColor: '#1677FF' }]}
              disabled={loading}
              onPress={handleCashierConfirm}
            >
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.cashierConfirmText}>确认支付 ¥{cashier?.amount ?? 0}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScreenFrame>
  )
}

const styles = StyleSheet.create({
  heroWrap: { marginBottom: 14 },
  heroCard: { borderRadius: radius.lg, padding: 18, ...Platform.select({ web: { boxShadow: '0 12px 32px rgba(29,78,216,0.26), 0 4px 8px rgba(29,78,216,0.14)' }, default: { elevation: 6, shadowColor: '#1D4ED8', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.26, shadowRadius: 16 } }) },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroEyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', color: 'rgba(255,255,255,0.82)' },
  heroTag: { fontSize: 11, fontWeight: '800', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 },
  heroTagText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  heroMid: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 10 },
  heroBalanceCol: { flex: 1 },
  balanceRow: { flexDirection: 'row', alignItems: 'flex-end' },
  balanceCur: { fontSize: 22, fontWeight: '800', color: '#fff', marginRight: 2, marginBottom: 6 },
  balanceNum: { fontSize: 38, fontWeight: '800', color: '#fff', lineHeight: 44, letterSpacing: -1 },
  balanceSub: { fontSize: 12.5, color: 'rgba(255,255,255,0.70)', marginTop: 4 },
  cu: { fontWeight: '700', color: '#fff' },
  sec: { fontSize: 13, fontWeight: '800', marginBottom: 12, paddingLeft: 11, borderLeftWidth: 3, borderLeftColor: colors.primary },
  presGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  presCard: { width: '31%', borderRadius: radius.md, borderWidth: 1, overflow: 'hidden' },
  presInner: { borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent', paddingVertical: 12, alignItems: 'center' },
  presNum: { fontSize: 16, fontWeight: '800' },
  presEst: { fontSize: 10.5, marginTop: 3 },
  customWrap: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 14, height: 48, marginBottom: 14 },
  customLabel: { fontSize: 13, marginRight: 8 },
  customCur: { fontSize: 16, fontWeight: '800', marginRight: 4 },
  customInput: { flex: 1, fontSize: 16, fontWeight: '700', outlineStyle: 'none' as any },
  payBtn: { height: 50, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  payBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  errText: { fontSize: 13, textAlign: 'center', marginBottom: 8 },
  okText: { fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  trialBox: { borderRadius: radius.lg, borderWidth: 1, padding: 14, marginBottom: 14 },
  trialTxt: { fontSize: 12.5, fontWeight: '600', lineHeight: 20 },
  pausedTitle: { fontSize: 16, fontWeight: '800' },
  // 支付方式选择（列表 + 蓝色圆勾，对标参考图）
  payList: { marginBottom: 14, gap: 10 },
  payRow: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  payRowIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  payRowIconText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  payRowInfo: { flex: 1 },
  payRowName: { fontSize: 15, fontWeight: '800' },
  payRowDesc: { fontSize: 11.5, marginTop: 3, fontWeight: '500' },
  payRowCheck: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  payRowCheckInner: { color: '#fff', fontSize: 13, fontWeight: '800' },
  payRowTag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  payRowTagText: { fontSize: 10.5, fontWeight: '700' },
  // 模拟收银台
  cashierOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  cashierSheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 1, paddingBottom: 28, overflow: 'hidden' },
  cashierHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 14 },
  cashierHeaderTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cashierClose: { color: '#fff', fontSize: 18, fontWeight: '700' },
  cashierLabel: { fontSize: 12, textAlign: 'center', marginTop: 18, fontWeight: '600' },
  cashierAmount: { fontSize: 34, fontWeight: '800', textAlign: 'center', marginTop: 4, marginBottom: 16 },
  cashierOrder: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 12, borderTopWidth: 0.5 },
  cashierOrderKv: { fontSize: 13 },
  cashierOrderVal: { fontSize: 13, fontWeight: '700' },
  cashierDemoTag: { fontSize: 11, textAlign: 'center', marginTop: 10, paddingHorizontal: 20 },
  cashierConfirm: { height: 50, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginTop: 18, marginHorizontal: 18 },
  cashierConfirmText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  // 数据环中心（深蓝 hero 卡内）
  ringCenter: { position: 'absolute', width: 92, height: 92, alignItems: 'center', justifyContent: 'center', top: 0, left: 0 },
  ringValue: { color: '#fff', fontSize: 20, fontWeight: '800', letterSpacing: -0.5 },
  ringLabel: { color: 'rgba(255,255,255,0.72)', fontSize: 10, marginTop: 1 },
})

// 白色数据环：深蓝 hero 卡上显示「今日免费剩余/总额」进度（对标参考图数据环）
function FreeRing({ remaining, total, C }: { remaining: number; total: number; C: any }) {
  const size = 92
  const stroke = 10
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const circ = 2 * Math.PI * r
  const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0
  const used = circ * ratio
  return (
    <View style={{ width: size, height: size, position: 'relative' }}>
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cy} r={r} stroke="rgba(255,255,255,0.18)" strokeWidth={stroke} fill="none" />
        <Circle
          cx={cx}
          cy={cy}
          r={r}
          stroke="#fff"
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${used} ${circ - used}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </Svg>
      <View style={styles.ringCenter}>
        <Text style={styles.ringValue}>{remaining}</Text>
        <Text style={styles.ringLabel}>今日免费剩</Text>
      </View>
    </View>
  )
}
