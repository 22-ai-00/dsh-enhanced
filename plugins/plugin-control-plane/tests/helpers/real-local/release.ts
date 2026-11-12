import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { approvalSigningPayload, Ed25519ApprovalAuthority } from '../../../src/approval.ts'
import * as release from '../../../src/release.ts'
import { advanceSourceRelease } from '../../../src/source-release-runner.ts'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from '../../../src/store.ts'
import { defaultHostAttestationPolicy, loadTrustConfig } from '../../../src/trust.ts'
import type { PluginControlTrustConfig } from '../../../src/trust.ts'
import type { SourceReleaseAuthorization } from '../../../src/types.ts'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
export const d3a0Enabled = process.platform === 'linux' && process.env.DSH_REAL_LOCAL_E2E === '1'
  && typeof process.env.DSH_REAL_LOCAL_DSH === 'string' && process.env.DSH_REAL_LOCAL_DSH.length > 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@dsh.invalid', ...args], { cwd, encoding: 'utf8' }).trim()
}
async function pin(path: string) { return { path: await realpath(path), sha256: sha(await readFile(await realpath(path))) } }
async function privateKey(pair: ReturnType<typeof generateKeyPairSync>, path: string) {
  await writeFile(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 })
  return path
}
function sourceDigests(repository: string, baseCommit: string, scope: readonly string[]) {
  const index = join(repository, '..', 'source-e2e.index')
  execFileSync('/usr/bin/git', ['read-tree', baseCommit], { cwd: repository, env: { ...process.env, GIT_INDEX_FILE: index } })
  execFileSync('/usr/bin/git', ['--literal-pathspecs', 'add', '--all', '--', ...scope], { cwd: repository, env: { ...process.env, GIT_INDEX_FILE: index } })
  execFileSync('/usr/bin/git', ['write-tree'], { cwd: repository, env: { ...process.env, GIT_INDEX_FILE: index }, encoding: 'utf8' }).trim()
  const listing = execFileSync('/usr/bin/git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--stage', '-z', '--', ...scope], { cwd: repository, env: { ...process.env, GIT_INDEX_FILE: index } })
  const patch = execFileSync('/usr/bin/git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--cached', '--binary', '--full-index', '--no-color', baseCommit, '--', ...scope], { cwd: repository, env: { ...process.env, GIT_INDEX_FILE: index } })
  const binding = Buffer.from(baseCommit + '\0' + JSON.stringify(scope) + '\0')
  return { treeDigest: createHash('sha256').update('dsh-source-tree-v2\0').update(binding).update(listing).digest('hex'),
    patchDigest: createHash('sha256').update('dsh-source-patch-v2\0').update(binding).update(patch).digest('hex') }
}
export async function realLocalReleaseFixture(input: { name?: string; ownerBound?: boolean } = {}) {
  const cleanup: (() => Promise<void>)[] = []
  const restoreEnv = new Map<string, string | undefined>()
  const setEnv = (key: string, value: string) => { if (!restoreEnv.has(key)) restoreEnv.set(key, process.env[key]); process.env[key] = value }
  let root: string
  try {
  root = await realpath(await mkdtemp(join(tmpdir(), 'd3a0-release-'))); await chmod(root, 0o700)
  // Register teardown before any fallible construction so a throw below cannot leak
  // the temporary root or the DSH_RELEASE_* environment overrides.
  cleanup.push(async () => rm(root, { recursive: true, force: true }))
  cleanup.push(async () => { for (const [key, value] of restoreEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const repository = join(root, 'repository'), remote = join(root, 'remote.git'), home = join(root, 'home')
  for (const path of [repository, remote, home, join(root, 'keys'), join(root, 'adapters'), join(root, 'configs'),
    join(root, 'state'), join(root, 'registry'), join(root, 'downloads'), join(root, 'catalog'), join(root, 'reviews'),
    join(root, 'review-decisions'), join(root, 'toolchain'), join(root, 'store', 'v11', 'projects'), join(root, 'store', 'v11', 'files')]) await mkdir(path, { recursive: true, mode: 0o700 })
  const dsh = await realpath(process.env.DSH_REAL_LOCAL_DSH!); const nodePath = await realpath(process.execPath); const nodePin = await pin(nodePath)

  const name = input.name ?? 'e2e-helper', packageName = '@dsh-enhanced/' + name, version = '0.1.123'
  const targetBranch = 'dsh-source'
  // Base repository: no candidate package, pushed to a local bare remote.
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'd3a0-source', private: true,
    packageManager: 'pnpm@11.7.0', scripts: { build: 'node -e "process.exit(0)"' } }, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(repository, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n', { mode: 0o600 })
  await writeFile(join(repository, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n", { mode: 0o600 })
  await mkdir(join(repository, 'plugins'), { recursive: true, mode: 0o700 })
  await writeFile(join(repository, 'plugins', 'README.md'), '# Plugins\n', { mode: 0o600 })
  git(repository, 'init', '-q'); git(repository, 'add', '--all'); git(repository, 'commit', '-q', '-m', 'base')
  const baseCommit = git(repository, 'rev-parse', 'HEAD')
  git(remote, 'init', '-q', '--bare'); git(repository, 'remote', 'add', 'origin', remote)
  git(repository, 'push', '-q', 'origin', 'HEAD:refs/heads/' + targetBranch)
  // Candidate change stays uncommitted in the worktree; the adapter creates the PR/merge commits.
  const packageDir = join(repository, 'plugins', name)
  await mkdir(join(packageDir, 'lib'), { recursive: true, mode: 0o700 })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version, type: 'module',
    main: './lib/index.js', files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    scripts: { build: 'node -e "process.exit(0)"' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(packageDir, 'lib', 'index.js'), 'export const name = ' + JSON.stringify(name) + '\nexport function apply() {}\n', { mode: 0o600 })
  await writeFile(join(packageDir, 'cordis.patch.yml'), '- id: ' + name + '\n  name: ' + JSON.stringify(packageName) + '\n', { mode: 0o600 })
  await writeFile(join(packageDir, 'README.md'), '# E2E helper\n', { mode: 0o600 })
  await writeFile(join(packageDir, 'LICENSE'), 'MIT\n', { mode: 0o600 })
  if (input.ownerBound !== true) await writeFile(join(repository, 'plugins', 'README.md'), '# Plugins\n\n- ' + name + '\n', { mode: 0o600 })
  const scope = input.ownerBound === true ? ['plugins/' + name] : ['plugins/README.md', 'plugins/' + name]
  const digests = sourceDigests(repository, baseCommit, scope)

  // Ed25519 identities.
  const pair = () => generateKeyPairSync('ed25519')
  const releaseOwner = pair(), approval = pair(), host = pair()
  const signer = pair(), registryVerifier = pair()
  const phaseKeys = Object.fromEntries(phases.map(phase => [phase, pair()])) as Record<typeof phases[number], ReturnType<typeof pair>>
  const keyPath = (name: string) => join(root, 'keys', name + '.key')
  const pubPath = (name: string) => join(root, 'keys', name + '.pub')
  const allPairs: Record<string, ReturnType<typeof pair>> = { releaseOwner, approval, host, signer, registryVerifier,
    ...Object.fromEntries(phases.map(phase => ['release-' + phase, phaseKeys[phase]])) }
  for (const [name, pair] of Object.entries(allPairs)) {
    await privateKey(pair, keyPath(name)); await writeFile(pubPath(name), pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), { mode: 0o600 })
  }
  const identity = async (label: string) => ({ authority: label, keyId: label, publicKeyPath: pubPath(label) })
  const trustKey = (label: string) => ({ authority: label, keyId: label,
    publicKeyPem: allPairs[label]!.publicKey.export({ format: 'pem', type: 'spki' }).toString() })
  // Build toolchain: pinned node + pnpm + store with a v11 project registry.
  await copyFile(nodePath, join(root, 'toolchain', 'node')); await chmod(join(root, 'toolchain', 'node'), 0o700)
  const gatePnpmRoot = process.env.DSH_TEST_PNPM_ROOT
  if (gatePnpmRoot !== undefined && existsSync(join(gatePnpmRoot, 'pnpm'))) {
    for (const entry of await readdir(gatePnpmRoot)) {
      if (entry === 'node') continue
      await cp(join(gatePnpmRoot, entry), join(root, 'toolchain', entry), { recursive: true, dereference: true })
    }
  } else {
    const pnpmRootSource = '/usr/lib/node_modules/pnpm'
    for (const entry of await readdir(pnpmRootSource)) {
      if (entry === 'node_modules') continue
      await cp(join(pnpmRootSource, entry), join(root, 'toolchain', entry), { recursive: true, dereference: false })
    }
    await writeFile(join(root, 'toolchain', 'pnpm'), '#!/usr/bin/env node\nimport(\'./bin/pnpm.mjs\')\n', { mode: 0o700 })
  }
  // The pinned store is read-only inside the build sandbox; pnpm still opens
  // the store index read-only, so seed a valid empty-ish index from the host store.
  const configuredStore = process.env.pnpm_config_store_dir
  const hostStore = configuredStore === undefined
    ? execFileSync('/usr/bin/pnpm', ['store', 'path'], { encoding: 'utf8' }).trim()
    : join(configuredStore, 'v11')
  await copyFile(join(hostStore, 'index.db'), join(root, 'store', 'v11', 'index.db'))
  const { inspectLocalReleaseBuildEnvironment } = await import(new URL('../../../bin/dsh-local-release-adapter.js', import.meta.url).href) as {
    inspectLocalReleaseBuildEnvironment(input: { pnpmRoot: string; storeRoot: string }): Record<string, unknown> }
  const buildPins = inspectLocalReleaseBuildEnvironment({ pnpmRoot: join(root, 'toolchain'), storeRoot: join(root, 'store') })
  const adapterSource = new URL('../../../bin/dsh-local-release-adapter.js', import.meta.url)
  const catalogHelper = await pin(new URL('../../../lib/catalog.js', import.meta.url).pathname)
  const catalogPath = join(root, 'catalog', 'catalog.json')
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, entries: [] }), { mode: 0o600 })
  const registryRoot = join(root, 'registry'), downloadRoot = join(root, 'downloads')
  const policy = { targetBranch, candidateId: name, packageName, packageVersion: version, packagePath: 'plugins/' + name,
    dshBaseline: execFileSync(process.execPath, [dsh, '--version'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } }).trim(),
    capabilities: ['e2e'], authorities: ['filesystem'], requires: [],
    registryId: 'local', registryLocator: pathToFileURL(registryRoot).href,
    registryReference: pathToFileURL(join(registryRoot, 'packages', encodeURIComponent(packageName), version, 'package.tgz')).href,
    catalogId: 'catalog', catalogPath, minimumReproducibleBuilds: 2 }
  const signerPublic = await identity('release-sign')
  const registryVerifierPublic = await identity('release-registry-verify')
  const configs: Record<string, string> = {}
  const adapters: Record<string, { id: string; version: string; path: string; sha256: string; interpreter: { path: string; sha256: string };
    authority: string; keyId: string; timeoutMs: number; environmentAllowlist: string[] }> = {}
  for (const phase of phases) {
    await mkdir(join(root, 'state', phase), { recursive: true, mode: 0o700 })
    const adapterPath = join(root, 'adapters', phase + '.js')
    await copyFile(adapterSource.pathname, adapterPath)
    const adapterLines = (await readFile(adapterPath, 'utf8')).split('\n')
    adapterLines[0] = '#!' + nodePath
    await writeFile(adapterPath, adapterLines.join('\n'), { mode: 0o700 })
    const adapterPin = await pin(adapterPath)
    const label = 'release-' + phase
    const configPath = join(root, 'configs', phase + '.json')
    const config: Record<string, unknown> = { schemaVersion: 1, id: label, phase, executablePath: adapterPath,
      authority: label, keyId: label, privateKeyPath: keyPath(label), authorizationAuthority: await identity('releaseOwner'),
      stateRoot: join(root, 'state', phase),
      git: { executable: await pin('/usr/bin/git'), remote, targetBranch, authorName: 'D3 E2E', authorEmail: 'e2e@dsh.invalid',
        reviewStore: join(root, 'reviews'), reviewDecisionRoot: join(root, 'review-decisions'),
        ...(phase === 'merge' ? { reviewAuthority: await identity('release-review') } : {}) },
      build: buildPins,
      registry: { id: 'local', root: registryRoot, locator: policy.registryLocator, downloadRoot, signer: signerPublic },
      catalog: { id: 'catalog', path: catalogPath, helper: catalogHelper, interpreter: nodePin },
      ...(phase === 'catalog-admission' ? { registryVerifier: registryVerifierPublic } : {}) }
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    const envName = 'DSH_RELEASE_' + phase.toUpperCase().replaceAll('-', '_') + '_CONFIG'
    setEnv(envName, configPath); configs[phase] = configPath
    adapters[phase] = { id: label, version: 'dsh-local-release-adapter-1', ...adapterPin, interpreter: nodePin, authority: label, keyId: label,
      timeoutMs: 120_000, environmentAllowlist: [envName] }
  }


  const trustPath = join(root, 'trust.json'), ledgerPath = join(root, 'control.sqlite')
  const installationId = '018f4f6e-7b21-7c00-8000-00000000d3a0'
  const rawTrust = { schemaVersion: 4, installationId, dshHome: home, hostAttestor: null,
    executor: { id: 'dsh', version: policy.dshBaseline, ...(await pin(dsh)), environmentAllowlist: [] },
    hostPolicy: defaultHostAttestationPolicy, hostAttestationKeys: [trustKey('host')],
    approvalKeys: [trustKey('approval')], releaseAuthorizationKeys: [trustKey('releaseOwner')],
    releaseKeys: phases.map(phase => trustKey('release-' + phase)),
    ledger: { id: '018f4f6e-7b21-7c00-8000-00000000d3a1', path: ledgerPath },
    catalog: { id: 'catalog', path: catalogPath },
    releaseRegistry: { id: 'local', locator: policy.registryLocator }, releaseReceiptTtlMs: 60_000,
    releaseAdapters: adapters }
  await writeFile(trustPath, JSON.stringify(rawTrust), { mode: 0o600 })
  const trust: PluginControlTrustConfig = await loadTrustConfig(trustPath)
  const store = new ControlPlaneStore({ path: ledgerPath, withOwnerActivationFence: (_gapId, callback) => callback() }); cleanup.push(async () => store.close())
  const owner = { receiptVersion: 2 as const, authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const gap = input.ownerBound === true
    ? store.recordOwnerTaskFailureGap({ schemaVersion: 1, owner, outcomeId: 'd3b-outcome', projection: { subjectKind: 'foreground-turn', subjectRef: 'd3b-task', version: 1, digest: sha('projection'), disposition: 'upsert' }, sourceDigest: sha('source') })
    : store.recordGap({ idempotencyKey: 'd3a0-gap', capability: 'e2e', context: 'd3a0 release', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
  const withSourceFence = <T>(callback: () => T): T => input.ownerBound === true ? store.withOwnerTaskFailureGapAdmission(gap.id, callback) : callback()
  const sourcePlanInput = input.ownerBound === true
    ? { mode: 'modify' as const, generatorDigest: MODIFY_GENERATOR_DIGEST, scope,
        prepared: { treeDigest: digests.treeDigest, patchDigest: digests.patchDigest, checkedAt: Date.now(),
          evidence: { schemaVersion: 1 as const, kind: 'dsh-source-prepared-evidence' as const,
            environment: { npmConfigIgnoreScripts: true as const, frozenLockfile: true as const, offline: true as const, nodeVersion: 'fixture', pnpmVersion: 'fixture' },
            commands: [{ command: 'pnpm', args: ['check'], exitCode: 0 as const, durationMs: 1, logDigest: sha('log') }],
            pack: { name, version, sizeBytes: 1, sha256: sha('pack') }, preparedAt: Date.now() } } }
    : { generatorDigest: sha('d3a0-generator'), scope }
  let plan = withSourceFence(() => store.createSourcePlan({ gapId: gap.id, repository, worktree: repository, baseCommit, name,
    ttlMs: 900_000, idempotencyKey: 'd3a0-plan', ...sourcePlanInput })).result
  const approvalUnsigned = { schemaVersion: 1 as const, approvalId: 'd3a0-approval', authority: 'approval', keyId: 'approval',
    planId: plan.id, planDigest: plan.digest, decision: 'approved' as const, principal: 'owner', decidedAt: Date.now(), expiresAt: plan.expiresAt }
  const approvalReceipt = { ...approvalUnsigned, signature: sign(null, Buffer.from(approvalSigningPayload(approvalUnsigned)), approval.privateKey).toString('base64') }
  plan = (await store.approveSource({ planId: plan.id, expectedRevision: plan.revision, receipt: approvalReceipt,
    idempotencyKey: 'd3a0-approval', withSourceFence,
    resolveAuthority: () => new Ed25519ApprovalAuthority(approval.publicKey.export({ format: 'pem', type: 'spki' }).toString(), 'approval', 'approval') })).result
  if (input.ownerBound === true) plan = store.verifyPreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision,
    recheckedTreeDigest: plan.sourceCheck!.treeDigest, recheckedPatchDigest: plan.sourceCheck!.patchDigest, withSourceFence }).result
  else { plan = store.beginSourceChecks({ planId: plan.id, expectedRevision: plan.revision })
    plan = store.finishSourceChecks({ planId: plan.id, expectedRevision: plan.revision, succeeded: true,
      checkedTreeDigest: plan.sourceCheck?.treeDigest ?? digests.treeDigest, checkedPatchDigest: plan.sourceCheck?.patchDigest ?? digests.patchDigest }) }
  const authorizationUnsigned = { schemaVersion: 1 as const, kind: 'dsh-source-release-authorization' as const,
    authorizationId: 'd3a0-authorization', authority: 'releaseOwner', keyId: 'releaseOwner', planId: plan.id, planDigest: plan.digest,
    baseCommit, scope: plan.scope, checkedTreeDigest: plan.sourceCheck!.treeDigest, checkedPatchDigest: plan.sourceCheck!.patchDigest,
    releasePolicy: policy, authorizedAt: Date.now(), expiresAt: plan.expiresAt }
  const authorizationSignature = sign(null, Buffer.from(release.sourceReleaseAuthorizationSigningPayload(authorizationUnsigned)), releaseOwner.privateKey).toString('base64')
  const authorization = { ...authorizationUnsigned, signature: authorizationSignature } as SourceReleaseAuthorization
  plan = (await store.startSourceRelease({ planId: plan.id, expectedRevision: plan.revision,
    authorization, idempotencyKey: 'd3a0-start', withSourceFence,
    resolveAuthority: () => new release.Ed25519SourceReleaseAuthorizationAuthority(
      releaseOwner.publicKey.export({ format: 'pem', type: 'spki' }).toString(), 'releaseOwner', 'releaseOwner') })).result
  const controller = new AbortController()
  const engineOptions: Parameters<typeof advanceSourceRelease>[0] = { store, planId: plan.id, trust,
    config: { reviewDecisionRoot: join(root, 'review-decisions'), timeoutMs: 120_000 }, signal: controller.signal,
    assertCurrent: async () => controller.signal.throwIfAborted(), withSourceFence }
  const decided = new Set<string>()
  const decideReview = async (): Promise<void> => {
    const operation = store.findSourceReleaseOperation(plan.id, 'review', plan.release!.fence)
    if (!operation || operation.request.phase !== 'review' || decided.has(operation.operationId)) return
    const input = operation.request.input as { prId: string; baseCommit: string; headCommit: string; prEvidenceDigest: string }
    await writeFile(join(root, 'review-decisions', input.prId + '.json'), JSON.stringify({ schemaVersion: 1,
      kind: 'dsh-local-review-decision', ...input, decision: 'approved', reviewerPrincipal: 'd3a0-independent-reviewer' }), { mode: 0o600 })
    decided.add(operation.operationId)
  }
  const advanceRaw = async (): Promise<typeof plan> => advanceSourceRelease(engineOptions)
  const advanceOnce = async (): Promise<typeof plan> => { await decideReview(); return advanceSourceRelease(engineOptions) }
  const advance = async (): Promise<typeof plan> => {
    let current = store.getSourcePlan(plan.id)
    for (let index = 0; index < 12 && current.status !== 'release-complete'; index += 1) {
      await decideReview()
      current = await advanceSourceRelease(engineOptions)
      const status = current.status as string
      if (status === 'failed' || status === 'expired' || status === 'rolled-back' || status === 'catalog-admission-rejected') break
    }
    return current
  }
  return { root, home, repository, remote, trust, trustPath, store, plan, options: engineOptions, controller, policy, digests,
    keys: { releaseOwner, approval, host, signer, registryVerifier, phases: phaseKeys }, adapters, configs, rawTrust,
    advance, advanceOnce, advanceRaw, decideReview,
    async close() { controller.abort(); for (const action of cleanup.splice(0).reverse()) await action() } }
  } catch (error) {
    for (const action of cleanup.splice(0).reverse()) { try { await action() } catch { /* best-effort construction teardown */ } }
    throw error
  }
}
