import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate,
  type PluginRevisionVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { RevisionCapabilityJournal, verifyRevisionCapabilityAdoptionReceipt } from '../src/revision-capability-journal.js'
import { RevisionCapabilityRuntime } from '../src/revision-capability-runtime.js'
import type { CreationCapabilityObservation, CreationCapabilityTool } from '../src/creation-capability-types.js'
import type { RevisionCapabilityConfig, RevisionCapabilityPorts } from '../src/revision-capability-types.js'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const d = (value: string) => value.repeat(64)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const environment = { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' }
const tools: readonly CreationCapabilityTool[] = [{ originalName: 'read_test', name: 'evolved_rsi_revision_0',
  description: 'fixture', parameters: { type: 'object', additionalProperties: false,
    properties: { query: { type: 'string' } }, required: ['query'] } }]
const schemaDigest = d('c')

function root(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), 'cp-revision-runtime-'))
  roots.push(value); chmodSync(value, 0o700)
  return value
}

function certificate(protocol: 'assistant-growth/creation-verification/v1' | 'assistant-growth/revision-verification/v1',
  planId: string, artifact: Buffer, parent?: PluginRevisionVerificationCertificate['parent'],
  base = Date.now()): PluginCreationVerificationCertificate | PluginRevisionVerificationCertificate {
  const signer = generateKeyPairSync('ed25519')
  const authority = protocol === 'assistant-growth/revision-verification/v1'
    ? { protocol: 'assistant-growth/revision-acceptance-authority/v1', authorityId: 'revision-review',
      keyId: 'revision-review-key', authorityDigest: d('e'), namePrefix: 'rsi-revision-', expiresAt: base + 300_000 }
    : { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'creation-review',
      keyId: 'creation-review-key', authorityDigest: d('b'), namePrefix: 'rsi-revision-', expiresAt: base + 300_000 }
  const unsigned = {
    protocol, verificationId: 'verification-' + planId, authority,
    plan: { id: planId, digest: sha(planId), name: 'rsi-revision-tool', sourceTreeDigest: d('d'),
      sourcePatchDigest: d('f'), artifactSha256: sha(artifact), artifactBytes: artifact.length, generatorDigest: d('1') },
    ...(parent === undefined ? {} : { parent }),
    source: { referenceDigest: d('2'), ownerDigest: d('3'), growthRunDigest: d('4') },
    contractDigest: d('5'), schemaDigest, environment,
    model: { provider: 'fixture', model: 'fixture' },
    budget: { modelCalls: 2, maxOutputTokens: 1_024, maxDurationMs: 10_000, maxCases: 2 },
    sessions: { contract: 'contract-' + planId, sourceReview: 'review-' + planId },
    observations: [{ caseId: 'case-a', jobId: 'job-a-' + planId, operationDigest: d('6'), observationDigest: d('7') },
      { caseId: 'case-b', jobId: 'job-b-' + planId, operationDigest: d('8'), observationDigest: d('9') }],
    reviewDigest: d('a'), verifiedAt: base - 1_000, expiresAt: base + 120_000,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), signer.privateKey)
    .toString('base64url') } as PluginCreationVerificationCertificate | PluginRevisionVerificationCertificate
}

