import React from 'react'
import Svg, { Path, Circle, Rect, Polyline, Line } from 'react-native-svg'

/**
 * 线性图标库（设置页用）：stroke 式，currentColor 继承主题文字色，无 emoji/颜文字。
 * geRatio 统一 24x24 viewBox，宽高由调用方指定。
 */
type IconProps = { size?: number; color?: string; strokeWidth?: number }

function base(size = 22, color = 'currentColor', strokeWidth = 1.7) {
  return { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
}

/** 徽章/钱包：充值余额 */
export const IconWallet = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Rect x={3} y={6} width={18} height={13} rx={3} />
    <Path d="M3 9.5h18" />
    <Path d="M16 13h1.5" />
  </Svg>
)

/** 铃铛：通知偏好 */
export const IconBell = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" />
    <Path d="M10 19a2 2 0 0 0 4 0" />
  </Svg>
)

/** 文档/报告：消耗明细 */
export const IconDoc = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Path d="M7 3h7l4 4v14H7z" />
    <Path d="M14 3v4h4" />
    <Line x1={9.5} y1={12} x2={14.5} y2={12} />
    <Line x1={9.5} y1={16} x2={14.5} y2={16} />
  </Svg>
)

/** 信息 i：关于 */
export const IconInfo = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Circle cx={12} cy={12} r={9} />
    <Line x1={12} y1={11} x2={12} y2={16} />
    <Circle cx={12} cy={8} r={0.8} fill={color} stroke="none" />
  </Svg>
)

/** 登出 */
export const IconLogout = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6" />
    <Polyline points="9 12 21 12" />
    <Polyline points="17 8 21 12 17 16" />
  </Svg>
)

/** 右箭头 chevron */
export const IconChevronRight = ({ size = 16, color = 'currentColor', strokeWidth = 2 }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Polyline points="9 5 16 12 9 19" />
  </Svg>
)

/** 用户/档案 */
export const IconUser = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Circle cx={12} cy={8} r={4} />
    <Path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
  </Svg>
)

/** 锁 */
export const IconLock = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Rect x={5} y={11} width={14} height={9} rx={2} />
    <Path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
)

/** 邮箱（实名/找回密码用） */
export const IconMail = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Rect x={3} y={5} width={18} height={14} rx={3} />
    <Path d="M4 7l8 6 8-6" />
  </Svg>
)

/** 铅笔改 */
export const IconEdit = ({ size, color, strokeWidth }: IconProps) => (
  <Svg {...base(size, color, strokeWidth)}>
    <Path d="M4 20h16" />
    <Path d="M14.5 5.5l4 4L8 20H4v-4z" />
  </Svg>
)
