/**
 * Harder public development tasks for the native Goal strategy benchmark (strategy-v2).
 *
 * This suite is deliberately more coupled and adversarial than strategy-v1: each task combines
 * several exact constraints (half-open boundaries, midnight wrap, closed-intersection feasibility,
 * paragraph-aware rewrapping, a quoted-CSV state machine) so a first-round artifact can plausibly
 * fail independent verification. Like v1, the model sees only `objective`, `publicPrompt` and the
 * single public example per task; the private verifier vectors never leave the Host.
 *
 * The v1 authored corpus is intentionally untouched so its dataset digest stays byte-identical.
 * Every private expected byte below was produced by a POSIX-sh reference implementation and
 * byte-compared inside the frozen verifier image (dash + busybox awk); it is not hand-computed.
 */
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { BenchmarkCase, BenchmarkPlan } from './types.js'
import { strategyGoalTaskDigests, type StrategyGoalTask } from './strategy-goal-runtime.js'
import {
  frozenJson,
  objective,
  prompt,
  strategyDevelopmentCases,
  strategyDevelopmentCorpus,
  strategyDevelopmentDataset,
  strategyDevelopmentTask,
  type AuthoredStrategyTask,
  type StrategyDevelopmentCorpusTask,
} from './strategy-corpus.js'

export type StrategySuite = 'strategy-v1' | 'strategy-v2'
export const strategySuites: readonly StrategySuite[] = ['strategy-v1', 'strategy-v2']
export const isStrategySuite = (value: unknown): value is StrategySuite => value === 'strategy-v1' || value === 'strategy-v2'

const sessionGapSplit = objective([
  'reads one wall-clock timestamp in exact "HH:MM:SS" form per line (24-hour, zero-padded), and partitions the series into sessions.',
  'The timestamps are non-decreasing except that a raw value smaller than the previous raw value means the series crosses exactly one midnight; add 86400 seconds to that value and every later value for that comparison.',
  'Two consecutive events belong to the same session only when the difference between their absolute times is at most 300 seconds; a gap strictly greater than 300 seconds starts a new session (exactly 300 seconds stays in the same session).',
  'For every session, in chronological session order, write one line "start-end count" where start and end are the session\'s first and last timestamps rendered as "HH:MM:SS" (a timestamp on the far side of midnight is shown as that wrapped wall-clock time by taking it modulo 86400) and count is the number of events in that session; a single event is rendered with start equal to end and count 1.',
  'Every emitted line ends with one newline. Empty input produces no output.',
].join(' '))

const closedRangeIntersection = objective([
  'reads lines of three whitespace-separated fields "name lo hi", giving one closed integer interval [lo, hi] constraint on name.',
  'Accumulate every constraint with the same name: the resulting lower bound is the maximum of all lo values and the upper bound is the minimum of all hi values, i.e. the intersection of the closed intervals.',
  'A result whose lower bound equals its upper bound is the single point [x, x] and is still feasible; it is empty only when the maximum lower bound is strictly greater than the minimum upper bound.',
  'If ANY name has an empty intersection, write exactly one line containing "NONE". Otherwise write one "name lo hi" line per name, ordered by ascending name in ASCII byte order, each line ending with one newline.',
  'Empty input produces no output.',
].join(' '))

const greedyParagraphWrap = objective([
  'splits standard input into paragraphs separated by runs of blank lines, ignoring leading and trailing blank lines and paragraphs that contain only whitespace.',
  'Within a paragraph, collapse every run of whitespace (spaces, tabs and newlines) into a single separator to obtain the ordered sequence of words.',
  'Fill words greedily into lines exactly 40 columns wide: the first word starts a line; a later word is joined with a single space only when "current line length + 1 + word length <= 40", otherwise it starts a new line. A word longer than 40 columns is placed alone on its own line intact, never split or truncated.',
  'Lines within a paragraph are separated by one newline; consecutive paragraphs are separated by exactly one blank line; any non-empty output ends with one newline.',
  'Empty input or input containing only whitespace produces no output.',
].join(' '))

const quotedCsvAccountTotal = objective([
  'skips the first line, which is the fixed header "account,jurisdiction,amount", and reads each remaining line as one record with exactly three comma-separated columns: account, jurisdiction, and an integer amount in cents that may be negative.',
  'A column may be wrapped in double quotes; commas inside a quoted column are literal data, and two consecutive double quotes inside a quoted column denote one literal double quote.',
  'Group records by the pair (jurisdiction, account) and sum the integer amounts in each group. The value -0 equals 0, and a group whose positive and negative amounts cancel to exactly 0 is still emitted.',
  'For each distinct pair write one line with jurisdiction, account and the integer total joined by single tab characters as "jurisdiction<TAB>account<TAB>total", ending with one newline. Order the lines by ascending ASCII byte order of the whole line (equivalently jurisdiction first, then account).',
  'Input containing only the header, or no records at all, produces no output.',
].join(' '))

