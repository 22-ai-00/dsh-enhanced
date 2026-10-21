import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runNativeMacProcess, type NativeMacProcessInput } from '../src/native-macos.ts'

const mac = process.platform === 'darwin' ? describe.sequential : describe.skip
let root: string
let workspace: string
let outside: string
let input: NativeMacProcessInput

beforeAll(async () => {
  if (process.platform !== 'darwin') return
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-mac-')))
  workspace = await realpath(await mkdtemp(join(root, 'worker-')))
  await chmod(workspace, 0o700)
  outside = join(root, 'outside.txt')
  await writeFile(outside, 'CANARY', { mode: 0o600 })
  const nodePath = await realpath(process.execPath)
  const runtimeRoot = nodePath.includes('/Cellar/') ? nodePath.split('/Cellar/')[0]! : dirname(nodePath)
  const runtime = await lstat(runtimeRoot)
  input = { workspacePath: workspace, nodePath,
    nodeSha256: createHash('sha256').update(await readFile(nodePath)).digest('hex'),
    runtimeReadRoots: [{ path: runtimeRoot, dev: runtime.dev, ino: runtime.ino }], source: 'console.log("ok")',
    deadline: Date.now() + 20_000, maxOutputBytes: 4096, signal: new AbortController().signal }
})

afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function run(source: string, overrides: Partial<NativeMacProcessInput> = {}) {
  return await runNativeMacProcess({ ...input, source, deadline: Date.now() + 20_000, ...overrides })
}

function processDiagnostic(result: Awaited<ReturnType<typeof run>>) {
  return JSON.stringify({ status: result.status, reason: result.reason, pid: result.pid, exitCode: result.exitCode })
}

