import { spawnSync } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { hashLinuxRuntimeTree, validateLinuxRuntime, verifyLinuxRuntime, type LinuxRuntime } from '../src/linux-runtime.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture(): Promise<LinuxRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-linux-runtime-test-'))
  directories.push(root)
  const write = async (path: string, content: string, mode = 0o600): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 })
    await writeFile(join(root, path), content, { mode })
  }
  await write('bin/node', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.23.2; else echo 11.7.0; fi\n', 0o500)
  await write('pnpm/bin/pnpm.mjs', 'fixed pnpm')
  await write('pnpm-native/pnpm', '#!/bin/sh\necho 11.7.0\n', 0o500)
  await write('pnpm-native/node', await readFile(join(root, 'bin', 'node'), 'utf8'), 0o500)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  await write('node_modules/typescript/package.json', '{"version":"6.0.3"}')
  await write('node_modules/@deepseek-ai/cordis/package.json', '{"version":"4.0.5"}')
  await write('node_modules/@deepseek-ai/dsh-tools/package.json', '{"version":"0.2.1-rc.2"}')
  await write('node_modules/@deepseek-ai/dsh-system-prompt/package.json', '{"version":"0.2.1-rc.2"}')
  await mkdir(join(root, 'store'), { mode: 0o700 })
  await mkdir(join(root, 'cache'), { mode: 0o700 })
  const fs = await import('node:fs/promises')
  const info = await fs.stat(root)
  const nodeSha256 = (await import('node:crypto')).createHash('sha256')
    .update(await readFile(join(root, 'bin', 'node'))).digest('hex')
  const lockSha256 = (await import('node:crypto')).createHash('sha256')
    .update(await readFile(join(root, 'pnpm-lock.yaml'))).digest('hex')
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256,
    root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    nodePath: join(root, 'bin', 'node'), nodeSha256,
    pnpmPath: join(root, 'pnpm', 'bin', 'pnpm.mjs'), nativePnpmRoot: join(root, 'pnpm-native'),
    nativePnpmPath: join(root, 'pnpm-native', 'pnpm'), modulesPath: join(root, 'node_modules'),
    storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5',
      tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
}

test.runIf(process.platform === 'linux')('runtime is pinned to its complete tree, package versions and executable behavior', async () => {
  const runtime = await fixture()
  await expect(verifyLinuxRuntime(runtime)).resolves.toMatchObject({ backend: 'linux-native' })
  await expect(verifyLinuxRuntime({ ...runtime, nodePath: '/usr/bin/node' })).rejects.toThrow('invalid Linux runtime')
  await writeFile(join(runtime.root.path, 'store', 'tamper'), 'changed')
  await expect(verifyLinuxRuntime(runtime)).rejects.toThrow('root differs')
  await rm(join(runtime.root.path, 'store', 'tamper'))
  await chmod(join(runtime.root.path, 'node_modules', 'typescript', 'package.json'), 0o666)
  await expect(verifyLinuxRuntime(runtime)).rejects.toThrow('file bound')
})

test.runIf(process.platform === 'linux')('runtime tree rejects external links and special files', async () => {
  const runtime = await fixture()
  await symlink('/etc/passwd', join(runtime.root.path, 'cache', 'outside'))
  await expect(hashLinuxRuntimeTree(runtime.root.path)).rejects.toThrow('link escaped root')
})

test.runIf(process.platform === 'linux')('runtime schema refuses unexpected backend and credential path', async () => {
  const runtime = await fixture()
  expect(() => validateLinuxRuntime({ ...runtime, backend: 'docker' })).toThrow('invalid Linux runtime')
  expect(() => validateLinuxRuntime({ ...runtime, cachePath: '/home/user/.npm' })).toThrow('invalid Linux runtime')
  expect(() => validateLinuxRuntime({ ...runtime, dockerPath: '/usr/bin/docker' })).toThrow('invalid Linux runtime')
})

test.runIf(process.platform === 'linux')('the release adapter Node copy must match the pinned standalone Node', async () => {
  const runtime = await fixture()
  await chmod(join(runtime.nativePnpmRoot, 'node'), 0o700)
  await writeFile(join(runtime.nativePnpmRoot, 'node'), '#!/bin/sh\necho different\n')
  await chmod(join(runtime.nativePnpmRoot, 'node'), 0o500)
  const changed = { ...runtime, root: { ...runtime.root, sha256: await hashLinuxRuntimeTree(runtime.root.path) } }
  await expect(verifyLinuxRuntime(changed)).rejects.toThrow('release Node differs')
})

