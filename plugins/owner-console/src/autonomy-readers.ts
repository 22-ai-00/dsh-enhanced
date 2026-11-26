import type { Context } from '@deepseek-ai/cordis'
import { hasControlChars, type LoaderService } from './settings.js'
import type {
  OwnerConsoleAssistantOverview,
  OwnerConsoleWriteResult,
} from './typert.js'

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown, max = 240): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  return trimmed === '' ? undefined : trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const intOrZero = (value: unknown): number => {
  const n = num(value)
  return n === undefined || n < 0 ? 0 : Math.trunc(n)
}
const bool = (value: unknown): boolean => value === true

const MAX_LIST = 20

function findLoaderConfig(host: Context, moduleName: string): Readonly<{ disabled: boolean; config: Record<string, unknown> }> | undefined {
  const loader = host.get('loader' as never) as Partial<LoaderService> | undefined
  if (typeof loader?.entries !== 'function') return undefined
  try {
    for (const entry of loader.entries()) {
      if (entry.options.name === moduleName) {
        return { disabled: entry.options.disabled === true, config: record(entry.options.config) }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export function resolveOverviewScope(
  host: Context,
  requestedWorkspace: string,
  requestedPreset: string,
): Readonly<{ workspace: string; preset: string }> | undefined {
  const ws = requestedWorkspace.trim()
  const pr = requestedPreset.trim()
  if (ws !== '' && pr !== '') return Object.freeze({ workspace: ws, preset: pr })

  const candidateModules = [
    '@dsh-ray/assistant-dreaming',
    '@dsh-ray/assistant-work-items',
    '@dsh-ray/assistant-growth-driver',
    '@dsh-ray/assistant-memory-learning',
    '@dsh-ray/assistant-web-owner',
  ]
  for (const mod of candidateModules) {
    const entry = findLoaderConfig(host, mod)
    if (!entry || entry.disabled) continue
    const scope = record(entry.config['scope'])
    const owner = record(entry.config['owner'])
    const w = str(scope['workspace'], 4_096)
      ?? str(owner['workspace'], 4_096)
      ?? str(entry.config['workspace'], 4_096)
    const p = str(scope['preset'], 200)
      ?? str(owner['agentPreset'], 200)
      ?? str(entry.config['agentPreset'], 200)
    if (w !== undefined && p !== undefined) return Object.freeze({ workspace: w, preset: p })
  }
  return undefined
}

function dreamingMissingPrereqs(config: Record<string, unknown>): readonly string[] {
  const missing: string[] = []
  if (config['retired'] === true) missing.push('retired=false')
  const scope = record(config['scope'])
  if (typeof scope['workspace'] !== 'string' || scope['workspace'].trim() === '') missing.push('scope.workspace')
  if (typeof scope['preset'] !== 'string' || scope['preset'].trim() === '') missing.push('scope.preset')
  if (typeof scope['principalId'] !== 'string' || scope['principalId'].trim() === '') missing.push('scope.principalId')
  if (typeof scope['ownerRouteId'] !== 'string' || scope['ownerRouteId'].trim() === '') missing.push('scope.ownerRouteId')
  if (typeof config['databasePath'] !== 'string' || config['databasePath'].trim() === '') missing.push('databasePath')
  if (typeof config['provider'] !== 'string' || config['provider'].trim() === '') missing.push('provider')
  if (typeof config['model'] !== 'string' || config['model'].trim() === '') missing.push('model')
  if (typeof config['budgetId'] !== 'string' || config['budgetId'].trim() === '') missing.push('budgetId')
  if (typeof config['budgetAmount'] !== 'number' || config['budgetAmount'] <= 0) missing.push('budgetAmount')
  return Object.freeze(missing)
}

function readDreamingOverview(
  host: Context,
  installedModules: ReadonlySet<string>,
): OwnerConsoleAssistantOverview['dreaming'] {
  const pkg = '@dsh-ray/assistant-dreaming'
  const svc = host.get('assistantDreaming' as never) as Record<string, unknown> | undefined
  const loaderEntry = findLoaderConfig(host, pkg)
  if (svc === undefined || svc === null) {
    const installed = installedModules.has(pkg) || loaderEntry !== undefined
    const missing = loaderEntry ? dreamingMissingPrereqs(loaderEntry.config) : []
    return Object.freeze({
      state: installed ? 'disabled' : 'absent',
      ideas: Object.freeze([]),
      canAcknowledge: false,
      canValidate: false,
      canReject: false,
      canRetire: false,
      missingPrerequisites: Object.freeze(missing),
      ...(installed && loaderEntry?.disabled ? { note: '插件行当前处于停用状态' } : {}),
    })
  }
  try {
    const healthRaw = typeof svc['health'] === 'function' ? record((svc['health'] as () => unknown)()) : {}
    const countsRaw = record(healthRaw['counts'])
    const enabled = healthRaw['enabled'] === true
    const scheduler = str(healthRaw['scheduler'], 32) ?? 'unavailable'
    const normalizedScheduler: 'active' | 'dormant' | 'unavailable' =
      scheduler === 'active' || scheduler === 'dormant' ? scheduler : 'unavailable'
    const health = Object.freeze({
      enabled,
      scheduler: normalizedScheduler,
      ...(num(healthRaw['lastRunAt']) === undefined ? {} : { lastRunAt: Math.trunc(num(healthRaw['lastRunAt'])!) }),
      ...(str(healthRaw['lastRunOutcome'], 120) === undefined ? {} : { lastRunOutcome: str(healthRaw['lastRunOutcome'], 120)! }),
      ...(str(healthRaw['lastSkipReason'], 120) === undefined ? {} : { lastSkipReason: str(healthRaw['lastSkipReason'], 120)! }),
      runs: intOrZero(countsRaw['runs']),
      ideas: intOrZero(countsRaw['ideas']),
      recorded: intOrZero(countsRaw['recorded']),
    })
    const ideasRaw = typeof svc['inspectIdeas'] === 'function'
      ? (svc['inspectIdeas'] as (limit?: number) => unknown)(MAX_LIST)
      : []
    const ideas = list(ideasRaw).slice(0, MAX_LIST).flatMap(item => {
      const row = record(item)
      const id = str(row['id'], 160)
      if (id === undefined) return []
      return [Object.freeze({
        id,
        runId: str(row['runId'], 160) ?? '',
        createdAt: intOrZero(row['createdAt']),
        dayKey: str(row['dayKey'], 32) ?? '',
        state: str(row['state'], 32) ?? 'recorded',
        summary: str(row['summary'], 240) ?? '',
        detail: str(row['detail'], 600) ?? '',
        evidenceCount: list(row['evidenceRefs']).length,
      })]
    })
    const canAcknowledge = typeof svc['acknowledgeIdea'] === 'function'
    const canTransition = typeof svc['transitionIdea'] === 'function'
    const canRetire = typeof svc['retire'] === 'function' || canTransition
    const missing = loaderEntry && !enabled ? dreamingMissingPrereqs(loaderEntry.config) : []
    return Object.freeze({
      state: enabled ? 'ok' : 'disabled',
      health,
      ideas: Object.freeze(ideas),
      canAcknowledge,
      canValidate: canTransition,
      canReject: canTransition,
      canRetire,
      missingPrerequisites: Object.freeze(missing),
    })
  } catch (error) {
    return Object.freeze({
      state: 'error',
      ideas: Object.freeze([]),
      canAcknowledge: false,
      canValidate: false,
      canReject: false,
      canRetire: false,
      missingPrerequisites: Object.freeze([]),
      note: str(error instanceof Error ? error.message : String(error), 300) ?? 'assistant-dreaming 状态读取失败',
    })
  }
}

function formatQuestionSummary(question: unknown, flatItem?: Record<string, unknown>): string | undefined {
  const q = record(question)
  const change = record(q['change'])
  const param = str(change['parameter'], 80) ?? str(flatItem?.['parameter'], 80)
  if (param !== undefined) {
    const rawFrom = change['parameter'] !== undefined ? change['from'] : flatItem?.['parentValue']
    const rawTo = change['parameter'] !== undefined ? change['to'] : flatItem?.['candidateValue']
    const fromVal = rawFrom === undefined ? '?' : String(rawFrom)
    const toVal = rawTo === undefined ? '?' : String(rawTo)
    return `${param}: ${fromVal} → ${toVal}`
  }
  return str(q['summary'], 240)
}

function readProactiveOverview(
  host: Context,
  scope: Readonly<{ workspace: string; preset: string }> | undefined,
  installedModules: ReadonlySet<string>,
): OwnerConsoleAssistantOverview['proactive'] {
  const pkg = '@dsh-ray/assistant-proactive'
  const proactive = host.get('assistantProactive' as never) as Record<string, unknown> | undefined
  const evaluation = host.get('assistantEvaluation' as never) as Record<string, unknown> | undefined
  const proactiveEntry = findLoaderConfig(host, pkg)
  const evalEntry = findLoaderConfig(host, '@dsh-ray/assistant-evaluation')

  const attentionQuestions: Array<OwnerConsoleAssistantOverview['proactive']['attentionQuestions'][number]> = []
  let populatedQuestionsViaProactive = false
  if (proactive !== undefined && proactive !== null && typeof proactive['inspectAttentionQuestions'] === 'function') {
    try {
      const inspectedRaw = (proactive['inspectAttentionQuestions'] as (filter?: unknown) => unknown)({
        ...(scope === undefined ? {} : {
          scope: { workspace: scope.workspace, preset: scope.preset },
          workspace: scope.workspace,
          preset: scope.preset,
        }),
        includeResolved: true,
        limit: MAX_LIST,
      })
      const inspected = Array.isArray(inspectedRaw) ? undefined : record(inspectedRaw)
      const rawItems = Array.isArray(inspectedRaw) ? inspectedRaw : list(inspected?.['items'])
      const fallbackCohort = record(inspected?.['cohort'])
      const defaultLane = str(fallbackCohort['lane'], 128) ?? 'owner-notification'
      const defaultSourceId = str(fallbackCohort['sourceId'], 128) ?? 'assistant-proactive/v1'
      for (const raw of rawItems.slice(0, MAX_LIST)) {
        const item = record(raw)
        const qid = str(item['questionId'], 160)
        if (qid === undefined) continue
        const itemCohort = record(item['cohort'])
        const itemScope = record(item['scope'])
        const delivery = item['delivery'] !== undefined && item['delivery'] !== null ? record(item['delivery']) : {}
        const reply = item['reply'] !== undefined && item['reply'] !== null ? record(item['reply']) : undefined
        const replyChoice = str(reply?.['choice'], 64)
        const questionSummary = formatQuestionSummary(item['question'], item)
        const proposalId = str(item['proposalId'], 160)
        const qWs = str(itemScope['workspace'], 4_096)
        const qPr = str(itemScope['preset'], 200)
        const isOpen = typeof item['open'] === 'boolean' ? item['open'] : undefined
        const actionable = typeof item['actionable'] === 'boolean'
          ? item['actionable']
          : (isOpen ?? true) && replyChoice === undefined
        attentionQuestions.push(Object.freeze({
          questionId: qid,
          ...(proposalId === undefined ? {} : { proposalId }),
          cohortLane: str(itemCohort['lane'], 128) ?? defaultLane,
          cohortSourceId: str(itemCohort['sourceId'], 128) ?? defaultSourceId,
          ...(qWs === undefined ? {} : { workspace: qWs }),
          ...(qPr === undefined ? {} : { preset: qPr }),
          ...(isOpen === undefined ? {} : { open: isOpen }),
          actionable,
          deliveryStatus: str(delivery['status'], 32) ?? (isOpen === true ? 'queued' : 'closed'),
          recordedAt: intOrZero(delivery['recordedAt'] ?? record(item['question'])['createdAt'] ?? item['createdAt']),
          ...(questionSummary === undefined ? {} : { questionSummary }),
          ...(replyChoice === undefined ? {} : { replyChoice, repliedAt: intOrZero(reply?.['repliedAt']) }),
        }))
      }
      populatedQuestionsViaProactive = true
    } catch {
      // Fall through to direct assistantEvaluation read if inspectAttentionQuestions fails.
    }
  }

  if (!populatedQuestionsViaProactive && evaluation !== undefined && evaluation !== null && scope !== undefined
    && typeof evaluation['attentionOwnerQuestionStatus'] === 'function') {
    const configuredCohorts = list(evalEntry?.config['attentionTuningCohorts'])
      .map(c => ({ lane: str(record(c)['lane'], 128), sourceId: str(record(c)['sourceId'], 128) }))
      .filter((c): c is { lane: string; sourceId: string } => c.lane !== undefined && c.sourceId !== undefined)
    const cohorts = configuredCohorts.length > 0
      ? configuredCohorts
      : [{ lane: 'owner-notification', sourceId: 'assistant-proactive/v1' }]
    for (const cohort of cohorts.slice(0, 8)) {
      try {
        const res = record((evaluation['attentionOwnerQuestionStatus'] as (input: unknown) => unknown)({ scope, cohort }))
        const repliesById = new Map<string, { choice: string; repliedAt: number }>()
        for (const r of list(res['replies'])) {
          const rr = record(r)
          const qid = str(rr['questionId'], 160)
          const choice = str(rr['choice'], 64)
          if (qid && choice) repliesById.set(qid, { choice, repliedAt: intOrZero(rr['repliedAt']) })
        }
        for (const d of list(res['deliveries']).slice(0, MAX_LIST)) {
          const dd = record(d)
          const qid = str(dd['questionId'], 160)
          if (qid === undefined) continue
          const reply = repliesById.get(qid)
          const status = str(dd['status'], 32) ?? 'queued'
          attentionQuestions.push(Object.freeze({
            questionId: qid,
            cohortLane: cohort.lane,
            cohortSourceId: cohort.sourceId,
            workspace: scope.workspace,
            preset: scope.preset,
            actionable: reply === undefined && status === 'queued',
            deliveryStatus: status,
            recordedAt: intOrZero(dd['recordedAt']),
            ...(reply === undefined ? {} : { replyChoice: reply.choice, repliedAt: reply.repliedAt }),
          }))
        }
      } catch {
        // Ignore single cohort read failure; continue aggregating remaining cohorts.
      }
    }
  }

  if (proactive === undefined || proactive === null) {
    const installed = installedModules.has(pkg) || proactiveEntry !== undefined
    return Object.freeze({
      state: installed ? 'disabled' : 'absent',
      profileCount: list(proactiveEntry?.config['profiles']).length,
      drafts: Object.freeze([]),
      attentionQuestions: Object.freeze(attentionQuestions.slice(0, MAX_LIST)),
    })
  }

  try {
    const intakeRaw = typeof proactive['intakeEvaluationHealth'] === 'function'
      ? record((proactive['intakeEvaluationHealth'] as () => unknown)())
      : undefined
    const draftsFn = (['inspectDrafts', 'inspectPreparations', 'listPreparations', 'listDrafts'] as const)
      .map(name => proactive[name])
      .find(fn => typeof fn === 'function') as ((filter?: unknown) => unknown) | undefined
    const draftsRaw = draftsFn !== undefined
      ? draftsFn({ ...(scope === undefined ? {} : { workspace: scope.workspace, preset: scope.preset }), limit: MAX_LIST })
      : []
    const drafts = list(draftsRaw).slice(0, MAX_LIST).flatMap(item => {
      const row = record(item)
      const id = str(row['id'], 160)
      if (id === undefined) return []
      const result = record(row['result'])
      const preview = str(row['outputPreview'], 300) ?? str(result['output'], 300) ?? str(row['output'], 300)
      const prepState = str(row['preparationState'], 32) ?? str(row['state'], 32) ?? 'queued'
      const prepReason = str(row['preparationReason'], 120) ?? str(row['reason'], 120)
      const profileId = str(row['profileId'], 120)
      const objective = str(row['objective'], 300)
      const decisionState = str(row['decisionState'], 32)
      const feedback = str(row['feedback'], 32)
      return [Object.freeze({
        id,
        goalId: str(row['goalId'], 160) ?? str(record(row['decision'])['goalId'], 160) ?? '',
        ...(profileId === undefined ? {} : { profileId }),
        ...(objective === undefined ? {} : { objective }),
        state: prepState,
        ...(prepReason === undefined ? {} : { reason: prepReason }),
        ...(decisionState === undefined ? {} : { decisionState }),
        ...(feedback === undefined ? {} : { feedback }),
        updatedAt: intOrZero(row['updatedAt'] ?? row['createdAt']),
        ...(preview === undefined ? {} : { outputPreview: preview }),
        verified: row['verified'] === true,
      })]
    })
    const canResolveDraft = typeof proactive['resolveDraft'] === 'function'
    const profiles = list(proactiveEntry?.config['profiles'])
    return Object.freeze({
      state: 'ok',
      profileCount: profiles.length,
      ...(intakeRaw === undefined ? {} : {
        intakeEvaluation: Object.freeze({
          enabled: bool(intakeRaw['enabled']),
          registered: bool(intakeRaw['registered']),
          callsLastHour: intOrZero(intakeRaw['callsLastHour']),
          consecutiveFailures: intOrZero(intakeRaw['consecutiveFailures']),
          ...(str(intakeRaw['degradedReason'], 200) === undefined ? {} : { degradedReason: str(intakeRaw['degradedReason'], 200)! }),
        }),
      }),
      canResolveDraft,
      drafts: Object.freeze(drafts),
      attentionQuestions: Object.freeze(attentionQuestions.slice(0, MAX_LIST)),
    })
  } catch (error) {
    return Object.freeze({
      state: 'error',
      profileCount: list(proactiveEntry?.config['profiles']).length,
      drafts: Object.freeze([]),
      attentionQuestions: Object.freeze(attentionQuestions.slice(0, MAX_LIST)),
      note: str(error instanceof Error ? error.message : String(error), 300) ?? 'assistant-proactive 状态读取失败',
    })
  }
}

function readWorkItemsOverview(
  host: Context,
  installedModules: ReadonlySet<string>,
): OwnerConsoleAssistantOverview['workItems'] {
  const pkg = '@dsh-ray/assistant-work-items'
  const svc = host.get('assistantWorkItems' as never) as Record<string, unknown> | undefined
  const loaderEntry = findLoaderConfig(host, pkg)
  if (svc === undefined || svc === null) {
    return Object.freeze({
      state: installedModules.has(pkg) || loaderEntry !== undefined ? 'disabled' : 'absent',
      queue: Object.freeze([]),
    })
  }
  try {
    const h = typeof svc['health'] === 'function' ? record((svc['health'] as () => unknown)()) : {}
    const enabled = h['enabled'] === true
    const evalH = record(h['evaluation'])
    const intakeEvalH = typeof svc['intakeEvaluationHealth'] === 'function'
      ? record((svc['intakeEvaluationHealth'] as () => unknown)())
      : undefined
    const inspectQueue = typeof svc['inspectIntakeQueue'] === 'function'
      ? record((svc['inspectIntakeQueue'] as (opts?: unknown) => unknown)({ limit: MAX_LIST }))
      : undefined
    const admitCfg = inspectQueue === undefined ? undefined : record(inspectQueue['admit'])
    const queueCounts = inspectQueue === undefined ? undefined : record(inspectQueue['counts'])
    const admitMode = str(admitCfg?.['mode'], 32) ?? str(inspectQueue?.['mode'], 32)
    const health = Object.freeze({
      enabled,
      mode: str(h['mode'], 32) ?? 'observe',
      openItems: intOrZero(h['openItems']),
      workerConnected: bool(h['workerConnected']),
      ownerRouteValid: bool(h['ownerRouteValid']),
      ...(num(h['lastAdmitAt']) === undefined ? {} : { lastAdmitAt: Math.trunc(num(h['lastAdmitAt'])!) }),
      evaluationPending: intOrZero(evalH['pending']),
      ...(intakeEvalH === undefined ? {} : {
        intakeEnabled: bool(intakeEvalH['enabled']),
        intakeEvaluated: intOrZero(intakeEvalH['evaluated']),
      }),
      ...(inspectQueue === undefined ? {} : {
        intakeLedgerEnabled: inspectQueue['intakeLedgerEnabled'] === true || inspectQueue['enabled'] === true,
        ...(admitMode === undefined ? {} : { admitMode }),
        ...(admitCfg?.['hasAcceptanceObjective'] === undefined ? {} : { hasAcceptanceObjective: bool(admitCfg['hasAcceptanceObjective']) }),
        pendingAdmissions: intOrZero(queueCounts?.['pendingAdmissions'] ?? inspectQueue['pendingAdmissions']),
      }),
    })

    const queueEntries: Array<OwnerConsoleAssistantOverview['workItems']['queue'][number]> = []
    if (inspectQueue !== undefined) {
      const admissionRows = list(inspectQueue['admissions']).length > 0
        ? list(inspectQueue['admissions'])
        : list(inspectQueue['recent'])
      const seenDecisions = new Set<string>()
      for (const raw of admissionRows.slice(0, MAX_LIST)) {
        const row = record(raw)
        const id = str(row['sourceEventId'], 160) ?? str(row['decisionId'], 160)
        if (id === undefined) continue
        const decId = str(row['decisionId'], 160)
        if (decId !== undefined) seenDecisions.add(decId)
        const src = str(row['source'], 80)
        const mode = str(row['mode'], 32)
        const reasonCode = str(row['reasonCode'], 80)
        const observeReason = str(row['observeReason'], 80)
        const itemId = str(row['itemId'], 160)
        queueEntries.push(Object.freeze({
          id,
          entryKind: 'admission',
          ...(src === undefined ? {} : { source: src }),
          ...(mode === undefined ? {} : { mode }),
          outcome: str(row['outcome'], 64) ?? 'would-admit',
          ...(reasonCode === undefined ? {} : { reasonCode }),
          ...(observeReason === undefined ? {} : { observeReason }),
          ...(itemId === undefined ? {} : { summary: `item: ${itemId}` }),
          recordedAt: intOrZero(row['recordedAt']),
        }))
      }
      const hasInlineObserved = Object.hasOwn(inspectQueue, 'observedItems')
      const observedRows = hasInlineObserved
        ? list(inspectQueue['observedItems'])
        : (typeof svc['listObservedItems'] === 'function'
            ? list((svc['listObservedItems'] as (opts?: unknown) => unknown)({ limit: MAX_LIST }))
            : [])
      for (const raw of observedRows.slice(0, MAX_LIST)) {
        const row = record(raw)
        const decId = str(row['decisionId'], 160)
        if (!hasInlineObserved && decId !== undefined && seenDecisions.has(decId)) continue
        const id = str(row['id'], 160) ?? str(row['sourceEventId'], 160) ?? decId
        if (id === undefined) continue
        const kind = str(row['kind'], 80) ?? str(row['source'], 80)
        const mode = str(row['configuredMode'], 32)
        const reasonCode = str(row['stateReason'], 80) ?? str(row['observeReason'], 80)
        const summary = str(row['title'], 240) ?? str(row['ruleId'], 240)
        const wouldReject = list(row['wouldReject'])
          .map(entry => str(entry, 80))
          .filter((entry): entry is string => entry !== undefined)
          .slice(0, 8)
        queueEntries.push(Object.freeze({
          id,
          entryKind: 'observed',
          ...(kind === undefined ? {} : { source: kind }),
          ...(mode === undefined ? {} : { mode }),
          outcome: str(row['state'], 64) ?? 'would-admit',
          ...(reasonCode === undefined ? {} : { reasonCode }),
          ...(summary === undefined ? {} : { summary }),
          ...(wouldReject.length === 0 ? {} : { wouldReject: Object.freeze(wouldReject) }),
          recordedAt: intOrZero(row['createdAt'] ?? row['recordedAt']),
        }))
      }
    } else if (typeof svc['outcomes'] === 'function') {
      for (const [idx, raw] of list((svc['outcomes'] as (opts?: unknown) => unknown)({ limit: MAX_LIST })).entries()) {
        const row = record(raw)
        const id = str(row['id'] ?? row['itemId'], 160) ?? `outcome-${idx}`
        queueEntries.push(Object.freeze({
          id,
          entryKind: 'outcome',
          ...(str(row['source'], 80) === undefined ? {} : { source: str(row['source'], 80)! }),
          outcome: str(row['outcome'] ?? row['evidenceState'] ?? row['state'], 64) ?? 'observed',
          ...(str(row['summary'] ?? row['title'], 240) === undefined
            ? {} : { summary: str(row['summary'] ?? row['title'], 240)! }),
          recordedAt: intOrZero(row['recordedAt'] ?? row['createdAt']),
        }))
      }
    }
    const sorted = queueEntries.toSorted((a, b) => b.recordedAt - a.recordedAt).slice(0, MAX_LIST)
    return Object.freeze({
      state: enabled ? 'ok' : 'disabled',
      health,
      queue: Object.freeze(sorted),
    })
  } catch (error) {
    return Object.freeze({
      state: 'error',
      queue: Object.freeze([]),
      note: str(error instanceof Error ? error.message : String(error), 300) ?? 'assistant-work-items 状态读取失败',
    })
  }
}

function readMemoryLearningOverview(
  host: Context,
  installedModules: ReadonlySet<string>,
): OwnerConsoleAssistantOverview['memoryLearning'] {
  const pkg = '@dsh-ray/assistant-memory-learning'
  const svc = host.get('assistantMemoryLearning' as never) as Record<string, unknown> | undefined
  const loaderEntry = findLoaderConfig(host, pkg)
  if (svc === undefined || svc === null) {
    const installed = installedModules.has(pkg) || loaderEntry !== undefined
    return Object.freeze({
      state: installed ? 'disabled' : 'absent',
      ...(installed && loaderEntry?.disabled ? { note: 'Memory Learning 默认禁用，需显式配置 owner 授权与有限提取额度后启用' } : {}),
    })
  }
  try {
    const h = typeof svc['health'] === 'function' ? record((svc['health'] as () => unknown)()) : {}
    const countsRaw = record(h['counts'])
    const counts: Record<string, number> = {}
    for (const [k, v] of Object.entries(countsRaw)) {
      if (typeof v === 'number' && Number.isFinite(v)) counts[k] = Math.trunc(v)
    }
    return Object.freeze({
      state: bool(h['enabled']) ? 'ok' : 'disabled',
      health: Object.freeze({
        enabled: bool(h['enabled']),
        connected: bool(h['connected']),
        available: bool(h['available']),
        remainingExtractions: intOrZero(h['remainingExtractions']),
        ...(num(h['lastScanAt']) === undefined ? {} : { lastScanAt: Math.trunc(num(h['lastScanAt'])!) }),
        ...(str(h['lastError'], 240) === undefined ? {} : { lastError: str(h['lastError'], 240)! }),
        counts: Object.freeze(counts),
      }),
    })
  } catch (error) {
    return Object.freeze({
      state: 'error',
      note: str(error instanceof Error ? error.message : String(error), 300) ?? 'assistant-memory-learning 状态读取失败',
    })
  }
}

function readGrowthDriverOverview(
  host: Context,
  installedModules: ReadonlySet<string>,
): OwnerConsoleAssistantOverview['growthDriver'] {
  const pkg = '@dsh-ray/assistant-growth-driver'
  const svc = host.get('assistantGrowthDriver' as never) as Record<string, unknown> | undefined
  const loaderEntry = findLoaderConfig(host, pkg)
  if (svc === undefined || svc === null) {
    return Object.freeze({
      state: installedModules.has(pkg) || loaderEntry !== undefined ? 'disabled' : 'absent',
      proposals: Object.freeze([]),
    })
  }
  try {
    const wake = typeof svc['health'] === 'function' ? record((svc['health'] as () => unknown)()) : {}
    const usage = typeof svc['usageHealth'] === 'function' ? record((svc['usageHealth'] as () => unknown)()) : {}
    const usageCountsRaw = record(usage['counts'])
    const usageCounts: Record<string, number> = {}
    for (const [k, v] of Object.entries(usageCountsRaw)) {
      if (typeof v === 'number' && Number.isFinite(v)) usageCounts[k] = Math.trunc(v)
    }
    const enabled = loaderEntry?.config['enabled'] === true || bool(usage['enabled'])
    const proposalsFn = (['inspectProposals', 'listProposals', 'inspectCandidates'] as const)
      .map(name => svc[name])
      .find(fn => typeof fn === 'function') as ((input?: unknown) => unknown) | undefined
    const proposalsRaw = proposalsFn !== undefined ? proposalsFn({ limit: MAX_LIST }) : []
    const proposals = list(proposalsRaw).slice(0, MAX_LIST).flatMap((item, idx) => {
      const row = record(item)
      const id = str(row['id'], 160) ?? str(row['runId'], 160) ?? `proposal-${idx}`
      return [Object.freeze({
        id,
        kind: str(row['kind'] ?? row['source'], 64) ?? 'capability',
        state: str(row['state'] ?? row['outcome'], 64) ?? 'pending',
        summary: str(row['summary'] ?? row['title'] ?? row['reason'], 240) ?? '',
        recordedAt: intOrZero(row['recordedAt'] ?? row['createdAt']),
      })]
    })
    const run = record(wake['run'])
    const dreamingRaw = wake['dreamingIntake']
    const dreamingIntakeRec = dreamingRaw !== undefined && dreamingRaw !== null ? record(dreamingRaw) : undefined
    const dreamingIntake = dreamingIntakeRec === undefined ? undefined : Object.freeze({
      enabled: bool(dreamingIntakeRec['enabled']),
      considered: intOrZero(dreamingIntakeRec['considered']),
      ingested: intOrZero(dreamingIntakeRec['ingested']),
      rejectedUnvalidated: intOrZero(dreamingIntakeRec['rejectedUnvalidated']),
    })
    return Object.freeze({
      state: enabled ? 'ok' : 'disabled',
      health: Object.freeze({
        enabled,
        outcome: str(wake['outcome'], 64) ?? 'never-run',
        ...(num(wake['lastWakeAt']) === undefined ? {} : { lastWakeAt: Math.trunc(num(wake['lastWakeAt'])!) }),
        ...(str(wake['reason'], 200) === undefined ? {} : { reason: str(wake['reason'], 200)! }),
        ...(str(run['outcome'], 64) === undefined ? {} : { lastRunOutcome: str(run['outcome'], 64)! }),
        usageEnabled: bool(usage['enabled']),
        usageConnected: bool(usage['connected']),
        ...(num(usage['lastScanAt']) === undefined ? {} : { usageLastScanAt: Math.trunc(num(usage['lastScanAt'])!) }),
        usageCounts: Object.freeze(usageCounts),
        ...(dreamingIntake === undefined ? {} : { dreamingIntake }),
      }),
      proposals: Object.freeze(proposals),
    })
  } catch (error) {
    return Object.freeze({
      state: 'error',
      proposals: Object.freeze([]),
      note: str(error instanceof Error ? error.message : String(error), 300) ?? 'assistant-growth-driver 状态读取失败',
    })
  }
}

export function readAssistantOverview(
  host: Context,
  workspace: string,
  preset: string,
  installedModules: ReadonlySet<string>,
): OwnerConsoleAssistantOverview {
  const scope = resolveOverviewScope(host, workspace, preset)
  return Object.freeze({
    ...(scope === undefined ? {} : { resolvedScope: scope }),
    dreaming: readDreamingOverview(host, installedModules),
    proactive: readProactiveOverview(host, scope, installedModules),
    workItems: readWorkItemsOverview(host, installedModules),
    memoryLearning: readMemoryLearningOverview(host, installedModules),
    growthDriver: readGrowthDriverOverview(host, installedModules),
  })
}

export type DreamingIdeaAction = 'acknowledge' | 'validate' | 'reject' | 'retire'

export function executeDreamingIdeaAction(
  host: Context,
  ideaId: string,
  action: DreamingIdeaAction,
  note: string,
): OwnerConsoleWriteResult {
  const entry = 'dsh-ray-assistant-dreaming'
  const svc = host.get('assistantDreaming' as never) as Record<string, unknown> | undefined
  if (svc === undefined || svc === null) {
    return Object.freeze({ applied: false, entry, note: 'assistant-dreaming 未加载，无法执行想法状态变更' })
  }
  const cleanId = ideaId.trim()
  const cleanNote = note.trim().slice(0, 500)
  if (hasControlChars(cleanId) || cleanId.length > 200) {
    return Object.freeze({ applied: false, entry, note: 'ideaId 格式无效' })
  }

  try {
    if (action === 'retire' && cleanId === '') {
      if (typeof svc['retire'] !== 'function') {
        return Object.freeze({ applied: false, entry, note: '当前 assistant-dreaming 版本未提供 retire() 方法' })
      }
      ;(svc['retire'] as () => void)()
      return Object.freeze({ applied: true, entry, note: '已按主人要求休眠 assistant-dreaming 调度（现有记录保留）' })
    }
    if (cleanId === '') {
      return Object.freeze({ applied: false, entry, note: '必须指定 ideaId' })
    }
    if (action === 'acknowledge') {
      const fn = svc['acknowledgeIdea'] as ((input: { ideaId: string; note?: string }) => unknown) | undefined
      if (typeof fn !== 'function') {
        return Object.freeze({ applied: false, entry, note: '当前 assistant-dreaming 版本尚未暴露 owner acknowledgeIdea 接口' })
      }
      fn({ ideaId: cleanId, ...(cleanNote === '' ? {} : { note: cleanNote }) })
      return Object.freeze({ applied: true, entry, note: `已标记想法 ${cleanId} 为主人已阅（owner-acknowledged）` })
    }
    const fn = svc['transitionIdea'] as ((input: {
      ideaId: string; transition: 'validate' | 'reject' | 'retire'; note?: string
    }) => unknown) | undefined
    if (typeof fn !== 'function') {
      return Object.freeze({ applied: false, entry, note: '当前 assistant-dreaming 版本尚未暴露 owner transitionIdea 接口' })
    }
    fn({ ideaId: cleanId, transition: action, ...(cleanNote === '' ? {} : { note: cleanNote }) })
    const label = action === 'validate' ? '已验证通过（validated）' : action === 'reject' ? '已拒绝（rejected）' : '已撤回休眠（withdrawn）'
    return Object.freeze({ applied: true, entry, note: `想法 ${cleanId} 状态已更新为：${label}` })
  } catch (error) {
    return Object.freeze({
      applied: false,
      entry,
      note: str(error instanceof Error ? error.message : String(error), 400) ?? 'Dreaming 操作失败',
    })
  }
}

export function executeAttentionQuestionReply(
  host: Context,
  workspace: string,
  preset: string,
  cohortLane: string,
  cohortSourceId: string,
  questionId: string,
  choice: 'authorize-once' | 'decline',
): OwnerConsoleWriteResult {
  const proactive = host.get('assistantProactive' as never) as Record<string, unknown> | undefined
  const evaluation = host.get('assistantEvaluation' as never) as Record<string, unknown> | undefined
  const ws = workspace.trim()
  const pr = preset.trim()
  const lane = cohortLane.trim()
  const sourceId = cohortSourceId.trim()
  const qid = questionId.trim()
  if (ws === '' || pr === '' || qid === '') {
    return Object.freeze({ applied: false, entry: 'dsh-ray-assistant-evaluation', note: 'workspace、preset 与 questionId 均不能为空' })
  }
  try {
    if (proactive !== undefined && proactive !== null && typeof proactive['resolveAttentionQuestion'] === 'function') {
      const result = record((proactive['resolveAttentionQuestion'] as (input: unknown) => unknown)({
        workspace: ws, preset: pr, questionId: qid, choice,
      }))
      const status = str(result['status'], 64)
      if (status === 'applied' || status === 'recorded' || status === 'accepted') {
        return Object.freeze({
          applied: true,
          entry: 'dsh-ray-assistant-proactive',
          note: choice === 'authorize-once'
            ? `已记录问题 ${qid} 的单次授权（后续仍需 holdout 复核）`
            : `已拒绝问题 ${qid} 的放宽建议`,
        })
      }
      const reason = str(result['reason'], 120) ?? status ?? '未记录'
      return Object.freeze({ applied: false, entry: 'dsh-ray-assistant-proactive', note: `拒绝本次回复：${reason}` })
    }
    const entry = 'dsh-ray-assistant-evaluation'
    if (evaluation === undefined || evaluation === null
      || typeof evaluation['applyAttentionOwnerQuestionReply'] !== 'function') {
      return Object.freeze({ applied: false, entry, note: 'assistant-evaluation 未加载，无法响应注意力授权问题' })
    }
    if (lane === '' || sourceId === '') {
      return Object.freeze({ applied: false, entry, note: 'cohort 不能为空' })
    }
    const result = record((evaluation['applyAttentionOwnerQuestionReply'] as (input: unknown) => unknown)({
      scope: { workspace: ws, preset: pr },
      cohort: { lane, sourceId },
      questionId: qid,
      choice,
    }))
    const status = str(result['status'], 64)
    if (status === 'recorded' || status === 'applied' || status === 'accepted' || result['ok'] === true) {
      return Object.freeze({
        applied: true,
        entry,
        note: choice === 'authorize-once'
          ? `已记录问题 ${qid} 的单次授权（后续仍需 holdout 复核）`
          : `已拒绝问题 ${qid} 的放宽建议`,
      })
    }
    const reason = str(result['reason'], 120) ?? status ?? '未记录'
    return Object.freeze({ applied: false, entry, note: `Evaluation 拒绝本次回复：${reason}` })
  } catch (error) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-assistant-evaluation',
      note: str(error instanceof Error ? error.message : String(error), 400) ?? '注意力授权操作失败',
    })
  }
}

export function executeProactiveDraftAction(
  host: Context,
  id: string,
  action: 'accept' | 'reject' | 'cancel',
  workspace: string,
  preset: string,
): OwnerConsoleWriteResult {
  const entry = 'dsh-ray-assistant-proactive'
  const proactive = host.get('assistantProactive' as never) as Record<string, unknown> | undefined
  if (proactive === undefined || proactive === null) {
    return Object.freeze({ applied: false, entry, note: 'assistant-proactive 未加载' })
  }
  const cleanId = id.trim()
  if (cleanId === '' || hasControlChars(cleanId)) {
    return Object.freeze({ applied: false, entry, note: 'draft id 无效' })
  }
  const fn = proactive['resolveDraft'] as ((input: {
    id: string; action: 'accept' | 'reject' | 'cancel'; workspace?: string; preset?: string
  }) => unknown) | undefined
  if (typeof fn !== 'function') {
    return Object.freeze({ applied: false, entry, note: '当前 assistant-proactive 版本暂未提供 resolveDraft 方法' })
  }
  const resolved = resolveOverviewScope(host, workspace, preset)
  try {
    fn({
      id: cleanId,
      action,
      ...(resolved === undefined ? {} : { workspace: resolved.workspace, preset: resolved.preset }),
    })
    const label = action === 'accept' ? '已接受草稿' : action === 'reject' ? '已拒绝草稿' : '已取消草稿'
    return Object.freeze({ applied: true, entry, note: `${cleanId}：${label}` })
  } catch (error) {
    return Object.freeze({
      applied: false,
      entry,
      note: str(error instanceof Error ? error.message : String(error), 400) ?? '草稿操作失败',
    })
  }
}
