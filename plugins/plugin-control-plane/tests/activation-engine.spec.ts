import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { activatePluginPlan } from '../src/cli.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import type { ApprovalReceipt } from '../src/types.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'

const roots: string[] = []
const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const ledgerId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01'

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(waitForAbort = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-activation-engine-')); roots.push(root)
  const dshHome = join(root, 'dsh'); const profile = join(dshHome, 'profiles', 'web'); const state = join(root, 'control.sqlite')
  await mkdir(profile, { recursive: true, mode: 0o700 }); await writeFile(join(profile, 'marker'), 'original')
  const pidFile = join(root, 'executor-child.pid'); const traceFile = join(root, 'executor.trace'); const executor = join(root, 'executor')
  const packageName = '@fixture/engine'; const version = '1.0.0'
  const lockfile = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '${packageName}':\n        specifier: ${version}\n        version: ${version}\npackages:\n  '${packageName}@${version}':\n    resolution:\n      integrity: sha512-Zml4dHVyZQ==\nsnapshots:\n`
  await writeFile(executor, `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${JSON.stringify(traceFile)}
if [[ "\${1:-}" == '--version' ]]; then echo '1.0.0'; exit 0; fi
if [[ "\${1:-}" == 'plugin' ]] && ${waitForAbort ? 'true' : 'false'}; then
  ( while :; do sleep 1; done ) & echo "$!" > ${JSON.stringify(pidFile)}; wait
fi
profile=web
for ((i=1;i<=$#;i++)); do if [[ "\${!i}" == '--profile' ]]; then j=$((i+1)); profile="\${!j}"; fi; done
dir="$DSH_HOME/profiles/$profile"; mkdir -p "$dir/node_modules/@fixture/engine"
printf '%b' ${JSON.stringify(lockfile)} > "$dir/pnpm-lock.yaml"
printf '{"name":"@fixture/engine","version":"1.0.0"}' > "$dir/node_modules/@fixture/engine/package.json"
`, { mode: 0o700 })
  await chmod(executor, 0o700)
  const keys = generateKeyPairSync('ed25519'); const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const trust = { schemaVersion: 2, installationId, dshHome, ledger: { id: ledgerId, path: state },
    executor: { id: 'fixture-executor', version: '1.0.0', path: executor,
      sha256: createHash('sha256').update(await readFile(executor)).digest('hex'), environmentAllowlist: ['PATH'] },
    hostPolicy: { readinessMinimumChecks: 1, effectBlockedMinimumDeliveryAttempts: 1, effectBlockedMinimumToolExecutionAttempts: 1,
      shadowMinimumSamples: 1, shadowMaximumMismatches: 0, canaryMinimumSamples: 1, canaryMaximumFailures: 0,
      soakMinimumWindowMs: 1, soakMinimumSamples: 1, soakMaximumFailureRate: 0, healthMinimumChecks: 1, healthMaximumFailures: 0, receiptTtlMs: 30_000 },
    hostAttestor: null, approvalKeys: [{ authority: 'owner', keyId: 'key', publicKeyPem }], hostAttestationKeys: [] } as unknown as PluginControlTrustConfig
  const store = new ControlPlaneStore({ path: state }); const gap = store.recordGap({ idempotencyKey: `gap-${waitForAbort}`, capability: 'fixture', context: 'activation engine', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  const candidate = { id: 'fixture-engine', package: packageName, version, integrity: 'sha512-Zml4dHVyZQ==', capabilities: ['fixture'], requires: [], authorities: ['fixture-owner'], dshBaseline: '1.0.0' }
  const created = store.createPlan({ candidate, catalog: { digest: controlPlaneDigest({ schemaVersion: 1, entries: [candidate] }), provenance: 'owner-provided-integrity-pinned' },
    matchedCapabilities: ['fixture'], profile: 'web', target: { dshHome, profile: 'web', profilePath: profile }, installationId, ledger: trust.ledger,
    executor: { id: 'fixture-executor', version: '1.0.0', path: executor, sha256: trust.executor.sha256 }, ttlMs: 60_000, gapId: gap.id, idempotencyKey: `plan-${waitForAbort}` }).result
  const now = Date.now(); const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `approval-${waitForAbort}`, authority: 'owner', keyId: 'key', planId: created.id, planDigest: created.digest, decision: 'approved', principal: 'owner', decidedAt: now, expiresAt: now + 30_000 }
  const receipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), keys.privateKey).toString('base64') }
  const approved = await store.approve({ planId: created.id, expectedRevision: created.revision, receipt,
    resolveAuthority: () => new Ed25519ApprovalAuthority(publicKeyPem, 'owner', 'key'), idempotencyKey: `approval-${waitForAbort}` })
  return { store, trust, plan: approved.result, pidFile, traceFile }
}

describe('shared activation engine', () => {
  test('stages through the real fixture executor without stdout or closing the caller store', async () => {
    const f = await fixture(); const stdout = vi.spyOn(process.stdout, 'write')
    try {
      const result = await activatePluginPlan({ store: f.store, trust: f.trust, planId: f.plan.id, expectedRevision: f.plan.revision })
      expect(result.status).toBe('awaiting-reload'); expect(stdout).not.toHaveBeenCalled()
      expect(f.store.getPlan(f.plan.id).status).toBe('awaiting-reload')
    } finally { stdout.mockRestore(); f.store.close() }
  })

  test.runIf(process.platform === 'linux')('cancels a running fixture executor only after its process group is drained', async () => {
    const f = await fixture(true); const controller = new AbortController(); const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const flight = activatePluginPlan({ store: f.store, trust: f.trust, planId: f.plan.id, expectedRevision: f.plan.revision, signal: controller.signal })
      await expect.poll(async () => { try { return Number(await readFile(f.pidFile, 'utf8')) > 0 } catch { return false } }).toBe(true)
      const pid = Number(await readFile(f.pidFile, 'utf8')); controller.abort()
      await expect(flight).rejects.toMatchObject({ name: 'ActivationCancelledError' })
      expect(() => process.kill(pid, 0)).toThrow(); expect(f.store.getPlan(f.plan.id).status).toBe('rolled-back'); expect(stdout).not.toHaveBeenCalled()
    } finally { stdout.mockRestore(); f.store.close() }
  })
})
