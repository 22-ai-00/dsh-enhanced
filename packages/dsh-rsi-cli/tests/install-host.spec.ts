import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { prepareInstallHostEnvironment, type InstallHostPorts } from '../src/install-host.ts'
import { runInstall } from '../src/install.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'dsh-install-host-'))
  roots.push(root)
  const dshHome = join(root,'home with spaces')
  const cacheRoot = join(root,'cache')
  const runtime = {version:'0.1.5-rc.3',root:cacheRoot,dshPath:join(cacheRoot,'dsh.js'),binDirectory:join(cacheRoot,'bin'),integrity:'fixture',receiptDigest:'a'.repeat(64)}
  const prepare = vi.fn(async () => runtime)
  const read = vi.fn(async () => runtime)
  const ports: InstallHostPorts = {prepare,read}
  const input = {dshHome,cacheRoot,environment:{PATH:'/original/bin',TOKEN:'preserved'}}
  return {root,input,runtime,prepare,read,ports}
}

describe('Home-bound private Host selection', () => {
  test('fresh Home resolves latest once; retry reads the frozen runtime and preserves environment', async () => {
    const f = await fixture()
    const env = await prepareInstallHostEnvironment(f.input,f.ports)
    expect(f.prepare).toHaveBeenCalledWith({root:f.input.cacheRoot,selector:'latest'})
    expect(env).toEqual({DSH_HOME:f.input.dshHome,DSH_ENHANCED_HOST_BIN:f.runtime.binDirectory,PATH:`${f.runtime.binDirectory}${delimiter}/original/bin`,TOKEN:'preserved'})
    const bindingPath = join(f.input.dshHome,'.dsh-rsi-host.json')
    expect((await stat(bindingPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(bindingPath,'utf8')).not.toContain('preserved')
    f.prepare.mockRejectedValue(new Error('registry unavailable'))
    expect(await prepareInstallHostEnvironment(f.input,f.ports)).toEqual(env)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.read).toHaveBeenLastCalledWith({root:f.input.cacheRoot,version:f.runtime.version})
    expect(await readdir(f.input.dshHome)).toEqual(['.dsh-rsi-host.json'])
  })
  test('an existing unbound Home retains its current Host without preparing a new runtime', async () => {
    const f = await fixture()
    await mkdir(join(f.input.dshHome,'profiles'),{recursive:true})
    expect(await prepareInstallHostEnvironment(f.input,f.ports)).toEqual(f.input.environment)
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    expect(await readdir(f.input.dshHome)).toEqual(['profiles'])
    expect(await prepareInstallHostEnvironment({...f.input,environment:{...f.input.environment,DSH_ENHANCED_HOST_BIN:'/stale/home/bin'}},f.ports)).toEqual(f.input.environment)
  })
  test('fresh and bound Homes reject directories writable by other users', async () => {
    const f = await fixture()
    await mkdir(f.input.dshHome)
    await chmod(f.input.dshHome,0o777)
    await expect(prepareInstallHostEnvironment(f.input,f.ports)).rejects.toThrow('不可由其他用户写入')
    expect(f.prepare).not.toHaveBeenCalled()
    await chmod(f.input.dshHome,0o700)
    await prepareInstallHostEnvironment(f.input,f.ports)
    f.read.mockClear()
    await chmod(f.input.dshHome,0o777)
    await expect(prepareInstallHostEnvironment(f.input,f.ports)).rejects.toThrow('不可由其他用户写入')
    expect(f.read).not.toHaveBeenCalled()
  })
  test('a frozen Home rejects a different requested version and changed runtime receipt', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input,f.ports)
    await expect(prepareInstallHostEnvironment({...f.input,selector:'0.1.5-rc.4'},f.ports)).rejects.toThrow('更新事务')
    f.read.mockResolvedValue({...f.runtime,receiptDigest:'b'.repeat(64)})
    await expect(prepareInstallHostEnvironment(f.input,f.ports)).rejects.toThrow('制品发生变化')
    expect(f.prepare).toHaveBeenCalledTimes(1)
  })
  test('a linked binding is never followed', async () => {
    const f = await fixture()
    await mkdir(f.input.dshHome)
    const target = join(f.root,'foreign.json')
    await writeFile(target,'{}',{mode:0o600})
    await symlink(target,join(f.input.dshHome,'.dsh-rsi-host.json'))
    await expect(prepareInstallHostEnvironment(f.input,f.ports)).rejects.toThrow()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(await readFile(target,'utf8')).toBe('{}')
  })
  test('concurrent Home creation during preparation cannot publish a binding', async () => {
    const f = await fixture()
    f.prepare.mockImplementation(async () => {
      await mkdir(join(f.input.dshHome,'profiles'))
      return f.runtime
    })
    await expect(prepareInstallHostEnvironment(f.input,f.ports)).rejects.toThrow('其它安装修改')
    expect(await readdir(f.input.dshHome)).toEqual(['profiles'])
  })
  test('preparation failure leaves no binding and permits a later retry', async () => {
    const f = await fixture()
    f.prepare.mockRejectedValueOnce(new Error('download interrupted'))
    await expect(prepareInstallHostEnvironment(f.input,f.ports)).rejects.toThrow('download interrupted')
    expect(await readdir(f.input.dshHome)).toEqual([])
    await prepareInstallHostEnvironment(f.input,f.ports)
    expect(f.prepare).toHaveBeenCalledTimes(2)
  })
  test('upgrade reuses a bound runtime, but never creates a fresh Home or resolves latest', async () => {
    const f = await fixture()
    expect(await prepareInstallHostEnvironment({...f.input,prepareFresh:false},f.ports)).toEqual(f.input.environment)
    await expect(stat(f.input.dshHome)).rejects.toMatchObject({code:'ENOENT'})
    await prepareInstallHostEnvironment(f.input,f.ports)
    f.prepare.mockClear()
    expect((await prepareInstallHostEnvironment({...f.input,prepareFresh:false},f.ports)).PATH).toContain(f.runtime.binDirectory)
    expect(f.prepare).not.toHaveBeenCalled()
  })
})

