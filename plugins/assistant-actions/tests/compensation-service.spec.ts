import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantIsolationService } from '@dsh-enhanced/assistant-isolation'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { request as httpsRequest } from 'node:https'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test, vi } from 'vitest'
import { AssistantActionsService } from '../src/service.ts'
import { commitOnGitHub, createCompensatingCommitOnGitHub, readGitHubPreimage } from '../src/github.ts'
import type { ActionGrant } from '../src/types.ts'

const secret = 'fixture-broker-token-not-a-user-secret'
const initialHead = 'a'.repeat(40)
const ownerSid = 'action-session'
const otherSid = 'other-session'

function makeAgent(ctx: Context, workspace: string, sid: string): Agent {
  const id = SessionId(sid)
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id, options: { provider: 'test', model: 'test' }, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 }); session.append('approval/policy', { policy: 'ask' })
  return value
}

interface HarnessOptions {
  forwardFiles?: Array<{ path: string; content: string }>
  /** Parent-commit contents for grant paths; an absent key means the path returned an exact 404. */
  preimage?: Record<string, string>
  /** When set, the branch-head inspection reports this OID instead of the real current head. */
  branchHeadOverride?: string
  /** Destroy the socket (lost ACK) for the compensation GraphQL POST. */
  dropCompensationAck?: boolean
  /** Make the first N preimage captures contradict the parent tree (blob 404), then serve normally. */
  captureFailures?: number
  /** Delay each preimage contents GET by this many ms (lets authorization change while the capture is in flight). */
  captureDelayMs?: number
  /** Invoked once, when the first preimage contents request reaches the server. */
  onFirstCapture?: () => void
}

interface GraphQLPost { clientMutationId: string; input: Record<string, unknown>; raw: string }