function fixture(options: { maxAdoptions?: number; maxRollbacks?: number; rollbackExpiresAt?: number } = {}) {
  const dir = root(), base = Date.now()
  const pair = generateKeyPairSync('ed25519')
  const keyPath = join(dir, 'revision.key')
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const owner = { authorityId: 'owner-route', authorityHash: d('a'), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: dir, agentPreset: 'primary' }
  const config: RevisionCapabilityConfig = { authorityId: 'owner-revision', keyId: 'revision-key', keyPath, owner,
    namePrefix: 'rsi-revision-', expiresAt: base + 120_000, maxAdoptions: options.maxAdoptions ?? 2,
    maxInputBytes: 4096, maxCallRecords: 8, rollback: { authorityId: 'owner-revision-rollback',
      expiresAt: options.rollbackExpiresAt ?? base + 120_000, maxRollbacks: options.maxRollbacks ?? 2 } }
  const journal = new RevisionCapabilityJournal({ path: join(dir, 'revision-adoptions.sqlite'), config })
  const parentArtifact = Buffer.from('parent artifact'), revisionArtifact = Buffer.from('revision artifact')
  const secondArtifact = Buffer.from('second revision artifact')
  const parentCertificate = certificate('assistant-growth/creation-verification/v1', 'parent-plan',
    parentArtifact, undefined, base) as PluginCreationVerificationCertificate
  const parentReceiptJson = canonicalGrowthJson({ protocol: 'dsh-created-capability-adoption/v1',
    authorityId: 'owner-creation', authorityDigest: d('a'), keyId: 'creation-key', planId: 'parent-plan',
    planDigest: parentCertificate.plan.digest, verificationDigest: sha(canonicalGrowthJson(parentCertificate)),
    artifactSha256: sha(parentArtifact), artifactBytes: parentArtifact.length, source: parentCertificate.source,
    schemaDigest, toolsDigest: d('f'), expiresAt: base + 120_000, adoptedAt: base - 500, signature: 'A'.repeat(86) })
  const parent = { planId: 'parent-plan', name: 'rsi-revision-tool', owner, certificate: parentCertificate,
    artifact: parentArtifact, tools, receiptJson: parentReceiptJson, receiptDigest: sha(parentReceiptJson) }
  const candidate = (planId: string, artifact: Buffer) => {
    const revisionCertificate = certificate('assistant-growth/revision-verification/v1', planId, artifact,
      { planId: 'parent-plan', certificateDigest: sha(canonicalGrowthJson(parentCertificate)),
        artifactSha256: sha(parentArtifact), sourceArchiveDigest: d('1'), sourceDigest: d('2') }, base) as PluginRevisionVerificationCertificate
    return { certificate: revisionCertificate, artifact, source: {} as never,
      plan: { id: planId, digest: revisionCertificate.plan.digest, name: revisionCertificate.plan.name }, owner }
  }
  const candidates = new Map<string, ReturnType<typeof candidate>>([
    ['revision-plan-a', candidate('revision-plan-a', revisionArtifact)],
    ['revision-plan-b', candidate('revision-plan-b', secondArtifact)]])
  const suspended: string[] = [], resumed: string[] = []
  let discoveries = 0, invokes = 0
  let discoverFailure: Buffer | undefined
  let hold: { artifact: Buffer; entered: () => void; gate: Promise<void> } | undefined
  const output = (artifact: Buffer, call: { id: string; toolName: string }): CreationCapabilityObservation => {
    const answer = artifact.equals(parentArtifact) ? 'parent' : artifact.equals(revisionArtifact) ? 'revised' : 'revised-b'
    return { status: 'observed', quiescent: true, artifactSha256: sha(artifact), schemaDigest, environment,
      calls: [{ id: call.id, toolName: call.toolName,
        result: { isError: false, value: { answer }, content: [{ type: 'text', text: answer }] } }] }
  }
  const ports: RevisionCapabilityPorts = {
    inspect: planId => { const value = candidates.get(planId); if (!value) throw new Error('unknown candidate'); return value },
    recheck: async () => {},
    parent: () => parent,
    recheckParent: async () => {},
    inFlightParentCalls: () => 2,
    suspendParent: async planId => { suspended.push(planId) },
    resumeParent: async planId => { resumed.push(planId) },
    runVersion: async input => {
      if (input.operation.kind === 'discover') {
        discoveries++
        if (discoverFailure !== undefined && input.artifact.equals(discoverFailure)) throw new Error('fixture discovery failure')
        return { status: 'observed', quiescent: true, artifactSha256: sha(input.artifact), schemaDigest,
          environment, schemas: [{ name: 'read_test' }] }
      }
      invokes++
      const call = input.operation.calls[0]!
      if (hold?.artifact.equals(input.artifact)) {
        hold.entered()
        await hold.gate
      }
      return output(input.artifact, call)
    },
    recheckExecution: async () => {},
    matchesExecution: () => true,
    assertCaller: () => {},
  }
  const ctx = new Context(); contexts.push(ctx)
  const runtime = new RevisionCapabilityRuntime({ ctx, config, journal, ports, regressionRequired: false })
  const exec = (callId: string): ToolRunContext => ({ callId, agent: { session: { id: 'session-1' } },
    signal: new AbortController().signal }) as unknown as ToolRunContext
  const entryId = () => journal.listEntries()[0]!.entryId
  return { dir, config, journal, runtime, ctx, candidates, parent, revisionArtifact, parentArtifact,
    exec, entryId, suspended, resumed,
    counts: () => ({ discoveries, invokes }),
    failDiscovery: (artifact: Buffer | undefined) => { discoverFailure = artifact },
    beginHold: (artifact: Buffer) => {
      let entered!: () => void, release!: () => void
      const enteredPromise = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      hold = { artifact, entered, gate }
      return { entered: enteredPromise, release: () => { release(); hold = undefined } }
    },
  }
}

