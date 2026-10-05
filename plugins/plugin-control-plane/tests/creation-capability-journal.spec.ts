import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { CreationCapabilityJournal, creationCapabilityPublicKey, validateCreationCapabilityConfig,
  verifyCreationCapabilityReceipt } from '../src/creation-capability-journal.js'
import { CreationCapabilityRuntime } from '../src/creation-capability-runtime.js'
import { creationCapabilitySourceDigest, type CreationCapabilitySourceSnapshot } from '../src/creation-capability-source.js'
import type { CreationCapabilityConfig, CreationCapabilityForegroundCallWitness, CreationCapabilityPorts, CreationCapabilityRunner,
  CreationCapabilityTool } from '../src/creation-capability-types.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const d = (letter: string) => letter.repeat(64)
function fixture(maxAdoptions = 2, maxCalls = 3) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'creation-capability-')); roots.push(root); chmodSync(root, 0o700)
  const signing = generateKeyPairSync('ed25519'), verifier = generateKeyPairSync('ed25519')
  const keyPath = join(root, 'adoption.key')
  writeFileSync(keyPath, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const config: CreationCapabilityConfig = {
    authorityId: 'owner-adoption', keyId: 'adoption-key', keyPath,
    owner: { authorityId: 'owner', authorityHash: d('a'), principalId: 'provider/account/tenant/user',
      principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'default' },
    namePrefix: 'generated-', expiresAt: Date.now() + 120_000, maxAdoptions, maxTools: 2,
    maxCallsPerAdoption: maxCalls, maxCallRecords: maxCalls, maxInputBytes: 1024,
    runner: { stateRoot: root, image: `runner@sha256:${d('a')}`, dockerPath: '/usr/bin/docker',
      expiresAt: Date.now() + 120_000, maxRuns: 5, maxTotalDurationMs: 30_000,
      maxDurationMs: 10_000, maxOutputBytes: 65536 },
  }
  const path = join(root, 'creation-adoptions.sqlite')
  const artifact = Buffer.from('exact candidate tarball')
  function certificate(planId: string, lifetimeMs = 90_000, schemaDigest = d('5')): PluginCreationVerificationCertificate {
    const now = Date.now()
    const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
      protocol: 'assistant-growth/creation-verification/v1', verificationId: `verification-${planId}`,
      authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'independent-verifier',
        keyId: 'verifier-key', authorityDigest: d('b'), namePrefix: 'generated-', expiresAt: now + 120_000 },
      plan: { id: planId, digest: d('c'), name: `generated-${planId}`, sourceTreeDigest: d('d'),
        sourcePatchDigest: d('e'), artifactSha256: createHash('sha256').update(artifact).digest('hex'),
        artifactBytes: artifact.length, generatorDigest: d('f') },
      source: { referenceDigest: d('1'), ownerDigest: d('2'), growthRunDigest: d('3') },
      contractDigest: d('4'), schemaDigest, environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
      model: { provider: 'fixture', model: 'test' }, budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
      sessions: { contract: 'contract-session', sourceReview: 'review-session' },
      observations: [{ caseId: 'first', jobId: 'job-first', operationDigest: d('6'), observationDigest: d('7') },
        { caseId: 'second', jobId: 'job-second', operationDigest: d('8'), observationDigest: d('9') }],
      reviewDigest: d('0'), verifiedAt: now - 1000, expiresAt: now + lifetimeMs,
    }
    return { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), verifier.privateKey).toString('base64url') }
  }
  return { root, config, path, artifact, certificate, signing, verifier }
}

