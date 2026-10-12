import { createHash } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { prepareManagedHostRuntime, readManagedHostRuntime, type ManagedHostRuntimePorts } from '../src/host-runtime.ts'

const SHA_A = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
const SHA_B = `sha512-${Buffer.alloc(64, 2).toString('base64')}`
const created: string[] = []
afterEach(async () => { await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'managed host runtime '))
  created.push(parent)
  const root = join(parent, 'private cache')
  await mkdir(root, { mode: 0o700 })
  let latest = '0.2.0-rc.2'
  let integrity = SHA_A
  let installCount = 0
  let viewCount = 0
  let corruptLock = false
  let escapedLink = false
  let failInstall = false
  let delayMs = 0
  const ports: ManagedHostRuntimePorts = {
    runNpm: async (args, options) => {
      if (args[0] === 'view') {
        viewCount++
        const selected = args[1]?.endsWith('@latest') ? latest : args[1]?.slice('@deepseek-ai/dsh@'.length)
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: selected,
            'dist.integrity': integrity,
            'dist.tarball': `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${selected}.tgz`,
          }),
          stderr: '',
        }
      }
      expect(args[0]).toBe('install')
      expect(args).toContain('--ignore-scripts')
      expect(args).toContain('--no-audit')
      expect(args).toContain('--no-fund')
      expect(args).toContain('--package-lock=true')
      expect(args).not.toContain('--global')
      installCount++
      const stage = options.cwd
      if (delayMs > 0) await new Promise(done => setTimeout(done, delayMs))
      const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      const version = manifest.dependencies['@deepseek-ai/dsh']!
      const packageRoot = join(stage, 'node_modules', '@deepseek-ai', 'dsh')
      await mkdir(join(packageRoot, 'lib'), { recursive: true })
      await mkdir(join(stage, 'node_modules', '.bin'), { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
      await writeFile(join(packageRoot, 'lib', 'bin.js'), `#!/usr/bin/env node\nconsole.log('${version}')\n`, { mode: 0o755 })
      await symlink(escapedLink ? '/tmp' : '../@deepseek-ai/dsh/lib/bin.js', join(stage, 'node_modules', '.bin', 'dsh'))
      await writeFile(join(stage, 'package-lock.json'), JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@deepseek-ai/dsh': version } },
          'node_modules/@deepseek-ai/dsh': {
            version,
            integrity: corruptLock ? SHA_B : integrity,
            resolved: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`,
          },
        },
      }))
      if (failInstall) return { exitCode: 42, stdout: '', stderr: 'npm error code EAUTH npm_token=secret' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  return {
    root, ports,
    counts: () => ({ viewCount, installCount }),
    setLatest: (value: string) => { latest = value },
    setIntegrity: (value: string) => { integrity = value },
    corruptLock: () => { corruptLock = true },
    escapedLink: () => { escapedLink = true },
    failInstall: () => { failInstall = true },
    setDelay: (value: number) => { delayMs = value },
  }
}

describe('private managed DSH runtime', () => {
  test('installs exact latest once, verifies executable and reuses the local receipt', async () => {
    const f = await fixture()
    const first = await prepareManagedHostRuntime({ root: f.root }, f.ports)
    expect(first.version).toBe('0.2.0-rc.2')
    expect(first.integrity).toBe(SHA_A)
    expect(first.dshPath).toBe(join(first.binDirectory, 'dsh'))
    expect(first.root).toBe(join(f.root, first.version))
    expect(first.receiptDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(f.counts()).toEqual({ viewCount: 1, installCount: 1 })
    const offline = await readManagedHostRuntime({ root: f.root, version: first.version })
    expect(offline).toEqual(first)
    const again = await prepareManagedHostRuntime({ root: f.root }, f.ports)
    expect(again).toEqual(first)
    expect(f.counts()).toEqual({ viewCount: 2, installCount: 1 })
  })

  test('a moving latest tag cannot replace a cached validated runtime with an old version', async () => {
    const f = await fixture()
    const first = await prepareManagedHostRuntime({ root: f.root }, f.ports)
    f.setLatest('0.1.5-rc.4')
    await expect(prepareManagedHostRuntime({ root: f.root }, f.ports)).rejects.toThrow(/unsupported DSH version/u)
    expect(await readManagedHostRuntime({ root: f.root, version: first.version })).toEqual(first)
    expect(f.counts()).toEqual({ viewCount: 2, installCount: 1 })
  })

  test('an explicit supported version is resolved and installed without following latest', async () => {
    const f = await fixture()
    f.setLatest('0.1.5-rc.4')
    const exact = await prepareManagedHostRuntime({ root: f.root, selector: '0.2.0-rc.2' }, f.ports)
    expect(exact.version).toBe('0.2.0-rc.2')
    expect(f.counts()).toEqual({ viewCount: 1, installCount: 1 })
  })

  test.each(['0.1.5-rc.3', '0.1.5'])('reads a verified legacy %s receipt without selecting it for a new install', async legacyVersion => {
    const f = await fixture()
    const current = await prepareManagedHostRuntime({ root: f.root }, f.ports)
    const legacyRoot = join(f.root, legacyVersion)
    await cp(current.root, legacyRoot, { recursive: true, verbatimSymlinks: true })
    const changedPaths = ['package.json', 'package-lock.json', 'node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-ai/dsh/lib/bin.js']
    for (const path of changedPaths) {
      const target = join(legacyRoot, path)
      await writeFile(target, (await readFile(target, 'utf8')).replaceAll(current.version, legacyVersion))
    }
    const receiptPath = join(legacyRoot, 'receipt.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      version: string; tarball: string; entries: Array<{ path: string; sha256?: string }>
    }
    receipt.version = legacyVersion
    receipt.tarball = receipt.tarball.replace(current.version, legacyVersion)
    for (const entry of receipt.entries) {
      if (changedPaths.includes(entry.path)) entry.sha256 = createHash('sha256').update(await readFile(join(legacyRoot, entry.path))).digest('hex')
    }
    await writeFile(receiptPath, JSON.stringify(receipt) + '\n')
    const legacy = await readManagedHostRuntime({ root: f.root, version: legacyVersion })
    expect(legacy.version).toBe(legacyVersion)
    expect(legacy.integrity).toBe(SHA_A)
    await expect(prepareManagedHostRuntime({ root: f.root, selector: legacyVersion }, f.ports)).rejects.toThrow(/unsupported DSH version/u)
    expect(f.counts().installCount).toBe(1)
  })

  test('rejects beta, next and unvalidated versions before installing', async () => {
    const f = await fixture()
    for (const selector of ['next', '0.1.5-rc.3', '0.1.5', '0.1.7-rc.2', '0.2.0-alpha.1', '0.2.0-rc.1', '0.2.0-rc.3', '0.2.0', '0.3.0-rc.1']) {
      await expect(prepareManagedHostRuntime({ root: f.root, selector }, f.ports)).rejects.toThrow(/unsupported DSH version/u)
    }
    f.setLatest('0.1.7-rc.2')
    await expect(prepareManagedHostRuntime({ root: f.root }, f.ports)).rejects.toThrow(/unsupported DSH version/u)
    expect(f.counts().installCount).toBe(0)
  })

  test('detects changed package bytes and changed registry integrity without repairing existing version', async () => {
    const f = await fixture()
    const runtime = await prepareManagedHostRuntime({ root: f.root }, f.ports)
    f.setIntegrity(SHA_B)
    await expect(prepareManagedHostRuntime({ root: f.root }, f.ports)).rejects.toThrow(/integrity differs/u)
    f.setIntegrity(SHA_A)
    await writeFile(join(runtime.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\nconsole.log("tampered")\n')
    await expect(readManagedHostRuntime({ root: f.root, version: runtime.version })).rejects.toThrow(/inventory changed/u)
    await expect(prepareManagedHostRuntime({ root: f.root }, f.ports)).rejects.toThrow(/inventory changed/u)
    expect(f.counts().installCount).toBe(1)
  })

  test('rejects incorrect lock integrity and escaping symlinks before executable runs', async () => {
    const badLock = await fixture()
    badLock.corruptLock()
    await expect(prepareManagedHostRuntime({ root: badLock.root }, badLock.ports)).rejects.toThrow(/package-lock DSH resolution/u)
    expect((await readdir(badLock.root)).filter(name => name.startsWith('.stage-'))).toEqual([])
    const badLink = await fixture()
    badLink.escapedLink()
    await expect(prepareManagedHostRuntime({ root: badLink.root }, badLink.ports)).rejects.toThrow(/symlink escapes runtime/u)
    expect((await readdir(badLink.root)).filter(name => name.startsWith('.stage-'))).toEqual([])
  })

  test('failed install never publishes partial runtime and omits sensitive stderr', async () => {
    const f = await fixture()
    f.failInstall()
    await expect(prepareManagedHostRuntime({ root: f.root }, f.ports)).rejects.toThrow(/npm install failed \(exit 42, EAUTH\)/u)
    expect((await readdir(f.root)).filter(name => name.startsWith('.stage-') || name === '0.2.0-rc.2')).toEqual([])
  })

  test('an already cancelled request never contacts npm or publishes a runtime', async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(prepareManagedHostRuntime({ root: f.root, signal: controller.signal }, f.ports)).rejects.toThrow(/cancelled/u)
    expect(f.counts()).toEqual({ viewCount: 0, installCount: 0 })
  })

  test('concurrent callers install once and both receive the same verified runtime', async () => {
    const f = await fixture()
    f.setDelay(120)
    const [first, second] = await Promise.all([
      prepareManagedHostRuntime({ root: f.root }, f.ports),
      prepareManagedHostRuntime({ root: f.root }, f.ports),
    ])
    expect(first).toEqual(second)
    expect(f.counts().installCount).toBe(1)
  })
})
