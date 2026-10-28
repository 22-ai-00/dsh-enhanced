import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
