import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { installRsiLocalProfile, installRsiLocalTarget, mergeRsiLocalOverrides, preflightRsiLocalProfile, readRsiLocalLaunchAgentPlist, rsiLocalDependencyOverrides, type RsiLocalProfilePorts } from '../src/rsi-local-install.js'
import { parseRsiSetupArgs } from '../src/rsi-setup.js'
import { prepareRsiLocalCohort, verifyRsiLocalInstalledPackages, rsiLocalPeerOverrides, type RsiLocalCohort } from '../src/rsi-local-cohort.js'
import { installFixture, localCohortFixture } from './fixtures/rsi-local-cohort.js'

describe('frozen local profile dependency installation', () => {
  test('initializes with native DSH, adds only selected tarballs and verifies the installed bytes before success', async () => {
    const f = await localCohortFixture()
    try {
      const cohort = await prepareRsiLocalCohort({dshHome:f.home,profile:f.profile,source:f.source,bundles:['target']},f.ports)
      const path = join(f.root,'dsh.js'), executable = '#!/usr/bin/env node\n'
      await writeFile(path,executable,{mode:0o700})
      const profilePath = join(f.home,'profiles',f.profile), workspace = join(profilePath,'pnpm-workspace.yaml')
      let corrupt = false, repairable = false
      const command = vi.fn<RsiLocalProfilePorts['command']>(async (_exe,args,environment) => {
        expect(environment.DSH_HOME).toBe(f.home)
        expect(environment.pnpm_config_package_import_method).toBe('copy')
        expect(environment.CI).toBe('true')
        if (args[3] === 'list') {
          await mkdir(profilePath,{recursive:true,mode:0o700})
          await writeFile(workspace,'# owner configuration\npackages: [.]\nautoInstallPeers: false\nnodeLinker: hoisted\n',{flag:'wx',mode:0o600})
        } else {
          expect(args).toEqual(['plugin','--profile',f.profile,'add',cohort.packages.find(pkg => pkg.name === '@dsh-enhanced/target')!.tarball])
          if (environment.pnpm_config_force === 'true') await rm(join(profilePath,'node_modules'),{recursive:true,force:true})
          await installFixture(f,cohort,['target','shared-lib','optional-plugin'],`home/profiles/${f.profile}`)
          if (corrupt && !(repairable && environment.pnpm_config_force === 'true')) await writeFile(join(profilePath,'node_modules','@dsh-enhanced','target','lib','index.js'),'changed after package install\n')
        }
        return ''
      })
      const input = {dshHome:f.home,profile:f.profile,cohort,bundles:['target'],
        dsh:{path,pin:{path,sha256:createHash('sha256').update(executable).digest('hex')}},signal:new AbortController().signal}
      await installRsiLocalProfile(input,{command,verify:verifyRsiLocalInstalledPackages})
      expect(command.mock.calls.map(call => call[1][3])).toEqual(['list','add'])
      expect(await readFile(workspace,'utf8')).toContain('# owner configuration')
      await preflightRsiLocalProfile(input)
      const conflict = 'packages: [.]\nallowBuilds:\n  koffi: false\n'
      await writeFile(workspace,conflict)
      await expect(preflightRsiLocalProfile(input)).rejects.toThrow('build policy conflicts')
      expect(await readFile(workspace,'utf8')).toBe(conflict)
      await rm(profilePath,{recursive:true,force:true})
      corrupt = true
      await expect(installRsiLocalProfile(input,{command,verify:verifyRsiLocalInstalledPackages})).rejects.toThrow('installed package file differs')
      expect(await readFile(workspace,'utf8')).toContain('overrides:')
      expect(command.mock.calls.filter(call => call[2].pnpm_config_force === 'true')).toHaveLength(1)
      await rm(profilePath,{recursive:true,force:true})
      repairable = true
      await installRsiLocalProfile(input,{command,verify:verifyRsiLocalInstalledPackages})
      expect(command.mock.calls.filter(call => call[2].pnpm_config_force === 'true')).toHaveLength(2)
    } finally { await rm(f.root,{recursive:true,force:true}) }
  })
  test('scopes overrides to runtime edges and preserves unrelated settings and comments', () => {
    const cohort = {version:'0.1.48',packages:[
      {name:'@dsh-enhanced/personal-assistant',runtimeDependencies:['@dsh-enhanced/assistant-policy'],tarball:'/private/personal.tgz'},
      {name:'@dsh-enhanced/assistant-policy',runtimeDependencies:[],tarball:'/private/with spaces/policy.tgz'},
    ]} as unknown as RsiLocalCohort
    const overrides = rsiLocalDependencyOverrides(cohort)
    expect(overrides).toEqual({'@dsh-enhanced/personal-assistant@0.1.48>@dsh-enhanced/assistant-policy':'file:/private/with spaces/policy.tgz'})
    const original = '# owner settings\npackages: [.]\nautoInstallPeers: false\nnodeLinker: hoisted\noverrides:\n  another-package: 1.2.3\n'
    const merged = mergeRsiLocalOverrides(original,overrides)
    expect(merged).toContain('# owner settings')
    expect(parseDocument(merged).toJS()).toMatchObject({packages:['.'],autoInstallPeers:false,nodeLinker:'isolated',
      overrides:{'another-package':'1.2.3',...overrides}})
    expect(mergeRsiLocalOverrides(merged,overrides)).toBe(merged)
    expect(() => mergeRsiLocalOverrides(merged,{...overrides,[Object.keys(overrides)[0]!]: 'file:/different.tgz'})).toThrow('conflicts')
    expect(() => mergeRsiLocalOverrides('overrides: false\n',overrides)).toThrow('mapping')
    expect(() => mergeRsiLocalOverrides('overrides: {}\noverrides: {}\n',overrides)).toThrow('invalid')
    expect(() => mergeRsiLocalOverrides('nodeLinker: pnp\n',overrides)).toThrow('unsupported profile nodeLinker')
    const policy = {koffi:true,protobufjs:false}
    const withBuilds = mergeRsiLocalOverrides(original,overrides,policy)
    expect(parseDocument(withBuilds).toJS().allowBuilds).toEqual(policy)
    expect(mergeRsiLocalOverrides(withBuilds,overrides,policy)).toBe(withBuilds)
    expect(() => mergeRsiLocalOverrides(withBuilds,overrides,{koffi:false})).toThrow('build policy conflicts')
    expect(() => mergeRsiLocalOverrides('allowBuilds: true\n',overrides,policy)).toThrow('mapping')
  })

  test('accepts a unique explicit bundle list only in the local installation mode', () => {
    const args = ['--install-local-cohort','--profile','web','--source-repository','/private/repository',
      '--dsh-home','/private/home','--bundle','personal-assistant','--bundle','lark-channel']
    expect(parseRsiSetupArgs(args)).toMatchObject({installLocalCohort:true,bundles:['personal-assistant','lark-channel']})
    expect(() => parseRsiSetupArgs([...args,'--bundle','lark-channel'])).toThrow('unique bundles')
    expect(() => parseRsiSetupArgs([...args,'--install-owner'])).toThrow('cannot be combined')
    expect(() => parseRsiSetupArgs(['--install-owner','--profile','web','--bundle','lark-channel'])).toThrow('--bundle requires')
    expect(() => parseRsiSetupArgs(args.slice(0,-4))).toThrow('requires a profile')
  })
})

