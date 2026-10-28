#!/usr/bin/env node
// Real kernel acceptance: run after explicit per-UID cgroup preparation and
// assistant-isolation build. No Docker process, socket, image or fallback.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LinuxCgroupLease } from '../../plugins/assistant-isolation/lib/linux-cgroups.js'
import { runLinuxNamespace } from '../../plugins/assistant-isolation/lib/linux-namespace.js'

const owner = process.getuid?.()
assert.equal(process.platform, 'linux')
assert.ok(Number.isSafeInteger(owner) && owner > 0)
const args = process.argv.slice(2)
assert.equal(args.length, 2, 'usage: linux-native-boundary.mjs --roots <private-root-config.json>')
assert.equal(args[0], '--roots')
const prepared = JSON.parse(await readFile(args[1], 'utf8'))
assert.equal(prepared.schemaVersion, 1)
assert.equal(prepared.uid, owner)
const roots = { mode: prepared.mode, ...prepared.roots }
const root = await mkdtemp(join(tmpdir(), 'dsh-native-boundary-'))
const secret = join(root, 'host-private-marker')
await writeFile(secret, randomBytes(32).toString('hex'), { mode: 0o600 })
const evidence = []

async function run(name, script, options = {}) {
  const leases = []
  const admissions = {}
  const observations = {}
  const create = async (role, limits) => {
    const lease = await LinuxCgroupLease.create({ roots, jobId: randomUUID(), nonce: randomBytes(16).toString('hex'),
      limits, deadline: Date.now() + 30_000 })
    leases.push(lease)
    observations[role] = { limits, directories: lease.snapshot.directories }
    return lease
  }
  const cleanups = new Map()
  const cleanup = lease => {
    if (!cleanups.has(lease)) cleanups.set(lease, (async () => {
      const memory = lease.snapshot.directories.memory?.path
      if (memory) {
        observations[lease === leases[0] ? 'keeper' : 'candidate'].memory = Object.fromEntries(await Promise.all(
          ['memory.max_usage_in_bytes', 'memory.failcnt', 'memory.oom_control'].map(async key => [key,
            await readFile(join(memory, key), 'utf8').catch(error => `unavailable: ${error.code}`)])))
      }
      assert.equal(await lease.terminateAndProve(5_000), true, 'entire resource group must stop')
      assert.equal(await lease.removeWhenEmpty(), true, 'all resource groups must be removed')
    })())
    return cleanups.get(lease)
  }
  try {
    // The keeper must be bounded before unshare, Node, mounts or input staging.
    // Candidate admission moves its gate into a distinct independently bounded group.
    const keeper = await create('keeper', { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 })
    const candidate = await create('candidate', { memoryMiB: 128, pidsLimit: 32, cpus: 0.5 })
    const namespaceId = `${randomUUID()}-${randomBytes(16).toString('hex')}`
    const admit = async (role, lease, identity) => {
      await lease.admit({ pid: identity.pid, startTicks: String(identity.startTicks),
        uid: owner, bootId: lease.snapshot.bootId })
      admissions[role] = { ...identity, cgroup: await readFile(`/proc/${identity.pid}/cgroup`, 'utf8') }
    }
    const result = await runLinuxNamespace({ stateRoot: root, namespaceId,
      argv: ['/usr/bin/python3', '-I', '-S', '-c', script],
      files: [{ path: 'input.txt', content: 'native-input' }], artifacts: [], readOnlyRoots: [],
      workspaceBytes: 4 * 1024 * 1024, workspaceInodes: 64, tmpBytes: 1024 * 1024, tmpInodes: 32,
      timeoutMs: 10_000, maxOutputBytes: 16_384, profile: 'ordinary', signal: new AbortController().signal,
      ...options,
      beforeKeeperStart: identity => admit('keeper', keeper, identity),
      beforeStart: identity => admit('candidate', candidate, identity),
      afterExit: () => cleanup(candidate),
      onStop: async () => { await cleanup(candidate); await cleanup(keeper) } })
    await cleanup(candidate)
    await cleanup(keeper)
    evidence.push({ name, namespaceId, status: result.status, exitCode: result.exitCode,
      stdout: result.stdout, reason: result.reason, admissions, resourceGroups: observations })
    assert.equal(result.namespaceExited, true, JSON.stringify(result))
    return result
  } finally { for (const lease of [...leases].reverse()) await cleanup(lease) }
}

