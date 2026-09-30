import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
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
    await mkdir(binDirectory, { recursive: true, mode: 0o700 })
    await chmod(runtimeRoot, 0o700)
    await cp(yamlRoot, join(runtimeRoot, 'node_modules', 'yaml'), { recursive: true, dereference: true })
    await writeFile(join(native, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version,
      bin: { dsh: 'lib/bin.js' } }) + '\n')
    await writeFile(join(native, 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version }) + '\n')
    await writeFile(join(runtimeRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      'node_modules/@deepseek-ai/dsh': { version, integrity: old.integrity },
      'node_modules/@deepseek-ai/dsh-base': { version, integrity: old.integrity },
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

describe('managed Host transaction inputs', () => {
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

  it('returns current without creating a transaction or touching Home', async () => {
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

  it('switches an unregistered Home to the candidate Host through the full v4 transaction', async () => {
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

  it('migrates an active unit and preserves an inactive same-Home sibling', async () => {
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

  it('rejects an external Home symlink created by candidate dump-config before swap', async () => {
    const fixture = await controlledHostFixture(false, 'external')
    try {
      const result = fixture.run('host-update')
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/DSH_HOME 包含指向外部的符号链接|unapproved external package link/u)
      expect(await readFile(join(fixture.home, '.dsh-rsi-host.json'), 'utf8'))
        .toBe(fixture.originalBindingSource)
    } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }, 90_000)

  it('allows a staged node_modules link into the receipt-verified candidate Host', async () => {
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

  it('recovers the original Home after a v4 rename-gap crash with simulated empty unmanaged-process inventory', async () => {
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

  it('restores original unit bytes and active set after a prestart rename-gap crash', async () => {
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

  it('keeps the candidate binding and resumes acceptance after the candidate has run', async () => {
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
