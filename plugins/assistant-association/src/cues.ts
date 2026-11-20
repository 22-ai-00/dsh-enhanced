import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantGoalsService, GoalTaskContext } from '@dsh-enhanced/assistant-goals'
import { isBoundaryMatch, stepAcState, type EntityAutomaton } from './aho-corasick.js'
import type { AssociationMemoryIndex } from './index-memory.js'
import { normalizeForAc } from './tokenize.js'
import {
  computeOwnerScopeKey,
  computePrincipalDigest,
  type AssociationOwnerScope,
  type HoldoutTaskKind,
  type HotPathCue,
  type ScoredAssociationItem,
  type SessionActivationEntry,
} from './types.js'

const MAX_CUE_TEXT_CHARS = 2_048
const MAX_TOOL_RESULT_SCAN_CHARS = 16_384
const MAX_TOOL_ENTITY_CUES = 32
const MAX_SESSION_ACTIVATION_ENTRIES = 128
const MAX_TOOL_NAMES_PER_TURN = 64
const MAX_TOOL_TURN_KEYS = 512
const MAX_CALL_LOOKBACK = 10_000
const DEFAULT_SESSION_HALF_LIFE_MS = 300_000
const DEFAULT_SESSION_STEP_DECAY = 0.85

const HUMAN_TASK_SOURCE_KINDS = new Set([
  'user',
  'delivery',
  'assistant-automations',
  'plugin:@dsh-enhanced/assistant-automations',
])

export interface ClaimedUserCue {
  readonly turn: number
  readonly messageId: string
  readonly text: string
  readonly sourceKind: string
}

export interface ToolEntityCue {
  readonly entityId: string
  readonly surface: string
  readonly turn: number
  readonly step: number
  readonly observedAt: number
  hits: number
}

export interface SessionActivationEntryState {
  score: number
  updatedAt: number
}

export interface RetainedAssociationItem {
  readonly item: ScoredAssociationItem
  readonly injectedScore: number
  readonly line: string
}

export interface StepMemoEntry {
  readonly epochKey: string
  readonly renderedBlock: string
}

export interface StepOutcomeRecord {
  readonly nonce: number
  readonly taskId: string
  readonly outcome: 'injected' | 'holdout' | 'timeout'
}

export interface AgentAssocState {
  ownerKey: string | undefined
  inputNonce: number
  invalidationNonce: number
  claimedUserMessage: ClaimedUserCue | undefined
  readonly toolEntities: Map<string, ToolEntityCue>
  hasNewToolEntity: boolean
  readonly sessionActivation: Map<string, SessionActivationEntryState>
  readonly retainedItems: Map<string, RetainedAssociationItem>
  retainedBlock: string
  retainedDirty: boolean
  readonly overflowDroppedIds: Set<string>
  lastEvaluatedNonce: number
  lastMetricNonce: number
  lastStepOutcome: StepOutcomeRecord | undefined
  memo: StepMemoEntry | undefined
  readonly recordedTaskIds: Set<string>
}

export function createAgentAssocState(): AgentAssocState {
  return {
    ownerKey: undefined,
    inputNonce: 0,
    invalidationNonce: 0,
    claimedUserMessage: undefined,
    toolEntities: new Map(),
    hasNewToolEntity: false,
    sessionActivation: new Map(),
    retainedItems: new Map(),
    retainedBlock: '',
    retainedDirty: false,
    overflowDroppedIds: new Set(),
    lastEvaluatedNonce: -1,
    lastMetricNonce: -1,
    lastStepOutcome: undefined,
    memo: undefined,
    recordedTaskIds: new Set(),
  }
}

export function getOrCreateAgentAssocState(
  states: WeakMap<Agent, AgentAssocState>,
  agent: Agent,
): AgentAssocState {
  let state = states.get(agent)
  if (state === undefined) {
    state = createAgentAssocState()
    states.set(agent, state)
  }
  return state
}