describe('native local cohort target lifecycle', () => {
  test('reads only a physical owner plist in a physical owner LaunchAgents directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-local-plist-'))
    const directory = join(root, 'LaunchAgents'), path = join(directory, 'owner.plist')
    try {
      expect(await readRsiLocalLaunchAgentPlist(path)).toBeNull()
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      await mkdir(directory, { mode: 0o700 })
      expect(await readRsiLocalLaunchAgentPlist(path)).toBeNull()
      await writeFile(path, 'trusted', { mode: 0o644 })
      expect((await readRsiLocalLaunchAgentPlist(path))?.toString()).toBe('trusted')
      await chmod(path, 0o664)
      await expect(readRsiLocalLaunchAgentPlist(path)).rejects.toThrow('not owner-safe')
      await chmod(path, 0o644)
      const linked = join(directory, 'linked.plist')
      await link(path, linked)
      await expect(readRsiLocalLaunchAgentPlist(path)).rejects.toThrow('not owner-safe')
      await rm(linked)
      await rm(path)
      await symlink(join(directory, 'missing.plist'), path)
      await expect(readRsiLocalLaunchAgentPlist(path)).rejects.toThrow('not owner-safe')
      await rm(path)
      await writeFile(path, 'trusted', { mode: 0o644 })
      await chmod(directory, 0o777)
      await expect(readRsiLocalLaunchAgentPlist(path)).rejects.toThrow('directory is not owner-safe')
      await chmod(directory, 0o700)
      const linkedDirectory = join(root, 'LinkedAgents')
      await symlink(directory, linkedDirectory)
      await expect(readRsiLocalLaunchAgentPlist(join(linkedDirectory, 'owner.plist'))).rejects.toThrow('directory is not owner-safe')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-local-target-'))
    const dshHome = join(root, 'home'), dshPath = join(root, 'dsh')
    await mkdir(dshHome, { mode: 0o700 })
    const executable = Buffer.from('#!/bin/sh\n')
    await writeFile(dshPath, executable, { mode: 0o700 })
    const sha256 = createHash('sha256').update(executable).digest('hex')
    const cohort = { sourceCommit: 'a'.repeat(40), packages: [{}] } as unknown as RsiLocalCohort
    const events: string[] = []
    let plist: Buffer | null = Buffer.from('trusted plist')
    let registered = true
    const ports = {
      platform: 'darwin' as const,
      prepareSource: vi.fn(async () => { events.push('source'); return {} as never }),
      prepareCohort: vi.fn(async () => { events.push('cohort'); return cohort }),
      preflight: vi.fn(async () => { events.push('preflight') }),
      resolveDsh: vi.fn(async () => ({ path: dshPath, pin: { path: dshPath, sha256 } }) as never),
      installProfile: vi.fn(async () => { events.push('install') }),
      pinSystemctl: vi.fn(async (): Promise<never> => { throw new Error('systemctl must not run on macOS') }),
      stopLinux: vi.fn(async () => { throw new Error('Linux service stop must not run on macOS') }),
      startLinux: vi.fn(async () => { throw new Error('Linux service start must not run on macOS') }),
      inspectNative: vi.fn(() => ({ registered, pid: registered ? 123 : 0 })),
      validatePlist: vi.fn(() => { events.push('validate') }),
      stopNative: vi.fn(async () => { events.push('stop') }),
      startNative: vi.fn(async () => { events.push('start') }),
      readPlist: vi.fn(async () => plist),
    } satisfies NonNullable<Parameters<typeof installRsiLocalTarget>[1]>
    const input = { dshHome, profile: 'web', sourceRepository: join(root, 'source'), bundles: ['target'] }
    return { root, input, ports, events, setPlist: (value: Buffer | null) => { plist = value },
      setRegistered: (value: boolean) => { registered = value } }
  }

  test('validates its loaded LaunchAgent, stops it and restores it only after frozen installation', async () => {
    const f = await fixture()
    try {
      await expect(installRsiLocalTarget(f.input, f.ports)).resolves.toMatchObject({ mode: 'local-cohort-installed', profile: 'web' })
      expect(f.events).toEqual(['source', 'cohort', 'preflight', 'validate', 'stop', 'install', 'validate', 'start'])
      expect(f.ports.readPlist).toHaveBeenCalledTimes(2)
      expect(f.ports.pinSystemctl).not.toHaveBeenCalled()
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test('keeps an unregistered profile stopped and refuses missing or changed loaded plist', async () => {
    const f = await fixture()
    try {
      f.setRegistered(false); f.setPlist(null)
      await installRsiLocalTarget(f.input, f.ports)
      expect(f.events).toEqual(['source', 'cohort', 'preflight', 'install'])
      expect(f.ports.stopNative).not.toHaveBeenCalled()
      expect(f.ports.startNative).not.toHaveBeenCalled()

      f.events.length = 0; f.setRegistered(true)
      await expect(installRsiLocalTarget(f.input, f.ports)).rejects.toThrow('no trusted plist')
      expect(f.ports.installProfile).toHaveBeenCalledTimes(1)
      expect(f.ports.stopNative).not.toHaveBeenCalled()

      f.setPlist(Buffer.from('trusted plist'))
      f.ports.installProfile.mockImplementationOnce(async () => { f.setPlist(Buffer.from('changed plist')) })
      await expect(installRsiLocalTarget(f.input, f.ports)).rejects.toThrow('identity changed')
      expect(f.ports.startNative).not.toHaveBeenCalled()
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test('compensates a startup error after bootstrap by stopping the same loaded job', async () => {
    const f = await fixture()
    try {
      f.ports.startNative.mockImplementationOnce(async () => { f.events.push('bootstrap committed'); throw new Error('post-bootstrap inspect failed') })
      await expect(installRsiLocalTarget(f.input, f.ports)).rejects.toThrow('post-bootstrap inspect failed')
      expect(f.events).toEqual(['source', 'cohort', 'preflight', 'validate', 'stop', 'install', 'validate',
        'bootstrap committed', 'stop'])
      expect(f.ports.stopNative).toHaveBeenCalledTimes(2)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test('reports an unknown service outcome if the startup compensation cannot prove identity', async () => {
    const f = await fixture()
    try {
      f.ports.startNative.mockRejectedValueOnce(new Error('post-bootstrap inspect failed'))
      f.ports.stopNative.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('loaded job identity differs'))
      const failure = await installRsiLocalTarget(f.input, f.ports).catch(error => error as AggregateError)
      if (!(failure instanceof AggregateError)) throw new Error('expected unknown service outcome')
      expect(failure.message).toContain('stop outcome is unknown')
      expect(failure.errors.map((error: Error) => error.message)).toEqual([
        'post-bootstrap inspect failed', 'loaded job identity differs'])
      expect(f.ports.stopNative).toHaveBeenCalledTimes(2)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test('preserves Linux service wiring and rejects other platforms before preparing files', async () => {
    const f = await fixture()
    try {
      const linux = { ...f.ports, platform: 'linux' as const,
        pinSystemctl: vi.fn(async () => ({ path: '/usr/bin/systemctl', sha256: 'a'.repeat(64), interpreter: null })),
        stopLinux: vi.fn(async () => true), startLinux: vi.fn(async () => {}) }
      await installRsiLocalTarget(f.input, linux)
      expect(linux.pinSystemctl).toHaveBeenCalledTimes(1)
      expect(linux.stopLinux).toHaveBeenCalledTimes(1)
      expect(linux.startLinux).toHaveBeenCalledWith('web', f.input.dshHome)
      expect(linux.inspectNative).not.toHaveBeenCalled()
      await expect(installRsiLocalTarget(f.input, { ...f.ports, platform: 'win32' })).rejects.toThrow('requires Linux or macOS')
      expect(f.ports.prepareSource).toHaveBeenCalledTimes(1)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
})


test('native pnpm peer overrides preserve one module identity and do not install absent optional providers', async () => {
  const f = await localCohortFixture(true)
  try {
    const cohort = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source, bundles: ['target'] }, f.ports)
    const profilePath = join(f.root, 'native-pnpm'); await mkdir(profilePath)
    const target = cohort.packages.find(item => item.name === '@dsh-enhanced/target')!
    await writeFile(join(profilePath, 'package.json'), JSON.stringify({ private: true,
      dependencies: { [target.name]: `file:${target.tarball}` } }))
    const peers = await rsiLocalPeerOverrides({ cohort, bundles: ['target'] })
    await writeFile(join(profilePath, 'pnpm-workspace.yaml'), mergeRsiLocalOverrides('packages: [.]\nautoInstallPeers: false\n',
      { ...rsiLocalDependencyOverrides(cohort, ['target']), ...peers }))
    // All runtime packages are frozen local tarballs. Offline resolution also
    // prevents pnpm's optional peer metadata probe from needing a registry.
    const output = execFileSync('pnpm', ['--dir', profilePath, 'install', '--offline', '--ignore-scripts'], { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CI: 'true', pnpm_config_package_import_method: 'copy' } })
    expect(output).toContain('Packages: +3')
    await verifyRsiLocalInstalledPackages({ cohort, profilePath })
    const targetPath = createRequire(join(profilePath, 'package.json')).resolve(`${target.name}/package.json`)
    const targetRequire = createRequire(targetPath)
    const provider = targetRequire.resolve('@dsh-enhanced/shared-lib/package.json')
    const consumer = targetRequire.resolve('@dsh-enhanced/optional-plugin/package.json')
    const peer = createRequire(consumer).resolve('@dsh-enhanced/shared-lib/package.json')
    expect(await realpath(peer)).toBe(await realpath(provider))
    for (const absent of ['assistant-policy', 'peer-only', 'assistant-automations', 'plugin-control-plane']) {
      let resolved: string | undefined
      try { resolved = targetRequire.resolve(`@dsh-enhanced/${absent}/package.json`) } catch { /* absent everywhere */ }
      // NODE_PATH may expose this repository's unrelated packages to Node.
      // They must not have been installed into the disposable profile.
      expect(resolved?.startsWith(`${profilePath}/`) ?? false).toBe(false)
    }
    const before = await readFile(join(cohort.root, 'receipt.json'), 'utf8')
    // Same-cohort retry derives the identical plan; unknown selectors fail
    // preflight before invoking the package manager or touching owner bytes.
    const workspace = join(profilePath, 'pnpm-workspace.yaml')
    const known = await readFile(workspace, 'utf8')
    await mkdir(join(f.home, 'profiles'), { recursive: true })
    const retryProfile = join(f.home, 'profiles', 'retry'); await mkdir(retryProfile)
    await writeFile(join(retryProfile, 'pnpm-workspace.yaml'), known)
    await preflightRsiLocalProfile({ dshHome: f.home, profile: 'retry', cohort, bundles: ['target'] })
    const drift = known + "  '@dsh-enhanced/target@0.1.48>@dsh-enhanced/assistant-policy': file:/unknown.tgz\n"
    await writeFile(join(retryProfile, 'pnpm-workspace.yaml'), drift)
    await expect(preflightRsiLocalProfile({ dshHome: f.home, profile: 'retry', cohort, bundles: ['target'] })).rejects.toThrow('frozen internal override')
    expect(await readFile(join(cohort.root, 'receipt.json'), 'utf8')).toBe(before)
  } finally { await rm(f.root, { recursive: true, force: true }) }
}, 40_000)
