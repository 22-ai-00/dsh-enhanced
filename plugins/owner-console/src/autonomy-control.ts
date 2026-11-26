import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isMap, isScalar, isSeq, type YAMLMap, type YAMLSeq } from 'yaml'
import {
  atomicWritePatchWithBackup, ensureConfigMap, findPatchRow, readConfigMap, readPatchDocument,
  resolveProfilePaths, type AutonomyHostContext,
} from './autonomy-setup.js'
import {
  applyDoctorRepair, inspectProfileRestartSupport, inspectSetupDoctor, triggerProfileRestart,
} from './doctor-repair.js'
import type { OwnerSelfIterationAction } from './nl-control.js'
import { CodingToolProber } from './probes.js'
import {
  hasControlChars, isSingleLineCommand,
  type PluginManagerService, type SettingsDescriptor, type SettingsService,
} from './settings.js'
import type { OwnerConsoleStatus, OwnerConsoleWriteResult, SetupDoctorReport } from './typert.js'
import {
  buildUpgradeProbeEnv, detectFrozenSystemdProfile, readBoundHostMetadata,
} from './upgrade-probe.js'

const PROFILE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const UPGRADE_CLI_TIMEOUT_MS = 120_000

export const SELF_ITERATION_TOGGLE_ROWS = [
  { rowId: 'dsh-ray-assistant-work-items', pkgName: '@dsh-ray/assistant-work-items' },
  { rowId: 'dsh-ray-assistant-proactive', pkgName: '@dsh-ray/assistant-proactive' },
  { rowId: 'dsh-ray-assistant-growth-driver', pkgName: '@dsh-ray/assistant-growth-driver' },
  { rowId: 'dsh-ray-assistant-dreaming', pkgName: '@dsh-ray/assistant-dreaming' },
  { rowId: 'dsh-ray-assistant-memory-learning', pkgName: '@dsh-ray/assistant-memory-learning' },
  { rowId: 'dsh-ray-assistant-association', pkgName: '@dsh-ray/assistant-association' },
  { rowId: 'dsh-ray-assistant-evaluation', pkgName: '@dsh-ray/assistant-evaluation' },
  { rowId: 'dsh-ray-assistant-evolution', pkgName: '@dsh-ray/assistant-evolution' },
  { rowId: 'dsh-ray-preference-learning', pkgName: '@dsh-ray/preference-learning' },
] as const

export const PROTECTED_ROW_IDS = new Set([
  'dsh-ray-assistant-web-owner',
  'dsh-ray-owner-console',
  'dsh-ray-lark-channel',
  'dsh-ray-assistant-delivery',
  'dsh-ray-personal-assistant',
  'dsh-ray-assistant-policy',
  'dsh-ray-assistant-goals',
])

export const PROTECTED_PACKAGE_NAMES = new Set([
  '@dsh-ray/assistant-web-owner',
  '@dsh-ray/owner-console',
  '@dsh-ray/lark-channel',
  '@dsh-ray/assistant-delivery',
  '@dsh-ray/personal-assistant',
  '@dsh-ray/assistant-policy',
  '@dsh-ray/assistant-goals',
])

const DREAMING_REQUIRED_STRING_FIELDS = ['provider', 'model', 'budgetId'] as const
const DREAMING_REQUIRED_SCOPE_FIELDS = ['preset', 'principalId', 'ownerRouteId'] as const
const DREAMING_MAX_BUDGET_AMOUNT = 10_000_000

function isYamlJsTag(tag: string | undefined): boolean {
  return tag === '!js' || tag === 'tag:yaml.org,2002:js'
}

function isNonEmptyPlainStringNode(node: unknown): boolean {
  if (isScalar(node)) {
    if (isYamlJsTag(node.tag)) return false
    return typeof node.value === 'string' && node.value.trim().length > 0
  }
  return typeof node === 'string' && node.trim().length > 0
}

function isCanonicalAbsolutePathOrJsNode(node: unknown): boolean {
  if (isScalar(node)) {
    if (isYamlJsTag(node.tag)) {
      return typeof node.value === 'string' && node.value.trim().length > 0
    }
    const val = node.value
    return typeof val === 'string' && val.length >= 1 && isAbsolute(val) && resolve(val) === val
  }
  return typeof node === 'string' && node.length >= 1 && isAbsolute(node) && resolve(node) === node
}

