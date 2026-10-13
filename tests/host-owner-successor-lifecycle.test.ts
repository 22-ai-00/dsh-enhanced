import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { lifecycleProfileTest, restoreBoundOwnerSuccessorMasks } from '../scripts/install/lifecycle-profile.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const homePath = '/private/home'
const transactionRoot = `${homePath}.dsh-enhanced-transaction`
const archiveRoot = `${transactionRoot}.owner-predecessor-11111111-1111-4111-8111-111111111111`
const profile = 'assistant'
const coordinatorProfile = `rsi-${profile}-${hash(profile).slice(0, 12)}`
const runtime = { version: '0.2.0-rc.2', root: '/private/hosts/0.2.0-rc.2',
  dshPath: '/private/hosts/0.2.0-rc.2/node_modules/.bin/dsh',
  binDirectory: '/private/hosts/0.2.0-rc.2/node_modules/.bin', receiptDigest: 'a'.repeat(64),
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }
const binding = `${JSON.stringify({ schemaVersion: 1, cacheRoot: '/private/hosts',
  version: runtime.version, receiptDigest: runtime.receiptDigest })}\n`
const plan = { schemaVersion: 1, status: 'current', canonicalHome: homePath,
  bindingPath: `${homePath}/.dsh-rsi-host.json`, originalBindingSource: binding,
  originalBindingDigest: hash(binding), originalRuntime: runtime, candidateRuntime: runtime,
  candidateBindingSource: binding }
const services = [profile, coordinatorProfile].map(name => ({
  unit: `dsh-profile-${name}.service`, profile: name, wasActive: true,
}))
const identity = { dev: '1', ino: '2', uid: process.getuid(), mode: 0o100600 }
const masks = services.map(service => ({ unit: service.unit, path: `/private/systemd/${service.unit}`,
  target: '/dev/null', transactionRoot,
  stagingPath: `${transactionRoot}/masks/${service.unit}`, identity }))
const barriers = services.map(service => ({ unit: service.unit, originalUnitFileState: 'enabled',
  enablement: { path: `/private/systemd/default.target.wants/${service.unit}`,
    target: `/private/systemd/${service.unit}`, transactionRoot,
    stagingPath: `${transactionRoot}/enablement/${service.unit}`, identity } }))

function manifest() {
  return { version: 4, operation: 'host-update', state: 'swapped', profile,
    services, serviceMasks: masks, serviceStartBarriers: barriers,
    containmentMasks: [], containmentMaskIntents: [], containmentStartBarriers: [],
    hostMigration: { phase: 'starting', candidateEverStarted: true, plan,
      localSource: { protocol: 'dsh-enhanced/host-owner-source-repair/v1', ownerRepairNext: {},
        ownerRepair: { permissionPreset: 'danger-full-access' } } } }
}

test('admits only the started, unaccepted same-Host owner repair and the same preset', () => {
  const current = manifest()
  expect(() => lifecycleProfileTest.assertHostOwnerSuccessorAdmission(current, 'danger-full-access')).not.toThrow()
  const invalid = [
    { ...current, state: 'preparing' },
    { ...current, serviceAcceptance: [] },
    { ...current, operation: 'upgrade' },
    { ...current, hostMigration: { ...current.hostMigration, phase: 'accepted' } },
    { ...current, hostMigration: { ...current.hostMigration, candidateEverStarted: false } },
    { ...current, hostMigration: { ...current.hostMigration, nativeSettingsImport: {} } },
    { ...current, hostMigration: { ...current.hostMigration,
      plan: { ...plan, status: 'update' } } },
    { ...current, hostMigration: { ...current.hostMigration,
      localSource: { ...current.hostMigration.localSource, protocol: 'dsh-enhanced/host-local-source-update/v1' } } },
    { ...current, hostMigration: { ...current.hostMigration,
      localSource: { ...current.hostMigration.localSource, ownerRepairNext: undefined } } },
    { ...current, containmentMasks: [{}] },
    { ...current, containmentMaskIntents: [{}] },
    { ...current, containmentStartBarriers: [{}] },
    { ...current, services: services.slice(0, 1) },
  ]
  for (const candidate of invalid) {
    expect(() => lifecycleProfileTest.assertHostOwnerSuccessorAdmission(candidate, 'danger-full-access')).toThrow()
  }
  expect(() => lifecycleProfileTest.assertHostOwnerSuccessorAdmission(current, 'workspace-write')).toThrow()
})

