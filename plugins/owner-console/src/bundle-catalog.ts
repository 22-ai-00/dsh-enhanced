import { CUSTOM_MODEL_OPTION } from './model-route-ui.js'
import type { OwnerConsoleStatus } from './typert.js'

export const INSTALL_ALL_AVAILABLE_OPTION = '__all_available__'
export const CUSTOM_BUNDLE_OPTION = CUSTOM_MODEL_OPTION
export const OWNER_CONSOLE_PACKAGE = '@dsh-ray/owner-console'
export const PERSONAL_ASSISTANT_PACKAGE = '@dsh-ray/personal-assistant'
export const PERSONAL_ASSISTANT_SPLIT_PACKAGES = Object.freeze([
  '@dsh-ray/assistant-policy',
  '@dsh-ray/personal-memory',
  '@dsh-ray/personal-wiki',
  '@dsh-ray/assistant-automations',
] as const)

export type ProjectBundleCategory = 'core' | 'channels' | 'models' | 'autonomy' | 'safety' | 'special'

export interface ProjectBundleCatalogEntry {
  readonly name: `@dsh-ray/${string}`
  readonly label: string
  readonly category: ProjectBundleCategory
  readonly availability: 'standard' | 'pa-split' | 'special'
  readonly excludeReason?: string
}

/**
 * Complete catalog of all @dsh-ray/* DSH bundles in topological provider-first order.
 * Standard bundles can be safely batch-installed into Desktop/Web profiles without
 * duplicating host-runner, disabling native session-controller, or colliding with
 * the personal-assistant meta-bundle.
 */
export const PROJECT_BUNDLE_CATALOG: readonly ProjectBundleCatalogEntry[] = Object.freeze([
  Object.freeze({
    name: '@dsh-ray/personal-assistant',
    label: '个人助手四核心组合（策略 / 记忆 / 知识库 / 调度）',
    category: 'core',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-policy',
    label: '策略授权、预算与脱敏审计边界（拆分版）',
    category: 'core',
    availability: 'pa-split',
  }),
  Object.freeze({
    name: '@dsh-ray/personal-memory',
    label: '有界长期记忆存储与检索（拆分版）',
    category: 'core',
    availability: 'pa-split',
  }),
  Object.freeze({
    name: '@dsh-ray/personal-wiki',
    label: 'Markdown 个人知识库（拆分版）',
    category: 'core',
    availability: 'pa-split',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-automations',
    label: '冷启动持久定时调度与执行（拆分版）',
    category: 'core',
    availability: 'pa-split',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-evaluation',
    label: '本地评测与注意力反馈账本',
    category: 'core',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-delivery',
    label: '持久消息投递核心与会话绑定',
    category: 'channels',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/credentials-keychain',
    label: '系统钥匙串 / 凭据安全句柄管理',
    category: 'safety',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-goals',
    label: '持久化长期业务目标管理',
    category: 'core',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-isolation',
    label: '跨平台原生隔离执行沙箱',
    category: 'safety',
    availability: 'special',
    excludeReason: '原生隔离沙箱需通过 CLI --scenario autonomy 预先配置运行时与 cgroup，不随桌面一键安装',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-skills',
    label: '可复用工作流技能库与验收',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-health',
    label: '助手服务健康与就绪聚合报告',
    category: 'safety',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-verifier',
    label: '独立任务验收与候选行为审查',
    category: 'core',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/plugin-control-plane',
    label: '能力缺口发现与插件热加载控制面',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/preference-learning',
    label: '有界反馈偏好自学习',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-evolution',
    label: '审批门控的行为规则自演化',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-association',
    label: '进程内联想记忆召回图',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-work-items',
    label: '后台工作项与观察准入台账',
    category: 'channels',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-proactive',
    label: '主动机会筛选与准备草稿',
    category: 'channels',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-heartbeat',
    label: '活跃时段主动巡检心跳',
    category: 'channels',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-actions',
    label: '有限授权外部动作代理（GitHub / HTTP）',
    category: 'safety',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-deepseek-budget',
    label: '官方 DeepSeek 目标计量路由',
    category: 'models',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-growth-experiments',
    label: '工作流回放 / 影子 / 灰度实验',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-recovery',
    label: '宿主恢复与外部副作用补偿',
    category: 'safety',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-memory-learning',
    label: '任务与工作项经验自动学习',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-dreaming',
    label: '受控后台做梦灵感与联想',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-growth-driver',
    label: '日常使用驱动的持续成长引擎',
    category: 'autonomy',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/event-triggers',
    label: '文件 / Webhook / 日历 / 邮件事件触发器',
    category: 'channels',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/memory-wiki-bridge',
    label: 'Memory 与 Wiki 知识沉淀桥接',
    category: 'safety',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/lark-channel',
    label: '飞书 / Lark 机器人长连接通道',
    category: 'channels',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/coding-subscription-provider',
    label: '本机 Codex / Claude / Cursor / Grok 订阅模型路由',
    category: 'models',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/traex-acp-provider',
    label: '本机 TraeX / Antigravity (agy) ACP 编程代理',
    category: 'models',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/owner-console',
    label: '文鳐 Ray 主人控制台与设置面板',
    category: 'channels',
    availability: 'standard',
  }),
  Object.freeze({
    name: '@dsh-ray/acp',
    label: 'stdio ACP 服务端（用于外部编辑器连接）',
    category: 'special',
    availability: 'special',
    excludeReason: '仅用于独立 stdio ACP profile，与桌面/Web 内置 Host 冲突',
  }),
  Object.freeze({
    name: '@dsh-ray/assistant-web-owner',
    label: 'Web Owner 控制器（需离线 dsh-web-owner-setup）',
    category: 'special',
    availability: 'special',
    excludeReason: '会停用原生 session-controller 且需离线配置，不随桌面一键安装',
  }),
  Object.freeze({
    name: '@dsh-ray/hello',
    label: '最小示例插件（验证安装与构建链路）',
    category: 'special',
    availability: 'special',
    excludeReason: '示例插件，不随一键安装可用插件',
  }),
])

