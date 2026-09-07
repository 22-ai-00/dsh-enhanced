/**
 * Ephemeral, production-native owner runtime for one strategy benchmark cell.
 *
 * This is deliberately a Host helper rather than a benchmark fixture.  It
 * composes the public DSH services used by Delivery and keeps every durable
 * artifact below the caller-provided benchmark state root.  It never opens a
 * real channel adapter and does not discover a user's DSH profile.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { DeliveryAdapter, DeliveryOwnerLineage, InboundEnvelope, OutboundIntent, OwnerRouteValidationReceipt } from '@dsh-enhanced/assistant-delivery/types'
import { AssistantPolicyService, type PolicyRule } from '@dsh-enhanced/assistant-policy'
import { benchmarkSnapshot } from './schema.js'

/** Public structural surface avoids the Evaluation ↔ Delivery service declaration build cycle. */
interface OwnerDelivery {
  registerAdapter(adapter: DeliveryAdapter): Promise<() => Promise<void>>
  issuePairing(operator: string, principal: InboundEnvelope['principal']): { challenge: { id: string }; code: string }
  confirmPairing(input: { challengeId: string; principal: InboundEnvelope['principal']; code: string }): { id: string; version: number; role: string; status: string }
  acceptInbound(input: InboundEnvelope): Promise<{ inboxId: string; duplicate: boolean; status: string }>
  validateOwnerRoute(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }): OwnerRouteValidationReceipt
  tick(): Promise<void>
  whenIdle(): Promise<void>
  health(): { pendingInbox: number; pendingOutbox: number; deadLetterInbox: number; deadLetterOutbox: number; unknownOutbox: number; pendingPresentations: number; deadPresentations: number }
}