async function makeHarness(options: HarnessOptions = {}) {
  const forwardFiles = options.forwardFiles ?? [{ path: 'a.txt', content: 'new-a' }, { path: 'b.txt', content: 'brand-new' }]
  const parentFiles = options.preimage ?? { 'a.txt': 'old-a' }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'action-compensation-')))
  const fixedNow = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
  const stateRoot = join(root, 'actions'); const secretRoot = join(root, 'secret')
  await mkdir(secretRoot, { mode: 0o700 }); await writeFile(join(secretRoot, 'token'), secret, { mode: 0o600 })

  let serverHead = initialHead
  let seq = 0
  let captureFailuresRemaining = options.captureFailures ?? 0
  let firstCaptureFired = false
  const captureDelayMs = options.captureDelayMs ?? 0
  const posts: GraphQLPost[] = []
  const captureLog: Array<{ path: string; ref: string }> = []
  const branchLog: string[] = []
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://github.local')
    if (req.method === 'POST' && url.pathname === '/graphql') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      expect(req.headers.authorization).toBe(`Bearer ${secret}`)
      const input = JSON.parse(raw).variables.input as Record<string, unknown>
      const clientMutationId = String(input.clientMutationId)
      posts.push({ clientMutationId, input, raw })
      if (options.dropCompensationAck && clientMutationId.startsWith('dsh-compensation:')) { req.socket.destroy(); return }
      if (input.expectedHeadOid !== serverHead) { res.statusCode = 200; res.end(JSON.stringify({ errors: [{ message: 'head changed' }] })); return }
      const previous = serverHead
      seq += 1; serverHead = seq.toString(16).padStart(40, '0')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { createCommitOnBranch: { clientMutationId,
        commit: { oid: serverHead, parents: { nodes: [{ oid: previous }] }, repository: { nameWithOwner: 'owner/repository' } },
        ref: { name: 'allowed', target: { oid: serverHead } } } } }))
      return
    }
    if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
    const commitTree = /^\/repos\/owner\/repository\/git\/commits\/([0-9a-f]{40})$/u.exec(url.pathname)
    if (commitTree) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ sha: commitTree[1], tree: { sha: '7'.repeat(40) } }))
      return
    }
    const treeLookup = /^\/repos\/owner\/repository\/git\/trees\/(.+)$/u.exec(url.pathname)
    if (treeLookup) {
      // The immutable parent tree lists exactly the paths that existed at the
      // parent commit; contents 404s are only trusted as absent for these.
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ sha: treeLookup[1], truncated: false, tree: Object.keys(parentFiles).map(path => ({ path, type: 'blob', sha: 'c'.repeat(40), mode: '100644' })) }))
      return
    }
    if (url.pathname === '/repos/owner/repository/branches/allowed') {
      const sha = options.branchHeadOverride ?? serverHead
      branchLog.push(sha)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: 'allowed', commit: { sha } }))
      return
    }
    const contents = /^\/repos\/owner\/repository\/contents\/(.+)$/u.exec(url.pathname)
    if (contents) {
      const path = decodeURIComponent(contents[1]!)
      captureLog.push({ path, ref: url.searchParams.get('ref') ?? '' })
      if (!firstCaptureFired) { firstCaptureFired = true; options.onFirstCapture?.() }
      if (captureDelayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, captureDelayMs))
      const old = parentFiles[path]
      // First N captures: the indexed blob path answers 404 although the parent
      // tree proves the blob exists, which the capture must treat as a failure.
      if (captureFailuresRemaining > 0 && old !== undefined) {
        captureFailuresRemaining -= 1
        res.statusCode = 404; res.end(); return
      }
      if (old === undefined) { res.statusCode = 404; res.end(); return }
      const bytes = Buffer.from(old, 'utf8')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ path, type: 'file', encoding: 'base64', sha: 'c'.repeat(40), size: bytes.length,
        content: bytes.toString('base64') }))
      return
    }
    res.statusCode = 404; res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  const port = address.port
  const graphqlTransport = ((url: URL, opts: Parameters<typeof httpRequest>[1], callback: Parameters<typeof httpRequest>[2]) => {
    expect(url.href).toBe('https://api.github.com/graphql')
    return httpRequest(`http://127.0.0.1:${port}/graphql`, opts, callback)
  }) as typeof httpsRequest
  const restTransport = ((url: URL, opts: Parameters<typeof httpRequest>[1], callback: Parameters<typeof httpRequest>[2]) => {
    expect(url.href.startsWith('https://api.github.com/repos/')).toBe(true)
    return httpRequest(new URL(url.pathname + url.search, `http://127.0.0.1:${port}`), opts, callback)
  }) as typeof httpsRequest

  const ctx = new Context(); let plugin: { dispose(): Promise<void> } | undefined
  const owner = makeAgent(ctx, root, ownerSid)
  const other = makeAgent(ctx, root, otherSid)
  const grant: ActionGrant = { id: 'fix', revision: 1, principalDigest: createHash('sha256').update('owner').digest('hex'), principalRecordId: 'record', principalVersion: 1,
    workspace: root, agentPreset: 'primary', repository: 'owner/repository', branch: 'allowed', paths: ['a.txt', 'b.txt'],
    credentialHandle: 'github', expiresAt: fixedNow + 120_000, maxActions: 8, maxTotalBytes: 1_000_000,
    rollback: { allowRollback: true, budgetId: 'rollbacks', maxActions: 2, maxTotalBytes: 200_000 } }
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow', budgets: [
    { id: 'commits', metric: 'dispatches', limit: 1, periodMs: 60_000, scope: 'subject' },
    { id: 'rollbacks', metric: 'github-compensations', limit: 1, periodMs: 60_000, scope: 'subject' },
  ], rules: [
    { id: 'action', effect: 'allow', subject: { kind: 'agent', id: 'primary' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:fix' }, budget: { id: 'commits', amount: 1 } },
    { id: 'compensate', effect: 'allow', subject: { kind: 'agent', id: 'primary' }, actions: ['compensate'], resource: { kind: 'tool', id: 'action:github-rollback:fix' }, budget: { id: 'rollbacks', amount: 1 } },
    { id: 'credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential', id: 'github' } },
  ] })
  await ctx.plugin(CredentialsKeychainService, { databasePath: join(root, 'credentials.sqlite'), handles: [{ id: 'github', provider: 'linux-protected-file', path: join(secretRoot, 'token'), consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit', 'github.compensate'], maxLeaseMs: 30_000 }] })
  ctx.provide('agents' as never, { get: (id: string) => id === owner.id ? owner : id === other.id ? other : undefined } as never)
  // Tests may switch the resolved delivery principal while a compensation is in
  // flight to prove the 100 ms authorization poll aborts it after owner change.
  let principalOverride: { principalId: string; principalRecordId: string; principalVersion: number } | undefined
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => {
    const value = principalOverride ?? { principalId: 'owner', principalRecordId: 'record', principalVersion: 1 }
    return { principalId: value.principalId, principalLineage: { principalRecordId: value.principalRecordId, principalVersion: value.principalVersion }, scope: { workspace: root, preset: 'primary' } }
  } } as never)
  await ctx.plugin(AssistantIsolationService, { stateRoot: join(root, 'isolation'), image: 'sha256:' + 'a'.repeat(64), grants: [{ id: 'offline', revision: 1, principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: root, agentPreset: 'primary', expiresAt: grant.expiresAt, maxRuns: 1, maxTotalDurationMs: 60_000 }] })
  let asks = 0
  ctx.on('approval/request', async () => { asks++; return 'allowed-once' })
  const load = async () => await ctx.plugin({ name: 'dsh-enhanced-assistant-actions', apply(runtime: Context) {
    new AssistantActionsService(runtime, { stateRoot, grants: [grant] },
      input => commitOnGitHub(input, graphqlTransport),
      undefined,
      { capture: input => readGitHubPreimage(input, restTransport),
        commit: input => createCompensatingCommitOnGitHub(input, { graphql: graphqlTransport, rest: restTransport }) })
  } }) as unknown as { dispose(): Promise<void> }
  plugin = await load()

  type ToolResult = { isError: boolean; result: string }
  const call = async (name: string, args: unknown, who: Agent = owner): Promise<ToolResult> => {
    const toolResult = await ctx.tools.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: args, signal: new AbortController().signal, agent: who }) as
      { isError: boolean; content: Array<{ type: string; text?: string }> }
    return { isError: toolResult.isError, result: toolResult.content.map(block => block.text ?? '').join('') }
  }
  const forward = async (key = 'forward-key') => {
    const request = { grantId: 'fix', idempotencyKey: key, expectedHeadOid: serverHead, headline: 'bounded change', files: forwardFiles }
    const toolResult = await call('action_github_commit', request)
    expect(toolResult.isError, toolResult.result).toBe(false)
    const parsed = JSON.parse(toolResult.result)
    return { request, parsed, receipt: parsed.forwardReceipt as { actionId: string; version: number; requestDigest: string; commitOid: string } }
  }
  const compensate = async (key: string, receipt: { actionId: string; version: number; requestDigest: string; commitOid: string }, who: Agent = owner) =>
    await call('action_github_compensate', { grantId: 'fix', idempotencyKey: key, forwardActionId: receipt.actionId, forwardActionVersion: receipt.version, forwardRequestDigest: receipt.requestDigest, forwardCommitOid: receipt.commitOid }, who)
  const statusOf = async (actionId: string, who: Agent = owner) => await call('action_github_compensation_status', { grantId: 'fix', actionId }, who)
  const compPosts = () => posts.filter(post => post.clientMutationId.startsWith('dsh-compensation:'))
  const openLedger = () => new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
  const openPolicy = () => new DatabaseSync(join(root, 'policy.sqlite'))
  const cleanup = async () => {
    try { await plugin?.dispose(); await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } finally {
      await rm(root, { recursive: true, force: true }); clock.mockRestore()
    }
  }
  return { ctx, owner, other, grant, call, forward, compensate, statusOf, posts, compPosts, captureLog, branchLog, openLedger, openPolicy,
    setPrincipal: (value: { principalId: string; principalRecordId: string; principalVersion: number } | undefined) => { principalOverride = value },
    reload: async () => { await plugin!.dispose(); plugin = await load() }, cleanup, asks: () => asks }
}