function archivedFixture(f: ReturnType<typeof fixture>, planId = 'one') {
  const certificate = f.certificate(planId)
  const baseCommit = '1'.repeat(40), content = 'export const answer = 42\n'
  const path = `plugins/${certificate.plan.name}/src/index.ts`, bytes = Buffer.from(content)
  const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const scope = [`plugins/${certificate.plan.name}`, 'plugins/README.md', 'pnpm-lock.yaml'].sort()
  const entries = [{ path: 'plugins/README.md', mode: '100644' as const, oid: '2'.repeat(40) },
    { path, mode: '100644' as const, oid }, { path: 'pnpm-lock.yaml', mode: '100644' as const, oid: '3'.repeat(40) }]
  const treeDigest = createHash('sha256').update(`dsh-source-tree-v2\0${baseCommit}\0${JSON.stringify(scope)}\0`)
    .update(entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join('')).digest('hex')
  const payload: Omit<CreationCapabilitySourceSnapshot, 'digest'> = {
    protocol: 'dsh-created-capability-source/v1', baseCommit, scope, treeDigest,
    patchDigest: certificate.plan.sourcePatchDigest, entries,
    files: [{ path, mode: '100644', oid, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), content }],
  }
  const source = { ...payload, digest: creationCapabilitySourceDigest(payload) }
  const { signature: _signature, ...body } = certificate
  body.plan = { ...body.plan, sourceTreeDigest: treeDigest }
  return { source, certificate: { ...body, signature: sign(null,
    Buffer.from(canonicalGrowthJson(body)), f.verifier.privateKey).toString('base64url') } }
}
const tools: CreationCapabilityTool[] = [{ originalName: 'echo', name: 'generated_echo', description: 'Echo', parameters: { type: 'object' } }]
const callKey = (planId: string, sessionId: string, callId: string, toolName: string) =>
  createHash('sha256').update(JSON.stringify({ planId, sessionId, callId, toolName })).digest('hex')
function witness(config: CreationCapabilityConfig, argumentsDigest: string, callId = 'call-1'): CreationCapabilityForegroundCallWitness {
  return { protocol: 'assistant-delivery/foreground-tool-call/v1',
    task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId: 'inbox-1', sessionId: 'session-1',
      scope: { workspace: config.owner.workspace, preset: config.owner.agentPreset },
      owner: { principalRecordId: config.owner.principalRecordId, principalVersion: config.owner.principalVersion },
      binding: { id: 'binding-1', version: 1, generation: 1 }, dispatchedAt: Date.now() },
    turn: 1, call: { id: callId, toolName: 'generated_echo', eventSeq: 1, eventDigest: d('f'), argumentsDigest } }
}

test('owner key and config preflight are read-only and reject unsafe fields', () => {
  const f = fixture()
  validateCreationCapabilityConfig(f.config)
  expect(creationCapabilityPublicKey(f.config)).toContain('BEGIN PUBLIC KEY')
  expect(() => validateCreationCapabilityConfig({ ...f.config, maxAdoptions: 33 })).toThrow()
  let invoked = false
  const bad = { ...f.config }
  Object.defineProperty(bad, 'keyPath', { enumerable: true, get() { invoked = true; return f.config.keyPath } })
  expect(() => validateCreationCapabilityConfig(bad)).toThrow()
  expect(invoked).toBe(false)
})

test('historical signed source survives expiry, closure and restart without renewed quota', () => {
  const f = fixture(1, 1), prepared = archivedFixture(f)
  let journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  journal.claim({ ...prepared, artifact: f.artifact })
  expect(journal.inspectSourceArchive('one')).toBeUndefined() // No adopted receipt yet.
  journal.authorize('one', tools); journal.activate('one')
  const receipt = journal.inspect('one')!.receipt!, authorityDigest = journal.authorityDigest
  const original = journal.inspectSourceArchive('one')!
  expect(original.source).toEqual(prepared.source)
  journal.claimCall({ planId: 'one', key: 'uncertain', argumentsDigest: d('a') })
  journal.settle('one', 'closed', 'owner-corrected')
  journal.close()
  vi.spyOn(Date, 'now').mockReturnValue(f.config.expiresAt + 1)
  journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.recoverClaims()
    expect(journal.authorityDigest).toBe(authorityDigest)
    expect(journal.inspect('one')?.receipt).toEqual(receipt)
    expect(journal.inspectSourceArchive('one')).toEqual(original)
    expect(journal.listCallEvidence('one')).toMatchObject([{ status: 'unknown' }])
    expect(() => journal.claimCall({ planId: 'one', key: 'new-call', argumentsDigest: d('a') })).toThrow()
    expect(() => journal.claim({ certificate: f.certificate('two'), artifact: f.artifact })).toThrow()
  } finally { journal.close() }
})

