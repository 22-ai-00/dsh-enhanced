// Engineering fixtures run a fake Docker executable. These tests exercise Host
// admission, process bounds and daemon failure handling, not OS isolation.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { validateNativeMacRuntime } from '@dsh-enhanced/assistant-isolation'
import { removeSourceJobContainer, runDockerPreparedChecks, validateSourceBuildConfig, type SourceBuildConfig } from '../src/source-build.ts'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace, type SourceCreationGrant } from '../src/source-creation.ts'
import { createIsolatedWorktree } from '../src/source-workspace.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'

const indices = vi.hoisted(() => [] as string[])
const indexHook = vi.hoisted(() => ({ run: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: async (prefix: string) => {
    const path = await actual.mkdtemp(prefix)
    if (prefix.includes('dsh-source-build-index-')) { indices.push(path); await indexHook.run?.() }
    return path
  } }
})

const roots: string[] = []
const worktrees: Array<{ remove: () => Promise<void> }> = []
afterEach(async () => { indexHook.run = undefined; indices.length = 0; for (const worktree of worktrees.splice(0).reverse()) await worktree.remove(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('keeps synchronous native Config validation strict and aligned with the executor shape check', () => {
  const runtime = { schemaVersion: 1 as const, platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64',
    nodePath: '/approved/node/bin/node', nodeSha256: 'a'.repeat(64), modulesPath: '/approved/modules',
    roots: [{ path: '/approved/node', dev: 1, ino: 2, sha256: 'b'.repeat(64) },
      { path: '/approved/modules', dev: 3, ino: 4, sha256: 'c'.repeat(64) }],
    versions: { node: 'v24.22.0', typescript: '6.0.3', cordis: '1', tools: '1', systemPrompt: '1' } }
  const config = { backend: 'macos-seatbelt' as const, runtime, stateRoot: '/approved/state',
    authorityDigest: 'd'.repeat(64), expiresAt: Date.now() + 60_000, maxRuns: 2,
    maxTotalDurationMs: 120_000, timeoutMs: 60_000, outputBytes: 1_048_576 }
  expect(() => validateNativeMacRuntime(runtime)).not.toThrow()
  expect(() => validateSourceBuildConfig(config)).not.toThrow()
  const malformed: unknown[] = [
    { ...runtime, unexpected: true },
    { ...runtime, platform: 'linux-arm64' },
    { ...runtime, nodePath: '/other/node' },
    { ...runtime, modulesPath: '/other/modules' },
    { ...runtime, nodeSha256: 'A'.repeat(64) },
    { ...runtime, roots: [{ ...runtime.roots[0], dev: -1 }, runtime.roots[1]] },
    { ...runtime, roots: [{ ...runtime.roots[0], ino: 1.5 }, runtime.roots[1]] },
    { ...runtime, roots: [runtime.roots[0], runtime.roots[0]] },
    { ...runtime, roots: [{ ...runtime.roots[0], path: '/approved/../node' }, runtime.roots[1]] },
    { ...runtime, versions: { ...runtime.versions, unexpected: '1' } },
  ]
  for (const candidate of malformed) {
    expect(() => validateNativeMacRuntime(candidate)).toThrow('invalid native runtime')
    expect(() => validateSourceBuildConfig({ ...config, runtime: candidate } as SourceBuildConfig))
      .toThrow('native source runtime configuration is invalid')
  }
})
const marker = `printf 'DSH_PREPARED_PACK\\thelper-1.0.0-rc.1.tgz\\t13\\t${'d'.repeat(64)}\\tv24.0.0\\t11.7.0\\n'`
const packFrame = 'DSH_PREPARED_PACK_BYTES_V1'
function captureOutput(bytes: Buffer, options: { size?: number; sha?: string; encoded?: string; trailing?: string } = {}): string {
  const size = options.size ?? bytes.length
  const sha = options.sha ?? createHash('sha256').update(bytes).digest('hex')
  const encoded = options.encoded ?? bytes.toString('base64')
  return `printf '%s\\n' 'DSH_PREPARED_PACK\thelper-1.0.0-rc.1.tgz\t${size}\t${sha}\tv24.0.0\t11.7.0' '${packFrame}\t${encoded}'${options.trailing ?? ''}`
}
async function fixture(run = marker, control = 'exit 0', override: Partial<SourceBuildConfig> = {}, version = "printf '%s\\n' '29.4.1/linux/amd64'") {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-builder-test-'))); roots.push(root)
  const repository = join(root, 'repo'); const plugin = join(repository, 'plugins', 'helper')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'package.json'), '{"name":"helper","version":"1.0.0-rc.1"}')
  await writeFile(join(plugin, 'index.js'), 'old')
  const environment = { PATH: process.env.PATH, HOME: root }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q'); git('add', '--all'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
  const baseCommit = git('rev-parse', 'HEAD')
  await writeFile(join(plugin, 'index.js'), 'new')
  const dockerPath = join(root, 'docker')
  await writeFile(dockerPath, `#!/bin/sh\nif [ "$1" = run ]; then\nprintf '%s\\n' "$@" > "$0.args"\ncat >/dev/null\n${run}\nelif [ "$1" = version ]; then\n${version}\nelse\n${control}\nfi\n`)
  await chmod(dockerPath, 0o700)
  const config: SourceBuildConfig = { dockerPath, image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 4_096, ...override }
  return { root, repository, plugin, dockerPath, config, input: { config, worktree: repository, baseCommit,
    name: 'helper', scope: ['plugins/helper'], environment, signal: new AbortController().signal,
    assertCurrent: async () => {}, preparedAt: Date.now() } }
}

async function creationFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-builder-create-'))); roots.push(root)
  const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
  const { repository, baseCommit } = await createSourceCreationFixture(sourceRoot, join(root, 'repository'))
  const environment = { ...process.env, HOME: root }
  const isolated = await createIsolatedWorktree({ stateRoot: join(root, 'state'), repository, baseCommit, environment })
  worktrees.push(isolated)
  const signal = new AbortController().signal
  const name = 'rsi-build-proof'
  const grant: SourceCreationGrant = { id: 'owner-build-proof', expiresAt: Date.now() + 120_000,
    maxCreates: 1, namePrefix: 'rsi-build-' }
  const view = await inspectSourceCreationContext({ repository, name, paths: ['src/index.ts'], baseCommit,
    environment, signal, assertCurrent: () => undefined, grant })
  const creation = { grant, generatorDigest: view.generatorDigest }
  const prepared = await prepareCreatedPluginWorkspace({ worktree: isolated.worktree, baseCommit, name,
    files: [{ path: 'README.md', content: '# Created build proof\n' }], environment, signal,
    assertCurrent: () => undefined, creation })
  const dockerPath = join(root, 'docker')
  await writeFile(dockerPath, `#!/bin/sh\nif [ "$1" = run ]; then\nprintf '%s\\n' "$@" > "$0.args"\ncat >/dev/null\n${marker}\nfi\n`)
  await chmod(dockerPath, 0o700)
  const config: SourceBuildConfig = { dockerPath, image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 4_096 }
  return { root, repository, worktree: isolated.worktree, dockerPath, name, baseCommit, scope: prepared.scope,
    creation, input: { config, worktree: isolated.worktree, baseCommit, name, scope: prepared.scope,
      environment, signal, assertCurrent: async () => {}, preparedAt: Date.now(), creation } }
}

