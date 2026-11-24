import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { behaviorSha256, extractLinuxBehaviorAsset, LINUX_BEHAVIOR_COMMAND, LINUX_BEHAVIOR_COMPILE_FLAGS,
  LINUX_BEHAVIOR_MAPPINGS, loadLinuxBehaviorAssets, readBehaviorFile } from '../src/linux-behavior-assets.js'

describe('published Linux behavior assets', () => {
  it.runIf(process.platform === 'linux')('ships the original C bytes and maps exactly the Docker worker source', async () => {
    const original = await readFile(new URL('../../../scripts/isolation/plugin-observer-launcher.c', import.meta.url))
    expect(await readFile(new URL('../runtime/plugin-observer-launcher.c', import.meta.url))).toEqual(original)
    const raw = await readFile(new URL('../lib/plugin-behavior-runner.js', import.meta.url), 'utf8')
    const worker = extractLinuxBehaviorAsset(raw, 'WORKER'), candidate = extractLinuxBehaviorAsset(raw, 'CANDIDATE')
    const assets = await loadLinuxBehaviorAssets()
    const map = (source: string): string => LINUX_BEHAVIOR_MAPPINGS.reduce((value, [from, to]) => value.replaceAll(from, to), source)
    expect(assets.worker).toBe(map(worker)); expect(assets.candidate).toBe(map(candidate))
    expect(assets.launcher).toBe(map(original.toString('utf8')))
    expect(assets.sourceSha256).toBe(behaviorSha256(JSON.stringify({ schemaVersion: 1,
      workerSha256: behaviorSha256(worker), candidateSha256: behaviorSha256(candidate),
      launcherSourceSha256: behaviorSha256(original), mapping: LINUX_BEHAVIOR_MAPPINGS,
      command: LINUX_BEHAVIOR_COMMAND, compileFlags: LINUX_BEHAVIOR_COMPILE_FLAGS })))
    expect(assets.worker).toContain("stdio: ['pipe', 'ignore', 'ignore', 'pipe']")
    expect(assets.launcher).toContain('PR_SET_DUMPABLE, 0')
    expect(assets.launcher).toContain('BLOCK(__NR_ptrace)')
    expect(assets.launcher).toContain('"--permission", "--disable-sigusr1"')
    expect(assets.launcher).toContain('"--allow-fs-read=/runtime/0/node_modules"')
    expect(assets.launcher).toContain('"--allow-fs-read=/runtime/0/dsh-plugin-verifier/node_modules"')
    expect(assets.launcher).not.toContain('"--allow-fs-read=/runtime/0"')
    expect(Buffer.byteLength(worker)).toBeLessThan(32 * 1024)
    expect(Buffer.byteLength(candidate)).toBeLessThan(32 * 1024)
    expect(Buffer.byteLength(raw)).toBeLessThan(256 * 1024)
    expect(assets.worker).toContain('parsePatchMeta')
    expect(assets.candidate).toContain('service_lifecycle_probe')
    expect(assets.candidate).toContain('channel_readiness_probe')
    expect(assets.candidate).toContain('ui_declaration_probe')
  })

  it('extracts package.json and cordis.patch.yml metadata in worker.mjs for candidate.mjs', async () => {
    const raw = await readFile(new URL('../lib/plugin-behavior-runner.js', import.meta.url), 'utf8')
    const worker = extractLinuxBehaviorAsset(raw, 'WORKER')
    const candidate = extractLinuxBehaviorAsset(raw, 'CANDIDATE')
    expect(worker).toContain('readPackageMeta')
    expect(worker).toContain('package/cordis.patch.yml')
    expect(worker).toContain('meta')
    expect(candidate).toContain('request.meta')
    expect(candidate).not.toContain('cordis.patch.yml')
  })

  it('rejects missing, duplicate, inverted and oversized markers', () => {
    const begin = '/* DSH_PLUGIN_VERIFIER_WORKER_START\n', end = '\nDSH_PLUGIN_VERIFIER_WORKER_END */'
    expect(extractLinuxBehaviorAsset(begin + 'x' + end, 'WORKER')).toBe('x\n')
    for (const raw of ['', begin + 'x', begin + begin + end, begin + end + end, end + begin + end,
      begin + 'x'.repeat(32 * 1024) + end, 'x'.repeat(256 * 1024 + 1)]) {
      expect(() => extractLinuxBehaviorAsset(raw, 'WORKER')).toThrow()
    }
  })

  it.runIf(process.platform === 'linux')('bounds reads and rejects a symlink rather than reading its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linux-behavior-assets-'))
    try {
      const file = join(root, 'source')
      await writeFile(file, 'private', { mode: 0o444 })
      await symlink('source', join(root, 'link'))
      expect((await readBehaviorFile(file, 7)).toString()).toBe('private')
      await expect(readBehaviorFile(file, 6)).rejects.toThrow('unsafe')
      await expect(readBehaviorFile(join(root, 'link'), 7)).rejects.toThrow('unsafe')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.runIf(process.platform === 'linux')('enforces UI stub, typert disposal, channel provision, and hybrid disposal checks in Linux worker+candidate', async () => {
    const raw = await readFile(new URL('../lib/plugin-behavior-runner.js', import.meta.url), 'utf8')
    const rawWorker = extractLinuxBehaviorAsset(raw, 'WORKER')
    const rawCandidate = extractLinuxBehaviorAsset(raw, 'CANDIDATE')
    const modulesPath = fileURLToPath(new URL('../node_modules', import.meta.url))

    const pack = (entries: Record<string, string>): Buffer => {
      const records: Buffer[] = []
      for (const [name, content] of Object.entries(entries)) {
        const bytes = Buffer.from(content), header = Buffer.alloc(512)
        header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
        header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
        header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
        header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
        records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
      }
      return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
    }

    const runLinuxAssets = async (tgz: Buffer, pluginKind?: string) => {
      const root = await mkdtemp(join(tmpdir(), 'linux-assets-exec-'))
      try {
        const candidatePath = join(root, 'candidate.mjs')
        const workerPath = join(root, 'worker.mjs')
        await symlink(modulesPath, join(root, 'node_modules'))
        const pkgRootEscaped = join(root, 'plugin/package/lib/').replaceAll('/', '\\/')
        const patchedCandidate = rawCandidate.replace(
          '/^\\/workspace\\/plugin\\/package\\/lib\\/[A-Za-z0-9._/-]+\\.js$/',
          `/^${pkgRootEscaped}[A-Za-z0-9._/-]+\\.js$/`,
        )
        expect(patchedCandidate).not.toBe(rawCandidate)
        const patchedWorker = rawWorker
          .replaceAll("'/workspace/plugin/package'", JSON.stringify(join(root, 'plugin/package')))
          .replaceAll("'/workspace/plugin'", JSON.stringify(join(root, 'plugin')))
          .replaceAll("'/workspace/artifact'", JSON.stringify(join(root, 'artifact')))
          .replaceAll("'/workspace/input'", JSON.stringify(join(root, 'input')))
          .replaceAll("'/opt/dsh-plugin-verifier/node_modules/'", JSON.stringify(modulesPath + '/'))
          .replaceAll("'/opt/dsh-plugin-verifier/node_modules'", JSON.stringify(modulesPath))
          .replace("spawn('/opt/dsh-plugin-verifier/candidate-launcher', [], {", `spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(candidatePath)}], {`)
        await writeFile(candidatePath, patchedCandidate, 'utf8')
        await writeFile(workerPath, patchedWorker, 'utf8')
        await writeFile(join(root, 'artifact'), tgz.toString('base64'), 'utf8')
        await writeFile(join(root, 'input'), JSON.stringify({
          schemaVersion: 1,
          sha256: createHash('sha256').update(tgz).digest('hex'),
          sizeBytes: tgz.length,
          operation: { kind: 'discover' },
          ...(pluginKind !== undefined ? { pluginKind } : {}),
        }), 'utf8')
        const res = spawnSync(process.execPath, [workerPath], { cwd: root, encoding: 'utf8', timeout: 15_000 })
        expect(res.status).toBe(0)
        return JSON.parse(res.stdout.trim()) as Record<string, unknown>
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    // 1. Empty UI stubs & false cordis.patch.yml config:\n  ui: false rejected
    const stubTypert = pack({
      'package/package.json': JSON.stringify({ name: 'linux-stub-typert', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/lib/index.js': 'export const TYPERT = {}\nexport function apply() {}',
    })
    expect(await runLinuxAssets(stubTypert)).toMatchObject({ status: 'unknown', reason: 'invalid-tool-schemas' })
    expect(await runLinuxAssets(stubTypert, 'ui')).toMatchObject({ status: 'unknown', reason: 'invalid-ui-plugin' })

    const falsePatch = pack({
      'package/package.json': JSON.stringify({ name: 'linux-false-patch', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/cordis.patch.yml': '- insert:\n  - id: linux-false-patch\n    name: linux-false-patch\n    config:\n      ui: false\n',
      'package/lib/index.js': 'export function apply() {}',
    })
    expect(await runLinuxAssets(falsePatch)).toMatchObject({ status: 'unknown', reason: 'invalid-service-plugin' })
    expect(await runLinuxAssets(falsePatch, 'ui')).toMatchObject({ status: 'unknown', reason: 'invalid-ui-plugin' })

    // 2. typertContributions disposal leak rejected with plugin-disposal-unconfirmed (while ctx.typert.register succeeds)
    const leakTypert = pack({
      'package/package.json': JSON.stringify({ name: 'linux-leak-typert', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/lib/index.js': `
        export const inject = ['typert']
        export function apply(ctx) {
          ctx.root.typert.register({
            package: 'linux-leak-typert', face: 'host',
            schemas: { s: { type: 'object' } }, model: { services: [], events: [], objects: [] }, invocations: [],
          })
        }
      `,
    })
    expect(await runLinuxAssets(leakTypert, 'ui')).toMatchObject({ status: 'unknown', reason: 'plugin-disposal-unconfirmed' })

    const cleanTypert = pack({
      'package/package.json': JSON.stringify({ name: 'linux-clean-typert', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/lib/index.js': `
        export const inject = ['typert']
        export function apply(ctx) {
          ctx.typert.register({
            package: 'linux-clean-typert', face: 'host',
            schemas: { s: { type: 'object' } }, model: { services: [], events: [], objects: [] }, invocations: [],
          })
        }
      `,
    })
    expect(await runLinuxAssets(cleanTypert, 'ui')).toMatchObject({ status: 'observed', pluginKind: 'ui' })

    // 3. Incomplete channel service provision rejected when 'channel', and not misclassified as 'channel' when omitted
    const fakeChan = pack({
      'package/package.json': JSON.stringify({ name: 'linux-fake-chan', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/lib/index.js': `export function apply(ctx) { ctx.provide('fakeChan', { send() {} }) }`,
    })
    expect(await runLinuxAssets(fakeChan, 'channel')).toMatchObject({ status: 'unknown', reason: 'invalid-channel-plugin' })
    expect((await runLinuxAssets(fakeChan)).pluginKind).not.toBe('channel')

    // 4. Hybrid 'tool' + leaked assistantDelivery.registerAdapter rejected with plugin-disposal-unconfirmed
    const hybridLeak = pack({
      'package/package.json': JSON.stringify({ name: 'linux-hybrid-leak', version: '1.0.0', type: 'module', main: './lib/index.js' }),
      'package/lib/index.js': `
        export const inject = ['tools', 'assistantDelivery']
        export function apply(ctx) {
          ctx.tools.register({
            name: 'ping', description: 'Ping',
            parameters: { type: 'object', properties: {} },
            output: { schema: { type: 'object' }, render: v => [{ type: 'text', text: JSON.stringify(v) }] },
            execute: async () => ({ ok: true }),
          })
          ctx.get('assistantDelivery').registerAdapter({
            channel: 'c', account: 'a', capabilities: {}, start: async () => {}, send: async () => ({ ok: true }),
          })
        }
      `,
    })
    expect(await runLinuxAssets(hybridLeak)).toMatchObject({ status: 'unknown', reason: 'plugin-disposal-unconfirmed' })
  })
})
