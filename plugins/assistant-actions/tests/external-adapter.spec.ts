import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin from '../src/index.ts'
import { validateConfig, type Config } from '../src/config.ts'
import { BrokerClientError, type GitHubBrokerClientOptions } from '../src/broker-client.ts'
import { GITHUB_BROKER_PROTOCOL, brokerDigest, type BrokerClientRequest, type BrokerGrantProjection, type BrokerServerResponse } from '../src/broker-protocol.ts'
import { AssistantActionsService, readPinnedKeyFile } from '../src/service.ts'
import type { ActionGrant } from '../src/types.ts'

type ExternalDispatch = (options: GitHubBrokerClientOptions, intent: import('../src/broker-protocol.ts').BrokerRequestIntent, signal?: AbortSignal) => Promise<BrokerServerResponse>
type MockExternalDispatch = ReturnType<typeof vi.fn<ExternalDispatch>>

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function ownerAgent(ctx: Context, workspace: string): Agent {
  const id = SessionId('external-owner-session')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const agent: Agent = { id, options: { provider: 'test', model: 'test' }, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context, status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(agent as unknown as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  session.append('turn/start', { turn: 1 }); session.append('approval/policy', { policy: 'ask' })
  return agent
}

async function keyFixture(root: string) {
  const keys = generateKeyPairSync('ed25519')
  const keyRoot = join(root, 'keys'); await mkdir(keyRoot, { mode: 0o700 }); await chmod(keyRoot, 0o700)
  const brokerPublicKeyPath = join(keyRoot, 'broker-public.pem'), clientSigningKeyPath = join(keyRoot, 'client-private.pem')
  await writeFile(brokerPublicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  await writeFile(clientSigningKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { brokerPublicKeyPath, clientSigningKeyPath }
}

function projection(root: string, overrides: Partial<BrokerGrantProjection> = {}): BrokerGrantProjection {
  return {
    id: 'external', revision: 1, grantDigest: 'a'.repeat(64),
    owner: { principalDigest: createHash('sha256').update('owner').digest('hex'), principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary', bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1 },
    sessionId: 'external-owner-session', destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main', paths: ['a.txt'] },
    expiresAt: Date.now() + 60_000, maxActions: 8, maxTotalBytes: 1_048_576, source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) }, maxCostUnits: 8,
    allowedOperations: ['commit', 'inspect'], allowedInspectKinds: ['repository', 'branch', 'file'], ...overrides,
  }
}

async function externalConfig(root: string, grants: readonly BrokerGrantProjection[] = [projection(root)]): Promise<Config> {
  const keys = await keyFixture(root)
  return { stateRoot: join(root, 'must-not-create-host-ledger'), externalGrants: grants, broker: { mode: 'external-unix-v1', actionSocketPath: join(root, 'broker.sock'), brokerId: 'broker-1',
    brokerPublicKeyPath: keys.brokerPublicKeyPath, clientKeyId: 'client-key-1', clientSigningKeyPath: keys.clientSigningKeyPath, clientInstanceId: 'host-1', clientGeneration: 3,
    expectedSocketUid: process.getuid!(), expectedSocketGid: process.getgid!(), expectedBrokerPeerUid: process.getuid!(), expectedBrokerPeerGid: process.getgid!() } }
}

function response(actionId: string, status: 'succeeded' | 'failed' | 'unknown', operation: 'commit' | 'inspect' = 'commit'): BrokerServerResponse {
  const result = status !== 'succeeded' ? null : operation === 'commit'
    ? { operation: 'commit' as const, repository: 'owner/repository', branch: 'main', parentOid: 'c'.repeat(40), commitOid: 'd'.repeat(40) }
    : { operation: 'inspect' as const, repository: 'owner/repository', branch: 'main', kind: 'repository' as const, observed: { full_name: 'owner/repository', untrusted: true } as const, observedDigest: brokerDigest({ full_name: 'owner/repository', untrusted: true }) }
  return { protocol: GITHUB_BROKER_PROTOCOL, type: 'server-response', requestId: 'request', actionId, instanceId: 'broker-1', generation: 1, challenge: Buffer.alloc(32).toString('base64url'), requestDigest: 'e'.repeat(64),
    status, dispatched: status !== 'failed', result, error: status === 'succeeded' ? null : { code: 'fixture-error' }, completedAt: Date.now(), signature: Buffer.alloc(64).toString('base64url') }
}

async function externalFixture(dispatch: MockExternalDispatch = vi.fn<ExternalDispatch>(async (_options, intent, _signal) => response(intent.actionId, 'succeeded'))) {
  const root = await mkdtemp(join(tmpdir(), 'actions-external-')), ctx = new Context(), agent = ownerAgent(ctx, root)
  const localCommit = vi.fn(), localWorkflow = { branch: vi.fn(), pullRequest: vi.fn(), inspect: vi.fn() }, localCompensation = { capture: vi.fn(), commit: vi.fn() }
  let policyAllowed = true
  const policy = { isPreauthorizedTool: () => true, registerPreauthorizedTool: () => () => {}, evaluateAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), authorizeAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }) }
  let currentBinding = 1
  const delivery = { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' }, bindingId: 'binding', bindingVersion: currentBinding, bindingGeneration: 1, sessionId: String(agent.id) }) }
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' })
  ctx.provide('agents' as never, { get: (id: string) => id === agent.id ? agent : undefined } as never)
  ctx.provide('assistantPolicy' as never, policy as never); ctx.provide('assistantDelivery' as never, delivery as never)
  const config = await externalConfig(root)
  const service = new AssistantActionsService(ctx, config, localCommit as never, localWorkflow as never, localCompensation as never, dispatch as never)
  await new Promise(resolve => setTimeout(resolve, 0))
  const cleanup = async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }; cleanups.push(cleanup)
  return { root, ctx, agent, service, config, dispatch, localCommit, localWorkflow, localCompensation, changeBinding: () => { currentBinding++ }, denyPolicy: () => { policyAllowed = false },
    execute: (name: string, args: object) => ctx.tools.execute({ callId: ToolCallId(`${name}-${Math.random()}`), name, arguments: args, signal: new AbortController().signal, agent }) }
}