test('archive rebase changes only transaction roots and staging locations', () => {
  const current = manifest()
  const before = JSON.stringify(current)
  const relocated = lifecycleProfileTest.ownerSuccessorServiceBarriers(current, transactionRoot, archiveRoot)
  expect(relocated.masks).toEqual(masks.map(mask => ({ ...mask, transactionRoot: archiveRoot,
    stagingPath: `${archiveRoot}${mask.stagingPath.slice(transactionRoot.length)}` })))
  expect(relocated.barriers).toEqual(barriers.map(barrier => ({ ...barrier,
    enablement: { ...barrier.enablement, transactionRoot: archiveRoot,
      stagingPath: `${archiveRoot}${barrier.enablement.stagingPath.slice(transactionRoot.length)}` } })))
  expect(JSON.stringify(current)).toBe(before)
})

test('archive rebase rejects a foreign or root-level staging location', () => {
  const current = manifest()
  for (const changed of [
    { ...masks[0], transactionRoot: '/private/foreign' },
    { ...masks[0], stagingPath: '/private/foreign/mask' },
    { ...masks[0], stagingPath: `${transactionRoot}-other/mask` },
    { ...masks[0], stagingPath: transactionRoot },
  ]) {
    expect(() => lifecycleProfileTest.ownerSuccessorServiceBarriers({ ...current,
      serviceMasks: [changed, masks[1]] }, transactionRoot, archiveRoot)).toThrow('containment path changed')
  }
  for (const changed of [
    { ...barriers[0].enablement, transactionRoot: '/private/foreign' },
    { ...barriers[0].enablement, stagingPath: '/private/foreign/link' },
    { ...barriers[0].enablement, stagingPath: transactionRoot },
  ]) {
    expect(() => lifecycleProfileTest.ownerSuccessorServiceBarriers({ ...current,
      serviceStartBarriers: [{ ...barriers[0], enablement: changed }, barriers[1]] },
    transactionRoot, archiveRoot)).toThrow('containment path changed')
  }
})

const testLinux = process.platform === 'linux' ? test : test.skip

