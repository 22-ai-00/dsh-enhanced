import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, link, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lstatSync } from 'node:fs'
import { afterAll, afterEach, beforeEach, describe as baseDescribe, expect, test, vi } from 'vitest'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../src/approval.ts'
import { Ed25519HostAttestationAuthority, hostAttestationEvidenceDigest, hostAttestationSigningPayload } from '../src/attestation.ts'
import { exampleIntegrityPinnedCatalog } from '../src/catalog.ts'
import { checkedSourceSnapshot, runPluginControl } from '../src/cli.ts'
import { invokeConfiguredHostAttestor, prepareConfiguredHostAttestation } from '../src/host-attestor.ts'
import { sourceReleaseAuthorizationSigningPayload, sourceReleaseEvidenceDigest, sourceReleaseRequestDigest,
  sourceReleaseSigningPayload } from '../src/release.ts'
import { controlPlaneDigest, ControlPlaneStore, type CreateActivationPlanInput } from '../src/store.ts'
import { loadTrustConfig } from '../src/trust.ts'
import type { ApprovalAuthority, ApprovalReceipt, HostAttestationReceipt, PluginActivationPlan, PluginSourcePlan, SourceReleaseAuthorization,
  SourceReleaseReceipt, SourceReleaseRequest } from '../src/types.ts'

const roots: string[] = []
const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const ledgerId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01'
const candidate = exampleIntegrityPinnedCatalog.entries.find(item => item.id === 'assistant-health')!
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
let cachedInterpreter: { path: string; sha256: string } | undefined
let cachedInterpreterRoot: string | undefined