export function wipeStateOnOwnerRotation(
  state: AgentAssocState,
  nextOwnerKey: string,
): boolean {
  if (state.ownerKey !== undefined && state.ownerKey === nextOwnerKey) {
    return false
  }
  const rotated = state.ownerKey !== undefined && state.ownerKey !== nextOwnerKey
  state.ownerKey = nextOwnerKey
  if (rotated) {
    state.toolEntities.clear()
    state.hasNewToolEntity = false
    state.sessionActivation.clear()
    state.retainedItems.clear()
    state.retainedBlock = ''
    state.retainedDirty = false
    state.overflowDroppedIds.clear()
    state.memo = undefined
    state.lastEvaluatedNonce = -1
    state.lastMetricNonce = -1
    state.lastStepOutcome = undefined
    state.recordedTaskIds.clear()
    state.invalidationNonce += 1
  }
  return rotated
}

export function evictNodesFromAgentState(
  state: AgentAssocState,
  nodeIds: ReadonlySet<string>,
): void {
  if (nodeIds.size === 0) return
  let changed = false
  let retainedEvicted = false
  for (const id of nodeIds) {
    if (state.retainedItems.delete(id)) {
      changed = true
      retainedEvicted = true
    }
    if (state.sessionActivation.delete(id)) changed = true
    state.overflowDroppedIds.delete(id)
  }
  if (retainedEvicted) {
    state.retainedDirty = true
    state.retainedBlock = ''
  }
  if (changed) {
    state.invalidationNonce += 1
    state.memo = undefined
  }
}

function isHumanOrTaskMessage(message: Message): message is UserMessage {
  if (message.role !== 'user') return false
  const sourceKind = message.source?.kind
  if (typeof sourceKind !== 'string' || !HUMAN_TASK_SOURCE_KINDS.has(sourceKind)) {
    return false
  }
  return message.content.some((block) => block.type === 'text' && block.text.trim().length > 0)
}

function extractTextBounded(
  blocks: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
  maxChars: number,
): string {
  let out = ''
  for (const block of blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const piece = block.text
    if (piece.length === 0) continue
    if (out.length === 0) {
      out = piece.slice(0, maxChars)
    } else {
      const remaining = maxChars - out.length
      if (remaining <= 1) break
      out += `\n${piece.slice(0, remaining - 1)}`
    }
    if (out.length >= maxChars) break
  }
  return out
}

export function handleInboxClaimed(
  state: AgentAssocState,
  message: UserMessage,
  turn: number,
): void {
  state.inputNonce += 1
  if (isHumanOrTaskMessage(message)) {
    state.claimedUserMessage = {
      turn,
      messageId: String(message.id),
      text: extractTextBounded(message.content, MAX_CUE_TEXT_CHARS),
      sourceKind: message.source.kind,
    }
  }
}

export function handleInboxDiscarded(
  state: AgentAssocState,
  message: UserMessage,
): void {
  state.inputNonce += 1
  if (state.claimedUserMessage?.messageId === String(message.id)) {
    state.claimedUserMessage = undefined
  }
}

export function handleAgentStatus(
  state: AgentAssocState,
  status: 'idle' | 'running',
): void {
  if (status === 'idle') {
    state.claimedUserMessage = undefined
  }
}

export function extractAcEntitiesFromText(
  ac: EntityAutomaton,
  rawText: string,
): Array<{ readonly entityId: string; readonly surface: string }> {
  if (ac.entityCount === 0 || rawText.length === 0) return []
  const normText = normalizeForAc(rawText)
  const seen = new Set<number>()
  const matches: Array<{ readonly entityId: string; readonly surface: string }> = []
  let acState = 0

  for (let i = 0; i < normText.length; i += 1) {
    const ch = normText.charCodeAt(i)
    acState = stepAcState(ac, acState, ch)
    const oStart = ac.outOffset[acState]!
    const oEnd = ac.outOffset[acState + 1]!
    if (oStart === oEnd) continue
    for (let oi = oStart; oi < oEnd; oi += 1) {
      const startPos = isBoundaryMatch(ac, oi, normText, i)
      if (startPos < 0) continue
      const eid = ac.outEntityId[oi]!
      if (seen.has(eid)) continue
      seen.add(eid)
      const entityName = ac.entityNames[eid]
      if (entityName !== undefined) {
        matches.push({ entityId: entityName, surface: entityName })
      }
    }
  }
  return matches
}