testLinux('canonicalizes only the inode-bound predecessor backup before profile validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-successor-backup-'))
  const archiveRoot = join(root, 'archived-transaction')
  const backup = join(archiveRoot, 'original-home')
  await mkdir(backup, { recursive: true, mode: 0o700 })
  const original = await lstat(backup)
  const expected = { dev: String(original.dev), ino: String(original.ino), uid: original.uid, mode: original.mode }
  const descriptor = await open(root, 'r')
  try {
    const anchoredArchive = `/proc/self/fd/${descriptor.fd}/archived-transaction`
    expect(anchoredArchive).not.toBe(await realpath(anchoredArchive))
    expect(await lifecycleProfileTest.canonicalOwnerSuccessorBackup(anchoredArchive, expected))
      .toBe(await realpath(backup))
    const heldOriginalHome = join(root, 'held-original-home')
    await rename(backup, heldOriginalHome)
    await mkdir(backup, { mode: 0o700 })
    await expect(lifecycleProfileTest.canonicalOwnerSuccessorBackup(anchoredArchive, expected))
      .rejects.toThrow('Home identities changed')
    await rm(backup, { recursive: true })
    await symlink(heldOriginalHome, backup)
    await expect(lifecycleProfileTest.canonicalOwnerSuccessorBackup(anchoredArchive, expected))
      .rejects.toThrow('Home identities changed')
  } finally {
    await descriptor.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function maskedInspectionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-owner-successor-mask-'))
  const home = join(root, 'home')
  const controlParent = join(root, 'systemd')
  const controlRoot = join(controlParent, 'user.control')
  const stagingRoot = join(root, 'transaction', 'masks')
  await mkdir(home, { mode: 0o700 })
  await mkdir(controlRoot, { recursive: true, mode: 0o700 })
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  const units = ['dsh-profile-assistant.service', 'dsh-profile-rsi-assistant.service']
  const boundMasks = []
  for (const unit of units) {
    const path = join(controlRoot, unit)
    await symlink('/dev/null', path)
    const entry = await lstat(path)
    boundMasks.push({ unit, path, stagingPath: join(stagingRoot, unit), transactionRoot: join(root, 'transaction'),
      target: '/dev/null',
      identity: { dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode } })
  }
  const statePath = join(root, 'state.json')
  const logPath = join(root, 'systemctl.log')
  const executable = join(root, 'systemctl')
  await writeFile(statePath, JSON.stringify({ active: false, runtimeMasked: false }), { mode: 0o600 })
  await writeFile(logPath, '', { mode: 0o600 })
  const source = `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs')
const args = process.argv.slice(2)
const statePath = __STATE__
const logPath = __LOG__
const masks = __MASKS__
const units = Object.keys(masks)
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
fs.appendFileSync(logPath, JSON.stringify(args) + '\n')
if (args[0] !== '--user') process.exit(90)
const command = args[1]
if (command === 'show') {
  const unit = args[2]
  if (!units.includes(unit)) process.exit(91)
  const masked = fs.existsSync(masks[unit])
  const reportedMasked = masked && state.loadedForPid !== process.ppid
  const values = { Id: unit, LoadState: reportedMasked ? 'masked' : 'loaded',
    UnitFileState: reportedMasked ? 'masked' : 'static',
    ActiveState: state.active ? 'active' : 'inactive', SubState: state.active ? 'running' : 'dead',
    MainPID: state.active ? '12345' : '0', ControlPID: '0', InvocationID: '', NRestarts: '0',
    Environment: 'DSH_HOME=__HOME__', WorkingDirectory: '__HOME__',
    FragmentPath: '__FRAGMENT__', DropInPaths: '',
    ExecStart: reportedMasked ? '' : '{ path=/usr/bin/node ; argv[]=/usr/bin/node dsh ; ignore_errors=no ; }',
    User: '', Group: '', Type: 'simple', KillMode: 'control-group' }
  for (const argument of args) {
    if (argument.startsWith('--property=')) {
      const property = argument.slice('--property='.length)
      if (!(property in values)) process.exit(92)
      process.stdout.write(property + '=' + values[property] + '\n')
    }
  }
} else if (command === 'list-unit-files') {
  for (const unit of units) process.stdout.write(unit + ' masked\n')
} else if (command === 'list-units') {
  for (const unit of units) process.stdout.write(unit + ' loaded inactive dead\n')
} else if (command === 'mask' && args[2] === '--runtime') {
  state.runtimeMasked = true
  fs.writeFileSync(statePath, JSON.stringify(state))
} else if (command === 'stop') {
  state.active = false
  fs.writeFileSync(statePath, JSON.stringify(state))
} else if (['daemon-reload', 'reset-failed', 'disable'].includes(command)) {
} else process.exit(93)
`
  await writeFile(executable, source.replace('__STATE__', JSON.stringify(statePath))
    .replace('__LOG__', JSON.stringify(logPath))
    .replace('__MASKS__', JSON.stringify(Object.fromEntries(boundMasks.map(mask => [mask.unit, mask.path]))))
    .replaceAll('__HOME__', home).replace('__FRAGMENT__', join(root, 'original-unit')),
  { mode: 0o700 })
  return { root, home, executable, units, boundMasks, statePath, logPath }
}

