import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidateHostUnitSource, classifyHostUnitBytes, parseHostUpdatePlan } from '../scripts/install/host-lifecycle.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { createSystemdUserUnit, systemdServicePaths } from '../plugins/lark-channel/src/systemd.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const old = { version: '0.1.5-rc.3', root: '/private/hosts/0.1.5-rc.3',
  dshPath: '/private/hosts/0.1.5-rc.3/node_modules/.bin/dsh',
  binDirectory: '/private/hosts/0.1.5-rc.3/node_modules/.bin',
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, receiptDigest: 'a'.repeat(64) }
const candidate = { ...old, version: '0.1.5-rc.4', root: '/private/hosts/0.1.5-rc.4',
  dshPath: '/private/hosts/0.1.5-rc.4/node_modules/.bin/dsh',
  binDirectory: '/private/hosts/0.1.5-rc.4/node_modules/.bin', receiptDigest: 'b'.repeat(64) }
const binding = (runtime: typeof old) => JSON.stringify({ schemaVersion: 1, cacheRoot: '/private/hosts',
  version: runtime.version, receiptDigest: runtime.receiptDigest }) + '\n'
const plan = { schemaVersion: 1, status: 'update', canonicalHome: '/private/home',
  bindingPath: '/private/home/.dsh-rsi-host.json', originalBindingSource: binding(old),
  originalBindingDigest: digest(binding(old)), originalRuntime: old,
  candidateRuntime: candidate, candidateBindingSource: binding(candidate) }