describe('external broker configuration', () => {
  it('defaults to embedded compatibility and rejects mixed or malformed external authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actions-config-')); cleanups.push(async () => rm(root, { recursive: true, force: true }))
    expect(validateConfig({ stateRoot: join(root, 'state') }).broker.mode).toBe('embedded-compat')
    const external = await externalConfig(root)
    expect(validateConfig(external)).toMatchObject({ broker: { mode: 'external-unix-v1', requestTimeoutMs: 30_000, helloTtlMs: 30_000 }, grants: [] })
    const embeddedGrant: ActionGrant = { id: 'local', revision: 1, principalDigest: '1'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', repository: 'owner/repository', branch: 'main', paths: ['a.txt'], credentialHandle: 'secret', expiresAt: Date.now() + 1000, maxActions: 1, maxTotalBytes: 10 }
    expect(() => validateConfig({ ...external, grants: [embeddedGrant] })).toThrow(/invalid external broker config/)
    const [grant] = external.externalGrants!
    expect(() => validateConfig({ ...external, externalGrants: [{ ...grant!, allowedInspectKinds: ['checks'] }] })).toThrow(/invalid external grant projection/)
    expect(() => validateConfig({ stateRoot: join(root, 'state'), externalGrants: [grant!] })).toThrow(/external grants require external broker mode/)
  })

  it('rejects a key beneath an unsafe writable ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actions-key-ancestor-')); cleanups.push(async () => rm(root, { recursive: true, force: true }))
    const unsafe = join(root, 'unsafe'), keyRoot = join(unsafe, 'keys'), keyPath = join(keyRoot, 'client.pem')
    await mkdir(keyRoot, { recursive: true, mode: 0o700 }); await chmod(unsafe, 0o770); await chmod(keyRoot, 0o700)
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }); await writeFile(keyPath, key, { mode: 0o600 })
    expect(() => readPinnedKeyFile(keyPath, 'private')).toThrow(/unsafe key path ancestry/)
  })

  it('rejects replacement of the direct key parent after opening the key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actions-key-parent-race-')); cleanups.push(async () => rm(root, { recursive: true, force: true }))
    const keyRoot = join(root, 'keys'), moved = join(root, 'keys-old'), keyPath = join(keyRoot, 'client.pem')
    mkdirSync(keyRoot, { mode: 0o700 }); const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }); writeFileSync(keyPath, key, { mode: 0o600 })
    expect(() => readPinnedKeyFile(keyPath, 'private', { afterAncestorSnapshot() { renameSync(keyRoot, moved); mkdirSync(keyRoot, { mode: 0o700 }); writeFileSync(keyPath, key, { mode: 0o600 }) } })).toThrow(/key ancestor changed/)
  })
})

