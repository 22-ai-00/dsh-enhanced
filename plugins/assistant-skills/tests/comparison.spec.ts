import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createDefinition } from '../src/definition.ts'
import { SkillComparator, validateComparisonProfiles, type SkillComparisonProfile } from '../src/comparison.ts'

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const value = await mkdtemp(join(tmpdir(), 'skills-comparison-')); roots.push(value); return value }
function skill(workspace: string, script: string) { const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace, preset: 'primary' }; return createDefinition({ protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: { id: 'source', definition: { version: 1, digest: 'a'.repeat(64), objective: 'script' }, sessionId: 'session', nativeGoalId: 'native' }, runId: 'run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 }, steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'result.sh', content: script } }] }, { name: 'script-result', description: 'Write result script.', bindings: [{ name: 'path', stepId: 'write', path: '/file_path' }] }, ['write']) }
function profile(workspace: string, stateRoot: string): SkillComparisonProfile { const cases = [['replay', 'one'], ['evaluation', 'two'], ['regression', 'three']] as const; return { id: 'synthetic', version: 1, scope: { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace, preset: 'primary' }, stateRoot, image, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, maxComparisons: 2, repeats: 2, cellDurationMs: 30000, verificationDurationMs: 10000, maxToolCalls: 2, maxBytes: 65536, maxOutputBytes: 65536, minimumEvaluationGain: 0.1, cases: cases.map(([kind, stdin]) => ({ id: kind, kind, inputs: { path: 'result.sh' }, files: [], stdin: `${stdin}\n`, expectedStdout: `${stdin}\n`, expectedExitCode: 0 })) } }

const dockerTests = /^sha256:[0-9a-f]{64}$/u.test(image) ? describe.sequential : describe.skip
dockerTests('synthetic native skill comparison', () => {
  test('runs paired replay/evaluation/regression cells and never promotes automatically', async () => {
    const workspace = await root(), stateRoot = await root(); await chmod(stateRoot, 0o700)
    const comparator = new SkillComparator(profile(workspace, stateRoot))
    try { const result = await comparator.compare('synthetic-run', skill(workspace, '#!/bin/sh\nread x\nprintf wrong'), skill(workspace, '#!/bin/sh\ncat'), new AbortController().signal, () => {})
      expect(result.cells).toHaveLength(12); expect(result.cells.every(cell => cell.toolCalls === 1 && cell.quiescent)).toBe(true)
      expect(result.quality).toMatchObject({ candidateChecksPassed: true, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'unproven' }); expect(result.promotionAuthorized).toBe(false)
    } finally { await comparator.close() }
  }, 120000)

  test('does not pass the critical regression gate when only evaluation improves', async () => {
    const workspace = await root(), stateRoot = await root(); await chmod(stateRoot, 0o700); const comparator = new SkillComparator(profile(workspace, stateRoot))
    try { const result = await comparator.compare('regression-gate', skill(workspace, '#!/bin/sh\nread x\nprintf wrong'), skill(workspace, '#!/bin/sh\nread x\nif [ "$x" = three ]; then printf wrong; else printf "%s\\n" "$x"; fi'), new AbortController().signal, () => {})
      expect(result.quality).toMatchObject({ evaluationGainObserved: true, criticalRegressionsPassed: false, candidateChecksPassed: false }); expect(result.promotionAuthorized).toBe(false)
    } finally { await comparator.close() }
  }, 120000)

  test('stops after authority is revoked following the first isolated cell', async () => {
    const workspace = await root(), stateRoot = await root(); await chmod(stateRoot, 0o700); const comparator = new SkillComparator(profile(workspace, stateRoot)); let checks = 0
    try { const result = await comparator.compare('authority-stop', skill(workspace, '#!/bin/sh\nread x\nprintf wrong'), skill(workspace, '#!/bin/sh\ncat'), new AbortController().signal, () => { if (++checks > 6) throw new Error('fixture authority revoked') }); expect(checks).toBeGreaterThan(6); expect(result.report).toMatchObject({ complete: false, recordedCells: 1 }); expect(result.quality.candidateChecksPassed).toBe(false); expect(result.promotionAuthorized).toBe(false)
    } finally { await comparator.close() }
  }, 120000)
})

test('rejects unsafe or incomplete synthetic comparison profiles', async () => {
  const workspace = await root(), stateRoot = await root(); const valid = profile(workspace, stateRoot)
  expect(() => validateComparisonProfiles([{ ...valid, id: 'bad', stateRoot: workspace }])).toThrow()
  expect(() => validateComparisonProfiles([{ ...valid, cases: valid.cases.map((entry, index) => index ? entry : { ...entry, id: 'evaluation' }) }])).toThrow()
  expect(() => validateComparisonProfiles([{ ...valid, maxComparisons: Infinity }])).toThrow()
})
