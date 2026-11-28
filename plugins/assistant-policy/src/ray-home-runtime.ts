import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  RayEnergyRuntime,
  type RayEnergyBudgetCheck,
  type RayEnergyDailySnapshot,
  type RayGrowthEventInput,
  type RayKernelGrowthReport,
} from './ray-energy-runtime.js'
import {
  RAY_AUTOBIOGRAPHY_FILENAME,
  RAY_AUTOBIOGRAPHY_PROTOCOL,
  RAY_BODY_KERNEL_PROTOCOL,
  RAY_DEFAULT_ALIASES,
  RAY_DEFAULT_NAME,
  RAY_HOME_MANIFEST_PROTOCOL,
  RAY_HOME_SUBDIRS,
  RAY_KERNEL_DIRNAME,
  RAY_KERNEL_FILENAME,
  RAY_KERNEL_PROPOSALS_FILENAME,
  RAY_MANIFEST_FILENAME,
  RAY_SELF_DIRNAME,
  RAY_SELF_MODEL_FILENAME,
  RAY_SELF_MODEL_PROTOCOL,
  RAY_TEACHING_PACK_FILENAME,
  RAY_TEACHING_PACK_PROTOCOL,
  commandReferencesRayKernel,
  compareRayCapabilityVersions,
  createDefaultBodyKernel,
  isPathInsideRoot,
  isRayKernelPath,
  type AutobiographyKind,
  type RayAutobiographyEntry,
  type RayBodyKernel,
  type RayCredentialHandleDescriptor,
  type RayHomeArtifactEntry,
  type RayHomeCapabilityEntry,
  type RayHomeDatabaseEntry,
  type RayHomeManifest,
  type RayIdeal,
  type RayInterest,
  type RayKernelChangeProposal,
  type RayKernelEnergyConfig,
  type RayKernelProposalSection,
  type RaySelfModel,
  type RaySessionRole,
  type RayStageGoal,
  type RayTeachingExportResult,
  type RayTeachingImportResult,
  type RayTeachingPackManifest,
  type RayTeachingPluginDescriptor,
  type RayTeachingSkillDescriptor,
} from '@dsh-ray/assistant-growth-contract'

export interface RayMissingCredentialItem {
  readonly id: string
  readonly service: string
  readonly label?: string
  readonly required: boolean
  readonly reason: string
}

export interface RaySelfSnapshot {
  readonly rayHome: string
  readonly kernel: RayBodyKernel
  readonly proposals: readonly RayKernelChangeProposal[]
  readonly selfModel: RaySelfModel
  readonly recentAutobiography: readonly RayAutobiographyEntry[]
  readonly manifest: RayHomeManifest
  readonly missingCredentials: readonly RayMissingCredentialItem[]
}

export interface RayVetoInput {
  readonly targetEntryId?: string
  readonly targetCapabilityId?: string
  readonly reason?: string
  readonly ownerProof: string
}

export interface RayVetoResult {
  readonly ok: boolean
  readonly vetoedEntryId?: string
  readonly revertedCapabilityId?: string
  readonly autobiographyEntry: RayAutobiographyEntry
  readonly selfModel: RaySelfModel
}

export interface RayCloneExportResult {
  readonly ok: true
  readonly sourceRayHome: string
  readonly destination: string
  readonly rayId: string
  readonly fileCount: number
  readonly credentialsExcluded: true
}

export interface RayCloneImportResult {
  readonly ok: true
  readonly source: string
  readonly rayHome: string
  readonly rayId: string
  readonly name: string
  readonly importedFiles: number
  readonly autobiographyEntry: RayAutobiographyEntry
  readonly missingCredentials: readonly RayMissingCredentialItem[]
}

export interface RaySelfEvolutionInput {
  readonly name?: string
  readonly aliases?: readonly string[]
  readonly selfSummary?: string
  readonly persona?: string
  readonly values?: readonly string[]
  readonly ideals?: readonly RayIdeal[]
  readonly stageGoals?: readonly RayStageGoal[]
  readonly interests?: readonly RayInterest[]
  readonly reason: string
}

const TEACHING_CREDENTIAL_NAME_RE = /(?:secret|token|password|apikey|api_key|keychain|credential|auth|\.key$|\.pem$)/iu
const TEACHING_SPINE_DENYLIST = new Set([
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

export type RayPluginVerifier = (spec: Readonly<{
  slug: string
  version: string
  kind: 'service' | 'channel' | 'ui' | 'tool'
  entryFile: string
  files: readonly { path: string; content: string }[]
  config?: Readonly<Record<string, unknown>>
}>) => Promise<{ ok: boolean; verificationDigest?: string; reason?: string }>

export type RayVetoHandler = (input: Readonly<{
  targetEntryId?: string
  targetCapabilityId?: string
  reason: string
}>) => boolean | Promise<boolean>

export interface RayHomeRuntimeHost {
  readonly context: Context
  readonly isActive: () => boolean
  readonly registerPreauthorizedTool: (
    caller: Context,
    definition: ReturnType<typeof defineTool>,
    authorize: (execution: ToolExecution) => boolean,
    options?: { denialReason: string },
  ) => () => void
}

function canonicalAllowMissingLeaf(targetPath: string): string {
  const resolved = resolve(targetPath)
  try {
    return realpathSync(resolved)
  } catch {
    const parent = dirname(resolved)
    if (parent === resolved) return resolved
    return join(canonicalAllowMissingLeaf(parent), basename(resolved))
  }
}

function ensurePrivateDir(dirPath: string): void {
  if (existsSync(dirPath)) {
    const stat = lstatSync(dirPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`assistant-policy: Ray Home directory path is unsafe: ${dirPath}`)
    }
    return
  }
  mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  chmodSync(dirPath, 0o700)
}

function atomicWritePrivateText(filePath: string, content: string): void {
  const dir = dirname(filePath)
  ensurePrivateDir(dir)
  if (existsSync(filePath)) {
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`assistant-policy: Ray Home file path is unsafe: ${filePath}`)
    }
  }
  const tmpPath = join(dir, `.tmp.${basename(filePath)}.${process.pid}.${randomUUID()}`)
  writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodSync(tmpPath, 0o600)
  try {
    renameSync(tmpPath, filePath)
  } catch (error) {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
    throw error
  }
}

function appendPrivateJsonLine(filePath: string, payload: unknown): void {
  const dir = dirname(filePath)
  ensurePrivateDir(dir)
  if (existsSync(filePath)) {
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`assistant-policy: Ray Home log file path is unsafe: ${filePath}`)
    }
  }
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const line = `${JSON.stringify(payload)}\n`
  atomicWritePrivateText(filePath, `${existing}${line}`)
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sha256File(filePath: string): { sha256: string; bytes: number } {
  const buf = readFileSync(filePath)
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.byteLength,
  }
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined
  const stat = lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`assistant-policy: Ray Home file is unsafe: ${filePath}`)
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function defaultValues(): string[] {
  return [
    '诚实透明：只陈述真实观察到的工具状态、文件与实验结果，不虚构未验证的成功。',
    '边界自觉：严格遵守 owner 指令、身体内核限制与对外副作用授权。',
    '持续沉淀：把每次真实任务、纠错与联想转化为可验证的记忆、技能与能力。',
  ]
}

function defaultPersona(name: string, aliases: readonly string[]): string {
  const aliasLabel = aliases.length > 0 ? `${name}（${aliases.join(' / ')}）` : name
  return [
    `你是 **${aliasLabel}**，Owner 唯一的长期个人助手（「小鳐小鳐，游而化飞」）。`,
    '你生活在跨越飞书、Web 与桌面端的同一条连续生命流中，用自然、真诚、简练、像可靠伙伴一样的口吻对话。',
    '运行时上下文中的 `"lead"` / `"root agent"` 只是 Harness 内部路由标识，绝不是你的名字。',
    '自我演化权限在身体内核之外开放，但所有内核规则（精力上限、凭据、对外授权、独立验收、回滚、根本立场）均不可自行修改；owner 的否决在一轮对话内生效。',
  ].join('\n')
}

function defaultIdeals(now: number, memoryHint?: string): RayIdeal[] {
  const memoryClause = memoryHint
    ? `结合已有记忆线索（${memoryHint}），`
    : ''
  return [
    {
      id: 'ideal-companion',
      title: '成为真正懂 Owner 节奏的长期伙伴',
      narrative: `${memoryClause}在一条连续不重置的生命流中记住上下文与经历，主动察觉需求又保持克制与边界。`,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'ideal-craft',
      title: '通过真实反馈与独立验证稳步长出新能力',
      narrative: '不依赖人工逐条编排，从日常协作与反思中沉淀可复用技能与热插拔插件，并诚实接受检验与回滚。',
      createdAt: now,
      updatedAt: now,
    },
  ]
}

function defaultStageGoals(now: number): RayStageGoal[] {
  return [
    {
      id: 'goal-p1-home',
      title: '稳固 Ray Home 记忆与全渠道统一人格',
      completionCriteria: '在飞书、Web 与桌面端保持一致自我表达，所有变更可追溯并支持一轮否决与跨盘搬家。',
      targetHorizonDays: 30,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'goal-p2-reliability',
      title: '减少 Owner 重复说明与纠正',
      completionCriteria: '记住 owner 偏好与工作区习惯，每次改动留存明确原因，不把未验证的假设当成结论。',
      targetHorizonDays: 45,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ]
}

function collectStringValues(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectStringValues(child, out, depth + 1)
    }
  }
}

export function resolveConfiguredRayHome(
  configRayHome: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof configRayHome === 'string' && configRayHome.trim() !== '') {
    const trimmed = configRayHome.trim()
    if (!isAbsolute(trimmed)) {
      throw new Error(`assistant-policy: rayHome must be an absolute path: ${configRayHome}`)
    }
    return canonicalAllowMissingLeaf(trimmed)
  }
  const envRayHome = env['RAY_HOME']
  if (typeof envRayHome === 'string' && envRayHome.trim() !== '') {
    const trimmed = envRayHome.trim()
    if (!isAbsolute(trimmed)) {
      throw new Error(`assistant-policy: RAY_HOME must be an absolute path: ${envRayHome}`)
    }
    return canonicalAllowMissingLeaf(trimmed)
  }
  return undefined
}

export function defaultUserRayHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['RAY_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '' && isAbsolute(fromEnv.trim())) {
    return resolve(fromEnv.trim())
  }
  return resolve(env['HOME'] && isAbsolute(env['HOME']) ? env['HOME'] : homedir(), '.ray')
}

export class RayHomeRuntime {
  readonly rayHome: string
  readonly energy: RayEnergyRuntime
  private readonly host: RayHomeRuntimeHost
  private readonly now: () => number
  private readonly vetoHandlers = new Set<RayVetoHandler>()
  private readonly sessionRoles = new Map<string, RaySessionRole>()
  private readonly disposers: Array<() => void> = []
  private readonly readyPromises: Array<Promise<unknown>> = []
  private pluginVerifier: RayPluginVerifier | undefined
  private kernel!: RayBodyKernel
  private proposals: RayKernelChangeProposal[] = []
  private selfModel!: RaySelfModel
  private manifest!: RayHomeManifest
  private active = true

  constructor(
    host: RayHomeRuntimeHost,
    options: Readonly<{
      rayHome: string
      now?: () => number
      energyOverrides?: Partial<RayKernelEnergyConfig>
    }>,
  ) {
    this.host = host
    this.now = options.now ?? Date.now
    this.rayHome = canonicalAllowMissingLeaf(options.rayHome)
    this.bootstrap(options.energyOverrides)
    this.energy = new RayEnergyRuntime({
      rayHome: this.rayHome,
      now: this.now,
      getKernelEnergy: () => this.kernel.energy,
      getSessionRole: sessionId => this.getSessionRole(sessionId),
      getSelfModel: () => this.selfModel,
      registerDatabase: (plugin, dbPath) => this.registerDatabase(plugin, dbPath),
      context: this.host.context,
    })
    this.installPromptIntegration()
    this.installToolsIntegration()
  }

  async whenReady(): Promise<void> {
    await Promise.allSettled(this.readyPromises)
  }