describe('external broker Host facade', () => {
  it('executes commit and bounded inspect without Keychain, Host ledger or local GitHub fallback', async () => {
    const dispatch = vi.fn<ExternalDispatch>(async (options, intent, _signal) => {
      expect(options.beforeWrite).toBeTypeOf('function')
      await options.beforeWrite!({} as never, intent as unknown as BrokerClientRequest, new AbortController().signal)
      return response(intent.actionId, 'succeeded', intent.operation)
    })
    const f = await externalFixture(dispatch)
    expect(f.ctx.tools.schemas().filter(tool => tool.name.startsWith('action_github_')).map(tool => tool.name).sort()).toEqual(['action_github_commit', 'action_github_grants', 'action_github_inspect'])
    const request = { grantId: 'external', idempotencyKey: 'same', expectedHeadOid: 'c'.repeat(40), headline: 'Commit', files: [{ path: 'a.txt', content: 'safe' }] }
    const first = await f.service.run(f.agent, request, new AbortController().signal)
    const second = await f.service.run(f.agent, request, new AbortController().signal)
    expect(first).toMatchObject({ status: 'succeeded', commitOid: 'd'.repeat(40) }); expect(second.actionId).toBe(first.actionId)
    const inspected = await f.service.runInspect(f.agent, { grantId: 'external', kind: 'repository' }, new AbortController().signal)
    expect(inspected).toMatchObject({ result: { status: 'succeeded' }, observed: { full_name: 'owner/repository', untrusted: true } })
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(dispatch.mock.calls[0]![1].callId).toMatch(/^api:[0-9a-f]{64}$/u)
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ owner: { bindingId: 'binding', bindingVersion: 1 }, operation: 'commit', budget: { actions: 1, maxCostUnits: 1 }, destination: { repository: 'owner/repository', branch: 'main' } })
    await expect(access(f.config.stateRoot!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.localCommit).not.toHaveBeenCalled(); expect(f.localWorkflow.branch).not.toHaveBeenCalled(); expect(f.localWorkflow.pullRequest).not.toHaveBeenCalled(); expect(f.localWorkflow.inspect).not.toHaveBeenCalled()
  })

  it('keeps direct API call identity bounded for the longest accepted idempotency key', async () => {
    const f = await externalFixture()
    await f.service.run(f.agent, { grantId: 'external', idempotencyKey: 'x'.repeat(256), expectedHeadOid: 'c'.repeat(40), headline: 'Commit', files: [{ path: 'a.txt', content: 'safe' }] }, new AbortController().signal)
    expect(f.dispatch.mock.calls[0]![1].callId).toMatch(/^api:[0-9a-f]{64}$/u)
    expect(f.dispatch.mock.calls[0]![1].rootCallId).toBe(f.dispatch.mock.calls[0]![1].callId)
  })

  it('maps transport failures without fallback and suppresses late observations after owner drift', async () => {
    const failed = await externalFixture(vi.fn<ExternalDispatch>(async (_options, intent, _signal) => { throw new BrokerClientError('connect-failed', 'not-dispatched', `no broker for ${intent.actionId}`) }))
    await expect(failed.service.run(failed.agent, { grantId: 'external', idempotencyKey: 'fail', expectedHeadOid: 'c'.repeat(40), headline: 'Commit', files: [{ path: 'a.txt', content: 'safe' }] }, new AbortController().signal)).resolves.toMatchObject({ status: 'failed', reason: 'external-broker-connect-failed' })
    expect(failed.localCommit).not.toHaveBeenCalled()
    const unknown = await externalFixture(vi.fn<ExternalDispatch>(async (_options, intent, _signal) => { throw new BrokerClientError('disconnected', 'post-dispatch-unknown', `lost response for ${intent.actionId}`) }))
    await expect(unknown.service.run(unknown.agent, { grantId: 'external', idempotencyKey: 'unknown', expectedHeadOid: 'c'.repeat(40), headline: 'Commit', files: [{ path: 'a.txt', content: 'safe' }] }, new AbortController().signal)).resolves.toMatchObject({ status: 'unknown', reason: 'external-broker-disconnected' })
    expect(unknown.localCommit).not.toHaveBeenCalled()

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const late = await externalFixture(vi.fn<ExternalDispatch>(async (options, intent, _signal) => { await options.beforeWrite!({} as never, intent as unknown as BrokerClientRequest, new AbortController().signal); await gate; return response(intent.actionId, 'succeeded', 'inspect') }))
    const pending = late.service.runInspect(late.agent, { grantId: 'external', kind: 'repository' }, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0)); late.changeBinding(); release()
    await expect(pending).resolves.toMatchObject({ result: { status: 'unknown', reason: 'external-broker-authorization-ended' } })
    expect((await pending).observed).toBeUndefined()
  })

  it('rechecks current Policy in the client pre-write gate', async () => {
    let entered = false, deny!: () => void
    const f = await externalFixture(vi.fn<ExternalDispatch>(async (options, intent, _signal) => {
      entered = true; deny()
      await options.beforeWrite!({} as never, intent as unknown as BrokerClientRequest, new AbortController().signal)
      return response(intent.actionId, 'succeeded')
    }))
    deny = f.denyPolicy
    await expect(f.service.run(f.agent, { grantId: 'external', idempotencyKey: 'denied', expectedHeadOid: 'c'.repeat(40), headline: 'Commit', files: [{ path: 'a.txt', content: 'safe' }] }, new AbortController().signal)).rejects.toThrow(/external authorization ended before dispatch/)
    expect(entered).toBe(true); expect(f.localCommit).not.toHaveBeenCalled()
  })

  it('awaits an in-flight external request while disposal aborts it', async () => {
    let sawAbort = false
    const f = await externalFixture(vi.fn<ExternalDispatch>(async (options, intent, signal) => {
      await options.beforeWrite!({} as never, intent as unknown as BrokerClientRequest, new AbortController().signal)
      await new Promise<void>(resolve => signal?.addEventListener('abort', () => { sawAbort = true; resolve() }, { once: true }))
      throw new BrokerClientError('aborted', 'post-dispatch-unknown', 'disposed')
    }))
    const pending = f.service.run(f.agent, { grantId: 'external', idempotencyKey: 'dispose', expectedHeadOid: 'c'.repeat(40), headline: 'Commit', files: [{ path: 'a.txt', content: 'safe' }] }, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    await f.ctx.fiber.dispose()
    expect(sawAbort).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 'unknown', reason: 'external-broker-aborted' })
  })

  it('fails unsupported operations before local or broker transport', async () => {
    const f = await externalFixture()
    await expect(f.service.runBranch(f.agent, { grantId: 'external', idempotencyKey: 'b', baseHeadOid: 'c'.repeat(40) }, new AbortController().signal)).rejects.toThrow('external-operation-unsupported')
    await expect(f.service.runPullRequest(f.agent, { grantId: 'external', idempotencyKey: 'p', expectedHeadOid: 'c'.repeat(40), title: 'PR', body: '' }, new AbortController().signal)).rejects.toThrow('external-operation-unsupported')
    await expect(f.service.runCompensation(f.agent, { grantId: 'external', idempotencyKey: 'r', forwardActionId: 'a', forwardActionVersion: 1, forwardRequestDigest: 'd'.repeat(64), forwardCommitOid: 'c'.repeat(40) }, new AbortController().signal)).rejects.toThrow('external-operation-unsupported')
    expect(() => f.service.prepareVerifiedDelivery(f.agent, { grantId: 'external', idempotencyKey: 'v', expectedHeadOid: 'c'.repeat(40), headline: 'x', paths: ['a.txt'] })).toThrow('external-operation-unsupported')
    expect(() => f.service.repositoryReadbackGeneration()).toThrow('external-operation-unsupported')
    await expect(f.service.runInspect(f.agent, { grantId: 'external', kind: 'checks', pullRequestNumber: 1 }, new AbortController().signal)).rejects.toThrow(/request not granted/)
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.localCommit).not.toHaveBeenCalled(); expect(f.localWorkflow.branch).not.toHaveBeenCalled(); expect(f.localWorkflow.pullRequest).not.toHaveBeenCalled()
  })
})

