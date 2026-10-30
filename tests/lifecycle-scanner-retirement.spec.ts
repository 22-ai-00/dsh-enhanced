import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { lifecycleProfileTest as api } from '../scripts/install/lifecycle-profile.mjs'

// Parent journal/projection fixtures are not stage authorization receipts. The
// actual tuple/owner/transition checks live in the independently tested stage.
const h = (letter: string) => letter.repeat(64)
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const clone = <T>(value: T): T => structuredClone(value)
type Artifact = { file: string; digest: string }
type Identity = { dev: string; ino: string; uid: number; mode: number }
type Journal = { protocol: string; phase: string; transactionId: string; homePath: string; profile: string;
  originalIdentity: Identity; stagedIdentity: Identity; sourceDigest: string; sourceArtifact: Artifact;
  captureArtifact?: Artifact; completionArtifact?: Artifact; planDigest?: string; unmanagedAutomationsDigest?: string }
async function identity(path: string): Promise<Identity> {
  const entry = await lstat(path)
  return { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scanner-installer-proof-'))); roots.push(root)
  const home = join(root, 'home'), transaction = `${home}.dsh-enhanced-transaction`, staged = join(transaction, 'staged-home')
  await mkdir(home, { mode: 0o700 }); await mkdir(transaction, { mode: 0o700 }); await mkdir(staged, { mode: 0o700 })
  const beforeRecords = [{ id: `usage-scan-${h('1')}`, owner: 'assistant-growth-usage', definitionHash: h('2'),
    status: 'active', nextRunAt: 2, createdAt: 1, updatedAt: 1, version: 1, runningTaskCount: 0 }]
  const afterRecords = [{ ...beforeRecords[0], status: 'paused', nextRunAt: undefined, updatedAt: 3, version: 2 }]
  const effectiveConfig = '{"participation":"original"}\n'
  const source = { effectiveConfigDigest: hash(effectiveConfig), semanticDigest: h('3'), databasePaths: {
    automations: 'automations.sqlite', delivery: 'delivery.sqlite', recovery: 'recovery.sqlite' },
  automationsProof: { storageDigest: h('4') }, deliveryProof: { storageDigest: h('5') }, recoveryProof: { storageDigest: h('6') },
  unmanagedAutomationsDigest: api.unmanagedAutomationDigest(beforeRecords), ownerBindingDigest: h('7') }
  const owner = { authorityId: 'owner-route', authorityHash: h('8'), principalId: 'old-owner',
    principalRecordId: `principal_${randomUUID()}`, principalVersion: 1, workspace: join(home, 'workspace'), agentPreset: 'primary' }
  const ownerSource = { protocol: 'host-rsi/scanner-owner-source/v1', homePath: home, profile: 'web', sourceDigest: h('9'), owner }
  const manifest = { id: randomUUID(), version: 3, operation: 'upgrade', homePath: home, profile: 'web',
    originalIdentity: await identity(home), stagedIdentity: await identity(staged), transactionIdentity: await identity(transaction),
    supervisedLifecycle: { source, scannerRetirement: undefined as Journal | undefined } }
  const sourceArtifact = { protocol: 'dsh-enhanced/scanner-retirement-source/v1', transactionId: manifest.id,
    homePath: home, profile: 'web', source, effectiveConfig, ownerSource }
  const plan = { protocol: 'lark-channel/scanner-retirement-plan/v1', planDigest: h('a'), dshHome: home, profile: 'web', owner,
    effectiveConfigDigest: source.effectiveConfigDigest, automationsDatabasePath: join(home, source.databasePaths.automations),
    before: { storageDigest: source.automationsProof.storageDigest, records: beforeRecords },
    ownerProof: { storageDigest: source.deliveryProof.storageDigest },
    operations: [{ owner: 'assistant-growth-usage', automationId: beforeRecords[0]!.id, expectedVersion: 1 }] }
  const captured = { candidateConfigDigest: hash(effectiveConfig), capture: { status: 'prepared', plan } }
  const completion = { protocol: 'lark-channel/scanner-retirement-completion/v1', planDigest: plan.planDigest, after: { records: afterRecords } }
  function journal(phase = 'source-bound'): Journal {
    return { protocol: 'dsh-enhanced/scanner-retirement-transaction/v1', phase, transactionId: manifest.id, homePath: home, profile: 'web',
      originalIdentity: clone(manifest.originalIdentity), stagedIdentity: clone(manifest.stagedIdentity), sourceDigest: api.scannerBindingDigest(source),
      sourceArtifact: { file: 'scanner-retirement-source.json', digest: h('b') },
      ...(phase === 'source-bound' ? {} : { captureArtifact: { file: 'scanner-retirement-capture.json', digest: h('c') } }),
      ...(['prepared', 'completed'].includes(phase) ? { planDigest: plan.planDigest } : {}),
      ...(phase === 'completed' ? { completionArtifact: { file: 'scanner-retirement-completion.json', digest: h('d') },
        unmanagedAutomationsDigest: api.unmanagedAutomationDigest(afterRecords) } : {}) }
  }
  return { root, home, transaction, staged, manifest, source, owner, sourceArtifact, captured, completion, journal }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function archive(f: Fixture, phase: 'source-bound' | 'prepared' | 'unchanged' | 'completed' = 'completed') {
  const journal = f.journal(phase)
  journal.sourceArtifact = await api.writeScannerArtifact(f.transaction, f.manifest, 'source', f.sourceArtifact)
  if (phase !== 'source-bound') {
    const captured = phase === 'unchanged' ? { candidateConfigDigest: f.captured.candidateConfigDigest, capture: { status: 'no-op', reason: 'owner-active',
      effectiveConfigDigest: f.source.effectiveConfigDigest, beforeSnapshotDigest: h('e'), storageDigest: f.source.automationsProof.storageDigest } } : f.captured
    journal.captureArtifact = await api.writeScannerArtifact(f.transaction, f.manifest, 'capture', captured)
  }
  if (phase === 'completed') journal.completionArtifact = await api.writeScannerArtifact(f.transaction, f.manifest, 'completion', f.completion)
  f.manifest.supervisedLifecycle.scannerRetirement = journal
  return journal
}
async function replaceArchive(f: Fixture, kind: 'source' | 'capture' | 'completion', value: unknown) {
  const journal = f.manifest.supervisedLifecycle.scannerRetirement!
  await rm(join(f.transaction, `scanner-retirement-${kind}.json`))
  journal[`${kind}Artifact`] = await api.writeScannerArtifact(f.transaction, f.manifest, kind, value)
}

describe('scanner retirement journal and candidate baseline', () => {
  test('keeps legacy transactions without a journal on the original source', async () => {
    const f = await fixture()
    expect(api.scannerCandidateSource(f.manifest)).toBe(f.source)
    expect(() => api.assertScannerRetirementBinding(f.manifest)).not.toThrow()
    await expect(api.readScannerRetirementEvidence(f.transaction, f.manifest)).resolves.toBeUndefined()
  })
  test.each(['source-bound', 'prepared'])('forbids candidate activation in %s phase', async phase => {
    const f = await fixture(); f.manifest.supervisedLifecycle.scannerRetirement = f.journal(phase)
    expect(api.validScannerRetirement(f.manifest.supervisedLifecycle.scannerRetirement, f.source)).toBe(true)
    expect(() => api.scannerCandidateSource(f.manifest)).toThrow(/must complete/u)
  })
  test('uses unchanged source by identity and completed source with only the unmanaged baseline replaced', async () => {
    const f = await fixture(), original = clone(f.source)
    f.manifest.supervisedLifecycle.scannerRetirement = f.journal('unchanged')
    expect(api.scannerCandidateSource(f.manifest)).toBe(f.source)
    f.manifest.supervisedLifecycle.scannerRetirement = f.journal('completed')
    expect(api.scannerCandidateSource(f.manifest)).toEqual({ ...original,
      unmanagedAutomationsDigest: api.unmanagedAutomationDigest(f.completion.after.records) })
    expect(f.manifest.supervisedLifecycle.source).toBe(f.source)
    expect(f.source).toEqual(original)
  })
  test.each(['transaction', 'home', 'profile', 'original-inode', 'staged-inode', 'source', 'operation', 'version'] as const)(
    'rejects %s binding drift before selecting a candidate source', async fault => {
      const f = await fixture(); const journal = f.journal('completed'); f.manifest.supervisedLifecycle.scannerRetirement = journal
      if (fault === 'transaction') journal.transactionId = randomUUID()
      if (fault === 'home') journal.homePath = `${f.home}-other`
      if (fault === 'profile') journal.profile = 'other'
      if (fault === 'original-inode') journal.originalIdentity.ino = '0'
      if (fault === 'staged-inode') journal.stagedIdentity.ino = '0'
      if (fault === 'source') journal.sourceDigest = h('0')
      if (fault === 'operation') f.manifest.operation = 'uninstall'
      if (fault === 'version') f.manifest.version = 2
      expect(() => api.scannerCandidateSource(f.manifest)).toThrow(/binding differs/u)
    })
  test.each(['bad-phase', 'extra-field', 'prepared-missing-plan', 'prepared-with-completion', 'source-with-capture', 'completed-without-digest', 'unchanged-with-plan', 'bad-artifact'] as const)(
    'rejects strict journal shape violation: %s', async fault => {
      const f = await fixture(), journal = f.journal(fault.startsWith('source-') ? 'source-bound' : fault.startsWith('unchanged-') ? 'unchanged' : 'prepared')
      if (fault === 'bad-phase') journal.phase = 'complete'
      if (fault === 'extra-field') Object.assign(journal, { approved: true })
      if (fault === 'prepared-missing-plan') delete journal.planDigest
      if (fault === 'prepared-with-completion') journal.completionArtifact = { file: 'scanner-retirement-completion.json', digest: h('a') }
      if (fault === 'source-with-capture') journal.captureArtifact = { file: 'scanner-retirement-capture.json', digest: h('a') }
      if (fault === 'completed-without-digest') { Object.assign(journal, f.journal('completed')); delete journal.unmanagedAutomationsDigest }
      if (fault === 'unchanged-with-plan') journal.planDigest = h('a')
      if (fault === 'bad-artifact') journal.sourceArtifact.file = '../scanner-retirement-source.json'
      expect(api.validScannerRetirement(journal, f.source)).toBe(false)
    })
})

describe.skipIf(process.platform !== 'linux')('private scanner retirement archive files', () => {
  test.each(['source-bound', 'prepared', 'unchanged', 'completed'] as const)('round-trips real 0600 %s archives', async phase => {
    const f = await fixture(), journal = await archive(f, phase)
    const evidence = await api.readScannerRetirementEvidence(f.transaction, f.manifest)
    expect(evidence.source).toEqual(f.sourceArtifact)
    for (const reference of [journal.sourceArtifact, journal.captureArtifact, journal.completionArtifact].filter((value): value is Artifact => value !== undefined)) {
      const path = join(f.transaction, reference.file), entry = await lstat(path), bytes = await readFile(path)
      expect(entry.mode & 0o777).toBe(0o600)
      expect(entry.nlink).toBe(1)
      expect(entry.uid).toBe(process.getuid!())
      expect(reference.digest).toBe(hash(bytes))
      await expect(api.readScannerArtifact(f.transaction, f.manifest, reference)).resolves.toEqual(JSON.parse(bytes.toString('utf8')))
    }
    await expect(api.writeScannerArtifact(f.transaction, f.manifest, 'source', f.sourceArtifact)).rejects.toThrow()
  })
  test.each(['symlink', 'hardlink', 'permissions', 'digest', 'path', 'oversize', 'root-mode', 'root-inode', 'root-symlink'] as const)(
    'rejects unsafe archived evidence: %s', async fault => {
      const f = await fixture(), journal = await archive(f)
      const path = join(f.transaction, journal.sourceArtifact.file)
      if (fault === 'symlink') { const copy = join(f.root, 'foreign.json'); await writeFile(copy, await readFile(path), { mode: 0o600 }); await rm(path); await symlink(copy, path) }
      if (fault === 'hardlink') await link(path, join(f.root, 'extra-link'))
      if (fault === 'permissions') await chmod(path, 0o640)
      if (fault === 'digest') await writeFile(path, JSON.stringify({ ...f.sourceArtifact, effectiveConfig: 'changed' }))
      if (fault === 'path') journal.sourceArtifact.file = '../scanner-retirement-source.json'
      if (fault === 'oversize') await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1, 32))
      if (fault === 'root-mode') await chmod(f.transaction, 0o755)
      if (fault === 'root-inode') f.manifest.transactionIdentity.ino = '0'
      let root = f.transaction
      if (fault === 'root-symlink') { root = join(f.root, 'linked-transaction'); await symlink(f.transaction, root) }
      await expect(api.readScannerArtifact(root, f.manifest, journal.sourceArtifact)).rejects.toThrow()
    })
  test('rejects unknown write kinds and oversized serialized values without creating artifacts', async () => {
    const f = await fixture()
    await expect(api.writeScannerArtifact(f.transaction, f.manifest, '../foreign', {})).rejects.toThrow()
    await expect(api.writeScannerArtifact(f.transaction, f.manifest, 'source', { payload: 'x'.repeat(8 * 1024 * 1024) })).rejects.toThrow(/limit/u)
    expect(await readFile(join(f.transaction, 'scanner-retirement-source.json')).catch(error => error.code)).toBe('ENOENT')
  })
  test.each(['config', 'owner', 'plan-home', 'plan-profile', 'plan-path', 'before-storage', 'owner-storage', 'plan-digest', 'completion-plan', 'completion-baseline', 'source-scope', 'owner-source-scope'] as const)(
    'rejects correctly rehashed archives with %s binding drift', async fault => {
      const f = await fixture(); await archive(f)
      if (fault === 'config') { f.sourceArtifact.effectiveConfig += '\n'; await replaceArchive(f, 'source', f.sourceArtifact) }
      if (fault === 'owner') { f.captured.capture.plan.owner = { ...f.owner, principalVersion: 2 }; await replaceArchive(f, 'capture', f.captured) }
      if (fault === 'plan-home') { f.captured.capture.plan.dshHome += '-other'; await replaceArchive(f, 'capture', f.captured) }
      if (fault === 'plan-profile') { f.captured.capture.plan.profile = 'other'; await replaceArchive(f, 'capture', f.captured) }
      if (fault === 'plan-path') { f.captured.capture.plan.automationsDatabasePath += '-other'; await replaceArchive(f, 'capture', f.captured) }
      if (fault === 'before-storage') { f.captured.capture.plan.before.storageDigest = h('0'); await replaceArchive(f, 'capture', f.captured) }
      if (fault === 'owner-storage') { f.captured.capture.plan.ownerProof.storageDigest = h('0'); await replaceArchive(f, 'capture', f.captured) }
      if (fault === 'plan-digest') { f.captured.capture.plan.planDigest = h('0'); await replaceArchive(f, 'capture', f.captured) }
      if (fault === 'completion-plan') { f.completion.planDigest = h('0'); await replaceArchive(f, 'completion', f.completion) }
      if (fault === 'completion-baseline') { f.completion.after.records[0]!.version++; await replaceArchive(f, 'completion', f.completion) }
      if (fault === 'source-scope') { f.sourceArtifact.transactionId = randomUUID(); await replaceArchive(f, 'source', f.sourceArtifact) }
      if (fault === 'owner-source-scope') { f.sourceArtifact.ownerSource.profile = 'other'; await replaceArchive(f, 'source', f.sourceArtifact) }
      await expect(api.readScannerRetirementEvidence(f.transaction, f.manifest)).rejects.toThrow()
    })
  test('rejects an edited tuple with the original archive digest; semantic tuple validation belongs to the stage', async () => {
    const f = await fixture(); await archive(f)
    f.captured.capture.plan.operations[0]!.expectedVersion++
    await writeFile(join(f.transaction, 'scanner-retirement-capture.json'), JSON.stringify(f.captured))
    await expect(api.readScannerRetirementEvidence(f.transaction, f.manifest)).rejects.toThrow(/artifact changed/u)
  })
  test.each(['bad-status', 'extra-capture', 'no-op-prepared', 'no-op-bad-reason', 'no-op-storage', 'candidate-digest'] as const)(
    'rejects capture phase/status inconsistency: %s', async fault => {
      const f = await fixture(); const unchanged = fault.startsWith('no-op-'); await archive(f, unchanged ? 'unchanged' : 'prepared')
      const captured = JSON.parse(await readFile(join(f.transaction, 'scanner-retirement-capture.json'), 'utf8'))
      if (fault === 'bad-status') captured.capture.status = 'completed'
      if (fault === 'extra-capture') captured.capture.authorized = true
      if (fault === 'no-op-prepared') captured.capture.status = 'prepared'
      if (fault === 'no-op-bad-reason') captured.capture.reason = 'temporarily-unavailable'
      if (fault === 'no-op-storage') captured.capture.storageDigest = h('0')
      if (fault === 'candidate-digest') captured.candidateConfigDigest = 'invalid'
      await replaceArchive(f, 'capture', captured)
      await expect(api.readScannerRetirementEvidence(f.transaction, f.manifest)).rejects.toThrow()
    })
})

