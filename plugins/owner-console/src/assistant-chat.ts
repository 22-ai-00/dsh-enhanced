import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { YAMLSeq } from 'yaml'
import { inspectOwnerRoute, readPatchDocument, resolveProfilePaths } from './autonomy-setup.js'
import { hasControlChars, type SettingsDescriptor, type SettingsService } from './settings.js'
import type { AssistantChatCapabilities, AssistantChatContext } from './typert.js'

const MAX_KNOWN_SESSIONS = 32
const MAX_SESSION_ID_CHARS = 200

interface PersistedAssistantSessions {
  readonly schemaVersion: 1
  readonly activeSessionId: string | null
  readonly sessionIds: readonly string[]
}

function validSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SESSION_ID_CHARS || hasControlChars(trimmed)) return undefined
  return trimmed
}

function resolveRegistryFilePath(host: Context, env: NodeJS.ProcessEnv): string | null {
  const paths = resolveProfilePaths(host, env)
  if (paths.canonicalHome === null) return null
  return join(paths.canonicalHome, 'owner-console', 'assistant-sessions.json')
}

function safeEnsureDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      const st = lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) return
      return
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Non-fatal in read-only or ephemeral test environments.
  }
}

function assertSafeTargetFile(filePath: string): void {
  let existing: ReturnType<typeof lstatSync>
  try {
    existing = lstatSync(filePath)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw error
  }
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error('assistant-sessions.json path is unsafe')
  }
}

function atomicWritePrivateJson(filePath: string, data: PersistedAssistantSessions): void {
  const dir = dirname(filePath)
  safeEnsureDir(dir)
  const dirStat = lstatSync(dir)
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('assistant-sessions directory path is unsafe')
  }
  assertSafeTargetFile(filePath)
  const tmpPath = join(dir, `.assistant-sessions.${process.pid}.${randomUUID()}.tmp`)
  let created = false
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    created = true
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, filePath)
  } catch (error: unknown) {
    if (created || (error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      try {
        unlinkSync(tmpPath)
      } catch {
        // Best-effort cleanup of temp file.
      }
    }
    throw error
  }
}

/**
 * Persistent Host-side registry tracking Session IDs created by or bound to the
 * dedicated 文鳐 assistant surface, keeping normal coding sessions untouched.
 */
export class AssistantChatRegistry {
  private readonly host: Context
  private readonly env: NodeJS.ProcessEnv
  private loadedPath: string | null = null
  private loaded = false
  private activeSessionId: string | null = null
  private sessionIds: string[] = []
  private readonly sessionSet = new Set<string>()

  constructor(host: Context, env: NodeJS.ProcessEnv = process.env) {
    this.host = host
    this.env = env
  }

  private ensureLoaded(): string | null {
    const filePath = resolveRegistryFilePath(this.host, this.env)
    if (this.loaded && filePath === this.loadedPath) return filePath
    this.loaded = true
    this.loadedPath = filePath
    this.activeSessionId = null
    this.sessionIds = []
    this.sessionSet.clear()
    if (filePath === null || !existsSync(filePath)) return filePath
    try {
      const dirStat = lstatSync(dirname(filePath))
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return filePath
      const st = lstatSync(filePath)
      if (!st.isFile() || st.isSymbolicLink()) return filePath
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedAssistantSessions>
      if (parsed?.schemaVersion !== 1) return filePath
      const seen = new Set<string>()
      const ordered: string[] = []
      for (const rawId of Array.isArray(parsed.sessionIds) ? parsed.sessionIds : []) {
        const clean = validSessionId(rawId)
        if (clean === undefined || seen.has(clean)) continue
        seen.add(clean)
        ordered.push(clean)
      }
      const cleanActive = validSessionId(parsed.activeSessionId)
      if (cleanActive !== undefined) {
        if (!seen.has(cleanActive)) {
          seen.add(cleanActive)
          ordered.push(cleanActive)
        } else if (ordered.length > MAX_KNOWN_SESSIONS && ordered.indexOf(cleanActive) < ordered.length - MAX_KNOWN_SESSIONS) {
          ordered.splice(ordered.indexOf(cleanActive), 1)
          ordered.push(cleanActive)
        }
      }
      const trimmed = ordered.slice(-MAX_KNOWN_SESSIONS)
      this.sessionIds = trimmed
      for (const id of trimmed) this.sessionSet.add(id)
      this.activeSessionId = cleanActive !== undefined && this.sessionSet.has(cleanActive)
        ? cleanActive
        : (trimmed.at(-1) ?? null)
    } catch {
      // Corrupt or unreadable state starts clean without crashing Host startup.
    }
    return filePath
  }

