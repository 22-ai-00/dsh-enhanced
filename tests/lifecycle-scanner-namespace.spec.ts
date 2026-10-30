import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService, type Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import { inspectAutomationRetirementSnapshot, type HostAutomationDefinition } from '@dsh-enhanced/assistant-automations'
import { externalPrincipalId, ownerRouteAuthorityHash, inspectRevokedOwnerRouteLocally } from '@dsh-enhanced/assistant-delivery'
import { afterEach, describe, expect, test } from 'vitest'
import { stringify } from 'yaml'
import { lifecycleProfileTest as api } from '../scripts/install/lifecycle-profile.mjs'
import { createRsiMemoryLearningSetup } from '../plugins/lark-channel/src/rsi-memory-learning.ts'
import { deriveScannerRetirementConfiguration } from '../plugins/lark-channel/src/rsi-scanner-retirement-config.ts'

const require = createRequire(import.meta.url)
const { AutomationStore } = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-automations/package.json')), 'lib/store.js')).href)
const { DeliveryStore } = await import(pathToFileURL(join(dirname(require.resolve('@dsh-enhanced/assistant-delivery/package.json')), 'lib/store.js')).href)
const available = process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/', '/',
  '--proc', '/proc', '--dev', '/dev', '--', '/bin/true'], { timeout: 5000 }).status === 0
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function identity(path: string) {
  const stat = await lstat(path)
  return { dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid, mode: stat.mode }
}
async function paths() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scanner-namespace-'))); roots.push(root)
  const home = join(root, 'home'), transaction = `${home}.dsh-enhanced-transaction`, staged = join(transaction, 'staged-home')
  await mkdir(home, { mode: 0o700 }); await mkdir(transaction, { mode: 0o700 })
  return { root, home, transaction, staged }
}
function sql<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try { return action(db) } finally { db.close() }
}

