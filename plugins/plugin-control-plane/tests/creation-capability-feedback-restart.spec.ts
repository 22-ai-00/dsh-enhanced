import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { CreationCapabilityJournal } from '../src/creation-capability-journal.js'
import { inspectCreationCapabilityTaskAssociations, type CreationCapabilityFeedbackInput } from '../src/creation-capability-feedback.js'
import type { CreationCapabilityConfig } from '../src/creation-capability-types.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const d = (c: string) => c.repeat(64)
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

test('signed adoption and attributed call survive journal restart while current feedback and use window are reread', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'created-feedback-restart-'))
  roots.push(root); chmodSync(root, 0o700)
  const signing = generateKeyPairSync('ed25519'), verifier = generateKeyPairSync('ed25519')
  const keyPath = join(root, 'adoption.key'), path = join(root, 'creation-adoptions.sqlite')
  writeFileSync(keyPath, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const base = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(base)
  const owner = { authorityId: 'owner', authorityHash: d('a'), principalId: 'principal',
    principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'default' }
  const config: CreationCapabilityConfig = { authorityId: 'owner-adoption', keyId: 'adoption-key', keyPath,
    owner, namePrefix: 'generated-', expiresAt: base + 10_000, maxAdoptions: 1, maxTools: 1,
    maxCallsPerAdoption: 1, maxCallRecords: 1, maxInputBytes: 1024,
    retention: { maximumLifetimeMs: 5_000 },
    runner: { stateRoot: root, image: `runner@sha256:${d('b')}`, dockerPath: '/usr/bin/docker',
      expiresAt: base + 10_000, maxRuns: 1, maxTotalDurationMs: 10_000,
      maxDurationMs: 10_000, maxOutputBytes: 65_536 } }
  const artifact = Buffer.from('candidate fixture package')
  const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'verification-one',
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'independent-verifier',
      keyId: 'verifier-key', authorityDigest: d('c'), namePrefix: 'generated-', expiresAt: base + 10_000 },
    plan: { id: 'plan', digest: d('d'), name: 'generated-tool', sourceTreeDigest: d('e'),
      sourcePatchDigest: d('f'), artifactSha256: sha(artifact), artifactBytes: artifact.length, generatorDigest: d('1') },
    source: { referenceDigest: d('2'), ownerDigest: d('3'), growthRunDigest: d('4') },
    contractDigest: d('5'), schemaDigest: d('6'),
    environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
    model: { provider: 'fixture', model: 'test' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: [{ caseId: 'first', jobId: 'job-first', operationDigest: d('7'), observationDigest: d('8') },
      { caseId: 'second', jobId: 'job-second', operationDigest: d('9'), observationDigest: d('0') }],
    reviewDigest: d('a'), verifiedAt: base - 1_000, expiresAt: base + 2_000,
  }
  const certificate = { ...unsigned,
    signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), verifier.privateKey).toString('base64url') }
  let journal = new CreationCapabilityJournal({ path, config })
  const tools = [{ originalName: 'read', name: 'generated_read', description: 'Read', parameters: { type: 'object' } }]
  journal.claim({ certificate, artifact })
  const receipt = journal.authorize('plan', tools).receipt!
  journal.activate('plan')
  expect(receipt.expiresAt).toBe(base + 5_000)
  const callId = 'call-1', sessionId = 'session-1', inboxId = 'later-inbox'
  const key = sha(JSON.stringify({ planId: 'plan', sessionId, callId, toolName: 'generated_read' }))
  const argumentsDigest = sha(JSON.stringify({ query: 'private input' }))
  const witness = { protocol: 'assistant-delivery/foreground-tool-call/v1' as const,
    task: { protocol: 'assistant-delivery/foreground-task/v1' as const, inboxId, sessionId,
      scope: { workspace: root, preset: owner.agentPreset },
      owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
      binding: { id: 'binding-1', version: 1, generation: 1 }, dispatchedAt: base + 10 },
    turn: 1, call: { id: callId, toolName: 'generated_read', eventSeq: 1,
      eventDigest: d('b'), argumentsDigest } }
  clock.mockReturnValue(base + 100)
  expect(journal.claimCall({ planId: 'plan', key, argumentsDigest,
    toolAlias: 'generated_read', foreground: witness }).created).toBe(true)
  clock.mockReturnValue(base + 150)
  journal.settleCall({ planId: 'plan', key, status: 'completed', result: { secret: 'private result' } })
  const before = journal.listCallEvidence('plan')
  journal.close()

  clock.mockReturnValue(base + 200)
  journal = new CreationCapabilityJournal({ path, config })
  expect(journal.inspect('plan')?.receipt).toEqual(receipt)
  expect(journal.listCallEvidence('plan')).toEqual(before)
  expect(() => journal.claimCall({ planId: 'plan', key: d('c'), argumentsDigest })).toThrow()

  let version = 1, disposition: 'upsert' | 'retract' = 'upsert', originalDisposition: 'upsert' | 'retract' = 'upsert'
  let currentOwner = owner.principalVersion
  const canonical = () => ({ triggerOutcomeId: `outcome-${version}`, scopeWatermark: version,
    projection: { subjectKind: 'foreground-turn' as const, subjectRef: inboxId, version,
      digest: d(String(version)), disposition }, objective: { status: 'achieved' as const } })
  const learning = () => ({ protocol: 'assistant-delivery/owner-foreground-learning/v1' as const,
    owner: { ...owner, principalVersion: currentOwner, bindingVersion: 1, generation: 1 },
    canonical: canonical(), judgement: 'owner-feedback' as const,
    source: { inboxId, sessionId, objective: 'private task text', quiescent: true, truncated: false } })
  const evaluation = { canonicalHostScope: () => ({ workspace: root, preset: owner.agentPreset }),
    getTrustedForegroundLearningProjection: () => canonical(),
    withTrustedCanonicalTaskWriterFence: (_input: unknown, callback: () => unknown) => ({ matched: true as const, value: callback() }) }
  const delivery = { inspectOwnerForegroundLearningTask: () => learning(),
    inspectOwnerForegroundTaskSource: () => ({ authorityId: owner.authorityId, authorityHash: owner.authorityHash,
      principalId: owner.principalId, owner: { principalRecordId: owner.principalRecordId,
        principalVersion: currentOwner }, binding: { ...witness.task.binding, sessionId } }) }
  const input = (): CreationCapabilityFeedbackInput => ({ record: journal.inspect('plan')!,
    calls: journal.listCallEvidence('plan'), triggerInboxId: 'original-inbox', owner,
    evaluation: evaluation as unknown as CreationCapabilityFeedbackInput['evaluation'],
    delivery: delivery as unknown as CreationCapabilityFeedbackInput['delivery'],
    readSourceCurrent: () => ({ scopeWatermark: version, projection: { subjectKind: 'foreground-turn',
      subjectRef: 'original-inbox', version: 1, digest: d('d'), disposition: originalDisposition } }),
    now: Date.now() })
  expect(inspectCreationCapabilityTaskAssociations(input())).toMatchObject([{ inboxId, callKeys: [key],
    adoptionStatus: 'active', withinSignedUseWindow: true, task: { projection: { version: 1 } } }])
  version = 2
  expect(inspectCreationCapabilityTaskAssociations(input())[0]?.task.projection.version).toBe(2)
  disposition = 'retract'
  expect(inspectCreationCapabilityTaskAssociations(input())).toEqual([])
  disposition = 'upsert'; currentOwner = 2
  expect(inspectCreationCapabilityTaskAssociations(input())).toEqual([])
  currentOwner = owner.principalVersion; originalDisposition = 'retract'
  expect(inspectCreationCapabilityTaskAssociations(input())).toEqual([])
  originalDisposition = 'upsert'
  journal.settle('plan', 'closed', 'source-withdrawn')
  journal.close()

  clock.mockReturnValue(receipt.expiresAt + 1)
  journal = new CreationCapabilityJournal({ path, config })
  try {
    expect(journal.inspect('plan')?.status).toBe('closed')
    expect(journal.inspect('plan')?.receipt).toEqual(receipt)
    expect(journal.listCallEvidence('plan')).toEqual(before)
    expect(inspectCreationCapabilityTaskAssociations(input())[0]).toMatchObject({
      adoptionStatus: 'closed', withinSignedUseWindow: false })
    expect(() => journal.activate('plan')).toThrow()
    expect(() => journal.claimCall({ planId: 'plan', key: d('c'), argumentsDigest })).toThrow()
    expect(JSON.stringify(journal.listCallEvidence('plan'))).not.toMatch(/private input|private result/)
  } finally { journal.close() }
})
