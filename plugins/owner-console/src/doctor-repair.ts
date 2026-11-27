import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Document, isMap, isScalar, isSeq, YAMLMap, YAMLSeq } from 'yaml'
import {
  findEntry, hasControlChars, isAppId,
  type PluginManagerService, type SettingsDescriptor, type SettingsService,
} from './settings.js'
import { type CodingToolId, type CodingToolProber } from './probes.js'
import type {
  FeishuQrOwnerBinding, OwnerConsoleStatus, OwnerConsoleWriteResult, ProfileRestartMode, SetupDoctorIssue, SetupDoctorReport,
} from './typert.js'
import { detectFrozenSystemdProfile } from './upgrade-probe.js'
import {
  asPlainRecord, atomicWritePatchWithBackup, canonicalObjectDigest, checkScopedDbPath, createPlainNode,
  ensureConfigMap, ensurePatchRow, ensureVerifierDefaults, externalPrincipalId, findPatchRow,
  formatGrantIdWithGeneration, getPatchRowConfig, getPatchRowConfigNode, getPersonalAndPolicyConfigs,
  inspectMemoryLearningGrantConflicts, inspectOwnerRoute, jsDshHomeScalar, mergeDescriptorConfig,
  normalizeLearningConfigForDigest, normalizeMemoryGrantForDigest, normalizeProfileSlug, pruneStaleOwnerRouteRules,
  readConfigMap, readPatchDocument, resolveProfilePaths, resolveScopedDbTarget, strOrNull,
  syncPrimaryOwnerRoutes, upsertById, yamlNodeToJs, type AutonomyHostContext, type ProfilePaths,
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
  { pkg: '@dsh-ray/assistant-policy', rowId: 'dsh-ray-assistant-policy', section: 'assistantPolicy' },
  { pkg: '@dsh-ray/assistant-automations', rowId: 'dsh-ray-assistant-automations', section: 'assistantAutomations' },
  { pkg: '@dsh-ray/personal-memory', rowId: 'dsh-ray-personal-memory', section: 'personalMemory' },
  { pkg: '@dsh-ray/personal-wiki', rowId: 'dsh-ray-personal-wiki', section: 'personalWiki' },
] as const

/** Core infrastructure bundles that Doctor must never auto-disable via generic `stalled-bundle:*`,
 * because disabling them cascades into missing Policy/Delivery/Feishu dependencies. */
const PROTECTED_CORE_BUNDLES = new Set([
  '@dsh-ray/owner-console',
  '@dsh-ray/personal-assistant',
  '@dsh-ray/assistant-policy',
  '@dsh-ray/personal-memory',
  '@dsh-ray/personal-wiki',
  '@dsh-ray/assistant-automations',
  '@dsh-ray/assistant-delivery',
  '@dsh-ray/credentials-keychain',
  '@dsh-ray/lark-channel',
  '@dsh-ray/assistant-verifier',
])

const SCOPED_STATE_BUNDLES = [
  { pkg: '@dsh-ray/assistant-goals', rowId: 'dsh-ray-assistant-goals', subdir: 'assistant-goals' },
  { pkg: '@dsh-ray/assistant-dreaming', rowId: 'dsh-ray-assistant-dreaming', subdir: 'assistant-dreaming' },
  { pkg: '@dsh-ray/assistant-proactive', rowId: 'dsh-ray-assistant-proactive', subdir: 'assistant-proactive' },
  { pkg: '@dsh-ray/assistant-work-items', rowId: 'dsh-ray-assistant-work-items', subdir: 'assistant-work-items' },
] as const

