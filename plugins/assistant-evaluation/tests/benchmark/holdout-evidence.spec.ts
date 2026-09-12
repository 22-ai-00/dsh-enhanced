import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoldoutEvidenceStore, type HoldoutEvidenceVerifier, type HoldoutHostEvidence } from '../../src/benchmark/holdout-evidence.ts'
import {
  HOLDOUT_PROTOCOL_V1, holdoutAuthorityKeyId, holdoutEnvelopeDigest, holdoutUnsignedCanonicalJson, holdoutVerdictsDigest,
  parseSignedHoldoutFinish, parseSignedHoldoutManifest, parseSignedHoldoutVerdict,
} from '../../src/benchmark/holdout-protocol.ts'
import { benchmarkPlanDigest, benchmarkSchedule } from '../../src/benchmark/schema.ts'
import type { BenchmarkCell, BenchmarkPlan, BenchmarkResult } from '../../src/benchmark/types.ts'

const roots: string[] = [], keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const hex = (value: string): string => createHash('sha256').update(value).digest('hex')
const signed = <T extends object>(value: T): T & { signature: string } => ({ ...value, signature: sign(null, Buffer.from(holdoutUnsignedCanonicalJson(value)), keys.privateKey).toString('base64url') })
const cases = [{ id: 'private-case', domain: 'research' as const, inputDigest: hex('private prompt bytes'), acceptanceDigest: hex('private oracle bytes') }]
const dataset = { id: 'independent-holdout', version: 'v1', split: 'holdout' as const, digest: acceptanceDigest({ id: 'independent-holdout', version: 'v1', split: 'holdout', cases }) }
const manifest = signed({ protocol: HOLDOUT_PROTOCOL_V1, kind: 'manifest' as const, manifestId: 'manifest', authorityKeyId: holdoutAuthorityKeyId(publicKey), dataset, cases, issuedAt: 10 })
const versions = { model: hex('model'), prompt: hex('prompt'), skills: hex('skills'), tools: hex('tools'), policy: hex('policy'), runtime: hex('runtime') }
const plan = (): BenchmarkPlan => ({ schemaVersion: 1, id: 'holdout-plan', dataset, comparison: 'capability', cases,
  variants: [{ id: 'baseline', role: 'baseline', versions, features: { memory: false, planning: false, review: false, growth: false } },
    { id: 'candidate', role: 'candidate', versions, features: { memory: true, planning: false, review: false, growth: false } }],
  budget: { durationMs: 10_000, inputTokens: 100, outputTokens: 100, costUsdMicros: 1_000, toolCalls: 4 }, repeats: 2, seed: 7 })
