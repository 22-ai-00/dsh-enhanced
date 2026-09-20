import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, link, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
import { activationRetractionSigningPayload, postActivationEvidenceDigest, postActivationObservationSigningPayload } from '../src/post-activation.ts'
import { sourceReleaseAuthorizationSigningPayload, sourceReleaseEvidenceDigest, sourceReleaseRequestDigest,
  sourceReleaseSigningPayload } from '../src/release.ts'
import { controlPlaneDigest, ControlPlaneStore, type CreateActivationPlanInput } from '../src/store.ts'
import { startLocalHttpsRegistry } from '../src/registry-fetch.ts'
import { loadTrustConfig } from '../src/trust.ts'
import type { ActivationRetractionReceipt, ApprovalAuthority, ApprovalReceipt, HostAttestationReceipt, PluginActivationPlan,
  PluginSourcePlan, PostActivationObservationReceipt, SourceReleaseAuthorization, SourceReleaseAuthority,
  SourceReleaseAuthorizationAuthority, SourceReleaseReceipt, SourceReleaseRequest } from '../src/types.ts'

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

// Generates one self-signed certificate for 127.0.0.1 with openssl and returns
// the PEM key/certificate pair used by the loopback HTTPS registry fixture.
async function loopbackCertificate(): Promise<{ key: string; cert: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-control-tls-')); roots.push(directory)
  const keyPath = join(directory, 'key.pem'); const certPath = join(directory, 'cert.pem')
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'])
  return { key: await readFile(keyPath, 'utf8'), cert: await readFile(certPath, 'utf8') }
}

