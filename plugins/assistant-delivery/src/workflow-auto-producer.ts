/**
 * Closed, deterministic automatic-workflow catalog.
 *
 * The inbound text is used only as an exact selector.  No substring, token,
 * argument, or normalized user value reaches the returned descriptor.  This
 * makes the descriptor safe to place in a deterministic-deidentification
 * template; arbitrary natural language must use the owner-explicit
 * `/workflow save` route instead.
 */
export interface DeterministicallyDeidentifiedWorkflowTemplate {
  /** Stable reviewed catalog identity, not an owner-provided name. */
  readonly catalogId: string
  readonly name: string
  readonly prompt: string
  readonly schedule: Readonly<{
    readonly kind: 'cron'
    readonly expression: string
    readonly timezone: string
  }>
  readonly timeoutMs: number
  readonly toolCatalogIds: readonly ['assistant.agent-turn']
}

const dailyWorkspaceStatusSummary = Object.freeze({
  catalogId: 'daily-workspace-status-summary-v1',
  name: 'Daily workspace status summary',
  prompt: 'Prepare the daily workspace status summary from current workspace context. '
    + 'Include completed work, blockers, and next steps. Do not rely on prior delivery content.',
  schedule: Object.freeze({ kind: 'cron' as const, expression: '0 9 * * *', timezone: 'UTC' }),
  timeoutMs: 60_000,
  toolCatalogIds: Object.freeze(['assistant.agent-turn'] as const),
} satisfies DeterministicallyDeidentifiedWorkflowTemplate)

const weeklyWorkspaceStatusSummary = Object.freeze({
  catalogId: 'weekly-workspace-status-summary-v1',
  name: 'Weekly workspace status summary',
  prompt: 'Prepare the weekly workspace status summary from current workspace context. '
    + 'Include completed work, blockers, and next steps. Do not rely on prior delivery content.',
  schedule: Object.freeze({ kind: 'cron' as const, expression: '0 9 * * 1', timezone: 'UTC' }),
  timeoutMs: 60_000,
  toolCatalogIds: Object.freeze(['assistant.agent-turn'] as const),
} satisfies DeterministicallyDeidentifiedWorkflowTemplate)

/**
 * Exact phrases intentionally remain few.  Adding an alias is a reviewed
 * catalog change: it must still map to an already-reviewed static descriptor
 * and must never copy owner text into any returned field.
 */
const exactTemplates = new Map<string, Readonly<DeterministicallyDeidentifiedWorkflowTemplate>>([
  ['prepare daily workspace status summary', dailyWorkspaceStatusSummary],
  ['prepare the daily workspace status summary', dailyWorkspaceStatusSummary],
  ['准备每日工作区状态摘要', dailyWorkspaceStatusSummary],
  ['prepare weekly workspace status summary', weeklyWorkspaceStatusSummary],
  ['prepare the weekly workspace status summary', weeklyWorkspaceStatusSummary],
  ['准备每周工作区状态摘要', weeklyWorkspaceStatusSummary],
])

const catalogTemplates = new Map<string, Readonly<DeterministicallyDeidentifiedWorkflowTemplate>>([
  [dailyWorkspaceStatusSummary.catalogId, dailyWorkspaceStatusSummary],
  [weeklyWorkspaceStatusSummary.catalogId, weeklyWorkspaceStatusSummary],
])

/**
 * Return a reviewed content-free descriptor only for an exact closed-set
 * phrase.  Deliberately do not trim, fold case, parse arguments, or extract
 * entities: those conveniences would turn unreviewed owner data into a
 * purported deidentification proof.
 */
export function deriveDeterministicallyDeidentifiedWorkflowTemplate(
  text: string,
): Readonly<DeterministicallyDeidentifiedWorkflowTemplate> | undefined {
  if (typeof text !== 'string' || text.normalize('NFC') !== text) return undefined
  return exactTemplates.get(text)
}

/**
 * Validate a durable catalog receipt without consulting owner-controlled text.
 * This is deliberately separate from the phrase selector above so registry
 * recovery can prove that a stored deterministic receipt still points at the
 * same reviewed static descriptor.
 */
export function getDeterministicallyDeidentifiedWorkflowTemplate(
  catalogId: string,
): Readonly<DeterministicallyDeidentifiedWorkflowTemplate> | undefined {
  if (typeof catalogId !== 'string') return undefined
  return catalogTemplates.get(catalogId)
}
