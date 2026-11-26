import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@dsh-ray/assistant-delivery'
import type {} from '@dsh-ray/assistant-policy'
import type {} from '@dsh-ray/credentials-keychain'
import type { GoalExecutionRun } from '@dsh-ray/assistant-goals'
import type { RepositoryOutcomeAuthority } from '@dsh-ray/assistant-verifier'
import { validateTaskAcceptanceContract, validateTaskVerificationReceipt, type TaskAcceptanceContract } from '@dsh-ray/task-acceptance-contract'
import { createHash, createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Config, commitBytes, normalizeCommit, normalizeCompensation, normalizeVerifiedDelivery, validateConfig } from './config.js'
import { VerifiedDeliveryRuntime, type DeliveryIntent, type DeliveryOutcome, type DeliverySecurity, type VerifiedFiles } from './verified-delivery.js'
import { normalizeRepositoryCommitReadback, normalizeRepositoryReadback, validateRepositoryReadbackRequirements, type RepositoryCommitReadback, type RepositoryReadback, type RepositoryReadbackRequirements } from './repository-readback.js'
import { ActionLedger, normalizeWorkflow, type RecoveredCompensationRef } from './ledger.js'
import { commitOnGitHub, createBranchOnGitHub, createCompensatingCommitOnGitHub, createPullRequestOnGitHub, inspectGitHub, readGitHubPreimage } from './github.js'
import { BrokerClientError, requestActionBroker, requestGitHubBroker, type ActionBrokerClientOptions, type GitHubBrokerClientOptions } from './broker-client.js'
import { brokerDigest, canonicalBrokerJson, type BrokerOperation, type BrokerClientRequest, type BrokerServerHello, type BrokerRequestIntent, type BrokerServerResponse } from './broker-protocol.js'
import {
  ACTION_ID_PROTOCOL,
  resolveWp08DestinationString,
  type ActionBrokerGrantProjection,
  type ActionBrokerRequestIntent,
  type ActionBrokerServerResponse,
  type BrokerActionDomain,
  type CalendarActionPayload,
  type CalendarGrantDestination,
  type CalendarRequestDestination,
  type HttpGrantDestination,
  type HttpRequestDestination,
  type HttpRequestPayload,
  type LarkGrantDestination,
  type LarkReadPayload,
  type LarkRequestDestination,
  type LarkSendPayload,
  type ShellExecPayload,
  type ShellGrantDestination,
  type ShellRequestDestination,
} from './broker-protocol-v2.js'
import { authorizeAgentWithWp08, isBrokerSensitivity, sensitivityRank, type BrokerPolicyServicePort, type BrokerSensitivity, type BrokerWp08Constraints } from './broker-policy.js'
import { verifyWindowsPrivatePath } from './broker-peer-windows.js'
import { createBrokerTransportAdapter, inspectPlatformPeerCredentials } from './broker-transport.js'
import { executeHttpGuardedAction, HttpGuardError, validateHttpAgainstGrant } from './guards/http-guard.js'
import { executeLarkGuardedAction, LarkGuardError, validateLarkAgainstGrant } from './guards/lark-guard.js'
import { executeCalendarGuardedAction, CalendarGuardError, validateCalendarAgainstGrant } from './guards/calendar-guard.js'
import { executeShellGuardedAction, ShellGuardError, validateShellAgainstGrant, validateShellPolicyAgainstGrant } from './guards/shell-guard.js'
import type { ActionAuthority, ActionGrant, ActionIdentity, ActionRecord, ActionResult, BranchRequest, CommitRequest, CompensationRecord, CompensationRequest, CompensationResult, ExternalActionGrantMirror, GeneralizedActionExecutionInput, GeneralizedActionExecutionResult, InspectRequest, PullRequestRequest, VerifiedDeliveryRequest, WorkflowRequest } from './types.js'

import { captureExternalDeliveryReceipt, verifyExternalDeliveryReceipt, type ExternalDeliveryReceipt } from './external-delivery-receipt.js'
import { normalizeRepositoryEventObservationInput, repositoryEventBranchHead, repositoryEventCommitSemanticFingerprint, repositoryEventPendingFingerprint, repositoryEventSemanticFingerprint, type NormalizedRepositoryEventObservationInput, type RepositoryEventObservationInput } from './repository-event-observation.js'

export { Config }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const principalDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
interface Authorization { identity(): ActionIdentity; authorize(record: ActionRecord): boolean; sessionId: string }
type Operation = (actionId: string, grant: ActionGrant, token: string, signal: AbortSignal) => Promise<ActionResult>
type ExternalDispatch = (options: GitHubBrokerClientOptions, intent: BrokerRequestIntent, signal?: AbortSignal) => Promise<BrokerServerResponse>
type ExternalActionDispatch = (options: ActionBrokerClientOptions, intent: ActionBrokerRequestIntent, signal?: AbortSignal) => Promise<ActionBrokerServerResponse>
interface ExternalInvocation { callId: string; rootCallId: string }
interface ExternalBackgroundAuthorization { sessionId: string; agentId: string; current(): void; authorize(actionId: string): boolean }
type DeliveryGrant = Omit<ActionGrant, 'credentialHandle'>
interface VisibleGrant {
  grantId: string; repository: string; branch: string; paths: readonly string[]; expiresAt: number; maxActions: number; verifiedDelivery: boolean
  acceptance?: 'goal-outcome' | 'goal-step'; workflow?: ActionGrant['repoWorkflow']; baseBranch?: string
  allowedOperations?: readonly BrokerOperation[]; allowedInspectKinds?: ExternalActionGrantMirror['allowedInspectKinds']
}
type CompensationStatus = Readonly<{ actionId: string; status: CompensationRecord['status']; repository: string; branch: string; parentOid: string; resultOid?: string; reason?: string }>
interface RepositoryReadbackContext {
  authority: { kind: RepositoryOutcomeAuthority['kind']; grantId: string; grantRevision: number; repository: string; branch: string; baseBranch: string; timeoutMs: number; freshnessMs: number }
  evidenceDigest: string; requirements: RepositoryReadbackRequirements; security: DeliverySecurity; intent: DeliveryIntent; commitOid: string; pullRequestNumber?: number
}
const workflowTransport = { branch: createBranchOnGitHub, pullRequest: createPullRequestOnGitHub, inspect: inspectGitHub }
const compensationTransport = { capture: readGitHubPreimage, commit: createCompensatingCommitOnGitHub }
const ROLLBACK_BUDGET_METRIC = 'github-compensations'
const EXTERNAL_UNSUPPORTED = 'assistant-actions: external-operation-unsupported'

interface KeyDirectoryIdentity { path: string; dev: bigint; ino: bigint; uid: bigint; gid: bigint; mode: number }
export interface PinnedKeyReadHooks { afterAncestorSnapshot?: () => void; afterFileSnapshot?: () => void; afterOpen?: () => void; afterRead?: () => void }
function sameDirectory(left: KeyDirectoryIdentity, right: KeyDirectoryIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode
}
function inspectKeyDirectory(path: string): KeyDirectoryIdentity {
  const before = lstatSync(path, { bigint: true }), canonical = realpathSync(path), after = lstatSync(path, { bigint: true })
  const first = { path, dev: before.dev, ino: before.ino, uid: before.uid, gid: before.gid, mode: Number(before.mode & 0o7777n) }
  const second = { path, dev: after.dev, ino: after.ino, uid: after.uid, gid: after.gid, mode: Number(after.mode & 0o7777n) }
  if (canonical !== path || before.isSymbolicLink() || after.isSymbolicLink() || !before.isDirectory() || !after.isDirectory() || !sameDirectory(first, second)) throw new Error('assistant-actions: unsafe key path ancestry')
  return first
}
function inspectKeyAncestorChain(path: string, expectedUid: number, expectedGid: number): readonly KeyDirectoryIdentity[] {
  let cursor = path, leaf = true
  const result: KeyDirectoryIdentity[] = []
  for (;;) {
    const identity = inspectKeyDirectory(cursor)
    const stickyRoot = identity.uid === 0n && (identity.mode & 0o1000) !== 0 && (identity.mode & 0o022) !== 0
    if (!stickyRoot && (identity.mode & 0o022) !== 0
      || leaf && (identity.uid !== BigInt(expectedUid) || identity.gid !== BigInt(expectedGid) || (identity.mode & 0o077) !== 0)) throw new Error('assistant-actions: unsafe key path ancestry')
    result.push(identity)
    const parent = dirname(cursor)
    if (parent === cursor) return Object.freeze(result)
    cursor = parent; leaf = false
  }
}
function sameAncestorChain(left: readonly KeyDirectoryIdentity[], right: readonly KeyDirectoryIdentity[]): boolean {
  return left.length === right.length && left.every((value, index) => sameDirectory(value, right[index]!))
}

export function readPinnedKeyFile(path: string, kind: 'private' | 'public', hooks: PinnedKeyReadHooks = {}): KeyObject {
  if (process.platform === 'win32') {
    verifyWindowsPrivatePath(path, { platform: 'win32' })
    hooks.afterAncestorSnapshot?.()
    hooks.afterFileSnapshot?.()
    let bytes: Buffer | undefined
    try {
      hooks.afterOpen?.()
      bytes = readFileSync(path)
      hooks.afterRead?.()
      const key = kind === 'private' ? createPrivateKey(bytes) : createPublicKey(bytes)
      if (key.type !== kind || key.asymmetricKeyType !== 'ed25519') throw new Error(`assistant-actions: ${kind} key must be Ed25519`)
      return key
    } finally { if (bytes !== undefined) bytes.fill(0) }
  }
  const expectedUid = process.geteuid?.(), expectedGid = process.getegid?.()
  if (expectedUid === undefined || expectedGid === undefined) throw new Error(`assistant-actions: unsafe ${kind} key platform`)
  const parentPath = dirname(path), ancestors = inspectKeyAncestorChain(parentPath, expectedUid, expectedGid)
  hooks.afterAncestorSnapshot?.()
  if (!sameAncestorChain(ancestors, inspectKeyAncestorChain(parentPath, expectedUid, expectedGid))) throw new Error(`assistant-actions: ${kind} key ancestor changed before open`)
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(expectedUid)
    || before.gid !== BigInt(expectedGid) || Number(before.mode & 0o7777n) !== 0o600
    || before.size < 1n || before.size > 16_384n) throw new Error(`assistant-actions: unsafe ${kind} key file`)
  let descriptor: number | undefined
  let bytes: Buffer | undefined
  try {
    hooks.afterFileSnapshot?.()
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid || opened.gid !== before.gid
      || opened.mode !== before.mode || opened.nlink !== before.nlink || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs
      || !sameAncestorChain(ancestors, inspectKeyAncestorChain(parentPath, expectedUid, expectedGid))) throw new Error(`assistant-actions: ${kind} key or ancestor changed while opening`)
    hooks.afterOpen?.()
    bytes = readFileSync(descriptor)
    hooks.afterRead?.()
    const after = fstatSync(descriptor, { bigint: true }), pathAfter = lstatSync(path, { bigint: true })
    const ancestorsAfter = inspectKeyAncestorChain(parentPath, expectedUid, expectedGid)
    if (!sameAncestorChain(ancestors, ancestorsAfter)) throw new Error(`assistant-actions: ${kind} key parent changed while reading`)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.uid !== opened.uid || after.gid !== opened.gid
      || after.mode !== opened.mode || after.nlink !== opened.nlink || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.uid !== opened.uid || pathAfter.gid !== opened.gid
      || pathAfter.mode !== opened.mode || pathAfter.nlink !== opened.nlink || pathAfter.size !== opened.size || pathAfter.mtimeNs !== opened.mtimeNs || pathAfter.ctimeNs !== opened.ctimeNs
      || pathAfter.isSymbolicLink() || !pathAfter.isFile()) throw new Error(`assistant-actions: ${kind} key changed while reading`)
    const key = kind === 'private' ? createPrivateKey(bytes) : createPublicKey(bytes)
    if (key.type !== kind || key.asymmetricKeyType !== 'ed25519') throw new Error(`assistant-actions: ${kind} key must be Ed25519`)
    return key
  } finally { if (bytes !== undefined) bytes.fill(0); if (descriptor !== undefined) closeSync(descriptor) }
}

declare module '@deepseek-ai/cordis' { interface Context { assistantActions: AssistantActionsService } }

const GENERALIZED_TOOL_DOMAINS: Readonly<Record<string, BrokerActionDomain>> = {
  action_http_request: 'http',
  action_lark_action: 'lark',
  action_calendar_action: 'calendar',
  action_shell_exec: 'shell',
}
const GENERALIZED_TOOL_NAMES = new Set<string>(['action_broker_grants', ...Object.keys(GENERALIZED_TOOL_DOMAINS)])

function ensurePrivateStateRoot(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const root = lstatSync(stateRoot)
  if (process.platform === 'win32') {
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(stateRoot) !== stateRoot) {
      throw new Error('assistant-actions: private owned state root required')
    }
    return
  }
  if (!root.isDirectory() || root.uid !== process.getuid?.() || realpathSync(stateRoot) !== stateRoot) {
    throw new Error('assistant-actions: private owned state root required')
  }
  chmodSync(stateRoot, 0o700)
}

/** Trusted Host control plane, never mounted or callable from the offline worker. */
export class AssistantActionsService extends Service {
  static Config = Config
  readonly #ledger!: ActionLedger
  readonly #authority!: ActionAuthority
  readonly #externalGrants = new Map<string, ExternalActionGrantMirror>()
  readonly #actionGrants = new Map<string, ActionBrokerGrantProjection>()
  readonly #wp08Usage = new Map<string, { leaseUses: number; spentCostMicros: number; lastSettledCommitDigest?: string }>()
  readonly #settledActions = new Map<string, { requestDigest: string; result: GeneralizedActionExecutionResult }>()
  readonly #pendingActions = new Map<string, { requestDigest: string; done: Promise<GeneralizedActionExecutionResult> }>()
  readonly #mode: Config['broker'] extends infer B ? B extends { mode: infer M } ? M : never : never
  #externalClient: GitHubBrokerClientOptions | undefined
  #externalActionClient: ActionBrokerClientOptions | undefined
  readonly #externalFacadeGeneration = randomUUID()
  #externalObservedGeneration: number | undefined
  #externalObservedEpochs: string | undefined
  readonly #externalDispatch: ExternalDispatch
  readonly #externalActionDispatch: ExternalActionDispatch
  readonly #pending = new Map<string, { abort: AbortController; done: Promise<ActionResult> }>()
  readonly #pendingCompensations = new Map<string, { abort: AbortController; done: Promise<CompensationResult> }>()
  readonly #pendingExternal = new Set<{ abort: AbortController; done: Promise<BrokerServerResponse>; client: GitHubBrokerClientOptions }>()
  #pendingCompensationReleases: RecoveredCompensationRef[] = []
  #active = true
  #verified: VerifiedDeliveryRuntime | undefined