test('source insertion failure rolls back the adoption reservation and never backfills a legacy claim', () => {
  const f = fixture(1), prepared = archivedFixture(f)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  const db = new DatabaseSync(f.path)
  try {
    db.exec("CREATE TRIGGER reject_archive BEFORE INSERT ON source_archives BEGIN SELECT RAISE(ABORT,'fixture-storage-failure'); END")
    expect(() => journal.claim({ ...prepared, artifact: f.artifact })).toThrow(/fixture-storage-failure/)
    expect(journal.list()).toEqual([])
    db.exec('DROP TRIGGER reject_archive')
    journal.claim({ certificate: prepared.certificate, artifact: f.artifact })
    const receipt = journal.authorize('one', tools).receipt
    expect(journal.inspectSourceArchive('one')).toBeUndefined()
    expect(() => journal.claim({ ...prepared, artifact: f.artifact })).toThrow()
    expect(journal.inspect('one')?.receipt).toEqual(receipt)
    expect(journal.inspectSourceArchive('one')).toBeUndefined()
    expect(() => journal.claim({ certificate: f.certificate('two'), artifact: f.artifact })).toThrow()
  } finally { db.close(); journal.close() }
})

test('lazy archive reads reject source and signature tampering without altering the signed adoption', () => {
  const f = fixture(), prepared = archivedFixture(f)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  journal.claim({ ...prepared, artifact: f.artifact }); journal.authorize('one', tools)
  const original = journal.inspectSourceArchive('one')!, receipt = journal.inspect('one')!.receipt
  const db = new DatabaseSync(f.path)
  try {
    const signature = Buffer.from(original.signature, 'base64url'); signature[0] = signature[0]! ^ 1
    for (const tampered of [{ ...original, signature: signature.toString('base64url') },
      { ...original, source: { ...original.source, files: original.source.files.map(file => ({ ...file, content: 'forged source' })) } },
      { ...original, artifactSha256: d('a') }]) {
      db.prepare('UPDATE source_archives SET archive_json=? WHERE plan_id=?').run(canonicalGrowthJson(tampered), 'one')
      expect(() => journal.inspectSourceArchive('one')).toThrow()
      expect(journal.inspect('one')?.receipt).toEqual(receipt)
    }
    db.prepare('UPDATE source_archives SET archive_json=? WHERE plan_id=?').run(canonicalGrowthJson(original), 'one')
    expect(journal.inspectSourceArchive('one')).toEqual(original)
  } finally { db.close(); journal.close() }
})

test('schema 2 migration preserves authority, receipts, calls and exhausted quota without invented source', () => {
  const f = fixture(1, 1)
  let journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  journal.claim({ certificate: f.certificate('one'), artifact: f.artifact }); journal.authorize('one', tools)
  journal.activate('one')
  const authorityDigest = journal.authorityDigest, receipt = journal.inspect('one')!.receipt
  journal.claimCall({ planId: 'one', key: 'cached', argumentsDigest: d('a') })
  journal.settleCall({ planId: 'one', key: 'cached', status: 'completed', result: { answer: 'original' } })
  journal.close()
  const db = new DatabaseSync(f.path)
  try { db.exec('DROP TABLE source_archives; PRAGMA user_version=2') } finally { db.close() }
  journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(journal.authorityDigest).toBe(authorityDigest)
    expect(journal.inspect('one')?.receipt).toEqual(receipt)
    expect(journal.inspectSourceArchive('one')).toBeUndefined()
    expect(journal.claimCall({ planId: 'one', key: 'cached', argumentsDigest: d('a') }).call.result).toEqual({ answer: 'original' })
    expect(() => journal.claimCall({ planId: 'one', key: 'new-call', argumentsDigest: d('b') })).toThrow()
    expect(() => journal.claim({ certificate: f.certificate('two'), artifact: f.artifact })).toThrow()
  } finally { journal.close() }
})

