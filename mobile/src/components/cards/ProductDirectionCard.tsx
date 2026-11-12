import React, { useMemo, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native'
import { colors, radius, spacing, shadows } from '../../theme'
import { useTheme } from '../../utils/theme'
import { ProductDirection } from '../../utils/types'
import { trackingAPI } from '../../utils/api'

const platformLabels: Record<string, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
}

export function ProductDirectionCard({ data, onSend, userId }: { data: ProductDirection; onSend?: (text: string) => void; userId?: string | null }) {
  const { colors: C, isDark } = useTheme()
  const S = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [tracked, setTracked] = useState(false)
  const [trackingBusy, setTrackingBusy] = useState(false)

  const onTrack = async () => {
    if (!userId || trackingBusy) return
    setTrackingBusy(true)
    try {
      if (tracked) {
        await trackingAPI.remove(data.directionName)
        setTracked(false)
      } else {
        await trackingAPI.add(data.directionName, data.directionName)
        setTracked(true)
      }
    } catch {
      // 失败静默，保持原状态
    } finally {
      setTrackingBusy(false)
    }
  }

  return (
    <View style={S.card}>
      {/* 标题 */}
      <View style={S.header}>
        <Text style={S.title}>{data.directionName}</Text>
        <Text style={S.category}>{data.category}</Text>
      </View>

      {/* 价格带 */}
      <View style={S.row}>
        <Text style={S.label}>推荐价格带</Text>
        <Text style={S.value}>{data.priceRange}</Text>
      </View>

      {/* 目标人群 */}
      <View style={S.row}>
        <Text style={S.label}>目标人群</Text>
        <Text style={S.valueText}>{data.targetUsers}</Text>
      </View>

      {/* 核心卖点 */}
      <View style={S.section}>
        <Text style={S.sectionTitle}>卖点</Text>
        <View style={S.tags}>
          {data.keySellingPoints.map((point, idx) => (
            <View key={idx} style={S.tag}>
              <Text style={S.tagText}>{point}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* 适合平台 */}
      <View style={S.section}>
        <Text style={S.sectionTitle}>适合平台</Text>
        <View style={S.platforms}>
          {data.suitablePlatforms.map((p, idx) => (
            <View key={idx} style={S.platformBadge}>
              <Text style={S.platformText}>{platformLabels[p] || p}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* 内容打法 */}
      <View style={S.section}>
        <Text style={S.sectionTitle}>内容打法</Text>
        {data.contentAngles.map((angle, idx) => (
          <Text key={idx} style={S.contentItem}>• {angle}</Text>
        ))}
      </View>

      {/* 操作按钮 */}
      <View style={S.actions}>
        <TouchableOpacity
          style={S.actionBtn}
          onPress={() => onSend?.(`帮我看 ${data.directionName} 的竞品`)}
        >
          <Text style={S.actionBtnText}>查看竞品</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={S.actionBtn}
          onPress={() => onSend?.(`给我 ${data.directionName} 的卖点文案`)}
        >
          <Text style={S.actionBtnText}>生成卖点</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[S.actionBtn, tracked ? S.actionBtnTracked : S.actionBtnPrimary]}
          onPress={onTrack}
          disabled={!userId || trackingBusy}
        >
          <Text style={[S.actionBtnText, tracked ? S.actionBtnTrackedText : S.actionBtnPrimaryText]}>
            {tracked ? '已追踪' : userId ? '加入追踪' : '登录后可追踪'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

type ColorSet = {
  cardBg: string
  border: string
  borderLight: string
  textPrimary: string
  textSecondary: string
  primary: string
  success: string
}

function buildStyles(C: ColorSet, isDark: boolean) {
  return StyleSheet.create({
  card: {
    backgroundColor: C.cardBg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: C.border,
    ...Platform.select({
      web: {
        backdropFilter: 'blur(16px) saturate(130%)',
        WebkitBackdropFilter: 'blur(16px) saturate(130%)',
        boxShadow: isDark ? shadows.cardDark : shadows.card,
      },
      default: {
        shadowColor: C.textPrimary,
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: isDark ? 0.40 : 0.10,
        shadowRadius: 20,
        elevation: 6,
      },
    }),
    // 生命力：hover 抬升 + 主蓝柔光（web）
    ':hover': { transform: [{ translateY: -2 }], borderColor: C.primary + '40' },
  } as any,
  header: {
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: 19,
    fontWeight: '700',
    color: C.textPrimary,
    marginBottom: 4,
  },
  category: {
    fontSize: 13,
    color: C.textSecondary,
  },
  row: {
    marginBottom: spacing.md,
  },
  label: {
    fontSize: 13,
    color: C.textSecondary,
    marginBottom: 4,
  },
  value: {
    fontSize: 20,
    fontWeight: '600',
    color: C.textPrimary,
  },
  valueText: {
    fontSize: 14,
    color: C.textPrimary,
    lineHeight: 20,
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textPrimary,
    marginBottom: spacing.sm,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tag: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  tagText: {
    fontSize: 13,
    color: C.textPrimary,
    fontWeight: '500',
  },
  platforms: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  platformBadge: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  platformText: {
    fontSize: 13,
    color: C.textPrimary,
    fontWeight: '600',
  },
  contentItem: {
    fontSize: 14,
    color: C.textPrimary,
    lineHeight: 22,
    marginBottom: 4,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: C.borderLight,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  actionBtnPrimary: {
    backgroundColor: C.primary,
  },
  actionBtnTracked: {
    backgroundColor: C.success + '1A',
    borderWidth: 1,
    borderColor: C.success,
  },
  actionBtnText: {
    fontSize: 13,
    color: C.textPrimary,
    fontWeight: '600',
  },
  actionBtnPrimaryText: {
    color: '#fff',
  },
  actionBtnTrackedText: {
    color: C.success,
  },
  })
}
