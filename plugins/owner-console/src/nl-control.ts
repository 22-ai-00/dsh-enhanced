/**
 * Pure browser-safe natural-language parser and summary formatter for owner self-iteration controls
 * and version/self-iteration queries.
 * Shared across Host tools/services and the browser chat surface (zero node:* imports).
 */

import type { AssistantVersionPluginEntry, AssistantVersionReport } from './typert.js'

export type OwnerSelfIterationAction =
  | 'enableSelfIteration'
  | 'disableSelfIteration'
  | 'upgradeAssistantAndRecover'

export interface ParsedOwnerSelfIterationCommand {
  readonly action: OwnerSelfIterationAction
  readonly sourceText: string
}

export type OwnerVersionQueryIntent = 'slash' | 'version' | 'selfIterationCount'

export interface ParsedOwnerVersionQuery {
  readonly intent: OwnerVersionQueryIntent
  readonly sourceText: string
}

const ENABLE_PATTERN = /^(?:开启自迭代|打开自迭代|启用自迭代|恢复自迭代|enable\s+autonomy|enable\s+self[-\s]+iteration|\/autonomy\s+enable)$/iu
const DISABLE_PATTERN = /^(?:关闭自迭代|停用自迭代|暂停自迭代|disable\s+autonomy|disable\s+self[-\s]+iteration|\/autonomy\s+disable)$/iu
const UPGRADE_PATTERN = /^(?:升级整体助手|升级助手|upgrade\s+assistant|upgrade\s+autonomy|\/autonomy\s+upgrade)$/iu
const EXACT_SLASH_UPDATE_PATTERN = /^\/(?:update|upgrade)$/iu
const SLASH_UPDATE_ATTEMPT_PATTERN = /^\/(?:update|upgrade)(?:$|[^a-z0-9_-])/iu

export const OWNER_UPDATE_SLASH_USAGE = '用法：/update 或 /upgrade（不接受额外参数）；如需升级并恢复整体助手，请直接发送 /update。'

export function parseOwnerUpdateSlashUsageError(text: string): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (EXACT_SLASH_UPDATE_PATTERN.test(trimmed)) return undefined
  return SLASH_UPDATE_ATTEMPT_PATTERN.test(trimmed) ? OWNER_UPDATE_SLASH_USAGE : undefined
}

const SLASH_VERSION_PATTERN = /^\/(?:version(?:\s+--short)?|autonomy[\t ]+version)$/iu

const OWNER_VERSION_QUERY_PHRASES: Readonly<Record<string, OwnerVersionQueryIntent>> = Object.freeze({
  '查看版本': 'version',
  '查看版本信息': 'version',
  '查看当前版本': 'version',
  '查看助手版本': 'version',
  '查版本': 'version',
  '看版本': 'version',
  '版本信息': 'version',
  '当前版本': 'version',
  '现在版本': 'version',
  '现在什么版本': 'version',
  '现在是什么版本': 'version',
  '当前是什么版本': 'version',
  '助手版本': 'version',
  '助手当前版本': 'version',
  '当前助手版本': 'version',
  '整体助手版本': 'version',
  '助手是什么版本': 'version',
  'version': 'version',
  'assistant version': 'version',
  'version info': 'version',
  'current version': 'version',
  'autonomy version': 'version',
  'check version': 'version',
  'show version': 'version',
  '查看自迭代次数': 'selfIterationCount',
  '自迭代次数': 'selfIterationCount',
  '查看自迭代统计': 'selfIterationCount',
  '自迭代统计': 'selfIterationCount',
  '查看进化次数': 'selfIterationCount',
  '进化次数': 'selfIterationCount',
  '自己迭代了多少次': 'selfIterationCount',
  '迭代了多少次': 'selfIterationCount',
  '自迭代了多少次': 'selfIterationCount',
  '进化了多少次': 'selfIterationCount',
  '自我迭代了多少次': 'selfIterationCount',
  '助手迭代了多少次': 'selfIterationCount',
  '助手自迭代了多少次': 'selfIterationCount',
  '助手进化了多少次': 'selfIterationCount',
  '总共迭代了多少次': 'selfIterationCount',
  '累计迭代了多少次': 'selfIterationCount',
  '版本与自迭代次数': 'selfIterationCount',
  '版本和自迭代次数': 'selfIterationCount',
  '版本和迭代次数': 'selfIterationCount',
  'self-iteration count': 'selfIterationCount',
  'self iteration count': 'selfIterationCount',
  'iteration count': 'selfIterationCount',
  'how many iterations': 'selfIterationCount',
  'how many self-iterations': 'selfIterationCount',
})

/** Parse concise Chinese/English owner self-iteration control intents; returns undefined for ordinary chat. */
export function parseOwnerSelfIterationCommand(
  text: string,
): ParsedOwnerSelfIterationCommand | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (EXACT_SLASH_UPDATE_PATTERN.test(trimmed)) {
    return { action: 'upgradeAssistantAndRecover', sourceText: trimmed }
  }
  if (SLASH_UPDATE_ATTEMPT_PATTERN.test(trimmed)) return undefined
  if (/[?？]$/u.test(trimmed)) return undefined
  const normalized = trimmed.replace(/[。！!.]+$/u, '').trim()
  if (normalized === '') return undefined

  if (ENABLE_PATTERN.test(normalized)) {
    return { action: 'enableSelfIteration', sourceText: trimmed }
  }
  if (DISABLE_PATTERN.test(normalized)) {
    return { action: 'disableSelfIteration', sourceText: trimmed }
  }
  if (UPGRADE_PATTERN.test(normalized)) {
    return { action: 'upgradeAssistantAndRecover', sourceText: trimmed }
  }
  return undefined
}