// This fixture supplies the parent's already-trusted owner provenance. The
// owner-source signature chain, package installer and systemd are separately
// verified; here the real journal/operator, namespace, Policy, Automations and
// SQLite transition run together, including a real physical Home rename.
async function maintenanceFixture(version: 15 | 16) {
  const f = await paths(), home = f.home
  const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
  const authority = { id: 'rsi-owner', conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm' as const, chat: 'oc_owner' },
    principal, workspace: join(home, 'workspace'), agentPreset: 'primary', policyRef: 'owner-dm', minimumGeneration: 1 }
  const delivery = new DeliveryStore({ path: join(home, 'delivery.sqlite'), codeGenerator: () => 'PAIR1234' })
  let paired
  try {
    const issued = delivery.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 3 })
    paired = delivery.confirmPairing({ challengeId: issued.challenge.id, principal, code: issued.code })
    delivery.createBinding({ conversation: authority.conversation, principal, workspace: authority.workspace, agentPreset: authority.agentPreset,
      sessionId: 'owner-session', policyRef: authority.policyRef })
    delivery.revokePrincipal(paired.id, paired.version)
  } finally { delivery.close() }
  const owner = { authorityId: authority.id, authorityHash: ownerRouteAuthorityHash(authority), principalId: externalPrincipalId(principal),
    principalRecordId: paired.id, principalVersion: paired.version, workspace: authority.workspace, agentPreset: authority.agentPreset }
  const scope = { ownerRouteId: owner.authorityId, principalId: owner.principalId, workspace: owner.workspace, preset: owner.agentPreset }
  const memory = createRsiMemoryLearningSetup({ installationId: 'namespace', stateRoot: join(home, 'learning'), owner, now: Date.now(), expiresAt: Date.now() + 60000 })
  const policy: PolicyConfig = { databasePath: join(home, 'policy.sqlite'), proposalMaintenanceIntervalMs: 1234,
    budgets: [{ id: 'existing-retirement', metric: 'maintenance', limit: 4, periodMs: 86400000, scope: 'global' }],
    rules: [{ id: 'existing-authorization', effect: 'allow', subject: { kind: 'background', id: '*', workspace: owner.workspace, principal: owner.principalId },
      actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] }, budget: { id: 'existing-retirement', amount: 1 } }] }
  const row = (name: string, config: unknown) => ({ id: `dsh-enhanced-${name}`, name: `@dsh-enhanced/${name}`, config })
  const client = { executable: { path: '/unavailable/client', sha256: 'b'.repeat(64) }, configPath: '/unavailable/authority.json', timeoutMs: 1000 }
  const effectiveConfig = stringify([
    row('personal-assistant', { assistantPolicy: policy, assistantAutomations: { databasePath: join(home, 'automations.sqlite'), runsPath: join(home, 'runs'),
      schedulerEnabled: true, reconcileIntervalMs: 4567 }, personalMemory: { databasePath: join(home, 'memory.sqlite'), automaticLearning: memory.adoption } }),
    row('assistant-delivery', { databasePath: join(home, 'delivery.sqlite'), defaultWorkspace: owner.workspace, defaultAgentPreset: owner.agentPreset, ownerRoutes: [authority] }),
    row('lark-channel', { enabled: true, account: 'primary', tenant: 'personal' }), row('assistant-memory-learning', memory.learning),
    row('assistant-growth-driver', { enabled: true, intervalMs: 0, budgetId: 'reviews', budgetAmount: 1, scope,
      usageLearning: { enabled: true, databasePath: join(home, 'growth.sqlite'), scanBudgetId: 'discovery', scanBudgetAmount: 1 } }),
    row('plugin-control-plane', { catalogPath: join(home, 'catalog.json'), statePath: join(home, 'control'), trustPath: join(home, 'trust.json'),
      taskObservations: { scope, profilePath: join(home, 'profiles', 'web'), timeoutMs: 300000, budgetId: 'observations', budgetAmount: 1, authority: client,
        policy: { id: 'observations', expiresAt: 1, maximumObservations: 1000, minimumChecks: 1, maximumChecks: 32, lookbackMs: 86400000 } },
      liveQualification: { scope, profilePath: join(home, 'profiles', 'web'), timeoutMs: 300000, budgetId: 'qualification', budgetAmount: 1, authority: client } }),
  ], { aliasDuplicateObjects: false })
  const derived = deriveScannerRetirementConfiguration({ effectiveConfig, dshHome: home, profile: 'web', owner })
  const definition: HostAutomationDefinition = { name: 'Original scanner', workspace: owner.workspace, agentPreset: owner.agentPreset, principal: owner.principalId,
    schedule: { kind: 'every', anchorAt: '2026-01-01T00:00:00.000Z', intervalMs: 60000 }, timeoutMs: 60000, misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    execution: { kind: 'host', executorId: 'original-scanner-v1', executorContractVersion: 1, catalogDigest: 'd'.repeat(64), runbookId: 'scan', runbookVersion: 1,
      targetScope: { workspace: owner.workspace, preset: owner.agentPreset }, scopeDigest: 'f'.repeat(64), ownerRouteId: owner.authorityId, activationNonce: 'original' } }
  const store = new AutomationStore({ path: join(home, 'automations.sqlite') })
  try {
    for (const target of derived.targets) store.reconcileSystemOwned({ ...target, idempotencyKey: target.owner, definition })
    store.reconcileSystemOwned({ owner: 'ordinary', automationId: 'ordinary', idempotencyKey: 'ordinary', definition })
  } finally { store.close() }
  sql(join(home, 'automations.sqlite'), db => {
    const now = Date.now()
    db.prepare("INSERT INTO automation_occurrences(id,automation_id,trigger_kind,trigger_key,scheduled_at,status,dry_run,created_at,updated_at) VALUES ('occ','ordinary','manual','manual',?,'unknown',0,?,?)").run(now, now, now)
    db.prepare("INSERT INTO automation_tasks(id,occurrence_id,automation_id,status,cancel_requested,attempt_count,created_at,updated_at) VALUES ('unknown','occ','ordinary','unknown',0,0,?,?)").run(now, now)
    if (version === 15) {
      for (const name of ['automation_retirements_no_update', 'automation_retirements_no_delete', 'automation_retired_no_activate_insert', 'automation_retired_no_activate_update']) db.exec(`DROP TRIGGER ${name}`)
      db.exec('DROP TABLE automation_system_retirements; PRAGMA user_version=15')
    }
  })
  const ctx = new Context(), fiber = ctx.plugin(AssistantPolicyService, { ...policy, proposalMaintenanceIntervalMs: 0 })
  try { await fiber.await() } finally { await fiber.dispose(); await ctx.fiber.dispose() }
  const moduleRoot = join(home, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'lark-channel')
  await mkdir(moduleRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}')
  await writeFile(join(moduleRoot, 'package.json'), JSON.stringify({ type: 'module', main: './index.mjs' }))
  await writeFile(join(moduleRoot, 'index.mjs'), `export * from ${JSON.stringify(pathToFileURL(require.resolve('@dsh-enhanced/lark-channel')).href)}\n`)
  await writeFile(join(home, 'effective.yml'), effectiveConfig, { mode: 0o600 })
  await writeFile(join(home, 'dsh'), `#!${process.execPath}\nimport {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(process.env.DSH_HOME+'/effective.yml'))\n`, { mode: 0o700 })
  await writeFile(join(home, 'package.json'), '{"type":"module"}')
  const before = inspectAutomationRetirementSnapshot(join(home, 'automations.sqlite'))
  const revoked = inspectRevokedOwnerRouteLocally(derived.ownerQuery)
  await cp(home, f.staged, { recursive: true, preserveTimestamps: true })
  const source = { effectiveConfigDigest: hash(effectiveConfig), databasePaths: { delivery: 'delivery.sqlite', automations: 'automations.sqlite', recovery: 'recovery.sqlite' },
    automationsProof: { storageDigest: before.storageDigest }, deliveryProof: { storageDigest: revoked.storageDigest },
    unmanagedAutomationsDigest: api.unmanagedAutomationDigest(before.records) }
  const manifest = { id: randomUUID(), version: 3, operation: 'upgrade', homePath: home, canonicalHome: home, profile: 'web',
    transactionPath: f.transaction, transactionIdentity: await identity(f.transaction), originalIdentity: await identity(home), stagedIdentity: await identity(f.staged),
    state: 'prepared', servicePhase: 'stopped', supervisedLifecycle: { phase: 'source-attested', source, scannerRetirement: undefined as unknown } }
  const sourceArtifact = await api.writeScannerArtifact(f.transaction, manifest, 'source', { protocol: 'dsh-enhanced/scanner-retirement-source/v1',
    transactionId: manifest.id, homePath: home, profile: 'web', source, effectiveConfig,
    ownerSource: { protocol: 'host-rsi/scanner-owner-source/v1', homePath: home, profile: 'web', owner, sourceDigest: hash(JSON.stringify(owner)) } })
  manifest.supervisedLifecycle.scannerRetirement = { protocol: 'dsh-enhanced/scanner-retirement-transaction/v1', phase: 'source-bound',
    transactionId: manifest.id, homePath: home, profile: 'web', originalIdentity: manifest.originalIdentity, stagedIdentity: manifest.stagedIdentity,
    sourceDigest: api.scannerBindingDigest(source), sourceArtifact }
  const sandbox = { bwrapExecutable: '/usr/bin/bwrap', homePath: home, stageHome: f.staged, profile: 'web', dshExecutable: join(home, 'dsh') }
  return { ...f, before, manifest, sandbox }
}

