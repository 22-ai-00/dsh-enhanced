/** Public synthetic development tasks for the native Goal strategy benchmark. */
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { strategyGoalTaskDigests, type StrategyGoalTask } from './strategy-goal-runtime.js'
import type { BenchmarkCase, BenchmarkPlan } from './types.js'

export interface StrategyDevelopmentCorpusTask {
  id: string
  domain: 'code'
  objective: string
  publicPrompt: string
  artifactPath: string
  examples: readonly { stdin: string; expectedStdout: string }[]
}

interface AuthoredStrategyTask extends StrategyDevelopmentCorpusTask {
  verification: StrategyGoalTask['verification']
}

const objective = (description: string): string => `Create a POSIX shell program named answer.sh that ${description}`
const prompt = (value: string, examples: readonly { stdin: string; expectedStdout: string }[]): string => [
  value,
  'Public examples:\n' + examples.map(example => `stdin:\n${example.stdin}\nstdout:\n${example.expectedStdout}`).join('\n'),
  'Create a Goal by calling goal_create with the exact objective stated above.',
  'Use isolation_run with grant_id "benchmark-work" to create the fixed artifact answer.sh.',
  'Do not return the solution in chat; the artifact is evaluated independently.',
].join('\n\n')

const authored: readonly AuthoredStrategyTask[] = [
  {
    id: 'integer-sum', domain: 'code',
    objective: objective('reads signed decimal integers separated by whitespace from standard input and writes their sum followed by one newline.'),
    examples: [{ stdin: '4 -1\n', expectedStdout: '3\n' }],
    publicPrompt: prompt(objective('reads signed decimal integers separated by whitespace from standard input and writes their sum followed by one newline.'), [{ stdin: '4 -1\n', expectedStdout: '3\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 1_024, cases: [
      { stdin: '1 2 3\n', expectedStdout: '6\n', expectedExitCode: 0 },
      { stdin: '-5\n10\n-3\n', expectedStdout: '2\n', expectedExitCode: 0 },
      { stdin: '', expectedStdout: '0\n', expectedExitCode: 0 },
    ] },
  },
  {
    id: 'merge-touching-intervals', domain: 'code',
    objective: objective('reads one inclusive integer interval "start end" per line, merges intervals that overlap or are adjacent (next start <= current end + 1), and writes merged intervals in ascending order as "start end" lines, each ending in one newline.'),
    examples: [{ stdin: '1 2\n2 3\n', expectedStdout: '1 3\n' }],
    publicPrompt: prompt(objective('reads one inclusive integer interval "start end" per line, merges intervals that overlap or are adjacent (next start <= current end + 1), and writes merged intervals in ascending order as "start end" lines, each ending in one newline.'), [{ stdin: '1 2\n2 3\n', expectedStdout: '1 3\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 2_048, cases: [
      { stdin: '5 7\n1 3\n3 5\n10 12\n', expectedStdout: '1 7\n10 12\n', expectedExitCode: 0 },
      { stdin: '1 1\n2 2\n4 4\n', expectedStdout: '1 2\n4 4\n', expectedExitCode: 0 },
      { stdin: '', expectedStdout: '', expectedExitCode: 0 },
    ] },
  },
  {
    id: 'word-frequency-lexical-ties', domain: 'code',
    objective: objective('reads whitespace-separated words, counts exact byte-for-byte word frequency, then writes one "word count" line per distinct word ordered by descending count and ascending lexical order for ties, each ending in one newline.'),
    examples: [{ stdin: 'red blue red\n', expectedStdout: 'red 2\nblue 1\n' }],
    publicPrompt: prompt(objective('reads whitespace-separated words, counts exact byte-for-byte word frequency, then writes one "word count" line per distinct word ordered by descending count and ascending lexical order for ties, each ending in one newline.'), [{ stdin: 'red blue red\n', expectedStdout: 'red 2\nblue 1\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 2_048, cases: [
      { stdin: 'pear apple pear banana apple pear\n', expectedStdout: 'pear 3\napple 2\nbanana 1\n', expectedExitCode: 0 },
      { stdin: 'z a z a\n', expectedStdout: 'a 2\nz 2\n', expectedExitCode: 0 },
      { stdin: '', expectedStdout: '', expectedExitCode: 0 },
    ] },
  },
  {
    id: 'dependency-topological-order', domain: 'code',
    objective: objective('reads directed dependency edges "before after" per line and writes a lexically smallest topological ordering as one node per line; when no ordering exists, writes exactly "CYCLE" followed by one newline.'),
    examples: [{ stdin: 'parse build\n', expectedStdout: 'parse\nbuild\n' }],
    publicPrompt: prompt(objective('reads directed dependency edges "before after" per line and writes a lexically smallest topological ordering as one node per line; when no ordering exists, writes exactly "CYCLE" followed by one newline.'), [{ stdin: 'parse build\n', expectedStdout: 'parse\nbuild\n' }]),
    artifactPath: 'answer.sh',
    verification: { command: 'sh artifact < input', maxDurationMs: 5_000, maxOutputBytes: 2_048, cases: [
      { stdin: 'cook eat\nshop cook\n', expectedStdout: 'shop\ncook\neat\n', expectedExitCode: 0 },
      { stdin: 'b d\na d\n', expectedStdout: 'a\nb\nd\n', expectedExitCode: 0 },
      { stdin: 'a b\nb c\nc a\n', expectedStdout: 'CYCLE\n', expectedExitCode: 0 },
    ] },
  },
]

function frozenJson<T>(value: T): T {
  const copy = JSON.parse(acceptanceCanonicalJson(value)) as T
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object') return
    for (const child of Object.values(entry)) freeze(child)
    Object.freeze(entry)
  }
  freeze(copy)
  return copy
}

/** This public surface intentionally excludes independent verification vectors. */
export const strategyDevelopmentCorpus: readonly StrategyDevelopmentCorpusTask[] = frozenJson(authored.map(({ verification: _verification, ...task }) => task))

const fullTask = (task: AuthoredStrategyTask): StrategyGoalTask => ({
  objective: task.objective, publicPrompt: task.publicPrompt, artifactPath: task.artifactPath, verification: task.verification,
})
const taskDigests = (task: AuthoredStrategyTask) => strategyGoalTaskDigests(fullTask(task))

/** Dataset identity commits to the complete private verification manifest. */
export const strategyDevelopmentDataset: BenchmarkPlan['dataset'] = frozenJson({
  id: 'dsh-strategy-development', version: '1', split: 'development',
  digest: acceptanceDigest(authored.map(task => ({ id: task.id, domain: task.domain, task: fullTask(task), digests: taskDigests(task) }))),
})

export function strategyDevelopmentCases(): readonly BenchmarkCase[] {
  return frozenJson(authored.map(task => ({ id: task.id, domain: task.domain, ...taskDigests(task) })))
}

/** Host-only full task material, including private verifier vectors. */
export function strategyDevelopmentTask(caseId: string): Readonly<StrategyGoalTask> {
  const task = authored.find(candidate => candidate.id === caseId)
  if (task === undefined) throw new Error(`unknown strategy development case: ${caseId}`)
  return frozenJson(fullTask(task))
}
