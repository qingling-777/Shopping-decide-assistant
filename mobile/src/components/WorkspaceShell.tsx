import React, { useMemo } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native'
import { glass, radius, spacing, shadows } from '../theme'
import { useTheme } from '../utils/theme'
import { AppHeader, BrandLogo } from './AppHeader'
import { GlassBackground } from './GlassBackground'
import zgoMark from '../../assets/brand/zgo-mark.jpg'

/** 工作台 Tab 标识：抽屉模块入口共用同一套 */
export type WorkspaceTab = 'overview' | 'opportunities' | 'pool' | 'conversation'

export function WorkspaceShell({
  onOpenMenu,
  onOpenProfile,
  userLabel,
  children,
  footer,
}: {
  /** 点击左上角 ZGo logo 打开功能抽屉（模块入口 + 历史对话） */
  onOpenMenu: () => void
  onOpenProfile?: () => void
  userLabel?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])

  return (
    <View style={S.root}>
      {/* 玻璃态背景 */}
      <GlassBackground />

      {/* 顶部导航栏：左 ZGo logo（可点开抽屉） + 右昵称，其余省略 */}
      <View style={S.headerWrap}>
        <AppHeader
          left={(
            <TouchableOpacity
              onPress={onOpenMenu}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="打开功能菜单"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={S.menuBtn}
            >
              <BrandLogo size={30} image={zgoMark} />
            </TouchableOpacity>
          )}
          right={(
            <View style={S.headerActions}>
              {userLabel ? (
                <TouchableOpacity onPress={onOpenProfile} activeOpacity={0.7} style={S.userPill}>
                  <Text style={S.userPillText} numberOfLines={1}>{userLabel}</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={onOpenProfile} activeOpacity={0.7} style={S.loginPill}>
                  <Text style={S.loginPillText}>我的</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        />
      </View>

      {/* 中间内容区域 - 可滚动 */}
      <View style={S.body}>
        {children}
        {footer ? <View style={S.footer}>{footer}</View> : null}
      </View>
    </View>
  )
}

/** buildStyles 实际用到的配色键（浅/暗共有），结构性兼容 colors 与 dark */
type ColorSet = {
  pageBg: string
  cardBg: string
  border: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  primary: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  const G = isDark ? glass.dark : glass.light
  return StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.pageBg,
  },
  headerWrap: {
    position: 'relative',
    zIndex: 20,
    elevation: 20,
    backgroundColor: isDark ? 'rgba(15,26,46,1)' : 'rgba(248,250,252,1)',
    borderBottomWidth: 1,
    borderBottomColor: isDark ? 'rgba(33,48,74,0.9)' : 'rgba(255,255,255,0.30)',
    ...Platform.select({
      web: {
        boxShadow: isDark ? shadows.floatingDark : '0 8px 32px rgba(59,130,246,0.12), 0 2px 8px rgba(15,23,42,0.04)',
        backdropFilter: `blur(${glass.overlayBlur}px) saturate(${glass.overlaySaturate}%)`,
        WebkitBackdropFilter: `blur(${glass.overlayBlur}px) saturate(${glass.overlaySaturate}%)`,
      },
      default: { elevation: 8 },
    }),
  },
  menuBtn: {
    paddingVertical: 4,
    paddingRight: 6,
    borderRadius: radius.md,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  userPill: {
    minWidth: 76,
    maxWidth: 120,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: C.cardBg,
    borderWidth: 1,
    borderColor: C.border,
  },
  userPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: C.textSecondary,
  },
  loginPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: C.primary,
  },
  loginPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  body: {
    flex: 1,
  },
  footer: {
    marginTop: spacing.md,
  },
  })
}
