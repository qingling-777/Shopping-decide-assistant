export const colors = {
  // 背景（纯净白底：全站对齐，浅色统一 #FFFFFF，元素靠发丝边框/柔影分层）
  pageBg: '#FFFFFF',
  pageBgGradient: ['#FFFFFF', '#FFFFFF', '#FFFFFF'] as const,
  cardBg: '#FFFFFF',
  cardBgGlass: 'rgba(255, 255, 255, 0.65)',

  // 主色（更浅一档旗舰蓝；用于顶栏蓝条/主按钮/聊天用户气泡等大色块）
  primary: '#3B82F6',
  primaryDark: '#1E40AF',
  // 亮蓝副色：仅作光晕/渐变副色（蓝系），不用于大色块；品牌双色唯一：主蓝 #3B82F6 + 克制金 #C9A24B
  primaryBright: '#60A5FA',

  // 状态色
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',

  // 会员微金（微提亮，更显金；免费款保持朴素、会员款金面主视觉）
  gold: '#C9A24B',
  goldDeep: '#7A5C12', // 浅色 on goldBg 约 4.65:1，过 WCAG AA
  goldBg: '#FBF6EA',
  goldBorder: '#E7D6A8',

  // 文字
  textPrimary: '#0F172A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',

  // 边框
  border: '#E2E8F0',
  borderLight: '#F1F5F9',

  // 语义价格色（P1：从 danger 误用中拆出，价格不再用红色）
  price: '#0F172A', // 现价/价格本体：用正文色，靠字号字重表达，不染色
  sale: '#EF4444', // 促销/降价/折扣价：真红（涨=红 的中文行情约定）
  error: '#EF4444', // 错误/危险提示：与 sale 同红，但语义独立
  up: '#EF4444', // 涨（中国行情：红涨）
  down: '#10B981', // 跌（中国行情：绿跌）
}

// 金属金边：模拟真金镶边的高光渐变（LinearGradient colors），用于会员显示的描边
export const goldRim = ['#F0D98A', '#C9A24B', '#9A7B2E', '#E7D6A8'] as const

// 语义浅染：每张卡按含义染极浅一层（Refactoring UI 手法），配同色调发丝边框
export const surfaceTints = {
  risk: { bg: '#FEF2F2', border: '#FECACA' },
  data: { bg: '#EFF6FF', border: '#BFDBFE' },
  action: { bg: '#F0FDF4', border: '#BBF7D0' },
  opportunity: { bg: '#FFFBEB', border: '#FDE68A' },
  hot: { bg: '#FFF7F0', border: '#FED7AA' },
  neutral: { bg: '#FFFFFF', border: '#E2E8F0' },
}

/**
 * 暗色语义浅染（P1 补齐）：同语义低饱和深底 + 同色发丝边框。
 * 避免暗色下红/黄/绿/蓝实底卡刺眼（原 surfaceTints 仅浅色）。
 */
export const darkSurfaceTints = {
  risk: { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.28)' },
  data: { bg: 'rgba(96,165,250,0.10)', border: 'rgba(96,165,250,0.28)' },
  action: { bg: 'rgba(52,211,153,0.10)', border: 'rgba(52,211,153,0.28)' },
  opportunity: { bg: 'rgba(224,189,107,0.10)', border: 'rgba(224,189,107,0.28)' },
  hot: { bg: 'rgba(249,115,22,0.10)', border: 'rgba(249,115,22,0.30)' },
  neutral: { bg: '#0D1424', border: '#21304A' },
}

export const gradients = {
  // 三色渐变更立体（SaaS 旗舰感）
  strong_recommend: ['#0EA5E9', '#3B82F6', '#10B981'] as const,
  recommend: ['#3B82F6', '#3B82F6', '#60A5FA'] as const,
  cautious: ['#F59E0B', '#FBBF24'] as const,
  // 紫→slate（去紫铁律）
  observe: ['#475569', '#64748B'] as const,
  not_recommend: ['#EF4444', '#F97316'] as const,
  // 新增：品牌色 hero 渐变（顶栏品牌条/封面/提交按钮主视觉）
  hero: ['#3B82F6', '#3B82F6', '#60A5FA'] as const,
  // 新增：会员金面主视觉（我的页/会员中心）
  goldFace: ['#F0D98A', '#C9A24B', '#9A7B2E'] as const,
}

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xl2: 24, // Klarna 消费级大圆角：商品卡/弹层/大卡
}