// Every scenario exercises the real linux-protected-file credential backend.
describe.skipIf(process.platform !== 'linux')('Linux protected-file compensation', () => {
test('A: succeeded forward result exposes only the redacted four-field receipt', async () => {
  const h = await makeHarness()
  try {
    const { parsed, receipt } = await h.forward()
    expect(parsed).toEqual({ actionId: expect.any(String), status: 'succeeded', commitOid: expect.stringMatching(/^[0-9a-f]{40}$/u),
      forwardReceipt: { actionId: parsed.actionId, version: 3, requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), commitOid: parsed.commitOid } })
    expect(receipt.actionId).toBe(parsed.actionId)
    expect(receipt.commitOid).toBe(parsed.commitOid)
    expect(JSON.stringify(parsed)).not.toMatch(/preimage|blobOid|content|old-a|brand-new|secret/u)
    expect(h.asks()).toBe(0)
  } finally { await h.cleanup() }
}, 30_000)

test('B: compensation restores parent files with one expected-head commit, never force/reset/updateRef', async () => {
  const h = await makeHarness()
  try {
    const { receipt } = await h.forward()
    const toolResult = await h.compensate('comp-key', receipt)
    expect(toolResult.isError, toolResult.result).toBe(false)
    const parsed = JSON.parse(toolResult.result)
    expect(parsed.status).toBe('succeeded')
    expect(parsed).toMatchObject({ repository: 'owner/repository', branch: 'allowed', parentOid: receipt.commitOid })
    expect(parsed.resultOid).toMatch(/^[0-9a-f]{40}$/u)
    expect(parsed.reason).toBeUndefined()

    // Parent preimage is read path-by-path at the immutable parent OID before any commit is attempted.
    expect(h.captureLog).toEqual([{ path: 'a.txt', ref: initialHead }, { path: 'b.txt', ref: initialHead }])
    expect(h.branchLog).toEqual([receipt.commitOid])
    expect(h.compPosts()).toHaveLength(1)
    const post = h.compPosts()[0]!
    expect(post.clientMutationId).toBe(`dsh-compensation:${parsed.actionId}`)
    expect(post.input.expectedHeadOid).toBe(receipt.commitOid)
    expect(post.input.branch).toEqual({ repositoryNameWithOwner: 'owner/repository', branchName: 'allowed' })
    const fileChanges = post.input.fileChanges as { additions: unknown; deletions: unknown }
    expect(Object.keys(fileChanges).sort()).toEqual(['additions', 'deletions'])
    expect(fileChanges.additions).toEqual([{ path: 'a.txt', contents: Buffer.from('old-a', 'utf8').toString('base64') }])
    expect(fileChanges.deletions).toEqual([{ path: 'b.txt' }])
    expect(post.raw).not.toMatch(/updateRef|force/iu)
    expect(h.asks()).toBe(0)

    const db = h.openLedger()
    try {
      expect(JSON.stringify(db.prepare('SELECT * FROM actions').all())).not.toContain(secret)
      expect(JSON.stringify(db.prepare('SELECT * FROM compensations').all())).not.toContain(secret)
    } finally { db.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('C: a second compensation key for one succeeded forward is rejected without another dispatch', async () => {
  const h = await makeHarness()
  try {
    const { receipt } = await h.forward()
    const first = await h.compensate('comp-key', receipt)
    expect(first.isError, first.result).toBe(false)
    const second = await h.compensate('comp-key-other', receipt)
    expect(second.isError).toBe(true)
    expect(h.compPosts()).toHaveLength(1)
    // The rejected attempt never reached preimage capture.
    expect(h.captureLog).toHaveLength(2)
  } finally { await h.cleanup() }
}, 30_000)

test('D: replaying the identical compensation key returns the stored terminal result without redispatch', async () => {
  const h = await makeHarness()
  try {
    const { receipt } = await h.forward()
    const first = await h.compensate('comp-key', receipt)
    expect(first.isError, first.result).toBe(false)
    const firstParsed = JSON.parse(first.result)
    const replay = await h.compensate('comp-key', receipt)
    expect(replay.isError, replay.result).toBe(false)
    const replayParsed = JSON.parse(replay.result)
    expect(replayParsed).toEqual(firstParsed)
    expect(h.compPosts()).toHaveLength(1)
    expect(h.captureLog).toHaveLength(2)
  } finally { await h.cleanup() }
}, 30_000)

test('E: status projection hides preimages and a different Session is denied', async () => {
  const h = await makeHarness()
  try {
    const { receipt } = await h.forward()
    const comp = await h.compensate('comp-key', receipt)
    const actionId = (JSON.parse(comp.result) as { actionId: string }).actionId
    const mine = await h.statusOf(actionId, h.owner)
    expect(mine.isError, mine.result).toBe(false)
    expect(JSON.parse(mine.result)).toEqual({ actionId, status: 'succeeded', repository: 'owner/repository', branch: 'allowed', parentOid: receipt.commitOid, resultOid: expect.stringMatching(/^[0-9a-f]{40}$/u) })
    expect(mine.result).not.toMatch(/preimage|blobOid|old-a|content/iu)

    const theirs = await h.statusOf(actionId, h.other)
    expect(theirs.isError).toBe(true)
  } finally { await h.cleanup() }
}, 30_000)

test('F: lost compensation ACK is unknown and stays unknown across restart without replay', async () => {
  const h = await makeHarness({ dropCompensationAck: true })
  try {
    const { receipt } = await h.forward()
    const lost = await h.compensate('comp-key', receipt)
    expect(lost.isError, lost.result).toBe(false)
    const lostParsed = JSON.parse(lost.result)
    expect(lostParsed.status).toBe('unknown')
    expect(lostParsed.reason).toBe('github-compensation-unknown')
    expect(h.compPosts()).toHaveLength(1)

    await h.reload()
    const replay = await h.compensate('comp-key', receipt)
    expect(replay.isError, replay.result).toBe(false)
    const replayParsed = JSON.parse(replay.result)
    expect(replayParsed.actionId).toBe(lostParsed.actionId)
    expect(replayParsed.status).toBe('unknown')
    expect(replayParsed.reason).toBe('github-compensation-unknown')
    expect(h.compPosts()).toHaveLength(1)
  } finally { await h.cleanup() }
}, 30_000)

test('G: an advanced branch head fails compensation after capture, with zero commit dispatch', async () => {
  const h = await makeHarness({ branchHeadOverride: 'f'.repeat(40) })
  try {
    const { receipt } = await h.forward()
    const result = await h.compensate('comp-key', receipt)
    expect(result.isError, result.result).toBe(false)
    const parsed = JSON.parse(result.result)
    expect(parsed.status).toBe('failed')
    expect(parsed.reason).toBe('github-compensation-head-conflict')
    expect(h.captureLog).toHaveLength(2)
    expect(h.compPosts()).toHaveLength(0)
    // The failed terminal state is readable on replay rather than retried.
    const replay = JSON.parse((await h.compensate('comp-key', receipt)).result)
    expect(replay.status).toBe('failed')
    expect(replay.reason).toBe('github-compensation-head-conflict')
    expect(h.compPosts()).toHaveLength(0)
    // The local dispatch flip happened before the head inspection failed, so the
    // reservation is finalized (a real dispatch attempt), never left as a hold.
    const pdb = h.openPolicy()
    try {
      const reservation = pdb.prepare("SELECT status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").get() as { status: string }
      expect(reservation.status).toBe('finalized')
      const period = pdb.prepare("SELECT reserved_amount, spent_amount FROM budget_periods WHERE metric = 'github-compensations'").get() as { reserved_amount: number; spent_amount: number }
      expect(period).toEqual({ reserved_amount: 0, spent_amount: 1 })
    } finally { pdb.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('H: the github-compensations budget is independent of the forward dispatch budget', async () => {
  const h = await makeHarness()
  try {
    const { receipt } = await h.forward()
    // The forward budget (metric "dispatches", limit 1) is now exhausted...
    expect(h.ctx.assistantPolicy.authorizeAgent(h.owner, 'execute', { kind: 'tool', id: 'action:github:fix' }, { idempotencyKey: 'extra-forward' })).toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })
    // ...but the dedicated compensation budget (metric "github-compensations") still pays for one compensation.
    const result = await h.compensate('comp-key', receipt)
    expect(result.isError, result.result).toBe(false)
    expect(JSON.parse(result.result).status).toBe('succeeded')
    expect(h.compPosts()).toHaveLength(1)
    // The compensation budget is now exhausted too, proving they were counted separately.
    const db = h.openLedger()
    try {
      const rows = db.prepare("SELECT budget_id, status FROM compensations").all() as Array<{ budget_id: string; status: string }>
      expect(rows).toEqual([{ budget_id: 'rollbacks', status: 'succeeded' }])
    } finally { db.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('I: a preimage larger than 64 KiB (but within 1 MiB) compensates byte-for-byte', async () => {
  const oldContent = 'o'.repeat(70_000)
  const h = await makeHarness({ forwardFiles: [{ path: 'a.txt', content: 'x'.repeat(70_000) }], preimage: { 'a.txt': oldContent } })
  try {
    const { receipt } = await h.forward()
    const result = await h.compensate('comp-key', receipt)
    expect(result.isError, result.result).toBe(false)
    const parsed = JSON.parse(result.result)
    expect(parsed.status).toBe('succeeded')
    const post = h.compPosts()[0]!
    const fileChanges = post.input.fileChanges as { additions: Array<{ path: string; contents: string }>; deletions: unknown[] }
    expect(fileChanges.additions).toEqual([{ path: 'a.txt', contents: Buffer.from(oldContent, 'utf8').toString('base64') }])
    expect(Buffer.from(fileChanges.additions[0]!.contents, 'base64').toString('utf8')).toHaveLength(70_000)
    expect(fileChanges.deletions).toEqual([])
  } finally { await h.cleanup() }
}, 30_000)

test('J: a pre-dispatch budget denial releases the hold and discards the capturing placeholder, freeing the slot for a retry', async () => {
  const h = await makeHarness()
  const policy = h.ctx.assistantPolicy
  // Exhaust the subject's rollback budget with an independent held reservation
  // (same subject scope "agent:primary", same github-compensations metric).
  const probe = policy.reserve({ budgetId: 'rollbacks', subject: { kind: 'agent', id: 'primary', workspace: h.grant.workspace }, amount: 1, idempotencyKey: 'probe:exhaust-rollbacks' })
  expect(probe.status).toBe('reserved')
  try {
    const { receipt } = await h.forward()
    const denied = await h.compensate('comp-key-denied', receipt)
    expect(denied.isError).toBe(true)
    // The two-phase reserve is denied before preimage capture, so no GitHub GET/POST was attempted...
    expect(h.captureLog).toHaveLength(0)
    expect(h.compPosts()).toHaveLength(0)
    // ...the capturing placeholder was discarded, leaving no compensation row behind...
    const db = h.openLedger()
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM compensations').get() as { n: number }).n).toBe(0)
    } finally { db.close() }
    // ...and the denied attempt left no orphan reservation of its own.
    const pdb = h.openPolicy()
    try {
      const rows = pdb.prepare("SELECT idempotency_key, status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").all() as Array<{ idempotency_key: string; status: string }>
      expect(rows).toEqual([])
    } finally { pdb.close() }

    // Once the blocking hold is released, a new compensation key for the same forward action proceeds.
    expect(policy.release(probe.reservationId).status).toBe('released')
    const retried = await h.compensate('comp-key-retry', receipt)
    expect(retried.isError, retried.result).toBe(false)
    expect(JSON.parse(retried.result).status).toBe('succeeded')
    expect(h.captureLog).toHaveLength(2)
    expect(h.compPosts()).toHaveLength(1)
    // The successful attempt is finalized (charged once); the released probe and
    // denied attempt consume nothing in the current period.
    const pdb2 = h.openPolicy()
    try {
      const reservations = pdb2.prepare("SELECT idempotency_key, status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").all() as Array<{ idempotency_key: string; status: string }>
      expect(reservations).toEqual([{ idempotency_key: expect.stringMatching(/^compensation:./u), status: 'finalized' }])
      const period = pdb2.prepare("SELECT reserved_amount, spent_amount FROM budget_periods WHERE metric = 'github-compensations'").get() as { reserved_amount: number; spent_amount: number }
      expect(period).toEqual({ reserved_amount: 0, spent_amount: 1 })
    } finally { pdb2.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('K: a preimage-capture failure releases the budget hold and discards the placeholder, so a retry is not blocked', async () => {
  // The first capture attempt contradicts the parent tree (blob 404); it
  // happens after the budget reserve but before the dispatch boundary.
  const h = await makeHarness({ captureFailures: 1 })
  try {
    const { receipt } = await h.forward()
    const failed = await h.compensate('comp-key-failed', receipt)
    expect(failed.isError).toBe(true)
    expect(h.compPosts()).toHaveLength(0)
    const ldb = h.openLedger()
    try {
      expect((ldb.prepare('SELECT COUNT(*) AS n FROM compensations').get() as { n: number }).n).toBe(0)
    } finally { ldb.close() }
    // The hold is released (the row stays for audit as a released reservation).
    let pdb = h.openPolicy()
    try {
      const rows = pdb.prepare("SELECT status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").all() as Array<{ status: string }>
      expect(rows).toEqual([{ status: 'released' }])
    } finally { pdb.close() }

    // The next attempt (server now serves the preimage) succeeds on the same one-action budget.
    const retried = await h.compensate('comp-key-retry', receipt)
    expect(retried.isError, retried.result).toBe(false)
    expect(JSON.parse(retried.result).status).toBe('succeeded')
    expect(h.compPosts()).toHaveLength(1)
    pdb = h.openPolicy()
    try {
      const period = pdb.prepare("SELECT reserved_amount, spent_amount FROM budget_periods WHERE metric = 'github-compensations'").get() as { reserved_amount: number; spent_amount: number }
      expect(period).toEqual({ reserved_amount: 0, spent_amount: 1 })
    } finally { pdb.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('L: restart releases the orphaned budget hold for a compensation stuck prepared and never dispatches it again', async () => {
  const h = await makeHarness()
  try {
    const { receipt } = await h.forward()
    const ok = await h.compensate('comp-key', receipt)
    expect(ok.isError, ok.result).toBe(false)
    const actionId = (JSON.parse(ok.result) as { actionId: string }).actionId
    expect(h.compPosts()).toHaveLength(1)

    // Simulate the crash window: a sealed prepared compensation with a still-open
    // reservation (process died after capture, before the dispatch flip).
    await h.reload()
    const ldb = h.openLedger()
    try {
      ldb.prepare("UPDATE compensations SET status = 'prepared', result_json = NULL WHERE id = ?").run(actionId)
    } finally { ldb.close() }
    const pdb0 = h.openPolicy()
    try {
      pdb0.prepare("UPDATE budget_reservations SET status = 'reserved' WHERE idempotency_key = ?").run(`compensation:${actionId}`)
      pdb0.prepare("UPDATE budget_periods SET reserved_amount = 1, spent_amount = 0, version = version + 1 WHERE metric = 'github-compensations'").run()
    } finally { pdb0.close() }

    // Restart: recovery turns the stale row unknown (never replayed) and releases
    // the orphan reservation through the deterministic idempotency key.
    await h.reload()
    const ldb2 = h.openLedger()
    try {
      const row = ldb2.prepare('SELECT status FROM compensations WHERE id = ?').get(actionId) as { status: string }
      expect(row.status).toBe('unknown')
    } finally { ldb2.close() }
    const pdb = h.openPolicy()
    try {
      const reservation = pdb.prepare('SELECT status FROM budget_reservations WHERE idempotency_key = ?').get(`compensation:${actionId}`) as { status: string }
      expect(reservation.status).toBe('released')
      const period = pdb.prepare("SELECT reserved_amount, spent_amount FROM budget_periods WHERE metric = 'github-compensations'").get() as { reserved_amount: number; spent_amount: number }
      expect(period).toEqual({ reserved_amount: 0, spent_amount: 0 })
    } finally { pdb.close() }

    // The recovered unknown is terminal: no second POST for the same key.
    const replay = await h.compensate('comp-key', receipt)
    expect(JSON.parse(replay.result)).toMatchObject({ status: 'unknown' })
    expect(h.compPosts()).toHaveLength(1)
  } finally { await h.cleanup() }
}, 30_000)

test('M: an in-flight grant revocation during preimage capture aborts before dispatch and discards the placeholder', async () => {
  // The capture sleeps longer than the 100 ms authorization poll, so the
  // second-connection revoke is observed while the capture is still running.
  const h = await makeHarness({ captureDelayMs: 250, onFirstCapture: () => {
    const db = h.openLedger()
    try {
      db.prepare('UPDATE grant_heads SET revoked = 1 WHERE id = ?').run(h.grant.id)
      db.prepare('UPDATE grants SET revoked = 1 WHERE id = ? AND revision = ?').run(h.grant.id, h.grant.revision)
    } finally { db.close() }
  } })
  try {
    const { receipt } = await h.forward()
    const revoked = await h.compensate('comp-key-revoked', receipt)
    expect(revoked.isError).toBe(true)
    expect(revoked.result).toMatch(/authorization ended|capture unavailable/u)
    // The revocation was detected mid-capture: no compensation commit was posted.
    expect(h.compPosts()).toHaveLength(0)
    // The capturing placeholder was discarded (delete, not a terminal row).
    const ldb = h.openLedger()
    try {
      expect((ldb.prepare('SELECT COUNT(*) AS n FROM compensations').get() as { n: number }).n).toBe(0)
      const audits = ldb.prepare("SELECT kind FROM audit WHERE kind LIKE 'compensation-%' ORDER BY sequence").all() as Array<{ kind: string }>
      expect(audits.map(entry => entry.kind)).toContain('compensation-discarded')
    } finally { ldb.close() }
    // The hold was released before the dispatch boundary; nothing was charged.
    const pdb = h.openPolicy()
    try {
      const rows = pdb.prepare("SELECT status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").all() as Array<{ status: string }>
      expect(rows).toEqual([{ status: 'released' }])
      const period = pdb.prepare("SELECT reserved_amount, spent_amount FROM budget_periods WHERE metric = 'github-compensations'").get() as { reserved_amount: number; spent_amount: number }
      expect(period).toEqual({ reserved_amount: 0, spent_amount: 0 })
    } finally { pdb.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('N: an in-flight owner change during capture aborts before dispatch and discards the placeholder', async () => {
  const h = await makeHarness({ captureDelayMs: 250, onFirstCapture: () => {
    h.setPrincipal({ principalId: 'intruder', principalRecordId: 'record', principalVersion: 2 })
  } })
  try {
    const { receipt } = await h.forward()
    const changed = await h.compensate('comp-key-owner', receipt)
    expect(changed.isError).toBe(true)
    expect(changed.result).toMatch(/authorization ended|capture unavailable|owner changed/u)
    expect(h.compPosts()).toHaveLength(0)
    const ldb = h.openLedger()
    try {
      expect((ldb.prepare('SELECT COUNT(*) AS n FROM compensations').get() as { n: number }).n).toBe(0)
      const audits = ldb.prepare("SELECT kind FROM audit WHERE kind LIKE 'compensation-%' ORDER BY sequence").all() as Array<{ kind: string }>
      expect(audits.map(entry => entry.kind)).toContain('compensation-discarded')
    } finally { ldb.close() }
    const pdb = h.openPolicy()
    try {
      const rows = pdb.prepare("SELECT status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").all() as Array<{ status: string }>
      expect(rows).toEqual([{ status: 'released' }])
      const period = pdb.prepare("SELECT reserved_amount, spent_amount FROM budget_periods WHERE metric = 'github-compensations'").get() as { reserved_amount: number; spent_amount: number }
      expect(period).toEqual({ reserved_amount: 0, spent_amount: 0 })
    } finally { pdb.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('O: a parent file whose content echoes the PAT fails capture closed without dispatching or leaking the token', async () => {
  const h = await makeHarness({ preimage: { 'a.txt': `prefix-${secret}-suffix` } })
  try {
    const { receipt } = await h.forward()
    const blocked = await h.compensate('comp-key-token-echo', receipt)
    expect(blocked.isError).toBe(true)
    // The token-bearing blob is rejected at decode: fail-closed capture failure.
    expect(blocked.result).toMatch(/capture unavailable/u)
    expect(h.compPosts()).toHaveLength(0)
    // Capture short-circuits on the first rejected path; b.txt is never fetched.
    expect(h.captureLog.map(entry => entry.path)).toEqual(['a.txt'])
    const ldb = h.openLedger()
    try {
      expect((ldb.prepare('SELECT COUNT(*) AS n FROM compensations').get() as { n: number }).n).toBe(0)
      expect(JSON.stringify(ldb.prepare('SELECT * FROM compensations').all())).not.toContain(secret)
    } finally { ldb.close() }
    // Neither the tool result nor the persisted actions ledger ever carries the token.
    expect(blocked.result).not.toContain(secret)
    const adb = h.openLedger()
    try {
      expect(JSON.stringify(adb.prepare('SELECT * FROM actions').all())).not.toContain(secret)
    } finally { adb.close() }
    const pdb = h.openPolicy()
    try {
      const rows = pdb.prepare("SELECT status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").all() as Array<{ status: string }>
      expect(rows).toEqual([{ status: 'released' }])
    } finally { pdb.close() }
  } finally { await h.cleanup() }
}, 30_000)

test('P: losing the rollback hold after the preimage seal but before dispatch terminalizes the sealed row to unknown without replay', async () => {
  // During the capture flight the still-open reservation is released through
  // the same crash-recovery API a host uses for orphaned holds. The seal then
  // succeeds but the pre-dispatch re-check fails: the sealed prepared row must
  // be terminalized to unknown live instead of lingering as a zombie that only
  // a process restart would clear.
  const h = await makeHarness({ captureDelayMs: 250, onFirstCapture: () => {
    const pdb = h.openPolicy()
    try {
      const row = pdb.prepare("SELECT idempotency_key FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%' AND status = 'reserved'").get() as { idempotency_key: string } | undefined
      if (row) (h.ctx.get('assistantPolicy') as unknown as { releaseByIdempotencyKey(key: string): unknown }).releaseByIdempotencyKey(row.idempotency_key)
    } finally { pdb.close() }
  } })
  try {
    const { receipt } = await h.forward()
    const blocked = await h.compensate('comp-key-sealed', receipt)
    expect(blocked.isError).toBe(true)
    expect(blocked.result).toMatch(/authorization ended/u)
    // The dispatch flip never happened, so no compensation commit was posted.
    expect(h.compPosts()).toHaveLength(0)
    const ldb = h.openLedger()
    try {
      const row = ldb.prepare('SELECT status, result_json FROM compensations').get() as { status: string; result_json: string }
      expect(row.status).toBe('unknown')
      expect((JSON.parse(row.result_json) as { reason?: string }).reason).toBe('authorization-ended-before-dispatch')
      const audits = ldb.prepare("SELECT kind FROM audit WHERE kind LIKE 'compensation-%' ORDER BY sequence").all() as Array<{ kind: string }>
      expect(audits.map(entry => entry.kind)).toContain('compensation-abandoned')
    } finally { ldb.close() }
    // The never-dispatched hold is released; nothing was charged to the rollback budget.
    const pdb = h.openPolicy()
    try {
      const rows = pdb.prepare("SELECT status FROM budget_reservations WHERE idempotency_key LIKE 'compensation:%'").all() as Array<{ status: string }>
      expect(rows).toEqual([{ status: 'released' }])
      const period = pdb.prepare("SELECT reserved_amount, spent_amount FROM budget_periods WHERE metric = 'github-compensations'").get() as { reserved_amount: number; spent_amount: number }
      expect(period).toEqual({ reserved_amount: 0, spent_amount: 0 })
    } finally { pdb.close() }
    // unknown is terminal: replaying the identical key returns the stored unknown and never redispatches.
    const replay = await h.compensate('comp-key-sealed', receipt)
    expect(replay.isError, replay.result).toBe(false)
    expect(JSON.parse(replay.result)).toMatchObject({ status: 'unknown', reason: 'authorization-ended-before-dispatch' })
    expect(h.compPosts()).toHaveLength(0)
  } finally { await h.cleanup() }
}, 30_000)
})