test('accepts immutable Docker image ID or repository digest, rejecting mutable tags', () => {
  const f = fixture()
  expect(() => validateCreationCapabilityConfig({ ...f.config,
    runner: { ...f.config.runner, image: `sha256:${d('a')}` } })).not.toThrow()
  expect(() => validateCreationCapabilityConfig(f.config)).not.toThrow()
  expect(() => validateCreationCapabilityConfig({ ...f.config,
    runner: { ...f.config.runner, image: 'runner:latest' } })).toThrow()
})

test('preflight rejects budgets the actual process runner cannot start', () => {
  const f = fixture()
  for (const budget of [{ maxOutputBytes: 65535 }, { maxOutputBytes: 65537 },
    { maxDurationMs: 300001 }, { maxDurationMs: 30000, maxTotalDurationMs: 29999 }]) {
    expect(() => validateCreationCapabilityConfig({ ...f.config,
      runner: { ...f.config.runner, ...budget } })).toThrow()
  }
  expect(() => validateCreationCapabilityConfig({ ...f.config,
    runner: { ...f.config.runner, maxDurationMs: 300000, maxTotalDurationMs: 300000 } })).not.toThrow()
})

test('retention is explicit, bounded and part of the immutable authority digest', () => {
  const f = fixture()
  for (const maximumLifetimeMs of [0, 30 * 86_400_000 + 1, 1.5]) {
    expect(() => validateCreationCapabilityConfig({ ...f.config, retention: { maximumLifetimeMs } })).toThrow()
  }
  const retained = { ...f.config, retention: { maximumLifetimeMs: 15_000 } }
  const journal = new CreationCapabilityJournal({ path: f.path, config: retained })
  journal.close()
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.config })).toThrow()
  expect(() => new CreationCapabilityJournal({ path: f.path,
    config: { ...retained, retention: { maximumLifetimeMs: 15_001 } } })).toThrow()
})

test('retention never admits a first adoption with an expired certificate or use grant', () => {
  const f = fixture()
  f.config.retention = { maximumLifetimeMs: 20_000 }
  const now = Date.now()
  f.config.runner.expiresAt = now + 1_000
  const expired = f.certificate('expired', 1), fresh = f.certificate('runner-expired')
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 3)
    expect(() => journal.claim({ certificate: expired, artifact: f.artifact })).toThrow()
    clock.mockReturnValue(now + 1_001)
    expect(() => journal.claim({ certificate: fresh, artifact: f.artifact })).toThrow()
  } finally { journal.close() }
})

test('the signed retained deadline cannot be extended or used for another call', () => {
  const f = fixture()
  f.config.retention = { maximumLifetimeMs: 5_000 }
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('one', 2_000), artifact: f.artifact })
    const receipt = journal.authorize('one', tools).receipt!
    journal.activate('one')
    expect(receipt.expiresAt).toBe(receipt.adoptedAt + 5_000)
    expect(journal.inspect('one')?.receipt).toEqual(receipt)
    vi.spyOn(Date, 'now').mockReturnValue(receipt.expiresAt)
    expect(verifyCreationCapabilityReceipt(receipt, journal.authorityDigest, journal.publicKey)).toBe(false)
    expect(() => journal.claimCall({ planId: 'one', key: 'late', argumentsDigest: d('a') })).toThrow()
    expect(journal.inspect('one')?.receipt).toEqual(receipt)
  } finally { journal.close() }
})