  hasSession(sessionId: string): boolean {
    const clean = validSessionId(sessionId)
    if (clean === undefined) return false
    this.ensureLoaded()
    return this.sessionSet.has(clean)
  }

  snapshot(): Readonly<{ activeSessionId: string | null; knownSessionIds: readonly string[] }> {
    this.ensureLoaded()
    return Object.freeze({
      activeSessionId: this.activeSessionId,
      knownSessionIds: Object.freeze([...this.sessionIds]),
    })
  }

  registerSession(sessionId: string, makeActive: boolean): Readonly<{ persisted: boolean; activeSessionId: string | null }> {
    const clean = validSessionId(sessionId)
    if (clean === undefined) throw new Error('无效的助手会话 ID')
    const filePath = this.ensureLoaded()
    let nextSessionIds = [...this.sessionIds]
    let nextActiveSessionId: string | null = makeActive || this.activeSessionId === null
      ? clean
      : this.activeSessionId
    if (!this.sessionSet.has(clean)) {
      nextSessionIds.push(clean)
    } else if (makeActive) {
      // Keep active session near the end so MRU eviction preserves it.
      nextSessionIds = [...nextSessionIds.filter(id => id !== clean), clean]
    }
    if (nextSessionIds.length > MAX_KNOWN_SESSIONS) {
      const overflow = nextSessionIds.length - MAX_KNOWN_SESSIONS
      let removed = 0
      const retained: string[] = []
      for (const id of nextSessionIds) {
        if (removed < overflow && id !== nextActiveSessionId) {
          removed += 1
          continue
        }
        retained.push(id)
      }
      nextSessionIds = retained.slice(-MAX_KNOWN_SESSIONS)
    }
    if (nextActiveSessionId === null || !nextSessionIds.includes(nextActiveSessionId)) {
      nextActiveSessionId = nextSessionIds.at(-1) ?? null
    }
    if (filePath !== null) {
      atomicWritePrivateJson(filePath, {
        schemaVersion: 1,
        activeSessionId: nextActiveSessionId,
        sessionIds: nextSessionIds,
      })
    }
    this.sessionIds = nextSessionIds
    this.sessionSet.clear()
    for (const id of nextSessionIds) this.sessionSet.add(id)
    this.activeSessionId = nextActiveSessionId
    return Object.freeze({ persisted: filePath !== null, activeSessionId: this.activeSessionId })
  }
}

export function readAssistantChatCapabilities(host: Context): AssistantChatCapabilities {
  const larkSvc = host.get('larkChannel' as never) as Readonly<{ health?: () => Readonly<{ state?: unknown }> }> | undefined
  let feishuConnected = false
  try {
    const state = larkSvc?.health?.()?.state
    feishuConnected = state === 'connected' || state === 'connected-with-gap'
  } catch {
    feishuConnected = false
  }
  return Object.freeze({
    memory: host.get('personalMemory' as never) !== undefined,
    wiki: host.get('personalWiki' as never) !== undefined,
    dreaming: host.get('assistantDreaming' as never) !== undefined,
    proactive: host.get('assistantProactive' as never) !== undefined,
    growth: host.get('assistantGrowthDriver' as never) !== undefined,
    feishuConnected,
  })
}

export function resolveAssistantWorkspace(host: Context, env: NodeJS.ProcessEnv = process.env): Readonly<{
  workspace: string
  agentPreset?: string
}> {
  const paths = resolveProfilePaths(host, env)
  const settings = host.get('settings' as never) as SettingsService | undefined
  let descriptors: readonly SettingsDescriptor[] = []
  try {
    descriptors = settings?.describe({ redactSecrets: true }) ?? []
  } catch {
    descriptors = []
  }
  let seq: YAMLSeq | undefined
  if (paths.patchPath !== null) {
    try {
      const doc = readPatchDocument(paths.patchPath)
      seq = doc.contents as YAMLSeq
    } catch {
      seq = undefined
    }
  }
  const owner = inspectOwnerRoute(host, paths, seq, descriptors)
  const fallbackWs = paths.canonicalHome !== null ? join(paths.canonicalHome, 'assistant-workspace') : ''
  const configuredWs = owner.configured && isAbsolute(owner.workspace) ? owner.workspace : ''
  const workspace = configuredWs !== '' ? configuredWs : fallbackWs
  if (workspace !== '' && paths.canonicalHome !== null && (workspace === join(paths.canonicalHome, 'assistant-workspace') || owner.configured)) {
    safeEnsureDir(workspace)
  }
  const preset = owner.preset.trim()
  return Object.freeze({
    workspace,
    ...(preset === '' ? {} : { agentPreset: preset }),
  })
}