function hasDreamingRequiredFields(config: YAMLMap): boolean {
  const scopeNode = config.get('scope', true)
  if (!isMap(scopeNode)) return false
  if (!isCanonicalAbsolutePathOrJsNode(scopeNode.get('workspace', true))) return false
  for (const subKey of DREAMING_REQUIRED_SCOPE_FIELDS) {
    if (!isNonEmptyPlainStringNode(scopeNode.get(subKey, true))) return false
  }
  if (!isCanonicalAbsolutePathOrJsNode(config.get('databasePath', true))) return false
  for (const field of DREAMING_REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyPlainStringNode(config.get(field, true))) return false
  }
  const budgetNode = config.get('budgetAmount', true)
  const budgetAmount = isScalar(budgetNode)
    ? (isYamlJsTag(budgetNode.tag) ? undefined : budgetNode.value)
    : budgetNode
  return typeof budgetAmount === 'number'
    && Number.isSafeInteger(budgetAmount)
    && budgetAmount >= 1
    && budgetAmount <= DREAMING_MAX_BUDGET_AMOUNT
}

export interface OwnerConsoleControlDeps {
  readonly runUpgrade?: (input: Readonly<{
    dshHome: string
    profile: string
    confirmDshHomeStopped: boolean
  }>) => Promise<Readonly<{ ok: boolean; error?: string; note?: string }>>
  readonly runDoctor?: (host: AutonomyHostContext, status: OwnerConsoleStatus, descriptors: readonly SettingsDescriptor[]) => Promise<SetupDoctorReport>
  readonly repairDoctor?: (input: Readonly<{
    host: AutonomyHostContext
    status: OwnerConsoleStatus
    descriptors: readonly SettingsDescriptor[]
    issueIds: readonly string[]
  }>) => Promise<OwnerConsoleWriteResult>
  readonly restartService?: (host: AutonomyHostContext) => Promise<OwnerConsoleWriteResult>
}

export interface OwnerConsoleControlRequest {
  readonly dshHome?: string
  readonly profile?: string
  readonly ownerAuthorized: boolean
  readonly action: string
  readonly confirmDshHomeStopped?: boolean
  readonly now?: number
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly deps?: OwnerConsoleControlDeps
}

export interface OwnerConsoleControlResult {
  readonly ok: boolean
  readonly action?: OwnerSelfIterationAction
  readonly state?: 'enabled' | 'disabled' | 'upgraded'
  readonly healthy?: boolean
  readonly error?: string
  readonly reason?: string
  readonly note?: string
  readonly patchPath?: string
  readonly affectedRowIds?: readonly string[]
}

function failControl(
  reason: string,
  action?: OwnerSelfIterationAction,
  extra?: Readonly<{ healthy?: boolean }>,
): OwnerConsoleControlResult {
  return Object.freeze({
    ok: false,
    ...(action === undefined ? {} : { action }),
    ...(extra?.healthy === undefined ? {} : { healthy: extra.healthy }),
    error: reason,
    reason,
  })
}

function isValidAction(value: unknown): value is OwnerSelfIterationAction {
  return value === 'enableSelfIteration'
    || value === 'disableSelfIteration'
    || value === 'upgradeAssistantAndRecover'
}

function toHostContext(ctx: unknown): AutonomyHostContext {
  if (ctx !== null && typeof ctx === 'object' && typeof (ctx as { get?: unknown }).get === 'function') {
    return ctx as AutonomyHostContext
  }
  return { get: () => undefined }
}

function validateDirectoryNotSymlink(targetPath: string, label: string): string | null {
  try {
    const st = lstatSync(targetPath)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return `${label} must be a non-symlink directory`
    }
    return null
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    return error instanceof Error ? error.message : String(error)
  }
}