test('real journal and Cordis tool retain one signed adoption across certificate expiry and Host restart', async () => {
  const f = fixture(1, 2)
  const baseTime = Date.now()
  f.config.retention = { maximumLifetimeMs: 15_000 }
  f.config.expiresAt = baseTime + 12_000
  f.config.runner.expiresAt = baseTime + 10_000
  const schemas = [{ name: 'echo', parameters: { type: 'object', additionalProperties: false,
    properties: { query: { type: 'string' } }, required: ['query'] } }]
  const schemaDigest = createHash('sha256').update(JSON.stringify(schemas)).digest('hex')
  const certificate = f.certificate('one', 2_000, schemaDigest)
  const ctx = new Context()
  let journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  let discover = 0, invoke = 0, sourceCurrent = true, proofAvailable = true
  let pinnedProof: CreationCapabilityForegroundCallWitness | undefined
  const ports: CreationCapabilityPorts = {
    inspect: () => {
      if (Date.now() >= certificate.expiresAt) throw new Error('fresh certificate expired')
      return { certificate, artifact: f.artifact, owner: f.config.owner }
    },
    recheck: async () => { if (Date.now() >= certificate.expiresAt) throw new Error('fresh certificate expired') },
    inspectRetained: () => ({ certificate, artifact: f.artifact, owner: f.config.owner }),
    recheckRetained: async () => { if (!sourceCurrent) throw new Error('canonical source withdrawn') },
    withCurrent: (_record, callback) => {
      if (!sourceCurrent) throw new Error('canonical source withdrawn')
      return callback()
    },
    assertCaller: () => { if (!sourceCurrent) throw new Error('owner withdrawn') },
    inspectCall: (_record, _execution, alias, argumentsJson) => {
      if (!proofAvailable) return undefined
      if (!pinnedProof) {
        const base = witness(f.config, createHash('sha256').update(argumentsJson).digest('hex'), 'first')
        pinnedProof = { ...base, task: { ...base.task, sessionId: 'session-one' },
          call: { ...base.call, toolName: alias } }
      }
      return pinnedProof
    },
  }
  const runner: CreationCapabilityRunner = {
    run: async input => {
      if (input.operation.kind === 'discover') {
        discover++
        return { status: 'observed', quiescent: true, artifactSha256: certificate.plan.artifactSha256,
          schemaDigest, environment: certificate.environment, schemas }
      }
      invoke++
      return { status: 'observed', quiescent: true, artifactSha256: certificate.plan.artifactSha256,
        schemaDigest, environment: certificate.environment,
        calls: input.operation.calls.map(call => ({ id: call.id, toolName: call.toolName,
          result: { isError: false, value: { answer: 'ok' }, content: [{ type: 'text', text: 'ok' }] } })) }
    },
    close: async () => {},
  }
  const runtime = () => new CreationCapabilityRuntime({ ctx, config: f.config, journal, ports,
    createRunner: async () => runner })
  const execute = async (name: string, callId: string) => ctx.tools.get(name)!.execute({ query: 'hi' }, {
    callId, agent: { session: { id: 'session-one' } }, signal: new AbortController().signal,
  } as unknown as ToolRunContext)
  try {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    const first = runtime(); await first.start(); await first.adopt('one', new AbortController().signal)
    const receipt = journal.inspect('one')!.receipt!
    const name = journal.inspect('one')!.tools![0]!.name
    expect(receipt.protocol).toBe('dsh-created-capability-adoption/v2')
    expect(receipt.expiresAt).toBe(f.config.runner.expiresAt)
    expect(verifyCreationCapabilityReceipt(receipt, journal.authorityDigest, journal.publicKey)).toBe(true)
    expect(verifyCreationCapabilityReceipt({ ...receipt, expiresAt: receipt.expiresAt + 1 },
      journal.authorityDigest, journal.publicKey)).toBe(false)
    expect(await execute(name, 'first')).toMatchObject({ value: { answer: 'ok' } })
    proofAvailable = false
    await expect(execute(name, 'first')).rejects.toThrow()
    expect(invoke).toBe(1)
    await first.close()
    vi.spyOn(Date, 'now').mockReturnValue(baseTime + 3_000)
    journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
    expect(() => journal.claim({ certificate, artifact: f.artifact })).toThrow()
    const restarted = runtime(); await restarted.start()
    expect(ctx.tools.get(name)).toBeDefined()
    await expect(execute(name, 'first')).rejects.toThrow()
    expect(invoke).toBe(1)
    proofAvailable = true
    expect(await execute(name, 'first')).toMatchObject({ value: { answer: 'ok' } })
    proofAvailable = false
    expect(await execute(name, 'second')).toMatchObject({ value: { answer: 'ok' } })
    expect(journal.listCallEvidence('one').find(item => item.foreground)?.attribution).toBe('foreground')
    expect(discover).toBe(1)
    expect(invoke).toBe(2)
    await expect(execute(name, 'third')).rejects.toThrow()
    expect(invoke).toBe(2)
    sourceCurrent = false
    await restarted.reconcile()
    expect(ctx.tools.get(name)).toBeUndefined()
    expect(journal.inspect('one')?.status).toBe('closed')
    await restarted.close()
  } finally { await ctx.fiber.dispose() }
})

