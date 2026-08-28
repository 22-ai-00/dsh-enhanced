import { cp, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { candidateDigest, discover, loadCatalogWithFirstPartyFallback, parseCatalog, type CatalogEntry, type CatalogPackage } from './catalog.js'

interface Plan {
  schemaVersion: 1; id: string; status: 'owner-approved' | 'pending-owner-approval'; createdAt: number; expiresAt: number
  profile: string; candidate: CatalogEntry; digest: string; approval?: { principal: string; approvedAt: number }
}

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const planIdPattern = /^plugin-[a-f0-9]{24}$/u
const maxPlanLifetimeMs = 86_400_000

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name)
  const value = index === -1 ? undefined : argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`plugin-control-plane: ${name} is required`)
  return value
}

function optionalOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`plugin-control-plane: ${name} requires a value`)
  return value
}

function defaultCatalogPath(): string {
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  if (!isAbsolute(dshHome)) throw new Error('plugin-control-plane: DSH_HOME must be absolute')
  return join(dshHome, 'plugin-control', 'catalog.json')
}

function exactPackages(candidate: CatalogEntry): CatalogPackage[] {
  return [
    { package: candidate.package, version: candidate.version, integrity: candidate.integrity },
    ...candidate.requires,
  ]
}

function validApproval(value: unknown): value is { principal: string; approvedAt: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const approval = value as { principal?: unknown; approvedAt?: unknown }
  return typeof approval.principal === 'string' && approval.principal.normalize('NFC').trim() !== ''
    && approval.principal.length <= 256 && Number.isSafeInteger(approval.approvedAt)
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function run(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  const outcome = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', maxBuffer: 1_048_576 })
  if (outcome.status !== 0) throw new Error(`plugin-control-plane: ${command} failed: ${(outcome.stderr || outcome.stdout || '').trim().slice(0, 1_000)}`)
  return outcome.stdout
}

async function planFromFile(path: string): Promise<Plan> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('plugin-control-plane: invalid plan')
  const plan = value as Partial<Plan>
  const createdAt = plan.createdAt
  const expiresAt = plan.expiresAt
  if (plan.schemaVersion !== 1 || typeof plan.id !== 'string' || typeof plan.profile !== 'string'
    || typeof plan.digest !== 'string' || typeof createdAt !== 'number' || typeof expiresAt !== 'number'
    || !Number.isSafeInteger(createdAt) || !Number.isSafeInteger(expiresAt)) {
    throw new Error('plugin-control-plane: invalid plan')
  }
  if (!planIdPattern.test(plan.id) || !profilePattern.test(plan.profile)
    || !/^[a-f0-9]{64}$/u.test(plan.digest)
    || expiresAt <= createdAt || expiresAt - createdAt > maxPlanLifetimeMs) {
    throw new Error('plugin-control-plane: invalid plan')
  }
  const candidate = parseCatalog({ schemaVersion: 1, entries: [plan.candidate] }).entries[0]
  if (candidate === undefined || candidateDigest(candidate, plan.profile) !== plan.digest) throw new Error('plugin-control-plane: plan digest mismatch')
  if (Date.now() > expiresAt) throw new Error('plugin-control-plane: plan has expired')
  if (plan.status !== 'pending-owner-approval' && plan.status !== 'owner-approved') throw new Error('plugin-control-plane: invalid plan status')
  if (plan.status === 'owner-approved' && !validApproval(plan.approval)) throw new Error('plugin-control-plane: invalid plan approval')
  return {
    schemaVersion: 1,
    id: plan.id,
    status: plan.status,
    createdAt,
    expiresAt,
    profile: plan.profile,
    candidate,
    digest: plan.digest,
    ...(plan.approval === undefined ? {} : { approval: plan.approval }),
  }
}

async function approve(argv: readonly string[]): Promise<void> {
  const path = resolve(option(argv, '--plan'))
  const principal = option(argv, '--approved-by').normalize('NFC').trim()
  if (principal === '' || principal.length > 256) throw new Error('plugin-control-plane: invalid approving principal')
  const plan = await planFromFile(path)
  if (plan.status !== 'pending-owner-approval') throw new Error('plugin-control-plane: plan is not pending approval')
  const approved: Plan = { ...plan, status: 'owner-approved', approval: { principal, approvedAt: Date.now() } }
  await atomicJsonWrite(path, approved)
  process.stdout.write(`Approved ${approved.id}; activation remains a separate command.\n`)
}

