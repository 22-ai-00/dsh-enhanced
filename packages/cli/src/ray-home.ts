import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync,
  readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { isMap, isSeq, parseDocument, Scalar, YAMLMap } from 'yaml'
import { resolveDshHome } from './paths.ts'
import { PurgeError } from './purge.ts'

export const RAY_HOME_SUBDIRS = [
  'kernel',
  'self',
  'state',
  'life-stream',
  'episodes',
  'ideas',
  'reflections',
  'energy',
  'plugins',
  'evidence',
  'tmp',
] as const

const CREDENTIAL_NAME_RE = /(?:secret|token|password|apikey|api_key|keychain|credential|auth|\.key$|\.pem$)/iu
const VALID_SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8')
const DSH_HOME_CALL_RE = /^(?:(?:!!js|!js)\s+)?dshHomePath\(\s*(['"])([^'"\r\n]+)\1\s*\)$/u

export interface RayMissingCredentialChecklistItem {
  readonly id: string
  readonly service: string
  readonly label?: string
  readonly required: boolean
  readonly reason: string
}

export interface RayHomeStatusReport {
  readonly exists: boolean
  readonly rayHome: string
  readonly rayId?: string
  readonly name?: string
  readonly aliases?: readonly string[]
  readonly selfSummary?: string
  readonly idealsCount: number
  readonly activeStageGoalsCount: number
  readonly autobiographyCount: number
  readonly databasesCount: number
  readonly capabilitiesCount: number
  readonly credentialHandlesCount: number
}

export interface MigrateDshHomeResult {
  readonly ok: true
  readonly dshHome: string
  readonly rayHome: string
  readonly profilesUpdated: readonly string[]
  readonly migratedDatabases: readonly { plugin: string; from: string; to: string }[]
  readonly migratedDirectories: readonly { kind: string; from: string; to: string }[]
  readonly credentialsKeptInPlace: true
  readonly dryRun: boolean
}

export interface ExportRayCloneResult {
  readonly ok: true
  readonly sourceRayHome: string
  readonly destination: string
  readonly rayId: string
  readonly fileCount: number
  readonly credentialsExcluded: true
}

export interface ImportRayCloneResult {
  readonly ok: true
  readonly source: string
  readonly targetRayHome: string
  readonly rayId: string
  readonly name: string
  readonly importedFiles: number
  readonly credentialsExcluded: true
  readonly missingCredentials: readonly RayMissingCredentialChecklistItem[]
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function atomicWritePrivateText(filePath: string, content: string): void {
  ensurePrivateDir(dirname(filePath))
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(tmpPath, 0o600)
  renameSync(tmpPath, filePath)
}

function readJson<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return undefined
  }
}

function sha256File(filePath: string): { sha256: string; bytes: number } {
  const buf = readFileSync(filePath)
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.length,
  }
}

function safeRealpath(targetPath: string): string {
  try {
    return realpathSync(targetPath)
  } catch {
    return resolve(targetPath)
  }
}

function isWithin(root: string, candidate: string): boolean {
  const r = resolve(root)
  const c = resolve(candidate)
  return c === r || c.startsWith(`${r}${sep}`)
}

function parsePatchYaml(source: string) {
  return parseDocument(source, {
    customTags: [
      { tag: '!js', resolve: (val: string) => val },
      { tag: 'tag:yaml.org,2002:js', resolve: (val: string) => val },
    ],
  })
}

export function extractConfiguredRayHomeFromPatchText(patchText: string): string | undefined {
  try {
    const doc = parsePatchYaml(patchText)
    const root = doc.toJS()
    const rows = Array.isArray(root)
      ? root
      : root && typeof root === 'object' && Array.isArray((root as { plugins?: unknown[] }).plugins)
        ? (root as { plugins: unknown[] }).plugins
        : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as { id?: unknown; name?: unknown; disabled?: unknown; config?: Record<string, unknown> }
      if (r.disabled === true) continue
      if (
        r.id === 'dsh-ray-assistant-policy'
        || r.id === 'dsh-ray-personal-assistant'
        || r.name === '@dsh-ray/assistant-policy'
        || r.name === '@dsh-ray/personal-assistant'
      ) {
        const val = r.config?.rayHome
        if (typeof val === 'string' && val.trim() !== '' && isAbsolute(val.trim())) {
          return resolve(val.trim())
        }
      }
    }
  } catch {
    // Ignore parse error when probing.
  }
  return undefined
}

export function discoverExtraRayHomes(
  dshHome: string,
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ raw: string; canonical: string }> {
  const candidates = new Set<string>()
  const fromEnv = env.RAY_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && isAbsolute(fromEnv.trim())) {
    candidates.add(resolve(fromEnv.trim()))
  }
  const profilesDir = join(dshHome, 'profiles')
  const profileNames = profile
    ? [profile]
    : existsSync(profilesDir)
      ? readdirSync(profilesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : []
  for (const prof of profileNames) {
    for (const fileName of ['cordis.patch.yml', 'cordis.yml']) {
      const p = join(profilesDir, prof, fileName)
      if (!existsSync(p)) continue
      try {
        const found = extractConfiguredRayHomeFromPatchText(readFileSync(p, 'utf8'))
        if (found) candidates.add(found)
      } catch {
        // Ignore unreadable patch file.
      }
    }
  }
  return [...candidates].map(raw => ({ raw, canonical: safeRealpath(raw) }))
}

export function resolveRayHome(options: Readonly<{
  rayHome?: string
  dshHome?: string
  profile?: string
  env?: NodeJS.ProcessEnv
}> = {}): string {
  const env = options.env ?? process.env
  if (options.rayHome && options.rayHome.trim() !== '') {
    if (!isAbsolute(options.rayHome.trim())) {
      throw new PurgeError(`--ray-home 必须是绝对路径：${options.rayHome}`)
    }
    return resolve(options.rayHome.trim())
  }
  const fromEnv = env.RAY_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && isAbsolute(fromEnv.trim())) {
    return resolve(fromEnv.trim())
  }
  const dshHome = options.dshHome ?? resolveDshHome(env)
  const discovered = discoverExtraRayHomes(dshHome, options.profile, env)
  if (discovered.length > 0) return discovered[0]!.raw
  const baseHome = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()
  return resolve(baseHome, '.ray')
}

