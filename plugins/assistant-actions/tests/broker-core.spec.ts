import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExternalBrokerCore, type ExternalBrokerCoreConfig } from '../src/broker-core.ts'
import { brokerPayloadBytes, withBrokerGrantDigest, type ExternalGitHubGrantUnsigned } from '../src/broker-ledger.ts'
import { createBrokerAdminRequest, createBrokerClientRequest, createBrokerServerHello, type BrokerAdminIntent, type BrokerOperation, type BrokerRequestIntent } from '../src/broker-protocol.ts'

const keys = generateKeyPairSync('ed25519')
const roots: string[] = []
let now = 2_000_000

async function fixture(): Promise<{ config: ExternalBrokerCoreConfig; secret: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'external-broker-core-'))); roots.push(root)
  const credentials = join(root, 'credentials'); await mkdir(credentials, { mode: 0o700 }); await chmod(credentials, 0o700)
  const secret = 'github_pat_external_broker_only'; const secretPath = join(credentials, 'github.token'); await writeFile(secretPath, secret, { mode: 0o600 }); await chmod(secretPath, 0o600)
  const grant = withBrokerGrantDigest({
    protocol: 'assistant-actions/external-github-grant/v1', id: 'grant', revision: 1, clientKeyId: 'client-key',
    owner: { principalDigest: 'a'.repeat(64), principalRecordId: 'record', principalVersion: 1, workspace: '/workspace', preset: 'primary', bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1 }, sessionId: 'session',
    destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main', baseBranch: 'trunk', paths: ['a.txt'] }, credentialId: 'github', expiresAt: now + 120_000,
    maxActions: 8, maxTotalBytes: 1_000_000, maxCostUnits: 8, allowedOperations: ['commit', 'inspect', 'pull-request'], allowedInspectKinds: ['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews', 'commit-checks'],
    client: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 }, source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) }, policyEpoch: 3, emergencyEpoch: 0,
  } satisfies ExternalGitHubGrantUnsigned)
  return { secret, config: { instanceId: 'broker', statePath: join(root, 'broker.sqlite'), credentials: [{ id: 'github', provider: 'linux-protected-file', path: secretPath, maxLeaseMs: 30_000 }], grants: [grant], policyEpoch: 3, now: () => now } }
}

function signed(config: ExternalBrokerCoreConfig, operation: BrokerOperation = 'commit', changes: Partial<BrokerRequestIntent> = {}) {
  const grant = config.grants[0]!
  const payload = operation === 'commit' ? { expectedHeadOid: 'c'.repeat(40), headline: 'change', files: [{ path: 'a.txt', content: 'hello' }] } : operation === 'pull-request' ? { expectedHeadOid: 'c'.repeat(40), title: 'Change', body: 'Bounded change' } : { kind: 'repository' as const }
  const intent = { actionId: 'action', grantId: grant.id, grantRevision: grant.revision, grantDigest: grant.digest, owner: grant.owner, sessionId: grant.sessionId, agentId: 'agent', rootCallId: 'root', callId: 'call', operation,
    source: grant.source, destination: { classification: 'github-repository' as const, repository: grant.destination.repository, branch: grant.destination.branch, ...(grant.destination.baseBranch === undefined ? {} : { baseBranch: grant.destination.baseBranch }) }, payload, deadline: now + 30_000,
    budget: { reservationId: 'reservation', actions: 1, bytes: 0, costMetric: 'github-api-units' as const, maxCostUnits: 1 }, ...changes } as BrokerRequestIntent
  const hello = createBrokerServerHello({ instanceId: 'broker', generation: 1, policyEpoch: 3, emergencyEpoch: 0, expiresAt: now + 30_000 }, keys.privateKey)
  const requestId = 'wire-' + intent.actionId
  const initial = createBrokerClientRequest(intent, hello, grant.client, grant.clientKeyId, keys.privateKey, requestId)
  return createBrokerClientRequest({ ...intent, budget: { ...intent.budget, bytes: brokerPayloadBytes(initial) } }, hello, grant.client, grant.clientKeyId, keys.privateKey, requestId)
}

function admin(config: ExternalBrokerCoreConfig, intent: BrokerAdminIntent, requestId: string) {
  const state = { generation: 1, policyEpoch: 3, emergencyEpoch: 0 }
  const hello = createBrokerServerHello({ instanceId: config.instanceId, ...state, expiresAt: now + 30_000 }, keys.privateKey)
  return createBrokerAdminRequest(intent, hello, { kind: 'assistant-actions-admin', instanceId: 'operator', generation: 1 }, 'admin', keys.privateKey, requestId)
}