describe('Cordis mode lifecycle', () => {
  it('owns embedded service under Keychain availability and reloads it on provider replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actions-lifecycle-')), ctx = new Context(); cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    ctx.provide('assistantPolicy' as never, {} as never); ctx.provide('assistantDelivery' as never, {} as never)
    await ctx.plugin(plugin, { stateRoot: join(root, 'state') })
    expect(ctx.get('assistantActions', false)).toBeUndefined()
    const removeFirst = ctx.provide('credentialsKeychain' as never, {} as never); await new Promise(resolve => setTimeout(resolve, 0))
    const first = ctx.get('assistantActions', false); expect(first).toBeDefined()
    await removeFirst(); await new Promise(resolve => setTimeout(resolve, 0)); expect(ctx.get('assistantActions', false)).toBeUndefined()
    ctx.provide('credentialsKeychain' as never, {} as never); await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('assistantActions', false)).toBeDefined(); expect(ctx.get('assistantActions', false)).not.toBe(first)
  })

  it('mounts external mode without Keychain and never creates the Host state root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actions-external-lifecycle-')), ctx = new Context(); cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    ctx.provide('assistantPolicy' as never, {} as never); ctx.provide('assistantDelivery' as never, {} as never)
    const config = await externalConfig(root, [])
    const mounted = await ctx.plugin(plugin, config); const service = ctx.assistantActions
    expect(service.health()).toMatchObject({ mode: 'external-unix-v1', projectedGrants: 0 })
    await expect(access(config.stateRoot!)).rejects.toMatchObject({ code: 'ENOENT' })
    await mounted.dispose()
    expect(service.health()).toMatchObject({ active: false, mode: 'external-unix-v1' })
    await expect(service.runBranch(undefined, { grantId: 'external', idempotencyKey: 'b', baseHeadOid: 'c'.repeat(40) }, new AbortController().signal)).rejects.toThrow('external-operation-unsupported')
  })
})