function resolveControlTarget(
  rawHost: AutonomyHostContext,
  request: OwnerConsoleControlRequest,
  env: NodeJS.ProcessEnv,
): Readonly<{ ok: true; canonicalHome: string; profileName: string; profileDir: string; patchPath: string; scopedHost: AutonomyHostContext }>
  | Readonly<{ ok: false; error: string }> {
  const hostPaths = resolveProfilePaths(rawHost, env)
  const rawHome = request.dshHome ?? hostPaths.dshHome
  if (typeof rawHome !== 'string' || rawHome.trim() === '' || hasControlChars(rawHome)) {
    return { ok: false, error: 'DSH_HOME is missing or invalid' }
  }
  if (!isAbsolute(rawHome)) {
    return { ok: false, error: 'DSH_HOME must be an absolute path' }
  }
  const resolvedHome = resolve(rawHome)
  if (!existsSync(resolvedHome)) {
    return { ok: false, error: `DSH_HOME does not exist: ${resolvedHome}` }
  }
  let homeStat: ReturnType<typeof lstatSync>
  try {
    homeStat = lstatSync(resolvedHome)
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    return { ok: false, error: 'DSH_HOME must be a regular directory (not a symlink)' }
  }
  let canonicalHome: string
  try {
    canonicalHome = realpathSync(resolvedHome)
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const hostProfileCtx = rawHost.get('profileContext') as Readonly<{ name?: unknown }> | undefined
  const hostProfileName = typeof hostProfileCtx?.name === 'string' && hostProfileCtx.name.trim() !== ''
    ? hostProfileCtx.name.trim()
    : undefined
  const profileName = request.profile !== undefined
    ? request.profile
    : (hostProfileName ?? 'web')
  if (typeof profileName !== 'string' || !PROFILE_TOKEN.test(profileName)) {
    return { ok: false, error: `invalid profile name: ${String(profileName)}` }
  }

  const profilesRoot = join(canonicalHome, 'profiles')
  const profilesRootErr = validateDirectoryNotSymlink(profilesRoot, 'profiles directory')
  if (profilesRootErr !== null) return { ok: false, error: profilesRootErr }

  const profileDir = join(profilesRoot, profileName)
  const profileDirErr = validateDirectoryNotSymlink(profileDir, `profile directory '${profileName}'`)
  if (profileDirErr !== null) return { ok: false, error: profileDirErr }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    try {
      const patchStat = lstatSync(patchPath)
      if (patchStat.isSymbolicLink() || !patchStat.isFile()) {
        return { ok: false, error: 'cordis.patch.yml must be a regular file (not a symlink)' }
      }
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const scopedHost: AutonomyHostContext = {
    get: (name: string) => {
      if (name === 'profileContext') {
        return {
          home: canonicalHome,
          dir: profileDir,
          name: profileName,
        }
      }
      return rawHost.get(name)
    },
  }
  return { ok: true, canonicalHome, profileName, profileDir, patchPath, scopedHost }
}

function collectMatchingRows(seq: YAMLSeq, rowId: string, pkgName: string): YAMLMap[] {
  const matches: YAMLMap[] = []
  const seen = new Set<YAMLMap>()
  const inspectRow = (candidate: unknown) => {
    if (!isMap(candidate)) return
    const id = candidate.get('id')
    const name = candidate.get('name')
    if (typeof id === 'string' && PROTECTED_ROW_IDS.has(id)) return
    if (typeof name === 'string' && PROTECTED_PACKAGE_NAMES.has(name)) return
    if ((id === rowId || name === pkgName) && !seen.has(candidate)) {
      seen.add(candidate)
      matches.push(candidate)
    }
  }
  for (const item of seq.items) {
    inspectRow(item)
    if (isMap(item)) {
      const inserted = item.get('insert', true)
      if (isSeq(inserted)) {
        for (const sub of inserted.items) inspectRow(sub)
      }
    }
  }
  return matches
}

async function syncPluginManagerBundles(
  host: AutonomyHostContext,
  enable: boolean,
  targetPackages: ReadonlySet<string>,
): Promise<void> {
  const manager = host.get('pluginManager') as PluginManagerService | undefined
  if (manager === undefined || typeof manager.listBundles !== 'function' || typeof manager.setBundleEnabled !== 'function') {
    return
  }
  try {
    const bundles = await manager.listBundles()
    for (const bundle of bundles) {
      if (!bundle.installed) continue
      if (PROTECTED_PACKAGE_NAMES.has(bundle.name)) continue
      if (!targetPackages.has(bundle.name)) continue
      if (bundle.enabled !== enable) {
        await manager.setBundleEnabled(bundle.name, enable)
      }
    }
  } catch {
    // Persisted cordis.patch.yml remains the durable source of truth.
  }
}

async function readStatusForControl(host: AutonomyHostContext): Promise<OwnerConsoleStatus> {
  const existing = host.get('ownerConsole') as { status?: () => Promise<OwnerConsoleStatus> } | undefined
  if (typeof existing?.status === 'function') {
    try {
      return await existing.status()
    } catch {
      // Fall back to direct Host inspection below.
    }
  }
  const settings = host.get('settings') as SettingsService | undefined
  const manager = host.get('pluginManager') as PluginManagerService | undefined
  let bundles: OwnerConsoleStatus['bundles'] = []
  let plugins: OwnerConsoleStatus['plugins'] = []
  let bundlesPhase: 'ok' | 'unavailable' | 'failed' = 'unavailable'
  let pluginsPhase: 'ok' | 'unavailable' | 'failed' = 'unavailable'
  if (manager !== undefined && typeof manager.listBundles === 'function' && typeof manager.listPlugins === 'function') {
    const [bRes, pRes] = await Promise.allSettled([manager.listBundles(), manager.listPlugins()])
    if (bRes.status === 'fulfilled') {
      bundlesPhase = 'ok'
      bundles = bRes.value
        .filter(b => b.name.startsWith('@dsh-ray/') && b.error?.code !== 'not-bundle')
        .map(b => Object.freeze({
          name: b.name,
          ...(b.version === undefined ? {} : { version: b.version }),
          enabled: b.enabled,
          installed: b.installed,
          removable: b.removable,
          ...(b.error === undefined ? {} : {
            error: Object.freeze({
              code: b.error.code ?? 'operation-error',
              ...(b.error.diagnostic === undefined ? {} : { diagnostic: b.error.diagnostic }),
            }),
          }),
          rows: Object.freeze((b.rows ?? []).map(r => Object.freeze({
            rowId: r.rowId,
            moduleName: r.moduleName,
            ...(r.entryId === undefined ? {} : { entryId: r.entryId }),
          }))),
        }))
    } else {
      bundlesPhase = 'failed'
    }
    if (pRes.status === 'fulfilled') {
      pluginsPhase = 'ok'
      plugins = pRes.value
        .filter(p => p.moduleName.startsWith('@dsh-ray/'))
        .map(p => Object.freeze({
          entryId: p.entryId,
          moduleName: p.moduleName,
          enabled: p.enabled,
          fiberPhase: p.fiberPhase,
          ...(p.diagnostic === undefined ? {} : { diagnostic: p.diagnostic }),
        }))
    } else {
      pluginsPhase = 'failed'
    }
  }

  return Object.freeze({
    feishu: Object.freeze({
      mode: 'env' as const,
      installed: bundles.some(b => b.name === '@dsh-ray/lark-channel' && b.installed),
      enabled: bundles.some(b => b.name === '@dsh-ray/lark-channel' && b.enabled),
      appIdConfigured: false,
      connected: false,
      connection: 'absent' as const,
    }),
    traex: Object.freeze({
      installed: bundles.some(b => b.name === '@dsh-ray/traex-acp-provider' && b.installed),
      enabled: false,
      command: '',
    }),
    agy: Object.freeze({
      installed: bundles.some(b => b.name === '@dsh-ray/traex-acp-provider' && b.installed),
      enabled: false,
      command: '',
    }),
    defaultModel: Object.freeze({ available: false, provider: '', model: '' }),
    llmProviders: Object.freeze([]),
    host: Object.freeze({
      settings: settings !== undefined,
      pluginManager: manager !== undefined,
      bundles: bundlesPhase,
      plugins: pluginsPhase,
    }),
    dependencies: Object.freeze(['assistantPolicy', 'assistantDelivery', 'assistantSkills'].map(dep => Object.freeze({
      name: dep,
      available: host.get(dep) !== undefined,
    }))),
    evaluation: Object.freeze({ intakeAgreement: 'absent' as const }),
    bundles: Object.freeze(bundles),
    plugins: Object.freeze(plugins),
  })
}

function discoverDshRayExecutable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = env['HOME']?.trim() || homedir()
  const dirs = platform === 'win32'
    ? (env['APPDATA'] ? [join(env['APPDATA'], 'npm')] : [])
    : [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), join(home, 'Library', 'pnpm'), '/opt/homebrew/bin', '/usr/local/bin']
  const names = platform === 'win32' ? ['dsh-ray.cmd', 'dsh-ray.exe'] : ['dsh-ray']
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        const st = statSync(candidate)
        if (st.isFile() && (platform === 'win32' || (st.mode & 0o111) !== 0)) {
          return candidate
        }
      } catch {
        // Continue probing candidate paths.
      }
    }
  }
  return 'dsh-ray'
}

