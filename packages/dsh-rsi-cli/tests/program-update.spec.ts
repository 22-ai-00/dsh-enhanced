import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { assertFrozenCliUpdateVersion, detectFrozenOwner, runFrozenOwnerUpdate, type ProgramUpdatePorts } from '../src/program-update.ts'
import { main } from '../src/index.ts'
import { runSelfUpdate } from '../src/update.ts'
import { version as VERSION } from '../src/version.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-program-update-')))
  roots.push(root)
  const home = join(root, 'home'), repository = join(root, 'repository'), profile = 'owner'
  await mkdir(join(home, 'rsi-local-cohorts', profile), { recursive: true, mode: 0o700 })
  await mkdir(repository, { mode: 0o700 })
  const receipt = join(home, 'rsi-local-cohorts', profile, 'receipt.json')
  const marker = join(home, `.rsi-coordinator-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}.json`)
  await writeFile(receipt, JSON.stringify({ schemaVersion: 1, root: join(home, 'rsi-local-cohorts', profile), sourceRepository: repository }), { mode: 0o600 })
  await writeFile(marker, JSON.stringify({ schemaVersion: 1, targetProfile: profile, coordinatorProfile: 'coordinator', sourceRepository: repository }), { mode: 0o600 })
  return { root, home, repository, profile, receipt, marker }
}

async function auxiliary(f: Awaited<ReturnType<typeof fixture>>, suffix = 'a'.repeat(20)) {
  const name = `host-migration-${suffix}`
  const root = join(f.home, 'rsi-local-cohorts', name)
  const artifacts = join(root, 'artifacts')
  await mkdir(artifacts, { recursive: true, mode: 0o700 })
  const tarball = join(artifacts, 'assistant-actions.tgz')
  const bundles = ['assistant-actions', 'assistant-automations', 'assistant-policy', 'plugin-control-plane']
  const packages = []
  for (const slug of bundles) {
    const artifact = join(artifacts, `${slug}.tgz`)
    const content = `archive:${slug}`
    await writeFile(artifact, content, { mode: 0o600 })
    packages.push({ name: `@dsh-enhanced/${slug}`, path: `plugins/${slug}`, bundle: true,
      tarball: artifact, sha256: createHash('sha256').update(content).digest('hex'), runtimeDependencies: [], files: [] })
  }
  const body = { schemaVersion: 1, root, sourceCommit: 'a'.repeat(40), version: '0.1.56',
    sourceRepository: f.repository, allowBuilds: {}, bundles, packages }
  const receipt = join(root, 'receipt.json')
  await writeFile(receipt, JSON.stringify({ ...body,
    receiptDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }), { mode: 0o600 })
  return { name, root, artifacts, tarball, receipt }
}

