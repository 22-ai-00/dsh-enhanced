import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'
import { RestartStore } from '../src/restart-store.ts'
import {
  createSystemRestartSupervisor,
  inspectRestartDeliveryAuthority,
  inspectRestartAutomationQuiescence,
  inspectRestartPolicyAndCode,
  runLockedRestartSupervisorTick,
  runRestartSupervisorTick,
  type RestartSupervisorConfig,
  type RestartSupervisorSystem,
} from '../src/restart-supervisor.ts'

const roots: string[] = []
const sourceInvocationId = 'a'.repeat(32)
const newInvocationId = 'b'.repeat(32)
const expectedUnitDigest = createHash('sha256').update('fixed-unit').digest('hex')
const now0 = 1_700_000_000_000

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(noticeStatus: 'accepted' | 'unknown_after_send' = 'accepted') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restart-supervisor-'))
  roots.push(root)
  const deliveryDatabasePath = join(root, 'delivery.sqlite')
  const databasePath = join(root, 'restart.sqlite')
  const automationDatabasePath = join(root, 'automation.sqlite')
  const automations = new DatabaseSync(automationDatabasePath)
  automations.exec(`CREATE TABLE automation_tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE automation_attempts(id TEXT PRIMARY KEY,status TEXT NOT NULL);`)
  automations.close()
  let now = now0
  const principal = { channel: 'lark', account: 'assistant', tenant: 'tenant', user: 'owner' }
  const conversation = { channel: 'lark', account: 'assistant', tenant: 'tenant', kind: 'dm' as const, chat: 'chat' }
  const delivery = new DeliveryStore({ path: deliveryDatabasePath, now: () => now, codeGenerator: () => 'PAIR1234' })
  const pairing = delivery.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 3 })
  delivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
  const owner = delivery.getPrincipal(principal)!
  const binding = delivery.createBinding({ conversation, principal, workspace: '/work/restart',
    agentPreset: 'primary', sessionId: 'session-restart', policyRef: 'owner-dm' })
  const inbox = delivery.acceptInbound({ channel: 'lark', account: 'assistant', eventId: 'event-restart',
    occurredAt: now, principal, conversation, kind: 'text', text: 'resume this task' }).record
  delivery.queueInbox(inbox.id, binding.id)
  const claim = delivery.claimInbox({ ownerId: 'inbound-worker', leaseMs: 60_000, limit: 1, maxAttempts: 3 })[0]!
  delivery.bindForegroundTaskExecution({ inboxId: inbox.id,
    scope: { workspace: binding.workspace, preset: binding.agentPreset },
    owner: { principalRecordId: owner.id, principalVersion: owner.version }, binding, dispatchedAt: now })
  delivery.finishInbox({ inboxId: inbox.id, ownerId: 'inbound-worker', fencingToken: claim.fencingToken,
    outcome: 'processed' })
  const raw = new DatabaseSync(deliveryDatabasePath)
  raw.prepare(`INSERT INTO delivery_session_leases(
    session_id,holder_id,fencing_token,lease_until,state,target_json,principal_record_id,principal_version)
    VALUES (?,?,?,?,?,?,?,?)`).run(binding.sessionId, 'old-host', 1, now + 10_000,
    'released', JSON.stringify({ kind: 'bound' }), owner.id, owner.version)
  raw.prepare(`INSERT INTO outbox_messages(
    id,idempotency_key,binding_id,intent_hash,intent_json,channel,account,lane_hash,status,
    provider_message_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('outbox-restart-notice',
    `inbound:${inbox.id}:maintenance`, binding.id, 'f'.repeat(64), '{}', 'lark', 'assistant',
    'e'.repeat(64), noticeStatus, noticeStatus === 'accepted' ? 'om_restart_notice' : null, now, now)
  raw.close()
  const restart = new RestartStore({ path: databasePath, now: () => now })
  restart.beginTask({ inboxId: inbox.id, eventId: inbox.eventId,
    binding: { id: binding.id, version: binding.version, generation: binding.generation,
      sessionId: binding.sessionId, workspace: binding.workspace, preset: binding.agentPreset,
      policyRef: binding.policyRef, authorityHash: 'c'.repeat(64),
      conversation, principal },
    owner: { principalRecordId: owner.id, principalVersion: owner.version },
    sourceInvocationId, maxModelRequests: 3, maxToolCalls: 3, maxOutputTokens: 2_000,
    capabilityDigest: 'd'.repeat(64), deadline: now + 60_000 })
  restart.captureModel(inbox.id, { provider: 'provider', model: 'model' })
  const request = restart.request(inbox.id, { reason: 'maintenance', requestKey: 'restart-request-1' })
  restart.checkpoint(request.id, { sessionEventCount: 3, sessionDigest: 'a'.repeat(64),
    continuationMessageId: 'continuation-1', continuationTextDigest: 'b'.repeat(64) })
  restart.ready(request.id)
  const fenced = new DatabaseSync(deliveryDatabasePath)
  fenced.exec('CREATE TABLE IF NOT EXISTS delivery_restart_fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1), request_id TEXT, source_invocation_id TEXT)')
  fenced.prepare('INSERT INTO delivery_restart_fence(singleton,request_id,source_invocation_id) VALUES(1,?,?)')
    .run(request.id, sourceInvocationId)
  fenced.close()
  const config: RestartSupervisorConfig = { dshHome: root, profile: 'assistant', databasePath,
    deliveryDatabasePath, unit: 'dsh-profile-assistant.service', expectedUnitDigest,
    policyDatabasePath: join(root, 'assistant-policy', 'policy.sqlite'),
    automationDatabasePath,
    policyEvaluatorPath: join(root, 'packages', 'assistant-policy', 'lib', 'evaluator.js'),
    profilePatchDigest: 'e'.repeat(64), cohortReceiptDigest: 'f'.repeat(64), sourceCommit: '1'.repeat(40),
    restartOwnerRouteId: 'owner-route-1',
    hostBindingDigest: '2'.repeat(64), hostReceiptPath: '/tmp/dsh-restart-test-host-receipt.json',
    hostReceiptSourceDigest: '3'.repeat(64),
    trustedFiles: [
      { path: join(root, 'packages', 'assistant-policy', 'lib', 'evaluator.js'), digest: 'a'.repeat(64) },
      { path: join(root, 'packages', 'assistant-delivery', 'lib', 'service.js'), digest: 'b'.repeat(64) },
      { path: join(root, 'packages', 'assistant-delivery', 'lib', 'restart-supervisor.js'), digest: 'c'.repeat(64) },
    ], policyRules: [],
    readyTimeoutMs: 5_000, stableWindowMs: 1_000, maxRestarts: 3, windowMs: 600_000 }
  const close = () => { restart.close(); delivery.close() }
  return { root, deliveryDatabasePath, automationDatabasePath, restart, delivery, inbox, owner, binding, request, config,
    now: () => now, advance(ms: number) { now += ms }, close }
}

function fakeSystem(advance: (ms: number) => void) {
  let invocationId = sourceInvocationId
  let restarted = 0
  let ready = true
  let transaction = false
  const system: RestartSupervisorSystem = {
    async unit() { return { invocationId, active: true, mainPid: 42, fragmentPath: '/fixed/unit' } },
    async restart() { restarted += 1; invocationId = newInvocationId },
    async ready() { return ready },
    async withLock(_home, task) { return task() },
    async transactionExists() { return transaction },
    async unitDigest() { return expectedUnitDigest },
    async authority() { return true },
    async sleep(ms) { advance(ms) },
  }
  return { system, get restarted() { return restarted }, set ready(value: boolean) { ready = value },
    set transaction(value: boolean) { transaction = value }, set invocationId(value: string) { invocationId = value } }
}

describe('fixed-unit restart supervisor', () => {
  test('reopening the supervisor does not reset a dispatched restart observation deadline', async () => {
    const f = await fixture()
    try {
      f.restart.claimRestart(f.request.id, { holderId: 'old-supervisor', invocationId: sourceInvocationId })
      f.advance(f.config.readyTimeoutMs + 1)
      const system = fakeSystem(f.advance)
      expect(await runRestartSupervisorTick(f.config, f.restart, { system: system.system, now: f.now })).toBe('failed')
      expect(system.restarted).toBe(0)
      expect(f.restart.getRequest(f.request.id)?.failureCode).toBe('restart-outcome-unknown')
    } finally { f.close() }
  })

  test('waits for an already claimed outbound send before restarting', async () => {
    const f = await fixture()
    try {
      const db = new DatabaseSync(f.deliveryDatabasePath)
      try {
        db.exec(`INSERT INTO outbox_messages(id,idempotency_key,binding_id,intent_hash,intent_json,channel,account,lane_hash,status,created_at,updated_at)
          SELECT 'other-send','other-send',binding_id,intent_hash,intent_json,channel,account,lane_hash,'attempting',created_at,updated_at
          FROM outbox_messages WHERE id='outbox-restart-notice'`)
      } finally { db.close() }
      const system = fakeSystem(f.advance)
      expect(await runRestartSupervisorTick(f.config, f.restart, { system: system.system, now: f.now })).toBe('deferred')
      expect(system.restarted).toBe(0)
      expect(f.restart.getRequest(f.request.id)?.status).toBe('ready')
    } finally { f.close() }
  })

  test('a durably accepted stop blocks restart before its async conversation transition', async () => {
    const f = await fixture()
    try {
      f.delivery.acceptInbound({ ...f.inbox.envelope, eventId: 'pending-stop', kind: 'command', text: '/stop' })
      expect(inspectRestartDeliveryAuthority(f.deliveryDatabasePath, f.restart.getTask(f.inbox.id)!, f.request.id)).toBe('invalid')
      const system = fakeSystem(f.advance)
      expect(await runRestartSupervisorTick(f.config, f.restart, { system: system.system, now: f.now })).toBe('failed')
    } finally { f.close() }
  })

  test('restarts once after exact durable owner and quiescence checks', async () => {
    const f = await fixture()
    try {
      const system = fakeSystem(f.advance)
      expect(inspectRestartDeliveryAuthority(f.deliveryDatabasePath, f.restart.getTask(f.inbox.id)!, f.request.id)).toBe('ready')
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('restarted')
      expect(system.restarted).toBe(1)
      expect(f.restart.getRequest(f.request.id)?.status).toBe('restarted')
      expect(f.restart.countDispatchedSince(now0)).toBe(1)
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('idle')
      expect(system.restarted).toBe(1)
    } finally { f.close() }
  })

  test('uncertain command result and recovered worker only observe the new invocation', async () => {
    const f = await fixture()
    try {
      const system = fakeSystem(f.advance)
      system.system.restart = async () => { throw new Error('lost systemctl result') }
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('failed')
      expect(f.restart.countDispatchedSince(now0)).toBe(1)
      expect(f.restart.getRequest(f.request.id)?.status).toBe('failed')
    } finally { f.close() }
    const next = await fixture()
    try {
      next.restart.claimRestart(next.request.id, { holderId: 'worker-one', invocationId: sourceInvocationId })
      const system = fakeSystem(next.advance)
      system.invocationId = newInvocationId
      expect(await runRestartSupervisorTick(next.config, next.restart,
        { system: system.system, now: next.now })).toBe('restarted')
      expect(system.restarted).toBe(0)
    } finally { next.close() }
  })

  test('revoked owner, claimed work, and unit drift refuse restart', async () => {
    const revoked = await fixture()
    try {
      revoked.delivery.revokePrincipal(revoked.owner.id, revoked.owner.version)
      const system = fakeSystem(revoked.advance)
      expect(await runRestartSupervisorTick(revoked.config, revoked.restart,
        { system: system.system, now: revoked.now })).toBe('failed')
      expect(system.restarted).toBe(0)
    } finally { revoked.close() }
    const claimed = await fixture()
    try {
      claimed.delivery.clearRestartFence(claimed.request.id)
      const raw = new DatabaseSync(claimed.deliveryDatabasePath)
      try { raw.prepare("UPDATE inbox_messages SET status='claimed' WHERE id=?").run(claimed.inbox.id) }
      finally { raw.close() }
      claimed.delivery.setRestartFence(claimed.request.id, sourceInvocationId)
      const system = fakeSystem(claimed.advance)
      expect(await runRestartSupervisorTick(claimed.config, claimed.restart,
        { system: system.system, now: claimed.now })).toBe('failed')
      expect(system.restarted).toBe(0)
    } finally { claimed.close() }
    const drift = await fixture()
    try {
      const system = fakeSystem(drift.advance)
      system.system.unitDigest = async () => '0'.repeat(64)
      expect(await runRestartSupervisorTick(drift.config, drift.restart,
        { system: system.system, now: drift.now })).toBe('failed')
      expect(system.restarted).toBe(0)
    } finally { drift.close() }
  })

  test('missing request fence and another active Session lease refuse the restart', async () => {
    const missing = await fixture()
    try {
      const raw = new DatabaseSync(missing.deliveryDatabasePath)
      raw.exec('DELETE FROM delivery_restart_fence')
      raw.close()
      expect(inspectRestartDeliveryAuthority(missing.deliveryDatabasePath,
        missing.restart.getTask(missing.inbox.id)!, missing.request.id)).toBe('invalid')
      const system = fakeSystem(missing.advance)
      expect(await runRestartSupervisorTick(missing.config, missing.restart,
        { system: system.system, now: missing.now })).toBe('failed')
      expect(system.restarted).toBe(0)
    } finally { missing.close() }
    const concurrent = await fixture()
    try {
      const raw = new DatabaseSync(concurrent.deliveryDatabasePath)
      raw.prepare(`INSERT INTO delivery_session_leases(session_id,holder_id,fencing_token,lease_until,state,target_json,
        principal_record_id,principal_version) VALUES(?,?,?,?,?,?,?,?)`).run('other-session', 'other', 2,
        now0 + 60_000, 'dispatched', '{}', concurrent.owner.id, concurrent.owner.version)
      raw.close()
      const system = fakeSystem(concurrent.advance)
      expect(await runRestartSupervisorTick(concurrent.config, concurrent.restart,
        { system: system.system, now: concurrent.now })).toBe('failed')
      expect(system.restarted).toBe(0)
    } finally { concurrent.close() }
  })

  test('an active automation job blocks a restart; uncertain terminal work does not run in this Host', async () => {
    const f = await fixture()
    try {
      const raw = new DatabaseSync(f.automationDatabasePath)
      raw.prepare('INSERT INTO automation_tasks(id,status) VALUES(?,?)').run('job-one', 'running')
      expect(inspectRestartAutomationQuiescence(f.automationDatabasePath)).toBe(false)
      const system = fakeSystem(f.advance)
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('failed')
      expect(system.restarted).toBe(0)
      raw.prepare('UPDATE automation_tasks SET status=? WHERE id=?').run('unknown', 'job-one')
      expect(inspectRestartAutomationQuiescence(f.automationDatabasePath)).toBe(true)
      raw.close()
    } finally { f.close() }
  })

  test('current Policy denial blocks execution even with a durable ready request', async () => {
    const f = await fixture()
    try {
      const system = fakeSystem(f.advance)
      system.system.authority = async () => false
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('failed')
      expect(f.restart.getRequest(f.request.id)?.failureCode).toBe('restart-policy-or-code-changed')
      expect(system.restarted).toBe(0)
    } finally { f.close() }
  })

  test('real Policy evaluator requires allow, no emergency stop, and frozen code/config bytes', async () => {
    const f = await fixture()
    try {
      const cohort = join(f.root, 'rsi-local-cohorts', 'assistant')
      const profile = join(f.root, 'profiles', 'assistant')
      const policy = join(f.root, 'packages', 'assistant-policy')
      const delivery = join(f.root, 'packages', 'assistant-delivery')
      await Promise.all([mkdir(cohort, { recursive: true }), mkdir(profile, { recursive: true }),
        mkdir(join(policy, 'lib'), { recursive: true }), mkdir(join(delivery, 'lib'), { recursive: true }),
        mkdir(join(f.root, 'assistant-policy'), { recursive: true })])
      const evaluator = (await readFile(new URL('../../assistant-policy/lib/evaluator.js', import.meta.url), 'utf8'))
        .replace(/^\/\/# sourceMappingURL=.*$/mu, '')
      await writeFile(join(policy, 'package.json'), '{"type":"module"}')
      await writeFile(join(policy, 'lib', 'evaluator.js'), evaluator)
      await writeFile(join(delivery, 'lib', 'service.js'), 'const service = 1\n')
      await writeFile(join(delivery, 'lib', 'restart-supervisor.js'), 'const restart = 1\n')
      const receipt = JSON.stringify({ sourceCommit: '1'.repeat(40), root: cohort, packages: [] })
      const patch = '- id: policy\n'
      await writeFile(join(cohort, 'receipt.json'), receipt)
      await writeFile(join(profile, 'cordis.patch.yml'), patch)
      const policyDatabasePath = join(f.root, 'assistant-policy', 'policy.sqlite')
      const external = await mkdtemp(join(tmpdir(), 'dsh-restart-host-'))
      roots.push(external)
      const hostRoot = join(external, 'hosts', '0.2.1-rc.2')
      await mkdir(join(hostRoot, 'node_modules', '.bin'), { recursive: true })
      await mkdir(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
      const hostBinSource = 'export const host = 1\n'
      const hostManifestSource = '{"name":"@deepseek-ai/dsh"}'
      await writeFile(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), hostBinSource)
      await writeFile(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), hostManifestSource)
      await symlink('../@deepseek-ai/dsh/lib/bin.js', join(hostRoot, 'node_modules', '.bin', 'dsh'))
      const hostReceipt = JSON.stringify({ schemaVersion: 1, version: '0.2.1-rc.2', entries: [
        { path: 'node_modules/.bin/dsh', type: 'link', target: '../@deepseek-ai/dsh/lib/bin.js' },
        { path: 'node_modules/@deepseek-ai/dsh/lib/bin.js', type: 'file', sha256: createHash('sha256').update(hostBinSource).digest('hex') },
        { path: 'node_modules/@deepseek-ai/dsh/package.json', type: 'file', sha256: createHash('sha256').update(hostManifestSource).digest('hex') },
      ] })
      const hostReceiptPath = join(hostRoot, 'receipt.json')
      await writeFile(hostReceiptPath, hostReceipt)
      const hostBinding = JSON.stringify({ schemaVersion: 1, cacheRoot: join(external, 'hosts'),
        version: '0.2.1-rc.2', receiptDigest: createHash('sha256').update(hostReceipt).digest('hex') })
      await writeFile(join(f.root, '.dsh-rsi-host.json'), hostBinding)
      const policyDb = new DatabaseSync(policyDatabasePath)
      policyDb.exec('CREATE TABLE emergency_state(singleton INTEGER PRIMARY KEY,enabled INTEGER NOT NULL)')
      policyDb.prepare('INSERT INTO emergency_state(singleton,enabled) VALUES(1,0)').run()
      const task = f.restart.getTask(f.inbox.id)!
      const config = { ...f.config, policyDatabasePath,
        policyRules: [{ id: 'exact-restart', effect: 'allow',
          subject: { kind: 'agent', id: task.binding.preset, workspace: task.binding.workspace,
            principal: 'lark/assistant/tenant/owner' }, actions: ['maintenance.restart'],
          resource: { kind: 'message', id: 'maintenance:owner-route-1' }, context: { initiators: ['external'] } }],
        profilePatchDigest: createHash('sha256').update(patch).digest('hex'),
        cohortReceiptDigest: createHash('sha256').update(receipt).digest('hex'),
        hostBindingDigest: createHash('sha256').update(hostBinding).digest('hex'),
        hostReceiptPath, hostReceiptSourceDigest: createHash('sha256').update(hostReceipt).digest('hex'),
        trustedFiles: [join(policy, 'lib', 'evaluator.js'), join(delivery, 'lib', 'service.js'),
          join(delivery, 'lib', 'restart-supervisor.js')].map(path => ({ path,
          digest: createHash('sha256').update(path.endsWith('evaluator.js') ? evaluator
            : path.endsWith('service.js') ? 'const service = 1\n' : 'const restart = 1\n').digest('hex') })),
        policyEvaluatorPath: join(policy, 'lib', 'evaluator.js') }
      expect(await inspectRestartPolicyAndCode(config, task)).toBe(true)
      expect(await inspectRestartPolicyAndCode(config,
        { ...task, binding: { ...task.binding, id: 'new-binding-after-new' } })).toBe(true)
      expect(await inspectRestartPolicyAndCode({ ...config, policyRules: [] }, task)).toBe(false)
      policyDb.prepare('UPDATE emergency_state SET enabled=1 WHERE singleton=1').run()
      expect(await inspectRestartPolicyAndCode(config, task)).toBe(false)
      policyDb.prepare('UPDATE emergency_state SET enabled=0 WHERE singleton=1').run()
      await writeFile(join(delivery, 'lib', 'service.js'), 'const service = 2\n')
      expect(await inspectRestartPolicyAndCode(config, task)).toBe(false)
      await writeFile(join(delivery, 'lib', 'service.js'), 'const service = 1\n')
      await writeFile(join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'export const host = 2\n')
      expect(await inspectRestartPolicyAndCode(config, task)).toBe(false)
      policyDb.close()
    } finally { f.close() }
  })

  test('defers under upgrade transaction and refuses a request beyond the durable window budget', async () => {
    const f = await fixture()
    try {
      const system = fakeSystem(f.advance)
      system.transaction = true
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('deferred')
      expect(f.restart.getRequest(f.request.id)?.status).toBe('ready')
      system.transaction = false
      const limited = { ...f.config, maxRestarts: 1 }
      const priorDispatchLedger = {
        listRequests: f.restart.listRequests.bind(f.restart),
        getTask: f.restart.getTask.bind(f.restart),
        countDispatchedSince: () => 1,
        claimRestart: f.restart.claimRestart.bind(f.restart),
        markRestarted: f.restart.markRestarted.bind(f.restart),
        fail: f.restart.fail.bind(f.restart),
      }
      expect(await runRestartSupervisorTick(limited, priorDispatchLedger,
        { system: system.system, now: f.now })).toBe('failed')
      expect(f.restart.getRequest(f.request.id)?.failureCode).toBe('restart-budget-exhausted')
      expect(system.restarted).toBe(0)
    } finally { f.close() }
  })

  test('defers while the original maintenance acknowledgement has an unknown send result', async () => {
    const f = await fixture('unknown_after_send')
    try {
      const system = fakeSystem(f.advance)
      expect(inspectRestartDeliveryAuthority(f.deliveryDatabasePath, f.restart.getTask(f.inbox.id)!, f.request.id))
        .toBe('notice-pending')
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('deferred')
      expect(f.restart.getRequest(f.request.id)?.status).toBe('ready')
      expect(system.restarted).toBe(0)
    } finally { f.close() }
  })

  test('does not accept a fresh process without its own Host and channel readiness', async () => {
    const f = await fixture()
    try {
      const system = fakeSystem(f.advance)
      system.ready = false
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('failed')
      expect(system.restarted).toBe(1)
      expect(f.restart.getRequest(f.request.id)?.status).toBe('failed')
      expect(f.restart.getRequest(f.request.id)?.failureCode).toBe('restart-outcome-unknown')
      expect(await runRestartSupervisorTick(f.config, f.restart,
        { system: system.system, now: f.now })).toBe('idle')
      expect(system.restarted).toBe(1)
    } finally { f.close() }
  })

  // The production system adapter uses Linux flock and the installer's exact
  // /tmp rendezvous. Portable supervisor behavior is covered with fakeSystem.
  test.skipIf(process.platform !== 'linux')('the real kernel rendezvous lock excludes a second supervisor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-restart-lock-'))
    roots.push(root)
    const system = createSystemRestartSupervisor()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const first = system.withLock(root, async () => { entered(); await blocked; return 'first' })
    await enteredPromise
    expect(await system.withLock(root, async () => 'second')).toBeUndefined()
    release()
    expect(await first).toBe('first')
    expect(await system.withLock(root, async () => 'third')).toBe('third')
  })

  test.skipIf(process.platform !== 'linux')('a busy installer lock prevents the helper from opening any Home ledger', async () => {
    const f = await fixture()
    try {
      const system = createSystemRestartSupervisor()
      let release!: () => void
      const blocked = new Promise<void>(resolve => { release = resolve })
      let entered!: () => void
      const enteredPromise = new Promise<void>(resolve => { entered = resolve })
      const held = system.withLock(f.root, async () => { entered(); await blocked })
      await enteredPromise
      let opens = 0
      const result = await runLockedRestartSupervisorTick(f.config, () => {
        opens += 1
        throw new Error('journal must not open behind the installer')
      }, { system })
      expect(result).toBe('deferred')
      expect(opens).toBe(0)
      release()
      await held
    } finally { f.close() }
  })

  test.skipIf(process.platform !== 'linux')('two processes sharing the durable journal cannot each issue the restart', async () => {
    const f = await fixture()
    const contender = new RestartStore({ path: f.config.databasePath, now: f.now })
    try {
      const system = fakeSystem(f.advance)
      system.system.withLock = createSystemRestartSupervisor().withLock
      const results = await Promise.all([
        runRestartSupervisorTick(f.config, f.restart, { system: system.system, now: f.now }),
        runRestartSupervisorTick(f.config, contender, { system: system.system, now: f.now }),
      ])
      expect(results).toContain('restarted')
      expect(results.every(result => ['restarted', 'deferred', 'idle'].includes(result))).toBe(true)
      expect(system.restarted).toBe(1)
      expect(contender.countDispatchedSince(now0)).toBe(1)
    } finally { contender.close(); f.close() }
  })
})
