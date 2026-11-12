import React, { useEffect, useState } from 'react'
import { View, StyleSheet, Platform, Modal } from 'react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import { WorkspaceScreen } from './src/screens/WorkspaceScreen'
import { AuthScreen } from './src/screens/AuthScreen'
import { ProfileScreen } from './src/screens/ProfileScreen'
import { KBScreen } from './src/screens/KBScreen'
import { PlanScreen } from './src/screens/PlanScreen'
import { TestScreen } from './src/screens/TestScreen'
import { SettingsScreen } from './src/screens/SettingsScreen'
import { RechargeScreen } from './src/screens/RechargeScreen'
import { UsageScreen } from './src/screens/UsageScreen'
import { FeedbackScreen } from './src/screens/FeedbackScreen'
import { AdminFeedbackScreen } from './src/screens/AdminFeedbackScreen'
import { AdminAnalyticsScreen } from './src/screens/AdminAnalyticsScreen'
import { AdminAccountsScreen } from './src/screens/AdminAccountsScreen'
import { TrackingScreen } from './src/screens/TrackingScreen'
import { SelectionReportScreen } from './src/screens/SelectionReportScreen'
import { RankingScreen } from './src/screens/RankingScreen'
import { authAPI } from './src/utils/authApi'
import { tokenStorage } from './src/utils/authStorage'
import { deviceStorage } from './src/utils/deviceStorage'
import { billingAPI } from './src/utils/api'
import { User } from './src/utils/types'
import { colors } from './src/theme'