testLinux('inspects stopped owner successor units only while bound masks are staged', async () => {
  const fixture = await maskedInspectionFixture()
  try {
    await expect(lifecycleProfileTest.hostUnitProperties(fixture.executable, fixture.units[0]))
      .rejects.toThrow('ExecStart representation invalid')
    await lifecycleProfileTest.inspectStoppedOwnerSuccessor({ systemctlExecutable: fixture.executable,
      masks: fixture.boundMasks, units: fixture.units, homePath: fixture.home,
      inspect: async () => {
        for (const unit of fixture.units) {
          expect((await lifecycleProfileTest.hostUnitProperties(fixture.executable, unit)).ExecStart)
            .toBe('{ path=/usr/bin/node ; argv[]=/usr/bin/node dsh ; ignore_errors=no ; }')
          expect((await lstat(fixture.boundMasks.find(mask => mask.unit === unit)!.stagingPath)).isSymbolicLink())
            .toBe(true)
        }
      } })
    for (const mask of fixture.boundMasks) {
      expect(await readlink(mask.path)).toBe('/dev/null')
      await expect(lstat(mask.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands.some(command => command[1] === 'start')).toBe(false)
    expect(commands.filter(command => command[1] === 'daemon-reload')).toHaveLength(2)
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

testLinux('reinstalls masks without a runtime-mask residue when owner inspection throws', async () => {
  const fixture = await maskedInspectionFixture()
  try {
    await expect(lifecycleProfileTest.inspectStoppedOwnerSuccessor({ systemctlExecutable: fixture.executable,
      masks: fixture.boundMasks, units: fixture.units, homePath: fixture.home,
      inspect: async () => {
        await lifecycleProfileTest.hostUnitProperties(fixture.executable, fixture.units[0])
        throw new Error('owner binding changed')
      } })).rejects.toThrow('owner binding changed')
    for (const mask of fixture.boundMasks) expect(await readlink(mask.path)).toBe('/dev/null')
    const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands.some(command => command[1] === 'mask' && command[2] === '--runtime')).toBe(false)
    expect(commands.some(command => command[1] === 'start')).toBe(false)
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

testLinux('refuses a newly active predecessor and reinstalls bound masks', async () => {
  const fixture = await maskedInspectionFixture()
  try {
    await expect(lifecycleProfileTest.inspectStoppedOwnerSuccessor({ systemctlExecutable: fixture.executable,
      masks: fixture.boundMasks, units: fixture.units, homePath: fixture.home,
      inspect: async () => {
        await lifecycleProfileTest.hostUnitProperties(fixture.executable, fixture.units[0])
        await writeFile(fixture.statePath, JSON.stringify({ active: true, runtimeMasked: false }))
      } })).rejects.toThrow('predecessor service is not stopped')
    for (const mask of fixture.boundMasks) expect(await readlink(mask.path)).toBe('/dev/null')
    const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands.some(command => command[1] === 'start')).toBe(false)
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

testLinux('refuses completion when reinstalled masks still report a loaded unit', async () => {
  const fixture = await maskedInspectionFixture()
  try {
    await expect(lifecycleProfileTest.inspectStoppedOwnerSuccessor({ systemctlExecutable: fixture.executable,
      masks: fixture.boundMasks, units: fixture.units, homePath: fixture.home,
      inspect: async () => {
        await lifecycleProfileTest.hostUnitProperties(fixture.executable, fixture.units[0])
        await writeFile(fixture.statePath, JSON.stringify({ active: false, loadedForPid: process.pid }))
      } })).rejects.toThrow('guardian did not restore bound mask')
    for (const mask of fixture.boundMasks) {
      expect(await readlink(mask.path)).toBe('/dev/null')
      await expect(lstat(mask.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands.some(command => command[1] === 'list-unit-files')).toBe(true)
    expect(commands.some(command => command[1] === 'start')).toBe(false)
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

testLinux('guardian restore refuses missing and replacement bound mask identities', async () => {
  const fixture = await maskedInspectionFixture()
  try {
    const mask = fixture.boundMasks[0]
    const held = join(fixture.root, 'held-bound-mask')
    await rename(mask.path, held)
    await expect(restoreBoundOwnerSuccessorMasks(fixture.executable, fixture.boundMasks, fixture.units))
      .rejects.toThrow('已丢失')
    await symlink('/dev/null', mask.stagingPath)
    await expect(restoreBoundOwnerSuccessorMasks(fixture.executable, fixture.boundMasks, fixture.units))
      .rejects.toThrow('身份不匹配')
    expect(await readlink(held)).toBe('/dev/null')
    await expect(lstat(mask.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as string[])
    expect(commands.some(command => ['start', 'daemon-reload'].includes(command[1]))).toBe(false)
  } finally { await rm(fixture.root, { recursive: true, force: true }) }
})

async function verifyCrashGuardRestoresMasks(partlyInstalled: boolean) {
  const fixture = await maskedInspectionFixture()
  const readyPath = join(fixture.root, 'inspection-ready')
  const source = `import { writeFile } from 'node:fs/promises';
    import { lifecycleProfileTest } from ${JSON.stringify(new URL('../scripts/install/lifecycle-profile.mjs', import.meta.url).href)};
    const input = ${JSON.stringify({ systemctlExecutable: fixture.executable,
    masks: fixture.boundMasks, units: fixture.units, homePath: fixture.home })};
    await lifecycleProfileTest.inspectStoppedOwnerSuccessor({ ...input, inspect: async () => {
      await writeFile(${JSON.stringify(readyPath)}, 'ready');
      await new Promise(() => { setInterval(() => {}, 1000); });
    } });`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source],
    { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore'] })
  const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      ready = await lstat(readyPath).then(() => true, () => false)
      if (ready) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
    }
    expect(ready).toBe(true)
    if (partlyInstalled) await rename(fixture.boundMasks[0].stagingPath, fixture.boundMasks[0].path)
    const beforeCrashCommands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').filter(Boolean).length
    child.kill('SIGKILL')
    await closed
    let restored = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      restored = await Promise.all(fixture.boundMasks.map(mask => lstat(mask.path).then(() => true, () => false)))
        .then(values => values.every(Boolean))
      if (restored) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
    }
    expect(restored).toBe(true)
    for (const mask of fixture.boundMasks) {
      const entry = await lstat(mask.path)
      expect({ dev: String(entry.dev), ino: String(entry.ino), uid: entry.uid, mode: entry.mode }).toEqual(mask.identity)
      expect(await readlink(mask.path)).toBe('/dev/null')
      await expect(lstat(mask.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await lifecycleProfileTest.readRawServiceState(fixture.executable, mask.unit)).loadState).toBe('masked')
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const completed = (await readFile(fixture.logPath, 'utf8')).split('\n')
        .filter(line => line.includes('"list-unit-files"')).length >= 2
      if (completed) break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    const commands = (await readFile(fixture.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const crashCommands = commands.slice(beforeCrashCommands)
    expect(crashCommands[0]?.[1]).toBe('stop')
    expect(crashCommands.findIndex(command => command[1] === 'daemon-reload'))
      .toBeLessThan(crashCommands.findIndex(command => command[1] === 'list-unit-files'))
    expect(commands.some(command => command[1] === 'mask' && command[2] === '--runtime')).toBe(false)
    expect(commands.some(command => command[1] === 'start')).toBe(false)
  } finally {
    child.kill('SIGKILL')
    await rm(fixture.root, { recursive: true, force: true })
  }
}

testLinux('crash guardian restores fully staged bound masks before containment',
  async () => await verifyCrashGuardRestoresMasks(false))

testLinux('crash guardian restores partly staged bound masks before containment',
  async () => await verifyCrashGuardRestoresMasks(true))