function recordSessionTurnToolName(
  toolNamesBySessionTurn: Map<string, string[]>,
  sessionId: string,
  turn: number,
  toolName: string,
): void {
  const key = `${sessionId}\0${turn}`
  let list = toolNamesBySessionTurn.get(key)
  if (list === undefined) {
    list = []
    toolNamesBySessionTurn.set(key, list)
    while (toolNamesBySessionTurn.size > MAX_TOOL_TURN_KEYS) {
      const oldest = toolNamesBySessionTurn.keys().next().value
      if (oldest === undefined) break
      toolNamesBySessionTurn.delete(oldest)
    }
  } else {
    // Refresh LRU order
    toolNamesBySessionTurn.delete(key)
    toolNamesBySessionTurn.set(key, list)
  }
  if (list.length < MAX_TOOL_NAMES_PER_TURN) {
    list.push(toolName)
  }
}

export function consumeSessionTurnToolNames(
  toolNamesBySessionTurn: Map<string, string[]>,
  sessionId: string,
  turn?: number,
): string[] {
  if (turn !== undefined) {
    const key = `${sessionId}\0${turn}`
    const exact = toolNamesBySessionTurn.get(key)
    if (exact !== undefined) {
      toolNamesBySessionTurn.delete(key)
      return [...exact]
    }
  }
  const prefix = `${sessionId}\0`
  const merged: string[] = []
  for (const [key, list] of toolNamesBySessionTurn) {
    if (!key.startsWith(prefix)) continue
    for (const name of list) {
      if (merged.length >= MAX_TOOL_NAMES_PER_TURN) break
      merged.push(name)
    }
    toolNamesBySessionTurn.delete(key)
  }
  return merged
}

function resolveToolCallNameForResult(
  session: Session,
  eventSeq: number,
  turn: number,
  step: number,
  callId: string,
): string | undefined {
  const earliest = Math.max(0, eventSeq - MAX_CALL_LOOKBACK)
  for (let seq = eventSeq - 1; seq >= earliest; seq -= 1) {
    const candidate = session.eventAt(seq as never)
    if (candidate?.type === 'tool/result' && candidate.data.message.source.callId === callId) {
      return undefined
    }
    if (candidate?.type !== 'tool/call') continue
    if (candidate.data.callId !== callId) continue
    if (candidate.data.turn !== turn || candidate.data.step !== step) return undefined
    return candidate.data.name
  }
  return undefined
}

export function handleSessionEvent(
  state: AgentAssocState,
  session: Session,
  event: SessionEvent,
  activeIndex: AssociationMemoryIndex | null,
  toolNamesBySessionTurn: Map<string, string[]>,
): void {
  if (event.type === 'user/message') {
    if ((event.data.source?.kind as string | undefined) === 'runtime-context') {
      return
    }
    state.inputNonce += 1
    return
  }

  if (event.type === 'turn/start' || event.type === 'step/end' || event.type === 'assistant/message') {
    state.inputNonce += 1
    return
  }

  if (event.type === 'turn/end') {
    state.inputNonce += 1
    if (state.claimedUserMessage?.turn === event.data.turn) {
      state.claimedUserMessage = undefined
    }
    return
  }

  if (event.type === 'tool/call') {
    recordSessionTurnToolName(
      toolNamesBySessionTurn,
      String(session.id),
      event.data.turn,
      event.data.name,
    )
    return
  }

  if (event.type === 'tool/result') {
    const surfaceOp = (event as { readonly surfaceOp?: unknown }).surfaceOp
    if (surfaceOp !== 'append') return

    state.inputNonce += 1
    const msg = event.data.message
    const callId = String(msg.source.callId)
    const toolName = resolveToolCallNameForResult(
      session,
      event.seq,
      event.data.turn,
      event.data.step,
      callId,
    )

    if (toolName === 'assoc_read') {
      // Never echo untrusted <association_item> wrapper prose back into step cues
      return
    }

    if (activeIndex === null) return

    // Read tool result text into a local bounded buffer, run AC-only entity matching,
    // and discard the local buffer immediately without retaining raw prose.
    const localText = extractTextBounded(msg.content, MAX_TOOL_RESULT_SCAN_CHARS)
    if (localText.length === 0) return

    const matched = extractAcEntitiesFromText(activeIndex.ac, localText)
    if (matched.length > 0) {
      state.hasNewToolEntity = true
    }
    for (const hit of matched) {
      const existing = state.toolEntities.get(hit.entityId)
      if (existing !== undefined) {
        existing.hits += 1
        state.toolEntities.delete(hit.entityId)
        state.toolEntities.set(hit.entityId, {
          entityId: hit.entityId,
          surface: hit.surface,
          turn: event.data.turn,
          step: event.data.step,
          observedAt: event.time,
          hits: existing.hits,
        })
      } else {
        state.toolEntities.set(hit.entityId, {
          entityId: hit.entityId,
          surface: hit.surface,
          turn: event.data.turn,
          step: event.data.step,
          observedAt: event.time,
          hits: 1,
        })
        while (state.toolEntities.size > MAX_TOOL_ENTITY_CUES) {
          const oldest = state.toolEntities.keys().next().value
          if (oldest === undefined) break
          state.toolEntities.delete(oldest)
        }
      }
    }
  }
}