test('claim and signed adoption survive restart without restoring quota', () => {
  const f = fixture(1), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  const certificate = f.certificate('one')
  try {
    expect(journal.claim({ certificate, artifact: f.artifact }).created).toBe(true)
    expect(journal.claim({ certificate, artifact: f.artifact }).created).toBe(false)
    expect(() => journal.claim({ certificate, artifact: Buffer.from('tampered') })).toThrow()
    const record = journal.authorize('one', tools)
    expect(record.status).toBe('authorized')
    expect(record.receipt && verifyCreationCapabilityReceipt(record.receipt, journal.authorityDigest, journal.publicKey)).toBe(true)
    expect(record.receipt && verifyCreationCapabilityReceipt({ ...record.receipt, toolsDigest: d('f') }, journal.authorityDigest, journal.publicKey)).toBe(false)
    expect(journal.activate('one').status).toBe('active')
  } finally { journal.close() }
  const reopened = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(reopened.inspect('one')?.status).toBe('active')
    expect(() => reopened.claim({ certificate: f.certificate('two'), artifact: f.artifact })).toThrow()
    expect(() => new CreationCapabilityJournal({ path: f.path, config: { ...f.config, maxCallsPerAdoption: 2 } })).toThrow()
  } finally { reopened.close() }
})

test('call keys bind arguments, spend finite quota, and recovered claims never dispatch again', () => {
  const f = fixture(2, 1), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('one'), artifact: f.artifact })
    journal.authorize('one', tools); journal.activate('one')
    expect(journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).created).toBe(true)
    expect(journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).created).toBe(false)
    expect(() => journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('b') })).toThrow()
    expect(() => journal.claimCall({ planId: 'one', key: 'call-2', argumentsDigest: d('a') })).toThrow()
  } finally { journal.close() }
  const reopened = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(reopened.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).call.status).toBe('claimed')
    reopened.recoverClaims()
    expect(reopened.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).call.status).toBe('unknown')
    expect(() => reopened.settleCall({ planId: 'one', key: 'call-1', status: 'completed', result: 'late' })).toThrow()
    expect(() => reopened.claimCall({ planId: 'one', key: 'call-2', argumentsDigest: d('a') })).toThrow()
  } finally { reopened.close() }
})

test('terminal state and SQLite constraints reject reauthorization and corrupt rows', () => {
  const f = fixture(), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    const certificate = f.certificate('one')
    journal.claim({ certificate, artifact: f.artifact })
    journal.recoverClaims()
    expect(journal.inspect('one')?.status).toBe('unknown')
    expect(() => journal.authorize('one', tools)).toThrow()
    expect(journal.claim({ certificate, artifact: f.artifact }).record.status).toBe('unknown')
    const raw = new DatabaseSync(f.path)
    try { expect(() => raw.prepare("UPDATE adoptions SET status='invalid' WHERE plan_id='one'").run()).toThrow()
      raw.prepare("UPDATE adoptions SET certificate_digest=? WHERE plan_id='one'").run(d('f'))
      expect(() => journal.inspect('one')).toThrow()
    } finally { raw.close() }
  } finally { journal.close() }
})