async function setupControlledUnits({ home, systemdHome, systemdState, systemdLog, fakeSystemctl,
  fakeJournalctl, originalRuntime }: { home: string, systemdHome: string, systemdState: string,
    systemdLog: string, fakeSystemctl: string, fakeJournalctl: string, originalRuntime: typeof old }) {
  const unitDirectory = join(systemdHome, '.config', 'systemd', 'user')
  const wantsDirectory = join(unitDirectory, 'default.target.wants')
  await mkdir(wantsDirectory, { recursive: true, mode: 0o700 })
  const units: Record<string, unknown> = {}
  for (const [profile, active] of [['web', true], ['dormant', false]] as const) {
    const profileDirectory = join(home, 'profiles', profile)
    if (!active) {
      await mkdir(profileDirectory, { mode: 0o700 })
      for (const file of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
        await cp(join(home, 'profiles', 'web', file), join(profileDirectory, file))
      }
    }
    const paths = systemdServicePaths({ home: systemdHome, dshHome: home, profile })
    await writeFile(paths.unitPath, createSystemdUserUnit({ ...paths, dshHome: home, profile,
      profileDirectory, nodePath: process.execPath, dshPath: originalRuntime.dshPath,
      path: `${dirname(process.execPath)}:${originalRuntime.binDirectory}:/usr/bin:/bin` }), { mode: 0o600 })
    await symlink(paths.unitPath, join(wantsDirectory, paths.unitName))
    units[paths.unitName] = { profile, fragmentPath: paths.unitPath, activeState: active ? 'active' : 'inactive',
      subState: active ? 'running' : 'dead', mainPid: active ? 20001 : 0, controlPid: 0,
      invocationId: active ? 'original-web' : '', nRestarts: 0, starts: 0, runtimeMasked: false }
  }
  await writeFile(systemdState, JSON.stringify({ units, nextPid: 30000 }), { mode: 0o600 })
  await writeFile(systemdLog, '')
  const systemctlSource = String.raw`#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2), statePath = __STATE__
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
fs.appendFileSync(__LOG__, JSON.stringify(args) + '\n')
const save = () => fs.writeFileSync(statePath, JSON.stringify(state))
if (args[0] !== '--user') process.exit(90)
if (args[1] === 'list-unit-files' || args[1] === 'list-units') {
  for (const [name, unit] of Object.entries(state.units)) console.log(name + ' loaded ' + unit.activeState + ' ' + unit.subState)
  process.exit(0)
}
if (args[1] === 'daemon-reload') { save(); process.exit(0) }
if (args[1] === 'show') {
  const name = args[2], unit = state.units[name]; if (!unit) process.exit(4)
  const source = fs.readFileSync(unit.fragmentPath, 'utf8')
  const path = /^Environment="(PATH=[^"\n]+)"$/m.exec(source)?.[1]
  const executable = /^ExecStart="([^"]+)" --disable-warning=ExperimentalWarning "([^"]+)"/m.exec(source)
  if (!path || !executable) process.exit(5)
  const control = process.env.HOME + '/.config/systemd/user.control/' + name
  const masked = unit.runtimeMasked || fs.existsSync(control)
  const enabled = fs.existsSync(process.env.HOME + '/.config/systemd/user/default.target.wants/' + name)
  const environment = ['DSH_HOME=' + __HOME__, path,
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/' + process.getuid() + '/bus',
    'XDG_RUNTIME_DIR=/run/user/' + process.getuid()].join(' ')
  const props = { Id:name, LoadState:masked?'masked':'loaded', FragmentPath:unit.fragmentPath, DropInPaths:'',
    ActiveState:unit.activeState, SubState:unit.subState, MainPID:unit.mainPid, ControlPID:unit.controlPid,
    InvocationID:unit.invocationId, NRestarts:unit.nRestarts, UnitFileState:masked?'masked':enabled?'enabled':'disabled',
    WorkingDirectory:__HOME__ + '/profiles/' + unit.profile, Environment:environment,
    ExecStart:'{ path=' + executable[1] + ' ; argv[]=' + executable[1] + ' --disable-warning=ExperimentalWarning '
      + executable[2] + ' --profile ' + unit.profile + ' --no-open ; ignore_errors=no ; }',
    User:'', Group:'', Type:'simple', KillMode:'control-group' }
  const requested = args.filter(value => value.startsWith('--property=')).map(value => value.slice(11))
  console.log(requested.map(key => key + '=' + props[key]).join('\n')); process.exit(0)
}
if (args[1] === 'mask' && args[2] === '--runtime') { for (const name of args.slice(3)) state.units[name].runtimeMasked = true; save(); process.exit(0) }
if (args[1] === 'unmask' && args[2] === '--runtime') { for (const name of args.slice(3)) state.units[name].runtimeMasked = false; save(); process.exit(0) }
if (args[1] === 'stop' || args[1] === 'reset-failed') {
  for (const name of args.slice(2)) { const unit = state.units[name]; unit.activeState='inactive'; unit.subState='dead'; unit.mainPid=0 }
  save(); process.exit(0)
}
if (args[1] === 'start' || args[1] === 'restart') {
  for (const name of args.slice(2)) { const unit = state.units[name]; unit.starts++;
    unit.activeState='active'; unit.subState='running'; unit.mainPid=++state.nextPid;
    unit.invocationId='fresh-' + unit.profile + '-' + state.nextPid }
  if (state.failAfterStartOnce) { state.failAfterStartOnce = false; save(); process.exit(6) }
  save(); process.exit(0)
}
process.exit(91)
`
  await writeFile(fakeSystemctl, systemctlSource.replace(/^#!\/usr\/bin\/env node/u, `#!${process.execPath}`)
    .replaceAll('__STATE__', JSON.stringify(systemdState))
    .replaceAll('__LOG__', JSON.stringify(systemdLog)).replaceAll('__HOME__', JSON.stringify(home)), { mode: 0o700 })
  await writeFile(fakeJournalctl, String.raw`#!/usr/bin/env node
const invocation = process.argv.find(arg => arg.startsWith('_SYSTEMD_INVOCATION_ID='))?.split('=')[1]
if (invocation?.startsWith('fresh-')) process.stdout.write('dsh-enhanced host ready: v1\n')
else process.stdout.write('old invocation\n')
`.replace(/^#!\/usr\/bin\/env node/u, `#!${process.execPath}`), { mode: 0o700 })
}

async function controlledHostFixture(withUnits = false, dumpLink: 'none' | 'external' | 'candidate' = 'none') {
  // bwrap intentionally overlays /tmp; keep the verified Host outside it.
  const root = await mkdtemp(join(resolve('tests'), '.dsh-host-transaction-'))
  const home = join(root, 'home'), cache = join(root, 'hosts')
  const install = join(root, 'install'), fakeSystemctl = join(root, 'systemctl')
  const fakeJournalctl = join(root, 'journalctl'), systemdHome = join(root, 'systemd-home')
  const systemdState = join(root, 'systemd-state.json'), systemdLog = join(root, 'systemd.log')
  await mkdir(join(home, 'profiles', 'web'), { recursive: true, mode: 0o700 })
  await mkdir(cache, { mode: 0o700 })
  await mkdir(install, { mode: 0o700 })
  await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'test-profile', version: '1.0.0', dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }) + '\n', { mode: 0o600 })
  await writeFile(join(home, 'profiles', 'web', 'pnpm-workspace.yaml'), 'packages: []\n', { mode: 0o600 })
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'plugins: []\n', { mode: 0o600 })
  const yamlSource = await import.meta.resolve('yaml')
  const yamlRoot = resolve(dirname(new URL(yamlSource).pathname), '..')
  const makeRuntime = async (version: string) => {
    const runtimeRoot = join(cache, version)
    const native = join(runtimeRoot, 'node_modules', '@deepseek-ai')
    const binDirectory = join(runtimeRoot, 'node_modules', '.bin')
    const executable = join(binDirectory, 'dsh')
    await mkdir(join(native, 'dsh', 'lib'), { recursive: true, mode: 0o700 })
    await mkdir(join(native, 'dsh-base'), { recursive: true, mode: 0o700 })
    await mkdir(join(native, 'dsh-skill-filesystem'), { recursive: true, mode: 0o700 })
    await mkdir(binDirectory, { recursive: true, mode: 0o700 })
    await chmod(runtimeRoot, 0o700)
    await cp(yamlRoot, join(runtimeRoot, 'node_modules', 'yaml'), { recursive: true, dereference: true })
    await writeFile(join(native, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version,
      bin: { dsh: 'lib/bin.js' }, dependencies: { '@deepseek-ai/dsh-skill-filesystem': `^${version}` } }) + '\n')
    await writeFile(join(native, 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version }) + '\n')
    await writeFile(join(native, 'dsh-skill-filesystem', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-skill-filesystem', version, dependencies: { yaml: '^2.4.2' },
    }) + '\n')
    await writeFile(join(runtimeRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      'node_modules/@deepseek-ai/dsh': { version, integrity: old.integrity,
        dependencies: { '@deepseek-ai/dsh-skill-filesystem': `^${version}` } },
      'node_modules/@deepseek-ai/dsh-base': { version, integrity: old.integrity },
      'node_modules/@deepseek-ai/dsh-skill-filesystem': { version, integrity: old.integrity,
        dependencies: { yaml: '^2.4.2' } },
    } }) + '\n')
    const dumpMutation = version !== '0.1.5-rc.4' ? '' : dumpLink === 'external'
      ? `require('node:fs').symlinkSync('/etc/hosts', process.env.DSH_HOME + '/unexpected-link'); `
      : dumpLink === 'candidate'
        ? `require('node:fs').mkdirSync(process.env.DSH_HOME + '/profiles/web/node_modules', { recursive: true }); `
          + `require('node:fs').symlinkSync('${runtimeRoot}/node_modules/@deepseek-ai/dsh', `
          + `process.env.DSH_HOME + '/profiles/web/node_modules/host-native'); ` : ''
    await writeFile(join(native, 'dsh', 'lib', 'bin.js'), `#!${process.execPath}\n`
      + `if (process.argv.includes('--version')) process.stdout.write('${version}\\n')\n`
      + `else if (process.argv.includes('--dump-config')) { ${dumpMutation}process.stdout.write('service: {}\\n') }\n`
      + `else process.exit(2)\n`, { mode: 0o700 })
    await symlink('../@deepseek-ai/dsh/lib/bin.js', executable)
    const entries: Array<Record<string, unknown>> = []
    const walk = async (directory: string) => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name), item = await lstat(path)
        const entryPath = relative(runtimeRoot, path).split('\\').join('/')
        if (item.isDirectory()) { entries.push({ path: entryPath, type: 'directory', mode: item.mode & 0o777 }); await walk(path) }
        else if (item.isFile()) entries.push({ path: entryPath, type: 'file', mode: item.mode & 0o777,
          sha256: digest(await readFile(path)) })
        else if (item.isSymbolicLink()) entries.push({ path: entryPath, type: 'link', mode: item.mode & 0o777,
          target: await readlink(path) })
      }
    }
    await walk(runtimeRoot)
    const receipt = { schemaVersion: 1, version, integrity: old.integrity, tarball: 'fixture', entries }
    await writeFile(join(runtimeRoot, 'receipt.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    return { version, root: runtimeRoot, dshPath: executable, binDirectory, integrity: old.integrity,
      receiptDigest: digest(JSON.stringify(receipt)) }
  }
  const originalRuntime = await makeRuntime('0.1.5-rc.3')
  const candidateRuntime = await makeRuntime('0.1.5-rc.4')
  const originalBindingSource = JSON.stringify({ schemaVersion: 1, cacheRoot: cache,
    version: originalRuntime.version, receiptDigest: originalRuntime.receiptDigest }) + '\n'
  const candidateBindingSource = JSON.stringify({ schemaVersion: 1, cacheRoot: cache,
    version: candidateRuntime.version, receiptDigest: candidateRuntime.receiptDigest }) + '\n'
  await writeFile(join(home, '.dsh-rsi-host.json'), originalBindingSource, { mode: 0o600 })
  const hostPlan = { schemaVersion: 1, status: 'update', canonicalHome: home,
    bindingPath: join(home, '.dsh-rsi-host.json'), originalBindingSource,
    originalBindingDigest: digest(originalBindingSource), originalRuntime, candidateRuntime, candidateBindingSource }
  const planPath = join(root, 'plan.json')
  await writeFile(planPath, JSON.stringify(hostPlan), { mode: 0o600 })
  const lifecycleSource = await readFile(resolve('scripts/install/lifecycle-profile.mjs'), 'utf8')
  const marker = 'async function trustedServiceExecutable(path, name) {\n'
  if (!lifecycleSource.includes(marker)) throw new Error('service trust seam changed')
  let patched = lifecycleSource.replace(marker, marker
    + `  if (process.env.DSH_HOST_TEST_SYSTEMCTL === path && name === 'systemctl') return await realpath(path)\n`
    + `  if (process.env.DSH_HOST_TEST_JOURNALCTL === path && name === 'journalctl') return await realpath(path)\n`)
  if (withUnits) {
    const timeoutMarker = 'function serviceTimeouts() {\n'
    if (!patched.includes(timeoutMarker)) throw new Error('service timeout seam changed')
    patched = patched.replace(timeoutMarker, timeoutMarker
      + '  if (process.env.DSH_HOST_TEST_FAST === "1") return { stop: 1000, ready: 1000, stability: 100, stabilitySamples: 2 }\n')
  }
  // The copied transaction runs alongside unrelated Vitest files. Their
  // same-UID subprocesses can be non-dumpable, so the production fail-closed
  // /proc gate cannot establish this fixture's unrelated process inventory.
  const processScanMarker = 'async function assertNoUnmanagedHomeProcesses(homePath, equivalentHomePaths = []) {\n'
  if (!patched.includes(processScanMarker)) throw new Error('Host process scan seam changed')
  patched = patched.replace(processScanMarker, processScanMarker
    + "  if (process.env.DSH_HOST_TEST_ISOLATED_HOME === '1') return\n")
  const crashMarker = "  manifest = await writeManifest(physicalTransactionRoot, { ...manifest,\n    hostMigration: { ...manifest.hostMigration, phase: 'original-renamed' } }, 'original-renamed')"
  if (!patched.includes(crashMarker)) throw new Error('Host rename seam changed')
  patched = patched.replace(crashMarker, crashMarker
    + "\n  if (process.env.DSH_HOST_TEST_CRASH_RENAME === '1') process.kill(process.pid, 'SIGKILL')")
  await writeFile(join(install, 'lifecycle-profile.mjs'), patched)
  for (const name of ['lifecycle-config.mjs', 'host-lifecycle.mjs', 'host-profile-update.mjs', 'host-rsi-update.mjs']) {
    await cp(resolve('scripts', 'install', name), join(install, name))
  }
  if (withUnits) await setupControlledUnits({ home, systemdHome, systemdState, systemdLog,
    fakeSystemctl, fakeJournalctl, originalRuntime })
  else {
    await writeFile(fakeSystemctl, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(fakeJournalctl, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }
  const run = (operation: 'host-update' | 'host-recover', crash = false) => spawnSync(process.execPath, [
    join(install, 'lifecycle-profile.mjs'), operation, 'web', home,
    operation === 'host-update' ? originalRuntime.dshPath : process.execPath,
    operation === 'host-update' ? '/usr/bin/bwrap' : '/nonexistent/bwrap-not-required-for-recovery',
    fakeSystemctl, fakeJournalctl, ...(operation === 'host-update' ? [planPath] : []),
  ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env,
    DSH_HOST_TEST_SYSTEMCTL: fakeSystemctl,
    DSH_HOST_TEST_JOURNALCTL: fakeJournalctl,
    DSH_HOST_TEST_ISOLATED_HOME: '1',
    ...(withUnits ? { HOME: systemdHome, DSH_HOST_TEST_FAST: '1',
      DSH_HOST_TEST_STATE: systemdState, DSH_HOST_TEST_LOG: systemdLog, DSH_HOST_TEST_HOME: home } : {}),
    ...(crash ? { DSH_HOST_TEST_CRASH_RENAME: '1' } : {}),
  } })
  return { root, home, run, originalBindingSource, candidateBindingSource, systemdState, systemdLog,
    unitDirectory: join(systemdHome, '.config', 'systemd', 'user'), originalRuntime, candidateRuntime }
}