// Promotes the v2 fixture trust to v4 so activation can bind a real HTTPS
// release registry: the catalog/registry/adapter lanes are added with the
// eight release phases unconfigured (activation never executes them), while
// the approval and host-attestation keys from the v2 fixture are retained.
async function writeHttpsTrust(value: Awaited<ReturnType<typeof fixture>>, releaseRegistry: Record<string, unknown>): Promise<void> {
  const catalogPath = join(value.control, 'catalog.json')
  await writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 1, entries: [] })}\n`, { mode: 0o600 })
  const releaseKeys = generateKeyPairSync('ed25519'); const releasePublicKeyPem = releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const authorizationKeys = generateKeyPairSync('ed25519'); const authorizationPublicKeyPem = authorizationKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await writeFile(value.trustPath, `${JSON.stringify({ ...value.trust, schemaVersion: 4, catalog: { id: 'owner-catalog', path: catalogPath },
    releaseRegistry, releaseReceiptTtlMs: 30_000,
    releaseAdapters: Object.fromEntries(releasePhases.map(phase => [phase, null])),
    releaseKeys: [{ authority: 'release-adapter', keyId: 'release-adapter-key', publicKeyPem: releasePublicKeyPem }],
    releaseAuthorizationKeys: [{ authority: 'release-owner', keyId: 'release-owner-key', publicKeyPem: authorizationPublicKeyPem }] })}\n`,
    { mode: 0o600 })
}

async function approvedHttps(value: Awaited<ReturnType<typeof fixture>>, suffix: string, locator: string, registryId = 'fixture-registry',
  reference = `${candidate.package}@${candidate.version}`): Promise<PluginActivationPlan> {
  const bytes = Buffer.from(`https-tarball-${suffix}`)
  const httpsCandidate = { ...candidate, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    registry: { id: registryId, locator, reference } }
  const store = new ControlPlaneStore({ path: value.state })
  const gap = store.recordGap({ idempotencyKey: `gap:${suffix}`, capability: 'health', context: `gap ${suffix}`, expectedValue: 10,
    frequency: 2, estimatedCost: 2, risk: 0 })
  const created = store.createPlan({ ...input(value, gap.id, `plan:${suffix}`), candidate: httpsCandidate,
    catalog: { digest: controlPlaneDigest({ schemaVersion: 1, entries: [httpsCandidate] }), provenance: 'owner-provided-integrity-pinned' } }).result
  const now = Date.now(); const unsigned: Omit<ApprovalReceipt, 'signature'> = { schemaVersion: 1, approvalId: `approval-${suffix}`,
    authority: 'owner-policy', keyId: 'owner-key-1', planId: created.id, planDigest: created.digest, decision: 'approved',
    principal: 'owner@test', decidedAt: now, expiresAt: now + 30_000 }
  const receipt: ApprovalReceipt = { ...unsigned, signature: sign(null, Buffer.from(approvalSigningPayload(unsigned)), value.privateKey).toString('base64') }
  const authority = new Ed25519ApprovalAuthority(value.trust.approvalKeys[0]!.publicKeyPem, 'owner-policy', 'owner-key-1')
  const plan = (await store.approve({ planId: created.id, expectedRevision: created.revision, receipt, resolveAuthority: () => authority,
    idempotencyKey: `approval:${suffix}` })).result
  store.close(); return plan
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

// Synthetic but content-faithful release lane support: receipts are accepted
// with a non-cryptographic stand-in signature (the CLI activation-plan command
// never verifies release receipts itself, it reads durable applied operations),
// while the catalog file written for the owner must still byte-match the
// CatalogEntry reconstructed from the applied build evidence.
const releaseLaneSignature = Buffer.alloc(64, 7).toString('base64')
const releaseLaneSignatureDigest = createHash('sha256').update(Buffer.from(releaseLaneSignature, 'base64')).digest('hex')
const releasePhases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
const acceptingReleaseAuthority: SourceReleaseAuthority = {
  async verify(receipt) { const { signature: _signature, ...verified } = receipt
    return { ...verified, signatureDigest: releaseLaneSignatureDigest } },
}
const acceptingReleaseAuthorizationAuthority: SourceReleaseAuthorizationAuthority = {
  async verify(authorization) { return { ...authorization,
    signatureDigest: createHash('sha256').update(Buffer.from(authorization.signature, 'base64')).digest('hex') } },
}

function releaseSuccessEvidence(request: SourceReleaseRequest): SourceReleaseReceipt['evidence'] {
  if (request.phase === 'pr') return { kind: 'pr', prId: 'pr-1', baseCommit: request.input.baseCommit, headCommit: '2'.repeat(40),
    treeDigest: request.input.expectedTreeDigest, patchDigest: request.input.expectedPatchDigest, repositoryDigest: '3'.repeat(64) } as never
  if (request.phase === 'review') return { kind: 'review', prId: request.input.prId, headCommit: request.input.headCommit,
    reviewId: 'review-1', decision: 'approved', reviewerPrincipalDigest: '4'.repeat(64), prEvidenceDigest: request.input.prEvidenceDigest } as never
  if (request.phase === 'merge') return { kind: 'merge', prId: request.input.prId, reviewedHeadCommit: request.input.headCommit,
    reviewId: request.input.reviewId, reviewEvidenceDigest: request.input.reviewEvidenceDigest, mergeCommit: '5'.repeat(40),
    targetBranch: request.input.targetBranch } as never
  if (request.phase === 'build') {
    const tarballSha256 = '6'.repeat(64)
    return { kind: 'build', isolated: true, reproducibleBuilds: 2, firstBuildSha256: tarballSha256,
      secondBuildSha256: tarballSha256, mergeEvidenceDigest: request.input.mergeEvidenceDigest, candidateId: request.input.expectedCandidateId,
      sourceName: request.input.name, packagePath: request.input.expectedPackagePath, packageName: request.input.expectedPackageName,
      packageVersion: request.input.expectedPackageVersion, tarballPath: '/release/health-helper.tgz', tarballBytes: 123, tarballSha256,
      tarballIntegrity: `sha512-${Buffer.alloc(64, 6).toString('base64')}`, sbomPath: '/release/sbom.json', sbomSha256: '7'.repeat(64),
      provenancePath: '/release/provenance.json', provenanceSha256: '8'.repeat(64), mergedCommit: request.input.mergeCommit,
      dshBaseline: request.input.expectedDshBaseline, capabilities: request.input.expectedCapabilities,
      authorities: request.input.expectedAuthorities, requires: request.input.expectedRequires } as never
  }
  if (request.phase === 'sign') return { kind: 'sign', artifactStatementDigest: controlPlaneDigest(request.input.artifact),
    artifactSignature: releaseLaneSignature, artifactSignatureDigest: releaseLaneSignatureDigest,
    buildEvidenceDigest: request.input.buildEvidenceDigest } as never
  if (request.phase === 'publish') return { kind: 'publish', registryId: request.registry.id,
    registryReference: request.authorization.releasePolicy.registryReference, packageName: request.input.artifact.packageName,
    packageVersion: request.input.artifact.packageVersion, tarballSha256: request.input.artifact.tarballSha256,
    tarballIntegrity: request.input.artifact.tarballIntegrity, artifactStatementDigest: request.input.artifactStatementDigest,
    artifactSignatureDigest: releaseLaneSignatureDigest, signEvidenceDigest: request.input.signEvidenceDigest, immutable: true } as never
  if (request.phase === 'registry-verify') return { kind: 'registry-verify', registryId: request.registry.id,
    registryReference: request.input.registryReference, independentlyDownloaded: true, downloadedBytes: request.input.artifact.tarballBytes,
    downloadedSha256: request.input.artifact.tarballSha256, downloadedIntegrity: request.input.artifact.tarballIntegrity,
    artifactStatementDigest: request.input.artifactStatementDigest, artifactSignatureDigest: releaseLaneSignatureDigest,
    publishEvidenceDigest: request.input.publishEvidenceDigest } as never
  if (request.phase !== 'catalog-admission') throw new Error('unexpected release phase')
  return { kind: 'catalog-admission', admissionId: 'admission-1', catalogId: request.catalog.id,
    beforeCatalogDigest: request.input.expectedBeforeCatalogDigest, afterCatalogDigest: request.input.expectedAfterCatalogDigest,
    registryReference: request.input.registryReference, artifactStatementDigest: request.input.artifactStatementDigest,
    artifactSignatureDigest: releaseLaneSignatureDigest, verificationEvidenceDigest: request.input.verificationEvidenceDigest,
    candidate: request.input.candidate } as never
}

// Rewrites the v2 fixture trust as v4 with all eight release lanes unconfigured
// (release state is driven directly through durable store primitives), then
// advances a ready source plan through all eight applied phases to
// release-complete and returns the CatalogEntry the owner catalog must admit.
async function releasedCompleteSource(value: Awaited<ReturnType<typeof fixture>>, suffix: string, registry = { locator: 'https://registry.example.invalid', reference: '@dsh-enhanced/health-helper@0.1.0' }): Promise<{ plan: PluginSourcePlan; released: CatalogEntryShape }> {
  const ready = await readySource(value, suffix)
  const catalogPath = join(value.control, 'catalog.json')
  const adapterKeys = generateKeyPairSync('ed25519')
  const adapterPublicKeyPem = adapterKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const authorizationKeys = generateKeyPairSync('ed25519')
  const authorizationPublicKeyPem = authorizationKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const now = Date.now()
  const unsigned: Omit<SourceReleaseAuthorization, 'signature'> = { schemaVersion: 1,
    kind: 'dsh-source-release-authorization', authorizationId: `release-authorization-${suffix}`, authority: 'release-owner',
    keyId: 'release-owner-key', planId: ready.id, planDigest: ready.digest, baseCommit: ready.baseCommit,
    checkedTreeDigest: ready.sourceCheck!.treeDigest, checkedPatchDigest: ready.sourceCheck!.patchDigest, scope: ready.scope,
    releasePolicy: { targetBranch: 'main', candidateId: ready.name, packageName: '@dsh-enhanced/health-helper',
      packageVersion: '0.1.0', packagePath: 'plugins/health-helper', dshBaseline: '0.1.0-rc.8', capabilities: ['health'],
      authorities: ['read-only: health'], requires: [], registryId: 'fixture-registry',
      registryLocator: registry.locator, registryReference: registry.reference,
      catalogId: 'owner-catalog', catalogPath, minimumReproducibleBuilds: 2 }, authorizedAt: now, expiresAt: now + 60_000 }
  const authorization: SourceReleaseAuthorization = { ...unsigned,
    signature: sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsigned)), authorizationKeys.privateKey).toString('base64') }
  await writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 1, entries: [] })}\n`, { mode: 0o600 })
  await writeFile(value.trustPath, `${JSON.stringify({ ...value.trust, schemaVersion: 4, catalog: { id: 'owner-catalog', path: catalogPath },
    releaseRegistry: { id: 'fixture-registry', locator: registry.locator }, releaseReceiptTtlMs: 30_000,
    releaseAdapters: Object.fromEntries(releasePhases.map(phase => [phase, null])),
    releaseKeys: [{ authority: 'release-adapter', keyId: 'release-adapter-key', publicKeyPem: adapterPublicKeyPem }],
    releaseAuthorizationKeys: [{ authority: 'release-owner', keyId: 'release-owner-key', publicKeyPem: authorizationPublicKeyPem }] })}\n`,
    { mode: 0o600 })
  const store = new ControlPlaneStore({ path: value.state })
  try {
    let plan = (await store.startSourceRelease({ planId: ready.id, expectedRevision: ready.revision, authorization,
      resolveAuthority: () => acceptingReleaseAuthorizationAuthority, idempotencyKey: `release:start:${suffix}` })).result
    for (const phase of releasePhases) {
      expect(plan.status).toBe(`awaiting-${phase}`)
      const operation = await store.prepareSourceReleaseOperation({ planId: plan.id, expectedRevision: plan.revision,
        expectedFence: plan.release!.fence, installationId, ledger: value.trust.ledger,
        registry: { id: 'fixture-registry', locator: registry.locator }, catalog: { id: 'owner-catalog', path: catalogPath,
          ...(phase === 'catalog-admission' ? { expectedBeforeDigest: 'e'.repeat(64), expectedAfterDigest: 'f'.repeat(64) } : {}) },
        adapter: { id: `fixture-adapter-${phase}`, version: 'fixture-adapter-1', path: value.executor,
          sha256: value.trust.executor.sha256, interpreter: null, authority: 'release-adapter', keyId: 'release-adapter-key' },
        receiptTtlMs: 30_000, resolveAuthorizationAuthority: () => acceptingReleaseAuthorizationAuthority })
      const evidence = releaseSuccessEvidence(operation.request)
      const observedAt = Date.now()
      const receiptUnsigned: Omit<SourceReleaseReceipt, 'signature'> = { schemaVersion: 1, receiptId: `receipt:${operation.operationId}`,
        authority: 'release-adapter', keyId: 'release-adapter-key', installationId, planId: plan.id, planDigest: plan.digest,
        releaseId: plan.release!.id, fence: plan.release!.fence, operationId: operation.operationId,
        requestDigest: sourceReleaseRequestDigest(operation.request), phase, outcome: 'passed', evidence,
        evidenceDigest: controlPlaneDigest(evidence), observedAt, expiresAt: Math.min(observedAt + 30_000, authorization.expiresAt) }
      const receipt: SourceReleaseReceipt = { ...receiptUnsigned, signature: releaseLaneSignature }
      await store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision: plan.revision,
        expectedFence: plan.release!.fence, execute: async () => receipt, resolveAuthority: () => acceptingReleaseAuthority,
        resolveAuthorizationAuthority: () => acceptingReleaseAuthorizationAuthority })
      plan = (await store.applySourceRelease({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
        receipt, resolveAuthority: () => acceptingReleaseAuthority, idempotencyKey: `release:apply:${suffix}:${phase}` })).result
    }
    expect(plan.status).toBe('release-complete')
    const released = store.sourceReleaseCandidate(plan.id)
    await writeFile(catalogPath, `${JSON.stringify({ schemaVersion: 1, entries: [released] })}\n`, { mode: 0o600 })
    return { plan, released }
  } finally { store.close() }
}

