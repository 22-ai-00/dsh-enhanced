import { createHash } from 'node:crypto'
import { parse, stringify } from 'yaml'
import { describe, expect, test } from 'vitest'
import { verifyLocalSourceCandidatePolicy } from '../scripts/install/local-source-candidate-policy.mjs'

const lockfilePath = '/private/candidate/pnpm-lock.yaml'
const effectivePolicy = { ignoreScripts: true, ignorePnpmfile: true, trustLockfile: false, registry: 'https://registry.npmjs.org/',
  minimumReleaseAge: 20, minimumReleaseAgeExclude: ['z', 'a', 'z'], trustPolicy: 'no-downgrade', trustPolicyExclude: [], trustPolicyIgnoreAfter: 60,
  resolutionMode: 'lowest-direct', ignoreMissingTimeField: false, strictPeerDependencies: true }
const markerPolicy = { tarballUrlBinding: true, minimumReleaseAge: 20, minimumReleaseAgeExclude: ['a', 'z'], trustPolicy: 'no-downgrade',
  trustPolicyExclude: [], trustPolicyIgnoreAfter: 60, resolutionShapeCheck: true, dependencyAliasCheck: true }
const rawGraph = { lockfileVersion: '9.0', importers: { '.': { dependencies: { demo: { specifier: '1.0.0', version: '1.0.0' } } } },
  packages: { 'demo@1.0.0': { resolution: { integrity: 'sha512-demo' } } }, snapshots: { 'demo@1.0.0': {} } }