async function rewriteAuxiliaryReceipt(path: string, change: (body: Record<string, unknown>) => void): Promise<void> {
  const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const { receiptDigest: _digest, ...body } = original
  change(body)
  await writeFile(path, JSON.stringify({ ...body,
    receiptDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') }))
}

function historicalCandidate(home: string): string {
  return join(dirname(home), `.dsh-rsi-local-updates-${createHash('sha256').update(home).digest('hex').slice(0, 16)}`,
    'b'.repeat(64), 'source', 'repository')
}

test('detects exactly the owner target and rejects unsafe or ambiguous files', async () => {
  const f = await fixture()
  expect(await detectFrozenOwner(f.home)).toEqual({ home: f.home, profile: f.profile, repository: f.repository })
  await writeFile(join(f.home, 'rsi-local-cohorts', 'other'), '')
  await expect(detectFrozenOwner(f.home)).rejects.toThrow(/未知本地 cohort/)
  await rm(join(f.home, 'rsi-local-cohorts', 'other'))
  await rm(f.receipt)
  await symlink(f.marker, f.receipt)
  await expect(detectFrozenOwner(f.home)).rejects.toThrow()
})

test('single owner marker selects target while retaining historical host-migration cohorts', async () => {
  const f = await fixture()
  for (const suffix of ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(20), 'e'.repeat(20)]) {
    await auxiliary(f, suffix)
  }
  expect(await detectFrozenOwner(f.home)).toEqual({ home: f.home, profile: f.profile, repository: f.repository })
})

test('accepts a historical candidate source bound to this Home without requiring that source to exist', async () => {
  const f = await fixture(), item = await auxiliary(f)
  await rewriteAuxiliaryReceipt(item.receipt, body => { body.sourceRepository = historicalCandidate(f.home) })
  expect(await detectFrozenOwner(f.home)).toEqual({ home: f.home, profile: f.profile, repository: f.repository })
})

test('rejects auxiliary candidate source from another Home or outside its exact namespace', async () => {
  for (const sourceRepository of [
    (home: string) => historicalCandidate(join(dirname(home), 'other-home')),
    (home: string) => `${historicalCandidate(home)}/../repository`,
  ]) {
    const f = await fixture(), item = await auxiliary(f)
    await rewriteAuxiliaryReceipt(item.receipt, body => { body.sourceRepository = sourceRepository(f.home) })
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/收据格式或绑定无效/)
  }
})

test('rejects unknown, tampered, extra-owner and real-profile auxiliary cohorts', async () => {
  {
    const f = await fixture()
    await mkdir(join(f.home, 'rsi-local-cohorts', 'unknown'), { mode: 0o700 })
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/未知本地 cohort/)
  }
  {
    const f = await fixture(), item = await auxiliary(f)
    const original = JSON.parse(await readFile(item.receipt, 'utf8')) as Record<string, unknown>
    await writeFile(item.receipt, JSON.stringify({ ...original, sourceCommit: 'b'.repeat(40) }))
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/摘要不一致/)
  }
  {
    const f = await fixture(), item = await auxiliary(f)
    const original = JSON.parse(await readFile(item.receipt, 'utf8')) as Record<string, unknown>
    const { receiptDigest: _digest, ...body } = original
    const forged = { ...body, root: join(f.home, 'rsi-local-cohorts', 'other') }
    await writeFile(item.receipt, JSON.stringify({ ...forged,
      receiptDigest: createHash('sha256').update(JSON.stringify(forged)).digest('hex') }))
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/收据格式或绑定无效/)
  }
  {
    const f = await fixture()
    await auxiliary(f)
    const other = 'other'
    await writeFile(join(f.home, `.rsi-coordinator-${createHash('sha256').update(other).digest('hex').slice(0, 16)}.json`),
      '{}', { mode: 0o600 })
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/恰好一个/)
  }
  {
    const f = await fixture(), item = await auxiliary(f)
    await mkdir(join(f.home, 'profiles', item.name), { recursive: true, mode: 0o700 })
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/真实 profile/)
  }
})

test('rejects auxiliary cohort unknown files, symlinks and unsafe permissions', async () => {
  {
    const f = await fixture(), item = await auxiliary(f)
    await writeFile(join(item.root, 'extra'), 'x')
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/未知文件/)
  }
  {
    const f = await fixture(), item = await auxiliary(f)
    await rm(item.tarball)
    await symlink(f.receipt, item.tarball)
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/制品文件不安全/)
  }
  {
    const f = await fixture(), item = await auxiliary(f)
    await chmod(item.root, 0o755)
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(/目录不安全/)
  }
})

test('rejects same-length artifact tampering even when receipt and file metadata remain plausible', async () => {
  const f = await fixture(), item = await auxiliary(f)
  const content = await readFile(item.tarball)
  content[0] = content[0] === 0x58 ? 0x59 : 0x58
  await writeFile(item.tarball, content)
  await expect(detectFrozenOwner(f.home)).rejects.toThrow(/制品摘要不一致/)
})