const PERSONAL_ASSISTANT_DEFAULTS: Readonly<Record<string, unknown>> = {
  assistantPolicy: {
    databasePath: jsRef('assistant-policy/policy.sqlite'),
    rules: [
      {
        id: 'dsh-ray-foreground-capability-*',
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

const SETUP_KEY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const KEYCHAIN_LOCATOR_TOKEN = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,127}$/u
const PRESET_ID_TOKEN = /^[a-z0-9][a-z0-9-]*$/u
const DSH_HOME_EXPR = /^dshHomePath\(\s*(['"])([A-Za-z0-9._/-]+)\1\s*\)$/u
const LARK_OPEN_ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
export const PLACEHOLDER_LARK_APP_ID = 'cli_0000000000000000'
export const PLACEHOLDER_LARK_TENANT = 'replace-with-tenant-key'

const LARK_APPROVAL_SOURCES = [
  'dsh-ray-personal-memory',
  'dsh-ray-personal-wiki',
  'dsh-ray-assistant-automations',
  'dsh-ray-assistant-evolution',
] as const

function isAliasMangledObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec)
  return keys.length === 1 && typeof rec['source'] === 'string' && /^a\d+$/u.test(rec['source'])
}

export function hasAliasMangledPolicyRules(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false
  return rules.some(item => {
    const rec = asPlainRecord(item)
    return isAliasMangledObject(rec['subject']) || isAliasMangledObject(rec['context'])
  })
}

export function repairAliasMangledPolicyRules(rules: unknown): Readonly<{
  rules: readonly Record<string, unknown>[]
  repairedCount: number
  removedCount: number
}> {
  if (!Array.isArray(rules)) return { rules: [], repairedCount: 0, removedCount: 0 }
  const list = rules.map(asPlainRecord)
  const memExtractRule = list.find(r =>
    typeof r['id'] === 'string' && /^wizard-[^-]+-mem-extract-/u.test(r['id']) && !isAliasMangledObject(r['subject']))
  const memSubjectTemplate = memExtractRule !== undefined ? asPlainRecord(memExtractRule['subject']) : null
  const growthToolRule = list.find(r =>
    typeof r['id'] === 'string' && /^wizard-[^-]+-growth-tools-/u.test(r['id']) && !isAliasMangledObject(r['subject']))
  const agentSubjectTemplate = growthToolRule !== undefined ? asPlainRecord(growthToolRule['subject']) : null

  const out: Record<string, unknown>[] = []
  let repairedCount = 0
  let removedCount = 0

  for (const raw of list) {
    const rule = { ...raw }
    const id = typeof rule['id'] === 'string' ? rule['id'] : ''
    let subjectBroken = isAliasMangledObject(rule['subject'])
    let contextBroken = isAliasMangledObject(rule['context'])
    if (!subjectBroken && !contextBroken) {
      out.push(rule)
      continue
    }

    if (contextBroken && /^wizard-[^-]+-(?:mem|usage|growth-tools|verified-workflows)-/u.test(id)) {
      rule['context'] = { initiators: ['background'] }
      contextBroken = false
    }
    if (subjectBroken && /^wizard-[^-]+-mem-(?:review|adopt|scan-reconcile|job-reconcile)-/u.test(id) && memSubjectTemplate !== null && typeof memSubjectTemplate['kind'] === 'string') {
      rule['subject'] = { ...memSubjectTemplate }
      subjectBroken = false
    } else if (subjectBroken && /^wizard-[^-]+-verified-workflows-/u.test(id) && agentSubjectTemplate !== null && typeof agentSubjectTemplate['kind'] === 'string') {
      rule['subject'] = { ...agentSubjectTemplate }
      subjectBroken = false
    }

    if (subjectBroken || contextBroken) {
      removedCount += 1
      continue
    }
    repairedCount += 1
    out.push(rule)
  }

  return { rules: out, repairedCount, removedCount }
}

export function hasAutonomyGrantsForOtherPrincipal(
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
  targetPrincipalId: string | undefined,
): boolean {
  if (targetPrincipalId === undefined || targetPrincipalId === '') return false
  const readCfg = (rowId: string) => mergeDescriptorConfig(
    descriptors,
    rowId,
    seq ? getPatchRowConfig(seq, rowId) : {},
  )
  const candidates: unknown[] = []
  const memCfg = readCfg('dsh-ray-assistant-memory-learning')
  candidates.push(asPlainRecord(memCfg['owner'])['principalId'])
  const verifierCfg = readCfg('dsh-ray-assistant-verifier')
  candidates.push(asPlainRecord(asPlainRecord(verifierCfg['memoryReviews'])['owner'])['principalId'])
  const dreamCfg = readCfg('dsh-ray-assistant-dreaming')
  if (dreamCfg['enabled'] === true && dreamCfg['retired'] !== true) {
    candidates.push(asPlainRecord(dreamCfg['scope'])['principalId'])
  }
  const growthCfg = readCfg('dsh-ray-assistant-growth-driver')
  if (growthCfg['enabled'] === true) {
    candidates.push(asPlainRecord(growthCfg['scope'])['principalId'])
  }
  const layout = getPersonalAndPolicyConfigs(seq, descriptors)
  const adoptCfg = asPlainRecord(layout.personalMemoryCfg['automaticLearning'])
  candidates.push(asPlainRecord(adoptCfg['owner'])['principalId'])

  return candidates.some(value => typeof value === 'string' && value.trim() !== '' && value.trim() !== targetPrincipalId)
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
      target.set(key, createPlainNode(doc, val))
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
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      bundles?: unknown
      dependencies?: unknown
      dsh?: { profile?: { bundles?: unknown } }
    }
    if (parsed.bundles !== null && typeof parsed.bundles === 'object' && !Array.isArray(parsed.bundles)) {
      const out: Record<string, boolean> = {}
      for (const [name, enabled] of Object.entries(parsed.bundles as Record<string, unknown>)) {
        if (typeof enabled === 'boolean') out[name] = enabled
      }
      return out
    }
    const profileBundles = parsed.dsh?.profile?.bundles
    if (Array.isArray(profileBundles)) {
      const enabledSet = new Set(profileBundles.filter((item): item is string => typeof item === 'string'))
      const out: Record<string, boolean> = {}
      if (parsed.dependencies !== null && typeof parsed.dependencies === 'object' && !Array.isArray(parsed.dependencies)) {
        for (const depName of Object.keys(parsed.dependencies as Record<string, unknown>)) {
          if (depName.startsWith('@dsh-ray/')) out[depName] = enabledSet.has(depName)
        }
      }
      for (const pkg of enabledSet) {
        if (pkg.startsWith('@dsh-ray/')) out[pkg] = true
      }
      return out
    }
    return {}
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
  let changed = false
  if (parsed['bundles'] !== null && typeof parsed['bundles'] === 'object' && !Array.isArray(parsed['bundles'])) {
    const bundles = asPlainRecord(parsed['bundles'])
    for (const [pkg, enabled] of Object.entries(updates)) {
      if (Object.hasOwn(bundles, pkg) && bundles[pkg] !== enabled) {
        bundles[pkg] = enabled
        changed = true
      }
    }
    if (changed) parsed['bundles'] = bundles
  } else {
    const dsh = asPlainRecord(parsed['dsh'])
    const profile = asPlainRecord(dsh['profile'])
    if (Array.isArray(profile['bundles'])) {
      const list = profile['bundles'].filter((item): item is string => typeof item === 'string')
      const deps = asPlainRecord(parsed['dependencies'])
      for (const [pkg, enabled] of Object.entries(updates)) {
        const idx = list.indexOf(pkg)
        if (enabled) {
          if (idx === -1 && Object.hasOwn(deps, pkg)) {
            list.push(pkg)
            changed = true
          }
        } else if (idx !== -1) {
          list.splice(idx, 1)
          changed = true
        }
      }
      if (changed) {
        profile['bundles'] = list
        dsh['profile'] = profile
        parsed['dsh'] = dsh
      }
    }
  }
  if (!changed) return false

  if (paths.canonicalHome !== null) {
    const backupDir = join(paths.canonicalHome, '.dsh-ray-upgrade-backups', `doctor-${now}`)
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
      `SELECT id, version, principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active' ORDER BY version DESC LIMIT 32`,
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

interface LinkedLarkIngressInfo {
  readonly account: string
  readonly tenant: string
  readonly openId: string
  readonly principalKey: string
  readonly currentOwnerKey: string
}

/** Detect when the active Feishu ingress policy identity is only `linked` (not `owner`), blocking long-term memory & owner commands. */
function detectLinkedLarkIngressAccount(
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
  deliveryDbPath: string | null,
): LinkedLarkIngressInfo | null {
  if (deliveryDbPath === null || !existsSync(deliveryDbPath)) return null
  const larkCfg = mergeDescriptorConfig(
    descriptors,
    'dsh-ray-lark-channel',
    seq ? getPatchRowConfig(seq, 'dsh-ray-lark-channel') : {},
  )
  const rawAccount = strOrNull(larkCfg['account']) ?? 'primary'
  const rawTenant = strOrNull(larkCfg['tenant']) ?? 'personal'
  const account = SETUP_KEY_TOKEN.test(rawAccount) && !rawAccount.includes('-legacy-') ? rawAccount : 'primary'
  const tenant = SETUP_KEY_TOKEN.test(rawTenant) && rawTenant !== PLACEHOLDER_LARK_TENANT ? rawTenant : 'personal'

  const policyLayout = getPersonalAndPolicyConfigs(seq, descriptors)
  const rules = Array.isArray(policyLayout.policyCfg['rules']) ? policyLayout.policyCfg['rules'] : []
  const ingressRule = rules.map(asPlainRecord).find(rule => rule['id'] === `lark-owner-ingress-${account}`)
  const subjectId = ingressRule ? strOrNull(asPlainRecord(ingressRule['subject'])['id']) : null
  const prefix = `lark/${account}/${tenant}/`
  if (subjectId === null || !subjectId.startsWith(prefix)) return null
  const openId = subjectId.slice(prefix.length)
  if (!LARK_OPEN_ID_TOKEN.test(openId)) return null

  let db: DatabaseSync | undefined
  try {
    const st = lstatSync(deliveryDbPath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    db = new DatabaseSync(deliveryDbPath, { readOnly: true })
    const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_principals'`).get() as { name?: unknown } | undefined
    if (tbl?.name !== 'delivery_principals') return null
    const json = JSON.stringify({ channel: 'lark', account, tenant, user: openId })
    const hash = createHash('sha256').update(json, 'utf8').digest('hex')
    const ingressRow = db.prepare(
      `SELECT role, status, principal_json FROM delivery_principals WHERE key_hash = ? AND principal_json = ?`,
    ).get(hash, json) as Readonly<{ role?: unknown; status?: unknown; principal_json?: unknown }> | undefined
    if (ingressRow?.role !== 'linked' || ingressRow?.status !== 'active') return null

    const owners = db.prepare(
      `SELECT principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active' LIMIT 4`,
    ).all() as ReadonlyArray<{ principal_json?: unknown }>
    for (const ownerRow of owners) {
      if (typeof ownerRow.principal_json !== 'string') continue
      let parsed: Record<string, unknown>
      try {
        parsed = asPlainRecord(JSON.parse(ownerRow.principal_json))
      } catch {
        continue
      }
      const ownerKey = externalPrincipalId(parsed)
      if (ownerKey !== null && ownerKey !== subjectId) {
        return {
          account,
          tenant,
          openId,
          principalKey: subjectId,
          currentOwnerKey: ownerKey,
        }
      }
    }
    return null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* noop */ }
  }
}

function resolveDeliveryDbPathForProfile(
  canonicalHome: string | null,
  seq: YAMLSeq | undefined,
  descriptors: readonly SettingsDescriptor[],
): string | null {
  if (canonicalHome === null) return null
  const deliveryNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-delivery') : undefined
  const deliveryCfg = mergeDescriptorConfig(
    descriptors,
    'dsh-ray-assistant-delivery',
    seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-delivery') : {},
  )
  const scopedDb = checkScopedDbPath(deliveryNode?.get('databasePath', true) ?? deliveryCfg['databasePath'], canonicalHome)
  return scopedDb.resolved ?? join(canonicalHome, 'assistant-delivery', 'state.sqlite')
}

function ensurePolicyConfigTarget(
  doc: Document,
  seq: YAMLSeq,
  descriptors: readonly SettingsDescriptor[],
  manifestBundles?: Readonly<Record<string, boolean>>,
  statusBundles: OwnerConsoleStatus['bundles'] = [],
): Readonly<{
  useSplitPolicy: boolean
  effectivePolicyCfg: Record<string, unknown>
  policyConfigNode: YAMLMap
  existingRulesBeforeDefaults: unknown
}> {
  const layoutInfo = getPersonalAndPolicyConfigs(seq, descriptors)
  const hasPaRowOrDesc = findPatchRow(seq, 'dsh-ray-personal-assistant') !== undefined
    || findEntry(descriptors, ns => ns === 'dsh-ray-personal-assistant') !== undefined
    || (manifestBundles !== undefined && isBundleInstalled('@dsh-ray/personal-assistant', 'dsh-ray-personal-assistant', manifestBundles, statusBundles, seq))
  const splitPolicyDesc = findEntry(descriptors, ns => ns === 'dsh-ray-assistant-policy')
  const splitInstalled = splitPolicyDesc !== undefined
    || (manifestBundles !== undefined && isBundleInstalled('@dsh-ray/assistant-policy', 'dsh-ray-assistant-policy', manifestBundles, statusBundles, seq))
  const useSplitPolicy = layoutInfo.layout === 'split' || (!hasPaRowOrDesc && splitInstalled)
  const effectivePolicyCfg = useSplitPolicy
    ? { ...asPlainRecord(splitPolicyDesc?.value), ...getPatchRowConfig(seq, 'dsh-ray-assistant-policy', doc) }
    : layoutInfo.policyCfg

  let policyConfigNode: YAMLMap
  let existingRulesBeforeDefaults: unknown
  if (useSplitPolicy) {
    const policyRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-policy', '@dsh-ray/assistant-policy')
    if (policyRow.get('disabled') === true) policyRow.delete('disabled')
    policyConfigNode = ensureConfigMap(doc, policyRow, 'config')
    existingRulesBeforeDefaults = isSeq(policyConfigNode.get('rules', true))
      ? yamlNodeToJs(policyConfigNode.get('rules', true), doc)
      : effectivePolicyCfg['rules']
    // Cordis patch config is a whole-value replacement: restate required databasePath and surviving split-policy keys.
    const splitPolicyDefaults: Record<string, unknown> = {
      databasePath: jsRef('assistant-policy/policy.sqlite'),
      budgets: Array.isArray(effectivePolicyCfg['budgets']) ? effectivePolicyCfg['budgets'] : [],
    }
    for (const key of ['proposalMaintenanceIntervalMs', 'toolDefaultEffect', 'autoReview'] as const) {
      if (effectivePolicyCfg[key] !== undefined) splitPolicyDefaults[key] = effectivePolicyCfg[key]
    }
    setMissingMapDefaults(doc, policyConfigNode, splitPolicyDefaults)
  } else {
    const paRow = ensurePatchRow(doc, seq, 'dsh-ray-personal-assistant', '@dsh-ray/personal-assistant')
    if (paRow.get('disabled') === true) paRow.delete('disabled')
    const paCfg = ensureConfigMap(doc, paRow, 'config')
    const existingPolicyNode = readConfigMap(paCfg, 'assistantPolicy')
    existingRulesBeforeDefaults = isSeq(existingPolicyNode?.get('rules', true))
      ? yamlNodeToJs(existingPolicyNode!.get('rules', true), doc)
      : (Array.isArray(effectivePolicyCfg['rules']) && effectivePolicyCfg['rules'].length > 0
          ? effectivePolicyCfg['rules']
          : undefined)
    setMissingMapDefaults(doc, paCfg, PERSONAL_ASSISTANT_DEFAULTS)
    policyConfigNode = ensureConfigMap(doc, paCfg, 'assistantPolicy')
  }
  return { useSplitPolicy, effectivePolicyCfg, policyConfigNode, existingRulesBeforeDefaults }
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
  const acpPlugin = input.status.plugins.find(p => p.moduleName === '@dsh-ray/acp')
  const guiPresent = input.status.plugins.some(p => p.moduleName === '@deepseek-ai/dsh-web-app')
    || paths.profileName === 'desktop' || paths.profileName === 'web'
    || /DUPLICATE INSERT ID:\s*cordis-host-runner/iu.test(acpPlugin?.diagnostic ?? '')
  const acpEnabled = isBundleEnabled('@dsh-ray/acp', 'dsh-ray-acp', manifestBundles, input.status.bundles, seq)
  if (acpEnabled && guiPresent) {
    coveredPackages.add('@dsh-ray/acp')
    issues.push({
      id: 'gui-stdio-acp-conflict',
      severity: 'error',
      category: 'plugins',
      title: '@dsh-ray/acp 与桌面/Web 端内置 Host 冲突',
      detail: '桌面端与 Web 端已内置 `@deepseek-ai/dsh-web-app`（cordis-host-runner），同时启用 `@dsh-ray/acp` 会触发 DUPLICATE INSERT ID 冲突；停用 `@dsh-ray/acp` 即可恢复正常。',
      autoFixable: mutatable,
      fixLabel: '停用冲突的 @dsh-ray/acp',
    })
  }

  const isolationEnabled = isBundleEnabled(
    '@dsh-ray/assistant-isolation',
    'dsh-ray-assistant-isolation',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const isolationCfg = mergeDescriptorConfig(
    input.descriptors,
    'dsh-ray-assistant-isolation',
    seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-isolation') : {},
  )
  const rawIsolationBackend = isolationCfg['backend']
  const isolationBackend = rawIsolationBackend === undefined
    ? 'auto'
    : (typeof rawIsolationBackend === 'string' ? rawIsolationBackend : '__invalid__')
  const expectedPlatformByBackend: Readonly<Record<string, NodeJS.Platform>> = {
    'linux-native': 'linux',
    'macos-seatbelt': 'darwin',
    'windows-job': 'win32',
  }
  const autoSupportedPlatforms = new Set<NodeJS.Platform>(['linux', 'darwin', 'win32'])
  const expectedPlatform = Object.hasOwn(expectedPlatformByBackend, isolationBackend)
    ? expectedPlatformByBackend[isolationBackend]
    : undefined
  const isolationPlatformUnsupported = isolationEnabled && (
    isolationBackend === 'auto'
      ? !autoSupportedPlatforms.has(platform)
      : expectedPlatform !== undefined
        ? platform !== expectedPlatform
        : true
  )
  if (isolationPlatformUnsupported) {
    coveredPackages.add('@dsh-ray/assistant-isolation')
    issues.push({
      id: 'unsupported-platform-isolation',
      severity: 'error',
      category: 'plugins',
      title: '@dsh-ray/assistant-isolation 后端与当前系统不兼容',
      detail: `当前系统为 ${platform}，配置的隔离后端为 \`${isolationBackend}\`（支持平台：auto 支持 linux/darwin/win32，linux-native 仅支持 linux，macos-seatbelt 仅支持 darwin，windows-job 仅支持 win32）；停用该插件或调整 backend 配置即可消除异常。`,
      autoFixable: mutatable,
      fixLabel: '停用不兼容的隔离插件',
    })
  }

  const paEnabled = isBundleEnabled(
    '@dsh-ray/personal-assistant',
    'dsh-ray-personal-assistant',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const collidingSplits = SPLIT_PA_PACKAGES.filter(spec =>
    isBundleEnabled(spec.pkg, spec.rowId, manifestBundles, input.status.bundles, seq))
  if (paEnabled && collidingSplits.length > 0) {
    for (const spec of collidingSplits) coveredPackages.add(spec.pkg)
    coveredPackages.add('@dsh-ray/personal-assistant')
    issues.push({
      id: 'personal-assistant-split-collision',
      severity: 'error',
      category: 'plugins',
      title: 'personal-assistant 与拆分版子插件重复挂载',
      detail: `已同时启用组合包 \`@dsh-ray/personal-assistant\` 与子插件 ${collidingSplits.map(s => `\`${s.pkg}\``).join('、')}，会导致服务重复注入或配置覆盖。自动修复会将策略自定义项（如 \`toolDefaultEffect\`、\`autoReview\`、自定义规则/预算）迁移并合并进 \`personal-assistant\` 后安全停用重复子插件。`,
      autoFixable: mutatable,
      fixLabel: '合并重复子插件并保留策略',
    })
  }

  const paInstalled = isBundleInstalled(
    '@dsh-ray/personal-assistant',
    'dsh-ray-personal-assistant',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const splitPolicyInstalled = isBundleInstalled(
    '@dsh-ray/assistant-policy',
    'dsh-ray-assistant-policy',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const splitPolicyEnabled = isBundleEnabled(
    '@dsh-ray/assistant-policy',
    'dsh-ray-assistant-policy',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const larkEnabledForPolicy = isBundleEnabled(
    '@dsh-ray/lark-channel',
    'dsh-ray-lark-channel',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const deliveryEnabledForPolicy = isBundleEnabled(
    '@dsh-ray/assistant-delivery',
    'dsh-ray-assistant-delivery',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const policyDepUnavailable = input.status.dependencies.some(d => d.name === 'assistantPolicy' && !d.available)
  if (!paEnabled && !splitPolicyEnabled && (policyDepUnavailable || larkEnabledForPolicy || deliveryEnabledForPolicy)) {
    const recoveryPkg = paInstalled
      ? '@dsh-ray/personal-assistant'
      : splitPolicyInstalled
        ? '@dsh-ray/assistant-policy'
        : undefined
    if (recoveryPkg !== undefined) {
      coveredPackages.add(recoveryPkg)
      issues.push({
        id: 'disabled-core-policy-provider',
        severity: 'error',
        category: 'plugins',
        title: `核心策略组件 ${recoveryPkg} 已停用，导致飞书与消息投递无法启动`,
        detail: `assistantPolicy 服务由已安装的 \`${recoveryPkg}\` 提供；当前处于停用状态，导致 \`assistant-delivery\` 与飞书通道（\`lark-channel\`）一直处于「等待依赖服务」。一键恢复启用并重启 profile 即可恢复策略、记忆与飞书连接（无需另行安装拆分版 assistant-policy）。`,
        autoFixable: mutatable,
        fixLabel: recoveryPkg === '@dsh-ray/personal-assistant'
          ? '一键恢复启用 personal-assistant'
          : '一键恢复启用 assistant-policy',
      })
    }
  }

  if (seq !== undefined) {
    const grantConflict = inspectMemoryLearningGrantConflicts(paths, seq, input.descriptors)
    if (grantConflict.hasConflict) {
      coveredPackages.add('@dsh-ray/personal-assistant')
      coveredPackages.add('@dsh-ray/personal-memory')
      coveredPackages.add('@dsh-ray/assistant-memory-learning')
      issues.push({
        id: 'memory-learning-grant-conflict',
        severity: 'error',
        category: 'autonomy',
        title: '记忆自学习授权 ID 与本地账本冲突，导致核心策略与飞书无法启动',
        detail: `${grantConflict.reasons.join('；')}。历史已冻结账本不可覆盖，需轮换新的授权代数（-gN）并同步重算摘要与策略规则，重启后即可恢复 personal-assistant、策略与飞书连接。`,
        autoFixable: mutatable,
        fixLabel: '轮换记忆自学习授权 ID 并恢复启动',
      })
    }
  }

  const verifierEnabled = isBundleEnabled(
    '@dsh-ray/assistant-verifier',
    'dsh-ray-assistant-verifier',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  if (verifierEnabled) {
    const verifierPlugin = input.status.plugins.find(p => p.moduleName === '@dsh-ray/assistant-verifier')
    const verifierBundle = input.status.bundles.find(b => b.name === '@dsh-ray/assistant-verifier')
    const verifierPatchNode = seq ? getPatchRowConfigNode(seq, 'dsh-ray-assistant-verifier') : undefined
    const verifierDiag = `${verifierPlugin?.diagnostic ?? ''} ${verifierBundle?.error?.diagnostic ?? ''}`
    const verifierDbMissingInPatch = verifierPatchNode !== undefined
      && checkScopedDbPath(verifierPatchNode.get('databasePath', true), paths.canonicalHome).display === null
    const verifierMissingDbCrash = (verifierPlugin?.fiberPhase === 'failed' || verifierBundle?.error?.code === 'CONFIG_ERROR')
      && /databasePath/iu.test(verifierDiag)
    if (verifierDbMissingInPatch || verifierMissingDbCrash) {
      coveredPackages.add('@dsh-ray/assistant-verifier')
      issues.push({
        id: 'missing-verifier-database-path',
        severity: 'error',
        category: 'config',
        title: 'assistant-verifier 缺少必填 databasePath 配置',
        detail: 'cordis.patch.yml 中的 assistant-verifier 覆盖行未保留 databasePath，导致插件加载失败（invalid config: $.databasePath missing required value）。自动修复会补齐默认 databasePath 并完整保留 memoryReviews 等评审配置，无需停用插件。',
        autoFixable: mutatable,
        fixLabel: '一键补齐 verifier 数据库路径',
      })
    }
    const verifierMergedCfg = mergeDescriptorConfig(
      input.descriptors,
      'dsh-ray-assistant-verifier',
      seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-verifier') : {},
    )
    const verifierProfiles = verifierMergedCfg['profiles']
    if (verifierMergedCfg['requireAcceptance'] === true && (!Array.isArray(verifierProfiles) || verifierProfiles.length === 0)) {
      coveredPackages.add('@dsh-ray/assistant-verifier')
      issues.push({
        id: 'verifier-require-acceptance-without-profiles',
        severity: 'error',
        category: 'config',
        title: 'assistant-verifier 在空 profiles 下启用了 requireAcceptance，会阻塞日常对话',
        detail: '检测到 assistant-verifier 的 profiles 为空但 requireAcceptance 为 true，会导致所有日常消息在验收预检阶段被拦截。自动修复会将 requireAcceptance 设为 false，同时完整保留 databasePath 与评审配置。',
        autoFixable: mutatable,
        fixLabel: '一键修复 verifier 验收阻断配置',
      })
    }
  }

  if (seq !== undefined) {
    const policyLayout = getPersonalAndPolicyConfigs(seq, input.descriptors)
    if (hasAliasMangledPolicyRules(policyLayout.policyCfg['rules'])) {
      issues.push({
        id: 'corrupted-policy-alias-rules',
        severity: 'error',
        category: 'config',
        title: 'assistantPolicy 存在损坏的 YAML 别名规则',
        detail: '检测到 cordis.patch.yml 中部分策略规则的 subject/context 被序列化为 { source: a1 }，可能导致重启后策略校验失败。自动修复会将这些规则还原为标准平铺结构。',
        autoFixable: mutatable,
        fixLabel: '一键修复损坏的策略规则',
      })
    }
  }

  const memLearningEnabled = isBundleEnabled(
    '@dsh-ray/assistant-memory-learning',
    'dsh-ray-assistant-memory-learning',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  if (memLearningEnabled) {
    const memPlugin = input.status.plugins.find(p => p.moduleName === '@dsh-ray/assistant-memory-learning')
    const memBundle = input.status.bundles.find(b => b.name === '@dsh-ray/assistant-memory-learning')
    const memCfg = mergeDescriptorConfig(
      input.descriptors,
      'dsh-ray-assistant-memory-learning',
      seq ? getPatchRowConfig(seq, 'dsh-ray-assistant-memory-learning') : {},
    )
    const missingGrantFields = typeof memCfg['authorityId'] !== 'string'
      || typeof memCfg['reviewAuthorityDigest'] !== 'string'
      || typeof memCfg['adoptionGrantDigest'] !== 'string'
    const crashedConfig = memPlugin?.fiberPhase === 'failed'
      || memBundle?.error?.code === 'CONFIG_ERROR'
      || /Invalid memory learning/iu.test(`${memPlugin?.diagnostic ?? ''} ${memBundle?.error?.diagnostic ?? ''}`)
    if (missingGrantFields || crashedConfig) {
      coveredPackages.add('@dsh-ray/assistant-memory-learning')
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
    '@dsh-ray/assistant-delivery',
    'dsh-ray-assistant-delivery',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  const deliveryEnabled = isBundleEnabled(
    '@dsh-ray/assistant-delivery',
    'dsh-ray-assistant-delivery',
    manifestBundles,
    input.status.bundles,
    seq,
  )
  if (deliveryInstalled && deliveryEnabled && seq !== undefined) {
    const deliveryDbPath = resolveDeliveryDbPathForProfile(paths.canonicalHome, seq, input.descriptors)
    const routeInfo = inspectOwnerRoute(input.host, paths, seq, input.descriptors)
    if (!routeInfo.configured || !routeInfo.active) {
      const sqliteSnapshot = readDeliverySqliteSnapshot(deliveryDbPath)
      const webOwnerInstalled = isBundleInstalled(
        '@dsh-ray/assistant-web-owner',
        'dsh-ray-assistant-web-owner',
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

    const larkEnabled = isBundleEnabled(
      '@dsh-ray/lark-channel',
      'dsh-ray-lark-channel',
      manifestBundles,
      input.status.bundles,
      seq,
    )
    if (larkEnabled) {
      const linkedLark = detectLinkedLarkIngressAccount(seq, input.descriptors, deliveryDbPath)
      if (linkedLark !== null) {
        issues.push({
          id: 'lark-linked-not-primary-owner',
          severity: 'warn',
          category: 'autonomy',
          title: '当前飞书账号仍为关联身份（linked），无法使用长期记忆与主人命令',
          detail: `当前接入的飞书账号（${linkedLark.openId}）以关联身份挂载在旧主主人（${linkedLark.currentOwnerKey}）名下，因此飞书私聊读写长期记忆会提示「无已认证的 owner 命名空间」，且 /permission、/model 与审批卡片不可用。请在「远程接入（飞书）」确认点击「一键将当前飞书账号设为主主人」并重启 profile 生效。`,
          autoFixable: false,
          fixLabel: '需确认设为飞书主主人',
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
    if (!bundle.name.startsWith('@dsh-ray/')) continue
    if (bundle.name === '@dsh-ray/owner-console') continue
    if (coveredPackages.has(bundle.name)) continue
    if (!bundle.installed || !bundle.enabled) continue
    const plugin = input.status.plugins.find(p => p.moduleName === bundle.name)
    if (bundle.error === undefined && plugin?.fiberPhase !== 'failed') continue
    const diag = plugin?.diagnostic ?? bundle.error?.diagnostic ?? bundle.error?.code ?? '未知异常'
    if (PROTECTED_CORE_BUNDLES.has(bundle.name)) {
      issues.push({
        id: `core-bundle-failed:${bundle.name}`,
        severity: 'error',
        category: 'plugins',
        title: `核心组件 ${bundle.name} 当前未就绪`,
        detail: `诊断信息：${diag.slice(0, 200)}。该组件为策略/消息/飞书核心依赖，自动体检不会停用它；如刚保存过非易失配置，直接重启 profile 即可恢复，否则请检查配置日志。`,
        autoFixable: false,
        fixLabel: '核心组件不自动停用，请先重启 profile',
      })
      continue
    }
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
    if (source[key] !== undefined) targetPolicy.set(key, createPlainNode(doc, source[key]))
  }
  const srcRules = Array.isArray(source['rules']) ? source['rules'].map(asPlainRecord) : []
  if (srcRules.length > 0) {
    const existing = targetPolicy.get('rules', true)
    const existingList = isSeq(existing) ? yamlNodeToJs(existing, doc) : []
    targetPolicy.set('rules', createPlainNode(doc, upsertById(existingList, srcRules)))
  }
  const srcBudgets = Array.isArray(source['budgets']) ? source['budgets'].map(asPlainRecord) : []
  if (srcBudgets.length > 0) {
    const existing = targetPolicy.get('budgets', true)
    const existingList = isSeq(existing) ? yamlNodeToJs(existing, doc) : []
    targetPolicy.set('budgets', createPlainNode(doc, upsertById(existingList, srcBudgets)))
  }
  const known = new Set(['databasePath', 'rules', 'budgets', 'toolDefaultEffect', 'autoReview'])
  for (const [k, v] of Object.entries(source)) {
    if (!known.has(k) && v !== undefined && !targetPolicy.has(k)) {
      targetPolicy.set(k, createPlainNode(doc, v))
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
  // Restoring a disabled core policy provider must also rotate any conflicting memory-learning grant
  // that would immediately crash personal-assistant / personal-memory again on next boot.
  if (wanted.has('disabled-core-policy-provider')) {
    wanted.add('memory-learning-grant-conflict')
  }
  const targets = report.issues.filter(issue =>
    (issue.autoFixable && (wanted.size === 0 || wanted.has(issue.id)))
    || (issue.id === 'lark-linked-not-primary-owner' && wanted.has(issue.id) && report.writable && !report.frozenSystemdProfile))
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
  const postPatchEnableBundles: string[] = []
  const notes: string[] = []
  let needsRestart = false
  let promoteLinkedLark = false

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
    if (issue.id === 'lark-linked-not-primary-owner') {
      promoteLinkedLark = true
      continue
    }
    if (issue.id === 'gui-stdio-acp-conflict') {
      await disableBundle('@dsh-ray/acp', 'dsh-ray-acp', '@dsh-ray/acp')
      continue
    }
    if (issue.id === 'unsupported-platform-isolation') {
      await disableBundle('@dsh-ray/assistant-isolation', 'dsh-ray-assistant-isolation', '@dsh-ray/assistant-isolation')
      continue
    }
    if (issue.id === 'missing-verifier-database-path') {
      const verifierRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-verifier', '@dsh-ray/assistant-verifier')
      verifierRow.delete('disabled')
      const verifierCfg = ensureConfigMap(doc, verifierRow, 'config')
      const runtimeVerifierDesc = findEntry(input.descriptors, candidate => candidate === 'dsh-ray-assistant-verifier')
      ensureVerifierDefaults(doc, verifierCfg, runtimeVerifierDesc ? asPlainRecord(runtimeVerifierDesc.value) : undefined)
      patchDirty = true
      notes.push('已补齐 assistant-verifier 缺失的 databasePath 与默认配置')
      needsRestart = true
      continue
    }
    if (issue.id === 'verifier-require-acceptance-without-profiles') {
      const verifierRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-verifier', '@dsh-ray/assistant-verifier')
      verifierRow.delete('disabled')
      const verifierCfg = ensureConfigMap(doc, verifierRow, 'config')
      const runtimeVerifierDesc = findEntry(input.descriptors, candidate => candidate === 'dsh-ray-assistant-verifier')
      ensureVerifierDefaults(doc, verifierCfg, runtimeVerifierDesc ? asPlainRecord(runtimeVerifierDesc.value) : undefined)
      verifierCfg.set('requireAcceptance', createPlainNode(doc, false))
      patchDirty = true
      notes.push('已将空 profiles 下阻塞日常对话的 assistant-verifier requireAcceptance 设为 false 并保留完整配置')
      needsRestart = true
      continue
    }
    if (issue.id === 'corrupted-policy-alias-rules') {
      const manifestBundles = readProfileManifestBundles(paths.profileDir)
      const { effectivePolicyCfg, policyConfigNode, existingRulesBeforeDefaults } = ensurePolicyConfigTarget(
        doc,
        seq,
        input.descriptors,
        manifestBundles,
        input.status.bundles,
      )
      const rawRules = existingRulesBeforeDefaults
        ?? (isSeq(policyConfigNode.get('rules', true)) ? yamlNodeToJs(policyConfigNode.get('rules', true), doc) : effectivePolicyCfg['rules'])
      const repaired = repairAliasMangledPolicyRules(rawRules)
      policyConfigNode.set('rules', createPlainNode(doc, repaired.rules))
      patchDirty = true
      notes.push(`已修复 ${repaired.repairedCount} 条损坏的策略规则${repaired.removedCount > 0 ? `并清理 ${repaired.removedCount} 条不可恢复条目` : ''}`)
      needsRestart = true
      continue
    }
    if (issue.id === 'unconfigured-memory-learning-crash') {
      await disableBundle('@dsh-ray/assistant-memory-learning', 'dsh-ray-assistant-memory-learning', '@dsh-ray/assistant-memory-learning')
      continue
    }
    if (issue.id === 'disabled-core-policy-provider') {
      const manifestBundles = readProfileManifestBundles(paths.profileDir)
      const paInstalled = isBundleInstalled(
        '@dsh-ray/personal-assistant',
        'dsh-ray-personal-assistant',
        manifestBundles,
        input.status.bundles,
        seq,
      )
      const targetPkg = paInstalled ? '@dsh-ray/personal-assistant' : '@dsh-ray/assistant-policy'
      const targetRowId = paInstalled ? 'dsh-ray-personal-assistant' : 'dsh-ray-assistant-policy'
      const existingRow = findPatchRow(seq, targetRowId)
      if (existingRow !== undefined && existingRow.get('disabled') === true) {
        existingRow.delete('disabled')
        patchDirty = true
      }
      bundleUpdates[targetPkg] = true
      postPatchEnableBundles.push(targetPkg)
      notes.push(`已恢复启用核心策略组件 ${targetPkg}`)
      needsRestart = true
      continue
    }
    if (issue.id === 'memory-learning-grant-conflict') {
      const conflict = inspectMemoryLearningGrantConflicts(paths, seq, input.descriptors)
      if (!conflict.hasConflict) continue
      const layout = getPersonalAndPolicyConfigs(seq, input.descriptors)
      const adoptCfg = asPlainRecord(layout.personalMemoryCfg['automaticLearning'])
      const verifierPatchCfg = getPatchRowConfig(seq, 'dsh-ray-assistant-verifier')
      const reviewCfg = asPlainRecord(mergeDescriptorConfig(
        input.descriptors,
        'dsh-ray-assistant-verifier',
        verifierPatchCfg,
      )['memoryReviews'])
      const memPatchCfg = getPatchRowConfig(seq, 'dsh-ray-assistant-memory-learning')
      const memCfg = mergeDescriptorConfig(input.descriptors, 'dsh-ray-assistant-memory-learning', memPatchCfg)

      const oldAdoptId = strOrNull(adoptCfg['authorityId'])
      const oldReviewId = strOrNull(reviewCfg['authorityId'])
      const oldExtractId = strOrNull(memCfg['authorityId'])
      const profileSlug = normalizeProfileSlug(paths.profileName)

      let gen = conflict.nextGeneration
      let newAdoptId = oldAdoptId !== null ? formatGrantIdWithGeneration(oldAdoptId, gen) : null
      let newReviewId = oldReviewId !== null ? formatGrantIdWithGeneration(oldReviewId, gen) : null
      let newExtractId = oldExtractId !== null ? formatGrantIdWithGeneration(oldExtractId, gen) : null
      let nextMemDbPath = paths.canonicalHome !== null
        ? resolveScopedDbTarget(paths.canonicalHome, 'assistant-memory-learning', `${profileSlug}-g${gen}.sqlite`, undefined)
        : null
      let guard = 0
      while (guard < 1024 && (
        (newAdoptId !== null && conflict.storedAdoptGrants.has(newAdoptId))
        || (newReviewId !== null && conflict.storedReviewGrants.has(newReviewId))
        || (nextMemDbPath !== null && existsSync(nextMemDbPath))
      )) {
        gen += 1
        guard += 1
        newAdoptId = oldAdoptId !== null ? formatGrantIdWithGeneration(oldAdoptId, gen) : null
        newReviewId = oldReviewId !== null ? formatGrantIdWithGeneration(oldReviewId, gen) : null
        newExtractId = oldExtractId !== null ? formatGrantIdWithGeneration(oldExtractId, gen) : null
        nextMemDbPath = paths.canonicalHome !== null
          ? resolveScopedDbTarget(paths.canonicalHome, 'assistant-memory-learning', `${profileSlug}-g${gen}.sqlite`, undefined)
          : null
      }

      let newReviewDigest: string | null = null
      if (newReviewId !== null) {
        const nextReview = normalizeMemoryGrantForDigest({ ...reviewCfg, authorityId: newReviewId })
        newReviewDigest = canonicalObjectDigest(nextReview)
        const verifierRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-verifier', '@dsh-ray/assistant-verifier')
        const verifierCfgNode = ensureConfigMap(doc, verifierRow, 'config')
        const runtimeVerifierDesc = findEntry(input.descriptors, candidate => candidate === 'dsh-ray-assistant-verifier')
        ensureVerifierDefaults(doc, verifierCfgNode, runtimeVerifierDesc?.value && typeof runtimeVerifierDesc.value === 'object'
          ? runtimeVerifierDesc.value as Record<string, unknown>
          : undefined)
        verifierCfgNode.set('memoryReviews', createPlainNode(doc, nextReview))
        patchDirty = true
      }

      let newAdoptDigest: string | null = null
      if (newAdoptId !== null) {
        const nextAdopt = normalizeMemoryGrantForDigest({
          ...adoptCfg,
          authorityId: newAdoptId,
          ...(newReviewId !== null ? { reviewAuthorityId: newReviewId } : {}),
          ...(newReviewDigest !== null ? { reviewAuthorityDigest: newReviewDigest } : {}),
        })
        newAdoptDigest = canonicalObjectDigest(nextAdopt)
        if (layout.layout === 'split') {
          const pmRow = ensurePatchRow(doc, seq, 'dsh-ray-personal-memory', '@dsh-ray/personal-memory')
          const pmCfgNode = ensureConfigMap(doc, pmRow, 'config')
          if (!pmCfgNode.has('databasePath')) {
            const runtimePmDb = strOrNull(layout.personalMemoryCfg['databasePath'])
            pmCfgNode.set('databasePath', runtimePmDb !== null && isAbsolute(runtimePmDb)
              ? createPlainNode(doc, runtimePmDb)
              : jsDshHomeScalar('personal-memory/memory.sqlite'))
          }
          pmCfgNode.set('automaticLearning', createPlainNode(doc, nextAdopt))
        } else {
          const paRow = ensurePatchRow(doc, seq, 'dsh-ray-personal-assistant', '@dsh-ray/personal-assistant')
          const paCfgNode = ensureConfigMap(doc, paRow, 'config')
          const pmNode = ensureConfigMap(doc, paCfgNode, 'personalMemory')
          if (!pmNode.has('databasePath')) {
            pmNode.set('databasePath', jsDshHomeScalar('personal-memory/memory.sqlite'))
          }
          pmNode.set('automaticLearning', createPlainNode(doc, nextAdopt))
        }
        patchDirty = true
      }

      const memRow = findPatchRow(seq, 'dsh-ray-assistant-memory-learning')
      if (newExtractId !== null && memRow !== undefined) {
        const shouldRotateMemDb = nextMemDbPath !== null
          && (conflict.learningStoreConflict || (conflict.memoryLearningDbPath !== null && existsSync(conflict.memoryLearningDbPath)))
        const resolvedMemDbPath = shouldRotateMemDb
          ? nextMemDbPath!
          : (conflict.memoryLearningDbPath ?? (typeof memCfg['databasePath'] === 'string' && isAbsolute(memCfg['databasePath']) ? memCfg['databasePath'] : undefined))
        const nextMem = normalizeLearningConfigForDigest({
          ...memCfg,
          authorityId: newExtractId,
          ...(newReviewId !== null ? { reviewAuthorityId: newReviewId } : {}),
          ...(newReviewDigest !== null ? { reviewAuthorityDigest: newReviewDigest } : {}),
          ...(newAdoptId !== null ? { adoptionAuthorityId: newAdoptId } : {}),
          ...(newAdoptDigest !== null ? { adoptionGrantDigest: newAdoptDigest } : {}),
        }, resolvedMemDbPath)
        memRow.set('config', createPlainNode(doc, nextMem))
        patchDirty = true
      }

      // Synchronize policy resource ids (`learning:<authorityId>`) for rotated grants.
      const resourceRemap = new Map<string, string>()
      if (oldExtractId !== null && newExtractId !== null) resourceRemap.set(`learning:${oldExtractId}`, `learning:${newExtractId}`)
      if (oldReviewId !== null && newReviewId !== null) resourceRemap.set(`learning:${oldReviewId}`, `learning:${newReviewId}`)
      if (oldAdoptId !== null && newAdoptId !== null) resourceRemap.set(`learning:${oldAdoptId}`, `learning:${newAdoptId}`)
      if (resourceRemap.size > 0) {
        const policyTargetRow = layout.layout === 'split'
          ? findPatchRow(seq, 'dsh-ray-assistant-policy')
          : findPatchRow(seq, 'dsh-ray-personal-assistant')
        const policyCfgNode = policyTargetRow ? readConfigMap(policyTargetRow, 'config') : undefined
        const policySectionRaw: unknown = policyCfgNode?.get('assistantPolicy', true)
        const policySectionNode = layout.layout === 'split'
          ? policyCfgNode
          : (isMap(policySectionRaw) ? policySectionRaw : undefined)
        const rulesNode = policySectionNode?.get('rules', true)
        if (isSeq(rulesNode)) {
          for (let idx = 0; idx < rulesNode.items.length; idx += 1) {
            const plain = yamlNodeToJs(rulesNode.items[idx], doc)
            if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) continue
            const rec = plain as Record<string, unknown>
            const res = asPlainRecord(rec['resource'])
            const resId = strOrNull(res['id'])
            const mapped = res['kind'] === 'memory' && resId !== null ? resourceRemap.get(resId) : undefined
            if (mapped !== undefined) {
              rulesNode.set(idx, createPlainNode(doc, { ...rec, resource: { ...res, id: mapped } }))
              patchDirty = true
            }
          }
        }
      }

      notes.push(`已轮换记忆自学习授权代数至 g${gen} 并同步摘要与策略规则`)
      needsRestart = true
      continue
    }
    if (issue.id.startsWith('stalled-bundle:')) {
      const pkg = issue.id.slice('stalled-bundle:'.length)
      if (PROTECTED_CORE_BUNDLES.has(pkg)) continue
      const rowId = input.status.bundles.find(b => b.name === pkg)?.rows[0]?.rowId
        ?? `dsh-ray-${pkg.replace(/^@dsh-ray\//u, '')}`
      await disableBundle(pkg, rowId, pkg)
      continue
    }
    if (issue.id === 'personal-assistant-split-collision') {
      const paRow = ensurePatchRow(doc, seq, 'dsh-ray-personal-assistant', '@dsh-ray/personal-assistant')
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
            if (v !== undefined) sectionMap.set(k, createPlainNode(doc, v))
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
      const deliveryRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-delivery', '@dsh-ray/assistant-delivery')
      if (deliveryRow.get('disabled') === true) deliveryRow.delete('disabled')
      const deliveryCfgMap = ensureConfigMap(doc, deliveryRow, 'config')
      setMissingMapDefaults(doc, deliveryCfgMap, ASSISTANT_DELIVERY_DEFAULTS)

      const mergedDelivery = mergeDescriptorConfig(input.descriptors, 'dsh-ray-assistant-delivery', getPatchRowConfig(seq, 'dsh-ray-assistant-delivery'))
      const scopedDb = checkScopedDbPath(deliveryCfgMap.get('databasePath', true) ?? mergedDelivery['databasePath'], paths.canonicalHome)
      const deliveryDbPath = scopedDb.resolved ?? join(paths.canonicalHome, 'assistant-delivery', 'state.sqlite')
      const defaultWorkspace = resolveDeliveryWorkspacePath(
        deliveryCfgMap.get('defaultWorkspace', true),
        mergedDelivery['defaultWorkspace'],
        paths.canonicalHome,
      )
      const defaultPreset = strOrNull(mergedDelivery['defaultAgentPreset']) ?? 'standard'
      mkdirSync(defaultWorkspace, { recursive: true, mode: 0o755 })

      let sqliteSnapshot = readDeliverySqliteSnapshot(deliveryDbPath)
      let ownerPrincipal: Record<string, unknown> = { channel: 'web', account: paths.profileName, tenant: 'local', user: 'operator' }
      let ownerConversation: Record<string, unknown> | null = { channel: 'web', account: paths.profileName, tenant: 'local', kind: 'dm', chat: 'owner-primary' }
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
        } else {
          ownerConversation = null
        }
        routeWorkspace = active.workspace !== null && isAbsolute(active.workspace) ? active.workspace : defaultWorkspace
        routePreset = active.preset ?? defaultPreset
        routePolicyRef = active.policyRef ?? 'owner-dm'
        routeGeneration = active.generation
      }

      const routeChannel = strOrNull(ownerPrincipal['channel']) ?? 'web'
      const routeAccount = strOrNull(ownerPrincipal['account']) ?? paths.profileName
      if (ownerConversation === null) {
        notes.push(`检测到 ${routeChannel} 主主人尚未在对应通道建立私聊会话，请先给机器人发一条消息后再同步 ownerRoutes`)
        continue
      }
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
      const existingRoutes = isSeq(deliveryCfgMap.get('ownerRoutes', true)) ? yamlNodeToJs(deliveryCfgMap.get('ownerRoutes', true), doc) : []
      deliveryCfgMap.set('ownerRoutes', createPlainNode(doc, syncPrimaryOwnerRoutes(existingRoutes, ownerRoute)))
      deliveryCfgMap.set('defaultWorkspace', createPlainNode(doc, routeWorkspace))
      deliveryCfgMap.set('defaultAgentPreset', createPlainNode(doc, routePreset))

      const manifestBundles = readProfileManifestBundles(paths.profileDir)
      const { effectivePolicyCfg, policyConfigNode, existingRulesBeforeDefaults } = ensurePolicyConfigTarget(
        doc,
        seq,
        input.descriptors,
        manifestBundles,
        input.status.bundles,
      )
      const principalKey = externalPrincipalId(ownerPrincipal) ?? `${routeChannel}/${routeAccount}/local/operator`
      const existingRulesRaw = existingRulesBeforeDefaults
        ?? (isSeq(policyConfigNode.get('rules', true)) ? yamlNodeToJs(policyConfigNode.get('rules', true), doc) : effectivePolicyCfg['rules'])
      const cleanedRules = pruneStaleOwnerRouteRules(existingRulesRaw, routeId, principalKey)
      const requiredRules: Record<string, unknown>[] = [
        {
          id: `dsh-ray-owner-route-${routeId}`,
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
            id: `dsh-ray-web-${routeAccount}-ingest`,
            effect: 'allow',
            subject: { kind: 'external', id: principalKey },
            actions: ['ingest'],
            resource: { kind: 'message', id: '*' },
            context: { initiators: ['external'] },
          },
          {
            id: `dsh-ray-web-${routeAccount}-capability`,
            effect: 'allow',
            subject: { kind: 'agent', id: routePreset, workspace: routeWorkspace, principal: principalKey },
            actions: ['*'],
            resource: { kind: '*', id: '*' },
            context: { initiators: ['external'] },
          },
        )
      } else if (routeChannel === 'lark') {
        requiredRules.push(
          ...buildLarkOwnerPolicyRules({
            account: routeAccount,
            principalId: principalKey,
            workspace: routeWorkspace,
            preset: routePreset,
            existingRules: cleanedRules,
          }),
        )
      }
      policyConfigNode.set('rules', createPlainNode(doc, upsertById(cleanedRules, requiredRules)))

      if (routeChannel === 'web' && isBundleInstalled('@dsh-ray/assistant-web-owner', 'dsh-ray-assistant-web-owner', manifestBundles, input.status.bundles, seq)) {
        const webRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-web-owner', '@dsh-ray/assistant-web-owner')
        const webCfg = ensureConfigMap(doc, webRow, 'config')
        webCfg.set('principal', createPlainNode(doc, {
          account: strOrNull(ownerPrincipal['account']) ?? paths.profileName,
          tenant: strOrNull(ownerPrincipal['tenant']) ?? 'local',
          user: strOrNull(ownerPrincipal['user']) ?? 'operator',
        }))
        webCfg.set('workspace', createPlainNode(doc, routeWorkspace))
        webCfg.set('preset', createPlainNode(doc, routePreset))
        if (!webCfg.has('maxExecutionMs')) webCfg.set('maxExecutionMs', createPlainNode(doc, 300_000))
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
        const traexRow = ensurePatchRow(doc, seq, 'dsh-ray-traex-acp-provider', '@dsh-ray/traex-acp-provider')
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

  for (const pkg of postPatchEnableBundles) {
    if (input.manager !== undefined) {
      try {
        await input.manager.setBundleEnabled(pkg, true)
      } catch {
        // Fallback to manifest update below if manager fails or is stubbed.
      }
    }
  }

  if (Object.keys(bundleUpdates).length > 0) {
    backupAndUpdateProfileManifest(paths, now, bundleUpdates)
  }

  if (promoteLinkedLark) {
    const freshDoc = paths.patchPath !== null ? readPatchDocument(paths.patchPath) : doc
    const freshSeq = isSeq(freshDoc.contents) ? freshDoc.contents : seq
    const deliveryDbPath = resolveDeliveryDbPathForProfile(paths.canonicalHome, freshSeq, input.descriptors)
    const linkedLark = detectLinkedLarkIngressAccount(freshSeq, input.descriptors, deliveryDbPath)
    if (linkedLark !== null) {
      const promoted = await promoteLarkOwnerInProfile({
        host: input.host,
        descriptors: input.descriptors,
        openId: linkedLark.openId,
        account: linkedLark.account,
        tenant: linkedLark.tenant,
        confirmed: true,
        platform,
        env,
        now,
      })
      if (!promoted.applied) {
        if (notes.length === 0) {
          return Object.freeze({
            applied: false,
            entry: 'setup-doctor',
            note: promoted.note,
          })
        }
        notes.push(`切换飞书主主人失败（${promoted.note}）`)
      } else {
        if (notes.length === 0) {
          return Object.freeze({
            applied: true,
            entry: 'setup-doctor',
            note: promoted.note,
          })
        }
        notes.push(promoted.note)
        needsRestart = true
      }
    }
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
export type DeleteSecretFn = (locator: EasySecretLocator) => Promise<void>

export function redactVaultSecret(text: string, secret: string): string {
  if (secret === '') return text
  const hexLower = Buffer.from(secret, 'utf8').toString('hex')
  const hexUpper = hexLower.toUpperCase()
  let out = text.split(secret).join('[REDACTED]')
  if (hexLower.length >= 8) {
    out = out.split(hexLower).join('[REDACTED]')
    if (hexUpper !== hexLower) out = out.split(hexUpper).join('[REDACTED]')
  }
  return out
}

function resolveDeliveryWorkspacePath(
  patchNode: unknown,
  runtimeValue: unknown,
  canonicalHome: string,
): string {
  const tryJsExpr = (raw: string): string | null => {
    const match = DSH_HOME_EXPR.exec(raw.trim())
    if (match === null) return null
    const rel = match[2]!
    if (rel.startsWith('/') || rel.split('/').some(part => part === '' || part === '.' || part === '..')) return null
    return join(canonicalHome, rel)
  }
  if (isScalar(patchNode) && patchNode.tag === 'tag:yaml.org,2002:js' && typeof patchNode.value === 'string') {
    const resolved = tryJsExpr(patchNode.value)
    if (resolved !== null) return resolved
  }
  const patchStr = isScalar(patchNode) ? strOrNull(patchNode.value) : strOrNull(patchNode)
  if (patchStr !== null) {
    const exprResolved = tryJsExpr(patchStr)
    if (exprResolved !== null) return exprResolved
    if (isAbsolute(patchStr) && !patchStr.includes('*') && !patchStr.includes('\0')) return patchStr
  }
  const runtimeStr = strOrNull(runtimeValue)
  if (runtimeStr !== null && isAbsolute(runtimeStr) && !runtimeStr.includes('*') && !runtimeStr.includes('\0')) {
    return runtimeStr
  }
  return join(canonicalHome, 'assistant-workspace')
}

async function defaultStoreSecretFn(locator: EasySecretLocator, secret: string): Promise<void> {
  if (locator.provider === 'macos-keychain') {
    if (!KEYCHAIN_LOCATOR_TOKEN.test(locator.service) || !KEYCHAIN_LOCATOR_TOKEN.test(locator.account)) {
      throw new Error('钥匙串标识格式无效，拒绝写入')
    }
    const hex = Buffer.from(secret, 'utf8').toString('hex')
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = nodeExecFile('/usr/bin/security', ['-i'], {
        timeout: 10_000,
        env: { PATH: '/usr/bin:/bin' },
        windowsHide: true,
      }, (error) => {
        if (error) {
          rejectPromise(new Error('写入 macOS 钥匙串失败（请确认登录钥匙串已解锁并允许访问）'))
          return
        }
        resolvePromise()
      })
      child.stdin?.on('error', () => { /* ignore EPIPE if security exits early */ })
      child.stdin?.end(`add-generic-password -U -a ${locator.account} -s ${locator.service} -X ${hex}\n`)
    })
    return
  }

  const dir = dirname(locator.path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dirStat = lstatSync(dir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error('凭据目录不是普通目录，拒绝写入')
  }
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

async function defaultDeleteSecretFn(locator: EasySecretLocator): Promise<void> {
  if (locator.provider === 'macos-keychain') {
    if (!KEYCHAIN_LOCATOR_TOKEN.test(locator.service) || !KEYCHAIN_LOCATOR_TOKEN.test(locator.account)) {
      throw new Error('钥匙串标识格式无效，拒绝删除')
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = nodeExecFile('/usr/bin/security', ['-i'], {
        timeout: 10_000,
        env: { PATH: '/usr/bin:/bin' },
        windowsHide: true,
      }, (error, _stdout, stderr) => {
        if (error) {
          const code = (error as { code?: unknown }).code
          const missingMsg = typeof stderr === 'string' && /(?:could not be found|not found|no matching|no such)/iu.test(stderr)
          if (code === 44 || missingMsg) {
            resolvePromise()
            return
          }
          rejectPromise(new Error('清理 macOS 钥匙串凭据失败'))
          return
        }
        resolvePromise()
      })
      child.stdin?.on('error', () => { /* ignore EPIPE if security exits early */ })
      child.stdin?.end(`delete-generic-password -a ${locator.account} -s ${locator.service}\n`)
    })
    return
  }

  try {
    const st = lstatSync(locator.path)
    if (st.isSymbolicLink() || !st.isFile()) return
    unlinkSync(locator.path)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
}

export interface ConfigureFeishuEasyInput {
  readonly host: AutonomyHostContext
  readonly descriptors: readonly SettingsDescriptor[]
  readonly settings?: SettingsService | undefined
  readonly reloadEntry?: (entryId: string) => Promise<string>
  readonly appId: string
  readonly appSecret: string
  readonly account: string
  readonly tenant: string
  readonly domain?: 'feishu' | 'lark'
  readonly ownerOpenId?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly now?: number
  readonly storeSecretFn?: StoreSecretFn
  readonly deleteSecretFn?: DeleteSecretFn
}

export interface ApplyFeishuVaultResult extends OwnerConsoleWriteResult {
  readonly ownerBinding: FeishuQrOwnerBinding
  readonly domain: 'feishu' | 'lark'
  readonly account?: string
  readonly tenant?: string
  readonly existingAutonomyAnchored?: boolean
}

function authorizeLarkPrincipalInDeliverySqlite(
  dbPath: string,
  principal: Readonly<{ channel: 'lark'; account: string; tenant: string; user: string }>,
  now: number,
): FeishuQrOwnerBinding {
  if (!existsSync(dbPath)) return 'unmodified'
  let rwDb: DatabaseSync | undefined
  let inTx = false
  try {
    const st = lstatSync(dbPath)
    if (st.isSymbolicLink() || !st.isFile()) return 'unmodified'
    const json = JSON.stringify({
      channel: principal.channel,
      account: principal.account,
      tenant: principal.tenant,
      user: principal.user,
    })
    const hash = createHash('sha256').update(json, 'utf8').digest('hex')
    const ts = Math.max(0, Math.trunc(now))
    rwDb = new DatabaseSync(dbPath)
    rwDb.exec('PRAGMA busy_timeout = 5000;')
    rwDb.exec('PRAGMA foreign_keys = ON;')
    const tbl = rwDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_principals'`).get() as { name?: unknown } | undefined
    if (tbl?.name !== 'delivery_principals') return 'unmodified'

    rwDb.exec('BEGIN IMMEDIATE;')
    inTx = true
    const existing = rwDb.prepare(
      `SELECT id, role, status, linked_to_id, principal_json FROM delivery_principals WHERE key_hash = ?`,
    ).get(hash) as Readonly<{
      id?: unknown
      role?: unknown
      status?: unknown
      linked_to_id?: unknown
      principal_json?: unknown
    }> | undefined
    const activeOwners = rwDb.prepare(
      `SELECT id FROM delivery_principals WHERE role = 'owner' AND status = 'active' ORDER BY id LIMIT 2`,
    ).all() as ReadonlyArray<{ id?: unknown }>
    const singleOwnerId = activeOwners.length === 1 && typeof activeOwners[0]?.id === 'string'
      ? activeOwners[0].id
      : null

    let outcome: FeishuQrOwnerBinding = 'unmodified'
    if (existing !== undefined) {
      if (existing.principal_json === json && existing.status === 'active') {
        if (existing.role === 'owner') {
          outcome = 'reused-owner'
        } else if (
          existing.role === 'linked'
          && existing.linked_to_id === null
          && typeof existing.id === 'string'
          && singleOwnerId !== null
        ) {
          rwDb.prepare(
            `UPDATE delivery_principals SET linked_to_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
          ).run(singleOwnerId, ts, existing.id)
          outcome = 'linked-to-owner'
        } else {
          outcome = 'reused-linked'
        }
      } else if (
        existing.principal_json === json
        && existing.role === 'linked'
        && existing.status === 'revoked'
        && typeof existing.id === 'string'
        && singleOwnerId !== null
      ) {
        rwDb.prepare(
          `UPDATE delivery_principals SET status = 'active', linked_to_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(singleOwnerId, ts, existing.id)
        outcome = 'linked-to-owner'
      } else if (
        existing.principal_json === json
        && existing.role === 'owner'
        && existing.status === 'revoked'
        && typeof existing.id === 'string'
        && activeOwners.length === 0
      ) {
        rwDb.prepare(
          `UPDATE delivery_principals SET status = 'active', linked_to_id = NULL, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(ts, existing.id)
        outcome = 'bound-owner'
      }
    } else if (activeOwners.length === 0) {
      rwDb.prepare(
        `INSERT INTO delivery_principals (id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version)
         VALUES (?, ?, ?, 'owner', 'active', NULL, ?, ?, 1)`,
      ).run(`principal_${randomUUID()}`, hash, json, ts, ts)
      outcome = 'bound-owner'
    } else if (singleOwnerId !== null) {
      rwDb.prepare(
        `INSERT INTO delivery_principals (id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version)
         VALUES (?, ?, ?, 'linked', 'active', ?, ?, ?, 1)`,
      ).run(`principal_${randomUUID()}`, hash, json, singleOwnerId, ts, ts)
      outcome = 'linked-to-owner'
    }
    rwDb.exec('COMMIT;')
    inTx = false
    return outcome
  } catch {
    if (rwDb !== undefined && inTx) {
      try { rwDb.exec('ROLLBACK;') } catch { /* ignore rollback error */ }
    }
    return 'unmodified'
  } finally {
    rwDb?.close()
  }
}

function buildLarkOwnerPolicyRules(input: Readonly<{
  account: string
  principalId: string
  workspace: string
  preset: string
  existingRules?: unknown
}>): readonly Record<string, unknown>[] {
  const existingList = Array.isArray(input.existingRules) ? input.existingRules.map(asPlainRecord) : []
  const hasIngressForPrincipal = existingList.some(rule =>
    rule['id'] === `lark-owner-ingress-${input.account}`
    && asPlainRecord(rule['subject'])['id'] === input.principalId)
  const existingReplyRule = existingList.find(rule => rule['id'] === `lark-owner-reply-${input.account}`)
  const existingReplyPrincipal = existingReplyRule === undefined
    ? undefined
    : asPlainRecord(existingReplyRule['subject'])['principal']
  const hasExistingOwnerBinding = hasIngressForPrincipal
    && (existingReplyRule === undefined || existingReplyPrincipal === undefined || existingReplyPrincipal === input.principalId)

  const shouldPreserveExistingRule = (ruleId: string): boolean => {
    const existingRule = existingList.find(rule => rule['id'] === ruleId)
    if (existingRule === undefined) return hasExistingOwnerBinding
    const rulePrincipal = asPlainRecord(existingRule['subject'])['principal']
    if (rulePrincipal === input.principalId) return true
    if (rulePrincipal === undefined) {
      return existingRule['effect'] === 'deny' || hasExistingOwnerBinding
    }
    return false
  }

  const makeAgentSubject = () => ({
    kind: 'agent',
    id: input.preset,
    workspace: input.workspace,
    principal: input.principalId,
  })
  const capabilityRuleId = `lark-owner-capability-*-${input.account}`
  const toolRuleId = `lark-owner-tool-*-${input.account}`
  const rules: Record<string, unknown>[] = [
    {
      id: `lark-owner-ingress-${input.account}`,
      effect: 'allow',
      subject: { kind: 'external', id: input.principalId },
      actions: ['approval.decide', 'ingest'],
      resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] },
    },
    {
      id: `lark-owner-reply-${input.account}`,
      effect: 'allow',
      subject: makeAgentSubject(),
      actions: ['reply'],
      resource: { kind: 'message', id: '*' },
      context: { initiators: ['external'] },
    },
  ]
  // Preserve owner-customized capability/tool restrictions (including deny rules, legacy unscoped rules, and disabled tools) on re-scan for the same principal.
  if (!shouldPreserveExistingRule(capabilityRuleId)) {
    rules.push({
      id: capabilityRuleId,
      effect: 'allow',
      subject: makeAgentSubject(),
      actions: ['*'],
      resource: { kind: '*', id: '*' },
      context: { initiators: ['external'] },
    })
  }
  if (!shouldPreserveExistingRule(toolRuleId)) {
    rules.push({
      id: toolRuleId,
      effect: 'allow',
      subject: makeAgentSubject(),
      actions: ['execute'],
      resource: { kind: 'tool', id: '*' },
      context: { initiators: ['external'] },
    })
  }
  rules.push(
    ...LARK_APPROVAL_SOURCES.map(sourceId => ({
      id: `lark-owner-approval-${sourceId}-${input.account}`,
      effect: 'allow',
      subject: {
        kind: 'background',
        id: sourceId,
        workspace: input.workspace,
        principal: input.principalId,
      },
      actions: ['approval.send'],
      resource: { kind: 'message', id: '*' },
      context: { initiators: ['background'] },
    })),
    {
      id: `lark-owner-preference-signal-${input.account}`,
      effect: 'allow',
      subject: {
        kind: 'external',
        id: input.principalId,
        workspace: input.workspace,
      },
      actions: ['signal'],
      resource: { kind: 'preference', id: `${input.preset}/*` },
      context: { initiators: ['external'] },
    },
    {
      id: `lark-owner-preference-snapshot-${input.account}`,
      effect: 'allow',
      subject: makeAgentSubject(),
      actions: ['snapshot'],
      resource: { kind: 'preference', id: 'active' },
      context: { initiators: ['external'] },
    },
  )
  return rules
}

function ownerBindingNote(binding: FeishuQrOwnerBinding, openId: string | undefined): string {
  if (openId === undefined) return ''
  switch (binding) {
    case 'bound-owner':
      return `已自动绑定飞书主主人身份（${openId}）并写入消息与工具策略`
    case 'reused-owner':
      return `已沿用现有飞书主主人身份（${openId}）并同步消息与工具策略`
    case 'linked-to-owner':
      return `已将扫码飞书账号（${openId}）以关联身份（linked）接入当前主主人账户：普通私聊可用，但 /permission、/model、审批卡片与自主授权仍归属现有主主人（切换主主人或已有自主授权时更换应用请运行 dsh-lark-setup）`
    case 'reused-linked':
      return `已沿用关联飞书账号（${openId}，linked）：普通私聊可用，但 /permission、/model、审批卡片与自主授权仍归属现有主主人（切换主主人或已有自主授权时更换应用请运行 dsh-lark-setup）`
    case 'unmodified':
      return `已写入飞书账号（${openId}）的消息与工具策略（Delivery 身份表未改写，如需初始化或切换主主人请重启 profile 后检查或运行 dsh-lark-setup）`
    default:
      return ''
  }
}

/** Foolproof Feishu setup: accepts App Secret in memory, seals it in OS vault, wires keychain handle, policy, and optional QR owner authorization. */
export async function applyFeishuVaultConfig(input: ConfigureFeishuEasyInput): Promise<ApplyFeishuVaultResult> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const now = input.now ?? Date.now()
  const resolvedDomain: 'feishu' | 'lark' = input.domain === 'lark' ? 'lark' : 'feishu'
  const paths = resolveProfilePaths(input.host, env)
  if (detectFrozenSystemdProfile(paths.dshHome, paths.profileName, platform, env)) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: resolvedDomain,
      ownerBinding: 'unmodified' as const,
      note: '当前为受控 Linux systemd 冻结实例，拒绝在线改写系统凭据或通道策略。',
    })
  }

  const resolvedAppId = input.appId.trim()
  if (!isAppId(resolvedAppId) || resolvedAppId === PLACEHOLDER_LARK_APP_ID) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: resolvedDomain,
      ownerBinding: 'unmodified' as const,
      note: 'App ID 必须形如 cli_0123456789abcdef',
    })
  }

  const secret = input.appSecret.trim()
  if (secret === '' || secret.length > 512 || hasControlChars(secret) || /[\r\n]/u.test(secret)) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: resolvedDomain,
      ownerBinding: 'unmodified' as const,
      note: 'App Secret 不能为空，且须为单行有效文本（最多 512 字符）',
    })
  }

  if (!paths.writable || paths.patchPath === null || paths.canonicalHome === null) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: resolvedDomain,
      ownerBinding: 'unmodified' as const,
      note: '当前 profile 的 cordis.patch.yml 或 DSH_HOME 不可写入，无法保存加密凭据句柄。',
    })
  }

  if (!SETUP_KEY_TOKEN.test(paths.profileName)) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: resolvedDomain,
      ownerBinding: 'unmodified' as const,
      note: '当前 profile 名称含不受支持的字符，无法安全生成系统凭据句柄。',
    })
  }

  if (platform !== 'darwin' && platform !== 'linux' && input.storeSecretFn === undefined) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: resolvedDomain,
      ownerBinding: 'unmodified' as const,
      note: `当前系统（${platform}）暂不支持一键写入系统凭据库，请改用「环境变量」或「Keychain Handle」模式。`,
    })
  }

  let doc: Document
  try {
    doc = readPatchDocument(paths.patchPath)
  } catch (error: unknown) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: resolvedDomain,
      ownerBinding: 'unmodified' as const,
      note: `读取 profile 配置失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }
  const seq = doc.contents as YAMLSeq

  const larkDesc = findEntry(input.descriptors, ns => /(^|[-_/])lark(-channel)?($|[-_/])/u.test(ns))
  const currentLark = mergeDescriptorConfig(
    input.descriptors,
    larkDesc?.ns ?? 'dsh-ray-lark-channel',
    getPatchRowConfig(seq, 'dsh-ray-lark-channel'),
  )
  const existingTenant = strOrNull(currentLark['tenant'])
  const resolvedAccount = input.account.trim() !== ''
    ? input.account.trim()
    : (strOrNull(currentLark['account']) ?? 'primary')
  const resolvedTenant = input.tenant.trim() !== ''
    ? input.tenant.trim()
    : (existingTenant !== null && existingTenant !== PLACEHOLDER_LARK_TENANT ? existingTenant : 'personal')
  const effectiveDomain: 'feishu' | 'lark' = input.domain
    ?? (currentLark['domain'] === 'lark' ? 'lark' : 'feishu')

  if (!SETUP_KEY_TOKEN.test(resolvedAccount) || resolvedAccount.includes('-legacy-')) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: effectiveDomain,
      ownerBinding: 'unmodified' as const,
      note: 'account 格式无效（需 1..64 位字母/数字/._-，且不能包含 -legacy-）',
    })
  }
  if (!SETUP_KEY_TOKEN.test(resolvedTenant)) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: effectiveDomain,
      ownerBinding: 'unmodified' as const,
      note: 'tenant 格式无效（需 1..64 位字母/数字/._-）',
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

  if (locator.provider === 'macos-keychain'
    && (!KEYCHAIN_LOCATOR_TOKEN.test(locator.service) || !KEYCHAIN_LOCATOR_TOKEN.test(locator.account))) {
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: effectiveDomain,
      ownerBinding: 'unmodified' as const,
      note: 'profile 名称与 account 组合过长（超过系统凭据库 128 字符服务标识上限），请缩短 account 后重试。',
    })
  }

  const storeFn = input.storeSecretFn ?? defaultStoreSecretFn
  const deleteFn: DeleteSecretFn | undefined = input.deleteSecretFn
    ?? (input.storeSecretFn === undefined ? defaultDeleteSecretFn : undefined)
  try {
    await storeFn(locator, secret)
  } catch (error: unknown) {
    const safeDetail = redactVaultSecret(error instanceof Error ? error.message : String(error), secret)
    return Object.freeze({
      applied: false,
      entry: 'dsh-ray-lark-channel',
      domain: effectiveDomain,
      ownerBinding: 'unmodified' as const,
      note: `保存 App Secret 到系统凭据库失败：${safeDetail}`,
    })
  }

  // Match dsh-lark-setup (`setup-profile.ts`) canonical handle id so CLI & GUI stay 100% interoperable.
  const handleId = `lark-app-secret-${resolvedAccount}`
  let deliveryDbPath: string | undefined
  let validOpenId: string | undefined
  let existingAutonomyAnchored = false
  try {
    const handleEntry = {
      id: handleId,
      provider: locator.provider,
      ...(locator.provider === 'macos-keychain'
        ? { service: locator.service, account: locator.account }
        : { path: locator.path }),
      consumers: ['dsh-ray-lark-channel'],
      purposes: ['connect'],
      maxLeaseMs: 86_400_000,
    }

    const kcRow = ensurePatchRow(doc, seq, 'dsh-ray-credentials-keychain', '@dsh-ray/credentials-keychain')
    if (kcRow.get('disabled') === true) kcRow.delete('disabled')
    const kcCfg = ensureConfigMap(doc, kcRow, 'config')
    const kcDesc = findEntry(input.descriptors, ns => ns === 'dsh-ray-credentials-keychain')
    const runtimeKcHandles = Array.isArray(asPlainRecord(kcDesc?.value)['handles'])
      ? asPlainRecord(kcDesc?.value)['handles']
      : []
    const existingHandles = isSeq(kcCfg.get('handles', true))
      ? yamlNodeToJs(kcCfg.get('handles', true), doc)
      : runtimeKcHandles
    setMissingMapDefaults(doc, kcCfg, CREDENTIALS_KEYCHAIN_DEFAULTS)
    kcCfg.set('handles', createPlainNode(doc, upsertById(existingHandles, [handleEntry])))

    const manifestBundles = readProfileManifestBundles(paths.profileDir)
    const { effectivePolicyCfg, policyConfigNode, existingRulesBeforeDefaults } = ensurePolicyConfigTarget(
      doc,
      seq,
      input.descriptors,
      manifestBundles,
    )
    const existingDeliveryRow = findPatchRow(seq, 'dsh-ray-assistant-delivery')
    if (existingDeliveryRow?.get('disabled') === true) existingDeliveryRow.delete('disabled')

    const existingRules = existingRulesBeforeDefaults
      ?? (isSeq(policyConfigNode.get('rules', true)) ? yamlNodeToJs(policyConfigNode.get('rules', true), doc) : effectivePolicyCfg['rules'])

    const rawOpenId = input.ownerOpenId?.trim() ?? ''
    validOpenId = rawOpenId !== '' && LARK_OPEN_ID_TOKEN.test(rawOpenId) ? rawOpenId : undefined
    const policyRulesToUpsert: Record<string, unknown>[] = [
      {
        id: `lark-channel-credential-${resolvedAccount}`,
        effect: 'allow',
        subject: { kind: 'background', id: 'dsh-ray-lark-channel' },
        actions: ['credential.use'],
        resource: { kind: 'credential', id: handleId },
        context: { initiators: ['background'] },
      },
    ]

    let resolvedPrincipalKey: string | undefined
    if (validOpenId !== undefined) {
      const deliveryDesc = findEntry(input.descriptors, ns => ns === 'dsh-ray-assistant-delivery')
      const runtimeDelivery = asPlainRecord(deliveryDesc?.value)
      const mergedDelivery = {
        ...runtimeDelivery,
        ...getPatchRowConfig(seq, 'dsh-ray-assistant-delivery', doc),
      }
      const deliveryPatchCfg = findPatchRow(seq, 'dsh-ray-assistant-delivery')
      const deliveryCfgNode = deliveryPatchCfg ? readConfigMap(deliveryPatchCfg, 'config') : undefined
      const scopedDb = checkScopedDbPath(
        deliveryCfgNode?.get('databasePath', true) ?? mergedDelivery['databasePath'],
        paths.canonicalHome,
      )
      deliveryDbPath = scopedDb.scoped && scopedDb.resolved !== null
        ? scopedDb.resolved
        : join(paths.canonicalHome, 'assistant-delivery', 'state.sqlite')
      const defaultWorkspace = resolveDeliveryWorkspacePath(
        deliveryCfgNode?.get('defaultWorkspace', true),
        runtimeDelivery['defaultWorkspace'],
        paths.canonicalHome,
      )
      const rawPreset = strOrNull(mergedDelivery['defaultAgentPreset'])
      const defaultPreset = rawPreset !== null && PRESET_ID_TOKEN.test(rawPreset) ? rawPreset : 'standard'
      const principalKey = externalPrincipalId({
        channel: 'lark',
        account: resolvedAccount,
        tenant: resolvedTenant,
        user: validOpenId,
      })
      if (principalKey !== null) {
        resolvedPrincipalKey = principalKey
        policyRulesToUpsert.push(...buildLarkOwnerPolicyRules({
          account: resolvedAccount,
          principalId: principalKey,
          workspace: defaultWorkspace,
          preset: defaultPreset,
          existingRules,
        }))
      }
    }

    policyConfigNode.set('rules', createPlainNode(doc, upsertById(existingRules, policyRulesToUpsert)))

    const larkRow = ensurePatchRow(doc, seq, 'dsh-ray-lark-channel', '@dsh-ray/lark-channel')
    if (larkRow.get('disabled') === true) larkRow.delete('disabled')
    const larkCfg = ensureConfigMap(doc, larkRow, 'config')
    larkCfg.set('enabled', createPlainNode(doc, true))
    larkCfg.set('appId', createPlainNode(doc, resolvedAppId))
    larkCfg.set('account', createPlainNode(doc, resolvedAccount))
    larkCfg.set('tenant', createPlainNode(doc, resolvedTenant))
    larkCfg.set('secretSource', createPlainNode(doc, 'handle'))
    larkCfg.set('credentialHandle', createPlainNode(doc, handleId))
    larkCfg.set('credentialPurpose', createPlainNode(doc, 'connect'))
    larkCfg.set('credentialLeaseMs', createPlainNode(doc, 86_400_000))
    if (input.domain !== undefined || !larkCfg.has('domain')) {
      larkCfg.set('domain', createPlainNode(doc, effectiveDomain))
    }
    larkCfg.delete('appSecretEnv')

    atomicWritePatchWithBackup(paths.patchPath, doc.toString({ lineWidth: 0 }), now)
    existingAutonomyAnchored = hasAutonomyGrantsForOtherPrincipal(seq, input.descriptors, resolvedPrincipalKey)
  } catch (error: unknown) {
    let rollbackFailed = false
    if (deleteFn !== undefined) {
      try {
        await deleteFn(locator)
      } catch {
        rollbackFailed = true
      }
    }
    const safeDetail = redactVaultSecret(error instanceof Error ? error.message : String(error), secret)
    const cleanupNote = deleteFn === undefined
      ? ''
      : rollbackFailed
        ? '；尝试自动回滚新建的系统凭据项也失败，请稍后手动清理'
        : '；已自动清理本次新建的系统凭据项'
    return Object.freeze({
      applied: false,
      entry: larkDesc?.ns ?? 'dsh-ray-lark-channel',
      domain: effectiveDomain,
      account: resolvedAccount,
      tenant: resolvedTenant,
      ownerBinding: 'unmodified' as const,
      note: `写入 profile 配置（cordis.patch.yml）失败：${safeDetail}${cleanupNote}。`,
    })
  }

  const ownerBinding: FeishuQrOwnerBinding = validOpenId === undefined
    ? 'not-returned'
    : authorizeLarkPrincipalInDeliverySqlite(deliveryDbPath!, {
        channel: 'lark',
        account: resolvedAccount,
        tenant: resolvedTenant,
        user: validOpenId,
      }, now)

  // Never call settings.mutate() or hot-reload credentials-keychain / personal-assistant / assistant-policy / lark-channel
  // in-process after patching cordis.patch.yml (violates Cordis runtime contracts and causes cascading teardown / SETTINGS_CONFLICT).
  const bindingSummary = ownerBindingNote(ownerBinding, validOpenId)
  return Object.freeze({
    applied: true,
    entry: larkDesc?.ns ?? 'dsh-ray-lark-channel',
    domain: effectiveDomain,
    account: resolvedAccount,
    tenant: resolvedTenant,
    ownerBinding,
    existingAutonomyAnchored,
    note: `已将 App Secret 安全存入系统凭据库（句柄 ${handleId}，配置文件零明文），并写入通道与凭据/消息策略配置${bindingSummary === '' ? '' : `；${bindingSummary}`}；请重启一次 profile（重启 DeepSeek Harness.app 或运行 dsh-ray restart）以加载新凭据句柄与策略并建立飞书长连接。`,
  })
}

export async function configureFeishuEasy(input: ConfigureFeishuEasyInput): Promise<OwnerConsoleWriteResult> {
  const result = await applyFeishuVaultConfig(input)
  return Object.freeze({
    applied: result.applied,
    entry: result.entry,
    note: result.note,
  })
}

export interface PromoteLarkOwnerInput {
  readonly host: AutonomyHostContext
  readonly descriptors: readonly SettingsDescriptor[]
  readonly openId: string
  readonly account: string
  readonly tenant: string
  readonly confirmed: boolean
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly now?: number
}

export interface PromoteLarkOwnerResult {
  readonly applied: boolean
  readonly ownerBinding: FeishuQrOwnerBinding
  readonly existingAutonomyAnchored: boolean
  readonly errorCode?: string
  readonly note: string
}

/**
 * Atomic trusted local owner handoff matching `@dsh-ray/assistant-delivery` `DeliveryStore.handoffOwner`:
 * promotes the scanned Lark principal to the sole active `owner`, retires previous active owners and
 * unrelated linked identities + their conversation bindings, expires active pairing challenges, and retires
 * stale preference projection outbox rows so old owner lineage cannot resurface.
 */
function handoffLarkOwnerInDeliverySqlite(
  dbPath: string,
  principal: Readonly<{ channel: 'lark'; account: string; tenant: string; user: string }>,
  now: number,
): Readonly<{ ok: true; reused: boolean } | { ok: false; code: string; reason: string }> {
  if (!existsSync(dbPath)) {
    return { ok: false, code: 'delivery-db-missing', reason: 'Delivery 身份数据库尚未初始化，请先重启一次 profile 待数据库创建后再切换主主人。' }
  }
  let rwDb: DatabaseSync | undefined
  let inTx = false
  try {
    const st = lstatSync(dbPath)
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ok: false, code: 'delivery-db-unsafe', reason: 'Delivery 数据库路径不是受控普通文件，拒绝改写主主人身份。' }
    }
    const json = JSON.stringify({
      channel: principal.channel,
      account: principal.account,
      tenant: principal.tenant,
      user: principal.user,
    })
    const hash = createHash('sha256').update(json, 'utf8').digest('hex')
    const ts = Math.max(0, Math.trunc(now))

    rwDb = new DatabaseSync(dbPath)
    rwDb.exec('PRAGMA busy_timeout = 5000;')
    rwDb.exec('PRAGMA foreign_keys = ON;')
    const hasTable = (name: string): boolean => {
      const row = rwDb!.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { name?: unknown } | undefined
      return row?.name === name
    }
    if (!hasTable('delivery_principals')) {
      return { ok: false, code: 'delivery-schema-missing', reason: 'Delivery 身份表尚未初始化，请先重启一次 profile 后再重试。' }
    }
    const hasBindings = hasTable('conversation_bindings')
    const hasChallenges = hasTable('pairing_challenges')
    const hasOutbox = hasTable('delivery_preference_projection_outbox')

    rwDb.exec('BEGIN IMMEDIATE;')
    inTx = true

    const existing = rwDb.prepare(
      `SELECT id, role, status, linked_to_id, version, principal_json FROM delivery_principals WHERE key_hash = ? AND principal_json = ?`,
    ).get(hash, json) as Readonly<{
      id?: unknown
      role?: unknown
      status?: unknown
      linked_to_id?: unknown
      version?: unknown
      principal_json?: unknown
    }> | undefined
    const activeOwners = rwDb.prepare(
      `SELECT id FROM delivery_principals WHERE role = 'owner' AND status = 'active'`,
    ).all() as ReadonlyArray<{ id?: unknown }>

    let replacementId: string
    let reused = false
    if (existing === undefined || typeof existing.id !== 'string') {
      replacementId = `principal_${randomUUID()}`
      rwDb.prepare(
        `INSERT INTO delivery_principals (id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version)
         VALUES (?, ?, ?, 'owner', 'active', NULL, ?, ?, 1)`,
      ).run(replacementId, hash, json, ts, ts)
    } else {
      replacementId = existing.id
      if (existing.role === 'owner' && existing.status === 'active' && existing.linked_to_id === null && activeOwners.length === 1) {
        reused = true
      } else {
        rwDb.prepare(
          `UPDATE delivery_principals SET role = 'owner', status = 'active', linked_to_id = NULL, updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(ts, replacementId)
      }
    }

    if (hasBindings) {
      rwDb.prepare(
        `UPDATE conversation_bindings
         SET status = 'revoked', updated_at = ?, version = version + 1
         WHERE status = 'active' AND principal_id IN (
           SELECT id FROM delivery_principals
           WHERE role = 'linked' AND status = 'active' AND id <> ?
             AND (linked_to_id IS NULL OR linked_to_id <> ?)
         )`,
      ).run(ts, replacementId, replacementId)
    }
    rwDb.prepare(
      `UPDATE delivery_principals
       SET status = 'revoked', updated_at = ?, version = version + 1
       WHERE role = 'linked' AND status = 'active' AND id <> ?
         AND (linked_to_id IS NULL OR linked_to_id <> ?)`,
    ).run(ts, replacementId, replacementId)

    for (const owner of activeOwners) {
      if (typeof owner.id !== 'string' || owner.id === replacementId) continue
      rwDb.prepare(
        `UPDATE delivery_principals SET status = 'revoked', updated_at = ?, version = version + 1 WHERE id = ? AND role = 'owner' AND status = 'active'`,
      ).run(ts, owner.id)
      if (hasBindings) {
        rwDb.prepare(
          `UPDATE conversation_bindings SET status = 'revoked', updated_at = ?, version = version + 1 WHERE principal_id = ? AND status = 'active'`,
        ).run(ts, owner.id)
      }
    }

    if (hasChallenges) {
      rwDb.prepare(`UPDATE pairing_challenges SET status = 'expired', updated_at = ? WHERE status = 'active'`).run(ts)
    }

    const finalRow = rwDb.prepare(`SELECT id, version FROM delivery_principals WHERE id = ?`).get(replacementId) as { id?: unknown; version?: unknown } | undefined
    if (hasOutbox && typeof finalRow?.id === 'string' && typeof finalRow?.version === 'number') {
      rwDb.prepare(
        `UPDATE delivery_preference_projection_outbox
         SET terminal_at = ?, failure_code = 'owner-lineage-retired',
           next_attempt_at = 9007199254740991, updated_at = ?
         WHERE terminal_at IS NULL AND status IN ('pending', 'retry_wait')
           AND NOT (
             lane_kind = 'exact'
             AND lane_principal_record_id = ?
             AND lane_principal_version = ?
           )`,
      ).run(ts, ts, finalRow.id, finalRow.version)
    }

    rwDb.exec('COMMIT;')
    inTx = false
    return { ok: true, reused }
  } catch (error: unknown) {
    if (rwDb !== undefined && inTx) {
      try { rwDb.exec('ROLLBACK;') } catch { /* ignore rollback error */ }
    }
    return {
      ok: false,
      code: 'delivery-handoff-failed',
      reason: `更新 Delivery 主主人身份失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    rwDb?.close()
  }
}

function pauseStaleOwnerSystemAutomations(
  dbPath: string,
  currentPrincipalKey: string,
  now: number,
): number {
  if (!existsSync(dbPath)) return 0
  let rwDb: DatabaseSync | undefined
  let inTx = false
  try {
    const st = lstatSync(dbPath)
    if (st.isSymbolicLink() || !st.isFile()) return 0
    const ts = Math.max(0, Math.trunc(now))
    rwDb = new DatabaseSync(dbPath)
    rwDb.exec('PRAGMA busy_timeout = 5000;')
    const defTable = rwDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='automation_definitions'`).get() as { name?: unknown } | undefined
    if (defTable?.name !== 'automation_definitions') return 0
    rwDb.exec('BEGIN IMMEDIATE;')
    inTx = true
    const staleRows = rwDb.prepare(`
      SELECT id FROM automation_definitions
      WHERE system_owner IS NOT NULL
        AND system_owner <> ''
        AND status = 'active'
        AND json_valid(definition_json)
        AND json_type(definition_json, '$.principal') = 'text'
        AND json_extract(definition_json, '$.principal') <> ''
        AND json_extract(definition_json, '$.principal') <> ?
    `).all(currentPrincipalKey) as ReadonlyArray<{ id?: unknown }>
    const staleIds = staleRows.map(r => r.id).filter((id): id is string => typeof id === 'string')
    if (staleIds.length === 0) {
      rwDb.exec('COMMIT;')
      inTx = false
      return 0
    }
    const paused = rwDb.prepare(`
      UPDATE automation_definitions
      SET status = 'paused', next_run_at = NULL, updated_at = ?, version = version + 1
      WHERE system_owner IS NOT NULL
        AND system_owner <> ''
        AND status = 'active'
        AND json_valid(definition_json)
        AND json_type(definition_json, '$.principal') = 'text'
        AND json_extract(definition_json, '$.principal') <> ''
        AND json_extract(definition_json, '$.principal') <> ?
    `).run(ts, currentPrincipalKey)
    const incTable = rwDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='automation_incidents'`).get() as { name?: unknown } | undefined
    if (incTable?.name === 'automation_incidents') {
      const placeholders = staleIds.map(() => '?').join(', ')
      rwDb.prepare(`
        UPDATE automation_incidents
        SET alert_status = 'suppressed', alert_ref = NULL, updated_at = ?, version = version + 1
        WHERE alert_status = 'pending' AND automation_id IN (${placeholders})
      `).run(ts, ...staleIds)
    }
    rwDb.exec('COMMIT;')
    inTx = false
    return Number(paused.changes ?? 0)
  } catch {
    if (rwDb !== undefined && inTx) {
      try { rwDb.exec('ROLLBACK;') } catch { /* ignore rollback error */ }
    }
    return 0
  } finally {
    rwDb?.close()
  }
}

/** Explicit owner-confirmed promotion of the scanned Feishu/Lark account to primary owner. */
export async function promoteLarkOwnerInProfile(input: PromoteLarkOwnerInput): Promise<PromoteLarkOwnerResult> {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const now = input.now ?? Date.now()
  if (input.confirmed !== true) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'unmodified',
      existingAutonomyAnchored: false,
      errorCode: 'confirmation-required',
      note: '切换飞书主主人需要明确确认后才能执行。',
    })
  }
  const paths = resolveProfilePaths(input.host, env)
  if (detectFrozenSystemdProfile(paths.dshHome, paths.profileName, platform, env)) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'unmodified',
      existingAutonomyAnchored: false,
      errorCode: 'frozen-profile',
      note: '当前为受控 Linux systemd 冻结实例，拒绝在线切换主主人身份。',
    })
  }
  if (!paths.writable || paths.patchPath === null || paths.canonicalHome === null) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'unmodified',
      existingAutonomyAnchored: false,
      errorCode: 'unwritable-profile',
      note: '当前 profile 不可写入，无法切换飞书主主人身份。',
    })
  }
  const cleanOpenId = input.openId.trim()
  const cleanAccount = input.account.trim() || 'primary'
  const cleanTenant = input.tenant.trim() || 'personal'
  if (cleanOpenId === '' || !LARK_OPEN_ID_TOKEN.test(cleanOpenId)) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'not-returned',
      existingAutonomyAnchored: false,
      errorCode: 'invalid-open-id',
      note: '缺少有效的飞书扫码账号 open_id，无法一键设为主主人。',
    })
  }
  if (!SETUP_KEY_TOKEN.test(cleanAccount) || cleanAccount.includes('-legacy-') || !SETUP_KEY_TOKEN.test(cleanTenant)) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'unmodified',
      existingAutonomyAnchored: false,
      errorCode: 'invalid-identity-scope',
      note: '飞书 account/tenant 格式无效，拒绝切换主主人身份。',
    })
  }

  let doc: Document
  try {
    doc = readPatchDocument(paths.patchPath)
  } catch (error: unknown) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'unmodified',
      existingAutonomyAnchored: false,
      errorCode: 'patch-read-failed',
      note: `读取 cordis.patch.yml 失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }
  const seq = doc.contents as YAMLSeq
  const deliveryDesc = findEntry(input.descriptors, ns => ns === 'dsh-ray-assistant-delivery')
  const runtimeDelivery = asPlainRecord(deliveryDesc?.value)
  const mergedDelivery = {
    ...runtimeDelivery,
    ...getPatchRowConfig(seq, 'dsh-ray-assistant-delivery', doc),
  }
  const deliveryPatchRow = findPatchRow(seq, 'dsh-ray-assistant-delivery')
  const deliveryCfgNode = deliveryPatchRow ? readConfigMap(deliveryPatchRow, 'config') : undefined
  const scopedDb = checkScopedDbPath(
    deliveryCfgNode?.get('databasePath', true) ?? mergedDelivery['databasePath'],
    paths.canonicalHome,
  )
  const deliveryDbPath = scopedDb.scoped && scopedDb.resolved !== null
    ? scopedDb.resolved
    : join(paths.canonicalHome, 'assistant-delivery', 'state.sqlite')
  const defaultWorkspace = resolveDeliveryWorkspacePath(
    deliveryCfgNode?.get('defaultWorkspace', true),
    runtimeDelivery['defaultWorkspace'],
    paths.canonicalHome,
  )
  const rawPreset = strOrNull(mergedDelivery['defaultAgentPreset'])
  const defaultPreset = rawPreset !== null && PRESET_ID_TOKEN.test(rawPreset) ? rawPreset : 'standard'

  const principalKey = externalPrincipalId({
    channel: 'lark',
    account: cleanAccount,
    tenant: cleanTenant,
    user: cleanOpenId,
  })
  if (principalKey === null) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'unmodified',
      existingAutonomyAnchored: false,
      errorCode: 'invalid-principal',
      note: '无法构造有效的飞书主身份标识。',
    })
  }

  const handoff = handoffLarkOwnerInDeliverySqlite(deliveryDbPath, {
    channel: 'lark',
    account: cleanAccount,
    tenant: cleanTenant,
    user: cleanOpenId,
  }, now)
  if (!handoff.ok) {
    return Object.freeze({
      applied: false,
      ownerBinding: 'unmodified',
      existingAutonomyAnchored: hasAutonomyGrantsForOtherPrincipal(seq, input.descriptors, principalKey),
      errorCode: handoff.code,
      note: handoff.reason,
    })
  }

  // Ensure policy rules exist for the newly promoted primary owner without disturbing existing custom rules.
  // If the promoted owner already has an active DM binding in SQLite, also synchronize `ownerRoutes` now.
  let ownerRouteSynced = false
  let hasStaleOwnerRoute = false
  try {
    const sqliteAfterHandoff = readDeliverySqliteSnapshot(deliveryDbPath)
    const promotedActive = sqliteAfterHandoff.activeOwner !== null
      && sqliteAfterHandoff.activeOwner.principalKey === principalKey
      ? sqliteAfterHandoff.activeOwner
      : null
    const routeId = `owner-lark-${cleanAccount}`
    const extraPolicyRules: Record<string, unknown>[] = []

    const existingRoutesRaw = Array.isArray(mergedDelivery['ownerRoutes']) ? mergedDelivery['ownerRoutes'] : []
    hasStaleOwnerRoute = existingRoutesRaw.some(item => {
      const rec = asPlainRecord(item)
      const pKey = externalPrincipalId(asPlainRecord(rec['principal']))
      return pKey !== null && pKey !== principalKey
    })

    if (promotedActive?.conversation !== null && promotedActive?.conversation !== undefined) {
      const deliveryRow = ensurePatchRow(doc, seq, 'dsh-ray-assistant-delivery', '@dsh-ray/assistant-delivery')
      const deliveryCfgMap = ensureConfigMap(doc, deliveryRow, 'config')
      setMissingMapDefaults(doc, deliveryCfgMap, ASSISTANT_DELIVERY_DEFAULTS)
      const routeWorkspace = promotedActive.workspace !== null && isAbsolute(promotedActive.workspace)
        ? promotedActive.workspace
        : defaultWorkspace
      const routePreset = promotedActive.preset ?? defaultPreset
      const ownerRoute = {
        id: routeId,
        conversation: promotedActive.conversation,
        principal: { channel: 'lark', account: cleanAccount, tenant: cleanTenant, user: cleanOpenId },
        workspace: routeWorkspace,
        agentPreset: routePreset,
        policyRef: promotedActive.policyRef ?? 'owner-dm',
        minimumGeneration: promotedActive.generation,
      }
      const existingRoutes = isSeq(deliveryCfgMap.get('ownerRoutes', true))
        ? yamlNodeToJs(deliveryCfgMap.get('ownerRoutes', true), doc)
        : existingRoutesRaw
      deliveryCfgMap.set('ownerRoutes', createPlainNode(doc, syncPrimaryOwnerRoutes(existingRoutes, ownerRoute)))
      extraPolicyRules.push({
        id: `dsh-ray-owner-route-${routeId}`,
        effect: 'allow',
        subject: { kind: 'background', id: '*', workspace: routeWorkspace, principal: principalKey },
        actions: ['send'],
        resource: { kind: 'message', id: `route:${routeId}` },
        context: { initiators: ['background'] },
      })
      ownerRouteSynced = true
      hasStaleOwnerRoute = false
    }

    const manifestBundles = readProfileManifestBundles(paths.profileDir)
    const { effectivePolicyCfg, policyConfigNode, existingRulesBeforeDefaults } = ensurePolicyConfigTarget(
      doc,
      seq,
      input.descriptors,
      manifestBundles,
    )

    const rawExistingRules = existingRulesBeforeDefaults
      ?? (isSeq(policyConfigNode.get('rules', true)) ? yamlNodeToJs(policyConfigNode.get('rules', true), doc) : effectivePolicyCfg['rules'])
    const existingRules = ownerRouteSynced
      ? pruneStaleOwnerRouteRules(rawExistingRules, routeId, principalKey)
      : rawExistingRules
    const ownerRules = [
      ...buildLarkOwnerPolicyRules({
        account: cleanAccount,
        principalId: principalKey,
        workspace: defaultWorkspace,
        preset: defaultPreset,
        existingRules,
      }),
      ...extraPolicyRules,
    ]
    policyConfigNode.set('rules', createPlainNode(doc, upsertById(existingRules, ownerRules)))
    atomicWritePatchWithBackup(paths.patchPath, doc.toString({ lineWidth: 0 }), now)
  } catch (error: unknown) {
    return Object.freeze({
      applied: true,
      ownerBinding: handoff.reused ? 'reused-owner' : 'bound-owner',
      existingAutonomyAnchored: hasAutonomyGrantsForOtherPrincipal(seq, input.descriptors, principalKey),
      note: `已在 Delivery 中将 ${cleanOpenId} 设为飞书主主人，但同步策略文件失败（${error instanceof Error ? error.message : String(error)}）；请检查 cordis.patch.yml 并重启 profile。`,
    })
  }

  const { automationsCfg } = getPersonalAndPolicyConfigs(seq, input.descriptors)
  const scopedAutomationsDb = checkScopedDbPath(automationsCfg['databasePath'], paths.canonicalHome)
  const automationsDbPath = scopedAutomationsDb.scoped && scopedAutomationsDb.resolved !== null
    ? scopedAutomationsDb.resolved
    : join(paths.canonicalHome, 'assistant-automations', 'state.sqlite')
  const pausedStaleAutomations = pauseStaleOwnerSystemAutomations(automationsDbPath, principalKey, now)
  const pausedNote = pausedStaleAutomations > 0 ? `；已自动暂停 ${pausedStaleAutomations} 条旧主人遗留系统自动化` : ''

  const autonomyAnchoredElsewhere = hasAutonomyGrantsForOtherPrincipal(seq, input.descriptors, principalKey)
  const autonomyNote = autonomyAnchoredElsewhere
    ? (ownerRouteSynced
        ? '；已同步更新 ownerRoutes，检测到既有自主授权仍锚定旧主人，重启后在「自主能力向导」重新保存一次即可更新锚定'
        : '；检测到既有自主授权仍锚定旧主人，重启并在飞书给机器人发一句「你好」建立私聊会话后，在「自主能力向导」先点「一键初始化/修复前置项」同步路由再重新保存即可更新锚定')
    : hasStaleOwnerRoute
      ? '；重启并在飞书给机器人发一句「你好」后，如需主动汇报可在「系统体检」点击「一键绑定现有 Owner 主路由」'
      : ''
  return Object.freeze({
    applied: true,
    ownerBinding: handoff.reused ? 'reused-owner' : 'bound-owner',
    existingAutonomyAnchored: autonomyAnchoredElsewhere,
    note: `已将飞书账号 ${cleanOpenId} 设为本 profile 主主人（支持 /permission、/model 与审批卡片）${pausedNote}${autonomyNote}；下一步请重启 profile 生效。`,
  })
}

export interface ProfileRestartSupport {
  readonly supported: boolean
  readonly mode: ProfileRestartMode
  readonly command: string
  readonly targetLabel?: string
  readonly appPath?: string
}

export interface InspectProfileRestartInput {
  readonly host: AutonomyHostContext
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly execPath?: string
  readonly argv?: readonly string[]
}

const MACOS_DESKTOP_BUNDLE_ID = 'com.deepseek.dsh'

function findMacosDesktopAppPath(home: string, execPath: string, argv: readonly string[]): string | undefined {
  for (const candidate of [execPath, ...argv]) {
    const idx = candidate.indexOf('/DeepSeek Harness.app/')
    if (idx >= 0) {
      const appPath = candidate.slice(0, idx + '/DeepSeek Harness.app'.length)
      if (isAbsolute(appPath)) return appPath
    }
  }
  for (const appPath of ['/Applications/DeepSeek Harness.app', join(home, 'Applications', 'DeepSeek Harness.app')]) {
    try {
      const st = lstatSync(appPath)
      if (st.isDirectory() && !st.isSymbolicLink()) return appPath
    } catch {
      // Not installed in this location.
    }
  }
  return undefined
}

export function inspectProfileRestartSupport(input: InspectProfileRestartInput): ProfileRestartSupport {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv
  const paths = resolveProfilePaths(input.host, env)
  const manualCommand = paths.dshHome !== null
    ? `DSH_HOME=${JSON.stringify(paths.dshHome)} dsh --profile ${paths.profileName}`
    : `dsh --profile ${paths.profileName}`

  if (detectFrozenSystemdProfile(paths.dshHome, paths.profileName, platform, env)) {
    const unit = `dsh-profile-${paths.profileName}.service`
    return Object.freeze({
      supported: false,
      mode: 'manual',
      command: `systemctl --user restart ${unit}`,
    })
  }

  if (SETUP_KEY_TOKEN.test(paths.profileName)) {
    if (platform === 'darwin') {
      const label = `ai.deepseek.dsh.profile.${paths.profileName}`
      const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`)
      try {
        const st = lstatSync(plistPath)
        if (st.isFile() && !st.isSymbolicLink()) {
          const content = readFileSync(plistPath, 'utf8')
          if (content.includes(label)) {
            return Object.freeze({
              supported: true,
              mode: 'managed-service',
              command: `dsh-ray restart --profile ${paths.profileName}`,
              targetLabel: label,
            })
          }
        }
      } catch {
        // No managed LaunchAgent for this profile.
      }
    } else if (platform === 'linux') {
      const unit = `dsh-profile-${paths.profileName}.service`
      const unitPath = join(home, '.config', 'systemd', 'user', unit)
      try {
        const st = lstatSync(unitPath)
        if (st.isFile() && !st.isSymbolicLink()) {
          const content = readFileSync(unitPath, 'utf8')
          if (content.includes('DeepSeek Harness profile')) {
            return Object.freeze({
              supported: true,
              mode: 'managed-service',
              command: `dsh-ray restart --profile ${paths.profileName}`,
              targetLabel: unit,
            })
          }
        }
      } catch {
        // No managed systemd user unit for this profile.
      }
    }
  }

  if (platform === 'darwin') {
    const runningInsideApp = [execPath, ...argv].some(entry => entry.includes('/DeepSeek Harness.app/'))
    const appPath = findMacosDesktopAppPath(home, execPath, argv)
    if (runningInsideApp || (paths.profileName === 'desktop' && appPath !== undefined)) {
      return Object.freeze({
        supported: true,
        mode: 'desktop-app',
        command: '重启 DeepSeek Harness.app',
        ...(appPath === undefined ? {} : { appPath }),
      })
    }
  }

  return Object.freeze({
    supported: false,
    mode: 'manual',
    command: manualCommand,
  })
}

export type RestartSpawnFn = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    env: NodeJS.ProcessEnv
    detached: boolean
    stdio: 'ignore'
    shell: boolean
  }>,
) => Pick<ChildProcess, 'pid' | 'unref'>

export interface TriggerProfileRestartInput extends InspectProfileRestartInput {
  readonly confirmed: boolean
  readonly pid?: number
  readonly ppid?: number
  readonly uid?: number
  readonly spawnFn?: RestartSpawnFn
}

const MANAGED_SERVICE_RESTART_HELPER = [
  'const { execFileSync } = require("node:child_process");',
  'const delayMs = Math.max(0, Number(process.argv[1]) || 500);',
  'const cmd = process.argv[2];',
  'const args = process.argv.slice(3);',
  'setTimeout(() => { try { execFileSync(cmd, args, { stdio: "ignore", timeout: 15000 }); } catch {} }, delayMs);',
].join(' ')

const MACOS_DESKTOP_RESTART_HELPER = [
  'const { execFileSync } = require("node:child_process");',
  'const delayMs = Math.max(0, Number(process.argv[1]) || 500);',
  'const hostPid = Number(process.argv[2]) || 0;',
  'const bundleId = process.argv[3] || "com.deepseek.dsh";',
  'const appPath = process.argv[4] || "";',
  'const parentPid = Number(process.argv[5]) || 0;',
  'const alive = (pid) => { if (pid <= 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } };',
  'const appStillRegistered = () => {',
  '  try {',
  '    const out = execFileSync("/usr/bin/lsappinfo", ["find", `bundleid=${bundleId}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });',
  '    return out.trim().length > 0;',
  '  } catch { return false; }',
  '};',
  'const relaunch = () => {',
  '  try { execFileSync("/usr/bin/open", ["-b", bundleId], { stdio: "ignore", timeout: 10000 }); return; } catch {}',
  '  if (appPath) { try { execFileSync("/usr/bin/open", ["-a", appPath], { stdio: "ignore", timeout: 10000 }); } catch {} }',
  '};',
  'setTimeout(() => {',
  '  let quitSent = false;',
  '  try { execFileSync("/usr/bin/osascript", ["-e", `tell application id "${bundleId}" to quit`], { stdio: "ignore", timeout: 5000 }); quitSent = true; } catch {}',
  '  if (!quitSent && parentPid > 1 && alive(parentPid)) {',
  '    try { process.kill(parentPid, "SIGTERM"); } catch {}',
  '  }',
  '  const deadline = Date.now() + 15000;',
  '  const poll = () => {',
  '    if (!alive(hostPid) && !alive(parentPid) && !appStillRegistered()) { setTimeout(relaunch, 400); return; }',
  '    if (Date.now() < deadline) setTimeout(poll, 250);',
  '  };',
  '  setTimeout(poll, 350);',
  '}, delayMs);',
].join(' ')

function resolveSystemctlPath(): string {
  for (const candidate of ['/usr/bin/systemctl', '/bin/systemctl']) {
    try {
      const st = lstatSync(candidate)
      if (st.isFile() || st.isSymbolicLink()) return candidate
    } catch {
      // Try next standard path.
    }
  }
  return '/usr/bin/systemctl'
}

function defaultRestartSpawn(
  command: string,
  args: readonly string[],
  options: Readonly<{ env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore'; shell: boolean }>,
): Pick<ChildProcess, 'pid' | 'unref'> {
  return nodeSpawn(command, [...args], {
    env: options.env,
    detached: options.detached,
    stdio: options.stdio,
    shell: options.shell,
    windowsHide: true,
  })
}

/** Spawn an isolated detached helper to cleanly restart the Desktop app or managed resident service after RPC return. */
export async function triggerProfileRestart(input: TriggerProfileRestartInput): Promise<OwnerConsoleWriteResult> {
  if (input.confirmed !== true) {
    return Object.freeze({
      applied: false,
      entry: 'profile-restart',
      note: '重启 profile 需要明确确认后执行。',
    })
  }
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv
  const hostPid = input.pid ?? process.pid
  const runningInsideApp = [execPath, ...argv].some(entry => entry.includes('/DeepSeek Harness.app/'))
  const rawPpid = input.ppid ?? process.ppid
  const parentPid = runningInsideApp && Number.isSafeInteger(rawPpid) && rawPpid > 1 ? rawPpid : 0
  const uid = input.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  const paths = resolveProfilePaths(input.host, env)
  if (detectFrozenSystemdProfile(paths.dshHome, paths.profileName, platform, env)) {
    return Object.freeze({
      applied: false,
      entry: 'profile-restart',
      note: '当前为受控 Linux systemd 冻结实例，拒绝在线触发重启；请在终端通过受控运维命令重启服务。',
    })
  }

  const support = inspectProfileRestartSupport(input)
  if (!support.supported) {
    return Object.freeze({
      applied: false,
      entry: 'profile-restart',
      note: `当前运行模式不支持自动重启；请手动重启 profile（可运行：${support.command}）。`,
    })
  }

  const spawnFn = input.spawnFn ?? defaultRestartSpawn
  const helperEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    ...(env['HOME'] !== undefined ? { HOME: env['HOME'] } : {}),
    ...(env['XDG_RUNTIME_DIR'] !== undefined ? { XDG_RUNTIME_DIR: env['XDG_RUNTIME_DIR'] } : {}),
    ...(env['DBUS_SESSION_BUS_ADDRESS'] !== undefined ? { DBUS_SESSION_BUS_ADDRESS: env['DBUS_SESSION_BUS_ADDRESS'] } : {}),
    ELECTRON_RUN_AS_NODE: '1',
  }

  try {
    if (support.mode === 'managed-service' && support.targetLabel !== undefined) {
      let args: string[]
      if (platform === 'darwin') {
        if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
          return Object.freeze({
            applied: false,
            entry: 'profile-restart',
            note: `无法获取当前用户 UID；请在终端运行：${support.command}`,
          })
        }
        args = ['-e', MANAGED_SERVICE_RESTART_HELPER, '500', '/bin/launchctl', 'kickstart', '-k', `gui/${uid}/${support.targetLabel}`]
      } else {
        args = ['-e', MANAGED_SERVICE_RESTART_HELPER, '500', resolveSystemctlPath(), '--user', 'restart', support.targetLabel]
      }
      const child = spawnFn(execPath, args, { env: helperEnv, detached: true, stdio: 'ignore', shell: false })
      child.unref()
      if (child.pid === undefined || child.pid <= 0) {
        return Object.freeze({
          applied: false,
          entry: 'profile-restart',
          note: `未能拉起受管服务重启任务；请在终端运行：${support.command}`,
        })
      }
      return Object.freeze({
        applied: true,
        entry: 'profile-restart',
        note: `已触发受管常驻服务重启（${support.targetLabel}），约 3–8 秒后新凭据与飞书长连接将自动上线，届时刷新页面即可。`,
      })
    }

    if (support.mode === 'desktop-app') {
      const args = [
        '-e',
        MACOS_DESKTOP_RESTART_HELPER,
        '500',
        String(hostPid),
        MACOS_DESKTOP_BUNDLE_ID,
        support.appPath ?? '/Applications/DeepSeek Harness.app',
        String(parentPid),
      ]
      const child = spawnFn(execPath, args, { env: helperEnv, detached: true, stdio: 'ignore', shell: false })
      child.unref()
      if (child.pid === undefined || child.pid <= 0) {
        return Object.freeze({
          applied: false,
          entry: 'profile-restart',
          note: '未能拉起 DeepSeek Harness 重启任务；请按 Cmd+Q 退出并重新打开 DeepSeek Harness.app。',
        })
      }
      return Object.freeze({
        applied: true,
        entry: 'profile-restart',
        note: '正在自动退出并重新打开 DeepSeek Harness.app（通常 3–8 秒）；如系统未自动拉起，请手动打开应用即可加载新飞书连接。',
      })
    }
  } catch (error: unknown) {
    return Object.freeze({
      applied: false,
      entry: 'profile-restart',
      note: `触发自动重启失败（${error instanceof Error ? error.message : String(error)}）；请手动重启 profile（${support.command}）。`,
    })
  }

  return Object.freeze({
    applied: false,
    entry: 'profile-restart',
    note: `当前运行模式不支持自动重启；请手动重启 profile（${support.command}）。`,
  })
}