const event = (status: string, extra = {}) => ({ name: 'pnpm:lockfile-verification', level: 'debug', status, entries: 1, lockfilePath, ...extra })
const output = (...events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n'
function fixture() {
  const lockfileSource = stringify(rawGraph), stat = { size: Buffer.byteLength(lockfileSource), inode: '1234', mtimeNs: '987654321' }
  return { output: output(event('started'), event('done', { elapsedMs: 17 })), lockfileSource, lockfilePath,
    lockStats: [stat], effectivePolicy: structuredClone(effectivePolicy), parseYaml: parse, exitCode: 0, outputTruncated: false, pnpmVersion: '11.7.0', verifierConfigured: true,
    markerSource: output({ lockfile: { path: lockfilePath, hash: Buffer.alloc(32, 7).toString('base64'), ...stat }, policy: markerPolicy }) }
}
function replaceMarker(input: ReturnType<typeof fixture>, mutate: (record: ReturnType<typeof JSON.parse>) => void) {
  const record = JSON.parse(input.markerSource); mutate(record); input.markerSource = output(record)
}
function emptyFixture() {
  const input = fixture(); input.lockfileSource = stringify({ lockfileVersion: '9.0', importers: { '.': {} } })
  input.lockStats = [{ ...input.lockStats[0]!, size: Buffer.byteLength(input.lockfileSource) }]; input.output = ''
  return { ...input, markerSource: undefined }
}

describe('fixed pnpm 11.7 candidate policy receipt judgment', () => {
  test('binds actual event fields, final stat, opaque semantic identity, raw bytes and the full detached policy', () => {
    const input = fixture(), proof = verifyLocalSourceCandidatePolicy(input)
    expect(proof.applicability).toBe('fresh-candidates')
    expect(proof.verification).toEqual({ candidateEntries: 1, eventCount: 2, elapsedMs: 17, scope: 'pnpm-verifier-fanout' })
    expect(proof.lockfile.rawSha256).toBe(createHash('sha256').update(input.lockfileSource).digest('hex'))
    expect(proof.lockfile.observedSemanticHash).toBe(Buffer.alloc(32, 7).toString('base64'))
    expect(proof.lockfile.rawSha256).not.toBe(proof.lockfile.observedSemanticHash)
    expect(proof.effectivePolicy).toEqual(effectivePolicy)
    expect(proof.markerPolicy).toEqual(markerPolicy)
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.effectivePolicy.minimumReleaseAgeExclude)).toBe(true)
    input.effectivePolicy.minimumReleaseAgeExclude.push('mutated'); expect(proof.effectivePolicy.minimumReleaseAgeExclude).not.toContain('mutated')
  })

  test.each(['exitCode', 'outputTruncated', 'pnpmVersion', 'verifierConfigured', 'parseYaml'])('requires explicit wrapper evidence field %s', key => {
    const input = Object.fromEntries(Object.entries(fixture()).filter(([field]) => field !== key))
    expect(() => verifyLocalSourceCandidatePolicy(input)).toThrow('local source candidate policy:')
  })

  test.each(['registry', 'strictPeerDependencies', 'ignoreMissingTimeField'] as const)('binds marker-omitted effective policy field %s independently', key => {
    const input = fixture(), before = verifyLocalSourceCandidatePolicy(input)
    const changed = { ...input, effectivePolicy: { ...input.effectivePolicy, [key]: key === 'registry' ? 'https://another.invalid/' : !input.effectivePolicy[key] } }
    const after = verifyLocalSourceCandidatePolicy(changed)
    expect(after.lockfile.observedSemanticHash).toBe(before.lockfile.observedSemanticHash)
    expect(after.effectivePolicySha256).not.toBe(before.effectivePolicySha256)
  })

  test.each([
    ['nonzero exit', (i: ReturnType<typeof fixture>) => { i.exitCode = 1 }],
    ['truncated output', i => { i.outputTruncated = true }],
    ['wrong pnpm', i => { i.pnpmVersion = '11.8.0' }],
    ['no verifier', i => { i.verifierConfigured = false }],
    ['unsafe policy', i => { i.effectivePolicy.trustLockfile = true }],
    ['missing event', i => { i.output = '' }],
    ['cached', i => { i.output = output(event('cached')) }],
    ['failed', i => { i.output = output(event('started'), event('failed', { elapsedMs: 1 })) }],
    ['unfinished', i => { i.output = output(event('started')) }],
    ['out of order', i => { i.output = output(event('done', { elapsedMs: 1 }), event('started')) }],
    ['duplicate pair', i => { i.output += i.output }],
    ['unknown status', i => { i.output = output(event('started'), event('skipped', { elapsedMs: 1 })) }],
    ['different path', i => { i.output = output(event('started'), event('done', { elapsedMs: 1, lockfilePath: '/old/pnpm-lock.yaml' })) }],
    ['zero count', i => { i.output = output(event('started', { entries: 0 }), event('done', { entries: 0, elapsedMs: 1 })) }],
    ['unequal counts', i => { i.output = output(event('started'), event('done', { entries: 2, elapsedMs: 1 })) }],
    ['unbounded count', i => { i.output = output(event('started', { entries: 1000001 }), event('done', { entries: 1000001, elapsedMs: 1 })) }],
    ['negative elapsed', i => { i.output = output(event('started'), event('done', { elapsedMs: -1 })) }],
    ['unbounded elapsed', i => { i.output = output(event('started'), event('done', { elapsedMs: 86400001 })) }],
    ['missing elapsed', i => { i.output = output(event('started'), event('done')) }],
    ['invalid NDJSON', i => { i.output += 'passes policies\n' }],
    ['error event', i => { i.output += output({ name: 'pnpm:other', level: 'error' }) }],
    ['wrong channel', i => { i.output = i.output.replaceAll('pnpm:lockfile-verification', 'pnpm:progress') }],
    ['output byte bound', i => { i.output = ' '.repeat(8 * 1024 * 1024 + 1) }],
    ['event count bound', i => { i.output = '{}\n'.repeat(50001) }],
    ['invalid YAML', i => { i.lockfileSource = '[invalid'; i.lockStats[0]!.size = Buffer.byteLength(i.lockfileSource) }],
    ['noncanonical path', i => { i.lockfilePath = '/private/../candidate/pnpm-lock.yaml' }],
  ] satisfies Array<[string, (input: ReturnType<typeof fixture>) => void]>)('rejects %s', (_name, mutate) => {
    const input = fixture(); mutate(input); expect(() => verifyLocalSourceCandidatePolicy(input)).toThrow('local source candidate policy:')
  })

  test.each(['path', 'size', 'inode', 'mtimeNs', 'hash', 'policy'])('rejects stale or malformed marker %s', key => {
    const input = fixture()
    replaceMarker(input, record => { if (key === 'policy') record.policy.tarballUrlBinding = false
      else record.lockfile[key] = key === 'size' ? record.lockfile.size + 1 : key === 'hash' ? 'a'.repeat(64) : 'old' })
    expect(() => verifyLocalSourceCandidatePolicy(input)).toThrow('local source candidate policy:')
  })

  test('cannot reuse an earlier stat after atomic final lock replacement', () => {
    const input = fixture(); input.lockStats.push({ ...input.lockStats[0]!, inode: '5678' })
    expect(() => verifyLocalSourceCandidatePolicy(input)).toThrow('final lockfile stat')
  })
  test('rejects a marker of another current policy even if its old age was stronger', () => {
    const input = fixture(); replaceMarker(input, record => { record.policy.minimumReleaseAge = 21 })
    expect(() => verifyLocalSourceCandidatePolicy(input)).toThrow('current policy mismatch')
  })
  test('requires an actual fresh marker and rejects conflicting semantic hashes', () => {
    expect(() => verifyLocalSourceCandidatePolicy({ ...fixture(), markerSource: undefined })).toThrow('missing its marker')
    const input = fixture(), other = JSON.parse(input.markerSource); other.lockfile.hash = Buffer.alloc(32, 8).toString('base64'); input.markerSource += output(other)
    expect(() => verifyLocalSourceCandidatePolicy(input)).toThrow('conflicting semantic identities')
  })
  test('binds different raw bytes even when pnpm observed semantic identity is identical', () => {
    const input = fixture(), before = verifyLocalSourceCandidatePolicy(input)
    input.lockfileSource += '\n'; input.lockStats[0]!.size++; replaceMarker(input, record => { record.lockfile.size++ })
    const after = verifyLocalSourceCandidatePolicy(input)
    expect(after.lockfile.rawSha256).not.toBe(before.lockfile.rawSha256)
    expect(after.lockfile.observedSemanticHash).toBe(before.lockfile.observedSemanticHash)
  })

  test('accepts only the conservative truly empty graph as N/A, never as verified candidates', () => {
    const proof = verifyLocalSourceCandidatePolicy(emptyFixture())
    expect(proof.applicability).toBe('empty-graph'); expect(proof.lockfile.observedSemanticHash).toBeNull()
    expect(proof.verification).toEqual({ candidateEntries: 0, eventCount: 0, elapsedMs: null, scope: 'no-dependencies' })
    expect(() => verifyLocalSourceCandidatePolicy({ ...emptyFixture(), verifierConfigured: false })).toThrow('configured verifier')
  })
  test.each([
    { packages: { 'dangling@1.0.0': {} } }, { snapshots: { 'dangling@1.0.0': {} } }, { packages: [] }, { snapshots: null },
    { importers: { '.': { dependencies: { demo: { specifier: 'workspace:*', version: 'link:../demo' } } } } },
    { importers: { '.': { optionalDependencies: { demo: { specifier: 'file:a.tgz', version: 'file:a.tgz' } } } } },
    { importers: { '../outside': {} } }, { importers: {} }, { importers: { '.': { dependencies: null } } },
    { importers: { '.': { resolution: {} } } }, { catalogs: { default: {} } }, { lockfileVersion: '8.0' },
  ])('rejects falsely empty or unknown raw graph %j', extra => {
    const input = emptyFixture(); input.lockfileSource = stringify({ lockfileVersion: '9.0', importers: { '.': {} }, ...extra }); input.lockStats[0]!.size = Buffer.byteLength(input.lockfileSource)
    expect(() => verifyLocalSourceCandidatePolicy(input)).toThrow('local source candidate policy:')
  })
})
