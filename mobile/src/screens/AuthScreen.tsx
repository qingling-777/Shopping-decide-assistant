import React, { useMemo, useState } from 'react'
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Platform, KeyboardAvoidingView } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { authAPI } from '../utils/authApi'
import { tokenStorage } from '../utils/authStorage'
import { User } from '../utils/types'
import { FadeInView } from '../components/Motion'
import { GlassBackground } from '../components/GlassBackground'
import { runTencentCaptcha } from '../utils/captcha'
import zgoLogin from '../../assets/brand/zgo-login.jpg'

interface Props {
  onAuthenticated: (user: User) => void
  onBack?: () => void
}

type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'verify'

// 登录页 hero 封面用图标深蓝（取自 zgo-login.jpg 边缘主色），
// 与全局 gradients.hero（品牌蓝）区分：不污染其他用它做底的模块。
const authHeroGradient = ['#0A3CB0', '#09359E', '#081148'] as const

export function AuthScreen({ onAuthenticated, onBack }: Props) {
  const { colors: themeColors, isDark } = useTheme()
  const [mode, setMode] = useState<Mode>('login')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [focused, setFocused] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)
  const [verifyCodeSent, setVerifyCodeSent] = useState(false)
  // 注册通道：'email' 走邮箱验证码；'phone' 手机号+密码（暂不接短信）
  const [regChannel, setRegChannel] = useState<'email' | 'phone'>('email')

  const styles = useMemo(() => buildStyles(themeColors, isDark), [themeColors, isDark])

  const goMode = (next: Mode) => {
    setError('')
    setInfo('')
    setMode(next)
  }

  const startCountdown = (secs: number) => {
    setCountdown(secs)
    const timer = setInterval(() => {
      setCountdown((cur) => {
        if (cur <= 1) {
          clearInterval(timer)
          return 0
        }
        return cur - 1
      })
    }, 1000)
  }

  const doSendVerifyCode = async () => {
    setError('')
    setInfo('')
    setIsLoading(true)
    try {
      const res = await authAPI.sendVerifyCode(normalizedAccount())
      setInfo(res.message || '验证码已发送，请查看邮箱')
      setVerifyCodeSent(true)
      startCountdown(60)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '发送失败，请稍后重试')
    } finally {
      setIsLoading(false)
    }
  }

  const normalizedAccount = () => account.trim()

  const submit = async () => {
    const normalizedAccount = account.trim()
    setError('')
    setInfo('')
    setIsLoading(true)
    try {
      if (mode === 'register') {
        if (!normalizedAccount || password.length < 8) {
          setError('请输入账号和至少8位密码')
          return
        }
        // 手机号通道：必须是 11 位数字
        if (regChannel === 'phone' && !/^1\d{10}$/.test(normalizedAccount)) {
          setError('请输入正确的 11 位手机号')
          return
        }
        // 邮箱通道：必须含 @
        if (regChannel === 'email' && !normalizedAccount.includes('@')) {
          setError('请输入正确的邮箱地址')
          return
        }
        // 腾讯云图形验证码（防机器人）：先弹窗验证，拿到 ticket/randstr 再注册
        let captchaTicket: string | undefined
        let captchaRandstr: string | undefined
        try {
          const cap = await runTencentCaptcha()
          if (!cap.ticket || !cap.randstr) {
            setError('人机验证未通过，请重试')
            setIsLoading(false)
            return
          }
          captchaTicket = cap.ticket
          captchaRandstr = cap.randstr
        } catch (captchaError) {
          // 验证码脚本加载失败等：提示但放行（容灾），避免无网络时卡死注册
          console.warn('[captcha] 弹窗失败，降级放行:', captchaError)
        }
        const result = await authAPI.register({
          account: normalizedAccount,
          password,
          nickname: nickname.trim() || undefined,
          // 邀请码为随机 hex，后端按大写匹配；这里统一大写提交
          invite_code: inviteCode.trim().toUpperCase() || undefined,
          captcha_ticket: captchaTicket,
          captcha_randstr: captchaRandstr,
        })
        tokenStorage.set(result.access_token)
        // 注册即登入（账户名+密码+图形验证码）；不再因邮箱账号强制进入验证码步骤。
        // 「个人认证」作为后续独立功能：进入App后从个人中心触发邮箱验证，见 verify 模式复用。
        onAuthenticated(result.user)
        return
      }
      if (mode === 'login') {
        if (!normalizedAccount || password.length < 8) {
          setError('请输入账号和至少8位密码')
          return
        }
        const result = await authAPI.login({ account: normalizedAccount, password })
        tokenStorage.set(result.access_token)
        onAuthenticated(result.user)
        return
      }
      if (mode === 'forgot') {
        if (!normalizedAccount) {
          setError('请输入登录账号或绑定邮箱')
          return
        }
        const res = await authAPI.forgotPassword(normalizedAccount)
        setInfo(res.message || '若该账号已注册，重置验证码已发送')
        setMode('reset')
        return
      }
      if (mode === 'verify') {
        if (!normalizedAccount || code.trim().length < 4) {
          setError('请输入邮箱和验证码')
          return
        }
        const user = await authAPI.verifyEmail(normalizedAccount, code.trim())
        setInfo('邮箱已验证 ✓')
        onAuthenticated(user)
        return
      }
      // reset
      if (!normalizedAccount || code.trim().length < 4 || newPassword.length < 8) {
        setError('请填写账号、验证码和至少8位新密码')
        return
      }
      const result = await authAPI.resetPassword(normalizedAccount, code.trim(), newPassword)
      tokenStorage.set(result.access_token)
      onAuthenticated(result.user)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '操作失败，请稍后重试')
    } finally {
      setIsLoading(false)
    }
  }

  const formTitle =
    mode === 'register' ? '创建账号' : mode === 'login' ? '欢迎回来' : mode === 'forgot' ? '找回密码' : mode === 'verify' ? '验证邮箱' : '重置密码'

  return (
    <View style={styles.page}>
      <GlassBackground />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* 品牌 hero 封面：ZGo 字标大图 */}
          <LinearGradient colors={authHeroGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
            {onBack && (
              <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.7}>
                <Text style={styles.backText}>‹ 返回</Text>
              </TouchableOpacity>
            )}
            <Image source={zgoLogin} style={styles.heroLogo} resizeMode="contain" />
            <Text style={styles.heroKicker}>SELECTION INSIGHT</Text>
            <Text style={styles.heroTitle}>AI 全品类选品顾问</Text>
            <Text style={styles.heroSubtitle}>对话式选品决策情报 · 帮你少翻榜单多赚钱</Text>
          </LinearGradient>

          {mode === 'forgot' || mode === 'reset' || mode === 'verify' ? (
            <TouchableOpacity style={styles.backLink} onPress={() => goMode('login')} activeOpacity={0.7}>
              <Text style={styles.backLinkText}>‹ 返回登录</Text>
            </TouchableOpacity>
          ) : null}

          {/* 抬升的表单卡（stagger 进场；输入框聚焦已用品牌蓝描边光环） */}
          <FadeInView style={styles.formCard}>
            <Text style={styles.formTitle}>{formTitle}</Text>

        {mode === 'register' && (
          <TextInput
            style={[styles.input, focused === 'nickname' && styles.inputFocused]}
            value={nickname}
            onChangeText={setNickname}
            placeholder="昵称（选填，留空自动分配）"
            placeholderTextColor={themeColors.textMuted}
            onFocus={() => setFocused('nickname')}
            onBlur={() => setFocused(null)}
          />
        )}

        {/* 注册通道分段选择：手机号 / 邮箱 各填一边 */}
        {mode === 'register' && (
          <View style={styles.channelRow}>
            {(['phone', 'email'] as const).map((ch) => {
              const active = regChannel === ch
              return (
                <TouchableOpacity
                  key={ch}
                  style={[styles.channelTab, active && styles.channelTabActive]}
                  onPress={() => setRegChannel(ch)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.channelTabText, active && styles.channelTabTextActive]}>
                    {ch === 'phone' ? '手机号' : '邮箱'}
                  </Text>
                </TouchableOpacity>
              )
            })}
          </View>
        )}

        {mode === 'register' && (
          <TextInput
            style={[styles.input, focused === 'inviteCode' && styles.inputFocused]}
            value={inviteCode}
            onChangeText={setInviteCode}
            placeholder="邀请码（选填）"
            placeholderTextColor={themeColors.textMuted}
            autoCapitalize="characters"
            onFocus={() => setFocused('inviteCode')}
            onBlur={() => setFocused(null)}
          />
        )}

        <TextInput
          style={[styles.input, focused === 'account' && styles.inputFocused]}
          value={account}
          onChangeText={setAccount}
          placeholder={mode === 'register' ? (regChannel === 'phone' ? '手机号' : '邮箱地址') : mode === 'forgot' || mode === 'reset' ? '登录账号或绑定邮箱' : '邮箱或手机号'}
          placeholderTextColor={themeColors.textMuted}
          autoCapitalize="none"
          keyboardType={mode === 'register' ? (regChannel === 'phone' ? 'number-pad' : 'email-address') : mode === 'forgot' || mode === 'reset' ? 'default' : 'email-address'}
          editable={mode !== 'reset' && mode !== 'verify'}          onFocus={() => setFocused('account')}
          onBlur={() => setFocused(null)}
        />

        {mode === 'reset' && (
          <TextInput
            style={[styles.input, focused === 'code' && styles.inputFocused]}
            value={code}
            onChangeText={setCode}
            placeholder="验证码"
            placeholderTextColor={themeColors.textMuted}
            keyboardType="number-pad"
            onFocus={() => setFocused('code')}
            onBlur={() => setFocused(null)}
          />
        )}

        {mode === 'verify' && (
          <>
            <View style={styles.codeRow}>
              <TextInput
                style={[styles.input, styles.codeInput, focused === 'code' && styles.inputFocused]}
                value={code}
                onChangeText={setCode}
                placeholder="邮箱验证码"
                placeholderTextColor={themeColors.textMuted}
                keyboardType="number-pad"
                onFocus={() => setFocused('code')}
                onBlur={() => setFocused(null)}
              />
              <TouchableOpacity
                style={[styles.codeBtn, { opacity: countdown > 0 ? 0.5 : 1 }]}
                onPress={doSendVerifyCode}
                disabled={isLoading || countdown > 0}
                activeOpacity={0.85}
              >
                <Text style={styles.codeBtnText}>{countdown > 0 ? `${countdown}s` : '获取验证码'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.codeHint}>验证码已发送至你的邮箱，10 分钟内有效</Text>
          </>
        )}

        {(mode === 'login' || mode === 'register') && (
          <TextInput
            style={[styles.input, focused === 'password' && styles.inputFocused]}
            value={password}
            onChangeText={setPassword}
            placeholder="密码（至少8位）"
            placeholderTextColor={themeColors.textMuted}
            secureTextEntry
            onFocus={() => setFocused('password')}
            onBlur={() => setFocused(null)}
          />
        )}

        {mode === 'reset' && (
          <TextInput
            style={[styles.input, focused === 'newPassword' && styles.inputFocused]}
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder="新密码（至少8位）"
            placeholderTextColor={themeColors.textMuted}
            secureTextEntry
            onFocus={() => setFocused('newPassword')}
            onBlur={() => setFocused(null)}
          />
        )}

        {info ? <Text style={styles.info}>{info}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.submit, { opacity: isLoading ? 0.7 : 1 }]}
          onPress={submit}
          disabled={isLoading}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={authHeroGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, borderRadius: radius.md }}
          />
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitText}>
              {mode === 'login' ? '登录' : mode === 'register' ? '注册并开始使用' : mode === 'forgot' ? '发送验证码' : mode === 'verify' ? '确认验证' : '确认重置'}
            </Text>
          )}
        </TouchableOpacity>

        {mode === 'login' && (
          <TouchableOpacity onPress={() => goMode('forgot')} activeOpacity={0.7}>
            <Text style={styles.forgotLink}>忘记密码？</Text>
          </TouchableOpacity>
        )}

          {mode === 'login' || mode === 'register' ? (
            <TouchableOpacity onPress={() => goMode(mode === 'login' ? 'register' : 'login')} activeOpacity={0.7}>
              <Text style={styles.switchText}>{mode === 'register' ? '已有账号？去登录' : '还没有账号？立即注册'}</Text>
            </TouchableOpacity>
          ) : null}
          </FadeInView>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