test('rejects rehashed auxiliary receipt with invalid package graph', async () => {
  const cases: { change: (body: Record<string, unknown>) => void; message: RegExp }[] = [
    { change: body => { ((body.packages as Record<string, unknown>[])[0]!).path = 'packages/assistant-actions' },
      message: /包记录无效/ },
    { change: body => { ((body.packages as Record<string, unknown>[])[0]!).bundle = false },
      message: /包记录无效/ },
    { change: body => { ((body.packages as Record<string, unknown>[])[0]!).runtimeDependencies = ['@dsh-enhanced/missing'] },
      message: /依赖闭包无效/ },
    { change: body => { ((body.packages as Record<string, unknown>[])[0]!).files = [
      { path: '../escape', sha256: 'a'.repeat(64), mode: 0o600 },
    ] }, message: /文件记录无效/ },
    { change: body => { body.bundles = ['assistant-actions', 'assistant-automations', 'assistant-policy', 'plugin-control-plane', 'unknown'] },
      message: /缺少必要 bundle/ },
    { change: body => { body.bundles = [] }, message: /bundle 清单无效/ },
  ]
  for (const { change, message } of cases) {
    const f = await fixture(), item = await auxiliary(f)
    await rewriteAuxiliaryReceipt(item.receipt, change)
    await expect(detectFrozenOwner(f.home)).rejects.toThrow(message)
  }
})