// Each case copies the public generator inputs, commits a real Git baseline,
// creates an isolated worktree and runs the frozen Node plugin generator.
const creationProofTestTimeoutMs = 60_000

it('enables trust-lockfile only after real generated creation proof and freezes the base lock digest', async () => {
  const f = await creationFixture()
  const result = await runDockerPreparedChecks(f.input)
  const baseLock = execFileSync('/usr/bin/git', ['show', `${f.baseCommit}:pnpm-lock.yaml`], { cwd: f.repository })
  const expected = createHash('sha256').update(baseLock).digest('hex')
  expect(result.evidence.commands[0]?.args).toEqual(expect.arrayContaining([
    '--env', 'DSH_SOURCE_TRUST_LOCKFILE=true', '--env', `DSH_SOURCE_BASE_LOCK_SHA256=${expected}`]))
  expect(result.evidence.pack.version).toBe('0.1.0')
  expect(await readFile(`${f.dockerPath}.args`, 'utf8')).toContain('DSH_SOURCE_TRUST_LOCKFILE=true')
}, creationProofTestTimeoutMs)

it('rejects altered creation scope, grant, lock and scaffold before launching Docker', async () => {
  const f = await creationFixture()
  const argsPath = `${f.dockerPath}.args`
  const base = f.input
  await expect(runDockerPreparedChecks({ ...base, scope: [`plugins/${f.name}`] })).rejects.toThrow(/scope differs/)
  await expect(lstat(argsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(runDockerPreparedChecks({ ...base, creation: { ...f.creation,
    grant: { ...f.creation.grant, expiresAt: Date.now() - 1 } } })).rejects.toThrow(/grant expired/)
  await expect(lstat(argsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const lockPath = join(f.worktree, 'pnpm-lock.yaml')
  const lock = await readFile(lockPath)
  await writeFile(lockPath, 'tampered\n')
  await expect(runDockerPreparedChecks(base)).rejects.toThrow(/lock importer changed|source changed/)
  await expect(lstat(argsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(lockPath, lock)
  await writeFile(join(f.worktree, 'plugins', f.name, 'cordis.patch.yml'), 'tampered\n')
  await expect(runDockerPreparedChecks(base)).rejects.toThrow(/Host-owned generated file changed/)
  await expect(lstat(argsPath)).rejects.toMatchObject({ code: 'ENOENT' })
}, creationProofTestTimeoutMs)

it('rejects a staged tree changed after creation proof and before Git staging', async () => {
  const f = await creationFixture()
  indexHook.run = async () => { await writeFile(join(f.worktree, 'plugins', f.name, 'README.md'), '# raced source\n') }
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/staged tree differs from verified workspace/)
  await expect(lstat(`${f.dockerPath}.args`)).rejects.toMatchObject({ code: 'ENOENT' })
}, creationProofTestTimeoutMs)

it('records the immutable prerelease package version and configured image', async () => {
  const f = await fixture()
  const result = await runDockerPreparedChecks(f.input)
  expect(result.evidence.pack.version).toBe('1.0.0-rc.1')
  expect(result.evidence.commands[0]?.args).toContain(f.config.image)
  expect(result.evidence.commands[0]?.args).not.toContain('systempaths=unconfined')
  expect(result.evidence.commands[0]?.args.some(arg => arg.startsWith('/sys:'))).toBe(false)
  expect(result.evidence.commands[0]?.args.some(arg => arg.startsWith('VITEST_MAX_WORKERS='))).toBe(false)
  expect(result.evidence.commands[0]?.args).not.toContain('DSH_SOURCE_CAPTURE_PACK=true')
  expect(result.packArtifact).toBeUndefined()
})

it('returns only the exact bounded artifact whose size and digest match the verified marker', async () => {
  const bytes = Buffer.from('verified pack bytes\0from the same container read')
  const f = await fixture(captureOutput(bytes))
  const result = await runDockerPreparedChecks({ ...f.input, capturePack: true })
  expect(result.packArtifact).toEqual(bytes)
  expect(result.evidence.pack).toMatchObject({ sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  expect(result.evidence.commands[0]?.args).toEqual(expect.arrayContaining(['--env', 'DSH_SOURCE_CAPTURE_PACK=true']))
})

it.each([
  ['missing frame', marker],
  ['wrong SHA', captureOutput(Buffer.from('pack'), { sha: '0'.repeat(64) })],
  ['wrong size', captureOutput(Buffer.from('pack'), { size: 5 })],
  ['invalid base64', captureOutput(Buffer.from('pack'), { encoded: '!!!!' })],
  ['noncanonical base64', captureOutput(Buffer.from('f'), { encoded: 'Zh==' })],
  ['duplicate frame', captureOutput(Buffer.from('pack'), { trailing: `\nprintf '%s\\n' '${packFrame}\tcGFjaw=='` })],
  ['extra output', captureOutput(Buffer.from('pack'), { trailing: `\nprintf 'extra\\n'` })],
])('rejects captured pack with %s', async (_label, output) => {
  const f = await fixture(output)
  await expect(runDockerPreparedChecks({ ...f.input, capturePack: true })).rejects.toThrow(/capture|evidence/u)
})

it('bounds capture stdout independently of the normal evidence budget', async () => {
  const f = await fixture('exec /usr/bin/yes A')
  const started = Date.now()
  await expect(runDockerPreparedChecks({ ...f.input, capturePack: true })).rejects.toThrow(/output bound/u)
  expect(Date.now() - started).toBeLessThan(10_000)
})

it('does not return a captured artifact when container cleanup remains unknown', async () => {
  const f = await fixture(captureOutput(Buffer.from('pack')), 'exit 1')
  await expect(runDockerPreparedChecks({ ...f.input, capturePack: true })).rejects.toThrow(/cleanup could not prove quiescence/u)
})

it('rejects larger limits unless the owner explicitly selects the repository profile', () => {
  const base: SourceBuildConfig = { dockerPath: '/usr/bin/docker', image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 128, cpus: 0.25, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4_096 }
  expect(() => validateSourceBuildConfig({ ...base, timeoutMs: 240_001 })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, temporaryMiB: 33 })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repo' as never })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, versioning: 'minor' as never })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, versioning: 'patch' })).not.toThrow()
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repository', timeoutMs: 1_800_000, memoryMiB: 16_384,
    cpus: 16, pidsLimit: 1_024, workspaceMiB: 8_192, temporaryMiB: 4_096 })).not.toThrow()
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repository', temporaryMiB: Number.NaN })).toThrow(/configuration is invalid/)
})

it('passes repository profile resource and deterministic test environment flags to Docker evidence', async () => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', timeoutMs: 1_800_000, memoryMiB: 16_384,
    cpus: 16, pidsLimit: 1_024, workspaceMiB: 8_192, temporaryMiB: 2_048 })
  const result = await runDockerPreparedChecks(f.input)
  const argv = await readFile(`${f.dockerPath}.args`, 'utf8')
  expect(argv).toContain('--memory\n16384m\n')
  expect(argv).toContain('--cpus\n16\n')
  expect(argv).toContain('--pids-limit\n1024\n')
  expect(argv).toContain('/workspace:rw,nosuid,nodev,mode=1777,size=8192m,exec')
  expect(argv).toContain('/tmp:rw,nosuid,nodev,mode=1777,size=2048m,exec')
  expect(argv).toContain('CI=true')
  expect(argv).toContain('VITEST_MAX_WORKERS=4')
  expect(argv).not.toContain('systempaths=unconfined')
  expect(result.evidence.commands[0]?.args).toEqual(expect.arrayContaining([
    '--memory', '16384m', '--cpus', '16', '--pids-limit', '1024',
    '--env', 'CI=true', '--env', 'VITEST_MAX_WORKERS=4',
  ]))
})

