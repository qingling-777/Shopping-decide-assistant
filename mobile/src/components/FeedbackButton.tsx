import React, { useMemo, useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, Modal, TextInput, StyleSheet } from 'react-native'
import { colors, radius, spacing } from '../theme'
import { useTheme } from '../utils/theme'
import { feedbackAPI } from '../utils/api'

/**
 * 意见反馈弹窗（表单逻辑）。抽出为独立组件，供主页图标按钮与「我的」页入口共用。
 * 提交后管理员后台可见并处理；匿名用户走设备维度身份，无需登录。
 */
export function FeedbackModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) {
      setContent('')
      setContact('')
      setDone(false)
      setError(null)
      setSubmitting(false)
    }
  }, [visible])

  const submit = async () => {
    if (!content.trim()) {
      setError('请填写反馈内容')
      return
    }
    setSubmitting(true)
    try {
      await feedbackAPI.submit({ content: content.trim(), contact: contact.trim() || undefined })
      setDone(true)
    } catch (e: any) {
      setError(e?.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (!visible) return null

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>意见反馈</Text>
          <Text style={styles.sub}>提交后运营会在后台收到，可留下联系方式方便我们回复你</Text>
          {!done ? (
            <>
              <TextInput
                style={[styles.input, { height: 96, textAlignVertical: 'top' }]}
                value={content}
                onChangeText={(v) => {
                  setContent(v)
                  if (error) setError(null)
                }}
                placeholder="说点什么…（必填，最多 2000 字）"
                placeholderTextColor={C.textMuted}
                multiline
                maxLength={2000}
              />
              <TextInput
                style={styles.input}
                value={contact}
                onChangeText={setContact}
                placeholder="联系方式（选填）：微信 / 手机 / 邮箱"
                placeholderTextColor={C.textMuted}
                maxLength={200}
              />
              {error ? <Text style={styles.err}>{error}</Text> : null}
              <View style={styles.actions}>
                <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
                  <Text style={styles.cancelText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={submit} disabled={submitting} style={[styles.okBtn, submitting && styles.okDisabled]}>
                  <Text style={styles.okText}>{submitting ? '提交中…' : '提交'}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <View style={styles.doneBox}>
              <Text style={styles.doneText}>已收到，谢谢反馈！</Text>
              <TouchableOpacity onPress={onClose} style={styles.okBtn}>
                <Text style={styles.okText}>完成</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  )
}

/**
 * 意见反馈入口（主页右上角小图标按钮 + 弹窗）。
 */
export function FeedbackButton({ label = '反馈', style, onOpen }: { label?: string; style?: any; onOpen?: () => void }) {
  const { colors: C, isDark } = useTheme()
  const styles = useMemo(() => buildStyles(C, isDark), [C, isDark])
  const [show, setShow] = useState(false)
  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.btn, style]}
        activeOpacity={0.6}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        onPress={() => (onOpen ? onOpen() : setShow(true))}
      >
        <Text style={styles.btnGlyph}>✎</Text>
      </TouchableOpacity>
      {!onOpen ? <FeedbackModal visible={show} onClose={() => setShow(false)} /> : null}
    </>
  )
}

function buildStyles(C: Record<string, any>, isDark: boolean) {
  return StyleSheet.create({
  btn: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnGlyph: { fontSize: 20, color: C.textSecondary, textAlign: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  sheet: { backgroundColor: C.cardBg, borderRadius: radius.lg, padding: 22, width: '100%', maxWidth: 340 },
  title: { fontSize: 16, fontWeight: '700', color: C.textPrimary, marginBottom: 4 },
  sub: { fontSize: 12, color: C.textMuted, marginBottom: 14, lineHeight: 18 },
  input: { backgroundColor: C.pageBg, borderRadius: radius.lg, borderWidth: 1, borderColor: C.border, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, fontSize: 14, color: C.textPrimary, marginBottom: spacing.sm, outlineStyle: 'none' as any },
  err: { fontSize: 12, color: '#e5484d', marginTop: 8, textAlign: 'right' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  cancelBtn: { paddingVertical: 8, paddingHorizontal: 14 },
  cancelText: { fontSize: 14, color: C.textMuted },
  okBtn: { paddingVertical: 8, paddingHorizontal: 14, marginLeft: 8, backgroundColor: C.primary, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  okDisabled: { opacity: 0.6 },
  okText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  doneBox: { alignItems: 'center', paddingVertical: 8 },
  doneText: { fontSize: 14, color: C.success, fontWeight: '700', marginBottom: 10 },
})
}