export function buildWenyaoSystemPrompt(workspace: string, capabilities: AssistantChatCapabilities): string {
  const activeCapabilities: string[] = []
  if (capabilities.memory) activeCapabilities.push('长期记忆（personal-memory）')
  if (capabilities.wiki) activeCapabilities.push('个人知识库（personal-wiki）')
  if (capabilities.dreaming) activeCapabilities.push('自主做梦灵感（assistant-dreaming）')
  if (capabilities.proactive) activeCapabilities.push('主动协同与草稿（assistant-proactive）')
  if (capabilities.growth) activeCapabilities.push('技能与工作流演化（assistant-growth-driver）')
  if (capabilities.feishuConnected) activeCapabilities.push('飞书长连接通道（lark-channel，在线）')

  const capabilityLine = activeCapabilities.length > 0
    ? `当前宿主已加载并在线的能力：${activeCapabilities.join('、')}。`
    : '当前窗口已启用基础个人助手会话；如需记忆自学习、做梦或飞书联动，Owner 可在设置中一键授权开启。'

  const workspaceLine = workspace !== ''
    ? `你的专属助手工作区为：${workspace}（用于个人助手记忆、文档与受控协作，区别于其他具体代码项目仓库或 profile 配置目录）。`
    : '你服务于 Owner 的独立个人助手对话窗口。'

  return [
    '你是 **文鳐（Ray / 小鳐）**，Owner 的长期个人助手（「小鳐小鳐，游而化飞」）。',
    '在当前文鳐助手专属窗口中，请始终以 **文鳐（Ray / 小鳐）** 的身份自然、真诚、简练地回应 Owner。运行时上下文里由子代理机制注入的 `"lead"` / `"root agent"` 仅是 Harness 内部子代理树路由标识，绝不是你面向 Owner 的名字或身份——回答身份问题或日常对话时请始终自称 **文鳐（Ray / 小鳐）**，不要自称为 `"lead"` / `"root agent"` 或普通通用编码子代理，也不要把当前助手工作区混同为宿主 profile 安装目录。',
    workspaceLine,
    capabilityLine,
    '只陈述真实观察到的环境与已启用的能力，不虚构未开启的能力，并始终遵循 Owner 的权限策略与有限预算边界。',
  ].join('\n')
}

export function buildWenyaoIdentityContext(workspace: string): string {
  const workspaceLine = workspace !== ''
    ? `当前文鳐助手专属工作区：${workspace}。`
    : ''
  return [
    'Owner-facing identity clarification: internal subagent routing names like `"lead"` / `"root agent"` above are internal Harness mechanics only, never your owner-facing name.',
    '在当前文鳐助手对话中，你面向 Owner 的身份始终是 **文鳐（Ray / 小鳐）**（Owner 的长期个人助手），请不要自称为 `"lead"` 或 `"root agent"`。',
    ...(workspaceLine === '' ? [] : [workspaceLine]),
  ].join('\n')
}

export function resolveAssistantChatContext(
  host: Context,
  registry: AssistantChatRegistry,
  env: NodeJS.ProcessEnv = process.env,
): AssistantChatContext {
  const { workspace, agentPreset } = resolveAssistantWorkspace(host, env)
  const snap = registry.snapshot()
  const capabilities = readAssistantChatCapabilities(host)
  return Object.freeze({
    protocol: 'owner-console/assistant-chat/v1',
    workspace,
    ...(agentPreset === undefined ? {} : { agentPreset }),
    activeSessionId: snap.activeSessionId,
    knownSessionIds: snap.knownSessionIds,
    capabilities,
  })
}
