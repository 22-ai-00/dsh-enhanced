import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry as AgentPresets } from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { externalPrincipalId } from './canonical.js'
import type { DeliveryStore } from './store.js'
import type { ConversationBinding, ConversationRef, ModelRouteRef } from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ray-worker': {
      kind: 'ray-worker'
      ticketId: string
      action: 'dispatch' | 'followup' | 'steer' | 'resume'
    }
  }
}

export type RayWorkerTicketStatus = 'running' | 'completed' | 'handed_back' | 'failed'

export type RayWorkerTicketEventKind =
  | 'dispatched'
  | 'followup'
  | 'steer'
  | 'completed'
  | 'handed_back'
  | 'failed'
  | 'resumed'
  | 'narrated'

export interface RayWorkerTicketSnapshot {
  readonly ticketId: string
  readonly sessionId: string
  readonly title: string
  readonly objective: string
  readonly scopeSummary: string
  readonly status: RayWorkerTicketStatus
  readonly sourceBindingId?: string
  readonly sourceChannel?: string
  readonly sourceAccount?: string
  readonly sourceChat?: string
  readonly principalId: string
  readonly workspace: string
  readonly agentPreset: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly tokenBudget?: number
  readonly usedTokens: number
  readonly resultSummary?: string
  readonly handbackReason?: string
  readonly errorMessage?: string
  readonly narrationText?: string
  readonly narrationSent: boolean
  readonly frontNarrated: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
}