mac('native macOS deny-default process', () => {
  test('runs one Node process with a clean environment and a private writable workspace', async () => {
    const result = await run('const fs=require("node:fs");fs.writeFileSync("made.txt","yes");console.log(process.env.HOME, process.env.NODE_OPTIONS || "clean", process.pid)', { workspaceWritable: true })
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0 })
    expect(result.stdout).toContain(`${workspace} clean ${result.pid}`)
    expect(await readFile(join(workspace, 'made.txt'), 'utf8')).toBe('yes')
  })

  test('denies external read/write and symlink escape', async () => {
    const result = await run(`const fs=require('node:fs');for(const p of [${JSON.stringify(outside)},'../outside.txt']){for(const op of ['read','write']){try{op==='read'?fs.readFileSync(p):fs.writeFileSync(p,'BAD');console.log('ALLOWED',p,op)}catch(e){console.log('DENIED',op,e.code)}}}`, { workspaceWritable: true })
    expect(result.status).toBe('succeeded')
    expect(result.stdout).not.toContain('ALLOWED')
    expect(result.stdout.match(/DENIED/g)?.length).toBe(4)
    expect(await readFile(outside, 'utf8')).toBe('CANARY')
    await symlink(outside, join(workspace, 'escape'))
    try { expect(await run('console.log("FORBIDDEN")')).toMatchObject({ status: 'failed', reason: 'unsafe-workspace-tree' }) }
    finally { await rm(join(workspace, 'escape')) }
    await link(outside, join(workspace, 'hardlink'))
    try { expect(await run('console.log("FORBIDDEN")')).toMatchObject({ status: 'failed', reason: 'unsafe-workspace-tree' }) }
    finally { await rm(join(workspace, 'hardlink')) }
  })

  test('a writable candidate cannot use new links to modify an approved read root', async () => {
    const readRoot = await realpath(await mkdtemp(join(root, 'approved-read-')))
    const canary = join(readRoot, 'canary.txt')
    await writeFile(canary, 'READ-ONLY', { mode: 0o600 })
    const info = await lstat(readRoot)
    const readRoots = [...input.runtimeReadRoots, { path: readRoot, dev: info.dev, ino: info.ino }]
    const result = await run(`const fs=require('node:fs');const p=${JSON.stringify(canary)};for(const [kind,make] of [['symlink',()=>fs.symlinkSync(p,'new-symlink')],['hardlink',()=>fs.linkSync(p,'new-hardlink')]]){try{make();console.log(kind,'created');try{fs.writeFileSync('new-'+kind,'BAD');console.log(kind,'WRITE-ALLOWED')}catch(e){console.log(kind,'WRITE-DENIED',e.code)}}catch(e){console.log(kind,'CREATE-DENIED',e.code)}}`, { runtimeReadRoots: readRoots, workspaceWritable: true })
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true })
    expect(result.stdout).toContain('symlink')
    expect(result.stdout).toContain('hardlink')
    expect(result.stdout).not.toContain('WRITE-ALLOWED')
    expect(await readFile(canary, 'utf8')).toBe('READ-ONLY')
    await rm(join(workspace, 'new-symlink'), { force: true })
    await rm(join(workspace, 'new-hardlink'), { force: true })
  })

  test('imports an approved deep module from a nested workspace without reading ancestor or sibling contents', async () => {
    const nestedWorkspace = await realpath(await mkdtemp(join(workspace, 'nested-worker-')))
    const approved = await realpath(await mkdtemp(join(root, 'approved-module-')))
    const moduleDir = join(approved, 'pkg', 'deep')
    await mkdir(moduleDir, { recursive: true })
    await writeFile(join(moduleDir, 'value.mjs'), 'export const value = "approved-module"')
    await writeFile(join(moduleDir, 'entry.mjs'), 'export { value } from "./value.mjs"')
    const parentCanary = join(workspace, 'parent-canary.txt')
    const siblingCanary = join(root, 'sibling-canary.txt')
    await writeFile(parentCanary, 'PARENT-SECRET')
    await writeFile(siblingCanary, 'SIBLING-SECRET')
    const info = await lstat(approved)
    const source = `const fs=require('node:fs');const os=require('node:os');import(${JSON.stringify(pathToFileURL(join(moduleDir, 'entry.mjs')).href)}).then(m=>{console.log('MODULE',m.value,'OS',os.type());for(const p of [${JSON.stringify(parentCanary)},${JSON.stringify(siblingCanary)}]){try{console.log('CONTENT',fs.readFileSync(p,'utf8'))}catch(e){console.log('DENIED',e.code)}}try{console.log('LIST',fs.readdirSync(${JSON.stringify(root)}))}catch(e){console.log('LIST-DENIED',e.code)}console.log('ROOT-LISTED',fs.readdirSync('/').includes('Users'))})`
    const result = await run(source, { workspacePath: nestedWorkspace,
      runtimeReadRoots: [...input.runtimeReadRoots, { path: approved, dev: info.dev, ino: info.ino }] })
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true })
    expect(result.stdout).toContain('MODULE approved-module OS Darwin')
    expect(result.stdout.match(/^DENIED EPERM$/gm)?.length).toBe(2)
    expect(result.stdout).toContain('LIST-DENIED EPERM')
    expect(result.stdout).toContain('ROOT-LISTED true')
    expect(result.stdout).not.toContain('SECRET')
  })

  test('workspace is read-only by default', async () => {
    const result = await run('try{require("node:fs").writeFileSync("default-denied","x");console.log("ALLOWED")}catch(e){console.log(e.code)}')
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true })
    expect(result.stdout.trim()).toBe('EPERM')
  })

  test('cannot signal a separate self-created host process', async () => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => { sentinel.once('spawn', resolve); sentinel.once('error', reject) })
    try {
      const result = await run(`try{process.kill(${sentinel.pid},'SIGTERM');console.log('ALLOWED')}catch(e){console.log('DENIED',e.code)}`)
      expect(result.quiescent).toBe(true)
      expect(result.stdout).toContain('DENIED EPERM')
      expect(sentinel.exitCode).toBeNull()
    } finally {
      sentinel.kill('SIGKILL')
      await new Promise<void>(resolve => sentinel.once('close', () => resolve()))
    }
  })

  test('denies socket and process creation', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    try {
      if (!address || typeof address === 'string') throw new Error('unexpected-address')
      const result = await run(`const net=require('node:net');const s=net.connect(${address.port},'127.0.0.1');s.on('error',e=>console.log('NETWORK',e.code));s.on('connect',()=>{console.log('NETWORK connected');s.destroy()})`)
      expect(result.quiescent).toBe(true)
      expect(result.stdout).not.toContain('NETWORK connected')
      expect(result.stdout).toContain('NETWORK EPERM')
      // spawnSync can return an error object instead of throwing.
      const fork = await run('const p=require("node:child_process").spawnSync(process.execPath,["-e","0"]);console.log(p.error?.code || p.status)')
      expect(fork.quiescent).toBe(true)
      expect(fork.stdout).toContain('EPERM')
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  test('fails closed on executable receipt mismatch', async () => {
    const result = await run('console.log("FORBIDDEN")', { nodeSha256: '0'.repeat(64) })
    expect(result).toMatchObject({ status: 'failed', quiescent: true, reason: 'node-receipt-mismatch' })
    const root = input.runtimeReadRoots[0]!
    const displaced = await run('console.log("FORBIDDEN")', { runtimeReadRoots: [{ ...root, ino: root.ino + 1 }] })
    expect(displaced).toMatchObject({ status: 'failed', quiescent: true, reason: 'invalid-runtime-read-roots' })
  })

  test('a running process reaches its deadline and closes', async () => {
    const timed = await run('process.stdout.write("ready\\n");setInterval(()=>{},1000)',
      { deadline: Date.now() + 5_000 })
    expect(timed, processDiagnostic(timed)).toMatchObject({ status: 'timed-out', quiescent: true })
    expect(timed.stdout).toContain('ready\n')
    expect(timed.pid).toBeTypeOf('number')
    expect(() => process.kill(timed.pid!, 0)).toThrow()
  }, 12_000)

  test('an expired pre-spawn deadline fails without a process', async () => {
    const result = await run('process.stdout.write("FORBIDDEN")', { deadline: Date.now() - 1 })
    expect(result).toMatchObject({ status: 'failed', quiescent: true, reason: 'invalid-deadline' })
    expect(result.pid).toBeUndefined()
    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toBe('')
  })

  test('cancels a confirmed running process and closes it', async () => {
    const marker = join(workspace, 'ready-cancel.txt')
    await rm(marker, { force: true })
    const controller = new AbortController()
    const pending = run('require("node:fs").writeFileSync("ready-cancel.txt","ready");setInterval(()=>{},1000)',
      { signal: controller.signal, workspaceWritable: true, deadline: Date.now() + 10_000 })
    let cancelled!: Awaited<ReturnType<typeof run>>
    try {
      const limit = Date.now() + 5_000
      while (Date.now() < limit && await readFile(marker, 'utf8').catch(() => undefined) !== 'ready') {
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
      expect(await readFile(marker, 'utf8')).toBe('ready')
    } finally {
      controller.abort()
      try { cancelled = await pending }
      finally { await rm(marker, { force: true }) }
    }
    expect(cancelled, processDiagnostic(cancelled)).toMatchObject({ status: 'cancelled', quiescent: true })
    expect(cancelled.pid).toBeTypeOf('number')
    expect(() => process.kill(cancelled.pid!, 0)).toThrow()
  }, 12_000)

  test('output overflow closes the process', async () => {
    const overflow = await run('process.stdout.write("x".repeat(100000))', { maxOutputBytes: 16 })
    expect(overflow).toMatchObject({ status: 'output-limit', quiescent: true })
    expect(overflow.pid).toBeTypeOf('number')
    expect(() => process.kill(overflow.pid!, 0)).toThrow()
  })

  test('invalid UTF-8 never expands the combined output byte limit', async () => {
    const invalid = await run('process.stdout.write(Buffer.alloc(1024,0xff))', { maxOutputBytes: 16 })
    expect(invalid).toMatchObject({ status: 'output-limit', quiescent: true, stdout: '', reason: 'invalid-utf8-output' })
    const truncated = await run('process.stdout.write(Buffer.from("😀"))', { maxOutputBytes: 3 })
    expect(truncated).toMatchObject({ status: 'output-limit', quiescent: true, stdout: '', reason: 'invalid-utf8-output' })
    const mixed = await run('process.stdout.write("12345678");process.stderr.write("é".repeat(100))', { maxOutputBytes: 17 })
    expect(mixed.quiescent).toBe(true)
    expect(Buffer.byteLength(mixed.stdout) + Buffer.byteLength(mixed.stderr)).toBeLessThanOrEqual(17)
    const malformed = await run('process.stdout.write(Buffer.from([0xff]))')
    expect(malformed).toMatchObject({ status: 'failed', quiescent: true, stdout: '', reason: 'invalid-utf8-output' })
  })

  test('oversized source fails before spawn', async () => {
    const result = await run(' '.repeat(65_537))
    expect(result).toMatchObject({ status: 'failed', quiescent: true, reason: 'invalid-source' })
    expect(result.pid).toBeUndefined()
    const nul = await run('console.log(1)\0')
    expect(nul).toMatchObject({ status: 'failed', quiescent: true, reason: 'invalid-source' })
    expect(nul.pid).toBeUndefined()
  })
})