describe.skipIf(process.platform !== 'linux')('scanner original-restore admission', () => {
  async function stopped() {
    const f = await fixture(); f.manifest.supervisedLifecycle.scannerRetirement = f.journal('completed')
    await writeFile(join(f.home, 'old-unknown-ledger'), 'retain original unknown and spent quota', { mode: 0o600 })
    const backup = join(f.transaction, 'original-home')
    await rename(f.home, backup)
    const manifest = { ...f.manifest, state: 'prepared', servicePhase: 'staged',
      supervisedLifecycle: { ...f.manifest.supervisedLifecycle, phase: 'source-attested', startAttempt: { kind: 'restore-source' } } }
    return { ...f, backup, manifest }
  }
  test.each(['swapped', 'committed', 'service-accepted', 'cleanup-started'] as const)(
    'refuses old backup after adopted journal state %s, even with a restore-source attempt', async state => {
      const f = await stopped(); f.manifest.state = state
      await expect(api.assertScannerOriginalRestorePossible(f.manifest, f.transaction)).rejects.toThrow(/candidate was adopted/u)
      expect(await readFile(join(f.backup, 'old-unknown-ledger'), 'utf8')).toBe('retain original unknown and spent quota')
    })
  test.each(['post-swap-pending', 'post-swap-accepted'] as const)('refuses old backup in %s phase', async phase => {
    const f = await stopped(); f.manifest.supervisedLifecycle.phase = phase
    await expect(api.assertScannerOriginalRestorePossible(f.manifest, f.transaction)).rejects.toThrow(/candidate was adopted/u)
  })
  test.each(['swapped', 'starting', 'service-accepted'])('refuses candidate service phase %s without a source-restore attempt', async servicePhase => {
    const f = await stopped(); f.manifest.servicePhase = servicePhase; f.manifest.supervisedLifecycle.startAttempt.kind = 'accept-active'
    await expect(api.assertScannerOriginalRestorePossible(f.manifest, f.transaction)).rejects.toThrow(/candidate was adopted/u)
  })
  test('permits pre-swap admission only while the bound stage inode remains, without restoring any files', async () => {
    const f = await stopped(), before = await identity(f.staged)
    await expect(api.assertScannerOriginalRestorePossible(f.manifest, f.transaction)).resolves.toBeUndefined()
    expect(await identity(f.staged)).toEqual(before)
    await expect(lstat(f.home)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.backup, 'old-unknown-ledger'), 'utf8')).toBe('retain original unknown and spent quota')
  })
  test('refuses when directory rename wins before journal update and the original stage is gone', async () => {
    const f = await stopped()
    await rename(f.staged, f.home)
    await rename(f.home, join(f.root, 'missing-candidate-home'))
    await expect(api.assertScannerOriginalRestorePossible(f.manifest, f.transaction)).rejects.toThrow()
    expect(await readFile(join(f.backup, 'old-unknown-ledger'), 'utf8')).toBe('retain original unknown and spent quota')
  })
  test('refuses a different stage inode at the same path', async () => {
    const f = await stopped()
    await rename(f.staged, join(f.transaction, 'old-stage'))
    await mkdir(f.staged, { mode: 0o700 })
    await expect(api.assertScannerOriginalRestorePossible(f.manifest, f.transaction)).rejects.toThrow()
  })
})