test('default Home alias resolves to canonical owner Home and dispatches its original target', async () => {
  const f = await fixture()
  const aliasParent = join(f.root, 'login-home')
  await mkdir(aliasParent)
  await symlink(f.home, join(aliasParent, '.dsh'))
  expect(await detectFrozenOwner(join(aliasParent, '.dsh'))).toEqual({
    home: f.home, profile: f.profile, repository: f.repository,
  })
  const previousHome = process.env.HOME
  process.env.HOME = aliasParent
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const frozenUpdate = vi.fn(async () => 0)
  try {
    expect(await main(['update', '--all', '--yes', '--dry-run'], { HOME: aliasParent },
      { platform: 'linux', frozenUpdate, selfUpdate: async () => ({ fromVersion: VERSION, selector: 'latest',
        installedVersion: VERSION, alreadyCurrent: true, migratedFrom: false, actions: [] }) })).toBe(0)
    expect(frozenUpdate).toHaveBeenCalledWith({ home: f.home, profile: f.profile, repository: f.repository }, { dryRun: true })
  } finally {
    output.mockRestore()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

function ports(repo: string, overrides: Record<string, string> = {}) {
  const calls: string[] = []
  const values: Record<string, string> = {
    'git remote get-url origin': 'https://github.com/22-ai-00/dsh-enhanced.git',
    'git symbolic-ref --quiet --short HEAD': 'dev',
    'git status --porcelain=v1 --untracked-files=all': '',
    'git rev-parse --show-toplevel': repo,
    ...overrides,
  }
  const adapter: ProgramUpdatePorts = { run(command, args, cwd) {
    const key = [command, ...args].join(' ')
    calls.push(`${cwd ?? '-'} ${key}`)
    return { status: 0, stdout: values[key] ?? '' }
  } }
  return { adapter, calls }
}

test('source branch update uses fetch, fast-forward merge, frozen install, build, then program script', async () => {
  const f = await fixture(), owner = (await detectFrozenOwner(f.home))!
  const { adapter, calls } = ports(f.repository)
  expect(await runFrozenOwnerUpdate(owner, { dryRun: true }, adapter)).toBe(0)
  expect(calls).toHaveLength(4)
  calls.length = 0
  expect(await runFrozenOwnerUpdate(owner, { dryRun: false, dshVersion: '0.2.1-rc.2' }, adapter)).toBe(0)
  expect(calls.slice(4, 8)).toEqual([
    `${f.repository} git fetch origin dev`, `${f.repository} git merge --ff-only FETCH_HEAD`,
    `${f.repository} pnpm install --frozen-lockfile`, `${f.repository} pnpm build`,
  ])
  expect(calls[8]).toContain(`scripts/install/upgrade-program.mjs --dsh-home ${f.home} --profile owner --dsh-version 0.2.1-rc.2`)
})

test('rejects foreign origin, dirty tree and detached or divergent branches before build', async () => {
  const f = await fixture(), owner = (await detectFrozenOwner(f.home))!
  for (const overrides of [
    { 'git remote get-url origin': 'https://example.org/other.git' },
    { 'git status --porcelain=v1 --untracked-files=all': ' M package.json' },
    { 'git symbolic-ref --quiet --short HEAD': 'feature' },
  ]) {
    const { adapter, calls } = ports(f.repository, overrides)
    await expect(runFrozenOwnerUpdate(owner, { dryRun: false }, adapter)).rejects.toThrow()
    expect(calls.some(call => call.includes('pnpm '))).toBe(false)
  }
  const { adapter, calls } = ports(f.repository)
  adapter.run = (command, args, cwd) => {
    const key = [command, ...args].join(' ')
    calls.push(`${cwd ?? '-'} ${key}`)
    return { status: key === 'git merge --ff-only FETCH_HEAD' ? 1 : 0,
      stdout: key === 'git remote get-url origin' ? 'https://github.com/22-ai-00/dsh-enhanced.git'
        : key === 'git symbolic-ref --quiet --short HEAD' ? 'dev'
          : key === 'git rev-parse --show-toplevel' ? f.repository : '' }
  }
  await expect(runFrozenOwnerUpdate(owner, { dryRun: false }, adapter)).rejects.toThrow(/退出码 1/)
  expect(calls.some(call => call.includes('pnpm '))).toBe(false)
})

test('pending v4 owner transaction uses bound original installer recovery before any Git command', async () => {
  const f = await fixture(), owner = (await detectFrozenOwner(f.home))!
  const transaction = `${f.home}.dsh-enhanced-transaction`
  await mkdir(transaction, { mode: 0o700 })
  await writeFile(join(transaction, 'manifest.json'), JSON.stringify({ version: 4, homePath: f.home,
    profile: f.profile, transactionPath: transaction, hostMigration: { localSource: {
      protocol: 'dsh-enhanced/host-owner-program-update/v1', ownerUpdate: { installer: { root: f.repository } },
    } } }), { mode: 0o600 })
  const { adapter, calls } = ports(f.repository)
  expect(await runFrozenOwnerUpdate(owner, { dryRun: true }, adapter)).toBe(0)
  expect(calls).toEqual([])
  expect(await runFrozenOwnerUpdate(owner, { dryRun: false }, adapter)).toBe(0)
  expect(calls).toEqual([`- ${process.execPath} ${join(f.repository, 'scripts', 'install', 'upgrade-program.mjs')} --dsh-home ${f.home} --profile owner --recover`])
})

test('a readiness recovery envelope never selects an executable path through the ordinary updater', async () => {
  const f = await fixture(), owner = (await detectFrozenOwner(f.home))!
  const transaction = `${f.home}.dsh-enhanced-transaction`
  await mkdir(transaction, { mode: 0o700 })
  await writeFile(join(transaction, 'manifest.json'), JSON.stringify({ version: 4, homePath: f.home,
    profile: f.profile, transactionPath: transaction, hostMigration: {
      localSource: { protocol: 'dsh-enhanced/host-owner-program-update/v1', ownerUpdate: { installer: { root: f.repository } } },
      programReadinessRecovery: { permit: { readinessInstaller: { root: '/untrusted/installer' } } },
    } }), { mode: 0o600 })
  const { adapter, calls } = ports(f.repository)
  await expect(runFrozenOwnerUpdate(owner, { dryRun: false }, adapter)).rejects.toThrow('独立审核')
  expect(calls).toEqual([])
})

test('Linux frozen route rejects extra authority flags and uses bound target without npm installer', async () => {
  const f = await fixture()
  const selfUpdate = vi.fn(async () => ({ fromVersion: VERSION, selector: 'latest', installedVersion: VERSION,
    alreadyCurrent: true, migratedFrom: false, actions: [] }))
  const install = vi.fn(async () => 0), frozenUpdate = vi.fn(async () => 0)
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    expect(await main(['update', '--all', '--yes', '--dry-run'], { DSH_HOME: f.home },
      { platform: 'linux', selfUpdate, install, frozenUpdate })).toBe(0)
    expect(frozenUpdate).toHaveBeenCalledWith({ home: f.home, profile: 'owner', repository: f.repository }, { dryRun: true })
    expect(install).not.toHaveBeenCalled()
    expect(await main(['update', '--all', '--yes', '--scenario', 'web'], { DSH_HOME: f.home },
      { platform: 'linux', selfUpdate, install, frozenUpdate })).toBe(1)
    expect(await main(['update', '--all', '--yes', '--profile', 'web'], { DSH_HOME: f.home },
      { platform: 'linux', selfUpdate, install, frozenUpdate })).toBe(1)
    expect(selfUpdate).toHaveBeenCalledTimes(1)
  } finally { error.mockRestore(); output.mockRestore() }
})

test('frozen owner rejects explicit CLI downgrade before self-update, fresh exec or Home update', async () => {
  const f = await fixture()
  const selfUpdate = vi.fn(async () => ({ fromVersion: VERSION, selector: 'latest', installedVersion: VERSION,
    alreadyCurrent: true, migratedFrom: false, actions: [] }))
  const freshExec = vi.fn(() => 0), frozenUpdate = vi.fn(async () => 0), install = vi.fn(async () => 0)
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(await main(['update', '--all', '--yes', '--version', '0.1.55'], { DSH_HOME: f.home },
      { platform: 'linux', selfUpdate, freshExec, frozenUpdate, install })).toBe(1)
    expect(selfUpdate).not.toHaveBeenCalled()
    expect(freshExec).not.toHaveBeenCalled()
    expect(frozenUpdate).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  } finally { error.mockRestore() }
})

test('single CLI update keeps its explicit version selector', async () => {
  const selfUpdate = vi.fn(async () => ({ fromVersion: VERSION, selector: '0.1.55', installedVersion: '0.1.55',
    alreadyCurrent: true, migratedFrom: false, actions: [] }))
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    expect(await main(['update', '--version', '0.1.55'], { DSH_HOME: '/absent' },
      { platform: 'linux', selfUpdate })).toBe(0)
    expect(selfUpdate).toHaveBeenCalledWith({ selector: '0.1.55', dryRun: false })
  } finally { output.mockRestore() }
})