type CatalogEntryShape = ReturnType<ControlPlaneStore['sourceReleaseCandidate']>

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

async function activatedByProbe(value: Awaited<ReturnType<typeof fixture>>, suffix: string): Promise<PluginActivationPlan> {
  let plan = await staged(value, suffix)
  for (let phase = 0; phase < 7; phase += 1) {
    await configuredProbe(value, plan)
    const store = new ControlPlaneStore({ path: value.state }); plan = store.getPlan(plan.id); store.close()
  }
  expect(plan.status).toBe('activated')
  return plan
}

function watchObservationReceipt(plan: PluginActivationPlan, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  options: { observationId: string; disposition?: 'healthy' | 'regressed'; hostGeneration: number; overrides?: Record<string, unknown> }): PostActivationObservationReceipt {
  const disposition = options.disposition ?? 'healthy'
  const evidence = { kind: 'post-activation-health' as const, checks: 4, failures: disposition === 'regressed' ? 1 : 0, probeDigest: 'b'.repeat(64) }
  const observedAt = Date.now()
  const unsigned: Omit<PostActivationObservationReceipt, 'signature'> = { schemaVersion: 1, observationId: options.observationId,
    authority: 'host-runtime', keyId: 'host-key-1',
    installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
    package: plan.candidate.package, version: plan.candidate.version, integrity: plan.candidate.integrity,
    disposition, evidence, evidenceDigest: postActivationEvidenceDigest(evidence),
    hostGeneration: options.hostGeneration, observedAt, expiresAt: observedAt + 30_000, ...options.overrides }
  return { ...unsigned, signature: sign(null, Buffer.from(postActivationObservationSigningPayload(unsigned)), privateKey).toString('base64') }
}