async function activate(argv: readonly string[]): Promise<void> {
  const plan = await planFromFile(resolve(option(argv, '--plan')))
  if (plan.status !== 'owner-approved' || plan.approval === undefined) throw new Error('plugin-control-plane: owner approval is required')
  const dshHome = resolve(option(argv, '--dsh-home'))
  if (!isAbsolute(dshHome) || !profilePattern.test(plan.profile)) throw new Error('plugin-control-plane: invalid DSH home or profile')
  const profilePath = join(dshHome, 'profiles', plan.profile)
  const stageProfile = `stage-${plan.id.slice(-24)}`
  const stagePath = join(dshHome, 'profiles', stageProfile)
  const backupPath = join(dshHome, 'profiles', `.${plan.profile}.plugin-backup-${plan.id.slice(-12)}`)
  await rm(stagePath, { recursive: true, force: true })
  await rm(backupPath, { recursive: true, force: true })
  try {
    try { await stat(profilePath); await cp(profilePath, stagePath, { recursive: true, force: true }) } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const env = { ...process.env, DSH_HOME: dshHome }
    const installedDshVersion = run('dsh', ['--version'], undefined, env).trim()
    if (installedDshVersion !== plan.candidate.dshBaseline) {
      throw new Error(`plugin-control-plane: candidate requires DSH ${plan.candidate.dshBaseline}, found ${installedDshVersion || 'unknown'}`)
    }
    const packages = exactPackages(plan.candidate)
    run('dsh', ['plugin', '--profile', stageProfile, 'add', ...packages.map(item => `${item.package}@${item.version}`)], undefined, env)
    const stagedLock = await readFile(join(stagePath, 'pnpm-lock.yaml'), 'utf8')
    if (packages.some(item => !stagedLock.includes(item.integrity))) {
      throw new Error('plugin-control-plane: staged lockfile integrity does not match the approved catalog')
    }
    run('dsh', ['--profile', stageProfile, '--dump-config'], undefined, env)
    try { await rename(profilePath, backupPath) } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    await rename(stagePath, profilePath)
    try { run('dsh', ['--profile', plan.profile, '--dump-config'], undefined, env) } catch (error) {
      await rm(profilePath, { recursive: true, force: true })
      await rename(backupPath, profilePath)
      throw error
    }
    await rm(backupPath, { recursive: true, force: true })
    process.stdout.write(`Activated ${packages.map(item => `${item.package}@${item.version}`).join(', ')} atomically; restart the resident service with scripts/install/restart.sh ${plan.profile}.\n`)
  } finally {
    await rm(stagePath, { recursive: true, force: true })
  }
}

async function scaffold(argv: readonly string[]): Promise<void> {
  if (!argv.includes('--owner-approved')) throw new Error('plugin-control-plane: scaffold requires --owner-approved')
  const repository = resolve(option(argv, '--repository'))
  const name = option(argv, '--name')
  const worktrees = run('git', ['worktree', 'list', '--porcelain'], repository).split('\n')
    .filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
  if (worktrees.length < 2 || worktrees[0] === repository || !worktrees.includes(repository)) {
    throw new Error('plugin-control-plane: source creation is allowed only in a linked Git worktree, never the primary checkout')
  }
  if (run('git', ['status', '--porcelain'], repository).trim() !== '') throw new Error('plugin-control-plane: worktree must be clean before scaffolding')
  run('pnpm', ['create:plugin', name], repository)
  run('pnpm', 'check'.split(' '), repository)
  process.stdout.write(`Scaffolded ${name} in an isolated clean worktree and completed pnpm check. Submit it for review/PR; it was not activated.\n`)
}

async function verifyWorktree(argv: readonly string[]): Promise<void> {
  if (!argv.includes('--owner-approved')) throw new Error('plugin-control-plane: verify-worktree requires --owner-approved')
  const repository = resolve(option(argv, '--repository'))
  const worktrees = run('git', ['worktree', 'list', '--porcelain'], repository).split('\n')
    .filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
  if (worktrees.length < 2 || worktrees[0] === repository || !worktrees.includes(repository)) {
    throw new Error('plugin-control-plane: plugin modification verification is allowed only in a linked Git worktree')
  }
  run('git', ['diff', '--check'], repository)
  run('pnpm', ['check'], repository)
  process.stdout.write('Isolated worktree passed pnpm check. Review and submit a PR before publishing or activating it.\n')
}

export async function runPluginControl(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0]
  if (command === 'discover') {
    const catalog = await loadCatalogWithFirstPartyFallback(resolve(optionalOption(argv, '--catalog') ?? defaultCatalogPath()))
    process.stdout.write(`${JSON.stringify(discover(catalog, option(argv, '--capability')), null, 2)}\n`)
    return
  }
  if (command === 'approve') return approve(argv)
  if (command === 'activate') return activate(argv)
  if (command === 'scaffold') return scaffold(argv)
  if (command === 'verify-worktree') return verifyWorktree(argv)
  throw new Error('Usage: dsh-plugin-control <discover|approve|activate|scaffold|verify-worktree> ...')
}