const MAX_TEXT_BYTES = 64 * 1024
const safeId = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}
const safeRoute = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u.test(value)) throw new Error(`invalid ${label}`)
  return value
}
const positive = (value: unknown, label: string, max: number): number => {
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${label}`)
  const number = value as number
  if (number < 1 || number > max) throw new Error(`invalid ${label}`)
  return number
}
const inside = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}/`)
async function privateCanonicalDirectory(path: string, label: string): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a private non-symlink directory`)
  }
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) throw new Error(`${label} must belong to the current OS user`)
  const canonical = await realpath(path)
  if (canonical !== path) throw new Error(`${label} must be canonical`)
  return canonical
}

export interface BenchmarkStrategyOwnerOptions {
  /** Fresh Context owned by one benchmark cell.  The helper installs its Host services into it. */
  ctx: Context
  /** Isolated candidate workspace, never a user profile directory. */
  workspace: string
  /** Separate per-cell durable state root, outside the candidate workspace. */
  stateRoot: string
  /** Stable plan/cell identity; it becomes only local channel identifiers. */
  cellId: string
  provider: string
  model: string
  maxOutputTokens: number
  persona: string
  /** Extra fixed policy rules, normally the two allowed Goal tools and goal actions. */
  policyRules: readonly PolicyRule[]
  /** Global tools visible to this Delivery owner.  Defaults to the two Goal tools. */
  allowedToolNames?: readonly string[]
  agentPreset?: string
}

export interface BenchmarkStrategyOwnerScope {
  readonly workspace: string
  readonly preset: string
  readonly principalId: string
  readonly owner: Readonly<DeliveryOwnerLineage>
  readonly route: Readonly<OwnerRouteValidationReceipt>
}

export interface BenchmarkStrategyOwnerRuntime {
  readonly ctx: Context
  readonly workspace: string
  readonly stateRoot: string
  /** Fresh, private state directory for this exact runtime; retained for evidence after shutdown. */
  readonly runtimeRoot: string
  readonly principal: Readonly<InboundEnvelope['principal']>
  readonly conversation: Readonly<InboundEnvelope['conversation']>
  readonly outbound: readonly Readonly<OutboundIntent>[]
  /** Register the sole exact model route after the caller installs its outer meter. */
  installModel(adapter: LlmAdapter): Promise<void>
  /** Pair the synthetic owner before the one public inbound message is admitted. */
  pairOwner(): Readonly<DeliveryOwnerLineage>
  /** Admit exactly one synthetic public owner message through Delivery. */
  sendPublicInbound(text: string): Promise<Readonly<{ inboxId: string; duplicate: boolean; status: string }>>
  /** Drain actual Delivery work and, when supplied, actual Goals work. */
  waitForQuiescence(goals?: Readonly<{ whenIdle(): Promise<void> }>): Promise<void>
  /** Read only public Delivery owner-route evidence after the owner binding exists. */
  ownerScope(): Readonly<BenchmarkStrategyOwnerScope>
  shutdown(): Promise<void>
}

/**
 * Compose the real DSH/Delivery stack needed by a native strategy cell.
 *
 * Goals, Verifier, the in-process Subagent provider, the outer meter, and the
 * model adapter deliberately remain caller-owned: they differ by cell or arm
 * and must be installed before `sendPublicInbound()`.
 */
export async function createBenchmarkStrategyOwnerRuntime(
  input: BenchmarkStrategyOwnerOptions,
): Promise<BenchmarkStrategyOwnerRuntime> {
  const ctx = input.ctx
  if (['llm', 'sessions', 'agents', 'tools', 'assistantDelivery'].some(name => ctx.get(name as never) !== undefined)) {
    throw new Error('benchmark owner requires a fresh dedicated Context')
  }
  const workspace = resolve(input.workspace)
  const stateRoot = resolve(input.stateRoot)
  if (!isAbsolute(input.workspace) || !isAbsolute(input.stateRoot) || inside(workspace, stateRoot) || inside(stateRoot, workspace)) {
    throw new Error('benchmark workspace and state root must be distinct absolute directories')
  }
  const cellId = safeId(input.cellId, 'benchmark cell id')
  const provider = safeRoute(input.provider, 'provider')
  const model = safeRoute(input.model, 'model')
  const preset = safeId(input.agentPreset ?? 'benchmark', 'agent preset')
  const maxOutputTokens = positive(input.maxOutputTokens, 'max output tokens', 1_000_000)
  if (typeof input.persona !== 'string' || Buffer.byteLength(input.persona, 'utf8') > MAX_TEXT_BYTES) throw new Error('invalid benchmark persona')
  const persona = input.persona
  const policyRules = benchmarkSnapshot(input.policyRules)
  const allowedToolNames = Object.freeze([...(input.allowedToolNames ?? ['goal_create', 'goal_strategy'])].map(value => safeId(value, 'allowed tool name')))
  if (new Set(allowedToolNames).size !== allowedToolNames.length) throw new Error('duplicate allowed tool name')
  const fingerprint = createHash('sha256').update(`${cellId}\0${workspace}\0${stateRoot}`).digest('hex').slice(0, 24)
  const channel = `benchmark-${fingerprint.slice(0, 12)}`
  const account = `cell-${fingerprint.slice(12)}`
  const principal = Object.freeze({ channel, account, tenant: 'isolated', user: `owner-${fingerprint}` })
  const conversation = Object.freeze({ channel, account, tenant: 'isolated', kind: 'dm' as const, chat: `private-${fingerprint}` })
  const deliveryPackage = '@dsh-enhanced/assistant-delivery'
  const deliveryModule = await import(deliveryPackage)
  if (typeof deliveryModule.AssistantDeliveryService !== 'function' || typeof deliveryModule.externalPrincipalId !== 'function') throw new Error('benchmark Delivery peer lacks required public APIs')
  const principalId: string = deliveryModule.externalPrincipalId(principal)
  const Delivery = deliveryModule.AssistantDeliveryService as new (ctx: Context, config: unknown) => OwnerDelivery
  let delivery!: OwnerDelivery
  const authorityId = `benchmark-owner-${fingerprint}`
  const bootstrapId = `benchmark-bootstrap-${fingerprint}`
  const runtimeRoot = join(stateRoot, `owner-${fingerprint}`)
  const sent: OutboundIntent[] = []
  let paired = false
  let inboundSent = false
  let closed = false
  let shutdownFlight: Promise<void> | undefined
  let eventNumber = 0
  let removeAdapter: (() => void) | undefined
  let removeChannel: (() => Promise<void>) | undefined

  await privateCanonicalDirectory(workspace, 'benchmark workspace')
  await privateCanonicalDirectory(stateRoot, 'benchmark state root')
  await mkdir(runtimeRoot, { recursive: false, mode: 0o700 })
  await privateCanonicalDirectory(runtimeRoot, 'benchmark runtime root')
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' })
    ctx.systemPrompt.section({ name: 'benchmark-strategy-persona', order: 0, text: persona, complete: true })
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(runtimeRoot, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
    // Delivery first persists an unstarted Session, then disposes and resumes
    // it for the inbound turn. JSONL flush alone leaves an empty log lazy;
    // explicitly materialize its real header without fabricating an event.
    ctx.on('session/flush', session => ctx.sessionPersistence.ensureMaterialized(session))
    await ctx.plugin(AssistantPolicyService, { databasePath: join(runtimeRoot, 'policy.sqlite'), toolDefaultEffect: 'deny', rules: [
      { id: 'benchmark-pair-issue', effect: 'allow', subject: { kind: 'external', id: `local:${bootstrapId}` }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'benchmark-owner-ingest', effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'benchmark-owner-reply', effect: 'allow', subject: { kind: 'agent', id: preset, workspace, principal: principalId }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      ...policyRules,
    ] })
    ctx.on('agent/created', ({ agent }) => {
      // Delivery creates all benchmark foreground agents after the arm has
      // mounted its public tools.  Restrict only global tools; arm-scoped tools
      // still need an explicit Policy allow and are therefore not a bypass.
      agent.ctx.tools.restrict({ allow: allowedToolNames })
    })
    await ctx.plugin(Delivery, {
      databasePath: join(runtimeRoot, 'delivery.sqlite'), spoolPath: join(runtimeRoot, 'spool'), schedulerEnabled: false,
      defaultWorkspace: workspace, defaultAgentPreset: preset, policyRef: 'benchmark-owner', agentProvider: provider, agentModel: model,
      agentMaxOutputTokens: maxOutputTokens, agentMaxAutoContinuationTurns: 0,
      ownerRoutes: [{ id: authorityId, conversation, principal, workspace, agentPreset: preset, policyRef: 'benchmark-owner', minimumGeneration: 1 }],
    })
    delivery = ctx.get('assistantDelivery' as never) as unknown as OwnerDelivery
    if (!delivery || typeof delivery.validateOwnerRoute !== 'function') throw new Error('benchmark Delivery service unavailable')
    await ctx.plugin(AgentLoop, { agents: [] })
  } catch (error) {
    try { await ctx.fiber.dispose() } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'benchmark owner runtime setup and disposal failed')
    }
    throw error
  }

  const adapter: DeliveryAdapter = {
    channel, account,
    capabilities: Object.freeze({ reconcileUnknownSend: false, receipts: [] as const, formats: ['plain'] as const }),
    async start() {},
    async send(intent) {
      // The only channel is a local capture sink.  No network, provider
      // notification, browser, or user profile is reachable from this adapter.
      sent.push(structuredClone(intent))
      return { outcome: 'accepted', providerMessageId: `benchmark-${createHash('sha256').update(intent.idempotencyKey).digest('hex').slice(0, 32)}` }
    },
  }

  const assertOpen = (): void => { if (closed) throw new Error('benchmark owner runtime is shut down') }
  const snapshotOutbound = (): readonly Readonly<OutboundIntent>[] => Object.freeze(sent.map(intent => Object.freeze(structuredClone(intent))))
  const ownerScope = (): Readonly<BenchmarkStrategyOwnerScope> => {
    assertOpen()
    const route = delivery.validateOwnerRoute({ authorityId, principalId, workspace, agentPreset: preset })
    return Object.freeze({ workspace, preset, principalId, owner: Object.freeze({ principalRecordId: route.principalRecordId, principalVersion: route.principalVersion }), route })
  }
  const waitForQuiescence = async (goals?: Readonly<{ whenIdle(): Promise<void> }>): Promise<void> => {
    assertOpen()
    // A second Delivery tick flushes a reply queued by the completed foreground
    // turn.  Goals is caller supplied because this helper never installs it.
    await delivery.tick(); await delivery.whenIdle(); await goals?.whenIdle()
    await delivery.tick(); await delivery.whenIdle(); await goals?.whenIdle()
    const health = delivery.health()
    if (health.pendingInbox !== 0 || health.pendingOutbox !== 0 || health.deadLetterInbox !== 0
      || health.deadLetterOutbox !== 0 || health.unknownOutbox !== 0 || health.pendingPresentations !== 0 || health.deadPresentations !== 0) {
      throw new Error('benchmark Delivery work is pending or unresolved')
    }
  }
  try {
    removeChannel = await delivery.registerAdapter(adapter)
  } catch (error) {
    try { await ctx.fiber.dispose() } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'benchmark owner adapter setup and disposal failed')
    }
    throw error
  }
  return Object.freeze({
    ctx, workspace, stateRoot, runtimeRoot, principal, conversation,
    get outbound() { return snapshotOutbound() },
    async installModel(modelAdapter: LlmAdapter): Promise<void> {
      assertOpen()
      if (removeAdapter !== undefined) throw new Error('benchmark model adapter is already installed')
      if (!(modelAdapter instanceof LlmAdapter)) throw new Error('benchmark model adapter must be an LlmAdapter')
      removeAdapter = ctx.llm.registerAdapter([provider], modelAdapter)
      try { await ctx.llm.resolveModelInfo(provider, model) } catch (error) { removeAdapter(); removeAdapter = undefined; throw error }
    },
    pairOwner(): Readonly<DeliveryOwnerLineage> {
      assertOpen()
      if (paired) throw new Error('benchmark owner is already paired')
      const pairing = delivery.issuePairing(bootstrapId, principal)
      const confirmed = delivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
      if (confirmed.role !== 'owner' || confirmed.status !== 'active' || confirmed.id === '') {
        throw new Error('benchmark owner pairing was not confirmed')
      }
      const owner = Object.freeze({ principalRecordId: confirmed.id, principalVersion: confirmed.version })
      paired = true
      return owner
    },
    async sendPublicInbound(text: string): Promise<Readonly<{ inboxId: string; duplicate: boolean; status: string }>> {
      assertOpen()
      if (!paired || inboundSent) throw new Error('benchmark owner inbound must follow one pairing and precede shutdown')
      if (removeAdapter === undefined) throw new Error('benchmark model adapter is not installed')
      if (typeof text !== 'string' || text.trim() === '' || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new Error('invalid benchmark inbound text')
      inboundSent = true
      const accepted = await delivery.acceptInbound({ channel, account, eventId: `benchmark-inbound-${fingerprint}-${++eventNumber}`,
        occurredAt: Date.now(), principal, conversation, kind: 'text', text })
      return Object.freeze(accepted)
    },
    waitForQuiescence,
    ownerScope,
    shutdown(): Promise<void> {
      if (shutdownFlight !== undefined) return shutdownFlight
      closed = true
      shutdownFlight = (async () => {
        for (const agent of ctx.agents.list()) agent.cancel({ kind: 'hook', reason: 'benchmark-owner-shutdown' })
        const errors: unknown[] = []
        for (const cleanup of [() => delivery.whenIdle(), () => removeChannel?.(), () => removeAdapter?.(), () => ctx.fiber.dispose()]) {
          try { await cleanup() } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'benchmark owner shutdown failed')
      })()
      return shutdownFlight
    },
  })
}
