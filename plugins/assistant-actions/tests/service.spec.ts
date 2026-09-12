import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantIsolationService } from '@dsh-enhanced/assistant-isolation'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import type { request as httpsRequest } from 'node:https'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { AssistantActionsService } from '../src/service.ts'
import { commitOnGitHub } from '../src/github.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { ActionGrant } from '../src/types.ts'

const secret = 'fixture-broker-token-not-a-user-secret'
function agent(ctx: Context, workspace: string): Agent {
  const id = SessionId('action-session')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id, options: { provider: 'test', model: 'test' }, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 }); session.append('approval/policy', { policy: 'ask' })
  return value
}

test.runIf(process.platform === 'linux')('real ToolRuntime, Keychain and HTTP execute a finite commit, preserve unknown after ACK loss and honor external revocation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'action-service-')))
  // The Policy ledger uses fixed wall-clock windows. Keep all four budget
  // reservations in one window; a real minute rollover made this assertion flaky.
  const policyNow = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(policyNow)
  const stateRoot = join(root, 'actions'); const secretRoot = join(root, 'secret')
  await mkdir(secretRoot, { mode: 0o700 }); await writeFile(join(secretRoot, 'token'), secret, { mode: 0o600 })
  let head = 'a'.repeat(40); let received = 0; let mode: 'success' | 'drop' | 'hang' = 'success'
  let arrived: (() => void) | undefined
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')).variables.input
    expect(req.headers.authorization).toBe(`Bearer ${secret}`)
    received++; arrived?.()
    if (mode === 'hang') return
    if (payload.expectedHeadOid !== head) { res.end(JSON.stringify({ errors: [{ message: 'head changed' }] })); return }
    const previous = head; head = received.toString(16).padStart(40, '0')
    if (mode === 'drop') { req.socket.destroy(); return }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: { createCommitOnBranch: { clientMutationId: payload.clientMutationId,
      commit: { oid: head, parents: { nodes: [{ oid: previous }] }, repository: { nameWithOwner: 'owner/repository' } }, ref: { name: 'allowed', target: { oid: head } } } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  const transport = ((url: URL, options: Parameters<typeof httpRequest>[1], callback: Parameters<typeof httpRequest>[2]) => {
    expect(url.href).toBe('https://api.github.com/graphql')
    return httpRequest(`http://127.0.0.1:${address.port}`, options, callback)
  }) as typeof httpsRequest
  const ctx = new Context(); let plugin: { dispose(): Promise<void> } | undefined
  const owner = agent(ctx, root)
  const grant: ActionGrant = { id: 'fix', revision: 1, principalDigest: createHash('sha256').update('owner').digest('hex'), principalRecordId: 'record', principalVersion: 1,
    workspace: root, agentPreset: 'primary', repository: 'owner/repository', branch: 'allowed', paths: ['a.txt'], credentialHandle: 'github', expiresAt: Date.now() + 120_000, maxActions: 8, maxTotalBytes: 100_000 }
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow', budgets: [{ id: 'commits', metric: 'dispatches', limit: 3, periodMs: 60_000, scope: 'subject' }], rules: [
      { id: 'action', effect: 'allow', subject: { kind: 'agent', id: 'primary' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:fix' }, budget: { id: 'commits', amount: 1 } },
      { id: 'credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential', id: 'github' } },
    ] })
    await ctx.plugin(CredentialsKeychainService, { databasePath: join(root, 'credentials.sqlite'), handles: [{ id: 'github', provider: 'linux-protected-file', path: join(secretRoot, 'token'), consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30_000 }] })
    ctx.provide('agents' as never, { get: (id: string) => id === owner.id ? owner : undefined } as never)
    ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }) } as never)
    // Exercise the actual Isolation routing exception; no isolation job is submitted.
    await ctx.plugin(AssistantIsolationService, { stateRoot: join(root, 'isolation'), image: 'sha256:' + 'a'.repeat(64), grants: [{ id: 'offline', revision: 1, principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: root, agentPreset: 'primary', expiresAt: grant.expiresAt, maxRuns: 1, maxTotalDurationMs: 60_000 }] })
    let asks = 0; let allowHostCanary = true; ctx.on('approval/request', async () => { asks++; return allowHostCanary ? 'allowed-once' : 'rejected' })
    const load = async () => await ctx.plugin({ name: 'dsh-enhanced-assistant-actions', apply(runtime: Context) {
      new AssistantActionsService(runtime, { stateRoot, grants: [grant] }, input => commitOnGitHub(input, transport))
    } }) as unknown as { dispose(): Promise<void> }
    let hostExecutions = 0
    ctx.tools.register(defineTool({ name: 'bash', description: 'Host execution canary', parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => { hostExecutions++; return 'host executed' } }))
    plugin = await load()
    const input = { grantId: 'fix', idempotencyKey: 'first', expectedHeadOid: head, headline: 'bounded change', files: [{ path: 'a.txt', content: 'content' }] }
    const execute = async (request = input) => await ctx.tools.execute({ callId: ToolCallId(`call-${Math.random()}`), name: 'action_github_commit', arguments: request, signal: new AbortController().signal, agent: owner })
    const hostResult = await ctx.tools.execute({ callId: ToolCallId('host-canary'), name: 'bash', arguments: {}, signal: new AbortController().signal, agent: owner })
    expect(hostResult.isError).toBe(true); expect(hostExecutions).toBe(0)
    allowHostCanary = false; asks = 0
    const first = await execute()
    expect(first.isError, JSON.stringify(first)).toBe(false)
    expect(JSON.stringify(first)).toContain('succeeded'); expect(asks).toBe(0); expect(received).toBe(1)
    expect(JSON.stringify(await execute())).toContain('succeeded'); expect(received).toBe(1)
    expect((await execute({ ...input, idempotencyKey: 'path', files: [{ path: 'secret.txt', content: 'outside' }] })).isError).toBe(true)
    expect(received).toBe(1)
    mode = 'drop'
    const lost = { ...input, expectedHeadOid: head, idempotencyKey: 'lost' }
    const lostResult = await execute(lost); expect(JSON.stringify(lostResult)).toContain('unknown'); expect(received).toBe(2)
    await plugin.dispose(); plugin = await load()
    expect(JSON.stringify(await execute(lost))).toContain('unknown'); expect(received).toBe(2)
    expect((await execute({ ...lost, idempotencyKey: 'unsafe-new-key' })).isError).toBe(true); expect(received).toBe(2)
    mode = 'hang'
    const atServer = new Promise<void>(resolve => { arrived = resolve })
    const pending = execute({ ...input, expectedHeadOid: head, idempotencyKey: 'revoke' })
    await atServer
    // Allow multiple live authorization polls while the third and final budget unit is occupied.
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(ctx.assistantPolicy.authorizeAgent(owner, 'execute', { kind: 'tool', id: 'action:github:fix' }, { idempotencyKey: 'extra-budget-probe' })).toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })
    const revoked = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../lib/cli.js', import.meta.url)), 'revoke', stateRoot, 'fix', '1'], { timeout: 10_000, maxBuffer: 4096 })
    expect(JSON.parse(revoked.stdout)).toMatchObject({ revoked: true, inFlightOutcome: 'requires-readback' })
    expect(JSON.stringify(await pending)).toContain('unknown'); expect(received).toBe(3)
    expect((await execute({ ...input, expectedHeadOid: head, idempotencyKey: 'revoked-next' })).isError).toBe(true); expect(received).toBe(3)
    const database = new DatabaseSync(join(stateRoot, 'ledger.sqlite'))
    try { expect(JSON.stringify(database.prepare('SELECT * FROM actions').all())).not.toContain(secret) } finally { database.close() }
    expect((await readFile(join(stateRoot, 'ledger.sqlite'))).includes(Buffer.from(secret))).toBe(false)
    expect(JSON.stringify([first, lostResult, ctx.credentialsKeychain.listLeases()])).not.toContain(secret)
  } finally {
    try {
      await plugin?.dispose(); await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    } finally { clock.mockRestore() }
  }
}, 30_000)