export function resolveOwnerScope(
  ctx: Context,
  agent: Agent | undefined,
  options: {
    readonly allowHeadlessScope: boolean
    readonly headlessPrincipals?: WeakMap<Agent, string>
    readonly defaultHeadlessPrincipal?: string
  },
): AssociationOwnerScope | undefined {
  if (agent === undefined) return undefined

  const agents = ctx.get('agents', false) as { get(id: unknown): Agent | undefined } | undefined
  if (agents !== undefined && agents.get(agent.id) !== agent) return undefined

  const sessions = ctx.get('sessions', false) as { get(id: unknown): Session | undefined } | undefined
  if (sessions !== undefined && sessions.get(agent.session.id) !== agent.session) return undefined

  const workspace = agent.session.header.cwd
  const agentPreset = agent.session.header.agentPreset
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) return undefined
  if (typeof agentPreset !== 'string' || agentPreset.trim() === '') return undefined

  const delivery = ctx.get('assistantDelivery', false) as AssistantDeliveryService | undefined
  if (delivery !== undefined && typeof delivery.preferencePrincipalForAgent === 'function') {
    let attestation: ReturnType<AssistantDeliveryService['preferencePrincipalForAgent']>
    try {
      attestation = delivery.preferencePrincipalForAgent(agent)
    } catch {
      return undefined
    }
    if (
      attestation === undefined ||
      attestation.scope.workspace !== workspace ||
      attestation.scope.preset !== agentPreset ||
      attestation.sessionId !== String(agent.session.id)
    ) {
      return undefined
    }
    const principalDigest = computePrincipalDigest(attestation.principalId)
    const principalRecordId = attestation.principalLineage.principalRecordId
    const principalVersion = attestation.principalLineage.principalVersion
    let authorityId: string | undefined
    if (typeof delivery.listActiveOwnerRouteScopes === 'function') {
      try {
        const routes = delivery.listActiveOwnerRouteScopes()
        const match = routes.find(
          (route) =>
            route.principalRecordId === principalRecordId &&
            route.principalVersion === principalVersion &&
            route.workspace === workspace &&
            route.agentPreset === agentPreset,
        )
        authorityId = match?.authorityId
      } catch {
        authorityId = undefined
      }
    }
    return {
      mode: 'delivery',
      ownerScopeKey: computeOwnerScopeKey({
        mode: 'delivery',
        principalDigest,
        principalRecordId,
        principalVersion,
        workspace,
        agentPreset,
      }),
      principalId: attestation.principalId,
      principalDigest,
      principalRecordId,
      principalVersion,
      workspace,
      agentPreset,
      ...(authorityId === undefined ? {} : { authorityId }),
    }
  }

  if (!options.allowHeadlessScope) {
    return undefined
  }

  const principalId =
    options.headlessPrincipals?.get(agent) ??
    options.defaultHeadlessPrincipal ??
    `headless:${workspace}:${agentPreset}`
  const principalDigest = computePrincipalDigest(principalId)
  return {
    mode: 'headless',
    ownerScopeKey: computeOwnerScopeKey({
      mode: 'headless',
      principalDigest,
      principalRecordId: null,
      principalVersion: null,
      workspace,
      agentPreset,
    }),
    principalId,
    principalDigest,
    principalRecordId: null,
    principalVersion: null,
    workspace,
    agentPreset,
  }
}