test('completed calls retain bounded result and expired receipts cannot dispatch', () => {
  const f = fixture(), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('one'), artifact: f.artifact })
    const receipt = journal.authorize('one', tools).receipt!
    journal.activate('one')
    journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') })
    expect(() => journal.settleCall({ planId: 'one', key: 'call-1', status: 'completed', result: 'x'.repeat(65537) })).toThrow()
    journal.settleCall({ planId: 'one', key: 'call-1', status: 'completed', result: { value: 'ok' }, jobId: 'job-one' })
    expect(journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).call)
      .toEqual({ key: 'call-1', status: 'completed', result: { value: 'ok' }, jobId: 'job-one' })
    expect(() => journal.settleCall({ planId: 'one', key: 'call-1', status: 'unknown' })).toThrow()
    vi.spyOn(Date, 'now').mockReturnValue(receipt.expiresAt)
    expect(verifyCreationCapabilityReceipt(receipt, journal.authorityDigest, journal.publicKey)).toBe(false)
    expect(() => journal.claimCall({ planId: 'one', key: 'call-2', argumentsDigest: d('a') })).toThrow()
  } finally { journal.close() }
})

test('v1 calls migrate without backfilling evidence, quota or unknown state', () => {
  const f = fixture(1, 2)
  const first = new CreationCapabilityJournal({ path: f.path, config: f.config })
  first.claim({ certificate: f.certificate('one'), artifact: f.artifact })
  first.authorize('one', tools); first.activate('one')
  const authorityDigest = first.authorityDigest, receipt = first.inspect('one')!.receipt!
  first.claimCall({ planId: 'one', key: 'legacy-completed', argumentsDigest: d('a') })
  first.settleCall({ planId: 'one', key: 'legacy-completed', status: 'completed', result: { secret: 'private result' } })
  first.claimCall({ planId: 'one', key: 'legacy-claimed', argumentsDigest: d('b') })
  first.close()
  const raw = new DatabaseSync(f.path)
  try {
    raw.exec(`BEGIN IMMEDIATE;
      CREATE TABLE calls_v1 (plan_id TEXT NOT NULL REFERENCES adoptions(plan_id), call_key TEXT NOT NULL,
        arguments_digest TEXT NOT NULL CHECK(length(arguments_digest)=64),
        status TEXT NOT NULL CHECK(status IN ('claimed','completed','unknown')),
        result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=65536)),
        job_id TEXT, PRIMARY KEY(plan_id,call_key),
        CHECK((status='claimed' AND result_json IS NULL AND job_id IS NULL) OR status IN ('completed','unknown'))) STRICT, WITHOUT ROWID;
      INSERT INTO calls_v1 SELECT plan_id,call_key,arguments_digest,status,result_json,job_id FROM calls;
      DROP TABLE calls;
      ALTER TABLE calls_v1 RENAME TO calls;
      DROP TABLE source_archives;
      PRAGMA user_version=1;
      COMMIT;`)
  } finally { raw.close() }
  const reopened = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(reopened.authorityDigest).toBe(authorityDigest)
    expect(reopened.inspect('one')?.receipt).toEqual(receipt)
    reopened.recoverClaims()
    expect(reopened.claimCall({ planId: 'one', key: 'legacy-completed', argumentsDigest: d('a') }).call.result)
      .toEqual({ secret: 'private result' })
    expect(reopened.claimCall({ planId: 'one', key: 'legacy-claimed', argumentsDigest: d('b') }).call.status).toBe('unknown')
    expect(() => reopened.claimCall({ planId: 'one', key: 'third', argumentsDigest: d('c') })).toThrow()
    const evidence = reopened.listCallEvidence('one')
    expect(evidence).toHaveLength(2)
    expect(evidence.every(item => item.attribution === 'legacy-unattributed' && item.claimedAt === undefined
      && item.settledAt === undefined && item.foreground === undefined)).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain('private result')
  } finally { reopened.close() }
  const check = new DatabaseSync(f.path)
  try {
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
    const rows = check.prepare('SELECT tool_alias,foreground_json,claimed_at,settled_at FROM calls').all() as
      Array<{ tool_alias: null; foreground_json: null; claimed_at: null; settled_at: null }>
    expect(rows).toEqual([{ tool_alias: null, foreground_json: null, claimed_at: null, settled_at: null },
      { tool_alias: null, foreground_json: null, claimed_at: null, settled_at: null }])
  } finally { check.close() }
})