// These subprocess cases test the embedded operator's wiring and fences only.
// The tiny public-API module records delegation; it grants no stage authority.
async function operatorFixture() {
  const f = await fixture(); const journal = await archive(f)
  const packageRoot = join(f.home, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'lark-channel')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/lark-channel', type: 'module', exports: './index.mjs' }))
  const log = join(f.home, 'operator-api.ndjson'), config = join(f.home, 'operator-config.json'), dumpLog = join(f.home, 'operator-dump.json')
  await writeFile(config, f.sourceArtifact.effectiveConfig)
  const dsh = join(f.home, 'dsh')
  await writeFile(dsh, `#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(dumpLog)},JSON.stringify(process.argv.slice(2)));process.stdout.write(readFileSync(${JSON.stringify(config)}));\n`, { mode: 0o700 })
  // .mjs interpreter mode is pinned by the profile package's enclosing metadata.
  await writeFile(join(f.home, 'package.json'), '{"type":"module"}')
  await writeFile(join(packageRoot, 'index.mjs'), `import {createHash} from 'node:crypto'; import {appendFile} from 'node:fs/promises';
const record=async(kind,input)=>appendFile(${JSON.stringify(log)},JSON.stringify({kind,input})+'\\n');
export async function deriveScannerRetirementConfiguration(input){await record('derive',input);return {effectiveConfigDigest:createHash('sha256').update(input.effectiveConfig).digest('hex'),...JSON.parse(input.effectiveConfig),owner:input.owner,dshHome:input.dshHome,profile:input.profile};}
export async function captureScannerRetirementPlan(input){await record('capture',input);return {status:'prepared',plan:{wire:'captured'}};}
export async function applyScannerRetirementPlan(input){await record('apply',{...input,signal:{provided:input.signal instanceof AbortSignal,aborted:input.signal.aborted}});return {wire:'applied',planDigest:input.plan.planDigest};}
export async function verifyScannerRetirementPersistence(input){await record('verify',input);return {wire:'verified'};}
`)
  const run = (action: string, override: Partial<{ sourceDigest: string; captureDigest: string; completionDigest: string }> = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', api.SCANNER_RETIREMENT_OPERATOR_PROGRAM,
    action, f.home, 'web', dsh, join(f.transaction, journal.sourceArtifact.file), override.sourceDigest ?? journal.sourceArtifact.digest,
    join(f.transaction, journal.captureArtifact!.file), override.captureDigest ?? journal.captureArtifact!.digest,
    join(f.transaction, journal.completionArtifact!.file), override.completionDigest ?? journal.completionArtifact!.digest], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, DSH_HOME: f.home },
  })
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { ...f, journal, config, dumpLog, run, calls }
}

