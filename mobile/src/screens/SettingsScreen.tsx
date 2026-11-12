import React, { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, Switch, StyleSheet, Platform, TextInput } from 'react-native'
import { colors, dark, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { ScreenFrame } from '../components/ScreenFrame'
import { FadeInView } from '../components/Motion'
import { authAPI, UpdateProfileBody } from '../utils/authApi'
import { billingAPI } from '../utils/api'
import type { User } from '../utils/types'
import prefStorage from '../utils/preferenceStorage'
import { APP_VERSION } from '../utils/version'
import { IconWallet, IconBell, IconDoc, IconInfo, IconLogout, IconChevronRight, IconUser, IconMail } from '../components/icons'

type Props = {
  visible: boolean
  onClose: () => void
  user?: User | null
  onLogout?: () => void
  onOpenPage?: (page: 'recharge' | 'usage' | 'feedback') => void
  onProfileUpdated?: (u: User) => void
}

type EditMode = 'profile' | 'email' | null

export function SettingsScreen({ visible, onClose, user, onLogout, onOpenPage, onProfileUpdated }: Props) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  const [notify, setNotify] = useState(() => prefStorage.get('notify', true))
  const [arrive, setArrive] = useState(() => prefStorage.get('arrive', true))

  // 偏好开关持久化：切换即写入 localStorage
  const toggleNotify = (v: boolean) => { setNotify(v); prefStorage.set('notify', v) }
  const toggleArrive = (v: boolean) => { setArrive(v); prefStorage.set('arrive', v) }

  // 独立整页编辑态：点「昵称与密码」/「邮箱实名」→ 进入全屏编辑页，不再内联铺开
  const [editMode, setEditMode] = useState<EditMode>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [curPw, setCurPw] = useState('')   // 改密码时的当前密码 / 绑邮箱时的当前密码(复用)
  const [newPw, setNewPw] = useState('')
  const [newEmail, setNewEmail] = useState('') // 邮箱实名绑定候选
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  // 支付总开关（2026-08-28 免费引流策略）：false 时隐藏「充值 / 余额」入口
  const [paymentEnabled, setPaymentEnabled] = useState(true)

  // 拉取支付开关（匿名亦可取 pricing），支付关闭时隐藏充值入口
  useEffect(() => {
    if (!visible) return
    billingAPI.getPricing().then((p: any) => {
      if (typeof p?.payment_enabled === 'boolean') setPaymentEnabled(p.payment_enabled)
    }).catch(() => {})
  }, [visible])

  // 重置编辑态 + 清空草稿（关闭设置弹窗时调用，避免再次进入时停留上次的编辑页）
  const resetEdit = () => {
    setEditMode(null)
    setNameDraft('')
    setCurPw('')
    setNewPw('')
    setNewEmail('')
    setErr('')
    setSaving(false)
  }

  // 打开设置态/编辑页切换时重置错误
  useEffect(() => { setErr(''); setSaving(false) }, [editMode])

  // 兜底：只要设置弹窗关闭（visible=false），无论从哪条路径退出都重置编辑态，防止再进设置时卡在上次编辑页
  useEffect(() => { if (!visible) resetEdit() }, [visible])

  // 编辑页的 ✕ / 返回：先重置编辑态，再关设置弹窗
  const handleClose = () => { resetEdit(); onClose() }

  const title = editMode === 'profile' ? '昵称与密码' : editMode === 'email' ? '邮箱实名' : '设置'

  const save = async () => {
    setErr(''); setSaving(true)
    try {
      let u: User
      if (editMode === 'profile') {
        // 昵称 + 密码 合并一次改：昵称必传；改密码时带 current_password + new_password
        const body: UpdateProfileBody = { nickname: nameDraft.trim() }
        if (newPw) {
          body.current_password = curPw
          body.new_password = newPw
        }
        u = await authAPI.updateProfile(body)
      } else if (editMode === 'email') {
        // 邮箱实名绑定：填新邮箱 + 当前密码验证
        u = await authAPI.updateProfile({ email: newEmail.trim(), current_password: curPw })
      } else {
        return
      }
      onProfileUpdated?.(u)
      setEditMode(null)
    } catch (e: any) {
      setErr(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const canSave =
    editMode === 'profile'
      ? (nameDraft.trim().length > 0 && !newPw) || (newPw.length >= 8 && curPw.length > 0)
      : editMode === 'email'
      ? (newEmail.trim().includes('@') && curPw.length > 0)
      : false

  // ── 编辑整页 ──
  if (editMode) {
    return (
      <ScreenFrame visible={visible} onClose={handleClose} title={title}>
        <View style={[styles.editPage, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          {editMode === 'profile' ? (
            <>
              {/* 昵称（随密码一起改，一次两项） */}
              <Text style={[styles.editLabel, { color: C.textMuted }]}>昵称</Text>
              <TextInput
                style={[styles.editInput, { color: C.textPrimary, borderColor: C.border, backgroundColor: C.pageBg }]}
                value={nameDraft}
                placeholder="输入新昵称"
                placeholderTextColor={C.textMuted}
                maxLength={50}
                autoFocus
                onChangeText={setNameDraft}
              />
              <Text style={[styles.editHint, { color: C.textMuted }]}>昵称用于展示，最多 50 字</Text>

              {/* 密码（选填：留空则只改昵称；填写则需当前密码验证） */}
              <Text style={[styles.editLabel, { color: C.textMuted }]}>当前密码（改密码时填）</Text>
              <TextInput
                style={[styles.editInput, { color: C.textPrimary, borderColor: C.border, backgroundColor: C.pageBg }]}
                value={curPw}
                placeholder="当前密码"
                placeholderTextColor={C.textMuted}
                secureTextEntry
                onChangeText={setCurPw}
              />
              <Text style={[styles.editLabel, { color: C.textMuted }]}>新密码（选填）</Text>
              <TextInput
                style={[styles.editInput, { color: C.textPrimary, borderColor: C.border, backgroundColor: C.pageBg }]}
                value={newPw}
                placeholder="留空则只改昵称；填写则同步改密码（至少 8 位）"
                placeholderTextColor={C.textMuted}
                secureTextEntry
                maxLength={128}
                onChangeText={setNewPw}
              />
              <Text style={[styles.editHint, { color: C.textMuted }]}>只改昵称可留空密码；同改密码时需验证当前密码</Text>
            </>
          ) : null}

          {editMode === 'email' ? (
            <>
              <Text style={[styles.editLabel, { color: C.textMuted }]}>绑定邮箱</Text>
              <TextInput
                style={[styles.editInput, { color: C.textPrimary, borderColor: C.border, backgroundColor: C.pageBg }]}
                value={newEmail}
                placeholder="填写要绑定的邮箱地址"
                placeholderTextColor={C.textMuted}
                maxLength={255}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                onChangeText={setNewEmail}
              />
              <Text style={[styles.editLabel, { color: C.textMuted }]}>当前密码（验证）</Text>
              <TextInput
                style={[styles.editInput, { color: C.textPrimary, borderColor: C.border, backgroundColor: C.pageBg }]}
                value={curPw}
                placeholder="输入当前密码以确认"
                placeholderTextColor={C.textMuted}
                secureTextEntry
                onChangeText={setCurPw}
              />
              <Text style={[styles.editHint, { color: C.textMuted }]}>邮箱实名独立绑定于账号，找回密码时将收到邮箱验证码</Text>
            </>
          ) : null}

          {err ? <Text style={[styles.editErr, { color: C.danger }]}>{err}</Text> : null}

          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.saveBtn, { backgroundColor: C.primary, opacity: canSave ? 1 : 0.45 }]}
            disabled={saving || !canSave}
            onPress={save}
          >
            <Text style={styles.saveBtnText}>{saving ? '保存中…' : '保存'}</Text>
          </TouchableOpacity>
        </View>
      </ScreenFrame>
    )
  }

  // ── 设置首页 ──
  return (
    <ScreenFrame visible={visible} onClose={handleClose} title="设置">
      <FadeInView delay={0} style={styles.group}>
        <Text style={[styles.sec, { color: C.textMuted }]}>账号</Text>
        <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <View style={styles.acc}>
            <View style={[styles.avatar, { backgroundColor: C.primary }]}>
              <Text style={styles.avatarText}>{(user?.nickname || user?.account || '客').slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.aName, { color: C.textPrimary }]}>{user?.nickname || user?.account || '游客'}</Text>
                {user?.is_member ? <Text style={[styles.badgeGold, { color: C.goldDeep, backgroundColor: C.goldBg }]}>会员</Text> : null}
              </View>
              <Text style={[styles.aSub, { color: C.textMuted }]}>{user?.account || '本机归档模式'}</Text>
            </View>
          </View>
        </View>
        <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <SettingRow icon={<IconUser />} label="昵称与密码" sub={user?.nickname || undefined} hasDivider onPress={() => { setNameDraft(user?.nickname || ''); setCurPw(''); setNewPw(''); setEditMode('profile') }}>
            <Text style={[styles.rowActionText, { color: C.primary }]}>修改</Text>
            <IconChevronRight size={14} color={C.primary} />
          </SettingRow>
          <SettingRow icon={<IconMail />} label="邮箱实名" sub={user?.email || undefined} onPress={() => { setNewEmail(user?.email || ''); setCurPw(''); setEditMode('email') }}>
            <Text style={[styles.rowActionText, { color: user?.email ? C.textMuted : C.primary }]}>{user?.email ? '修改' : '绑定'}</Text>
            <IconChevronRight size={14} color={C.textMuted} />
          </SettingRow>
        </View>
      </FadeInView>

      <FadeInView delay={60} style={styles.group}>
        <Text style={[styles.sec, { color: C.textMuted }]}>账户</Text>
        {paymentEnabled && (
          <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
            <SettingRow icon={<IconWallet />} label="充值 / 余额" sub="余额 · 充值 · 专属微信" active onPress={() => onOpenPage?.('recharge')}>
              <IconChevronRight size={16} color={C.primary} />
            </SettingRow>
          </View>
        )}
      </FadeInView>

      <FadeInView delay={120} style={styles.group}>
        <Text style={[styles.sec, { color: C.textMuted }]}>偏好</Text>
        <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <SettingRow icon={<IconBell />} label="新消息通知" hasDivider>
            <Switch value={notify} onValueChange={toggleNotify} thumbColor={notify ? C.primary : '#fff'} trackColor={{ false: C.border, true: C.primary + '66' }} />
          </SettingRow>
          <SettingRow icon={<IconBell />} label="选品到账提醒">
            <Switch value={arrive} onValueChange={toggleArrive} thumbColor={arrive ? C.primary : '#fff'} trackColor={{ false: C.border, true: C.primary + '66' }} />
          </SettingRow>
        </View>
      </FadeInView>

      <FadeInView delay={180} style={styles.group}>
        <Text style={[styles.sec, { color: C.textMuted }]}>通用</Text>
        <View style={[styles.card, { backgroundColor: C.cardBg, borderColor: C.border }]}>
          <SettingRow icon={<IconDoc />} label="我的消耗明细" hasDivider active onPress={() => onOpenPage?.('usage')}>
            <IconChevronRight size={16} color={C.textMuted} />
          </SettingRow>
          <SettingRow icon={<IconInfo />} label="关于 AI 选品顾问" active onPress={() => onOpenPage?.('feedback')}>
            <Text style={[styles.versionText, { color: C.textMuted }]}>v{APP_VERSION}</Text>
            <IconChevronRight size={16} color={C.textMuted} />
          </SettingRow>
        </View>
      </FadeInView>

      {user ? (
        <FadeInView delay={240} style={styles.group}>
          <TouchableOpacity activeOpacity={0.85} style={[styles.signout, { backgroundColor: C.cardBg, borderColor: C.border }]} onPress={() => { onLogout?.(); onClose() }}>
            <IconLogout size={18} color={C.danger} />
            <Text style={[styles.signoutText, { color: C.danger }]}>退出登录</Text>
          </TouchableOpacity>
        </FadeInView>
      ) : null}
    </ScreenFrame>
  )
}

/** 设置页行：左侧 图标 + 标题(+副标题)，右侧 交互元素 */
function SettingRow({
  icon,
  label,
  sub,
  active,
  hasDivider,
  onPress,
  children,
}: {
  icon: React.ReactNode
  label: string
  sub?: string
  active?: boolean
  hasDivider?: boolean
  onPress?: () => void
  children?: React.ReactNode
}) {
  const { isDark } = useTheme()
  const C = isDark ? dark : colors
  return (
    <TouchableOpacity activeOpacity={onPress ? 0.7 : 1} onPress={onPress} style={[styles.settingRow, hasDivider && styles.settingRowDivider]}>
      <View style={[styles.rowIcon, { backgroundColor: active ? 'rgba(59,130,246,0.10)' : C.borderLight, borderColor: active ? 'rgba(59,130,246,0.22)' : 'transparent' }]}>
        {icon}
      </View>
      <View style={styles.rowLabelWrap}>
        <Text style={[styles.rowLabel, { color: C.textPrimary }]}>{label}</Text>
        {sub ? <Text style={[styles.rowSub, { color: C.textMuted }]} numberOfLines={1} ellipsizeMode="middle">{sub}</Text> : null}
      </View>
      <View style={styles.rowRight}>{children}</View>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: 14, marginBottom: 12, backgroundColor: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.35)', outlineStyle: 'none' as any, ...Platform.select({ web: { backdropFilter: 'blur(20px) saturate(150%)', WebkitBackdropFilter: 'blur(20px) saturate(150%)', boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  // 分组：section 标题 + 一张卡（参考图分组式设置页）
  group: { marginBottom: 6 },
  sec: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 8, marginHorizontal: 2, marginBottom: 8, outlineStyle: 'none' as any },
  acc: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  aName: { fontSize: 15, fontWeight: '700' },
  aSub: { fontSize: 12, marginTop: 2 },
  badgeGold: { fontSize: 10, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, marginLeft: 8 },
  // 行（图标 + 标题 + 右侧元素）
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, outlineStyle: 'none' as any },
  settingRowDivider: { borderBottomWidth: 1, borderBottomColor: 'rgba(148,163,184,0.14)' },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowLabelWrap: { flex: 1, justifyContent: 'center' },
  rowLabel: { fontSize: 14, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowActionText: { fontSize: 13, fontWeight: '600' },
  versionText: { fontSize: 12, fontWeight: '600' },
  // 独立编辑整页
  editPage: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.xl, marginBottom: 12, ...Platform.select({ web: { boxShadow: '0 8px 32px rgba(59,130,246,0.10)' }, default: { elevation: 4 } }) },
  editLabel: { fontSize: 13, fontWeight: '600', marginTop: spacing.md, marginBottom: 6 },
  editInput: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, outlineStyle: 'none' as any },
  editHint: { fontSize: 12, marginTop: 6, lineHeight: 18 },
  editErr: { fontSize: 13, marginTop: spacing.md, lineHeight: 19 },
  saveBtn: { marginTop: spacing.xl, borderRadius: 12, paddingVertical: 14, alignItems: 'center', outlineStyle: 'none' as any },
  saveBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  signout: { marginTop: 8, borderRadius: radius.md, borderWidth: 1, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, outlineStyle: 'none' as any },
  signoutText: { fontSize: 14, fontWeight: '700' },
})