afterEach(async () => { now = 2_000_000; vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

// This core fixture uses the Linux protected-file credential backend.
describe.skipIf(process.platform !== 'linux')('ExternalBrokerCore', () => {
  it('rejects a credential below a writable non-sticky ancestor', async () => {
    const { config } = await fixture(), unsafe = join(config.statePath, '..', 'unsafe'), credentialDirectory = join(unsafe, 'private'), credentialPath = join(credentialDirectory, 'token')
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 }); await chmod(unsafe, 0o777); await chmod(credentialDirectory, 0o700); await writeFile(credentialPath, 'hidden', { mode: 0o600 })
    const changed = { ...config, credentials: [{ id: 'github', provider: 'linux-protected-file' as const, path: credentialPath, maxLeaseMs: 30_000 }] }
    const commit = vi.fn(), core = new ExternalBrokerCore(changed, { commit })
    await expect(core.execute(signed(changed), new AbortController().signal)).resolves.toMatchObject({ status: 'failed', dispatched: false, error: { code: 'credential-unavailable' } })
    expect(commit).not.toHaveBeenCalled(); await core.close(); await chmod(unsafe, 0o700)
  })

  it('rejects a credential parent replacement between pin and open', async () => {
    const { config } = await fixture(), original = join(config.statePath, '..', 'credentials'), parked = join(config.statePath, '..', 'parked-credentials'), replacement = join(config.statePath, '..', 'replacement-credentials')
    await mkdir(replacement, { mode: 0o700 }); await writeFile(join(replacement, 'github.token'), 'attacker-token', { mode: 0o600 })
    let swapped = false
    const commit = vi.fn(), core = new ExternalBrokerCore(config, { commit, beforeCredentialOpen: async () => { if (swapped) return; swapped = true; await rename(original, parked); await rename(replacement, original) } })
    await expect(core.execute(signed(config), new AbortController().signal)).resolves.toMatchObject({ status: 'failed', dispatched: false, error: { code: 'credential-unavailable' } })
    expect(commit).not.toHaveBeenCalled(); await core.close(); await rename(original, replacement); await rename(parked, original)
  })

  it('keeps the credential inside the core and returns a durable exact commit result', async () => {
    const { config, secret } = await fixture()
    const transport = vi.fn(async (input: Parameters<typeof import('../src/github.ts').commitOnGitHub>[0]) => {
      expect(input.token).toBe(secret)
      return { actionId: input.actionId, status: 'succeeded' as const, commitOid: 'd'.repeat(40) }
    })
    const core = new ExternalBrokerCore(config, { commit: transport })
    const request = signed(config)
    const result = await core.execute(request, new AbortController().signal)
    expect(result).toMatchObject({ status: 'succeeded', dispatched: true, result: { operation: 'commit', commitOid: 'd'.repeat(40) } })
    expect(JSON.stringify(result)).not.toContain(secret)
    await core.close()
    expect((await readFile(config.statePath)).includes(Buffer.from(secret))).toBe(false)
  })

  it('creates one expected-head PR through the only write-enabled broker transport', async () => {
    const { config, secret } = await fixture()
    const pullRequest = vi.fn(async (input: Parameters<typeof import('../src/github.ts').createPullRequestOnGitHub>[0]) => {
      expect(input.token).toBe(secret)
      expect(input.grant.repoWorkflow).toEqual({ baseBranch: 'trunk', allowBranchCreate: false, allowPullRequest: true })
      expect(input.expectedHeadOid).toBe('c'.repeat(40))
      return { actionId: input.actionId, status: 'succeeded' as const, pullRequestNumber: 7 }
    })
    const commit = vi.fn(), core = new ExternalBrokerCore(config, { commit, pullRequest })
    const result = await core.execute(signed(config, 'pull-request'), new AbortController().signal)
    expect(result).toMatchObject({ status: 'succeeded', dispatched: true, result: { operation: 'pull-request', repository: 'owner/repository', branch: 'main', baseBranch: 'trunk', expectedHeadOid: 'c'.repeat(40), pullRequestNumber: 7 } })
    expect(pullRequest).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled()
    await core.close()
  })

  it('rejects secret-bearing PR input before dispatch and never retries an unknown PR', async () => {
    const { config, secret } = await fixture()
    const pullRequest = vi.fn(async () => ({ actionId: 'action', status: 'unknown' as const, reason: 'ack-lost' }))
    const core = new ExternalBrokerCore(config, { pullRequest })
    const leaked = signed(config, 'pull-request', { payload: { expectedHeadOid: 'c'.repeat(40), title: secret, body: 'bounded' } })
    await expect(core.execute(leaked, new AbortController().signal)).resolves.toMatchObject({ status: 'failed', dispatched: false, error: { code: 'request-invalid' } })
    expect(pullRequest).not.toHaveBeenCalled()
    const request = signed(config, 'pull-request', { actionId: 'unknown-pr', callId: 'unknown-pr', budget: { reservationId: 'unknown-pr', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 } })
    await expect(core.execute(request, new AbortController().signal)).resolves.toMatchObject({ status: 'unknown', dispatched: true })
    await expect(core.execute(request, new AbortController().signal)).resolves.toMatchObject({ status: 'unknown', dispatched: true })
    expect(pullRequest).toHaveBeenCalledOnce()
    await core.close()
  })

  it('rejects a payload containing the just-read token before dispatch', async () => {
    const { config, secret } = await fixture(), transport = vi.fn()
    const core = new ExternalBrokerCore(config, { commit: transport })
    const request = signed(config, 'commit', { payload: { expectedHeadOid: 'c'.repeat(40), headline: 'change', files: [{ path: 'a.txt', content: secret }] } })
    const result = await core.execute(request, new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'request-invalid' } })
    expect(transport).not.toHaveBeenCalled()
    await core.close()
  })

  it('rejects a payload containing another configured credential or a credential-shaped literal', async () => {
    const { config } = await fixture(), directory = join(config.statePath, '..', 'credentials'), other = join(directory, 'other.token'), otherSecret = 'other_external_broker_secret'
    await writeFile(other, otherSecret, { mode: 0o600 }); await chmod(other, 0o600)
    const hardened = { ...config, credentials: [...config.credentials, { id: 'other', provider: 'linux-protected-file' as const, path: other, maxLeaseMs: 30_000 }] }
    const commit = vi.fn(), core = new ExternalBrokerCore(hardened, { commit })
    expect(await core.execute(signed(hardened, 'commit', { payload: { expectedHeadOid: 'c'.repeat(40), headline: 'change', files: [{ path: 'a.txt', content: otherSecret }] } }), new AbortController().signal)).toMatchObject({ status: 'failed', dispatched: false })
    const shaped = signed(hardened, 'commit', { actionId: 'shaped', callId: 'shaped', payload: { expectedHeadOid: 'c'.repeat(40), headline: 'change', files: [{ path: 'a.txt', content: 'Authorization: Bearer abc.def' }] }, budget: { reservationId: 'shaped', actions: 1, bytes: 103, costMetric: 'github-api-units', maxCostUnits: 1 } })
    expect(await core.execute(shaped, new AbortController().signal)).toMatchObject({ status: 'failed', dispatched: false })
    expect(commit).not.toHaveBeenCalled(); await core.close()
  })

  it('returns the bounded authorized repository inspection', async () => {
    const { config } = await fixture(), inspect = vi.fn(async () => ({ observed: { full_name: 'owner/repository', untrusted: true } }))
    const core = new ExternalBrokerCore(config, { inspect })
    const result = await core.execute(signed(config, 'inspect'), new AbortController().signal)
    expect(result).toMatchObject({ status: 'succeeded', result: { operation: 'inspect', kind: 'repository' } })
    expect(inspect).toHaveBeenCalledOnce()
    await core.close()
  })

  it('rejects inspect responses with unexpected remote fields before they reach the wire', async () => {
    const { config, secret } = await fixture()
    const inspect = vi.fn(async () => ({ observed: { full_name: 'owner/repository', private: true, permissions: { admin: true }, injected: secret, untrusted: true } }))
    const core = new ExternalBrokerCore(config, { inspect }), result = await core.execute(signed(config, 'inspect'), new AbortController().signal)
    expect(result.status).not.toBe('succeeded')
    expect(JSON.stringify(result)).not.toContain(secret)
    await core.close()
  })

  it('projects grant-bound pull requests, checks, reviews, and exact commit checks through the read-only GitHub grant', async () => {
    const { config } = await fixture()
    const sha = 'd'.repeat(40)
    const pullRequest = { number: 7, state: 'open', merged: false, head: { ref: 'main', sha, repo: { full_name: 'owner/repository' } }, base: { ref: 'trunk', repo: { full_name: 'owner/repository' } } }
    const commit = vi.fn()
    const inspect = vi.fn(async (input: Parameters<typeof import('../src/github.ts').inspectGitHub>[0]) => {
      expect(input.grant.repoWorkflow).toEqual({ baseBranch: 'trunk', allowBranchCreate: false, allowPullRequest: false })
      if (input.kind === 'pull-request') return { observed: { ...pullRequest, untrusted: true } }
      if (input.kind === 'checks') return { observed: { pullRequest, headOid: sha, items: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: sha, app: { id: 2 } }], truncated: false, untrusted: true } }
      if (input.kind === 'commit-checks') return { observed: { repository: 'owner/repository', headOid: sha, items: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_sha: sha, app: { id: 2 } }], truncated: false, untrusted: true } }
      return { observed: { pullRequest, headOid: sha, items: [{ id: 3, state: 'APPROVED', commit_id: sha, user: { id: 4 }, submitted_at: '2026-01-01T00:00:00Z' }], truncated: false, untrusted: true } }
    })
    const core = new ExternalBrokerCore(config, { commit, inspect })
    for (const kind of ['pull-request', 'checks', 'reviews'] as const) {
      const result = await core.execute(signed(config, 'inspect', { actionId: `${kind}-action`, callId: `${kind}-call`, payload: { kind, pullRequestNumber: 7 }, budget: { reservationId: `${kind}-reservation`, actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: kind === 'pull-request' ? 1 : 2 } }), new AbortController().signal)
      expect(result).toMatchObject({ status: 'succeeded', dispatched: true, result: { operation: 'inspect', kind } })
      expect(JSON.stringify(result)).not.toContain('github_pat_external_broker_only')
    }
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(commit).not.toHaveBeenCalled()
    await core.close()
  })

  it('requires the exact requested OID for direct commit checks', async () => {
    const { config } = await fixture(), sha = 'd'.repeat(40)
    const inspect = vi.fn(async () => ({ observed: { repository: 'owner/repository', headOid: sha, items: [], truncated: false, untrusted: true } }))
    const core = new ExternalBrokerCore(config, { inspect })
    const result = await core.execute(signed(config, 'inspect', { actionId: 'commit-checks-action', callId: 'commit-checks-call', payload: { kind: 'commit-checks', commitOid: sha }, budget: { reservationId: 'commit-checks-reservation', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 } }), new AbortController().signal)
    expect(result).toMatchObject({ status: 'succeeded', result: { operation: 'inspect', kind: 'commit-checks', observed: { repository: 'owner/repository', headOid: sha } } })
    await core.close()
  })

  it.each([
    ['wrong base', (value: Record<string, unknown>) => ({ ...value, base: { ref: 'other', repo: { full_name: 'owner/repository' } } })],
    ['wrong head', (value: Record<string, unknown>) => ({ ...value, head: { ref: 'other', sha: 'd'.repeat(40), repo: { full_name: 'owner/repository' } } })],
    ['wrong PR number', (value: Record<string, unknown>) => ({ ...value, number: 8 })],
    ['foreign repository', (value: Record<string, unknown>) => ({ ...value, head: { ref: 'main', sha: 'd'.repeat(40), repo: { full_name: 'attacker/repository' } } })],
  ])('does not report a success for a %s PR scope', async (_name, mutate) => {
    const { config } = await fixture()
    const observed = mutate({ number: 7, state: 'open', merged: false, head: { ref: 'main', sha: 'd'.repeat(40), repo: { full_name: 'owner/repository' } }, base: { ref: 'trunk', repo: { full_name: 'owner/repository' } }, untrusted: true })
    const commit = vi.fn(), inspect = vi.fn(async () => ({ observed }))
    const core = new ExternalBrokerCore(config, { commit, inspect })
    const result = await core.execute(signed(config, 'inspect', { actionId: `${_name}-action`, callId: `${_name}-call`, payload: { kind: 'pull-request', pullRequestNumber: 7 }, budget: { reservationId: `${_name}-reservation`, actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 } }), new AbortController().signal)
    expect(result.status).not.toBe('succeeded')
    expect(inspect).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
    await core.close()
  })

  it('does not release credential-shaped fields or otherwise valid observed credential values', async () => {
    const { config, secret } = await fixture()
    const sha = 'd'.repeat(40)
    const pullRequest = { number: 7, state: 'open', merged: false, head: { ref: 'main', sha, repo: { full_name: 'owner/repository' } }, base: { ref: 'trunk', repo: { full_name: 'owner/repository' } } }
    const inspect = vi.fn(async (input: Parameters<typeof import('../src/github.ts').inspectGitHub>[0]) => input.kind === 'pull-request'
      ? { observed: { ...pullRequest, untrusted: true, token: secret } }
      : { observed: { pullRequest, headOid: sha, items: [{ id: 1, name: secret, status: 'completed', conclusion: 'success', head_sha: sha, app: { id: 2 } }], truncated: false, untrusted: true } })
    const core = new ExternalBrokerCore(config, { inspect })
    const pr = await core.execute(signed(config, 'inspect', { actionId: 'secret-field-action', callId: 'secret-field-call', payload: { kind: 'pull-request', pullRequestNumber: 7 }, budget: { reservationId: 'secret-field-reservation', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 } }), new AbortController().signal)
    const checks = await core.execute(signed(config, 'inspect', { actionId: 'secret-value-action', callId: 'secret-value-call', payload: { kind: 'checks', pullRequestNumber: 7 }, budget: { reservationId: 'secret-value-reservation', actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 2 } }), new AbortController().signal)
    for (const result of [pr, checks]) {
      expect(result.status).not.toBe('succeeded')
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    expect(inspect).toHaveBeenCalledTimes(2)
    await core.close()
  })

  it('returns a durable terminal outcome after expiry without redispatching', async () => {
    const { config } = await fixture(), commit = vi.fn(async (input: Parameters<typeof import('../src/github.ts').commitOnGitHub>[0]) => ({ actionId: input.actionId, status: 'succeeded' as const, commitOid: 'd'.repeat(40) }))
    const core = new ExternalBrokerCore(config, { commit }), request = signed(config)
    expect(await core.execute(request, new AbortController().signal)).toMatchObject({ status: 'succeeded' })
    now = config.grants[0]!.expiresAt + 1
    expect(await core.execute(request, new AbortController().signal)).toMatchObject({ status: 'succeeded' })
    expect(commit).toHaveBeenCalledOnce()
    await core.close()
  })

  it('returns the same terminal outcome after a restart and never invokes transport again', async () => {
    const { config } = await fixture(), commit = vi.fn(async (input: Parameters<typeof import('../src/github.ts').commitOnGitHub>[0]) => ({ actionId: input.actionId, status: 'succeeded' as const, commitOid: 'd'.repeat(40) }))
    const request = signed(config), first = new ExternalBrokerCore(config, { commit })
    expect(await first.execute(request, new AbortController().signal)).toMatchObject({ status: 'succeeded' })
    await first.close(); const second = new ExternalBrokerCore(config, { commit })
    expect(await second.execute(request, new AbortController().signal)).toMatchObject({ status: 'succeeded', result: { commitOid: 'd'.repeat(40) } })
    expect(commit).toHaveBeenCalledOnce(); await second.close()
  })

  it('persists stop/resume epochs, consumes admin nonces once, and aborts dispatched work', async () => {
    const { config } = await fixture()
    let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve })
    const commit = vi.fn(async (input: Parameters<typeof import('../src/github.ts').commitOnGitHub>[0]) => { reached(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true })); return { actionId: input.actionId, status: 'unknown' as const, reason: 'aborted' } })
    const core = new ExternalBrokerCore(config, { commit }); const pending = core.execute(signed(config), new AbortController().signal); await started
    const stop = admin(config, { operation: 'stop', body: { expectedControlVersion: 1, drainDeadline: now + 10_000, reason: 'security-response' }, deadline: now + 10_000 }, 'admin-stop')
    expect(await core.admin(stop, new AbortController().signal)).toMatchObject({ status: 'succeeded', state: { admission: 'stopped', revocationEpoch: 1 } })
    expect(await pending).toMatchObject({ status: 'unknown', dispatched: true })
    expect(await core.admin(stop, new AbortController().signal)).toMatchObject({ status: 'failed', error: { code: 'request-conflict' } })
    const stopped = core.snapshot()
    const resume = admin(config, { operation: 'resume', body: { expectedControlVersion: stopped.controlVersion, expectedGeneration: stopped.generation }, deadline: now + 10_000 }, 'admin-resume')
    expect(await core.admin(resume, new AbortController().signal)).toMatchObject({ status: 'succeeded', state: { admission: 'accepting', revocationEpoch: 2 } })
    await core.close()
  })

  it('makes drain idempotent and rejects new admission without replaying transport', async () => {
    const { config } = await fixture(), commit = vi.fn()
    const core = new ExternalBrokerCore(config, { commit })
    core.beginDrain('lifecycle'); core.beginDrain('sigterm')
    await expect(core.execute(signed(config), new AbortController().signal)).rejects.toMatchObject({ code: 'broker-draining', dispatched: false })
    expect(commit).not.toHaveBeenCalled()
    await core.drain(now + 100); await core.close()
  })

  it('reports a post-dispatch abort as unknown and never calls the transport twice on replay', async () => {
    const { config } = await fixture(); const controller = new AbortController()
    const commit = vi.fn(async (input: Parameters<typeof import('../src/github.ts').commitOnGitHub>[0]) => { controller.abort(); return { actionId: input.actionId, status: 'unknown' as const, reason: 'aborted' } })
    const core = new ExternalBrokerCore(config, { commit }), request = signed(config)
    await expect(core.execute(request, controller.signal)).resolves.toMatchObject({ status: 'unknown', dispatched: true })
    await expect(core.execute(request, new AbortController().signal)).resolves.toMatchObject({ status: 'unknown', dispatched: true })
    expect(commit).toHaveBeenCalledOnce()
    await core.close()
  })

  it('uses the credential lease as the transport deadline', async () => {
    const { config } = await fixture(); const short = { ...config, credentials: [{ ...config.credentials[0]!, maxLeaseMs: 1_000 }] }
    const commit = vi.fn(async (input: Parameters<typeof import('../src/github.ts').commitOnGitHub>[0]) => { await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true })); return { actionId: input.actionId, status: 'unknown' as const, reason: 'aborted' } })
    const core = new ExternalBrokerCore(short, { commit }), request = signed(short)
    const result = await core.execute(request, new AbortController().signal)
    expect(result).toMatchObject({ status: 'unknown', dispatched: true })
    expect(commit).toHaveBeenCalledOnce(); await core.close()
  }, 5_000)

  it('bounds drain and close when the transport ignores AbortSignal forever', async () => {
    vi.useFakeTimers()
    try {
      const { config } = await fixture()
      let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve })
      let transportSettled = false
      const commit = vi.fn(async () => { reached(); await new Promise<never>(() => undefined); transportSettled = true; throw new Error('unreachable') })
      const core = new ExternalBrokerCore(config, { commit }), request = signed(config)
      const pending = core.execute(request, new AbortController().signal)
      await started; core.beginDrain('sigterm')
      const draining = core.drain(now + 20)
      await vi.advanceTimersByTimeAsync(20)
      await draining
      await expect(pending).resolves.toMatchObject({ status: 'unknown', dispatched: true })
      await core.close()
      expect(transportSettled).toBe(false)
      const successor = new ExternalBrokerCore(config, { commit })
      await expect(successor.execute(request, new AbortController().signal)).resolves.toMatchObject({ status: 'unknown', dispatched: true })
      expect(commit).toHaveBeenCalledOnce()
      await successor.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds direct close while a non-cooperative transport is running', async () => {
    const { config } = await fixture()
    let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve })
    let transportSettled = false
    const commit = vi.fn(async () => { reached(); await new Promise<never>(() => undefined); transportSettled = true; throw new Error('unreachable') })
    const core = new ExternalBrokerCore(config, { commit }), request = signed(config), pending = core.execute(request, new AbortController().signal)
    await started; await core.close()
    await expect(pending).resolves.toMatchObject({ status: 'unknown', dispatched: true })
    expect(transportSettled).toBe(false)
    const successor = new ExternalBrokerCore(config, { commit })
    await expect(successor.execute(request, new AbortController().signal)).resolves.toMatchObject({ status: 'unknown', dispatched: true })
    expect(commit).toHaveBeenCalledOnce()
    await successor.close()
  })
})