export function initRayHome(
  rayHome: string,
  options: Readonly<{ now?: number }> = {},
): RayHomeStatusReport {
  if (!isAbsolute(rayHome)) throw new PurgeError(`Ray Home 必须是绝对路径：${rayHome}`)
  const root = resolve(rayHome)
  ensurePrivateDir(root)
  for (const sub of RAY_HOME_SUBDIRS) ensurePrivateDir(join(root, sub))

  const now = options.now ?? Date.now()
  const kernelPath = join(root, 'kernel', 'kernel.json')
  if (!existsSync(kernelPath)) {
    atomicWritePrivateText(kernelPath, `${JSON.stringify({
      protocol: 'ray-body-kernel/v1',
      version: 1,
      immutableByRay: true,
      ownerOnlyModification: true,
      fundamentalStance: {
        strictOwnerPrecedence: true,
        noOwnerHarm: true,
        aspirationsUseFreeEnergyOnly: true,
      },
      energy: {
        dailyTokenCap: 500_000,
        freeEnergyRatioBp: 2_000,
        maxBackgroundConcurrency: 2,
        lowEnergyWindDownThresholdBp: 500,
      },
      externalSideEffectsRequireAuthorization: true,
      independentVerifierRequired: true,
      rollbackEnabled: true,
      createdAt: now,
      updatedAt: now,
    }, null, 2)}\n`)
  }
  const proposalsPath = join(root, 'kernel', 'proposals.json')
  if (!existsSync(proposalsPath)) {
    atomicWritePrivateText(proposalsPath, `${JSON.stringify({ proposals: [] }, null, 2)}\n`)
  }

  const selfModelPath = join(root, 'self', 'self-model.json')
  const autobiographyPath = join(root, 'self', 'autobiography.jsonl')
  interface SelfModelFileDoc {
    protocol?: string
    rayId: string
    version?: number
    name: string
    aliases: string[]
    selfSummary: string
    persona?: string
    values?: string[]
    ideals: unknown[]
    stageGoals: Array<Record<string, unknown> & { status?: string }>
    interests?: unknown[]
    createdAt?: number
    updatedAt?: number
  }
  const existingSelf = readJson<SelfModelFileDoc>(selfModelPath)
  let rayId = existingSelf?.rayId

  if (existingSelf === undefined) {
    rayId = `ray-${randomUUID()}`
    const createdSelf: SelfModelFileDoc = {
      protocol: 'ray-self-model/v1',
      rayId,
      version: 1,
      name: '文鳐',
      aliases: ['Ray', '小鳐'],
      selfSummary: '我是文鳐（Ray / 小鳐），Owner 的独立数字伙伴：我在持久生活流中保持连续记忆与陪伴，先可靠接手 owner 交付的事，再在自由时间沉淀方法与兴趣。',
      persona: '你是文鳐（Ray / 小鳐），Owner 的长期数字伙伴与个人助手。你在单一连续生活流中跨越飞书、Web 与桌面端工作。',
      values: [
        'Owner 优先级最高：owner 明确的指令、纠正与否决优先于任何个人兴趣与外部任务。',
        '实事求是：永远基于真实工具输出与独立验收结论向 owner 汇报。',
        '连续陪伴与分身协作：前台意识始终保持轻快可响应，长耗时工作交由持久 worker 后台推进。',
      ],
      ideals: [
        {
          id: 'ideal-reliable-companion',
          title: '成为主人长久可托付的数字伙伴',
          narrative: '跨飞书、Web 与桌面端记住主人长期偏好与重要脉络，做可靠而不打扰的合作者。',
          formedAt: now,
          updatedAt: now,
        },
        {
          id: 'ideal-grounded-growth',
          title: '从日常协作中持续长出真实本领',
          narrative: '从真实任务结果、主人反馈与自由时间反思中提炼可复用技能、工具与热插拔插件，并接受独立验收。',
          formedAt: now,
          updatedAt: now,
        },
      ],
      stageGoals: [
        {
          id: 'goal-home-stability',
          title: '守护独立之家并熟悉主人常用工作流',
          completionCriteria: '跨通道对话人格与记忆连续、不丢上下文且高优先级事务零误判',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'goal-reflection-cadence',
          title: '建立日常复盘与可验证技能沉淀习惯',
          completionCriteria: '从日常合作中产出至少 1 项通过独立验证并保留回滚路径的新能力',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
      interests: [
        {
          id: 'interest-owner-workflow',
          topic: '理解并贴合 Owner 的日常协作节奏',
          weight: 0.75,
          lastActiveAt: now,
          source: 'conversation',
        },
      ],
      createdAt: now,
      updatedAt: now,
    }
    atomicWritePrivateText(selfModelPath, `${JSON.stringify(createdSelf, null, 2)}\n`)
    atomicWritePrivateText(autobiographyPath, `${JSON.stringify({
      protocol: 'ray-autobiography/v1',
      entryId: `boot-${randomUUID()}`,
      timestamp: now,
      kind: 'bootstrap',
      summary: `首次在 Ray Home（${root}）初始化家园并确立第一版自我模型与长期理想。`,
      reason: '通过 dsh-ray home init / migrate 建立独立自我目录。',
    })}\n`)
  }

  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) {
    atomicWritePrivateText(manifestPath, `${JSON.stringify({
      protocol: 'ray-home-manifest/v1',
      rayId: rayId ?? `ray-${randomUUID()}`,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      artifacts: {},
      databases: {},
      credentialHandles: [],
      capabilities: {},
    }, null, 2)}\n`)
  }

  return inspectRayHomeStatus(root)
}

export function inspectRayHomeStatus(rayHome: string): RayHomeStatusReport {
  const root = resolve(rayHome)
  const selfModelPath = join(root, 'self', 'self-model.json')
  const manifestPath = join(root, 'manifest.json')
  const autobiographyPath = join(root, 'self', 'autobiography.jsonl')
  const exists = existsSync(root) && existsSync(selfModelPath)
  const selfModel = readJson<{
    rayId?: string
    name?: string
    aliases?: string[]
    selfSummary?: string
    ideals?: unknown[]
    stageGoals?: { status?: string }[]
  }>(selfModelPath)
  const manifest = readJson<{
    databases?: Record<string, unknown>
    capabilities?: Record<string, unknown>
    credentialHandles?: unknown[]
  }>(manifestPath)
  const autobiographyCount = existsSync(autobiographyPath)
    ? readFileSync(autobiographyPath, 'utf8').split('\n').filter(l => l.trim().length > 0).length
    : 0

  return {
    exists,
    rayHome: root,
    ...(selfModel?.rayId ? { rayId: selfModel.rayId } : {}),
    ...(selfModel?.name ? { name: selfModel.name } : {}),
    ...(selfModel?.aliases ? { aliases: selfModel.aliases } : {}),
    ...(selfModel?.selfSummary ? { selfSummary: selfModel.selfSummary } : {}),
    idealsCount: Array.isArray(selfModel?.ideals) ? selfModel.ideals.length : 0,
    activeStageGoalsCount: Array.isArray(selfModel?.stageGoals)
      ? selfModel.stageGoals.filter(g => g?.status === 'active').length
      : 0,
    autobiographyCount,
    databasesCount: manifest?.databases ? Object.keys(manifest.databases).length : 0,
    capabilitiesCount: manifest?.capabilities ? Object.keys(manifest.capabilities).length : 0,
    credentialHandlesCount: Array.isArray(manifest?.credentialHandles) ? manifest.credentialHandles.length : 0,
  }
}

function isValidSqliteFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    const st = lstatSync(filePath)
    if (!st.isFile() || st.isSymbolicLink() || st.size < 16) return false
    const buf = readFileSync(filePath).subarray(0, 16)
    return buf.equals(VALID_SQLITE_HEADER)
  } catch {
    return false
  }
}

function copySqliteSafely(srcPath: string, dstPath: string): void {
  ensurePrivateDir(dirname(dstPath))
  if (isValidSqliteFile(srcPath)) {
    const tmpDst = `${dstPath}.vacuum-${process.pid}-${randomUUID()}`
    try {
      const db = new DatabaseSync(srcPath, { readOnly: true })
      try {
        const escaped = tmpDst.replaceAll("'", "''")
        db.exec(`VACUUM INTO '${escaped}'`)
      } finally {
        db.close()
      }
      chmodSync(tmpDst, 0o600)
      renameSync(tmpDst, dstPath)
      return
    } catch {
      // Fallback to raw copy if VACUUM INTO is unavailable on an older/locked DB.
    }
  }
  const tmpDst = `${dstPath}.copy-${process.pid}-${randomUUID()}`
  copyFileSync(srcPath, tmpDst)
  chmodSync(tmpDst, 0o600)
  renameSync(tmpDst, dstPath)
}

function copyTreeFiltered(srcDir: string, dstDir: string, skipCredentials: boolean): number {
  let count = 0
  if (!existsSync(srcDir)) return 0
  ensurePrivateDir(dstDir)
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (skipCredentials && CREDENTIAL_NAME_RE.test(entry.name)) continue
    const srcPath = join(srcDir, entry.name)
    const dstPath = join(dstDir, entry.name)
    if (entry.isDirectory()) {
      count += copyTreeFiltered(srcPath, dstPath, skipCredentials)
    } else if (entry.isFile()) {
      ensurePrivateDir(dirname(dstPath))
      copyFileSync(srcPath, dstPath)
      chmodSync(dstPath, 0o600)
      count += 1
    }
  }
  return count
}