/**
 * Klarna 式 diffuse 多层柔影（web boxShadow；native 端用 elevation.float 近似）。
 * 多层柔影 = 高级感来源：近层细、中层泛蓝、远层极散，避免"贴片"式硬阴影。
 */
export const shadows = {
  card: '0 1px 2px rgba(15,23,42,0.04), 0 10px 24px -8px rgba(59,130,246,0.10), 0 28px 56px -24px rgba(15,23,42,0.18)',
  cardDark: '0 2px 6px rgba(0,0,0,0.42), 0 18px 44px -14px rgba(0,0,0,0.60), 0 44px 88px -32px rgba(0,0,0,0.72)',
  floating: '0 8px 30px -8px rgba(59,130,246,0.18), 0 2px 8px rgba(15,23,42,0.06)',
  floatingDark: '0 10px 34px -10px rgba(0,0,0,0.62), 0 2px 8px rgba(0,0,0,0.46)',
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
}

export const typography = {
  h1: { fontSize: 24, fontWeight: '700' as const, color: colors.textPrimary },
  h2: { fontSize: 20, fontWeight: '700' as const, color: colors.textPrimary },
  h3: { fontSize: 17, fontWeight: '600' as const, color: colors.textPrimary },
  body: { fontSize: 15, fontWeight: '400' as const, color: colors.textPrimary },
  caption: { fontSize: 13, fontWeight: '400' as const, color: colors.textSecondary },
  small: { fontSize: 12, fontWeight: '400' as const, color: colors.textMuted },
}

/**
 * 字号梯度令牌（P1）：统一一套 11→13→15→17→19→24 的字号阶梯，
 * 取代散落的裸 fontSize，保证跨页层级一致、可整体调参。
 */
export const fontSize = {
  xxs: 11,
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 19,
  xxl: 24,
} as const

/**
 * 层级令牌（P1）：三种统一的「浮起」语言，取代 boxShadow / 发丝边框 / 金渐变 三套混用。
 * - flat：静态卡片，用发丝边框表达边界（默认）
 * - float：悬浮层（弹窗/菜单/侧栏/商品卡/统计卡），用柔和阴影（中度加深）
 * - pressed：按压反馈
 */