describe('installer Host preparation wiring', () => {
  const options = {mode:'local' as const,localRepositoryRoot:'/repo',releaseRef:'v0.1.48',dshHome:'/new/home'}
  function executor() {
    return {prepareHost:vi.fn(async () => ({PATH:'/private/bin',DSH_HOME:'/canonical/home'})),download:vi.fn(async () => ''),runInherited:vi.fn(async () => 0)}
  }
  test('delegates with prepared environment and explicit selector', async () => {
    const ports = executor()
    await runInstall({...options,passthrough:['--dsh-version','0.1.5-rc.3'],executor:ports})
    expect(ports.prepareHost).toHaveBeenCalledWith(expect.objectContaining({dshHome:'/new/home',selector:'0.1.5-rc.3'}))
    expect(ports.runInherited).toHaveBeenCalledWith('bash',[
      '/repo/scripts/install/install-local.sh','--dsh-version','0.1.5-rc.3','--scenario','supervised',
    ],{env:{PATH:'/private/bin',DSH_HOME:'/canonical/home'}})
  })
  test('explicit legacy mode preserves Host preparation and suppresses the default scenario', async () => {
    const ports = executor()
    await runInstall({...options,passthrough:['--mode','standard'],executor:ports})
    expect(ports.prepareHost).toHaveBeenCalledWith(expect.objectContaining({prepareFresh:true,selector:'latest'}))
    expect(ports.runInherited).toHaveBeenCalledWith('bash',[
      '/repo/scripts/install/install-local.sh','--mode','standard',
    ],{env:{PATH:'/private/bin',DSH_HOME:'/canonical/home'}})
  })
  test.each([['--dry-run'],['--help'],['-h']])('does not prepare for %j', async (...passthrough) => {
    const ports = executor()
    await runInstall({...options,passthrough,executor:ports})
    expect(ports.prepareHost).not.toHaveBeenCalled()
    expect(ports.runInherited).toHaveBeenCalledOnce()
  })
  test.each(['upgrade','recover'])('%s selects only an already-bound Host', async operation => {
    const ports = executor()
    await runInstall({...options,passthrough:['--operation',operation],executor:ports})
    expect(ports.prepareHost).toHaveBeenCalledWith(expect.objectContaining({prepareFresh:false}))
    expect(ports.runInherited).toHaveBeenCalledWith('bash',expect.any(Array),{env:{PATH:'/private/bin',DSH_HOME:'/canonical/home'}})
  })
  test.each([['--dsh-version'],['--dsh-version','--yes'],['--dsh-version','latest','--dsh-version','latest'],['--operation']])('rejects malformed Host arguments before preparation: %j', async (...passthrough) => {
    const ports = executor()
    await expect(runInstall({...options,passthrough,executor:ports})).rejects.toThrow('必须提供')
    expect(ports.prepareHost).not.toHaveBeenCalled()
    expect(ports.runInherited).not.toHaveBeenCalled()
  })
  test('preparation failure never invokes the installer', async () => {
    const ports = executor()
    ports.prepareHost.mockRejectedValueOnce(new Error('Host verification failed'))
    await expect(runInstall({...options,passthrough:[],executor:ports})).rejects.toThrow('Host verification failed')
    expect(ports.runInherited).not.toHaveBeenCalled()
  })
})
