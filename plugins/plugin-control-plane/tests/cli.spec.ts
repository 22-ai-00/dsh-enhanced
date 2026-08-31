import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, link, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { Ed25519HostAttestationAuthority, hostAttestationEvidenceDigest, hostAttestationSigningPayload } from '../src/attestation.ts'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.ts'
import { runPluginControl } from '../src/cli.ts'
import { invokeConfiguredHostAttestor, prepareConfiguredHostAttestation } from '../src/host-attestor.ts'
import { controlPlaneDigest, ControlPlaneStore, type CreateActivationPlanInput } from '../src/store.ts'
import { loadTrustConfig } from '../src/trust.ts'
import type { ApprovalReceipt, HostAttestationReceipt, PluginActivationPlan } from '../src/types.ts'

const roots: string[] = []
const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const ledgerId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01'
const candidate = exampleIntegrityPinnedCatalog.entries.find(item => item.id === 'assistant-health')!
let cachedInterpreter: { path: string; sha256: string } | undefined

async function fixtureInterpreter(): Promise<{ path: string; sha256: string }> {
  if (cachedInterpreter !== undefined) return cachedInterpreter
  const path = await realpath('/usr/bin/node')
  cachedInterpreter = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
  return cachedInterpreter
}

async function executable(path: string, content: string): Promise<void> { await writeFile(path, content, 'utf8'); await chmod(path, 0o700) }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-control-cli-')); roots.push(root)
  const dshHome = join(root, 'dsh'); const profile = join(dshHome, 'profiles', 'web'); const control = join(dshHome, 'plugin-control')
  await mkdir(profile, { recursive: true, mode: 0o700 }); await mkdir(join(control, 'plans'), { recursive: true, mode: 0o700 }); await chmod(control, 0o700)
  await writeFile(join(profile, 'marker'), 'original', 'utf8')
  const executor = join(root, 'dsh-executor')
  await executable(executor, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '%s\\n' '0.1.0-rc.8'; exit 0; fi
if [[ "\${DSH_TEST_FAIL:-0}" == '1' ]]; then printf '%s\\n' 'TOP-SECRET-STDERR' >&2; exit 27; fi
if [[ "\${1:-}" == 'plugin' ]]; then
  profile='web'
  for ((index = 1; index <= $#; index += 1)); do if [[ "\${!index}" == '--profile' ]]; then next=$((index + 1)); profile="\${!next}"; fi; done
  directory="$DSH_HOME/profiles/$profile"; mkdir -p "$directory"; printf '%b' "$DSH_TEST_LOCK" > "$directory/pnpm-lock.yaml"; exit 0
fi
exit 0
`)
  const keys = generateKeyPairSync('ed25519'); const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const attestorDirectory = join(root, 'host-attestor-state'); await mkdir(attestorDirectory, { mode: 0o700 })
  await writeFile(join(attestorDirectory, 'private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const now = Date.now()
  await writeFile(join(attestorDirectory, 'observations.json'), JSON.stringify({
    reload: { service: 'fixture-host' }, readiness: { checks: 2, failures: 0 },
    effectBlockedReplay: { deliveryAttempts: 2, deliveryBlocked: 2, toolExecutionAttempts: 2, toolExecutionBlocked: 2, externalEffects: 0 },
    shadow: { samples: 3, mismatches: 0, externalEffects: 0 }, canary: { samples: 2, failures: 0 },
    soak: { windowStartedAt: now - 2_000, windowEndedAt: now - 1_000, samples: 4, failures: 0 },
    health: { checks: 2, failures: 0 },
  }), { mode: 0o600 })
  const attestor = join(root, 'host-attestor')
  const interpreter = await fixtureInterpreter(); const interpreterPath = interpreter.path
  await executable(attestor, (await readFile(new URL('./fixtures/host-attestor.mjs', import.meta.url), 'utf8'))
    .replace('#!/usr/bin/env node', `#!${interpreterPath}`))
  const state = join(control, 'plans', 'control.sqlite')
  const executorSha256 = createHash('sha256').update(await readFile(executor)).digest('hex')
  const attestorSha256 = createHash('sha256').update(await readFile(attestor)).digest('hex')
  const trustPath = join(control, 'trust.json')
  const trust = { schemaVersion: 2, installationId, dshHome, ledger: { id: ledgerId, path: state },
    executor: { id: 'test-dsh', version: '0.1.0-rc.8', path: executor, sha256: executorSha256,
    environmentAllowlist: ['PATH', 'DSH_TEST_LOCK', 'DSH_TEST_FAIL'] },
    hostPolicy: { readinessMinimumChecks: 1, effectBlockedMinimumDeliveryAttempts: 1,
      effectBlockedMinimumToolExecutionAttempts: 1, shadowMinimumSamples: 1, shadowMaximumMismatches: 0,
      canaryMinimumSamples: 1, canaryMaximumFailures: 0, soakMinimumWindowMs: 1,
      soakMinimumSamples: 1, soakMaximumFailureRate: 0, healthMinimumChecks: 1, healthMaximumFailures: 0, receiptTtlMs: 30_000 },
    hostAttestor: { id: 'fixture-host-attestor', version: 'fixture-host-attestor-1', path: attestor, sha256: attestorSha256,
      interpreter,
      environmentAllowlist: ['HOST_ATTESTOR_FIXTURE_DIR', 'HOST_ATTESTOR_MODE', 'HOST_ATTESTOR_FAIL_PHASE'],
      authority: 'host-runtime', keyId: 'host-key-1', timeoutMs: 10_000 },
    approvalKeys: [{ authority: 'owner-policy', keyId: 'owner-key-1', publicKeyPem }],
    hostAttestationKeys: [{ authority: 'host-runtime', keyId: 'host-key-1', publicKeyPem }] }
  await writeFile(trustPath, `${JSON.stringify(trust)}\n`, { mode: 0o600 }); await chmod(trustPath, 0o600)
  return { root, dshHome, profile, control, executor, attestor, attestorDirectory, trustPath, trust, state, privateKey: keys.privateKey }
}

function input(value: Awaited<ReturnType<typeof fixture>>, gapId: string, key: string): CreateActivationPlanInput {
  return { candidate, catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
    matchedCapabilities: candidate.capabilities, profile: 'web', target: { dshHome: value.dshHome, profile: 'web', profilePath: value.profile },
    installationId, ledger: value.trust.ledger,
    executor: { id: 'test-dsh', version: '0.1.0-rc.8', path: value.executor, sha256: value.trust.executor.sha256 },
    ttlMs: 60_000, gapId, idempotencyKey: key }
}

function lockfile(plan: PluginActivationPlan): string {
  return `lockfileVersion: '9.0'\npackages:\n${plan.dossier.packages.map(item => `  '${item.package}@${item.version}':\n    resolution:\n      integrity: ${item.integrity}\n`).join('')}snapshots:\n`
}

async function approved(value: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginActivationPlan> {
  const store = new ControlPlaneStore({ path: value.state })
  const gap = store.recordGap({ idempotencyKey: `gap:${suffix}`, capability: 'health', context: `gap ${suffix}`, expectedValue: 10, frequency: 2, estimatedCost: 2, risk: 0 })
  const plan = store.createPlan(input(value, gap.id, `plan:${suffix}`)).result
  const now = Date.now()
  const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `approval-${suffix}`,
    authority: 'owner-policy', keyId: 'owner-key-1', planId: plan.id, planDigest: plan.digest, decision: 'approved',
    principal: 'owner@test', decidedAt: now, expiresAt: now + 30_000 }
  const receipt: ApprovalReceipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), value.privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(value.trust.approvalKeys[0]!.publicKeyPem, 'owner-policy', 'owner-key-1')
  const result = await store.approve({ planId: plan.id, expectedRevision: 1, receipt, resolveAuthority: () => authority, idempotencyKey: `approval:${suffix}` })
  store.close(); return result.result
}

async function staged(value: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginActivationPlan> {
  const plan = await approved(value, suffix)
  await withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(plan), DSH_TEST_FAIL: '0' },
    () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))
  const store = new ControlPlaneStore({ path: value.state }); const result = store.getPlan(plan.id); store.close()
  return result
}

