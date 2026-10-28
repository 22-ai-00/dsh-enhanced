// Opt-in kernel test with a retained, verified Linux runtime. This fixture's
// pnpm check is deliberately small; it is not full repository acceptance.
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { runLinuxPreparedChecks } from '../src/linux-source-build.js'
import type { LinuxSourceBuildConfig } from '../src/source-build.js'

const runtimeFile = process.env.DSH_LINUX_SOURCE_RUNTIME_JSON

test.skipIf(process.env.DSH_NATIVE_CGROUP_REAL !== '1' || !runtimeFile)(
  'installs a real retained dependency offline from the configured pnpm store and returns a binary pack', async () => {
    const { LinuxRepositoryRunner } = await import('@dsh-enhanced/assistant-isolation')
    const value = JSON.parse(await readFile(runtimeFile!, 'utf8')) as LinuxRuntime | { runtime: LinuxRuntime }
    const runtime = 'runtime' in value ? value.runtime : value
    const runtimeLockLines = (await readFile(join(runtime.root.path, 'pnpm-lock.yaml'), 'utf8')).split('\n')
    const packageStart = runtimeLockLines.indexOf(`  typescript@${runtime.versions.typescript}:`)
    expect(packageStart).toBeGreaterThan(0)
    let packageEnd = packageStart + 1
    while (packageEnd < runtimeLockLines.length && (runtimeLockLines[packageEnd]!.startsWith('    ') || runtimeLockLines[packageEnd]!.trim() === '')) packageEnd++
    const packageEntry = runtimeLockLines.slice(packageStart, packageEnd).join('\n').trimEnd()
    const root = await mkdtemp(join(tmpdir(), 'linux-source-real-')), worktree = join(root, 'source')
    const plugin = join(worktree, 'plugins', 'helper')
    await mkdir(join(plugin, 'src'), { recursive: true })
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ name: 'source-fixture', private: true,
      packageManager: 'pnpm@11.7.0', scripts: { check: 'node check.mjs' }, devDependencies: { typescript: runtime.versions.typescript } }) + '\n')
    await writeFile(join(worktree, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
    await writeFile(join(worktree, '.npmrc'), 'manage-package-manager-versions=false\npackage-import-method=copy\n')
    await writeFile(join(worktree, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      typescript:
        specifier: ${runtime.versions.typescript}
        version: ${runtime.versions.typescript}

  plugins/helper: {}

packages:

${packageEntry}

snapshots:

  typescript@${runtime.versions.typescript}: {}
`)
    await writeFile(join(worktree, 'check.mjs'), `import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module'; import {execFileSync} from 'node:child_process'; import assert from 'node:assert/strict';
assert.equal(execFileSync('pnpm',['config','get','store-dir'],{encoding:'utf8'}).trim(), '/workspace/.dsh-pnpm-store');
assert.equal(execFileSync('pnpm',['store','path'],{encoding:'utf8'}).trim(), '/workspace/.dsh-pnpm-store/v11');
assert.equal(createRequire(import.meta.url)('typescript').version, ${JSON.stringify(runtime.versions.typescript)});
mkdirSync('plugins/helper/lib',{recursive:true}); writeFileSync('plugins/helper/lib/index.js','export const answer = 42\\n'); writeFileSync('plugins/helper/lib/index.d.ts','export declare const answer = 42\\n');
`)
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/helper', version: '1.0.0',
      type: 'module', main: './lib/index.js', types: './lib/index.d.ts', files: ['lib', 'README.md', 'LICENSE', 'cordis.patch.yml'],
      exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } }, dsh: { bundle: { patch: './cordis.patch.yml' } } }) + '\n')
    await writeFile(join(plugin, 'README.md'), '# Real Linux fixture\n')
    await writeFile(join(plugin, 'LICENSE'), 'MIT\n')
    await writeFile(join(plugin, 'cordis.patch.yml'), 'mount: "@dsh-enhanced/helper"\n')
    await writeFile(join(plugin, 'src', 'index.ts'), 'export const answer = 42\n')
    const environment = { PATH: process.env.PATH, HOME: root }
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: worktree, env: environment, encoding: 'utf8' }).trim()
    git('init', '-q'); git('add', '--all'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
    const baseCommit = git('rev-parse', 'HEAD')
    const uid = process.getuid?.()
    const config: LinuxSourceBuildConfig = { backend: 'linux-native', runtime, stateRoot: join(root, 'authority'),
      authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 600000, maxRuns: 1, maxTotalDurationMs: 180000,
      timeoutMs: 180000, outputBytes: 1048576, memoryMiB: 4096, cpus: 2, pidsLimit: 256,
      workspaceMiB: 8192, temporaryMiB: 512, workspaceInodes: 1000000, temporaryInodes: 65536,
      cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
        memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
        freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
    const runner = new LinuxRepositoryRunner({ backend: config.backend, runtime: config.runtime, stateRoot: config.stateRoot,
      authorityDigest: config.authorityDigest, expiresAt: config.expiresAt, maxRuns: config.maxRuns,
      maxTotalDurationMs: config.maxTotalDurationMs, cgroupRoots: config.cgroupRoots, limits: { maxDurationMs: config.timeoutMs,
      maxInputBytes: 64 * 1024 ** 2, maxOutputBytes: config.outputBytes, maxArtifactBytes: 32 * 1024 ** 2,
      maxFiles: 1, memoryMiB: config.memoryMiB, cpus: config.cpus, pidsLimit: config.pidsLimit,
      workspaceMiB: config.workspaceMiB, workspaceInodes: config.workspaceInodes,
      tmpMiB: config.temporaryMiB, tmpInodes: config.temporaryInodes, inputMiB: 65, inputInodes: 16 } })
    let quiescent = false
    try {
      const result = await runLinuxPreparedChecks({ config, runner, worktree, baseCommit, name: 'helper',
        scope: ['plugins/helper'], environment, signal: new AbortController().signal, assertCurrent: async () => {},
        preparedAt: Date.now(), sourceJob: { id: 'source-job-' + '1'.repeat(64) }, capturePack: true })
      expect(result.evidence).toMatchObject({ schemaVersion: 3, boundary: 'linux-native-repository-v1',
        environment: { offline: true, frozenLockfile: true, nodeVersion: 'v22.23.2', pnpmVersion: '11.7.0' } })
      expect(result.packArtifact!.length).toBeGreaterThan(0)
      quiescent = await runner.inspectQuiescence('source-job-' + '1'.repeat(64)) === 'quiescent'
      expect(quiescent).toBe(true)
      expect(execFileSync('/usr/bin/tar', ['-tzf', '-'], { input: result.packArtifact!, encoding: 'utf8' })).toContain('package/lib/index.js')
      if (process.env.DSH_LINUX_SOURCE_EVIDENCE_PATH) {
        await writeFile(process.env.DSH_LINUX_SOURCE_EVIDENCE_PATH, JSON.stringify(result.evidence, null, 2) + '\n', { mode: 0o600 })
      }
    } finally {
      await runner.close()
      if (quiescent) await rm(root, { recursive: true, force: true })
      else console.error('retained unconfirmed Linux source fixture:', root)
    }
  }, 240000)
