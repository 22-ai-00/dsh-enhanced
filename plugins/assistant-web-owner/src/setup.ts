import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { autonomyDockerPath, prepareAutonomyProfile, validateAutonomyOptions, type AutonomySetupOptions } from './autonomy.js'
import { ensurePrincipalLocally } from '@dsh-enhanced/assistant-delivery'
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

export interface WebOwnerSetupInput {
  dshHome: string
  profile: string
  workspace: string
  preset: string
  isolation?: AutonomySetupOptions
}

const key = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const slugs = ['personal-assistant', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner'] as const
function fail(message: string): never { throw new Error(`assistant-web-owner setup: ${message}`) }
function validate(input: WebOwnerSetupInput): void {
  if (input.isolation) validateAutonomyOptions(input.isolation)
  if (!key.test(input.profile) || !/^[a-z0-9][a-z0-9-]*$/u.test(input.preset)) fail('invalid profile or preset')
  for (const value of [input.dshHome, input.workspace]) {
    if (!isAbsolute(value) || value.includes('\0') || value.includes('*')) fail('home and workspace must be literal absolute paths')
  }
}
function parse(source: string, label: string): { document: Document, rows: YAMLSeq } {
  const document = parseDocument(source.trim() === '' ? '[]' : source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  if (document.errors.length > 0 || !isSeq(document.contents)) fail(`${label} must be an unambiguous YAML sequence`)
  return { document, rows: document.contents }
}
function row(rows: YAMLSeq, slug: typeof slugs[number], required: boolean): YAMLMap | undefined {
  const id = `dsh-enhanced-${slug}`
  const name = `@dsh-enhanced/${slug}`
  const matches = rows.items.filter(item => isMap(item) && (item.get('id') === id || item.get('name') === name)) as YAMLMap[]
  if (matches.length > 1) fail(`duplicate or shadowed ${id}`)
  const match = matches[0]
  if (match === undefined) { if (required) fail(`install ${name} before setup`); return undefined }
  if (match.get('id') !== id || (match.has('name') && match.get('name') !== name)
    || (match.has('disabled') && match.get('disabled') !== false)) fail(`invalid or disabled ${id}`)
  return match
}
function map(value: unknown, label: string): YAMLMap {
  if (!isMap(value)) fail(`${label} must be a mapping`)
  return value
}
function merge(base: YAMLMap, overlay: YAMLMap): YAMLMap {
  const result = map(base.clone(), 'cloned config')
  for (const pair of overlay.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') fail('config keys must be strings')
    const inherited = result.get(pair.key.value, true)
    const value = pair.value as Node | null
    result.set(pair.key.value, isMap(inherited) && isMap(value) ? merge(inherited, value) : value?.clone() ?? null)
  }
  return result
}
export function literalPath(node: unknown, input: WebOwnerSetupInput, label: string): string {
  if (!isScalar(node) || typeof node.value !== 'string') fail(`${label} must be an absolute path`)
  let value = node.value
  if (node.tag === 'tag:yaml.org,2002:js') {
    // Recognize only the published path helper. Never evaluate arbitrary YAML JS.
    const match = /^dshHomePath\(['"]([^'"\n]+)['"]\)$/u.exec(value)
    if (match === null || isAbsolute(match[1]!) || match[1]!.split('/').includes('..')) fail(`${label} needs a literal path or dshHomePath`)
    value = join(input.dshHome, match[1]!)
  } else if (node.tag !== undefined && node.tag !== 'tag:yaml.org,2002:str') fail(`${label} has an unsupported tag`)
  if (!isAbsolute(value) || value.includes('\0') || value.includes('*')) fail(`${label} must be a literal absolute path`)
  return normalize(value)
}

/** Materialize complete Cordis config replacements while retaining YAML tags and custom siblings. */
export function prepareWebOwnerProfile(input: WebOwnerSetupInput, source: string, effectiveSource: string): {
  patch: string, databasePath: string, principal: { channel: 'web', account: string, tenant: string, user: string }
} {
  validate(input)
  const target = parse(source, 'profile patch')
  const effective = parse(effectiveSource, 'effective profile')
  const configs = new Map<typeof slugs[number], YAMLMap>()
  for (const slug of slugs) {
    const inherited = row(effective.rows, slug, true)!
    const existing = row(target.rows, slug, false)
    const base = inherited.has('config') ? map(inherited.get('config', true), slug) : target.document.createNode({}) as YAMLMap
    const config = existing?.has('config') ? merge(base, map(existing.get('config', true), slug)) : map(base.clone(), slug)
    const destination = existing ?? target.document.createNode({ id: `dsh-enhanced-${slug}`, name: `@dsh-enhanced/${slug}` }) as YAMLMap
    destination.set('config', config)
    if (existing === undefined) target.rows.add(destination)
    configs.set(slug, config)
  }
  const principal = { channel: 'web' as const, account: input.profile, tenant: 'local', user: 'operator' }
  const owner = configs.get('assistant-web-owner')!
  const identity = { account: principal.account, tenant: principal.tenant, user: principal.user }
  if (owner.has('principal')) {
    const old = map(owner.get('principal', true), 'existing Web identity')
    for (const [field, value] of Object.entries(identity)) if (old.get(field) !== value) fail('existing Web owner identity differs; explicit owner migration is required')
  }
  for (const [field, value] of Object.entries({ workspace: input.workspace, preset: input.preset })) {
    if (owner.has(field) && owner.get(field) !== value) fail(`existing Web ${field} differs; preserve the existing scope or migrate explicitly`)
    owner.set(field, value)
  }
  owner.set('principal', target.document.createNode(identity))
  if (!owner.has('maxExecutionMs')) owner.set('maxExecutionMs', 300_000)
  const delivery = configs.get('assistant-delivery')!
  const databasePath = literalPath(delivery.get('databasePath', true), input, 'Delivery databasePath')
  literalPath(delivery.get('spoolPath', true), input, 'Delivery spoolPath')
  // YAMLMap.set(string) mutates an existing scalar and retains its !!js tag.
  // A selected literal must replace that node, or Loader evaluates /path as JS.
  delivery.set('defaultWorkspace', target.document.createNode(input.workspace))
  delivery.set('defaultAgentPreset', target.document.createNode(input.preset))
  const goals = configs.get('assistant-goals')!
  if (!goals.has('databasePath')) goals.set('databasePath', join(input.dshHome, 'assistant-goals', `${input.profile}.sqlite`))
  else literalPath(goals.get('databasePath', true), input, 'Goals databasePath')
  const personal = configs.get('personal-assistant')!
  for (const sibling of ['personalMemory', 'personalWiki', 'assistantAutomations']) map(personal.get(sibling, true), sibling)
  const policy = map(personal.get('assistantPolicy', true), 'assistantPolicy')
  literalPath(policy.get('databasePath', true), input, 'Policy databasePath')
  let rules: unknown = policy.get('rules', true)
  if (rules === undefined || (isScalar(rules) && rules.value === null)) { rules = target.document.createNode([]); policy.set('rules', rules) }
  if (!isSeq(rules)) fail('Policy rules must be a sequence')
  const principalId = `web/${input.profile}/local/operator`
  const managed = [
    { id: `dsh-enhanced-web-${input.profile}-ingest`, effect: 'allow', subject: { kind: 'external', id: principalId }, actions: ['ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
    { id: `dsh-enhanced-web-${input.profile}-capability`, effect: 'allow', subject: { kind: 'agent', id: input.preset, workspace: input.workspace, principal: principalId }, actions: ['*'], resource: { kind: '*', id: '*' }, context: { initiators: ['external'] } },
  ]
  for (const rule of managed) {
    const matches = rules.items.filter(item => isMap(item) && item.get('id') === rule.id) as YAMLMap[]
    if (matches.length > 1) fail(`duplicate managed rule ${rule.id}`)
    if (matches[0] !== undefined) {
      // Customizations are not silently overwritten, including edited allow/deny rules.
      if (!isDeepStrictEqual(matches[0].toJSON(), rule)) fail(`managed rule ${rule.id} was customized; review it before setup`)
    } else rules.add(target.document.createNode(rule))
  }
  return { patch: target.document.toString({ lineWidth: 0 }), databasePath, principal }
}

async function readPatch(path: string): Promise<string> {
  try {
    if (!(await lstat(path)).isFile()) fail('profile patch must be a regular file, not a symlink')
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Local offline setup. A failed YAML commit may leave a newly paired identity; retry preserves its lineage. */
export async function configureWebOwner(input: WebOwnerSetupInput, effectiveSource: string): Promise<string> {
  validate(input)
  const directory = join(input.dshHome, 'profiles', input.profile)
  if (!(await lstat(directory)).isDirectory()) fail('install the target profile first')
  const lock = join(directory, '.assistant-web-owner-setup.lock')
  try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('another setup holds the profile lock; inspect the previous setup before retrying')
    throw error
  }
  const path = join(directory, 'cordis.patch.yml')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const before = await readPatch(path)
    const plan = prepareWebOwnerProfile(input, before, effectiveSource)
    await mkdir(input.workspace, { recursive: true })
    if (input.isolation) {
      const preflight = prepareAutonomyProfile({ ...input, isolation: input.isolation }, plan.patch, effectiveSource)
      const { probeIsolationRuntime } = await import('@dsh-enhanced/assistant-isolation')
      await probeIsolationRuntime(input.isolation.image, autonomyDockerPath(preflight))
    }
    const owner = ensurePrincipalLocally({ databasePath: plan.databasePath, principal: plan.principal })
    if (input.isolation) plan.patch = prepareAutonomyProfile({ ...input, isolation: input.isolation }, plan.patch, effectiveSource, owner)
    if (plan.patch === before) return path
    await writeFile(temporary, plan.patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    if (await readPatch(path) !== before) fail('profile changed during setup; retry with its latest configuration')
    await rename(temporary, path)
    return path
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }) }
}

export async function runWebOwnerSetup(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: dsh-web-owner-setup --profile <name> --workspace <absolute-path> [--preset standard] [--dsh-home <absolute-path>] [--isolation-image sha256:<id> --isolation-max-runs 20 --isolation-lease-ms 3600000 --isolation-runtime-ms 600000]\nGoal setup: use --list-goal-sessions to show real idle owner Sessions, or --goal-admission <private-absolute-task.json> [--session-id <existing-idle-session>]. Without --session-id, setup selects the sole matching idle Session and otherwise prints candidates.\nRepair setup: --repair-admission <private-absolute-json> installs preconfigured finite repair profiles after checking the current owner scope, owner route, Goals execution budget, exact model routes, Skills holdouts and Verifier profiles. It creates no Goal, Session, credential, grant, or unlimited authority.\nInitializes one local Web owner without replacing existing owner authority. Stop the target Host before setup; configuration changes require restart.\n')
    return
  }
  const input: WebOwnerSetupInput = { dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'), profile: 'web', workspace: '', preset: 'standard' }
  const isolation: AutonomySetupOptions = { image: '', maxRuns: 20, leaseMs: 3_600_000, maxTotalDurationMs: 600_000 }
  let isolated = false
  let goalAdmission: string | undefined; let repairAdmission: string | undefined; let sessionId: string | undefined; let listGoalSessions = false
  const numeric = { '--isolation-max-runs': 'maxRuns', '--isolation-lease-ms': 'leaseMs', '--isolation-runtime-ms': 'maxTotalDurationMs' } as const
  const fields = { '--dsh-home': 'dshHome', '--profile': 'profile', '--workspace': 'workspace', '--preset': 'preset' } as const
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!
    if (option === '--list-goal-sessions') { listGoalSessions = true; continue }
    if (!(option in fields) && !['--isolation-image', '--goal-admission', '--repair-admission', '--session-id'].includes(option) && !(option in numeric)) fail(`unknown option ${option}`)
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) fail(`${option} requires a value`)
    if (option === '--goal-admission') goalAdmission = value
    else if (option === '--repair-admission') repairAdmission = value
    else if (option === '--session-id') sessionId = value
    else if (option === '--isolation-image') { isolation.image = value; isolated = true }
    else if (option in numeric) {
      if (!/^[1-9][0-9]*$/.test(value)) fail(`${option} requires a positive integer`)
      isolation[numeric[option as keyof typeof numeric]] = Number(value); isolated = true
    } else input[fields[option as keyof typeof fields]] = value
  }
  if (isolated) input.isolation = isolation
  validate(input)
  if (listGoalSessions && (goalAdmission !== undefined || repairAdmission !== undefined || sessionId !== undefined || isolated)) fail('--list-goal-sessions cannot be combined with setup, goal admission, repair admission, or isolation options')
  if (sessionId !== undefined && goalAdmission === undefined) fail('--session-id requires --goal-admission')
  if (repairAdmission !== undefined && (goalAdmission !== undefined || sessionId !== undefined || isolated)) fail('--repair-admission cannot be combined with goal admission, session selection, or isolation options')
  const readEffectiveSource = async (): Promise<string> => { try {
    const result = await promisify(execFile)('dsh', ['--profile', input.profile, '--dump-config'], {
      env: { ...process.env, DSH_HOME: input.dshHome }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    })
    return result.stdout
  } catch { fail('could not read the effective DSH profile; check installed bundles and dsh --dump-config') } }
  const effective = await readEffectiveSource()
  if (listGoalSessions) {
    const { listGoalAdmissionSessions } = await import('./goal-setup.js')
    const sessions = await listGoalAdmissionSessions(input, effective)
    process.stdout.write(sessions.length === 0 ? 'No matching idle Web owner Sessions. Open the native Web UI once; this command never creates a Session.\n' : `Idle Web owner Sessions:\n${sessions.map(id => `  ${id}\n`).join('')}`)
    return
  }
  if (goalAdmission !== undefined) {
    const { configureGoalAdmission } = await import('./goal-setup.js')
    const result = await configureGoalAdmission(input, effective, goalAdmission, sessionId, readEffectiveSource)
    if (result.repositoryDelivery) process.stdout.write(`Repository: ${result.repositoryDelivery.repository}; branch: ${result.repositoryDelivery.branch}. Authorized paths: ${result.repositoryDelivery.paths.join(', ')}. Independent acceptance: ${result.repositoryDelivery.acceptance}. Credential availability and remote GitHub access have not been tested.\n`)
    process.stdout.write(`Goal configuration written: ${result.path}\nAdmission: ${result.admissionId}; Session: ${result.sessionId}. Existing authority and budget are preserved. Restart the target Host. v2 uses the already configured exact provider/model route; v1 retains deepseek-goal-metered. Model connectivity and runtime admission have not been tested.\n`)
    return
  }
  if (repairAdmission !== undefined) {
    const { configureRepairAdmission } = await import('./repair-setup.js')
    const result = await configureRepairAdmission(input, effective, repairAdmission, readEffectiveSource)
    process.stdout.write(`Repair configuration written: ${result.path}\nProfile: ${result.id}. Existing authority and budgets were not expanded. Restart the target Host. Configuration completion is not real repair acceptance, canary success, or autonomous-improvement evidence.\n`)
    return
  }
  const path = await configureWebOwner(input, effective)
  if (input.isolation) process.stdout.write(`Isolated execution probe passed. Finite grant: autonomy-${input.profile}. Existing grant expiry and used budget are preserved. GitHub action credentials and autonomous goal verification are not configured by this step.\n`)
  process.stdout.write(`Web owner configured for ${input.profile}: ${path}\nWorkspace: ${input.workspace}; preset: ${input.preset}. Model connectivity and runtime readiness require the installer checks.\n`)
}
