// Owner-invoked OS-boundary proof for the production repository source runner.
// It uses a synthetic, empty-dependency Git repository and does not contact a
// model, registry, production profile, or release path.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDockerPreparedChecks } from '../../plugins/plugin-control-plane/lib/source-build.js'

const image = process.env.DSH_SOURCE_BUILD_IMAGE
assert.match(image ?? '', /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u,
  'set DSH_SOURCE_BUILD_IMAGE to a locally available pinned source-builder image')
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const seccompPath = resolve(repositoryRoot, 'scripts/isolation/source-builder-seccomp.json')
const root = await mkdtemp(join(tmpdir(), 'dsh-source-repository-sandbox-'))
const repository = join(root, 'repository')
const plugin = join(repository, 'plugins', 'sandbox-probe')
const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repository, env, encoding: 'utf8' }).trim()
const docker = (...args) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8' })

function containerIds() {
  return new Set(docker('container', 'ls', '--all', '--format', '{{.ID}}\t{{.Names}}').trim().split('\n')
    .map(line => line.split('\t')).filter((parts) => parts[1]?.startsWith('dsh-source-prepare-')).map(parts => parts[0]))
}

function assertContainerBoundary(id, expected) {
  const value = JSON.parse(docker('container', 'inspect', id))
  assert.equal(value.length, 1)
  const item = value[0]
  assert.equal(item.Config.User, '65534:65534')
  assert.equal(item.HostConfig.NetworkMode, 'none')
  assert.equal(item.HostConfig.ReadonlyRootfs, true)
  assert.equal(item.HostConfig.Privileged, false)
  assert.deepEqual(item.HostConfig.CapDrop, ['ALL'])
  assert.ok(item.HostConfig.SecurityOpt.includes('no-new-privileges'))
  assert.ok(item.HostConfig.SecurityOpt.some(entry => entry.startsWith('seccomp=')))
  assert.equal(item.Config.Labels['dsh.source.seccomp.sha256'], expected.seccompSha256)
  assert.equal(item.HostConfig.Memory, expected.memoryMiB * 1024 * 1024)
  assert.equal(item.HostConfig.MemorySwap, expected.memoryMiB * 1024 * 1024)
  assert.equal(item.HostConfig.PidsLimit, expected.pidsLimit)
  assert.equal(item.HostConfig.NanoCpus, expected.nanoCpus)
  assert.equal(item.Mounts.some(mount => mount.Type === 'bind'), false)
  assert.equal(item.Mounts.some(mount => String(mount.Source).includes('docker.sock')), false)
  assert.equal(item.HostConfig.MaskedPaths?.length ?? 0, 0)
  assert.equal(item.HostConfig.ReadonlyPaths?.length ?? 0, 0)
  assert.match(item.HostConfig.Tmpfs['/sys'], /ro,nosuid,nodev,noexec,size=1m/)
  return item.Name.slice(1)
}

const check = String.raw`
  const assert = require('node:assert/strict');
  const fs = require('node:fs'); const cp = require('node:child_process');
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const field = name => { const match = status.match(new RegExp('^' + name + ':\\s*(.+)$', 'm')); return match?.[1]?.trim(); };
  const hostPath = ${JSON.stringify(root)};
  assert.equal(process.getuid(), 65534); for (const name of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.equal(field(name), '0000000000000000');
  assert.equal(field('NoNewPrivs'), '1'); assert.equal(field('Seccomp'), '2');
  assert.deepEqual(fs.readdirSync('/sys'), []); assert.match(fs.readFileSync('/proc/mounts', 'utf8'), /tmpfs \/sys tmpfs ro,/);
  assert.equal(fs.existsSync('/var/run/docker.sock'), false); assert.equal(fs.existsSync(hostPath), false); assert.equal(fs.existsSync('.git'), false); assert.throws(() => fs.writeFileSync('/rootfs-probe', 'no'));
  assert.equal(process.env.SOURCE_SANDBOX_SECRET, undefined); assert.deepEqual(fs.readFileSync('/proc/net/dev', 'utf8').trim().split('\n').slice(2).map(x => x.trim().split(':')[0].trim()), ['lo']);
  for (const path of ['/proc/sys/kernel/hostname', '/proc/sysrq-trigger']) assert.throws(() => fs.openSync(path, 'r+'));
  assert.throws(() => fs.openSync('/proc/kcore', 'r'));
  let keysVisibility = 'unavailable'; try { const fd = fs.openSync('/proc/keys', 'r'); fs.closeSync(fd); keysVisibility = 'openable'; } catch { keysVisibility = 'denied'; }
  const deny = code => { const result = cp.spawnSync('/usr/bin/python3', ['-c', code], { stdio: 'ignore' }); assert.equal(result.error, undefined, 'negative syscall probe must start'); assert.equal(result.status, 0); };
  const eperm = syscall => "import ctypes,errno; libc=ctypes.CDLL(None,use_errno=True); r=" + syscall + "; raise SystemExit(0 if r == -1 and ctypes.get_errno() == errno.EPERM else 1)";
  deny("import ctypes,errno,os; p='/tmp/mount-probe'; os.mkdir(p); libc=ctypes.CDLL(None,use_errno=True); r=libc.syscall(165,b'tmpfs',p.encode(),b'tmpfs',0,0); raise SystemExit(0 if r == -1 and ctypes.get_errno() == errno.EPERM else 1)");
  const denyUnshare = flag => { const result = cp.spawnSync('/usr/bin/unshare', [flag, 'true'], { stdio: 'ignore' }); assert.equal(result.error, undefined, 'unshare probe must start'); assert.notEqual(result.status, 0); };
  denyUnshare('--cgroup');
  denyUnshare('--time');
  deny(eperm('libc.syscall(321, 0, 0, 0)'));
  const parent = ['user','pid','net'].map(kind => fs.readlinkSync('/proc/self/ns/' + kind));
  const child = cp.spawnSync('/usr/bin/bwrap', ['--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--','/usr/local/bin/node','-e', "const fs=require('node:fs'); console.log(JSON.stringify({ns:['user','pid','net'].map(x=>fs.readlinkSync('/proc/self/ns/'+x)), status:fs.readFileSync('/proc/self/status','utf8')}))"], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); const nested = JSON.parse(child.stdout);
  for (const name of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.equal(nested.status.match(new RegExp('^' + name + ':\\s*(.+)$', 'm'))?.[1], '0000000000000000'); assert.equal(nested.status.match(/^NoNewPrivs:\s*(.+)$/m)?.[1], '1');
  assert.equal(nested.ns.every((value, index) => value !== parent[index]), true);
  console.log(JSON.stringify({ uid: process.getuid(), keysVisibility, nestedNamespaces: nested.ns }));
`

