import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { sourceReleaseAuthorizationSigningPayload, sourceReleaseEvidenceDigest,
  sourceReleaseRequestDigest, sourceReleaseSigningPayload } from '../src/release.ts'
import { resolveSourceBaseline, validateSourceBaselineConfig } from '../src/source-baseline.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import type { PluginSourcePlan, SourceReleaseOperation, SourceReleaseRequest } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const run = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
  env: { LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()

async function gitFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-source-baseline-')))
  roots.push(root)
  const repository = join(root, 'repository'), remote = join(root, 'remote.git')
  run(root, 'init', '-q', '-b', 'main', repository)
  run(repository, 'config', 'user.name', 'Fixture')
  run(repository, 'config', 'user.email', 'fixture@example.invalid')
  const commits: string[] = []
  for (let index = 0; index < 3; index++) {
    await writeFile(join(repository, 'tracked.txt'), `version ${index}\n`)
    run(repository, 'add', 'tracked.txt')
    run(repository, 'commit', '-qm', `version-${index}`)
    commits.push(run(repository, 'rev-parse', 'HEAD'))
  }
  run(root, 'init', '-q', '--bare', remote)
  await chmod(remote, 0o700)
  run(repository, 'push', '-q', remote, 'HEAD:refs/heads/repairs')
  await writeFile(join(repository, 'tracked.txt'), 'dirty tracked file\n')
  await writeFile(join(repository, 'untracked.txt'), 'dirty untracked file\n')
  const config = { ref: 'refs/dsh-source/main', remote, targetBranch: 'repairs', initialCommit: commits[0]! }
  const keys = generateKeyPairSync('ed25519')
  const trust = { installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00',
    ledger: { id: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01', path: join(root, 'control.sqlite') },
    releaseKeys: [{ authority: 'release-authority', keyId: 'release-key', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }],
  } as unknown as PluginControlTrustConfig
  const controller = new AbortController()
  return { root, repository, remote, commits, config, trust, keys, controller,
    options(history: readonly { plan: PluginSourcePlan; operation: SourceReleaseOperation }[]) {
      return { repository, config, environment: process.env, signal: controller.signal,
        assertCurrent: async () => {}, readHistory: () => history, trust }
    },
  }
}

function signedEdge(value: Awaited<ReturnType<typeof gitFixture>>, base: string, merged: string, ordinal: number):
  { plan: PluginSourcePlan; operation: SourceReleaseOperation } {
  const now = Date.now(), id = `source-${ordinal}`, planDigest = digest(id), releaseId = `release-${ordinal}`
  const policy = { targetBranch: 'repairs', candidateId: 'health-helper', packageName: '@dsh-enhanced/health-helper',
    packageVersion: '0.1.1', packagePath: 'plugins/health-helper', dshBaseline: '0.1.5', capabilities: ['health'],
    authorities: ['filesystem'], requires: [], registryId: 'local', registryLocator: 'file:///private/registry',
    registryReference: 'file:///private/registry/package.tgz', catalogId: 'catalog', catalogPath: join(value.root, 'catalog.json'),
    minimumReproducibleBuilds: 2 }
  const unsignedAuthorization = { schemaVersion: 1 as const, kind: 'dsh-source-release-authorization' as const,
    authorizationId: `authorization-${ordinal}`, authority: 'owner', keyId: 'owner', planId: id, planDigest,
    baseCommit: base, scope: ['plugins/health-helper'], checkedTreeDigest: 'a'.repeat(64), checkedPatchDigest: 'b'.repeat(64),
    releasePolicy: policy, authorizedAt: now - 2_000, expiresAt: now + 60_000 }
  const signature = sign(null, Buffer.from(sourceReleaseAuthorizationSigningPayload(unsignedAuthorization)),
    value.keys.privateKey).toString('base64')
  const authorization = { ...unsignedAuthorization, signature, signatureDigest: digest(Buffer.from(signature, 'base64')) }
  const plan = { schemaVersion: 1, kind: 'source', id, gapId: `gap-${ordinal}`,
    gapSnapshot: { revision: 1, inputDigest: '0'.repeat(64), roi: 1, capability: 'health' },
    status: 'release-complete', revision: 10,
    createdAt: now - 5_000, expiresAt: now + 60_000, digest: planDigest, repository: value.repository,
    worktree: join(value.root, `worktree-${ordinal}`), baseCommit: base, name: 'health-helper', generatorDigest: 'c'.repeat(64),
    mode: 'modify', scope: ['plugins/health-helper'], releaseAuthorization: authorization,
    release: { id: releaseId, fence: 1, updatedAt: now } } as PluginSourcePlan
  const request: SourceReleaseRequest = { schemaVersion: 1, kind: 'dsh-source-release-request', operationId: `operation-${ordinal}`,
    attempt: 1, requestedAt: now - 1_000, receiptTtlMs: 10_000, installationId: value.trust.installationId,
    ledger: value.trust.ledger, plan: { id, digest: planDigest, revision: 7 }, release: { id: releaseId, fence: 1 },
    authorization, adapter: { id: 'local-merge', version: '1', path: join(value.root, 'adapter'), sha256: 'd'.repeat(64),
      interpreter: null, authority: 'release-authority', keyId: 'release-key' },
    registry: { id: policy.registryId, locator: policy.registryLocator },
    catalog: { id: policy.catalogId, path: policy.catalogPath }, phase: 'merge',
    input: { prId: `pr-${ordinal}`, headCommit: merged, reviewId: `review-${ordinal}`, reviewEvidenceDigest: 'e'.repeat(64),
      targetBranch: 'repairs' } }
  const evidence = { kind: 'merge' as const, prId: request.input.prId, reviewedHeadCommit: request.input.headCommit,
    reviewId: request.input.reviewId, reviewEvidenceDigest: request.input.reviewEvidenceDigest,
    mergeCommit: merged, targetBranch: 'repairs' }
  const unsignedReceipt = { schemaVersion: 1 as const, receiptId: `receipt-${ordinal}`, authority: 'release-authority',
    keyId: 'release-key', installationId: request.installationId, planId: id, planDigest, releaseId, fence: 1,
    operationId: request.operationId, requestDigest: sourceReleaseRequestDigest(request), phase: 'merge' as const,
    outcome: 'passed' as const, evidence, evidenceDigest: sourceReleaseEvidenceDigest(evidence),
    observedAt: now - 500, expiresAt: now + 5_000 }
  const receipt = { ...unsignedReceipt, signature: sign(null, Buffer.from(sourceReleaseSigningPayload(unsignedReceipt)),
    value.keys.privateKey).toString('base64') }
  const operation: SourceReleaseOperation = { planId: id, phase: 'merge', operationId: request.operationId, attempt: 1,
    fence: 1, bindingDigest: 'f'.repeat(64), requestDigest: sourceReleaseRequestDigest(request), request,
    status: 'applied', receipt, createdAt: request.requestedAt, completedAt: now - 400, appliedAt: now - 300 }
  return { plan, operation }
}

test('validates managed ref, simple branch, canonical bare path, and bootstrap pin syntax', () => {
  expect(() => validateSourceBaselineConfig({ ref: 'refs/dsh-source/main', remote: '/private/bare',
    targetBranch: 'repairs', initialCommit: 'a'.repeat(40) })).not.toThrow()
  for (const ref of ['refs/heads/main', 'refs/dsh-source/../main', 'refs/dsh-source/Main', 'refs/dsh-source/a.lock']) {
    expect(() => validateSourceBaselineConfig({ ref, remote: '/private/bare', targetBranch: 'repairs',
      initialCommit: 'a'.repeat(40) })).toThrow()
  }
})

test('boots from owner pin, advances two signed merges, and leaves dirty HEAD/index/worktree intact', async () => {
  const value = await gitFixture(), [initial, second, final] = value.commits
  const history = [signedEdge(value, initial!, second!, 1), signedEdge(value, second!, final!, 2)]
  const head = run(value.repository, 'rev-parse', 'HEAD'), status = run(value.repository, 'status', '--porcelain')
  const index = await readFile(join(value.repository, '.git', 'index'))
  expect(await resolveSourceBaseline(value.options(history))).toBe(final)
  expect(run(value.repository, 'show-ref', '--hash', value.config.ref)).toBe(final)
  expect(await resolveSourceBaseline(value.options(history))).toBe(final)
  expect(run(value.repository, 'rev-parse', 'HEAD')).toBe(head)
  expect(run(value.repository, 'status', '--porcelain')).toBe(status)
  expect(await readFile(join(value.repository, '.git', 'index'))).toEqual(index)
})

test('zero-history bootstrap accepts only exact owner pin matching private bare branch', async () => {
  const value = await gitFixture()
  value.config.initialCommit = value.commits[2]!
  expect(await resolveSourceBaseline(value.options([]))).toBe(value.commits[2])
  expect(run(value.repository, 'show-ref', '--hash', value.config.ref)).toBe(value.commits[2])
})

test('rejects fork, bad signature, divergent managed ref, remote drift, and abort', async () => {
  const value = await gitFixture(), [initial, second, final] = value.commits
  const first = signedEdge(value, initial!, second!, 1), last = signedEdge(value, second!, final!, 2)
  await expect(resolveSourceBaseline(value.options([first, signedEdge(value, initial!, final!, 3)]))).rejects.toThrow(/forks/u)
  await expect(resolveSourceBaseline(value.options([last]))).rejects.toThrow(/disconnected/u)
  const forged = { ...first, operation: { ...first.operation,
    receipt: { ...first.operation.receipt!, signature: Buffer.alloc(64).toString('base64') } } }
  await expect(resolveSourceBaseline(value.options([forged, last]))).rejects.toThrow(/signature/u)
  const tree = run(value.repository, 'rev-parse', `${final}^{tree}`)
  const untrusted = run(value.repository, 'commit-tree', tree, '-p', final!, '-m', 'untrusted')
  run(value.repository, 'update-ref', value.config.ref, untrusted)
  await expect(resolveSourceBaseline(value.options([first, last]))).rejects.toThrow(/diverged/u)
  run(value.repository, 'update-ref', value.config.ref, initial!)
  run(value.remote, 'update-ref', 'refs/heads/repairs', second!)
  await expect(resolveSourceBaseline(value.options([first, last]))).rejects.toThrow(/branch/u)
  run(value.remote, 'update-ref', 'refs/heads/repairs', final!)
  await chmod(value.remote, 0o755)
  await expect(resolveSourceBaseline(value.options([first, last]))).rejects.toThrow(/private/u)
  value.controller.abort(new Error('cancelled'))
  await expect(resolveSourceBaseline(value.options([first, last]))).rejects.toThrow(/cancelled/u)
})

test('abort interrupts a hung owner-current fence before any managed ref mutation', async () => {
  const value = await gitFixture(), controller = new AbortController()
  const running = resolveSourceBaseline({ ...value.options([]), signal: controller.signal,
    assertCurrent: () => new Promise<void>(() => {}) })
  controller.abort(new Error('owner fence cancelled'))
  await expect(running).rejects.toThrow(/owner fence cancelled/u)
  expect(run(value.repository, 'for-each-ref', '--format=%(objectname)', value.config.ref)).toBe('')
})

test('history change after bootstrap CAS stops advancement at the known owner pin', async () => {
  const value = await gitFixture(), [initial, second, final] = value.commits
  const first = signedEdge(value, initial!, second!, 1), last = signedEdge(value, second!, final!, 2)
  let history = [first, last], checks = 0
  await expect(resolveSourceBaseline({ ...value.options(history), readHistory: () => history,
    assertCurrent: () => { if (++checks === 5) history = [first] } })).rejects.toThrow(/authority changed/u)
  expect(run(value.repository, 'show-ref', '--hash', value.config.ref)).toBe(initial)
  expect(run(value.repository, 'rev-parse', 'HEAD')).toBe(final)
})

test('rejects when the main worktree HEAD follows the managed ref', async () => {
  const value = await gitFixture(), [initial, second, final] = value.commits
  const history = [signedEdge(value, initial!, second!, 1), signedEdge(value, second!, final!, 2)]
  run(value.repository, 'update-ref', value.config.ref, initial!)
  run(value.repository, 'symbolic-ref', 'HEAD', value.config.ref)
  expect(run(value.repository, 'rev-parse', 'HEAD')).toBe(initial)
  await expect(resolveSourceBaseline(value.options(history))).rejects.toThrow(/checked out/u)
  expect(run(value.repository, 'show-ref', '--hash', value.config.ref)).toBe(initial)
  expect(run(value.repository, 'rev-parse', 'HEAD')).toBe(initial)
})

test('rejects a linked worktree whose HEAD indirectly follows the managed ref', async () => {
  const value = await gitFixture(), [initial, second, final] = value.commits
  const history = [signedEdge(value, initial!, second!, 1), signedEdge(value, second!, final!, 2)]
  const linked = join(value.root, 'linked-worktree')
  run(value.repository, 'update-ref', value.config.ref, initial!)
  run(value.repository, 'worktree', 'add', '-q', '--detach', linked, final!)
  run(linked, 'symbolic-ref', 'refs/heads/managed-alias', value.config.ref)
  run(linked, 'symbolic-ref', 'HEAD', 'refs/heads/managed-alias')
  expect(run(linked, 'symbolic-ref', 'HEAD')).toBe(value.config.ref)
  await expect(resolveSourceBaseline(value.options(history))).rejects.toThrow(/checked out/u)
  expect(run(value.repository, 'show-ref', '--hash', value.config.ref)).toBe(initial)
  expect(run(linked, 'rev-parse', 'HEAD')).toBe(initial)
  expect(run(value.repository, 'rev-parse', 'HEAD')).toBe(final)
})

test('rejects a symbolic managed ref instead of dereferencing into a user branch', async () => {
  const value = await gitFixture(), [initial, second, final] = value.commits
  const history = [signedEdge(value, initial!, second!, 1), signedEdge(value, second!, final!, 2)]
  run(value.repository, 'symbolic-ref', value.config.ref, 'refs/heads/main')
  await expect(resolveSourceBaseline(value.options(history))).rejects.toThrow(/symbolic/u)
  expect(run(value.repository, 'rev-parse', 'refs/heads/main')).toBe(final)
})