test('frozen owner version guard is derived from running version and rejects older installed CLI', async () => {
  expect(() => assertFrozenCliUpdateVersion('0.1.55', '0.1.56', false)).toThrow(/不能证明/)
  expect(() => assertFrozenCliUpdateVersion('0.1.56-rc.1', '0.1.56', false)).toThrow(/不能证明/)
  expect(() => assertFrozenCliUpdateVersion('0.1.56', '0.1.56', false)).toThrow(/不能证明/)
  expect(() => assertFrozenCliUpdateVersion('0.1.57', '0.1.56', false)).not.toThrow()
  const f = await fixture()
  const freshExec = vi.fn(() => 0), frozenUpdate = vi.fn(async () => 0)
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    expect(await main(['update', '--all', '--yes'], { DSH_HOME: f.home }, {
      platform: 'linux', freshExec, frozenUpdate,
      selfUpdate: async () => ({ fromVersion: VERSION, selector: 'latest', installedVersion: '0.1.54',
        alreadyCurrent: false, migratedFrom: false, actions: [] }),
    })).toBe(1)
    expect(freshExec).not.toHaveBeenCalled()
    expect(frozenUpdate).not.toHaveBeenCalled()
  } finally { error.mockRestore(); output.mockRestore() }
})

test('frozen owner keeps a newer official local CLI when npm latest lags, then dispatches program update', async () => {
  const f = await fixture()
  const calls: string[] = []
  const frozenUpdate = vi.fn(async () => 0)
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    expect(await main(['update', '--all', '--yes'], { DSH_HOME: f.home }, {
      platform: 'linux', frozenUpdate,
      selfUpdate: options => runSelfUpdate({ ...options,
        packageRoot: '/test/global/lib/node_modules/@dsh-enhanced/dsh-rsi-cli',
        runner: (command, args) => {
          calls.push([command, ...args].join(' '))
          return { status: 0, stdout: args[0] === 'view' ? '0.1.54\n' : '', stderr: '' }
        },
      }),
    })).toBe(0)
    expect(calls.some(call => call.startsWith('npm install'))).toBe(false)
    expect(frozenUpdate).toHaveBeenCalledWith({ home: f.home, profile: f.profile, repository: f.repository }, { dryRun: false })
  } finally { output.mockRestore() }
})

