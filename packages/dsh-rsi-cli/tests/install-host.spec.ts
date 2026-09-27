import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { prepareHostUpdatePlan, prepareInstallHostEnvironment, type InstallHostPorts } from '../src/install-host.ts'
import { runInstall } from '../src/install.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
function runtimeAt(cacheRoot: string, version: string, receiptDigest = 'a'.repeat(64)) {
  const root = join(cacheRoot, version)
  return { version, root, dshPath: join(root, 'dsh.js'), binDirectory: join(root, 'bin'), integrity: 'fixture', receiptDigest }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'dsh-install-host-'))
  roots.push(root)
  const dshHome = join(root,'home with spaces')
  const cacheRoot = join(root,'cache')
  const runtime = runtimeAt(cacheRoot, '0.1.5-rc.3')
  const prepare = vi.fn(async () => runtime)
  const read = vi.fn(async (_input: Parameters<InstallHostPorts['read']>[0]) => runtime)
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

describe('read-only Home Host update planning', () => {
  test('same verified version returns current with exact original source and no Home writes', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input, f.ports)
    const path = join(f.input.dshHome, '.dsh-rsi-host.json')
    const before = await readFile(path, 'utf8')
    f.prepare.mockClear()
    const plan = await prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)
    expect(plan).toMatchObject({ schemaVersion: 1, status: 'current', canonicalHome: f.input.dshHome,
      bindingPath: path, originalRuntime: f.runtime, candidateRuntime: f.runtime,
      originalBindingSource: before, candidateBindingSource: before,
      originalBindingDigest: createHash('sha256').update(before).digest('hex') })
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith({ root: f.input.cacheRoot, selector: 'latest' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readdir(f.input.dshHome)).toEqual(['.dsh-rsi-host.json'])
  })
  test('a different compatible exact version only prepares candidate binding bytes', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input, f.ports)
    const path = join(f.input.dshHome, '.dsh-rsi-host.json')
    const before = await readFile(path, 'utf8')
    const candidate = runtimeAt(f.input.cacheRoot, '0.1.5-rc.4', 'b'.repeat(64))
    f.prepare.mockResolvedValue(candidate)
    f.read.mockImplementation(async ({ version }) => version === candidate.version ? candidate : f.runtime)
    const plan = await prepareHostUpdatePlan({ dshHome: f.input.dshHome, selector: '0.1.5-rc.4' }, f.ports)
    expect(plan.status).toBe('update')
    expect(plan.candidateRuntime).toEqual(candidate)
    expect(JSON.parse(plan.candidateBindingSource)).toEqual({ schemaVersion: 1, cacheRoot: f.input.cacheRoot,
      version: candidate.version, receiptDigest: candidate.receiptDigest })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(f.prepare).toHaveBeenLastCalledWith({ root: f.input.cacheRoot, selector: '0.1.5-rc.4' })
  })
  test('same-version receipt or runtime path mismatch cannot be treated as current', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input, f.ports)
    const path = join(f.input.dshHome, '.dsh-rsi-host.json')
    const before = await readFile(path, 'utf8')
    f.prepare.mockResolvedValueOnce({ ...f.runtime, receiptDigest: 'b'.repeat(64) })
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('独立收据验证')
    f.prepare.mockResolvedValueOnce({ ...f.runtime, dshPath: join(f.root, 'other-dsh.js') })
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('独立收据验证')
    expect(await readFile(path, 'utf8')).toBe(before)
  })
  test.each([['0.1.5-rc.4', '0.1.5-rc.3'], ['0.1.5', '0.1.5-rc.4']])(
    'latest and exact selectors cannot downgrade %s to %s', async (originalVersion, olderVersion) => {
      const f = await fixture()
      const originalRuntime = runtimeAt(f.input.cacheRoot, originalVersion)
      f.prepare.mockResolvedValueOnce(originalRuntime)
      f.read.mockResolvedValue(originalRuntime)
      await prepareInstallHostEnvironment(f.input, f.ports)
      const path = join(f.input.dshHome, '.dsh-rsi-host.json')
      const before = await readFile(path, 'utf8')
      f.prepare.mockClear()
      f.prepare.mockResolvedValue(runtimeAt(f.input.cacheRoot, olderVersion, 'b'.repeat(64)))
      await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('不能降级')
      expect(f.prepare).toHaveBeenCalledTimes(1)
      await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome, selector: olderVersion }, f.ports)).rejects.toThrow('不能降级')
      expect(f.prepare).toHaveBeenCalledTimes(1)
      expect(await readFile(path, 'utf8')).toBe(before)
    })
  test('a different-version candidate must independently match the exact cached runtime', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input, f.ports)
    const path = join(f.input.dshHome, '.dsh-rsi-host.json')
    const before = await readFile(path, 'utf8')
    const candidate = runtimeAt(f.input.cacheRoot, '0.1.5-rc.4', 'b'.repeat(64))
    f.prepare.mockResolvedValue(candidate)
    f.read.mockImplementation(async ({ version }) => version === candidate.version
      ? { ...candidate, root: join(f.root, 'foreign-cache') } : f.runtime)
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('独立收据验证')
    expect(f.read).toHaveBeenLastCalledWith({ root: f.input.cacheRoot, version: candidate.version })
    f.read.mockImplementation(async ({ version }) => version === candidate.version
      ? { ...candidate, receiptDigest: 'c'.repeat(64) } : f.runtime)
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('独立收据验证')
    expect(await readFile(path, 'utf8')).toBe(before)
  })
  test('unknown or unbound Homes never create a binding or candidate', async () => {
    const f = await fixture()
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('不存在')
    await expect(stat(f.input.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(f.input.dshHome)
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('没有私有 Host 绑定')
    expect(await readdir(f.input.dshHome)).toEqual([])
    expect(f.prepare).not.toHaveBeenCalled()
  })
  test('tampered receipt and public binding mode fail before candidate preparation', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input, f.ports)
    const path = join(f.input.dshHome, '.dsh-rsi-host.json')
    const before = await readFile(path, 'utf8')
    f.prepare.mockClear()
    f.read.mockResolvedValue({ ...f.runtime, receiptDigest: 'b'.repeat(64) })
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('制品发生变化')
    expect(f.prepare).not.toHaveBeenCalled()
    f.read.mockResolvedValue(f.runtime)
    await chmod(path, 0o644)
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('不安全')
    expect(await readFile(path, 'utf8')).toBe(before)
  })
  test('binding drift during preparation is rejected without publishing the candidate', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input, f.ports)
    const path = join(f.input.dshHome, '.dsh-rsi-host.json')
    const drifted = JSON.stringify({ schemaVersion: 1, cacheRoot: f.input.cacheRoot, version: f.runtime.version,
      receiptDigest: 'c'.repeat(64) }) + '\n'
    const candidate = runtimeAt(f.input.cacheRoot, '0.1.5-rc.4', 'b'.repeat(64))
    f.read.mockImplementation(async ({ version }) => version === candidate.version ? candidate : f.runtime)
    f.prepare.mockImplementation(async () => {
      await writeFile(path, drifted, { mode: 0o600 })
      return candidate
    })
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('绑定发生变化')
    expect(await readFile(path, 'utf8')).toBe(drifted)
  })
  test('incompatible latest and cancellation leave the binding unchanged', async () => {
    const f = await fixture()
    await prepareInstallHostEnvironment(f.input, f.ports)
    const path = join(f.input.dshHome, '.dsh-rsi-host.json')
    const before = await readFile(path, 'utf8')
    f.prepare.mockResolvedValueOnce({ ...f.runtime, version: '0.2.0' })
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome }, f.ports)).rejects.toThrow('候选 Host 版本')
    const controller = new AbortController()
    f.prepare.mockImplementationOnce(async () => { controller.abort(); return f.runtime })
    await expect(prepareHostUpdatePlan({ dshHome: f.input.dshHome, signal: controller.signal }, f.ports)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.read).toHaveBeenLastCalledWith({ root: f.input.cacheRoot, version: f.runtime.version, signal: controller.signal })
    expect(f.prepare).toHaveBeenLastCalledWith({ root: f.input.cacheRoot, selector: 'latest', signal: controller.signal })
    expect(await readFile(path, 'utf8')).toBe(before)
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
