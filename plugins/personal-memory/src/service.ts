import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import { MemoryProposalManager } from './proposals.js'
import { MemoryStore } from './store.js'
import { registerMemoryTools } from './tools.js'
import type {
  MemoryAgentContext,
  MemoryEntryInput,
  MemoryIdentity,
  MemoryImportBatchResult,
  MemoryMutation,
  MemoryProposalDecisionInput,
  MemoryProposalResult,
  MemoryRecord,
  MemorySearchHit,
  MemorySnapshot,
} from './types.js'

export interface Config {
  databasePath: string
  maxContentBytes?: number
  maxRecordsPerIdentity?: number
  searchLimit?: number
  snapshotLimit?: number
  snapshotMaxBytes?: number
  snapshotMaxTokens?: number
  defaultProposalTtlMs?: number
  maxImportRecords?: number
}

export interface ServiceSearchRequest {
  query: string
  limit?: number
  authorizationIdempotencyKey?: string
}

export interface ServiceProposalInput {
  idempotencyKey: string
  principal: string
  ttlMs?: number
  mutation: MemoryMutation
}

export interface ServiceImportInput {
  json: string
  idempotencyKey: string
  principal: string
  ttlMs?: number
}

export type PersonalMemoryErrorCode =
  | 'disposed'
  | 'identity-mismatch'
  | 'invalid-import'
  | 'missing-identity'
  | 'not-found'
  | 'policy-denied'
  | 'unauthorized-principal'

export class PersonalMemoryError extends Error {
  constructor(readonly code: PersonalMemoryErrorCode, message: string) {
    super(message)
    this.name = 'PersonalMemoryError'
  }
}

const configSchema = Schema.object({
  databasePath: Schema.string().required(),
  maxContentBytes: Schema.number().step(1).min(1).default(4_096),
  maxRecordsPerIdentity: Schema.number().step(1).min(1).default(1_000),
  searchLimit: Schema.number().step(1).min(1).max(100).default(20),
  snapshotLimit: Schema.number().step(1).min(1).max(100).default(20),
  snapshotMaxBytes: Schema.number().step(1).min(1).default(8_192),
  snapshotMaxTokens: Schema.number().step(1).min(1).default(2_048),
  defaultProposalTtlMs: Schema.number().step(1).min(1).default(900_000),
  maxImportRecords: Schema.number().step(1).min(1).max(1_000).default(100),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    personalMemory: PersonalMemoryService
  }
}

function decisionError(decision: PolicyDecision): PersonalMemoryError {
  return new PersonalMemoryError('policy-denied', `personal-memory policy denied operation: ${decision.reasonCode}`)
}

export class PersonalMemoryService extends Service {
  static Config = configSchema

  private readonly memoryStore: MemoryStore
  private readonly proposals: MemoryProposalManager
  private readonly policy: AssistantPolicyService
  private readonly config: Required<Config>
  private readonly sessionSnapshots = new WeakMap<Agent, MemorySnapshot>()
  private active = true

  constructor(ctx: Context, input: Config) {
    super(ctx, 'personalMemory')
    let config: Required<Config>
    try {
      config = PersonalMemoryService.Config(input) as Required<Config>
    } catch (error) {
      throw new Error(`personal-memory: invalid configuration: ${String(error)}`, { cause: error })
    }
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('personal-memory: assistantPolicy service is required')
    this.config = config
    this.policy = policy
    this.memoryStore = new MemoryStore({
      path: config.databasePath,
      maxContentBytes: config.maxContentBytes,
      maxRecordsPerIdentity: config.maxRecordsPerIdentity,
    })
    this.proposals = new MemoryProposalManager(this.memoryStore, policy)

    ctx.effect(() => () => {
      this.active = false
      this.memoryStore.close()
    }, 'personal-memory.database')
    ctx.on('agent/session-start', ({ agent }) => {
      this.injectSessionSnapshot(agent)
    })
    ctx.inject(['tools'], (toolsCtx) => {
      registerMemoryTools(toolsCtx, this)
    })
  }