it.each([[1, 1], [8, 4], [0.5, 1]])('sets repository Vitest workers from %s CPUs to %s', async (cpus, workers) => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', cpus })
  const result = await runDockerPreparedChecks(f.input)
  const expected = `VITEST_MAX_WORKERS=${workers}`
  expect(await readFile(`${f.dockerPath}.args`, 'utf8')).toContain(expected)
  expect(result.evidence.commands[0]?.args).toEqual(expect.arrayContaining(['--cpus', String(cpus), '--env', expected]))
})

it('rejects repository seccomp escalation unless the exact repository configuration is used', () => {
  const base: SourceBuildConfig = { dockerPath: '/usr/bin/docker', image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 128, cpus: 0.25, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4_096 }
  expect(() => validateSourceBuildConfig({ ...base, repositorySandbox: { seccompPath: '/tmp/profile.json' } })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repository', repositorySandbox: { seccompPath: '/tmp/profile.json', extra: true } as never })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repository', repositorySandbox: { seccompPath: 'relative.json' } })).toThrow(/configuration is invalid/)
})

it('requires an explicit portable repository profile, immutable image, local socket and daemon binding', () => {
  const base: SourceBuildConfig = { dockerPath: '/usr/bin/docker', image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 128, cpus: 0.25, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4_096 }
  const portable = { ...base, profile: 'portable-repository' as const, socketPath: '/tmp/.docker/run/docker.sock',
    daemonId: 'TEST-DAEMON-0000', repositorySandbox: { seccompPath: '/tmp/profile.json' } }
  expect(() => validateSourceBuildConfig(portable)).not.toThrow()
  expect(() => validateSourceBuildConfig({ ...portable, repositorySandbox: undefined } as unknown as SourceBuildConfig)).toThrow(/invalid/)
  expect(() => validateSourceBuildConfig({ ...portable, repositorySandbox: { seccompPath: '/tmp/profile.json', extra: true } as never })).toThrow(/invalid/)
  expect(() => validateSourceBuildConfig({ ...portable, daemonId: undefined } as unknown as SourceBuildConfig)).toThrow(/invalid/)
  expect(() => validateSourceBuildConfig({ ...portable, image: 'example.com/image@sha256:' + 'a'.repeat(64) })).toThrow(/invalid/)
  expect(() => validateSourceBuildConfig({ ...portable, socketPath: 'tcp://remote' })).toThrow(/invalid/)
  expect(() => validateSourceBuildConfig({ ...base, socketPath: portable.socketPath })).toThrow(/invalid/)
})