async function execDshRayUpgrade(
  canonicalHome: string,
  profileName: string,
  confirmDshHomeStopped: boolean,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<Readonly<{ ok: boolean; error?: string; note?: string }>> {
  const safeEnv = buildUpgradeProbeEnv(env, platform, canonicalHome)
  const args = ['upgrade', '--yes', '--json', '--dsh-home', canonicalHome, '--profile', profileName]
  if (confirmDshHomeStopped) args.push('--confirm-dsh-home-stopped')

  const execCommand = (bin: string) => new Promise<{ stdout: string; stderr: string; exitCode: number; errorCode?: string }>(resolveExec => {
    if (!isSingleLineCommand(bin)) {
      resolveExec({ stdout: '', stderr: 'invalid dsh-ray binary path', exitCode: 1, errorCode: 'EINVAL' })
      return
    }
    nodeExecFile(bin, args, { env: safeEnv, timeout: UPGRADE_CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) {
        resolveExec({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 })
        return
      }
      const rec = err as NodeJS.ErrnoException & { code?: unknown; status?: unknown }
      const errorCode = typeof rec.code === 'string' ? rec.code : undefined
      const exitCode = typeof rec.status === 'number' ? rec.status : (typeof rec.code === 'number' ? rec.code : 1)
      resolveExec({
        stdout: stdout ?? '',
        stderr: stderr ?? (err.message || ''),
        exitCode,
        ...(errorCode === undefined ? {} : { errorCode }),
      })
    })
  })

  let result = await execCommand('dsh-ray')
  if (result.errorCode === 'ENOENT' || result.errorCode === 'EACCES') {
    const fallbackBin = discoverDshRayExecutable(env, platform)
    if (fallbackBin !== 'dsh-ray') {
      result = await execCommand(fallbackBin)
    }
  }

  const trimmed = result.stdout.trim()
  const jsonStart = trimmed.indexOf('{')
  let parsed: Record<string, unknown> | undefined
  if (jsonStart >= 0) {
    try {
      const candidate = JSON.parse(trimmed.slice(jsonStart)) as unknown
      if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      parsed = undefined
    }
  }

  if (result.exitCode !== 0 || parsed?.['ok'] === false) {
    const errText = (typeof parsed?.['error'] === 'string' && parsed['error'].trim() !== '')
      ? parsed['error'].trim()
      : (result.stderr.trim() || result.stdout.trim() || `dsh-ray upgrade exited with ${result.exitCode}`)
    return { ok: false, error: errText }
  }
  return { ok: true, note: '已完成宿主与插件升级' }
}

