// Engineering fixtures run a fake Docker executable. These tests exercise Host
// admission, process bounds and daemon failure handling, not OS isolation.
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runDockerPreparedChecks, validateSourceBuildConfig, type SourceBuildConfig } from '../src/source-build.ts'

const indices = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: async (prefix: string) => {
    const path = await actual.mkdtemp(prefix)
    if (prefix.includes('dsh-source-build-index-')) indices.push(path)
    return path
  } }
})

const roots: string[] = []
afterEach(async () => { indices.length = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const marker = `printf 'DSH_PREPARED_PACK\\thelper-1.0.0-rc.1.tgz\\t13\\t${'d'.repeat(64)}\\tv24.0.0\\t11.7.0\\n'`
async function fixture(run = marker, control = 'exit 0', override: Partial<SourceBuildConfig> = {}, version = "printf '%s\\n' '29.4.1/linux/amd64'") {
  const root = await mkdtemp(join(tmpdir(), 'source-builder-test-')); roots.push(root)
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

it('records the immutable prerelease package version and configured image', async () => {
  const f = await fixture()
  const result = await runDockerPreparedChecks(f.input)
  expect(result.evidence.pack.version).toBe('1.0.0-rc.1')
  expect(result.evidence.commands[0]?.args).toContain(f.config.image)
  expect(result.evidence.commands[0]?.args).not.toContain('systempaths=unconfined')
  expect(result.evidence.commands[0]?.args.some(arg => arg.startsWith('/sys:'))).toBe(false)
})

it('rejects larger limits unless the owner explicitly selects the repository profile', () => {
  const base: SourceBuildConfig = { dockerPath: '/usr/bin/docker', image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 128, cpus: 0.25, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4_096 }
  expect(() => validateSourceBuildConfig({ ...base, timeoutMs: 240_001 })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, temporaryMiB: 33 })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repo' as never })).toThrow(/configuration is invalid/)
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
  expect(argv).toContain('VITEST_MAX_WORKERS=1')
  expect(argv).not.toContain('systempaths=unconfined')
  expect(result.evidence.commands[0]?.args).toEqual(expect.arrayContaining([
    '--memory', '16384m', '--cpus', '16', '--pids-limit', '1024',
    '--env', 'CI=true', '--env', 'VITEST_MAX_WORKERS=1',
  ]))
})

it('rejects repository seccomp escalation unless the exact repository configuration is used', () => {
  const base: SourceBuildConfig = { dockerPath: '/usr/bin/docker', image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
    memoryMiB: 128, cpus: 0.25, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4_096 }
  expect(() => validateSourceBuildConfig({ ...base, repositorySandbox: { seccompPath: '/tmp/profile.json' } })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repository', repositorySandbox: { seccompPath: '/tmp/profile.json', extra: true } as never })).toThrow(/configuration is invalid/)
  expect(() => validateSourceBuildConfig({ ...base, profile: 'repository', repositorySandbox: { seccompPath: 'relative.json' } })).toThrow(/configuration is invalid/)
})

it('uses only an approved copied repository seccomp profile after exact Docker runtime gating', async () => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', repositorySandbox: { seccompPath: join(process.cwd(), 'placeholder') } })
  const profile = join(f.root, 'repository-seccomp.json')
  await writeFile(profile, await readFile(new URL('../../../scripts/isolation/source-builder-seccomp.json', import.meta.url)))
  f.config.repositorySandbox = { seccompPath: profile }
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

it('rejects a repository seccomp profile whose bytes do not match the approved digest', async () => {
  const f = await fixture(marker, 'exit 0', { profile: 'repository', repositorySandbox: { seccompPath: join(process.cwd(), 'placeholder') } })
  const profile = join(f.root, 'repository-seccomp.json')
  await writeFile(profile, '{"defaultAction":"SCMP_ACT_ALLOW"}\n')
  f.config.repositorySandbox = { seccompPath: profile }
  await expect(runDockerPreparedChecks(f.input)).rejects.toThrow(/digest is not approved/)
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