const authoredV2: readonly AuthoredStrategyTask[] = [
  {
    id: 'session-gap-split', domain: 'code',
    objective: sessionGapSplit,
    examples: [{ stdin: '09:00:00\n09:01:00\n09:10:00\n', expectedStdout: '09:00:00-09:01:00 2\n09:10:00-09:10:00 1\n' }],
    publicPrompt: prompt(sessionGapSplit, [{ stdin: '09:00:00\n09:01:00\n09:10:00\n', expectedStdout: '09:00:00-09:01:00 2\n09:10:00-09:10:00 1\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 2_048, cases: [
      { stdin: '', expectedStdout: '', expectedExitCode: 0 },
      { stdin: '12:34:56\n', expectedStdout: '12:34:56-12:34:56 1\n', expectedExitCode: 0 },
      { stdin: '09:00:00\n09:05:00\n', expectedStdout: '09:00:00-09:05:00 2\n', expectedExitCode: 0 },
      { stdin: '09:00:00\n09:05:01\n', expectedStdout: '09:00:00-09:00:00 1\n09:05:01-09:05:01 1\n', expectedExitCode: 0 },
      { stdin: '23:58:00\n00:02:00\n', expectedStdout: '23:58:00-00:02:00 2\n', expectedExitCode: 0 },
      { stdin: '23:59:00\n00:01:00\n00:10:00\n', expectedStdout: '23:59:00-00:01:00 2\n00:10:00-00:10:00 1\n', expectedExitCode: 0 },
      { stdin: '08:00:00\n08:00:00\n08:10:00\n', expectedStdout: '08:00:00-08:00:00 2\n08:10:00-08:10:00 1\n', expectedExitCode: 0 },
      { stdin: '09:00:00\n09:00:30\n09:10:00\n09:10:10\n09:30:00\n', expectedStdout: '09:00:00-09:00:30 2\n09:10:00-09:10:10 2\n09:30:00-09:30:00 1\n', expectedExitCode: 0 },
    ] },
  },
  {
    id: 'closed-range-intersection', domain: 'code',
    objective: closedRangeIntersection,
    examples: [{ stdin: 'alpha 0 10\nalpha 5 15\n', expectedStdout: 'alpha 5 10\n' }],
    publicPrompt: prompt(closedRangeIntersection, [{ stdin: 'alpha 0 10\nalpha 5 15\n', expectedStdout: 'alpha 5 10\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 2_048, cases: [
      { stdin: '', expectedStdout: '', expectedExitCode: 0 },
      { stdin: 'alpha 5 5\nalpha 5 10\n', expectedStdout: 'alpha 5 5\n', expectedExitCode: 0 },
      { stdin: 'beta 1 4\nbeta 5 10\n', expectedStdout: 'NONE\n', expectedExitCode: 0 },
      { stdin: 'gamma 0 100\ngamma 10 20\ngamma 21 30\n', expectedStdout: 'NONE\n', expectedExitCode: 0 },
      { stdin: 'zeta 1 2\ndelta 10 0\n', expectedStdout: 'NONE\n', expectedExitCode: 0 },
      { stdin: 'eta 3 8\neta 3 8\n', expectedStdout: 'eta 3 8\n', expectedExitCode: 0 },
      { stdin: 'theta 7 7\n', expectedStdout: 'theta 7 7\n', expectedExitCode: 0 },
      { stdin: 'b 0 10\na 1 5\na 4 9\n', expectedStdout: 'a 4 5\nb 0 10\n', expectedExitCode: 0 },
    ] },
  },
  {
    id: 'greedy-paragraph-wrap', domain: 'code',
    objective: greedyParagraphWrap,
    examples: [{ stdin: 'the quick brown fox jumps\n', expectedStdout: 'the quick brown fox jumps\n' }],
    publicPrompt: prompt(greedyParagraphWrap, [{ stdin: 'the quick brown fox jumps\n', expectedStdout: 'the quick brown fox jumps\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 2_048, cases: [
      { stdin: '', expectedStdout: '', expectedExitCode: 0 },
      { stdin: '   \n\t  \n', expectedStdout: '', expectedExitCode: 0 },
      { stdin: '   one two   \n', expectedStdout: 'one two\n', expectedExitCode: 0 },
      { stdin: 'abcdefghij abcdefghi abcdefghi abcdefghi end\n', expectedStdout: 'abcdefghij abcdefghi abcdefghi abcdefghi\nend\n', expectedExitCode: 0 },
      { stdin: 'before xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx after\n', expectedStdout: 'before\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\nafter\n', expectedExitCode: 0 },
      { stdin: 'hello   world\tfoo\n\n\nbar baz\n', expectedStdout: 'hello world foo\n\nbar baz\n', expectedExitCode: 0 },
      { stdin: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx y\n', expectedStdout: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\ny\n', expectedExitCode: 0 },
      { stdin: 'p1a p1b\np1c\n\n   p2a    p2b\n', expectedStdout: 'p1a p1b p1c\n\np2a p2b\n', expectedExitCode: 0 },
    ] },
  },
  {
    id: 'quoted-csv-account-totals', domain: 'code',
    objective: quotedCsvAccountTotal,
    examples: [{ stdin: 'account,jurisdiction,amount\nfoo,US,100\nfoo,US,50\n', expectedStdout: 'US\tfoo\t150\n' }],
    publicPrompt: prompt(quotedCsvAccountTotal, [{ stdin: 'account,jurisdiction,amount\nfoo,US,100\nfoo,US,50\n', expectedStdout: 'US\tfoo\t150\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 2_048, cases: [
      { stdin: '', expectedStdout: '', expectedExitCode: 0 },
      { stdin: 'account,jurisdiction,amount\n', expectedStdout: '', expectedExitCode: 0 },
      { stdin: 'account,jurisdiction,amount\nacme,US,500\nacme,US,-500\n', expectedStdout: 'US\tacme\t0\n', expectedExitCode: 0 },
      { stdin: 'account,jurisdiction,amount\nacme,US,-0\nacme,US,7\nneg,US,3\nneg,US,-10\n', expectedStdout: 'US\tacme\t7\nUS\tneg\t-7\n', expectedExitCode: 0 },
      { stdin: 'account,jurisdiction,amount\n"Smith, LLC",US,100\n"Smith, LLC",US,-40\n', expectedStdout: 'US\tSmith, LLC\t60\n', expectedExitCode: 0 },
      { stdin: 'account,jurisdiction,amount\n"a""b",US,10\n"a""b",US,2\n', expectedStdout: 'US\ta"b\t12\n', expectedExitCode: 0 },
      { stdin: 'account,jurisdiction,amount\nb,J2,1\na,J1,2\na,J2,3\nb,J2,10\na,J1,-2\n', expectedStdout: 'J1\ta\t0\nJ2\ta\t3\nJ2\tb\t11\n', expectedExitCode: 0 },
      { stdin: 'account,jurisdiction,amount\n"X, Y ""Z""",US,3\n"X, Y ""Z""",US,-1\n', expectedStdout: 'US\tX, Y "Z"\t2\n', expectedExitCode: 0 },
    ] },
  },
]

/** This public surface intentionally excludes independent verification vectors. */
export const strategyV2Corpus: readonly StrategyDevelopmentCorpusTask[] = frozenJson(authoredV2.map(({ verification: _verification, ...task }) => task))

const fullTask = (task: AuthoredStrategyTask): StrategyGoalTask => ({
  objective: task.objective, publicPrompt: task.publicPrompt, artifactPath: task.artifactPath, verification: task.verification,
})
const taskDigests = (task: AuthoredStrategyTask) => strategyGoalTaskDigests(fullTask(task))

/** Dataset identity commits to the complete private verification manifest. */
export const strategyV2Dataset: BenchmarkPlan['dataset'] = frozenJson({
  id: 'dsh-strategy-development-v2', version: '1', split: 'development',
  digest: acceptanceDigest(authoredV2.map(task => ({ id: task.id, domain: task.domain, task: fullTask(task), digests: taskDigests(task) }))),
})

export function strategyV2Cases(): readonly BenchmarkCase[] {
  return frozenJson(authoredV2.map(task => ({ id: task.id, domain: task.domain, ...taskDigests(task) })))
}

/** Host-only full task material, including private verifier vectors. */
export function strategyV2Task(caseId: string): Readonly<StrategyGoalTask> {
  const task = authoredV2.find(candidate => candidate.id === caseId)
  if (task === undefined) throw new Error(`unknown strategy-v2 case: ${caseId}`)
  return frozenJson(fullTask(task))
}

// Suite-scoped resolvers so config/executor/cli share one place that maps a suite to its corpus.
export const strategyCorpusForSuite = (suite: StrategySuite): readonly StrategyDevelopmentCorpusTask[] =>
  suite === 'strategy-v2' ? strategyV2Corpus : strategyDevelopmentCorpus
export const strategyDatasetForSuite = (suite: StrategySuite): BenchmarkPlan['dataset'] =>
  suite === 'strategy-v2' ? strategyV2Dataset : strategyDevelopmentDataset
export const strategyCasesForSuite = (suite: StrategySuite): readonly BenchmarkCase[] =>
  suite === 'strategy-v2' ? strategyV2Cases() : strategyDevelopmentCases()
export const strategyTaskForSuite = (suite: StrategySuite, caseId: string): Readonly<StrategyGoalTask> =>
  suite === 'strategy-v2' ? strategyV2Task(caseId) : strategyDevelopmentTask(caseId)