/**
 * Owner-authorized control entry for Web `owner-console`:
 * - Fails closed (zero disk writes) when `ownerAuthorized !== true` or action is unknown.
 * - `enableSelfIteration` / `disableSelfIteration`: toggles the Contract 1 self-iteration rows in
 *   `cordis.patch.yml` while protecting core Web/Lark/Delivery/PA/Policy/Goals rows and `ownerRoutes`.
 * - `upgradeAssistantAndRecover`: respects `frozen-linux-systemd` safety, validates host & patch,
 *   runs upgrade (when bound), doctor inspection/repair, and managed restart/recovery.
 */
export async function handleOwnerConsoleControlAction(
  ctx: unknown,
  request: OwnerConsoleControlRequest,
): Promise<OwnerConsoleControlResult> {
  if (request === null || typeof request !== 'object' || request.ownerAuthorized !== true) {
    return failControl('owner authorization required')
  }
  if (!isValidAction(request.action)) {
    return failControl(`unsupported control action: ${String(request.action)}`)
  }
  const action: OwnerSelfIterationAction = request.action
  const env = request.env ?? process.env
  const platform = request.platform ?? process.platform
  const now = request.now ?? Date.now()
  const rawHost = toHostContext(ctx)

  const target = resolveControlTarget(rawHost, request, env)
  if (!target.ok) {
    return failControl(target.error, action)
  }

  const { canonicalHome, profileName, patchPath, scopedHost } = target

  if (action === 'enableSelfIteration' || action === 'disableSelfIteration') {
    const enable = action === 'enableSelfIteration'
    let doc: ReturnType<typeof readPatchDocument>
    try {
      doc = readPatchDocument(existsSync(patchPath) ? patchPath : null)
    } catch (error: unknown) {
      return failControl(error instanceof Error ? error.message : String(error), action)
    }
    const seq = doc.contents as YAMLSeq
    const affectedRowIds: string[] = []
    const targetPackages = new Set<string>()

    for (const spec of SELF_ITERATION_TOGGLE_ROWS) {
      const rows = collectMatchingRows(seq, spec.rowId, spec.pkgName)
      for (const row of rows) {
        if (enable) {
          row.delete('disabled')
          const cfg = readConfigMap(row, 'config')
          if (cfg !== undefined) {
            if (spec.rowId === 'dsh-ray-assistant-dreaming') {
              if (hasDreamingRequiredFields(cfg)) {
                cfg.set('enabled', true)
              }
              if (cfg.has('retired')) {
                cfg.delete('retired')
              }
            } else if (cfg.get('enabled') === false || spec.rowId === 'dsh-ray-assistant-work-items') {
              cfg.set('enabled', true)
            }
          } else if (spec.rowId === 'dsh-ray-assistant-work-items') {
            const createdCfg = ensureConfigMap(doc, row, 'config')
            createdCfg.set('enabled', true)
          }
        } else {
          row.set('disabled', true)
          const cfg = readConfigMap(row, 'config')
          if (cfg !== undefined && (cfg.has('enabled') || spec.rowId === 'dsh-ray-assistant-work-items')) {
            cfg.set('enabled', false)
          } else if (spec.rowId === 'dsh-ray-assistant-work-items') {
            const createdCfg = ensureConfigMap(doc, row, 'config')
            createdCfg.set('enabled', false)
          }
        }
        affectedRowIds.push(spec.rowId)
        targetPackages.add(spec.pkgName)
      }
    }

    // Fresh/empty profile fixture (e.g. T1-F21-03): materialize primary self-iteration row cleanly.
    if (findPatchRow(seq, 'dsh-ray-assistant-work-items') === undefined && affectedRowIds.length === 0) {
      const created = doc.createNode({
        id: 'dsh-ray-assistant-work-items',
        name: '@dsh-ray/assistant-work-items',
        ...(enable ? {} : { disabled: true }),
        config: { enabled: enable },
      })
      seq.add(created)
      affectedRowIds.push('dsh-ray-assistant-work-items')
      targetPackages.add('@dsh-ray/assistant-work-items')
    }

    try {
      atomicWritePatchWithBackup(patchPath, doc.toString({ lineWidth: 0 }), now)
    } catch (error: unknown) {
      return failControl(error instanceof Error ? error.message : String(error), action)
    }

    await syncPluginManagerBundles(scopedHost, enable, targetPackages)

    return Object.freeze({
      ok: true,
      action,
      state: enable ? 'enabled' : 'disabled',
      patchPath,
      affectedRowIds: Object.freeze([...new Set(affectedRowIds)]),
      note: enable
        ? `已开启 profile '${profileName}' 的整体自迭代能力`
        : `已关闭 profile '${profileName}' 的整体自迭代能力`,
    })
  }

  // action === 'upgradeAssistantAndRecover'
  if (detectFrozenSystemdProfile(canonicalHome, profileName, platform, env)) {
    return failControl(
      'frozen-linux-systemd profile forbids in-process upgrade; run dsh-ray upgrade out-of-band after stopping the service',
      action,
    )
  }

  const bound = readBoundHostMetadata(canonicalHome)
  if (bound.status === 'corrupt' || bound.status === 'unreadable') {
    return failControl(bound.error ?? `host metadata is ${bound.status}`, action)
  }

  if (existsSync(patchPath)) {
    try {
      readPatchDocument(patchPath)
    } catch (error: unknown) {
      return failControl(error instanceof Error ? error.message : String(error), action)
    }
  }

  const notes: string[] = []
  if (request.deps?.runUpgrade !== undefined) {
    const upgRes = await request.deps.runUpgrade({
      dshHome: canonicalHome,
      profile: profileName,
      confirmDshHomeStopped: request.confirmDshHomeStopped === true,
    })
    if (!upgRes.ok) {
      return failControl(upgRes.error ?? 'assistant upgrade failed', action)
    }
    if (upgRes.note) notes.push(upgRes.note)
  } else if (bound.status === 'ready') {
    const upgRes = await execDshRayUpgrade(
      canonicalHome,
      profileName,
      request.confirmDshHomeStopped === true,
      platform,
      env,
    )
    if (!upgRes.ok) {
      return failControl(upgRes.error ?? 'assistant upgrade failed', action)
    }
    if (upgRes.note) notes.push(upgRes.note)
  }

  const settings = scopedHost.get('settings') as SettingsService | undefined
  const descriptors = settings?.describe({ redactSecrets: true }) ?? []
  const status = await readStatusForControl(scopedHost)
  const prober = new CodingToolProber()

  const runDoctorCheck = async (): Promise<SetupDoctorReport> => {
    if (request.deps?.runDoctor !== undefined) {
      return request.deps.runDoctor(scopedHost, status, descriptors)
    }
    return inspectSetupDoctor({
      host: scopedHost,
      status,
      descriptors,
      prober,
      platform,
      env,
      now,
    })
  }

  let doctor = await runDoctorCheck()
  if (doctor.autoFixableCount > 0 && doctor.writable && !doctor.frozenSystemdProfile) {
    const fixIds = doctor.issues.filter(i => i.autoFixable).map(i => i.id)
    const repairResult = request.deps?.repairDoctor !== undefined
      ? await request.deps.repairDoctor({ host: scopedHost, status, descriptors, issueIds: fixIds })
      : await applyDoctorRepair({
          host: scopedHost,
          status,
          descriptors,
          settings,
          manager: scopedHost.get('pluginManager') as PluginManagerService | undefined,
          prober,
          issueIds: fixIds,
          platform,
          env,
          now,
        })
    if (!repairResult.applied) {
      return failControl(repairResult.note, action, { healthy: false })
    }
    notes.push(repairResult.note)
    doctor = await runDoctorCheck()
  }

  if (!doctor.healthy) {
    const firstIssue = doctor.issues[0]?.title ?? 'setup doctor reported unhealthy state'
    return failControl(`恢复后健康检查未通过：${firstIssue}`, action, { healthy: false })
  }

  if (request.deps?.restartService !== undefined) {
    const restartRes = await request.deps.restartService(scopedHost)
    if (!restartRes.applied) {
      return failControl(restartRes.note, action, { healthy: doctor.healthy })
    }
    notes.push(restartRes.note)
  } else {
    const support = inspectProfileRestartSupport({ host: scopedHost, platform, env })
    if (support.supported) {
      const restartRes = await triggerProfileRestart({
        host: scopedHost,
        confirmed: true,
        platform,
        env,
      })
      if (!restartRes.applied) {
        return failControl(restartRes.note, action, { healthy: doctor.healthy })
      }
      notes.push(restartRes.note)
    }
  }

  return Object.freeze({
    ok: true,
    action,
    state: 'upgraded',
    healthy: true,
    patchPath,
    note: notes.length > 0
      ? notes.join('；')
      : `已完成 profile '${profileName}' 升级检查与健康恢复`,
  })
}
