import React, { useMemo } from 'react'
import { View, Text, TextInput, TouchableOpacity, ScrollView, Modal, Animated, StyleSheet, Platform } from 'react-native'
import { colors, dark, radius, spacing, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { createGlassPanel } from '../../styles/glassStyles'
import { BrandLogo } from '../AppHeader'
import zgoMark from '../../../assets/brand/zgo-mark.jpg'

interface ChatSession {
  id: string
  title: string
  /** HomeScreen 侧为 number(毫秒时间戳)，本组件只读展示，兼容两者 */
  updatedAt: number | string
}

/** 抽屉里的模块入口（与 WorkspaceTab 对齐），点击切 tab 并收起抽屉 */
export interface DrawerModule {
  key: string
  label: string
  glyph: string
}

export const DRAWER_MODULES: DrawerModule[] = [
  { key: 'overview', label: '总览', glyph: '▦' },
  { key: 'opportunities', label: '机会', glyph: '↗' },
  { key: 'pool', label: '商品池', glyph: '▣' },
  { key: 'knowledge', label: '知识', glyph: '▤' },
]
interface Props {
  visible: boolean
  onClose: () => void
  sessions: ChatSession[]
  currentSessionId: string | null
  searchQuery: string
  onSearchChange: (text: string) => void
  onSessionSelect: (id: string) => void
  onNewChat: () => void
  onDeleteSession: (id: string) => void
  sidebarAnim: Animated.Value
  /** 当前激活 Tab（用于高亮模块入口） */
  activeTab?: string
  /** 点击模块入口切 Tab（由父级传入 setActiveTab），点击后收起抽屉 */
  onNavigate?: (tab: string) => void
  /** 打开反馈 */
  onOpenFeedback?: () => void
}

export function ConversationSidebar({
  visible,
  onClose,
  sessions,
  currentSessionId,
  searchQuery,
  onSearchChange,
  onSessionSelect,
  onNewChat,
  onDeleteSession,
  sidebarAnim,
  activeTab,
  onNavigate,
  onOpenFeedback,
}: Props) {
  const filteredSessions = sessions.filter(
    s => !searchQuery || s.title.toLowerCase().includes(searchQuery.toLowerCase())
  )
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  // 深色下用暗玻璃覆盖 createGlassPanel 的白色面板底
  const panelBg = isDark ? { backgroundColor: 'rgba(15,26,46,0.90)' as const } : {}

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={S.modalOverlay}>
        <Animated.View style={[S.sidebar, createGlassPanel(16), panelBg, { transform: [{ translateX: sidebarAnim }] }]}>
          <View style={S.sidebarHeader}>
            <Text style={S.sidebarTitle}>功能菜单</Text>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7} style={S.closeBtn} accessibilityRole="button" accessibilityLabel="关闭菜单">
              <BrandLogo size={26} image={zgoMark} />
            </TouchableOpacity>
          </View>

          {/* 对话——最重要的入口：整宽高亮，点击回到对话页 */}
          <TouchableOpacity
            style={[S.chatEntry, activeTab === 'conversation' && S.chatEntryActive]}
            activeOpacity={0.8}
            onPress={() => { onNavigate?.('conversation'); onClose() }}
            accessibilityRole="button"
            accessibilityLabel="对话"
          >
            <View style={S.chatEntryIconWrap}>
              <Text style={S.chatEntryIcon}>≋</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={S.chatEntryText}>对话</Text>
              <Text style={S.chatEntrySub}>选品咨询 · 实时数据</Text>
            </View>
            <Text style={S.chatEntryChev}>›</Text>
          </TouchableOpacity>

          {/* 模块入口：总览/机会/商品池/知识 —— 2×2 等宽网格（点击切 Tab + 收起） */}
          <View style={S.moduleGrid}>
            {DRAWER_MODULES.map((mod) => {
              const isActive = activeTab === mod.key
              return (
                <TouchableOpacity
                  key={mod.key}
                  style={[S.moduleCell, isActive && S.moduleCellActive]}
                  activeOpacity={0.75}
                  onPress={() => { onNavigate?.(mod.key); onClose() }}
                  accessibilityRole="button"
                  accessibilityLabel={mod.label}
                >
                  <Text style={[S.moduleGlyph, isActive && S.moduleGlyphActive]}>{mod.glyph}</Text>
                  <Text style={[S.moduleLabel, isActive && S.moduleLabelActive]}>{mod.label}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
          {onOpenFeedback ? (
            <TouchableOpacity style={S.feedbackRow} activeOpacity={0.75} onPress={() => { onOpenFeedback(); onClose() }}>
              <Text style={S.feedbackGlyph}>✎</Text>
              <Text style={S.feedbackLabel}>意见反馈</Text>
            </TouchableOpacity>
          ) : null}

          <View style={S.newChatBtn}>
            <TouchableOpacity
              style={S.newChatInner}
              activeOpacity={0.8}
              onPress={onNewChat}
            >
              <Text style={S.newChatGlyph}>＋</Text>
              <Text style={S.newChatText}>新建对话</Text>
            </TouchableOpacity>
          </View>

          <View style={S.historyTitleRow}>
            <Text style={S.historyTitle}>历史对话</Text>
          </View>

          <View style={S.searchBox}>
            <TextInput
              style={S.searchInput}
              value={searchQuery}
              onChangeText={onSearchChange}
              placeholder="搜索对话..."
              placeholderTextColor={C.textMuted}
            />
          </View>

          <ScrollView style={S.sessionList} showsVerticalScrollIndicator={false}>
            {filteredSessions.map((session) => (
              <TouchableOpacity
                key={session.id}
                style={[S.sessionItem, session.id === currentSessionId && S.sessionItemActive]}
                onPress={() => onSessionSelect(session.id)}
                activeOpacity={0.7}
              >
                <View style={{ flex: 1 }}>
                  <Text style={S.sessionTitle} numberOfLines={1}>
                    {session.title}
                  </Text>
                  <Text style={S.sessionTime}>
                    {new Date(session.updatedAt).toLocaleDateString('zh-CN', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={(e) => {
                    e.stopPropagation()
                    onDeleteSession(session.id)
                  }}
                  activeOpacity={0.7}
                  style={S.deleteBtn}
                >
                  <Text style={S.deleteBtnText}>删除</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
            {sessions.length === 0 && (
              <View style={S.empty}>
                <Text style={S.emptyTitle}>暂无历史对话</Text>
                <Text style={S.emptyHint}>点上方「新建对话」开始一次选品咨询</Text>
              </View>
            )}
          </ScrollView>
        </Animated.View>
        <TouchableOpacity style={S.modalBackdrop} onPress={onClose} activeOpacity={1} />
      </View>
    </Modal>
  )
}

type ColorSet = {
  primary: string
  pageBg: string
  border: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  danger: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  modalOverlay: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebar: {
    width: 300,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: isDark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)',
  },
  sidebarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sidebarTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: C.textPrimary,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.pageBg,
    borderWidth: 1,
    borderColor: C.border,
    ...Platform.select({
      web: { cursor: 'pointer' as any },
    }),
  },
  // 对话入口：整宽高亮，最重要的模块（回对话页）
  chatEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: C.pageBg,
    borderWidth: 1,
    borderColor: C.border,
    ...Platform.select({
      web: { cursor: 'pointer' as any },
    }),
  },
  chatEntryActive: {
    backgroundColor: C.primary + '12',
    borderColor: C.primary,
  },
  chatEntryIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  chatEntryIcon: {
    fontSize: 18,
    color: '#fff',
    fontWeight: '700',
  },
  chatEntryText: {
    fontSize: 15,
    fontWeight: '700',
    color: C.textPrimary,
  },
  chatEntrySub: {
    fontSize: 12,
    color: C.textMuted,
    marginTop: 2,
  },
  chatEntryChev: {
    fontSize: 22,
    color: C.textSecondary,
    marginLeft: 'auto',
  },
  // 模块入口：2×2 等宽网格
  moduleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  moduleCell: {
    width: '48%',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: C.pageBg,
    borderWidth: 1,
    borderColor: C.border,
    ...Platform.select({
      web: { cursor: 'pointer' as any },
    }),
  },
  moduleCellActive: {
    backgroundColor: C.primary + '12',
    borderColor: C.primary,
  },
  moduleGlyph: {
    fontSize: 20,
    color: C.textSecondary,
    marginBottom: 4,
  },
  moduleGlyphActive: {
    color: C.primary,
  },
  moduleLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: C.textSecondary,
  },
  moduleLabelActive: {
    color: C.primary,
    fontWeight: '700',
  },
  feedbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: C.border,
  },
  feedbackGlyph: {
    fontSize: 15,
    color: C.textSecondary,
  },
  feedbackLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: C.textSecondary,
  },
  newChatBtn: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  newChatInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: C.primary,
    borderRadius: radius.md,
  },
  newChatGlyph: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
  newChatText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
  historyTitleRow: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  historyTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: C.textMuted,
  },
  searchBox: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  searchInput: {
    backgroundColor: C.pageBg,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    fontSize: 14,
    color: C.textPrimary,
    borderWidth: 1,
    borderColor: C.border,
    outlineStyle: 'none' as any, // RN-Web: 去掉浏览器原生聚焦黄圈
  },
  sessionList: {
    flex: 1,
  },
  sessionItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sessionItemActive: {
    backgroundColor: C.primary + '08',
  },
  sessionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textPrimary,
    marginBottom: 4,
  },
  sessionTime: {
    fontSize: 12,
    color: C.textMuted,
  },
  deleteBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  deleteBtnText: {
    fontSize: 12,
    color: C.danger || '#f44336',
  },
  empty: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
    paddingHorizontal: spacing.lg,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: C.textSecondary,
    marginBottom: spacing.xs,
  },
  emptyHint: {
    fontSize: 12,
    color: C.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
  })
}
