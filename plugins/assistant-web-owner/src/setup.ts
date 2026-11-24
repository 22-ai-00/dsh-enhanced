import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { preflightAutonomyProfile, prepareAutonomyProfile, validateAutonomyOptions, type AutonomySetupOptions, type AutonomyResolvedOptions } from './autonomy.js'
import {
  canonicalPath,
  dumpEffectiveProfile,
  findExactRow,
  globalDshDatabasePath,
  mergeConfigMaps,
  publishedDatabaseDefault,
  sqliteStateExists,
  withinDshHome,
} from './host-dsh.js'
import { ensurePrincipalLocally } from '@dsh-enhanced/assistant-delivery'
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

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
function map(value: unknown, label: string): YAMLMap {
  if (!isMap(value)) fail(`${label} must be a mapping`)
  return value
}
function scopeConfigDatabasePath(options: {
  config: YAMLMap
  explicitConfig: YAMLMap | undefined
  pathKeys: readonly string[]
  fallback: string
  publishedDefault: string
  label: string
  companion?: boolean
  createIfMissing: boolean
  input: WebOwnerSetupInput
  document: Document
}): boolean {
  const { config, explicitConfig, pathKeys, fallback, publishedDefault, label, companion = false, createIfMissing, input, document } = options
  const current = config.getIn(pathKeys, true)
  const explicit = explicitConfig !== undefined && explicitConfig.hasIn(pathKeys)
  let modified = false
  const inheritedDefault = !explicit && ((current === undefined && createIfMissing) || publishedDatabaseDefault(current, publishedDefault))
  if (inheritedDefault) {
    if (current !== undefined
      && sqliteStateExists(publishedDefault, companion, fail)
      && canonicalPath(publishedDefault, label, fail) !== canonicalPath(fallback, label, fail)) {
      fail(`${label} published default contains existing state; perform an offline migration to ${fallback} before setup`)
    }
    config.setIn(pathKeys, document.createNode(fallback))
    modified = true
  }
  const updated = config.getIn(pathKeys, true)
  if (updated !== undefined) {
    withinDshHome(literalPath(updated, input, label), input.dshHome, label, fail)
  }
  return modified
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
  const explicitConfigs = new Map<typeof slugs[number], YAMLMap | undefined>()
  for (const slug of slugs) {
    const inherited = findExactRow(effective.rows, slug, { required: true }, fail)!
    const existing = findExactRow(target.rows, slug, { required: false }, fail)
    const existingConfig = existing?.has('config') ? map(existing.get('config', true), slug) : undefined
    explicitConfigs.set(slug, existingConfig)
    const base = inherited.has('config') ? map(inherited.get('config', true), slug) : target.document.createNode({}) as YAMLMap
    const config = existingConfig !== undefined ? mergeConfigMaps(base, existingConfig, fail) : map(base.clone(), slug)
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
  withinDshHome(databasePath, input.dshHome, 'Delivery databasePath', fail)
  withinDshHome(literalPath(delivery.get('spoolPath', true), input, 'Delivery spoolPath'), input.dshHome, 'Delivery spoolPath', fail)
  // YAMLMap.set(string) mutates an existing scalar and retains its !!js tag.
  // A selected literal must replace that node, or Loader evaluates /path as JS.
  delivery.set('defaultWorkspace', target.document.createNode(input.workspace))
  delivery.set('defaultAgentPreset', target.document.createNode(input.preset))
  const goals = configs.get('assistant-goals')!
  scopeConfigDatabasePath({
    config: goals,
    explicitConfig: explicitConfigs.get('assistant-goals'),
    pathKeys: ['databasePath'],
    fallback: join(input.dshHome, 'assistant-goals', `${input.profile}.sqlite`),
    publishedDefault: globalDshDatabasePath('assistant-goals'),
    label: 'Goals databasePath',
    createIfMissing: true,
    input,
    document: target.document,
  })
  const personal = configs.get('personal-assistant')!
  for (const sibling of ['personalMemory', 'personalWiki', 'assistantAutomations']) map(personal.get(sibling, true), sibling)
  const policy = map(personal.get('assistantPolicy', true), 'assistantPolicy')
  withinDshHome(literalPath(policy.get('databasePath', true), input, 'Policy databasePath'), input.dshHome, 'Policy databasePath', fail)
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
  const optionalStateRows = [
    { slug: 'assistant-proactive', pathKeys: ['databasePath'], label: 'Proactive databasePath', subdir: 'assistant-proactive', filename: `${input.profile}.sqlite`, companion: true, createIfMissing: true, publishedSlug: 'assistant-proactive' },
    { slug: 'assistant-dreaming', pathKeys: ['databasePath'], label: 'Dreaming databasePath', subdir: 'assistant-dreaming', filename: `${input.profile}.sqlite`, companion: false, createIfMissing: true, publishedSlug: 'assistant-dreaming' },
    { slug: 'assistant-memory-learning', pathKeys: ['databasePath'], label: 'Memory learning databasePath', subdir: 'assistant-memory-learning', filename: `${input.profile}.sqlite`, companion: false, createIfMissing: true, publishedSlug: 'assistant-memory-learning' },
    { slug: 'assistant-association', pathKeys: ['databasePath'], label: 'Association databasePath', subdir: 'assistant-association', filename: `${input.profile}.sqlite`, companion: false, createIfMissing: true, publishedSlug: 'assistant-association' },
    { slug: 'assistant-work-items', pathKeys: ['databasePath'], label: 'Work-items databasePath', subdir: 'assistant-work-items', filename: `${input.profile}.sqlite`, companion: false, createIfMissing: true, publishedSlug: 'assistant-work-items' },
    { slug: 'assistant-growth-driver', pathKeys: ['usageLearning', 'databasePath'], label: 'Growth usage databasePath', subdir: 'assistant-growth-driver', filename: `${input.profile}-usage.sqlite`, companion: false, createIfMissing: false, publishedSlug: 'assistant-growth-driver' },
  ] as const
  for (const spec of optionalStateRows) {
    const inherited = findExactRow(effective.rows, spec.slug, { required: false, allowDisabled: true }, fail)
    if (inherited === undefined) continue
    const existing = findExactRow(target.rows, spec.slug, { required: false, allowDisabled: true }, fail)
    const existingConfig = existing?.has('config') ? map(existing.get('config', true), spec.slug) : undefined
    const base = inherited.has('config') ? map(inherited.get('config', true), spec.slug) : target.document.createNode({}) as YAMLMap
    const config = existingConfig !== undefined ? mergeConfigMaps(base, existingConfig, fail) : map(base.clone(), spec.slug)
    const createMissing = spec.slug === 'assistant-growth-driver'
      ? spec.createIfMissing || config.getIn(['usageLearning', 'enabled']) === true
      : spec.createIfMissing
    const modified = scopeConfigDatabasePath({
      config,
      explicitConfig: existingConfig,
      pathKeys: spec.pathKeys,
      fallback: join(input.dshHome, spec.subdir, spec.filename),
      publishedDefault: globalDshDatabasePath(spec.publishedSlug),
      label: spec.label,
      companion: spec.companion,
      createIfMissing: createMissing,
      input,
      document: target.document,
    })
    if (spec.slug === 'assistant-work-items' && config.has('workRoot')) {
      withinDshHome(literalPath(config.get('workRoot', true), input, 'Work-items workRoot'), input.dshHome, 'Work-items workRoot', fail)
    }
    if (existing !== undefined || modified) {
      const destination = existing ?? target.document.createNode({ id: `dsh-enhanced-${spec.slug}`, name: `@dsh-enhanced/${spec.slug}` }) as YAMLMap
      destination.set('config', config)
      if (existing === undefined) target.rows.add(destination)
    }
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
    let resolvedIsolation: AutonomyResolvedOptions | undefined
    if (input.isolation) {
      const preflight = preflightAutonomyProfile({ ...input, isolation: input.isolation }, plan.patch, effectiveSource)
      const resources = await import('@dsh-enhanced/assistant-isolation/native-resources')
      const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
      if (typeof metadata.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(metadata.version)) fail('invalid installed package version')
      const selected = input.isolation.source ?? { kind: 'official-tag' as const }
      const source = await resources.freezeLinuxRuntimeSource({ ...selected, version: metadata.version })
      const preparation = { dshHome: input.dshHome, profile: input.profile, source }
      const parsed = parse(preflight, 'autonomy preflight')
      const isolationRow = parsed.rows.items.find(item => isMap(item) && item.get('id') === 'dsh-enhanced-assistant-isolation') as YAMLMap
      const hasExisting = map(isolationRow.get('config', true), 'Isolation config').has('linux')
      if (!hasExisting) await resources.prepareLinuxRuntime(preparation)
      const prepared = await resources.readLinuxRuntime(preparation)
      const cgroupRoots = await resources.discoverLinuxCgroupRoots()
      resolvedIsolation = { backend: 'linux-native', linux: { runtime: prepared.runtime, cgroupRoots },
        maxRuns: input.isolation.maxRuns, leaseMs: input.isolation.leaseMs, maxTotalDurationMs: input.isolation.maxTotalDurationMs }
      // Reject descriptor/source/root drift before any owner pairing or grant write.
      const complete = prepareAutonomyProfile({ ...input, isolation: resolvedIsolation }, plan.patch, effectiveSource)
      await resources.probeLinuxIsolationRuntime(resolvedIsolation.linux)
      // Re-read the immutable receipt after the disposable probe.
      if (!isDeepStrictEqual((await resources.readLinuxRuntime(preparation)).runtime, prepared.runtime)) fail('Linux runtime changed during setup probe')
      plan.patch = complete
    }
    const owner = ensurePrincipalLocally({ databasePath: plan.databasePath, principal: plan.principal })
    if (resolvedIsolation) plan.patch = prepareAutonomyProfile({ ...input, isolation: resolvedIsolation }, plan.patch, effectiveSource, owner)
    if (plan.patch === before) return path
    await writeFile(temporary, plan.patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    if (await readPatch(path) !== before) fail('profile changed during setup; retry with its latest configuration')
    await rename(temporary, path)
    return path
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }) }
}