  constructor(
    ctx: Context,
    input: Config = {},
    private readonly commit = commitOnGitHub,
    private readonly workflow = workflowTransport,
    private readonly compensation = compensationTransport,
    externalDispatch: ExternalDispatch = requestGitHubBroker,
    externalActionDispatch: ExternalActionDispatch = requestActionBroker,
  ) {
    super(ctx, 'assistantActions')
    const config = validateConfig(input)
    this.#mode = config.broker.mode
    this.#externalDispatch = externalDispatch
    this.#externalActionDispatch = externalActionDispatch
    for (const grant of config.actionGrants) this.#actionGrants.set(grant.id, grant)
    for (const grant of config.externalActionGrants) this.#actionGrants.set(grant.id, grant)
    if (config.broker.mode !== 'embedded-compat') {
      for (const grant of config.externalGrants) this.#externalGrants.set(grant.id, grant)
      const serverPublicKey = readPinnedKeyFile(config.broker.brokerPublicKeyPath, 'public')
      const clientPrivateKey = readPinnedKeyFile(config.broker.clientSigningKeyPath, 'private')
      const broker = config.broker
      const sourceEndpoint = Object.freeze({ kind: 'assistant-actions-host' as const, instanceId: broker.clientInstanceId, generation: broker.clientGeneration })
      const resolvedPlatform = broker.mode === 'external-macos-v1'
        ? 'darwin'
        : broker.mode === 'external-windows-v1'
          ? 'win32'
          : broker.mode === 'external-v2'
            ? broker.platform
            : 'linux'
      const resolvedTransport = broker.mode === 'external-windows-v1'
        ? 'windows-pipe'
        : broker.mode === 'external-v2'
          ? broker.transport
          : 'posix-uds'
      const peerInspector = inspectPlatformPeerCredentials(resolvedPlatform, 'server')
      const transportAdapter = createBrokerTransportAdapter({
        platform: resolvedPlatform,
        transport: resolvedTransport,
        role: 'server',
        inspectPeer: peerInspector,
      })
      const baseConn = {
        socketPath: broker.actionSocketPath,
        serverPublicKey,
        clientPrivateKey,
        clientKeyId: broker.clientKeyId,
        source: sourceEndpoint,
        timeoutMs: broker.requestTimeoutMs,
        maxHelloTtlMs: broker.helloTtlMs,
        expectedServerInstanceId: broker.brokerId,
        expectedBrokerPeerUid: broker.expectedBrokerPeerUid ?? 0,
        expectedBrokerPeerGid: broker.expectedBrokerPeerGid ?? 0,
        minimumServerGeneration: broker.minimumBrokerGeneration,
        inspectPeerCredentials: peerInspector,
        platform: resolvedPlatform,
        transport: transportAdapter,
        ...('expectedSocketUid' in broker ? {
          expectedSocketUid: broker.expectedSocketUid,
          expectedSocketGid: broker.expectedSocketGid,
          expectedSocketMode: broker.expectedSocketMode,
          expectedSocketParentUid: broker.expectedSocketParentUid,
          expectedSocketParentGid: broker.expectedSocketParentGid,
          expectedSocketParentMode: broker.expectedSocketParentMode,
        } : {}),
        ...(broker.mode === 'external-windows-v1' ? { expectedBrokerPeerSid: broker.expectedUserSid } : {}),
        ...(broker.mode === 'external-v2' && broker.expectedBrokerPeerSid !== undefined ? { expectedBrokerPeerSid: broker.expectedBrokerPeerSid } : {}),
      }
      this.#externalClient = Object.freeze(baseConn)
      this.#externalActionClient = Object.freeze(baseConn)
    } else {
      ensurePrivateStateRoot(config.stateRoot)
      const ledger = new ActionLedger(join(config.stateRoot, 'ledger.sqlite'))
      this.#ledger = ledger
      try {
        this.#authority = ledger.claimController(randomUUID(), 30_000)
        ledger.syncGrants(config.grants, this.#authority)
        ledger.recover(this.#authority)
        this.#pendingCompensationReleases = ledger.recoverCompensations(this.#authority).neverDispatched
      } catch (error) { ledger.close(); throw error }
    }
    const timer = setInterval(() => {
      if (!this.#ledger || !this.#authority) return
      try { if (this.#active && this.#ledger.renewController(this.#authority, 30_000)) return } catch { /* Stop when the fence is lost. */ }
      this.#active = false
      for (const operation of this.#pending.values()) operation.abort.abort()
      for (const operation of this.#pendingCompensations.values()) operation.abort.abort()
    }, 5000)
    timer.unref()
    ctx.effect(() => async () => {
      this.#active = false; clearInterval(timer)
      await this.#verified?.close()
      for (const operation of this.#pending.values()) operation.abort.abort()
      for (const operation of this.#pendingCompensations.values()) operation.abort.abort()
      for (const operation of this.#pendingExternal) operation.abort.abort(new Error('assistant-actions disposed'))
      await Promise.allSettled([...this.#pending.values()].map(operation => operation.done))
      await Promise.allSettled([...this.#pendingCompensations.values()].map(operation => operation.done))
      await Promise.allSettled([...this.#pendingExternal].map(operation => operation.done))
      this.#externalClient = undefined
      this.#externalActionClient = undefined
      if (this.#ledger && this.#authority) try { this.#ledger.releaseController(this.#authority) } finally { this.#ledger.close() }
    }, 'assistant-actions.controller')
    // Configured scopes keep their restricted execution route even after grants
    // expire or are revoked. Only trusted fixed brokers can use Host authority.
    ctx.inject(['tools'], runtime => runtime.on('tools/execute', async (execution, next) => {
      const header = execution.agent?.session.header
      const scopedGithub = config.broker.mode === 'embedded-compat'
        ? config.grants.some(grant => grant.workspace === header?.cwd && grant.agentPreset === header?.agentPreset)
        : config.externalGrants.some(grant => grant.owner.workspace === header?.cwd && grant.owner.preset === header?.agentPreset)
      const scopedAction = [...this.#actionGrants.values()].some(grant => grant.owner.workspace === header?.cwd && grant.owner.preset === header?.agentPreset)
      const scoped = scopedGithub || scopedAction
      if (header && scoped
        && !['isolation_run', 'isolation_grants', 'goal_context', 'goal_checkpoint'].includes(execution.name)
        && !this.#allowsGeneralizedToolExecution(execution)
        && !(['action_github_grants', 'action_github_deliver', 'action_github_delivery_status', 'action_github_commit', 'action_github_branch', 'action_github_pr', 'action_github_inspect', 'action_github_compensate', 'action_github_compensation_status', 'goal_create', 'goal_schedule', 'goal_strategy', 'goal_wait_event'].includes(execution.name) && this.ctx.get('assistantPolicy')?.isPreauthorizedTool(execution))) throw new Error('assistant-actions: this scope requires isolated execution or an authorized broker')
      return await next()
    }))
    // Reconcile rollback reservations orphaned by a crash. Only rows that never
    // reached the local dispatch flip are reported (capturing/prepared), so no
    // POST could have landed and their open holds are safe to release. A
    // finalized hold is never unwound (release throws invalid-state); such a
    // mismatch fails closed and is left for the budget period to roll over.
    if (config.broker.mode === 'embedded-compat') ctx.inject(['assistantPolicy'], runtime => {
      for (const ref of this.#pendingCompensationReleases) {
        try { runtime.assistantPolicy.releaseByIdempotencyKey(`compensation:${ref.id}`) } catch { /* retain the hold; fail closed */ }
      }
      this.#pendingCompensationReleases = []
    })
    const hasGithubGrants = config.broker.mode === 'embedded-compat' ? config.grants.length > 0 : config.externalGrants.length > 0
    const hasActionGrants = this.#actionGrants.size > 0
    const toolDependencies = config.broker.mode === 'embedded-compat'
      ? ['tools', 'agents', 'assistantPolicy', 'assistantDelivery', 'credentialsKeychain']
      : ['tools', 'agents', 'assistantPolicy', 'assistantDelivery']
    ctx.inject(toolDependencies, runtime => {
      if (hasActionGrants) {
        this.#registerGeneralizedTools(runtime)
      }
      if (!hasGithubGrants) return
      const grants = () => config.broker.mode === 'embedded-compat'
        ? config.grants.flatMap(grant => { const current = this.#ledger.grant(grant.id); return current !== undefined && current.expiresAt > Date.now() ? [current] : [] })
        : config.externalGrants.filter(grant => grant.expiresAt > Date.now())
      const visibleGrants = (agent: Agent | undefined): VisibleGrant[] => {
        const current: readonly (ActionGrant | ExternalActionGrantMirror)[] = grants()
        return current.flatMap<VisibleGrant>(grant => {
        try {
          if (config.broker.mode !== 'embedded-compat') {
            const external = grant as ExternalActionGrantMirror
            this.#externalContext(agent, external.id)
            return [{ grantId: external.id, repository: external.destination.repository, branch: external.destination.branch, paths: external.destination.paths, expiresAt: external.expiresAt, maxActions: external.maxActions, verifiedDelivery: !!external.verifiedDelivery,
              ...(external.verifiedDelivery ? { acceptance: external.verifiedDelivery.acceptance ?? 'goal-outcome' } : {}),
              ...(external.destination.baseBranch ? { workflow: { baseBranch: external.destination.baseBranch, allowBranchCreate: false, allowPullRequest: external.allowedOperations.includes('pull-request') } } : {}),
              allowedOperations: external.allowedOperations, allowedInspectKinds: external.allowedInspectKinds,
              ...(external.destination.baseBranch === undefined ? {} : { baseBranch: external.destination.baseBranch }) }]
          }
          const embedded = grant as ActionGrant
          const identity = this.#identity(agent, embedded.id)
          if (!this.#allows(embedded, identity, { grantId: embedded.id, operation: 'inspect', idempotencyKey: 'discovery', kind: 'repository' })) return []
          return [{ grantId: embedded.id, repository: embedded.repository, branch: embedded.branch, paths: embedded.paths, expiresAt: embedded.expiresAt, maxActions: embedded.maxActions, verifiedDelivery: !!embedded.verifiedDelivery,
            ...(embedded.verifiedDelivery ? { acceptance: embedded.verifiedDelivery.acceptance ?? 'goal-outcome' } : {}), ...(embedded.repoWorkflow ? { workflow: embedded.repoWorkflow } : {}) }]
        } catch { return [] }
        })
      }
      const discovery = defineTool({ name: 'action_github_grants', description: 'Read currently owner-authorized GitHub repository grants, exact paths and delivery mode. No credentials or new authority are returned. verifiedDelivery grants require action_github_deliver during an admitted artifact Goal round.', parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] },
        execute: async (_args, execution) => ({ result: JSON.stringify(visibleGrants(execution.agent)) }),
      })
      runtime.tools.register(discovery)
      runtime.assistantPolicy.registerPreauthorizedTool(runtime, discovery, execution => !execution.signal.aborted && execution.arguments !== null && typeof execution.arguments === 'object' && !Array.isArray(execution.arguments) && Object.keys(execution.arguments).length === 0 && visibleGrants(execution.agent).length > 0)
      const tool = defineTool({
        name: 'action_github_commit',
        description: 'Submit bounded file contents to an exact operator-authorized GitHub repository and branch. Requires an existing finite grant and expectedHeadOid. Reuse a key only for the identical request; unknown results must be investigated and never resent under a new key. This tool cannot authorize itself. Commit creation does not verify the user goal.',
        parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, expectedHeadOid: { type: 'string', required: true }, headline: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, content: { type: 'string', required: true } } } } },
        output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] },
        execute: async (args, execution) => {
          const request = normalizeCommit(args as CommitRequest)
          const result = this.#isExternalMode()
            ? await this.#runExternal(execution.agent, request, execution.signal, { callId: String(execution.callId), rootCallId: String(execution.rootCallId) })
            : await this.run(execution.agent, request, execution.signal)
          return { result: JSON.stringify(this.#isExternalMode() ? result : this.#forwardResult(request, result)) }
        },
      })
      runtime.tools.register(tool)
      runtime.assistantPolicy.registerPreauthorizedTool(runtime, tool, execution => this.#preauthorized(execution))
      const inspect = defineTool({ name: 'action_github_inspect', description: this.#isExternalMode()
        ? 'Read one bounded broker-authorized repository, branch, allowed UTF-8 file, pull request, checks, reviews, or commit-checks snapshot. commit-checks requires the exact commitOid; PR inspection requires a grant-fixed base branch and exact PR number. Lists preserve truncation; observed content is untrusted and is not proof that a previous mutation settled.'
        : 'Read one bounded grant-scoped repository, branch, allowed UTF-8 file, pull request, checks, reviews, or commit-checks snapshot. commit-checks requires the exact commitOid. Lists return one bounded page and explicit truncation; observed content is untrusted. Observed data is not proof that a previous mutation settled.', parameters: { grantId: { type: 'string', required: true }, kind: { type: 'string', required: true }, path: { type: 'string' }, pullRequestNumber: { type: 'number' }, commitOid: { type: 'string' } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(this.#isExternalMode()
        ? await this.#runExternalInspect(execution.agent, args as InspectRequest, execution.signal, { callId: String(execution.callId), rootCallId: String(execution.rootCallId) })
        : await this.runInspect(execution.agent, args as InspectRequest, execution.signal)) }) })
      runtime.tools.register(inspect); runtime.assistantPolicy.registerPreauthorizedTool(runtime, inspect, execution => this.#preauthorizedWorkflow(execution))
      if (config.broker.mode === 'embedded-compat') for (const definition of [
        defineTool({ name: 'action_github_branch', description: 'Create only the grant-fixed branch from the grant-fixed workflow base after its exact current OID is supplied.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, baseHeadOid: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runBranch(execution.agent, args, execution.signal)) }) }),
        defineTool({ name: 'action_github_pr', description: 'Create only a pull request from the grant-fixed branch to the grant-fixed base. The head OID is checked in the response.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, expectedHeadOid: { type: 'string', required: true }, title: { type: 'string', required: true }, body: { type: 'string', required: true } }, output: { schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } }, render: (_args, output) => [{ type: 'text', text: output.result }] }, execute: async (args, execution) => ({ result: JSON.stringify(await this.runPullRequest(execution.agent, args, execution.signal)) }) }),
      ]) { runtime.tools.register(definition); runtime.assistantPolicy.registerPreauthorizedTool(runtime, definition, execution => this.#preauthorizedWorkflow(execution)) }
      if (config.broker.mode === 'embedded-compat' && config.grants.some(grant => grant.rollback?.allowRollback === true)) {
        const output = { schema: { type: 'object' as const, additionalProperties: false as const, properties: { result: { type: 'string' as const, required: true as const } } }, render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }] }
        const compensate = defineTool({ name: 'action_github_compensate', description: 'Create at most one bounded compensating commit for an exact succeeded forward receipt. The Host reads the immutable parent preimage; callers cannot provide files or preimages. Reuse only the identical key and receipt. Unknown is terminal and must never be replayed.',
          parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, forwardActionId: { type: 'string', required: true }, forwardActionVersion: { type: 'number', required: true }, forwardRequestDigest: { type: 'string', required: true }, forwardCommitOid: { type: 'string', required: true } }, output,
          execute: async (args, execution) => ({ result: JSON.stringify(await this.runCompensation(execution.agent, args as CompensationRequest, execution.signal)) }),
        })
        runtime.tools.register(compensate)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, compensate, execution => this.#preauthorizedCompensation(execution))
        const status = defineTool({ name: 'action_github_compensation_status', description: 'Read one compensation status in this exact Session and grant. This never returns captured file preimages.',
          parameters: { grantId: { type: 'string', required: true }, actionId: { type: 'string', required: true } }, output,
          execute: async (args, execution) => ({ result: JSON.stringify(this.compensationStatus(execution.agent, args as { grantId: string; actionId: string })) }),
        })
        runtime.tools.register(status)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, status, execution => this.#preauthorizedCompensationStatus(execution))
      }
      if ((config.broker.mode === 'embedded-compat' ? config.grants : config.externalGrants).some(grant => grant.verifiedDelivery)) {
        const output = { schema: { type: 'object' as const, additionalProperties: false as const, properties: { result: { type: 'string' as const, required: true as const } } }, render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }] }
        const deliver = defineTool({ name: 'action_github_deliver', description: 'During the current native artifact goal round, register a finite GitHub delivery intent. Export all listed paths with isolation_run. Host submits exact independently accepted artifacts after the grant acceptance mode: goal-outcome requires step and whole-goal verification (default); goal-step allows intermediate delivery after step verification while the original goal waits. This call only queues intent and never proves whole-goal completion. Never supply file content. Optional pullRequest opens the grant-fixed branch-to-base PR after the commit. Query action_github_delivery_status for the actual result; unknown must not be resent.',
          parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true }, expectedHeadOid: { type: 'string', required: true }, headline: { type: 'string', required: true }, paths: { type: 'array', required: true, items: { type: 'string' } }, pullRequest: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', required: true }, body: { type: 'string', required: true } } } }, output,
          execute: async (args, execution) => ({ result: JSON.stringify(this.prepareVerifiedDelivery(execution.agent, args)) }),
        })
        runtime.tools.register(deliver)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, deliver, execution => { try { if (execution.signal.aborted) return false; this.#captureDelivery(execution.agent, normalizeVerifiedDelivery(execution.arguments as VerifiedDeliveryRequest)); return true } catch { return false } })
        const status = defineTool({ name: 'action_github_delivery_status', description: 'Read this Session’s durable verified delivery result. Queued is not committed; unknown must not be resent.', parameters: { grantId: { type: 'string', required: true }, idempotencyKey: { type: 'string', required: true } }, output,
          execute: async (args, execution) => { const identity = this.#identity(execution.agent, args.grantId); return { result: JSON.stringify(this.#verified!.get(String(execution.agent!.session.id), args.grantId, args.idempotencyKey, identity) ?? { status: 'not-found' }) } },
        })
        runtime.tools.register(status)
        runtime.assistantPolicy.registerPreauthorizedTool(runtime, status, execution => { try { const args = execution.arguments as { grantId: string }; return !execution.signal.aborted && !!this.#identity(execution.agent, args.grantId) } catch { return false } })
      }
    })
    if ((config.broker.mode === 'embedded-compat' ? config.grants : config.externalGrants).some(grant => grant.verifiedDelivery)) {
      ensurePrivateStateRoot(config.stateRoot)
      this.#verified = new VerifiedDeliveryRuntime(ctx, config.stateRoot, {
      capture: (agent, request) => this.#captureDelivery(agent, request), inspect: intent => this.#inspectDelivery(intent),
      deliver: (intent, snapshot, signal) => this.#deliverVerified(intent, snapshot, signal),
      notify: (intent, value) => this.#notifyVerifiedDelivery(intent, value),
      })
    }
  }

  #isExternalMode(): boolean { return this.#mode !== 'embedded-compat' }

  get brokerMode(): Config['broker'] extends infer B ? B extends { mode: infer M } ? M : never : never { return this.#mode }
  health = (): Readonly<{
    active: boolean
    mode: Config['broker'] extends infer B ? B extends { mode: infer M } ? M : never : never
    projectedGrants: number
    actionGrants: number
    supportedDomains: readonly BrokerActionDomain[]
    supportedOperations: readonly BrokerOperation[] | readonly ('commit' | 'branch' | 'pull-request' | 'inspect' | 'compensate' | 'verified-delivery' | 'repository-readback')[]
  }> => Object.freeze({
    active: this.#active,
    mode: this.brokerMode,
    projectedGrants: this.#isExternalMode() ? this.#externalGrants.size : 0,
    actionGrants: this.#actionGrants.size,
    supportedDomains: Object.freeze(['github', 'http', 'lark', 'calendar', 'shell'] as const),
    supportedOperations: Object.freeze(this.#isExternalMode() ? ['commit', 'pull-request', 'inspect', 'verified-delivery', 'repository-readback'] as const : ['commit', 'branch', 'pull-request', 'inspect', 'compensate', 'verified-delivery', 'repository-readback'] as const),
  })

  /**
   * Host-only repository observation for EventTriggers.  The caller receives
   * no remote content: only a deterministic semantic fingerprint after every
   * authority, lifecycle, receipt, and signed-response boundary has held.
   */
  readRepositoryEventObservation = async (raw: RepositoryEventObservationInput, signal: AbortSignal): Promise<{ protocol: 'assistant-actions/repository-event/v1'; fingerprint: string; truthy: true }> => {
    const input = normalizeRepositoryEventObservationInput(raw)
    signal.throwIfAborted()
    const context = () => this.#repositoryEventContext(input)
    const initial = context()
    const snapshot = initial.snapshot
    const stable = () => {
      const current = context()
      if (current.snapshot !== snapshot) throw new Error('assistant-actions: repository event authority changed')
      return current
    }
    const invocation = { rootCallId: `repository-event:${randomUUID()}`, callId: `repository-event:${randomUUID()}` }
    const inspect = async (kind: InspectRequest['kind'], pullRequestNumber?: number, commitOid?: string): Promise<{ observed: unknown; generation: number; epochs: string }> => {
      const current = stable()
      const response = await this.#externalRequest(undefined, current.grant, current.grant.owner, 'inspect', {
        kind, ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }), ...(commitOid === undefined ? {} : { commitOid }),
      }, signal, { rootCallId: invocation.rootCallId, callId: `${invocation.callId}:${kind}` }, `${invocation.callId}:${kind}:${randomUUID()}`, current.authorization)
      if (response.result.status !== 'succeeded' || response.observed === undefined || response.generation === undefined || response.epochs === undefined) throw new Error('assistant-actions: repository event inspection unavailable')
      stable()
      return { observed: response.observed, generation: response.generation, epochs: response.epochs }
    }
    // This is deliberately first even before any source is goal-bound: an
    // external source must establish a real branch baseline, never a synthetic
    // "no goal" marker.
    const branch = await inspect('branch')
    const headOid = repositoryEventBranchHead(branch.observed, input.branch)
    if (!headOid) throw new Error('assistant-actions: repository event branch observation malformed')
    if (!input.goal) return Object.freeze({ protocol: 'assistant-actions/repository-event/v1' as const, fingerprint: repositoryEventPendingFingerprint(input, headOid), truthy: true as const })
    const settled = initial.delivery
    if (!settled) return Object.freeze({ protocol: 'assistant-actions/repository-event/v1' as const, fingerprint: repositoryEventPendingFingerprint(input, headOid), truthy: true as const })
    const { outcome, intent } = settled
    // Reverify the signed historical receipts and accepted artifacts before
    // using the delivery-selected PR number.  Caller-supplied PR numbers never
    // cross this boundary.
    this.#verifyExternalDelivery(intent, outcome)
    if (input.deliveryMode === 'commit') {
      const commitOid = outcome.commit.commitOid
      if (intent.request.pullRequest || !commitOid || headOid !== commitOid) return Object.freeze({ protocol: 'assistant-actions/repository-event/v1' as const, fingerprint: repositoryEventPendingFingerprint(input, headOid), truthy: true as const })
      const checks = await inspect('commit-checks', undefined, commitOid)
      if (checks.generation !== branch.generation || checks.epochs !== branch.epochs) throw new Error('assistant-actions: repository event broker generation changed')
      stable()
      return Object.freeze({ protocol: 'assistant-actions/repository-event/v1' as const, fingerprint: repositoryEventCommitSemanticFingerprint(input, headOid, checks.observed), truthy: true as const })
    }
    const pullRequestNumber = outcome.pullRequest?.pullRequestNumber
    const commitOid = outcome.commit.commitOid
    if (!Number.isSafeInteger(pullRequestNumber) || !commitOid || headOid !== commitOid) return Object.freeze({ protocol: 'assistant-actions/repository-event/v1' as const, fingerprint: repositoryEventPendingFingerprint(input, headOid), truthy: true as const })
    const verifiedPullRequestNumber = pullRequestNumber as number
    const pullRequest = await inspect('pull-request', verifiedPullRequestNumber)
    const checks = await inspect('checks', verifiedPullRequestNumber)
    const reviews = await inspect('reviews', verifiedPullRequestNumber)
    if ([pullRequest, checks, reviews].some(value => value.generation !== branch.generation || value.epochs !== branch.epochs)) throw new Error('assistant-actions: repository event broker generation changed')
    stable()
    return Object.freeze({ protocol: 'assistant-actions/repository-event/v1' as const,
      fingerprint: repositoryEventSemanticFingerprint(input, headOid, verifiedPullRequestNumber, pullRequest.observed, checks.observed, reviews.observed), truthy: true as const })
  }

  #repositoryEventContext(input: NormalizedRepositoryEventObservationInput): { grant: ExternalActionGrantMirror; authorization: ExternalBackgroundAuthorization; snapshot: string; delivery?: { intent: DeliveryIntent; outcome: DeliveryOutcome } } {
    if (!this.#isExternalMode() || !this.#active) throw new Error('assistant-actions: repository event broker unavailable')
    const grant = this.#externalGrants.get(input.grantId)
    if (!grant || grant.revision !== input.grantRevision || grant.grantDigest !== input.grantDigest || grant.expiresAt <= Date.now()
      || grant.destination.repository !== input.repository || grant.destination.branch !== input.branch || grant.destination.baseBranch !== input.baseBranch
      || !grant.allowedOperations.includes('inspect') || (input.deliveryMode === 'commit'
        ? grant.allowedOperations.includes('pull-request') || !['branch', 'commit-checks'].every(kind => grant.allowedInspectKinds.includes(kind as InspectRequest['kind']))
        : !['branch', 'pull-request', 'checks', 'reviews'].every(kind => grant.allowedInspectKinds.includes(kind as InspectRequest['kind'])))
      || grant.owner.principalDigest !== principalDigest(input.owner.principalId) || grant.owner.principalRecordId !== input.owner.principalRecordId
      || grant.owner.principalVersion !== input.owner.principalVersion || grant.owner.workspace !== input.owner.workspace || grant.owner.preset !== input.owner.preset
      || grant.expiresAt !== input.owner.expiresAt || grant.verifiedDelivery?.ownerRouteId !== input.owner.ownerRouteId) throw new Error('assistant-actions: repository event grant changed')
    const delivery = this.ctx.get('assistantDelivery')
    if (!delivery) throw new Error('assistant-actions: repository event delivery unavailable')
    const route = delivery.validateOwnerRoute({ authorityId: input.owner.ownerRouteId, principalId: input.owner.principalId, workspace: input.owner.workspace, agentPreset: input.owner.preset })
    const resolved = delivery.resolveOwnerRoute(input.owner.ownerRouteId)
    if (!route || route.principalRecordId !== input.owner.principalRecordId || route.principalVersion !== input.owner.principalVersion
      || route.bindingVersion !== grant.owner.bindingVersion || route.generation !== grant.owner.bindingGeneration
      || grant.owner.bindingId !== resolved?.binding.id || resolved.binding.sessionId !== grant.sessionId) throw new Error('assistant-actions: repository event owner changed')
    const policy = this.ctx.get('assistantPolicy')
    if (!policy) throw new Error('assistant-actions: repository event policy unavailable')
    const eventPolicy = () => policy.evaluate({ subject: { kind: 'background' as const, id: `event-triggers:${input.triggerId}`, workspace: input.owner.workspace, principal: input.owner.principalId },
      action: 'observe', resource: { kind: 'network' as const, id: `https://api.github.com/repos/${input.repository}` }, context: { initiator: 'background' as const } }).effect === 'allow'
    const actionPolicy = () => policy.evaluate({ subject: { kind: 'background' as const, id: 'dsh-ray-assistant-actions', workspace: input.owner.workspace, principal: input.owner.principalId },
      action: 'execute', resource: { kind: 'tool' as const, id: `action:github:${grant.id}` }, context: { initiator: 'background' as const } }).effect === 'allow'
    if (!eventPolicy() || !actionPolicy()) throw new Error('assistant-actions: repository event policy denied')
    let selected: { intent: DeliveryIntent; outcome: DeliveryOutcome } | undefined
    if (input.goal) {
      const goals = this.ctx.get('assistantGoals') as { inspectGoalLifecycle?: (value: { scope: { principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string }; goalId: string }) => { definition: { version: number; digest: string }; native: { sessionId: string; goalId: string; phase: 'active' | 'paused' | 'blocked' | 'complete' | 'cleared' } } | undefined } | undefined
      const lifecycle = goals?.inspectGoalLifecycle?.({ scope: { principalId: input.owner.principalId, principalRecordId: input.owner.principalRecordId, principalVersion: input.owner.principalVersion, workspace: input.owner.workspace, preset: input.owner.preset }, goalId: input.goal.id })
      if (!lifecycle || lifecycle.definition.version !== input.goal.definitionVersion || lifecycle.definition.digest !== input.goal.definitionDigest
        || lifecycle.native.sessionId !== input.goal.sessionId || lifecycle.native.goalId !== input.goal.nativeGoalId || ['complete', 'cleared'].includes(lifecycle.native.phase)
        || grant.sessionId !== input.goal.sessionId || !this.#verified) throw new Error('assistant-actions: repository event goal changed')
      const latest = this.#verified.latestForGoal(input.goal, grant.id, { principalRecordId: input.owner.principalRecordId, principalVersion: input.owner.principalVersion }, { workspace: input.owner.workspace, preset: input.owner.preset })
      if (latest?.state === 'succeeded' && latest.outcome?.commit.status === 'succeeded' && (input.deliveryMode === 'commit' ? !latest.intent.request.pullRequest && !latest.outcome.pullRequest : latest.outcome.pullRequest?.status === 'succeeded')) selected = { intent: latest.intent, outcome: latest.outcome }
    }
    const snapshot = digest({ grant: { id: grant.id, revision: grant.revision, digest: grant.grantDigest, expiresAt: grant.expiresAt, owner: grant.owner, destination: grant.destination }, route,
      goal: input.goal, delivery: selected && { id: selected.intent.id, security: selected.intent.security, outcome: selected.outcome } })
    const authorization: ExternalBackgroundAuthorization = {
      sessionId: input.goal?.sessionId ?? grant.sessionId, agentId: `event-triggers:${input.triggerId}`,
      current: () => { if (this.#repositoryEventContext(input).snapshot !== snapshot) throw new Error('assistant-actions: repository event authority changed') },
      // Do not retain a Policy proxy across an await; provider replacement is
      // an authorization boundary, so resolve and validate the complete live
      // capability again at the broker dispatch gate.
      authorize: (actionId) => {
        try {
          const current = this.#repositoryEventContext(input)
          if (current.snapshot !== snapshot) return false
          const livePolicy = this.ctx.get('assistantPolicy')
          if (!livePolicy) return false
          return livePolicy.authorize({ subject: { kind: 'background', id: 'dsh-ray-assistant-actions', workspace: input.owner.workspace, principal: input.owner.principalId },
            action: 'execute', resource: { kind: 'tool', id: `action:github:${grant.id}` }, context: { initiator: 'background' } }, { idempotencyKey: `external-action:${actionId}` }).effect === 'allow'
        } catch { return false }
      },
    }
    return { grant, authorization, snapshot, ...(selected === undefined ? {} : { delivery: selected }) }
  }

  #external(): GitHubBrokerClientOptions {
    if (!this.#active || !this.#externalClient) throw new Error('assistant-actions: external broker unavailable')
    return this.#externalClient
  }

  #externalContext(agent: Agent | undefined, grantId: string): { grant: ExternalActionGrantMirror; identity: ActionIdentity; owner: BrokerRequestIntent['owner'] } {
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-actions: exact live agent required')
    const attestation = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    const grant = this.#externalGrants.get(grantId)
    if (!attestation || !grant || grant.expiresAt <= Date.now() || attestation.sessionId !== String(agent.session.id)
      || attestation.scope.workspace !== agent.session.header.cwd || attestation.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-actions: authenticated owner required')
    const owner: BrokerRequestIntent['owner'] = { principalDigest: principalDigest(attestation.principalId), ...attestation.principalLineage, workspace: attestation.scope.workspace,
      preset: attestation.scope.preset, bindingId: attestation.bindingId, bindingVersion: attestation.bindingVersion, bindingGeneration: attestation.bindingGeneration }
    if (digest(owner) !== digest(grant.owner) || grant.sessionId !== String(agent.session.id)) throw new Error('assistant-actions: external grant projection does not match current owner')
    if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent, 'execute', { kind: 'tool', id: `action:github:${grantId}` }).effect !== 'allow') throw new Error('assistant-actions: policy denied')
    return { grant, owner, identity: { principalDigest: owner.principalDigest, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, workspace: owner.workspace, agentPreset: owner.preset } }
  }

  #externalActionId(grant: ExternalActionGrantMirror, sessionId: string, operation: BrokerOperation, idempotencyKey: string): string {
    return brokerDigest({ protocol: 'assistant-actions/external-action-id/v1', clientKeyId: this.#external().clientKeyId, grantId: grant.id, grantRevision: grant.revision, sessionId, operation, idempotencyKey })
  }

  async #externalRequest(agent: Agent | undefined, grant: ExternalActionGrantMirror, owner: BrokerRequestIntent['owner'], operation: BrokerOperation, payload: BrokerRequestIntent['payload'],
    signal: AbortSignal, invocation: ExternalInvocation, idempotencyKey: string, background?: ExternalBackgroundAuthorization): Promise<{ result: ActionResult; observed?: unknown; receipt?: ExternalDeliveryReceipt; generation?: number; epochs?: string }> {
    signal.throwIfAborted()
    const client = this.#external(), sessionId = background?.sessionId ?? String(agent!.session.id)
    const actionId = this.#externalActionId(grant, sessionId, operation, idempotencyKey)
    const policy = this.ctx.get('assistantPolicy')
    const decision = background ? undefined : policy?.authorizeAgent(agent, 'execute', { kind: 'tool', id: `action:github:${grant.id}` }, { idempotencyKey: `external-action:${actionId}` })
    if (background ? !background.authorize(actionId) : decision?.effect !== 'allow') throw new Error('assistant-actions: external broker policy denied')
    const intent: BrokerRequestIntent = {
      actionId, grantId: grant.id, grantRevision: grant.revision, grantDigest: grant.grantDigest, owner, sessionId, agentId: background?.agentId ?? String(agent!.id),
      rootCallId: invocation.rootCallId, callId: invocation.callId, operation, source: grant.source,
      destination: { classification: 'github-repository', repository: grant.destination.repository, branch: grant.destination.branch,
        ...(grant.destination.baseBranch === undefined ? {} : { baseBranch: grant.destination.baseBranch }) }, payload, deadline: Math.min(grant.expiresAt, Date.now() + (client.timeoutMs ?? 30_000)),
      budget: { reservationId: actionId, actions: 1, bytes: Buffer.byteLength(canonicalBrokerJson(payload)), costMetric: 'github-api-units',
        maxCostUnits: operation === 'inspect' && 'kind' in payload && ['checks', 'reviews'].includes(payload.kind) ? 2 : 1 },
    }
    const authorization = new AbortController()
    const stillAuthorized = (): boolean => {
      try {
        const current = background ? (background.current(), { grant: this.#externalGrants.get(grant.id)!, owner: grant.owner }) : this.#externalContext(agent, grant.id)
        return this.#active && !signal.aborted && !authorization.signal.aborted && this.#externalClient === client
          && current.grant.grantDigest === grant.grantDigest && digest(current.owner) === digest(owner)
      } catch { return false }
    }
    const timer = setInterval(() => { if (!stillAuthorized()) authorization.abort(new Error('assistant-actions external authorization ended')) }, 100)
    timer.unref()
    let signed: { hello: BrokerServerHello; request: BrokerClientRequest } | undefined
    const requestClient: GitHubBrokerClientOptions = { ...client, beforeWrite: (hello, request, gateSignal) => {
      signed = { hello, request }
      gateSignal.throwIfAborted()
      if (!stillAuthorized() || request.actionId !== actionId || request.grantDigest !== grant.grantDigest || digest(request.owner) !== digest(owner)) throw new Error('assistant-actions: external authorization ended before dispatch')
    } }
    const pending = Promise.resolve().then(() => this.#externalDispatch(requestClient, intent, AbortSignal.any([signal, authorization.signal])))
    const operationState = { abort: authorization, done: pending, client }
    this.#pendingExternal.add(operationState)
    try {
      const response = await pending
      this.#externalObservedGeneration = response.generation
      if (signed && Number.isSafeInteger(signed.hello.policyEpoch) && Number.isSafeInteger(signed.hello.emergencyEpoch)) this.#externalObservedEpochs = brokerDigest([signed.hello.policyEpoch, signed.hello.emergencyEpoch])
      if (!stillAuthorized()) return { result: { actionId, status: response.dispatched ? 'unknown' : 'failed', reason: 'external-broker-authorization-ended' } }
      const result: ActionResult = { actionId: response.actionId, status: response.status,
        ...(response.result?.operation === 'commit' ? { commitOid: response.result.commitOid, branch: response.result.branch } : {}),
        ...(response.result?.operation === 'pull-request' ? { pullRequestNumber: response.result.pullRequestNumber, branch: response.result.branch } : {}),
        ...(response.error ? { reason: `external-broker-${response.error.code}` } : {}) }
      return { result, generation: response.generation, ...(signed && Number.isSafeInteger(signed.hello.policyEpoch) && Number.isSafeInteger(signed.hello.emergencyEpoch) ? { epochs: brokerDigest([signed.hello.policyEpoch, signed.hello.emergencyEpoch]) } : {}), ...(signed ? { receipt: captureExternalDeliveryReceipt(signed.hello, signed.request, response) } : {}), ...(response.status === 'succeeded' && response.result?.operation === 'inspect' ? { observed: structuredClone(response.result.observed) } : {}) }
    } catch (error) {
      if (error instanceof BrokerClientError) return { result: { actionId, status: error.postDispatchUnknown ? 'unknown' : 'failed', reason: `external-broker-${error.code}` } }
      throw error
    } finally { clearInterval(timer); this.#pendingExternal.delete(operationState) }
  }

  async #runExternal(agent: Agent | undefined, request: CommitRequest, signal: AbortSignal, invocation: ExternalInvocation): Promise<ActionResult> {
    const { grant, owner, identity } = this.#externalContext(agent, request.grantId)
    if (grant.verifiedDelivery || !this.#allowsExternal(grant, identity, request)) throw new Error('assistant-actions: request not granted')
    return (await this.#externalRequest(agent, grant, owner, 'commit', { expectedHeadOid: request.expectedHeadOid, headline: request.headline, files: request.files }, signal, invocation, request.idempotencyKey)).result
  }

  async #runExternalInspect(agent: Agent | undefined, input: InspectRequest, signal: AbortSignal, invocation: ExternalInvocation): Promise<{ result: ActionResult; observed?: unknown }> {
    const request = normalizeWorkflow({ ...input, operation: 'inspect', idempotencyKey: invocation.callId })
    if (!('operation' in request)) throw new Error('assistant-actions: invalid inspection')
    const { grant, owner, identity } = this.#externalContext(agent, request.grantId)
    if (!this.#allowsExternal(grant, identity, input)) throw new Error('assistant-actions: request not granted')
    const payload = { kind: request.kind, ...(request.path === undefined ? {} : { path: request.path }), ...(request.pullRequestNumber === undefined ? {} : { pullRequestNumber: request.pullRequestNumber }), ...(request.commitOid === undefined ? {} : { commitOid: request.commitOid }) } as BrokerRequestIntent['payload']
    const { result, observed } = await this.#externalRequest(agent, grant, owner, 'inspect', payload, signal, invocation, request.idempotencyKey)
    return { result, ...(observed === undefined ? {} : { observed }) }
  }

  #identity(agent: Agent | undefined, grantId: string): ActionIdentity {
    if (this.#isExternalMode()) return this.#externalContext(agent, grantId).identity
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-actions: controller unavailable')
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-actions: exact live agent required')
    const owner = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-actions: authenticated owner required')
    if (this.ctx.get('assistantPolicy')?.evaluateAgent(agent, 'execute', { kind: 'tool', id: `action:github:${grantId}` }).effect !== 'allow') throw new Error('assistant-actions: policy denied')
    return { principalDigest: principalDigest(owner.principalId), ...owner.principalLineage, workspace: owner.scope.workspace, agentPreset: owner.scope.preset }
  }

  #compensationIdentity(agent: Agent | undefined, grantId: string): ActionIdentity {
    if (!this.#active || !this.#ledger.hasController(this.#authority)) throw new Error('assistant-actions: controller unavailable')
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-actions: exact live agent required')
    const owner = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    if (!owner || owner.scope.workspace !== agent.session.header.cwd || owner.scope.preset !== agent.session.header.agentPreset) throw new Error('assistant-actions: authenticated owner required')
    const grant = this.#ledger.grant(grantId)
    const rollback = grant?.rollback
    const policy = this.ctx.get('assistantPolicy')
    if (!grant || !rollback?.allowRollback || grant.expiresAt <= Date.now()
      || policy?.getBudgetConfig(rollback.budgetId)?.metric !== ROLLBACK_BUDGET_METRIC
      || policy.evaluateAgent(agent, 'compensate', { kind: 'tool', id: `action:github-rollback:${grantId}` }).effect !== 'allow') throw new Error('assistant-actions: compensation denied')
    return { principalDigest: principalDigest(owner.principalId), ...owner.principalLineage, workspace: owner.scope.workspace, agentPreset: owner.scope.preset }
  }

  #reserveCompensation(agent: Agent | undefined, record: CompensationRecord, expectedReservationId?: string): { reservationId: string; amount: number } | undefined {
    try {
      const grant = this.#ledger.grant(record.grantId)
      const rollback = grant?.rollback
      const policy = this.ctx.get('assistantPolicy')
      if (!rollback?.allowRollback || policy?.getBudgetConfig(rollback.budgetId)?.metric !== ROLLBACK_BUDGET_METRIC) return undefined
      // evaluateAgent only decides; the two-phase reserve below is what holds
      // budget capacity, so an authorization that never reaches the dispatch
      // POST can be released instead of permanently spending the action.
      const decision = policy.evaluateAgent(agent, 'compensate', { kind: 'tool', id: `action:github-rollback:${record.grantId}` })
      if (decision.effect !== 'allow' || decision.budget?.id !== rollback.budgetId) return undefined
      const preset = agent?.session.header.agentPreset
      const workspace = agent?.session.header.cwd
      if (!agent || preset === undefined || preset === '' || workspace === undefined) return undefined
      const reservation = policy.reserve({
        budgetId: rollback.budgetId,
        subject: { kind: 'agent', id: preset, workspace },
        amount: decision.budget.amount,
        idempotencyKey: `compensation:${record.id}`,
      })
      // A still-open reservation is accepted both fresh (new capturing row) and
      // as a replay (resuming a prepared row whose earlier attempt stopped
      // before dispatch). A released/finalized replay is fail-closed: the
      // capacity was already settled and a sealed prepared row is never reused.
      if (reservation.status !== 'reserved') return undefined
      // The pre-dispatch re-check must replay the very same open reservation.
      if (expectedReservationId !== undefined && (!reservation.replayed || reservation.reservationId !== expectedReservationId)) return undefined
      return { reservationId: reservation.reservationId, amount: decision.budget.amount }
    } catch { return undefined }
  }

  #forwardResult(request: CommitRequest, result: ActionResult): ActionResult | (ActionResult & { forwardReceipt: { actionId: string; version: number; requestDigest: string; commitOid: string } }) {
    if (result.status !== 'succeeded' || !result.commitOid) return result
    const record = this.#ledger.get(result.actionId)
    const grant = this.#ledger.grant(request.grantId)
    if (!grant?.rollback?.allowRollback || !record || record.kind !== 'commit' || record.status !== 'succeeded'
      || record.grantId !== request.grantId || record.result?.commitOid !== result.commitOid || digest(record.result) !== digest(result)) return result
    return { ...result, forwardReceipt: { actionId: record.id, version: record.version, requestDigest: record.requestDigest, commitOid: result.commitOid } }
  }

  prepareVerifiedDelivery = (agent: Agent | undefined, input: VerifiedDeliveryRequest) => {
    if (!this.#verified) throw new Error('assistant-actions: verified delivery unavailable')
    return this.#verified.prepare(agent, normalizeVerifiedDelivery(input))
  }

  /** Stable only while this fenced broker remains active; used by Verifier around an untrusted remote read. */
  repositoryReadbackGeneration = (): string => {
    if (this.#mode === 'external-unix-v1') return this.#active ? digest({ facade: this.#externalFacadeGeneration, generation: this.#externalObservedGeneration ?? this.#external().minimumServerGeneration, epochs: this.#externalObservedEpochs }) : ''
    return this.#active && this.#ledger.hasController(this.#authority) ? digest(this.#authority) : ''
  }

  readRepositoryGoalOutcome = async (input: { contractId: string; authorityId: string; authorityDigest: string }, signal: AbortSignal): Promise<(RepositoryReadback & { ready: boolean }) | RepositoryCommitReadback> => {
    signal.throwIfAborted()
    const verifier = this.ctx.get('assistantVerifier', false)
    if (!verifier) throw new Error('assistant-actions: repository readback authority unavailable')
    const binding = verifier.inspectRepositoryReadbackAuthority(input.contractId, input.authorityId, input.authorityDigest)
    const bindingDigest = digest(binding)
    const context = () => {
      const currentVerifier = this.ctx.get('assistantVerifier', false)
      if (!currentVerifier) throw new Error('assistant-actions: repository readback authority unavailable')
      const current = currentVerifier.inspectRepositoryReadbackAuthority(input.contractId, input.authorityId, input.authorityDigest)
      if (digest(current) !== bindingDigest) throw new Error('assistant-actions: repository readback authority changed')
      return this.#repositoryReadbackContext(current.contract, current.authority)
    }
    const initial = context()
    if (!Number.isSafeInteger(initial.authority.timeoutMs) || initial.authority.timeoutMs <= 0 || !Number.isSafeInteger(initial.authority.freshnessMs) || initial.authority.freshnessMs <= 0) throw new Error('assistant-actions: repository readback bounds invalid')
    const observedAt = Date.now()
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(initial.authority.timeoutMs)])
    if (initial.authority.kind === 'repository-commit-readback') {
      // Check the receipt's immutable commit first, then fence a moving branch
      // with the final remote read before issuing an affirmative outcome.
      const [checks, branchSnapshot] = [
        await this.#readRepositoryInspection(context, 'commit-checks', undefined, initial.commitOid, deadline),
        await this.#readRepositoryInspection(context, 'branch', undefined, undefined, deadline),
      ]
      const final = context()
      if (digest(initial) !== digest(final) || Date.now() - observedAt > final.authority.freshnessMs) throw new Error('assistant-actions: repository readback authority changed')
      return normalizeRepositoryCommitReadback({ repository: final.authority.repository, branch: final.authority.branch, commitOid: final.commitOid,
        requirements: final.requirements, checks, branchSnapshot })
    }
    const pullRequestNumber = initial.pullRequestNumber
    if (pullRequestNumber === undefined) throw new Error('assistant-actions: repository delivery receipt invalid')
    const [checks, reviews, pullRequest, branchSnapshot] = [
      await this.#readRepositoryInspection(context, 'checks', pullRequestNumber, undefined, deadline),
      await this.#readRepositoryInspection(context, 'reviews', pullRequestNumber, undefined, deadline),
      await this.#readRepositoryInspection(context, 'pull-request', pullRequestNumber, undefined, deadline),
      await this.#readRepositoryInspection(context, 'branch', undefined, undefined, deadline),
    ]
    const final = context()
    if (digest(initial) !== digest(final) || Date.now() - observedAt > final.authority.freshnessMs) throw new Error('assistant-actions: repository readback authority changed')
    const normalized = normalizeRepositoryReadback({ repository: final.authority.repository, branch: final.authority.branch, baseBranch: final.authority.baseBranch,
      commitOid: final.commitOid, pullRequestNumber, requirements: final.requirements, checks, reviews, pullRequest, branchSnapshot })
    const headConfirmed = normalized.headOid === final.commitOid
    const ci = !headConfirmed ? 'unknown' : normalized.ci
    const review = !headConfirmed ? 'unknown' : normalized.review
    return Object.freeze({ objectId: normalized.objectId, headOid: normalized.headOid, ci, review, pullRequest: normalized.pullRequest,
      ready: ci === 'passed' && review === 'approved' && (normalized.pullRequest === 'open' || normalized.pullRequest === 'merged') })
  }

  #repositoryReadbackContext(contract: TaskAcceptanceContract, authority: RepositoryOutcomeAuthority): RepositoryReadbackContext {
    if (!this.#active || !this.#verified || contract.expiresAt <= Date.now() || contract.task.kind !== 'goal-outcome' || !['repository-readback', 'repository-commit-readback'].includes(authority.kind)) throw new Error('assistant-actions: repository readback binding invalid')
    const goal = contract.task.goal
    const latest = this.#verified.latestForGoal({ id: goal.id, sessionId: goal.sessionId, nativeGoalId: goal.nativeGoalId, definitionVersion: goal.definitionVersion, definitionDigest: goal.definitionDigest }, authority.grantId, contract.owner, contract.scope)
    if (!latest || latest.state !== 'succeeded' || latest.intent.security.acceptance !== 'goal-step' || !latest.outcome) throw new Error('assistant-actions: repository delivery not settled')
    const security = latest.intent.security
    if (security.goalId !== goal.id || security.nativeGoalId === undefined || security.nativeGoalId !== goal.nativeGoalId || security.sessionId !== goal.sessionId || security.definitionVersion !== goal.definitionVersion || security.definitionDigest !== goal.definitionDigest
      || security.grantId !== authority.grantId || security.grantRevision !== authority.grantRevision || security.identity.principalRecordId !== contract.owner.principalRecordId || security.identity.principalVersion !== contract.owner.principalVersion
      || security.identity.workspace !== contract.scope.workspace || security.identity.agentPreset !== contract.scope.preset) throw new Error('assistant-actions: repository delivery binding changed')
    const grant = this.#deliveryGrant(authority.grantId)
    if (!grant || grant.revision !== authority.grantRevision || grant.repository !== authority.repository || grant.branch !== authority.branch || grant.repoWorkflow?.baseBranch !== authority.baseBranch) throw new Error('assistant-actions: repository grant changed')
    const outcome = latest.outcome as DeliveryOutcome
    const commitOid = outcome.commit.commitOid, pullRequestOutcome = outcome.pullRequest, pullRequestNumber = pullRequestOutcome?.pullRequestNumber
    const direct = authority.kind === 'repository-commit-readback'
    if (direct && latest.intent.request.pullRequest) throw new Error('assistant-actions: repository direct delivery unexpectedly opened a pull request')
    if (!direct && !latest.intent.request.pullRequest) throw new Error('assistant-actions: repository pull request delivery missing')
    if (direct && this.#mode === 'external-unix-v1') {
      const external = this.#externalGrants.get(authority.grantId)
      if (!external || external.allowedOperations.includes('pull-request') || !external.allowedOperations.includes('inspect')
        || !external.allowedInspectKinds.includes('branch') || !external.allowedInspectKinds.includes('commit-checks')) throw new Error('assistant-actions: repository direct grant changed')
    }
    if (this.#mode === 'external-unix-v1') this.#verifyExternalDelivery(latest.intent, outcome)
    else {
    const commit = this.#ledger.get(outcome.commit.actionId)
    const pullRequest = pullRequestOutcome && this.#ledger.get(pullRequestOutcome.actionId)
    if (outcome.commit.status !== 'succeeded' || !commitOid || !commit || commit.kind !== 'commit' || commit.status !== 'succeeded' || digest(commit.result) !== digest(outcome.commit)
      || commit.grantId !== grant.id || commit.grantRevision !== grant.revision || commit.sessionId !== security.sessionId || digest(commit.identity) !== digest(security.identity)
      || !direct && (!pullRequestOutcome || pullRequestOutcome.status !== 'succeeded' || !pullRequestNumber || !pullRequest || pullRequest.kind !== 'pull-request' || pullRequest.status !== 'succeeded' || digest(pullRequest.result) !== digest(pullRequestOutcome)
      || pullRequest.grantId !== grant.id || pullRequest.grantRevision !== grant.revision || pullRequest.sessionId !== security.sessionId || digest(pullRequest.identity) !== digest(security.identity))) throw new Error('assistant-actions: repository delivery receipt invalid')
    }
    if (outcome.commit.status !== 'succeeded' || !commitOid || !direct && (pullRequestOutcome?.status !== 'succeeded' || !pullRequestNumber)) throw new Error('assistant-actions: repository delivery receipt invalid')
    this.#deliveryIdentity(security)
    type OwnerEvidence = { storedGoal?: { definition?: { version?: number; digest?: string }; nativeAtLastObservation?: { phase?: string; sessionId?: string; goalId?: string } }; acceptedTasks?: readonly { contractId: string; state: string; contract: unknown; receipt: unknown }[]; executionRuns?: readonly GoalExecutionRun[]; outcomeAssessments?: readonly { contract: TaskAcceptanceContract; triggerRunId: string | null; execution: { status: 'succeeded' | 'unknown'; quiescent: boolean } | null }[] }
    const goals = this.ctx.get('assistantGoals', false) as { inspectOwnerGoalExecution?: (input: { ownerRouteId: string; principalId: string; workspace: string; preset: string; sessionId: string; goalId: string }) => OwnerEvidence } | undefined
    const evidence = goals?.inspectOwnerGoalExecution?.({ ownerRouteId: security.ownerRouteId, principalId: security.principalId, workspace: security.identity.workspace, preset: security.identity.agentPreset, sessionId: security.sessionId, goalId: security.goalId })
    const phase = evidence?.storedGoal?.nativeAtLastObservation?.phase
    if (!evidence || phase === undefined || !['active', 'paused', 'complete', 'blocked'].includes(phase) || evidence.storedGoal?.definition?.version !== goal.definitionVersion || evidence.storedGoal?.definition?.digest !== goal.definitionDigest
      || evidence.storedGoal?.nativeAtLastObservation?.sessionId !== goal.sessionId || evidence.storedGoal?.nativeAtLastObservation?.goalId !== goal.nativeGoalId) throw new Error('assistant-actions: repository goal changed')
    const assessment = evidence.outcomeAssessments?.find(item => item.contract.id === contract.id && item.contract.digest === contract.digest)
    const source = evidence.executionRuns?.find(run => run.intent.runId === security.runId)
    const assessmentRun = assessment?.triggerRunId === null || assessment?.triggerRunId === undefined ? undefined : evidence.executionRuns?.find(run => run.intent.runId === assessment.triggerRunId)
    const exactRun = (run: GoalExecutionRun | undefined) => run !== undefined && run.intent.scope.workspace === contract.scope.workspace && run.intent.scope.preset === contract.scope.preset
      && run.intent.scope.principalId === security.principalId && run.dispatchedAt !== undefined && run.intent.scope.principalRecordId === contract.owner.principalRecordId && run.intent.scope.principalVersion === contract.owner.principalVersion
      && run.intent.task.goal.id === goal.id && run.intent.task.goal.definitionVersion === goal.definitionVersion && run.intent.task.goal.definitionDigest === goal.definitionDigest
      && run.intent.task.goal.sessionId === goal.sessionId && run.intent.task.goal.nativeGoalId === goal.nativeGoalId && run.execution?.status === 'succeeded' && run.execution.quiescent
    if (!assessment || !source || !assessmentRun || assessment.execution?.status !== 'succeeded' || !assessment.execution.quiescent || !exactRun(source) || !exactRun(assessmentRun)) throw new Error('assistant-actions: repository goal execution changed')
    if (source.intent.admission.round > assessmentRun.intent.admission.round) throw new Error('assistant-actions: repository goal execution changed')
    const acceptedSource = evidence.acceptedTasks?.find(value => value.contractId === source.acceptance?.contractId && value.state === 'done')
    if (!acceptedSource) throw new Error('assistant-actions: repository source acceptance unavailable')
    const sourceContract = validateTaskAcceptanceContract(acceptedSource.contract)
    const sourceReceipt = validateTaskVerificationReceipt(sourceContract, acceptedSource.receipt)
    if (sourceContract.digest !== source.acceptance?.contractDigest || digest(sourceContract.task) !== digest(source.intent.task)
      || sourceContract.owner.principalRecordId !== contract.owner.principalRecordId || sourceContract.owner.principalVersion !== contract.owner.principalVersion
      || digest(sourceContract.scope) !== digest(contract.scope) || sourceReceipt.objectiveStatus !== 'achieved') throw new Error('assistant-actions: repository source acceptance changed')
    const evidenceDigest = digest({ source, assessment, assessmentRun, acceptedSource })
    return Object.freeze({ authority: Object.freeze({ kind: authority.kind, grantId: authority.grantId, grantRevision: authority.grantRevision, repository: authority.repository, branch: authority.branch, baseBranch: authority.baseBranch, timeoutMs: authority.timeoutMs, freshnessMs: authority.freshnessMs }),
      evidenceDigest, requirements: validateRepositoryReadbackRequirements({ requiredChecks: authority.requiredChecks, reviewerIds: direct ? [] : authority.reviewerIds, minApprovals: direct ? 0 : authority.minApprovals }), security, intent: latest.intent, commitOid, ...(direct ? {} : { pullRequestNumber: pullRequestNumber! }) })
  }

  async #readRepositoryInspection(context: () => RepositoryReadbackContext, kind: InspectRequest['kind'], pullRequestNumber: number | undefined, commitOid: string | undefined, signal: AbortSignal): Promise<unknown> {
    let observed: unknown
    const start = context()
    if (this.#isExternalMode()) {
      const grant = this.#externalGrants.get(start.authority.grantId)!
      if (!grant.allowedOperations.includes('inspect') || !grant.allowedInspectKinds.includes(kind)) throw new Error('assistant-actions: repository inspection not granted')
      const authorization = this.#externalDeliveryAuthorization(start.intent)
      const current = authorization.current
      authorization.current = () => { current(); if (digest(context()) !== digest(start)) throw new Error('assistant-actions: repository readback changed') }
      const generation = this.#externalObservedGeneration, epochs = this.#externalObservedEpochs, callId = `readback:${randomUUID()}`
      const response = await this.#externalRequest(undefined, grant, grant.owner, 'inspect', { kind, ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }), ...(commitOid === undefined ? {} : { commitOid }) },
        signal, { callId, rootCallId: start.intent.id }, callId, authorization)
      if (response.result.status !== 'succeeded' || response.observed === undefined || generation !== undefined && generation !== response.generation || epochs !== undefined && epochs !== this.#externalObservedEpochs) throw new Error('assistant-actions: repository inspection unavailable or broker changed')
      authorization.current()
      return response.observed
    }
    const request = normalizeWorkflow({ grantId: start.authority.grantId, operation: 'inspect', idempotencyKey: randomUUID(), kind, ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }), ...(commitOid === undefined ? {} : { commitOid }) })
    if (!('operation' in request)) throw new Error('assistant-actions: repository inspection invalid')
    const authorization: Authorization = { sessionId: start.security.sessionId,
      identity: () => { const current = context(); if (digest(current) !== digest(start)) throw new Error('assistant-actions: repository readback changed'); return current.security.identity },
      authorize: record => this.ctx.get('assistantPolicy')?.authorize(this.#deliveryPolicy(start.security), { idempotencyKey: `action:${record.id}` }).effect === 'allow' }
    const result = await this.#runAuthorized(authorization, request, signal, async (actionId, grant, token, combined) => {
      const reply = await this.workflow.inspect({ grant, kind: request.kind, ...(request.pullRequestNumber === undefined ? {} : { pullRequestNumber: request.pullRequestNumber }), ...(request.commitOid === undefined ? {} : { commitOid: request.commitOid }), token, signal: combined })
      observed = reply?.observed
      return reply ? { actionId, status: 'succeeded' } : { actionId, status: 'failed', reason: 'github-inspect-failed' }
    })
    if (result.status !== 'succeeded' || observed === undefined) throw new Error('assistant-actions: repository inspection unavailable')
    context()
    return observed
  }

  #deliveryGrant(id: string): DeliveryGrant | undefined {
    if (!this.#isExternalMode()) return this.#ledger.grant(id)
    const grant = this.#externalGrants.get(id)
    if (!grant) return undefined
    return { id: grant.id, revision: grant.revision, principalDigest: grant.owner.principalDigest, principalRecordId: grant.owner.principalRecordId,
      principalVersion: grant.owner.principalVersion, workspace: grant.owner.workspace, agentPreset: grant.owner.preset,
      repository: grant.destination.repository, branch: grant.destination.branch, paths: [...grant.destination.paths], expiresAt: grant.expiresAt,
      maxActions: grant.maxActions, maxTotalBytes: grant.maxTotalBytes, ...(grant.verifiedDelivery ? { verifiedDelivery: grant.verifiedDelivery } : {}),
      ...(grant.destination.baseBranch ? { repoWorkflow: { baseBranch: grant.destination.baseBranch, allowBranchCreate: false, allowPullRequest: grant.allowedOperations.includes('pull-request') } } : {}) }
  }

  #captureDelivery(agent: Agent | undefined, request: VerifiedDeliveryRequest): DeliverySecurity {
    const identity = this.#identity(agent, request.grantId)
    const grant = this.#deliveryGrant(request.grantId)
    if (!grant?.verifiedDelivery || grant.expiresAt <= Date.now() || digest(identity) !== digest({ principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: grant.workspace, agentPreset: grant.agentPreset })
      || !request.paths.every(path => grant.paths.includes(path)) || request.pullRequest && !grant.repoWorkflow?.allowPullRequest) throw new Error('assistant-actions: verified delivery is not granted')
    const delivery = this.ctx.get('assistantDelivery')!
    const owner = delivery.preferencePrincipalForAgent(agent!)!
    const goals = this.ctx.get('assistantGoals', false)
    const context = goals?.taskContext(agent)
    const current = context ? goals!.inspectWorkflowRunContext(agent, context.goal.id) : undefined
    const nativeGoalId = current?.nativeGoalId
    if (!current) throw new Error('assistant-actions: admitted native goal round required')
    const routeReceipt = delivery.validateOwnerRoute({ authorityId: grant.verifiedDelivery.ownerRouteId, principalId: owner.principalId, workspace: identity.workspace, agentPreset: identity.agentPreset })
    if (routeReceipt.principalRecordId !== identity.principalRecordId || routeReceipt.principalVersion !== identity.principalVersion
      || routeReceipt.bindingVersion !== owner.bindingVersion || routeReceipt.generation !== owner.bindingGeneration) throw new Error('assistant-actions: current owner route mismatch')
    const security: DeliverySecurity = { principalId: owner.principalId, identity, sessionId: String(agent!.session.id),
      goalId: current.goalId, ...(typeof nativeGoalId === 'string' && nativeGoalId.length > 0 ? { nativeGoalId } : {}), runId: current.goalExecutionRunId, definitionDigest: current.definition.digest, definitionVersion: current.definition.version,
      grantId: grant.id, grantRevision: grant.revision, ...(this.#isExternalMode() ? { externalGrantDigest: this.#externalGrants.get(grant.id)!.grantDigest } : {}), ownerRouteId: grant.verifiedDelivery.ownerRouteId, budgetId: grant.verifiedDelivery.budgetId,
      expiresAt: grant.expiresAt, routeReceipt, ...(grant.verifiedDelivery.acceptance ? { acceptance: grant.verifiedDelivery.acceptance } : {}) }
    this.#deliveryIdentity(security)
    return security
  }

  #deliveryPolicy(security: DeliverySecurity) {
    return { subject: { kind: 'background' as const, id: 'dsh-ray-assistant-actions', workspace: security.identity.workspace, principal: security.principalId },
      action: 'execute' as const, resource: { kind: 'tool' as const, id: `action:github:${security.grantId}` }, context: { initiator: 'background' as const } }
  }
  #deliveryIdentity(security: DeliverySecurity): ActionIdentity {
    if (!this.#active || (!this.#isExternalMode() && !this.#ledger.hasController(this.#authority))) throw new Error('assistant-actions: controller unavailable')
    const grant = this.#deliveryGrant(security.grantId)
    if (!grant?.verifiedDelivery || grant.revision !== security.grantRevision || grant.expiresAt <= Date.now()
      || grant.verifiedDelivery.ownerRouteId !== security.ownerRouteId || grant.verifiedDelivery.budgetId !== security.budgetId
      || digest(security.identity) !== digest({ principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: grant.workspace, agentPreset: grant.agentPreset })
      || Date.now() >= security.expiresAt || (grant.verifiedDelivery.acceptance ?? 'goal-outcome') !== (security.acceptance ?? 'goal-outcome')) throw new Error('assistant-actions: delivery grant ended')
    const route = this.ctx.get('assistantDelivery')?.validateOwnerRoute({ authorityId: security.ownerRouteId, principalId: security.principalId,
      workspace: security.identity.workspace, agentPreset: security.identity.agentPreset })
    if (digest(route) !== digest(security.routeReceipt) || this.ctx.get('assistantPolicy')?.evaluate(this.#deliveryPolicy(security)).effect !== 'allow') throw new Error('assistant-actions: delivery authority changed')
    if (this.#isExternalMode()) {
      const external = this.#externalGrants.get(grant.id)!
      const resolved = this.ctx.get('assistantDelivery')?.resolveOwnerRoute(security.ownerRouteId)
      if (security.externalGrantDigest !== external.grantDigest || external.sessionId !== security.sessionId
        || resolved?.binding.id !== external.owner.bindingId || resolved.binding.sessionId !== security.sessionId
        || resolved.snapshot.bindingVersion !== external.owner.bindingVersion || resolved.snapshot.generation !== external.owner.bindingGeneration) throw new Error('assistant-actions: external delivery binding changed')
    } else if (security.externalGrantDigest !== undefined) throw new Error('assistant-actions: delivery backend changed')
    return security.identity
  }
  #inspectDelivery(intent: DeliveryIntent, historicalReadback = false): VerifiedFiles | undefined {
    const security = intent.security
    this.#deliveryIdentity(security)
    const goals = this.ctx.get('assistantGoals', false)
    if (!goals) throw new Error('assistant-actions: Goals unavailable')
    const input = { ownerRouteId: security.ownerRouteId, principalId: security.principalId, workspace: security.identity.workspace,
      preset: security.identity.agentPreset, sessionId: security.sessionId, goalId: security.goalId }
    const evidence = goals.inspectOwnerGoalExecution(input)
    const intermediate = security.acceptance === 'goal-step'
    if (evidence.storedGoal.definition.digest !== security.definitionDigest || evidence.storedGoal.definition.version !== security.definitionVersion
      || !(intermediate ? (historicalReadback ? ['active', 'paused', 'complete', 'blocked'] : ['active', 'paused', 'complete']) : ['active', 'complete']).includes(evidence.storedGoal.nativeAtLastObservation.phase)) throw new Error('assistant-actions: delivery goal changed')
    if (intermediate) {
      if (typeof goals.inspectOwnerAcceptedStepArtifacts !== 'function') throw new Error('assistant-actions: upgrade Goals for accepted step delivery')
      const run = evidence.executionRuns.find(item => item.intent.runId === security.runId)
      if (!run?.acceptance) throw new Error('assistant-actions: delivery step missing')
      if (run.execution !== undefined && (run.execution.status !== 'succeeded' || !run.execution.quiescent)) throw new Error('assistant-actions: delivery step execution invalid')
      const step = evidence.acceptedTasks.find(item => item.contractId === run.acceptance!.contractId)
      if (run.execution === undefined || step === undefined || step.state === 'unavailable' || step.state === 'pending' || step?.state === 'verifying' || step?.state === 'awaiting-execution') return undefined
      const snapshot = goals.inspectOwnerAcceptedStepArtifacts({ ...input, runId: security.runId, paths: intent.request.paths })
      this.#deliveryIdentity(security)
      return snapshot
    }
    if (evidence.outcome?.status !== 'achieved') {
      if (evidence.storedGoal.nativeAtLastObservation.phase === 'complete') throw new Error('assistant-actions: current acceptance missing')
      return undefined
    }
    const snapshot = goals.inspectOwnerVerifiedArtifacts({ ...input, runId: security.runId, paths: intent.request.paths })
    this.#deliveryIdentity(security)
    return snapshot
  }
  #notifyVerifiedDelivery(intent: DeliveryIntent, value: { idempotencyKey: string; text: string; outcome: unknown }): void {
    const security = intent.security
    this.#deliveryIdentity(security)
    const delivery = this.ctx.get('assistantDelivery') as { enqueueOwnerNotification?: (input: unknown) => unknown } | undefined
    if (typeof delivery?.enqueueOwnerNotification !== 'function') throw new Error('assistant-actions: owner notification delivery unavailable')
    delivery.enqueueOwnerNotification({ sourceId: 'assistant-actions-verified-delivery/v1', ownerRouteId: security.ownerRouteId,
      scope: { principalId: security.principalId, principalRecordId: security.identity.principalRecordId, principalVersion: security.identity.principalVersion,
        workspace: security.identity.workspace, preset: security.identity.agentPreset }, sessionId: security.sessionId,
      idempotencyKey: value.idempotencyKey, text: value.text, expiresAt: security.expiresAt, attention: { purpose: 'result' } })
  }
  #externalDeliveryAuthorization(intent: DeliveryIntent, frozen?: string): ExternalBackgroundAuthorization {
    const current = () => {
      this.#deliveryIdentity(intent.security)
      if (frozen !== undefined) {
        const snapshot = this.#inspectDelivery(intent)
        if (!snapshot || digest(snapshot) !== frozen) throw new Error('assistant-actions: accepted artifacts changed')
      }
    }
    return { sessionId: intent.security.sessionId, agentId: `delivery:${intent.id}`, current,
      authorize: actionId => { current(); return this.ctx.get('assistantPolicy')?.authorize(this.#deliveryPolicy(intent.security), { idempotencyKey: `external-action:${actionId}` }).effect === 'allow' } }
  }

  async #deliverExternalVerified(intent: DeliveryIntent, snapshot: VerifiedFiles, signal: AbortSignal): Promise<DeliveryOutcome> {
    const security = intent.security, authorization = this.#externalDeliveryAuthorization(intent, digest(snapshot))
    authorization.current()
    const grant = this.#externalGrants.get(security.grantId)!
    if (!grant.allowedOperations.includes('commit') || snapshot.files.some(file => !grant.destination.paths.includes(file.path))
      || intent.request.pullRequest && !grant.allowedOperations.includes('pull-request')) throw new Error('assistant-actions: external delivery not granted')
    const commitRequest = normalizeCommit({ grantId: grant.id, idempotencyKey: `${intent.id}:commit`, expectedHeadOid: intent.request.expectedHeadOid,
      headline: intent.request.headline, files: snapshot.files.map(file => ({ path: file.path, content: file.content })) })
    const committed = await this.#externalRequest(undefined, grant, grant.owner, 'commit', { expectedHeadOid: commitRequest.expectedHeadOid, headline: commitRequest.headline, files: commitRequest.files },
      signal, { callId: `${intent.id}:commit`, rootCallId: intent.id }, commitRequest.idempotencyKey, authorization)
    const commit = committed.result
    if (commit.status !== 'succeeded') return { commit }
    if (!committed.receipt || !commit.commitOid) return { commit: { ...commit, status: 'unknown', reason: 'external-delivery-receipt-unavailable' } }
    const brokerReceipts: NonNullable<DeliveryOutcome['brokerReceipts']> = { commit: committed.receipt }
    if (!intent.request.pullRequest) return { commit, brokerReceipts }
    authorization.current()
    const pr = normalizeWorkflow({ grantId: grant.id, idempotencyKey: `${intent.id}:pr`, expectedHeadOid: commit.commitOid, ...intent.request.pullRequest }) as PullRequestRequest
    const created = await this.#externalRequest(undefined, grant, grant.owner, 'pull-request', { expectedHeadOid: pr.expectedHeadOid, title: pr.title, body: pr.body },
      signal, { callId: `${intent.id}:pr`, rootCallId: intent.id }, pr.idempotencyKey, authorization)
    if (created.result.status === 'succeeded' && !created.receipt) return { commit, pullRequest: { ...created.result, status: 'unknown', reason: 'external-delivery-receipt-unavailable' }, brokerReceipts }
    return { commit, pullRequest: created.result, brokerReceipts: { ...brokerReceipts, ...(created.receipt ? { pullRequest: created.receipt } : {}) } }
  }

  #verifyExternalDelivery(intent: DeliveryIntent, outcome: DeliveryOutcome): void {
    this.#deliveryIdentity(intent.security)
    const grant = this.#externalGrants.get(intent.security.grantId)!, receipts = outcome.brokerReceipts
    const snapshot = this.#inspectDelivery(intent, true)
    if (!receipts?.commit || !snapshot || !outcome.commit.commitOid) throw new Error('assistant-actions: external delivery receipt unavailable')
    const destination = { classification: 'github-repository' as const, repository: grant.destination.repository, branch: grant.destination.branch,
      ...(grant.destination.baseBranch === undefined ? {} : { baseBranch: grant.destination.baseBranch }) }
    const common = { grantId: grant.id, grantRevision: grant.revision, grantDigest: grant.grantDigest, owner: grant.owner, sessionId: intent.security.sessionId, source: grant.source, destination }
    const commit = verifyExternalDeliveryReceipt(receipts.commit, { expectedHeadOid: intent.request.expectedHeadOid, headline: intent.request.headline,
      files: snapshot.files.map(file => ({ path: file.path, content: file.content })) },
    { ...common, operation: 'commit', actionId: this.#externalActionId(grant, intent.security.sessionId, 'commit', `${intent.id}:commit`) }, this.#external())
    if (commit.result?.operation !== 'commit' || commit.actionId !== outcome.commit.actionId || commit.result.commitOid !== outcome.commit.commitOid) throw new Error('assistant-actions: external delivery receipt changed')
    if (!intent.request.pullRequest) {
      if (outcome.pullRequest || receipts.pullRequest) throw new Error('assistant-actions: external delivery receipt changed')
      return
    }
    if (!receipts.pullRequest || !outcome.pullRequest) throw new Error('assistant-actions: external delivery receipt unavailable')
    const pr = verifyExternalDeliveryReceipt(receipts.pullRequest, { expectedHeadOid: outcome.commit.commitOid, ...intent.request.pullRequest },
      { ...common, operation: 'pull-request', actionId: this.#externalActionId(grant, intent.security.sessionId, 'pull-request', `${intent.id}:pr`) }, this.#external())
    if (pr.result?.operation !== 'pull-request' || pr.actionId !== outcome.pullRequest.actionId || pr.result.pullRequestNumber !== outcome.pullRequest.pullRequestNumber) throw new Error('assistant-actions: external delivery receipt changed')
  }

  async #deliverVerified(intent: DeliveryIntent, snapshot: VerifiedFiles, signal: AbortSignal) {
    const security = intent.security, frozen = digest(snapshot)
    if (this.#isExternalMode()) return await this.#deliverExternalVerified(intent, snapshot, signal)
    const authorization: Authorization = { sessionId: security.sessionId,
      identity: () => {
        const current = this.#inspectDelivery(intent)
        if (!current || digest(current) !== frozen) throw new Error('assistant-actions: accepted artifacts changed')
        return this.#deliveryIdentity(security)
      },
      authorize: record => this.ctx.get('assistantPolicy')?.authorize(this.#deliveryPolicy(security), { idempotencyKey: `action:${record.id}` }).effect === 'allow',
    }
    const request = normalizeCommit({ grantId: security.grantId, idempotencyKey: `${intent.id}:commit`, expectedHeadOid: intent.request.expectedHeadOid,
      headline: intent.request.headline, files: snapshot.files.map(file => ({ path: file.path, content: file.content })) })
    const commit = await this.#runAuthorized(authorization, request, signal, async (actionId, grant, token, combined) => this.commit({ actionId, grant, request, token, signal: combined }))
    if (commit.status !== 'succeeded' || !intent.request.pullRequest) return { commit }
    if (!commit.commitOid) return { commit, pullRequest: { actionId: intent.id, status: 'unknown' as const, reason: 'commit-oid-unavailable' } }
    const pr = normalizeWorkflow({ grantId: security.grantId, idempotencyKey: `${intent.id}:pr`, expectedHeadOid: commit.commitOid, ...intent.request.pullRequest }) as PullRequestRequest
    const pullRequest = await this.#runAuthorized(authorization, pr, signal, async (actionId, grant, token, combined) => this.workflow.pullRequest({ actionId, grant, expectedHeadOid: pr.expectedHeadOid, title: pr.title, body: pr.body, token, signal: combined }))
    return { commit, pullRequest }
  }

  #preauthorized(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      const request = normalizeCommit(execution.arguments as CommitRequest)
      const identity = this.#identity(execution.agent, request.grantId)
      if (this.#isExternalMode()) return this.#allowsExternal(this.#externalGrants.get(request.grantId), identity, request)
      const grant = this.#ledger.grant(request.grantId)
      return !!grant && !grant.verifiedDelivery && grant.expiresAt > Date.now() && grant.principalDigest === identity.principalDigest
        && grant.principalRecordId === identity.principalRecordId && grant.principalVersion === identity.principalVersion
        && grant.workspace === identity.workspace && grant.agentPreset === identity.agentPreset
        && request.files.every(file => grant.paths.includes(file.path)) && commitBytes(request) <= grant.maxTotalBytes
    } catch { return false }
  }

  #allows(grant: ActionGrant | undefined, identity: ActionIdentity, request: WorkflowRequest): boolean {
    if (!grant || grant.expiresAt <= Date.now() || digest(identity) !== digest({ principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: grant.workspace, agentPreset: grant.agentPreset })) return false
    if ('files' in request) return request.files.every(file => grant.paths.includes(file.path)) && commitBytes(request) <= grant.maxTotalBytes
    if ('baseHeadOid' in request) return grant.repoWorkflow?.allowBranchCreate === true
    if ('title' in request) return grant.repoWorkflow?.allowPullRequest === true
    return (request.kind !== 'file' || grant.paths.includes(request.path!)) && (!['pull-request', 'checks', 'reviews'].includes(request.kind) || !!grant.repoWorkflow)
  }

  #allowsExternal(grant: ExternalActionGrantMirror | undefined, identity: ActionIdentity, request: CommitRequest | InspectRequest): boolean {
    if (!grant || grant.expiresAt <= Date.now() || digest(identity) !== digest({ principalDigest: grant.owner.principalDigest, principalRecordId: grant.owner.principalRecordId, principalVersion: grant.owner.principalVersion, workspace: grant.owner.workspace, agentPreset: grant.owner.preset })) return false
    if ('files' in request) return !grant.verifiedDelivery && grant.allowedOperations.includes('commit') && request.files.every(file => grant.destination.paths.includes(file.path)) && commitBytes(request) <= grant.maxTotalBytes
    return grant.allowedOperations.includes('inspect') && grant.allowedInspectKinds.includes(request.kind) && (request.kind !== 'file' || grant.destination.paths.includes(request.path!))
      && (!['pull-request', 'checks', 'reviews'].includes(request.kind) || typeof grant.destination.baseBranch === 'string')
  }

  #preauthorizedWorkflow(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      const input = execution.arguments
      if (!input || typeof input !== 'object' || Array.isArray(input)) return false
      const request = normalizeWorkflow(execution.name === 'action_github_inspect' ? { ...input, operation: 'inspect', idempotencyKey: 'preauthorization' } : input)
      if (this.#isExternalMode()) return 'operation' in request && this.#allowsExternal(this.#externalGrants.get(request.grantId), this.#identity(execution.agent, request.grantId), request)
      if (!('operation' in request) && this.#ledger.grant(request.grantId)?.verifiedDelivery) return false
      return this.#allows(this.#ledger.grant(request.grantId), this.#identity(execution.agent, request.grantId), request)
    } catch { return false }
  }

  #preauthorizedCompensation(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted) return false
      const request = normalizeCompensation(execution.arguments as CompensationRequest)
      const identity = this.#compensationIdentity(execution.agent, request.grantId)
      const forward = this.#ledger.get(request.forwardActionId)
      return !!forward && forward.kind === 'commit' && forward.status === 'succeeded' && forward.sessionId === String(execution.agent?.session.id)
        && forward.grantId === request.grantId && forward.version === request.forwardActionVersion
        && forward.requestDigest === request.forwardRequestDigest && forward.result?.commitOid === request.forwardCommitOid
        && digest(forward.identity) === digest(identity)
    } catch { return false }
  }

  #preauthorizedCompensationStatus(execution: ToolExecution): boolean {
    try {
      if (execution.signal.aborted || !execution.arguments || typeof execution.arguments !== 'object' || Array.isArray(execution.arguments)
        || Object.keys(execution.arguments).length !== 2) return false
      const { grantId, actionId } = execution.arguments as { grantId?: unknown; actionId?: unknown }
      if (typeof grantId !== 'string' || typeof actionId !== 'string') return false
      const identity = this.#compensationIdentity(execution.agent, grantId)
      const record = this.#ledger.getCompensation(actionId)
      return !!record && record.grantId === grantId && record.sessionId === String(execution.agent?.session.id) && digest(record.identity) === digest(identity)
    } catch { return false }
  }

  run = async (agent: Agent | undefined, input: CommitRequest, signal: AbortSignal): Promise<ActionResult> => {
    const request = normalizeCommit(input)
    if (this.#isExternalMode()) { const callId = `api:${brokerDigest(request.idempotencyKey)}`; return await this.#runExternal(agent, request, signal, { callId, rootCallId: callId }) }
    if (this.#ledger.grant(request.grantId)?.verifiedDelivery) throw new Error('assistant-actions: this grant requires independently verified delivery')
    return await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => await this.commit({ actionId, grant, request, token, signal: combined }))
  }

  runCompensation = async (agent: Agent | undefined, input: CompensationRequest, signal: AbortSignal): Promise<CompensationStatus> => {
    if (this.#isExternalMode()) throw new Error(EXTERNAL_UNSUPPORTED)
    signal.throwIfAborted()
    const request = normalizeCompensation(input)
    const identity = this.#compensationIdentity(agent, request.grantId)
    const sessionId = String(agent?.session.id)
    const { record } = this.#ledger.prepareCompensation({ identity, sessionId, request, authority: this.#authority })
    const terminal = this.#publicCompensation(record)
    if (terminal) return terminal
    const current = this.#pendingCompensations.get(record.id)
    if (current) return this.#publicCompensationResult(await current.done)
    const abort = new AbortController()
    const done = this.#executeCompensation(agent, identity, record, AbortSignal.any([signal, abort.signal]))
    this.#pendingCompensations.set(record.id, { abort, done })
    try {
      const result = await done
      if (digest(this.#compensationIdentity(agent, request.grantId)) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return this.#publicCompensationResult(result)
    } finally { this.#pendingCompensations.delete(record.id) }
  }

  compensationStatus = (agent: Agent | undefined, input: { grantId: string; actionId: string }): CompensationStatus | { status: 'not-found' } => {
    if (this.#isExternalMode()) throw new Error(EXTERNAL_UNSUPPORTED)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
      || typeof input.grantId !== 'string' || typeof input.actionId !== 'string') throw new Error('assistant-actions: invalid compensation status request')
    const identity = this.#compensationIdentity(agent, input.grantId)
    const record = this.#ledger.getCompensation(input.actionId)
    if (!record) return { status: 'not-found' }
    if (record.grantId !== input.grantId || record.sessionId !== String(agent?.session.id) || digest(record.identity) !== digest(identity)) throw new Error('assistant-actions: compensation status denied')
    return this.#publicCompensation(record) ?? { actionId: record.id, status: record.status, repository: record.repository, branch: record.branch, parentOid: record.forwardCommitOid }
  }

  #publicCompensation(record: CompensationRecord): CompensationStatus | undefined {
    if (!record.result) return undefined
    return this.#publicCompensationResult(record.result)
  }

  #publicCompensationResult(result: CompensationResult): CompensationStatus {
    return Object.freeze({ actionId: result.actionId, status: result.status, repository: result.repository, branch: result.branch, parentOid: result.parentOid,
      ...(result.resultOid === undefined ? {} : { resultOid: result.resultOid }), ...(result.reason === undefined ? {} : { reason: result.reason }) })
  }

  async #executeCompensation(agent: Agent | undefined, identity: ActionIdentity, initial: CompensationRecord, signal: AbortSignal): Promise<CompensationResult> {
    let record = initial
    // Two-phase rollback budget: capacity is reserved before the preimage is
    // captured and only charged (finalized) once the local dispatch boundary
    // is crossed. A failure before dispatch releases the hold, so a denied or
    // failed attempt cannot permanently burn the subject's rollback budget.
    let reservation: { reservationId: string; amount: number } | undefined
    let reservationSettled = false
    let dispatched = false
    const abort = new AbortController()
    const stillAuthorized = (): boolean => {
      try {
        const grant = this.#ledger.grant(record.grantId)
        return !signal.aborted && !!grant?.rollback?.allowRollback && grant.revision === record.grantRevision && grant.expiresAt > Date.now()
          && digest(this.#compensationIdentity(agent, record.grantId)) === digest(identity)
      } catch { return false }
    }
    const timer = setInterval(() => { if (!stillAuthorized()) abort.abort() }, 100); timer.unref()
    try {
      const grant = this.#ledger.grant(record.grantId)
      const credentials = this.ctx.get('credentialsKeychain')
      if (!grant || !credentials || !stillAuthorized()) throw new Error('assistant-actions: compensation unavailable')
      // Accepts a fresh reservation for a capturing row and an open replay when
      // resuming a prepared row; a released/finalized replay is denied.
      reservation = this.#reserveCompensation(agent, record)
      if (!reservation) throw new Error('assistant-actions: compensation budget denied')
      return await credentials.withSecret(this.ctx, { handleId: grant.credentialHandle, purpose: 'github.compensate', idempotencyKey: `compensation:${record.id}`, ttlMs: Math.min(30_000, record.expiresAt - Date.now()) }, async (token, credentialSignal) => {
        const combined = AbortSignal.any([signal, abort.signal, credentialSignal, AbortSignal.timeout(Math.max(1, record.expiresAt - Date.now()))])
        combined.throwIfAborted()
        if (!stillAuthorized()) throw new Error('assistant-actions: compensation authorization ended')
        if (record.status === 'capturing') {
          const preimage = await this.compensation.capture({ grant, commitOid: record.parentOid, paths: record.paths, token, signal: combined })
          if (!preimage || !stillAuthorized() || combined.aborted) throw new Error('assistant-actions: compensation capture unavailable')
          record = this.#ledger.captureCompensation(record.id, record.version, preimage, this.#authority)
        }
        if (record.status !== 'prepared' || !record.preimage) throw new Error('assistant-actions: compensation is not dispatchable')
        // Re-decide and confirm the same open reservation still holds before the
        // local dispatch flip that authorizes the network POST.
        if (!stillAuthorized() || !this.#reserveCompensation(agent, record, reservation!.reservationId)) throw new Error('assistant-actions: compensation authorization ended')
        record = this.#ledger.dispatchCompensation(record.id, record.version, this.#authority)
        dispatched = true
        let outcome: CompensationResult
        try {
          outcome = await this.compensation.commit({ actionId: record.id, grant, forwardCommitOid: record.forwardCommitOid, preimage: record.preimage!, token, signal: combined })
          if (!stillAuthorized() || combined.aborted) outcome = { actionId: record.id, status: 'unknown', repository: record.repository, branch: record.branch, parentOid: record.forwardCommitOid, actionMarker: `dsh-compensation:${record.id}`, reason: 'authorization-ended-after-dispatch' }
        } catch {
          outcome = { actionId: record.id, status: 'unknown', repository: record.repository, branch: record.branch, parentOid: record.forwardCommitOid, actionMarker: `dsh-compensation:${record.id}`, reason: 'dispatch-unconfirmed-no-replay' }
        }
        const settled = this.#ledger.settleCompensation(record.id, record.version, outcome, this.#authority).result!
        // The dispatch boundary is behind us and the POST may already have
        // landed (every terminal outcome, including head-conflict and unknown,
        // is a real attempt). Charge the reservation; never release it here.
        try {
          this.ctx.get('assistantPolicy')?.finalize(reservation!.reservationId, reservation!.amount)
          reservationSettled = true
        } catch (error) {
          // A failed finalize leaves a conservative reserved hold (fails closed
          // until the budget period rolls); never mask the settled compensation.
          throw new Error(`assistant-actions: compensation budget finalize failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return settled
      })
    } catch (error) {
      if (reservation && !reservationSettled) {
        try {
          const policy = this.ctx.get('assistantPolicy')
          if (dispatched) policy?.finalize(reservation.reservationId, reservation.amount)
          else policy?.release(reservation.reservationId)
          reservationSettled = true
        } catch { /* A retained reserved hold fails closed; preserve the original error. */ }
      }
      if (!dispatched && record.status === 'capturing') {
        // A capturing row is only a pre-dispatch placeholder: no preimage was
        // sealed and no compensation POST could have been sent. Drop it so a
        // denial, abort or capture failure neither wedges the forward action's
        // one-compensation slot nor permanently consumes a rollback action.
        try { this.#ledger.discardCompensation(record.id, record.version, this.#authority) } catch {}
      } else if (!dispatched && record.status === 'prepared') {
        // A preimage was sealed but the dispatch flip never happened, so no
        // POST could have landed. Terminalize to unknown live (the same
        // no-replay outcome crash recovery would assign) rather than leaving a
        // zombie 'prepared' that only the next process restart clears. The open
        // reservation for this never-dispatched row is released above.
        try { this.#ledger.abandonPreparedCompensation(record.id, record.version, this.#authority, 'authorization-ended-before-dispatch') } catch {}
      }
      throw error
    } finally { clearInterval(timer) }
  }

  async #runWorkflow(agent: Agent | undefined, request: WorkflowRequest, signal: AbortSignal, operation: Operation): Promise<ActionResult> {
    return await this.#runAuthorized({ sessionId: String(agent?.session.id),
      identity: () => this.#identity(agent, request.grantId),
      authorize: record => this.ctx.get('assistantPolicy')?.authorizeAgent(agent, 'execute', { kind: 'tool', id: `action:github:${record.grantId}` }, { idempotencyKey: `action:${record.id}` }).effect === 'allow',
    }, request, signal, operation)
  }

  async #runAuthorized(authorization: Authorization, request: WorkflowRequest, signal: AbortSignal, operation: Operation): Promise<ActionResult> {
    signal.throwIfAborted()
    const identity = authorization.identity()
    if (!this.#allows(this.#ledger.grant(request.grantId), identity, request)) throw new Error('assistant-actions: request not granted')
    const bytes = 'files' in request ? commitBytes(request) : Buffer.byteLength(JSON.stringify(request))
    const { record, created } = this.#ledger.prepare({ identity, sessionId: authorization.sessionId, request, bytes, authority: this.#authority })
    if (!created) {
      const pending = this.#pending.get(record.id)
      const result = pending ? await pending.done : record.result ?? { actionId: record.id, status: 'unknown' as const, reason: 'action-in-progress-no-replay' }
      if (digest(authorization.identity()) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return structuredClone(result)
    }
    const abort = new AbortController()
    const done = this.#execute(authorization, identity, record, operation, AbortSignal.any([signal, abort.signal]))
    this.#pending.set(record.id, { abort, done })
    try {
      const result = await done
      if (digest(authorization.identity()) !== digest(identity)) throw new Error('assistant-actions: owner changed')
      return structuredClone(result)
    } finally { this.#pending.delete(record.id) }
  }

  async #execute(authorization: Authorization, identity: ActionIdentity, initial: ActionRecord, operation: Operation, signal: AbortSignal): Promise<ActionResult> {
    let record = initial
    const abort = new AbortController()
    const authorized = (): boolean => {
      try { return !signal.aborted && this.#ledger.usable(record.id) && digest(authorization.identity()) === digest(identity) } catch { return false }
    }
    const timer = setInterval(() => { if (!authorized()) abort.abort() }, 100); timer.unref()
    let result: ActionResult = { actionId: record.id, status: 'failed', reason: 'preparation-failed' }
    try {
      const grant = this.#ledger.grant(record.grantId)
      const credentials = this.ctx.get('credentialsKeychain')
      if (!grant || !credentials || !authorized()) throw new Error('unavailable')
      if (!authorization.authorize(record)) throw new Error('policy budget denied')
      result = await credentials.withSecret(this.ctx, { handleId: grant.credentialHandle, purpose: 'github.commit', idempotencyKey: `action:${record.id}`, ttlMs: Math.min(30_000, record.expiresAt - Date.now()) }, async (token, credentialSignal) => {
        const combined = AbortSignal.any([signal, abort.signal, credentialSignal, AbortSignal.timeout(Math.max(1, record.expiresAt - Date.now()))])
        combined.throwIfAborted()
        if (!authorized()) throw new Error('authorization ended')
        record = this.#ledger.dispatch(record.id, record.version, this.#authority)
        const outcome = await operation(record.id, grant, token, combined)
        return authorized() && !combined.aborted ? outcome : { actionId: record.id, status: 'unknown', reason: 'authorization-ended-after-dispatch' }
      })
    } catch {
      if (record.status === 'dispatched') result = { actionId: record.id, status: 'unknown', reason: 'dispatch-unconfirmed-no-replay' }
    } finally { clearInterval(timer) }
    this.#ledger.settle(record.id, record.version, result, this.#authority)
    return result
  }

  runBranch = async (agent: Agent | undefined, input: BranchRequest, signal: AbortSignal): Promise<ActionResult> => {
    if (this.#isExternalMode()) throw new Error(EXTERNAL_UNSUPPORTED)
    const request = normalizeWorkflow(input)
    if (this.#ledger.grant(request.grantId)?.verifiedDelivery) throw new Error('assistant-actions: this grant requires independently verified delivery')
    if (!('baseHeadOid' in request)) throw new Error('assistant-actions: invalid branch request')
    return await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => await this.workflow.branch({ actionId, grant, baseHeadOid: request.baseHeadOid, token, signal: combined }))
  }

  runPullRequest = async (agent: Agent | undefined, input: PullRequestRequest, signal: AbortSignal): Promise<ActionResult> => {
    if (this.#isExternalMode()) throw new Error(EXTERNAL_UNSUPPORTED)
    const request = normalizeWorkflow(input)
    if (this.#ledger.grant(request.grantId)?.verifiedDelivery) throw new Error('assistant-actions: this grant requires independently verified delivery')
    if (!('title' in request)) throw new Error('assistant-actions: invalid pull request')
    return await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => await this.workflow.pullRequest({ actionId, grant, expectedHeadOid: request.expectedHeadOid, title: request.title, body: request.body, token, signal: combined }))
  }

  runInspect = async (agent: Agent | undefined, input: InspectRequest, signal: AbortSignal): Promise<{ result: ActionResult; observed?: unknown }> => {
    if (this.#isExternalMode()) { const callId = `api:${randomUUID()}`; return await this.#runExternalInspect(agent, input, signal, { callId, rootCallId: callId }) }
    // Each read is a distinct, durably charged action, never a synthetic write.
    const request = normalizeWorkflow({ ...input, operation: 'inspect', idempotencyKey: randomUUID() })
    if (!('operation' in request)) throw new Error('assistant-actions: invalid inspection')
    let observed: unknown
    const result = await this.#runWorkflow(agent, request, signal, async (actionId, grant, token, combined) => {
      const reply = await this.workflow.inspect({ grant, kind: request.kind, ...(request.path === undefined ? {} : { path: request.path }), ...(request.pullRequestNumber === undefined ? {} : { pullRequestNumber: request.pullRequestNumber }), token, signal: combined })
      observed = reply?.observed
      return reply ? { actionId, status: 'succeeded' } : { actionId, status: 'failed', reason: 'github-inspect-failed' }
    })
    // A late response after revocation must not release repository content.
    return { result, ...(result.status === 'succeeded' ? { observed } : {}) }
  }

  #allowsGeneralizedToolExecution(execution: ToolExecution): boolean {
    if (!GENERALIZED_TOOL_NAMES.has(execution.name)) return false
    const header = execution.agent?.session.header
    if (!header || this.#actionGrants.size === 0) return false
    const now = Date.now()
    const domain = GENERALIZED_TOOL_DOMAINS[execution.name]
    const matchingGrant = [...this.#actionGrants.values()].some(grant =>
      grant.expiresAt > now
      && grant.owner.workspace === header.cwd
      && grant.owner.preset === header.agentPreset
      && (domain === undefined || grant.domain === domain))
    if (!matchingGrant) return false
    return this.ctx.get('assistantPolicy')?.evaluateAgent(execution.agent, 'execute', { kind: 'tool', id: execution.name }).effect === 'allow'
  }

  #registerGeneralizedTools(runtime: Context): void {
    const tools = runtime.get('tools') as { register(def: unknown): unknown } | undefined
    if (!tools) return
    const output = {
      schema: { type: 'object' as const, additionalProperties: false as const, properties: { result: { type: 'string' as const, required: true as const } } },
      render: (_args: unknown, value: { result: string }) => [{ type: 'text' as const, text: value.result }],
    }

    // Never call assistantPolicy.registerPreauthorizedTool for generalized tools
    // because assistant-policy enforces a strict 9-tool GitHub allowlist.
    tools.register(defineTool({
      name: 'action_broker_grants',
      description: 'List currently owner-authorized generalized action grants (HTTP, Lark, Calendar, Shell). No credentials are returned.',
      parameters: {},
      output,
      execute: async (_args, execution) => ({ result: JSON.stringify(this.listActionGrants(execution.agent)) }),
    }))

    tools.register(defineTool({
      name: 'action_http_request',
      description: 'Execute a bounded, grant-scoped HTTP request through the action broker guard.',
      parameters: {
        grantId: { type: 'string', required: true },
        idempotencyKey: { type: 'string', required: true },
        method: { type: 'string', required: true },
        url: { type: 'string', required: true },
        headers: { type: 'object', additionalProperties: true },
        body: { type: 'string' },
        expectedResponseSha256: { type: 'string' },
      },
      output,
      execute: async (args, execution) => {
        const urlStr = String(args.url ?? '')
        const parsed = new URL(urlStr)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('assistant-actions: action_http_request URL must use http or https')
        }
        return {
          result: JSON.stringify(await this.executeAction(execution.agent, {
            grantId: String(args.grantId ?? ''),
            idempotencyKey: String(args.idempotencyKey ?? ''),
            domain: 'http',
            operation: 'http.request',
            destination: {
              classification: 'http-endpoint',
              scheme: parsed.protocol === 'https:' ? 'https' : 'http',
              host: parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase(),
              ...(parsed.port ? { port: Number(parsed.port) } : {}),
              path: parsed.pathname,
            },
            payload: {
              method: String(args.method ?? 'GET') as HttpRequestPayload['method'],
              url: urlStr,
              ...(args.headers && typeof args.headers === 'object' ? { headers: args.headers as Record<string, string> } : {}),
              ...(typeof args.body === 'string' ? { body: args.body } : {}),
              ...(typeof args.expectedResponseSha256 === 'string' ? { expectedResponseSha256: args.expectedResponseSha256 } : {}),
            },
          }, execution.signal)),
        }
      },
    }))

    tools.register(defineTool({
      name: 'action_lark_action',
      description: 'Execute a bounded, grant-scoped Lark messaging action.',
      parameters: {
        grantId: { type: 'string', required: true },
        idempotencyKey: { type: 'string', required: true },
        operation: { type: 'string', required: true },
        tenantKey: { type: 'string', required: true },
        receiveIdType: { type: 'string', required: true },
        receiveId: { type: 'string', required: true },
        payload: { type: 'object', required: true, additionalProperties: true },
      },
      output,
      execute: async (args, execution) => ({
        result: JSON.stringify(await this.executeAction(execution.agent, {
          grantId: String(args.grantId ?? ''),
          idempotencyKey: String(args.idempotencyKey ?? ''),
          domain: 'lark',
          operation: String(args.operation ?? '') as 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
          destination: {
            classification: 'lark-workspace',
            tenantKey: String(args.tenantKey ?? ''),
            receiveIdType: String(args.receiveIdType ?? '') as 'chat_id' | 'open_id',
            receiveId: String(args.receiveId ?? ''),
          },
          payload: args.payload as unknown as LarkSendPayload | LarkReadPayload,
        }, execution.signal)),
      }),
    }))

    tools.register(defineTool({
      name: 'action_calendar_action',
      description: 'Execute a bounded, grant-scoped Calendar read or mutation action.',
      parameters: {
        grantId: { type: 'string', required: true },
        idempotencyKey: { type: 'string', required: true },
        operation: { type: 'string', required: true },
        provider: { type: 'string', required: true },
        calendarId: { type: 'string', required: true },
        payload: { type: 'object', required: true, additionalProperties: true },
      },
      output,
      execute: async (args, execution) => ({
        result: JSON.stringify(await this.executeAction(execution.agent, {
          grantId: String(args.grantId ?? ''),
          idempotencyKey: String(args.idempotencyKey ?? ''),
          domain: 'calendar',
          operation: String(args.operation ?? '') as 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
          destination: {
            classification: 'calendar-scope',
            provider: String(args.provider ?? '') as 'lark-calendar' | 'caldav' | 'google-calendar',
            calendarId: String(args.calendarId ?? ''),
          },
          payload: args.payload as unknown as CalendarActionPayload,
        }, execution.signal)),
      }),
    }))

    tools.register(defineTool({
      name: 'action_shell_exec',
      description: 'Execute an explicitly allowlisted command with shell: false under a bounded cwd and env.',
      parameters: {
        grantId: { type: 'string', required: true },
        idempotencyKey: { type: 'string', required: true },
        executable: { type: 'string', required: true },
        args: { type: 'array', required: true, items: { type: 'string' } },
        cwd: { type: 'string', required: true },
        env: { type: 'object', additionalProperties: true },
        stdin: { type: 'string' },
        timeoutMs: { type: 'number', required: true },
      },
      output,
      execute: async (args, execution) => {
        const executable = String(args.executable ?? '')
        const cwd = String(args.cwd ?? '')
        return {
          result: JSON.stringify(await this.executeAction(execution.agent, {
            grantId: String(args.grantId ?? ''),
            idempotencyKey: String(args.idempotencyKey ?? ''),
            domain: 'shell',
            operation: 'shell.exec',
            destination: { classification: 'shell-command', executable, cwd },
            payload: {
              executable,
              args: Array.isArray(args.args) ? args.args.map(item => String(item)) : [],
              cwd,
              ...(args.env && typeof args.env === 'object' ? { env: args.env as Record<string, string> } : {}),
              ...(typeof args.stdin === 'string' ? { stdin: args.stdin } : {}),
              timeoutMs: Number(args.timeoutMs ?? 0),
            },
          }, execution.signal)),
        }
      },
    }))
  }

  #actionContext(agent: Agent | undefined, grantId: string): { grant: ActionBrokerGrantProjection; owner: BrokerRequestIntent['owner'] } {
    if (!this.#active) throw new Error('assistant-actions: service inactive')
    if (!agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-actions: exact live agent required')
    const attestation = this.ctx.get('assistantDelivery')?.preferencePrincipalForAgent(agent)
    const grant = this.#actionGrants.get(grantId)
    if (!attestation || !grant || grant.expiresAt <= Date.now() || attestation.sessionId !== String(agent.session.id)
      || attestation.scope.workspace !== agent.session.header.cwd || attestation.scope.preset !== agent.session.header.agentPreset) {
      throw new Error('assistant-actions: authenticated owner required')
    }
    const owner: BrokerRequestIntent['owner'] = {
      principalDigest: principalDigest(attestation.principalId),
      ...attestation.principalLineage,
      workspace: attestation.scope.workspace,
      preset: attestation.scope.preset,
      bindingId: attestation.bindingId,
      bindingVersion: attestation.bindingVersion,
      bindingGeneration: attestation.bindingGeneration,
    }
    if (digest(owner) !== digest(grant.owner) || grant.sessionId !== String(agent.session.id)) {
      throw new Error('assistant-actions: action grant projection does not match current owner')
    }
    return { grant, owner }
  }

  listActionGrants = (agent?: Agent): readonly ActionBrokerGrantProjection[] => {
    const now = Date.now()
    const out: ActionBrokerGrantProjection[] = []
    for (const grant of this.#actionGrants.values()) {
      if (grant.expiresAt <= now) continue
      if (agent) {
        try {
          this.#actionContext(agent, grant.id)
          out.push(grant)
        } catch {
          // Omit grants not owned by this agent
        }
      } else {
        out.push(grant)
      }
    }
    return Object.freeze(out)
  }

  executeAction = async (
    agent: Agent | undefined,
    input: GeneralizedActionExecutionInput,
    signal: AbortSignal,
  ): Promise<GeneralizedActionExecutionResult> => {
    signal.throwIfAborted()
    const { grant, owner } = this.#actionContext(agent, input.grantId)
    if (grant.domain !== input.domain || !grant.allowedOperations.includes(input.operation)) {
      throw new Error('assistant-actions: action operation is not granted')
    }
    if (input.sensitivity !== undefined && !isBrokerSensitivity(input.sensitivity)) {
      throw new Error('assistant-actions: WP08 policy rejected (invalid-input)')
    }
    if (input.estimatedCostMicros !== undefined && (!Number.isSafeInteger(input.estimatedCostMicros) || input.estimatedCostMicros < 0 || Object.is(input.estimatedCostMicros, -0))) {
      throw new Error('assistant-actions: WP08 policy rejected (invalid-input)')
    }
    const effectiveSensitivity: BrokerSensitivity = input.sensitivity !== undefined
      && sensitivityRank(input.sensitivity) > sensitivityRank(grant.source.classification)
      ? input.sensitivity
      : grant.source.classification
    const now = Date.now()
    const actionId = brokerDigest({
      protocol: ACTION_ID_PROTOCOL,
      grantId: grant.id,
      grantRevision: grant.revision,
      sessionId: String(agent!.session.id),
      domain: input.domain,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
    })
    const requestDigest = brokerDigest({
      grantId: grant.id,
      grantRevision: grant.revision,
      domain: input.domain,
      operation: input.operation,
      destination: input.destination,
      payload: input.payload,
      sensitivity: effectiveSensitivity,
      estimatedCostMicros: input.estimatedCostMicros ?? null,
      commitDigest: input.commitDigest ?? null,
      predecessorDigest: input.predecessorDigest ?? null,
    })

    if (grant.lease?.revoked === true) {
      throw new Error('assistant-actions: WP08 policy rejected (lease-revoked)')
    }
    if (grant.lease?.expiresAtMs !== undefined && now >= grant.lease.expiresAtMs) {
      throw new Error('assistant-actions: WP08 policy rejected (lease-expired)')
    }

    const settled = this.#settledActions.get(actionId)
    if (settled !== undefined) {
      if (settled.requestDigest !== requestDigest) {
        throw new Error('assistant-actions: action idempotency conflict')
      }
      return structuredClone(settled.result)
    }
    const pendingAction = this.#pendingActions.get(actionId)
    if (pendingAction !== undefined) {
      if (pendingAction.requestDigest !== requestDigest) {
        throw new Error('assistant-actions: action idempotency conflict')
      }
      return structuredClone(await pendingAction.done)
    }

    const done = (async (): Promise<GeneralizedActionExecutionResult> => {
      const isExternal = this.#isExternalMode() && !!this.#externalActionClient
      if (input.domain === 'http') {
        validateHttpAgainstGrant(
          grant.destination as HttpGrantDestination,
          input.destination as HttpRequestDestination,
          input.payload as HttpRequestPayload,
        )
      } else if (input.domain === 'lark') {
        validateLarkAgainstGrant(
          input.operation as 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
          grant.destination as LarkGrantDestination,
          input.destination as LarkRequestDestination,
          input.payload as LarkSendPayload | LarkReadPayload,
        )
      } else if (input.domain === 'calendar') {
        validateCalendarAgainstGrant(
          input.operation as 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
          grant.destination as CalendarGrantDestination,
          input.destination as CalendarRequestDestination,
          input.payload as CalendarActionPayload,
          now,
        )
      } else if (input.domain === 'shell') {
        if (isExternal) {
          validateShellPolicyAgainstGrant(
            grant.destination as ShellGrantDestination,
            input.destination as ShellRequestDestination,
            input.payload as ShellExecPayload,
          )
        } else {
          await validateShellAgainstGrant(
            grant.destination as ShellGrantDestination,
            input.destination as ShellRequestDestination,
            input.payload as ShellExecPayload,
          )
        }
      } else {
        throw new Error('assistant-actions: github domain uses dedicated GitHub methods')
      }

      const externalPayloadBytes = isExternal && this.#externalActionClient
        ? Buffer.byteLength(canonicalBrokerJson(input.payload), 'utf8')
        : undefined

      const destinationStr = resolveWp08DestinationString(input.domain, input.destination, input.payload)
      const usage = this.#wp08Usage.get(grant.id) ?? { leaseUses: 0, spentCostMicros: 0 }
      if (input.estimatedCostMicros !== undefined && (!Number.isSafeInteger(input.estimatedCostMicros) || input.estimatedCostMicros < 0 || Object.is(input.estimatedCostMicros, -0))) {
        throw new Error('assistant-actions: WP08 policy rejected (invalid-input)')
      }
      const costDelta = input.estimatedCostMicros !== undefined && Number.isSafeInteger(input.estimatedCostMicros) && input.estimatedCostMicros >= 0 && !Object.is(input.estimatedCostMicros, -0)
        ? input.estimatedCostMicros
        : 0
      const nextSpentCostMicros = usage.spentCostMicros + costDelta
      if (!Number.isSafeInteger(nextSpentCostMicros) || nextSpentCostMicros < 0) {
        throw new Error('assistant-actions: WP08 policy rejected (invalid-input)')
      }

      const constraints: BrokerWp08Constraints | undefined =
        grant.lease !== undefined || grant.destinations !== undefined || grant.maxSensitivity !== undefined || grant.monetaryCostCapMicros !== undefined || grant.commitDigest !== undefined
          ? {
            ...(grant.lease === undefined ? {} : { lease: grant.lease }),
            ...(grant.destinations === undefined ? {} : { destinations: grant.destinations }),
            ...(grant.maxSensitivity === undefined ? {} : { maxSensitivity: grant.maxSensitivity }),
            ...(grant.monetaryCostCapMicros === undefined ? {} : { monetaryCostCapMicros: grant.monetaryCostCapMicros }),
            ...(grant.commitDigest === undefined ? {} : { commitDigest: grant.commitDigest }),
          }
          : undefined
      const policy = this.ctx.get('assistantPolicy')
      const policyIdempotencyKey = `action-v2:${actionId}`
      const policyEval = authorizeAgentWithWp08(
        policy,
        agent,
        'execute',
        { kind: 'tool', id: `action:${grant.domain}:${grant.id}` },
        {
          idempotencyKey: policyIdempotencyKey,
          destination: destinationStr,
          sensitivity: effectiveSensitivity,
          ...(input.estimatedCostMicros === undefined ? {} : { estimatedCostMicros: input.estimatedCostMicros }),
          ...(input.commitDigest === undefined ? {} : { commitDigest: input.commitDigest }),
          ...(input.predecessorDigest === undefined ? {} : { predecessorDigest: input.predecessorDigest }),
        },
        constraints,
        usage,
        now,
      )
      if (!policyEval.wp08.allowed) {
        throw new Error(`assistant-actions: WP08 policy rejected (${policyEval.wp08.reasonCode})`)
      }
      if (policyEval.effect !== 'allow') {
        throw new Error('assistant-actions: external action policy denied')
      }

      const nextUsage = {
        leaseUses: usage.leaseUses + 1,
        spentCostMicros: nextSpentCostMicros,
        ...(usage.lastSettledCommitDigest ? { lastSettledCommitDigest: usage.lastSettledCommitDigest } : {}),
      }
      this.#wp08Usage.set(grant.id, nextUsage)

      const rollbackPolicy = (): void => {
        const port = policy as Partial<BrokerPolicyServicePort> | undefined
        if (typeof port?.rollbackPreDispatchAuthorization !== 'function') return
        port.rollbackPreDispatchAuthorization({
          idempotencyKey: policyIdempotencyKey,
          ...(policyEval.policyDecision?.decisionId === undefined ? {} : { decisionId: policyEval.policyDecision.decisionId }),
          ...(policyEval.policyDecision?.ruleId === undefined ? {} : { ruleId: policyEval.policyDecision.ruleId }),
          ...(policyEval.policyDecision?.lease?.leaseId === undefined ? {} : { leaseId: policyEval.policyDecision.lease.leaseId }),
          ...(input.estimatedCostMicros === undefined ? {} : { estimatedCostMicros: input.estimatedCostMicros }),
          ...(input.commitDigest === undefined ? {} : { commitDigest: input.commitDigest }),
          auditDetails: { actionId, grantId: grant.id, domain: input.domain, operation: input.operation },
        })
      }

      const rollbackUsage = (): void => {
        const current = this.#wp08Usage.get(grant.id)
        if (!current) return
        const rolledUses = Math.max(0, current.leaseUses - 1)
        const safeCurrentCost = Number.isSafeInteger(current.spentCostMicros) && current.spentCostMicros >= 0 ? current.spentCostMicros : 0
        const rolledCost = Math.max(0, safeCurrentCost - costDelta)
        if (rolledUses === 0 && rolledCost === 0 && !current.lastSettledCommitDigest) {
          this.#wp08Usage.delete(grant.id)
        } else {
          this.#wp08Usage.set(grant.id, {
            leaseUses: rolledUses,
            spentCostMicros: rolledCost,
            ...(current.lastSettledCommitDigest ? { lastSettledCommitDigest: current.lastSettledCommitDigest } : {}),
          })
        }
      }
      const recordSettledDigest = (): void => {
        if (!input.commitDigest) return
        const current = this.#wp08Usage.get(grant.id)
        if (current) {
          this.#wp08Usage.set(grant.id, { ...current, lastSettledCommitDigest: input.commitDigest })
        }
      }

      if (isExternal && this.#externalActionClient) {
        const client = this.#externalActionClient
        let res: ActionBrokerServerResponse
        try {
          const costMetric = input.domain === 'http' ? 'http-requests'
            : input.domain === 'lark' ? 'lark-api-calls'
              : input.domain === 'calendar' ? 'calendar-api-calls'
                : input.domain === 'shell' ? 'shell-exec-units'
                  : 'github-api-units'
          const intent: ActionBrokerRequestIntent = {
            actionId,
            grantId: grant.id,
            grantRevision: grant.revision,
            grantDigest: grant.grantDigest,
            domain: input.domain,
            owner,
            sessionId: String(agent!.session.id),
            agentId: String(agent!.id),
            rootCallId: `api:${actionId}`,
            callId: `api:${actionId}`,
            operation: input.operation,
            source: grant.source,
            destination: input.destination,
            payload: input.payload,
            deadline: Math.min(grant.expiresAt, Date.now() + (client.timeoutMs ?? 30_000)),
            budget: {
              reservationId: actionId,
              actions: 1,
              bytes: externalPayloadBytes ?? 0,
              costMetric,
              maxCostUnits: 1,
              ...(input.estimatedCostMicros === undefined ? {} : { estimatedCostMicros: input.estimatedCostMicros }),
            },
            ...(input.estimatedCostMicros === undefined ? {} : { estimatedCostMicros: input.estimatedCostMicros }),
            ...(input.commitDigest === undefined ? {} : { commitDigest: input.commitDigest }),
            ...(input.predecessorDigest === undefined ? {} : { predecessorDigest: input.predecessorDigest }),
            idempotencyKey: input.idempotencyKey,
          }
          res = await this.#externalActionDispatch(client, intent, signal)
        } catch (error) {
          const preDispatch = error instanceof BrokerClientError
            ? !error.postDispatchUnknown
            : (typeof error !== 'object' || error === null || (
              (error as { postDispatchUnknown?: unknown }).postDispatchUnknown !== true
              && (error as { dispatched?: unknown }).dispatched !== true
            ))
          if (preDispatch) {
            rollbackUsage()
            rollbackPolicy()
          }
          throw error
        }
        const out: GeneralizedActionExecutionResult = {
          actionId: res.actionId,
          status: res.status,
          domain: input.domain,
          operation: input.operation,
          ...(res.result ? { result: res.result } : {}),
          ...(res.error ? { reason: `external-broker-${res.error.code}` } : {}),
        }
        if (!res.dispatched && res.status === 'failed') {
          rollbackUsage()
          rollbackPolicy()
        } else {
          if (res.status === 'succeeded') recordSettledDigest()
          this.#settledActions.set(actionId, { requestDigest, result: structuredClone(out) })
        }
        return out
      }

      const remainingMs = Math.max(1, Math.min(30_000, grant.expiresAt - Date.now()))
      try {
        let out: GeneralizedActionExecutionResult
        if (input.domain === 'http') {
          const result = await executeHttpGuardedAction({
            grantDestination: grant.destination as HttpGrantDestination,
            requestDestination: input.destination as HttpRequestDestination,
            payload: input.payload as HttpRequestPayload,
            ...(input.credentialToken === undefined ? {} : { token: input.credentialToken }),
            timeoutMs: remainingMs,
            signal,
          })
          recordSettledDigest()
          out = { actionId, status: 'succeeded', domain: 'http', operation: input.operation, result }
        } else if (input.domain === 'lark') {
          const result = await executeLarkGuardedAction({
            actionId,
            operation: input.operation as 'lark.send-message' | 'lark.reply-message' | 'lark.read-messages',
            grantDestination: grant.destination as LarkGrantDestination,
            requestDestination: input.destination as LarkRequestDestination,
            payload: input.payload as LarkSendPayload | LarkReadPayload,
            token: input.credentialToken ?? '',
            timeoutMs: remainingMs,
            signal,
          })
          recordSettledDigest()
          out = { actionId, status: 'succeeded', domain: 'lark', operation: input.operation, result }
        } else if (input.domain === 'calendar') {
          const result = await executeCalendarGuardedAction({
            operation: input.operation as 'calendar.list-events' | 'calendar.get-event' | 'calendar.create-event' | 'calendar.update-event' | 'calendar.delete-event',
            grantDestination: grant.destination as CalendarGrantDestination,
            requestDestination: input.destination as CalendarRequestDestination,
            payload: input.payload as CalendarActionPayload,
            token: input.credentialToken ?? '',
            timeoutMs: remainingMs,
            signal,
          })
          recordSettledDigest()
          out = { actionId, status: 'succeeded', domain: 'calendar', operation: input.operation, result }
        } else if (input.domain === 'shell') {
          const result = await executeShellGuardedAction({
            grantDestination: grant.destination as ShellGrantDestination,
            requestDestination: input.destination as ShellRequestDestination,
            payload: input.payload as ShellExecPayload,
            remainingLeaseMs: remainingMs,
            signal,
          })
          recordSettledDigest()
          out = { actionId, status: 'succeeded', domain: 'shell', operation: input.operation, result }
        } else {
          throw new Error('assistant-actions: github domain uses dedicated GitHub methods')
        }
        this.#settledActions.set(actionId, { requestDigest, result: structuredClone(out) })
        return out
      } catch (error) {
        if (
          (error instanceof HttpGuardError || error instanceof LarkGuardError || error instanceof CalendarGuardError || error instanceof ShellGuardError)
          && !error.dispatched
        ) {
          rollbackUsage()
          rollbackPolicy()
        }
        throw error
      }
    })()

    this.#pendingActions.set(actionId, { requestDigest, done })
    try {
      return structuredClone(await done)
    } finally {
      this.#pendingActions.delete(actionId)
    }
  }
}