async function configuredProbe(value: Awaited<ReturnType<typeof fixture>>, plan: PluginActivationPlan,
  mode = 'passed', failedPhase = ''): Promise<void> {
  await withEnvironment({ DSH_HOME: value.dshHome, HOST_ATTESTOR_FIXTURE_DIR: value.attestorDirectory,
    HOST_ATTESTOR_MODE: mode, HOST_ATTESTOR_FAIL_PHASE: failedPhase }, () => runPluginControl(['probe', '--plan-id', plan.id,
    '--expected-revision', String(plan.revision), '--expected-fence', String(plan.activation!.fence)]))
}

async function withEnvironment<T>(environment: Record<string, string>, action: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment)
  try { return await action() } finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

beforeEach(() => { vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write) })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe.sequential('trusted staged CLI', () => {
  test('uses only the pre-registered approval key and rejects command-supplied trust roots', async () => {
    await expect(runPluginControl(['approve', '--approved-by', 'anyone'])).rejects.toThrow('trust roots cannot be supplied')
    await expect(runPluginControl(['approve', '--approval-public-key', '/tmp/key'])).rejects.toThrow('command-supplied trust roots or ledgers are forbidden')
    await expect(runPluginControl(['probe', '--attestor-path', '/tmp/untrusted'])).rejects.toThrow('command-supplied trust roots or ledgers are forbidden')
  })

  test('stages with an allowlisted environment but stops at signed reload attestation instead of claiming activated', async () => {
    const value = await fixture(); const plan = await approved(value, 'staged')
    await withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(plan), DSH_TEST_FAIL: '0', UNREGISTERED_SECRET_TOKEN: 'must-not-inherit' },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))
    const inspect = new ControlPlaneStore({ path: value.state }); const staged = inspect.getPlan(plan.id); inspect.close()
    expect(staged.status).toBe('awaiting-reload')
    expect(staged.status).not.toBe('activated')
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('applies a signed failed Host receipt and restores the retained backup', async () => {
    const value = await fixture(); const plan = await approved(value, 'host-failure')
    await withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(plan), DSH_TEST_FAIL: '0' },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))
    const inspect = new ControlPlaneStore({ path: value.state }); const awaiting = inspect.getPlan(plan.id)
    const operation = inspect.prepareHostAttestationOperation({ planId: awaiting.id, expectedRevision: awaiting.revision,
      expectedFence: awaiting.activation!.fence, issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 30_000 }); inspect.close()
    const evidence = { kind: 'reload' as const, reloaded: false, previousHostGeneration: 0, currentHostGeneration: 1, probeDigest: 'd'.repeat(64) }
    const now = Date.now(); const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: 'host-failure-reload',
      authority: 'host-runtime', keyId: 'host-key-1', installationId, planId: awaiting.id, planDigest: awaiting.digest,
      activationId: awaiting.activation!.id, fence: awaiting.activation!.fence, phase: 'reload', outcome: 'failed',
      operationId: operation.operationId, requestDigest: operation.requestDigest, hostGeneration: 1, evidence,
      evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: now, expiresAt: now + 30_000 }
    const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), value.privateKey).toString('base64') }
    const receiptPath = join(value.control, 'host-receipt.json'); await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['attest', '--plan-id', awaiting.id,
      '--expected-revision', String(awaiting.revision), '--expected-fence', String(awaiting.activation!.fence),
      '--receipt', receiptPath]))
    const terminal = new ControlPlaneStore({ path: value.state }); expect(terminal.getPlan(plan.id).status).toBe('rolled-back'); terminal.close()
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('removes a promoted profile on rollback when the target originally did not exist', async () => {
    const value = await fixture(); const plan = await approved(value, 'host-failure-no-target')
    await rm(value.profile, { recursive: true })
    await withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(plan), DSH_TEST_FAIL: '0' },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))
    const inspect = new ControlPlaneStore({ path: value.state }); const awaiting = inspect.getPlan(plan.id)
    const operation = inspect.prepareHostAttestationOperation({ planId: awaiting.id, expectedRevision: awaiting.revision,
      expectedFence: awaiting.activation!.fence, issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 30_000 }); inspect.close()
    expect(awaiting.activation?.targetOriginallyExisted).toBe(false)
    const evidence = { kind: 'reload' as const, reloaded: false, previousHostGeneration: 0, currentHostGeneration: 1, probeDigest: 'e'.repeat(64) }
    const now = Date.now(); const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2,
      receiptId: 'host-failure-no-target-reload', authority: 'host-runtime', keyId: 'host-key-1', installationId,
      planId: awaiting.id, planDigest: awaiting.digest, activationId: awaiting.activation!.id, fence: awaiting.activation!.fence,
      operationId: operation.operationId, requestDigest: operation.requestDigest, phase: 'reload', outcome: 'failed', hostGeneration: 1,
      evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: now, expiresAt: now + 30_000 }
    const receipt: HostAttestationReceipt = { ...unsigned,
      signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), value.privateKey).toString('base64') }
    const receiptPath = join(value.control, 'host-no-target-receipt.json')
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['attest', '--plan-id', awaiting.id,
      '--expected-revision', String(awaiting.revision), '--expected-fence', String(awaiting.activation!.fence),
      '--receipt', receiptPath]))
    await expect(readFile(join(value.profile, 'pnpm-lock.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const terminal = new ControlPlaneStore({ path: value.state }); expect(terminal.getPlan(plan.id).status).toBe('rolled-back'); terminal.close()
  })

  test('recovers a crash between profile backup rename and stage promotion with a new fence', async () => {
    const value = await fixture(); const approvedPlan = await approved(value, 'crash-rename')
    const store = new ControlPlaneStore({ path: value.state }); let claimed = store.claimActivation({ planId: approvedPlan.id, expectedRevision: approvedPlan.revision, leaseMs: 5_000 })
    claimed = store.recordActivationTargetBaseline({ planId: claimed.id, expectedRevision: claimed.revision,
      fence: claimed.activation!.fence, existed: true }); store.close()
    const suffix = claimed.activation!.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
    const backup = join(value.dshHome, 'profiles', `.web.plugin-backup-${suffix}`); const stage = join(value.dshHome, 'profiles', `stage-${suffix}`)
    await rename(value.profile, backup); await mkdir(stage); await writeFile(join(stage, 'partial'), 'crash residue')
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(claimed.id); raw.close()
    await withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(claimed), DSH_TEST_FAIL: '0' },
      () => runPluginControl(['activate', '--plan-id', claimed.id, '--expected-revision', String(claimed.revision)]))
    const inspect = new ControlPlaneStore({ path: value.state }); const recovered = inspect.getPlan(claimed.id); inspect.close()
    expect(recovered).toMatchObject({ status: 'awaiting-reload', activation: { id: claimed.activation!.id, fence: claimed.activation!.fence + 1 } })
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('never steals a lock from a live worker and never exposes executor stderr', async () => {
    const value = await fixture(); const approvedPlan = await approved(value, 'lock')
    const store = new ControlPlaneStore({ path: value.state }); const claimed = store.claimActivation({ planId: approvedPlan.id, expectedRevision: approvedPlan.revision, leaseMs: 5_000 }); store.close()
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(claimed.id); raw.close()
    const lock = join(value.dshHome, 'profiles', '.plugin-control-web.lock')
    await writeFile(lock, `${JSON.stringify({ schemaVersion: 1, planId: claimed.id, activationId: claimed.activation!.id,
      fence: claimed.activation!.fence, pid: process.pid, nonce: 'live-owner' })}\n`, { mode: 0o600 })
    await expect(withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(claimed), DSH_TEST_FAIL: '1' },
      () => runPluginControl(['activate', '--plan-id', claimed.id, '--expected-revision', String(claimed.revision)])))
      .rejects.toThrow('LOCK_CONFLICT')
    await rm(lock)
    const latestStore = new ControlPlaneStore({ path: value.state }); const latest = latestStore.getPlan(claimed.id); latestStore.close()
    const raw2 = new DatabaseSync(value.state); raw2.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(latest.id); raw2.close()
    await expect(withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(latest), DSH_TEST_FAIL: '1' },
      () => runPluginControl(['activate', '--plan-id', latest.id, '--expected-revision', String(latest.revision)])))
      .rejects.not.toThrow('TOP-SECRET-STDERR')
  })

  test('rejects secret-bearing environment allowlist entries in the owner trust file', async () => {
    const value = await fixture(); const invalid = { ...value.trust, executor: { ...value.trust.executor, environmentAllowlist: ['PATH', 'API_TOKEN'] } }
    await writeFile(value.trustPath, JSON.stringify(invalid), { mode: 0o600 }); await chmod(value.trustPath, 0o600)
    await expect(loadTrustConfig(value.trustPath)).rejects.toThrow('secret-bearing')
    await writeFile(value.trustPath, JSON.stringify({ ...value.trust,
      hostAttestor: { ...value.trust.hostAttestor, environmentAllowlist: ['NODE_OPTIONS'] } }), { mode: 0o600 })
    await expect(loadTrustConfig(value.trustPath)).rejects.toThrow('invalid or secret-bearing')
    await writeFile(value.trustPath, JSON.stringify({ ...value.trust,
      hostAttestor: { ...value.trust.hostAttestor, interpreter: null } }), { mode: 0o600 })
    await expect(loadTrustConfig(value.trustPath)).rejects.toThrow('interpreter')
  })

  test('rejects writable and hard-linked registered executors', async () => {
    const writable = await fixture()
    await chmod(writable.executor, 0o722)
    await expect(loadTrustConfig(writable.trustPath)).rejects.toThrow('non-writable')

    const hardlinked = await fixture(); const alias = join(hardlinked.root, 'executor-alias')
    await link(hardlinked.executor, alias)
    await expect(loadTrustConfig(hardlinked.trustPath)).rejects.toThrow('non-writable')
  })

  test('runs every signed deployment phase through the fixed subprocess contract and activates only after health', async () => {
    const value = await fixture(); let plan = await staged(value, 'configured-all-phases')
    const statuses = ['awaiting-reload', 'awaiting-readiness', 'awaiting-effect-blocked-replay', 'awaiting-shadow',
      'awaiting-canary', 'awaiting-soak', 'awaiting-health'] as const
    for (const status of statuses) {
      expect(plan.status).toBe(status)
      await configuredProbe(value, plan)
      const store = new ControlPlaneStore({ path: value.state }); plan = store.getPlan(plan.id); store.close()
    }
    expect(plan.status).toBe('activated')
    await expect(readFile(join(value.attestorDirectory, 'canary-exposures'), 'utf8')).resolves.toBe('1')
    const database = new DatabaseSync(value.state)
    expect((database.prepare("SELECT count(*) AS count FROM host_attestation_operations WHERE status = 'applied'").get() as { count: number }).count).toBe(7)
    expect((database.prepare('SELECT count(*) AS count FROM host_attestations').get() as { count: number }).count).toBe(7)
    const reloadRequest = JSON.parse((database.prepare("SELECT request_json FROM host_attestation_operations WHERE plan_id = ? AND phase = 'reload'")
      .get(plan.id) as { request_json: string }).request_json) as Record<string, unknown>
    expect(reloadRequest).toMatchObject({ schemaVersion: 1, kind: 'dsh-host-attestation-request', installationId,
      ledger: value.trust.ledger, plan: { id: plan.id, digest: plan.digest },
      activation: { id: plan.activation!.id, fence: 1 }, profile: { name: 'web', path: value.profile },
      issuer: { mode: 'configured-executable', id: 'fixture-host-attestor', path: value.attestor,
        sha256: value.trust.hostAttestor.sha256, authority: 'host-runtime', keyId: 'host-key-1' },
      phase: 'reload', requirements: { kind: 'reload', previousHostGeneration: 0 } })
    database.close()
  }, 15_000)

  test('stays awaiting when no executable attestor is configured while preserving the manual request lane', async () => {
    const value = await fixture(); const plan = await staged(value, 'no-attestor')
    await writeFile(value.trustPath, JSON.stringify({ ...value.trust, hostAttestor: null }), { mode: 0o600 })
    await expect(configuredProbe(value, plan)).rejects.toThrow('HOST_ATTESTOR_NOT_CONFIGURED')
    const store = new ControlPlaneStore({ path: value.state }); expect(store.getPlan(plan.id).status).toBe('awaiting-reload'); store.close()
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['host-request', '--plan-id', plan.id,
      '--expected-revision', String(plan.revision), '--expected-fence', String(plan.activation!.fence)]))
    const database = new DatabaseSync(value.state)
    expect((database.prepare("SELECT status FROM host_attestation_operations WHERE plan_id = ? AND phase = 'reload'").get(plan.id) as { status: string }).status).toBe('pending')
    database.close()
  })

  test.each(['wrong-request-digest', 'wrong-key', 'wrong-phase', 'bad-evidence', 'bad-signature'])(
    'rejects a configured attestor response with %s without advancing the plan', async mode => {
      const value = await fixture(); const plan = await staged(value, `invalid-${mode}`)
      await expect(configuredProbe(value, plan, mode)).rejects.toThrow()
      const store = new ControlPlaneStore({ path: value.state }); expect(store.getPlan(plan.id).status).toBe('awaiting-reload'); store.close()
    })

  test('automatically restores the profile after a valid signed failed probe', async () => {
    const value = await fixture(); const plan = await staged(value, 'configured-failure')
    await configuredProbe(value, plan, 'failed', 'reload')
    const store = new ControlPlaneStore({ path: value.state }); expect(store.getPlan(plan.id).status).toBe('rolled-back'); store.close()
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('reuses one durable canary operation after crash-before-commit and the external issuer rejects changed payload', async () => {
    const value = await fixture(); let plan = await staged(value, 'canary-crash')
    for (let index = 0; index < 4; index += 1) {
      await configuredProbe(value, plan)
      const store = new ControlPlaneStore({ path: value.state }); plan = store.getPlan(plan.id); store.close()
    }
    expect(plan.status).toBe('awaiting-canary')
    const trust = await loadTrustConfig(value.trustPath); const beforeCrash = new ControlPlaneStore({ path: value.state })
    const operation = prepareConfiguredHostAttestation(beforeCrash, plan, trust); beforeCrash.close()
    await withEnvironment({ HOST_ATTESTOR_FIXTURE_DIR: value.attestorDirectory, HOST_ATTESTOR_MODE: 'passed', HOST_ATTESTOR_FAIL_PHASE: '' },
      () => invokeConfiguredHostAttestor(trust, operation.request))
    await expect(readFile(join(value.attestorDirectory, 'canary-exposures'), 'utf8')).resolves.toBe('1')
    await expect(withEnvironment({ HOST_ATTESTOR_FIXTURE_DIR: value.attestorDirectory, HOST_ATTESTOR_MODE: 'passed', HOST_ATTESTOR_FAIL_PHASE: '' },
      () => invokeConfiguredHostAttestor(trust, { ...operation.request, profile: { ...operation.request.profile, name: 'changed' } }))).rejects.toThrow('non-zero')
    await configuredProbe(value, plan)
    await expect(readFile(join(value.attestorDirectory, 'canary-exposures'), 'utf8')).resolves.toBe('1')
    const recovered = new ControlPlaneStore({ path: value.state }); expect(recovered.getPlan(plan.id).status).toBe('awaiting-soak'); recovered.close()
  }, 15_000)

  test('serializes concurrent canary workers behind one durable operation and one exposure', async () => {
    const value = await fixture(); let plan = await staged(value, 'canary-concurrent')
    for (let index = 0; index < 4; index += 1) {
      await configuredProbe(value, plan)
      const store = new ControlPlaneStore({ path: value.state }); plan = store.getPlan(plan.id); store.close()
    }
    const trust = await loadTrustConfig(value.trustPath); const store = new ControlPlaneStore({ path: value.state })
    const operation = prepareConfiguredHostAttestation(store, plan, trust)
    const authority = new Ed25519HostAttestationAuthority(value.trust.hostAttestationKeys[0]!.publicKeyPem, 'host-runtime', 'host-key-1')
    const receipt = await withEnvironment({ HOST_ATTESTOR_FIXTURE_DIR: value.attestorDirectory,
      HOST_ATTESTOR_MODE: 'passed', HOST_ATTESTOR_FAIL_PHASE: '' }, () => store.runHostAttestationOperation({
      operationId: operation.operationId, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      resolveAuthority: () => authority,
      execute: async request => {
        const contender = `const { DatabaseSync } = require('node:sqlite'); const database = new DatabaseSync(process.argv[1]);
          database.exec('PRAGMA busy_timeout=0'); try { database.exec('BEGIN IMMEDIATE'); process.stdout.write('acquired'); database.exec('ROLLBACK') }
          catch { process.stdout.write('busy') } finally { database.close() }`
        expect(execFileSync(process.execPath, ['-e', contender, value.state], { encoding: 'utf8' })).toBe('busy')
        return invokeConfiguredHostAttestor(trust, request)
      },
    }))
    await store.applyHostAttestation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
      receipt, resolveAuthority: () => authority, idempotencyKey: `host-attestation:${operation.operationId}` })
    store.close()
    await expect(readFile(join(value.attestorDirectory, 'canary-exposures'), 'utf8')).resolves.toBe('1')
    const inspect = new ControlPlaneStore({ path: value.state }); expect(inspect.getPlan(plan.id).status).toBe('awaiting-soak'); inspect.close()
  }, 15_000)

  test('rejects a changed configured attestor digest before execution', async () => {
    const value = await fixture()
    await writeFile(value.trustPath, JSON.stringify({ ...value.trust,
      hostAttestor: { ...value.trust.hostAttestor, sha256: '0'.repeat(64) } }), { mode: 0o600 })
    await expect(loadTrustConfig(value.trustPath)).rejects.toThrow('digest changed')
  })
})