/**
 * Parse `/version`, `/version --short`, `/autonomy version`, and closed-set concise Chinese/English
 * version or self-iteration-count queries (zero overlap with `parseOwnerSelfIterationCommand`).
 */
export function parseOwnerVersionQuery(
  text: string,
): ParsedOwnerVersionQuery | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (SLASH_VERSION_PATTERN.test(trimmed)) {
    return Object.freeze({ intent: 'slash', sourceText: trimmed })
  }
  const normalized = trimmed.replace(/[。.!！?？]+$/u, '').trim().replace(/[\t ]+/gu, ' ').toLowerCase()
  if (normalized === '') return undefined
  const intent = Object.hasOwn(OWNER_VERSION_QUERY_PHRASES, normalized)
    ? OWNER_VERSION_QUERY_PHRASES[normalized]
    : undefined
  if (intent === undefined) return undefined
  return Object.freeze({ intent, sourceText: trimmed })
}

function formatNullableCount(value: number | null): string {
  return value === null ? '无账本数据' : String(value)
}

function formatPluginList(entries: readonly AssistantVersionPluginEntry[], limit = 12): string {
  if (entries.length === 0) return '无'
  const shown = entries.slice(0, limit).map(entry => {
    const ver = entry.version ? `@${entry.version}` : ''
    const flags: string[] = []
    if (entry.installKind !== undefined) flags.push(entry.installKind)
    if (entry.enabled === false) flags.push('disabled')
    const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : ''
    return `\`${entry.name}${ver}\`${suffix}`
  })
  if (entries.length > limit) {
    shown.push(`等共 ${entries.length} 个`)
  }
  return shown.join('、')
}

/** Browser-safe Markdown summary formatter for `AssistantVersionReport` (`dsh-ray/version/v1`). */
export function formatOwnerConsoleVersionSummary(report: AssistantVersionReport): string {
  const s = report.selfIteration
  const dataStateText = s.dataState === 'no-data'
    ? '无可用只读账本数据 (`no-data`)'
    : s.dataState === 'zero'
      ? '账本已就绪，当前累计计数为 0 (`zero`)'
      : '已汇总只读账本统计 (`data`)'

  const lines: string[] = [
    '### 助手版本与自迭代概览',
    '',
    `- **整体助手版本**：\`${report.assistant.name}\` **v${report.assistant.version}**${report.assistant.cliVersion ? `（CLI v${report.assistant.cliVersion}）` : ''}`,
    `- **DSH Host (${report.host.packageName})**：绑定 \`${report.host.boundVersion ?? '未绑定'}\`（${report.host.boundStatus}） / 运行 \`${report.host.runningVersion ?? '未知'}\``,
    `- **Profile**：\`${report.profile ?? '未指定'}\`${report.profiles && report.profiles.length > 0 ? `（全部：${report.profiles.map(p => `\`${p}\``).join('、')}）` : ''}`,
    `- **插件概览**（${report.plugins.state}）：核心 **${report.plugins.coreCount}** 个，自演进 **${report.plugins.evolvedCount}** 个（已激活 **${report.plugins.activeEvolvedCount}** 个）`,
  ]

  if (report.plugins.core.length > 0) {
    lines.push(`  - 核心插件：${formatPluginList(report.plugins.core)}`)
  }
  if (report.plugins.evolved.length > 0) {
    lines.push(`  - 自演进插件：${formatPluginList(report.plugins.evolved)}`)
  }

  lines.push(
    '',
    `#### 自迭代与演进统计（${dataStateText}）`,
    `- **累计自迭代次数**：**${formatNullableCount(s.totalIterations)}**`,
    `- **执行与任务**：工作项 \`${formatNullableCount(s.workItemsTotal)}\`（已结算 \`${formatNullableCount(s.workItemsSettled)}\`） · 成长任务 \`${formatNullableCount(s.growthUsageJobsTotal)}\` · 做梦 \`${formatNullableCount(s.dreamingRuns)}\` · 恢复 \`${formatNullableCount(s.recoveryRuns)}\` · 策略 \`${formatNullableCount(s.goalStrategyRuns)}\``,
    `- **候选与插件演进**：生成 \`${formatNullableCount(s.candidatesGenerated)}\` · 采用 \`${formatNullableCount(s.candidatesAdopted)}\` · 新建插件 \`${formatNullableCount(s.pluginsCreated)}\` · 修订插件 \`${formatNullableCount(s.pluginsRevised)}\` · 验收通过 \`${formatNullableCount(s.taskVerificationsDone)}\` · 回退 \`${formatNullableCount(s.rollbacks)}\``,
    `- **规则与参数演进**：演进规则 \`${formatNullableCount(s.evolutionRulesAdopted)}\` · 联想参数版本 \`${formatNullableCount(s.associationParamVersion)}\`（采用 \`${formatNullableCount(s.associationProfileAdoptions)}\`） · 评估调优 \`${formatNullableCount(s.evaluationAttentionTuningAdoptions)}\` / 放宽采用 \`${formatNullableCount(s.evaluationLooseningDecisionsAdopted)}\``,
    `- **记忆、技能与升级**：活跃记忆 \`${formatNullableCount(s.activeMemories)}\` · 偏好覆盖 \`${formatNullableCount(s.activePreferenceOverlays)}\` · 工作流晋升 \`${formatNullableCount(s.workflowCandidatesPromoted)}\` · 技能部署 \`${formatNullableCount(s.skillDeployments)}\` · 自我升级 \`${formatNullableCount(s.selfUpgrades)}\` · 升级备份 \`${formatNullableCount(s.backupSnapshotsCount)}\``,
  )

  return lines.join('\n')
}
