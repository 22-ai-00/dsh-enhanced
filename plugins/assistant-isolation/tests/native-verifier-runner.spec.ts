import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NativeMacVerifierRunner, type NativeMacVerifierRunnerConfig } from '../src/native-verifier-runner.ts'
import { hashNativeMacRuntimeTree, nativeMacRuntimeDigest, verifyNativeMacRuntime } from '../src/native-runtime.ts'
import { IsolationLedger } from '../src/ledger.ts'

const mac = process.platform === 'darwin' ? describe.sequential : describe.skip
let root: string
let config: NativeMacVerifierRunnerConfig

beforeAll(async () => {
  if (process.platform !== 'darwin') return
  root = await realpath(await mkdtemp(join(tmpdir(), 'native-verifier-')))
  const runtimeRoot = join(root, 'runtime')
  const modulesPath = join(runtimeRoot, 'node_modules')
  await mkdir(modulesPath, { recursive: true, mode: 0o700 })
  const nodePath = join(runtimeRoot, 'node')
  const fixtureNode = fileURLToPath(new URL('../../../docs/evidence/macos-native-20261015/node-v24.22.0-darwin-arm64/node', import.meta.url))
  const chosenNode = process.arch === 'arm64' && existsSync(fixtureNode) ? fixtureNode : await realpath(process.execPath)
  await copyFile(chosenNode, nodePath)
  await chmod(nodePath, 0o500)
  const packages = { typescript: 'typescript', cordis: '@deepseek-ai/cordis', tools: '@deepseek-ai/dsh-tools', systemPrompt: '@deepseek-ai/dsh-system-prompt' }
  for (const name of Object.values(packages)) {
    const dir = join(modulesPath, name)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), { mode: 0o600 })
  }
  const info = await lstat(runtimeRoot)
  config = { backend: 'macos-seatbelt', stateRoot: join(root, 'state'), authorityDigest: 'a'.repeat(64), source: 'console.log("native-ok")',
    runtime: { schemaVersion: 1, platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64', nodePath,
      nodeSha256: createHash('sha256').update(await readFile(nodePath)).digest('hex'),
      roots: [{ path: runtimeRoot, dev: info.dev, ino: info.ino, sha256: await hashNativeMacRuntimeTree(runtimeRoot) }],
      modulesPath, versions: { node: chosenNode === fixtureNode ? 'v24.22.0' : process.version, typescript: '1.0.0', cordis: '1.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } },
    expiresAt: Date.now() + 120_000, maxRuns: 8, maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 4096 }
})

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