try {
  const ordinary = await run('normal-artifact', 'from pathlib import Path; assert Path("input.txt").read_text()=="native-input"; Path("output.txt").write_text("native-result"); print("ok")', { artifacts: ['output.txt'] })
  assert.equal(ordinary.status, 'succeeded')
  assert.equal(ordinary.stdout.trim(), 'ok')
  assert.deepEqual(ordinary.artifacts, [{ path: 'output.txt', content: 'native-result' }])

  const unicode = await run('unicode-space-artifact', 'from pathlib import Path; Path("中文 目录").mkdir(); Path("中文 目录/结果.txt").write_text("真实结果")',
    { artifacts: ['中文 目录/结果.txt'], maxArtifactBytes: 12 })
  assert.equal(unicode.status, 'succeeded')
  assert.deepEqual(unicode.artifacts, [{ path: '中文 目录/结果.txt', content: '真实结果' }])

  const artifactLimit = await run('artifact-total-byte-limit', "from pathlib import Path; Path('a').write_text('abc'); Path('b').write_text('def')",
    { artifacts: ['a', 'b'], maxArtifactBytes: 5 })
  assert.equal(artifactLimit.status, 'unknown')
  assert.deepEqual(artifactLimit.artifacts, [])

  const hidden = await run('host-files-and-network', `import os,socket
assert not os.path.exists(${JSON.stringify(secret)})
assert not os.path.exists('/sys/fs/cgroup')
assert not os.path.exists('/var/run/docker.sock')
s=socket.socket(); s.settimeout(.2)
try: s.connect(('1.1.1.1',443))
except OSError: print('isolated')
else: raise AssertionError('network unexpectedly reachable')`)
  assert.equal(hidden.status, 'succeeded')
  assert.equal(hidden.stdout.trim(), 'isolated')

  for (const [name, operation] of [
    ['workspace-byte-limit', "with open('large','wb') as f: f.write(b'x'*(8*1024*1024))"],
    ['workspace-inode-limit', "for i in range(256): open('item-%d'%i,'w').close()"],
    ['tmp-byte-limit', "with open('/tmp/large','wb') as f: f.write(b'x'*(2*1024*1024))"],
    ['tmp-inode-limit', "for i in range(128): open('/tmp/item-%d'%i,'w').close()"],
  ]) {
    const result = await run(name, `import errno\ntry:\n ${operation}\nexcept OSError as e:\n assert e.errno==errno.ENOSPC; print('bounded')\nelse: raise AssertionError('capacity was not enforced')`)
    assert.equal(result.status, 'succeeded', name)
    assert.equal(result.stdout.trim(), 'bounded', name)
  }

  const linked = await run('artifact-link-rejected', "import os; os.symlink('/etc/passwd','result')", { artifacts: ['result'] })
  assert.notEqual(linked.status, 'succeeded')
  assert.deepEqual(linked.artifacts, [])

  const timeout = await run('timeout-descendant-cleanup', "import subprocess,time; subprocess.Popen(['/usr/bin/sleep','30']); time.sleep(30)", { timeoutMs: 1_500 })
  assert.equal(timeout.status, 'timed-out')

  const output = await run('output-bound-cleanup', "print('x'*100000)", { maxOutputBytes: 1024 })
  assert.notEqual(output.status, 'succeeded')
  assert.ok(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 1024)

  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, passed: true, backend: 'linux-native', mode: roots.mode, cases: evidence }, null, 2)}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, passed: false, backend: 'linux-native', mode: roots.mode,
    cases: evidence, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`)
  throw error
} finally { await rm(root, { recursive: true, force: true }) }