function buildStyles(c: any, isDark: boolean) {
  return StyleSheet.create({
    page: { flex: 1, backgroundColor: c.pageBg },
    flex: { flex: 1 },
    // 滚动容器：内容超高（注册页字段多/短屏）时可上下滚动，按钮不再被挤出屏幕；
    // 表单卡底部留白，避免贴到屏幕底。
    scrollContent: { flexGrow: 1, paddingBottom: spacing.xl },
    // hero 渐变封面
    hero: {
      paddingTop: 56,
      paddingBottom: 48,
      paddingHorizontal: spacing.xxl,
      alignItems: 'center',
      borderBottomLeftRadius: 28,
      borderBottomRightRadius: 28,
    },
    heroLogo: {
      width: 120,
      height: 120,
      marginBottom: -6,
      borderRadius: radius.xl,
      overflow: 'hidden',
      shadowColor: 'rgba(0,0,0,1)',
      shadowOpacity: 0.20,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 10 },
      elevation: 12,
      ...Platform.select({
        web: {
          boxShadow: '0 10px 32px rgba(4,12,40,0.35)',
        },
      }),
    },
    heroKicker: { color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: '700', letterSpacing: 2, marginTop: spacing.md },
    heroTitle: { color: '#fff', fontSize: 28, fontWeight: '800', marginTop: spacing.xs },
    heroSubtitle: { color: 'rgba(255,255,255,0.78)', fontSize: 13, lineHeight: 20, marginTop: spacing.sm, textAlign: 'center' },
    backBtn: { position: 'absolute', top: spacing.xl, left: spacing.xxl, zIndex: 10, paddingVertical: spacing.xs },
    backText: { color: 'rgba(255,255,255,0.9)', fontSize: 16, fontWeight: '600' },
    backLink: { alignSelf: 'flex-start', paddingHorizontal: spacing.xxl, paddingVertical: spacing.sm },
    backLinkText: { color: c.primary, fontSize: 15, fontWeight: '600' },
    // 抬升表单卡
    formCard: {
      backgroundColor: isDark ? 'rgba(15,26,46,0.66)' : 'rgba(255,255,255,0.60)',
      borderRadius: radius.lg,
      padding: spacing.xxl,
      marginHorizontal: spacing.xxl,
      marginTop: -28,
      borderWidth: 1,
      borderColor: isDark ? 'rgba(33,48,74,0.60)' : 'rgba(255,255,255,0.40)',
      ...Platform.select({
        web: {
          backdropFilter: 'blur(20px) saturate(150%)',
          WebkitBackdropFilter: 'blur(20px) saturate(150%)',
          boxShadow: isDark
            ? '0 20px 60px rgba(0,0,0,0.45), 0 8px 24px rgba(0,0,0,0.30)'
            : '0 20px 60px rgba(59,130,246,0.15), 0 8px 24px rgba(15,23,42,0.08)',
        },
        default: {
          shadowColor: '#3B82F6',
          shadowOffset: { width: 0, height: 12 },
          shadowOpacity: 0.15,
          shadowRadius: 30,
          elevation: 12,
        },
      }),
    },
    formTitle: { color: c.textPrimary, fontSize: 20, fontWeight: '700', marginBottom: spacing.lg },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      color: c.textPrimary,
      // iOS Safari: input/textarea 字号 < 16px 时，聚焦会触发"智能缩放"导致整页跳动/位移。
      // 提到 16px 可避免打字时页面大小变化（用户在手机上反馈"打字页面会移动"）。
      fontSize: 16,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      marginBottom: spacing.md,
      backgroundColor: c.cardBg,
      outlineStyle: 'none' as any, // RN-Web: 去掉浏览器原生聚焦黄圈，改由 inputFocused 品牌蓝描边接管
    },
    // 输入框聚焦：品牌蓝描边
    inputFocused: {
      borderColor: c.primary,
      borderWidth: 1.5,
    },
    // 注册通道分段选择：手机号 / 邮箱
    channelRow: {
      flexDirection: 'row',
      backgroundColor: isDark ? 'rgba(33,48,74,0.60)' : 'rgba(15,23,42,0.06)',
      borderRadius: radius.md,
      padding: 4,
      marginBottom: spacing.md,
    },
    channelTab: {
      flex: 1,
      paddingVertical: spacing.sm,
      alignItems: 'center',
      borderRadius: radius.sm,
    },
    channelTabActive: {
      backgroundColor: c.primary,
    },
    channelTabText: { color: c.textSecondary, fontSize: 14, fontWeight: '600' },
    channelTabTextActive: { color: '#fff', fontSize: 14, fontWeight: '700' },
    // 邮箱验证：验证码输入 + 获取按钮同行
    codeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
    codeInput: { flex: 1, marginBottom: 0, marginRight: spacing.sm },
    codeBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: radius.md,
      backgroundColor: c.primary,
      minWidth: 96,
      alignItems: 'center',
    },
    codeBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
    codeHint: { color: c.textSecondary, fontSize: 12, marginBottom: spacing.md, lineHeight: 18 },
    error: { color: c.danger, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
    info: { color: c.primary, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
    submit: {
      minHeight: 48,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: spacing.sm,
      marginBottom: spacing.lg,
      overflow: 'hidden' as const,
      position: 'relative' as const,
    },
    submitText: { color: '#fff', fontSize: 15, fontWeight: '700' },
    switchText: { textAlign: 'center', color: c.primary, fontSize: 14, fontWeight: '600' },
    forgotLink: { textAlign: 'center', color: c.textSecondary, fontSize: 13, fontWeight: '500', marginBottom: spacing.md },
  })
}
