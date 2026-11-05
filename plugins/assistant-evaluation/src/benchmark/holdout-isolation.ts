/**
 * Held-out isolation checks. A holdout plan must be disjoint from every public development
 * manifest (dataset id/digest, case ids, input digests and acceptance digests), and a holdout
 * plan must never be supplied as a candidate-generation input. These are manifest-level checks:
 * they detect reuse of a published task or judge, not paraphrased leakage.
 */
import { developmentCases, developmentDataset } from './corpus.js'
import { familiesDevelopmentCases, familiesDevelopmentDataset } from './families-corpus.js'
import { memoryDevelopmentCases, memoryDevelopmentDataset, memoryDevelopmentDatasetV2 } from './memory-corpus.js'
import { BenchmarkError, benchmarkAssert, parseBenchmarkPlan } from './schema.js'
import type { BenchmarkCase, BenchmarkPlan } from './types.js'

export interface PublicBenchmarkManifest {
  suite: string
  dataset: BenchmarkPlan['dataset']
  cases: readonly BenchmarkCase[]
}

/**
 * Lightweight public suites. Strategy suites live behind optional runtime packages; callers that
 * can load them pass their manifests through `additional` (the CLI-independent API stays light).
 */
export function publicDevelopmentManifests(): readonly PublicBenchmarkManifest[] {
  return Object.freeze([
    { suite: 'research-v1', dataset: developmentDataset, cases: developmentCases() },
    { suite: 'families-v1', dataset: familiesDevelopmentDataset, cases: familiesDevelopmentCases() },
    { suite: 'memory-v1', dataset: memoryDevelopmentDataset, cases: memoryDevelopmentCases('1') },
    { suite: 'memory-v2', dataset: memoryDevelopmentDatasetV2, cases: memoryDevelopmentCases('2') },
  ])
}

export interface HoldoutIsolationOverlap {
  suite: string
  kind: 'dataset-id' | 'dataset-digest' | 'case-id' | 'input-digest' | 'acceptance-digest'
  /** Holdout case id, or the dataset id for dataset-level overlaps. Never private input. */
  holdoutRef: string
}

/** Pure inspection: every overlap between a holdout plan and the given public manifests. */
export function holdoutIsolationOverlaps(input: BenchmarkPlan, additional: readonly PublicBenchmarkManifest[] = []): readonly HoldoutIsolationOverlap[] {
  const plan = parseBenchmarkPlan(input)
  const overlaps: HoldoutIsolationOverlap[] = []
  for (const manifest of [...publicDevelopmentManifests(), ...additional]) {
    benchmarkAssert(manifest.dataset.split === 'development', 'public manifest must be a development split')
    if (manifest.dataset.id === plan.dataset.id) overlaps.push({ suite: manifest.suite, kind: 'dataset-id', holdoutRef: plan.dataset.id })
    if (manifest.dataset.digest === plan.dataset.digest) overlaps.push({ suite: manifest.suite, kind: 'dataset-digest', holdoutRef: plan.dataset.id })
    const ids = new Set(manifest.cases.map(task => task.id))
    const inputs = new Set(manifest.cases.map(task => task.inputDigest))
    const acceptances = new Set(manifest.cases.map(task => task.acceptanceDigest))
    for (const task of plan.cases) {
      if (ids.has(task.id)) overlaps.push({ suite: manifest.suite, kind: 'case-id', holdoutRef: task.id })
      if (inputs.has(task.inputDigest)) overlaps.push({ suite: manifest.suite, kind: 'input-digest', holdoutRef: task.id })
      if (acceptances.has(task.acceptanceDigest)) overlaps.push({ suite: manifest.suite, kind: 'acceptance-digest', holdoutRef: task.id })
    }
  }
  return Object.freeze(overlaps.map(entry => Object.freeze(entry)))
}

/** Throws unless the plan is a holdout split disjoint from every public development manifest. */
export function assertHoldoutIsolation(input: BenchmarkPlan, additional: readonly PublicBenchmarkManifest[] = []): void {
  const plan = parseBenchmarkPlan(input)
  benchmarkAssert(plan.dataset.split === 'holdout', 'holdout isolation requires a holdout dataset')
  const overlaps = holdoutIsolationOverlaps(plan, additional)
  if (overlaps.length > 0) {
    const kinds = [...new Set(overlaps.map(entry => `${entry.suite}:${entry.kind}`))].sort().join(', ')
    throw new BenchmarkError(`holdout overlaps public development data (${kinds})`)
  }
}

/**
 * Guard for anything that derives candidates (prompts, skills, policies) from benchmark data:
 * only development splits may feed generation. A holdout plan is rejected before any read.
 */
export function assertCandidateGenerationInput(input: BenchmarkPlan): Readonly<BenchmarkPlan> {
  const plan = parseBenchmarkPlan(input)
  benchmarkAssert(plan.dataset.split === 'development', 'holdout data must never be used for candidate generation')
  return plan
}