const queryClient = new QueryClient()

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showKB, setShowKB] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const [showTest, setShowTest] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showRecharge, setShowRecharge] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [showAdminFeedback, setShowAdminFeedback] = useState(false)
  const [showAdminAnalytics, setShowAdminAnalytics] = useState(false)
  const [showAdminAccounts, setShowAdminAccounts] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [showUsage, setShowUsage] = useState(false)
  const [showTracking, setShowTracking] = useState(false)
  const [showRanking, setShowRanking] = useState(false)
  const openPage = (p: string) => {
    if (p === 'kb') setShowKB(true)
    else if (p === 'plan') setShowPlan(true)
    else if (p === 'test') setShowTest(true)
    else if (p === 'member' || p === 'recharge') {
      if (!user) { setShowAuth(true); return }  // 匿名用户点充值 → 引导登录
      setShowRecharge(true)
    }
    else if (p === 'settings') setShowSettings(true)
    else if (p === 'feedback') setShowFeedback(true)
    else if (p === 'admin-feedback') setShowAdminFeedback(true)
    else if (p === 'admin-analytics') setShowAdminAnalytics(true)
    else if (p === 'admin-accounts') setShowAdminAccounts(true)
    else if (p === 'report') setShowReport(true)
    else if (p === 'usage') setShowUsage(true)
    else if (p === 'tracking') setShowTracking(true)
    else if (p === 'ranking') setShowRanking(true)
  }
  const [isCheckingAuth, setIsCheckingAuth] = useState(true)
  // 会员态信号：从「我的」续费/取消后自增，驱动首页用量刷新（跨组件同步）
  const [billingTick, setBillingTick] = useState(0)
  const notifyMembershipChanged = () => setBillingTick((t) => t + 1)
  // 「我的」里点「商家常问」→ 暂存问题，关闭「我的」并由首页顾问发出
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const askAdvisor = (prompt: string) => {
    setPendingPrompt(prompt)
    setShowProfile(false)
  }

  // 登录后：把本机匿名会员并入账号（跨设备跟随），再做一次会员态刷新
  const afterLogin = async (authenticatedUser: User) => {
    setUser(authenticatedUser)
    try {
      await billingAPI.linkDevice(deviceStorage.get())
    } catch {
      // 迁移失败不阻塞登录：会员态以账号自身为准，下次登录会重试
    }
    notifyMembershipChanged()
  }

  useEffect(() => {
    const token = tokenStorage.get()
    if (!token) {
      setIsCheckingAuth(false)
      return
    }
    authAPI.me()
      .then(async (u) => {
        setUser(u)
        // 恢复登录态时也把本机匿名会员并入账号（跨设备跟随），await 保证首页挂载前迁移完成
        try {
          await billingAPI.linkDevice(deviceStorage.get())
        } catch {
          // 迁移失败不阻塞：会员态以账号自身为准，下次登录会重试
        }
      })
      .catch(() => tokenStorage.clear())
      .finally(() => setIsCheckingAuth(false))
  }, [])

  const logout = async () => {
    try {
      await authAPI.logout()
    } catch {
      // 本地清理仍然需要执行，避免失效 token 阻塞退出
    }
    tokenStorage.clear()
    setUser(null)
  }

  if (isCheckingAuth) return null

  return (
    <QueryClientProvider client={queryClient}>
      <View style={styles.root}>
        <View style={styles.frame}>
          <WorkspaceScreen user={user} onLogout={logout} onLogin={() => setShowAuth(true)} onOpenProfile={() => setShowProfile(true)} onOpenFeedback={() => setShowFeedback(true)} onOpenRecharge={() => setShowRecharge(true)} onOpenTest={() => setShowTest(true)} onOpenRanking={() => setShowRanking(true)} onMembershipChanged={notifyMembershipChanged} membershipTick={billingTick} initialPrompt={pendingPrompt} onConsumePrompt={() => setPendingPrompt(null)} />
          <ProfileScreen
            visible={showProfile}
            onClose={() => setShowProfile(false)}
            user={user}
            onLogout={logout}
            onLogin={() => setShowAuth(true)}
            onMembershipChanged={notifyMembershipChanged}
            onAskAdvisor={askAdvisor}
            onOpenPage={openPage}
          />
          <KBScreen visible={showKB} onClose={() => setShowKB(false)} />
          <PlanScreen visible={showPlan} onClose={() => setShowPlan(false)} />
          <TestScreen visible={showTest} onClose={() => setShowTest(false)} />
          <SettingsScreen visible={showSettings} onClose={() => setShowSettings(false)} user={user} onLogout={logout} onOpenPage={openPage} onProfileUpdated={setUser} />
          <RechargeScreen visible={showRecharge} onClose={() => setShowRecharge(false)} user={user} onRecharged={notifyMembershipChanged} />
          <FeedbackScreen visible={showFeedback} onClose={() => setShowFeedback(false)} user={user} />
          <AdminFeedbackScreen visible={showAdminFeedback} onClose={() => setShowAdminFeedback(false)} />
          <AdminAnalyticsScreen visible={showAdminAnalytics} onClose={() => setShowAdminAnalytics(false)} />
          <AdminAccountsScreen visible={showAdminAccounts} onClose={() => setShowAdminAccounts(false)} />
          <SelectionReportScreen visible={showReport} onClose={() => setShowReport(false)} />
          <UsageScreen visible={showUsage} onClose={() => setShowUsage(false)} />
          <TrackingScreen visible={showTracking} onClose={() => setShowTracking(false)} />
          <RankingScreen visible={showRanking} onClose={() => setShowRanking(false)} />
          {/* 登录弹窗放到最后：确保它始终叠加在个人页/各页面 Modal 之上（RN Modal 按声明顺序后声明者在上层） */}
          {/* animationType="none"：RN-Web 的 slide/fade 动画在 web 上内容会先移出/透明 → 滑入/淡入过程中背后匿名首页会裸出闪烁。none=立即整屏不透明显示，杜绝露出背景。 */}
          <Modal visible={showAuth} animationType="none" onRequestClose={() => setShowAuth(false)}>
            <AuthScreen onAuthenticated={(authenticatedUser) => { afterLogin(authenticatedUser); setShowAuth(false) }} onBack={() => setShowAuth(false)} />
          </Modal>
        </View>
      </View>
      <StatusBar style="dark" />
    </QueryClientProvider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F0F4FF',
  },
  frame: {
    width: '100%',
    flex: 1,
    backgroundColor: 'transparent',
  },
})