  search(agent: Agent | undefined, request: ServiceSearchRequest): MemorySearchHit[] {
    this.assertActive()
    const context = this.agentContext(agent)
    const authorizationOptions = request.authorizationIdempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.authorizationIdempotencyKey }
    const decision = this.policy.authorizeAgent(
      agent,
      'search',
      { kind: 'memory', id: 'visible' },
      authorizationOptions,
    )
    if (decision.effect !== 'allow') throw decisionError(decision)
    return this.memoryStore.search({
      context,
      query: request.query,
      limit: request.limit ?? this.config.searchLimit,
    })
  }

  read(agent: Agent | undefined, request: { ids: readonly string[] }): MemoryRecord[] {
    this.assertActive()
    const context = this.agentContext(agent)
    const decision = this.policy.authorizeAgent(agent, 'read', { kind: 'memory', id: 'selected' }, {
      idempotencyKey: `memory-read:${request.ids.join(':')}`,
    })
    if (decision.effect !== 'allow') throw decisionError(decision)
    try {
      return this.memoryStore.read(context, request.ids)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'not-found') {
        throw new PersonalMemoryError('not-found', error.message)
      }
      throw error
    }
  }

  propose(agent: Agent | undefined, input: ServiceProposalInput): MemoryProposalResult {
    this.assertActive()
    const context = this.agentContext(agent)
    this.assertMutationIdentity(context, input.mutation)
    const decision = this.policy.authorizeAgent(agent, 'propose', {
      kind: 'memory', id: input.mutation.op,
    }, { idempotencyKey: `memory-propose:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw decisionError(decision)
    return this.proposals.propose({
      idempotencyKey: input.idempotencyKey,
      requester: `agent:${context.agentPreset}`,
      principal: input.principal,
      ttlMs: input.ttlMs ?? this.config.defaultProposalTtlMs,
      mutation: input.mutation,
    })
  }

  decideProposal(input: MemoryProposalDecisionInput): MemoryProposalResult {
    this.assertActive()
    return this.proposals.decide(input)
  }

  exportJson(agent: Agent | undefined): string {
    this.assertActive()
    const context = this.agentContext(agent)
    const decision = this.policy.authorizeAgent(agent, 'export', { kind: 'memory', id: 'visible' }, {
      idempotencyKey: `memory-export:${String(agent?.id)}`,
    })
    if (decision.effect !== 'allow') throw decisionError(decision)
    return JSON.stringify(this.memoryStore.exportDocument(context), null, 2)
  }

  proposeImport(agent: Agent | undefined, input: ServiceImportInput): MemoryImportBatchResult {
    this.assertActive()
    const context = this.agentContext(agent)
    let decoded: unknown
    try {
      decoded = JSON.parse(input.json)
    } catch (error) {
      throw new PersonalMemoryError('invalid-import', `memory import is not valid JSON: ${String(error)}`)
    }
    const document = decoded as {
      format?: unknown
      version?: unknown
      records?: unknown
    }
    if (typeof document !== 'object' || document === null
      || document.format !== 'dsh-personal-memory'
      || document.version !== 1
      || !Array.isArray(document.records)
      || document.records.length > this.config.maxImportRecords) {
      throw new PersonalMemoryError('invalid-import', 'memory import format, version, or record count is invalid')
    }
    let mutations: MemoryMutation[]
    try {
      mutations = document.records.map((value) => {
        if (typeof value !== 'object' || value === null) throw new Error('record must be an object')
        const record = value as { identity?: unknown; entry?: unknown }
        const mutation = this.memoryStore.normalizeMutation({
          op: 'add',
          identity: record.identity as MemoryIdentity,
          entry: record.entry as MemoryEntryInput,
        })
        this.assertMutationIdentity(context, mutation)
        return mutation
      })
    } catch (error) {
      throw new PersonalMemoryError('invalid-import', `memory import record is invalid: ${String(error)}`)
    }
    const proposals = mutations.map((mutation, index) => this.propose(agent, {
      idempotencyKey: `${input.idempotencyKey}:${index}`,
      principal: input.principal,
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      mutation,
    }))
    return Object.freeze({ proposals: Object.freeze(proposals) })
  }

  getProposal(proposalId: string, principal: string): MemoryProposalResult | undefined {
    this.assertActive()
    const proposal = this.proposals.getProposal(proposalId)
    if (proposal === undefined) return undefined
    const stored = this.memoryStore.getProposal(proposalId)
    if (stored?.principal !== principal) {
      throw new PersonalMemoryError('unauthorized-principal', 'memory proposal is bound to another principal')
    }
    return proposal
  }

  health(): ReturnType<MemoryStore['health']> {
    this.assertActive()
    return this.memoryStore.health()
  }

  private injectSessionSnapshot(agent: Agent): void {
    if (this.sessionSnapshots.has(agent)) return
    let context: MemoryAgentContext
    try {
      context = this.agentContext(agent)
    } catch (error) {
      if (error instanceof PersonalMemoryError && error.code === 'missing-identity') return
      throw error
    }
    const decision = this.policy.authorizeAgent(agent, 'snapshot', { kind: 'memory', id: 'visible' }, {
      idempotencyKey: `memory-snapshot:${agent.id}`,
    })
    if (decision.effect !== 'allow') return
    const snapshot = this.memoryStore.snapshot({
      context,
      limit: this.config.snapshotLimit,
      maxBytes: this.config.snapshotMaxBytes,
      maxTokens: this.config.snapshotMaxTokens,
    })
    this.sessionSnapshots.set(agent, snapshot)
    if (snapshot.text === '') return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: snapshot.text }],
      source: { kind: 'plugin', plugin: 'personal-memory' },
    }))
  }

  private assertMutationIdentity(context: MemoryAgentContext, mutation: MemoryMutation): void {
    const identity = mutation.identity
    if (identity.scope === 'workspace' && identity.workspace !== context.workspace) {
      throw new PersonalMemoryError('identity-mismatch', 'workspace memory must target the current workspace')
    }
    if (identity.owner === 'agent' && identity.agentPreset !== context.agentPreset) {
      throw new PersonalMemoryError('identity-mismatch', 'agent memory must target the current agent preset')
    }
  }

  private agentContext(agent: Agent | undefined): MemoryAgentContext {
    if (agent === undefined) throw new PersonalMemoryError('missing-identity', 'memory operation requires an agent')
    const workspace = agent.session.header.cwd
    const agentPreset = agent.session.header.agentPreset
    if (workspace === undefined || !isAbsolute(workspace) || agentPreset === undefined || agentPreset === '') {
      throw new PersonalMemoryError('missing-identity', 'memory operation requires an absolute workspace and agent preset')
    }
    return { workspace, agentPreset }
  }

  private assertActive(): void {
    if (!this.active) throw new PersonalMemoryError('disposed', 'personal-memory service is disposed')
  }
}
