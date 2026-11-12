import React, { useRef } from 'react'
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native'
import { colors, radius, spacing } from '../../theme'
import { QuickChip } from '../../utils/types'

interface Props {
  input: string
  onChangeInput: (text: string) => void
  onSend: () => void
  category: 'general' | 'beauty'
  onChangeCategory: (cat: 'general' | 'beauty') => void
  quickChips: QuickChip[]
  onQuickChipPress: (prompt: string) => void
  onActionsPress: () => void
  composerButton: React.ReactNode
  usageInfo?: React.ReactNode
  isLoading?: boolean
}

export function ConversationInput({
  input,
  onChangeInput,
  onSend,
  category,
  onChangeCategory,
  quickChips,
  onQuickChipPress,
  onActionsPress,
  composerButton,
  usageInfo,
  isLoading,
}: Props) {
  const inputRef = useRef<TextInput>(null)

  return (
    <View style={styles.bottomPanel}>
      {usageInfo}

      {quickChips.length > 0 && (
        <View style={styles.quickBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.quickContent}
          >
            {quickChips.map((chip, idx) => (
              <TouchableOpacity
                key={idx}
                style={styles.quickChip}
                onPress={() => onQuickChipPress(chip.prompt)}
                activeOpacity={0.7}
              >
                <Text style={styles.quickChipText}>{chip.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      <View style={styles.inputCapsule}>
        <TouchableOpacity
          style={styles.plusBtn}
          onPress={onActionsPress}
          activeOpacity={0.7}
          disabled={isLoading}
        >
          <Text style={styles.plusText}>＋</Text>
        </TouchableOpacity>

        <View style={styles.themeInline}>
          <TouchableOpacity
            style={[styles.themeChip, category === 'general' && styles.themeChipActive]}
            activeOpacity={0.8}
            onPress={() => onChangeCategory('general')}
          >
            <Text style={[styles.themeChipText, category === 'general' && styles.themeChipTextActive]}>
              全品类
            </Text>
          </TouchableOpacity>
        </View>

        <TextInput
          ref={inputRef}
          style={styles.input}
          value={input}
          onChangeText={onChangeInput}
          placeholder={
            category === 'general'
              ? '问问 AI：想做哪个品类的带货？'
              : '问问 AI：哪个带货方向更容易起量？'
          }
          placeholderTextColor={colors.textMuted}
          returnKeyType="send"
          onSubmitEditing={onSend}
          blurOnSubmit={false}
          editable={true}
          autoComplete="off"
        />

        {composerButton}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bottomPanel: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: Platform.OS === 'ios' ? 24 : spacing.xs,
  },
  quickBar: {
    marginBottom: spacing.xs,
  },
  quickContent: {
    paddingRight: spacing.md,
    gap: spacing.xs,
  },
  quickChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(59,130,246,0.10)',
    marginRight: spacing.xs,
  },
  quickChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
  },
  inputCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.xs,
    paddingRight: spacing.xs,
    paddingVertical: spacing.xs,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.40)',
    ...Platform.select({
      web: {
        backdropFilter: 'blur(20px) saturate(150%)',
        WebkitBackdropFilter: 'blur(20px) saturate(150%)',
        boxShadow: '0 4px 16px rgba(59,130,246,0.08)',
      },
      default: {
        elevation: 4,
      },
    }),
  },
  plusBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs,
  },
  plusText: {
    fontSize: 18,
    color: colors.textSecondary,
    fontWeight: '400',
  },
  themeInline: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.borderLight,
    borderRadius: 999,
    padding: 2,
    marginRight: spacing.xs,
  },
  themeChip: {
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 999,
  },
  themeChipActive: {
    backgroundColor: colors.cardBg,
  },
  themeChipText: {
    fontSize: 11.5,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  themeChipTextActive: {
    color: colors.primary,
    fontWeight: '700',
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    paddingVertical: 8,
    paddingHorizontal: spacing.xs,
    outlineStyle: 'none' as any, // RN-Web: 去掉浏览器原生聚焦黄圈
  },
})