test('cancelled runtime validation does not start filesystem access', async () => {
  const reason = new Error('owner disposed'), signal = AbortSignal.abort(reason)
  await expect(hashLinuxRuntimeTree('/missing-runtime', signal)).rejects.toBe(reason)
  await expect(verifyLinuxRuntime({} as LinuxRuntime, signal)).rejects.toBe(reason)
})

test.runIf(process.platform === 'linux')('runtime traversal stops on cancellation and remains reusable', async () => {
  const runtime = await fixture(), controller = new AbortController(), reason = new Error('verification cancelled')
  const pending = hashLinuxRuntimeTree(runtime.root.path, controller.signal)
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  await expect(hashLinuxRuntimeTree(runtime.root.path)).resolves.toBe(runtime.root.sha256)
})

test('shared cgroup validation is pure/detached and preserves v2 execution-contract digest', async () => {
  const { validateLinuxCgroupRoots, validateLinuxExecutionContract, linuxExecutionContractDigest } = await import('../src/linux-execution-contract.js')
  const { defaultLimits } = await import('../src/config.js')
  const v1 = { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000', memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000',
    pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' }
  const checked = validateLinuxCgroupRoots(v1)
  v1.cpu = '/invalid'
  expect(checked).toMatchObject({ cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000' })
  expect(Object.isFrozen(checked)).toBe(true)
  const contract = { schemaVersion: 1 as const, backend: 'linux-native' as const, runtimeDigest: 'a'.repeat(64), profile: 'ordinary' as const,
    limits: defaultLimits, keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 },
    cgroupRoots: { mode: 'v2' as const, unified: '/sys/fs/cgroup/dsh-native/uid-1000' } }
  expect(validateLinuxCgroupRoots(contract.cgroupRoots)).toEqual(contract.cgroupRoots)
  expect(validateLinuxExecutionContract(contract)).toEqual(contract)
  expect(linuxExecutionContractDigest(contract)).toBe('86e4807558fe4e861dfca30cc42ddbe80cb779ff407f6c74c62735183b47aec5')
  const repository = { ...contract, schemaVersion: 2 as const, profile: 'repository' as const,
    limits: { ...defaultLimits, tmpMiB: 64, tmpInodes: 128, inputMiB: 65 as const, inputInodes: 16 as const },
    keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 } }
  expect(validateLinuxExecutionContract(repository)).toEqual(repository)
  expect(linuxExecutionContractDigest(repository)).toBe('27901e4a5348f6da7428b252e6dcae46faa594fbf6b9a9eb97372922f8c9473c')
  for (const roots of [{ ...checked, extra: true }, { ...checked, cpu: checked.mode === 'v1' ? checked.memory : '' },
    { mode: 'v2', unified: '/tmp/cgroup' }, { mode: 'future' }]) expect(() => validateLinuxCgroupRoots(roots)).toThrow()
})


// Run cancellation in a separate real Node process: an uncaught ReadStream
// error must fail this test rather than be absorbed by the Vitest process.
test.each(['completed', 'metadata-window', 'chunk-window'] as const)('runtime hash %s cancellation owns no late abort listeners or descriptors', async mode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-hash-stream-')))
  directories.push(root)
  await writeFile(join(root, 'data'), Buffer.alloc(1024 * 1024, 7), { mode: 0o600 })
  const source = new URL('../src/linux-runtime.ts', import.meta.url).href
  const script = String.raw`
    import { hashLinuxRuntimeTree } from ${JSON.stringify(source)};
    import { getEventListeners } from 'node:events';
    import { readdirSync, readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    const mode = ${JSON.stringify(mode)}, root = process.argv[1];
    const digest = value => createHash('sha256').update(value).digest('hex');
    const bytes = readFileSync(root + '/data');
    const expected = digest(JSON.stringify(['dir', '', 0o700]) + '\n' + JSON.stringify(['file', 'data', 0o600, bytes.length, digest(bytes)]) + '\n');
    if (await hashLinuxRuntimeTree(root) !== expected) throw new Error('complete bytes/metadata digest changed');
    const descriptors = () => process.platform === 'linux' ? readdirSync('/proc/self/fd').length : null;
    const before = descriptors(), rounds = [];
    for (let round = 0; round < 8; round++) {
      const controller = new AbortController(), signal = controller.signal, reason = new Error('owner disposed');
      const baseline = getEventListeners(signal, 'abort').length;
      let checks = 0, outcome = 'resolved';
      const check = signal.throwIfAborted.bind(signal);
      signal.throwIfAborted = () => {
        checks++;
        // Initial/root/file checks are followed by real lstat/open/stat awaits.
        // This schedules cancellation during those awaits, before stream construction.
        if (mode === 'metadata-window' && checks === 3) queueMicrotask(() => controller.abort(reason));
        // Both implementations have read bytes by this check in this one-file tree.
        if (mode === 'chunk-window' && checks === 5) controller.abort(reason);
        check();
      };
      try { const actual = await hashLinuxRuntimeTree(root, signal); if (actual !== expected) throw new Error('hash mismatch'); }
      catch (error) { if (error !== reason) throw error; outcome = 'owner-rejection'; }
      if (outcome !== (mode === 'completed' ? 'resolved' : 'owner-rejection')) throw new Error('cancellation did not reject');
      if (getEventListeners(signal, 'abort').length !== baseline) throw new Error('abort listener retained after hash');
      controller.abort(reason);
      await new Promise(resolve => setImmediate(resolve));
      if (await hashLinuxRuntimeTree(root) !== expected) throw new Error('runtime not reusable after cancellation');
      rounds.push({ outcome, abortListeners: getEventListeners(signal, 'abort').length });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    const after = descriptors();
    if (after !== before) throw new Error('file descriptor count changed: ' + before + ' -> ' + after);
    console.log(JSON.stringify({ node: process.version, mode, before, after, rounds }));
  `
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, root], { encoding: 'utf8', timeout: 5000 })
  expect(result.status, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error: result.error?.message })).toBe(0)
  const receipt = JSON.parse(result.stdout.trim()) as { rounds: {outcome: string; abortListeners: number}[]; before: number | null; after: number | null }
  expect(receipt.rounds).toHaveLength(8)
  expect(receipt.rounds.every(round => round.abortListeners === 0)).toBe(true)
  expect(receipt.after).toBe(receipt.before)
})