async function fixtureInterpreter(): Promise<{ path: string; sha256: string }> {
  if (cachedInterpreter !== undefined) return cachedInterpreter
  const sourcePath = await realpath(process.execPath)
  const root = await mkdtemp(join(tmpdir(), 'plugin-control-node-')); await chmod(root, 0o700)
  const path = join(root, 'node')
  await copyFile(sourcePath, path); await chmod(path, 0o700)
  cachedInterpreterRoot = root
  cachedInterpreter = { path: await realpath(path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
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
if [[ -n "\${DSH_TEST_EXECUTOR_MARKER:-}" ]]; then printf '%s\\n' 'trusted' >> "$DSH_TEST_EXECUTOR_MARKER"; fi
if [[ -n "\${DSH_TEST_EXECUTOR_LOG:-}" ]]; then printf '%s\\n' "$*" >> "$DSH_TEST_EXECUTOR_LOG"; fi
if [[ "\${1:-}" == '--version' && -n "\${DSH_TEST_SWAP_SOURCE:-}" && -f "\${DSH_TEST_SWAP_REPLACEMENT:-}" ]]; then
  ( sleep 0.05; mv -f "$DSH_TEST_SWAP_REPLACEMENT" "$DSH_TEST_SWAP_SOURCE" ) &
  sleep 0.1
fi
if [[ "\${1:-}" == '--version' ]]; then printf '%s\\n' '0.1.0-rc.8'; exit 0; fi
if [[ "\${DSH_TEST_FAIL:-0}" == '1' ]]; then printf '%s\\n' 'TOP-SECRET-STDERR' >&2; exit 27; fi
if [[ "\${1:-}" == 'plugin' ]]; then
  profile='web'
  for ((index = 1; index <= $#; index += 1)); do if [[ "\${!index}" == '--profile' ]]; then next=$((index + 1)); profile="\${!next}"; fi; done
  directory="$DSH_HOME/profiles/$profile"; mkdir -p "$directory"
  artifact="\${!#}"
  if [[ "$artifact" != file://* ]]; then artifact=''; fi
  if [[ -n "\${DSH_TEST_ARTIFACT_ARGUMENT_LOG:-}" ]]; then
    printf '%s\\n' "$artifact" > "$DSH_TEST_ARTIFACT_ARGUMENT_LOG"
    if [[ -n "\${DSH_TEST_ARTIFACT_SWAP_SOURCE:-}" && -f "\${DSH_TEST_ARTIFACT_SWAP_REPLACEMENT:-}" ]]; then
      mv -f "$DSH_TEST_ARTIFACT_SWAP_REPLACEMENT" "$DSH_TEST_ARTIFACT_SWAP_SOURCE"
    fi
    cp "\${artifact#file://}" "$DSH_TEST_ARTIFACT_BYTES_LOG"
  fi
  lock="$DSH_TEST_LOCK"
  if [[ -n "$artifact" ]]; then
    artifact_name="\${artifact##*/}"
    lock="\${lock//FD/$artifact_name}"
  fi
  printf '%b' "$lock" > "$directory/pnpm-lock.yaml"
  while IFS='|' read -r package version; do
    [[ -z "$package" ]] && continue
    manifest="$directory/node_modules/$package/package.json"; mkdir -p "$(dirname "$manifest")"
    printf '{"name":"%s","version":"%s"}\n' "$package" "$version" > "$manifest"
  done <<< "\${DSH_TEST_PACKAGES:-}"
  exit 0
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
    environmentAllowlist: ['PATH', 'DSH_TEST_LOCK', 'DSH_TEST_PACKAGES', 'DSH_TEST_EXECUTOR_LOG', 'DSH_TEST_SWAP_SOURCE',
      'DSH_TEST_SWAP_REPLACEMENT', 'DSH_TEST_EXECUTOR_MARKER', 'DSH_TEST_ARTIFACT_ARGUMENT_LOG', 'DSH_TEST_ARTIFACT_BYTES_LOG',
      'DSH_TEST_ARTIFACT_SWAP_SOURCE', 'DSH_TEST_ARTIFACT_SWAP_REPLACEMENT', 'DSH_TEST_FAIL'] },
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

async function sourceRepositoryFixture(extraGeneratorWrite = false): Promise<{ repository: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-control-source-repository-')); roots.push(root)
  const repository = join(root, 'repository'); const worktree = join(root, 'worktree')
  await mkdir(join(repository, 'scripts'), { recursive: true }); await mkdir(join(repository, 'plugins'), { recursive: true })
  await cp(join(repositoryRoot, 'scripts', 'create-plugin.mjs'), join(repository, 'scripts', 'create-plugin.mjs'))
  await cp(join(repositoryRoot, 'templates', 'plugin'), join(repository, 'templates', 'plugin'), { recursive: true })
  await cp(join(repositoryRoot, 'LICENSE'), join(repository, 'LICENSE'))
  if (extraGeneratorWrite) {
    const generator = join(repository, 'scripts', 'create-plugin.mjs')
    await writeFile(generator, `${await readFile(generator, 'utf8')}\nawait writeFile(join(repoRoot, 'OUTSIDE.md'), 'outside approved scope\\n')\n`)
  }
  await writeFile(join(repository, 'plugins', 'README.md'), '# Plugin catalog\n\n<!-- plugin-catalog:end -->\n')
  await writeFile(join(repository, '.gitignore'), 'node_modules/\npnpm-lock.yaml\n')
  await writeFile(join(repository, 'package.json'), `${JSON.stringify({ name: 'source-scaffold-fixture', private: true, type: 'module',
    scripts: { 'create:plugin': 'node ./scripts/create-plugin.mjs', check: 'node ./scripts/check-fixture.mjs' } }, null, 2)}\n`)
  await writeFile(join(repository, 'scripts', 'check-fixture.mjs'), `import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
const entries = (await readdir('plugins', { withFileTypes: true })).filter(entry => entry.isDirectory())
if (entries.length !== 1) throw new Error('expected exactly one generated plugin')
const name = entries[0].name
const root = join('plugins', name)
await Promise.all(['README.md', 'cordis.patch.yml', 'package.json', 'src/index.ts', 'src/version.ts', 'tests/index.spec.ts',
  'tsconfig.build.json', 'tsconfig.json', 'LICENSE'].map(path => access(join(root, path))))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (manifest.name !== '@dsh-enhanced/' + name || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('invalid generated manifest')
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes("name: '@dsh-enhanced/" + name + "'")) throw new Error('invalid generated patch')
const catalog = await readFile('plugins/README.md', 'utf8')
const row = '| [' + name + '](' + name + ') | \`@dsh-enhanced/' + name + '\` | 实验性 |'
if (catalog.split(row).length !== 2) throw new Error('generated catalog row is missing or duplicated')
`)
  execFileSync('/usr/bin/git', ['init', repository]); execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.name', 'Test'])
  execFileSync('/usr/bin/git', ['-C', repository, 'config', 'user.email', 'test@example.invalid'])
  execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']); execFileSync('/usr/bin/git', ['-C', repository, 'commit', '-m', 'fixture'])
  execFileSync('/usr/bin/git', ['-C', repository, 'worktree', 'add', '-b', 'scaffold', worktree])
  return { repository: await realpath(repository), worktree: await realpath(worktree) }
}

function input(value: Awaited<ReturnType<typeof fixture>>, gapId: string, key: string): CreateActivationPlanInput {
  return { candidate, catalog: { digest: controlPlaneDigest(exampleIntegrityPinnedCatalog), provenance: 'owner-provided-integrity-pinned' },
    matchedCapabilities: candidate.capabilities, profile: 'web', target: { dshHome: value.dshHome, profile: 'web', profilePath: value.profile },
    installationId, ledger: value.trust.ledger,
    executor: { id: 'test-dsh', version: '0.1.0-rc.8', path: value.executor, sha256: value.trust.executor.sha256 },
    ttlMs: 60_000, gapId, idempotencyKey: key }
}

function lockfile(plan: PluginActivationPlan): string {
  const dependencies = plan.dossier.packages.map(item => `      '${item.package}':\n        specifier: ${item.version}\n        version: ${item.version}\n`).join('')
  const packages = plan.dossier.packages.map(item => `  '${item.package}@${item.version}':\n    resolution:\n      integrity: ${item.integrity}\n`).join('')
  return `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n${dependencies}packages:\n${packages}snapshots:\n`
}

function localLockfile(plan: PluginActivationPlan, artifactPath: string, approvedArtifactPath = artifactPath): string {
  const activationId = plan.activation?.id
  if (activationId === undefined) throw new Error('local lockfile fixture requires a claimed activation')
  const suffix = activationId.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
  const stagePath = join(plan.target.dshHome, 'profiles', `stage-${suffix}`)
  const absoluteReference = `file:${approvedArtifactPath}`
  const relativeReference = `file:${relative(stagePath, approvedArtifactPath)}`
  const primary = plan.dossier.packages[0]!
  const requirements = plan.dossier.packages.slice(1)
  const dependencies = [`      '${primary.package}':\n        specifier: ${absoluteReference}\n        version: ${relativeReference}\n`,
    ...requirements.map(item => `      '${item.package}':\n        specifier: ${item.version}\n        version: ${item.version}\n`)].join('')
  const packages = [`  '${primary.package}@${relativeReference}':\n    resolution: {integrity: ${primary.integrity}, tarball: ${relativeReference}}\n    version: ${primary.version}\n`,
    ...requirements.map(item => `  '${item.package}@${item.version}':\n    resolution:\n      integrity: ${item.integrity}\n`)].join('')
  return `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n${dependencies}packages:\n${packages}snapshots:\n`
}

function localLockfileForDescriptor(plan: PluginActivationPlan): string {
  const descriptor = `/proc/${process.pid}/fd/FD`
  return localLockfile(plan, descriptor)
}

function installedPackages(plan: PluginActivationPlan): string {
  return plan.dossier.packages.map(item => `${item.package}|${item.version}`).join('\n')
}

function activationEnvironment(value: Awaited<ReturnType<typeof fixture>>, plan: PluginActivationPlan, fail = '0'): Record<string, string> {
  return { DSH_HOME: value.dshHome, DSH_TEST_LOCK: lockfile(plan), DSH_TEST_PACKAGES: installedPackages(plan), DSH_TEST_FAIL: fail }
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

function claimInput(plan: PluginActivationPlan, leaseMs = 30_000) {
  const authority: ApprovalAuthority = {
    async verify(receipt) {
      const { signature, ...fields } = receipt
      return { ...fields, principal: fields.principal.normalize('NFC').trim(),
        signatureDigest: createHash('sha256').update(Buffer.from(signature, 'base64')).digest('hex') }
    },
  }
  return { planId: plan.id, expectedRevision: plan.revision, leaseMs, resolveApprovalAuthority: () => authority }
}

async function approvedLocal(value: Awaited<ReturnType<typeof fixture>>, suffix: string, bytes: Buffer): Promise<{ plan: PluginActivationPlan; reference: string }> {
  const registryRoot = join(value.root, `registry-${suffix}`)
  const artifactPath = join(registryRoot, 'packages', encodeURIComponent(candidate.package), candidate.version, 'package.tgz')
  await mkdir(join(artifactPath, '..'), { recursive: true, mode: 0o700 })
  await writeFile(artifactPath, bytes, { mode: 0o400 })
  const reference = pathToFileURL(artifactPath).href
  const localCandidate = { ...candidate, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    registry: { id: 'fixture-local-registry', locator: pathToFileURL(registryRoot).href, reference } }
  const store = new ControlPlaneStore({ path: value.state })
  const gap = store.recordGap({ idempotencyKey: `gap:${suffix}`, capability: 'health', context: `gap ${suffix}`, expectedValue: 10, frequency: 2, estimatedCost: 2, risk: 0 })
  const created = store.createPlan({ ...input(value, gap.id, `plan:${suffix}`), candidate: localCandidate,
    catalog: { digest: controlPlaneDigest({ schemaVersion: 1, entries: [localCandidate] }), provenance: 'owner-provided-integrity-pinned' } }).result
  const now = Date.now(); const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `approval-${suffix}`,
    authority: 'owner-policy', keyId: 'owner-key-1', planId: created.id, planDigest: created.digest, decision: 'approved',
    principal: 'owner@test', decidedAt: now, expiresAt: now + 30_000 }
  const receipt: ApprovalReceipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), value.privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(value.trust.approvalKeys[0]!.publicKeyPem, 'owner-policy', 'owner-key-1')
  const plan = (await store.approve({ planId: created.id, expectedRevision: created.revision, receipt, resolveAuthority: () => authority,
    idempotencyKey: `approval:${suffix}` })).result
  store.close(); return { plan, reference }
}

async function readySource(value: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginSourcePlan> {
  const store = new ControlPlaneStore({ path: value.state })
  const gap = store.recordGap({ idempotencyKey: `source-gap:${suffix}`, capability: 'health', context: `source gap ${suffix}`,
    expectedValue: 10, frequency: 2, estimatedCost: 2, risk: 0 })
  const plan = store.createSourcePlan({ gapId: gap.id, repository: value.root, worktree: value.root, baseCommit: 'a'.repeat(40),
    name: 'health-helper', generatorDigest: 'b'.repeat(64), scope: ['plugins/README.md', 'plugins/health-helper'], ttlMs: 60_000,
    idempotencyKey: `source-plan:${suffix}` }).result
  const now = Date.now(); const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `source-approval-${suffix}`,
    authority: 'owner-policy', keyId: 'owner-key-1', planId: plan.id, planDigest: plan.digest, decision: 'approved',
    principal: 'owner@test', decidedAt: now, expiresAt: now + 30_000 }
  const receipt: ApprovalReceipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), value.privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(value.trust.approvalKeys[0]!.publicKeyPem, 'owner-policy', 'owner-key-1')
  const approvedPlan = (await store.approveSource({ planId: plan.id, expectedRevision: plan.revision, receipt, resolveAuthority: () => authority,
    idempotencyKey: `source-approval:${suffix}` })).result
  const running = store.beginSourceChecks({ planId: plan.id, expectedRevision: approvedPlan.revision })
  const ready = store.finishSourceChecks({ planId: plan.id, expectedRevision: running.revision, succeeded: true,
    checkedTreeDigest: 'c'.repeat(64), checkedPatchDigest: 'd'.repeat(64) })
  store.close(); return ready
}

async function approvedScaffoldSource(value: Awaited<ReturnType<typeof fixture>>, source: { repository: string; worktree: string },
  suffix: string, name = 'health-helper'): Promise<PluginSourcePlan> {
  const store = new ControlPlaneStore({ path: value.state })
  const gap = store.recordGap({ idempotencyKey: 'scaffold-gap:' + suffix, capability: 'health', context: 'scaffold gap ' + suffix,
    expectedValue: 10, frequency: 2, estimatedCost: 2, risk: 0 })
  store.close()
  await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['source-plan', '--gap-id', gap.id,
    '--repository', source.repository, '--worktree', source.worktree, '--name', name, '--idempotency-key', 'scaffold-plan:' + suffix]))
  const database = new DatabaseSync(value.state)
  const id = (database.prepare('SELECT id FROM source_plans WHERE gap_id = ?').get(gap.id) as { id: string }).id
  database.close()
  const inspect = new ControlPlaneStore({ path: value.state }); const plan = inspect.getSourcePlan(id); inspect.close()
  const now = Date.now(); const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1,
    approvalId: 'scaffold-approval-' + suffix, authority: 'owner-policy', keyId: 'owner-key-1', planId: plan.id,
    planDigest: plan.digest, decision: 'approved', principal: 'owner@test', decidedAt: now, expiresAt: now + 30_000 }
  const receipt: ApprovalReceipt = { ...unsigned,
    signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), value.privateKey).toString('base64') }
  const receiptPath = join(value.control, 'scaffold-approval-' + suffix + '.json')
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
  await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['approve', '--kind', 'source', '--plan-id', plan.id,
    '--expected-revision', String(plan.revision), '--approval-receipt', receiptPath]))
  const approvedStore = new ControlPlaneStore({ path: value.state }); const approvedPlan = approvedStore.getSourcePlan(plan.id); approvedStore.close()
  return approvedPlan
}

