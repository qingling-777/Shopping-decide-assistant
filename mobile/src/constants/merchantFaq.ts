// B 端商家（全品类选品人/带货操盘手/达人）最常见的问题。
// q = 列表展示文案；prompt = 点开后直接发给顾问对话的真实提问（比 q 更完整，便于 AI 直接给结论）。

export interface FaqItem {
  id: string
  q: string
  prompt: string
}

export interface FaqGroup {
  title: string
  items: FaqItem[]
}

export const MERCHANT_FAQ: FaqGroup[] = [
  {
    title: '选品方向',
    items: [
      {
        id: 'dir_bonus',
        q: '现在还有哪些品类红利方向值得做？',
        prompt: '现在电商带货还有哪些品类方向值得做、还有红利？帮我列 3-5 个，并说清为什么现在还有机会。',
      },
      {
        id: 'dir_newbie',
        q: '哪个方向最适合新手起量？',
        prompt: '我是带货新手，预算有限，哪个方向最适合起量、容错高？给我具体建议和理由。',
      },
    ],
  },
  {
    title: '这个品值不值得做',
    items: [
      {
        id: 'worth_frame',
        q: '怎么判断一个品值不值得做？',
        prompt: '怎么判断一个品值不值得做？从机会、竞争、佣金、价格带几个维度给我一套判断框架。',
      },
      {
        id: 'worth_roi',
        q: '同样预算选高佣还是高客单？',
        prompt: '同样推广预算，我该选高佣金低客单的品，还是低佣金高客单的品？从 ROI 角度帮我分析。',
      },
    ],
  },
  {
    title: '平台选择',
    items: [
      {
        id: 'plat_choice',
        q: '我适合做抖音还是小红书？',
        prompt: '我适合做抖音还是小红书带货？从流量、内容形式、起量难度帮我对比并给结论。',
      },
      {
        id: 'plat_bend',
        q: 'B 端自己上架卖怎么选平台？',
        prompt: '我是商家自己上架卖货（不是淘客），抖音小店和小红书店铺怎么选？各自利弊是什么？',
      },
    ],
  },
  {
    title: '测品',
    items: [
      {
        id: 'test_lowcost',
        q: '新手怎么低成本测品？',
        prompt: '新手怎么低成本测品？先测几个品、每个品预算多少、怎么看测品结果决定加注？',
      },
      {
        id: 'test_priority',
        q: '测品计划怎么排优先级？',
        prompt: '我有十几个候选品，怎么排测品优先级？给我一个可执行的排序标准。',
      },
    ],
  },
  {
    title: '内容',
    items: [
      {
        id: 'content_script',
        q: '给我写单品推广脚本',
        prompt: '给我写一份单品短视频推广脚本（30-60秒），含开头钩子、卖点、行动号召，直接能拍。',
      },
      {
        id: 'content_diff',
        q: '怎么做出差异化内容？',
        prompt: '同类品那么多，我怎么做出差异化内容不被淹没？给我 3 个差异化的内容角度。',
      },
    ],
  },
  {
    title: '变现',
    items: [
      {
        id: 'grow_lowcost',
        q: '早期怎么低成本起盘？',
        prompt: '早期怎么低成本起盘做带货，要不要先不开店、先用什么方式验证？',
      },
      {
        id: 'grow_distribute',
        q: '选品参谋怎么靠分发赚佣？',
        prompt: '除了订阅，选品顾问怎么靠 C 端分发（带 App 自有 pid 的链接）赚佣金？给我一个可落地的飞轮。',
      },
    ],
  },
]
