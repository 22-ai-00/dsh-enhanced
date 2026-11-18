import { execFile as nodeExecFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Document, isMap, isSeq, Scalar, YAMLMap, YAMLSeq } from 'yaml'
import {
  boundedConfig, findEntry, hasControlChars, isAppId, isSingleLineCommand,
  type PluginManagerService, type SettingsDescriptor, type SettingsService,
} from './settings.js'
import { type CodingToolId, type CodingToolProber } from './probes.js'
import type {
  OwnerConsoleStatus, OwnerConsoleWriteResult, SetupDoctorIssue, SetupDoctorReport,
} from './typert.js'
import { detectFrozenSystemdProfile } from './upgrade-probe.js'
import {
  asPlainRecord, atomicWritePatchWithBackup, checkScopedDbPath, ensureConfigMap, ensurePatchRow,
  externalPrincipalId, findPatchRow, getPatchRowConfig, getPatchRowConfigNode,
  getPersonalAndPolicyConfigs, inspectOwnerRoute, mergeDescriptorConfig,
  readConfigMap, readPatchDocument, resolveProfilePaths, strOrNull, upsertById,
  type AutonomyHostContext, type ProfilePaths,
} from './autonomy-setup.js'

interface JsDshHomeRef {
  readonly __jsDshHome: string
}

function jsRef(relPath: string): JsDshHomeRef {
  return { __jsDshHome: relPath }
}

function isJsRef(value: unknown): value is JsDshHomeRef {
  return value !== null && typeof value === 'object' && '__jsDshHome' in value && typeof (value as JsDshHomeRef).__jsDshHome === 'string'
}

const SPLIT_PA_PACKAGES = [
  { pkg: '@dsh-enhanced/assistant-policy', rowId: 'dsh-enhanced-assistant-policy', section: 'assistantPolicy' },
  { pkg: '@dsh-enhanced/assistant-automations', rowId: 'dsh-enhanced-assistant-automations', section: 'assistantAutomations' },
  { pkg: '@dsh-enhanced/personal-memory', rowId: 'dsh-enhanced-personal-memory', section: 'personalMemory' },
  { pkg: '@dsh-enhanced/personal-wiki', rowId: 'dsh-enhanced-personal-wiki', section: 'personalWiki' },
] as const

const SCOPED_STATE_BUNDLES = [
  { pkg: '@dsh-enhanced/assistant-goals', rowId: 'dsh-enhanced-assistant-goals', subdir: 'assistant-goals' },
  { pkg: '@dsh-enhanced/assistant-dreaming', rowId: 'dsh-enhanced-assistant-dreaming', subdir: 'assistant-dreaming' },
  { pkg: '@dsh-enhanced/assistant-proactive', rowId: 'dsh-enhanced-assistant-proactive', subdir: 'assistant-proactive' },
  { pkg: '@dsh-enhanced/assistant-work-items', rowId: 'dsh-enhanced-assistant-work-items', subdir: 'assistant-work-items' },
] as const

const PERSONAL_ASSISTANT_DEFAULTS: Readonly<Record<string, unknown>> = {
  assistantPolicy: {
    databasePath: jsRef('assistant-policy/policy.sqlite'),
    rules: [
      {
        id: 'dsh-enhanced-foreground-capability-*',
        effect: 'allow',
        subject: { kind: 'agent', id: '*', workspace: '*' },
        actions: ['*'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground'] },
      },
    ],
    budgets: [],
  },
  personalMemory: {
    databasePath: jsRef('personal-memory/memory.sqlite'),
    approvalMode: 'delivery-required',
    maxContentBytes: 4096,
    maxRecordsPerIdentity: 1000,
    searchLimit: 20,
    snapshotLimit: 20,
    snapshotMaxBytes: 8192,
    snapshotMaxTokens: 2048,
    defaultProposalTtlMs: 900000,
    maxImportRecords: 100,
    reconcileIntervalMs: 15000,
    reconcileLimit: 50,
  },
  personalWiki: {
    vaultRoot: jsRef('personal-wiki/vault'),
    databasePath: jsRef('personal-wiki/state.sqlite'),
    maxPageBytes: 1048576,
    searchLimit: 20,
    maxSnippetBytes: 2048,
    readMaxBytes: 8192,
    readMaxParagraphs: 40,
    lintLimit: 200,
    defaultProposalTtlMs: 900000,
    reconcileIntervalMs: 15000,
    reconcileLimit: 50,
  },
  assistantAutomations: {
    databasePath: jsRef('assistant-automations/state.sqlite'),
    runsPath: jsRef('assistant-automations/runs'),
    schedulerEnabled: false,
    tickIntervalMs: 5000,
    dutyLeaseMs: 15000,
    taskLeaseMs: 30000,
    misfireGraceMs: 60000,
    maxCatchUp: 100,
    maxConcurrency: 1,
    maxArtifactBytes: 1048576,
    defaultProposalTtlMs: 900000,
    reconcileIntervalMs: 15000,
    reconcileLimit: 50,
  },
}

const ASSISTANT_DELIVERY_DEFAULTS: Readonly<Record<string, unknown>> = {
  databasePath: jsRef('assistant-delivery/state.sqlite'),
  spoolPath: jsRef('assistant-delivery/spool'),
  schedulerEnabled: true,
  tickIntervalMs: 1000,
  leaseMs: 30000,
  maxAttempts: 5,
  maxConcurrency: 4,
  maxTextBytes: 65536,
  retryBaseMs: 1000,
  retryMaxMs: 300000,
  pairingTtlMs: 600000,
  pairingMaxAttempts: 5,
  defaultWorkspace: jsRef('assistant-workspace'),
  defaultAgentPreset: 'standard',
  policyRef: 'owner-dm',
  agentProvider: 'deepseek-official',
  agentModel: 'deepseek-v4-flash',
  agentMaxOutputTokens: 8192,
  agentMaxAutoContinuationTurns: 2,
  modelPickerTtlMs: 900000,
  permissionPickerTtlMs: 900000,
  toolApprovalTtlMs: 300000,
  ownerRoutes: [],
}

const CREDENTIALS_KEYCHAIN_DEFAULTS: Readonly<Record<string, unknown>> = {
  databasePath: jsRef('credentials-keychain/ledger.sqlite'),
  defaultLeaseMs: 300000,
  maxSecretBytes: 65536,
  providerTimeoutMs: 5000,
  handles: [],
}

const ACCOUNT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,40}$/u

function jsDshHomeScalar(relPath: string): Scalar {
  const node = new Scalar(`dshHomePath('${relPath}')`)
  node.tag = 'tag:yaml.org,2002:js'
  return node
}

function setMissingMapDefaults(doc: Document, target: YAMLMap, defaults: Readonly<Record<string, unknown>>): void {
  for (const [key, val] of Object.entries(defaults)) {
    const existing: unknown = target.get(key, true)
    if (isJsRef(val)) {
      if (existing === undefined) target.set(key, jsDshHomeScalar(val.__jsDshHome))
      continue
    }
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const subMap = isMap(existing) ? existing : ensureConfigMap(doc, target, key)
      setMissingMapDefaults(doc, subMap, val as Readonly<Record<string, unknown>>)
      continue
    }
    if (existing === undefined) {
      target.set(key, doc.createNode(val))
    }
  }
}

