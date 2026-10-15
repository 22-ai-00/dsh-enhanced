import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'
import { prepareNativeRsiRuntime, readNativeRsiRuntime } from '../src/rsi-native-runtime-bootstrap.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const nodeArchivePath = process.env.DSH_TEST_NATIVE_NODE_ARCHIVE
const pnpmArchivePath = process.env.DSH_TEST_NATIVE_PNPM_ARCHIVE

test.runIf(process.platform === 'darwin' && nodeArchivePath && pnpmArchivePath)(
  'installs frozen manifests with official Node and pnpm, replays exactly and rejects runtime drift', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-runtime-')))
    roots.push(root)
    const dshHome = join(root, 'home'), profile = 'runtime-test'
    await mkdir(dshHome, { mode: 0o700 })
    const repository = resolve(import.meta.dirname, '../../..')
    const version = JSON.parse(execFileSync('/usr/bin/git', ['show', 'HEAD:package.json'], { cwd: repository, encoding: 'utf8' })).version as string
    const source = await prepareRsiSourceWorkspace({ dshHome, profile, version, sourceRepository: repository })
    const originalBlob = execFileSync('/usr/bin/git', ['rev-parse', `${source.sourceCommit}:package.json`],
      { cwd: source.repository, encoding: 'utf8' }).trim()
    const originalManifest = JSON.parse(execFileSync('/usr/bin/git', ['show', `${source.sourceCommit}:package.json`],
      { cwd: source.repository, encoding: 'utf8' })) as Record<string, unknown>
    const replacement = JSON.stringify({ ...originalManifest, packageManager: 'pnpm@0.0.0' })
    const replacementBlob = execFileSync('/usr/bin/git', ['hash-object', '-w', '--stdin'],
      { cwd: source.repository, input: replacement, encoding: 'utf8' }).trim()
    execFileSync('/usr/bin/git', ['update-ref', `refs/replace/${originalBlob}`, replacementBlob], { cwd: source.repository })
    const replacementEnvironment = { ...process.env }
    delete replacementEnvironment.GIT_NO_REPLACE_OBJECTS
    expect(execFileSync('/usr/bin/git', ['show', `${source.sourceCommit}:package.json`],
      { cwd: source.repository, encoding: 'utf8', env: replacementEnvironment }))
      .toContain('pnpm@0.0.0')
    const input = { dshHome, profile, source, nodeArchivePath: nodeArchivePath!, pnpmArchivePath: pnpmArchivePath! }
    const badArchive = join(root, 'bad-node.tgz')
    await writeFile(badArchive, 'not an official archive', { mode: 0o600 })
    await expect(prepareNativeRsiRuntime({ ...input, nodeArchivePath: badArchive }))
      .rejects.toThrow('official bootstrap archive digest differs')
    const first = await prepareNativeRsiRuntime(input)
    expect(first).toMatchObject({ schemaVersion: 2, sourceCommit: source.sourceCommit,
      sourceBuild: { backend: 'macos-seatbelt', timeoutMs: 60_000, outputBytes: 1_048_576 } })
    const runtimeRoot = join(dshHome, 'rsi-native-runtimes', profile, 'runtime')
    await expect(lstat(join(runtimeRoot, 'plugins', 'lark-channel', 'src'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(runtimeRoot, '.npmrc'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(dshHome, 'rsi-native-runtimes', profile, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await prepareNativeRsiRuntime(input)).toEqual(first)
    expect(await readNativeRsiRuntime(input)).toEqual(first)
    const receiptPath = join(dshHome, 'rsi-native-runtimes', profile, 'bootstrap.json')
    await chmod(receiptPath, 0o644)
    await expect(readNativeRsiRuntime(input)).rejects.toThrow('native bootstrap receipt is unsafe')
    await chmod(receiptPath, 0o600)
    expect(await readNativeRsiRuntime(input)).toEqual(first)
    const manifestPath = join(dshHome, 'rsi-native-runtimes', profile, 'runtime', 'package.json')
    const original = await readFile(manifestPath)
    await writeFile(manifestPath, Buffer.concat([original, Buffer.from('changed')]))
    await expect(readNativeRsiRuntime(input)).rejects.toThrow()
    await writeFile(manifestPath, original); await chmod(manifestPath, 0o600)
    expect(await readNativeRsiRuntime(input)).toEqual(first)
    await rm(manifestPath)
    await expect(prepareNativeRsiRuntime(input)).rejects.toThrow()
  }, 240_000)
