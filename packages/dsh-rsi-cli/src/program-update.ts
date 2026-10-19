import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { PurgeError } from './purge.ts'

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export interface FrozenOwner { home: string; profile: string; repository: string }
export interface ProgramUpdatePorts {
  run: (command: string, args: readonly string[], cwd?: string, capture?: boolean) => { status: number | null; stdout: string }
  scriptRoot?: string
}

const defaultPorts: ProgramUpdatePorts = {
  run(command, args, cwd, capture = true) {
    const result = spawnSync(command, [...args], { cwd, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' })
    return { status: result.status, stdout: result.stdout ?? '' }
  },
}

function fail(reason: string): never { throw new PurgeError(`冻结 owner 更新：${reason}`) }

async function ownedDirectory(path: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o022)) {
    fail(`目录归属或权限不安全：${path}`)
  }
}

async function privateJson(path: string, limit: number): Promise<Record<string, unknown>> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await descriptor.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o077) || before.size < 1 || before.size > limit) fail(`收据不安全：${path}`)
    const bytes = await descriptor.readFile()
    const after = await descriptor.stat()
    const named = await lstat(path)
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink()) fail(`收据读取期间变化：${path}`)
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`收据格式错误：${path}`)
    return value as Record<string, unknown>
  } finally { await descriptor.close() }
}

async function names(path: string): Promise<string[]> {
  try { return await readdir(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

/** Read-only, fail-closed recognition. Partial frozen installations must not fall into the npm updater. */
export async function detectFrozenOwner(dshHome: string): Promise<FrozenOwner | undefined> {
  if (!isAbsolute(dshHome) || resolve(dshHome) !== dshHome) {
    fail('DSH_HOME 必须是规范绝对路径')
  }
  const canonical = await realpath(dshHome).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (canonical === undefined) return undefined
  await ownedDirectory(canonical)
  const cohorts = await names(join(canonical, 'rsi-local-cohorts'))
  const localRoot = await lstat(join(canonical, 'rsi-local-cohorts')).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  const markers = (await names(canonical)).filter(name => name.startsWith('.rsi-coordinator-'))
  if (localRoot === undefined && markers.length === 0) return undefined
  if (cohorts.length !== 1 || markers.length !== 1 || !profilePattern.test(cohorts[0]!)) {
    fail('只接受恰好一个冻结 target 与 coordinator marker')
  }
  const profile = cohorts[0]!
  const marker = `.rsi-coordinator-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}.json`
  if (markers[0] !== marker) fail('coordinator marker 与 target 不一致')
  await ownedDirectory(join(canonical, 'rsi-local-cohorts'))
  await ownedDirectory(join(canonical, 'rsi-local-cohorts', profile))
  const cohort = await privateJson(join(canonical, 'rsi-local-cohorts', profile, 'receipt.json'), 16_777_216)
  const pair = await privateJson(join(canonical, marker), 65_536)
  const repository = cohort.sourceRepository
  if (cohort.schemaVersion !== 1 || cohort.root !== join(canonical, 'rsi-local-cohorts', profile)
    || typeof repository !== 'string' || !isAbsolute(repository) || resolve(repository) !== repository
    || await realpath(repository) !== repository || pair.schemaVersion !== 1 || pair.targetProfile !== profile
    || pair.sourceRepository !== repository || !profilePattern.test(String(pair.coordinatorProfile))
    || pair.coordinatorProfile === profile) fail('冻结收据的 target、source 或 coordinator 不一致')
  await ownedDirectory(repository)
  return { home: canonical, profile, repository }
}

export function assertFrozenUpdateArgs(input: {
  profile?: string; local?: string; passthrough: readonly string[]; yes: boolean; dshVersion?: string; cliVersion?: string
}, owner: FrozenOwner): void {
  if (input.profile !== undefined && input.profile !== owner.profile) fail(`目标 profile 必须是 ${owner.profile}`)
  if (input.cliVersion !== undefined && input.cliVersion !== 'latest') {
    fail('冻结 owner 的 --all 只允许 CLI --version latest，不能指定旧版或精确版本')
  }
  if (input.local !== undefined || input.passthrough.length > 0 || !input.yes) {
    fail('冻结更新只接受 --all --yes、现有 --profile、--dsh-version、--dry-run 与 CLI --version')
  }
  // The host-runtime contract performs the final selector and compatibility check.
}

export function compareExactVersions(left: string, right: string): number | undefined {
  const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u
  const a = pattern.exec(left), b = pattern.exec(right)
  if (a === null || b === null) return undefined
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index])
    if (!Number.isSafeInteger(Number(a[index])) || !Number.isSafeInteger(Number(b[index]))) return undefined
    if (difference !== 0) return Math.sign(difference)
  }
  if (a[4] === undefined && b[4] === undefined) return 0
  if (a[4] === undefined) return 1
  if (b[4] === undefined) return -1
  const leftParts = a[4].split('.'), rightParts = b[4].split('.')
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const l = leftParts[index], r = rightParts[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    const numericLeft = /^\d+$/u.test(l), numericRight = /^\d+$/u.test(r)
    if (numericLeft && numericRight) {
      const delta = BigInt(l) - BigInt(r)
      return delta < 0n ? -1 : 1
    }
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1
    return l < r ? -1 : 1
  }
  return 0
}