export interface UninstalledBundleItem {
  readonly name: `@dsh-ray/${string}`
  readonly label: string
  readonly category: ProjectBundleCategory
  readonly availableForInstallAll: boolean
  readonly excludeReason?: string
}

export interface UninstalledBundleInventory {
  readonly ready: boolean
  readonly hostUnavailable: boolean
  readonly available: readonly UninstalledBundleItem[]
  readonly excluded: readonly UninstalledBundleItem[]
  readonly all: readonly UninstalledBundleItem[]
}

const PA_SPLIT_SET = new Set<string>(PERSONAL_ASSISTANT_SPLIT_PACKAGES)

/**
 * Derive uninstalled project bundles from Host `status()`, preserving dependency-first install
 * order and separating special/conflicting bundles from the one-click "all available" list.
 */
export function resolveUninstalledBundles(status: OwnerConsoleStatus | undefined): UninstalledBundleInventory {
  if (status === undefined) {
    return Object.freeze({
      ready: false,
      hostUnavailable: false,
      available: Object.freeze([]),
      excluded: Object.freeze([]),
      all: Object.freeze([]),
    })
  }
  if (!status.host.pluginManager || status.host.bundles !== 'ok') {
    return Object.freeze({
      ready: false,
      hostUnavailable: true,
      available: Object.freeze([]),
      excluded: Object.freeze([]),
      all: Object.freeze([]),
    })
  }

  const installedNames = new Set<string>(
    status.bundles.filter(bundle => bundle.installed).map(bundle => bundle.name),
  )
  // This console itself is already running in the profile ("其他未安装的").
  installedNames.add(OWNER_CONSOLE_PACKAGE)

  const enabledNames = new Set<string>([
    ...status.bundles.filter(bundle => bundle.installed && bundle.enabled).map(bundle => bundle.name),
    ...status.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.moduleName),
  ])

  const paInstalled = installedNames.has(PERSONAL_ASSISTANT_PACKAGE)
  const anySplitEnabled = PERSONAL_ASSISTANT_SPLIT_PACKAGES.some(pkg => enabledNames.has(pkg))

  const available: UninstalledBundleItem[] = []
  const excluded: UninstalledBundleItem[] = []

  for (const entry of PROJECT_BUNDLE_CATALOG) {
    if (installedNames.has(entry.name)) continue

    if (entry.availability === 'special') {
      excluded.push(Object.freeze({
        name: entry.name,
        label: entry.label,
        category: entry.category,
        availableForInstallAll: false,
        excludeReason: entry.excludeReason ?? '专用插件，不随一键安装',
      }))
      continue
    }

    if (entry.name === PERSONAL_ASSISTANT_PACKAGE && anySplitEnabled) {
      excluded.push(Object.freeze({
        name: entry.name,
        label: entry.label,
        category: entry.category,
        availableForInstallAll: false,
        excludeReason: '与已启用的拆分版子插件冲突',
      }))
      continue
    }

    if (PA_SPLIT_SET.has(entry.name) && (paInstalled || !anySplitEnabled)) {
      excluded.push(Object.freeze({
        name: entry.name,
        label: entry.label,
        category: entry.category,
        availableForInstallAll: false,
        excludeReason: paInstalled ? '已由 personal-assistant 托管，勿重复启用' : '随 personal-assistant 一并安装',
      }))
      continue
    }

    available.push(Object.freeze({
      name: entry.name,
      label: entry.label,
      category: entry.category,
      availableForInstallAll: true,
    }))
  }

  return Object.freeze({
    ready: true,
    hostUnavailable: false,
    available: Object.freeze(available),
    excluded: Object.freeze(excluded),
    all: Object.freeze([...available, ...excluded]),
  })
}