function latestTurnNumber(agent: Agent, state: AgentAssocState): number {
  const events = agent.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!
    if (ev.type === 'turn/start' || ev.type === 'turn/end') {
      return ev.data.turn
    }
  }
  return state.claimedUserMessage?.turn ?? 0
}

function readValidGoalContext(
  ctx: Context,
  agent: Agent,
  ownerScope: AssociationOwnerScope,
): GoalTaskContext | undefined {
  const goals = ctx.get('assistantGoals', false) as AssistantGoalsService | undefined
  if (goals === undefined || typeof goals.taskContext !== 'function') return undefined
  let task: GoalTaskContext | undefined
  try {
    task = goals.taskContext(agent)
  } catch {
    return undefined
  }
  if (task === undefined || task.protocol !== 'goal-task-context/v1' || task.active !== true) {
    return undefined
  }
  if (task.scope.workspace !== ownerScope.workspace || task.scope.preset !== ownerScope.agentPreset) {
    return undefined
  }
  if (ownerScope.mode === 'delivery') {
    if (
      task.scope.principalRecordId !== ownerScope.principalRecordId ||
      task.scope.principalVersion !== ownerScope.principalVersion ||
      computePrincipalDigest(task.scope.principalId) !== ownerScope.principalDigest
    ) {
      return undefined
    }
  }
  return task
}

export function resolveTaskId(
  ctx: Context,
  agent: Agent,
  state: AgentAssocState,
  ownerScope: AssociationOwnerScope,
): {
  readonly taskId: string
  readonly taskKind: HoldoutTaskKind
  readonly turnNumber: number
  readonly goalContext: GoalTaskContext | undefined
} {
  const delivery = ctx.get('assistantDelivery', false) as AssistantDeliveryService | undefined
  const turnNumber = latestTurnNumber(agent, state)
  const goalContext = readValidGoalContext(ctx, agent, ownerScope)

  if (delivery !== undefined && typeof delivery.currentPreferenceTurn === 'function') {
    try {
      const turn = delivery.currentPreferenceTurn(agent)
      if (turn !== undefined && turn.sessionId === String(agent.session.id)) {
        return {
          taskId: `foreground-turn:${turn.sourceInboxId}`,
          taskKind: 'foreground-turn',
          turnNumber: turn.turn,
          goalContext,
        }
      }
    } catch {
      // Fallback below
    }
  }

  const sessionId = String(agent.session.id)
  const derivedMessages = agent.session.deriveMessages()
  const latestHuman = derivedMessages.findLast(isHumanOrTaskMessage)
  const sourceKind = state.claimedUserMessage?.sourceKind ?? latestHuman?.source?.kind
  if (
    sourceKind === 'assistant-automations' ||
    sourceKind === 'plugin:@dsh-enhanced/assistant-automations'
  ) {
    return {
      taskId: `automation-run:${sessionId}:turn:${turnNumber}`,
      taskKind: 'automation-run',
      turnNumber,
      goalContext,
    }
  }

  if (goalContext !== undefined) {
    return {
      taskId: `goal-step:${goalContext.goal.id}:turn:${turnNumber}`,
      taskKind: 'goal-step',
      turnNumber,
      goalContext,
    }
  }

  return {
    taskId: `headless-session:${sessionId}:turn:${turnNumber}`,
    taskKind: ownerScope.mode === 'delivery' ? 'foreground-turn' : 'headless-session',
    turnNumber,
    goalContext,
  }
}