it.each(['x64', 'arm64'] as const)('portable prepared checks on macOS %s reject runtime, daemon and image drift and keep the Docker endpoint local', async arch => {
  const f = await fixture()
  const previousHome = process.env.HOME
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!
  const dockerArchitecture = arch === 'arm64' ? 'arm64' : 'amd64'
  const driftArchitecture = arch === 'arm64' ? 'amd64' : 'arm64'
  const socket = join(f.root, '.docker', 'run', 'docker.sock')
  const state = join(f.root, 'state')
  await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
  await writeFile(state, 'ready')
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  await writeFile(f.dockerPath, `#!/bin/sh
if [ "$1" = --config ]; then shift 4; fi
state="$(cat ${state})"
case "$1" in
  version) if [ "$state" = runtime-drift ]; then printf '%s\\n' '29.4.1/linux/${driftArchitecture}'; else printf '%s\\n' '29.4.1/linux/${dockerArchitecture}'; fi ;;
  info) if [ "$state" = daemon-drift ]; then printf '%s\\n' 'BAD-DAEMON-0000'; else printf '%s\\n' 'TEST-DAEMON-0000'; fi ;;
  image) if [ "$state" = image-drift ]; then printf '%s\\n' 'sha256:${'a'.repeat(64)}/linux/${driftArchitecture}'; else printf '%s\\n' 'sha256:${'a'.repeat(64)}/linux/${dockerArchitecture}'; fi ;;
  run) printf '%s\\n' "$@" > "$0.args"; cat >/dev/null; ${marker} ;;
  *) exit 0 ;;
esac
`)
  try {
    process.env.HOME = f.root
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    Object.defineProperty(process, 'arch', { value: arch, configurable: true })
    f.config.profile = 'portable-repository'
    f.config.socketPath = socket
    f.config.daemonId = 'TEST-DAEMON-0000'
    const seccompPath = join(f.root, 'seccomp.json')
    await writeFile(seccompPath, await readFile(new URL('../../../scripts/isolation/source-builder-seccomp.json', import.meta.url)))
    f.config.repositorySandbox = { seccompPath }
    const result = await runDockerPreparedChecks(f.input)
    const args = result.evidence.commands[0]!.args
    expect(args).toEqual(expect.arrayContaining(['-H', `unix://${socket}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL']))
    expect(args).toEqual(expect.arrayContaining(['systempaths=unconfined', '/sys:ro,nosuid,nodev,noexec,size=1m']))
    await writeFile(state, 'runtime-drift')
    await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/approved matching Linux Docker runtime/)
    await writeFile(state, 'daemon-drift')
    await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/daemon identity differs/)
    await writeFile(state, 'image-drift')
    await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/image ID or platform differs/)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', architecture)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('admits an approved copied seccomp profile only on a supported Host after Docker runtime gating', async () => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', repositorySandbox: { seccompPath: join(process.cwd(), 'placeholder') } })
  const profile = join(f.root, 'repository-seccomp.json')
  await writeFile(profile, await readFile(new URL('../../../scripts/isolation/source-builder-seccomp.json', import.meta.url)))
  f.config.repositorySandbox = { seccompPath: profile }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/repository seccomp requires an approved native Host/)
    await expect(lstat(`${f.dockerPath}.args`)).rejects.toMatchObject({ code: 'ENOENT' })
    return
  }
  const result = await runDockerPreparedChecks(f.input)
  const argv = await readFile(`${f.dockerPath}.args`, 'utf8')
  const copied = argv.match(/seccomp=(.+)/u)?.[1]?.trim()
  expect(copied).toMatch(/dsh-source-build-index-/)
  expect(copied).not.toBe(profile)
  expect(argv).toContain(`dsh.source.seccomp.sha256=b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342`)
  expect(result.evidence.commands[0]?.args).toContain(`seccomp=${copied}`)
  expect(result.evidence.commands[0]?.args).toEqual(expect.arrayContaining([
    'systempaths=unconfined', '/sys:ro,nosuid,nodev,noexec,size=1m',
    '--cap-drop', 'ALL', '--user', '65534:65534', '--read-only', '--network', 'none', 'no-new-privileges',
  ]))
  await expect(lstat(copied!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an unapproved Docker runtime before archiving repository source', async () => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', repositorySandbox: { seccompPath: join(process.cwd(), 'placeholder') } }, "printf '%s\\n' '29.4.0/linux/amd64'")
  const profile = join(f.root, 'repository-seccomp.json')
  await writeFile(profile, await readFile(new URL('../../../scripts/isolation/source-builder-seccomp.json', import.meta.url)))
  f.config.repositorySandbox = { seccompPath: profile }
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/approved Docker runtime/)
  await expect(lstat(`${f.dockerPath}.args`)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects repository seccomp at the Host gate or the approved digest gate before container start', async () => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', repositorySandbox: { seccompPath: join(process.cwd(), 'placeholder') } })
  const profile = join(f.root, 'repository-seccomp.json')
  await writeFile(profile, '{"defaultAction":"SCMP_ACT_ALLOW"}\n')
  f.config.repositorySandbox = { seccompPath: profile }
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(process.platform === 'linux' && process.arch === 'x64'
    ? /digest is not approved/ : /repository seccomp requires an approved native Host/)
  await expect(lstat(`${f.dockerPath}.args`)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cancels a runtime preflight without starting an archive or container', async () => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', repositorySandbox: { seccompPath: '/unused/profile.json' } },
    ': > "$0.version-started"\nexec /bin/sleep 60')
  const abort = new AbortController()
  const pending = runDockerPreparedChecks({ ...f.input, signal: abort.signal })
  void pending.catch(() => undefined)
  try {
    await vi.waitFor(async () => { expect((await lstat(`${f.dockerPath}.version-started`)).isFile()).toBe(true) })
    const started = Date.now()
    abort.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(indices).toHaveLength(0)
    await expect(lstat(`${f.dockerPath}.args`)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { abort.abort(); await pending.catch(() => undefined) }
})

it.each([
  ['daemon unavailable', 'exit 1'],
  ['container remains', 'if [ "$1" = container ]; then echo still-running; fi; exit 0'],
])('refuses success when cleanup cannot prove absence: %s', async (_label, control) => {
  const f = await fixture(marker, control)
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/cleanup could not prove quiescence/)
})

it('rejects candidate-spoofed extra evidence output', async () => {
  const f = await fixture(`${marker}\n${marker}`)
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/unexpected evidence output/)
})

it('stops excessive output and settles instead of buffering until the deadline', async () => {
  const f = await fixture('exec /usr/bin/yes x')
  const started = Date.now()
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/output bound/)
  expect(Date.now() - started).toBeLessThan(5_000)
})

it('cancels a running client and checks daemon cleanup before settling', async () => {
  const f = await fixture(': > "$0.started"\nexec /bin/sleep 60')
  const abort = new AbortController()
  const pending = runDockerPreparedChecks({ ...f.input, signal: abort.signal })
  void pending.catch(() => undefined)
  try {
    await vi.waitFor(async () => { expect((await lstat(`${f.dockerPath}.started`)).isFile()).toBe(true) }, { timeout: 5_000 })
    abort.abort(new Error('owner stopped'))
    await expect(pending).rejects.toThrow(/cancelled|archive exited/)
  } finally { abort.abort(); await pending.catch(() => undefined) }
})

it('does not return captured bytes after owner cancellation', async () => {
  const f = await fixture(': > "$0.started"\nexec /bin/sleep 60')
  const abort = new AbortController()
  const pending = runDockerPreparedChecks({ ...f.input, capturePack: true, signal: abort.signal })
  void pending.catch(() => undefined)
  try {
    await vi.waitFor(async () => { expect((await lstat(`${f.dockerPath}.started`)).isFile()).toBe(true) }, { timeout: 5_000 })
    abort.abort(new Error('owner stopped'))
    await expect(pending).rejects.toThrow(/cancelled|archive exited/u)
  } finally { abort.abort(); await pending.catch(() => undefined) }
})

it('refuses a Host worktree change made after the archive was consumed', async () => {
  const f = await fixture()
  await writeFile(f.dockerPath, `#!/bin/sh\nif [ "$1" = run ]; then\ncat >/dev/null\nprintf changed > '${join(f.plugin, 'index.js')}'\n${marker}\nfi\n`)
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/source changed/)
  expect(await readFile(join(f.plugin, 'index.js'), 'utf8')).toBe('changed')
})

it('removes the immutable index if malformed package metadata fails before Docker starts', async () => {
  const f = await fixture()
  await writeFile(join(f.plugin, 'package.json'), '{invalid json')
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow()
  expect(indices).toHaveLength(1)
  await expect(lstat(indices[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('records the preallocated job identity and refuses to reuse an existing durable container', async () => {
  const sourceJob = { id: `source-job-${'b'.repeat(64)}`, containerName: `dsh-source-job-${'b'.repeat(64)}` }
  const f = await fixture()
  const result = await runDockerPreparedChecks({ ...f.input, sourceJob })
  expect(result.evidence.commands[0]!.args).toContain(`dsh.source.job=${sourceJob.id}`)
  expect(result.evidence.commands[0]!.args).toContain(sourceJob.containerName)
  const occupied = await fixture(marker, 'echo occupied')
  await expect(runDockerPreparedChecks({ ...occupied.input, sourceJob })).rejects.toThrow(/already exists/)
  await expect(lstat(`${occupied.dockerPath}.args`)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const index of indices) await expect(lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([true, false])('reconciles only the exact image and job labeled container (matching=%s)', async matching => {
  const f = await fixture()
  const job = { id: `source-job-${'b'.repeat(64)}`, containerName: `dsh-source-job-${'b'.repeat(64)}` }
  const containerId = 'c'.repeat(64)
  const inspected = JSON.stringify([containerId, `/${job.containerName}`, f.config.image, matching ? job.id : 'foreign-job'])
  await writeFile(f.dockerPath, `#!/bin/sh\ncase "$1" in\ncontainer) if [ ! -f "$0.removed" ]; then echo container; fi;;\ninspect) printf '%s\\n' '${inspected}';;\nrm) printf '%s\\n' "$@" > "$0.removed";;\nesac\n`)
  if (matching) {
    await removeSourceJobContainer(f.config, job)
    expect(await readFile(`${f.dockerPath}.removed`, 'utf8')).toBe(`rm\n-f\n${containerId}\n`)
  } else {
    await expect(removeSourceJobContainer(f.config, job)).rejects.toThrow(/ownership mismatch/)
    await expect(lstat(`${f.dockerPath}.removed`)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('keeps durable resource state unknown when daemon absence cannot be established', async () => {
  const f = await fixture(marker, 'exit 1')
  await expect(removeSourceJobContainer(f.config, { id: `source-job-${'b'.repeat(64)}`, containerName: `dsh-source-job-${'b'.repeat(64)}` })).rejects.toThrow(/absence is unproven/)
})