const outputDigest = (cell: BenchmarkCell): string => hex('model-output-' + cell.id)
function verdict(cell: BenchmarkCell, output = outputDigest(cell)) {
  return signed({ protocol: HOLDOUT_PROTOCOL_V1, kind: 'verdict' as const, authorityKeyId: holdoutAuthorityKeyId(publicKey), manifestDigest: holdoutEnvelopeDigest(manifest), planDigest: benchmarkPlanDigest(plan()), cell,
    inputDigest: cases[0]!.inputDigest, acceptanceDigest: cases[0]!.acceptanceDigest, outputDigest: output, verdict: 'achieved' as const, evaluatedAt: 20 })
}
function host(cell: BenchmarkCell, output = outputDigest(cell)): HoldoutHostEvidence { return { versions, hostMetrics: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, toolCalls: 1, rework: 0, interventions: 0, latencyMs: null }, quiescent: true, executionEvidenceDigest: hex('execution-' + cell.id), outputDigest: output } }
function verifier(counter?: { manifest: number; verdict: number; finish: number }): HoldoutEvidenceVerifier { return {
  verifyManifest: value => { if (counter) counter.manifest++; return parseSignedHoldoutManifest(value, publicKey) },
  verifyVerdict: input => { if (counter) counter.verdict++; return parseSignedHoldoutVerdict(input.envelope, input.manifest, input.planDigest, input.cell, input.outputDigest, publicKey) },
  verifyFinish: input => { if (counter) counter.finish++; return parseSignedHoldoutFinish(input.envelope, input.manifest, input.planDigest, input.cells, input.verdictEnvelopeDigests, publicKey) },
} }
function stateRoot(): string { const parent = mkdtempSync(join(tmpdir(), 'holdout-evidence-')); roots.push(parent); return join(parent, 'state') }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe.runIf(process.platform === 'linux')('HoldoutEvidenceStore', () => {
  it('publishes canonical 0600 manifest/verdict objects without private input or raw output and re-verifies from digests', () => {
    const root = stateRoot(), count = { manifest: 0, verdict: 0, finish: 0 }, cell = benchmarkSchedule(plan())[0]!, envelope = verdict(cell), store = new HoldoutEvidenceStore({ root, verifier: verifier(count) })
    const saved = store.writeVerdict({ plan: plan(), manifest, cell, outputDigest: outputDigest(cell), host: host(cell), envelope })
    expect(saved.receiptDigest).toBe(holdoutEnvelopeDigest(envelope)); expect(saved.path).toBe(join(root, saved.digest + '.json')); expect(statSync(saved.path).mode & 0o7777).toBe(0o600)
    const bytes = readFileSync(saved.path, 'utf8'); expect(hex(bytes)).toBe(saved.digest); expect(bytes.endsWith('\n')).toBe(true); expect(bytes).not.toContain('private prompt bytes'); expect(bytes).not.toContain('model-output-')
    store.close(); const reopened = new HoldoutEvidenceStore({ root, verifier: verifier(count), create: false })
    expect(reopened.readVerdict(plan(), cell, saved.digest)).toMatchObject({ kind: 'verdict', inputDigest: cases[0]!.inputDigest, acceptanceDigest: cases[0]!.acceptanceDigest, host: { quiescent: true } })
    expect(count.manifest).toBeGreaterThanOrEqual(3); expect(count.verdict).toBe(2); reopened.close()
  })

  it('is idempotent and rejects plan, cell, output, metrics and signature drift', () => {
    const store = new HoldoutEvidenceStore({ root: stateRoot(), verifier: verifier() }), cells = benchmarkSchedule(plan()), cell = cells[0]!, envelope = verdict(cell), input = { plan: plan(), manifest, cell, outputDigest: outputDigest(cell), host: host(cell), envelope }
    const first = store.writeVerdict(input); expect(store.writeVerdict(structuredClone(input))).toEqual(first)
    expect(() => store.readVerdict(plan(), cells[1]!, first.digest)).toThrow()
    expect(() => store.writeVerdict({ ...input, outputDigest: hex('other'), host: host(cell, hex('other')) })).toThrow()
    expect(() => store.writeVerdict({ ...input, host: { ...host(cell), hostMetrics: { ...host(cell).hostMetrics, inputTokens: 101 } } })).toThrow()
    expect(() => store.writeVerdict({ ...input, envelope: { ...envelope, signature: 'a'.repeat(86) } })).toThrow(); store.close()
  })

  it('creates an immutable plan marker and recursively verifies manifest, ordered verdicts and finish after reopen', () => {
    const root = stateRoot(), currentPlan = plan(), cells = benchmarkSchedule(currentPlan), store = new HoldoutEvidenceStore({ root, verifier: verifier() })
    const verdictEvidence = cells.map(cell => store.writeVerdict({ plan: currentPlan, manifest, cell, outputDigest: outputDigest(cell), host: host(cell), envelope: verdict(cell) }))
    const verdictEnvelopeDigests = cells.map(cell => holdoutEnvelopeDigest(verdict(cell)))
    const finish = signed({ protocol: HOLDOUT_PROTOCOL_V1, kind: 'finish' as const, authorityKeyId: holdoutAuthorityKeyId(publicKey), manifestDigest: holdoutEnvelopeDigest(manifest), planDigest: benchmarkPlanDigest(currentPlan), cellCount: cells.length, verdictsDigest: holdoutVerdictsDigest(cells, verdictEnvelopeDigests), complete: true, finalizedAt: 30 })
    const saved = store.writeFinish({ plan: currentPlan, manifest, verdictEvidenceDigests: verdictEvidence.map(item => item.digest), envelope: finish })
    store.close(); const reopened = new HoldoutEvidenceStore({ root, verifier: verifier(), create: false }), completion = reopened.readPlanCompletion(currentPlan)
    expect(completion).toMatchObject({ finishEvidenceDigest: saved.digest, verdictEvidenceDigests: verdictEvidence.map(item => item.digest) })
    expect(reopened.readFinish(currentPlan, saved.digest).envelope.complete).toBe(true)
    const results: BenchmarkResult[] = cells.map((cell, index) => ({ cell, status: 'completed', verdict: 'achieved', metrics: { ...host(cell).hostMetrics, latencyMs: 50 }, evidenceDigest: verdictEvidence[index]!.digest, reason: 'verified', startedAt: 1, completedAt: 2 }))
    expect(reopened.verifyRun(currentPlan, results).verdicts).toHaveLength(cells.length)
    expect(() => reopened.verifyRun(currentPlan, results.slice(1))).toThrow()
    expect(() => reopened.verifyRun(currentPlan, results.map((item, index) => index === 0 ? { ...item, evidenceDigest: verdictEvidence[1]!.digest } : item))).toThrow()
    expect(() => reopened.writeFinish({ plan: currentPlan, manifest, verdictEvidenceDigests: verdictEvidence.map(item => item.digest).reverse(), envelope: finish })).toThrow(); reopened.close()
  })

  it('rejects verifier callbacks that try to persist extra private material', () => {
    const cell = benchmarkSchedule(plan())[0]!, delegate = verifier(), root = stateRoot()
    const malicious: HoldoutEvidenceVerifier = { ...delegate, verifyVerdict(input) { return { ...delegate.verifyVerdict(input), rawOutput: 'private model output' } as never } }
    const store = new HoldoutEvidenceStore({ root, verifier: malicious })
    expect(() => store.writeVerdict({ plan: plan(), manifest, cell, outputDigest: outputDigest(cell), host: host(cell), envelope: verdict(cell) })).toThrow(/invalid-evidence/)
    expect(readdirSync(root)).toEqual([])
    store.close()
  })

  it('rejects symlink, hardlink, permission and content tampering on digest-only read', () => {
    const cell = benchmarkSchedule(plan())[0]!
    for (const kind of ['symlink', 'hardlink', 'mode', 'content'] as const) {
      const root = stateRoot(), store = new HoldoutEvidenceStore({ root, verifier: verifier() }), saved = store.writeVerdict({ plan: plan(), manifest, cell, outputDigest: outputDigest(cell), host: host(cell), envelope: verdict(cell) })
      if (kind === 'symlink') { unlinkSync(saved.path); symlinkSync('/etc/passwd', saved.path) }
      if (kind === 'hardlink') linkSync(saved.path, join(dirname(saved.path), 'alias.json'))
      if (kind === 'mode') chmodSync(saved.path, 0o644)
      if (kind === 'content') writeFileSync(saved.path, readFileSync(saved.path, 'utf8') + 'x')
      expect(() => store.readVerdict(plan(), cell, saved.digest)).toThrow(); store.close()
    }
  })

  it('rejects unsafe ancestors and detects replacement of its pinned root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'holdout-evidence-unsafe-')); roots.push(parent); chmodSync(parent, 0o777); const child = join(parent, 'state')
    expect(() => new HoldoutEvidenceStore({ root: child, verifier: verifier() })).toThrow(/unsafe-root/); chmodSync(parent, 0o700)
    const root = join(parent, 'trusted'); mkdirSync(root, { mode: 0o700 }); const store = new HoldoutEvidenceStore({ root, verifier: verifier(), create: false }), parked = join(parent, 'parked'), replacement = join(parent, 'replacement')
    mkdirSync(replacement, { mode: 0o700 }); renameSync(root, parked); renameSync(replacement, root)
    const cell = benchmarkSchedule(plan())[0]!
    expect(() => store.writeVerdict({ plan: plan(), manifest, cell, outputDigest: outputDigest(cell), host: host(cell), envelope: verdict(cell) })).toThrow(/unsafe-root/)
    store.close(); renameSync(root, replacement); renameSync(parked, root)
  })
})
