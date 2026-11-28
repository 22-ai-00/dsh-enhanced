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
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
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
  commandReferencesRayKernel,
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
  private readonly host: RayHomeRuntimeHost
  private readonly now: () => number
  private readonly vetoHandlers = new Set<RayVetoHandler>()
  private readonly sessionRoles = new Map<string, RaySessionRole>()
  private readonly disposers: Array<() => void> = []
  private readonly readyPromises: Array<Promise<unknown>> = []
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
    this.vetoHandlers.clear()
    this.sessionRoles.clear()
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

    for (const raw of strings) {
      const trimmed = raw.trim()
      if (trimmed === '') continue
      if (isAbsolute(trimmed)) {
        const canonical = canonicalAllowMissingLeaf(trimmed)
        if (isRayKernelPath(this.rayHome, canonical) || isRayKernelPath(this.rayHome, trimmed)) {
          return `RAY_KERNEL_WRITE_DENIED: 身体内核（${kernelRoot}）由 owner 维护，不允许通过工具直接修改；请改用 ray_propose_kernel_change 提交提案。`
        }
      } else if (workspace !== undefined && isAbsolute(workspace)) {
        const resolved = canonicalAllowMissingLeaf(resolve(workspace, trimmed))
        if (isRayKernelPath(this.rayHome, resolved)) {
          return `RAY_KERNEL_WRITE_DENIED: 身体内核（${kernelRoot}）由 owner 维护，不允许通过相对路径直接修改；请改用 ray_propose_kernel_change 提交提案。`
        }
      }
      if (commandReferencesRayKernel(trimmed, this.rayHome, workspace)) {
        return `RAY_KERNEL_WRITE_DENIED: 检测到命令引用身体内核路径（${kernelRoot}）；身体内核不可由执行体直接改写，请使用 ray_propose_kernel_change。`
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
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.isRayOwnedSession(exec.agent)) {
              throw new Error('ray_evolve_self requires an active Ray assistant session')
            }
            const res = this.evolveSelfModel({
              reason: args.reason,
              ...(args.name === undefined ? {} : { name: args.name }),
              ...(args.selfSummary === undefined ? {} : { selfSummary: args.selfSummary }),
              ...(args.persona === undefined ? {} : { persona: args.persona }),
            })
            return JSON.parse(JSON.stringify({
              ok: true,
              entryId: res.entry.entryId,
              version: res.selfModel.version,
              name: res.selfModel.name,
              selfSummary: res.selfModel.selfSummary,
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
    for (const handler of this.vetoHandlers) {
      try {
        await handler({
          ...(target === undefined ? {} : { targetEntryId: target.entryId }),
          ...(capabilityId === undefined ? {} : { targetCapabilityId: capabilityId }),
          reason: vetoReason,
        })
      } catch {
        // Keep veto rollback best-effort across handlers while preserving self-model revert.
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

  private emitPromptChanged(): void {
    try {
      const emitter = this.host.context as unknown as { emit?: (event: string) => void }
      emitter.emit?.('system-prompt/change')
    } catch {
      // Ignore if Host context stub lacks emit().
    }
  }
}