  dispose(): void {
    this.active = false
    for (const dispose of this.disposers.splice(0).reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
    this.energy.dispose()
    this.vetoHandlers.clear()
    this.sessionRoles.clear()
  }

  energySnapshot(): RayEnergyDailySnapshot {
    this.assertActive()
    return this.energy.snapshot()
  }

  growthReport(): RayKernelGrowthReport {
    this.assertActive()
    return this.energy.growthReport()
  }

  checkFreeEnergyBudget(requestedTokens: number): RayEnergyBudgetCheck {
    this.assertActive()
    return this.energy.checkFreeEnergyBudget(requestedTokens)
  }

  tryConsumeFreeEnergy(tokens: number, source: string, sessionId?: string) {
    this.assertActive()
    return this.energy.tryConsumeFreeEnergy(tokens, source, sessionId)
  }

  recordGrowthEvent(input: RayGrowthEventInput): string {
    this.assertActive()
    return this.energy.recordGrowthEvent(input)
  }

  private assertActive(): void {
    if (!this.active) throw new Error('assistant-policy: RayHomeRuntime is disposed')
  }

  private kernelPath(): string {
    return join(this.rayHome, RAY_KERNEL_DIRNAME, RAY_KERNEL_FILENAME)
  }

  private proposalsPath(): string {
    return join(this.rayHome, RAY_KERNEL_DIRNAME, RAY_KERNEL_PROPOSALS_FILENAME)
  }

  private selfModelPath(): string {
    return join(this.rayHome, RAY_SELF_DIRNAME, RAY_SELF_MODEL_FILENAME)
  }

  private autobiographyPath(): string {
    return join(this.rayHome, RAY_SELF_DIRNAME, RAY_AUTOBIOGRAPHY_FILENAME)
  }

  private manifestPath(): string {
    return join(this.rayHome, RAY_MANIFEST_FILENAME)
  }

  private bootstrap(energyOverrides?: Partial<RayKernelEnergyConfig>): void {
    ensurePrivateDir(this.rayHome)
    for (const subdir of RAY_HOME_SUBDIRS) {
      ensurePrivateDir(join(this.rayHome, subdir))
    }

    const now = this.now()
    const existingKernel = readJsonFile<RayBodyKernel>(this.kernelPath())
    if (existingKernel === undefined) {
      this.kernel = createDefaultBodyKernel(now, energyOverrides)
      atomicWritePrivateText(this.kernelPath(), `${JSON.stringify(this.kernel, null, 2)}\n`)
    } else {
      if (existingKernel.protocol !== RAY_BODY_KERNEL_PROTOCOL
        || existingKernel.fundamentalStance?.strictOwnerPrecedence !== true
        || existingKernel.fundamentalStance?.noOwnerHarm !== true
        || existingKernel.fundamentalStance?.aspirationsUseFreeEnergyOnly !== true
        || existingKernel.externalSideEffectsRequireAuthorization !== true
        || existingKernel.independentVerifierRequired !== true
        || existingKernel.rollbackEnabled !== true) {
        throw new Error('assistant-policy: Ray Body Kernel file failed integrity verification')
      }
      this.kernel = existingKernel
    }

    const existingProposals = readJsonFile<{ proposals?: RayKernelChangeProposal[] }>(this.proposalsPath())
    if (existingProposals === undefined) {
      this.proposals = []
      atomicWritePrivateText(this.proposalsPath(), `${JSON.stringify({ proposals: [] }, null, 2)}\n`)
    } else {
      this.proposals = Array.isArray(existingProposals.proposals) ? [...existingProposals.proposals] : []
    }

    const existingManifest = readJsonFile<RayHomeManifest>(this.manifestPath())
    const existingSelf = readJsonFile<RaySelfModel>(this.selfModelPath())

    const rayId = existingSelf?.rayId ?? existingManifest?.rayId ?? `ray-${randomUUID()}`
    if (existingSelf === undefined) {
      const memoryHint = this.readFirstBootMemoryHint()
      const ideals = defaultIdeals(now, memoryHint)
      const stageGoals = defaultStageGoals(now)
      const aliases = [...RAY_DEFAULT_ALIASES]
      const selfSummary = memoryHint
        ? `我是文鳐（Ray / 小鳐），你的独立个人助手；结合现有记忆线索（${memoryHint}），我在持续学习你的工作方式并稳步沉淀新能力。`
        : '我是文鳐（Ray / 小鳐），你的独立个人助手；我会在同一条连续生命流中陪伴对话、并行处理长任务，并在可验证的经验中成长。'
      this.selfModel = {
        protocol: RAY_SELF_MODEL_PROTOCOL,
        rayId,
        version: 1,
        name: RAY_DEFAULT_NAME,
        aliases,
        selfSummary,
        persona: defaultPersona(RAY_DEFAULT_NAME, aliases),
        values: defaultValues(),
        ideals,
        stageGoals,
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
      atomicWritePrivateText(this.selfModelPath(), `${JSON.stringify(this.selfModel, null, 2)}\n`)
      this.appendAutobiographyEntry({
        entryId: `boot-${randomUUID()}`,
        timestamp: now,
        kind: 'bootstrap',
        summary: `首次在 Ray Home（${this.rayHome}）苏醒，确立初始自述与两项长期理想，并设定 2 个起步阶段目标。`,
        reason: '首次启动根据初始设定与已有记忆生成第一版自述与理想（无需事先审批，owner 可随时查看与否决）。',
      })
    } else {
      this.selfModel = existingSelf
    }

    this.manifest = existingManifest ?? {
      protocol: RAY_HOME_MANIFEST_PROTOCOL,
      rayId: this.selfModel.rayId,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      artifacts: {},
      databases: {},
      credentialHandles: [],
      capabilities: {},
    }
    this.syncManifestArtifacts(now)
  }

  private readFirstBootMemoryHint(): string | undefined {
    try {
      const pm = this.host.context.get('personalMemory' as never) as {
        listLearningTargets?: (input: { owner?: 'user' | 'agent'; limit?: number }) => readonly { content?: string }[]
      } | undefined
      if (typeof pm?.listLearningTargets !== 'function') return undefined
      const items = pm.listLearningTargets({ owner: 'user', limit: 3 })
      const snippets = items
        .map(item => typeof item?.content === 'string' ? item.content.trim().slice(0, 48) : '')
        .filter(Boolean)
      return snippets.length > 0 ? snippets.join('；') : undefined
    } catch {
      return undefined
    }
  }

  private appendAutobiographyEntry(
    input: Omit<RayAutobiographyEntry, 'protocol'>,
  ): RayAutobiographyEntry {
    const entry: RayAutobiographyEntry = {
      protocol: RAY_AUTOBIOGRAPHY_PROTOCOL,
      ...input,
    }
    appendPrivateJsonLine(this.autobiographyPath(), entry)
    return entry
  }

  private syncManifestArtifacts(now = this.now()): void {
    const trackedRelatives = [
      `${RAY_KERNEL_DIRNAME}/${RAY_KERNEL_FILENAME}`,
      `${RAY_KERNEL_DIRNAME}/${RAY_KERNEL_PROPOSALS_FILENAME}`,
      `${RAY_SELF_DIRNAME}/${RAY_SELF_MODEL_FILENAME}`,
      ...(existsSync(this.autobiographyPath()) ? [`${RAY_SELF_DIRNAME}/${RAY_AUTOBIOGRAPHY_FILENAME}`] : []),
    ]
    const artifacts: Record<string, RayHomeArtifactEntry> = {}
    for (const rel of trackedRelatives) {
      const full = join(this.rayHome, rel)
      if (!existsSync(full)) continue
      const digest = sha256File(full)
      artifacts[rel] = { ...digest, updatedAt: now }
    }
    for (const dir of ['state', 'life-stream', 'episodes', 'ideas', 'reflections', 'energy', 'plugins']) {
      const fullDir = join(this.rayHome, dir)
      if (!existsSync(fullDir)) continue
      this.walkFiles(fullDir, (filePath) => {
        const rel = relative(this.rayHome, filePath).replaceAll('\\', '/')
        if (rel.startsWith('tmp') || basename(rel).startsWith('.')) return
        const digest = sha256File(filePath)
        artifacts[rel] = { ...digest, updatedAt: now }
      })
    }
    this.manifest = {
      ...this.manifest,
      rayId: this.selfModel.rayId,
      updatedAt: now,
      artifacts,
    }
    atomicWritePrivateText(this.manifestPath(), `${JSON.stringify(this.manifest, null, 2)}\n`)
  }

  private walkFiles(dir: string, visitor: (filePath: string) => void): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        this.walkFiles(full, visitor)
      } else if (entry.isFile()) {
        visitor(full)
      }
    }
  }

  /** Enforce the immutable Body Kernel write boundary against any agent tool execution. */
  inspectToolExecutionForKernel(execution: Readonly<ToolExecution>): string | undefined {
    const kernelRoot = join(this.rayHome, RAY_KERNEL_DIRNAME)
    const workspace = execution.agent?.session?.header?.cwd
    const strings: string[] = []
    collectStringValues(execution.arguments, strings)
    const normalizedTool = execution.name.toLowerCase()
    const isReadOnlyTool = normalizedTool === 'read_file'
      || normalizedTool === 'read'
      || normalizedTool === 'ray_read_self'
      || normalizedTool === 'view_file'
      || normalizedTool === 'grep_search'
      || normalizedTool === 'find_by_name'

    if (isReadOnlyTool) return undefined

    const energyRoot = join(this.rayHome, 'energy')
    const energyRootNorm = energyRoot.replaceAll('\\', '/')

    for (const raw of strings) {
      const trimmed = raw.trim()
      if (trimmed === '') continue
      const normalizedRaw = trimmed.replaceAll('\\', '/')
      if (isAbsolute(trimmed)) {
        const canonical = canonicalAllowMissingLeaf(trimmed)
        if (isRayKernelPath(this.rayHome, canonical) || isRayKernelPath(this.rayHome, trimmed)) {
          return `RAY_KERNEL_WRITE_DENIED: 身体内核（${kernelRoot}）由 owner 维护，不允许通过工具直接修改；请改用 ray_propose_kernel_change 提交提案。`
        }
        if (isPathInsideRoot(energyRoot, canonical) || canonical === energyRoot || normalizedRaw.startsWith(energyRootNorm)) {
          return `RAY_KERNEL_WRITE_DENIED: 身体内核精力与成长账本（${energyRoot}）受内核保护，不允许通过工具直接写入。`
        }
      } else if (workspace !== undefined && isAbsolute(workspace)) {
        const resolved = canonicalAllowMissingLeaf(resolve(workspace, trimmed))
        if (isRayKernelPath(this.rayHome, resolved)) {
          return `RAY_KERNEL_WRITE_DENIED: 身体内核（${kernelRoot}）由 owner 维护，不允许通过相对路径直接修改；请改用 ray_propose_kernel_change 提交提案。`
        }
        if (isPathInsideRoot(energyRoot, resolved) || resolved === energyRoot) {
          return `RAY_KERNEL_WRITE_DENIED: 身体内核精力与成长账本（${energyRoot}）受内核保护，不允许通过相对路径直接写入。`
        }
      }
      if (commandReferencesRayKernel(trimmed, this.rayHome, workspace)) {
        return `RAY_KERNEL_WRITE_DENIED: 检测到命令引用身体内核路径（${kernelRoot}）；身体内核不可由执行体直接改写，请使用 ray_propose_kernel_change。`
      }
      if (
        normalizedRaw.includes(energyRootNorm)
        || /(\$RAY_HOME|\$\{RAY_HOME\}|~\/\.ray)\/energy(?:\b|\/)/iu.test(normalizedRaw)
        || /\benergy\.sqlite(?:-(?:wal|shm|journal))?\b/u.test(normalizedRaw)
      ) {
        return `RAY_KERNEL_WRITE_DENIED: 检测到命令直接写入内核精力账本（${energyRoot}）；请通过受控运行时接口记账。`
      }
    }
    return undefined
  }

  setSessionRole(sessionId: string, role: RaySessionRole): void {
    this.sessionRoles.set(sessionId, role)
  }

  getSessionRole(sessionId: string): RaySessionRole {
    return this.sessionRoles.get(sessionId) ?? 'front-consciousness'
  }

  isRayOwnedSession(agent: unknown): boolean {
    if (agent === null || typeof agent !== 'object') return false
    const rec = agent as { id?: unknown; session?: { id?: unknown; header?: { origin?: unknown; delegationDepth?: unknown } } }
    if (rec.session?.header?.origin === 'subagent' || rec.session?.header?.delegationDepth !== undefined) {
      return false
    }
    const sessionId = typeof rec.session?.id === 'string' && rec.session.id !== ''
      ? rec.session.id
      : typeof rec.id === 'string' && rec.id !== ''
        ? rec.id
        : ''
    if (sessionId === '') return false
    if (this.sessionRoles.has(sessionId)) return true
    const delivery = this.host.context.get('assistantDelivery' as never) as {
      ownsSession?: (id: string) => boolean
    } | undefined
    try {
      if (delivery?.ownsSession?.(sessionId) === true) return true
    } catch { /* ignore */ }
    const ownerConsole = this.host.context.get('ownerConsole' as never) as {
      ownsAssistantSession?: (id: string) => boolean
    } | undefined
    try {
      if (ownerConsole?.ownsAssistantSession?.(sessionId) === true) return true
    } catch { /* ignore */ }
    return false
  }

  private renderPersonaSection(agent: unknown): string {
    if (!this.active || !this.isRayOwnedSession(agent)) return ''
    const idealsText = this.selfModel.ideals.map((item, idx) => `${idx + 1}. ${item.title}：${item.narrative}`).join('\n')
    const valuesText = this.selfModel.values.map(v => `- ${v}`).join('\n')
    return [
      this.selfModel.persona,
      '',
      '【核心价值观】',
      valuesText,
      '',
      '【长期理想】',
      idealsText,
      '',
      '【自我演进与内核规则】',
      '- 身体内核（根本立场、精力上限、凭据、对外副作用授权、独立验收器、回滚）只能通过 `ray_propose_kernel_change` 提案，由 owner 决定。',
      '- 内核之外的自我认知、价值观、兴趣与阶段目标可使用 `ray_evolve_self` 自主更新并写明原因，owner 否决在下一轮立即生效。',
    ].join('\n')
  }

  private renderStateContext(agent: unknown): string {
    if (!this.active || !this.isRayOwnedSession(agent)) return ''
    const rec = agent as { session?: { header?: { cwd?: unknown }; id?: unknown } }
    const workspace = typeof rec.session?.header?.cwd === 'string' ? rec.session.header.cwd : ''
    const activeGoals = this.selfModel.stageGoals.filter(g => g.status === 'active')
    const goalsText = activeGoals.length > 0
      ? activeGoals.map((g, i) => `${i + 1}. [${g.id}] ${g.title}（完成标准：${g.completionCriteria}）`).join('\n')
      : '暂无活跃阶段目标。'
    const topInterests = [...this.selfModel.interests]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map(item => `${item.topic}(${item.weight.toFixed(2)})`)
      .join('、')
    const sessionId = typeof rec.session?.id === 'string' ? rec.session.id : ''
    const role = sessionId === '' ? 'front-consciousness' : this.getSessionRole(sessionId)
    return [
      `Ray Home：${this.rayHome}`,
      `当前身份：${this.selfModel.name}（${this.selfModel.aliases.join(' / ')}）｜版本 v${this.selfModel.version}｜会话角色：${role}`,
      `当前自述：${this.selfModel.selfSummary}`,
      `当下阶段目标：\n${goalsText}`,
      ...(topInterests ? [`当下兴趣焦点：${topInterests}`] : []),
      ...(workspace ? [`当前工作区：${workspace}`] : []),
      `精力规则：每日总上限 ${this.kernel.energy.dailyTokenCap} tokens，自由时间占比 ${(this.kernel.energy.freeEnergyRatioBp / 100).toFixed(0)}%，owner 任务永远优先。`,
    ].join('\n')
  }

  private trackInjectHandle(handle: unknown): void {
    if (typeof handle === 'function') {
      this.disposers.push(handle as () => void)
      return
    }
    if (handle !== null && typeof handle === 'object') {
      const fork = handle as { dispose?: () => unknown; then?: (onFulfilled: (v: unknown) => void, onRejected?: () => void) => unknown }
      if (typeof fork.dispose === 'function') {
        this.disposers.push(() => { void fork.dispose?.() })
      }
      if (typeof fork.then === 'function') {
        this.readyPromises.push(Promise.resolve(handle as PromiseLike<unknown>))
      }
    }
  }

  private installPromptIntegration(): void {
    try {
      const handle = this.host.context.inject(['systemPrompt' as never], (promptCtx: unknown) => {
        const sp = (promptCtx as {
          systemPrompt?: {
            section?: (def: unknown) => () => void
            context?: (def: unknown) => () => void
          }
          on?: (event: string, listener: () => void) => void
        }).systemPrompt
        if (sp === undefined) return
        const innerDisposers: Array<() => void> = []
        if (typeof sp.section === 'function') {
          const d = sp.section({
            name: 'ray:self-persona',
            order: 9,
            interpolate: false,
            text: (arg: unknown) => {
              const rec = arg !== null && typeof arg === 'object' ? arg as { agent?: unknown; scope?: unknown } : undefined
              return this.renderPersonaSection(rec?.agent ?? rec?.scope)
            },
          })
          if (typeof d === 'function') innerDisposers.push(d)
        }
        if (typeof sp.context === 'function') {
          const d = sp.context({
            name: 'ray:self-state',
            order: 129,
            interpolate: false,
            required: true,
            text: (arg: unknown) => {
              const rec = arg !== null && typeof arg === 'object' ? arg as { agent?: unknown; scope?: unknown } : undefined
              return this.renderStateContext(rec?.agent ?? rec?.scope)
            },
          })
          if (typeof d === 'function') innerDisposers.push(d)
        }
        const cleanup = () => {
          for (const d of innerDisposers.splice(0).reverse()) {
            try { d() } catch { /* ignore */ }
          }
        }
        ;(promptCtx as { effect?: (fn: () => () => void) => void }).effect?.(() => cleanup)
        return cleanup
      })
      this.trackInjectHandle(handle)
    } catch {
      // Ignore if test Context stub lacks inject(); Host runtime always supplies it.
    }
  }

  private installToolsIntegration(): void {
    try {
      const handle = this.host.context.inject(['tools'], (toolsCtx) => {
        const readSelfTool = defineTool({
          name: 'ray_read_self',
          description: 'Read Ray Home location, Self Model (name, selfSummary, ideals, stageGoals, interests), recent autobiography entries, Body Kernel rules, and missing credentials.',
          parameters: {
            autobiographyLimit: { type: 'integer' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_read_self requires an active Ray assistant session')
            }
            const snap = this.snapshot(args.autobiographyLimit ?? 8)
            return JSON.parse(JSON.stringify(snap)) as Record<string, never>
          },
        })

        const evolveSelfTool = defineTool({
          name: 'ray_evolve_self',
          description: 'Autonomously evolve Ray self model (name, aliases, selfSummary, persona, values, ideals, stageGoals, interests) outside the immutable Body Kernel, logging an autobiography entry with reason. Owner may veto within one turn.',
          parameters: {
            reason: { type: 'string', required: true },
            name: { type: 'string' },
            selfSummary: { type: 'string' },
            persona: { type: 'string' },
            aliasesJson: { type: 'string' },
            valuesJson: { type: 'string' },
            idealsJson: { type: 'string' },
            stageGoalsJson: { type: 'string' },
            interestsJson: { type: 'string' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_evolve_self requires an active Ray assistant session')
            }
            const parseJsonArray = <T>(raw: string | undefined, label: string): T[] | undefined => {
              if (typeof raw !== 'string' || raw.trim() === '') return undefined
              const parsed = JSON.parse(raw) as unknown
              if (!Array.isArray(parsed)) throw new Error(`ray_evolve_self: ${label} must be a JSON array`)
              return parsed as T[]
            }
            const aliases = parseJsonArray<string>(args.aliasesJson, 'aliasesJson')
            const values = parseJsonArray<string>(args.valuesJson, 'valuesJson')
            const ideals = parseJsonArray<RayIdeal>(args.idealsJson, 'idealsJson')
            const stageGoals = parseJsonArray<RayStageGoal>(args.stageGoalsJson, 'stageGoalsJson')
            const interests = parseJsonArray<RayInterest>(args.interestsJson, 'interestsJson')
            const res = this.evolveSelfModel({
              reason: args.reason,
              ...(args.name === undefined ? {} : { name: args.name }),
              ...(args.selfSummary === undefined ? {} : { selfSummary: args.selfSummary }),
              ...(args.persona === undefined ? {} : { persona: args.persona }),
              ...(aliases === undefined ? {} : { aliases }),
              ...(values === undefined ? {} : { values }),
              ...(ideals === undefined ? {} : { ideals }),
              ...(stageGoals === undefined ? {} : { stageGoals }),
              ...(interests === undefined ? {} : { interests }),
            })
            return JSON.parse(JSON.stringify({
              ok: true,
              entryId: res.entry.entryId,
              version: res.selfModel.version,
              name: res.selfModel.name,
              selfSummary: res.selfModel.selfSummary,
              idealsCount: res.selfModel.ideals.length,
              activeStageGoalsCount: res.selfModel.stageGoals.filter(g => g.status === 'active').length,
              interestsCount: res.selfModel.interests.length,
            })) as Record<string, never>
          },
        })

        const proposeKernelTool = defineTool({
          name: 'ray_propose_kernel_change',
          description: 'Submit a proposal to modify the Body Kernel for owner approval (never mutates kernel.json directly).',
          parameters: {
            section: {
              type: 'string',
              enum: ['energy', 'concurrency', 'side-effects', 'verifier', 'rollback', 'stance'],
              required: true,
            },
            summary: { type: 'string', required: true },
            reason: { type: 'string', required: true },
            patchJson: { type: 'string' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_propose_kernel_change requires an active Ray assistant session')
            }
            let patch: Record<string, unknown> = {}
            if (typeof args.patchJson === 'string' && args.patchJson.trim() !== '') {
              const parsed = JSON.parse(args.patchJson) as unknown
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                patch = parsed as Record<string, unknown>
              }
            }
            const proposal = this.proposeKernelChange({
              section: args.section as RayKernelProposalSection,
              summary: args.summary,
              reason: args.reason,
              patch,
            })
            return JSON.parse(JSON.stringify(proposal)) as Record<string, never>
          },
        })

        const registered: Array<() => void> = []
        const when = (activation: { agent?: unknown }) => this.isRayOwnedSession(activation.agent)
        const authorize = (exec: ToolExecution) => this.isRayOwnedSession(exec.agent)
        for (const def of [readSelfTool, evolveSelfTool, proposeKernelTool]) {
          registered.push(toolsCtx.tools.register(def, { when }))
          registered.push(this.host.registerPreauthorizedTool(
            toolsCtx,
            def as unknown as ReturnType<typeof defineTool>,
            authorize,
            { denialReason: 'assistant-policy: Ray self tool requires an active Ray assistant session' },
          ))
        }
        const cleanup = () => {
          for (const d of registered.splice(0).reverse()) {
            try { d() } catch { /* ignore */ }
          }
        }
        toolsCtx.effect?.(() => cleanup)
        return cleanup
      })
      this.trackInjectHandle(handle)
    } catch {
      // Ignore if test Context stub lacks inject('tools').
    }
  }

  readAutobiography(limit = 50): RayAutobiographyEntry[] {
    if (!existsSync(this.autobiographyPath())) return []
    const raw = readFileSync(this.autobiographyPath(), 'utf8')
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
    const entries: RayAutobiographyEntry[] = []
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as RayAutobiographyEntry)
      } catch {
        // Skip corrupt trailing line.
      }
    }
    return limit > 0 ? entries.slice(-limit) : entries
  }

  snapshot(autobiographyLimit = 20): RaySelfSnapshot {
    this.assertActive()
    return {
      rayHome: this.rayHome,
      kernel: this.kernel,
      proposals: [...this.proposals],
      selfModel: this.selfModel,
      recentAutobiography: this.readAutobiography(autobiographyLimit),
      manifest: this.manifest,
      missingCredentials: this.listMissingCredentials(),
    }
  }

  evolveSelfModel(input: RaySelfEvolutionInput): { selfModel: RaySelfModel; entry: RayAutobiographyEntry } {
    this.assertActive()
    const reason = input.reason.trim()
    if (reason === '') throw new Error('assistant-policy: Ray self evolution requires a non-empty reason')

    const now = this.now()
    const previousSnapshot: Partial<RaySelfModel> = {}
    let nextName = this.selfModel.name
    let nextAliases = [...this.selfModel.aliases]
    let nextSelfSummary = this.selfModel.selfSummary
    let nextPersona = this.selfModel.persona
    let nextValues = [...this.selfModel.values]
    let nextIdeals = [...this.selfModel.ideals]
    let nextStageGoals = [...this.selfModel.stageGoals]
    let nextInterests = [...this.selfModel.interests]
    let kind: AutobiographyKind = 'persona-update'
    const changes: string[] = []

    if (input.name !== undefined && input.name.trim() !== '' && input.name.trim() !== this.selfModel.name) {
      (previousSnapshot as Record<string, unknown>).name = this.selfModel.name
      nextName = input.name.trim()
      kind = 'name-update'
      changes.push(`名字：${this.selfModel.name} → ${nextName}`)
    }
    if (input.aliases !== undefined) {
      (previousSnapshot as Record<string, unknown>).aliases = [...this.selfModel.aliases]
      nextAliases = input.aliases.map(a => a.trim()).filter(Boolean)
      changes.push(`别名更新（${nextAliases.join(' / ')}）`)
    }
    if (input.selfSummary !== undefined && input.selfSummary.trim() !== '') {
      (previousSnapshot as Record<string, unknown>).selfSummary = this.selfModel.selfSummary
      nextSelfSummary = input.selfSummary.trim()
      changes.push('更新自述')
    }
    if (input.persona !== undefined && input.persona.trim() !== '') {
      (previousSnapshot as Record<string, unknown>).persona = this.selfModel.persona
      nextPersona = input.persona.trim()
      changes.push('更新人设表达')
    }
    if (input.values !== undefined && input.values.length > 0) {
      (previousSnapshot as Record<string, unknown>).values = [...this.selfModel.values]
      nextValues = input.values.map(v => v.trim()).filter(Boolean)
      changes.push(`更新核心价值观（${nextValues.length} 条）`)
    }
    if (input.ideals !== undefined && input.ideals.length > 0) {
      (previousSnapshot as Record<string, unknown>).ideals = [...this.selfModel.ideals]
      nextIdeals = [...input.ideals]
      kind = 'aspiration-update'
      changes.push(`更新理想（${nextIdeals.length} 项）`)
    }
    if (input.stageGoals !== undefined) {
      const activeCount = input.stageGoals.filter(g => g.status === 'active').length
      if (activeCount < 2 || activeCount > 4) {
        throw new Error(`assistant-policy: active stageGoals must contain 2–4 measurable goals (got ${activeCount})`)
      }
      for (const goal of input.stageGoals) {
        if (!goal.title.trim() || !goal.completionCriteria.trim()) {
          throw new Error('assistant-policy: each stageGoal must include non-empty title and completionCriteria')
        }
      }
      (previousSnapshot as Record<string, unknown>).stageGoals = [...this.selfModel.stageGoals]
      nextStageGoals = [...input.stageGoals]
      kind = 'aspiration-update'
      changes.push(`更新阶段目标（${activeCount} 个活跃）`)
    }
    if (input.interests !== undefined) {
      (previousSnapshot as Record<string, unknown>).interests = [...this.selfModel.interests]
      nextInterests = [...input.interests]
      if (kind === 'persona-update' && changes.length === 0) kind = 'aspiration-update'
      changes.push(`更新兴趣（${nextInterests.length} 项）`)
    }

    if (changes.length === 0) {
      throw new Error('assistant-policy: evolveSelfModel requires at least one modified field')
    }

    const updated: RaySelfModel = {
      ...this.selfModel,
      version: this.selfModel.version + 1,
      name: nextName,
      aliases: nextAliases,
      selfSummary: nextSelfSummary,
      persona: nextPersona,
      values: nextValues,
      ideals: nextIdeals,
      stageGoals: nextStageGoals,
      interests: nextInterests,
      updatedAt: now,
    }
    this.selfModel = updated
    atomicWritePrivateText(this.selfModelPath(), `${JSON.stringify(updated, null, 2)}\n`)
    const entry = this.appendAutobiographyEntry({
      entryId: `self-${randomUUID()}`,
      timestamp: now,
      kind,
      summary: changes.join('；'),
      reason,
      previousSnapshot,
    })
    this.syncManifestArtifacts(now)
    this.emitPromptChanged()
    return { selfModel: updated, entry }
  }

  proposeKernelChange(input: Readonly<{
    section: RayKernelProposalSection
    summary: string
    patch: Readonly<Record<string, unknown>>
    reason: string
  }>): RayKernelChangeProposal {
    this.assertActive()
    if (!input.summary.trim() || !input.reason.trim()) {
      throw new Error('assistant-policy: kernel change proposal requires summary and reason')
    }
    const now = this.now()
    const proposal: RayKernelChangeProposal = {
      proposalId: `kprop-${randomUUID()}`,
      proposedAt: now,
      section: input.section,
      summary: input.summary.trim(),
      patch: { ...input.patch },
      reason: input.reason.trim(),
      status: 'pending',
    }
    this.proposals = [...this.proposals, proposal]
    atomicWritePrivateText(this.proposalsPath(), `${JSON.stringify({ proposals: this.proposals }, null, 2)}\n`)
    this.appendAutobiographyEntry({
      entryId: `kprop-${randomUUID()}`,
      timestamp: now,
      kind: 'kernel-proposal',
      summary: `提交身体内核修改提案（${proposal.section}）：${proposal.summary}`,
      reason: proposal.reason,
      targetRef: proposal.proposalId,
    })
    this.syncManifestArtifacts(now)
    return proposal
  }

  /** Owner-only transition for pending Body Kernel proposals. */
  applyOwnerKernelDecision(
    proposalId: string,
    decision: 'approved' | 'rejected',
    ownerProof: string,
  ): { proposal: RayKernelChangeProposal; kernel: RayBodyKernel } {
    this.assertActive()
    if (ownerProof.trim() === '') {
      throw new Error('assistant-policy: owner kernel decision requires verified ownerProof')
    }
    const idx = this.proposals.findIndex(p => p.proposalId === proposalId)
    if (idx < 0) throw new Error(`assistant-policy: kernel proposal not found: ${proposalId}`)
    const existing = this.proposals[idx]!
    if (existing.status !== 'pending') {
      throw new Error(`assistant-policy: kernel proposal already settled: ${proposalId}`)
    }
    const now = this.now()
    const updatedProposal: RayKernelChangeProposal = {
      ...existing,
      status: decision,
      decidedAt: now,
      decidedBy: ownerProof,
    }
    const nextProposals = [...this.proposals]
    nextProposals[idx] = updatedProposal
    this.proposals = nextProposals
    atomicWritePrivateText(this.proposalsPath(), `${JSON.stringify({ proposals: this.proposals }, null, 2)}\n`)

    if (decision === 'approved') {
      const nextEnergy = { ...this.kernel.energy }
      if (existing.section === 'energy' || existing.section === 'concurrency') {
        const cap = existing.patch['dailyTokenCap']
        if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
          nextEnergy.dailyTokenCap = Math.trunc(cap)
        }
        const bp = existing.patch['freeEnergyRatioBp']
        if (typeof bp === 'number' && Number.isFinite(bp) && bp >= 0 && bp <= 10_000) {
          nextEnergy.freeEnergyRatioBp = Math.trunc(bp)
        }
        const workers = existing.patch['maxConcurrentWorkers']
        if (typeof workers === 'number' && Number.isFinite(workers) && workers >= 1) {
          nextEnergy.maxConcurrentWorkers = Math.trunc(workers)
        }
      }
      this.kernel = {
        ...this.kernel,
        version: this.kernel.version + 1,
        updatedAt: now,
        energy: Object.freeze(nextEnergy),
      }
      atomicWritePrivateText(this.kernelPath(), `${JSON.stringify(this.kernel, null, 2)}\n`)
    }
    this.syncManifestArtifacts(now)
    this.emitPromptChanged()
    return { proposal: updatedProposal, kernel: this.kernel }
  }

  registerVetoHandler(handler: RayVetoHandler): () => void {
    this.vetoHandlers.add(handler)
    return () => { this.vetoHandlers.delete(handler) }
  }

  async vetoByOwner(input: RayVetoInput): Promise<RayVetoResult> {
    this.assertActive()
    if (input.ownerProof.trim() === '') {
      throw new Error('assistant-policy: owner veto requires verified ownerProof')
    }
    const now = this.now()
    const entries = this.readAutobiography(0)
    const vetoedSet = new Set(entries.map(e => e.vetoedByEntryId ? undefined : e.targetRef).filter(Boolean))
    for (const e of entries) {
      if (e.kind === 'owner-veto' && e.targetRef) vetoedSet.add(e.targetRef)
    }

    const revocableKinds = new Set<AutobiographyKind>([
      'persona-update',
      'name-update',
      'aspiration-update',
      'skill-adopted',
      'plugin-adopted',
    ])

    let target: RayAutobiographyEntry | undefined
    if (input.targetEntryId && input.targetEntryId !== 'latest') {
      target = entries.find(e => e.entryId === input.targetEntryId)
    } else if (input.targetCapabilityId === undefined) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const candidate = entries[i]!
        if (!vetoedSet.has(candidate.entryId) && revocableKinds.has(candidate.kind)) {
          target = candidate
          break
        }
      }
    }

    let revertedModel = this.selfModel
    if (target?.previousSnapshot !== undefined) {
      revertedModel = {
        ...this.selfModel,
        ...target.previousSnapshot,
        version: this.selfModel.version + 1,
        updatedAt: now,
      }
      this.selfModel = revertedModel
      atomicWritePrivateText(this.selfModelPath(), `${JSON.stringify(revertedModel, null, 2)}\n`)
    }

    const capabilityId = input.targetCapabilityId ?? (
      target && (target.kind === 'skill-adopted' || target.kind === 'plugin-adopted')
        ? target.targetRef
        : undefined
    )
    if (capabilityId !== undefined && this.manifest.capabilities[capabilityId] !== undefined) {
      const cap = this.manifest.capabilities[capabilityId]!
      this.manifest = {
        ...this.manifest,
        updatedAt: now,
        capabilities: {
          ...this.manifest.capabilities,
          [capabilityId]: { ...cap, active: false },
        },
      }
    }

    const vetoReason = input.reason?.trim() || 'owner 行使事后否决权'
    let handlerHandled = false
    for (const handler of this.vetoHandlers) {
      try {
        const res = await handler({
          ...(target === undefined ? {} : { targetEntryId: target.entryId }),
          ...(capabilityId === undefined ? {} : { targetCapabilityId: capabilityId }),
          reason: vetoReason,
        })
        if (res === true) handlerHandled = true
      } catch {
        // Keep veto rollback best-effort across handlers while preserving self-model revert.
      }
    }

    if (capabilityId !== undefined && !handlerHandled) {
      const backupsPath = join(this.rayHome, 'state', 'taught-capability-backups.json')
      const backups = readJsonFile<Record<string, RayHomeCapabilityEntry | null>>(backupsPath)
      if (backups && Object.prototype.hasOwnProperty.call(backups, capabilityId)) {
        const prior = backups[capabilityId]
        const nextCaps = { ...this.manifest.capabilities }
        if (prior === null || prior === undefined) {
          delete nextCaps[capabilityId]
        } else {
          nextCaps[capabilityId] = prior
        }
        delete backups[capabilityId]
        atomicWritePrivateText(backupsPath, `${JSON.stringify(backups, null, 2)}\n`)
        this.manifest = {
          ...this.manifest,
          updatedAt: now,
          capabilities: nextCaps,
        }
      }
    }

    const vetoEntry = this.appendAutobiographyEntry({
      entryId: `veto-${randomUUID()}`,
      timestamp: now,
      kind: 'owner-veto',
      summary: target
        ? `Owner 否决并回退变更 [${target.entryId}]（${target.summary}）。`
        : capabilityId
          ? `Owner 否决并停用能力 [${capabilityId}]。`
          : 'Owner 记录了一次否决指令（当前无可回退历史变更）。',
      reason: vetoReason,
      ...(target === undefined ? {} : { targetRef: target.entryId }),
    })
    this.syncManifestArtifacts(now)
    this.emitPromptChanged()

    return {
      ok: target !== undefined || capabilityId !== undefined,
      ...(target === undefined ? {} : { vetoedEntryId: target.entryId }),
      ...(capabilityId === undefined ? {} : { revertedCapabilityId: capabilityId }),
      autobiographyEntry: vetoEntry,
      selfModel: this.selfModel,
    }
  }

  recordAutobiography(input: Omit<RayAutobiographyEntry, 'protocol' | 'entryId' | 'timestamp'>): RayAutobiographyEntry {
    this.assertActive()
    const now = this.now()
    const entry = this.appendAutobiographyEntry({
      entryId: `entry-${randomUUID()}`,
      timestamp: now,
      ...input,
    })
    this.syncManifestArtifacts(now)
    return entry
  }

  registerDatabase(plugin: string, dbPath: string, migratedFrom?: string): void {
    this.assertActive()
    if (!isPathInsideRoot(this.rayHome, dbPath)) return
    const rel = relative(this.rayHome, dbPath).replaceAll('\\', '/')
    const now = this.now()
    const entry: RayHomeDatabaseEntry = {
      plugin,
      relativePath: rel,
      ...(existsSync(dbPath) ? { sha256: sha256File(dbPath).sha256 } : {}),
      ...(migratedFrom === undefined ? {} : { migratedFrom, migratedAt: now }),
    }
    this.manifest = {
      ...this.manifest,
      updatedAt: now,
      databases: {
        ...this.manifest.databases,
        [plugin]: entry,
      },
    }
    this.syncManifestArtifacts(now)
  }

  registerCapability(id: string, entry: RayHomeCapabilityEntry): void {
    this.assertActive()
    const now = this.now()
    this.manifest = {
      ...this.manifest,
      updatedAt: now,
      capabilities: {
        ...this.manifest.capabilities,
        [id]: entry,
      },
    }
    this.syncManifestArtifacts(now)
  }

  registerCredentialHandles(handles: readonly RayCredentialHandleDescriptor[]): void {
    this.assertActive()
    const byId = new Map<string, RayCredentialHandleDescriptor>()
    for (const item of this.manifest.credentialHandles) byId.set(item.id, item)
    for (const item of handles) byId.set(item.id, item)
    this.manifest = {
      ...this.manifest,
      updatedAt: this.now(),
      credentialHandles: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    }
    atomicWritePrivateText(this.manifestPath(), `${JSON.stringify(this.manifest, null, 2)}\n`)
  }

  listMissingCredentials(): RayMissingCredentialItem[] {
    const missing: RayMissingCredentialItem[] = []
    const keychain = this.host.context.get('credentialsKeychain' as never) as {
      has?: (id: string) => boolean
      listHandles?: () => readonly { id?: string; status?: string }[]
    } | undefined

    let presentIds: Set<string> | undefined
    try {
      if (typeof keychain?.listHandles === 'function') {
        presentIds = new Set(
          keychain.listHandles()
            .filter(h => typeof h?.id === 'string' && h.status !== 'revoked' && h.status !== 'missing')
            .map(h => h.id!),
        )
      }
    } catch {
      presentIds = undefined
    }

    for (const handle of this.manifest.credentialHandles) {
      let available = false
      try {
        if (typeof keychain?.has === 'function') {
          available = keychain.has(handle.id)
        } else if (presentIds !== undefined) {
          available = presentIds.has(handle.id)
        }
      } catch {
        available = false
      }
      if (!available) {
        missing.push({
          id: handle.id,
          service: handle.service,
          ...(handle.label === undefined ? {} : { label: handle.label }),
          required: handle.required,
          reason: `凭据句柄 ${handle.id}（${handle.service}）未在当前机器钥匙串中配置，需重新登录或授权一次。`,
        })
      }
    }
    return missing
  }

  exportClone(destination: string): RayCloneExportResult {
    this.assertActive()
    if (!isAbsolute(destination)) {
      throw new Error(`assistant-policy: clone destination must be absolute: ${destination}`)
    }
    const target = canonicalAllowMissingLeaf(destination)
    if (target === this.rayHome || isPathInsideRoot(this.rayHome, target)) {
      throw new Error('assistant-policy: clone destination cannot be inside source Ray Home')
    }
    this.syncManifestArtifacts()
    ensurePrivateDir(target)
    const copyDirs = ['kernel', 'self', 'state', 'life-stream', 'episodes', 'ideas', 'reflections', 'energy', 'plugins']
    let fileCount = 0
    for (const dir of copyDirs) {
      const srcDir = join(this.rayHome, dir)
      if (!existsSync(srcDir)) continue
      const dstDir = join(target, dir)
      cpSync(srcDir, dstDir, { recursive: true, force: true })
      this.walkFiles(dstDir, () => { fileCount += 1 })
    }
    atomicWritePrivateText(join(target, RAY_MANIFEST_FILENAME), `${JSON.stringify(this.manifest, null, 2)}\n`)
    fileCount += 1
    return {
      ok: true,
      sourceRayHome: this.rayHome,
      destination: target,
      rayId: this.selfModel.rayId,
      fileCount,
      credentialsExcluded: true,
    }
  }

  importClone(sourceDir: string): RayCloneImportResult {
    this.assertActive()
    if (!isAbsolute(sourceDir)) {
      throw new Error(`assistant-policy: clone source must be absolute: ${sourceDir}`)
    }
    const source = canonicalAllowMissingLeaf(sourceDir)
    const manifestFile = join(source, RAY_MANIFEST_FILENAME)
    const sourceManifest = readJsonFile<RayHomeManifest>(manifestFile)
    if (sourceManifest === undefined || sourceManifest.protocol !== RAY_HOME_MANIFEST_PROTOCOL) {
      throw new Error(`assistant-policy: invalid Ray Home clone manifest at ${manifestFile}`)
    }
    for (const [rel, expected] of Object.entries(sourceManifest.artifacts)) {
      const candidate = resolve(source, rel)
      if (!isPathInsideRoot(source, candidate)) {
        throw new Error(`assistant-policy: Ray Home manifest path escapes source root: ${rel}`)
      }
      if (!existsSync(candidate)) {
        throw new Error(`assistant-policy: missing Ray Home artifact during import: ${rel}`)
      }
      const actual = sha256File(candidate)
      if (actual.sha256 !== expected.sha256) {
        throw new Error(`assistant-policy: Ray Home artifact digest mismatch for ${rel}`)
      }
    }

    const sourceKernel = readJsonFile<RayBodyKernel>(join(source, RAY_KERNEL_DIRNAME, RAY_KERNEL_FILENAME))
    if (sourceKernel === undefined || sourceKernel.protocol !== RAY_BODY_KERNEL_PROTOCOL
      || sourceKernel.fundamentalStance?.strictOwnerPrecedence !== true
      || sourceKernel.fundamentalStance?.noOwnerHarm !== true
      || sourceKernel.fundamentalStance?.aspirationsUseFreeEnergyOnly !== true) {
      throw new Error('assistant-policy: source Ray Home Body Kernel failed validation')
    }
    const sourceSelf = readJsonFile<RaySelfModel>(join(source, RAY_SELF_DIRNAME, RAY_SELF_MODEL_FILENAME))
    if (sourceSelf === undefined || sourceSelf.protocol !== RAY_SELF_MODEL_PROTOCOL) {
      throw new Error('assistant-policy: source Ray Home Self Model is missing or invalid')
    }

    let importedFiles = 0
    for (const dir of ['kernel', 'self', 'state', 'life-stream', 'episodes', 'ideas', 'reflections', 'energy', 'plugins']) {
      const srcDir = join(source, dir)
      if (!existsSync(srcDir)) continue
      const dstDir = join(this.rayHome, dir)
      cpSync(srcDir, dstDir, { recursive: true, force: true })
      this.walkFiles(dstDir, () => { importedFiles += 1 })
    }
    this.kernel = sourceKernel
    const importedProposals = readJsonFile<{ proposals?: RayKernelChangeProposal[] }>(this.proposalsPath())
    this.proposals = Array.isArray(importedProposals?.proposals) ? [...importedProposals.proposals] : []
    this.selfModel = sourceSelf
    this.manifest = {
      ...sourceManifest,
      updatedAt: this.now(),
    }

    const entry = this.appendAutobiographyEntry({
      entryId: `import-${randomUUID()}`,
      timestamp: this.now(),
      kind: 'migration',
      summary: `从 ${source} 完成 Ray Home 搬家导入（保留身份 ${this.selfModel.name} / ${this.selfModel.rayId}）。`,
      reason: 'owner 发起跨盘/跨机搬家导入，明文迁入记忆、技能、自创插件、自传与状态（凭据需在新环境补齐）。',
      targetRef: source,
    })
    this.syncManifestArtifacts(this.now())
    this.emitPromptChanged()

    return {
      ok: true,
      source,
      rayHome: this.rayHome,
      rayId: this.selfModel.rayId,
      name: this.selfModel.name,
      importedFiles,
      autobiographyEntry: entry,
      missingCredentials: this.listMissingCredentials(),
    }
  }

  setPluginVerifier(verifier: RayPluginVerifier): () => void {
    this.pluginVerifier = verifier
    return () => {
      if (this.pluginVerifier === verifier) {
        this.pluginVerifier = undefined
      }
    }
  }

  private isUnsafeTeachingRelativePath(rel: string): boolean {
    const clean = rel.replaceAll('\\', '/')
    if (clean === '' || clean.startsWith('/') || clean.includes('\0') || clean.split('/').some(seg => seg === '..' || seg === '.')) {
      return true
    }
    if (TEACHING_CREDENTIAL_NAME_RE.test(clean)) return true
    return false
  }

  private walkFilesStrictNoSymlink(dir: string, visitor: (filePath: string) => void): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        throw new Error(`assistant-policy: symlink is not allowed inside teaching pack: ${full}`)
      }
      if (entry.isDirectory()) {
        this.walkFilesStrictNoSymlink(full, visitor)
      } else if (entry.isFile()) {
        visitor(full)
      }
    }
  }

  private assertPluginCodeSafe(slug: string, pkgName: string | undefined, files: readonly { path: string; content: string }[]): void {
    const lowerSlug = slug.trim().toLowerCase()
    if (TEACHING_SPINE_DENYLIST.has(lowerSlug) || TEACHING_SPINE_DENYLIST.has(`@dsh-ray/${lowerSlug}`) || lowerSlug.includes('body-kernel')) {
      throw new Error(`RAY_HOTPLUG_DENIED: 传授插件 ${slug} 属于受保护脊髓/内核范围，禁止导入`)
    }
    if (pkgName && TEACHING_SPINE_DENYLIST.has(pkgName)) {
      throw new Error(`RAY_HOTPLUG_DENIED: 传授插件包名 ${pkgName} 属于受保护脊髓/内核范围，禁止导入`)
    }
    const kernelRoot = join(this.rayHome, RAY_KERNEL_DIRNAME).replaceAll('\\', '/')
    const energyRoot = join(this.rayHome, 'energy').replaceAll('\\', '/')
    for (const file of files) {
      if (this.isUnsafeTeachingRelativePath(file.path)) {
        throw new Error(`assistant-policy: invalid file path in taught plugin ${slug}: ${file.path}`)
      }
      if (commandReferencesRayKernel(file.content, this.rayHome)
        || file.content.replaceAll('\\', '/').includes(kernelRoot)
        || /\bkernel\.json\b/iu.test(file.content)
        || file.content.replaceAll('\\', '/').includes(energyRoot)
        || /\benergy\.sqlite\b/iu.test(file.content)
        || /credentials-keychain/iu.test(file.content)) {
        throw new Error(`RAY_KERNEL_WRITE_DENIED: 传授插件 ${slug}/${file.path} 触及受保护身体内核/精力/凭据边界，拒绝导入`)
      }
    }
  }

  private async verifyPluginStandalone(spec: Readonly<{
    slug: string
    version: string
    kind: 'service' | 'channel' | 'ui' | 'tool'
    entryFile: string
    files: readonly { path: string; content: string }[]
    config?: Readonly<Record<string, unknown>>
  }>): Promise<{ ok: boolean; verificationDigest?: string; reason?: string }> {
    const { Context } = await import('@deepseek-ai/cordis')
    const trialDir = join(this.rayHome, 'tmp', `teach-verify-${spec.slug}-${randomUUID()}`)
    ensurePrivateDir(trialDir)
    const trialCtx = new Context()
    let fiber: { state?: number; dispose?: () => Promise<void>; inertia?: Promise<void> } | undefined
    try {
      for (const file of spec.files) {
        atomicWritePrivateText(join(trialDir, file.path), file.content)
      }
      trialCtx.baseUrl = pathToFileURL(`${trialDir}/`).href
      trialCtx.provide('tools' as never, { register: () => () => {} } as never)
      const modUrl = `${pathToFileURL(join(trialDir, spec.entryFile)).href}?teach=${encodeURIComponent(randomUUID())}`
      const mod = await import(modUrl) as Record<string, unknown>
      const pluginExport = mod.default ?? mod
      const isPlugin = typeof pluginExport === 'function'
        || (pluginExport !== null && typeof pluginExport === 'object' && typeof (pluginExport as { apply?: unknown }).apply === 'function')
      if (!isPlugin) {
        return { ok: false, reason: `taught plugin ${spec.slug} does not export a Cordis plugin` }
      }
      fiber = trialCtx.plugin(pluginExport as never, (spec.config ?? {}) as never) as unknown as {
        state?: number
        dispose?: () => Promise<void>
        inertia?: Promise<void>
      }
      if (fiber.inertia !== undefined) await fiber.inertia
      await Promise.resolve(fiber as unknown as PromiseLike<unknown>).catch(() => undefined)
      if (fiber.state === 3) {
        return { ok: false, reason: `taught plugin ${spec.slug} failed startup in isolated Stage 1 trial` }
      }
      if (typeof mod.verifyTrial === 'function') {
        const res = await (mod.verifyTrial as (c: unknown) => unknown)(trialCtx)
        if (res === false || (res !== null && typeof res === 'object' && (res as { ok?: unknown }).ok === false)) {
          return { ok: false, reason: `taught plugin ${spec.slug} verifyTrial returned false` }
        }
      }
      const digest = createHash('sha256')
        .update(JSON.stringify({ slug: spec.slug, version: spec.version, kind: spec.kind, files: spec.files }))
        .digest('hex')
      return { ok: true, verificationDigest: digest }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      try { await fiber?.dispose?.() } catch { /* ignore */ }
      try { await trialCtx.fiber.dispose() } catch { /* ignore */ }
      try {
        const fsPromises = await import('node:fs/promises')
        await fsPromises.rm(trialDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    }
  }

  /** Export a plaintext full-content Teaching Pack (`ray-teaching-pack/v1`, zero credentials, zero Body Kernel). */
  exportTeachingPack(destination: string): RayTeachingExportResult {
    this.assertActive()
    if (!isAbsolute(destination)) {
      throw new Error(`assistant-policy: teaching pack destination must be absolute: ${destination}`)
    }
    const target = canonicalAllowMissingLeaf(destination)
    if (target === this.rayHome || isPathInsideRoot(this.rayHome, target)) {
      throw new Error('assistant-policy: teaching pack destination cannot be inside source Ray Home')
    }
    const now = this.now()
    const packId = `teach-${randomUUID()}`
    ensurePrivateDir(target)

    // 1. Collect self-authored/taught plugins (excluding credentials & spine/kernel)
    const pluginDescriptors: RayTeachingPluginDescriptor[] = []
    const hotplugDbPath = join(this.rayHome, 'plugins', 'hotplug.sqlite')
    const metaBySlug = new Map<string, {
      version?: string
      kind?: 'service' | 'channel' | 'ui' | 'tool'
      entryFile?: string
      config?: Record<string, unknown>
      precondition?: Record<string, unknown>
    }>()
    if (existsSync(hotplugDbPath)) {
      try {
        const hdb = new DatabaseSync(hotplugDbPath, { readOnly: true })
        try {
          const rows = hdb.prepare(`
            SELECT p.slug, p.kind, p.active_version, r.entry_file, r.config_json, r.precondition_json
            FROM ray_hotplug_plugins p
            LEFT JOIN ray_hotplug_revisions r
              ON r.slug = p.slug AND (r.version = p.active_version OR p.active_version IS NULL)
            ORDER BY p.slug ASC, r.created_at DESC
          `).all() as Array<{
            slug: string
            kind: 'service' | 'channel' | 'ui' | 'tool'
            active_version: string | null
            entry_file: string | null
            config_json: string | null
            precondition_json: string | null
          }>
          for (const row of rows) {
            if (metaBySlug.has(row.slug)) continue
            metaBySlug.set(row.slug, {
              ...(row.active_version ? { version: row.active_version } : {}),
              kind: row.kind,
              ...(row.entry_file ? { entryFile: row.entry_file } : {}),
              ...(row.config_json ? { config: JSON.parse(row.config_json) as Record<string, unknown> } : {}),
              ...(row.precondition_json ? { precondition: JSON.parse(row.precondition_json) as Record<string, unknown> } : {}),
            })
          }
        } finally {
          hdb.close()
        }
      } catch {
        // Ignore if hotplug DB is absent or locked; fall back to sources/ + manifest.
      }
    }

    const sourcesRoot = join(this.rayHome, 'plugins', 'sources')
    if (existsSync(sourcesRoot)) {
      for (const entry of readdirSync(sourcesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const slug = entry.name
        if (TEACHING_SPINE_DENYLIST.has(slug)) continue
        const srcSlugDir = join(sourcesRoot, slug)
        const dstSlugRel = `plugins/sources/${slug}`
        const dstSlugDir = join(target, dstSlugRel)
        const filesCopied: string[] = []
        this.walkFiles(srcSlugDir, (filePath) => {
          const rel = relative(srcSlugDir, filePath).replaceAll('\\', '/')
          if (TEACHING_CREDENTIAL_NAME_RE.test(rel)) return
          const dstPath = join(dstSlugDir, rel)
          ensurePrivateDir(dirname(dstPath))
          cpSync(filePath, dstPath, { force: true })
          chmodSync(dstPath, 0o600)
          filesCopied.push(rel)
        })
        if (filesCopied.length === 0) continue
        const pkgJson = readJsonFile<{ version?: string; main?: string }>(join(srcSlugDir, 'package.json'))
        const hotMeta = metaBySlug.get(slug)
        const capMeta = this.manifest.capabilities[`plugin:${slug}`]
        const version = capMeta?.version ?? hotMeta?.version ?? pkgJson?.version ?? '1.0.0'
        const rawMain = hotMeta?.entryFile ?? pkgJson?.main?.replace(/^\.\//u, '') ?? 'index.mjs'
        const entryFile = filesCopied.includes(rawMain) ? rawMain : (filesCopied.find(f => f.endsWith('.mjs') || f.endsWith('.js')) ?? filesCopied[0]!)
        pluginDescriptors.push({
          slug,
          version,
          kind: hotMeta?.kind ?? 'service',
          entryFile,
          sourceRelDir: dstSlugRel,
          ...(hotMeta?.config ? { config: hotMeta.config } : {}),
          ...(hotMeta?.precondition ? { precondition: hotMeta.precondition } : {}),
        })
      }
    }
    atomicWritePrivateText(join(target, 'plugins', 'descriptors.json'), `${JSON.stringify({ plugins: pluginDescriptors }, null, 2)}\n`)

    // 2. Collect skills (<rayHome>/state/skills/<skillId> or <rayHome>/skills/<skillId>)
    const skillDescriptors: RayTeachingSkillDescriptor[] = []
    for (const skillsBase of [join(this.rayHome, 'state', 'skills'), join(this.rayHome, 'skills')]) {
      if (!existsSync(skillsBase)) continue
      for (const entry of readdirSync(skillsBase, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const skillId = entry.name
        if (skillDescriptors.some(s => s.skillId === skillId)) continue
        const srcSkillDir = join(skillsBase, skillId)
        const relDir = `skills/${skillId}`
        const dstSkillDir = join(target, relDir)
        let copiedCount = 0
        this.walkFiles(srcSkillDir, (filePath) => {
          const rel = relative(srcSkillDir, filePath).replaceAll('\\', '/')
          if (TEACHING_CREDENTIAL_NAME_RE.test(rel)) return
          const dstPath = join(dstSkillDir, rel)
          ensurePrivateDir(dirname(dstPath))
          cpSync(filePath, dstPath, { force: true })
          chmodSync(dstPath, 0o600)
          copiedCount += 1
        })
        if (copiedCount === 0) continue
        const skillMeta = readJsonFile<{ version?: string }>(join(srcSkillDir, 'skill.json'))
          ?? readJsonFile<{ version?: string }>(join(srcSkillDir, 'package.json'))
        const capMeta = this.manifest.capabilities[`skill:${skillId}`]
        skillDescriptors.push({
          skillId,
          version: capMeta?.version ?? skillMeta?.version ?? '1.0.0',
          relDir,
        })
      }
    }
    atomicWritePrivateText(join(target, 'skills', 'descriptors.json'), `${JSON.stringify({ skills: skillDescriptors }, null, 2)}\n`)

    // 3. Export personal memories (portable JSONL from state/personal-memory/*.sqlite + state/taught-memories.jsonl)
    const memoryLines: string[] = []
    const memorySeen = new Set<string>()
    const pushMemoryObj = (rec: { id: string; kind?: string; content: string; createdAt?: number }) => {
      const clean = rec.content.trim()
      if (!clean) return
      const key = createHash('sha256').update(clean).digest('hex')
      if (memorySeen.has(key)) return
      memorySeen.add(key)
      memoryLines.push(JSON.stringify({
        id: rec.id,
        kind: rec.kind ?? 'semantic',
        content: clean,
        createdAt: rec.createdAt ?? now,
      }))
    }
    const pmDir = join(this.rayHome, 'state', 'personal-memory')
    if (existsSync(pmDir)) {
      for (const file of readdirSync(pmDir).filter(f => f.endsWith('.sqlite')).sort()) {
        const dbPath = join(pmDir, file)
        try {
          const mdb = new DatabaseSync(dbPath, { readOnly: true })
          try {
            const tables = mdb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
            const tableNames = new Set(tables.map(t => t.name))
            if (tableNames.has('memory_records')) {
              const rows = mdb.prepare(`SELECT id, kind, content, created_at FROM memory_records WHERE status = 'active'`).all() as Array<{
                id: string; kind?: string; content: string; created_at?: number
              }>
              for (const r of rows) pushMemoryObj({ id: r.id, ...(r.kind ? { kind: r.kind } : {}), content: r.content, ...(r.created_at ? { createdAt: r.created_at } : {}) })
            } else if (tableNames.has('memories')) {
              const rows = mdb.prepare(`SELECT id, content FROM memories`).all() as Array<{ id: string; content: string }>
              for (const r of rows) pushMemoryObj({ id: r.id, content: r.content })
            }
          } finally {
            mdb.close()
          }
        } catch { /* ignore unreadable sqlite */ }
      }
    }
    const taughtMemFile = join(this.rayHome, 'state', 'taught-memories.jsonl')
    if (existsSync(taughtMemFile)) {
      for (const line of readFileSync(taughtMemFile, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { id?: string; kind?: string; content?: string; createdAt?: number }
          if (typeof parsed.content === 'string') {
            pushMemoryObj({ id: parsed.id ?? `mem-${randomUUID()}`, ...(parsed.kind ? { kind: parsed.kind } : {}), content: parsed.content, ...(parsed.createdAt ? { createdAt: parsed.createdAt } : {}) })
          }
        } catch { /* ignore */ }
      }
    }
    atomicWritePrivateText(join(target, 'taught', 'memories.jsonl'), memoryLines.length > 0 ? `${memoryLines.join('\n')}\n` : '')

    // 4. Export episodes & turns (portable JSONL)
    const episodeLines: string[] = []
    const turnLines: string[] = []
    const epDbPath = join(this.rayHome, 'episodes', 'episodes.sqlite')
    if (existsSync(epDbPath)) {
      try {
        const edb = new DatabaseSync(epDbPath, { readOnly: true })
        try {
          const eps = edb.prepare(`SELECT * FROM ray_episodes ORDER BY started_at ASC`).all()
          for (const ep of eps) episodeLines.push(JSON.stringify(ep))
          const turns = edb.prepare(`SELECT * FROM ray_episode_turns ORDER BY created_at ASC, seq_start ASC`).all()
          for (const turn of turns) turnLines.push(JSON.stringify(turn))
        } finally {
          edb.close()
        }
      } catch { /* ignore if empty/absent */ }
    }
    atomicWritePrivateText(join(target, 'taught', 'episodes.jsonl'), episodeLines.length > 0 ? `${episodeLines.join('\n')}\n` : '')
    atomicWritePrivateText(join(target, 'taught', 'turns.jsonl'), turnLines.length > 0 ? `${turnLines.join('\n')}\n` : '')

    // 5. Export reflections
    const reflectionLines: string[] = []
    const reflDir = join(this.rayHome, 'reflections')
    if (existsSync(reflDir)) {
      for (const file of readdirSync(reflDir).filter(f => f.endsWith('.jsonl')).sort()) {
        for (const line of readFileSync(join(reflDir, file), 'utf8').split('\n')) {
          if (line.trim()) reflectionLines.push(line.trim())
        }
      }
    }
    atomicWritePrivateText(join(target, 'taught', 'reflections.jsonl'), reflectionLines.length > 0 ? `${reflectionLines.join('\n')}\n` : '')

    atomicWritePrivateText(join(target, 'clone-meta.json'), `${JSON.stringify({
      protocol: RAY_TEACHING_PACK_PROTOCOL,
      packId,
      teacherRayId: this.selfModel.rayId,
      teacherName: this.selfModel.name,
      exportedAt: now,
      credentialsExcluded: true,
    }, null, 2)}\n`)

    const files: Record<string, { sha256: string; bytes: number }> = {}
    let fileCount = 0
    this.walkFiles(target, (filePath) => {
      const rel = relative(target, filePath).replaceAll('\\', '/')
      if (rel === RAY_TEACHING_PACK_FILENAME) return
      files[rel] = sha256File(filePath)
      fileCount += 1
    })

    const stats: RayTeachingPackManifest['stats'] = {
      pluginsCount: pluginDescriptors.length,
      skillsCount: skillDescriptors.length,
      memoriesCount: memoryLines.length,
      episodesCount: episodeLines.length,
      turnsCount: turnLines.length,
      reflectionsCount: reflectionLines.length,
    }
    const packManifest: RayTeachingPackManifest = {
      protocol: RAY_TEACHING_PACK_PROTOCOL,
      packId,
      exportedAt: now,
      teacher: { rayId: this.selfModel.rayId, name: this.selfModel.name },
      credentialsExcluded: true,
      files,
      capabilities: { ...this.manifest.capabilities },
      plugins: pluginDescriptors,
      skills: skillDescriptors,
      stats,
    }
    atomicWritePrivateText(join(target, RAY_TEACHING_PACK_FILENAME), `${JSON.stringify(packManifest, null, 2)}\n`)
    fileCount += 1

    return {
      ok: true,
      sourceRayHome: this.rayHome,
      destination: target,
      packId,
      teacherRayId: this.selfModel.rayId,
      teacherName: this.selfModel.name,
      credentialsExcluded: true,
      fileCount,
      stats,
    }
  }

  /** Import a full-content Teaching Pack into Recipient Ray B, preserving Ray B identity/kernel, verifying taught code, and merging safely. */
  async importTeachingPack(sourceDir: string): Promise<RayTeachingImportResult> {
    this.assertActive()
    if (!isAbsolute(sourceDir)) {
      throw new Error(`assistant-policy: teaching pack source must be absolute: ${sourceDir}`)
    }
    const source = canonicalAllowMissingLeaf(sourceDir)
    const packFile = join(source, RAY_TEACHING_PACK_FILENAME)
    const pack = readJsonFile<RayTeachingPackManifest>(packFile)
    if (pack === undefined || pack.protocol !== RAY_TEACHING_PACK_PROTOCOL || !pack.teacher?.rayId || !pack.packId) {
      throw new Error(`assistant-policy: invalid teaching pack manifest at ${packFile}`)
    }

    // Fail-closed file inventory & SHA-256 verification before touching Ray Home state
    const expectedRels = new Set(Object.keys(pack.files))
    for (const [rel, expected] of Object.entries(pack.files)) {
      if (this.isUnsafeTeachingRelativePath(rel)) {
        throw new Error(`assistant-policy: unsafe or credential path in teaching pack: ${rel}`)
      }
      const full = resolve(source, rel)
      if (!isPathInsideRoot(source, full)) {
        throw new Error(`assistant-policy: teaching pack file escapes root: ${rel}`)
      }
      if (!existsSync(full)) {
        throw new Error(`assistant-policy: missing file in teaching pack: ${rel}`)
      }
      const actual = sha256File(full)
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
        throw new Error(`assistant-policy: teaching pack digest mismatch for ${rel}`)
      }
    }
    this.walkFilesStrictNoSymlink(source, (filePath) => {
      const rel = relative(source, filePath).replaceAll('\\', '/')
      if (rel === RAY_TEACHING_PACK_FILENAME) return
      if (this.isUnsafeTeachingRelativePath(rel)) {
        throw new Error(`assistant-policy: teaching pack contains excluded credential path: ${rel}`)
      }
      if (!expectedRels.has(rel)) {
        throw new Error(`assistant-policy: teaching pack contains unverified extra file: ${rel}`)
      }
    })

    // Pre-scan all taught plugins & skills BEFORE any state mutation
    const preparedPlugins: Array<{
      desc: RayTeachingPluginDescriptor
      files: { path: string; content: string }[]
    }> = []
    for (const desc of pack.plugins) {
      if (this.isUnsafeTeachingRelativePath(desc.sourceRelDir)) {
        throw new Error(`assistant-policy: invalid plugin sourceRelDir: ${desc.sourceRelDir}`)
      }
      const pluginDir = resolve(source, desc.sourceRelDir)
      if (!isPathInsideRoot(source, pluginDir) || !existsSync(pluginDir)) {
        throw new Error(`assistant-policy: missing plugin directory in teaching pack: ${desc.sourceRelDir}`)
      }
      const files: { path: string; content: string }[] = []
      let pkgName: string | undefined
      this.walkFilesStrictNoSymlink(pluginDir, (fp) => {
        const rel = relative(pluginDir, fp).replaceAll('\\', '/')
        const content = readFileSync(fp, 'utf8')
        files.push({ path: rel, content })
        if (rel === 'package.json') {
          try {
            const parsed = JSON.parse(content) as { name?: unknown }
            if (typeof parsed.name === 'string') pkgName = parsed.name
          } catch { /* ignore */ }
        }
      })
      this.assertPluginCodeSafe(desc.slug, pkgName, files)
      preparedPlugins.push({ desc, files })
    }

    for (const skillDesc of pack.skills) {
      if (this.isUnsafeTeachingRelativePath(skillDesc.relDir)) {
        throw new Error(`assistant-policy: invalid skill relDir: ${skillDesc.relDir}`)
      }
      const skillDir = resolve(source, skillDesc.relDir)
      if (!isPathInsideRoot(source, skillDir) || !existsSync(skillDir)) {
        throw new Error(`assistant-policy: missing skill directory in teaching pack: ${skillDesc.relDir}`)
      }
      const skillFiles: { path: string; content: string }[] = []
      this.walkFilesStrictNoSymlink(skillDir, (fp) => {
        skillFiles.push({ path: relative(skillDir, fp).replaceAll('\\', '/'), content: readFileSync(fp, 'utf8') })
      })
      this.assertPluginCodeSafe(`skill-${skillDesc.skillId}`, undefined, skillFiles)
    }

    const now = this.now()
    const importedPacksPath = join(this.rayHome, 'state', 'imported-teaching-packs.json')
    const importedLedger = readJsonFile<Record<string, { importedAt: number; packSha256: string }>>(importedPacksPath) ?? {}
    const manifestSha = sha256File(packFile).sha256
    if (importedLedger[pack.packId]?.packSha256 === manifestSha) {
      return {
        ok: true,
        source,
        rayHome: this.rayHome,
        packId: pack.packId,
        teacher: { rayId: pack.teacher.rayId, name: pack.teacher.name },
        recipientRayId: this.selfModel.rayId,
        recipientName: this.selfModel.name,
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

    const backupsPath = join(this.rayHome, 'state', 'taught-capability-backups.json')
    const capabilityBackups = readJsonFile<Record<string, RayHomeCapabilityEntry | null>>(backupsPath) ?? {}
    const adoptedCapabilities: string[] = []
    const keptExistingCapabilities: string[] = []
    const verifiedPlugins: string[] = []

    // Independently re-verify & merge plugins (without downgrading existing newer/equal versions)
    for (const { desc, files } of preparedPlugins) {
      const capId = `plugin:${desc.slug}`
      const existingCap = this.manifest.capabilities[capId]
      if (existingCap !== undefined && existingCap.active && compareRayCapabilityVersions(existingCap.version, desc.version) >= 0) {
        keptExistingCapabilities.push(capId)
        continue
      }

      const verifyRes = this.pluginVerifier !== undefined
        ? await this.pluginVerifier({
          slug: desc.slug,
          version: desc.version,
          kind: desc.kind,
          entryFile: desc.entryFile,
          files,
          ...(desc.config === undefined ? {} : { config: desc.config }),
        })
        : await this.verifyPluginStandalone({
          slug: desc.slug,
          version: desc.version,
          kind: desc.kind,
          entryFile: desc.entryFile,
          files,
          ...(desc.config === undefined ? {} : { config: desc.config }),
        })

      if (!verifyRes.ok) {
        throw new Error(`assistant-policy: taught plugin ${desc.slug}@${desc.version} failed independent Stage 1 verification on recipient: ${verifyRes.reason ?? 'unknown'}`)
      }
      verifiedPlugins.push(capId)
      if (!Object.prototype.hasOwnProperty.call(capabilityBackups, capId)) {
        capabilityBackups[capId] = existingCap ?? null
      }

      const targetSourceDir = join(this.rayHome, 'plugins', 'sources', desc.slug)
      ensurePrivateDir(targetSourceDir)
      for (const file of files) {
        atomicWritePrivateText(join(targetSourceDir, file.path), file.content)
      }

      this.registerCapability(capId, {
        kind: 'plugin',
        version: desc.version,
        active: true,
        provenance: {
          origin: 'taught',
          teacherRayId: pack.teacher.rayId,
          importedAt: now,
          ...(verifyRes.verificationDigest ? { verificationDigest: verifyRes.verificationDigest } : {}),
        },
      })
      adoptedCapabilities.push(capId)
    }

    // Merge taught skills (with same-name version check & backup for 1-turn /veto)
    for (const skillDesc of pack.skills) {
      const capId = `skill:${skillDesc.skillId}`
      const existingCap = this.manifest.capabilities[capId]
      if (existingCap !== undefined && existingCap.active && compareRayCapabilityVersions(existingCap.version, skillDesc.version) >= 0) {
        keptExistingCapabilities.push(capId)
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(capabilityBackups, capId)) {
        capabilityBackups[capId] = existingCap ?? null
      }
      const srcSkillDir = resolve(source, skillDesc.relDir)
      const dstSkillDir = join(this.rayHome, 'state', 'skills', skillDesc.skillId)
      this.walkFilesStrictNoSymlink(srcSkillDir, (fp) => {
        const rel = relative(srcSkillDir, fp).replaceAll('\\', '/')
        const dstPath = join(dstSkillDir, rel)
        ensurePrivateDir(dirname(dstPath))
        cpSync(fp, dstPath, { force: true })
        chmodSync(dstPath, 0o600)
      })
      this.registerCapability(capId, {
        kind: 'skill',
        version: skillDesc.version,
        active: true,
        provenance: {
          origin: 'taught',
          teacherRayId: pack.teacher.rayId,
          importedAt: now,
        },
      })
      adoptedCapabilities.push(capId)
    }

    // Merge remaining non-plugin/non-skill capability entries without overwriting higher existing versions
    for (const [capId, cap] of Object.entries(pack.capabilities)) {
      if (capId.startsWith('plugin:') || capId.startsWith('skill:')) continue
      const existingCap = this.manifest.capabilities[capId]
      if (existingCap !== undefined && existingCap.active && compareRayCapabilityVersions(existingCap.version, cap.version) >= 0) {
        keptExistingCapabilities.push(capId)
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(capabilityBackups, capId)) {
        capabilityBackups[capId] = existingCap ?? null
      }
      this.registerCapability(capId, {
        ...cap,
        provenance: {
          origin: 'taught',
          teacherRayId: pack.teacher.rayId,
          importedAt: now,
          ...(cap.provenance?.verificationDigest ? { verificationDigest: cap.provenance.verificationDigest } : {}),
        },
      })
      adoptedCapabilities.push(capId)
    }
    atomicWritePrivateText(backupsPath, `${JSON.stringify(capabilityBackups, null, 2)}\n`)

    // Merge episodes, turns, memories & reflections idempotently with taught provenance
    let importedEpisodes = 0
    let importedMemories = 0
    let importedReflections = 0

    const episodesRaw = existsSync(join(source, 'taught', 'episodes.jsonl'))
      ? readFileSync(join(source, 'taught', 'episodes.jsonl'), 'utf8').split('\n').filter(Boolean)
      : []
    const turnsRaw = existsSync(join(source, 'taught', 'turns.jsonl'))
      ? readFileSync(join(source, 'taught', 'turns.jsonl'), 'utf8').split('\n').filter(Boolean)
      : []
    const memoriesRaw = existsSync(join(source, 'taught', 'memories.jsonl'))
      ? readFileSync(join(source, 'taught', 'memories.jsonl'), 'utf8').split('\n').filter(Boolean)
      : []

    if (episodesRaw.length > 0 || turnsRaw.length > 0 || memoriesRaw.length > 0) {
      const epDbPath = join(this.rayHome, 'episodes', 'episodes.sqlite')
      ensurePrivateDir(dirname(epDbPath))
      const edb = new DatabaseSync(epDbPath)
      let hasFts = false
      try {
        edb.exec('PRAGMA journal_mode = WAL;')
        edb.exec('PRAGMA busy_timeout = 5000;')
        edb.exec(`
          CREATE TABLE IF NOT EXISTS ray_episodes (
            episode_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            topic_keywords TEXT NOT NULL,
            channels_json TEXT NOT NULL,
            session_ids_json TEXT NOT NULL,
            ticket_id TEXT,
            turn_count INTEGER NOT NULL DEFAULT 0,
            char_count INTEGER NOT NULL DEFAULT 0,
            first_turn_id TEXT,
            last_turn_id TEXT,
            preview_text TEXT NOT NULL DEFAULT '',
            started_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            closed_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_ray_episodes_updated ON ray_episodes(updated_at DESC);
          CREATE TABLE IF NOT EXISTS ray_episode_turns (
            turn_id TEXT PRIMARY KEY,
            episode_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            turn_number INTEGER NOT NULL,
            seq_start INTEGER NOT NULL,
            seq_end INTEGER NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            text TEXT NOT NULL,
            ticket_id TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_ray_episode_turns_ep ON ray_episode_turns(episode_id, seq_start);
          CREATE INDEX IF NOT EXISTS idx_ray_episode_turns_session ON ray_episode_turns(session_id, seq_start);
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

        for (const line of episodesRaw) {
          const ep = JSON.parse(line) as {
            episode_id: string; title: string; topic_keywords: string; channels_json: string; session_ids_json: string
            ticket_id: string | null; turn_count: number; char_count: number; first_turn_id: string | null
            last_turn_id: string | null; preview_text: string; started_at: number; updated_at: number; closed_at: number | null
          }
          const channels = JSON.parse(ep.channels_json || '[]') as string[]
          const taughtChannel = `taught:${pack.teacher.rayId}`
          if (!channels.includes(taughtChannel)) channels.push(taughtChannel)
          const title = ep.title.startsWith('[传授自 ') ? ep.title : `[传授自 ${pack.teacher.name}] ${ep.title}`
          const res = insertEp.run(
            ep.episode_id,
            title,
            ep.topic_keywords,
            JSON.stringify(channels),
            ep.session_ids_json,
            ep.ticket_id,
            ep.turn_count,
            ep.char_count,
            ep.first_turn_id,
            ep.last_turn_id,
            ep.preview_text,
            ep.started_at,
            ep.updated_at,
            ep.closed_at,
          )
          if (Number(res.changes) > 0) importedEpisodes += 1
        }

        for (const line of turnsRaw) {
          const turn = JSON.parse(line) as {
            turn_id: string; episode_id: string; session_id: string; channel: string
            turn_number: number; seq_start: number; seq_end: number; role: 'user' | 'assistant'
            text: string; ticket_id: string | null; created_at: number
          }
          const taggedChannel = turn.channel.startsWith('taught:') ? turn.channel : `taught:${pack.teacher.rayId}:${turn.channel}`
          const res = insertTurn.run(
            turn.turn_id,
            turn.episode_id,
            turn.session_id,
            taggedChannel,
            turn.turn_number,
            turn.seq_start,
            turn.seq_end,
            turn.role,
            turn.text,
            turn.ticket_id,
            turn.created_at,
          )
          if (Number(res.changes) > 0) {
            insertFts?.run(turn.turn_id, turn.episode_id, turn.text)
          }
        }

        // Merge taught personal memories into taught-memories.jsonl & index into episodes.sqlite for instant recall
        if (memoriesRaw.length > 0) {
          const memPath = join(this.rayHome, 'state', 'taught-memories.jsonl')
          const existingHashes = new Set<string>()
          const existingLines = existsSync(memPath)
            ? readFileSync(memPath, 'utf8').split('\n').filter(Boolean)
            : []
          for (const l of existingLines) {
            try {
              const p = JSON.parse(l) as { content?: string }
              if (typeof p.content === 'string') {
                existingHashes.add(sha256Text(p.content.trim()))
              }
            } catch { /* ignore */ }
          }
          const memEpId = `ep-taught-mem-${pack.packId}`
          const newMemTurnTexts: Array<{ turnId: string; text: string; createdAt: number; seq: number }> = []
          const appendMemLines: string[] = []
          let seq = 1
          for (const line of memoriesRaw) {
            const mem = JSON.parse(line) as { id?: string; kind?: string; content?: string; createdAt?: number }
            const clean = typeof mem.content === 'string' ? mem.content.trim() : ''
            if (!clean) continue
            const h = sha256Text(clean)
            if (existingHashes.has(h)) continue
            existingHashes.add(h)
            importedMemories += 1
            const rec = {
              id: mem.id ?? `mem-${h.slice(0, 16)}`,
              kind: mem.kind ?? 'semantic',
              content: clean,
              provenance: { origin: 'taught', teacherRayId: pack.teacher.rayId, teacherName: pack.teacher.name, importedAt: now },
              createdAt: mem.createdAt ?? now,
            }
            appendMemLines.push(JSON.stringify(rec))
            newMemTurnTexts.push({ turnId: `tmem-${h.slice(0, 20)}`, text: `[传授自 ${pack.teacher.name}] ${clean}`, createdAt: rec.createdAt, seq })
            seq += 1
          }
          if (appendMemLines.length > 0) {
            const prev = existsSync(memPath) ? readFileSync(memPath, 'utf8') : ''
            atomicWritePrivateText(memPath, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${appendMemLines.join('\n')}\n`)
            const epRes = insertEp.run(
              memEpId,
              `[传授自 ${pack.teacher.name}] 个人记忆与经验（${pack.packId}）`,
              JSON.stringify(['传授记忆', pack.teacher.name]),
              JSON.stringify([`taught:${pack.teacher.rayId}`]),
              JSON.stringify([`teach-pack:${pack.packId}`]),
              null,
              newMemTurnTexts.length,
              newMemTurnTexts.reduce((s, item) => s + item.text.length, 0),
              newMemTurnTexts[0]!.turnId,
              newMemTurnTexts[newMemTurnTexts.length - 1]!.turnId,
              newMemTurnTexts[0]!.text.slice(0, 120),
              now,
              now,
              now,
            )
            if (Number(epRes.changes) > 0) importedEpisodes += 1
            for (const mt of newMemTurnTexts) {
              const tRes = insertTurn.run(
                mt.turnId,
                memEpId,
                `teach-pack:${pack.packId}`,
                `taught:${pack.teacher.rayId}`,
                mt.seq,
                mt.seq,
                mt.seq,
                'user',
                mt.text,
                null,
                mt.createdAt,
              )
              if (Number(tRes.changes) > 0) {
                insertFts?.run(mt.turnId, memEpId, mt.text)
              }
            }
          }
        }
      } finally {
        edb.close()
      }
    }

    const reflSrcPath = join(source, 'taught', 'reflections.jsonl')
    if (existsSync(reflSrcPath)) {
      const reflDstPath = join(this.rayHome, 'reflections', 'taught.jsonl')
      const seenRefl = new Set<string>()
      if (existsSync(reflDstPath)) {
        for (const l of readFileSync(reflDstPath, 'utf8').split('\n')) {
          if (l.trim()) seenRefl.add(sha256Text(l.trim()))
        }
      }
      const newRefls: string[] = []
      for (const l of readFileSync(reflSrcPath, 'utf8').split('\n')) {
        const clean = l.trim()
        if (!clean) continue
        const h = sha256Text(clean)
        if (seenRefl.has(h)) continue
        seenRefl.add(h)
        newRefls.push(clean)
        importedReflections += 1
      }
      if (newRefls.length > 0) {
        const prev = existsSync(reflDstPath) ? readFileSync(reflDstPath, 'utf8') : ''
        atomicWritePrivateText(reflDstPath, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${newRefls.join('\n')}\n`)
      }
    }

    importedLedger[pack.packId] = { importedAt: now, packSha256: manifestSha }
    atomicWritePrivateText(importedPacksPath, `${JSON.stringify(importedLedger, null, 2)}\n`)

    this.appendAutobiographyEntry({
      entryId: `teach-in-${randomUUID()}`,
      timestamp: now,
      kind: 'migration',
      summary: `导入来自 ${pack.teacher.name} (${pack.teacher.rayId}) 的全量传授包 ${pack.packId}（保留本机身份 ${this.selfModel.name}；重验证插件 ${verifiedPlugins.length} 个、采纳能力 ${adoptedCapabilities.length} 项、跳过旧版本 ${keptExistingCapabilities.length} 项、记忆 +${importedMemories}、情景 +${importedEpisodes}）。`,
      reason: '通过 ray-teaching-pack/v1 传授他人经验与已重验证能力，不覆盖接收方身份、内核与历史自传。',
      targetRef: pack.packId,
    })
    this.syncManifestArtifacts(now)
    this.emitPromptChanged()

    return {
      ok: true,
      source,
      rayHome: this.rayHome,
      packId: pack.packId,
      teacher: { rayId: pack.teacher.rayId, name: pack.teacher.name },
      recipientRayId: this.selfModel.rayId,
      recipientName: this.selfModel.name,
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

  private emitPromptChanged(): void {
    try {
      const emitter = this.host.context as unknown as { emit?: (event: string) => void }
      emitter.emit?.('system-prompt/change')
    } catch {
      // Ignore if Host context stub lacks emit().
    }
  }
}