describe.skipIf(process.platform !== 'linux')('embedded scanner operator delegation', () => {
  test('captures with original frozen scope and attested storage while pinning the candidate dump digest', async () => {
    const f = await operatorFixture(), candidate = `${f.sourceArtifact.effectiveConfig}\n`; await writeFile(f.config, candidate)
    const result = f.run('capture')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ candidateConfigDigest: hash(candidate), capture: { status: 'prepared', plan: { wire: 'captured' } } })
    expect(JSON.parse(await readFile(f.dumpLog, 'utf8'))).toEqual(['--profile', 'web', '--dump-config'])
    expect((await f.calls()).find(call => call.kind === 'capture').input).toEqual({ dshHome: f.home, profile: 'web', owner: f.owner,
      effectiveConfig: f.sourceArtifact.effectiveConfig, expectedStorageDigest: f.source.automationsProof.storageDigest })
  })
  test('applies only the archived plan and original config with a cancellation signal', async () => {
    const f = await operatorFixture(), result = f.run('apply')
    expect(result.status, result.stderr).toBe(0)
    expect((await f.calls()).find(call => call.kind === 'apply').input).toEqual({ plan: f.captured.capture.plan,
      effectiveConfig: f.sourceArtifact.effectiveConfig, signal: { provided: true, aborted: false } })
  })
  test('verifies the archived completion without requiring a fresh candidate config dump', async () => {
    const f = await operatorFixture(); await writeFile(f.config, '{"participation":"later-recovery-config"}')
    const result = f.run('verify')
    expect(result.status, result.stderr).toBe(0)
    expect((await f.calls()).find(call => call.kind === 'verify').input).toEqual({ plan: f.captured.capture.plan, completion: f.completion })
    await expect(readFile(f.dumpLog)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test.each(['source-digest', 'capture-digest', 'completion-digest', 'capture-participation', 'apply-config', 'not-prepared', 'unknown-action'] as const)(
    'refuses %s before dispatch to the stage API', async fault => {
      const f = await operatorFixture(), override: { sourceDigest?: string; captureDigest?: string; completionDigest?: string } = {}
      let action = fault === 'completion-digest' ? 'verify' : fault === 'capture-participation' ? 'capture' : 'apply'
      if (fault === 'source-digest') override.sourceDigest = h('0')
      if (fault === 'capture-digest') override.captureDigest = h('0')
      if (fault === 'completion-digest') override.completionDigest = h('0')
      if (fault === 'capture-participation' || fault === 'apply-config') await writeFile(f.config, '{"participation":"different"}')
      if (fault === 'not-prepared') { const captured = clone(f.captured); captured.capture.status = 'no-op'; await replaceArchive(f, 'capture', captured) }
      if (fault === 'unknown-action') action = 'unknown'
      const result = f.run(action, override)
      expect(result.status).not.toBe(0)
      expect((await f.calls()).some(call => ['capture', 'apply', 'verify'].includes(call.kind))).toBe(false)
    })
})
