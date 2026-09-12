import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { AssistantActionsService } from '../src/service.ts'
import { ActionLedger } from '../src/ledger.ts'
import type { ActionGrant } from '../src/types.ts'

const oid = 'a'.repeat(40)
const branch = { grantId: 'fix', idempotencyKey: 'branch', baseHeadOid: oid }
const pr = { grantId: 'fix', idempotencyKey: 'pr', expectedHeadOid: oid, title: 'Fix', body: 'Changes' }
const inspect = { grantId: 'fix', kind: 'repository' }
const secret = 'fixture-workflow-secret'
const cleanups: Array<() => Promise<void>> = []
async function fixture(enabled = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-service-')))
  await writeFile(join(root, 'secret'), secret, { mode: 0o600 })
  const ctx = new Context(), id = SessionId('workflow-session')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: root, agentPreset: 'primary' })
  const owner: Agent = { id, options: { provider: 'test', model: 'test' }, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context, status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(owner as unknown as { ctx: Context }).ctx = createScope(ctx, owner).ctx
  session.append('turn/start', { turn: 1 }); session.append('approval/policy', { policy: 'ask' })
  const grant: ActionGrant = { id: 'fix', revision: 1, principalDigest: createHash('sha256').update('owner').digest('hex'), principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', repository: 'owner/repository', branch: 'fix', paths: ['a.txt'], credentialHandle: 'github', expiresAt: Date.now() + 120_000, maxActions: 10, maxTotalBytes: 100_000, repoWorkflow: { baseBranch: 'main', allowBranchCreate: true, allowPullRequest: true } }
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'allow', rules: [
    { id: 'action', effect: 'allow', subject: { kind: 'agent', id: 'primary' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:fix' } },
    { id: 'credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential', id: 'github' } },
  ] })
  await ctx.plugin(CredentialsKeychainService, { databasePath: join(root, 'credentials.sqlite'), handles: [{ id: 'github', provider: 'linux-protected-file', path: join(root, 'secret'), consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30_000 }] })
  ctx.provide('agents' as never, { get: (value: string) => value === id ? owner : undefined } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }) } as never)
  ctx.on('approval/request', async () => 'rejected')
  type Workflow = NonNullable<ConstructorParameters<typeof AssistantActionsService>[3]>
  const workflow: Workflow = {
    branch: vi.fn<Workflow['branch']>(async input => ({ actionId: input.actionId, status: 'succeeded', branch: 'fix' })),
    pullRequest: vi.fn<Workflow['pullRequest']>(async input => ({ actionId: input.actionId, status: 'succeeded', pullRequestNumber: 7 })),
    inspect: vi.fn(async () => ({ observed: { full_name: 'owner/repository' } })),
  }
  let plugin: { dispose(): Promise<void> }
  const load = async () => { plugin = await ctx.plugin({ name: 'dsh-enhanced-assistant-actions', apply(runtime: Context) { new AssistantActionsService(runtime, { stateRoot: join(root, 'actions'), grants: enabled ? [grant] : [] }, undefined, workflow) } }) as unknown as typeof plugin }
  await load()
  const result = { ctx, workflow, grant, load,
    dispose: async () => await plugin.dispose(),
    execute: async (name: string, args: object) => await ctx.tools.execute({ callId: ToolCallId(Math.random().toString()), name, arguments: args, signal: new AbortController().signal, agent: owner }),
    revoke: () => { const ledger = new ActionLedger(join(root, 'actions/ledger.sqlite')); try { ledger.revoke('fix', 1) } finally { ledger.close() } },
    rows: () => { const db = new DatabaseSync(join(root, 'actions/ledger.sqlite')); try { return db.prepare('SELECT * FROM actions').all() } finally { db.close() } },
    cleanup: async () => { await plugin.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) },
  }
  cleanups.push(result.cleanup)
  return result
}
import { afterEach } from 'vitest'
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

test('branch and PR receipts survive restart, duplicates do not redispatch, and reads consume a distinct durable action', async () => {
  const f = await fixture()
  const first = await f.execute('action_github_branch', branch)
  expect(first.isError, JSON.stringify(first)).toBe(false); expect(JSON.stringify(first)).toContain('succeeded')
  expect(JSON.stringify(await f.execute('action_github_pr', pr))).toContain('succeeded')
  await f.dispose(); await f.load()
  expect(JSON.stringify(await f.execute('action_github_branch', branch))).toContain('succeeded')
  expect(JSON.stringify(await f.execute('action_github_pr', pr))).toContain('succeeded')
  expect(f.workflow.branch).toHaveBeenCalledTimes(1); expect(f.workflow.pullRequest).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(await f.execute('action_github_inspect', inspect))).toContain('owner/repository')
  expect(f.rows().map(row => row.kind)).toEqual(['branch', 'pull-request', 'inspect'])
  expect(f.rows()[2]?.expected_head_oid).toBe('')
  expect(JSON.stringify(f.rows())).not.toContain(secret)
  expect((await f.execute('action_github_inspect', { grantId: 'fix', kind: 'file', path: 'outside.txt' })).isError).toBe(true)
  expect(f.workflow.inspect).toHaveBeenCalledTimes(1)
})

test.each(['branch', 'pullRequest', 'inspect'] as const)('%s rechecks a revocation while waiting for credential access', async kind => {
  const f = await fixture()
  const original = f.ctx.credentialsKeychain.withSecret.bind(f.ctx.credentialsKeychain)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  vi.spyOn(f.ctx.credentialsKeychain, 'withSecret').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return await original(...args) })
  const pending = f.execute(kind === 'branch' ? 'action_github_branch' : kind === 'pullRequest' ? 'action_github_pr' : 'action_github_inspect', kind === 'branch' ? branch : kind === 'pullRequest' ? pr : inspect)
  await entered.promise; f.revoke(); gate.resolve()
  const outcome = await pending
  expect(JSON.stringify(outcome)).not.toContain('succeeded'); expect(f.workflow[kind]).not.toHaveBeenCalled()
  expect(f.rows()[0]?.status).toBe('failed')
})

test.each(['branch', 'pullRequest', 'inspect'] as const)('%s aborts on plugin disposal and suppresses a late observed result', async kind => {
  const f = await fixture(), entered = Promise.withResolvers<void>()
  const blocked = async (input: { actionId?: string; signal: AbortSignal }) => {
    entered.resolve(); await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    return kind === 'inspect' ? { observed: { late: 'must-not-be-released' } } : { actionId: input.actionId!, status: 'succeeded' as const }
  }
  // Only the fixed transport is controlled here; ToolRuntime, Policy, Keychain,
  // the durable reservation, live revocation polling and disposal are real.
  vi.mocked(f.workflow[kind]).mockImplementation(blocked as never)
  const pending = f.execute(kind === 'branch' ? 'action_github_branch' : kind === 'pullRequest' ? 'action_github_pr' : 'action_github_inspect', kind === 'branch' ? branch : kind === 'pullRequest' ? pr : inspect)
  await entered.promise; await f.dispose()
  expect(JSON.stringify(await pending)).not.toContain('must-not-be-released')
  expect(f.rows()[0]?.status).toBe('unknown')
  await f.load()
})

test('an unconfigured installed broker exposes no unusable GitHub tools', async () => {
  const f = await fixture(false)
  expect(f.ctx.tools.schemas().some(tool => tool.name.startsWith('action_github_'))).toBe(false)
  expect((await f.execute('action_github_branch', branch)).isError).toBe(true)
  expect(f.workflow.branch).not.toHaveBeenCalled()
})