import type {
  AutonomyBudgetTier,
  AutonomyReasoningEffort,
  DreamingMode,
  WebOwnerAutonomySetupInput,
} from './autonomy-grants.js'

export async function runWebOwnerSetup(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: dsh-web-owner-setup --profile <name> --workspace <absolute-path> [--preset standard] [--dsh-home <absolute-path>] [--isolation-backend linux-native] [--isolation-source-repository <absolute-committed-repository>] [--isolation-max-runs 20 --isolation-lease-ms 3600000 --isolation-runtime-ms 600000]\nAutonomy setup: [--autonomy-setup] [--enable-memory-learning|--disable-memory-learning] [--enable-dreaming|--pause-dreaming|--retire-dreaming|--disable-dreaming] [--enable-growth|--disable-growth] [--work-item-experiences|--no-work-item-experiences] [--usage-learning] [--model-provider <provider> --model-id <model> [--reasoning-effort <level>]] [--budget-tier <conservative|balanced>] [--daily-budget <n>] [--max-extractions <n>] [--lease-days <1..365>] [--session-id <id>] [--dry-run] [--json]\nGoal setup: use --list-goal-sessions to show real idle owner Sessions, or --goal-admission <private-absolute-task.json> [--session-id <existing-idle-session>]. Without --session-id, setup selects the sole matching idle Session and otherwise prints candidates.\nRepair setup: --repair-admission <private-absolute-json> installs preconfigured finite repair profiles after checking the current owner scope, owner route, Goals execution budget, exact model routes, Skills holdouts and Verifier profiles. It creates no Goal, Session, credential, grant, or unlimited authority.\nIsolation is linux-native only; Docker isolation was removed. Initializes one local Web owner without replacing existing owner authority. Stop the target Host before setup; configuration changes require restart.\n')
    return
  }
  const input: WebOwnerSetupInput = { dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'), profile: 'web', workspace: '', preset: 'standard' }
  const limits = { maxRuns: 20, leaseMs: 3_600_000, maxTotalDurationMs: 600_000 }
  let isolationBackend: string | undefined; let isolationRepository: string | undefined
  let isolated = false
  let goalAdmission: string | undefined; let repairAdmission: string | undefined; let sessionId: string | undefined; let listGoalSessions = false
  let explicitAutonomyFlag = false
  let autonomyJson = false
  let autonomyDryRun = false
  let autonomyMemoryLearning: boolean | undefined
  let autonomyDreaming: DreamingMode | undefined
  let autonomyGrowth: boolean | undefined
  let autonomyUsageLearning: boolean | undefined
  let autonomyWorkItemExperiences: boolean | undefined
  let autonomyModelProvider: string | undefined
  let autonomyModelId: string | undefined
  let autonomyReasoningEffort: AutonomyReasoningEffort | undefined
  let autonomyBudgetTier: AutonomyBudgetTier | undefined
  let autonomyDailyBudget: number | undefined
  let autonomyMaxExtractions: number | undefined
  let autonomyLeaseDays: number | undefined

  const numeric = { '--isolation-max-runs': 'maxRuns', '--isolation-lease-ms': 'leaseMs', '--isolation-runtime-ms': 'maxTotalDurationMs' } as const
  const fields = { '--dsh-home': 'dshHome', '--profile': 'profile', '--workspace': 'workspace', '--preset': 'preset' } as const
  const autonomyValueFlags = new Set(['--model-provider', '--model-id', '--reasoning-effort', '--budget-tier', '--daily-budget', '--max-extractions', '--lease-days'])
  const jsonRequestedEarly = argv.includes('--json')
  function failSetup(message: string, code = 1): never {
    if (jsonRequestedEarly) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
      process.exitCode = code
    }
    fail(message)
  }

  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!
    if (option === '--list-goal-sessions') { listGoalSessions = true; continue }
    if (option === '--autonomy-setup') { explicitAutonomyFlag = true; continue }
    if (option === '--json') { autonomyJson = true; explicitAutonomyFlag = true; continue }
    if (option === '--dry-run') { autonomyDryRun = true; explicitAutonomyFlag = true; continue }
    if (option === '--enable-memory-learning') {
      if (autonomyMemoryLearning === false) failSetup('cannot combine --enable-memory-learning and --disable-memory-learning', 2)
      autonomyMemoryLearning = true; explicitAutonomyFlag = true; continue
    }
    if (option === '--disable-memory-learning') {
      if (autonomyMemoryLearning === true) failSetup('cannot combine --enable-memory-learning and --disable-memory-learning', 2)
      autonomyMemoryLearning = false; explicitAutonomyFlag = true; continue
    }
    if (option === '--enable-dreaming') {
      if (autonomyDreaming && autonomyDreaming !== 'enabled') failSetup('conflicting dreaming mode flags', 2)
      autonomyDreaming = 'enabled'; explicitAutonomyFlag = true; continue
    }
    if (option === '--pause-dreaming' || option === '--retire-dreaming') {
      if (autonomyDreaming && autonomyDreaming !== 'paused') failSetup('conflicting dreaming mode flags', 2)
      autonomyDreaming = 'paused'; explicitAutonomyFlag = true; continue
    }
    if (option === '--disable-dreaming') {
      if (autonomyDreaming && autonomyDreaming !== 'disabled') failSetup('conflicting dreaming mode flags', 2)
      autonomyDreaming = 'disabled'; explicitAutonomyFlag = true; continue
    }
    if (option === '--enable-growth') {
      if (autonomyGrowth === false) failSetup('cannot combine --enable-growth and --disable-growth', 2)
      autonomyGrowth = true; explicitAutonomyFlag = true; continue
    }
    if (option === '--disable-growth') {
      if (autonomyGrowth === true) failSetup('cannot combine --enable-growth and --disable-growth', 2)
      autonomyGrowth = false; explicitAutonomyFlag = true; continue
    }
    if (option === '--usage-learning') { autonomyUsageLearning = true; explicitAutonomyFlag = true; continue }
    if (option === '--work-item-experiences') {
      if (autonomyWorkItemExperiences === false) failSetup('cannot combine --work-item-experiences and --no-work-item-experiences', 2)
      autonomyWorkItemExperiences = true; explicitAutonomyFlag = true; continue
    }
    if (option === '--no-work-item-experiences') {
      if (autonomyWorkItemExperiences === true) failSetup('cannot combine --work-item-experiences and --no-work-item-experiences', 2)
      autonomyWorkItemExperiences = false; explicitAutonomyFlag = true; continue
    }
    if (!(option in fields) && !['--isolation-backend', '--isolation-source-repository', '--goal-admission', '--repair-admission', '--session-id'].includes(option) && !(option in numeric) && !autonomyValueFlags.has(option)) {
      failSetup(`unknown option ${option}`, 2)
    }
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) failSetup(`${option} requires a value`, 2)
    if (option === '--goal-admission') goalAdmission = value
    else if (option === '--repair-admission') repairAdmission = value
    else if (option === '--session-id') sessionId = value
    else if (option === '--model-provider') { autonomyModelProvider = value; explicitAutonomyFlag = true }
    else if (option === '--model-id') { autonomyModelId = value; explicitAutonomyFlag = true }
    else if (option === '--reasoning-effort') {
      if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) failSetup(`invalid --reasoning-effort '${value}'`, 2)
      autonomyReasoningEffort = value as AutonomyReasoningEffort; explicitAutonomyFlag = true
    }
    else if (option === '--budget-tier') {
      if (value !== 'conservative' && value !== 'balanced') failSetup(`--budget-tier must be conservative or balanced`, 2)
      autonomyBudgetTier = value; explicitAutonomyFlag = true
    }
    else if (option === '--daily-budget') {
      if (!/^[1-9][0-9]*$/.test(value)) failSetup('--daily-budget requires a positive integer', 2)
      autonomyDailyBudget = Number(value); explicitAutonomyFlag = true
    }
    else if (option === '--max-extractions') {
      if (!/^[1-9][0-9]*$/.test(value)) failSetup('--max-extractions requires a positive integer', 2)
      autonomyMaxExtractions = Number(value); explicitAutonomyFlag = true
    }
    else if (option === '--lease-days') {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 365) failSetup('--lease-days requires an integer between 1 and 365', 2)
      autonomyLeaseDays = Number(value); explicitAutonomyFlag = true
    }
    else if (option === '--isolation-backend') { isolationBackend = value; isolated = true }
    else if (option === '--isolation-source-repository') { isolationRepository = value; isolated = true }
    else if (option in numeric) {
      if (!/^[1-9][0-9]*$/.test(value)) failSetup(`${option} requires a positive integer`, 2)
      limits[numeric[option as keyof typeof numeric]] = Number(value); isolated = true
    } else input[fields[option as keyof typeof fields]] = value
  }
  if (isolated) {
    // Docker isolation was removed; isolated setup is linux-native only. An
    // explicit backend other than linux-native fails rather than silently
    // selecting a different execution boundary.
    const backend = isolationBackend ?? 'linux-native'
    if (backend !== 'linux-native') failSetup('invalid isolation backend; Docker isolation was removed', 2)
    input.isolation = { ...limits, backend: 'linux-native', ...(isolationRepository === undefined ? {} : { source: { kind: 'local-head' as const, repository: isolationRepository } }) }
  }
  const autonomyMode = explicitAutonomyFlag
  if (autonomyMode && (listGoalSessions || goalAdmission !== undefined || repairAdmission !== undefined)) {
    failSetup('--autonomy-setup cannot be combined with goal admission, repair admission, or --list-goal-sessions', 2)
  }
  if (autonomyMode) {
    if (!key.test(input.profile) || !/^[a-z0-9][a-z0-9-]*$/u.test(input.preset)) failSetup('invalid profile or preset', 2)
    if (!isAbsolute(input.dshHome) || input.dshHome.includes('\0') || input.dshHome.includes('*')) failSetup('home must be a literal absolute path', 2)
    if (input.workspace !== '') validate(input)
    else if (input.isolation) failSetup('--isolated requires --workspace', 2)
  } else {
    validate(input)
  }
  if (listGoalSessions && (goalAdmission !== undefined || repairAdmission !== undefined || sessionId !== undefined || isolated)) fail('--list-goal-sessions cannot be combined with setup, goal admission, repair admission, or isolation options')
  if (sessionId !== undefined && goalAdmission === undefined && !autonomyMode) fail('--session-id requires --goal-admission')
  if (repairAdmission !== undefined && (goalAdmission !== undefined || sessionId !== undefined || isolated)) fail('--repair-admission cannot be combined with goal admission, session selection, or isolation options')
  const readEffectiveSource = () => dumpEffectiveProfile(
    input.dshHome,
    input.profile,
    fail,
    'could not read the effective DSH profile; check installed bundles and dsh --dump-config',
  )
  if (autonomyMode) {
    try {
      let basePath: string | undefined
      if (input.workspace !== '') {
        if (autonomyDryRun) failSetup('--dry-run cannot be combined with --workspace initial setup', 2)
        const effective = await readEffectiveSource()
        basePath = await configureWebOwner(input, effective)
      }
      const autonomyInput: WebOwnerAutonomySetupInput = {
        dshHome: input.dshHome,
        profile: input.profile,
        ...(input.workspace !== '' ? { workspace: input.workspace, preset: input.preset } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(autonomyMemoryLearning !== undefined ? { memoryLearning: autonomyMemoryLearning } : {}),
        ...(autonomyDreaming !== undefined ? { dreaming: autonomyDreaming } : {}),
        ...(autonomyGrowth !== undefined ? { growth: autonomyGrowth } : {}),
        ...(autonomyUsageLearning !== undefined ? { usageLearning: autonomyUsageLearning } : {}),
        ...(autonomyWorkItemExperiences !== undefined ? { workItemExperiences: autonomyWorkItemExperiences } : {}),
        ...(autonomyModelProvider !== undefined ? { modelProvider: autonomyModelProvider } : {}),
        ...(autonomyModelId !== undefined ? { modelId: autonomyModelId } : {}),
        ...(autonomyReasoningEffort !== undefined ? { reasoningEffort: autonomyReasoningEffort } : {}),
        ...(autonomyBudgetTier !== undefined ? { budgetTier: autonomyBudgetTier } : {}),
        ...(autonomyDailyBudget !== undefined ? { dailyBudget: autonomyDailyBudget } : {}),
        ...(autonomyMaxExtractions !== undefined ? { memoryMaxExtractions: autonomyMaxExtractions } : {}),
        ...(autonomyLeaseDays !== undefined ? { leaseDays: autonomyLeaseDays } : {}),
        dryRun: autonomyDryRun,
      }
      const { applyWebOwnerAutonomySetup } = await import('./autonomy-grants.js')
      const result = await applyWebOwnerAutonomySetup(autonomyInput, {
        readEffectiveSource: (home, prof) => dumpEffectiveProfile(
          home,
          prof,
          (msg) => { throw new Error(`assistant-web-owner setup: ${msg}`) },
          'could not read the effective DSH profile; check installed bundles and dsh --dump-config',
        ),
      })
      if (autonomyJson) {
        const jsonPayload = {
          ok: result.ok,
          dshHome: result.dshHome,
          profile: result.profile,
          dryRun: result.dryRun,
          applied: result.applied,
          patchPath: result.patchPath,
          ...(basePath ? { baseSetupPath: basePath } : {}),
          owner: result.owner,
          modelRoute: result.modelRoute,
          budgetTier: result.budgetTier,
          leaseDays: result.leaseDays,
          expiresAt: result.expiresAt,
          enabled: result.enabled,
          policyIds: result.policyIds,
          prerequisites: result.prerequisites,
        }
        process.stdout.write(`${JSON.stringify(jsonPayload)}\n`)
        return
      }
      process.stdout.write(
        `Web owner RSI autonomy ${result.dryRun ? 'previewed (dry-run)' : 'configured'} for ${result.profile}: ${result.patchPath}\n`
        + `Owner route: ${result.owner.authorityId} (${result.owner.principalId}); model: ${result.modelRoute.provider}/${result.modelRoute.model}; tier: ${result.budgetTier}; lease: ${result.leaseDays}d.\n`
        + `Enabled: memoryLearning=${result.enabled.memoryLearning}, dreaming=${result.enabled.dreaming}, growth=${result.enabled.growth}, usageLearning=${result.enabled.usageLearning}, workItemExperiences=${result.enabled.workItemExperiences}.\n`,
      )
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (autonomyJson) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
        process.exitCode = 1
        return
      }
      throw error
    }
  }
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
