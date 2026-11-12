/**
 * D3a-0b activation fixture: real staging install, real profile load and real
 * runtime observer. Test-only Host attestor executable, test-only signing keys.
 *
 * Entry discovery rule (also documented in the test): after `activatePluginPlan`
 * swaps the profile, read the profile's `cordis.patch.yml` back, find the entry
 * whose `name` is the candidate package, derive `target.entryId = include:<entry.id>`,
 * module = entry.name, configDigest = runtimeConfigDigest(entry.config ?? null),
 * then rewrite the control-plane entry's runtimeObserver targets in the same
 * patch. No id is guessed before the install exists.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../../../src/approval.ts'
import { loadCatalogWithMetadata } from '../../../src/catalog.ts'
import { activatePluginPlan, probePluginPlan } from '../../../src/cli.ts'
import { runtimeConfigDigest } from '../../../src/runtime-observer.ts'
import { queryRuntimeObserver } from '../../../src/runtime-observer.ts'
import { loadTrustConfig } from '../../../src/trust.ts'
import type { PluginControlTrustConfig } from '../../../src/trust.ts'
import { realLocalReleaseFixture } from './release.ts'
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function pin(path: string) { return { path: await fileURLToPath(pathToFileURL(path)), sha256: sha(await readFile(path)) } }

function findEntries(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) { for (const item of node) findEntries(item, out); return }
  if (node === null || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (typeof record.name === 'string') out.push(record)
  for (const value of Object.values(record)) findEntries(value, out)
}
function findEntry(node: unknown, predicate: (entry: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  const entries: Record<string, unknown>[] = []; findEntries(node, entries)
  return entries.find(predicate)
}

export async function realLocalActivationFixture() {
  const release = await realLocalReleaseFixture()
  const cleanup: (() => Promise<void>)[] = []
  try {
    const completed = await release.advance()
    if (completed.status !== 'release-complete') throw new Error('release did not complete')
    const nodePath = await fileURLToPath(pathToFileURL(process.execPath))
    const dsh = await realpath(process.env.DSH_REAL_LOCAL_DSH!)
    const profile = 'e2e', home = release.home, profilePath = join(home, 'profiles', profile)
    // 1. Real executor wrapper: pinned node + the real dsh launcher (dsh is a JS CLI).
    const binDir = join(release.root, 'bin'); await mkdir(binDir, { recursive: true, mode: 0o700 })
    const executorPath = join(binDir, 'dsh')
    const wrapperSource = '#!' + nodePath + '\nconst { spawnSync } = require("node:child_process")\n' +
      'const result = spawnSync(process.execPath, [' + JSON.stringify(dsh) + ', ...process.argv.slice(2)], { stdio: "inherit", env: process.env })\n' +
      'process.exit(result.status ?? 1)\n'
    await writeFile(executorPath, wrapperSource, { mode: 0o700 }); await chmod(executorPath, 0o700)
    const executorPin = await pin(executorPath)
    // 2. Test-only Host attestor executable.
    const attestorPath = join(release.root, 'adapters', 'host-attestor.mjs')
    await copyFile(new URL('./host-attestor.mjs', import.meta.url), attestorPath)
    const attestorLines = (await readFile(attestorPath, 'utf8')).split('\n')
    attestorLines[0] = '#!' + nodePath
    await writeFile(attestorPath, attestorLines.join('\n'), { mode: 0o700 }); await chmod(attestorPath, 0o700)
    const attestorPin = await pin(attestorPath)
    const rawTrust = { ...release.rawTrust,
      hostPolicy: { ...(release.rawTrust.hostPolicy as unknown as Record<string, unknown>), receiptTtlMs: 60_000 },
      executor: { id: 'dsh', version: release.policy.dshBaseline, ...executorPin,
        environmentAllowlist: ['PATH', 'HOME', 'TMPDIR', 'PNPM_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
          'DSH_TEST_PNPM_ROOT'] },
      hostAttestor: { id: 'e2e-host-attestor', version: 'e2e-host-attestor-1', ...attestorPin,
        interpreter: await pin(nodePath), authority: 'host', keyId: 'host', timeoutMs: 120_000,
        environmentAllowlist: ['DSH_REAL_LOCAL_HOST_ATTESTOR_CONFIG'] } }
    await writeFile(release.trustPath, JSON.stringify(rawTrust), { mode: 0o600 })
    const trust: PluginControlTrustConfig = await loadTrustConfig(release.trustPath)
    // 3. Base profile from the real dsh default web profile, then the control-plane entry.
    execFileSync(nodePath, [dsh, '--profile', profile, '--from-default-profile', 'web', '--dump-config'], {
      cwd: home, timeout: 120_000, env: { ...process.env, DSH_HOME: home, HOME: release.root, DSH_TELEMETRY_DISABLED: '1' } })
    const observerDirectory = join(release.root, 'observer'); await mkdir(observerDirectory, { mode: 0o700 })
    const socketPath = join(observerDirectory, 'runtime.sock'), keyPath = join(observerDirectory, 'observer.key')
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
    const controlPackage = join(release.root, 'control-package')
    const { prepareRealHostControlPackage } = await import(new URL('../../../../../scripts/e2e/real-host-control-package.mjs', import.meta.url).href) as {
      prepareRealHostControlPackage(dsh: string, target: string): Promise<{ controlUrl: URL }> }
    const { controlUrl } = await prepareRealHostControlPackage(dsh, controlPackage)
    const controlManifest = JSON.parse(await readFile(join(controlPackage, 'package.json'), 'utf8')) as { name: string; version: string }
    // The gate dsh runtime is older than the control-plane peer range. Grant the
    // exact-version exemption in this disposable profile so the real Host loads
    // the row; this is test-profile state, never a shipped config change.
    execFileSync(nodePath, [dsh, 'plugin', '--profile', profile, 'allow-version',
      controlManifest.name + '@' + controlManifest.version, '--dsh-version', release.policy.dshBaseline, '--accept-risk'],
    { cwd: home, timeout: 120_000, env: { ...process.env, DSH_HOME: home, HOME: release.root } })
    const controlState = join(release.root, 'control-state')
    const placeholder = { entryId: 'include:placeholder', module: 'placeholder', configDigest: '0'.repeat(64), services: [] as string[] }
    const profilePatch = [{ insert: [{ id: 'e2e-control', name: controlUrl.href,
      config: { statePath: controlState, catalogPath: release.policy.catalogPath, trustPath: release.trustPath,
        runtimeObserver: { socketPath, keyPath, profilePath, targets: [placeholder] } } }] }]
    await writeFile(join(profilePath, 'cordis.patch.yml'), JSON.stringify(profilePatch, null, 2), { mode: 0o600 })
    // 4. Activation plan + approval + handoff.
    const candidate = release.store.sourceReleaseCandidate(release.plan.id)!
    const catalog = await loadCatalogWithMetadata(release.policy.catalogPath)
    // C: no owner-bound source binding / handoff / liveQualification. The release
    // products still come from the real D3a-0a plan; activation is a Host-local
    // installation whose readiness correctly stops at awaiting-effect-blocked-replay.
    let plan = release.store.createPlan({ gapId: release.plan.gapId, candidate,
      catalog: { digest: catalog.digest, provenance: catalog.provenance }, matchedCapabilities: candidate.capabilities,
      profile, target: { dshHome: home, profile, profilePath }, installationId: trust.installationId, ledger: trust.ledger,
      executor: { id: 'dsh', version: release.policy.dshBaseline, ...executorPin },
      ttlMs: 300_000, idempotencyKey: 'd3b-plan:' + release.plan.id }).result
    const approvalUnsigned = { schemaVersion: 1 as const, approvalId: 'd3b-approval', authority: 'approval', keyId: 'approval',
      planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
    const approvalReceipt = { ...approvalUnsigned, signature: (await import('node:crypto')).sign(null,
      Buffer.from(approvalSigningPayload(approvalUnsigned)), release.keys.approval.privateKey).toString('base64') }
    plan = (await release.store.approve({ planId: plan.id, expectedRevision: plan.revision, receipt: approvalReceipt,
      idempotencyKey: 'd3b-approval', resolveAuthority: () => new Ed25519ApprovalAuthority(
        release.keys.approval.publicKey.export({ format: 'pem', type: 'spki' }).toString(), 'approval', 'approval') })).result
    // 5. Real staging install + atomic profile swap.
    plan = await activatePluginPlan({ store: release.store, trust, planId: plan.id, expectedRevision: plan.revision })
    if (plan.status !== 'awaiting-reload') throw new Error('activation did not reach awaiting-reload: ' + plan.status)
    // 6. Discover the installed candidate entry from the actual profile patch and rewrite targets.
    const patchPath = join(profilePath, 'cordis.patch.yml'), patchText = await readFile(patchPath, 'utf8')
    const patch = parseYaml(patchText) as unknown
    let candidateEntry = findEntry(patch, entry => entry.name === release.policy.packageName)
    if (!candidateEntry) {
      // On the gate dsh runtime the profile manifest's bundle list does not mount
      // the installed bundle patch; pin the same installed package through the
      // profile patch so the real Loader still imports the shipped bundle.
      const groups = Array.isArray(patch) ? patch : []
      const group = groups.find(item => item !== null && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).insert))
      const inserted = { id: release.policy.candidateId, name: release.policy.packageName }
      if (group) (group as { insert: unknown[] }).insert.push(inserted)
      else groups.push({ insert: [inserted] })
      candidateEntry = inserted
    }
    if (!candidateEntry) throw new Error('installed candidate entry was not found in the profile patch')
    // Installed bundles are composed directly into the profile root (no Include
    // wrapper on this dsh version), so the Loader entry id is the bundle-local id.
    const entryId = typeof candidateEntry.id === 'string' ? candidateEntry.id : release.policy.candidateId
    const targets = [{ entryId, module: String(candidateEntry.name),
      configDigest: runtimeConfigDigest(candidateEntry.config ?? null), services: [] as string[] }]
    const controlEntry = findEntry(patch, entry => entry.id === 'e2e-control')
    if (!controlEntry) throw new Error('control-plane entry disappeared from the profile patch')
    const controlConfig = controlEntry.config as Record<string, unknown>
    const observer = { ...(controlConfig.runtimeObserver as Record<string, unknown>), targets }
    controlEntry.config = { ...controlConfig, runtimeObserver: observer }
    await writeFile(patchPath, stringifyYaml(patch), { mode: 0o600 })
    const hostConfigPath = join(release.root, 'host-attestor.json')
    const attestationModule = fileURLToPath(new URL('../../../lib/attestation.js', import.meta.url))
    const observerModule = fileURLToPath(new URL('../../../lib/runtime-observer.js', import.meta.url))
    const writeHostConfig = async (tamper: boolean) => {
      await writeFile(hostConfigPath, JSON.stringify({ version: 'e2e-host-attestor-1', dsh, node: nodePath, home, profile,
        hostKeyPath: join(release.root, 'keys', 'host.key'), statePath: join(release.root, 'host-attestor-state.json'),
        attestationModule, observerModule, authority: 'host', keyId: 'host',
        observer: { socketPath, keyPath, profilePath, targets }, tamper, tamperEntryId: entryId }), { mode: 0o600 })
    }
    await writeHostConfig(false)
    const previous = process.env.DSH_REAL_LOCAL_HOST_ATTESTOR_CONFIG
    process.env.DSH_REAL_LOCAL_HOST_ATTESTOR_CONFIG = hostConfigPath
    cleanup.push(async () => { if (previous === undefined) delete process.env.DSH_REAL_LOCAL_HOST_ATTESTOR_CONFIG
      else process.env.DSH_REAL_LOCAL_HOST_ATTESTOR_CONFIG = previous })
    const stopProcess = async () => {
      try {
        const state = JSON.parse(await readFile(join(release.root, 'host-attestor-state.json'), 'utf8')) as { pid?: number }
        if (state.pid) { try { process.kill(state.pid, 'SIGTERM') } catch { /* already gone */ } }
      } catch { /* no process state */ }
    }
    cleanup.push(stopProcess)
    const sample = () => queryRuntimeObserver({ socketPath, keyPath, signal: AbortSignal.timeout(5_000) })
    return { release, trust, plan, profile, profilePath, patchPath, targets, hostConfigPath, writeHostConfig,
      sample, stopProcess,
      async probe() { const current = release.store.getPlan(plan.id)
        return probePluginPlan({ store: release.store, trust, planId: plan.id,
          expectedRevision: current.revision, expectedFence: current.activation!.fence }) },
      async close() {
        await stopProcess()
        for (const action of cleanup.splice(0).reverse()) await action()
        await release.close()
      } }
  } catch (error) {
    for (const action of cleanup.splice(0).reverse()) { try { await action() } catch { /* best-effort */ } }
    await release.close()
    throw error
  }
}
