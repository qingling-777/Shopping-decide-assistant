import React, { useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native'
import { ScreenFrame } from '../components/ScreenFrame'
import { colors, radius, spacing } from '../theme'
import { User, ReferralInfo } from '../utils/types'
import { billingAPI, trackingAPI } from '../utils/api'

import { OPERATOR_WECHAT } from '../constants'
import { copyText } from '../utils/share'
import { createGlassCard } from '../styles/glassStyles'

interface Props {
  visible: boolean
  onClose: () => void
  user?: User | null
  onLogout?: () => void
  onLogin?: () => void
  onOpenPage?: (page: string) => void
  onAskAdvisor?: (prompt: string) => void
  onMembershipChanged?: () => void
}

export function ProfileScreen({ visible, onClose, user, onLogout, onLogin, onOpenPage }: Props) {
  const [balance, setBalance] = useState(0)
  const [estChats, setEstChats] = useState(0)
  const [referral, setReferral] = useState<ReferralInfo | null>(null)
  const [referralCopied, setReferralCopied] = useState(false)
  const [wechatCopied, setWechatCopied] = useState(false)
  const [tracked, setTracked] = useState<any[]>([])
  // 支付总开关（2026-08-28 免费引流策略）：false 时隐藏充值 CTA
  const [paymentEnabled, setPaymentEnabled] = useState(true)
  const [dailyFree, setDailyFree] = useState(3)

  const isMember = balance > 0

  useEffect(() => {
    if (visible && user) {
      loadQuota()
      trackingAPI.list().then((r) => setTracked(r.items || [])).catch(() => {})
    } else if (visible) {
      // 未登录：也拉取定价，保证「每日 N 次」文案动态准确
      billingAPI.getPricing().then((p: any) => {
        if (p?.daily_free_events) setDailyFree(p.daily_free_events)
        if (typeof p?.payment_enabled === 'boolean') setPaymentEnabled(p.payment_enabled)
      }).catch(() => {})
    } else {
      // 未登录或关闭个人页时清掉旧的会员态，避免退出登录后个人页仍残留旧会员信息
      setReferral(null)
      setReferralCopied(false)
      setWechatCopied(false)
      setTracked([])
      setBalance(0)
      setEstChats(0)
      setDailyFree(3)
      setPaymentEnabled(true)
    }
  }, [visible, user])

  const loadQuota = async () => {
    try {
      const r = await billingAPI.getBalance()
      setBalance(r.balance ?? 0)
      setEstChats(r.est_chats ?? 0)
      if (typeof r.payment_enabled === 'boolean') setPaymentEnabled(r.payment_enabled)
      if (r.daily_free_events) setDailyFree(r.daily_free_events)
    } catch (e) {
      console.error('加载余额失败', e)
    }
    try {
      const rf = await billingAPI.getReferralCode()
      setReferral(rf)
    } catch (e) {
      console.error('加载邀请码失败', e)
    }
  }

  const handleCopyReferral = async () => {
    if (!referral?.referral_code) return
    const ok = await copyText(referral.referral_code)
    if (ok) {
      setReferralCopied(true)
      setTimeout(() => setReferralCopied(false), 2000)
    }
  }

  const handleCopyWechat = async () => {
    const ok = await copyText(OPERATOR_WECHAT.id)
    if (ok) {
      setWechatCopied(true)
      setTimeout(() => setWechatCopied(false), 2000)
    }
  }

  return (
    <ScreenFrame visible={visible} onClose={onClose} title="个人中心">
      <View style={styles.content}>
          {/* 问候头卡：昵称 + 状态 pill（对标参考图 Hi, Anna Welcome back）*/}
          <View style={[styles.card, styles.helloCard, createGlassCard('medium', 16)]}>
            <View style={styles.userHeader}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{(user?.nickname || user?.account || '我').slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.userName} numberOfLines={1}>{user?.nickname || user?.account || '未登录'}</Text>
                <View style={styles.userTags}>
                  {user?.is_admin && (
                    <View style={[styles.tag, styles.tagRole]}>
                      <Text style={styles.tagText}>管理员</Text>
                    </View>
                  )}
                  {isMember && (
                    <View style={[styles.tag, styles.tagMember]}>
                      <Text style={styles.tagMemberText}>余额</Text>
                    </View>
                  )}
                  {user?.account?.includes('@') && (
                    <View style={[styles.tag, styles.tagEmail]}>
                      <Text style={styles.tagEmailText}>{user.email_verified ? '邮箱已验证' : '邮箱待验证'}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.userHint}>{user ? '已同步账号 · 多端可用' : `登录后同步数据 · 每日 ${dailyFree} 次免费对话`}</Text>
              </View>
              <TouchableOpacity
                style={[styles.iconBtn]}
                activeOpacity={0.7}
                onPress={() => onOpenPage?.('settings')}
              >
                <Text style={styles.iconBtnText}>⚙</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* 余额 hero 卡：超大数字余额（对标参考图 Max Spend up to 140.25€）+ 充值 CTA */}
          {user ? (
            <View style={[styles.card, styles.heroCard]}>
              <View style={styles.heroTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroEyebrow}>{balance > 0 ? '余额可用' : '余额不足'}</Text>
                  <Text style={[styles.heroNumber, { color: balance > 0 ? colors.primary : colors.textPrimary }]}>
                    ¥{balance.toFixed(2)}
                  </Text>
                  <Text style={styles.heroSub}>约还能聊 {estChats} 次</Text>
                </View>
                {paymentEnabled ? (
                  <TouchableOpacity
                    style={styles.heroCTA}
                    activeOpacity={0.8}
                    onPress={() => onOpenPage?.('recharge')}
                  >
                    <Text style={styles.heroCTAText}>充值</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.heroCTA}>
                    <Text style={styles.heroCTAText}>免费</Text>
                  </View>
                )}
              </View>
            </View>
          ) : (
            /* 未登录：整卡可点击引导登录 */
            <TouchableOpacity
              style={[styles.card, styles.heroCard]}
              activeOpacity={0.75}
              onPress={() => onLogin?.()}
            >
              <Text style={styles.heroEyebrow}>登录解锁余额</Text>
              <Text style={styles.heroNumber}>¥ 0.00</Text>
              <Text style={styles.heroSub}>每日 3 次免费对话 · 登录后查看个人余额</Text>
            </TouchableOpacity>
          )}

          {/* 邀请有礼：横向邀请条（对标参考图 Invite a friend 5¢ 的横条） */}
          {user && referral && (
            <TouchableOpacity
              style={[styles.card, styles.inviteBanner]}
              activeOpacity={0.8}
              onPress={() => {
                handleCopyReferral()
              }}
            >
              <View style={styles.inviteBannerLeft}>
                <View style={styles.inviteBannerIcon}>
                  <Text style={styles.inviteBannerIconText}>↗</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.inviteBannerTitle}>邀请好友 · 得 ¥2 礼券</Text>
                  <Text style={styles.inviteBannerDesc}>
                    {referralCopied ? `邀请码 ${referral.referral_code} 已复制` : `分享你的邀请码 ${referral.referral_code}`}
                  </Text>
                </View>
                <Text style={styles.inviteBannerChev}>›</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* 双色并行卡：我的追踪（蓝） + 余额明细（深蓝）——对标参考图 Balance/Saving 双卡 */}
          {user && (
            <View style={styles.duoRow}>
              <TouchableOpacity
                style={[styles.duoCard, styles.duoCardLight]}
                activeOpacity={0.85}
                onPress={() => onOpenPage?.('tracking')}
              >
                <View style={[styles.duoIconWrap, { backgroundColor: 'rgba(59,130,246,0.10)' }]}>
                  <Text style={styles.duoIcon}>↗</Text>
                </View>
                <Text style={[styles.duoLabel, { color: colors.textSecondary }]}>我的追踪</Text>
                <Text style={[styles.duoValue, { color: colors.primary }]}>{tracked.length}</Text>
                <Text style={[styles.duoHint, { color: colors.textMuted }]}>件方向</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.duoCard, styles.duoCardDark]}
                activeOpacity={0.85}
                onPress={() => onOpenPage?.('usage')}
              >
                <View style={styles.duoIconWrap}>
                  <Text style={styles.duoIcon}>¥</Text>
                </View>
                <Text style={[styles.duoLabel, { color: 'rgba(255,255,255,0.72)' }]}>消耗明细</Text>
                <Text style={[styles.duoValue, { color: '#fff' }]}>{estChats}</Text>
                <Text style={[styles.duoHint, { color: 'rgba(255,255,255,0.55)' }]}>可聊次数</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* 数据概览：商品池 / 收藏 / 测品 / 知识库（保持） */}
          <View style={styles.overviewSection}>
            <Text style={styles.sectionTitle}>数据概览</Text>
            <View style={styles.overviewGrid}>
              {[
                { label: '商品池', value: '5', key: 'pool' },
                { label: '收藏', value: '0', key: 'favorite' },
                { label: '测品计划', value: '0', key: 'test' },
                { label: '知识库', value: '0', key: 'knowledge' },
              ].map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={[styles.overviewCard, createGlassCard('light', 12)]}
                  activeOpacity={0.7}
                  onPress={onClose}
                >
                  <Text style={styles.overviewValue}>{item.value}</Text>
                  <Text style={styles.overviewLabel}>{item.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* 会员专属微信（保持） */}
          <View style={[styles.card, createGlassCard('medium', 16)]}>
              <Text style={styles.exclusiveTitle}>会员专属微信</Text>
              <Text style={styles.exclusiveDesc}>加我微信，选品有啥问题随时问</Text>
              <View style={styles.wechatRow}>
                <Text style={styles.wechatLabel}>微信号</Text>
                <Text style={styles.wechatId}>{OPERATOR_WECHAT.id}</Text>
                <TouchableOpacity
                  style={styles.copyBtn}
                  activeOpacity={0.7}
                  onPress={handleCopyWechat}
                >
                  <Text style={styles.copyBtnText}>{wechatCopied ? '已复制' : '复制'}</Text>
                </TouchableOpacity>
              </View>
            </View>

          {/* 干净菜单列表：榜单中心/我的追踪 / 消耗明细 / 设置 / 反馈 / 运营分析（管理员） */}
          <View style={[styles.card, createGlassCard('medium', 16), styles.menuCard]}>
            <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('ranking')}>
              <Text style={styles.menuLabel}>榜单中心</Text>
              <Text style={styles.menuChev}>›</Text>
            </TouchableOpacity>
            {user && (
              <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('tracking')}>
                <Text style={styles.menuLabel}>我的追踪</Text>
                <Text style={styles.menuChev}>›</Text>
              </TouchableOpacity>
            )}
            {user && (
              <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('usage')}>
                <Text style={styles.menuLabel}>我的消耗明细</Text>
                <Text style={styles.menuChev}>›</Text>
              </TouchableOpacity>
            )}
            {user && (
              <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('settings')}>
                <Text style={styles.menuLabel}>设置</Text>
                <Text style={styles.menuChev}>›</Text>
              </TouchableOpacity>
            )}
            {user && (
              <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('feedback')}>
                <Text style={styles.menuLabel}>意见反馈</Text>
                <Text style={styles.menuChev}>›</Text>
              </TouchableOpacity>
            )}
            {user?.is_admin && (
              <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('admin-analytics')}>
                <Text style={styles.menuLabel}>运营分析（管理员）</Text>
                <Text style={styles.menuChev}>›</Text>
              </TouchableOpacity>
            )}
            {user?.is_admin && (
              <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('admin-accounts')}>
                <Text style={styles.menuLabel}>账户调用报表（管理员）</Text>
                <Text style={styles.menuChev}>›</Text>
              </TouchableOpacity>
            )}
            {user?.is_admin && (
              <TouchableOpacity style={styles.menuRow} activeOpacity={0.7} onPress={() => onOpenPage?.('admin-feedback')}>
                <Text style={styles.menuLabel}>反馈查看（管理员）</Text>
                <Text style={styles.menuChev}>›</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* 退出登录 / 去登录 */}
          {user ? (
            <TouchableOpacity
              style={styles.logoutBtn}
              activeOpacity={0.8}
              onPress={onLogout}
            >
              <Text style={styles.logoutText}>退出登录</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.logoutBtn, { backgroundColor: colors.primary, borderColor: colors.primary }]}
              activeOpacity={0.8}
              onPress={onLogin}
            >
              <Text style={[styles.logoutText, { color: '#fff' }]}>去登录</Text>
            </TouchableOpacity>
          )}

          <View style={{ height: 40 }} />
        </View>
      </ScreenFrame>
  )
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
  },
  card: {
    padding: spacing.lg,
  },
  // 用户信息卡
  userHeader: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        boxShadow: '0 8px 20px rgba(59,130,246,0.20), 0 2px 6px rgba(59,130,246,0.10)',
      },
      default: {
        elevation: 6,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.20,
        shadowRadius: 10,
      },
    }),
  },
  avatarText: {
    fontSize: 28,
    fontWeight: '600',
    color: '#fff',
    letterSpacing: -0.5,
  },
  userInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  userName: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  userTags: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  tagRole: {
    backgroundColor: colors.primary + '12',
    borderWidth: 1,
    borderColor: colors.primary + '25',
  },
  tagMember: {
    backgroundColor: '#F59E0B' + '12',
    borderWidth: 1,
    borderColor: '#F59E0B' + '25',
  },
  tagText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.3,
  },
  tagMemberText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#D97706',
    letterSpacing: 0.3,
  },
  tagEmail: {
    backgroundColor: '#10B981' + '12',
    borderWidth: 1,
    borderColor: '#10B981' + '25',
  },
  tagEmailText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#059669',
    letterSpacing: 0.3,
  },
  userHint: {
    fontSize: 13,
    color: colors.textMuted,
    letterSpacing: -0.1,
  },
  // ── 个人中心主页改版（对标金融App结构，套品牌蓝）──────────────
  // 问候头卡：昵称 + 状态 pill + 设置图标
  helloCard: {
    borderRadius: radius.xl2,
    borderWidth: 1,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(24px) saturate(170%)',
        WebkitBackdropFilter: 'blur(24px) saturate(170%)',
        boxShadow: '0 12px 32px rgba(59,130,246,0.08), 0 4px 8px rgba(15,23,42,0.04)',
      },
      default: {
        elevation: 4,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
    }),
  },
  // 问候头卡：设置图标按钮
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(148,163,184,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.18)',
    alignSelf: 'flex-start',
  },
  iconBtnText: {
    fontSize: 16,
    color: colors.textSecondary,
  },
  // 余额 hero 卡：超大数字 + 充值 CTA
  heroCard: {
    borderRadius: radius.xl2,
    borderWidth: 1,
    overflow: 'hidden',
    ...Platform.select({
      web: {
        backdropFilter: 'blur(24px) saturate(170%)',
        WebkitBackdropFilter: 'blur(24px) saturate(170%)',
        boxShadow: '0 12px 32px rgba(59,130,246,0.12), 0 4px 8px rgba(59,130,246,0.06)',
      },
      default: {
        elevation: 6,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 16,
      },
    }),
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  heroEyebrow: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textSecondary,
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  heroNumber: {
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 46,
  },
  heroSub: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 8,
    letterSpacing: -0.1,
  },
  heroCTA: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: 'center',
    ...Platform.select({
      web: {
        boxShadow: '0 4px 12px rgba(59,130,246,0.25)',
      },
      default: {
        elevation: 3,
      },
    }),
  },
  heroCTAText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.2,
  },
  // 邀请横条
  inviteBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
  },
  inviteBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  inviteBannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(59,130,246,0.10)',
  },
  inviteBannerIconText: {
    fontSize: 20,
  },
  inviteBannerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 2,
    letterSpacing: -0.1,
  },
  inviteBannerDesc: {
    fontSize: 12,
    color: colors.textMuted,
    letterSpacing: -0.1,
  },
  inviteBannerChev: {
    fontSize: 20,
    color: colors.textMuted,
    marginLeft: 8,
  },
  // 双色并行卡
  duoRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  duoCard: {
    flex: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 128,
    justifyContent: 'space-between',
  },
  duoCardLight: {
    backgroundColor: 'rgba(59,130,246,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.12)',
  },
  duoCardDark: {
    backgroundColor: colors.primary,
    ...Platform.select({
      web: {
        boxShadow: '0 8px 20px rgba(59,130,246,0.25), 0 2px 6px rgba(59,130,246,0.12)',
      },
      default: {
        elevation: 4,
      },
    }),
  },
  duoIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginBottom: 10,
  },
  duoIcon: {
    fontSize: 17,
  },
  duoLabel: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  duoValue: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -1,
    marginTop: 2,
  },
  duoHint: {
    fontSize: 11,
    marginTop: 2,
  },
  // 干净菜单列表
  menuCard: {
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  menuLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  menuChev: {
    fontSize: 18,
    color: colors.textMuted,
  },
  // 数据概览 - 精致卡片
  overviewSection: {
    gap: spacing.md,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
    letterSpacing: -0.2,
  },
  overviewGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  overviewCard: {
    flex: 1,
    padding: spacing.md,
    alignItems: 'center',
    gap: 6,
    minHeight: 88,
    justifyContent: 'center',
  },
  overviewValue: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: -0.5,
  },
  overviewLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    letterSpacing: 0.2,
  },
  // 会员专属服务 - 精致呈现
  exclusiveTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 6,
    letterSpacing: -0.2,
  },
  exclusiveDesc: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    lineHeight: 19,
    letterSpacing: -0.1,
  },
  wechatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.02)',
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
  },
  wechatLabel: {
    fontSize: 13,
    color: colors.textMuted,
    letterSpacing: -0.1,
  },
  wechatId: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: 0.5,
  },
  copyBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.primary,
    ...Platform.select({
      web: {
        boxShadow: '0 2px 8px rgba(59,130,246,0.20)',
      },
      default: {
        elevation: 2,
      },
    }),
  },
  copyBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.2,
  },
  // 退出登录 - 克制设计
  logoutBtn: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.xl,
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderWidth: 1.5,
    borderColor: 'rgba(239,68,68,0.20)',
    alignItems: 'center',
  },
  logoutText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.danger,
    letterSpacing: 0.2,
  },
})