async function staged(value: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginActivationPlan> {
  const plan = await approved(value, suffix)
  await withEnvironment(activationEnvironment(value, plan),
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
afterAll(async () => { if (cachedInterpreterRoot !== undefined) await rm(cachedInterpreterRoot, { recursive: true, force: true }) })

const rootOwnsSystemDirs = process.platform === 'linux'
  && lstatSync('/usr/bin', { bigint: true }).uid === 0n
const describe = rootOwnsSystemDirs ? baseDescribe : baseDescribe.skip

describe.sequential('trusted staged CLI', () => {
  test('runs the real source-plan, signed approval and generator through the exact two-path scope', async () => {
    const value = await fixture(); const source = await sourceRepositoryFixture()
    const approvedPlan = await approvedScaffoldSource(value, source, 'real-generator')
    expect(approvedPlan.scope).toEqual(['plugins/README.md', 'plugins/health-helper'])
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['scaffold', '--plan-id', approvedPlan.id,
      '--expected-revision', String(approvedPlan.revision)]))
    const store = new ControlPlaneStore({ path: value.state }); const ready = store.getSourcePlan(approvedPlan.id); store.close()
    expect(ready).toMatchObject({ status: 'ready-for-human-review', scope: ['plugins/README.md', 'plugins/health-helper'],
      sourceCheck: { treeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), patchDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
    const checked = await checkedSourceSnapshot(source.worktree, ready.baseCommit, ready.scope, process.env)
    expect(ready.sourceCheck).toMatchObject({ treeDigest: checked.checkedTreeDigest, patchDigest: checked.checkedPatchDigest })
    const pluginRoot = join(source.worktree, 'plugins', 'health-helper')
    await Promise.all(['README.md', 'cordis.patch.yml', 'package.json', 'src/index.ts', 'src/version.ts', 'tests/index.spec.ts',
      'tsconfig.build.json', 'tsconfig.json', 'LICENSE'].map(path => readFile(join(pluginRoot, path), 'utf8')))
    expect(JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))).toMatchObject({ name: '@dsh-enhanced/health-helper',
      dsh: { bundle: { patch: './cordis.patch.yml' } } })
    expect(await readFile(join(pluginRoot, 'cordis.patch.yml'), 'utf8')).toContain("name: '@dsh-enhanced/health-helper'")
    expect(await readFile(join(pluginRoot, 'tests', 'index.spec.ts'), 'utf8')).toContain("describe('dsh-enhanced-health-helper'")
    expect(await readFile(join(pluginRoot, 'README.md'), 'utf8')).toContain('# @dsh-enhanced/health-helper')
    expect(await readFile(join(source.worktree, 'plugins', 'README.md'), 'utf8')).toContain('@dsh-enhanced/health-helper')
  }, 30_000)

  test('fails closed when the real generator additionally changes a file outside its approved scope', async () => {
    const value = await fixture(); const source = await sourceRepositoryFixture(true)
    const approvedPlan = await approvedScaffoldSource(value, source, 'outside-scope')
    await expect(withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['scaffold', '--plan-id', approvedPlan.id,
      '--expected-revision', String(approvedPlan.revision)]))).rejects.toThrow('source generator changed files outside its approved scope')
    const store = new ControlPlaneStore({ path: value.state }); const failed = store.getSourcePlan(approvedPlan.id); store.close()
    expect(failed).toMatchObject({ status: 'local-checks-failed', scope: ['plugins/README.md', 'plugins/health-helper'] })
    expect(failed.sourceCheck).toBeUndefined()
    await expect(readFile(join(source.worktree, 'OUTSIDE.md'), 'utf8')).resolves.toBe('outside approved scope\n')
  }, 30_000)

  test('computes an exact checked source snapshot without changing the real Git index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-control-checked-tree-')); roots.push(root)
    execFileSync('/usr/bin/git', ['init', root]); execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.name', 'Test'])
    execFileSync('/usr/bin/git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    await mkdir(join(root, 'plugins', 'example'), { recursive: true }); await writeFile(join(root, 'README.md'), 'base\n')
    await writeFile(join(root, 'plugins', 'README.md'), '<!-- plugin-catalog:end -->\n')
    execFileSync('/usr/bin/git', ['-C', root, 'add', '.']); execFileSync('/usr/bin/git', ['-C', root, 'commit', '-m', 'base'])
    await writeFile(join(root, 'plugins', 'example', 'index.ts'), 'export const value = 1\n')
    const before = execFileSync('/usr/bin/git', ['-C', root, 'diff', '--cached'], { encoding: 'utf8' })
    const baseCommit = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const exactScope = ['plugins/README.md', 'plugins/example']
    const first = await checkedSourceSnapshot(root, baseCommit, exactScope, {})
    const second = await checkedSourceSnapshot(root, baseCommit, exactScope, {})
    expect(first).toEqual(second)
    expect(first.checkedTreeDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.checkedPatchDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.checkedPatchDigest).not.toBe(createHash('sha256').update('').digest('hex'))
    expect(await checkedSourceSnapshot(root, baseCommit, ['plugins/README.md', 'plugins/example/index.ts'], {})).not.toEqual(first)
    execFileSync('/usr/bin/git', ['-C', root, 'commit', '--allow-empty', '-m', 'same tree, different base'])
    const nextBaseCommit = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(await checkedSourceSnapshot(root, nextBaseCommit, exactScope, {})).not.toEqual(first)
    await writeFile(join(root, 'README.md'), 'outside scope\n')
    expect(await checkedSourceSnapshot(root, baseCommit, exactScope, {})).toEqual(first)
    expect(execFileSync('/usr/bin/git', ['-C', root, 'diff', '--cached'], { encoding: 'utf8' })).toBe(before)
  })

  test('uses only the pre-registered approval key and rejects command-supplied trust roots', async () => {
    await expect(runPluginControl(['approve', '--approved-by', 'anyone'])).rejects.toThrow('trust roots cannot be supplied')
    await expect(runPluginControl(['approve', '--approval-public-key', '/tmp/key'])).rejects.toThrow('command-supplied trust roots or ledgers are forbidden')
    await expect(runPluginControl(['probe', '--attestor-path', '/tmp/untrusted'])).rejects.toThrow('command-supplied trust roots or ledgers are forbidden')
    await expect(runPluginControl(['release-step', '--registry-token', 'secret'])).rejects.toThrow('command-supplied trust roots or ledgers are forbidden')
    await expect(runPluginControl(['release-start', '--private-key', '/tmp/key'])).rejects.toThrow('command-supplied trust roots or ledgers are forbidden')
  })

  test.each(['release-start', 'release-request', 'release-step', 'release-attest', 'release-reconcile'])(
    '%s rejects caller-selected phases before any trust or state access', async command => {
      await expect(runPluginControl([command, '--phase', 'publish'])).rejects.toThrow('phase is derived from durable plan status')
    })

  test('release-reconcile rejects unsigned registry observations', async () => {
    await expect(runPluginControl(['release-reconcile', '--observation', '/tmp/unsigned.json']))
      .rejects.toThrow('unsigned registry observations are forbidden')
  })

  test('starts an explicitly authorized checked release and derives the durable PR request', async () => {
    const value = await fixture(); const ready = await readySource(value, 'release-start')
    const catalogPath = join(value.control, 'catalog.json')
    await writeFile(catalogPath, `${JSON.stringify(exampleIntegrityPinnedCatalog)}\n`, { mode: 0o600 })
    const adapter = { id: 'fixture-pr', version: 'fixture-host-attestor-1', path: value.attestor,
      sha256: value.trust.hostAttestor.sha256, interpreter: value.trust.hostAttestor.interpreter, environmentAllowlist: [],
      authority: 'release-adapter', keyId: 'release-adapter-key', timeoutMs: 10_000 }
    const adapterKeys = generateKeyPairSync('ed25519')
    const adapterPublicKeyPem = adapterKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const authorizationKeys = generateKeyPairSync('ed25519')
    const authorizationPublicKeyPem = authorizationKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const releaseAdapters = Object.fromEntries(['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission']
      .map(phase => [phase, phase === 'pr' ? adapter : null]))
    await writeFile(value.trustPath, `${JSON.stringify({ ...value.trust, schemaVersion: 4, catalog: { id: 'owner-catalog', path: catalogPath },
      releaseRegistry: { id: 'fixture-registry', locator: 'https://registry.example.invalid' }, releaseReceiptTtlMs: 30_000,
      releaseAdapters, releaseKeys: [
        { authority: 'release-adapter', keyId: 'release-adapter-key', publicKeyPem: adapterPublicKeyPem },
      ],
      releaseAuthorizationKeys: [{ authority: 'release-owner', keyId: 'release-owner-key', publicKeyPem: authorizationPublicKeyPem }] })}\n`, { mode: 0o600 })
    const now = Date.now(); const unsigned: Omit<SourceReleaseAuthorization, 'signature'> = { schemaVersion: 1,
      kind: 'dsh-source-release-authorization', authorizationId: 'release-authorization-1', authority: 'release-owner', keyId: 'release-owner-key',
      planId: ready.id, planDigest: ready.digest, baseCommit: ready.baseCommit, checkedTreeDigest: ready.sourceCheck!.treeDigest,
      checkedPatchDigest: ready.sourceCheck!.patchDigest, scope: ready.scope, releasePolicy: { targetBranch: 'main', candidateId: 'health-helper',
        packageName: '@dsh-enhanced/health-helper', packageVersion: '0.1.8', packagePath: 'plugins/health-helper', dshBaseline: '0.1.0-rc.8',
        capabilities: ['health'], authorities: ['read-only: health'], requires: [], registryId: 'fixture-registry',
        registryLocator: 'https://registry.example.invalid', catalogId: 'owner-catalog', catalogPath,
        minimumReproducibleBuilds: 2, registryReference: '@dsh-enhanced/health-helper@0.1.8' }, authorizedAt: now, expiresAt: now + 30_000 }
    const authorization: SourceReleaseAuthorization = { ...unsigned,
      signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), authorizationKeys.privateKey).toString('base64') }
    const authorizationPath = join(value.control, 'release-authorization.json')
    await writeFile(authorizationPath, JSON.stringify(authorization), { mode: 0o600 })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['release-start', '--plan-id', ready.id,
      '--expected-revision', String(ready.revision), '--authorization', authorizationPath]))
    let inspect = new ControlPlaneStore({ path: value.state }); const started = inspect.getSourcePlan(ready.id); inspect.close()
    expect(started).toMatchObject({ status: 'awaiting-pr', release: { fence: 1 }, releaseAuthorization: { authorizationId: 'release-authorization-1' } })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['release-request', '--plan-id', started.id,
      '--expected-revision', String(started.revision), '--expected-fence', String(started.release!.fence)]))
    const database = new DatabaseSync(value.state)
    const request = JSON.parse((database.prepare("SELECT request_json FROM source_release_operations WHERE plan_id = ? AND phase = 'pr'")
      .get(started.id) as { request_json: string }).request_json) as SourceReleaseRequest
    database.close()
    expect(request).toMatchObject({ phase: 'pr', registry: { id: 'fixture-registry' }, catalog: { id: 'owner-catalog', path: catalogPath },
      release: { id: started.release!.id, fence: 1 }, input: { expectedTreeDigest: 'c'.repeat(64), expectedPatchDigest: 'd'.repeat(64) } })
    if (request.phase !== 'pr') throw new Error('fixture request is not PR')
    const evidence = { kind: 'pr' as const, prId: 'pr-1', baseCommit: request.input.baseCommit, headCommit: 'e'.repeat(40),
      treeDigest: request.input.expectedTreeDigest, patchDigest: request.input.expectedPatchDigest, repositoryDigest: 'f'.repeat(64) }
    const observedAt = Date.now(); const receiptUnsigned: Omit<SourceReleaseReceipt, 'signature'> = { schemaVersion: 1, receiptId: 'pr-receipt-1',
      authority: 'release-adapter', keyId: 'release-adapter-key', installationId, planId: started.id, planDigest: started.digest,
      releaseId: started.release!.id, fence: started.release!.fence, operationId: request.operationId, requestDigest: sourceReleaseRequestDigest(request),
      phase: 'pr', outcome: 'passed', evidence, evidenceDigest: sourceReleaseEvidenceDigest(evidence), observedAt,
      expiresAt: Math.min(observedAt + request.receiptTtlMs, authorization.expiresAt) }
    const receipt: SourceReleaseReceipt = { ...receiptUnsigned,
      signature: sign(null, Buffer.from(sourceReleaseSigningPayload(receiptUnsigned)), adapterKeys.privateKey).toString('base64') }
    const receiptPath = join(value.control, 'pr-receipt.json'); await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['release-attest', '--plan-id', started.id,
      '--expected-revision', String(started.revision), '--expected-fence', String(started.release!.fence), '--receipt', receiptPath]))
    inspect = new ControlPlaneStore({ path: value.state })
    expect(inspect.getSourcePlan(started.id).status).toBe('awaiting-review')
    expect(inspect.getSourceReleaseOperation(request.operationId).status).toBe('applied')
    inspect.close()
  })

  test('stages with an allowlisted environment but stops at signed reload attestation instead of claiming activated', async () => {
    const value = await fixture(); const plan = await approved(value, 'staged')
    await withEnvironment({ ...activationEnvironment(value, plan), UNREGISTERED_SECRET_TOKEN: 'must-not-inherit' },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))
    const inspect = new ControlPlaneStore({ path: value.state }); const staged = inspect.getPlan(plan.id); inspect.close()
    expect(staged.status).toBe('awaiting-reload')
    expect(staged.status).not.toBe('activated')
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('executes the verified descriptor when the registered executor pathname is swapped after inspection', async () => {
    const value = await fixture(); const plan = await approved(value, 'executor-path-swap')
    const trustedMarker = join(value.root, 'trusted-executor.log'); const evilMarker = join(value.root, 'evil-executor.log')
    const replacement = join(value.root, 'evil-executor')
    await executable(replacement, `#!/usr/bin/env bash\nprintf '%s\\n' evil >> "${evilMarker}"\nexit 0\n`)
    await withEnvironment({ ...activationEnvironment(value, plan), DSH_TEST_EXECUTOR_MARKER: trustedMarker,
      DSH_TEST_SWAP_SOURCE: value.executor, DSH_TEST_SWAP_REPLACEMENT: replacement },
    () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))
    expect((await readFile(trustedMarker, 'utf8')).trim().split('\n')).toEqual(['trusted', 'trusted', 'trusted'])
    await expect(readFile(evilMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(value.executor, 'utf8')).toContain('evil')
  })

  test('snapshots a verified local artifact before invoking the executor and installs only from the private copy', async () => {
    const value = await fixture(); const { plan, reference } = await approvedLocal(value, 'local-artifact', Buffer.from('verified-tarball'))
    const log = join(value.root, 'executor.log')
    const claimedStore = new ControlPlaneStore({ path: value.state })
    const claimed = await claimedStore.claimActivation(claimInput(plan))
    const activationId = claimed.activation!.id; claimedStore.close()
    const cachePath = join(value.dshHome, 'plugin-control', 'activation-artifacts', activationId,
      `${createHash('sha256').update(candidate.package).digest('hex')}.tgz`)
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(plan.id); raw.close()
    const environment = { DSH_HOME: value.dshHome, DSH_TEST_LOCK: localLockfileForDescriptor(claimed),
      DSH_TEST_PACKAGES: installedPackages(claimed), DSH_TEST_EXECUTOR_LOG: log, DSH_TEST_FAIL: '0' }
    await withEnvironment(environment, () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(claimed.revision)]))
    const calls = await readFile(log, 'utf8')
    expect(calls).toMatch(new RegExp(`file:///proc/${process.pid}/fd/[0-9]+`, 'u'))
    expect(calls).not.toContain(reference)
    expect(await readFile(cachePath)).toEqual(Buffer.from('verified-tarball'))
    expect((await stat(cachePath)).mode & 0o777).toBe(0o400)
  })

  test('rejects a tampered local artifact before any executor invocation', async () => {
    const value = await fixture(); const { plan, reference } = await approvedLocal(value, 'tampered-artifact', Buffer.from('approved'))
    await chmod(fileURLToPath(reference), 0o600); await writeFile(fileURLToPath(reference), 'replaced'); await chmod(fileURLToPath(reference), 0o400)
    const log = join(value.root, 'executor.log')
    await expect(withEnvironment({ ...activationEnvironment(value, plan), DSH_TEST_EXECUTOR_LOG: log },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])))
      .rejects.toThrow('approved integrity')
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps installing the verified snapshot when the original registry path is replaced after preflight', async () => {
    const value = await fixture(); const { plan, reference } = await approvedLocal(value, 'artifact-swap', Buffer.from('approved'))
    const source = fileURLToPath(reference); const replacement = join(value.root, 'replacement.tgz')
    await writeFile(replacement, 'attacker', { mode: 0o400 })
    const claimedStore = new ControlPlaneStore({ path: value.state })
    const claimed = await claimedStore.claimActivation(claimInput(plan)); claimedStore.close()
    const cachePath = join(value.dshHome, 'plugin-control', 'activation-artifacts', claimed.activation!.id,
      `${createHash('sha256').update(candidate.package).digest('hex')}.tgz`)
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(plan.id); raw.close()
    const log = join(value.root, 'executor.log')
    await withEnvironment({ ...activationEnvironment(value, claimed), DSH_TEST_LOCK: localLockfileForDescriptor(claimed),
      DSH_TEST_EXECUTOR_LOG: log, DSH_TEST_SWAP_SOURCE: source, DSH_TEST_SWAP_REPLACEMENT: replacement },
    () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(claimed.revision)]))
    expect(await readFile(source, 'utf8')).toBe('attacker')
    expect(await readFile(cachePath, 'utf8')).toBe('approved')
    expect(await readFile(log, 'utf8')).toMatch(new RegExp(`file:///proc/${process.pid}/fd/[0-9]+`, 'u'))
    expect(await readFile(log, 'utf8')).not.toContain(reference)
  })

  test('keeps local artifact bytes descriptor-pinned across the executor to package-manager boundary', async () => {
    const value = await fixture(); const { plan } = await approvedLocal(value, 'artifact-cache-swap', Buffer.from('approved-bytes'))
    const claimedStore = new ControlPlaneStore({ path: value.state }); const claimed = await claimedStore.claimActivation(claimInput(plan)); claimedStore.close()
    const cachePath = join(value.dshHome, 'plugin-control', 'activation-artifacts', claimed.activation!.id,
      `${createHash('sha256').update(candidate.package).digest('hex')}.tgz`)
    const replacement = join(value.root, 'evil-cache.tgz'); await writeFile(replacement, 'evil-bytes', { mode: 0o400 })
    const argumentLog = join(value.root, 'artifact-argument.log'); const bytesLog = join(value.root, 'artifact-bytes.log')
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(plan.id); raw.close()
    await withEnvironment({ ...activationEnvironment(value, claimed), DSH_TEST_LOCK: localLockfileForDescriptor(claimed),
      DSH_TEST_ARTIFACT_ARGUMENT_LOG: argumentLog, DSH_TEST_ARTIFACT_BYTES_LOG: bytesLog, DSH_TEST_ARTIFACT_SWAP_SOURCE: cachePath,
      DSH_TEST_ARTIFACT_SWAP_REPLACEMENT: replacement },
    () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(claimed.revision)]))
    expect(await readFile(cachePath, 'utf8')).toBe('evil-bytes')
    expect(await readFile(bytesLog, 'utf8')).toBe('approved-bytes')
    expect(await readFile(argumentLog, 'utf8')).toMatch(new RegExp(`^file:///proc/${process.pid}/fd/[0-9]+\\n$`, 'u'))
  })

  test('rejects a wrong installed manifest after local artifact installation', async () => {
    const value = await fixture(); const { plan } = await approvedLocal(value, 'wrong-manifest', Buffer.from('verified'))
    const claimedStore = new ControlPlaneStore({ path: value.state })
    const claimed = await claimedStore.claimActivation(claimInput(plan)); claimedStore.close()
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(plan.id); raw.close()
    const wrong = installedPackages(claimed).replace(`|${candidate.version}`, '|9.9.9')
    await expect(withEnvironment({ ...activationEnvironment(value, claimed), DSH_TEST_LOCK: localLockfileForDescriptor(claimed), DSH_TEST_PACKAGES: wrong },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(claimed.revision)])))
      .rejects.toThrow('wrong name or version')
    const inspect = new ControlPlaneStore({ path: value.state }); expect(inspect.getPlan(plan.id).status).toBe('rolled-back'); inspect.close()
  })

  test('rejects a local artifact lockfile that resolves a different tarball', async () => {
    const value = await fixture(); const { plan } = await approvedLocal(value, 'wrong-local-lockfile', Buffer.from('verified'))
    const claimedStore = new ControlPlaneStore({ path: value.state })
    const claimed = await claimedStore.claimActivation(claimInput(plan)); claimedStore.close()
    const cachePath = join(value.dshHome, 'plugin-control', 'activation-artifacts', claimed.activation!.id,
      `${createHash('sha256').update(candidate.package).digest('hex')}.tgz`)
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(plan.id); raw.close()
    const wrongLockfile = localLockfile(claimed, cachePath).replaceAll('.tgz', '-wrong.tgz')
    await expect(withEnvironment({ ...activationEnvironment(value, claimed), DSH_TEST_LOCK: wrongLockfile },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(claimed.revision)])))
      .rejects.toThrow('approved local artifact')
    const inspect = new ControlPlaneStore({ path: value.state }); expect(inspect.getPlan(plan.id).status).toBe('rolled-back'); inspect.close()
  })

  test('applies a signed failed Host receipt and restores the retained backup', async () => {
    const value = await fixture(); const plan = await approved(value, 'host-failure')
    await withEnvironment(activationEnvironment(value, plan),
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
    await withEnvironment(activationEnvironment(value, plan),
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
    const store = new ControlPlaneStore({ path: value.state }); let claimed = await store.claimActivation(claimInput(approvedPlan, 5_000))
    claimed = store.recordActivationTargetBaseline({ planId: claimed.id, expectedRevision: claimed.revision,
      fence: claimed.activation!.fence, existed: true }); store.close()
    const suffix = claimed.activation!.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
    const backup = join(value.dshHome, 'profiles', `.web.plugin-backup-${suffix}`); const stage = join(value.dshHome, 'profiles', `stage-${suffix}`)
    await rename(value.profile, backup); await mkdir(stage); await writeFile(join(stage, 'partial'), 'crash residue')
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(claimed.id); raw.close()
    await withEnvironment(activationEnvironment(value, claimed),
      () => runPluginControl(['activate', '--plan-id', claimed.id, '--expected-revision', String(claimed.revision)]))
    const inspect = new ControlPlaneStore({ path: value.state }); const recovered = inspect.getPlan(claimed.id); inspect.close()
    expect(recovered).toMatchObject({ status: 'awaiting-reload', activation: { id: claimed.activation!.id, fence: claimed.activation!.fence + 1 } })
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('never steals a lock from a live worker and never exposes executor stderr', async () => {
    const value = await fixture(); const approvedPlan = await approved(value, 'lock')
    const store = new ControlPlaneStore({ path: value.state }); const claimed = await store.claimActivation(claimInput(approvedPlan, 5_000)); store.close()
    const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(claimed.id); raw.close()
    const lock = join(value.dshHome, 'profiles', '.plugin-control-web.lock')
    await writeFile(lock, `${JSON.stringify({ schemaVersion: 1, planId: claimed.id, activationId: claimed.activation!.id,
      fence: claimed.activation!.fence, pid: process.pid, nonce: 'live-owner' })}\n`, { mode: 0o600 })
    await expect(withEnvironment(activationEnvironment(value, claimed, '1'),
      () => runPluginControl(['activate', '--plan-id', claimed.id, '--expected-revision', String(claimed.revision)])))
      .rejects.toThrow('LOCK_CONFLICT')
    await rm(lock)
    const latestStore = new ControlPlaneStore({ path: value.state }); const latest = latestStore.getPlan(claimed.id); latestStore.close()
    const raw2 = new DatabaseSync(value.state); raw2.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(latest.id); raw2.close()
    await expect(withEnvironment(activationEnvironment(value, latest, '1'),
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