try {
  const before = containerIds()
  await mkdir(plugin, { recursive: true })
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'sandbox-source-smoke', version: '1.0.0', private: true, scripts: { check: 'node check.cjs' } }))
  await writeFile(join(repository, 'check.cjs'), check)
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/sandbox-probe', version: '1.0.0', files: ['index.js'] }))
  await writeFile(join(plugin, 'index.js'), 'export const sandboxProbe = true\n')
  execFileSync('pnpm', ['install', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: repository, env, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Sandbox source smoke'); git('config', 'user.email', 'sandbox@example.invalid')
  git('add', '--all'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
  const baseCommit = git('rev-parse', 'HEAD')
  const expected = { seccompSha256: 'b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342', memoryMiB: 1024, pidsLimit: 128, nanoCpus: 2_000_000_000 }
  let calls = 0
  let observedName
  const result = await runDockerPreparedChecks({
    config: { dockerPath: '/usr/bin/docker', image, profile: 'repository', repositorySandbox: { seccompPath }, timeoutMs: 120_000,
      memoryMiB: expected.memoryMiB, cpus: 2, pidsLimit: expected.pidsLimit, workspaceMiB: 2_048, temporaryMiB: 256, outputBytes: 65_536 },
    worktree: repository, baseCommit, name: 'sandbox-probe', scope: ['.'], environment: { ...env, SOURCE_SANDBOX_SECRET: 'must-not-cross' },
    signal: AbortSignal.timeout(130_000), preparedAt: Date.now(),
    assertCurrent: async () => {
      calls += 1
      // Repository seccomp validation has an extra post-version generation
      // fence, so the post-Docker fence is the fourth callback.
      if (calls !== 4) return
      const fresh = [...containerIds()].filter(id => !before.has(id))
      assert.equal(fresh.length, 1, 'exactly one new source-preparation container must exist at post-exit fence')
      observedName = assertContainerBoundary(fresh[0], expected)
    },
  })
  assert.match(result.treeDigest, /^[a-f0-9]{64}$/); assert.match(result.evidence.pack.sha256, /^[a-f0-9]{64}$/)
  assert.ok(result.evidence.commands[0].args.includes(`dsh.source.seccomp.sha256=${expected.seccompSha256}`))
  assert.ok(result.evidence.commands[0].args.includes('systempaths=unconfined'))
  const nameIndex = result.evidence.commands[0].args.indexOf('--name')
  assert.equal(result.evidence.commands[0].args[nameIndex + 1], observedName)
  const after = containerIds()
  assert.deepEqual(after, before, 'runner cleanup must restore the exact pre-existing source-container set')
  const evidence = { kind: 'real-production-source-repository-sandbox-smoke', passed: true, image, baseCommit, result,
    assertions: ['production-runner', 'repository-seccomp-opt-in', 'outer-nonroot-capdrop-nnp-seccomp-network-rootfs-systempaths', 'nested-bwrap-unshare-all', 'post-exit-container-inspection', 'exact-container-set-cleanup'],
    limits: ['synthetic empty-dependency repository', 'keys visibility is recorded without content because kernels differ', 'cancellation and cleanup-timeout paths are covered by source-build unit tests; this smoke runs one successful bounded invocation'] }
  if (process.env.DSH_SOURCE_BUILD_EVIDENCE) await writeFile(resolve(process.env.DSH_SOURCE_BUILD_EVIDENCE), JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally { await rm(root, { recursive: true, force: true }) }