test('after a changed global CLI install, fresh bin receives preserved arguments once', async () => {
  const f = await fixture(), prefix = join(f.root, 'npm')
  const bin = join(prefix, 'lib', 'node_modules', '@dsh-enhanced', 'dsh-rsi-cli', 'bin', 'dsh-rsi.js')
  await mkdir(resolve(bin, '..'), { recursive: true })
  await writeFile(bin, '')
  await writeFile(join(prefix, 'lib', 'node_modules', '@dsh-enhanced', 'dsh-rsi-cli', 'package.json'),
    JSON.stringify({ name: '@dsh-enhanced/dsh-rsi-cli', version: '99.0.0' }))
  const freshExec = vi.fn(() => 7), frozenUpdate = vi.fn(async () => 0)
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    const argv = ['update', '--all', '--yes', '--profile', 'owner']
    expect(await main(argv, { DSH_HOME: f.home }, { platform: 'linux', freshExec, frozenUpdate,
      selfUpdate: async () => ({ fromVersion: VERSION, selector: 'latest', installedVersion: '99.0.0',
        globalPrefix: prefix, alreadyCurrent: false, migratedFrom: false, actions: [] }) })).toBe(7)
    expect(freshExec).toHaveBeenCalledWith(bin, argv, expect.objectContaining({ DSH_RSI_UPDATE_FRESH_EXEC: '1' }))
    expect(frozenUpdate).not.toHaveBeenCalled()
  } finally { output.mockRestore() }
})

test('fresh exec rejects a mismatched manifest or unsafe bin before spawning', async () => {
  const f = await fixture(), prefix = join(f.root, 'npm')
  const packageRoot = join(prefix, 'lib', 'node_modules', '@dsh-enhanced', 'dsh-rsi-cli')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  const bin = join(packageRoot, 'bin', 'dsh-rsi.js')
  await writeFile(bin, '')
  const manifest = join(packageRoot, 'package.json')
  await writeFile(manifest, JSON.stringify({ name: '@dsh-enhanced/dsh-rsi-cli', version: '98.0.0' }))
  const freshExec = vi.fn(() => 0)
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const deps = { platform: 'linux' as const, freshExec,
    selfUpdate: async () => ({ fromVersion: VERSION, selector: 'latest', installedVersion: '99.0.0',
      globalPrefix: prefix, alreadyCurrent: false, migratedFrom: false, actions: [] }) }
  try {
    expect(await main(['update', '--all', '--yes'], { DSH_HOME: f.home }, deps)).toBe(1)
    await writeFile(manifest, JSON.stringify({ name: '@dsh-enhanced/dsh-rsi-cli', version: '99.0.0' }))
    await chmod(bin, 0o666)
    expect(await main(['update', '--all', '--yes'], { DSH_HOME: f.home }, deps)).toBe(1)
    expect(freshExec).not.toHaveBeenCalled()
  } finally { error.mockRestore(); output.mockRestore() }
})