export function assembleStepCues(input: {
  readonly agent: Agent
  readonly state: AgentAssocState
  readonly goalContext: GoalTaskContext | undefined
  readonly turnNumber: number
  readonly nowMs: number
  readonly shouldDecaySession: boolean
  readonly sessionHalfLifeMs?: number
  readonly sessionStepDecay?: number
}): {
  readonly cues: readonly HotPathCue[]
  readonly goalKey: string
  readonly sessionActivations: readonly SessionActivationEntry[]
} {
  const { agent, state, goalContext, turnNumber, nowMs, shouldDecaySession } = input
  const cues: HotPathCue[] = []

  // Cue 1: Latest user message (weight 1.0)
  const derivedMessages = agent.session.deriveMessages()
  const derivedLatest = derivedMessages.findLast(isHumanOrTaskMessage)
  let userText = ''
  if (state.claimedUserMessage !== undefined) {
    if (derivedLatest !== undefined && String(derivedLatest.id) === state.claimedUserMessage.messageId) {
      userText = extractTextBounded(derivedLatest.content, MAX_CUE_TEXT_CHARS)
    } else {
      userText = state.claimedUserMessage.text
    }
  } else if (derivedLatest !== undefined) {
    userText = extractTextBounded(derivedLatest.content, MAX_CUE_TEXT_CHARS)
  }
  if (userText.trim().length > 0) {
    cues.push({
      kind: 'user',
      text: userText,
      weight: 1.0,
    })
  }

  // Cue 2: Current goal / step (weight 0.6)
  let goalKey = 'none'
  if (goalContext !== undefined) {
    const objective = goalContext.goal.objective.slice(0, MAX_CUE_TEXT_CHARS)
    const nextStep = goalContext.checkpoint.nextStep.slice(0, MAX_CUE_TEXT_CHARS)
    const goalText = [objective, nextStep].filter((s) => s.trim().length > 0).join('\n')
    goalKey = `${goalContext.goal.id}:${goalContext.goal.definition.version}:${goalContext.goal.native.revision}:${nextStep.slice(0, 64)}`
    if (goalText.length > 0) {
      cues.push({
        kind: 'goal',
        text: goalText,
        weight: 0.6,
      })
    }
  }

  // Cue 3: Tool-result entities ONLY (weight 0.4, never raw prose!)
  const entityIds: string[] = []
  for (const cue of state.toolEntities.values()) {
    if (cue.turn === turnNumber) {
      entityIds.push(cue.entityId)
    }
  }
  if (entityIds.length > 0) {
    cues.push({
      kind: 'tool-entity',
      text: '',
      entities: entityIds,
      weight: 0.4,
    })
  }

  // Cue 4: Time-decaying session activation set (decayed once per unique step evaluation)
  const halfLifeMs = Math.max(1, input.sessionHalfLifeMs ?? DEFAULT_SESSION_HALF_LIFE_MS)
  const stepDecay = input.sessionStepDecay ?? DEFAULT_SESSION_STEP_DECAY
  const sessionActivations: SessionActivationEntry[] = []

  if (shouldDecaySession) {
    for (const [nodeId, entry] of state.sessionActivation) {
      const dt = Math.max(0, nowMs - entry.updatedAt)
      const nextScore = entry.score * Math.exp((-Math.LN2 * dt) / halfLifeMs) * stepDecay
      if (nextScore < 0.01) {
        state.sessionActivation.delete(nodeId)
        continue
      }
      entry.score = nextScore
      entry.updatedAt = nowMs
      sessionActivations.push({ nodeId, score: nextScore, updatedAt: nowMs })
    }
  } else {
    for (const [nodeId, entry] of state.sessionActivation) {
      if (entry.score >= 0.01) {
        sessionActivations.push({ nodeId, score: entry.score, updatedAt: entry.updatedAt })
      }
    }
  }

  return { cues, goalKey, sessionActivations }
}

export function foldStepSessionActivation(
  state: AgentAssocState,
  items: readonly ScoredAssociationItem[],
  nowMs: number,
): void {
  for (const item of items) {
    const clampedScore = Math.min(2.0, Math.max(0.05, item.score))
    const existing = state.sessionActivation.get(item.id)
    if (existing !== undefined) {
      existing.score = Math.min(2.0, Math.max(existing.score, clampedScore))
      existing.updatedAt = nowMs
    } else {
      state.sessionActivation.set(item.id, {
        score: clampedScore,
        updatedAt: nowMs,
      })
    }
  }
  while (state.sessionActivation.size > MAX_SESSION_ACTIVATION_ENTRIES) {
    let minKey: string | undefined
    let minScore = Infinity
    for (const [k, v] of state.sessionActivation) {
      if (v.score < minScore) {
        minScore = v.score
        minKey = k
      }
    }
    if (minKey === undefined) break
    state.sessionActivation.delete(minKey)
  }
}