function watchRetractionReceipt(plan: PluginActivationPlan, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  retractionId: string): ActivationRetractionReceipt {
  const decidedAt = Date.now()
  const unsigned: Omit<ActivationRetractionReceipt, 'signature'> = { schemaVersion: 1, retractionId, authority: 'owner-policy', keyId: 'owner-key-1',
    installationId, planId: plan.id, planDigest: plan.digest, activationId: plan.activation!.id, fence: plan.activation!.fence,
    package: plan.candidate.package, version: plan.candidate.version, integrity: plan.candidate.integrity,
    principal: 'owner@test', reason: 'post-canary regression accepted by owner', decidedAt, expiresAt: decidedAt + 900_000 }
  return { ...unsigned, signature: sign(null, Buffer.from(activationRetractionSigningPayload(unsigned)), privateKey).toString('base64') }
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

  async function runActivationPlan(value: Awaited<ReturnType<typeof fixture>>, sourcePlanId: string, profile: string, key: string,
    extra: readonly string[] = []): Promise<{ receipt: { idempotencyKey: string; result: PluginActivationPlan }; result: PluginActivationPlan; text: string }> {
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['activation-plan', '--source-plan', sourcePlanId,
      '--profile', profile, '--idempotency-key', key, ...extra]))
    const calls = vi.mocked(process.stdout.write).mock.calls
    const text = String(calls.at(-1)![0]!).trim()
    const receipt = JSON.parse(text) as { idempotencyKey: string; result: PluginActivationPlan }
    return { receipt, result: receipt.result, text }
  }

  test('activation-plan binds the exact released admitted candidate, matches the gap and replays the same receipt', async () => {
    const value = await fixture(); const { plan: source, released } = await releasedCompleteSource(value, 'activation-happy')
    const first = await runActivationPlan(value, source.id, 'web', 'activation:cli:happy')
    expect(first.result).toMatchObject({ status: 'pending-approval', kind: 'activation', gapId: source.gapId,
      candidate: released, profile: 'web', installationId })
    expect(first.result.candidate).toEqual(released)
    expect(first.result.dossier).toMatchObject({ catalogProvenance: 'owner-provided-integrity-pinned',
      matchedCapabilities: released.capabilities })
    const inspect = new ControlPlaneStore({ path: value.state })
    expect(inspect.getGap(source.gapId)).toMatchObject({ status: 'matched', candidateId: released.id })
    const stored = inspect.getPlan(first.result.id)
    expect(stored).toMatchObject({ status: 'pending-approval', candidate: released })
    inspect.close()
    const replay = await runActivationPlan(value, source.id, 'web', 'activation:cli:happy')
    expect(replay.text).toBe(first.text)
    expect(replay.result.id).toBe(first.result.id)
  })

  test('activation-plan preserves the released exact npm tarball reference across store restart', async () => {
    const value = await fixture()
    const reference = 'https://registry.example.invalid/npm/health-helper-0.1.0.tgz'
    const { plan: source, released } = await releasedCompleteSource(value, 'activation-npm', {
      locator: 'https://registry.example.invalid/npm/', reference })
    const first = await runActivationPlan(value, source.id, 'web', 'activation:cli:npm')
    expect(first.result).toMatchObject({ status: 'pending-approval', candidate: released, gapId: source.gapId })
    expect(first.result.candidate.registry?.reference).toBe(reference)
    const restarted = new ControlPlaneStore({ path: value.state })
    try { expect(restarted.getPlan(first.result.id).candidate.registry?.reference).toBe(reference) }
    finally { restarted.close() }
  })

  test('activation-plan rejects a source plan that has not completed release', async () => {
    const value = await fixture(); const ready = await readySource(value, 'activation-not-released')
    await expect(runActivationPlan(value, ready.id, 'web', 'activation:cli:not-released'))
      .rejects.toThrow('activation plan requires a release-complete source plan')
  })

  test('activation-plan fails closed when the owner catalog does not admit the released candidate', async () => {
    const value = await fixture(); const { plan: source } = await releasedCompleteSource(value, 'activation-unadmitted')
    await writeFile(join(value.control, 'catalog.json'), `${JSON.stringify({ schemaVersion: 1, entries: [] })}\n`, { mode: 0o600 })
    await expect(runActivationPlan(value, source.id, 'web', 'activation:cli:unadmitted'))
      .rejects.toThrow('released candidate is not the exact admitted owner catalog entry')
    const inspect = new ControlPlaneStore({ path: value.state })
    expect(inspect.getGap(source.gapId)).toMatchObject({ status: 'open' })
    inspect.close()
  })

  test('activation-plan fails closed when the same-id admitted catalog entry drifted from the released content', async () => {
    const value = await fixture(); const { plan: source, released } = await releasedCompleteSource(value, 'activation-drifted')
    const drifted = { ...released, version: '9.9.9',
      registry: { ...released.registry, reference: '@dsh-enhanced/health-helper@9.9.9' } }
    await writeFile(join(value.control, 'catalog.json'), `${JSON.stringify({ schemaVersion: 1, entries: [drifted] })}\n`, { mode: 0o600 })
    await expect(runActivationPlan(value, source.id, 'web', 'activation:cli:drifted'))
      .rejects.toThrow('released candidate is not the exact admitted owner catalog entry')
  })

  test('activation-plan rejects malformed profile text and non-canonical symlinked profile targets', async () => {
    const value = await fixture(); const { plan: source } = await releasedCompleteSource(value, 'activation-bad-profile')
    await expect(runActivationPlan(value, source.id, '../escape', 'activation:cli:bad-text'))
      .rejects.toThrow('profile must already be bounded canonical text')
    await symlink(join(value.dshHome, 'profiles', 'web'), join(value.dshHome, 'profiles', 'linked'))
    await expect(runActivationPlan(value, source.id, 'linked', 'activation:cli:symlink'))
      .rejects.toThrow('target profile must be a canonical directory')
  })

  test('activation-plan rejects a second non-idempotent attempt once the released gap is matched', async () => {
    const value = await fixture(); const { plan: source } = await releasedCompleteSource(value, 'activation-already-matched')
    await runActivationPlan(value, source.id, 'web', 'activation:cli:first')
    await expect(runActivationPlan(value, source.id, 'web', 'activation:cli:second'))
      .rejects.toThrow('only an open gap can create an activation plan')
  })

  test('activation-plan rejects a ttl outside the bounded range', async () => {
    const value = await fixture(); const { plan: source } = await releasedCompleteSource(value, 'activation-bad-ttl')
    await expect(runActivationPlan(value, source.id, 'web', 'activation:cli:bad-ttl', ['--ttl-ms', '1000']))
      .rejects.toThrow(/ttlMs|positive integer/u)
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

  test('downloads a pinned-TLS registry artifact, verifies its approved integrity, and installs from the descriptor cache', async () => {
    const value = await fixture()
    const { key, cert } = await loopbackCertificate()
    const seen: { path: string | undefined; authorization: string | undefined } = { path: undefined, authorization: undefined }
    const bytes = Buffer.from('https-tarball-registry-download')
    const server = await startLocalHttpsRegistry({ key, cert, handle(request) {
      seen.path = request.path; seen.authorization = request.authorization
      if (request.authorization !== 'Bearer fixture-token') return { status: 401 }
      return { status: 200, bytes, contentType: 'application/gzip' }
    } })
    try {
      await writeHttpsTrust(value, { id: 'fixture-registry', locator: server.origin, caPins: [cert], tokenEnvironment: 'DSH_TEST_REGISTRY_TOKEN' })
      const plan = await approvedHttps(value, 'registry-download', server.origin)
      const claimedStore = new ControlPlaneStore({ path: value.state })
      const claimed = await claimedStore.claimActivation(claimInput(plan)); claimedStore.close()
      const cachePath = join(value.dshHome, 'plugin-control', 'activation-artifacts', claimed.activation!.id,
        `${createHash('sha256').update(candidate.package).digest('hex')}.tgz`)
      const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(plan.id); raw.close()
      const log = join(value.root, 'executor.log')
      await withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_REGISTRY_TOKEN: 'fixture-token',
        DSH_TEST_LOCK: localLockfileForDescriptor(claimed), DSH_TEST_PACKAGES: installedPackages(claimed), DSH_TEST_EXECUTOR_LOG: log },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(claimed.revision)]))
      const encodedScope = candidate.package.split('/').map(part => encodeURIComponent(part)).join('/')
      expect(seen.path).toBe(`/packages/${encodedScope}/${candidate.version}/package.tgz`)
      expect(seen.authorization).toBe('Bearer fixture-token')
      const calls = await readFile(log, 'utf8')
      expect(calls).toMatch(new RegExp(`file:///proc/${process.pid}/fd/[0-9]+`, 'u'))
      expect(calls).not.toContain('fixture-token')
      expect(await readFile(cachePath)).toEqual(bytes)
      expect((await stat(cachePath)).mode & 0o777).toBe(0o400)
    } finally { await server.close() }
  })

  test('stages an npm exact version through approved metadata and the descriptor cache', async () => {
    const value = await fixture(); const { key, cert } = await loopbackCertificate()
    const bytes = Buffer.from('https-tarball-npm-download')
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const seen: Array<{ path: string; authorization: string | undefined }> = []
    const metadataPath = `/registry/${encodeURIComponent(candidate.package)}/${candidate.version}`
    const tarballPath = '/registry/artifacts/health.tgz'
    const server = await startLocalHttpsRegistry({ key, cert, handle(request) {
      seen.push({ path: request.path, authorization: request.authorization })
      if (request.authorization !== 'Bearer fixture-token') return { status: 401 }
      if (request.path === metadataPath) return { status: 200, contentType: 'application/json',
        bytes: Buffer.from(JSON.stringify({ name: candidate.package, version: candidate.version,
          dist: { tarball: `${server.origin}${tarballPath}`, integrity } })) }
      if (request.path === tarballPath) return { status: 200, bytes, contentType: 'application/octet-stream' }
      return { status: 404 }
    } })
    try {
      const locator = `${server.origin}/registry`
      await writeHttpsTrust(value, { id: 'fixture-registry', locator, protocol: 'npm', caPins: [cert], tokenEnvironment: 'DSH_TEST_REGISTRY_TOKEN' })
      expect((await loadTrustConfig(value.trustPath)).releaseRegistry?.protocol).toBe('npm')
      const plan = await approvedHttps(value, 'npm-download', locator, 'fixture-registry', `${server.origin}${tarballPath}`)
      const claimedStore = new ControlPlaneStore({ path: value.state })
      const claimed = await claimedStore.claimActivation(claimInput(plan)); claimedStore.close()
      const cachePath = join(value.dshHome, 'plugin-control', 'activation-artifacts', claimed.activation!.id,
        `${createHash('sha256').update(candidate.package).digest('hex')}.tgz`)
      const raw = new DatabaseSync(value.state); raw.prepare('UPDATE activation_plans SET activation_lease_until = 0 WHERE id = ?').run(plan.id); raw.close()
      const log = join(value.root, 'executor.log')
      await withEnvironment({ DSH_HOME: value.dshHome, DSH_TEST_REGISTRY_TOKEN: 'fixture-token',
        DSH_TEST_LOCK: localLockfileForDescriptor(claimed), DSH_TEST_PACKAGES: installedPackages(claimed), DSH_TEST_EXECUTOR_LOG: log },
      () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(claimed.revision)]))
      expect(seen).toEqual([{ path: metadataPath, authorization: 'Bearer fixture-token' },
        { path: tarballPath, authorization: 'Bearer fixture-token' }])
      expect(await readFile(cachePath)).toEqual(bytes)
      expect((await stat(cachePath)).mode & 0o777).toBe(0o400)
      expect(await readFile(log, 'utf8')).toMatch(new RegExp(`file:///proc/${process.pid}/fd/[0-9]+`, 'u'))
      const inspect = new ControlPlaneStore({ path: value.state })
      expect(inspect.getPlan(plan.id).status).toBe('awaiting-reload'); inspect.close()
    } finally { await server.close() }
  })

  test('rejects an npm tarball URL substitution with the approved digest before executor invocation', async () => {
    const value = await fixture(); const { key, cert } = await loopbackCertificate()
    const bytes = Buffer.from('https-tarball-npm-exact-substitution')
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const seen: string[] = []
    const approvedPath = '/registry/artifacts/approved-health.tgz'
    const substitutedPath = '/registry/artifacts/substituted-health.tgz'
    const server = await startLocalHttpsRegistry({ key, cert, handle(request) {
      seen.push(request.path)
      const metadataPath = `/registry/${encodeURIComponent(candidate.package)}/${candidate.version}`
      if (request.path === metadataPath) return { status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({
        name: candidate.package, version: candidate.version, dist: { tarball: `${server.origin}${substitutedPath}`, integrity },
      })) }
      if (request.path === substitutedPath) return { status: 200, bytes, contentType: 'application/octet-stream' }
      return { status: 404 }
    } })
    try {
      const locator = `${server.origin}/registry`
      await writeHttpsTrust(value, { id: 'fixture-registry', locator, protocol: 'npm', caPins: [cert], tokenEnvironment: null })
      const plan = await approvedHttps(value, 'npm-exact-substitution', locator, 'fixture-registry', `${server.origin}${approvedPath}`)
      const log = join(value.root, 'executor.log')
      await expect(withEnvironment({ ...activationEnvironment(value, plan), DSH_TEST_EXECUTOR_LOG: log },
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])))
        .rejects.toThrow('remote artifact reference does not match the approved exact HTTPS reference')
      expect(seen).toEqual([`/registry/${encodeURIComponent(candidate.package)}/${candidate.version}`, substitutedPath])
      await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const inspect = new ControlPlaneStore({ path: value.state })
      expect(inspect.getPlan(plan.id).status).toBe('rolled-back'); inspect.close()
    } finally { await server.close() }
  })

  test('rejects npm metadata that substitutes another integrity before download or executor invocation', async () => {
    const value = await fixture(); const { key, cert } = await loopbackCertificate()
    const seen: string[] = []
    const server = await startLocalHttpsRegistry({ key, cert, handle(request) {
      seen.push(request.path)
      return { status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({
        name: candidate.package, version: candidate.version, dist: { tarball: `${server.origin}/artifact.tgz`,
          integrity: `sha512-${createHash('sha512').update('substitute').digest('base64')}` },
      })) }
    } })
    try {
      await writeHttpsTrust(value, { id: 'fixture-registry', locator: server.origin, protocol: 'npm', caPins: [cert], tokenEnvironment: null })
      const plan = await approvedHttps(value, 'npm-substituted', server.origin)
      const log = join(value.root, 'executor.log')
      await expect(withEnvironment({ ...activationEnvironment(value, plan), DSH_TEST_EXECUTOR_LOG: log },
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))).rejects.toThrow(/integrity/u)
      expect(seen).toEqual([`/${encodeURIComponent(candidate.package)}/${candidate.version}`])
      await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const inspect = new ControlPlaneStore({ path: value.state })
      expect(inspect.getPlan(plan.id).status).toBe('rolled-back'); inspect.close()
    } finally { await server.close() }
  })

  test('rejects registry bytes that do not match the approved integrity before any executor invocation', async () => {
    const value = await fixture()
    const { key, cert } = await loopbackCertificate()
    const server = await startLocalHttpsRegistry({ key, cert, handle: () => ({ status: 200, bytes: Buffer.from('tampered-bytes') }) })
    try {
      await writeHttpsTrust(value, { id: 'fixture-registry', locator: server.origin, caPins: [cert], tokenEnvironment: null })
      const plan = await approvedHttps(value, 'registry-tampered', server.origin)
      const log = join(value.root, 'executor.log')
      await expect(withEnvironment({ ...activationEnvironment(value, plan), DSH_TEST_EXECUTOR_LOG: log },
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])))
        .rejects.toThrow('remote artifact bytes do not match the approved integrity')
      await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const inspect = new ControlPlaneStore({ path: value.state }); expect(inspect.getPlan(plan.id).status).toBe('rolled-back'); inspect.close()
    } finally { await server.close() }
  })

  test('rejects the registry when its bearer token is rejected', async () => {
    const value = await fixture()
    const { key, cert } = await loopbackCertificate()
    const server = await startLocalHttpsRegistry({ key, cert, handle: request =>
      request.authorization === 'Bearer fixture-token' ? { status: 200, bytes: Buffer.from('x') } : { status: 401 } })
    try {
      await writeHttpsTrust(value, { id: 'fixture-registry', locator: server.origin, caPins: [cert], tokenEnvironment: 'DSH_TEST_REGISTRY_TOKEN' })
      const plan = await approvedHttps(value, 'registry-401', server.origin)
      await expect(withEnvironment({ ...activationEnvironment(value, plan), DSH_TEST_REGISTRY_TOKEN: 'wrong-token' },
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])))
        .rejects.toThrow('registry answered 401')
    } finally { await server.close() }
  })

  test('refuses to fetch when the bound token environment variable is absent', async () => {
    const value = await fixture()
    const { key, cert } = await loopbackCertificate()
    let requested = false
    const server = await startLocalHttpsRegistry({ key, cert, handle: () => { requested = true; return { status: 200, bytes: Buffer.from('x') } } })
    try {
      await writeHttpsTrust(value, { id: 'fixture-registry', locator: server.origin, caPins: [cert], tokenEnvironment: 'DSH_TEST_REGISTRY_TOKEN' })
      const plan = await approvedHttps(value, 'registry-no-token', server.origin)
      const environment = Object.fromEntries(Object.entries(activationEnvironment(value, plan)).filter(([name]) => name !== 'DSH_TEST_REGISTRY_TOKEN'))
      await expect(withEnvironment(environment,
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])))
        .rejects.toThrow('bound registry token environment variable is missing')
      expect(requested).toBe(false)
    } finally { await server.close() }
  })

  test('rejects a catalog package bound to a registry other than the owner trust root', async () => {
    const value = await fixture()
    const { key, cert } = await loopbackCertificate()
    const server = await startLocalHttpsRegistry({ key, cert, handle: () => ({ status: 200, bytes: Buffer.from('x') }) })
    try {
      await writeHttpsTrust(value, { id: 'fixture-registry', locator: server.origin, caPins: [cert], tokenEnvironment: null })
      const plan = await approvedHttps(value, 'registry-identity', server.origin, 'another-registry')
      await expect(withEnvironment(activationEnvironment(value, plan),
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])))
        .rejects.toThrow('package registry is not the owner-bound release registry')
    } finally { await server.close() }
  })

  test('rejects a registry whose TLS certificate is not pinned by the owner trust root', async () => {
    const value = await fixture()
    const serverCertificate = await loopbackCertificate(); const pinnedCertificate = await loopbackCertificate()
    const server = await startLocalHttpsRegistry({ key: serverCertificate.key, cert: serverCertificate.cert,
      handle: () => ({ status: 200, bytes: Buffer.from('x') }) })
    try {
      await writeHttpsTrust(value, { id: 'fixture-registry', locator: server.origin, caPins: [pinnedCertificate.cert], tokenEnvironment: null })
      const plan = await approvedHttps(value, 'registry-tls', server.origin)
      await expect(withEnvironment(activationEnvironment(value, plan),
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)])))
        .rejects.toThrow('registry TLS certificate is not pinned by the owner trust root')
    } finally { await server.close() }
  })

  test('retains the legacy registry trust shape when protocol is omitted', async () => {
    const value = await fixture()
    const registry = { id: 'fixture-registry', locator: 'https://registry.example.invalid' }
    await writeHttpsTrust(value, registry)
    expect((await loadTrustConfig(value.trustPath)).releaseRegistry).toEqual({ ...registry, caPins: [], tokenEnvironment: null })
    await writeHttpsTrust(value, { ...registry, protocol: 'dsh' })
    expect((await loadTrustConfig(value.trustPath)).releaseRegistry?.protocol).toBe('dsh')
  })

  test('refuses trust roots whose release registry binding is malformed', async () => {
    const value = await fixture()
    const malformed: Array<{ label: string; registry: Record<string, unknown>; message: string }> = [
      { label: 'protocol', registry: { id: 'fixture-registry', locator: 'https://registry.example.invalid', protocol: 'auto' }, message: 'protocol must be dsh or npm' },
      { label: 'null-protocol', registry: { id: 'fixture-registry', locator: 'https://registry.example.invalid', protocol: null }, message: 'protocol must be dsh or npm' },
      { label: 'query', registry: { id: 'fixture-registry', locator: 'https://registry.example.invalid/?token=x' }, message: 'bare https origin/path' },
      { label: 'http', registry: { id: 'fixture-registry', locator: 'http://registry.example.invalid' }, message: 'bare https origin/path' },
      { label: 'credentials', registry: { id: 'fixture-registry', locator: 'https://owner:secret@registry.example.invalid' }, message: 'bare https origin/path' },
      { label: 'caPins', registry: { id: 'fixture-registry', locator: 'https://registry.example.invalid', caPins: ['not-a-pem'] }, message: 'must be a PEM certificate' },
      { label: 'tokenEnvironment', registry: { id: 'fixture-registry', locator: 'https://registry.example.invalid', tokenEnvironment: '1BAD-NAME' },
        message: 'must name one environment variable' },
      { label: 'id', registry: { id: '../escape', locator: 'https://registry.example.invalid' }, message: 'releaseRegistry id is invalid' },
    ]
    for (const item of malformed) {
      await writeHttpsTrust(value, item.registry)
      await expect(loadTrustConfig(value.trustPath), item.label).rejects.toThrow(item.message)
    }
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
    const terminal = new ControlPlaneStore({ path: value.state }); expect(terminal.getPlan(plan.id).status).toBe('rollback-pending'); terminal.close()
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('keeps physical rollback pending when promotion fails after the stage was installed', async () => {
    const value = await fixture(); const plan = await approved(value, 'post-promotion-failure')
    const original = ControlPlaneStore.prototype.advanceActivation; let injected = false
    const spy = vi.spyOn(ControlPlaneStore.prototype, 'advanceActivation').mockImplementation(function (this: ControlPlaneStore, input) {
      if (!injected && input.from === 'staging' && input.to === 'awaiting-reload') {
        injected = true; throw new Error('forced post-promotion transition failure')
      }
      return original.call(this, input)
    })
    try {
      await expect(withEnvironment(activationEnvironment(value, plan),
        () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))).rejects.toThrow('forced post-promotion')
    } finally { spy.mockRestore() }
    const store = new ControlPlaneStore({ path: value.state }); const pending = store.getPlan(plan.id); store.close()
    expect(pending).toMatchObject({ status: 'rollback-pending', activation: { hostRecoveryRequired: true, rollbackProfileRestored: true } })
    await expect(readFile(join(value.profile, 'marker'), 'utf8')).resolves.toBe('original')
  })

  test('refuses the rollback marker when the restored core-file baseline drifts', async () => {
    const value = await fixture(); const plan = await approved(value, 'rollback-baseline-drift')
    await withEnvironment(activationEnvironment(value, plan), () => runPluginControl(['activate', '--plan-id', plan.id, '--expected-revision', String(plan.revision)]))
    const inspect = new ControlPlaneStore({ path: value.state }); const awaiting = inspect.getPlan(plan.id)
    const operation = inspect.prepareHostAttestationOperation({ planId: awaiting.id, expectedRevision: awaiting.revision, expectedFence: awaiting.activation!.fence,
      issuer: { mode: 'owner-manual' }, requirements: { kind: 'reload', previousHostGeneration: 0 }, receiptTtlMs: 30_000 }); inspect.close()
    const suffix = awaiting.activation!.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
    await writeFile(join(value.dshHome, 'profiles', `.web.plugin-backup-${suffix}`, 'package.json'), '{"drift":true}\n')
    const evidence = { kind: 'reload' as const, reloaded: false, previousHostGeneration: 0, currentHostGeneration: 1, probeDigest: 'd'.repeat(64) }
    const now = Date.now(); const unsigned: Omit<HostAttestationReceipt, 'signature'> = { schemaVersion: 2, receiptId: 'rollback-baseline-drift-reload', authority: 'host-runtime', keyId: 'host-key-1', installationId,
      planId: awaiting.id, planDigest: awaiting.digest, activationId: awaiting.activation!.id, fence: awaiting.activation!.fence, phase: 'reload', outcome: 'failed',
      operationId: operation.operationId, requestDigest: operation.requestDigest, hostGeneration: 1, evidence, evidenceDigest: hostAttestationEvidenceDigest(evidence), observedAt: now, expiresAt: now + 30_000 }
    const receipt: HostAttestationReceipt = { ...unsigned, signature: sign(null, Buffer.from(hostAttestationSigningPayload(unsigned)), value.privateKey).toString('base64') }
    const receiptPath = join(value.control, 'rollback-baseline-drift.json'); await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
    await expect(withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['attest', '--plan-id', awaiting.id,
      '--expected-revision', String(awaiting.revision), '--expected-fence', String(awaiting.activation!.fence), '--receipt', receiptPath]))).rejects.toThrow('does not match')
    const store = new ControlPlaneStore({ path: value.state }); expect(store.getPlan(plan.id)).toMatchObject({ status: 'rollback-pending', activation: { hostRecoveryRequired: true } })
    expect(store.getPlan(plan.id).activation?.rollbackProfileRestored).toBeUndefined(); store.close()
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
    const terminal = new ControlPlaneStore({ path: value.state }); expect(terminal.getPlan(plan.id).status).toBe('rollback-pending'); terminal.close()
  })

  test('recovers a crash between profile backup rename and stage promotion with a new fence', async () => {
    const value = await fixture(); const approvedPlan = await approved(value, 'crash-rename')
    const store = new ControlPlaneStore({ path: value.state }); let claimed = await store.claimActivation(claimInput(approvedPlan, 5_000))
    const baselineFiles = await Promise.all(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(async name => {
      const path = join(value.profile, name)
      try { return { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') } }
      catch (error) { if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { path, sha256: null }; throw error }
    }))
    claimed = store.recordActivationTargetBaseline({ planId: claimed.id, expectedRevision: claimed.revision,
      fence: claimed.activation!.fence, existed: true, baselineFiles }); store.close()
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

  test('watch-observe accepts signed healthy and regressed Host evidence and closes the exact pinned watch', async () => {
    const value = await fixture(); const plan = await activatedByProbe(value, 'watch-observe')
    const healthyPath = join(value.control, 'watch-healthy.json')
    await writeFile(healthyPath, JSON.stringify(watchObservationReceipt(plan, value.privateKey, { observationId: 'obs-healthy-1', hostGeneration: 8 })), { mode: 0o600 })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['watch-observe', '--receipt', healthyPath]))
    let store = new ControlPlaneStore({ path: value.state })
    expect(store.getActivationWatch(plan.id)).toMatchObject({ state: 'watching', revision: 2, healthyObservations: 1, lastHostGeneration: 8 })
    store.close()
    const regressedPath = join(value.control, 'watch-regressed.json')
    await writeFile(regressedPath, JSON.stringify(watchObservationReceipt(plan, value.privateKey,
      { observationId: 'obs-regress-1', disposition: 'regressed', hostGeneration: 9 })), { mode: 0o600 })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['watch-observe', '--receipt', regressedPath]))
    store = new ControlPlaneStore({ path: value.state })
    const watch = store.getActivationWatch(plan.id)
    expect(watch.state).toBe('closed-regressed')
    expect(watch.close).toMatchObject({ disposition: 'regressed', evidenceId: 'obs-regress-1' })
    expect(store.getPlan(plan.id).status).toBe('activated')
    store.close()
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['watch-show', '--plan-id', plan.id]))
  }, 15_000)

  test('watch-retract accepts the owner receipt, closes the watch and reopens the capability gap', async () => {
    const value = await fixture(); const plan = await activatedByProbe(value, 'watch-retract')
    const retractionPath = join(value.control, 'watch-retract.json')
    await writeFile(retractionPath, JSON.stringify(watchRetractionReceipt(plan, value.privateKey, 'retract-1')), { mode: 0o600 })
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['watch-retract', '--receipt', retractionPath]))
    const store = new ControlPlaneStore({ path: value.state })
    expect(store.getActivationWatch(plan.id).state).toBe('closed-retracted')
    const gap = store.getGap(plan.gapId)
    expect(gap.status).toBe('open')
    expect('candidateId' in gap).toBe(false)
    store.close()
  }, 15_000)

  test('watch-observe rejects a signed receipt pinned to a different exact version', async () => {
    const value = await fixture(); const plan = await activatedByProbe(value, 'watch-wrong-exact')
    const receipt = watchObservationReceipt(plan, value.privateKey,
      { observationId: 'obs-wrong-version', hostGeneration: 8, overrides: { version: '0.1.4' } })
    const wrongPath = join(value.control, 'watch-wrong.json')
    await writeFile(wrongPath, JSON.stringify(receipt), { mode: 0o600 })
    await expect(withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(['watch-observe', '--receipt', wrongPath])))
      .rejects.toThrow(/exact installation/u)
    const store = new ControlPlaneStore({ path: value.state })
    expect(store.getActivationWatch(plan.id)).toMatchObject({ state: 'watching', revision: 1, healthyObservations: 0 })
    store.close()
  }, 15_000)

  test('prepares the exact configured Host request without invoking or advancing the attestor', async () => {
    const value = await fixture(); const plan = await staged(value, 'prepare-configured-host')
    const args = ['probe', '--prepare-only', '--plan-id', plan.id, '--expected-revision', String(plan.revision),
      '--expected-fence', String(plan.activation!.fence)]
    vi.mocked(process.stdout.write).mockClear()
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(args))
    const first = String(vi.mocked(process.stdout.write).mock.calls.at(-1)![0])
    await withEnvironment({ DSH_HOME: value.dshHome }, () => runPluginControl(args))
    expect(String(vi.mocked(process.stdout.write).mock.calls.at(-1)![0])).toBe(first)
    expect(JSON.parse(first)).toMatchObject({ phase: 'reload', issuer: { mode: 'configured-executable' },
      plan: { id: plan.id, digest: plan.digest }, activation: { id: plan.activation!.id, fence: plan.activation!.fence } })
    const store = new ControlPlaneStore({ path: value.state })
    try { expect(store.getPlan(plan.id).status).toBe('awaiting-reload') } finally { store.close() }
    const db = new DatabaseSync(value.state)
    try { expect(db.prepare('SELECT status FROM host_attestation_operations WHERE plan_id = ?').get(plan.id)).toMatchObject({ status: 'pending' }) } finally { db.close() }
    await expect(readFile(join(value.attestorDirectory, 'host-generation'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

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
    const store = new ControlPlaneStore({ path: value.state }); expect(store.getPlan(plan.id).status).toBe('rollback-pending'); store.close()
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