describe('revision capability adoption', () => {
  test('adopts a verified revision onto the stable entry, signs the parent-bound receipt and routes calls by version', async () => {
    const f = fixture()
    await mountAgentLoopTestDependencies(f.ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await f.runtime.start()
    expect(f.runtime.inspectReadiness()).toMatchObject({ available: true, remainingAdoptions: 2, remainingRollbacks: 2 })
    const record = await f.runtime.adopt('revision-plan-a', new AbortController().signal)
    expect(record).toMatchObject({ status: 'active', parentPlanId: 'parent-plan', inFlightParentCalls: 2 })
    const entry = f.journal.inspectEntry(f.entryId())!
    expect(entry.entry).toMatchObject({ currentPlanId: 'revision-plan-a', parentPlanId: 'parent-plan', revision: 2 })
    expect(entry.current.role).toBe('revision')
    expect(entry.entry.aliases).toEqual(['evolved_rsi_revision_0'])
    expect(f.suspended).toEqual(['parent-plan'])
    expect(f.ctx.tools.get('evolved_rsi_revision_0')).toBeDefined()
    const receipt = JSON.parse(entry.current.receiptJson) as Record<string, unknown>
    expect(verifyRevisionCapabilityAdoptionReceipt(receipt, f.journal.authorityDigest, f.journal.publicKey, Date.now())).toBe(true)
    expect(receipt).toMatchObject({ parentPlanId: 'parent-plan', parentReceiptDigest: entry.parent.receiptDigest,
      parentArtifactSha256: sha(f.parentArtifact), artifactSha256: sha(f.revisionArtifact),
      source: { referenceDigest: d('2'), ownerDigest: d('3'), growthRunDigest: d('4') }, inFlightParentCalls: 2 })
    const call = () => f.ctx.tools.get('evolved_rsi_revision_0')!.execute({ query: 'hello' }, f.exec('call-one'))
    expect(await call()).toMatchObject({ value: { answer: 'revised' } })
    expect(f.journal.listCallEvidence(f.entryId())).toMatchObject([{ versionPlanId: 'revision-plan-a',
      toolAlias: 'evolved_rsi_revision_0', status: 'completed' }])
    expect(f.counts()).toEqual({ discoveries: 1, invokes: 1 })
    await f.runtime.close()
    expect(f.ctx.tools.get('evolved_rsi_revision_0')).toBeUndefined()
  })

  test('never switches an in-flight call mid-flight: it keeps its claim-time version across an exact rollback', async () => {
    const f = fixture()
    await mountAgentLoopTestDependencies(f.ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await f.runtime.start()
    await f.runtime.adopt('revision-plan-a', new AbortController().signal)
    const hold = f.beginHold(f.revisionArtifact)
    const alias = 'evolved_rsi_revision_0'
    const inFlight = f.ctx.tools.get(alias)!.execute({ query: 'slow' }, f.exec('in-flight'))
    await hold.entered
    const rollback = await f.runtime.rollback({ entryId: f.entryId(), expectedCurrentPlanId: 'revision-plan-a' })
    expect(rollback).toMatchObject({ fromPlanId: 'revision-plan-a', toPlanId: 'parent-plan', ordinal: 1 })
    expect(f.journal.inspectEntry(f.entryId())!.entry.currentPlanId).toBe('parent-plan')
    hold.release()
    expect(await inFlight).toMatchObject({ value: { answer: 'revised' } })
    const evidence = f.journal.listCallEvidence(f.entryId())
    expect(evidence[0]).toMatchObject({ versionPlanId: 'revision-plan-a', status: 'completed' })
    expect(await f.ctx.tools.get(alias)!.execute({ query: 'next' }, f.exec('after-rollback')))
      .toMatchObject({ value: { answer: 'parent' } })
    expect(f.journal.listCallEvidence(f.entryId())[1]).toMatchObject({ versionPlanId: 'parent-plan' })
    await f.runtime.close()
  })

  test('refuses to replace an entry that already moved (parent CAS) and keeps the active revision serving', async () => {
    const f = fixture()
    await mountAgentLoopTestDependencies(f.ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await f.runtime.start()
    await f.runtime.adopt('revision-plan-a', new AbortController().signal)
    await expect(f.runtime.adopt('revision-plan-b', new AbortController().signal)).rejects.toThrow('candidate-ineligible')
    expect(f.journal.inspectAdoption('revision-plan-b')).toBeUndefined()
    expect(f.journal.inspectEntry(f.entryId())!.entry.currentPlanId).toBe('revision-plan-a')
    expect(await f.ctx.tools.get('evolved_rsi_revision_0')!.execute({ query: 'still' }, f.exec('still')))
      .toMatchObject({ value: { answer: 'revised' } })
    await f.runtime.close()
  })

  test('an unknown adoption consumes its claim, restores the parent entry and is never replayed', async () => {
    const f = fixture()
    await mountAgentLoopTestDependencies(f.ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await f.runtime.start()
    f.failDiscovery(f.revisionArtifact)
    await expect(f.runtime.adopt('revision-plan-a', new AbortController().signal)).rejects.toThrow('fixture discovery failure')
    expect(f.journal.inspectAdoption('revision-plan-a')).toMatchObject({ status: 'unknown', reason: 'adoption-unsettled' })
    // The failure happened before the alias handover, so the parent entry was never suspended.
    expect(f.suspended).toEqual([])
    expect(f.resumed).toEqual([])
    expect(f.ctx.tools.get('evolved_rsi_revision_0')).toBeUndefined()
    expect(f.journal.usage().adoptions).toBe(1)
    await expect(f.runtime.adopt('revision-plan-a', new AbortController().signal)).rejects.toThrow('candidate-ineligible')
    expect(f.counts().discoveries).toBe(1)
    expect(f.journal.usage().adoptions).toBe(1)
    expect(f.journal.listEntries()).toEqual([])
    await f.runtime.close()
  })

  test('a failed stable-alias registration keeps the parent version and records an unknown, non-replayable adoption', async () => {
    const f = fixture()
    await mountAgentLoopTestDependencies(f.ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    const occupied = { name: 'evolved_rsi_revision_0', description: 'pre-existing host tool', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      execute: async () => ({}) }
    f.ctx.tools.register(occupied as never)
    await f.runtime.start()
    await expect(f.runtime.adopt('revision-plan-a', new AbortController().signal)).rejects.toThrow('conflicts')
    expect(f.journal.inspectAdoption('revision-plan-a')).toMatchObject({ status: 'unknown' })
    expect(f.suspended).toEqual(['parent-plan'])
    expect(f.resumed).toEqual(['parent-plan'])
    expect(f.ctx.tools.get('evolved_rsi_revision_0')).toBe(occupied)
    expect(f.journal.listEntries()).toEqual([])
    await expect(f.runtime.adopt('revision-plan-a', new AbortController().signal)).rejects.toThrow('candidate-ineligible')
    expect(f.journal.usage().adoptions).toBe(1)
    await f.runtime.close()
  })

  test('enforces the rollback grant, exact version chain and finite count', async () => {
    const f = fixture({ maxRollbacks: 1 })
    await mountAgentLoopTestDependencies(f.ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await f.runtime.start()
    await f.runtime.adopt('revision-plan-a', new AbortController().signal)
    await expect(f.runtime.rollback({ entryId: f.entryId(), expectedCurrentPlanId: 'parent-plan' }))
      .rejects.toThrow('version changed')
    await expect(f.runtime.rollback({ entryId: f.entryId(), expectedCurrentPlanId: 'revision-plan-b' }))
      .rejects.toThrow('version changed')
    await f.runtime.rollback({ entryId: f.entryId(), expectedCurrentPlanId: 'revision-plan-a' })
    await expect(f.runtime.rollback({ entryId: f.entryId(), expectedCurrentPlanId: 'revision-plan-a' }))
      .rejects.toThrow('version changed')
    expect(f.journal.usage().rollbacks).toBe(1)
    f.config.rollback.expiresAt = Date.now() - 1
    await expect(f.runtime.rollback({ entryId: f.entryId(), expectedCurrentPlanId: 'parent-plan' }))
      .rejects.toThrow('rollback authority expired')
    await f.runtime.close()
  })

  test('consumes the adoption quota before any external action and stops admitting after exhaustion', async () => {
    const first = fixture({ maxAdoptions: 1 })
    await mountAgentLoopTestDependencies(first.ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    await first.runtime.start()
    await first.runtime.adopt('revision-plan-a', new AbortController().signal)
    await first.runtime.rollback({ entryId: first.entryId(), expectedCurrentPlanId: 'revision-plan-a' })
    await expect(first.runtime.adopt('revision-plan-b', new AbortController().signal)).rejects.toThrow('candidate-ineligible')
    expect(first.journal.usage().adoptions).toBe(1)
    expect(first.runtime.inspectReadiness()).toMatchObject({ available: false, remainingAdoptions: 0 })
    await first.runtime.close()
  })
})
