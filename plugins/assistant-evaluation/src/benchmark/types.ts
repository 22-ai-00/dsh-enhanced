/** Host-side benchmark data. These APIs are deliberately not registered as model tools. */
export const benchmarkDomains = ['code', 'research', 'cross-day', 'proactivity', 'injection', 'revocation', 'goal-change', 'duplicate-action'] as const
export type BenchmarkDomain = typeof benchmarkDomains[number]
export type BenchmarkSplit = 'development' | 'holdout'
export type BenchmarkVerdict = 'achieved' | 'not-achieved' | 'unknown'
export type BenchmarkFeatures = Readonly<Record<'memory' | 'planning' | 'review' | 'growth', boolean>>

export interface BenchmarkVersions {
  /** Every value is a SHA-256 of the resolved configuration/content, including model sampling. */
  model: string
  prompt: string
  skills: string
  tools: string
  policy: string
  runtime: string
}

export interface BenchmarkBudget {
  durationMs: number
  inputTokens: number
  outputTokens: number
  /** Null explicitly selects token-only budgeting for providers without a known tariff. */
  costUsdMicros: number | null
  toolCalls: number
}

export interface BenchmarkVariant {
  id: string
  role: 'baseline' | 'candidate' | 'ablation'
  versions: BenchmarkVersions
  features: BenchmarkFeatures
}

/** No prompts, answers, judge programs, file paths or source documents in this manifest. */
export interface BenchmarkCase {
  id: string
  domain: BenchmarkDomain
  inputDigest: string
  acceptanceDigest: string
}

export interface BenchmarkPlan {
  schemaVersion: 1
  id: string
  dataset: { id: string; version: string; digest: string; split: BenchmarkSplit }
  comparison: 'capability' | 'model'
  cases: readonly BenchmarkCase[]
  variants: readonly BenchmarkVariant[]
  budget: BenchmarkBudget
  repeats: number
  seed: number
}

/** Measured by the Host, never extracted from model prose. Null means unavailable. */
export interface BenchmarkMetrics {
  inputTokens: number | null
  outputTokens: number | null
  costUsdMicros: number | null
  toolCalls: number | null
  rework: number | null
  interventions: number | null
  latencyMs: number | null
}

export interface BenchmarkCell {
  id: string
  caseId: string
  variantId: string
  repeat: number
  seed: number
}

export interface BenchmarkObservation {
  /** The adapter must compare actual loaded versions, input and judge with the plan. */
  versions: BenchmarkVersions
  inputDigest: string
  acceptanceDigest: string
  verdict: BenchmarkVerdict
  metrics: BenchmarkMetrics
  evidenceDigest: string
  /** True only after the original agent and its owned resources have stopped. */
  quiescent: boolean
}

export interface BenchmarkResult {
  cell: BenchmarkCell
  status: 'completed' | 'unknown'
  verdict: BenchmarkVerdict
  metrics: BenchmarkMetrics
  evidenceDigest: string | null
  reason: 'verified' | 'adapter-error' | 'interrupted' | 'timeout' | 'invalid-observation' | 'budget-exceeded' | 'not-quiescent'
  startedAt: number
  completedAt: number
}

/** Nearest-rank percentiles over measured values only; every statistic is null without measurements. */
export interface BenchmarkMetricSummary {
  measured: number
  missing: number
  mean: number | null
  median: number | null
  p95: number | null
  min: number | null
  p10: number | null
  p90: number | null
  max: number | null
}

/** Per-task success rate across repeats; only tasks whose every repeat has a known verdict are summarized. */
export interface BenchmarkTaskSuccessDistribution {
  tasks: number
  summarized: number
  allAchieved: number
  noneAchieved: number
  /** Tasks whose repeats disagree (flaky under a fixed configuration). */
  mixed: number
  min: number | null
  median: number | null
  max: number | null
}

export interface BenchmarkDomainOutcome {
  domain: BenchmarkDomain
  tasks: number
  expected: number
  achieved: number
  notAchieved: number
  unknown: number
  successRate: number
}

export interface BenchmarkDomainComparison {
  domain: BenchmarkDomain
  paired: number
  missingPairs: number
  wins: number
  losses: number
  ties: number
  unknownPairs: number
}

/**
 * Paired variant-minus-reference metric differences over pairs where both verdicts are known and
 * both values were measured. `pairs + unknownVerdictPairs + missing` equals cases × repeats.
 */
export interface BenchmarkPairedDelta {
  pairs: number
  /** Recorded pairs excluded because either side has an unknown verdict (same as the comparison's unknownPairs). */
  unknownVerdictPairs: number
  /** Pairs with a missing result, or a known-verdict pair where either value was not measured. */
  missing: number
  mean: number | null
  p10: number | null
  median: number | null
  p90: number | null
}

export interface BenchmarkReport {
  schemaVersion: 1
  /** Additive distribution fields (min/p10/p90/max, byDomain, taskSuccess, metricDeltas) are version 1. */
  distributionVersion: 1
  planDigest: string
  complete: boolean
  expectedCells: number
  recordedCells: number
  variants: readonly {
    id: string
    expected: number
    recorded: number
    achieved: number
    notAchieved: number
    unknown: number
    successRate: number
    /** Task-cluster bootstrap; unavailable with missing/unknown results or fewer than two tasks. */
    successInterval95: readonly [number, number] | null
    metrics: Readonly<Record<keyof BenchmarkMetrics, BenchmarkMetricSummary>>
    byDomain: readonly BenchmarkDomainOutcome[]
    taskSuccess: BenchmarkTaskSuccessDistribution
  }[]
  comparisons: readonly {
    /** Reference arm: baseline for candidates, the unique candidate for ablations. */
    baselineId: string
    variantId: string
    paired: number
    missingPairs: number
    wins: number
    losses: number
    ties: number
    unknownPairs: number
    /** Unavailable if either arm has missing or unknown results: these cannot prove a gain. */
    successRateDelta: number | null
    /** Clustered by task: repeats are not independent tasks. Null with fewer than two tasks. */
    taskBootstrapInterval95: readonly [number, number] | null
    byDomain: readonly BenchmarkDomainComparison[]
    metricDeltas: Readonly<Record<keyof BenchmarkMetrics, BenchmarkPairedDelta>>
  }[]
  /** Measurement reports never grant promotion authority. */
  promotionAuthorized: false
}
