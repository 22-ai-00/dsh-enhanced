import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'

const roots: string[] = []
const children = new Set<ChildProcess>()
const fixture = join(process.cwd(), 'scripts/fixtures/repair-restart-runtime-child.mjs')
const linuxTest = process.platform === 'linux' ? test : test.skip
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
}
afterEach(async () => {
  await Promise.all([...children].map(async child => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited(child) } }))
  children.clear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function launch(mode: 'create' | 'resume', root: string) {
  const child = spawn(process.execPath, [fixture, mode, root], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } })
  children.add(child); let stderr = '', stdout = '', lines: any[] = []
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value; const rows = stdout.split('\n'); stdout = rows.pop() ?? ''; for (const row of rows) if (row) lines.push(JSON.parse(row)) })
  return { child, lines: () => lines, stderr: () => stderr }
}
async function message(run: ReturnType<typeof launch>, event: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) { const found = run.lines().find(line => line.event === event); if (found) return found; if (run.child.exitCode !== null) throw new Error(`child exited ${run.child.exitCode}: ${run.stderr()}`); await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(`timed out waiting for ${event}: ${run.stderr()}`)
}

linuxTest('SIGKILL after a persisted native tool result resumes the same repair goal with its durable fence and budgets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repair-restart-runtime-')); roots.push(root)
  const first = launch('create', root), ready = await message(first, 'ready')
  expect(ready.native).toMatchObject({ phase: 'active', roundsStarted: 1, maxGoalRounds: 2 })
  expect(ready.usage).toEqual({ modelCalls: 2, toolCalls: 1 })
  expect(ready.execution).toMatchObject({ state: 'active', pendingModel: 0, pendingTool: 0, fence: 1 })
  expect(ready.deadlineAt).toBe(ready.execution.deadlineAt)
  expect(ready.settlement).toMatchObject({ nativeGoalId: ready.nativeGoalId, round: 1, execution: { status: 'succeeded', quiescent: true }, acceptance: expect.any(Object) })
  expect(ready.firstOutcome).toMatchObject({ status: 'not-achieved', triggerRunId: ready.settlement.runId })
  first.child.kill('SIGKILL'); await exited(first.child)
  const second = launch('resume', root), resumed = await message(second, 'resumed')
  await exited(second.child)
  expect(second.child.exitCode).toBe(0)
  expect(resumed).toMatchObject({ continuationId: ready.continuationId, sessionId: ready.sessionId, goalId: ready.goalId, nativeGoalId: ready.nativeGoalId, definitionDigest: ready.definitionDigest })
  expect(resumed.native).toMatchObject({ phase: 'complete', roundsStarted: 2, maxGoalRounds: 2 })
  expect(resumed.usage).toEqual({ modelCalls: 4, toolCalls: 2 })
  expect(resumed.execution).toMatchObject({ fence: 2, pendingModel: 0, pendingTool: 0 })
  expect(resumed.deadlineAt).toBe(ready.deadlineAt)
  expect(resumed.settlement).toEqual(ready.settlement)
  await access(resumed.artifact); expect(JSON.parse(await readFile(resumed.artifact, 'utf8'))).toMatchObject({ mode: 'resume' })
}, 30_000)

linuxTest('a still-live lease holder blocks a second process from loading the original native repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repair-restart-runtime-live-')); roots.push(root)
  const first = launch('create', root), ready = await message(first, 'ready')
  const contender = launch('resume', root); await exited(contender.child)
  expect(contender.child.exitCode).not.toBe(0)
  expect(contender.stderr()).toMatch(/remains authoritative|recovery required/u)
  expect(ready.execution).toMatchObject({ fence: 1, pendingModel: 0, pendingTool: 0 })
  first.child.kill('SIGKILL'); await exited(first.child)
})