mac('native persistent verifier', () => {
  test('refuses a marker with a missing ledger instead of rebuilding state', async () => {
    const stateRoot = join(root, 'orphaned-state')
    await mkdir(stateRoot, { mode: 0o700 })
    await writeFile(join(stateRoot, 'native-backend'), 'macos-seatbelt-v1\n', { mode: 0o600 })
    expect(() => new NativeMacVerifierRunner({ ...config, stateRoot })).toThrow('invalid native state binding')
  })

  test('hashes internal links and rejects external links or writable files', async () => {
    const tree = join(root, 'tree')
    await mkdir(join(tree, 'actual'), { recursive: true, mode: 0o700 })
    await writeFile(join(tree, 'actual', 'module.js'), 'ok', { mode: 0o600 })
    await symlink('actual', join(tree, 'linked'))
    expect(await hashNativeMacRuntimeTree(tree)).toMatch(/^[0-9a-f]{64}$/u)
    await symlink(root, join(tree, 'escaped'))
    await expect(hashNativeMacRuntimeTree(tree)).rejects.toThrow('external symlink')
    await rm(join(tree, 'escaped'))
    await link(join(tree, 'actual', 'module.js'), join(tree, 'hardlink.js'))
    await expect(hashNativeMacRuntimeTree(tree)).rejects.toThrow('special or linked file')
    await rm(join(tree, 'hardlink.js'))
    await chmod(join(tree, 'actual', 'module.js'), 0o620)
    await expect(hashNativeMacRuntimeTree(tree)).rejects.toThrow('writable native runtime entry')
  })

  test('runs through pinned runtime and settles from a private receipt; same key does not rerun', async () => {
    const runner = new NativeMacVerifierRunner(config)
    try {
      const signal = new AbortController().signal
      const result = await runner.run('one', [{ path: 'input.txt', content: 'hello' }], '', signal)
      expect(result).toMatchObject({ status: 'succeeded', quiescent: true, stdout: 'native-ok\n' })
      expect(await runner.inspectQuiescence('one')).toBe('quiescent')
      expect(await runner.run('one', [{ path: 'input.txt', content: 'hello' }], '', signal)).toEqual(result)
      expect(await runner.inspectQuiescence('missing')).toBe('unknown')
    } finally { await runner.close() }
  }, 40_000)

  test('reopens an expired grant to read an old receipt without renewing or dispatching', async () => {
    const stateRoot = join(root, 'expired-state')
    const expiresAt = Date.now() + 7_000
    const expiredConfig = { ...config, stateRoot, authorityDigest: '3'.repeat(64), expiresAt,
      maxDurationMs: 2_000, maxTotalDurationMs: 10_000 }
    const first = new NativeMacVerifierRunner(expiredConfig)
    let original
    try {
      original = await first.run('before-expiry', [], '', new AbortController().signal)
      expect(original).toMatchObject({ status: 'succeeded', quiescent: true })
    } finally { await first.close() }
    await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 50)))
    const reopened = new NativeMacVerifierRunner(expiredConfig)
    try {
      expect(await reopened.inspectQuiescence('before-expiry')).toBe('quiescent')
      expect(await reopened.run('before-expiry', [], '', new AbortController().signal)).toEqual(original)
      await expect(reopened.run('after-expiry', [], '', new AbortController().signal)).rejects.toThrow()
      const db = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
      try {
        expect(db.prepare('SELECT COUNT(*) AS count FROM isolation_jobs').get()).toMatchObject({ count: 1 })
        expect(db.prepare("SELECT expires_at FROM isolation_grants WHERE id='verification'").get()).toMatchObject({ expires_at: expiresAt })
      } finally { db.close() }
    } finally { await reopened.close() }
  }, 20_000)

  test('candidate cannot read the ledger or receipt directory', async () => {
    const stateRoot = join(root, 'private-state')
    const source = `import fs from 'node:fs';for(const path of [${JSON.stringify(join(stateRoot, 'ledger.sqlite'))},${JSON.stringify(join(stateRoot, 'receipts'))}]){try{fs.readFileSync(path);console.log('ALLOWED')}catch(error){console.log('DENIED',error.code)}}`
    const runner = new NativeMacVerifierRunner({ ...config, stateRoot, authorityDigest: '2'.repeat(64), source })
    try {
      const result = await runner.run('private', [], '', new AbortController().signal)
      expect(result).toMatchObject({ status: 'succeeded', quiescent: true })
      expect(result.stdout).toBe('DENIED EPERM\nDENIED EPERM\n')
    } finally { await runner.close() }
  }, 30_000)

  test('records bounded output and deadline closures through receipts', async () => {
    for (const [name, source, limit, duration, expected, reason] of [
      ['overflow', 'console.log("X".repeat(1000))', 16, 5_000, 'failed', 'output-limit'],
      ['deadline', 'setInterval(()=>{},1000)', 4096, 1_500, 'timed-out', undefined],
    ] as const) {
      const bounded = { ...config, stateRoot: join(root, `${name}-state`), authorityDigest: name === 'overflow' ? 'e'.repeat(64) : 'f'.repeat(64),
        source, maxOutputBytes: limit, maxDurationMs: duration }
      const runner = new NativeMacVerifierRunner(bounded)
      try {
        const abort = new AbortController()
        const result = await runner.run(name, [], '', abort.signal)
        expect(result).toMatchObject({ status: expected, quiescent: true })
        if (reason) expect(result.reason).toBe(reason)
        expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(limit)
        expect(await runner.inspectQuiescence(name)).toBe('quiescent')
        if (name === 'deadline') {
          abort.abort()
          expect(await runner.run(name, [], '', new AbortController().signal)).toEqual(result)
        }
      } finally { await runner.close() }
    }
  }, 30_000)

  test('a running cancellation closes the child and produces a durable receipt', async () => {
    const stateRoot = join(root, 'cancel-state')
    const runner = new NativeMacVerifierRunner({ ...config, stateRoot, authorityDigest: '1'.repeat(64),
      source: 'setInterval(()=>{},1000)' })
    const abort = new AbortController()
    try {
      const pending = runner.run('cancel-key', [], '', abort.signal)
      const until = Date.now() + 8_000
      let running = false
      while (Date.now() < until) {
        if (existsSync(join(stateRoot, 'ledger.sqlite'))) {
          const db = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
          try { running = (db.prepare("SELECT status FROM isolation_jobs WHERE idempotency_key='cancel-key'").get() as { status?: string } | undefined)?.status === 'running' }
          finally { db.close() }
        }
        if (running) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(running).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 300))
      const db = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
      try {
        const job = db.prepare("SELECT deadline FROM isolation_jobs WHERE idempotency_key='cancel-key'").get() as { deadline: number }
        expect(Date.now()).toBeLessThan(job.deadline)
      } finally { db.close() }
      abort.abort()
      expect(await pending).toMatchObject({ status: 'cancelled', quiescent: true })
      expect(await runner.inspectQuiescence('cancel-key')).toBe('quiescent')
    } finally { await runner.close() }
  }, 30_000)

  test('parent SIGKILL makes detached supervisor kill the candidate and persist a close receipt', async () => {
    const stateRoot = join(root, 'crash-state')
    const crashConfig = { ...config, stateRoot, authorityDigest: 'c'.repeat(64),
      source: 'console.log("candidate-running");setInterval(()=>{},1000)', maxDurationMs: 15_000 }
    const configPath = join(root, 'crash-config.json')
    const driverPath = join(root, 'crash-driver.mjs')
    await writeFile(configPath, JSON.stringify(crashConfig), { mode: 0o600 })
    const runnerModule = fileURLToPath(new URL('../lib/native-verifier-runner.js', import.meta.url))
    await writeFile(driverPath, `import {readFileSync} from 'node:fs'; import {NativeMacVerifierRunner} from ${JSON.stringify(new URL(`file://${runnerModule}`).href)};
      const runner=new NativeMacVerifierRunner(JSON.parse(readFileSync(process.argv[2],'utf8')));
      console.log('driver-ready'); await runner.run('crash-key',[], '',new AbortController().signal);`, { mode: 0o600 })
    const parent = spawn(config.runtime.nodePath, [driverPath, configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    parent.stdout.on('data', data => { stdout += String(data) })
    parent.stderr.on('data', data => { stderr += String(data) })
    const until = Date.now() + 12_000
    let running = false
    while (Date.now() < until) {
      if (existsSync(join(stateRoot, 'ledger.sqlite'))) {
        const db = new DatabaseSync(join(stateRoot, 'ledger.sqlite'), { readOnly: true })
        try { running = (db.prepare("SELECT status FROM isolation_jobs WHERE idempotency_key='crash-key'").get() as { status?: string } | undefined)?.status === 'running' }
        finally { db.close() }
      }
      if (running) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(running, `driver stdout=${stdout} stderr=${stderr}`).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 600))
    parent.kill('SIGKILL')
    await new Promise<void>(resolve => parent.once('close', () => resolve()))
    const receiptDir = join(stateRoot, 'receipts')
    let receipt: { result?: { pid?: number; status?: string; quiescent?: boolean } } | undefined
    const receiptUntil = Date.now() + 8_000
    while (Date.now() < receiptUntil) {
      const names = await readdir(receiptDir).catch(() => [])
      if (names.some(name => name.endsWith('.json'))) {
        receipt = JSON.parse(await readFile(join(receiptDir, names.find(name => name.endsWith('.json'))!), 'utf8'))
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(receipt, `driver stdout=${stdout} stderr=${stderr}`).toMatchObject({ result: { status: 'cancelled', quiescent: true } })
    expect(receipt?.result?.pid).toBeTypeOf('number')
    expect(() => process.kill(receipt!.result!.pid!, 0)).toThrow()
    expect(() => new NativeMacVerifierRunner(crashConfig)).toThrow('controller is owned by another host')
    await new Promise(resolve => setTimeout(resolve, 31_000))
    const recovered = new NativeMacVerifierRunner(crashConfig)
    try { expect(await recovered.inspectQuiescence('crash-key')).toBe('quiescent') }
    finally { await recovered.close() }
  }, 60_000)

  test('dispatched jobs without receipts remain unknown and consume active capacity after restart', async () => {
    const stateRoot = join(root, 'unknown-state')
    const authorityDigest = 'd'.repeat(64)
    const unknownConfig = { ...config, stateRoot, authorityDigest }
    const first = new NativeMacVerifierRunner(unknownConfig)
    await first.close()
    const ledger = new IsolationLedger(join(stateRoot, 'ledger.sqlite'))
    const controller = ledger.claimController('test-controller', 10_000)
    const digest = createHash('sha256').update(JSON.stringify({ backend: 'macos-seatbelt', source: unknownConfig.source,
      runtime: nativeMacRuntimeDigest(unknownConfig.runtime), authority: authorityDigest, files: [], stdin: '' })).digest('hex')
    const lostJobs: Array<{ id: string; requestDigest: string; nativeNonce?: string; nativeResourceId?: string }> = []
    for (const key of ['lost-1', 'lost-2']) {
      const { job } = ledger.prepare({ backend: 'macos-seatbelt', identity: { principalDigest: authorityDigest,
        principalRecordId: `verification:${authorityDigest}`, principalVersion: 1, workspace: stateRoot,
        agentPreset: 'verification' }, sessionId: `authority:${authorityDigest}`, grantId: 'verification',
        idempotencyKey: key, requestDigest: digest, durationMs: 10_000, maxActiveJobs: 2, authority: controller })
      const dispatched = ledger.markDispatched(job.id, job.version, controller)
      lostJobs.push(dispatched)
      ledger.settle(job.id, dispatched.version, { jobId: job.id, status: 'unknown', quiescent: false,
        stdout: '', stderr: '', artifacts: [], reason: 'simulated-supervisor-loss' }, controller)
    }
    ledger.releaseController(controller)
    ledger.close()
    const receiptDir = join(stateRoot, 'receipts')
    await mkdir(receiptDir, { mode: 0o700 })
    for (const [index, job] of lostJobs.entries()) {
      const fake = { schemaVersion: 1, backend: 'macos-seatbelt', jobId: job.id,
        requestDigest: index === 0 ? job.requestDigest : 'f'.repeat(64),
        nonce: index === 0 ? 'wrong-nonce' : job.nativeNonce, nativeResourceId: job.nativeResourceId,
        closed: true, closedAt: Date.now(), result: { status: 'succeeded', quiescent: true, stdout: 'fake', stderr: '', pid: 999999 } }
      await writeFile(join(receiptDir, `${job.id}.json`), JSON.stringify(fake), { mode: 0o600 })
    }
    const restarted = new NativeMacVerifierRunner(unknownConfig)
    try {
      expect(await restarted.inspectQuiescence('lost-1')).toBe('unknown')
      expect(await restarted.inspectQuiescence('lost-2')).toBe('unknown')
      const replay = await restarted.run('lost-1', [], '', new AbortController().signal)
      expect(replay).toMatchObject({ status: 'unknown', quiescent: false })
      await expect(restarted.run('third', [], '', new AbortController().signal)).rejects.toThrow('active isolation job limit')
    } finally { await restarted.close() }
  }, 30_000)

  test('rejects runtime tamper before dispatch with a proven-quiescent failure', async () => {
    const manifest = join(config.runtime.modulesPath, 'typescript', 'package.json')
    await writeFile(manifest, '{"version":"2.0.0"}')
    await expect(verifyNativeMacRuntime(config.runtime)).rejects.toThrow()
    const tampered = { ...config, stateRoot: join(root, 'tampered-state'), authorityDigest: 'b'.repeat(64) }
    const runner = new NativeMacVerifierRunner(tampered)
    try {
      const result = await runner.run('tampered', [], '', new AbortController().signal)
      expect(result).toMatchObject({ status: 'failed', quiescent: true, reason: 'native-preparation-failed' })
      expect(await runner.inspectQuiescence('tampered')).toBe('unknown')
    } finally { await runner.close() }
  }, 40_000)
})