test('new call evidence binds the signed adoption and rejects a different foreground event or alias', () => {
  const f = fixture()
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('one'), artifact: f.artifact })
    journal.authorize('one', [...tools, { ...tools[0]!, originalName: 'other', name: 'generated_other' }])
    journal.activate('one')
    const argumentsDigest = d('a'), key = callKey('one', 'session-1', 'call-1', 'generated_echo')
    const foreground = witness(f.config, argumentsDigest)
    expect(journal.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_echo', foreground }).created).toBe(true)
    journal.settleCall({ planId: 'one', key, status: 'completed', result: { secret: 'private result' } })
    expect(journal.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_echo', foreground }).created).toBe(false)
    expect(() => journal.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_echo',
      foreground: { ...foreground, task: { ...foreground.task, inboxId: 'another-inbox' } } })).toThrow()
    expect(() => journal.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_other' })).toThrow()
    expect(() => journal.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_echo',
      foreground: { ...foreground, call: { ...foreground.call, eventDigest: d('0') } } })).toThrow()
    expect(() => journal.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_echo' })).toThrow()
    const evidence = journal.listCallEvidence('one')[0]!
    expect(evidence).toMatchObject({ planId: 'one', key, status: 'completed', attribution: 'foreground',
      toolAlias: 'generated_echo', originalName: 'echo', foreground })
    expect(evidence.receiptDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(evidence.artifactSha256).toBe(journal.inspect('one')!.receipt!.artifactSha256)
    expect(evidence.schemaDigest).toBe(journal.inspect('one')!.receipt!.schemaDigest)
    expect(evidence.claimedAt).toBeGreaterThan(0)
    expect(evidence.settledAt).toBeGreaterThanOrEqual(evidence.claimedAt!)
    expect(JSON.stringify(evidence)).not.toContain('private result')
  } finally { journal.close() }
})

test('unattributed calls stay unattributed and a crashed foreground claim remains unknown after restart', () => {
  const f = fixture(1, 2)
  const first = new CreationCapabilityJournal({ path: f.path, config: f.config })
  first.claim({ certificate: f.certificate('one'), artifact: f.artifact })
  first.authorize('one', tools); first.activate('one')
  const argumentsDigest = d('a'), key = callKey('one', 'session-1', 'call-1', 'generated_echo')
  first.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_echo' })
  expect(first.listCallEvidence('one')[0]).toMatchObject({ attribution: 'unattributed', toolAlias: 'generated_echo' })
  expect(() => first.claimCall({ planId: 'one', key, argumentsDigest, toolAlias: 'generated_echo',
    foreground: witness(f.config, argumentsDigest) })).toThrow()
  const unknownKey = callKey('one', 'session-1', 'call-2', 'generated_echo')
  const unknownProof = witness(f.config, argumentsDigest, 'call-2')
  first.claimCall({ planId: 'one', key: unknownKey, argumentsDigest, toolAlias: 'generated_echo',
    foreground: unknownProof })
  first.close()
  const reopened = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    reopened.recoverClaims()
    expect(() => reopened.claimCall({ planId: 'one', key: unknownKey, argumentsDigest,
      toolAlias: 'generated_echo' })).toThrow()
    expect(reopened.claimCall({ planId: 'one', key: unknownKey, argumentsDigest,
      toolAlias: 'generated_echo', foreground: unknownProof }).call.status).toBe('unknown')
    expect(() => reopened.claimCall({ planId: 'one', key: 'third', argumentsDigest: d('b') })).toThrow()
    reopened.settle('one', 'closed', 'owner-withdrawn')
    const evidence = reopened.listCallEvidence('one')
    expect(evidence.map(item => item.attribution).sort()).toEqual(['foreground', 'unattributed'])
    expect(evidence.every(item => item.status === 'unknown' && item.settledAt !== undefined)).toBe(true)
    expect(reopened.inspect('one')?.status).toBe('closed')
  } finally { reopened.close() }
})