async function treeSnapshot(root: string): Promise<string> {
  const entries: unknown[] = []
  const visit = async (path: string): Promise<void> => {
    const item = await lstat(path), name = relative(root, path)
    if (item.isDirectory()) {
      entries.push([name, 'directory', item.mode & 0o777])
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else if (item.isFile()) entries.push([name, 'file', item.mode & 0o777,
      createHash('sha256').update(await readFile(path)).digest('hex')])
    else if (item.isSymbolicLink()) entries.push([name, 'link', await readlink(path)])
    else throw new Error(`unexpected snapshot entry: ${path}`)
  }
  await visit(root)
  return digest(JSON.stringify(entries))
}

describe('managed Host transaction inputs', () => {
  const itLinux = process.platform === 'linux' ? it : it.skip

  itLinux('admits only the captured owner observer socket before stop and discards only its disposable copy', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-observer-copy-')))
    const home = join(root, 'home'), profile = 'assistant'
    const stateRoot = join(home, 'rsi-authorities', profile, 'state')
    const socketPath = join(stateRoot, 'observer.sock')
    const stageHome = join(root, 'candidate')
    const server = createServer()
    let replacement: ReturnType<typeof createServer> | undefined
    let other: ReturnType<typeof createServer> | undefined
    try {
      await mkdir(stateRoot, { recursive: true, mode: 0o700 })
      await new Promise<void>((resolveListen, reject) => server.listen(socketPath, resolveListen).once('error', reject))
      await chmod(socketPath, 0o600)
      const sourceProof = { protocol: 'dsh-enhanced/host-owner-source-repair/v1', ownerRepair: {
        homePath: home, profile, original: { resources: { stateRoot }, manifest: { controlPlane: {
          runtimeObserver: { socketPath } } } } } }
      const capture = lifecycleProfileTest.captureOwnerRepairObserverSocket
      await expect(capture({ ...sourceProof, protocol: 'forged' }, home, profile)).rejects.toThrow('not bound')
      await expect(capture({ ...sourceProof, ownerRepair: { ...sourceProof.ownerRepair,
        original: { ...sourceProof.ownerRepair.original, manifest: { controlPlane: {
          runtimeObserver: { socketPath: join(home, 'unapproved.sock') } } } } } }, home, profile))
        .rejects.toThrow('not bound')
      const bound = await capture(sourceProof, home, profile)
      expect(bound).toBeDefined()
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(home, home, true, undefined, bound)).resolves.toBeDefined()
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(home)).rejects.toThrow('特殊文件')
      await mkdir(stageHome, { mode: 0o700 })
      const copied = spawnSync('/bin/cp', ['-a', '--no-preserve=links', '--reflink=auto', '--', `${home}/.`, stageHome], { encoding: 'utf8' })
      expect(copied.status, copied.stderr).toBe(0)
      expect((await lstat(join(stageHome, 'rsi-authorities', profile, 'state', 'observer.sock'))).isSocket()).toBe(true)
      await lifecycleProfileTest.discardCopiedOwnerObserverSocket(home, stageHome, bound)
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(stageHome, home)).resolves.toBeDefined()
      expect((await lstat(socketPath)).isSocket()).toBe(true)
      const rogue = join(stateRoot, 'rogue.sock')
      other = createServer()
      await new Promise<void>((resolveListen, reject) => other!.listen(rogue, resolveListen).once('error', reject))
      await chmod(rogue, 0o600)
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(home, home, true, undefined, bound)).rejects.toThrow('特殊文件')
      await new Promise<void>(resolveClose => other!.close(resolveClose))
      other = undefined
      const fifo = join(stateRoot, 'rogue.fifo')
      const mkfifo = spawnSync('/usr/bin/mkfifo', [fifo], { encoding: 'utf8' })
      expect(mkfifo.status, mkfifo.stderr).toBe(0)
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(home, home, true, undefined, bound)).rejects.toThrow('特殊文件')
      await rm(fifo)
      await rename(socketPath, join(root, 'held-observer.sock'))
      await symlink(join(home, 'rsi-authorities'), socketPath)
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(home, home, true, undefined, bound)).rejects.toThrow('changed type')
      await rm(socketPath)
      const replacedByFifo = spawnSync('/usr/bin/mkfifo', [socketPath], { encoding: 'utf8' })
      expect(replacedByFifo.status, replacedByFifo.stderr).toBe(0)
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(home, home, true, undefined, bound)).rejects.toThrow('changed type')
      await rm(socketPath)
      replacement = createServer()
      await new Promise<void>((resolveListen, reject) => replacement!.listen(socketPath, resolveListen).once('error', reject))
      await chmod(socketPath, 0o600)
      await expect(lifecycleProfileTest.assertSnapshotTreeSafe(home, home, true, undefined, bound)).rejects.toThrow('changed before snapshot')
    } finally {
      if (other) await new Promise<void>(resolveClose => other!.close(resolveClose))
      if (replacement) await new Promise<void>(resolveClose => replacement!.close(resolveClose))
      await new Promise<void>(resolveClose => server.close(resolveClose))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('admits settings recovery only for its accepted started joint transaction and exact permit', () => {
    const envelope = { permit: { transactionId: 'transaction-a', homePath: '/private/home', profile: 'assistant',
      baseManifestDigest: 'a'.repeat(64) }, replayReceipt: {} }
    const manifest = { version: 4, operation: 'host-update', state: 'swapped', id: 'transaction-a',
      homePath: '/private/home', profile: 'assistant', bindingDigest: 'a'.repeat(64),
      services: [{ profile: 'assistant', wasActive: true }], hostMigration: { phase: 'accepted',
        candidateEverStarted: true, localSource: {}, plan: { schemaVersion: 2, candidateRuntime: { version: '0.2.0-rc.2' } } } }
    const admit = lifecycleProfileTest.assertHostSettingsRecoveryAdmission
    expect(() => admit(manifest, envelope)).not.toThrow()
    for (const changed of [
      { ...manifest, state: 'preparing' },
      { ...manifest, id: 'other-transaction' },
      { ...manifest, bindingDigest: 'b'.repeat(64) },
      { ...manifest, services: [] },
      { ...manifest, hostMigration: { ...manifest.hostMigration, phase: 'starting' } },
      { ...manifest, hostMigration: { ...manifest.hostMigration, candidateEverStarted: false } },
      { ...manifest, hostMigration: { ...manifest.hostMigration, localSource: undefined } },
    ]) expect(() => admit(changed, envelope)).toThrow(/native settings recovery/u)
    const persisted = { ...manifest, bindingDigest: 'b'.repeat(64),
      hostMigration: { ...manifest.hostMigration, nativeSettingsImport: envelope } }
    expect(() => admit(persisted, structuredClone(envelope))).not.toThrow()
    expect(() => admit({ ...persisted, hostMigration: { ...persisted.hostMigration, phase: 'starting' } }, envelope))
      .not.toThrow()
    expect(() => admit(persisted, { ...envelope, replayReceipt: { different: true } }))
      .toThrow('permit already differs')
  })

  it('requires a bound installed mask and a masked quiescent unit before admitting settings recovery', () => {
    const state = { loadState: 'masked', activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0 }
    const assertState = lifecycleProfileTest.assertHostSettingsRecoveryServiceState
    expect(() => assertState('installed', state)).not.toThrow()
    for (const location of ['staged', 'missing']) {
      expect(() => assertState(location, state)).toThrow('bound masked inactive services')
    }
    for (const changed of [
      { ...state, loadState: 'loaded' }, { ...state, activeState: 'activating' },
      { ...state, subState: 'running' }, { ...state, mainPid: 42 }, { ...state, controlPid: 42 },
    ]) expect(() => assertState('installed', changed)).toThrow('bound masked inactive services')
  })

  itLinux('reads settings recovery permits only from private canonical external files', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-settings-permit-')))
    const home = join(root, 'home'), permitPath = join(root, 'permit.json')
    const envelope = { permit: {}, replayReceipt: {} }
    try {
      await mkdir(home)
      await writeFile(permitPath, JSON.stringify(envelope), { mode: 0o600 })
      await expect(lifecycleProfileTest.readHostSettingsRecoveryFile(permitPath, home)).resolves.toEqual(envelope)
      await symlink(permitPath, join(root, 'alias.json'))
      await expect(lifecycleProfileTest.readHostSettingsRecoveryFile(join(root, 'alias.json'), home))
        .rejects.toThrow('canonical')
      await writeFile(join(home, 'permit.json'), JSON.stringify(envelope), { mode: 0o600 })
      await expect(lifecycleProfileTest.readHostSettingsRecoveryFile(join(home, 'permit.json'), home))
        .rejects.toThrow('outside Home')
      await chmod(permitPath, 0o644)
      await expect(lifecycleProfileTest.readHostSettingsRecoveryFile(permitPath, home)).rejects.toThrow('owner-private')
      await chmod(permitPath, 0o600)
      await writeFile(permitPath, JSON.stringify({ ...envelope, extra: true }))
      await expect(lifecycleProfileTest.readHostSettingsRecoveryFile(permitPath, home)).rejects.toThrow('invalid native')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  itLinux('canonicalizes the locked candidate Home for joint post-swap verification only', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-canonical-')))
    const parent = await open(root, 'r')
    try {
      const home = join(root, 'home'), otherHome = join(root, 'other')
      await mkdir(home)
      await mkdir(otherHome)
      const anchoredHome = `/proc/self/fd/${parent.fd}/home`
      await expect(lifecycleProfileTest.canonicalJointCandidateHome(anchoredHome, home)).resolves.toBe(home)
      await expect(lifecycleProfileTest.canonicalJointCandidateHome(anchoredHome, otherHome))
        .rejects.toThrow('does not resolve to the canonical Home')
      const source = await readFile(new URL('../scripts/install/lifecycle-profile.mjs', import.meta.url), 'utf8')
      expect(source.match(/physicalHome: candidateHome,\s+selection: 'candidate'/gu)).toHaveLength(2)
      expect(source).toContain("selection: 'candidate', checkLedger: ownerRepair")
      expect(source).toContain('stagedHome: candidateHome, originalPhysicalHome: backupHome')
    } finally {
      await parent.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes trust_lockfile only for offline materialize in the production bwrap invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-host-bwrap-'))
    try {
      const executable = join(root, 'capture-bwrap'), captured = join(root, 'args.json')
      await writeFile(executable, `#!${process.execPath}\n`
        + `require('node:fs').writeFileSync(${JSON.stringify(captured)}, JSON.stringify(process.argv.slice(2)))\n`,
      { mode: 0o700 })
      const invoke = async (phase: string, trust: string) => {
        await lifecycleProfileTest.hostSandboxRun({ bwrapExecutable: executable,
          preparationRoot: root, stageHome: join(root, 'stage'), logicalHome: join(root, 'home'),
          command: '/usr/bin/true', args: [], cwd: root, phase,
          environment: { pnpm_config_trust_lockfile: trust } })
        const args = JSON.parse(await readFile(captured, 'utf8')) as string[]
        const values = new Map<string, string>()
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === '--setenv') values.set(args[index + 1], args[index + 2])
        }
        return { args, values }
      }
      for (const phase of ['resolve', 'fetch']) {
        const { args, values } = await invoke(phase, 'true')
        expect(values.get('pnpm_config_trust_lockfile')).toBe('false')
        expect(args).not.toContain('--unshare-net')
      }
      const materialize = await invoke('materialize', 'false')
      expect(materialize.values.get('pnpm_config_trust_lockfile')).toBe('true')
      expect(materialize.values.get('pnpm_config_offline')).toBe('true')
      expect(materialize.values.get('pnpm_config_frozen_lockfile')).toBe('true')
      expect(materialize.args).toContain('--unshare-net')
      const fallback = await invoke('fallback', 'true')
      expect(fallback.values.get('pnpm_config_trust_lockfile')).toBe('false')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('binds both exact runtimes to one Home and rejects a changed binding', () => {
    expect(parseHostUpdatePlan(plan, '/private/home')).toEqual(plan)
    expect(() => parseHostUpdatePlan({ ...plan, originalBindingDigest: '0'.repeat(64) }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...plan, canonicalHome: '/another/home' }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...plan, candidateBindingSource: binding(old) }, '/private/home')).toThrow()
  })

  it('treats an exact current-version plan as a no-op input', () => {
    expect(parseHostUpdatePlan({ ...plan, status: 'current', candidateRuntime: old,
      candidateBindingSource: binding(old) }, '/private/home').status).toBe('current')
  })

  it('accepts an exact 0.2 candidate for an existing schema 1 binding', () => {
    const next = { ...candidate, version: '0.2.0-rc.2', root: '/private/hosts/0.2.0-rc.2',
      dshPath: '/private/hosts/0.2.0-rc.2/node_modules/.bin/dsh',
      binDirectory: '/private/hosts/0.2.0-rc.2/node_modules/.bin' }
    expect(parseHostUpdatePlan({ ...plan, candidateRuntime: next,
      candidateBindingSource: binding(next) }, '/private/home').candidateRuntime).toEqual(next)
  })

  it('accepts only a null-bound schema 2 legacy-to-0.2 plan in the same cache', () => {
    const next = { ...candidate, version: '0.2.0-rc.2', root: '/private/hosts/0.2.0-rc.2',
      dshPath: '/private/hosts/0.2.0-rc.2/node_modules/.bin/dsh',
      binDirectory: '/private/hosts/0.2.0-rc.2/node_modules/.bin' }
    const unbound = { ...plan, schemaVersion: 2, originalBindingSource: null,
      originalBindingDigest: null, candidateRuntime: next, candidateBindingSource: binding(next) }
    expect(parseHostUpdatePlan(unbound, '/private/home')).toEqual(unbound)
    expect(() => parseHostUpdatePlan({ ...unbound, originalBindingSource: binding(old) }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...unbound, originalBindingDigest: digest(binding(old)) }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...unbound, status: 'current' }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...unbound, candidateRuntime: candidate,
      candidateBindingSource: binding(candidate) }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...unbound, candidateBindingSource: JSON.stringify({
      schemaVersion: 1, cacheRoot: '/foreign', version: next.version,
      receiptDigest: next.receiptDigest,
    }) + '\n' }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...unbound, originalRuntime: { ...old, version: '0.1.5-rc.2' } }, '/private/home')).toThrow()
    expect(() => parseHostUpdatePlan({ ...unbound, candidateRuntime: { ...next, version: '0.2.1-alpha.2' } }, '/private/home')).toThrow()
  })

  itLinux.each([1, 2] as const)('rejects a schema %s direct cross-ABI Host update before changing Home', async schemaVersion => {
    const fixture = await controlledHostFixture()
    try {
      const planPath = join(fixture.root, 'plan.json')
      const original = JSON.parse(await readFile(planPath, 'utf8')) as {
        schemaVersion: number; originalBindingSource: string | null; originalBindingDigest: string | null;
        candidateRuntime: typeof old; candidateBindingSource: string
      }
      const nextRoot = join(dirname(fixture.originalRuntime.root), '0.2.0-rc.2')
      const nextRuntime = { ...original.candidateRuntime, version: '0.2.0-rc.2', root: nextRoot,
        dshPath: join(nextRoot, 'node_modules', '.bin', 'dsh'),
        binDirectory: join(nextRoot, 'node_modules', '.bin') }
      const nextBinding = `${JSON.stringify({ schemaVersion: 1, cacheRoot: dirname(nextRoot),
        version: nextRuntime.version, receiptDigest: nextRuntime.receiptDigest })}\n`
      await writeFile(planPath, JSON.stringify({ ...original, schemaVersion, candidateRuntime: nextRuntime,
        candidateBindingSource: nextBinding,
        ...(schemaVersion === 2 ? { originalBindingSource: null, originalBindingDigest: null } : {}) }), { mode: 0o600 })
      if (schemaVersion === 2) await rm(join(fixture.home, '.dsh-rsi-host.json'))
      const beforeHome = await treeSnapshot(fixture.home)
      const beforeCache = await treeSnapshot(dirname(fixture.originalRuntime.root))
      const result = fixture.run('host-update')
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(schemaVersion === 1
        ? /cross-ABI Host migration requires a verified joint local source transaction/u
        : /cross-ABI Host migration requires a verified joint local source transaction|unbound Host migration requires a verified joint local source transaction/u)
      expect(await treeSnapshot(fixture.home)).toBe(beforeHome)
      expect(await treeSnapshot(dirname(fixture.originalRuntime.root))).toBe(beforeCache)
      await expect(lstat(`${fixture.home}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(nextRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  it('changes only the Host executable and PATH of an exact unit', () => {
    const service = { profile: 'owner', nodePath: '/usr/bin/node', dshPath: old.dshPath,
      pathEnvironment: `PATH=/usr/bin:${old.binDirectory}:/bin` }
    const before = `[Unit]\nDescription=example\n[Service]\nEnvironment="PATH=/usr/bin:${old.binDirectory}:/bin"\n`
      + `ExecStart="/usr/bin/node" --disable-warning=ExperimentalWarning "${old.dshPath}" --profile owner --no-open\n`
      + 'Environment="DSH_HOME=/private/home"\n'
    const result = candidateHostUnitSource(service, before, old.dshPath, candidate.dshPath, old.root)
    expect(result.source).toContain(`ExecStart="/usr/bin/node" --disable-warning=ExperimentalWarning "${candidate.dshPath}"`)
    expect(result.source).toContain('Environment="DSH_HOME=/private/home"')
    expect(result.source).toContain(candidate.binDirectory)
    expect(result.source).not.toContain(old.binDirectory)
    expect(result.pathEnvironment.split(':')[0]).toBe(`PATH=${candidate.binDirectory}`)
    expect(classifyHostUnitBytes(before, before, result.source)).toBe('before')
    expect(classifyHostUnitBytes(result.source, before, result.source)).toBe('after')
    expect(() => classifyHostUnitBytes('tampered', before, result.source)).toThrow()
  })

  it('accepts a canonical DSH executable and removes every old Host PATH entry', () => {
    const canonicalDsh = `${old.root}/node_modules/@deepseek-ai/dsh/lib/bin.js`
    const service = { profile: 'owner', nodePath: '/usr/bin/node', dshPath: canonicalDsh,
      pathEnvironment: `PATH=/usr/bin:${old.binDirectory}:${old.root}/node_modules:/bin` }
    const before = `[Service]\nEnvironment="${service.pathEnvironment}"\n`
      + `ExecStart="/usr/bin/node" --disable-warning=ExperimentalWarning "${canonicalDsh}" --profile owner --no-open\n`
    const result = candidateHostUnitSource(service, before, canonicalDsh, candidate.dshPath, old.root)
    expect(result.source).toContain(candidate.dshPath)
    expect(result.pathEnvironment).toContain(candidate.binDirectory)
    expect(result.pathEnvironment.split(':')[0]).toBe(`PATH=${candidate.binDirectory}`)
    expect(result.pathEnvironment).not.toContain(old.root)
  })

  itLinux('returns current without creating a transaction or touching Home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-host-current-'))
    try {
      const home = join(root, 'home')
      const cache = join(root, 'hosts')
      const runtimeRoot = join(cache, old.version)
      const binDirectory = join(runtimeRoot, 'node_modules', '.bin')
      const executable = join(binDirectory, 'dsh')
      await mkdir(home, { mode: 0o700 })
      await mkdir(binDirectory, { recursive: true, mode: 0o700 })
      await chmod(cache, 0o700)
      await chmod(runtimeRoot, 0o700)
      await chmod(join(runtimeRoot, 'node_modules'), 0o700)
      await chmod(binDirectory, 0o700)
      const executableSource = `#!/bin/sh\necho ${old.version}\n`
      await writeFile(executable, executableSource, { mode: 0o700 })
      const receipt = { schemaVersion: 1, version: old.version, integrity: old.integrity,
        tarball: 'fixture', entries: [
          { path: 'node_modules', type: 'directory', mode: 0o700 },
          { path: 'node_modules/.bin', type: 'directory', mode: 0o700 },
          { path: 'node_modules/.bin/dsh', type: 'file', mode: 0o700, sha256: digest(executableSource) },
        ] }
      await writeFile(join(runtimeRoot, 'receipt.json'), `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
      const runtime = { version: old.version, root: runtimeRoot, dshPath: executable,
        binDirectory, integrity: old.integrity, receiptDigest: digest(JSON.stringify(receipt)) }
      const source = `${JSON.stringify({ schemaVersion: 1, cacheRoot: cache,
        version: runtime.version, receiptDigest: runtime.receiptDigest })}\n`
      await writeFile(join(home, '.dsh-rsi-host.json'), source, { mode: 0o600 })
      const currentPlan = { schemaVersion: 1, status: 'current', canonicalHome: home,
        bindingPath: join(home, '.dsh-rsi-host.json'), originalBindingSource: source,
        originalBindingDigest: digest(source), originalRuntime: runtime,
        candidateRuntime: runtime, candidateBindingSource: source }
      const path = join(root, 'plan.json')
      await writeFile(path, JSON.stringify(currentPlan), { mode: 0o600 })
      const script = resolve('scripts/install/lifecycle-profile.mjs')
      // /usr/bin/false satisfies the production executable trust gate while
      // making any accidental service operation fail this current-version test.
      const result = spawnSync(process.execPath, [script, 'host-update', 'owner', home, executable,
        '/usr/bin/bwrap', '/usr/bin/false', '/usr/bin/false', path],
      { encoding: 'utf8', timeout: 30_000 })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('managed Host already current')
      expect(await readFile(join(home, '.dsh-rsi-host.json'), 'utf8')).toBe(source)
      await expect(readFile(`${home}.dsh-enhanced-transaction/manifest.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 35_000)

  it('requires a fresh owner-bound RSI runtime successor with stable database identities', () => {
    const database = { device: 12, inode: 34 }
    const baseline = { effectiveConfigDigest: 'config', ownerBindingDigest: 'owner',
      unmanagedAutomationsDigest: 'unmanaged', databasePaths: { recovery: 'recovery.sqlite' },
      deliveryProof: { database }, recoveryProof: { database, bootstrap: { generation: 8,
        attestationSetDigest: 'attestation' } }, automationsProof: { database } }
    const current = { ...baseline, recoveryProof: { ...baseline.recoveryProof,
      bootstrap: { ...baseline.recoveryProof.bootstrap, generation: 9 } },
    activePlan: { effectiveConfigDigest: 'config', attestationSetDigest: 'attestation' } }
    const verify = lifecycleProfileTest.assertHostRsiRuntimeSuccessor
    expect(() => verify(baseline, current, { stage: 'active' })).not.toThrow()
    expect(() => verify(baseline, { ...current, ownerBindingDigest: 'other' }, { stage: 'active' })).toThrow()
    expect(() => verify(baseline, { ...current, recoveryProof: baseline.recoveryProof }, { stage: 'active' })).toThrow()
    expect(() => verify(baseline, { ...current, deliveryProof: { database: { device: 12, inode: 35 } } },
      { stage: 'active' })).toThrow()
    expect(() => verify(baseline, current, { stage: 'preview' })).toThrow()
  })

  itLinux('switches an unregistered Home to the candidate Host through the full v4 transaction', async () => {
    const fixture = await controlledHostFixture()
    try {
      const result = fixture.run('host-update')
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('managed Host updated: 0.1.5-rc.3 -> 0.1.5-rc.4')
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.candidateBindingSource)
      await expect(lstat(`${fixture.home}.dsh-enhanced-transaction`))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  itLinux('migrates an active unit and preserves an inactive same-Home sibling', async () => {
    const fixture = await controlledHostFixture(true)
    try {
      const result = fixture.run('host-update')
      expect(result.status, result.stderr).toBe(0)
      const state = JSON.parse(await readFile(fixture.systemdState, 'utf8'))
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active',
        invocationId: 'fresh-web-30001', starts: 1, runtimeMasked: false })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive',
        mainPid: 0, starts: 0, runtimeMasked: false })
      for (const profile of ['web', 'dormant']) {
        const source = await readFile(join(fixture.unitDirectory, `dsh-profile-${profile}.service`), 'utf8')
        expect(source).toContain(fixture.candidateRuntime.dshPath)
        expect(source).toContain(`Environment="PATH=${fixture.candidateRuntime.binDirectory}:`)
        expect(source).not.toContain(fixture.originalRuntime.root)
      }
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.candidateBindingSource)
      const commands = (await readFile(fixture.systemdLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(commands.some(args => args[1] === 'start' && args.includes('dsh-profile-web.service'))).toBe(true)
      expect(commands.some(args => args[1] === 'start' && args.includes('dsh-profile-dormant.service'))).toBe(false)
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  itLinux('rejects an external Home symlink created by candidate dump-config before swap', async () => {
    const fixture = await controlledHostFixture(false, 'external')
    try {
      const result = fixture.run('host-update')
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/DSH_HOME 包含指向外部的符号链接|unapproved external package link/u)
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.originalBindingSource)
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  itLinux('allows a staged node_modules link into the receipt-verified candidate Host', async () => {
    const fixture = await controlledHostFixture(false, 'candidate')
    try {
      const result = fixture.run('host-update')
      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.candidateBindingSource)
      expect(await readlink(join(fixture.home, 'profiles', 'web', 'node_modules', 'host-native')))
        .toBe(join(fixture.candidateRuntime.root, 'node_modules', '@deepseek-ai', 'dsh'))
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  itLinux('recovers the original Home after a v4 rename-gap crash with simulated empty unmanaged-process inventory', async () => {
    const fixture = await controlledHostFixture()
    try {
      const crashed = fixture.run('host-update', true)
      const crashEvidence = `status=${crashed.status} signal=${crashed.signal} stderr=${crashed.stderr}`
      expect(crashed.status, crashEvidence).not.toBe(0)
      const homeAfterCrash = await lstat(fixture.home).then(() => 'present', error => error?.code)
      if (homeAfterCrash !== 'ENOENT') console.error(crashEvidence)
      expect(homeAfterCrash, crashEvidence).toBe('ENOENT')
      const recovered = fixture.run('host-recover')
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.originalBindingSource)
      await expect(lstat(`${fixture.home}.dsh-enhanced-transaction`))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  itLinux('restores original unit bytes and active set after a prestart rename-gap crash', async () => {
    const fixture = await controlledHostFixture(true)
    try {
      const before = await Promise.all(['web', 'dormant'].map(profile =>
        readFile(join(fixture.unitDirectory, `dsh-profile-${profile}.service`), 'utf8')))
      const crashed = fixture.run('host-update', true)
      expect(crashed.status).not.toBe(0)
      await expect(lstat(fixture.home)).rejects.toMatchObject({ code: 'ENOENT' })
      const recovered = fixture.run('host-recover')
      expect(recovered.status, recovered.stderr).toBe(0)
      const state = JSON.parse(await readFile(fixture.systemdState, 'utf8'))
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active',
        invocationId: 'fresh-web-30001', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive',
        mainPid: 0, starts: 0 })
      for (const [index, profile] of ['web', 'dormant'].entries()) {
        expect(await readFile(join(fixture.unitDirectory, `dsh-profile-${profile}.service`), 'utf8'))
          .toBe(before[index])
      }
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.originalBindingSource)
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  itLinux('retains containment when the original profile changes after a prestart rename-gap crash', async () => {
    const fixture = await controlledHostFixture(true)
    try {
      expect(fixture.run('host-update', true).status).not.toBe(0)
      const backupManifest = join(`${fixture.home}.dsh-enhanced-transaction`, 'original-home',
        'profiles', 'web', 'package.json')
      await writeFile(backupManifest, `${await readFile(backupManifest, 'utf8')}\n`)
      const recovered = fixture.run('host-recover')
      expect(recovered.status).not.toBe(0)
      expect(recovered.stderr).toContain('Host recovery original profile changed')
      const state = JSON.parse(await readFile(fixture.systemdState, 'utf8'))
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'inactive',
        starts: 0 })
      expect(await readlink(join(dirname(fixture.unitDirectory), 'user.control', 'dsh-profile-web.service')))
        .toBe('/dev/null')
      expect((await lstat(`${fixture.home}.dsh-enhanced-transaction`)).isDirectory()).toBe(true)
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  itLinux('keeps the candidate binding and resumes acceptance after the candidate has run', async () => {
    const fixture = await controlledHostFixture(true)
    try {
      const state = JSON.parse(await readFile(fixture.systemdState, 'utf8'))
      state.failAfterStartOnce = true
      await writeFile(fixture.systemdState, JSON.stringify(state))
      const first = fixture.run('host-update')
      expect(first.status).not.toBe(0)
      const afterFirst = JSON.parse(await readFile(fixture.systemdState, 'utf8'))
      expect(afterFirst.units['dsh-profile-web.service'].starts).toBeGreaterThan(0)
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.candidateBindingSource)
      const recovered = fixture.run('host-recover')
      expect(recovered.status, recovered.stderr).toBe(0)
      const finalState = JSON.parse(await readFile(fixture.systemdState, 'utf8'))
      expect(finalState.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active' })
      expect(finalState.units['dsh-profile-web.service'].invocationId).toMatch(/^fresh-web-/u)
      expect(finalState.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.candidateBindingSource)
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)
})