test('portable runtime hashing retains full bytes, writable-file, escaping-link and hardlink checks', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-hash-guards-')))
  directories.push(root)
  await writeFile(join(root, 'data'), 'original bytes', { mode: 0o600 })
  const original = await hashLinuxRuntimeTree(root)
  await writeFile(join(root, 'data'), 'modified bytes')
  expect(await hashLinuxRuntimeTree(root)).not.toBe(original)
  await chmod(join(root, 'data'), 0o666)
  await expect(hashLinuxRuntimeTree(root)).rejects.toThrow('file bound')
  await chmod(join(root, 'data'), 0o600)
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'runtime-hash-outside-')))
  directories.push(outside)
  await writeFile(join(outside, 'external'), 'not trusted', { mode: 0o600 })
  await symlink(join(outside, 'external'), join(root, 'outside'))
  await expect(hashLinuxRuntimeTree(root)).rejects.toThrow('link escaped root')
  await rm(join(root, 'outside'))
  await link(join(root, 'data'), join(root, 'linked'))
  await expect(hashLinuxRuntimeTree(root)).rejects.toThrow('special or linked file')
})

test('portable runtime hashing still rejects a replaced named inode while reading its owned descriptor', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'runtime-hash-inode-')))
  directories.push(root)
  await writeFile(join(root, 'data'), Buffer.alloc(4096, 1), { mode: 0o600 })
  const controller = new AbortController(), check = controller.signal.throwIfAborted.bind(controller.signal)
  let checks = 0
  controller.signal.throwIfAborted = () => {
    if (++checks === 4) {
      renameSync(join(root, 'data'), join(root, 'moved'))
      writeFileSync(join(root, 'data'), Buffer.alloc(4096, 2), { mode: 0o600 })
    }
    check()
  }
  await expect(hashLinuxRuntimeTree(root, controller.signal)).rejects.toThrow('path changed')
  expect(checks).toBeGreaterThanOrEqual(4)
})
