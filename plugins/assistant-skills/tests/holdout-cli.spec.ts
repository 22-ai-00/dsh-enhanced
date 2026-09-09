import { spawn, execFile } from 'node:child_process'
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, chmod, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { createDefinition } from '../src/definition.ts'
import { qualifyHoldout } from '../src/holdout-qualification.ts'
import { openHoldoutProcess } from '../src/external-holdout.ts'
import { verifyHoldoutSignature, type BeginResult, type HoldoutReceipt, type SignedCell } from '../src/holdout-authority.ts'
import { generatorDigest, prospectiveGeneratorDigest, verifyProspectiveCertificate } from '../src/prospective-holdout.ts'

const exec = promisify(execFile), roots: string[] = [], closes: (() => Promise<void>)[] = []
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const cli = fileURLToPath(new URL('../lib/holdout-cli.js', import.meta.url))
const dataset = { id: 'operator-echo-cases', version: '1', cases: ['replay', 'evaluation', 'regression'].map((kind, index) => ({ id: `case-${index}`, kind, stdin: `${kind}\n`, expectedStdout: `${kind}\n`, expectedExitCode: 0 })) }
afterEach(async () => { for (const close of closes.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup(container = false, prospective = false, generator: 'order-summary/v1' | 'order-summary/v2' = 'order-summary/v1', maxToolCalls = 4) {
  const root = await mkdtemp(join(tmpdir(), 'holdout-cli-')); roots.push(root)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const prefix = container ? '/authority' : root
  await writeFile(join(root, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  if (!prospective) await writeFile(join(root, 'dataset.json'), JSON.stringify(dataset), { mode: 0o600 })
  await writeFile(join(root, 'config.json'), JSON.stringify({ ...(prospective ? { prospective: { generator } } : { datasetPath: join(prefix, 'dataset.json') }), privateKeyPath: join(prefix, 'key.pem'), statePath: join(prefix, 'state.sqlite'), limits: { maxToolCalls, maxOutputBytes: 16384 } }), { mode: 0o600 })
  return { root, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}
function connect(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const queue: any[] = [], pending: { resolve(value: any): void; reject(error: Error): void }[] = []
  let buffer = '', stderr = '', ended = false, serial = 0
  child.stdout.on('data', chunk => { buffer += String(chunk); let at: number; while ((at = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); const next = pending.shift(); if (next) next.resolve(value); else queue.push(value) } })
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
  const exit = new Promise<number | null>((resolveExit, reject) => { child.on('error', reject); child.on('close', code => { ended = true; for (const next of pending.splice(0)) next.reject(new Error(`authority exit ${code}: ${stderr}`)); resolveExit(code) }) })
  const read = async () => queue.length ? queue.shift() : ended ? Promise.reject(new Error(`authority ended: ${stderr}`)) : new Promise<any>((resolveValue, reject) => { pending.push({ resolve: resolveValue, reject }) })
  const close = async () => { if (!ended) child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 10000); try { await exit } finally { clearTimeout(timer) } }
  closes.push(close)
  return { read, exit, close, async request(operation: string, value?: unknown) { const id = `request-${++serial}`; child.stdin.write(JSON.stringify({ id, operation, ...(value === undefined ? {} : { value }) }) + '\n'); const response = await read(); expect(response.id).toBe(id); return response } }
}
const binding = () => ({ scopeDigest: sha('scope'), baselineDigest: sha('baseline'), candidateDigest: sha('candidate'), budgetDigest: sha('four-tools-zero-model-calls'), expiresAt: Date.now() + 300000, repeats: 2 })
function observation(cell: SignedCell, stdout = cell.stdin) { return { cellId: cell.cellId, armDigest: cell.armDigest, stdout, exitCode: 0, quiescent: true, status: 'completed', artifactDigest: sha('fixture-artifact'), toolCalls: [{ name: 'write', inputDigest: sha('fixture-input'), outputDigest: sha('fixture-output') }] } }

test('operator inspection returns public pins without consuming qualification state', async () => {
  const config = await setup()
  const { stdout } = await exec(process.execPath, [cli, '--inspect-config', join(config.root, 'config.json')])
  expect(JSON.parse(stdout)).toEqual({ publicKey: config.publicKey, datasetDigest: acceptanceDigest(dataset), limits: { maxToolCalls: 4, maxOutputBytes: 16384 } })
  await expect(stat(join(config.root, 'state.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(stdout).not.toMatch(/PRIVATE KEY|expectedStdout|stdin/u)
})

test('installed symbolic-link CLI invokes the operator instead of silently exiting', async () => {
  const config = await setup(false, true, 'order-summary/v2'), link = join(config.root, 'dsh-skill-holdout')
  await symlink(cli, link)
  const { stdout } = await exec(process.execPath, [link, '--inspect-config', join(config.root, 'config.json')])
  expect(JSON.parse(stdout)).toMatchObject({ publicKey: config.publicKey, generatorDigest: prospectiveGeneratorDigest('order-summary/v2') })
  await expect(stat(join(config.root, 'state.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('prospective inspection does not generate a dataset and begin returns a binding certificate', async () => {
  const config = await setup(false, true)
  const { stdout } = await exec(process.execPath, [cli, '--inspect-config', join(config.root, 'config.json')])
  expect(JSON.parse(stdout)).toEqual({ publicKey: config.publicKey, generatorDigest, limits: { maxToolCalls: 4, maxOutputBytes: 16384 } })
  await expect(stat(join(config.root, 'state.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  const client = connect(process.execPath, [cli, '--config', join(config.root, 'config.json')]); await client.read()
  const frozen = binding(), begin = (await client.request('begin', frozen)).value as BeginResult
  expect(begin.prospective).toBeDefined()
  expect(verifyProspectiveCertificate(begin.prospective, frozen, config.publicKey, generatorDigest)).toBe(true)
  expect(begin.datasetDigest).toBe(begin.prospective!.datasetDigest)
  expect(JSON.stringify(begin)).not.toMatch(/expectedStdout|stdin/u)
})

test('v2 inspection pins its generator without consuming state and rejects generator changes on restore', async () => {
  const config = await setup(false, true, 'order-summary/v2'), path = join(config.root, 'config.json')
  const { stdout } = await exec(process.execPath, [cli, '--inspect-config', path])
  expect(JSON.parse(stdout)).toMatchObject({ publicKey: config.publicKey, generatorDigest: prospectiveGeneratorDigest('order-summary/v2') })
  await expect(stat(join(config.root, 'state.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  const client = connect(process.execPath, [cli, '--config', path]); await client.read()
  const frozen = binding(), begin = (await client.request('begin', frozen)).value as BeginResult
  expect(begin.prospective?.generatorDigest).toBe(prospectiveGeneratorDigest('order-summary/v2'))
  expect(verifyProspectiveCertificate(begin.prospective, frozen, config.publicKey, prospectiveGeneratorDigest('order-summary/v2'))).toBe(true)
  await client.close()
  await writeFile(path, JSON.stringify({ prospective: { generator: 'order-summary/v1' }, privateKeyPath: join(config.root, 'key.pem'), statePath: join(config.root, 'state.sqlite'), limits: { maxToolCalls: 4, maxOutputBytes: 16384 } }), { mode: 0o600 })
  const restarted = connect(process.execPath, [cli, '--config', path]); expect(await restarted.exit).toBe(1)
})

test('legacy v1 frozen state resumes without regenerating or losing consumed cells', async () => {
  const config = await setup(false, true), path = join(config.root, 'config.json')
  const client = connect(process.execPath, [cli, '--config', path]); await client.read()
  const begin = (await client.request('begin', binding())).value as BeginResult
  const first = (await client.request('next')).value as SignedCell
  await client.request('record', observation(first, 'intentionally-wrong'))
  await client.close()
  const db = new DatabaseSync(join(config.root, 'state.sqlite'))
  // Version cdf2455 persisted this exact record shape without a generator field.
  db.exec("UPDATE authority SET prospective=json_remove(prospective, '$.generator')")
  db.close()
  const restarted = connect(process.execPath, [cli, '--config', path]); await restarted.read()
  const next = (await restarted.request('next')).value as SignedCell
  expect(next.cellId).toBe('cell-2')
  expect(next.planDigest).toBe(begin.planDigest)
  expect(next.stdin).toBe(first.stdin)
})

test.each([false, true])('switching authority mode cannot reset durable qualification (prospective=%s)', async prospective => {
  const config = await setup(false, prospective), path = join(config.root, 'config.json')
  const client = connect(process.execPath, [cli, '--config', path]); await client.read(); await client.request('begin', binding()); await client.close()
  await writeFile(join(config.root, 'dataset.json'), JSON.stringify(dataset), { mode: 0o600 })
  await writeFile(path, JSON.stringify({ ...(prospective ? { datasetPath: join(config.root, 'dataset.json') } : { prospective: { generator: 'order-summary/v1' } }),
    privateKeyPath: join(config.root, 'key.pem'), statePath: join(config.root, 'state.sqlite'), limits: { maxToolCalls: 4, maxOutputBytes: 16384 } }), { mode: 0o600 })
  const before = new DatabaseSync(join(config.root, 'state.sqlite'))
  const state = before.prepare('SELECT state,prospective FROM authority').get(); before.close()
  const restarted = connect(process.execPath, [cli, '--config', path]); expect(await restarted.exit).toBe(1)
  const after = new DatabaseSync(join(config.root, 'state.sqlite'))
  expect(after.prepare('SELECT state,prospective FROM authority').get()).toEqual(state); after.close()
})

test('failure after durable freeze poisons the prospective plan instead of regenerating samples', async () => {
  const config = await setup(false, true), path = join(config.root, 'config.json')
  const client = connect(process.execPath, [cli, '--config', path]); await client.read()
  const db = new DatabaseSync(join(config.root, 'state.sqlite'))
  db.exec("CREATE TRIGGER fail_generated BEFORE UPDATE OF prospective ON authority WHEN json_extract(NEW.prospective, '$.phase')='generated' BEGIN SELECT RAISE(ABORT, 'injected write failure after freeze'); END")
  expect((await client.request('begin', binding())).ok).toBe(false); expect(await client.exit).toBe(1)
  const frozen = db.prepare('SELECT state,prospective FROM authority').get() as { state: null; prospective: string }
  expect(frozen.state).toBeNull(); expect(JSON.parse(frozen.prospective)).toMatchObject({ phase: 'frozen' })
  // Trusted test fixture expires the dead controller lease; it never alters the frozen binding.
  db.exec('UPDATE authority SET lease_until=0; DROP TRIGGER fail_generated'); db.close()
  const restarted = connect(process.execPath, [cli, '--config', path]); expect(await restarted.exit).toBe(1)
  const recovered = new DatabaseSync(join(config.root, 'state.sqlite'))
  expect(recovered.prepare('SELECT state,prospective FROM authority').get()).toEqual(frozen); recovered.close()
})

test('private CLI persists before replies and signs an independently judged complete report', async () => {
  const config = await setup(), client = connect(process.execPath, [cli, '--config', join(config.root, 'config.json')])
  expect(await client.read()).toMatchObject({ event: 'ready' })
  const frozen = binding(), begin = (await client.request('begin', frozen)).value as BeginResult
  expect(begin.publicKey).toBe(config.publicKey)
  expect(JSON.stringify(begin)).not.toContain('expectedStdout')
  for (let index = 0; index < begin.cellCount; index++) {
    const cell = (await client.request('next')).value as SignedCell
    expect(verifyHoldoutSignature(cell as unknown as Record<string, unknown>, config.publicKey)).toBe(true)
    expect(await client.request('record', observation(cell, cell.armDigest === frozen.baselineDigest ? 'wrong' : cell.stdin))).toMatchObject({ ok: true })
  }
  const receipt = (await client.request('finish')).value as HoldoutReceipt
  expect(receipt.complete).toBe(true)
  expect(verifyHoldoutSignature(receipt as unknown as Record<string, unknown>, config.publicKey)).toBe(true)
  expect(receipt.cellVerdicts.filter(cell => cell.armDigest === frozen.baselineDigest).every(cell => cell.verdict === 'not-achieved')).toBe(true)
  expect(receipt.cellVerdicts.filter(cell => cell.armDigest === frozen.candidateDigest).every(cell => cell.verdict === 'achieved')).toBe(true)
  expect(JSON.stringify(receipt)).not.toMatch(/expectedStdout|stdin|"stdout"/u)
  await client.close()
  const restarted = connect(process.execPath, [cli, '--config', join(config.root, 'config.json')]); await restarted.read()
  expect((await restarted.request('finish')).value).toEqual(receipt)
})

test('only one controller runs and an issued cell becomes unknown across process restart', async () => {
  const config = await setup(), args = [cli, '--config', join(config.root, 'config.json')]
  const client = connect(process.execPath, args); await client.read(); await client.request('begin', binding())
  const other = connect(process.execPath, args)
  expect(await other.exit).toBe(1)
  const first = await client.request('next'); expect(first.ok).toBe(true)
  expect((await client.request('next')).ok).toBe(false)
  await client.close()
  const restarted = connect(process.execPath, args); await restarted.read()
  expect((await restarted.request('next')).value).toBeNull()
  const result = (await restarted.request('finish')).value
  expect(result.complete).toBe(false)
  expect(result.cellVerdicts.every((cell: { verdict: string }) => cell.verdict === 'unknown')).toBe(true)
  expect((await restarted.request('record', observation(first.value))).ok).toBe(false)
})

test('operator config readable by other users is rejected before serving requests', async () => {
  const config = await setup(); await chmod(join(config.root, 'config.json'), 0o644)
  const client = connect(process.execPath, [cli, '--config', join(config.root, 'config.json')]); expect(await client.exit).toBe(1)
})

test.each(['next', 'record'] as const)('recovers a durable %s whose acknowledgement was lost in a real process crash', async operation => {
  const config = await setup(), hook = join(config.root, 'before-ack.mjs')
  // Instrument only stdout, after the production transaction commits; no production fault switch.
  const requestId = operation === 'next' ? 'request-2' : 'request-3'
  await writeFile(hook, `const original = process.stdout.write.bind(process.stdout); process.stdout.write = function(chunk, ...args) { let message; try { message = JSON.parse(String(chunk)) } catch {} if (message?.id === ${JSON.stringify(requestId)} && message.ok) process.kill(process.pid, 'SIGKILL'); return original(chunk, ...args) }`, { mode: 0o600 })
  const client = connect(process.execPath, ['--import', hook, cli, '--config', join(config.root, 'config.json')]); await client.read(); await client.request('begin', binding())
  if (operation === 'next') await expect(client.request('next')).rejects.toThrow(/authority exit/u)
  else { const cell = (await client.request('next')).value; await expect(client.request('record', observation(cell))).rejects.toThrow(/authority exit/u) }
  await client.exit
  await delay(8200) // The real persisted controller lease must expire before takeover.
  const restarted = connect(process.execPath, [cli, '--config', join(config.root, 'config.json')]); await restarted.read()
  if (operation === 'next') {
    expect((await restarted.request('next')).value).toBeNull()
    expect((await restarted.request('finish')).value).toMatchObject({ complete: false, stoppedReason: 'recovered-outstanding' })
  } else {
    const cell = (await restarted.request('next')).value
    expect(cell.cellId).toBe('cell-2')
  }
}, 30000)

const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const authorityImage = process.env.DSH_HOLDOUT_TEST_IMAGE ?? ''
test.skipIf(![image, authorityImage].every(value => /^sha256:[a-f0-9]{64}$/u.test(value)))('separate authority and candidate containers judge real outputs without mounting answers or keys into the candidate', async () => {
  const config = await setup(true, false, 'order-summary/v1', 5), docker = process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', name = `dsh-holdout-test-${randomUUID()}`
  const client = await openHoldoutProcess({ executable: docker, publicKey: config.publicKey, datasetDigest: acceptanceDigest(dataset), args: ['run', '--rm', '-i', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid!()}:${process.getgid!()}`, '--pids-limit', '32', '--memory', '128m', '--cpus', '1', '--mount', `type=bind,source=${resolve(cli, '..')},target=/runtime,readonly`, '--mount', `type=bind,source=${config.root},target=/authority`, '--entrypoint', '/usr/local/bin/node', authorityImage, '/runtime/holdout-cli.js', '--config', '/authority/config.json'] }, new AbortController().signal)
  const stateRoot = await mkdtemp(join(tmpdir(), 'holdout-candidates-')); roots.push(stateRoot)
  const scope = { principalId: 'operator', principalRecordId: 'owner', principalVersion: 1, workspace: '/author-workspace', preset: 'primary' }
  const skill = (content: string) => createDefinition({ protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: { id: 'fixture-source', definition: { version: 1, digest: sha('fixture-definition'), objective: 'Echo stdin.' }, sessionId: 'fixture-session', nativeGoalId: 'fixture-native' }, runId: 'fixture-run', turn: 1,
    acceptance: { contractId: 'fixture-contract', contractDigest: sha('fixture-contract'), receiptDigest: sha('fixture-receipt'), verifiedAt: 1, validUntil: 2 }, steps: [
      { id: 'discover', toolName: 'glob', arguments: { path: scope.workspace, pattern: '*.sh' } },
      { id: 'write', toolName: 'write', arguments: { file_path: 'artifact.sh', content } },
      { id: 'read', toolName: 'read', arguments: { file_path: 'artifact.sh' } },
      { id: 'goal', toolName: 'get_goal', arguments: {} },
    ] }, { name: 'fixture-echo', description: 'Synthetic program comparison; source acceptance is a fixture.' }, ['glob', 'write', 'read', 'get_goal'])
  const operations: string[] = []
  try {
    const result = await qualifyHoldout({ baseline: skill('printf wrong'), candidate: skill('[ ! -e /authority/dataset.json ] && [ ! -e /authority/key.pem ] && [ ! -S /var/run/docker.sock ] && cat'), scope,
      execution: { image, dockerPath: docker, stateRoot, command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'artifact.sh', expiresAt: Date.now() + 180000, repeats: 2, maxToolCalls: 5, maxBytes: 65536, maxOutputBytes: 16384, cellDurationMs: 20000, verificationDurationMs: 10000 },
      expectedDatasetDigest: acceptanceDigest(dataset), pinnedPublicKey: config.publicKey, signal: new AbortController().signal, authorize() {}, transport: { async request(operation, value, signal) { operations.push(operation); return client.transport.request(operation, value, signal) } } })
    expect(result.receipt.complete).toBe(true)
    expect(verifyHoldoutSignature(result.receipt as unknown as Record<string, unknown>, config.publicKey)).toBe(true)
    expect(result.quality).toMatchObject({ candidateChecksPassed: true, evaluationGain: 1, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'unproven' })
    expect(result).toMatchObject({ modelCalls: 0, promotionAuthorized: false })
    expect(operations.filter(value => value === 'record')).toHaveLength(12)
    expect(JSON.stringify(result)).not.toMatch(/expectedStdout|stdin|"stdout"/u)
    if (process.env.DSH_HOLDOUT_TEST_EVIDENCE) await writeFile(process.env.DSH_HOLDOUT_TEST_EVIDENCE, JSON.stringify({ protocol: 'holdout-runtime-test/v1', source: 'explicit synthetic program and source-acceptance fixtures', authorityImage, candidateImage: image, separateContainerMounts: true, candidateProbes: ['authority dataset absent', 'authority key absent', 'Docker socket absent'], operations, result }, null, 2), { mode: 0o600 })
  } finally { await client.close(); await exec(docker, ['rm', '-f', name]).catch(() => {}) }
}, 180000)