export function assertFrozenCliUpdateVersion(installedVersion: string | undefined, currentVersion: string,
  alreadyCurrent: boolean): void {
  const comparison = installedVersion === undefined ? undefined : compareExactVersions(installedVersion, currentVersion)
  if (comparison === undefined || comparison < 0 || comparison === 0 && !alreadyCurrent) {
    fail('自升级目标 CLI 版本不能证明包含当前冻结 owner 更新协议；未继续升级 Home')
  }
}

function execute(ports: ProgramUpdatePorts, command: string, args: readonly string[], cwd?: string, capture = true): string {
  const result = ports.run(command, args, cwd, capture)
  if (result.status !== 0) fail(`${command} ${args[0] ?? ''} 退出码 ${result.status ?? 'signal'}`)
  return result.stdout.trim()
}

/** Source branch update is distinct from a published npm release. */
async function pendingInstaller(owner: FrozenOwner): Promise<string | undefined> {
  const transaction = `${owner.home}.dsh-enhanced-transaction`
  const entry = await lstat(transaction).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (entry === undefined) return undefined
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || (entry.mode & 0o077)) fail('待恢复事务目录不安全')
  const manifest = await privateJson(join(transaction, 'manifest.json'), 16_777_216)
  const migration = manifest.hostMigration as Record<string, unknown> | undefined
  const source = migration?.localSource as Record<string, unknown> | undefined
  const ownerUpdate = source?.ownerUpdate as Record<string, unknown> | undefined
  const installer = ownerUpdate?.installer as Record<string, unknown> | undefined
  const root = installer?.root
  if (manifest.version !== 4 || manifest.homePath !== owner.home || manifest.profile !== owner.profile
    || manifest.transactionPath !== transaction || source?.protocol !== 'dsh-enhanced/host-owner-program-update/v1'
    || typeof root !== 'string' || root !== owner.repository) {
    fail('待恢复事务未绑定现有 owner 源码与 profile；未更新源码')
  }
  await ownedDirectory(root)
  return root
}

export async function runFrozenOwnerUpdate(owner: FrozenOwner, options: { dryRun: boolean; dshVersion?: string }, ports: ProgramUpdatePorts = defaultPorts): Promise<number> {
  const repo = owner.repository
  const recoveryRoot = await pendingInstaller(owner)
  if (recoveryRoot !== undefined) {
    process.stdout.write(`检测到待恢复的 owner 升级事务；先使用原 installer ${recoveryRoot} 恢复，本次不拉取源码。\n`)
    if (options.dryRun) {
      process.stdout.write('【dry-run】计划仅执行原 installer 的 upgrade-program.mjs --recover；未修改源码或 Home。\n')
      return 0
    }
    execute(ports, process.execPath, [join(recoveryRoot, 'scripts', 'install', 'upgrade-program.mjs'),
      '--dsh-home', owner.home, '--profile', owner.profile, '--recover'], undefined, false)
    return 0
  }
  const origin = execute(ports, 'git', ['remote', 'get-url', 'origin'], repo)
  if (!/^(?:https:\/\/github\.com\/22-ai-00\/dsh-enhanced(?:\.git)?|git@github\.com:22-ai-00\/dsh-enhanced(?:\.git)?)$/u.test(origin)) {
    fail('已绑定源码仓库 origin 不是官方 GitHub 地址')
  }
  const branch = execute(ports, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repo)
  if (branch !== 'dev' && branch !== 'main') fail('源码仓库当前分支必须是 dev 或 main')
  if (execute(ports, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], repo) !== '') fail('源码仓库工作树不干净')
  const root = execute(ports, 'git', ['rev-parse', '--show-toplevel'], repo)
  if (root !== repo) fail('源码仓库根目录与绑定路径不一致')
  process.stdout.write(`冻结 owner：沿已绑定源码仓库 ${repo} 的 ${branch} 分支升级；该源码提交可能尚未发布到 npm。\n`)
  if (options.dryRun) {
    process.stdout.write(`【dry-run】计划：git fetch origin ${branch}；git merge --ff-only FETCH_HEAD；pnpm install --frozen-lockfile；pnpm build；upgrade-program.mjs --dsh-home ${owner.home} --profile ${owner.profile} --dsh-version ${options.dshVersion ?? 'latest'} --dry-run。未更新源码或 Home。\n`)
    return 0
  }
  execute(ports, 'git', ['fetch', 'origin', branch], repo, false)
  execute(ports, 'git', ['merge', '--ff-only', 'FETCH_HEAD'], repo, false)
  execute(ports, 'pnpm', ['install', '--frozen-lockfile'], repo, false)
  execute(ports, 'pnpm', ['build'], repo, false)
  const script = join(ports.scriptRoot ?? repo, 'scripts', 'install', 'upgrade-program.mjs')
  execute(ports, process.execPath, [script, '--dsh-home', owner.home, '--profile', owner.profile,
    '--dsh-version', options.dshVersion ?? 'latest'], undefined, false)
  return 0
}