function readProfileManifestBundles(profileDir: string | null): Readonly<Record<string, boolean>> {
  if (profileDir === null) return {}
  const pkgPath = join(profileDir, 'package.json')
  try {
    if (!existsSync(pkgPath)) return {}
    const st = lstatSync(pkgPath)
    if (st.isSymbolicLink() || !st.isFile()) return {}
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bundles?: unknown }
    if (parsed.bundles === null || typeof parsed.bundles !== 'object' || Array.isArray(parsed.bundles)) return {}
    const out: Record<string, boolean> = {}
    for (const [name, enabled] of Object.entries(parsed.bundles as Record<string, unknown>)) {
      if (typeof enabled === 'boolean') out[name] = enabled
    }
    return out
  } catch {
    return {}
  }
}

function backupAndUpdateProfileManifest(
  paths: ProfilePaths,
  now: number,
  updates: Readonly<Record<string, boolean>>,
): boolean {
  if (paths.profileDir === null || Object.keys(updates).length === 0) return false
  const pkgPath = join(paths.profileDir, 'package.json')
  if (!existsSync(pkgPath)) return false
  const st = lstatSync(pkgPath)
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error('profile package.json 必须是普通文件，拒绝写入符号链接')
  }
  const original = readFileSync(pkgPath, 'utf8')
  const parsed = JSON.parse(original) as Record<string, unknown>
  const bundles = asPlainRecord(parsed['bundles'])
  let changed = false
  for (const [pkg, enabled] of Object.entries(updates)) {
    if (Object.hasOwn(bundles, pkg) && bundles[pkg] !== enabled) {
      bundles[pkg] = enabled
      changed = true
    }
  }
  if (!changed) return false
  parsed['bundles'] = bundles

  if (paths.canonicalHome !== null) {
    const backupDir = join(paths.canonicalHome, '.dsh-rsi-upgrade-backups', `doctor-${now}`)
    mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(backupDir, `${paths.profileName}-package.json.bak`), original, { encoding: 'utf8', mode: 0o600 })
  }
  const nextJson = `${JSON.stringify(parsed, null, 2)}\n`
  const tmpPath = `${pkgPath}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, nextJson, { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmpPath, 0o600)
  renameSync(tmpPath, pkgPath)
  return true
}

function isBundleEnabled(
  pkgName: string,
  rowId: string,
  manifestBundles: Readonly<Record<string, boolean>>,
  statusBundles: OwnerConsoleStatus['bundles'],
  seq: YAMLSeq | undefined,
): boolean {
  const row = seq ? findPatchRow(seq, rowId) : undefined
  if (row?.get('disabled') === true) return false
  if (Object.hasOwn(manifestBundles, pkgName)) return manifestBundles[pkgName] === true
  const statusEntry = statusBundles.find(b => b.name === pkgName)
  if (statusEntry !== undefined) return statusEntry.installed && statusEntry.enabled
  return row !== undefined
}

function isBundleInstalled(
  pkgName: string,
  rowId: string,
  manifestBundles: Readonly<Record<string, boolean>>,
  statusBundles: OwnerConsoleStatus['bundles'],
  seq: YAMLSeq | undefined,
): boolean {
  if (Object.hasOwn(manifestBundles, pkgName)) return true
  if (statusBundles.some(b => b.name === pkgName && b.installed)) return true
  return seq ? findPatchRow(seq, rowId) !== undefined : false
}

function removePatchRow(seq: YAMLSeq, rowId: string): boolean {
  let removed = false
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i]
    if (!isMap(item)) continue
    if (item.get('id') === rowId) {
      seq.items.splice(i, 1)
      removed = true
      continue
    }
    const inserted = item.get('insert', true)
    if (isSeq(inserted)) {
      for (let j = inserted.items.length - 1; j >= 0; j--) {
        const sub = inserted.items[j]
        if (isMap(sub) && sub.get('id') === rowId) {
          inserted.items.splice(j, 1)
          removed = true
        }
      }
      if (inserted.items.length === 0 && item.items.length === 1) {
        seq.items.splice(i, 1)
      }
    }
  }
  return removed
}

function disablePatchRowIfPresent(doc: Document, seq: YAMLSeq, rowId: string, packageName: string): boolean {
  const existing = findPatchRow(seq, rowId)
  if (existing !== undefined) {
    if (existing.get('disabled') === true) return false
    existing.set('disabled', doc.createNode(true))
    return true
  }
  const row = doc.createNode({ id: rowId, name: packageName, disabled: true }) as unknown as YAMLMap
  seq.add(row)
  return true
}

interface SqliteOwnerSnapshot {
  readonly tablePresent: boolean
  readonly totalPrincipals: number
  readonly activeOwner: Readonly<{
    principalRecordId: string
    principalVersion: number
    principal: Record<string, unknown>
    principalKey: string
    conversation: Record<string, unknown> | null
    workspace: string | null
    preset: string | null
    policyRef: string | null
    generation: number
  }> | null
}

function readDeliverySqliteSnapshot(dbPath: string | null): SqliteOwnerSnapshot {
  if (dbPath === null || !existsSync(dbPath)) {
    return { tablePresent: false, totalPrincipals: 0, activeOwner: null }
  }
  let db: DatabaseSync | undefined
  try {
    const st = lstatSync(dbPath)
    if (st.isSymbolicLink() || !st.isFile()) {
      return { tablePresent: false, totalPrincipals: 0, activeOwner: null }
    }
    db = new DatabaseSync(dbPath, { readOnly: true })
    const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_principals'`).get() as { name?: unknown } | undefined
    if (tbl?.name !== 'delivery_principals') {
      return { tablePresent: false, totalPrincipals: 0, activeOwner: null }
    }
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM delivery_principals`).get() as { count?: unknown } | undefined
    const totalPrincipals = typeof countRow?.count === 'number' ? countRow.count : 0

    const owners = db.prepare(
      `SELECT id, version, principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active' ORDER BY version DESC LIMIT 8`,
    ).all() as ReadonlyArray<{ id?: unknown; version?: unknown; principal_json?: unknown }>
    let chosen: { id: string; version: number; principal: Record<string, unknown>; key: string } | null = null
    for (const row of owners) {
      if (typeof row.id !== 'string' || typeof row.version !== 'number' || typeof row.principal_json !== 'string') continue
      let parsed: Record<string, unknown>
      try {
        parsed = asPlainRecord(JSON.parse(row.principal_json))
      } catch {
        continue
      }
      const key = externalPrincipalId(parsed)
      if (key === null) continue
      if (parsed['channel'] === 'web') {
        chosen = { id: row.id, version: row.version, principal: parsed, key }
        break
      }
      if (chosen === null) chosen = { id: row.id, version: row.version, principal: parsed, key }
    }
    if (chosen === null) {
      return { tablePresent: true, totalPrincipals, activeOwner: null }
    }

    let conversation: Record<string, unknown> | null = null
    let workspace: string | null = null
    let preset: string | null = null
    let policyRef: string | null = null
    let generation = 1
    try {
      const binding = db.prepare(
        `SELECT conversation_json, workspace, agent_preset, policy_ref, generation FROM conversation_bindings WHERE (principal_id = ? OR principal_id = ?) AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
      ).get(chosen.id, chosen.key) as Readonly<{
        conversation_json?: unknown
        workspace?: unknown
        agent_preset?: unknown
        policy_ref?: unknown
        generation?: unknown
      }> | undefined
      if (binding !== undefined) {
        if (typeof binding.conversation_json === 'string') {
          try {
            const parsedConv = asPlainRecord(JSON.parse(binding.conversation_json))
            if (typeof parsedConv['channel'] === 'string' && typeof parsedConv['chat'] === 'string') {
              conversation = parsedConv
            }
          } catch { /* ignore malformed */ }
        }
        if (typeof binding.workspace === 'string') workspace = binding.workspace
        if (typeof binding.agent_preset === 'string') preset = binding.agent_preset
        if (typeof binding.policy_ref === 'string') policyRef = binding.policy_ref
        if (typeof binding.generation === 'number' && Number.isSafeInteger(binding.generation) && binding.generation >= 1) {
          generation = binding.generation
        }
      }
    } catch {
      // conversation_bindings may not exist on minimal synthetic fixtures.
    }

    return {
      tablePresent: true,
      totalPrincipals,
      activeOwner: {
        principalRecordId: chosen.id,
        principalVersion: chosen.version,
        principal: chosen.principal,
        principalKey: chosen.key,
        conversation,
        workspace,
        preset,
        policyRef,
        generation,
      },
    }
  } catch {
    return { tablePresent: false, totalPrincipals: 0, activeOwner: null }
  } finally {
    try { db?.close() } catch { /* noop */ }
  }
}

function severityRank(severity: SetupDoctorIssue['severity']): number {
  return severity === 'error' ? 0 : severity === 'warn' ? 1 : 2
}

export interface InspectSetupDoctorInput {
  readonly host: AutonomyHostContext
  readonly status: OwnerConsoleStatus
  readonly descriptors: readonly SettingsDescriptor[]
  readonly prober: CodingToolProber
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly now?: number
}

/** Inspect plugins, config collisions, DB scoping, owner routes, and ACP CLIs for self-healing setup. */
export async function inspectSetupDoctor(input: InspectSetupDoctorInput): Promise<SetupDoctorReport> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const now = input.now ?? Date.now()
  const paths = resolveProfilePaths(input.host, env)
  const frozenSystemdProfile = detectFrozenSystemdProfile(paths.dshHome, paths.profileName, platform, env)
  const manifestBundles = readProfileManifestBundles(paths.profileDir)
  const issues: SetupDoctorIssue[] = []
  const mutatable = paths.writable && !frozenSystemdProfile

  let seq: YAMLSeq | undefined
  let yamlError: string | null = null
  try {
    const doc = readPatchDocument(paths.patchPath)
    if (isSeq(doc.contents)) seq = doc.contents
  } catch (error: unknown) {
    yamlError = error instanceof Error ? error.message : String(error)
  }

  if (yamlError !== null) {
    issues.push({
      id: 'invalid-patch-yaml',
      severity: 'error',
      category: 'config',
      title: 'cordis.patch.yml 解析失败',
      detail: `${yamlError}（为保护现有配置，需先修正 YAML 语法或符号链接问题）`,
      autoFixable: false,
      fixLabel: '需手动检查 YAML 语法',
    })
  }

  const coveredPackages = new Set<string>()
  const acpPlugin = input.status.plugins.find(p => p.moduleName === '@dsh-enhanced/acp')
  const guiPresent = input.status.plugins.some(p => p.moduleName === '@deepseek-ai/dsh-web-app')
    || paths.profileName === 'desktop' || paths.profileName === 'web'
    || /DUPLICATE INSERT ID:\s*cordis-host-runner/iu.test(acpPlugin?.diagnostic ?? '')
  const acpEnabled = isBundleEnabled('@dsh-enhanced/acp', 'dsh-enhanced-acp', manifestBundles, input.status.bundles, seq)
  if (acpEnabled && guiPresent) {
    coveredPackages.add('@dsh-enhanced/acp')
    issues.push({
      id: 'gui-stdio-acp-conflict',
      severity: 'error',
      category: 'plugins',
      title: '@dsh-enhanced/acp 与桌面/Web 端内置 Host 冲突',
      detail: '桌面端与 Web 端已内置 `@deepseek-ai/dsh-web-app`（cordis-host-runner），同时启用 `@dsh-enhanced/acp` 会触发 DUPLICATE INSERT ID 冲突；停用 `@dsh-enhanced/acp` 即可恢复正常。',
      autoFixable: mutatable,
      fixLabel: '停用冲突的 @dsh-enhanced/acp',
    })
  }

  const isolationEnabled = isBundleEnabled(
    '@dsh-enhanced/assistant-isolation',
    'dsh-enhanced-assistant-isolation',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  if (platform !== 'linux' && isolationEnabled) {
    coveredPackages.add('@dsh-enhanced/assistant-isolation')
    issues.push({
      id: 'unsupported-platform-isolation',
      severity: 'error',
      category: 'plugins',
      title: '@dsh-enhanced/assistant-isolation 仅支持 Linux 环境',
      detail: `当前系统为 ${platform}，\`assistant-isolation\` 仅支持 \`linux-native\` 后端并会在启动时报错；停用该插件即可消除异常。`,
      autoFixable: mutatable,
      fixLabel: '停用 Linux 专用隔离插件',
    })
  }

  const paEnabled = isBundleEnabled(
    '@dsh-enhanced/personal-assistant',
    'dsh-enhanced-personal-assistant',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const collidingSplits = SPLIT_PA_PACKAGES.filter(spec =>
    isBundleEnabled(spec.pkg, spec.rowId, manifestBundles, input.status.bundles, seq))
  if (paEnabled && collidingSplits.length > 0) {
    for (const spec of collidingSplits) coveredPackages.add(spec.pkg)
    coveredPackages.add('@dsh-enhanced/personal-assistant')
    issues.push({
      id: 'personal-assistant-split-collision',
      severity: 'error',
      category: 'plugins',
      title: 'personal-assistant 与拆分版子插件重复挂载',
      detail: `已同时启用组合包 \`@dsh-enhanced/personal-assistant\` 与子插件 ${collidingSplits.map(s => `\`${s.pkg}\``).join('、')}，会导致服务重复注入或配置覆盖。自动修复会将策略自定义项（如 \`toolDefaultEffect\`、\`autoReview\`、自定义规则/预算）迁移并合并进 \`personal-assistant\` 后安全停用重复子插件。`,
      autoFixable: mutatable,
      fixLabel: '合并重复子插件并保留策略',
    })
  }

  const memLearningEnabled = isBundleEnabled(
    '@dsh-enhanced/assistant-memory-learning',
    'dsh-enhanced-assistant-memory-learning',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  if (memLearningEnabled) {
    const memPlugin = input.status.plugins.find(p => p.moduleName === '@dsh-enhanced/assistant-memory-learning')
    const memBundle = input.status.bundles.find(b => b.name === '@dsh-enhanced/assistant-memory-learning')
    const memCfg = mergeDescriptorConfig(
      input.descriptors,
      'dsh-enhanced-assistant-memory-learning',
      seq ? getPatchRowConfig(seq, 'dsh-enhanced-assistant-memory-learning') : {},
    )
    const missingGrantFields = typeof memCfg['authorityId'] !== 'string'
      || typeof memCfg['reviewAuthorityDigest'] !== 'string'
      || typeof memCfg['adoptionGrantDigest'] !== 'string'
    const crashedConfig = memPlugin?.fiberPhase === 'failed'
      || memBundle?.error?.code === 'CONFIG_ERROR'
      || /Invalid memory learning/iu.test(`${memPlugin?.diagnostic ?? ''} ${memBundle?.error?.diagnostic ?? ''}`)
    if (missingGrantFields || crashedConfig) {
      coveredPackages.add('@dsh-enhanced/assistant-memory-learning')
      issues.push({
        id: 'unconfigured-memory-learning-crash',
        severity: 'error',
        category: 'autonomy',
        title: 'assistant-memory-learning 尚未授权配置却已启用',
        detail: '记忆学习插件需要完整的 Owner 授权摘要配置才能加载；当前直接启用会导致配置校验失败（CONFIG_ERROR）。自动修复会先安全停用它，需要时可在本页「一键启用持久记忆学习与自治」向导中一键生成授权并启用。',
        autoFixable: mutatable,
        fixLabel: '安全停用未授权的记忆学习崩溃项',
      })
    }
  }

  const deliveryInstalled = isBundleInstalled(
    '@dsh-enhanced/assistant-delivery',
    'dsh-enhanced-assistant-delivery',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const deliveryEnabled = isBundleEnabled(
    '@dsh-enhanced/assistant-delivery',
    'dsh-enhanced-assistant-delivery',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  if (deliveryInstalled && deliveryEnabled && seq !== undefined) {
    const routeInfo = inspectOwnerRoute(input.host, paths, seq, input.descriptors)
    if (!routeInfo.configured || !routeInfo.active) {
      const deliveryNode = getPatchRowConfigNode(seq, 'dsh-enhanced-assistant-delivery')
      const deliveryCfg = mergeDescriptorConfig(
        input.descriptors,
        'dsh-enhanced-assistant-delivery',
        getPatchRowConfig(seq, 'dsh-enhanced-assistant-delivery'),
      )
      const scopedDb = checkScopedDbPath(deliveryNode?.get('databasePath', true) ?? deliveryCfg['databasePath'], paths.canonicalHome)
      const deliveryDbPath = scopedDb.resolved ?? (paths.canonicalHome ? join(paths.canonicalHome, 'assistant-delivery', 'state.sqlite') : null)
      const sqliteSnapshot = readDeliverySqliteSnapshot(deliveryDbPath)
      const webOwnerInstalled = isBundleInstalled(
        '@dsh-enhanced/assistant-web-owner',
        'dsh-enhanced-assistant-web-owner',
        manifestBundles,
        input.status.bundles,
        seq,
      )
      const waitingWebBoot = routeInfo.configured
        && !routeInfo.active
        && !sqliteSnapshot.tablePresent
        && webOwnerInstalled

      if (waitingWebBoot) {
        issues.push({
          id: 'owner-route-pending-restart',
          severity: 'info',
          category: 'autonomy',
          title: 'Owner 主路由已写入配置，等待 Profile 重启激活',
          detail: '已配置 Web Owner 主路由，待下次重启 profile 后自动初始化 Delivery 数据库并激活路由。',
          autoFixable: false,
          fixLabel: '重启后生效',
        })
      } else if (sqliteSnapshot.activeOwner !== null) {
        const owner = sqliteSnapshot.activeOwner
        const ch = strOrNull(owner.principal['channel']) ?? 'owner'
        const canBindFromSqlite = ch === 'web' || owner.conversation !== null
        issues.push({
          id: 'missing-local-owner-route',
          severity: 'warn',
          category: 'autonomy',
          title: '检测到已绑定 Owner，但 Delivery 主路由尚未写入配置',
          detail: canBindFromSqlite
            ? `已在 SQLite 检测到激活的 ${ch} Owner（${owner.principalKey}），自动修复会直接将该 Owner 绑定到 \`assistant-delivery.ownerRoutes\` 与 \`assistantPolicy\` 规则，不改动现有身份记录。`
            : `已在 SQLite 检测到激活的 ${ch} Owner（${owner.principalKey}），但尚未产生私聊会话绑定；请先在对应通道发送一条消息后重试。`,
          autoFixable: mutatable && canBindFromSqlite,
          fixLabel: '一键绑定现有 Owner 主路由',
        })
      } else {
        issues.push({
          id: 'missing-local-owner-route',
          severity: 'warn',
          category: 'autonomy',
          title: '尚未初始化本地 Owner 与主动汇报路由',
          detail: '一键修复将初始化本地 Web Owner 主体（web/<profile>/local/operator），并补齐 `assistant-delivery.ownerRoutes`、`assistant-web-owner` 与 `assistantPolicy` 路由规则。',
          autoFixable: mutatable && paths.canonicalHome !== null,
          fixLabel: '一键初始化本地 Owner 主路由',
        })
      }
    }
  }

  if (paths.canonicalHome !== null && seq !== undefined) {
    const unscopedTargets: string[] = []
    for (const spec of SCOPED_STATE_BUNDLES) {
      if (!isBundleEnabled(spec.pkg, spec.rowId, manifestBundles, input.status.bundles, seq)) continue
      const rowCfgNode = getPatchRowConfigNode(seq, spec.rowId)
      const rowCfg = mergeDescriptorConfig(input.descriptors, spec.rowId, getPatchRowConfig(seq, spec.rowId))
      const dbCheck = checkScopedDbPath(rowCfgNode?.get('databasePath', true) ?? rowCfg['databasePath'], paths.canonicalHome)
      if (!dbCheck.scoped) unscopedTargets.push(spec.rowId)
    }
    if (unscopedTargets.length > 0) {
      issues.push({
        id: 'unscoped-db-paths',
        severity: 'warn',
        category: 'config',
        title: '部分扩展插件缺少当前 DSH_HOME 独立数据库路径',
        detail: `插件 ${unscopedTargets.join('、')} 尚未限定在当前 DSH_HOME 下的独立 sqlite 文件；自动修复会自动补齐安全路径。`,
        autoFixable: mutatable,
        fixLabel: '一键补齐独立数据库路径',
      })
    }
  }

  const probeTool = async (tool: CodingToolId, hostState: OwnerConsoleStatus['traex'], issuePrefix: 'traex' | 'agy', label: string) => {
    const probe = await input.prober.probe(tool, {
      command: hostState.command,
      installed: hostState.installed,
      enabled: hostState.enabled,
      routeRegistered: input.status.llmProviders.some(p => p.id === `${tool}-agent`),
      dshHome: paths.dshHome,
    }, false)
    if (probe.binaryFound && probe.loggedIn && probe.installed) {
      if (!probe.enabled || !probe.routeRegistered || probe.needsPathPin) {
        issues.push({
          id: `${issuePrefix}-auto-connect`,
          severity: (!probe.routeRegistered || probe.needsPathPin) ? 'warn' : 'info',
          category: 'acp',
          title: `${label} CLI 已就绪，可一键固定路径并启用路由`,
          detail: `${probe.summary}${probe.discoveredPath ? `（检测到可执行文件 ${probe.discoveredPath}）` : ''}。`,
          autoFixable: !frozenSystemdProfile,
          fixLabel: '一键绑定路径并启用',
        })
      }
    } else if (probe.binaryFound && !probe.loggedIn && probe.state === 'auth-required') {
      const loginCmd = probe.loginCommand ?? (tool === 'traex' ? `${probe.command} login` : `${probe.command} acp --login`)
      issues.push({
        id: `${issuePrefix}-auth-required`,
        severity: 'info',
        category: 'acp',
        title: `${label} CLI 已安装，需要终端完成一次登录`,
        detail: `${probe.summary}；请复制下方命令在本机终端运行完成后点击「重新探测」。`,
        autoFixable: false,
        fixLabel: '需终端登录一次',
        copyCommand: loginCmd,
      })
    }
  }

  if (input.status.traex.installed) await probeTool('traex', input.status.traex, 'traex', 'TraeX')
  if (input.status.agy.installed) await probeTool('agy', input.status.agy, 'agy', 'Antigravity (agy)')

  for (const bundle of input.status.bundles) {
    if (!bundle.name.startsWith('@dsh-enhanced/')) continue
    if (bundle.name === '@dsh-enhanced/owner-console') continue
    if (coveredPackages.has(bundle.name)) continue
    if (!bundle.installed || !bundle.enabled) continue
    const plugin = input.status.plugins.find(p => p.moduleName === bundle.name)
    if (bundle.error === undefined && plugin?.fiberPhase !== 'failed') continue
    const diag = plugin?.diagnostic ?? bundle.error?.diagnostic ?? bundle.error?.code ?? '未知异常'
    issues.push({
      id: `stalled-bundle:${bundle.name}`,
      severity: 'warn',
      category: 'plugins',
      title: `插件 ${bundle.name} 加载失败`,
      detail: `当前处于异常状态（${diag.slice(0, 200)}）；可一键临时停用以恢复左侧插件健康状态，再按需要重新启用。`,
      autoFixable: mutatable,
      fixLabel: '安全停用异常插件',
    })
  }

  issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  const bounded = issues.slice(0, 64)
  const autoFixableCount = bounded.filter(item => item.autoFixable).length
  const healthy = bounded.every(item => item.severity === 'info') && autoFixableCount === 0
  const restartRequiredHint = bounded.some(item => item.category === 'plugins' || item.category === 'autonomy' || item.category === 'config')

  return Object.freeze({
    protocol: 'owner-console/setup-doctor/v1',
    checkedAt: now,
    profileName: paths.profileName,
    dshHome: paths.dshHome,
    frozenSystemdProfile,
    writable: paths.writable,
    healthy,
    autoFixableCount,
    restartRequiredHint,
    issues: Object.freeze(bounded),
  })
}

function mergePolicyIntoTarget(doc: Document, targetPolicy: YAMLMap, source: Readonly<Record<string, unknown>>): void {
  for (const key of ['toolDefaultEffect', 'autoReview']) {
    if (source[key] !== undefined) targetPolicy.set(key, doc.createNode(source[key]))
  }
  const srcRules = Array.isArray(source['rules']) ? source['rules'].map(asPlainRecord) : []
  if (srcRules.length > 0) {
    const existing = targetPolicy.get('rules', true)
    const existingList = isSeq(existing) ? existing.toJSON() : []
    targetPolicy.set('rules', doc.createNode(upsertById(existingList, srcRules)))
  }
  const srcBudgets = Array.isArray(source['budgets']) ? source['budgets'].map(asPlainRecord) : []
  if (srcBudgets.length > 0) {
    const existing = targetPolicy.get('budgets', true)
    const existingList = isSeq(existing) ? existing.toJSON() : []
    targetPolicy.set('budgets', doc.createNode(upsertById(existingList, srcBudgets)))
  }
  const known = new Set(['databasePath', 'rules', 'budgets', 'toolDefaultEffect', 'autoReview'])
  for (const [k, v] of Object.entries(source)) {
    if (!known.has(k) && v !== undefined && !targetPolicy.has(k)) {
      targetPolicy.set(k, doc.createNode(v))
    }
  }
}

export interface ApplyDoctorRepairInput {
  readonly host: AutonomyHostContext
  readonly status: OwnerConsoleStatus
  readonly descriptors: readonly SettingsDescriptor[]
  readonly settings: SettingsService | undefined
  readonly manager: PluginManagerService | undefined
  readonly prober: CodingToolProber
  readonly reloadEntry?: (entryId: string) => Promise<string>
  readonly issueIds: readonly string[]
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly now?: number
}

/** Execute verified self-healing repairs for plugins, DB scoping, owner routes, and ACP paths. */
export async function applyDoctorRepair(input: ApplyDoctorRepairInput): Promise<OwnerConsoleWriteResult> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const now = input.now ?? Date.now()
  const report = await inspectSetupDoctor({
    host: input.host,
    status: input.status,
    descriptors: input.descriptors,
    prober: input.prober,
    platform,
    env,
    now,
  })
  if (report.frozenSystemdProfile) {
    return Object.freeze({
      applied: false,
      entry: 'setup-doctor',
      note: '当前为受控 Linux systemd 冻结实例，拒绝在线改写 profile 清单或授权文件；请使用受控运维命令变更。',
    })
  }

  const wanted = new Set(input.issueIds.map(id => id.trim()).filter(Boolean))
  const targets = report.issues.filter(issue => issue.autoFixable && (wanted.size === 0 || wanted.has(issue.id)))
  if (targets.length === 0) {
    return Object.freeze({
      applied: true,
      entry: 'setup-doctor',
      note: '当前没有需要自动修复的异常项。',
    })
  }

  const paths = resolveProfilePaths(input.host, env)
  const doc = readPatchDocument(paths.patchPath)
  const seq = doc.contents as YAMLSeq
  let patchDirty = false
  const bundleUpdates: Record<string, boolean> = {}
  const notes: string[] = []
  let needsRestart = false

  const disableBundle = async (pkgName: string, rowId: string, label: string) => {
    bundleUpdates[pkgName] = false
    if (input.manager !== undefined) {
      try {
        await input.manager.setBundleEnabled(pkgName, false)
      } catch {
        // Fallback to manifest update below if manager doesn't expose it.
      }
    }
    if (disablePatchRowIfPresent(doc, seq, rowId, pkgName)) patchDirty = true
    notes.push(`已停用 ${label}`)
    needsRestart = true
  }

  for (const issue of targets) {
    if (issue.id === 'gui-stdio-acp-conflict') {
      await disableBundle('@dsh-enhanced/acp', 'dsh-enhanced-acp', '@dsh-enhanced/acp')
      continue
    }
    if (issue.id === 'unsupported-platform-isolation') {
      await disableBundle('@dsh-enhanced/assistant-isolation', 'dsh-enhanced-assistant-isolation', '@dsh-enhanced/assistant-isolation')
      continue
    }
    if (issue.id === 'unconfigured-memory-learning-crash') {
      await disableBundle('@dsh-enhanced/assistant-memory-learning', 'dsh-enhanced-assistant-memory-learning', '@dsh-enhanced/assistant-memory-learning')
      continue
    }
    if (issue.id.startsWith('stalled-bundle:')) {
      const pkg = issue.id.slice('stalled-bundle:'.length)
      const rowId = input.status.bundles.find(b => b.name === pkg)?.rows[0]?.rowId
        ?? `dsh-enhanced-${pkg.replace(/^@dsh-enhanced\//u, '')}`
      await disableBundle(pkg, rowId, pkg)
      continue
    }
    if (issue.id === 'personal-assistant-split-collision') {
      const paRow = ensurePatchRow(doc, seq, 'dsh-enhanced-personal-assistant', '@dsh-enhanced/personal-assistant')
      paRow.delete('disabled')
      const paConfig = ensureConfigMap(doc, paRow, 'config')
      setMissingMapDefaults(doc, paConfig, PERSONAL_ASSISTANT_DEFAULTS)

      for (const spec of SPLIT_PA_PACKAGES) {
        const patchSplit = getPatchRowConfig(seq, spec.rowId)
        const mergedSplit = mergeDescriptorConfig(input.descriptors, spec.rowId, patchSplit)
        const sectionMap = ensureConfigMap(doc, paConfig, spec.section)
        if (spec.section === 'assistantPolicy') {
          mergePolicyIntoTarget(doc, sectionMap, mergedSplit)
        } else {
          for (const [k, v] of Object.entries(patchSplit)) {
            if (v !== undefined) sectionMap.set(k, doc.createNode(v))
          }
        }
        bundleUpdates[spec.pkg] = false
        if (input.manager !== undefined) {
          try { await input.manager.setBundleEnabled(spec.pkg, false) } catch { /* manifest fallback */ }
        }
        if (removePatchRow(seq, spec.rowId)) patchDirty = true
      }
      patchDirty = true
      notes.push('已合并 personal-assistant 重复子插件并保留自定义策略')
      needsRestart = true
      continue
    }
    if (issue.id === 'unscoped-db-paths' && paths.canonicalHome !== null) {
      const manifestBundles = readProfileManifestBundles(paths.profileDir)
      for (const spec of SCOPED_STATE_BUNDLES) {
        if (!isBundleEnabled(spec.pkg, spec.rowId, manifestBundles, input.status.bundles, seq)) continue
        const row = findPatchRow(seq, spec.rowId)
        const rowCfg = row ? readConfigMap(row, 'config') : undefined
        const merged = mergeDescriptorConfig(input.descriptors, spec.rowId, getPatchRowConfig(seq, spec.rowId))
        const existingCheck = checkScopedDbPath(rowCfg?.get('databasePath', true) ?? merged['databasePath'], paths.canonicalHome)
        if (existingCheck.scoped) continue
        const targetRow = ensurePatchRow(doc, seq, spec.rowId, spec.pkg)
        const cfg = ensureConfigMap(doc, targetRow, 'config')
        cfg.set('databasePath', doc.createNode(join(paths.canonicalHome, spec.subdir, `${paths.profileName}.sqlite`)))
        patchDirty = true
      }
      notes.push('已补齐独立 SQLite 路径')
      needsRestart = true
      continue
    }
    if (issue.id === 'missing-local-owner-route' && paths.canonicalHome !== null) {
      const deliveryRow = ensurePatchRow(doc, seq, 'dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery')
      const deliveryCfgMap = ensureConfigMap(doc, deliveryRow, 'config')
      setMissingMapDefaults(doc, deliveryCfgMap, ASSISTANT_DELIVERY_DEFAULTS)

      const mergedDelivery = mergeDescriptorConfig(input.descriptors, 'dsh-enhanced-assistant-delivery', getPatchRowConfig(seq, 'dsh-enhanced-assistant-delivery'))
      const scopedDb = checkScopedDbPath(deliveryCfgMap.get('databasePath', true) ?? mergedDelivery['databasePath'], paths.canonicalHome)
      const deliveryDbPath = scopedDb.resolved ?? join(paths.canonicalHome, 'assistant-delivery', 'state.sqlite')
      const defaultWorkspace = strOrNull(mergedDelivery['defaultWorkspace']) ?? join(paths.canonicalHome, 'assistant-workspace')
      const defaultPreset = strOrNull(mergedDelivery['defaultAgentPreset']) ?? 'standard'
      mkdirSync(defaultWorkspace, { recursive: true, mode: 0o755 })

      let sqliteSnapshot = readDeliverySqliteSnapshot(deliveryDbPath)
      let ownerPrincipal: Record<string, unknown> = { channel: 'web', account: paths.profileName, tenant: 'local', user: 'operator' }
      let ownerConversation: Record<string, unknown> = { channel: 'web', account: paths.profileName, tenant: 'local', kind: 'dm', chat: 'owner-primary' }
      let routeWorkspace = defaultWorkspace
      let routePreset = defaultPreset
      let routePolicyRef = 'owner-dm'
      let routeGeneration = 1

      if (sqliteSnapshot.tablePresent && sqliteSnapshot.totalPrincipals === 0) {
        const json = JSON.stringify({ channel: 'web', account: paths.profileName, tenant: 'local', user: 'operator' })
        const hash = createHash('sha256').update(json, 'utf8').digest('hex')
        const rwDb = new DatabaseSync(deliveryDbPath)
        try {
          rwDb.prepare(
            `INSERT INTO delivery_principals (id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version) VALUES (?, ?, ?, 'owner', 'active', NULL, ?, ?, 1)`,
          ).run(`principal_${randomUUID()}`, hash, json, now, now)
        } finally {
          rwDb.close()
        }
        sqliteSnapshot = readDeliverySqliteSnapshot(deliveryDbPath)
      }

      if (sqliteSnapshot.activeOwner !== null) {
        const active = sqliteSnapshot.activeOwner
        ownerPrincipal = active.principal
        const ch = strOrNull(ownerPrincipal['channel']) ?? 'web'
        const acc = strOrNull(ownerPrincipal['account']) ?? paths.profileName
        const ten = strOrNull(ownerPrincipal['tenant']) ?? 'local'
        if (active.conversation !== null) {
          ownerConversation = active.conversation
        } else if (ch === 'web') {
          ownerConversation = { channel: 'web', account: acc, tenant: ten, kind: 'dm', chat: 'owner-primary' }
        }
        routeWorkspace = active.workspace ?? defaultWorkspace
        routePreset = active.preset ?? defaultPreset
        routePolicyRef = active.policyRef ?? 'owner-dm'
        routeGeneration = active.generation
      }

      const routeChannel = strOrNull(ownerPrincipal['channel']) ?? 'web'
      const routeAccount = strOrNull(ownerPrincipal['account']) ?? paths.profileName
      const routeId = `owner-${routeChannel}-${routeAccount}`
      const ownerRoute = {
        id: routeId,
        conversation: ownerConversation,
        principal: ownerPrincipal,
        workspace: routeWorkspace,
        agentPreset: routePreset,
        policyRef: routePolicyRef,
        minimumGeneration: routeGeneration,
      }
      const existingRoutes = isSeq(deliveryCfgMap.get('ownerRoutes', true)) ? deliveryCfgMap.get('ownerRoutes', true)!.toJSON() : []
      deliveryCfgMap.set('ownerRoutes', doc.createNode(upsertById(existingRoutes, [ownerRoute])))
      deliveryCfgMap.set('defaultWorkspace', doc.createNode(routeWorkspace))
      deliveryCfgMap.set('defaultAgentPreset', doc.createNode(routePreset))

      const layoutInfo = getPersonalAndPolicyConfigs(seq, input.descriptors)
      let policyConfigNode: YAMLMap
      if (layoutInfo.layout === 'split') {
        const policyRow = ensurePatchRow(doc, seq, 'dsh-enhanced-assistant-policy', '@dsh-enhanced/assistant-policy')
        policyConfigNode = ensureConfigMap(doc, policyRow, 'config')
      } else {
        const paRow = ensurePatchRow(doc, seq, 'dsh-enhanced-personal-assistant', '@dsh-enhanced/personal-assistant')
        const paCfg = ensureConfigMap(doc, paRow, 'config')
        setMissingMapDefaults(doc, paCfg, PERSONAL_ASSISTANT_DEFAULTS)
        policyConfigNode = ensureConfigMap(doc, paCfg, 'assistantPolicy')
      }
      const principalKey = externalPrincipalId(ownerPrincipal) ?? `${routeChannel}/${routeAccount}/local/operator`
      const requiredRules: Record<string, unknown>[] = [
        {
          id: `dsh-enhanced-owner-route-${routeId}`,
          effect: 'allow',
          subject: { kind: 'background', id: '*', workspace: routeWorkspace, principal: principalKey },
          actions: ['send'],
          resource: { kind: 'message', id: `route:${routeId}` },
          context: { initiators: ['background'] },
        },
      ]
      if (routeChannel === 'web') {
        requiredRules.push(
          {
            id: `dsh-enhanced-web-${routeAccount}-ingest`,
            effect: 'allow',
            subject: { kind: 'external', id: principalKey },
            actions: ['ingest'],
            resource: { kind: 'message', id: '*' },
            context: { initiators: ['external'] },
          },
          {
            id: `dsh-enhanced-web-${routeAccount}-capability`,
            effect: 'allow',
            subject: { kind: 'agent', id: routePreset, workspace: routeWorkspace, principal: principalKey },
            actions: ['*'],
            resource: { kind: '*', id: '*' },
            context: { initiators: ['external'] },
          },
        )
      }
      const existingRules = isSeq(policyConfigNode.get('rules', true)) ? policyConfigNode.get('rules', true)!.toJSON() : layoutInfo.policyCfg['rules']
      policyConfigNode.set('rules', doc.createNode(upsertById(existingRules, requiredRules)))

      const manifestBundles = readProfileManifestBundles(paths.profileDir)
      if (routeChannel === 'web' && isBundleInstalled('@dsh-enhanced/assistant-web-owner', 'dsh-enhanced-assistant-web-owner', manifestBundles, input.status.bundles, seq)) {
        const webRow = ensurePatchRow(doc, seq, 'dsh-enhanced-assistant-web-owner', '@dsh-enhanced/assistant-web-owner')
        const webCfg = ensureConfigMap(doc, webRow, 'config')
        webCfg.set('principal', doc.createNode({
          account: strOrNull(ownerPrincipal['account']) ?? paths.profileName,
          tenant: strOrNull(ownerPrincipal['tenant']) ?? 'local',
          user: strOrNull(ownerPrincipal['user']) ?? 'operator',
        }))
        webCfg.set('workspace', doc.createNode(routeWorkspace))
        webCfg.set('preset', doc.createNode(routePreset))
        if (!webCfg.has('maxExecutionMs')) webCfg.set('maxExecutionMs', doc.createNode(300_000))
      }

      patchDirty = true
      notes.push(`已绑定 Owner 主路由（${principalKey}）`)
      needsRestart = true
      continue
    }
    if (issue.id === 'traex-auto-connect' || issue.id === 'agy-auto-connect') {
      const tool: CodingToolId = issue.id === 'traex-auto-connect' ? 'traex' : 'agy'
      const current = tool === 'traex' ? input.status.traex : input.status.agy
      const probe = await input.prober.probe(tool, {
        command: current.command,
        installed: current.installed,
        enabled: current.enabled,
        routeRegistered: input.status.llmProviders.some(p => p.id === `${tool}-agent`),
        dshHome: paths.dshHome,
      }, false)
      const resolvedCmd = probe.discoveredPath ?? (probe.command.trim() !== '' ? probe.command.trim() : tool)
      const enableKey = tool === 'traex' ? 'enabled' : 'agyEnabled'
      const cmdKey = tool === 'traex' ? 'command' : 'agyCommand'

      let mutatedLive = false
      const traexDesc = findEntry(input.descriptors, ns => /traex/iu.test(ns))
      if (input.settings !== undefined && traexDesc !== undefined) {
        try {
          await input.settings.mutate(traexDesc.ns, [
            { op: 'set', path: [enableKey], value: true },
            { op: 'set', path: [cmdKey], value: resolvedCmd },
          ], traexDesc.revision)
          mutatedLive = true
          if (input.reloadEntry !== undefined) await input.reloadEntry(traexDesc.ns)
        } catch {
          // Fall back to writing patch directly below when writable.
        }
      }
      if (paths.patchPath !== null && paths.writable) {
        const traexRow = ensurePatchRow(doc, seq, 'dsh-enhanced-traex-acp-provider', '@dsh-enhanced/traex-acp-provider')
        const traexCfg = ensureConfigMap(doc, traexRow, 'config')
        traexCfg.set(enableKey, doc.createNode(true))
        traexCfg.set(cmdKey, doc.createNode(resolvedCmd))
        if (!traexCfg.has('cwd') && paths.canonicalHome !== null) {
          traexCfg.set('cwd', jsDshHomeScalar('assistant-workspace'))
        }
        patchDirty = true
      } else if (!mutatedLive) {
        return Object.freeze({
          applied: false,
          entry: 'setup-doctor',
          note: `无法写入 ${tool} 配置（live settings 与 cordis.patch.yml 均不可写）。`,
        })
      }
      notes.push(`已绑定并启用 ${tool}（${resolvedCmd}）`)
    }
  }

  if (patchDirty && paths.patchPath !== null) {
    if (!paths.writable) {
      return Object.freeze({
        applied: false,
        entry: 'setup-doctor',
        note: '当前 profile 的 cordis.patch.yml 不可写入，无法持久化修复配置。',
      })
    }
    atomicWritePatchWithBackup(paths.patchPath, doc.toString({ lineWidth: 0 }), now)
  }

  if (Object.keys(bundleUpdates).length > 0) {
    backupAndUpdateProfileManifest(paths, now, bundleUpdates)
  }

  return Object.freeze({
    applied: true,
    entry: 'setup-doctor',
    note: `${notes.join('；')}${needsRestart ? '。请重启 profile（桌面端可退出后重开应用）以彻底激活修复后的插件' : '。'}`,
  })
}

export type EasySecretLocator =
  | Readonly<{ provider: 'macos-keychain'; service: string; account: string }>
  | Readonly<{ provider: 'linux-protected-file'; path: string }>

export type StoreSecretFn = (locator: EasySecretLocator, secret: string) => Promise<void>

async function defaultStoreSecretFn(locator: EasySecretLocator, secret: string): Promise<void> {
  if (locator.provider === 'macos-keychain') {
    const hex = Buffer.from(secret, 'utf8').toString('hex')
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = nodeExecFile('/usr/bin/security', ['-i'], {
        timeout: 10_000,
        windowsHide: true,
      }, (error, _stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(`写入 macOS 钥匙串失败：${stderr.trim() || error.message}`))
          return
        }
        resolvePromise()
      })
      child.stdin?.end(`add-generic-password -U -a ${locator.account} -s ${locator.service} -X ${hex}\n`)
    })
    return
  }

  const dir = dirname(locator.path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (existsSync(locator.path)) {
    const st = lstatSync(locator.path)
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('凭据文件是符号链接，拒绝写入')
    }
  }
  const tmpPath = `${locator.path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, secret, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, locator.path)
  } catch (error) {
    try { unlinkSync(tmpPath) } catch { /* noop */ }
    throw error
  }
}

export interface ConfigureFeishuEasyInput {
  readonly host: AutonomyHostContext
  readonly descriptors: readonly SettingsDescriptor[]
  readonly settings: SettingsService | undefined
  readonly reloadEntry?: (entryId: string) => Promise<string>
  readonly appId: string
  readonly appSecret: string
  readonly account: string
  readonly tenant: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly now?: number
  readonly storeSecretFn?: StoreSecretFn
}

/** Foolproof Feishu setup: accepts App Secret in memory, seals it in OS vault, wires keychain handle & policy. */
export async function configureFeishuEasy(input: ConfigureFeishuEasyInput): Promise<OwnerConsoleWriteResult> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const now = input.now ?? Date.now()
  const paths = resolveProfilePaths(input.host, env)
  if (detectFrozenSystemdProfile(paths.dshHome, paths.profileName, platform, env)) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-enhanced-lark-channel',
      note: '当前为受控 Linux systemd 冻结实例，拒绝在线改写系统凭据或通道策略。',
    })
  }

  const resolvedAppId = input.appId.trim()
  if (!isAppId(resolvedAppId)) {
    return Object.freeze({ applied: false, entry: 'dsh-enhanced-lark-channel', note: 'App ID 必须形如 cli_0123456789abcdef' })
  }

  const secret = input.appSecret.trim()
  if (secret === '' || secret.length > 512 || hasControlChars(secret) || /[\r\n]/u.test(secret)) {
    return Object.freeze({ applied: false, entry: 'dsh-enhanced-lark-channel', note: 'App Secret 不能为空，且须为单行有效文本（最多 512 字符）' })
  }

  const larkDesc = findEntry(input.descriptors, ns => /(^|[-_/])lark(-channel)?($|[-_/])/u.test(ns))
  const currentLark = larkDesc ? boundedConfig(larkDesc.value) : {}
  const resolvedAccount = input.account.trim() !== ''
    ? input.account.trim()
    : (strOrNull(currentLark['account']) ?? 'primary')
  const resolvedTenant = input.tenant.trim() !== ''
    ? input.tenant.trim()
    : (strOrNull(currentLark['tenant']) ?? 'personal')

  if (!ACCOUNT_TOKEN.test(resolvedAccount)) {
    return Object.freeze({ applied: false, entry: 'dsh-enhanced-lark-channel', note: 'account 格式无效（需 1..41 位字母/数字/._@-）' })
  }
  if (!ACCOUNT_TOKEN.test(resolvedTenant)) {
    return Object.freeze({ applied: false, entry: 'dsh-enhanced-lark-channel', note: 'tenant 格式无效（需 1..41 位字母/数字/._@-）' })
  }

  if (!paths.writable || paths.patchPath === null || paths.canonicalHome === null) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-enhanced-lark-channel',
      note: '当前 profile 的 cordis.patch.yml 或 DSH_HOME 不可写入，无法保存加密凭据句柄。',
    })
  }

  if (platform !== 'darwin' && platform !== 'linux' && input.storeSecretFn === undefined) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-enhanced-lark-channel',
      note: `当前系统（${platform}）暂不支持一键写入系统凭据库，请改用「环境变量」或「Keychain Handle」模式。`,
    })
  }

  const versionHex = randomBytes(16).toString('hex')
  const locator: EasySecretLocator = platform === 'darwin'
    ? {
        provider: 'macos-keychain',
        service: `dsh/lark/${paths.profileName}/${resolvedAccount}/versions/${versionHex}`,
        account: resolvedAccount,
      }
    : {
        provider: 'linux-protected-file',
        path: join(paths.canonicalHome, 'credentials-keychain', `lark-${paths.profileName}-${resolvedAccount}-${versionHex}.secret`),
      }

  const storeFn = input.storeSecretFn ?? defaultStoreSecretFn
  try {
    await storeFn(locator, secret)
  } catch (error: unknown) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-enhanced-lark-channel',
      note: `保存 App Secret 到系统凭据库失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  const handleId = `lark-${paths.profileName}-${resolvedAccount}`
  const handleEntry = {
    id: handleId,
    provider: locator.provider,
    ...(locator.provider === 'macos-keychain'
      ? { service: locator.service, account: locator.account }
      : { path: locator.path }),
    consumers: ['dsh-enhanced-lark-channel'],
    purposes: ['connect'],
    maxLeaseMs: 86_400_000,
  }

  const doc = readPatchDocument(paths.patchPath)
  const seq = doc.contents as YAMLSeq

  const kcRow = ensurePatchRow(doc, seq, 'dsh-enhanced-credentials-keychain', '@dsh-enhanced/credentials-keychain')
  const kcCfg = ensureConfigMap(doc, kcRow, 'config')
  setMissingMapDefaults(doc, kcCfg, CREDENTIALS_KEYCHAIN_DEFAULTS)
  const existingHandles = isSeq(kcCfg.get('handles', true)) ? kcCfg.get('handles', true)!.toJSON() : []
  kcCfg.set('handles', doc.createNode(upsertById(existingHandles, [handleEntry])))

  const layoutInfo = getPersonalAndPolicyConfigs(seq, input.descriptors)
  let policyConfigNode: YAMLMap
  if (layoutInfo.layout === 'split') {
    const policyRow = ensurePatchRow(doc, seq, 'dsh-enhanced-assistant-policy', '@dsh-enhanced/assistant-policy')
    policyConfigNode = ensureConfigMap(doc, policyRow, 'config')
  } else {
    const paRow = ensurePatchRow(doc, seq, 'dsh-enhanced-personal-assistant', '@dsh-enhanced/personal-assistant')
    const paCfg = ensureConfigMap(doc, paRow, 'config')
    setMissingMapDefaults(doc, paCfg, PERSONAL_ASSISTANT_DEFAULTS)
    policyConfigNode = ensureConfigMap(doc, paCfg, 'assistantPolicy')
  }
  const credentialRule = {
    id: `lark-channel-credential-${resolvedAccount}`,
    effect: 'allow',
    subject: { kind: 'background', id: 'dsh-enhanced-lark-channel' },
    actions: ['credential.use'],
    resource: { kind: 'credential', id: handleId },
    context: { initiators: ['background'] },
  }
  const existingRules = isSeq(policyConfigNode.get('rules', true)) ? policyConfigNode.get('rules', true)!.toJSON() : layoutInfo.policyCfg['rules']
  policyConfigNode.set('rules', doc.createNode(upsertById(existingRules, [credentialRule])))

  const larkRow = ensurePatchRow(doc, seq, 'dsh-enhanced-lark-channel', '@dsh-enhanced/lark-channel')
  const larkCfg = ensureConfigMap(doc, larkRow, 'config')
  larkCfg.set('enabled', doc.createNode(true))
  larkCfg.set('appId', doc.createNode(resolvedAppId))
  larkCfg.set('account', doc.createNode(resolvedAccount))
  larkCfg.set('tenant', doc.createNode(resolvedTenant))
  larkCfg.set('secretSource', doc.createNode('handle'))
  larkCfg.set('credentialHandle', doc.createNode(handleId))
  larkCfg.delete('appSecretEnv')
  if (!larkCfg.has('connection') && typeof currentLark['connection'] === 'string' && isSingleLineCommand(currentLark['connection'])) {
    larkCfg.set('connection', doc.createNode(currentLark['connection']))
  }

  atomicWritePatchWithBackup(paths.patchPath, doc.toString({ lineWidth: 0 }), now)

  if (input.settings !== undefined && larkDesc !== undefined) {
    try {
      await input.settings.mutate(larkDesc.ns, [
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['appId'], value: resolvedAppId },
        { op: 'set', path: ['account'], value: resolvedAccount },
        { op: 'set', path: ['tenant'], value: resolvedTenant },
        { op: 'set', path: ['secretSource'], value: 'handle' },
        { op: 'set', path: ['credentialHandle'], value: handleId },
        { op: 'unset', path: ['appSecretEnv'] },
      ], larkDesc.revision)
    } catch {
      // Patch is already written cleanly; reload still helps pick it up.
    }
  }

  if (input.reloadEntry !== undefined) {
    for (const id of [
      'dsh-enhanced-credentials-keychain',
      layoutInfo.layout === 'split' ? 'dsh-enhanced-assistant-policy' : 'dsh-enhanced-personal-assistant',
      larkDesc?.ns ?? 'dsh-enhanced-lark-channel',
    ]) {
      try { await input.reloadEntry(id) } catch { /* best-effort live reload */ }
    }
  }

  return Object.freeze({
    applied: true,
    entry: larkDesc?.ns ?? 'dsh-enhanced-lark-channel',
    note: `已将 App Secret 安全存入系统凭据库（句柄 ${handleId}，配置文件零明文），并完成凭据策略授权与飞书连接配置；如未立即在线，请重启一次 profile 使新句柄生效。`,
  })
}