describe.skipIf(!available)('real scanner maintenance namespace', () => {
  test.each([15, 16] as const)('keeps the original Home intact and verifies the same retired database after swapping v%s', async version => {
    const f = await maintenanceFixture(version)
    const result = await api.prepareScannerRetirement({ manifest: f.manifest, physicalTransactionRoot: f.transaction, sandbox: f.sandbox })
    expect(result.supervisedLifecycle.scannerRetirement.phase).toBe('completed')
    const after = inspectAutomationRetirementSnapshot(join(f.staged, 'automations.sqlite'))
    expect(after.retirements).toHaveLength(4)
    expect(after.historyTables).toEqual(f.before.historyTables)
    expect(inspectAutomationRetirementSnapshot(join(f.home, 'automations.sqlite'))).toEqual(f.before)
    expect(sql(join(f.home, 'policy.sqlite'), db => db.prepare('SELECT count(*) AS n FROM budget_reservations').get()?.n)).toBe(0)
    expect(sql(join(f.staged, 'policy.sqlite'), db => db.prepare('SELECT count(*) AS n FROM budget_reservations').get()?.n)).toBe(4)
    const backup = join(f.transaction, 'original-home')
    await rename(f.home, backup); await rename(f.staged, f.home)
    await expect(api.assertScannerRetirementPersistent({ manifest: result, physicalTransactionRoot: f.transaction })).resolves.toBeUndefined()
    expect(inspectAutomationRetirementSnapshot(join(f.home, 'automations.sqlite'))).toEqual(after)
    // Rename won before any outer journal update: stage no longer exists.
    await expect(api.assertScannerOriginalRestorePossible(result, f.transaction)).rejects.toThrow('不存在')
    expect(sql(join(f.home, 'policy.sqlite'), db => db.prepare('SELECT count(*) AS n FROM budget_reservations').get()?.n)).toBe(4)
  }, 15000)

  test.each([1, 2, 3, 4])('SIGKILL after formal retirement %s preserves the prepared tuples and original Home', async count => {
    const f = await maintenanceFixture(15)
    const automationsUrl = pathToFileURL(require.resolve('@dsh-enhanced/assistant-automations')).href
    const larkUrl = pathToFileURL(require.resolve('@dsh-enhanced/lark-channel')).href
    // Only the crash trigger is injected. Each preceding call is the actual
    // Policy-authorized durable Automations operation in the child namespace.
    const injection = `import { AssistantAutomationsService as Service } from ${JSON.stringify(automationsUrl)};
const original = Service.prototype.retireSystemOwned; let completed = 0;
Service.prototype.retireSystemOwned = function(input) {
  const result = original.call(this, input);
  if (++completed === ${count}) process.kill(process.pid, 'SIGKILL');
  return result;
};
export * from ${JSON.stringify(larkUrl)};\n`
    await writeFile(join(f.staged, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'lark-channel', 'index.mjs'), injection)
    await expect(api.prepareScannerRetirement({ manifest: f.manifest, physicalTransactionRoot: f.transaction, sandbox: f.sandbox })).rejects.toThrow('failed')
    const persisted = JSON.parse(await readFile(join(f.transaction, 'manifest.json'), 'utf8'))
    expect(persisted.supervisedLifecycle.scannerRetirement.phase).toBe('prepared')
    const evidence = await api.readScannerRetirementEvidence(f.transaction, persisted)
    expect(evidence.captured.capture.plan.operations).toHaveLength(4)
    const partial = inspectAutomationRetirementSnapshot(join(f.staged, 'automations.sqlite'))
    expect(partial.retirements).toHaveLength(count)
    expect(partial.historyTables).toEqual(f.before.historyTables)
    expect(inspectAutomationRetirementSnapshot(join(f.home, 'automations.sqlite'))).toEqual(f.before)
    expect(sql(join(f.home, 'policy.sqlite'), db => db.prepare('SELECT count(*) AS n FROM budget_reservations').get()?.n)).toBe(0)
    expect(sql(join(f.staged, 'policy.sqlite'), db => db.prepare('SELECT count(*) AS n FROM budget_reservations').get()?.n)).toBe(count)
    await expect(lstat(join(f.transaction, 'scanner-retirement-completion.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(api.assertScannerOriginalRestorePossible(persisted, f.transaction)).resolves.toBeUndefined()
    expect(api.scannerBindingDigest(evidence.captured.capture.plan.operations)).toBe(api.scannerBindingDigest(
      (await api.readScannerRetirementEvidence(f.transaction, persisted)).captured.capture.plan.operations))
  }, 15000)

  test('timeout kills a listening descendant and leaves the original Home untouched', async () => {
    const f = await paths(); await mkdir(f.staged, { mode: 0o700 })
    await writeFile(join(f.home, 'original'), 'unchanged', { mode: 0o600 })
    const childCode = "const net=require('node:net'); net.createServer(s=>s.end('live')).listen(process.argv[1]); setInterval(()=>{},1000)"
    const program = `import {spawn} from 'node:child_process'; spawn(process.execPath,['--eval',${JSON.stringify(childCode)},${JSON.stringify(join(f.home, 'child.sock'))}],{stdio:'inherit'}); setInterval(()=>{},1000)`
    const started = Date.now()
    const outcome = api.sandboxRun({ bwrapExecutable: '/usr/bin/bwrap', homePath: f.home, stageHome: f.staged },
      [process.execPath, '--input-type=module', '--eval', program], { capture: true, timeoutMs: 2000 }).then(() => 'unexpected-success', error => String(error))
    const connect = () => new Promise<string>((resolve, reject) => {
      const socket = createConnection(join(f.staged, 'child.sock'))
      socket.setTimeout(500, () => socket.destroy(new Error('socket timeout')))
      socket.once('data', bytes => { resolve(bytes.toString()); socket.destroy() }); socket.once('error', reject)
    })
    let live = false
    while (Date.now() - started < 1500) {
      try { live = await connect() === 'live'; if (live) break } catch {}
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(live).toBe(true)
    expect(await outcome).toContain('timed out after 2000ms')
    await expect(connect()).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await readFile(join(f.home, 'original'), 'utf8')).toBe('unchanged')
    await expect(lstat(join(f.home, 'child.sock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 7000)
})