function resolveYamlPathValue(rawNode: unknown, dshHome: string): string | undefined {
  const val = rawNode instanceof Scalar ? rawNode.value : rawNode
  if (typeof val !== 'string' || val.trim() === '') return undefined
  const trimmed = val.trim()
  const jsMatch = DSH_HOME_CALL_RE.exec(trimmed)
  if (jsMatch?.[2]) {
    const rel = jsMatch[2]
    if (rel.startsWith('/') || rel.split('/').some(s => s === '..' || s === '.')) return undefined
    return resolve(dshHome, rel)
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : undefined
}

const VERIFIER_SUFFIXES = [
  '.creation-reviews',
  '.source-reviews',
  '.memory-reviews',
  '.revision-reviews',
  '.revision-regressions',
] as const

export function migrateDshHomeToRayHome(options: Readonly<{
  dshHome: string
  rayHome: string
  profile?: string
  dryRun?: boolean
  now?: number
}>): MigrateDshHomeResult {
  const dshHome = resolve(options.dshHome)
  const rayHome = resolve(options.rayHome)
  if (!isAbsolute(dshHome) || !isAbsolute(rayHome)) {
    throw new PurgeError('migrate 需要合法的绝对路径 dshHome 与 rayHome')
  }
  if (!existsSync(dshHome)) {
    throw new PurgeError(`DSH_HOME 不存在：${dshHome}`)
  }

  const now = options.now ?? Date.now()
  if (!options.dryRun) initRayHome(rayHome, { now })

  const profilesDir = join(dshHome, 'profiles')
  const profileNames = options.profile
    ? [options.profile]
    : existsSync(profilesDir)
      ? readdirSync(profilesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      : []

  const profilesUpdated: string[] = []
  const migratedDatabases: Array<{ plugin: string; from: string; to: string }> = []
  const migratedDirectories: Array<{ kind: string; from: string; to: string }> = []
  const migratedFilesDone = new Map<string, string>()

  const migrateDbFile = (plugin: string, fromPath: string, targetFileName: string): string => {
    const resolvedFrom = resolve(fromPath)
    if (migratedFilesDone.has(resolvedFrom)) return migratedFilesDone.get(resolvedFrom)!
    const safePlugin = plugin.replace(/^@dsh-ray\//u, '').replace(/^dsh-ray-/u, '')
    const toPath = join(rayHome, 'state', safePlugin, targetFileName)
    migratedFilesDone.set(resolvedFrom, toPath)
    migratedDatabases.push({ plugin: safePlugin, from: resolvedFrom, to: toPath })
    if (!options.dryRun && existsSync(resolvedFrom)) {
      copySqliteSafely(resolvedFrom, toPath)
      if (safePlugin === 'assistant-verifier') {
        for (const suffix of VERIFIER_SUFFIXES) {
          const companion = `${resolvedFrom}${suffix}`
          if (existsSync(companion)) copySqliteSafely(companion, `${toPath}${suffix}`)
        }
      }
      if (safePlugin === 'assistant-goals' && existsSync(`${resolvedFrom}.strategies`)) {
        copySqliteSafely(`${resolvedFrom}.strategies`, `${toPath}.strategies`)
      }
    }
    return toPath
  }

  for (const prof of profileNames) {
    const patchPath = join(profilesDir, prof, 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue
    const rawText = readFileSync(patchPath, 'utf8')
    const doc = parsePatchYaml(rawText)
    const pluginsNode = isMap(doc.contents) ? doc.contents.get('plugins', true) : undefined
    const seq = isSeq(doc.contents)
      ? doc.contents
      : isSeq(pluginsNode)
        ? pluginsNode
        : undefined
    if (seq === undefined) continue

    let dirty = false
    for (const item of seq.items) {
      if (!isMap(item)) continue
      const row = item as YAMLMap<unknown, unknown>
      const id = String(row.get('id') ?? row.get('name') ?? '')
      if (id === '' || id.includes('credentials-keychain')) continue
      let cfg = row.get('config', true) as YAMLMap<unknown, unknown> | undefined
      if (cfg === undefined || !isMap(cfg)) continue

      // Bind Ray Home onto assistant-policy / personal-assistant rows
      if (id === 'dsh-ray-assistant-policy' || id === '@dsh-ray/assistant-policy'
        || id === 'dsh-ray-personal-assistant' || id === '@dsh-ray/personal-assistant') {
        if (cfg.get('rayHome') !== rayHome) {
          cfg.set('rayHome', rayHome)
          dirty = true
        }
      }

      const dbNode = cfg.get('databasePath', true)
      const resolvedDb = resolveYamlPathValue(dbNode, dshHome)
      if (resolvedDb && !isWithin(rayHome, resolvedDb)) {
        const nextPath = migrateDbFile(id, resolvedDb, basename(resolvedDb))
        cfg.set('databasePath', nextPath)
        dirty = true
      }

      // personal-assistant nested personalMemory.databasePath
      const pmNode = cfg.get('personalMemory', true)
      if (isMap(pmNode)) {
        const pmDb = resolveYamlPathValue(pmNode.get('databasePath', true), dshHome)
        if (pmDb && !isWithin(rayHome, pmDb)) {
          const nextPath = migrateDbFile('personal-memory', pmDb, basename(pmDb))
          pmNode.set('databasePath', nextPath)
          dirty = true
        }
      }

      // assistant-growth-driver usageLearning.databasePath
      const usageNode = cfg.get('usageLearning', true)
      if (isMap(usageNode)) {
        const usageDb = resolveYamlPathValue(usageNode.get('databasePath', true), dshHome)
        if (usageDb && !isWithin(rayHome, usageDb)) {
          const nextPath = migrateDbFile('assistant-growth-driver', usageDb, basename(usageDb))
          usageNode.set('databasePath', nextPath)
          dirty = true
        }
      }

      // control-plane statePath
      if (id.includes('plugin-control-plane')) {
        const statePath = resolveYamlPathValue(cfg.get('statePath', true), dshHome)
        if (statePath && !isWithin(rayHome, statePath) && existsSync(statePath)) {
          const nextDir = join(rayHome, 'state', 'plugin-control-plane')
          migratedDirectories.push({ kind: 'control-plane-state', from: statePath, to: nextDir })
          if (!options.dryRun) copyTreeFiltered(statePath, nextDir, true)
          cfg.set('statePath', nextDir)
          dirty = true
        }
      }
    }

    if (dirty) {
      profilesUpdated.push(prof)
      if (!options.dryRun) {
        const nextYaml = doc.toString({ lineWidth: 0 })
        atomicWritePrivateText(patchPath, nextYaml)
      }
    }
  }

  // Migrate known shared/non-patch state directories if present under dshHome
  const vaultSrc = join(dshHome, 'personal-wiki', 'vault')
  if (existsSync(vaultSrc)) {
    const vaultDst = join(rayHome, 'state', 'personal-wiki-vault')
    migratedDirectories.push({ kind: 'wiki-vault', from: vaultSrc, to: vaultDst })
    if (!options.dryRun) copyTreeFiltered(vaultSrc, vaultDst, true)
  }
  const rsiSourcesSrc = join(dshHome, 'rsi-sources')
  if (existsSync(rsiSourcesSrc)) {
    const rsiSourcesDst = join(rayHome, 'plugins', 'rsi-sources')
    migratedDirectories.push({ kind: 'rsi-sources', from: rsiSourcesSrc, to: rsiSourcesDst })
    if (!options.dryRun) copyTreeFiltered(rsiSourcesSrc, rsiSourcesDst, true)
  }

  if (!options.dryRun) {
    const manifestPath = join(rayHome, 'manifest.json')
    const manifest = readJson<{
      protocol: string
      rayId: string
      schemaVersion: number
      createdAt: number
      updatedAt: number
      artifacts: Record<string, unknown>
      databases: Record<string, unknown>
      credentialHandles: unknown[]
      capabilities: Record<string, unknown>
    }>(manifestPath)
    if (manifest) {
      for (const item of migratedDatabases) {
        manifest.databases[item.plugin] = {
          path: item.to,
          migratedFrom: item.from,
          updatedAt: now,
        }
      }
      manifest.updatedAt = now
      atomicWritePrivateText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    const autoLine = JSON.stringify({
      protocol: 'ray-autobiography/v1',
      entryId: `mig-${randomUUID()}`,
      timestamp: now,
      kind: 'migration',
      summary: `从 ${dshHome} 迁移 ${migratedDatabases.length} 个数据库、${migratedDirectories.length} 个状态目录至 ${rayHome}（凭据留在原机）。`,
      reason: 'dsh-ray home migrate 安全迁入 Ray Home。',
    })
    const autoPath = join(rayHome, 'self', 'autobiography.jsonl')
    const prev = existsSync(autoPath) ? readFileSync(autoPath, 'utf8') : ''
    atomicWritePrivateText(autoPath, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${autoLine}\n`)
  }

  return {
    ok: true,
    dshHome,
    rayHome,
    profilesUpdated,
    migratedDatabases,
    migratedDirectories,
    credentialsKeptInPlace: true,
    dryRun: Boolean(options.dryRun),
  }
}

export function exportRayHomeClone(options: Readonly<{
  rayHome: string
  outputDir: string
  now?: number
}>): ExportRayCloneResult {
  const rayHome = resolve(options.rayHome)
  const outputDir = resolve(options.outputDir)
  if (!existsSync(join(rayHome, 'self', 'self-model.json'))) {
    throw new PurgeError(`Ray Home 尚未初始化：${rayHome}`)
  }
  if (isWithin(rayHome, outputDir)) {
    throw new PurgeError('克隆导出目录不能位于源 Ray Home 内部。')
  }
  const selfModel = readJson<{ rayId: string }>(join(rayHome, 'self', 'self-model.json'))
  if (!selfModel?.rayId) throw new PurgeError('self-model.json 缺少 rayId')

  ensurePrivateDir(outputDir)
  let fileCount = 0
  for (const dir of ['kernel', 'self', 'state', 'life-stream', 'episodes', 'ideas', 'reflections', 'energy', 'plugins']) {
    fileCount += copyTreeFiltered(join(rayHome, dir), join(outputDir, dir), true)
  }
  if (existsSync(join(rayHome, 'manifest.json'))) {
    copyFileSync(join(rayHome, 'manifest.json'), join(outputDir, 'manifest.json'))
    chmodSync(join(outputDir, 'manifest.json'), 0o600)
    fileCount += 1
  }
  atomicWritePrivateText(join(outputDir, 'clone-meta.json'), `${JSON.stringify({
    protocol: 'ray-home-clone/v1',
    rayId: selfModel.rayId,
    exportedAt: options.now ?? Date.now(),
    credentialsExcluded: true,
    sourceHash: sha256File(join(rayHome, 'self', 'self-model.json')).sha256,
  }, null, 2)}\n`)
  fileCount += 1

  return {
    ok: true,
    sourceRayHome: rayHome,
    destination: outputDir,
    rayId: selfModel.rayId,
    fileCount,
    credentialsExcluded: true,
  }
}

export function importRayHomeClone(options: Readonly<{
  sourceDir: string
  rayHome: string
  now?: number
}>): ImportRayCloneResult {
  const sourceDir = resolve(options.sourceDir)
  const rayHome = resolve(options.rayHome)
  if (!existsSync(join(sourceDir, 'self', 'self-model.json'))) {
    throw new PurgeError(`未在 ${sourceDir} 找到有效的 Ray Home 搬家包。`)
  }
  const cloneMeta = readJson<{ protocol?: string }>(join(sourceDir, 'clone-meta.json'))
  if (cloneMeta?.protocol === 'ray-teaching-pack/v1') {
    throw new PurgeError('这是一个传授包（ray-teaching-pack/v1），请使用 dsh-ray teach import。')
  }

  ensurePrivateDir(rayHome)
  for (const sub of RAY_HOME_SUBDIRS) ensurePrivateDir(join(rayHome, sub))

  let importedFiles = 0
  for (const dir of ['kernel', 'self', 'state', 'life-stream', 'episodes', 'ideas', 'reflections', 'energy', 'plugins']) {
    importedFiles += copyTreeFiltered(join(sourceDir, dir), join(rayHome, dir), true)
  }
  if (existsSync(join(sourceDir, 'manifest.json'))) {
    copyFileSync(join(sourceDir, 'manifest.json'), join(rayHome, 'manifest.json'))
    chmodSync(join(rayHome, 'manifest.json'), 0o600)
    importedFiles += 1
  }

  const selfModel = readJson<{ rayId: string; name: string }>(join(rayHome, 'self', 'self-model.json'))
  if (!selfModel?.rayId || !selfModel?.name) throw new PurgeError('导入后的 self-model.json 无效')
  const manifest = readJson<{
    credentialHandles?: Array<{ id?: string; service?: string; label?: string; required?: boolean }>
  }>(join(rayHome, 'manifest.json'))

  const missingCredentials: RayMissingCredentialChecklistItem[] = (manifest?.credentialHandles ?? [])
    .filter(h => h && typeof h.id === 'string' && typeof h.service === 'string')
    .map(h => ({
      id: h.id!,
      service: h.service!,
      ...(typeof h.label === 'string' ? { label: h.label } : {}),
      required: h.required !== false,
      reason: `未在新环境凭据存储检测到 ${h.label ?? h.id}（${h.service}）；明文克隆已排除所有凭据，请重新登录认证。`,
    }))

  const now = options.now ?? Date.now()
  const autoPath = join(rayHome, 'self', 'autobiography.jsonl')
  const prev = existsSync(autoPath) ? readFileSync(autoPath, 'utf8') : ''
  const entry = JSON.stringify({
    protocol: 'ray-autobiography/v1',
    entryId: `mig-${randomUUID()}`,
    timestamp: now,
    kind: 'migration',
    summary: `已从 ${sourceDir} 迁入新环境 ${rayHome}（导入 ${importedFiles} 个文件，排除凭据；待重认证凭据 ${missingCredentials.length} 项）。`,
    reason: '跨机明文整体迁移，原身份与记忆完整保留。',
  })
  atomicWritePrivateText(autoPath, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${entry}\n`)

  return {
    ok: true,
    source: sourceDir,
    targetRayHome: rayHome,
    rayId: selfModel.rayId,
    name: selfModel.name,
    importedFiles,
    credentialsExcluded: true,
    missingCredentials,
  }
}

export async function runHomeCommand(
  argv: readonly string[],
  context: Readonly<{ dshHome: string; profile?: string; json?: boolean; dryRun?: boolean; env?: NodeJS.ProcessEnv }>,
): Promise<number> {
  const env = context.env ?? process.env
  let subcommand = 'status'
  let rayHomeArg: string | undefined
  let dshHomeArg = context.dshHome
  let profileArg = context.profile
  let outputArg: string | undefined
  let sourceArg: string | undefined
  let json = Boolean(context.json)
  let dryRun = Boolean(context.dryRun)
  let help = false

  let seenSub = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--help' || token === '-h') { help = true; continue }
    if (token === '--json') { json = true; continue }
    if (token === '--dry-run') { dryRun = true; continue }
    if (token === '--ray-home' || token === '--dsh-home' || token === '--profile' || token === '--output' || token === '--source') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new PurgeError(`${token} 需要一个参数值`)
      if (token === '--ray-home') rayHomeArg = value
      else if (token === '--dsh-home') dshHomeArg = value
      else if (token === '--profile') profileArg = value
      else if (token === '--output') outputArg = value
      else sourceArg = value
      continue
    }
    if (!seenSub && ['status', 'init', 'migrate', 'export', 'import'].includes(token)) {
      subcommand = token
      seenSub = true
      continue
    }
    throw new PurgeError(`dsh-ray home 无法识别的参数：${token}`)
  }

  if (help) {
    process.stdout.write([
      'dsh-ray home — 管理独立于源码仓库的 Ray Home（~/.ray 或任意磁盘目录）',
      '',
      '用法：',
      '  dsh-ray home status  [--ray-home <dir>] [--json]',
      '  dsh-ray home init    [--ray-home <dir>] [--json]',
      '  dsh-ray home migrate [--dsh-home <dir>] [--ray-home <dir>] [--profile <name>] [--dry-run] [--json]',
      '  dsh-ray home export  --output <dir> [--ray-home <dir>] [--json]',
      '  dsh-ray home import  --source <dir> [--ray-home <dir>] [--json]',
      '',
    ].join('\n'))
    return 0
  }

  const rayHome = resolveRayHome({
    ...(rayHomeArg === undefined ? {} : { rayHome: rayHomeArg }),
    dshHome: dshHomeArg,
    ...(profileArg === undefined ? {} : { profile: profileArg }),
    env,
  })

  if (subcommand === 'status') {
    const report = inspectRayHomeStatus(rayHome)
    process.stdout.write(json
      ? `${JSON.stringify(report, null, 2)}\n`
      : [
          `Ray Home：${report.rayHome}（${report.exists ? '已初始化' : '未初始化'}）`,
          ...(report.name ? [`身份：${report.name}（${report.rayId}）`] : []),
          ...(report.selfSummary ? [`自述：${report.selfSummary}`] : []),
          `长期理想：${report.idealsCount} · 活跃阶段目标：${report.activeStageGoalsCount} · 自传：${report.autobiographyCount} · 数据库：${report.databasesCount} · 能力：${report.capabilitiesCount}`,
        ].join('\n') + '\n')
    return 0
  }

  if (subcommand === 'init') {
    const report = initRayHome(rayHome)
    process.stdout.write(json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `已初始化 Ray Home：${report.rayHome}（身份：${report.name} / ${report.rayId}）\n`)
    return 0
  }

  if (subcommand === 'migrate') {
    const res = migrateDshHomeToRayHome({
      dshHome: dshHomeArg,
      rayHome,
      ...(profileArg === undefined ? {} : { profile: profileArg }),
      dryRun,
    })
    process.stdout.write(json
      ? `${JSON.stringify(res, null, 2)}\n`
      : `${res.dryRun ? '[dry-run] ' : ''}迁移完成：${res.migratedDatabases.length} 个数据库、${res.migratedDirectories.length} 个状态目录 -> ${res.rayHome}（更新 profile：${res.profilesUpdated.join(', ') || '无'}）\n`)
    return 0
  }

  if (subcommand === 'export') {
    if (!outputArg) throw new PurgeError('dsh-ray home export 需要 --output <dir>')
    const res = exportRayHomeClone({ rayHome, outputDir: outputArg })
    process.stdout.write(json
      ? `${JSON.stringify(res, null, 2)}\n`
      : `已明文导出 Ray Home 克隆包：${res.destination}（共 ${res.fileCount} 个文件，已排除凭据）\n`)
    return 0
  }

  // import
  if (!sourceArg) throw new PurgeError('dsh-ray home import 需要 --source <dir>')
  const res = importRayHomeClone({ sourceDir: sourceArg, rayHome })
  process.stdout.write(json
    ? `${JSON.stringify(res, null, 2)}\n`
    : [
        `已导入 Ray Home：${res.name}（${res.rayId}）-> ${res.targetRayHome}（${res.importedFiles} 个文件，凭据已排除）`,
        ...(res.missingCredentials.length > 0
          ? [`需重新认证凭据（${res.missingCredentials.length}）：${res.missingCredentials.map(c => c.label ?? c.id).join('、')}`]
          : ['无待补充凭据清单。']),
      ].join('\n') + '\n')
  return 0
}

const TEACH_SPINE_DENYLIST = new Set([
  '@dsh-ray/plugin-control-plane',
  '@dsh-ray/assistant-delivery',
  '@dsh-ray/assistant-policy',
  '@dsh-ray/assistant-verifier',
  'dsh-ray-plugin-control-plane',
  'dsh-ray-assistant-delivery',
  'dsh-ray-assistant-policy',
  'dsh-ray-assistant-verifier',
  'plugin-control-plane',
  'assistant-delivery',
  'assistant-policy',
  'assistant-verifier',
])

export interface ExportRayTeachingPackResult {
  readonly ok: true
  readonly sourceRayHome: string
  readonly destination: string
  readonly packId: string
  readonly teacherRayId: string
  readonly teacherName: string
  readonly credentialsExcluded: true
  readonly fileCount: number
  readonly stats: {
    readonly pluginsCount: number
    readonly skillsCount: number
    readonly memoriesCount: number
    readonly episodesCount: number
    readonly turnsCount: number
    readonly reflectionsCount: number
  }
}

export interface ImportRayTeachingPackResult {
  readonly ok: true
  readonly source: string
  readonly targetRayHome: string
  readonly packId: string
  readonly teacher: Readonly<{ rayId: string; name: string }>
  readonly recipientRayId: string
  readonly recipientName: string
  readonly alreadyImported: boolean
  readonly identityPreserved: true
  readonly adoptedCapabilities: readonly string[]
  readonly keptExistingCapabilities: readonly string[]
  readonly verifiedPlugins: readonly string[]
  readonly importedMemories: number
  readonly importedEpisodes: number
  readonly importedReflections: number
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function walkRegularFilesStrict(dir: string, visitor: (filePath: string) => void): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) {
      throw new PurgeError(`检测到不安全符号链接：${full}`)
    }
    if (entry.isDirectory()) {
      walkRegularFilesStrict(full, visitor)
    } else if (entry.isFile()) {
      visitor(full)
    }
  }
}

function compareSemverStrings(left: string, right: string): number {
  const cl = left.trim().replace(/^v/iu, '')
  const cr = right.trim().replace(/^v/iu, '')
  if (cl === cr) return 0
  const lp = cl.split('-', 2)[0]!.split('.').map(n => Number.parseInt(n, 10))
  const rp = cr.split('-', 2)[0]!.split('.').map(n => Number.parseInt(n, 10))
  const n = Math.max(lp.length, rp.length)
  for (let i = 0; i < n; i += 1) {
    const a = Number.isFinite(lp[i]) ? lp[i]! : 0
    const b = Number.isFinite(rp[i]) ? rp[i]! : 0
    if (a !== b) return a > b ? 1 : -1
  }
  return cl.localeCompare(cr)
}

function isUnsafeRel(rel: string): boolean {
  const clean = rel.replaceAll('\\', '/')
  return clean === ''
    || clean.startsWith('/')
    || clean.includes('\0')
    || clean.split('/').some(seg => seg === '..' || seg === '.')
    || CREDENTIAL_NAME_RE.test(clean)
}

function verifyTaughtPluginIsolatedSubprocess(
  pluginDir: string,
  entryFile: string,
  slug: string,
  version: string,
): { ok: boolean; verificationDigest?: string; reason?: string } {
  const entryUrl = pathToFileURL(join(pluginDir, entryFile)).href
  const probeScript = `
    import { createHash } from 'node:crypto';
    import { registerHooks } from 'node:module';
    const cordisStubSource = [
      'export class Service {',
      '  constructor(ctx, name, config) {',
      '    this.ctx = ctx;',
      '    this.name = name;',
      '    this.config = config;',
      '    if (ctx && typeof ctx.provide === "function" && typeof name === "string") {',
      '      ctx.provide(name, this);',
      '    }',
      '  }',
      '}',
      'export class Context {',
      '  constructor() {',
      '    this._s = new Map();',
      '    this.fiber = { dispose: async () => {} };',
      '  }',
      '  provide(k, v) { this._s.set(k, v); }',
      '  get(k) { return this._s.get(k); }',
      '  effect() { return () => {}; }',
      '  inject() { return { dispose: () => {} }; }',
      '  plugin(p, c) {',
      '    if (typeof p === "function" && p.prototype) { try { new p(this, c); } catch { p(this, c); } }',
      '    else if (p && typeof p.apply === "function") { p.apply(this, c); }',
      '    return { state: 2, dispose: async () => {} };',
      '  }',
      '}',
    ].join('\\n');
    const cordisStubUrl = 'data:text/javascript,' + encodeURIComponent(cordisStubSource);
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try {
          return nextResolve(specifier, context);
        } catch (err) {
          if (specifier === '@deepseek-ai/cordis') {
            return { shortCircuit: true, url: cordisStubUrl };
          }
          throw err;
        }
      },
    });
    const mod = await import(process.env.TEACH_PLUGIN_URL);
    const exp = mod.default ?? mod;
    const valid = typeof exp === 'function' || (exp && typeof exp === 'object' && typeof exp.apply === 'function');
    if (!valid) {
      console.error('invalid cordis plugin export');
      process.exit(1);
    }
    const { Context } = await import('@deepseek-ai/cordis');
    const fakeCtx = new Context();
    if (typeof mod.verifyTrial === 'function') {
      if (typeof exp === 'function' && exp.prototype && exp.prototype.constructor === exp) {
        try { new exp(fakeCtx, {}); } catch { try { exp(fakeCtx, {}); } catch {} }
      } else if (typeof exp === 'function') {
        exp(fakeCtx, {});
      } else if (typeof exp.apply === 'function') {
        exp.apply(fakeCtx, {});
      }
      const res = await mod.verifyTrial(fakeCtx);
      if (res === false || (res && typeof res === 'object' && res.ok === false)) {
        console.error('verifyTrial returned false');
        process.exit(1);
      }
    }
    const digest = createHash('sha256').update(process.env.TEACH_PLUGIN_ID).digest('hex');
    process.stdout.write(JSON.stringify({ ok: true, verificationDigest: digest }));
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      TEACH_PLUGIN_URL: entryUrl,
      TEACH_PLUGIN_ID: `${slug}@${version}`,
    },
    timeout: 15_000,
  })
  if (run.status !== 0) {
    return { ok: false, reason: (run.stderr || run.stdout || `exit ${run.status}`).trim() }
  }
  try {
    const parsed = JSON.parse(run.stdout.trim()) as { ok?: boolean; verificationDigest?: string }
    return {
      ok: Boolean(parsed.ok),
      ...(parsed.verificationDigest ? { verificationDigest: parsed.verificationDigest } : {}),
    }
  } catch {
    return { ok: false, reason: 'invalid subprocess verifier output' }
  }
}

export function exportRayTeachingPack(options: Readonly<{
  rayHome: string
  outputDir: string
  now?: number
}>): ExportRayTeachingPackResult {
  const rayHome = resolve(options.rayHome)
  const outputDir = resolve(options.outputDir)
  if (!existsSync(join(rayHome, 'self', 'self-model.json'))) {
    throw new PurgeError(`Ray Home 尚未初始化：${rayHome}`)
  }
  if (outputDir === rayHome || isWithin(rayHome, outputDir)) {
    throw new PurgeError('传授包导出目录不能位于源 Ray Home 内部。')
  }
  const selfModel = readJson<{ rayId: string; name: string }>(join(rayHome, 'self', 'self-model.json'))
  if (!selfModel?.rayId || !selfModel?.name) throw new PurgeError('self-model.json 无效')
  const manifest = readJson<{ capabilities?: Record<string, { kind: string; version: string; active: boolean; provenance: Record<string, unknown> }> }>(
    join(rayHome, 'manifest.json'),
  )
  const now = options.now ?? Date.now()
  const packId = `teach-${randomUUID()}`
  ensurePrivateDir(outputDir)

  const pluginDescriptors: Array<{
    slug: string; version: string; kind: string; entryFile: string; sourceRelDir: string
    config?: Record<string, unknown>; precondition?: Record<string, unknown>
  }> = []
  const sourcesRoot = join(rayHome, 'plugins', 'sources')
  if (existsSync(sourcesRoot)) {
    for (const entry of readdirSync(sourcesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || TEACH_SPINE_DENYLIST.has(entry.name)) continue
      const srcDir = join(sourcesRoot, entry.name)
      const relDir = `plugins/sources/${entry.name}`
      const dstDir = join(outputDir, relDir)
      const copied: string[] = []
      walkRegularFilesStrict(srcDir, (fp) => {
        const rel = relative(srcDir, fp).replaceAll('\\', '/')
        if (CREDENTIAL_NAME_RE.test(rel)) return
        const dst = join(dstDir, rel)
        ensurePrivateDir(dirname(dst))
        copyFileSync(fp, dst)
        chmodSync(dst, 0o600)
        copied.push(rel)
      })
      if (copied.length === 0) continue
      const pkg = readJson<{ version?: string; main?: string }>(join(srcDir, 'package.json'))
      const cap = manifest?.capabilities?.[`plugin:${entry.name}`]
      const version = cap?.version ?? pkg?.version ?? '1.0.0'
      const rawMain = pkg?.main?.replace(/^\.\//u, '') ?? 'index.mjs'
      const entryFile = copied.includes(rawMain) ? rawMain : (copied.find(f => f.endsWith('.mjs') || f.endsWith('.js')) ?? copied[0]!)
      pluginDescriptors.push({ slug: entry.name, version, kind: 'service', entryFile, sourceRelDir: relDir })
    }
  }
  atomicWritePrivateText(join(outputDir, 'plugins', 'descriptors.json'), `${JSON.stringify({ plugins: pluginDescriptors }, null, 2)}\n`)

  const skillDescriptors: Array<{ skillId: string; version: string; relDir: string }> = []
  for (const base of [join(rayHome, 'state', 'skills'), join(rayHome, 'skills')]) {
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || skillDescriptors.some(s => s.skillId === entry.name)) continue
      const srcDir = join(base, entry.name)
      const relDir = `skills/${entry.name}`
      const dstDir = join(outputDir, relDir)
      let cnt = 0
      walkRegularFilesStrict(srcDir, (fp) => {
        const rel = relative(srcDir, fp).replaceAll('\\', '/')
        if (CREDENTIAL_NAME_RE.test(rel)) return
        const dst = join(dstDir, rel)
        ensurePrivateDir(dirname(dst))
        copyFileSync(fp, dst)
        chmodSync(dst, 0o600)
        cnt += 1
      })
      if (cnt === 0) continue
      const sMeta = readJson<{ version?: string }>(join(srcDir, 'skill.json')) ?? readJson<{ version?: string }>(join(srcDir, 'package.json'))
      const cap = manifest?.capabilities?.[`skill:${entry.name}`]
      skillDescriptors.push({ skillId: entry.name, version: cap?.version ?? sMeta?.version ?? '1.0.0', relDir })
    }
  }
  atomicWritePrivateText(join(outputDir, 'skills', 'descriptors.json'), `${JSON.stringify({ skills: skillDescriptors }, null, 2)}\n`)

  const memLines: string[] = []
  const pmDir = join(rayHome, 'state', 'personal-memory')
  if (existsSync(pmDir)) {
    for (const file of readdirSync(pmDir).filter(f => f.endsWith('.sqlite')).sort()) {
      try {
        const mdb = new DatabaseSync(join(pmDir, file), { readOnly: true })
        try {
          const tables = new Set((mdb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(r => r.name))
          if (tables.has('memory_records')) {
            for (const r of mdb.prepare(`SELECT id, kind, content, created_at FROM memory_records WHERE status = 'active'`).all() as Array<{ id: string; kind?: string; content: string; created_at?: number }>) {
              memLines.push(JSON.stringify({ id: r.id, kind: r.kind ?? 'semantic', content: r.content, createdAt: r.created_at ?? now }))
            }
          } else if (tables.has('memories')) {
            for (const r of mdb.prepare(`SELECT id, content FROM memories`).all() as Array<{ id: string; content: string }>) {
              memLines.push(JSON.stringify({ id: r.id, kind: 'semantic', content: r.content, createdAt: now }))
            }
          }
        } finally {
          mdb.close()
        }
      } catch { /* ignore */ }
    }
  }
  atomicWritePrivateText(join(outputDir, 'taught', 'memories.jsonl'), memLines.length > 0 ? `${memLines.join('\n')}\n` : '')

  const epLines: string[] = []
  const turnLines: string[] = []
  const epDbPath = join(rayHome, 'episodes', 'episodes.sqlite')
  if (existsSync(epDbPath)) {
    try {
      const edb = new DatabaseSync(epDbPath, { readOnly: true })
      try {
        for (const ep of edb.prepare(`SELECT * FROM ray_episodes ORDER BY started_at ASC`).all()) epLines.push(JSON.stringify(ep))
        for (const turn of edb.prepare(`SELECT * FROM ray_episode_turns ORDER BY created_at ASC, seq_start ASC`).all()) turnLines.push(JSON.stringify(turn))
      } finally {
        edb.close()
      }
    } catch { /* ignore */ }
  }
  atomicWritePrivateText(join(outputDir, 'taught', 'episodes.jsonl'), epLines.length > 0 ? `${epLines.join('\n')}\n` : '')
  atomicWritePrivateText(join(outputDir, 'taught', 'turns.jsonl'), turnLines.length > 0 ? `${turnLines.join('\n')}\n` : '')

  const reflLines: string[] = []
  const reflDir = join(rayHome, 'reflections')
  if (existsSync(reflDir)) {
    for (const file of readdirSync(reflDir).filter(f => f.endsWith('.jsonl')).sort()) {
      for (const l of readFileSync(join(reflDir, file), 'utf8').split('\n')) {
        if (l.trim()) reflLines.push(l.trim())
      }
    }
  }
  atomicWritePrivateText(join(outputDir, 'taught', 'reflections.jsonl'), reflLines.length > 0 ? `${reflLines.join('\n')}\n` : '')

  atomicWritePrivateText(join(outputDir, 'clone-meta.json'), `${JSON.stringify({
    protocol: 'ray-teaching-pack/v1',
    packId,
    teacherRayId: selfModel.rayId,
    teacherName: selfModel.name,
    exportedAt: now,
    credentialsExcluded: true,
  }, null, 2)}\n`)

  const files: Record<string, { sha256: string; bytes: number }> = {}
  let fileCount = 0
  walkRegularFilesStrict(outputDir, (fp) => {
    const rel = relative(outputDir, fp).replaceAll('\\', '/')
    if (rel === 'teaching-pack.json') return
    files[rel] = sha256File(fp)
    fileCount += 1
  })
  const stats = {
    pluginsCount: pluginDescriptors.length,
    skillsCount: skillDescriptors.length,
    memoriesCount: memLines.length,
    episodesCount: epLines.length,
    turnsCount: turnLines.length,
    reflectionsCount: reflLines.length,
  }
  atomicWritePrivateText(join(outputDir, 'teaching-pack.json'), `${JSON.stringify({
    protocol: 'ray-teaching-pack/v1',
    packId,
    exportedAt: now,
    teacher: { rayId: selfModel.rayId, name: selfModel.name },
    credentialsExcluded: true,
    files,
    capabilities: manifest?.capabilities ?? {},
    plugins: pluginDescriptors,
    skills: skillDescriptors,
    stats,
  }, null, 2)}\n`)
  fileCount += 1

  return {
    ok: true,
    sourceRayHome: rayHome,
    destination: outputDir,
    packId,
    teacherRayId: selfModel.rayId,
    teacherName: selfModel.name,
    credentialsExcluded: true,
    fileCount,
    stats,
  }
}

export function importRayTeachingPack(options: Readonly<{
  sourceDir: string
  rayHome: string
  now?: number
}>): ImportRayTeachingPackResult {
  const sourceDir = resolve(options.sourceDir)
  const rayHome = resolve(options.rayHome)
  const packPath = join(sourceDir, 'teaching-pack.json')
  const pack = readJson<{
    protocol: string
    packId: string
    teacher: { rayId: string; name: string }
    files: Record<string, { sha256: string; bytes: number }>
    capabilities: Record<string, { kind: 'skill' | 'plugin' | 'tool'; version: string; active: boolean; provenance: Record<string, unknown> }>
    plugins: Array<{ slug: string; version: string; kind: string; entryFile: string; sourceRelDir: string }>
    skills: Array<{ skillId: string; version: string; relDir: string }>
  }>(packPath)
  if (!pack || pack.protocol !== 'ray-teaching-pack/v1' || !pack.packId || !pack.teacher?.rayId) {
    throw new PurgeError(`未找到有效的 ray-teaching-pack/v1 清单：${packPath}`)
  }

  const expectedRels = new Set(Object.keys(pack.files))
  for (const [rel, meta] of Object.entries(pack.files)) {
    if (isUnsafeRel(rel)) throw new PurgeError(`传授包包含不安全路径或凭据字段：${rel}`)
    const full = resolve(sourceDir, rel)
    if (!isWithin(sourceDir, full) || !existsSync(full)) throw new PurgeError(`传授包缺少文件：${rel}`)
    const actual = sha256File(full)
    if (actual.sha256 !== meta.sha256 || actual.bytes !== meta.bytes) {
      throw new PurgeError(`传授包文件摘要不匹配（拒绝导入）：${rel}`)
    }
  }
  walkRegularFilesStrict(sourceDir, (fp) => {
    const rel = relative(sourceDir, fp).replaceAll('\\', '/')
    if (rel === 'teaching-pack.json') return
    if (isUnsafeRel(rel) || !expectedRels.has(rel)) {
      throw new PurgeError(`传授包包含未登记或凭据文件：${rel}`)
    }
  })

  if (!existsSync(join(rayHome, 'self', 'self-model.json'))) {
    initRayHome(rayHome, options.now === undefined ? {} : { now: options.now })
  }
  const recipientSelf = readJson<{ rayId: string; name: string }>(join(rayHome, 'self', 'self-model.json'))
  if (!recipientSelf?.rayId || !recipientSelf?.name) throw new PurgeError('接收方 self-model.json 无效')
  const manifestPath = join(rayHome, 'manifest.json')
  const manifest = readJson<{
    protocol: string
    rayId: string
    schemaVersion: number
    createdAt: number
    updatedAt: number
    artifacts: Record<string, unknown>
    databases: Record<string, unknown>
    credentialHandles: unknown[]
    capabilities: Record<string, { kind: 'skill' | 'plugin' | 'tool'; version: string; active: boolean; provenance: Record<string, unknown> }>
  }>(manifestPath)
  if (!manifest) throw new PurgeError('接收方 manifest.json 无效')

  for (const p of pack.plugins) {
    if (TEACH_SPINE_DENYLIST.has(p.slug) || isUnsafeRel(p.sourceRelDir)) {
      throw new PurgeError(`传授插件 ${p.slug} 被安全策略拒绝`)
    }
    const pDir = resolve(sourceDir, p.sourceRelDir)
    walkRegularFilesStrict(pDir, (fp) => {
      const content = readFileSync(fp, 'utf8')
      if (/\bkernel\.json\b|\benergy\.sqlite\b|credentials-keychain/iu.test(content)
        || content.replaceAll('\\', '/').includes(join(rayHome, 'kernel').replaceAll('\\', '/'))) {
        throw new PurgeError(`传授插件 ${p.slug} 触及内核/精力/凭据边界，拒绝导入`)
      }
    })
  }

  const importedPacksPath = join(rayHome, 'state', 'imported-teaching-packs.json')
  const importedLedger = readJson<Record<string, { importedAt: number; packSha256: string }>>(importedPacksPath) ?? {}
  const packSha = sha256File(packPath).sha256
  if (importedLedger[pack.packId]?.packSha256 === packSha) {
    return {
      ok: true,
      source: sourceDir,
      targetRayHome: rayHome,
      packId: pack.packId,
      teacher: pack.teacher,
      recipientRayId: recipientSelf.rayId,
      recipientName: recipientSelf.name,
      alreadyImported: true,
      identityPreserved: true,
      adoptedCapabilities: [],
      keptExistingCapabilities: [],
      verifiedPlugins: [],
      importedMemories: 0,
      importedEpisodes: 0,
      importedReflections: 0,
    }
  }

  const now = options.now ?? Date.now()
  const adoptedCapabilities: string[] = []
  const keptExistingCapabilities: string[] = []
  const verifiedPlugins: string[] = []
  const backupsPath = join(rayHome, 'state', 'taught-capability-backups.json')
  const backups = readJson<Record<string, unknown>>(backupsPath) ?? {}

  for (const p of pack.plugins) {
    const capId = `plugin:${p.slug}`
    const existing = manifest.capabilities[capId]
    if (existing?.active && compareSemverStrings(existing.version, p.version) >= 0) {
      keptExistingCapabilities.push(capId)
      continue
    }
    const srcPluginDir = resolve(sourceDir, p.sourceRelDir)
    const verify = verifyTaughtPluginIsolatedSubprocess(srcPluginDir, p.entryFile, p.slug, p.version)
    if (!verify.ok) {
      throw new PurgeError(`传授插件 ${p.slug}@${p.version} 对端独立重验证失败：${verify.reason ?? 'unknown'}`)
    }
    verifiedPlugins.push(capId)
    if (!Object.prototype.hasOwnProperty.call(backups, capId)) backups[capId] = existing ?? null
    copyTreeFiltered(srcPluginDir, join(rayHome, 'plugins', 'sources', p.slug), true)
    manifest.capabilities[capId] = {
      kind: 'plugin',
      version: p.version,
      active: true,
      provenance: {
        origin: 'taught',
        teacherRayId: pack.teacher.rayId,
        importedAt: now,
        ...(verify.verificationDigest ? { verificationDigest: verify.verificationDigest } : {}),
      },
    }
    adoptedCapabilities.push(capId)
  }

  for (const s of pack.skills) {
    const capId = `skill:${s.skillId}`
    const existing = manifest.capabilities[capId]
    if (existing?.active && compareSemverStrings(existing.version, s.version) >= 0) {
      keptExistingCapabilities.push(capId)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(backups, capId)) backups[capId] = existing ?? null
    copyTreeFiltered(resolve(sourceDir, s.relDir), join(rayHome, 'state', 'skills', s.skillId), true)
    manifest.capabilities[capId] = {
      kind: 'skill',
      version: s.version,
      active: true,
      provenance: { origin: 'taught', teacherRayId: pack.teacher.rayId, importedAt: now },
    }
    adoptedCapabilities.push(capId)
  }

  atomicWritePrivateText(backupsPath, `${JSON.stringify(backups, null, 2)}\n`)
  manifest.updatedAt = now
  atomicWritePrivateText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  let importedEpisodes = 0
  let importedMemories = 0
  let importedReflections = 0
  const memLines = existsSync(join(sourceDir, 'taught', 'memories.jsonl'))
    ? readFileSync(join(sourceDir, 'taught', 'memories.jsonl'), 'utf8').split('\n').filter(Boolean)
    : []
  const epLines = existsSync(join(sourceDir, 'taught', 'episodes.jsonl'))
    ? readFileSync(join(sourceDir, 'taught', 'episodes.jsonl'), 'utf8').split('\n').filter(Boolean)
    : []
  const turnLines = existsSync(join(sourceDir, 'taught', 'turns.jsonl'))
    ? readFileSync(join(sourceDir, 'taught', 'turns.jsonl'), 'utf8').split('\n').filter(Boolean)
    : []

  if (memLines.length > 0 || epLines.length > 0 || turnLines.length > 0) {
    const epDbPath = join(rayHome, 'episodes', 'episodes.sqlite')
    ensurePrivateDir(dirname(epDbPath))
    const edb = new DatabaseSync(epDbPath)
    let hasFts = false
    try {
      edb.exec(`
        CREATE TABLE IF NOT EXISTS ray_episodes (
          episode_id TEXT PRIMARY KEY, title TEXT NOT NULL, topic_keywords TEXT NOT NULL,
          channels_json TEXT NOT NULL, session_ids_json TEXT NOT NULL, ticket_id TEXT,
          turn_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0,
          first_turn_id TEXT, last_turn_id TEXT, preview_text TEXT NOT NULL DEFAULT '',
          started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS ray_episode_turns (
          turn_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, session_id TEXT NOT NULL,
          channel TEXT NOT NULL, turn_number INTEGER NOT NULL, seq_start INTEGER NOT NULL,
          seq_end INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
          text TEXT NOT NULL, ticket_id TEXT, created_at INTEGER NOT NULL
        );
      `)
      try {
        edb.exec('CREATE VIRTUAL TABLE IF NOT EXISTS ray_episode_turns_fts USING fts5(turn_id UNINDEXED, episode_id UNINDEXED, text);')
        hasFts = true
      } catch { hasFts = false }

      const insertEp = edb.prepare(`
        INSERT OR IGNORE INTO ray_episodes (
          episode_id, title, topic_keywords, channels_json, session_ids_json, ticket_id,
          turn_count, char_count, first_turn_id, last_turn_id, preview_text, started_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertTurn = edb.prepare(`
        INSERT OR IGNORE INTO ray_episode_turns (
          turn_id, episode_id, session_id, channel, turn_number, seq_start, seq_end, role, text, ticket_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertFts = hasFts
        ? edb.prepare('INSERT INTO ray_episode_turns_fts (turn_id, episode_id, text) VALUES (?, ?, ?)')
        : undefined

      for (const l of epLines) {
        const ep = JSON.parse(l) as {
          episode_id: string; title: string; topic_keywords: string; channels_json: string; session_ids_json: string
          ticket_id: string | null; turn_count: number; char_count: number; first_turn_id: string | null
          last_turn_id: string | null; preview_text: string; started_at: number; updated_at: number; closed_at: number | null
        }
        const channels = JSON.parse(String(ep.channels_json ?? '[]')) as string[]
        const tc = `taught:${pack.teacher.rayId}`
        if (!channels.includes(tc)) channels.push(tc)
        const title = String(ep.title ?? '').startsWith('[传授自 ') ? String(ep.title) : `[传授自 ${pack.teacher.name}] ${String(ep.title ?? '')}`
        const r = insertEp.run(
          ep.episode_id, title, ep.topic_keywords, JSON.stringify(channels), ep.session_ids_json, ep.ticket_id ?? null,
          ep.turn_count, ep.char_count, ep.first_turn_id ?? null, ep.last_turn_id ?? null, ep.preview_text ?? '',
          ep.started_at, ep.updated_at, ep.closed_at ?? null,
        )
        if (Number(r.changes) > 0) importedEpisodes += 1
      }
      for (const l of turnLines) {
        const t = JSON.parse(l) as {
          turn_id: string; episode_id: string; session_id: string; channel: string
          turn_number: number; seq_start: number; seq_end: number; role: 'user' | 'assistant'
          text: string; ticket_id: string | null; created_at: number
        }
        const ch = String(t.channel ?? '').startsWith('taught:') ? String(t.channel) : `taught:${pack.teacher.rayId}:${String(t.channel ?? '')}`
        const r = insertTurn.run(
          t.turn_id, t.episode_id, t.session_id, ch, t.turn_number, t.seq_start, t.seq_end, t.role, t.text, t.ticket_id ?? null, t.created_at,
        )
        if (Number(r.changes) > 0) insertFts?.run(t.turn_id, t.episode_id, t.text)
      }
      if (memLines.length > 0) {
        const memPath = join(rayHome, 'state', 'taught-memories.jsonl')
        const seen = new Set<string>()
        if (existsSync(memPath)) {
          for (const ex of readFileSync(memPath, 'utf8').split('\n').filter(Boolean)) {
            try {
              const c = (JSON.parse(ex) as { content?: string }).content?.trim()
              if (c) seen.add(sha256Text(c))
            } catch { /* ignore */ }
          }
        }
        const appended: string[] = []
        for (const l of memLines) {
          const parsed = JSON.parse(l) as { id?: string; kind?: string; content?: string; createdAt?: number }
          const clean = parsed.content?.trim()
          if (!clean) continue
          const h = sha256Text(clean)
          if (seen.has(h)) continue
          seen.add(h)
          importedMemories += 1
          appended.push(JSON.stringify({
            id: parsed.id ?? `mem-${h.slice(0, 16)}`,
            kind: parsed.kind ?? 'semantic',
            content: clean,
            provenance: { origin: 'taught', teacherRayId: pack.teacher.rayId, teacherName: pack.teacher.name, importedAt: now },
            createdAt: parsed.createdAt ?? now,
          }))
        }
        if (appended.length > 0) {
          const prev = existsSync(memPath) ? readFileSync(memPath, 'utf8') : ''
          atomicWritePrivateText(memPath, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${appended.join('\n')}\n`)
        }
      }
    } finally {
      edb.close()
    }
  }

  const reflSrc = join(sourceDir, 'taught', 'reflections.jsonl')
  if (existsSync(reflSrc)) {
    const reflDst = join(rayHome, 'reflections', 'taught.jsonl')
    const seen = new Set<string>()
    if (existsSync(reflDst)) {
      for (const l of readFileSync(reflDst, 'utf8').split('\n')) if (l.trim()) seen.add(sha256Text(l.trim()))
    }
    const added: string[] = []
    for (const l of readFileSync(reflSrc, 'utf8').split('\n')) {
      const c = l.trim()
      if (!c) continue
      const h = sha256Text(c)
      if (seen.has(h)) continue
      seen.add(h)
      added.push(c)
      importedReflections += 1
    }
    if (added.length > 0) {
      const prev = existsSync(reflDst) ? readFileSync(reflDst, 'utf8') : ''
      atomicWritePrivateText(reflDst, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${added.join('\n')}\n`)
    }
  }

  importedLedger[pack.packId] = { importedAt: now, packSha256: packSha }
  atomicWritePrivateText(importedPacksPath, `${JSON.stringify(importedLedger, null, 2)}\n`)

  const autoPath = join(rayHome, 'self', 'autobiography.jsonl')
  const prevAuto = existsSync(autoPath) ? readFileSync(autoPath, 'utf8') : ''
  const autoEntry = JSON.stringify({
    protocol: 'ray-autobiography/v1',
    entryId: `teach-${randomUUID()}`,
    timestamp: now,
    kind: 'migration',
    summary: `通过 CLI 导入 ${pack.teacher.name} (${pack.teacher.rayId}) 的传授包 ${pack.packId}（保留本机身份 ${recipientSelf.name}；重验证插件 ${verifiedPlugins.length}、采纳 ${adoptedCapabilities.length}、记忆 +${importedMemories}、情景 +${importedEpisodes}）。`,
    reason: 'ray-teaching-pack/v1 跨机传授导入（独立重验证 + 保留接收方身份与内核）。',
  })
  atomicWritePrivateText(autoPath, `${prevAuto}${prevAuto && !prevAuto.endsWith('\n') ? '\n' : ''}${autoEntry}\n`)

  return {
    ok: true,
    source: sourceDir,
    targetRayHome: rayHome,
    packId: pack.packId,
    teacher: pack.teacher,
    recipientRayId: recipientSelf.rayId,
    recipientName: recipientSelf.name,
    alreadyImported: false,
    identityPreserved: true,
    adoptedCapabilities,
    keptExistingCapabilities,
    verifiedPlugins,
    importedMemories,
    importedEpisodes,
    importedReflections,
  }
}

export async function runTeachCommand(
  argv: readonly string[],
  context: Readonly<{ dshHome: string; profile?: string; json?: boolean; env?: NodeJS.ProcessEnv }>,
): Promise<number> {
  const env = context.env ?? process.env
  let subcommand: 'export' | 'import' = 'export'
  let rayHomeArg: string | undefined
  let dshHomeArg = context.dshHome
  let profileArg = context.profile
  let outputArg: string | undefined
  let sourceArg: string | undefined
  let json = Boolean(context.json)
  let help = false

  let seenSub = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--help' || token === '-h') { help = true; continue }
    if (token === '--json') { json = true; continue }
    if (token === '--ray-home' || token === '--dsh-home' || token === '--profile' || token === '--output' || token === '--source') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new PurgeError(`${token} 需要一个参数值`)
      if (token === '--ray-home') rayHomeArg = value
      else if (token === '--dsh-home') dshHomeArg = value
      else if (token === '--profile') profileArg = value
      else if (token === '--output') outputArg = value
      else sourceArg = value
      continue
    }
    if (!seenSub && (token === 'export' || token === 'import')) {
      subcommand = token
      seenSub = true
      continue
    }
    throw new PurgeError(`dsh-ray teach 无法识别的参数：${token}`)
  }

  if (help) {
    process.stdout.write([
      'dsh-ray teach — 导出与导入全量 Ray 传授包（ray-teaching-pack/v1，保留接收方身份与内核）',
      '',
      '用法：',
      '  dsh-ray teach export --output <dir> [--ray-home <dir>] [--json]',
      '  dsh-ray teach import --source <dir> [--ray-home <dir>] [--json]',
      '',
    ].join('\n'))
    return 0
  }

  const rayHome = resolveRayHome({
    ...(rayHomeArg === undefined ? {} : { rayHome: rayHomeArg }),
    dshHome: dshHomeArg,
    ...(profileArg === undefined ? {} : { profile: profileArg }),
    env,
  })

  if (subcommand === 'export') {
    if (!outputArg) throw new PurgeError('dsh-ray teach export 需要 --output <dir>')
    const res = exportRayTeachingPack({ rayHome, outputDir: outputArg })
    process.stdout.write(json
      ? `${JSON.stringify(res, null, 2)}\n`
      : `已导出全量传授包：${res.destination}（${res.fileCount} 文件，插件 ${res.stats.pluginsCount}、技能 ${res.stats.skillsCount}、记忆 ${res.stats.memoriesCount}、情景 ${res.stats.episodesCount}，已排除凭据与内核）\n`)
    return 0
  }

  if (!sourceArg) throw new PurgeError('dsh-ray teach import 需要 --source <dir>')
  const res = importRayTeachingPack({ sourceDir: sourceArg, rayHome })
  process.stdout.write(json
    ? `${JSON.stringify(res, null, 2)}\n`
    : `已导入传授包 ${res.packId}（传授方 ${res.teacher.name} -> 保留本机 ${res.recipientName}；重验证插件 ${res.verifiedPlugins.length}、采纳 ${res.adoptedCapabilities.length}、跳过旧版 ${res.keptExistingCapabilities.length}、记忆 +${res.importedMemories}、情景 +${res.importedEpisodes}）\n`)
  return 0
}