export const elevation = {
  flat: {
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: 'transparent',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  float: {
    borderWidth: 0,
    shadowColor: '#0F172A',
    shadowOpacity: 0.18,           // 0.12 → 0.18：浮起更深，旗舰感
    shadowRadius: 20,              // 16 → 20：柔光更宽
    shadowOffset: { width: 0, height: 10 },  // 0,8 → 0,10：向下投影更明显
    elevation: 10,
  },
  pressed: {
    borderWidth: 1,
    borderColor: colors.primary + '40',
    shadowColor: colors.primary,
    shadowOpacity: 0.22,           // 0.18 → 0.22
    shadowRadius: 12,              // 10 → 12
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
} as const

/**
 * 卡片 hover 光晕（web 端用，react-native-web 的 :hover 选择器消费）
 * 浅色 .12 / 暗色 .18 强度，与 elevation.float 配合形成"双层光"
 */
export const cardHoverGlow = {
  light: 'rgba(59, 130, 246, 0.06)',
  dark: 'rgba(96, 165, 250, 0.18)',
} as const

/**
 * 暗色令牌：与浅色同源，接 useColorScheme 切换（见 utils/theme.ts 的 useAppColors）。
 * 金/语义价色在暗色下提亮，保证对比度。
 * 中度暗色：背景更深、卡片更深、金更亮，营造旗舰感。
 */
export const dark = {
  pageBg: '#070A12',          // Stream B 最终值：更深，提升浅色文字对比（text1 16.9:1 AAA）
  pageBgGradient: ['#070A12', '#0B1220', '#0D1424'] as const, // 暗色玻璃渐变底（与浅色同构，更深沉）
  cardBg: '#0D1424',          // Stream B 最终值：更深沉
  primary: '#3B82F6',         // 暗色主色对齐品牌双色（主理人决策 C：暗色主色仍 #3B82F6，亮蓝仅作光晕副色）
  primaryDark: '#1E3A8A',
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
  gold: '#E0BD6B',            // 暗色下提亮，更显金
  goldDeep: '#B8943F',
  goldBg: 'rgba(224,189,107,0.12)',
  goldBorder: 'rgba(224,189,107,0.34)',
  textPrimary: '#E8EEF6',
  textSecondary: '#9FB0C3',
  textMuted: '#64748B',
  border: '#21304A',
  borderLight: '#1A2740',
  price: '#E8EEF6',
  sale: '#F87171',
  error: '#F87171',
  up: '#F87171',
  down: '#34D399',
  // 暗色小字提亮（历史欠账修复）：更深底下的次要/三级文字与蓝字走提亮档，保证 8.4:1 AAA
  text2strong: '#A6B4C7',
  text3: '#7A8AA0',
  blueInk: '#7DB1FF',
} as const

/**
 * 毛玻璃令牌（轻量玻璃拟态）：固定层（顶栏/composer）叠半透明底 + 发丝下边。
 * RN 无 backdrop-filter，用半透明实底近似；浅/暗各一套。
 * 中度升级：alpha 提到 0.78/0.74，玻璃感更显。
 */
export const glass = {
  light: { bg: 'rgba(255,255,255,0.78)', border: 'rgba(226,232,240,0.9)' },
  dark: { bg: 'rgba(15,26,46,0.74)', border: 'rgba(33,48,74,0.9)' },
  // 玻璃强度令牌（Stream B）：强玻璃 overlay 24px / saturate 170 用于浮层/弹窗/会员卡/顶栏/composer；
  // 弱玻璃 soft 13px / saturate 130 用于普通卡 hover/focus 柔光叠层。
  // 注：RN 无 backdrop-filter，强玻璃用半透明分层实底 + 多层柔影(raised-glass)近似（见 components/Glow、ScreenFrame）。
  overlayBlur: 24,
  overlaySaturate: 170,
  softBlur: 13,
  softSaturate: 130,
} as const

/**
 * 玻璃卡片统一规范（P1：全站 blur 分级唯一来源，收敛 40/20/12 三值漂移）。
 * - glassCardLight / glassCardDark：内容卡「中玻璃 20px / sat 150」+ Klarna diffuse 多层柔影 + 发丝白边。
 * - strongGlass 强玻璃：顶栏 / composer / 弹层 / 会员金卡（24px / sat 170，对应 glass.overlayBlur）。
 * - lightGlass 轻玻璃：chips / 快捷按钮 / 思考面板 / AI 气泡（12px，低 alpha 保可读性）。
 */
export const glassCardLight = {
  backgroundColor: 'rgba(255,255,255,0.55)',
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.35)',
} as const

export const glassCardDark = {
  backgroundColor: 'rgba(15,26,46,0.60)',
  borderWidth: 1,
  borderColor: 'rgba(33,48,74,0.55)',
} as const

/**
 * 动效令牌（克制）：单段 ≤200ms；进场 translateY 8→10px（中度略强）；stagger 60ms；press 缩放 .98→.97。
 * 配合 useReducedMotion 在「减少动态」时退化为 duration 0 / 无位移 / 无缩放。
 */
export const motion = {
  // 轨道 A 静基底（维持克制）：单段 ≤200ms
  duration: {
    fast: 120,
    mid: 180,
    slow: 200,
    // 轨道 B 核心交互放开（物理感）：单段 300–500ms
    page: 400,
    sheet: 440,
    overlay: 320,
    staggerItem: 340,
    countTail: 200,
  },
  // RN Animated 用 Easing.bezier，见 utils/theme.ts 的 EASE
  ease: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    springSoft: 'cubic-bezier(.32,1.30,.64,1)', // 沉弹 ~6-8% overshoot（sheet/会员金卡/磁性回弹）
    apple: 'cubic-bezier(.22,1,.36,1)',         // 沉无过冲（转场/sheet/overlay/push）
  },
  stagger: 60,
  pressScale: 0.97,           // 0.98 → 0.97：中度按压反馈略强
  enterTranslateY: 10,        // 8 → 10：中度进场位移略大
  // 欢迎区「缓慢上浮」：位移与时长加大到肉眼可感知（明显能看到浮上来，而非轻微/闪现）
  welcomeDuration: 900,
  welcomeEnterY: 40,
} as const
