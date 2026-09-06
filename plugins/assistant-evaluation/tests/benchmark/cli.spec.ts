import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { benchmarkCli } from '../../src/benchmark/cli.js'
import { developmentCases } from '../../src/benchmark/corpus.js'
import type { NativeBenchmarkConfig } from '../../src/benchmark/native.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function workspace(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'benchmark-cli-')); directories.push(path); return path }
const configuration = (digest: string): NativeBenchmarkConfig => ({
  id: 'cli-trial', cases: [developmentCases()[0]!.id],
  variants: [{ id: 'baseline', role: 'baseline', persona: 'Answer the question.' }, { id: 'candidate', role: 'candidate', persona: 'Read every source before answering.' }],
  model: { provider: 'fixture', model: 'fixture-model', temperature: 0, maxOutputTokens: 100,
    inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null, adapterDigest: digest, tokenCounterDigest: digest },
  budget: { inputTokens: 1000, outputTokens: 100, durationMs: 2000, toolCalls: 0, costUsdMicros: null }, repeats: 2, seed: 1,
})
const capture = () => { const chunks: string[] = []; return { chunks, io: { stdout(text: string) { chunks.push(text) } } } }

describe('benchmark operator commands', () => {
  it('lists public tasks without exporting oracle answers and checks runtime readiness', async () => {
    const output = capture()
    expect(await benchmarkCli(['corpus'], output.io)).toBe(0)
    const corpus = JSON.parse(output.chunks.join(''))
    expect(corpus.dataset.split).toBe('development')
    expect(corpus.tasks).toHaveLength(8)
    expect(corpus.tasks.every((task: Record<string, unknown>) => !('acceptance' in task))).toBe(true)
    output.chunks.length = 0
    expect(await benchmarkCli(['doctor'], output.io)).toBe(0)
    expect(JSON.parse(output.chunks.join('')).ready).toBe(true)
  })
  it('creates a frozen plan and total token caps without loading an adapter or inventing prices', async () => {
    const root = await workspace(); const file = join(root, 'config.json'); const outputFile = join(root, 'plan.json')
    await writeFile(file, JSON.stringify(configuration('a'.repeat(64))))
    const output = capture()
    expect(await benchmarkCli(['plan', '--config', file, '--output', outputFile], output.io)).toBe(0)
    const result = JSON.parse(await readFile(outputFile, 'utf8'))
    expect(result).toMatchObject({ plannedCells: 4, maximumInputTokens: 4000, maximumOutputTokens: 400, maximumCostUsdMicros: null })
    expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/u)
    await expect(benchmarkCli(['plan', '--config', file, '--output', outputFile], output.io)).rejects.toThrow('already exists')
  })
  it('rejects adapter content drift before importing operator code', async () => {
    const root = await workspace(); const module = join(root, 'adapter.mjs'); const file = join(root, 'config.json')
    await writeFile(module, 'throw new Error("MUST_NOT_IMPORT");')
    await writeFile(file, JSON.stringify(configuration('b'.repeat(64))))
    await expect(benchmarkCli(['run', '--config', file, '--adapter', module, '--database', join(root, 'bench.sqlite')], capture().io)).rejects.toThrow('digests')
  })
  it('persists unknown on Host adapter failure and reports it without echoing exception content', async () => {
    const root = await workspace(); const module = join(root, 'adapter.mjs'); const file = join(root, 'config.json'); const database = join(root, 'bench.sqlite')
    const code = 'export function createNativeAdapter() { throw new Error("SECRET_SENTINEL"); }'
    const digest = createHash('sha256').update(code).digest('hex')
    await writeFile(module, code); await writeFile(file, JSON.stringify(configuration(digest)))
    const output = capture()
    expect(await benchmarkCli(['run', '--config', file, '--adapter', module, '--database', database], output.io)).toBe(2)
    expect(output.chunks.join('')).not.toContain('SECRET_SENTINEL')
    const result = JSON.parse(output.chunks.join(''))
    expect(result).toMatchObject({ complete: false, recordedCells: 1, promotionAuthorized: false })
    output.chunks.length = 0
    expect(await benchmarkCli(['report', '--database', database, '--plan', 'cli-trial'], output.io)).toBe(0)
    expect(JSON.parse(output.chunks.join(''))).toEqual(result)
  })
  it('rejects duplicate/unrecognized flags and does not create a database for report typos', async () => {
    const root = await workspace(); const missing = join(root, 'absent.sqlite')
    await expect(benchmarkCli(['corpus', '--config', 'x'], capture().io)).rejects.toThrow('argument')
    await expect(benchmarkCli(['plan', '--config', 'one', '--config', 'two'], capture().io)).rejects.toThrow('argument')
    await expect(benchmarkCli(['report', '--database', missing, '--plan', 'x'], capture().io)).rejects.toThrow()
    await expect(readFile(missing)).rejects.toThrow()
  })
})