interface RayWorkerTicketRow {
  ticket_id: string
  session_id: string
  title: string
  objective: string
  scope_summary: string
  status: string
  source_binding_id: string | null
  source_channel: string | null
  source_account: string | null
  source_chat: string | null
  principal_id: string
  workspace: string
  agent_preset: string
  provider: string
  model: string
  reasoning_effort: string | null
  token_budget: number | null
  used_tokens: number
  result_summary: string | null
  handback_reason: string | null
  error_message: string | null
  narration_text: string | null
  narration_sent: number
  front_narrated: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface RaySelfWorkerBridge {
  setSessionRole?(sessionId: string, role: 'front' | 'worker'): void
  registerDatabase?(plugin: string, dbPath: string, migratedFrom?: string): void
}

export interface RayWorkerRuntimeOptions {
  readonly rayHome: string
  readonly policy: AssistantPolicyService
  readonly deliveryStore: DeliveryStore
  readonly defaultWorkspace: string
  readonly defaultAgentPreset: string
  readonly defaultProvider: string
  readonly defaultModel: string
  readonly maxOutputTokens: number
  readonly getAgentPresets: () => Pick<AgentPresets, 'mount' | 'resolve'> | undefined
  readonly getModelSelection: (conversation: ConversationRef) => ModelRouteRef | undefined
  readonly isOwnerSessionAgent: (agent: Agent | undefined) => boolean
  readonly getRaySelf: () => RaySelfWorkerBridge | undefined
  readonly publishNarration: (ticket: RayWorkerTicketSnapshot) => Promise<boolean> | boolean
  readonly onTicketUpdated?: (ticket: RayWorkerTicketSnapshot) => void
  readonly warn?: (message: string) => void
}

interface TrackedWorker {
  readonly ticketId: string
  readonly handle: AgentHandle
  readonly cleanup: () => void
  pendingFollowups: number
}

const MAX_SUMMARY_CHARS = 1200

function clipText(value: string, maxChars = MAX_SUMMARY_CHARS): string {
  const clean = value.trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars - 1)}…`
}

function rowToSnapshot(row: RayWorkerTicketRow): RayWorkerTicketSnapshot {
  return Object.freeze({
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    title: row.title,
    objective: row.objective,
    scopeSummary: row.scope_summary,
    status: row.status as RayWorkerTicketStatus,
    ...(row.source_binding_id === null ? {} : { sourceBindingId: row.source_binding_id }),
    ...(row.source_channel === null ? {} : { sourceChannel: row.source_channel }),
    ...(row.source_account === null ? {} : { sourceAccount: row.source_account }),
    ...(row.source_chat === null ? {} : { sourceChat: row.source_chat }),
    principalId: row.principal_id,
    workspace: row.workspace,
    agentPreset: row.agent_preset,
    provider: row.provider,
    model: row.model,
    ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
    ...(row.token_budget === null ? {} : { tokenBudget: row.token_budget }),
    usedTokens: row.used_tokens,
    ...(row.result_summary === null ? {} : { resultSummary: row.result_summary }),
    ...(row.handback_reason === null ? {} : { handbackReason: row.handback_reason }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.narration_text === null ? {} : { narrationText: row.narration_text }),
    narrationSent: row.narration_sent === 1,
    frontNarrated: row.front_narrated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  })
}

function extractUsageTokens(events: readonly SessionEvent[]): number {
  let total = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = (event.data.message as {
      usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
    }).usage
    if (usage === undefined || typeof usage !== 'object' || usage === null) continue
    if (typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)) {
      total += Math.max(0, Math.floor(usage.totalTokens))
    } else {
      const inp = typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
      const out = typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0
      total += Math.max(0, Math.floor(inp + out))
    }
  }
  return total
}

function extractLastAssistantText(agent: Agent): string {
  const messages = agent.session.deriveMessages()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    const text = msg.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
      .trim()
    if (text !== '') return text
  }
  return ''
}

function inspectTurnState(events: readonly SessionEvent[]): {
  settledCompleted: boolean
  turnEndKind?: string
  errorMessage?: string
} {
  let lastUserSeq = -1
  let lastTurnStartSeq = -1
  let lastTurnEnd: Extract<SessionEvent, { type: 'turn/end' }> | undefined
  for (const event of events) {
    if (event.type === 'user/message') lastUserSeq = Number(event.seq)
    if (event.type === 'turn/start') lastTurnStartSeq = Number(event.seq)
    if (event.type === 'turn/end') lastTurnEnd = event
  }
  if (lastTurnEnd === undefined || Number(lastTurnEnd.seq) < lastTurnStartSeq || Number(lastTurnEnd.seq) < lastUserSeq) {
    return { settledCompleted: false }
  }
  const reason = lastTurnEnd.data.reason as { kind?: unknown; error?: { message?: unknown } } | undefined
  const turnEndKind = typeof reason?.kind === 'string' ? reason.kind : undefined
  const errorMessage = typeof reason?.error?.message === 'string' ? reason.error.message : undefined
  return {
    settledCompleted: turnEndKind === 'completed' || turnEndKind === 'max-tokens',
    ...(turnEndKind === undefined ? {} : { turnEndKind }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }
}

function buildNaturalNarration(snapshot: RayWorkerTicketSnapshot): string {
  if (snapshot.status === 'completed') {
    const summary = snapshot.resultSummary?.trim()
    return summary && summary !== ''
      ? `后台任务「${snapshot.title}」已完成：${clipText(summary, 500)}`
      : `后台任务「${snapshot.title}」（${snapshot.ticketId}）已完成。`
  }
  if (snapshot.status === 'handed_back') {
    const reason = snapshot.handbackReason ?? '超出当前任务边界或需要你的进一步确认'
    const summary = snapshot.resultSummary ? `（进展：${clipText(snapshot.resultSummary, 300)}）` : ''
    return `后台任务「${snapshot.title}」已交回前台协调：${reason}${summary}`
  }
  if (snapshot.status === 'failed') {
    const detail = snapshot.errorMessage ? `（${clipText(snapshot.errorMessage, 240)}）` : ''
    return `后台任务「${snapshot.title}」未顺利完成${detail}，可以随时告诉我是否重试或调整目标。`
  }
  return `后台任务「${snapshot.title}」正在进行中。`
}

function toModelSelection(route: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
  }
}

export class RayWorkerTicketRuntime {
  readonly databasePath: string
  private db: DatabaseSync | undefined
  private runtimeCtx: Context | undefined
  private readonly activeWorkers = new Map<string, TrackedWorker>()
  private recoveringPromise: Promise<number> | undefined
  private disposing = false
  private closed = false

  constructor(private readonly options: RayWorkerRuntimeOptions) {
    this.databasePath = `${options.rayHome.replace(/\/+$/u, '')}/state/tickets.sqlite`
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.databasePath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS ray_tickets (
        ticket_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        scope_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        source_binding_id TEXT,
        source_channel TEXT,
        source_account TEXT,
        source_chat TEXT,
        principal_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        agent_preset TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        token_budget INTEGER,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        handback_reason TEXT,
        error_message TEXT,
        narration_text TEXT,
        narration_sent INTEGER NOT NULL DEFAULT 0,
        front_narrated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ray_tickets_status ON ray_tickets(status, updated_at);
      CREATE TABLE IF NOT EXISTS ray_ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_ticket_events_ticket ON ray_ticket_events(ticket_id, id);
    `)
    this.db = db
    try {
      this.options.getRaySelf()?.registerDatabase?.('assistant-delivery/worker-tickets', this.databasePath)
    } catch {
      // Registration metadata is best-effort if Ray Home has not opened manifest yet.
    }
  }

  attachRuntime(ctx: Context): void {
    if (this.closed || this.disposing) return
    this.runtimeCtx = ctx
  }

  detachRuntime(ctx: Context): void {
    if (this.runtimeCtx === ctx) {
      this.runtimeCtx = undefined
    }
  }

  private assertOpen(): DatabaseSync {
    if (this.closed || this.db === undefined) {
      throw new Error('assistant-delivery: worker ticket runtime is closed')
    }
    return this.db
  }

  private getTicketRow(ticketId: string): RayWorkerTicketRow | undefined {
    const db = this.assertOpen()
    return db.prepare('SELECT * FROM ray_tickets WHERE ticket_id = ?').get(ticketId) as RayWorkerTicketRow | undefined
  }

  private getTicketRowBySession(sessionId: string): RayWorkerTicketRow | undefined {
    const db = this.assertOpen()
    return db.prepare('SELECT * FROM ray_tickets WHERE session_id = ?').get(sessionId) as RayWorkerTicketRow | undefined
  }

  private appendEvent(ticketId: string, kind: RayWorkerTicketEventKind, payload: Record<string, unknown>, now = Date.now()): void {
    const db = this.assertOpen()
    db.prepare('INSERT INTO ray_ticket_events (ticket_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(ticketId, kind, JSON.stringify(payload), now)
  }

  ownsWorkerSession(sessionId: string): boolean {
    if (this.closed || this.db === undefined) return false
    const clean = sessionId.trim()
    if (clean === '') return false
    return this.getTicketRowBySession(clean) !== undefined
  }

  hasTickets(): boolean {
    if (this.closed || this.db === undefined) return false
    const row = this.db.prepare('SELECT 1 AS found FROM ray_tickets LIMIT 1').get() as { found?: number } | undefined
    return row?.found === 1
  }

  listTickets(input: { status?: RayWorkerTicketStatus; limit?: number } = {}): readonly RayWorkerTicketSnapshot[] {
    if (this.closed || this.db === undefined) return []
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)))
    const rows = input.status === undefined
      ? this.db.prepare('SELECT * FROM ray_tickets ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as RayWorkerTicketRow[]
      : this.db.prepare('SELECT * FROM ray_tickets WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(input.status, limit) as unknown as RayWorkerTicketRow[]
    return rows.map(rowToSnapshot)
  }

  getTicket(ticketId: string): RayWorkerTicketSnapshot | undefined {
    if (this.closed || this.db === undefined) return undefined
    const row = this.getTicketRow(ticketId)
    return row === undefined ? undefined : rowToSnapshot(row)
  }

  listTicketEvents(ticketId: string, limit = 50): readonly {
    readonly id: number
    readonly ticketId: string
    readonly kind: RayWorkerTicketEventKind
    readonly payload: Record<string, unknown>
    readonly createdAt: number
  }[] {
    const db = this.assertOpen()
    const rows = db.prepare('SELECT * FROM ray_ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT ?')
      .all(ticketId, Math.max(1, Math.min(200, Math.floor(limit)))) as unknown as {
        id: number
        ticket_id: string
        kind: string
        payload_json: string
        created_at: number
      }[]
    return rows.map(row => ({
      id: row.id,
      ticketId: row.ticket_id,
      kind: row.kind as RayWorkerTicketEventKind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }))
  }

  private resolveFrozenRoute(
    frontAgent: Agent,
    binding: Readonly<ConversationBinding>,
  ): ModelRouteRef {
    const headerEvent = frontAgent.session.snapshotEvents().findLast(event => event.type === 'request/header')
    const headerConfig = headerEvent?.type === 'request/header' ? headerEvent.data.header.config : undefined
    if (headerConfig?.provider && headerConfig.model) {
      return {
        provider: headerConfig.provider,
        model: headerConfig.model,
        ...(headerConfig.reasoningEffort === undefined ? {} : { reasoningEffort: String(headerConfig.reasoningEffort) }),
      }
    }
    const stored = this.options.getModelSelection(binding.conversation)
    if (stored !== undefined) return stored
    return { provider: this.options.defaultProvider, model: this.options.defaultModel }
  }

  private async setupWorkerAgent(
    agentCtx: Context,
    preparedAgent: Agent | undefined,
    ticket: RayWorkerTicketSnapshot,
    presetId: string,
    agentPresets: Pick<AgentPresets, 'mount' | 'resolve'> | undefined,
  ): Promise<void> {
    if (preparedAgent === undefined) {
      throw new Error('assistant-delivery: worker Agent identity is missing')
    }
    const unbindInitiator = this.options.policy.bindInitiator(preparedAgent, 'external', ticket.principalId)
    agentCtx.effect(() => unbindInitiator, 'assistant-delivery.ray-worker-initiator')
    this.options.getRaySelf()?.setSessionRole?.(ticket.sessionId, 'worker')
    installModelSelection(agentCtx)
    preparedAgent.model.select(toModelSelection({
      provider: ticket.provider,
      model: ticket.model,
      ...(ticket.reasoningEffort === undefined ? {} : { reasoningEffort: ticket.reasoningEffort }),
    }))
    agentCtx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.context({
      name: 'ray:worker-ticket-scope',
      order: 245,
      text: () => {
        const latest = this.getTicket(ticket.ticketId) ?? ticket
        return [
          '[Ray Persistent Worker Ticket]',
          `- ticketId: ${latest.ticketId}`,
          `- title: ${latest.title}`,
          `- objective: ${latest.objective}`,
          `- scope: ${latest.scopeSummary}`,
          ...(latest.tokenBudget === undefined ? [] : [`- tokenBudget: ${latest.tokenBudget} (used ${latest.usedTokens})`]),
          '- instructions: You are an independent persistent background worker for Ray running concurrently with the front consciousness. Focus strictly on your ticket objective and scope. If the owner sends a steering/follow-up note, adapt in place without discarding progress. If requirements grow out of scope or hit an unresolvable blocker requiring owner coordination, call `ticket_handback` with a clear `reason` and `summary`.',
        ].join('\n')
      },
    }))
    await agentPresets?.mount(agentCtx, presetId)
  }

  private observeWorkerHandle(ticketId: string, handle: AgentHandle): TrackedWorker {
    const existing = this.activeWorkers.get(ticketId)
    if (existing !== undefined) {
      if (existing.handle === handle) return existing
      existing.cleanup()
    }
    const runtimeCtx = this.runtimeCtx
    const disposers: (() => void)[] = []
    if (runtimeCtx !== undefined) {
      disposers.push(runtimeCtx.on('session/event', (session, event) => {
        if (session !== handle.agent.session) return
        if (event.type === 'turn/end' || event.type === 'assistant/message') {
          this.syncTokenUsage(ticketId, handle.agent)
        }
        if (event.type === 'turn/end') {
          void this.reconcileWorkerSettlement(ticketId, handle.agent)
        }
      }))
      disposers.push(runtimeCtx.on('agent/status', ({ agent, status }) => {
        if (agent !== handle.agent || status !== 'idle') return
        void this.reconcileWorkerSettlement(ticketId, handle.agent)
      }))
    }
    const tracked: TrackedWorker = {
      ticketId,
      handle,
      pendingFollowups: 0,
      cleanup: () => {
        for (const dispose of disposers) {
          try { dispose() } catch {}
        }
      },
    }
    this.activeWorkers.set(ticketId, tracked)
    return tracked
  }

  private syncTokenUsage(ticketId: string, agent: Agent): void {
    if (this.closed || this.db === undefined) return
    const usedTokens = extractUsageTokens(agent.session.snapshotEvents())
    if (usedTokens <= 0) return
    this.db.prepare('UPDATE ray_tickets SET used_tokens = MAX(used_tokens, ?), updated_at = ? WHERE ticket_id = ?')
      .run(usedTokens, Date.now(), ticketId)
  }

  private async reconcileWorkerSettlement(ticketId: string, agent: Agent): Promise<void> {
    if (this.closed || this.disposing || this.db === undefined) return
    const tracked = this.activeWorkers.get(ticketId)
    const row = this.getTicketRow(ticketId)
    if (row === undefined || row.status !== 'running') return
    if (tracked !== undefined && tracked.pendingFollowups > 0) return
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return

    const events = agent.session.snapshotEvents()
    const turnState = inspectTurnState(events)
    if (!turnState.settledCompleted && turnState.turnEndKind === undefined) return

    const now = Date.now()
    const usedTokens = Math.max(row.used_tokens, extractUsageTokens(events))
    const assistantText = extractLastAssistantText(agent)
    const nextStatus: RayWorkerTicketStatus = turnState.settledCompleted ? 'completed' : 'failed'
    const resultSummary = assistantText !== '' ? clipText(assistantText) : row.result_summary
    const errorMessage = nextStatus === 'failed'
      ? (turnState.errorMessage ?? `turn ended with ${turnState.turnEndKind ?? 'unknown'}`)
      : null

    const draft = rowToSnapshot({
      ...row,
      status: nextStatus,
      used_tokens: usedTokens,
      result_summary: resultSummary ?? null,
      error_message: errorMessage,
      updated_at: now,
      completed_at: now,
    })
    const narration = buildNaturalNarration(draft)
    const updated = this.db.prepare(`
      UPDATE ray_tickets
      SET status = ?, used_tokens = ?, result_summary = ?, error_message = ?, narration_text = ?, updated_at = ?, completed_at = ?
      WHERE ticket_id = ? AND status = 'running'
    `).run(nextStatus, usedTokens, resultSummary ?? null, errorMessage, narration, now, now, ticketId)
    if (Number(updated.changes) === 0) return

    this.appendEvent(ticketId, nextStatus === 'completed' ? 'completed' : 'failed', {
      usedTokens,
      ...(turnState.turnEndKind === undefined ? {} : { turnEndKind: turnState.turnEndKind }),
      ...(errorMessage === null ? {} : { errorMessage }),
    }, now)

    const finalized = this.getTicket(ticketId)
    if (finalized !== undefined) {
      this.options.onTicketUpdated?.(finalized)
      await this.tryPublishNarration(finalized)
    }
  }

  private async tryPublishNarration(ticket: RayWorkerTicketSnapshot): Promise<void> {
    if (this.closed || this.disposing || this.db === undefined || ticket.narrationSent || !ticket.narrationText) return
    let sent = false
    try {
      sent = await this.options.publishNarration(ticket)
    } catch {
      sent = false
    }
    if (sent && !this.closed && this.db !== undefined) {
      const now = Date.now()
      this.db.prepare('UPDATE ray_tickets SET narration_sent = 1, updated_at = ? WHERE ticket_id = ?')
        .run(now, ticket.ticketId)
      this.appendEvent(ticket.ticketId, 'narrated', { channel: ticket.sourceChannel ?? 'unknown' }, now)
      const latest = this.getTicket(ticket.ticketId)
      if (latest !== undefined) this.options.onTicketUpdated?.(latest)
    }
  }

  async dispatchTicket(
    frontAgent: Agent | undefined,
    input: {
      title: string
      objective: string
      scopeSummary?: string
      tokenBudget?: number
    },
  ): Promise<RayWorkerTicketSnapshot> {
    const db = this.assertOpen()
    if (!this.options.isOwnerSessionAgent(frontAgent) || frontAgent === undefined) {
      throw new Error('assistant-delivery: ticket_dispatch requires an authenticated owner front session')
    }
    if (this.disposing) {
      throw new Error('assistant-delivery: worker ticket runtime is stopping')
    }
    const ctx = this.runtimeCtx
    const agents = ctx?.get('agents')
    const sessions = ctx?.get('sessions')
    if (ctx === undefined || agents === undefined || sessions === undefined) {
      throw new Error('assistant-delivery: agent runtime is unavailable for persistent worker dispatch')
    }
    const frontSessionId = String(frontAgent.session.id)
    const binding = this.options.deliveryStore.getBindingBySession(frontSessionId)
    if (binding === undefined || binding.status !== 'active') {
      throw new Error('assistant-delivery: active conversation binding not found for front session')
    }
    const route = this.resolveFrozenRoute(frontAgent, binding)
    const agentPresets = this.options.getAgentPresets()
    const presetId = agentPresets === undefined
      ? binding.agentPreset
      : (await agentPresets.resolve(binding.agentPreset)).id

    const now = Date.now()
    const ticketId = `tkt_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const sessionId = `ray_worker_${randomUUID()}`
    const title = clipText(input.title, 200)
    const objective = input.objective.trim()
    const scopeSummary = input.scopeSummary?.trim() || title
    if (title === '' || objective === '') {
      throw new Error('assistant-delivery: ticket title and objective are required')
    }
    const tokenBudget = input.tokenBudget !== undefined && Number.isSafeInteger(input.tokenBudget) && input.tokenBudget > 0
      ? input.tokenBudget
      : null

    db.prepare(`
      INSERT INTO ray_tickets (
        ticket_id, session_id, title, objective, scope_summary, status,
        source_binding_id, source_channel, source_account, source_chat,
        principal_id, workspace, agent_preset, provider, model, reasoning_effort,
        token_budget, used_tokens, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      ticketId,
      sessionId,
      title,
      objective,
      scopeSummary,
      binding.id,
      binding.conversation.channel,
      binding.conversation.account,
      binding.conversation.chat,
      externalPrincipalId(binding.principal),
      binding.workspace,
      presetId,
      route.provider,
      route.model,
      route.reasoningEffort ?? null,
      tokenBudget,
      now,
      now,
    )
    const initial = this.getTicket(ticketId)!
    this.appendEvent(ticketId, 'dispatched', {
      sourceBindingId: binding.id,
      sourceChannel: binding.conversation.channel,
      provider: route.provider,
      model: route.model,
    }, now)

    try {
      const handle = await agents.create({
        sessionId: SessionId(sessionId),
        meta: {
          cwd: binding.workspace,
          agentPreset: presetId,
        },
        agentOptions: {
          provider: route.provider,
          model: route.model,
          maxTokens: this.options.maxOutputTokens,
        },
        setup: async (agentCtx, preparedAgent) => {
          await this.setupWorkerAgent(agentCtx, preparedAgent, initial, presetId, agentPresets)
        },
      })
      const tracked = this.observeWorkerHandle(ticketId, handle)
      await sessions.flush(handle.agent.session)
      const promptText = [
        `请作为文鳐的持久后台 Worker 执行以下工单（${ticketId}）：`,
        `标题：${title}`,
        `目标：${objective}`,
        `范围边界：${scopeSummary}`,
        '请独立完成并给出清晰可向主人转述的最终结论；如果发现范围明显超出或需主人重新决策，请调用 ticket_handback。',
      ].join('\n')
      tracked.pendingFollowups += 1
      try {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: promptText }],
          source: { kind: 'ray-worker', ticketId, action: 'dispatch' },
        }))
      } finally {
        tracked.pendingFollowups = Math.max(0, tracked.pendingFollowups - 1)
      }
      this.options.onTicketUpdated?.(initial)
      return initial
    } catch (error) {
      const failedAt = Date.now()
      const msg = error instanceof Error ? error.message : String(error)
      db.prepare('UPDATE ray_tickets SET status = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE ticket_id = ?')
        .run('failed', msg, failedAt, failedAt, ticketId)
      this.appendEvent(ticketId, 'failed', { errorMessage: msg }, failedAt)
      throw error
    }
  }

  async followupTicket(
    frontAgent: Agent | undefined,
    input: {
      ticketId: string
      message: string
      mode?: 'steer' | 'followup'
    },
  ): Promise<{
    readonly ticket: RayWorkerTicketSnapshot
    readonly deliveryMode: 'steer' | 'followup'
  }> {
    const db = this.assertOpen()
    if (!this.options.isOwnerSessionAgent(frontAgent) || frontAgent === undefined) {
      throw new Error('assistant-delivery: ticket_followup requires an authenticated owner front session')
    }
    const row = this.getTicketRow(input.ticketId.trim())
    if (row === undefined) {
      throw new Error(`assistant-delivery: unknown worker ticket ${input.ticketId}`)
    }
    const messageText = input.message.trim()
    if (messageText === '') {
      throw new Error('assistant-delivery: follow-up message cannot be empty')
    }
    const ctx = this.runtimeCtx
    const agents = ctx?.get('agents')
    if (ctx === undefined || agents === undefined) {
      throw new Error('assistant-delivery: agent runtime is unavailable for worker follow-up')
    }

    let tracked = this.activeWorkers.get(row.ticket_id)
    if (tracked === undefined) {
      const existingAgent = agents.get(SessionId(row.session_id))
      if (existingAgent !== undefined) {
        tracked = this.observeWorkerHandle(row.ticket_id, {
          agent: existingAgent,
          dispose: async () => {},
        })
      } else {
        const snapshot = rowToSnapshot(row)
        const agentPresets = this.options.getAgentPresets()
        const presetId = agentPresets === undefined
          ? row.agent_preset
          : (await agentPresets.resolve(row.agent_preset)).id
        const handle = await agents.resume({
          resumeSessionId: SessionId(row.session_id),
          agentOptions: {
            provider: row.provider,
            model: row.model,
            maxTokens: this.options.maxOutputTokens,
          },
          setup: async (agentCtx, preparedAgent) => {
            await this.setupWorkerAgent(agentCtx, preparedAgent, snapshot, presetId, agentPresets)
          },
        })
        tracked = this.observeWorkerHandle(row.ticket_id, handle)
      }
    }

    const now = Date.now()
    const frontBinding = this.options.deliveryStore.getBindingBySession(String(frontAgent.session.id))
    if (row.status !== 'running') {
      db.prepare(`
        UPDATE ray_tickets
        SET status = 'running', handback_reason = NULL, error_message = NULL, narration_sent = 0, front_narrated = 0,
            completed_at = NULL, updated_at = ?,
            source_binding_id = COALESCE(?, source_binding_id),
            source_channel = COALESCE(?, source_channel),
            source_account = COALESCE(?, source_account),
            source_chat = COALESCE(?, source_chat)
        WHERE ticket_id = ?
      `).run(
        now,
        frontBinding?.id ?? null,
        frontBinding?.conversation.channel ?? null,
        frontBinding?.conversation.account ?? null,
        frontBinding?.conversation.chat ?? null,
        row.ticket_id,
      )
    } else if (frontBinding !== undefined) {
      // Allow owner interruptions from any surface to also update the latest narration target.
      db.prepare(`
        UPDATE ray_tickets
        SET source_binding_id = ?, source_channel = ?, source_account = ?, source_chat = ?, updated_at = ?
        WHERE ticket_id = ?
      `).run(
        frontBinding.id,
        frontBinding.conversation.channel,
        frontBinding.conversation.account,
        frontBinding.conversation.chat,
        now,
        row.ticket_id,
      )
    }

    const agent = tracked.handle.agent
    const deliveryMode: 'steer' | 'followup' = input.mode === 'followup'
      ? 'followup'
      : input.mode === 'steer'
        ? 'steer'
        : agent.status === 'idle'
          ? 'followup'
          : 'steer'

    const payloadMsg = createUserMessage({
      content: [{
        type: 'text',
        text: `[主人补充/插话 - ${deliveryMode === 'steer' ? '不中断实时调整' : '追加指令'}] ${messageText}`,
      }],
      source: { kind: 'ray-worker', ticketId: row.ticket_id, action: deliveryMode },
    })

    tracked.pendingFollowups += 1
    try {
      this.appendEvent(row.ticket_id, deliveryMode, { message: clipText(messageText, 400) }, now)
      if (deliveryMode === 'steer') {
        agent.steer(payloadMsg)
      } else {
        agent.followup(payloadMsg)
      }
    } finally {
      tracked.pendingFollowups = Math.max(0, tracked.pendingFollowups - 1)
    }

    const updated = this.getTicket(row.ticket_id)!
    this.options.onTicketUpdated?.(updated)
    return { ticket: updated, deliveryMode }
  }

  async handbackTicket(
    workerAgent: Agent | undefined,
    input: {
      reason: string
      summary: string
      suggestedNextStep?: string
    },
  ): Promise<RayWorkerTicketSnapshot> {
    const db = this.assertOpen()
    if (workerAgent === undefined) {
      throw new Error('assistant-delivery: ticket_handback requires a worker session')
    }
    const sessionId = String(workerAgent.session.id)
    const row = this.getTicketRowBySession(sessionId)
    if (row === undefined) {
      throw new Error('assistant-delivery: ticket_handback is restricted to active persistent worker sessions')
    }
    const reason = input.reason.trim()
    const summary = input.summary.trim()
    if (reason === '' || summary === '') {
      throw new Error('assistant-delivery: handback reason and summary are required')
    }
    const now = Date.now()
    const usedTokens = Math.max(row.used_tokens, extractUsageTokens(workerAgent.session.snapshotEvents()))
    const fullSummary = input.suggestedNextStep?.trim()
      ? `${summary}\n建议下一步：${input.suggestedNextStep.trim()}`
      : summary
    const draft = rowToSnapshot({
      ...row,
      status: 'handed_back',
      used_tokens: usedTokens,
      handback_reason: reason,
      result_summary: fullSummary,
      error_message: null,
      updated_at: now,
      completed_at: now,
    })
    const narration = buildNaturalNarration(draft)
    db.prepare(`
      UPDATE ray_tickets
      SET status = 'handed_back', used_tokens = ?, handback_reason = ?, result_summary = ?,
          error_message = NULL, narration_text = ?, narration_sent = 0, front_narrated = 0,
          updated_at = ?, completed_at = ?
      WHERE ticket_id = ?
    `).run(usedTokens, reason, fullSummary, narration, now, now, row.ticket_id)
    this.appendEvent(row.ticket_id, 'handed_back', {
      reason: clipText(reason, 300),
      summary: clipText(fullSummary, 400),
    }, now)
    const updated = this.getTicket(row.ticket_id)!
    this.options.onTicketUpdated?.(updated)
    await this.tryPublishNarration(updated)
    return this.getTicket(row.ticket_id) ?? updated
  }

  async recoverUnfinishedTickets(): Promise<number> {
    if (this.closed || this.disposing || this.db === undefined) return 0
    if (this.recoveringPromise !== undefined) return this.recoveringPromise
    const flight = this.recoverUnfinishedTicketsInternal().finally(() => {
      if (this.recoveringPromise === flight) this.recoveringPromise = undefined
    })
    this.recoveringPromise = flight
    return flight
  }

  private async recoverUnfinishedTicketsInternal(): Promise<number> {
    const db = this.assertOpen()
    const ctx = this.runtimeCtx
    const agents = ctx?.get('agents')
    const sessions = ctx?.get('sessions')
    if (ctx === undefined || agents === undefined || sessions === undefined) return 0

    const pendingRows = db.prepare('SELECT * FROM ray_tickets WHERE status = ? ORDER BY created_at ASC')
      .all('running') as unknown as RayWorkerTicketRow[]
    let recovered = 0
    const agentPresets = this.options.getAgentPresets()

    for (const row of pendingRows) {
      if (this.closed || this.disposing) break
      if (this.activeWorkers.has(row.ticket_id)) continue
      try {
        const snapshot = rowToSnapshot(row)
        const presetId = agentPresets === undefined
          ? row.agent_preset
          : (await agentPresets.resolve(row.agent_preset)).id
        const handle = await agents.resume({
          resumeSessionId: SessionId(row.session_id),
          agentOptions: {
            provider: row.provider,
            model: row.model,
            maxTokens: this.options.maxOutputTokens,
          },
          setup: async (agentCtx, preparedAgent) => {
            await this.setupWorkerAgent(agentCtx, preparedAgent, snapshot, presetId, agentPresets)
          },
        })
        const tracked = this.observeWorkerHandle(row.ticket_id, handle)
        const now = Date.now()
        this.appendEvent(row.ticket_id, 'resumed', { sessionId: row.session_id }, now)
        const turnState = inspectTurnState(handle.agent.session.snapshotEvents())
        const assistantText = extractLastAssistantText(handle.agent)
        if (turnState.settledCompleted && assistantText !== '' && handle.agent.status === 'idle') {
          await this.reconcileWorkerSettlement(row.ticket_id, handle.agent)
        } else if (handle.agent.status === 'idle' && handle.agent.inbox.nextTurn.length === 0) {
          tracked.pendingFollowups += 1
          try {
            handle.agent.followup(createUserMessage({
              content: [{
                type: 'text',
                text: `宿主刚刚重启恢复。请从上次进度继续完成工单「${row.title}」（${row.ticket_id}）；如果任务已不再适用或超出边界，请调用 ticket_handback。`,
              }],
              source: { kind: 'ray-worker', ticketId: row.ticket_id, action: 'resume' },
            }))
          } finally {
            tracked.pendingFollowups = Math.max(0, tracked.pendingFollowups - 1)
          }
        }
        recovered += 1
      } catch (error) {
        this.options.warn?.(
          `assistant-delivery: failed to recover worker ticket ${row.ticket_id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return recovered
  }

  markFrontNarrated(ticketIds: readonly string[]): void {
    if (this.closed || this.db === undefined || ticketIds.length === 0) return
    const now = Date.now()
    const stmt = this.db.prepare('UPDATE ray_tickets SET front_narrated = 1, updated_at = ? WHERE ticket_id = ?')
    for (const ticketId of ticketIds) {
      stmt.run(now, ticketId)
    }
  }

  pendingFrontNarrationIds(): readonly string[] {
    if (this.closed || this.db === undefined) return []
    const rows = this.db.prepare(`
      SELECT ticket_id FROM ray_tickets
      WHERE status IN ('completed', 'handed_back', 'failed') AND front_narrated = 0
      ORDER BY updated_at ASC LIMIT 10
    `).all() as unknown as { ticket_id: string }[]
    return rows.map(row => row.ticket_id)
  }

  renderFrontPromptContext(): string {
    if (this.closed || this.db === undefined) return ''
    const running = this.listTickets({ status: 'running', limit: 8 })
    const pendingNarration = this.db.prepare(`
      SELECT * FROM ray_tickets
      WHERE status IN ('completed', 'handed_back', 'failed') AND front_narrated = 0
      ORDER BY updated_at DESC LIMIT 6
    `).all() as unknown as RayWorkerTicketRow[]
    const recentTerminal = pendingNarration.length > 0
      ? pendingNarration.map(rowToSnapshot)
      : this.listTickets({ limit: 4 }).filter(t => t.status !== 'running')

    const lines = [
      '## 前台意识与持久 Worker 协作策略',
      '- 对需要多步调研、长耗时执行或可独立推进的工作，优先用 `ticket_dispatch` 派发持久后台 Worker 并立即自然回应主人，保持对话随时可插话。',
      '- 当主人中途插话补充需求、修改方向或纠正细节时，不要取消原工单，优先用 `ticket_followup`（`steer` 或 `followup`）把调整路由给对应 Worker；用 `ticket_list` 查看当前进度。',
    ]
    if (running.length > 0) {
      lines.push('', '### 正在进行的持久 Worker 工单')
      for (const t of running) {
        lines.push(`- ${t.ticketId} | ${t.title} | 状态: running | 已用 tokens: ${t.usedTokens}${t.tokenBudget ? `/${t.tokenBudget}` : ''}`)
      }
    }
    if (pendingNarration.length > 0) {
      lines.push('', '### 待自然转述给主人的 Worker 结果（请在本轮回复中用自然语言主动同步关键结果，不要直接贴原始 JSON）')
      for (const row of pendingNarration) {
        const snap = rowToSnapshot(row)
        lines.push(`- ${snap.ticketId} | ${snap.title} | ${snap.status}: ${snap.narrationText ?? snap.resultSummary ?? snap.handbackReason ?? snap.errorMessage ?? ''}`)
      }
    } else if (recentTerminal.length > 0) {
      lines.push('', '### 近期已结算工单')
      for (const t of recentTerminal) {
        lines.push(`- ${t.ticketId} | ${t.title} | ${t.status}: ${clipText(t.narrationText ?? t.resultSummary ?? t.handbackReason ?? '', 180)}`)
      }
    }
    return lines.join('\n')
  }

  formatTicketsCommandReply(): string {
    const tickets = this.listTickets({ limit: 12 })
    if (tickets.length === 0) {
      return '当前没有进行中或近期的持久 Worker 工单。'
    }
    const statusLabel = (s: RayWorkerTicketStatus): string =>
      s === 'running' ? '运行中'
        : s === 'completed' ? '已完成'
          : s === 'handed_back' ? '已交回前台'
            : '失败'
    const lines = ['文鳐持久 Worker 工单：']
    for (const t of tickets) {
      const detail = t.status === 'handed_back'
        ? t.handbackReason ?? t.resultSummary ?? ''
        : t.status === 'completed'
          ? t.resultSummary ?? ''
          : t.status === 'failed'
            ? t.errorMessage ?? ''
            : t.objective
      lines.push(`- [${statusLabel(t.status)}] ${t.ticketId} · ${t.title}${detail ? `：${clipText(detail, 120)}` : ''}`)
    }
    return lines.join('\n')
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.disposing = true
    const workers = [...this.activeWorkers.values()]
    this.activeWorkers.clear()
    for (const worker of workers) {
      worker.cleanup()
      try {
        await worker.handle.dispose()
      } catch {}
    }
    if (this.recoveringPromise !== undefined) {
      try { await this.recoveringPromise } catch {}
    }
    this.runtimeCtx = undefined
    this.closed = true
    try {
      this.db?.close()
    } catch {}
    this.db = undefined
  }
}
