import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isMap, isSeq, type YAMLMap } from 'yaml'
import type { OwnerConsoleConfig } from './index.js'
import { handleOwnerConsoleControlAction } from './autonomy-control.js'
import { formatOwnerConsoleVersionSummary, type OwnerSelfIterationAction } from './nl-control.js'
import {
  boundedConfig, configFacts, findEntry, hasControlChars, isAppId, isEntryId, isEnvName, isProjectBundle,
  isProjectPackage, isSecretRef, isSingleLineCommand,
  type AgentDefaultModelService, type BundleInfoLike, type ChangeResultLike, type LlmRuntimeService,
  type LoaderService, type PluginInfoLike, type PluginManagerService, type SettingsDescriptor,
  type SettingsPathOp, type SettingsService,
} from './settings.js'
import {
  INTAKE_AGREEMENT_LEVELS, INTAKE_AGREEMENT_OUTCOMES, LARK_CONNECTIONS, LARK_ERROR_CODES, OwnerConsoleIntakeAgreementSchema,
  OwnerConsoleTrendSnapshotsSchema, TREND_SNAPSHOT_PAGE_MAX,
  type CodingToolProbe, type IntakeAgreementAvailability, type OwnerConsoleAssistantOverview,
  type OwnerConsoleIntakeAgreement, type OwnerConsoleStatus, type OwnerConsoleTrendSnapshots, type OwnerConsoleWriteResult,
} from './typert.js'
import { componentState, missingRemedy, repairPatch } from './state.js'
import { persistAllowedBuilds, persistConfirmModulesPurgeDisabled } from './build-approvals.js'
import { reconcileProfilePnpmStore } from './pnpm-store.js'
import { CodingToolProber, discoverCodingToolBinary, type CodingToolId } from './probes.js'
import {
  applyAutonomyWizardSetup, atomicWritePatchWithBackup, findPatchRow, getPatchRowConfig,
  inspectAutonomyWizardStatus, readPatchDocument, resolveProfilePaths,
} from './autonomy-setup.js'
import { detectFrozenSystemdProfile, SelfUpgradeProber } from './upgrade-probe.js'
import type {
  AssistantChatContext, AssistantVersionReport, AutonomyBudgetLimits, AutonomyBudgetTier, AutonomySetupAction,
  AutonomySetupStatus, FeishuQrOnboardingSnapshot, OwnerConsoleControlActionResult, OwnerConsoleGrowthReport,
  OwnerConsoleModelCatalog, SelfUpgradePreview, SelfUpgradeStatus, SetupDoctorReport,
} from './typert.js'
import { collectOwnerConsoleVersionInfo } from './version-info.js'
import { readOwnerConsoleGrowthReport } from './growth-report.js'
import {
  applyDoctorRepair, configureFeishuEasy, inspectSetupDoctor, PLACEHOLDER_LARK_APP_ID, triggerProfileRestart,
  type TriggerProfileRestartInput,
} from './doctor-repair.js'
import { FeishuQrOnboardingManager } from './feishu-qr-onboarding.js'
import { ModelCatalogReader } from './model-catalog.js'
import {
  AssistantChatRegistry, buildWenyaoIdentityContext, buildWenyaoSystemPrompt, readAssistantChatCapabilities,
  resolveAssistantChatContext, resolveAssistantWorkspace,
} from './assistant-chat.js'
import {
  executeAttentionQuestionReply, executeDreamingIdeaAction, executeProactiveDraftAction,
  readAssistantOverview, type DreamingIdeaAction,
} from './autonomy-readers.js'

/** Companions worth surfacing; a missing one is a setup hint, never a hard failure. */
const DEPENDENCIES = ['assistantPolicy', 'assistantDelivery', 'assistantSkills'] as const
const LARK = /(^|[-_/])lark(-channel)?($|[-_/])/u
const TRAEX = /traex/iu
const DEFAULT_MODEL_NS = /^(?:agent[-_]?default[-_]?model|default[-_]?model)$/iu
const PROVIDER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const APP_ID_ENV = ['LARK_APP_ID', 'FEISHU_APP_ID'] as const
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

export interface OwnerConsoleServiceDeps {
  readonly reconcileStore?: (dir: string, manager: unknown) => Promise<boolean>
}

export { reconcileProfilePnpmStore, type ReconcileProfilePnpmStoreOptions } from './pnpm-store.js'

/** Read-only status plus owner-clicked, one-step writes through the Host settings service.
 * Only `.volatile()` config fields are editable by that service; every write addresses one
 * entry, uses CAS on its revision, and returns a business reason instead of throwing. */
export class OwnerConsoleService extends TypertRemoteService {
  private readonly host: Context
  private readonly prober: CodingToolProber
  private readonly upgradeProber: SelfUpgradeProber
  private readonly catalogReader: ModelCatalogReader
  private readonly assistantChat: AssistantChatRegistry
  private readonly feishuQr: FeishuQrOnboardingManager
  private readonly restartProfileFn: (input: TriggerProfileRestartInput) => Promise<OwnerConsoleWriteResult>
  private readonly reconcileStoreFn: (dir: string, manager: unknown) => Promise<boolean>

  constructor(
    ctx: Context,
    private readonly config: OwnerConsoleConfig,
    prober: CodingToolProber = new CodingToolProber(),
    upgradeProber: SelfUpgradeProber = new SelfUpgradeProber(),
    catalogReader: ModelCatalogReader = new ModelCatalogReader(),
    assistantChat: AssistantChatRegistry = new AssistantChatRegistry(ctx),
    feishuQr: FeishuQrOnboardingManager = new FeishuQrOnboardingManager(),
    restartProfileFn: (input: TriggerProfileRestartInput) => Promise<OwnerConsoleWriteResult> = triggerProfileRestart,
    deps: OwnerConsoleServiceDeps = {},
  ) {
    super(ctx, 'ownerConsole')
    this.host = ctx
    this.prober = prober
    this.upgradeProber = upgradeProber
    this.catalogReader = catalogReader
    this.assistantChat = assistantChat
    this.feishuQr = feishuQr
    this.restartProfileFn = restartProfileFn
    this.reconcileStoreFn = deps.reconcileStore ?? reconcileProfilePnpmStore
    this.installAssistantPromptScope()
    this.installSelfIterationControlTool()
    this.installVersionInfoTool()
    this.installModelCatalogInvalidation()
    this.installFeishuQrDisposal()
  }

  private isAuthorizedOwnerAgent(agent: unknown): boolean {
    if (this.resolveWenyaoSessionId(agent) !== '') return true
    const delivery = this.host.get('assistantDelivery' as never) as { canRequestRestart?: (agent: unknown) => boolean } | undefined
    try {
      if (typeof delivery?.canRequestRestart === 'function' && delivery.canRequestRestart(agent) === true) {
        return true
      }
    } catch {
      // Ignore delivery inspection failure.
    }
    return false
  }

  private installSelfIterationControlTool(): void {
    try {
      this.host.inject(['tools' as never], (toolCtx: unknown) => {
        const tools = (toolCtx as { tools?: { register?: (def: unknown, opts?: unknown) => () => void } }).tools
        if (typeof tools?.register !== 'function') return () => {}
        const toolDef = defineTool({
          name: 'owner_console_self_iteration_control',
          description: 'Owner-authorized overall assistant self-iteration control (enableSelfIteration, disableSelfIteration, or upgradeAssistantAndRecover).',
          parameters: {
            action: {
              type: 'string',
              enum: ['enableSelfIteration', 'disableSelfIteration', 'upgradeAssistantAndRecover'],
              required: true,
            },
            confirmDshHomeStopped: { type: 'boolean' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                action: { type: 'string' },
                state: { type: 'string' },
                healthy: { type: 'boolean' },
                error: { type: 'string' },
                reason: { type: 'string' },
                note: { type: 'string' },
              },
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            const authorized = this.isAuthorizedOwnerAgent(exec.agent)
            const res = await handleOwnerConsoleControlAction(this.host, {
              ownerAuthorized: authorized,
              action: args.action,
              ...(args.confirmDshHomeStopped === undefined ? {} : { confirmDshHomeStopped: args.confirmDshHomeStopped }),
            })
            if (res.ok) this.catalogReader.invalidate()
            return {
              ok: res.ok,
              ...(res.action === undefined ? {} : { action: res.action }),
              ...(res.state === undefined ? {} : { state: res.state }),
              ...(res.healthy === undefined ? {} : { healthy: res.healthy }),
              ...(res.error === undefined ? {} : { error: res.error }),
              ...(res.reason === undefined ? {} : { reason: res.reason }),
              ...(res.note === undefined ? {} : { note: res.note }),
            }
          },
        })
        const disposers: Array<() => void> = []
        const disposeTool = tools.register(toolDef, {
          when: (activation: { agent?: unknown }) => this.isAuthorizedOwnerAgent(activation.agent),
        })
        if (typeof disposeTool === 'function') disposers.push(disposeTool)
        const policy = (toolCtx as {
          assistantPolicy?: {
            registerPreauthorizedTool?: (ctx: unknown, def: unknown, predicate: (exec: { agent?: unknown }) => boolean, opts?: unknown) => () => void
          }
        }).assistantPolicy
        if (typeof policy?.registerPreauthorizedTool === 'function') {
          try {
            const disposePolicy = policy.registerPreauthorizedTool(
              toolCtx,
              toolDef,
              (execution: { agent?: unknown }) => this.isAuthorizedOwnerAgent(execution.agent),
              { denialReason: 'owner-console: self-iteration control requires an authorized owner session' },
            )
            if (typeof disposePolicy === 'function') disposers.push(disposePolicy)
          } catch {
            // assistantPolicy preauthorization is optional when policy service is absent.
          }
        }
        return () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try { dispose() } catch { /* ignore */ }
          }
        }
      })
    } catch {
      // Ignore if test Context stub lacks inject(); Host runtime always supplies it.
    }
  }

  private installVersionInfoTool(): void {
    try {
      this.host.inject(['tools' as never], (toolCtx: unknown) => {
        const tools = (toolCtx as { tools?: { register?: (def: unknown, opts?: unknown) => () => void } }).tools
        if (typeof tools?.register !== 'function') return () => {}
        const toolDef = defineTool({
          name: 'owner_console_version_info',
          description: 'Read-only query returning assistant version, DSH Host version, installed core/evolved plugins, and self-iteration statistics.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                error: { type: 'string' },
                summary: { type: 'string' },
                report: { type: 'object', additionalProperties: true },
              },
            },
            render: (_args, value) => [{
              type: 'text',
              text: typeof value.summary === 'string' ? value.summary : JSON.stringify(value),
            }],
          },
          execute: async (_args, exec) => {
            if (!this.isAuthorizedOwnerAgent(exec.agent)) {
              return {
                ok: false,
                error: 'owner-console: version info requires an authorized owner session',
              }
            }
            const report = await this.versionInfo()
            return {
              ok: true,
              report: JSON.parse(JSON.stringify(report)) as Record<string, never>,
              summary: formatOwnerConsoleVersionSummary(report),
            }
          },
        })
        const disposers: Array<() => void> = []
        const disposeTool = tools.register(toolDef, {
          when: (activation: { agent?: unknown }) => this.isAuthorizedOwnerAgent(activation.agent),
        })
        if (typeof disposeTool === 'function') disposers.push(disposeTool)
        const policy = (toolCtx as {
          assistantPolicy?: {
            registerPreauthorizedTool?: (ctx: unknown, def: unknown, predicate: (exec: { agent?: unknown }) => boolean, opts?: unknown) => () => void
          }
        }).assistantPolicy
        if (typeof policy?.registerPreauthorizedTool === 'function') {
          try {
            const disposePolicy = policy.registerPreauthorizedTool(
              toolCtx,
              toolDef,
              (execution: { agent?: unknown }) => this.isAuthorizedOwnerAgent(execution.agent),
              { denialReason: 'owner-console: version info requires an authorized owner session' },
            )
            if (typeof disposePolicy === 'function') disposers.push(disposePolicy)
          } catch {
            // assistantPolicy preauthorization is optional when policy service is absent.
          }
        }
        return () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try { dispose() } catch { /* ignore */ }
          }
        }
      })
    } catch {
      // Ignore if test Context stub lacks inject(); Host runtime always supplies it.
    }
  }

  private installFeishuQrDisposal(): void {
    try {
      if (typeof (this.host as { effect?: unknown }).effect !== 'function') return
      this.host.effect(() => () => {
        this.feishuQr.dispose()
      }, 'owner-console.feishu-qr')
    } catch {
      // Ignore if test Context stub lacks effect(); Host runtime always supplies it.
    }
  }

  private installModelCatalogInvalidation(): void {
    try {
      if (typeof (this.host as { on?: unknown }).on !== 'function') return
      const invalidate = () => {
        this.catalogReader.invalidate()
      }
      this.host.on('llm/adapters-updated' as never, invalidate as never)
      this.host.on('llm/models-updated' as never, invalidate as never)
    } catch {
      // Ignore if test Context stub lacks on(); Host runtime always supplies it.
    }
  }

  private installAssistantPromptScope(): void {
    try {
      this.host.inject(['systemPrompt' as never], (promptCtx: unknown) => {
        const sp = (promptCtx as {
          systemPrompt?: {
            section?: (def: unknown) => () => void
            context?: (def: unknown) => () => void
          }
        }).systemPrompt
        const text = (arg: unknown) => {
          const agent = arg !== null && typeof arg === 'object' ? (arg as { agent?: unknown }).agent : undefined
          return this.wenyaoPromptForAgent(agent)
        }
        const contextText = (arg: unknown) => {
          const agent = arg !== null && typeof arg === 'object' ? (arg as { agent?: unknown }).agent : undefined
          return this.wenyaoIdentityContextForAgent(agent)
        }
        const disposers: Array<() => void> = []
        const disposeAll = () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try {
              dispose()
            } catch {
              // Best-effort cleanup of prompt registrations.
            }
          }
        }
        if (sp === undefined) return disposeAll
        const hasSection = typeof sp.section === 'function'
        try {
          if (typeof sp.section === 'function') {
            const dispose = sp.section({
              name: 'owner-console:wenyao-persona',
              order: 10,
              interpolate: false,
              text,
            })
            if (typeof dispose === 'function') disposers.push(dispose)
          }
          if (typeof sp.context === 'function') {
            const dispose = sp.context(hasSection
              ? {
                name: 'owner-console:wenyao-identity-context',
                order: 130,
                interpolate: false,
                required: true,
                text: contextText,
              }
              : {
                name: 'owner-console:wenyao-persona',
                order: 130,
                interpolate: false,
                required: true,
                text,
              })
            if (typeof dispose === 'function') disposers.push(dispose)
          }
        } catch (error: unknown) {
          disposeAll()
          throw error
        }
        return disposeAll
      })
    } catch {
      // Ignore if test Context stub lacks inject(); Host runtime always supplies it.
    }
  }

  private resolveWenyaoSessionId(agent: unknown): string {
    if (agent === null || typeof agent !== 'object') return ''
    const rec = agent as { id?: unknown; session?: { id?: unknown } }
    const sessionId = typeof rec.session?.id === 'string' && rec.session.id !== ''
      ? rec.session.id
      : typeof rec.id === 'string' && rec.id !== ''
        ? rec.id
        : ''
    if (sessionId === '' || !this.assistantChat.hasSession(sessionId)) return ''
    return sessionId
  }

  private wenyaoPromptForAgent(agent: unknown): string {
    if (this.resolveWenyaoSessionId(agent) === '') return ''
    const { workspace } = resolveAssistantWorkspace(this.host)
    return buildWenyaoSystemPrompt(workspace, readAssistantChatCapabilities(this.host))
  }

  private wenyaoIdentityContextForAgent(agent: unknown): string {
    if (this.resolveWenyaoSessionId(agent) === '') return ''
    const { workspace } = resolveAssistantWorkspace(this.host)
    return buildWenyaoIdentityContext(workspace)
  }

  private settings(): SettingsService {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    if (settings === undefined) throw new Error('Host settings service is unavailable; this console cannot edit configuration')
    return settings
  }

  /** Host-supplied profile directory; only the `allowBuilds` fallback writes there. */
  private profileDirectory(): string | undefined {
    const profile = this.host.get('profileContext' as never) as { dir?: unknown } | undefined
    return typeof profile?.dir === 'string' && profile.dir !== '' ? profile.dir : undefined
  }

  private descriptors(): readonly SettingsDescriptor[] {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    return settings?.describe({ redactSecrets: true }) ?? []
  }

  /** Volatile edits update the running fiber references but never re-run apply.
   * A one-step write therefore restarts just this entry with its persisted raw
   * config. `fiber.update()` is synchronous while the restart is not, so the note
   * only claims a reload when the entry is active again in a fresh `describe()`;
   * anything else says a restart is needed. This never throws. */
  private async reload(entryId: string): Promise<string> {
    const loader = this.host.get('loader' as never) as LoaderService | undefined
    if (loader === undefined) return '；已保存，但 loader 不可用，重启 profile 后生效'
    try {
      const entry = [...loader.entries()].find(candidate => candidate.options.id === entryId || candidate.id === entryId)
      if (entry === undefined) return '；已保存，但未找到该 profile 条目，重启 profile 后生效'
      if (entry.fiber === undefined) await entry.refresh()
      else entry.fiber.update(entry.options.config, true)
      return this.descriptors().some(descriptor => descriptor.ns === entryId)
        ? '；条目已重新加载'
        : '；已保存，但未能确认条目已恢复加载；如未生效请重启 profile'
    } catch {
      return '；已保存，但自动重载失败，请重启 profile 后生效'
    }
  }

  /** Why a card's write target is not active, in the panel's own terms. It reports the observed
   * fiber phase/diagnostic, the missing companion services and a minimal patch repair instead of
   * the generic "not installed" refusal that hides a failed or pending load. */
  private async targetRefusal(entry: string, packageName: string, label: string): Promise<OwnerConsoleWriteResult> {
    const state = componentState(await this.status(), packageName)
    const diagnostic = state.entry?.diagnostic === undefined ? '' : `：${boundedText(state.entry.diagnostic, 300)}`
    const bundleError = state.error === undefined ? '' : `；Host 记录错误 ${state.error.code}`
    const missing = missingRemedy(state)
    const repair = state.stalled
      ? ` 可用以下最小 patch 临时停用该行：${repairPatch(state, packageName)}` : ''
    const note = state.kind === 'absent'
      ? `${label} 未安装；请先在面板安装 ${packageName}，再配置`
      : state.kind === 'active'
        ? `${label} 已加载，但没有声明任何可实时修改的配置字段`
        : state.kind === 'disabled'
        ? `${label} 已安装但未启用；请先点“启用”，等条目加载后再配置`
        : state.kind === 'unavailable' || state.kind === 'unreadable'
          ? `${label} 状态不可读：${state.label}${diagnostic}`
          : `${label} 已启用但未加载（${state.entry?.fiberPhase ?? '无 Loader 条目'}${bundleError}）${diagnostic}。`
            + `${missing === '' ? '' : `${missing}。`}修复后重启 profile 再配置。${repair}`
    return refuse(entry, note)
  }

  /** Read the keychain handles only when the provider exposes them; a provider that cannot list
   * (or throws) fails soft, and the write proceeds with a note that existence was not verified. */
  private keychainHandles(): readonly string[] | undefined {
    const keychain = this.host.get('credentialsKeychain' as never) as
      | Readonly<{ listHandles?: () => readonly Readonly<{ id?: unknown }>[] }> | undefined
    try {
      if (typeof keychain?.listHandles !== 'function') return undefined
      const handles = keychain.listHandles()
      return Array.isArray(handles)
        ? handles.flatMap(handle => typeof handle?.id === 'string' ? [handle.id] : [])
        : undefined
    } catch {
      return undefined
    }
  }

  private manager(): PluginManagerService {
    const manager = this.host.get('pluginManager' as never) as PluginManagerService | undefined
    if (manager === undefined) throw new Error('Host plugin manager is unavailable; this console cannot manage bundles')
    return manager
  }

  /** One inventory read, with each list isolated: a rejecting list is reported instead of making the
   * whole status (or the other list) fail, and an absent service is not the same fact as "nothing installed". */
  private async inventory(): Promise<Readonly<{
    bundles: readonly BundleInfoLike[], plugins: readonly PluginInfoLike[],
    phases: Readonly<{ bundles: 'ok' | 'unavailable' | 'failed', plugins: 'ok' | 'unavailable' | 'failed' }>,
    diagnostic?: string,
  }>> {
    const manager = this.host.get('pluginManager' as never) as PluginManagerService | undefined
    if (manager === undefined) {
      return Object.freeze({ bundles: Object.freeze([]), plugins: Object.freeze([]),
        phases: Object.freeze({ bundles: 'unavailable' as const, plugins: 'unavailable' as const }) })
    }
    const [listedBundles, listedPlugins] = await Promise.allSettled([manager.listBundles(), manager.listPlugins()])
    const phases = Object.freeze({
      bundles: listedBundles.status === 'fulfilled' ? 'ok' as const : 'failed' as const,
      plugins: listedPlugins.status === 'fulfilled' ? 'ok' as const : 'failed' as const,
    })
    const rejected = [listedBundles, listedPlugins].find(result => result.status === 'rejected')
    return Object.freeze({
      // A dependency row without a bundle patch (`not-bundle`) is not manageable here; every other
      // ManagementError stays visible so an incompatible installed bundle is never reported as absent.
      bundles: Object.freeze(listedBundles.status === 'fulfilled'
        ? listedBundles.value.filter(bundle => isProjectPackage(bundle.name) && bundle.error?.code !== 'not-bundle')
        : []),
      plugins: Object.freeze(listedPlugins.status === 'fulfilled'
        ? listedPlugins.value.filter(plugin => isProjectPackage(plugin.moduleName))
        : []),
      phases,
      ...(rejected === undefined
        ? {}
        : { diagnostic: boundedText(rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason), 1_024) }),
    })
  }

  private registeredLlmProviders(): readonly Readonly<{ id: string; name: string }>[] {
    const llm = this.host.get('llm' as never) as LlmRuntimeService | undefined
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return Object.freeze([])
    try {
      const rows = llm.listProviders()
      if (!Array.isArray(rows)) return Object.freeze([])
      return Object.freeze(rows.flatMap(provider => typeof provider?.id === 'string' && provider.id.trim() !== ''
        ? [Object.freeze({
          id: provider.id,
          name: typeof provider.name === 'string' && provider.name.trim() !== '' ? provider.name : provider.id,
        })]
        : []))
    } catch {
      return Object.freeze([])
    }
  }

  private defaultModelEntry(entries: readonly SettingsDescriptor[]): SettingsDescriptor | undefined {
    const direct = findEntry(entries, ns => DEFAULT_MODEL_NS.test(ns))
    if (direct !== undefined) return direct
    const loader = this.host.get('loader' as never) as Partial<LoaderService> | undefined
    if (typeof loader?.entries !== 'function') return undefined
    try {
      for (const entry of loader.entries()) {
        if (entry.options.name === '@deepseek-ai/dsh-agent-default-model') {
          const found = findEntry(entries, ns => ns === entry.options.id)
          if (found !== undefined) return found
        }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /** Fallback read for lark-channel config when the plugin is pending/disabled and absent from `settings.describe()`. */
  private persistedLarkConfig(): Readonly<Record<string, unknown>> {
    let loaderCfg: Readonly<Record<string, unknown>> = {}
    try {
      const loader = this.host.get('loader' as never) as Partial<LoaderService> | undefined
      if (typeof loader?.entries === 'function') {
        for (const entry of loader.entries()) {
          if (entry.options.name === '@dsh-ray/lark-channel' || LARK.test(entry.options.id)) {
            loaderCfg = configFacts(entry.options.config)
            break
          }
        }
      }
    } catch {
      // Ignore loader inspection failure.
    }
    let patchCfg: Readonly<Record<string, unknown>> = {}
    try {
      const paths = resolveProfilePaths(this.host, process.env)
      if (paths.patchExists && paths.patchPath !== null) {
        const doc = readPatchDocument(paths.patchPath)
        if (isSeq(doc.contents)) {
          const rawPatch = getPatchRowConfig(doc.contents, 'dsh-ray-lark-channel', doc)
          if (Object.keys(rawPatch).length > 0) patchCfg = configFacts(rawPatch)
        }
      }
    } catch {
      // Unreadable patch file falls back to loader inspection / defaults.
    }
    if (Object.keys(loaderCfg).length === 0 && Object.keys(patchCfg).length === 0) return Object.freeze({})
    return Object.freeze({ ...loaderCfg, ...patchCfg })
  }

  private clearPatchRowDisabled(packageName: string): boolean {
    try {
      const paths = resolveProfilePaths(this.host, process.env)
      if (!paths.writable || !paths.patchExists || paths.patchPath === null) return false
      if (detectFrozenSystemdProfile(paths.dshHome, paths.profileName, process.platform, process.env)) return false
      const doc = readPatchDocument(paths.patchPath)
      if (!isSeq(doc.contents)) return false
      const rowId = `dsh-ray-${packageName.replace(/^@dsh-ray\//u, '')}`
      const candidates: YAMLMap[] = []
      const direct = findPatchRow(doc.contents, rowId)
      if (direct !== undefined) candidates.push(direct)
      for (const item of doc.contents.items) {
        if (!isMap(item)) continue
        if (item.get('name') === packageName && !candidates.includes(item)) candidates.push(item)
        const inserted = item.get('insert', true)
        if (isSeq(inserted)) {
          for (const sub of inserted.items) {
            if (isMap(sub) && sub.get('name') === packageName && !candidates.includes(sub)) candidates.push(sub)
          }
        }
      }
      let cleared = false
      for (const row of candidates) {
        if (row.get('disabled') === true) {
          row.delete('disabled')
          cleared = true
        }
      }
      if (!cleared) return false
      atomicWritePatchWithBackup(paths.patchPath, doc.toString({ lineWidth: 0 }), Date.now())
      return true
    } catch {
      return false
    }
  }

  async status(): Promise<OwnerConsoleStatus> {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    const entries = settings?.describe({ redactSecrets: true }) ?? []
    const inventory = await this.inventory()
    const lark = findEntry(entries, ns => LARK.test(ns))
    const traex = findEntry(entries, ns => TRAEX.test(ns))
    const defaultModelEntry = this.defaultModelEntry(entries)
    const larkValue = lark === undefined ? this.persistedLarkConfig() : configFacts(lark.value)
    const traexValue = configFacts(traex?.value)
    const defaultModelService = this.host.get('agentDefaultModel' as never) as AgentDefaultModelService | undefined
    let defaultSelection: Readonly<{ provider: string; model: string; reasoningEffort?: string }> | undefined
    try {
      if (typeof defaultModelService?.currentSelection === 'function') {
        defaultSelection = defaultModelService.currentSelection()
      }
    } catch {
      defaultSelection = undefined
    }
    const defaultModelFacts = configFacts(defaultModelEntry?.value)
    const defaultProvider = typeof defaultSelection?.provider === 'string'
      ? defaultSelection.provider
      : typeof defaultModelFacts['provider'] === 'string' ? defaultModelFacts['provider'] : ''
    const defaultModelId = typeof defaultSelection?.model === 'string'
      ? defaultSelection.model
      : typeof defaultModelFacts['model'] === 'string' ? defaultModelFacts['model'] : ''
    const defaultEffort = typeof defaultSelection?.reasoningEffort === 'string' && defaultSelection.reasoningEffort !== ''
      ? defaultSelection.reasoningEffort
      : typeof defaultModelFacts['reasoningEffort'] === 'string' && defaultModelFacts['reasoningEffort'] !== ''
        ? defaultModelFacts['reasoningEffort'] : undefined
    const installed = (name: string) => inventory.phases.bundles === 'ok'
      && inventory.bundles.some(bundle => bundle.name === name && bundle.installed)
    const larkHealth = readLarkHealth(this.host.get('larkChannel' as never))
    const traexInstalled = installed('@dsh-ray/traex-acp-provider')
    const activeLarkAppId = isAppId(larkValue['appId']) && larkValue['appId'] !== PLACEHOLDER_LARK_APP_ID
      ? (larkValue['appId'] as string)
      : undefined
    return Object.freeze({
      feishu: Object.freeze({
        ...(lark === undefined ? {} : { entry: lark.ns }),
        mode: larkValue['secretSource'] === 'handle'
          || (larkValue['secretSource'] === undefined && typeof larkValue['credentialHandle'] === 'string' && larkValue['credentialHandle'].trim() !== '')
          ? 'handle'
          : 'env',
        installed: installed('@dsh-ray/lark-channel'),
        enabled: larkValue['enabled'] === true,
        appIdConfigured: activeLarkAppId !== undefined,
        ...(activeLarkAppId === undefined ? {} : { appId: activeLarkAppId }),
        ...larkHealth,
      }),
      traex: Object.freeze({
        ...(traex === undefined ? {} : { entry: traex.ns }),
        installed: traexInstalled,
        enabled: traexValue['enabled'] === true,
        command: typeof traexValue['command'] === 'string' ? traexValue['command'] : '',
      }),
      agy: Object.freeze({
        ...(traex === undefined ? {} : { entry: traex.ns }),
        installed: traexInstalled,
        enabled: traexValue['agyEnabled'] === true,
        command: typeof traexValue['agyCommand'] === 'string' ? traexValue['agyCommand'] : '',
      }),
      defaultModel: Object.freeze({
        ...(defaultModelEntry === undefined ? {} : { entry: defaultModelEntry.ns }),
        available: defaultModelService !== undefined || defaultModelEntry !== undefined,
        provider: defaultProvider,
        model: defaultModelId,
        ...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
      }),
      llmProviders: this.registeredLlmProviders(),
      host: Object.freeze({
        settings: settings !== undefined,
        pluginManager: this.host.get('pluginManager' as never) !== undefined,
        bundles: inventory.phases.bundles,
        plugins: inventory.phases.plugins,
        ...(inventory.diagnostic === undefined ? {} : { diagnostic: inventory.diagnostic }),
      }),
      dependencies: Object.freeze(DEPENDENCIES.map(name => Object.freeze({
        name, available: this.host.get(name as never) !== undefined,
      }))),
      evaluation: Object.freeze({
        intakeAgreement: readIntakeAgreementAvailability(this.host.get('assistantEvaluation' as never),
          this.host.get('loader' as never)),
      }),
      bundles: Object.freeze(inventory.bundles.map(bundle => Object.freeze({
        name: bundle.name,
        ...(bundle.version === undefined ? {} : { version: bundle.version }),
        enabled: bundle.enabled,
        installed: bundle.installed,
        removable: bundle.removable,
        ...(bundle.error === undefined ? {} : { error: Object.freeze({
          code: bundle.error.code ?? 'operation-error',
          ...(bundle.error.diagnostic === undefined ? {} : { diagnostic: boundedText(bundle.error.diagnostic, 2_048) }),
        }) }),
        rows: Object.freeze((bundle.rows ?? []).slice(0, 32).map(row => Object.freeze({
          rowId: row.rowId,
          moduleName: row.moduleName,
          ...(row.entryId === undefined ? {} : { entryId: row.entryId }),
        }))),
      }))),
      plugins: Object.freeze(inventory.plugins.map(plugin => Object.freeze({
        entryId: plugin.entryId,
        moduleName: plugin.moduleName,
        enabled: plugin.enabled,
        fiberPhase: plugin.fiberPhase,
        ...(plugin.diagnostic === undefined ? {} : { diagnostic: boundedText(plugin.diagnostic, 4_096) }),
      }))),
    })
  }

  /** Read-only page of sealed ordinary-use trend snapshots from the control plane. It never seals,
   * so viewing cannot change the ledger; `planId: ''` lists every plan and `beforeSequence: 0` starts
   * at the newest row. Any refusal or tampered row is reported as `unverifiable`, never repaired. */
  async trendSnapshots(planId: string, beforeSequence: number, limit: number): Promise<OwnerConsoleTrendSnapshots> {
    return readTrendSnapshots(this.host.get('pluginControlPlane' as never), planId, beforeSequence, limit)
  }

  /** Read-only agreement between intake judgments and owner notification outcomes for one exact
   * Evaluation scope (workspace + preset), over Evaluation's default window. It never writes, adopts
   * or sends; a disabled switch is reported as `disabled`, any refusal or odd shape as `unverifiable`. */
  async intakeAgreement(workspace: string, preset: string): Promise<OwnerConsoleIntakeAgreement> {
    return readIntakeAgreement(this.host.get('assistantEvaluation' as never), workspace, preset)
  }

  /** Read-only newest-first history of Evaluation's durable intake/attention agreement snapshots.
   * Counts and windows only: no workspace, id, digest or message text crosses to the panel. */
  async intakeAgreementHistory(workspace: string, preset: string, limit = 20): Promise<OwnerConsoleIntakeAgreementHistory> {
    return readIntakeAgreementHistory(this.host.get('assistantEvaluation' as never), workspace, preset, limit)
  }

  /** Select or remove one installed project bundle layer; dependencies stay installed. */
  async setBundleEnabled(name: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    if (!isProjectPackage(name)) return refuse('', '只允许管理本项目的 @dsh-ray/* bundle')
    const manager = this.manager()
    const result = applyChange(await manager.setBundleEnabled(name, enabled))
    if (result.applied) {
      this.catalogReader.invalidate()
      if (enabled && this.clearPatchRowDisabled(name)) {
        return Object.freeze({
          ...result,
          note: `${result.note}；已同时清除 cordis.patch.yml 中的 disabled 覆盖，重启 profile 后生效`,
        })
      }
    }
    return result
  }

  /** Enable or disable one loaded entry of a project bundle. */
  async setPluginEnabled(entryId: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    const manager = this.manager()
    if (entryId.trim() === '') return refuse('', 'entryId 不能为空')
    const inventory = await this.inventory()
    const entry = inventory.plugins.find(plugin => plugin.entryId === entryId)
    if (entry === undefined) return refuse(entryId, '该条目不属于本项目的插件，或尚未安装')
    const result = applyChange(await manager.setPluginEnabled(entryId, enabled))
    if (result.applied) this.catalogReader.invalidate()
    return result
  }

  /** Remove one project bundle layer after the owner confirms the destructive step. */
  async removeProjectBundle(name: string): Promise<OwnerConsoleWriteResult> {
    if (!isProjectPackage(name)) return refuse('', '只允许移除本项目的 @dsh-ray/* bundle')
    const manager = this.manager()
    const dir = this.profileDirectory()
    const raw = await executeWithPnpmRecovery(dir, manager, this.reconcileStoreFn, () => manager.removeBundle(name))
    const result = applyChange(raw)
    if (result.applied) this.catalogReader.invalidate()
    return result
  }

  /** Install one project bundle with its declared dependencies, then activate it.
   * The Host's pnpm run can stop at its dependency build-script policy. The names the console
   * parsed from that failure are written to the profile's `allowBuilds` before the retry, then
   * the install runs once more without an approval flag. Writing first works even when the
   * Host's own ANSI parsing lost the names: pnpm sees a real allow decision instead of a
   * pending placeholder, so the Host never has to record or re-approve them. */
  async installProjectBundle(spec: string, approvedBuilds: readonly string[] = []): Promise<OwnerConsoleWriteResult> {
    const trimmed = spec.trim()
    if (!isProjectPackage(trimmed)) {
      return refuse('', '只允许安装本项目的 @dsh-ray/<name> 包；本地路径和 git 地址不在此面板处理')
    }
    const approvals = [...new Set(approvedBuilds.map(name => name.trim()))]
    if (approvedBuilds.length > MAX_BUILD_NAMES
      || approvals.some(name => name === '' || name.length > 200 || /[*?\r\n]/u.test(name))) {
      return refuse(trimmed, '批准的构建脚本名称无效')
    }
    const manager = this.manager()
    const dir = this.profileDirectory()
    if (approvals.length > 0 && dir === undefined) {
      return rejectStaleApproval(trimmed, approvals)
    }
    if (approvals.length > 0 && dir !== undefined) {
      try {
        await persistAllowedBuilds(dir, approvals)
      } catch (cause) {
        return refuse(trimmed, `写入 allowBuilds 失败：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    if (dir !== undefined && existsSync(dir)) {
      // Non-TTY Electron/daemon bundle installs invoke pnpm without stdin TTY; disable interactive modules-purge prompt safely.
      await persistConfirmModulesPurgeDisabled(dir).catch(() => false)
    }
    const raw = await executeWithPnpmRecovery(
      dir,
      manager,
      this.reconcileStoreFn,
      () => manager.installBundle(trimmed, { enabled: true, saveExact: true }),
    )
    const result = applyInstall(raw, dir)
    if (result.applied) this.catalogReader.invalidate()
    return result
  }

  /** Feishu: one owner click, two ways to pair the bot. No plaintext secret is ever accepted. */
  async configureFeishu(appId: string, appSecretEnv: string, credentialHandle: string,
    account: string, tenant: string, discoverAppId: boolean): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const lark = findEntry(this.descriptors(), ns => LARK.test(ns))
    if (lark === undefined) {
      return await this.targetRefusal('dsh-ray-lark-channel', '@dsh-ray/lark-channel', 'lark-channel')
    }
    const current = configFacts(lark.value)
    const configured = isAppId(this.config.feishuAppId) ? this.config.feishuAppId : undefined
    const discovered = appId.trim() === '' && discoverAppId
      ? APP_ID_ENV.map(name => process.env[name]).find(value => isAppId(value)) ?? configured
      : undefined
    const resolvedAppId = appId.trim() === '' ? discovered : appId.trim()
    if (!isAppId(resolvedAppId)) {
      return refuse(lark.ns, discoverAppId
        ? '一键模式需要 Host 环境中的 LARK_APP_ID 或 FEISHU_APP_ID；否则请填写 appId'
        : 'appId 必须形如 cli_0123456789abcdef')
    }
    const envName = appSecretEnv.trim()
    const handle = credentialHandle.trim()
    if ((envName === '') === (handle === '')) {
      return refuse(lark.ns, 'secret 引用必须二选一：环境变量名或 keychain handle')
    }
    if (envName !== '' && !isEnvName(envName)) return refuse(lark.ns, 'appSecretEnv 必须是环境变量名')
    if (handle !== '' && !isSecretRef(handle)) return refuse(lark.ns, 'credentialHandle 格式无效')
    if (envName !== '' && process.env[envName] === undefined) {
      return refuse(lark.ns, `Host 进程中不存在环境变量 ${envName}；请先设置它，或改用 keychain handle`)
    }
    let keychainVerified = true
    if (handle !== '') {
      if (this.host.get('credentialsKeychain' as never) === undefined) {
        return refuse(lark.ns, 'credentials-keychain 未加载；无法引用 keychain secret')
      }
      const handles = this.keychainHandles()
      keychainVerified = handles !== undefined
      if (handles !== undefined && !handles.includes(handle)) {
        const known = handles.length === 0 ? '当前没有任何 handle' : `现有：${handles.slice(0, 8).join('、')}`
        return refuse(lark.ns, `credentials keychain 中没有 handle "${handle}"（${known}）；请先在 keychain 创建它，或改用环境变量引用`)
      }
    }
    const resolvedAccount = account.trim() === '' ? current['account'] : account.trim()
    const resolvedTenant = tenant.trim() === '' ? current['tenant'] : tenant.trim()
    if (typeof resolvedAccount !== 'string' || !ACCOUNT.test(resolvedAccount)) {
      return refuse(lark.ns, 'account 缺失或格式无效；请填写当前 owner 的 account，避免更换身份')
    }
    if (typeof resolvedTenant !== 'string' || !ACCOUNT.test(resolvedTenant)) {
      return refuse(lark.ns, 'tenant 缺失或格式无效；请填写当前 owner 的 tenant，避免更换身份')
    }
    try {
      await settings.mutate(lark.ns, [
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['appId'], value: resolvedAppId },
        { op: 'set', path: ['account'], value: resolvedAccount },
        { op: 'set', path: ['tenant'], value: resolvedTenant },
        envName === '' ? { op: 'unset', path: ['appSecretEnv'] } : { op: 'set', path: ['appSecretEnv'], value: envName },
        { op: 'set', path: ['secretSource'], value: handle === '' ? 'env' : 'handle' },
        handle === '' ? { op: 'unset', path: ['credentialHandle'] } : { op: 'set', path: ['credentialHandle'], value: handle },
      ], lark.revision)
    } catch (cause) {
      return writeFailure(lark.ns, cause)
    }
    const reloaded = await this.reload(lark.ns)
    const unchecked = handle !== '' && !keychainVerified ? '（未能校验 keychain handle 是否存在）' : ''
    return Object.freeze({ applied: true, entry: lark.ns,
      note: (handle === '' ? `secret 来自环境变量 ${envName}` : 'secret 保留在 credentials keychain') + unchecked + reloaded })
  }

  /** TraeX: one owner click toggles the local provider row; command is optional. */
  async configureTraex(enabled: boolean, command: string): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const traex = findEntry(this.descriptors(), ns => TRAEX.test(ns))
    if (traex === undefined) {
      return await this.targetRefusal('dsh-ray-traex-acp-provider', '@dsh-ray/traex-acp-provider', 'traex-acp-provider')
    }
    const value = command.trim()
    if (value !== '' && (value.length > 1_024 || /[\r\n]/u.test(value))) {
      return refuse(traex.ns, 'command 必须是单行且不超过 1024 字符')
    }
    const ops: SettingsPathOp[] = [{ op: 'set', path: ['enabled'], value: enabled }]
    if (value !== '') ops.push({ op: 'set', path: ['command'], value })
    try {
      await settings.mutate(traex.ns, ops, traex.revision)
    } catch (cause) {
      return writeFailure(traex.ns, cause)
    }
    const reloaded = await this.reload(traex.ns)
    this.catalogReader.invalidate()
    return Object.freeze({ applied: true, entry: traex.ns, note: (enabled ? 'TraeX 行已启用' : 'TraeX 行已停用') + reloaded })
  }

  /** Project bundles only: merge one bounded JSON object into fields the entry exposes live. */
  async configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    if (!isEntryId(entry) || !isProjectBundle(entry)) {
      return refuse('', '只允许修改本项目的 dsh-ray 条目')
    }
    const target = findEntry(this.descriptors(), ns => ns === entry)
    if (target === undefined) {
      const status = await this.status()
      const packageName = status.bundles.find(bundle => bundle.rows.some(row => row.rowId === entry))?.name
        ?? entry.replace(/^dsh-ray-/u, '@dsh-ray/')
      return await this.targetRefusal(entry, packageName, entry)
    }
    let patch: Readonly<Record<string, unknown>>
    try {
      patch = boundedConfig(config)
    } catch (cause) {
      return refuse(entry, cause instanceof Error ? cause.message : '配置无效')
    }
    const ops: SettingsPathOp[] = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
    if (ops.length === 0) return refuse(entry, '配置为空，没有可写入的字段')
    try {
      await settings.mutate(entry, ops, target.revision)
    } catch (cause) {
      return writeFailure(entry, cause)
    }
    const reloaded = await this.reload(entry)
    this.catalogReader.invalidate()
    return Object.freeze({ applied: true, entry, note: '已合并写入' + reloaded })
  }

  /** Antigravity (agy): toggle the local ACP route and optional binary path via volatile fields. */
  async configureAgy(enabled: boolean, command: string): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const traex = findEntry(this.descriptors(), ns => TRAEX.test(ns))
    if (traex === undefined) {
      return await this.targetRefusal('dsh-ray-traex-acp-provider', '@dsh-ray/traex-acp-provider', 'traex-acp-provider')
    }
    const value = command.trim()
    if (value !== '' && !isSingleLineCommand(value)) {
      return refuse(traex.ns, 'command 必须是单行且不超过 1024 字符（不含控制字符）')
    }
    const ops: SettingsPathOp[] = [{ op: 'set', path: ['agyEnabled'], value: enabled }]
    if (value !== '') ops.push({ op: 'set', path: ['agyCommand'], value })
    try {
      await settings.mutate(traex.ns, ops, traex.revision)
    } catch (cause) {
      return writeFailure(traex.ns, cause)
    }
    const reloaded = await this.reload(traex.ns)
    this.catalogReader.invalidate()
    return Object.freeze({
      applied: true,
      entry: traex.ns,
      note: (enabled ? 'Antigravity (agy) 路由已启用' : 'Antigravity (agy) 路由已停用') + reloaded,
    })
  }

  /** Safe read-only binary + auth probe for TraeX or Antigravity (zero LLM prompt calls). */
  async probeCodingTool(tool: CodingToolId, command: string, force: boolean): Promise<CodingToolProbe> {
    const snapshot = await this.status()
    const routeId = tool === 'traex' ? 'traex-agent' : 'agy-agent'
    const current = tool === 'traex' ? snapshot.traex : snapshot.agy
    const effectiveCommand = command.trim() !== '' ? command.trim() : current.command
    const routeRegistered = snapshot.llmProviders.some(provider => provider.id === routeId)
    const { dshHome } = resolveProfilePaths(this.host, process.env)
    return this.prober.probe(tool, {
      command: effectiveCommand,
      installed: current.installed,
      enabled: current.enabled,
      routeRegistered,
      dshHome,
    }, force)
  }

  /** Switch `agent-default-model`; when choosing an ACP coding route, enable and pin discovered path if inactive/unpinned. */
  async setDefaultModelRoute(provider: string, model: string, reasoningEffort: string): Promise<OwnerConsoleWriteResult> {
    const cleanProvider = provider.trim()
    const cleanModel = model.trim() === '' ? 'default' : model.trim()
    const cleanEffort = reasoningEffort.trim()
    if (!PROVIDER_TOKEN.test(cleanProvider)) {
      return refuse('agent-default-model', 'provider 格式无效')
    }
    if (cleanModel.length > 256 || hasControlChars(cleanModel)) {
      return refuse('agent-default-model', 'model 格式无效')
    }
    if (cleanEffort !== '' && (cleanEffort.length > 128 || hasControlChars(cleanEffort))) {
      return refuse('agent-default-model', 'reasoningEffort 格式无效')
    }

    let extraNote = ''
    if (cleanProvider === 'traex-agent' || cleanProvider === 'agy-agent') {
      const descriptors = this.descriptors()
      const traex = findEntry(descriptors, ns => TRAEX.test(ns))
      if (traex === undefined) {
        return await this.targetRefusal('dsh-ray-traex-acp-provider', '@dsh-ray/traex-acp-provider', 'traex-acp-provider')
      }
      const facts = configFacts(traex.value)
      const tool: CodingToolId = cleanProvider === 'traex-agent' ? 'traex' : 'agy'
      const enableKey = tool === 'traex' ? 'enabled' : 'agyEnabled'
      const cmdKey = tool === 'traex' ? 'command' : 'agyCommand'
      const ops: SettingsPathOp[] = []
      if (facts[enableKey] !== true) ops.push({ op: 'set', path: [enableKey], value: true })
      const rawCmd = typeof facts[cmdKey] === 'string' ? (facts[cmdKey] as string).trim() : ''
      if (rawCmd === '' || rawCmd === tool) {
        const { dshHome } = resolveProfilePaths(this.host, process.env)
        const discovered = discoverCodingToolBinary(tool, { dshHome })
        if (discovered !== undefined && discovered !== rawCmd) {
          ops.push({ op: 'set', path: [cmdKey], value: discovered })
        }
      }
      if (ops.length > 0) {
        const settings = this.settings()
        try {
          await settings.mutate(traex.ns, ops, traex.revision)
          const reloaded = await this.reload(traex.ns)
          extraNote = `（已同步启用并绑定 ${cleanProvider}${reloaded}）`
        } catch (cause) {
          return writeFailure(traex.ns, cause)
        }
      }
    }

    const descriptors = this.descriptors()
    const target = this.defaultModelEntry(descriptors)
    const defaultModelService = this.host.get('agentDefaultModel' as never) as AgentDefaultModelService | undefined
    if (target !== undefined) {
      const settings = this.settings()
      const ops: SettingsPathOp[] = [
        { op: 'set', path: ['provider'], value: cleanProvider },
        { op: 'set', path: ['model'], value: cleanModel },
        cleanEffort === ''
          ? { op: 'unset', path: ['reasoningEffort'] }
          : { op: 'set', path: ['reasoningEffort'], value: cleanEffort },
      ]
      try {
        await settings.mutate(target.ns, ops, target.revision)
      } catch (cause) {
        return writeFailure(target.ns, cause)
      }
      this.catalogReader.invalidate()
      return Object.freeze({
        applied: true,
        entry: target.ns,
        note: `默认模型已切换为 ${cleanProvider} / ${cleanModel}${cleanEffort === '' ? '' : `（${cleanEffort}）`}${extraNote}`,
      })
    }
    if (typeof defaultModelService?.saveSelection === 'function') {
      try {
        await defaultModelService.saveSelection({
          provider: cleanProvider,
          model: cleanModel,
          ...(cleanEffort === '' ? {} : { reasoningEffort: cleanEffort }),
        })
        this.catalogReader.invalidate()
        return Object.freeze({
          applied: true,
          entry: 'agent-default-model',
          note: `默认模型已切换为 ${cleanProvider} / ${cleanModel}${cleanEffort === '' ? '' : `（${cleanEffort}）`}${extraNote}`,
        })
      } catch (cause) {
        return writeFailure('agent-default-model', cause)
      }
    }
    return refuse('agent-default-model', 'Host agent-default-model 未加载，无法写入默认模型路由')
  }

  /** Read-only aggregate view of Dreaming, Proactive, WorkItems, MemoryLearning, and GrowthDriver. */
  async assistantOverview(workspace: string, preset: string): Promise<OwnerConsoleAssistantOverview> {
    const inventory = await this.inventory()
    const installedModules = new Set(inventory.bundles.filter(bundle => bundle.installed).map(bundle => bundle.name))
    return readAssistantOverview(this.host, workspace, preset, installedModules)
  }

  /** Owner-authorized state change on assistant-dreaming (ack / validate / reject / retire). */
  async actDreamingIdea(ideaId: string, action: DreamingIdeaAction, note: string): Promise<OwnerConsoleWriteResult> {
    return executeDreamingIdeaAction(this.host, ideaId, action, note)
  }

  /** Owner-authorized reply to a WP22 attention-loosening owner question in assistant-evaluation. */
  async actAttentionQuestion(workspace: string, preset: string, cohortLane: string, cohortSourceId: string,
    questionId: string, choice: 'authorize-once' | 'decline'): Promise<OwnerConsoleWriteResult> {
    return executeAttentionQuestionReply(this.host, workspace, preset, cohortLane, cohortSourceId, questionId, choice)
  }

  /** Host-only owner disposition of a proactive preparation draft (`unverified-draft`). */
  async actProactiveDraft(id: string, action: 'accept' | 'reject' | 'cancel',
    workspace: string, preset: string): Promise<OwnerConsoleWriteResult> {
    return executeProactiveDraftAction(this.host, id, action, workspace, preset)
  }

  /** Inspect owner route, model route, $DSH_HOME scoping, and current autonomy grants. */
  async autonomySetupStatus(): Promise<AutonomySetupStatus> {
    return inspectAutonomyWizardStatus(this.host)
  }

  /** Apply validated autonomy authorization, finite budgets, or safe pause/disable. */
  async configureAutonomySetup(
    action: AutonomySetupAction,
    tier: AutonomyBudgetTier,
    provider: string,
    model: string,
    reasoningEffort: string,
    enableMemoryLearning: boolean,
    enableDreaming: boolean,
    enableGrowth: boolean,
    workItemExperiences: boolean,
    customBudget: AutonomyBudgetLimits,
  ): Promise<OwnerConsoleWriteResult> {
    const result = await applyAutonomyWizardSetup(this.host, {
      action,
      tier,
      provider,
      model,
      reasoningEffort,
      enableMemoryLearning,
      enableDreaming,
      enableGrowth,
      workItemExperiences,
      customBudget,
      reloadEntry: entryId => this.reload(entryId),
    })
    if (result.applied) {
      this.catalogReader.invalidate()
      if (action === 'enable') {
        await this.ensureAuthorizedAutonomyBundlesEnabled(enableMemoryLearning, enableDreaming, enableGrowth)
      }
    }
    return result
  }

  private async ensureAuthorizedAutonomyBundlesEnabled(
    enableMemoryLearning: boolean,
    enableDreaming: boolean,
    enableGrowth: boolean,
  ): Promise<void> {
    const manager = this.host.get('pluginManager' as never) as PluginManagerService | undefined
    if (manager === undefined) return
    try {
      const bundles = await manager.listBundles()
      const targets: string[] = []
      if (enableMemoryLearning) targets.push('@dsh-ray/assistant-memory-learning')
      if (enableDreaming) targets.push('@dsh-ray/assistant-dreaming')
      if (enableGrowth) targets.push('@dsh-ray/assistant-growth-driver')
      for (const pkg of targets) {
        const entry = bundles.find(b => b.name === pkg)
        if (entry?.installed === true && !entry.enabled) {
          await manager.setBundleEnabled(pkg, true)
        }
      }
    } catch {
      // Best-effort bundle activation; persisted cordis.patch.yml already grants autonomy setup.
    }
  }

  /** Check current @dsh-ray / bound Host versions and latest npm release safely with TTL cache. */
  async checkSelfUpgrade(force: boolean): Promise<SelfUpgradeStatus> {
    return this.upgradeProber.check(this.host, force)
  }

  /** Preview an upgrade plan without mutating files or running detached upgraders. */
  async dryRunSelfUpgrade(): Promise<SelfUpgradePreview> {
    return this.upgradeProber.dryRun(this.host)
  }

  /** Explicitly trigger detached local/macOS upgrade (or return out-of-band CLI guidance on frozen systemd). */
  async runSelfUpgrade(confirmed: boolean): Promise<OwnerConsoleWriteResult> {
    return this.upgradeProber.trigger(this.host, confirmed)
  }

  /** Read-only cross-ledger growth scorecard (tasks/corrections, memory/exposure, candidates, notifications, suppliers). */
  async growthReport(workspace: string, preset: string, sinceDays: number): Promise<OwnerConsoleGrowthReport> {
    return readOwnerConsoleGrowthReport(this.host, workspace, preset, sinceDays)
  }

  /** Run self-healing setup doctor inspecting plugins, conflicts, owner routes, DB paths, and ACP CLIs. */
  async setupDoctor(): Promise<SetupDoctorReport> {
    return inspectSetupDoctor({
      host: this.host,
      status: await this.status(),
      descriptors: this.descriptors(),
      prober: this.prober,
    })
  }

  /** Automatically repair selected (or all auto-fixable) setup doctor issues safely and atomically. */
  async applyDoctorRepair(issueIds: readonly string[]): Promise<OwnerConsoleWriteResult> {
    const result = await applyDoctorRepair({
      host: this.host,
      status: await this.status(),
      descriptors: this.descriptors(),
      settings: this.host.get('settings' as never) as SettingsService | undefined,
      manager: this.host.get('pluginManager' as never) as PluginManagerService | undefined,
      prober: this.prober,
      reloadEntry: entryId => this.reload(entryId),
      issueIds,
    })
    if (result.applied) this.catalogReader.invalidate()
    return result
  }

  /** Store Feishu App Secret in OS credential vault and configure handle + policy rule without plaintext in YAML. */
  async configureFeishuEasy(appId: string, appSecret: string, account: string, tenant: string): Promise<OwnerConsoleWriteResult> {
    return configureFeishuEasy({
      host: this.host,
      descriptors: this.descriptors(),
      appId,
      appSecret,
      account,
      tenant,
    })
  }

  /** List registered and dormant providers, advertised models, and reasoning efforts (for /model-style selectors). */
  async modelCatalog(force: boolean): Promise<OwnerConsoleModelCatalog> {
    return this.catalogReader.read(this.host, await this.status(), force)
  }

  /** Resolve dedicated 文鳐 workspace, preset, known sessions, and live Host capabilities. */
  async assistantChatContext(): Promise<AssistantChatContext> {
    return resolveAssistantChatContext(this.host, this.assistantChat)
  }

  /** Bind a Session ID to the dedicated 文鳐 persona so Host injects assistant prompt only for it. */
  async registerAssistantSession(sessionId: string, makeActive: boolean): Promise<OwnerConsoleWriteResult> {
    const clean = sessionId.trim()
    if (clean === '' || clean.length > 200 || hasControlChars(clean)) {
      return refuse('owner-console', '会话 ID 无效')
    }
    try {
      const saved = this.assistantChat.registerSession(clean, makeActive)
      return Object.freeze({
        applied: true,
        entry: 'owner-console',
        note: saved.persisted
          ? `已将对话 ${clean} 绑定至文鳐助手上下文`
          : `已记录文鳐助手会话 ${clean}（当前未检测到可写 $DSH_HOME，仅本进程有效）`,
      })
    } catch (cause) {
      return refuse('owner-console', cause instanceof Error ? cause.message : '注册助手会话失败')
    }
  }

  /** Start official Feishu/Lark OAuth 2.0 Device Authorization QR onboarding; secrets remain strictly in Host memory. */
  async startFeishuQrOnboarding(
    domain: 'feishu' | 'lark',
    appName: string,
    existingAppId: string,
    account: string,
    tenant: string,
    calendarReadonly: boolean,
    businessTools: boolean,
  ): Promise<FeishuQrOnboardingSnapshot> {
    return this.feishuQr.start({
      host: this.host,
      getDescriptors: () => this.descriptors(),
    }, {
      domain,
      appName,
      existingAppId,
      account,
      tenant,
      calendarReadonly,
      businessTools,
    })
  }

  /** Poll sanitized status of the active (or specified) Feishu QR onboarding session. */
  async feishuQrOnboardingStatus(sessionId: string): Promise<FeishuQrOnboardingSnapshot> {
    return this.feishuQr.status(sessionId)
  }

  /** Cancel an active awaiting-scan Feishu QR onboarding session and abort Host polling immediately. */
  async cancelFeishuQrOnboarding(sessionId: string): Promise<FeishuQrOnboardingSnapshot> {
    return this.feishuQr.cancel(sessionId)
  }

  /** Promote the scanned Feishu/Lark account from the active completed QR session to primary owner (requires confirmation). */
  async promoteFeishuQrOwner(sessionId: string, confirmed: boolean): Promise<FeishuQrOnboardingSnapshot> {
    return this.feishuQr.promoteOwner({
      host: this.host,
      getDescriptors: () => this.descriptors(),
    }, sessionId, confirmed)
  }

  /** Trigger a clean detached restart of DeepSeek Harness.app or the profile's managed resident service (requires confirmation). */
  async restartProfile(confirmed: boolean): Promise<OwnerConsoleWriteResult> {
    return this.restartProfileFn({
      host: this.host,
      confirmed,
    })
  }

  /** Owner-authorized control for enabling, disabling, or upgrading & recovering overall assistant self-iteration (requires confirmation). */
  async controlSelfIteration(action: OwnerSelfIterationAction, confirmed: boolean): Promise<OwnerConsoleControlActionResult> {
    if (confirmed !== true) {
      return Object.freeze({
        ok: false,
        ...(action === 'enableSelfIteration' || action === 'disableSelfIteration' || action === 'upgradeAssistantAndRecover'
          ? { action }
          : {}),
        error: '需要 Owner 明确确认后才能执行整体自迭代控制操作',
        reason: 'confirmation required',
      })
    }
    const result = await handleOwnerConsoleControlAction(this.host, {
      ownerAuthorized: true,
      action,
    })
    if (result.ok) this.catalogReader.invalidate()
    return Object.freeze({
      ok: result.ok,
      ...(result.action === undefined ? {} : { action: result.action }),
      ...(result.state === undefined ? {} : { state: result.state }),
      ...(result.healthy === undefined ? {} : { healthy: result.healthy }),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.note === undefined ? {} : { note: result.note }),
    })
  }

  /** Read-only assistant/Host/plugin version & self-iteration statistics (`dsh-ray/version/v1`). */
  async versionInfo(): Promise<AssistantVersionReport> {
    return collectOwnerConsoleVersionInfo(this.host)
  }
}

const ANSI_ESCAPE = String.fromCodePoint(0x1b)
const ANSI_SEQUENCE = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'gu')
/** pnpm names the scripts it skipped on one line, coloured by default (pnpm 11 makes that a failure). */
const IGNORED_BUILDS = /\bIgnored build scripts: ([^\n]+)/u
const MAX_BUILD_NAMES = 64
const MAX_DIAGNOSTIC_CHARS = 600

/** Read the build-script names pnpm reported from a raw run: ANSI escapes are stripped first, since
 * pnpm 11 decorates the line and the Host's own parser (`dsh-plugin-manager`) can miss the boundary. */
export function blockedBuildNames(output: string): readonly string[] {
  const line = IGNORED_BUILDS.exec(output.replace(ANSI_SEQUENCE, ''))?.[1]
  if (line === undefined) return Object.freeze([])
  const names = new Set<string>()
  for (const raw of line.split(',')) {
    const name = raw.trim().replace(/\.$/u, '')
    if (name === '' || name.length > 200 || /[*?]/u.test(name)) continue
    names.add(name)
    if (names.size >= MAX_BUILD_NAMES) break
  }
  return Object.freeze([...names])
}

/** A failure diagnostic is shown as one bounded line; the full pnpm log stays in the Host's log file. */
function diagnosticTail(output: string | undefined): string {
  const text = (output ?? '').replace(ANSI_SEQUENCE, '').replace(/\s+/gu, ' ').trim()
  return text.length > MAX_DIAGNOSTIC_CHARS ? `…${text.slice(-MAX_DIAGNOSTIC_CHARS)}` : text
}

function requirementsLabel(requirements: Readonly<Record<string, string>>): string {
  const entries = Object.entries(requirements)
  return entries.length === 0 ? '未知要求' : entries.map(([name, version]) => `${name} ${version}`).join('、')
}

/** Only names the write-result wire schema accepts reach the client; a longer Host list is
 * approved in bounded retries instead of failing the whole result validation. */
function normalizeBuildNames(names: readonly string[] | undefined): readonly string[] {
  return Object.freeze((names ?? [])
    .filter(name => name !== '' && name.length <= 200 && !/[\r\n]/u.test(name))
    .slice(0, MAX_BUILD_NAMES))
}

function isNoTtyModulesPurgeError(result: ChangeResultLike): boolean {
  const text = `${result.error?.diagnostic ?? ''}\n${result.packageResult?.output ?? ''}`
  return /ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY/u.test(text)
}

/** Detect pnpm store-version / modules breaking-change aborts (`ERR_PNPM_UNEXPECTED_STORE` or `ERR_PNPM_MODULES_BREAKING_CHANGE`). */
export function isUnexpectedStoreError(result: ChangeResultLike): boolean {
  const text = `${result.error?.diagnostic ?? ''}\n${result.packageResult?.output ?? ''}`.replace(ANSI_SEQUENCE, '')
  return /ERR_PNPM_(?:UNEXPECTED_STORE|MODULES_BREAKING_CHANGE)/u.test(text)
}

async function executeWithPnpmRecovery(
  dir: string | undefined,
  manager: unknown,
  reconcileStore: (dir: string, manager: unknown) => Promise<boolean>,
  invoke: () => Promise<ChangeResultLike>,
): Promise<ChangeResultLike> {
  let raw = await invoke()
  let retriedNoTty = false
  let retriedStore = false
  for (;;) {
    if (!retriedNoTty && dir !== undefined && isNoTtyModulesPurgeError(raw)) {
      retriedNoTty = true
      const updated = await persistConfirmModulesPurgeDisabled(dir).catch(() => false)
      if (updated) {
        raw = await invoke()
        continue
      }
    }
    if (!retriedStore && dir !== undefined && existsSync(dir) && isUnexpectedStoreError(raw)) {
      retriedStore = true
      const reconciled = await reconcileStore(dir, manager).catch(() => false)
      if (reconciled) {
        raw = await invoke()
        continue
      }
    }
    break
  }
  return raw
}

/** Install-specific refusal mapping: surface every build name pnpm reported (the Host's own record
 * may be empty when its parser misses pnpm's coloured line), and turn a raw error box or a
 * compatibility denial into the concrete owner-facing next step. */
export function applyInstall(result: ChangeResultLike, profileDir?: string): OwnerConsoleWriteResult {
  const pending = normalizeBuildNames(result.pendingBuilds)
  const log = result.packageResult?.logPath === undefined
    ? '' : `；pnpm 日志：${boundedText(result.packageResult.logPath, 300)}`
  const error = result.error
  if (error === undefined) return applyChange(result)
  const incompatible = error.incompatible ?? []
  if (incompatible.length > 0) {
    const packages = incompatible.map(plugin =>
      `${plugin.name}@${plugin.version}（要求 ${requirementsLabel(plugin.requirements)}，当前 DSH ${plugin.runtimeVersion}）`)
    return Object.freeze({
      applied: false,
      entry: result.target,
      ...(pending.length === 0 ? {} : { pendingBuilds: pending }),
      note: `Host 拒绝了不兼容的插件版本：${packages.join('；')}。请安装兼容版本，或由主人为这个精确版本授予兼容豁免后重试。${log}`,
    })
  }
  if (isNoTtyModulesPurgeError(result)) {
    return Object.freeze({
      applied: false,
      entry: result.target,
      ...(pending.length === 0 ? {} : { pendingBuilds: pending }),
      note: `安装被 pnpm 非交互终端安全确认拦截（ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY）；请在 profile 目录 pnpm-workspace.yaml 写入 confirmModulesPurge: false 或在环境设置 CI=true 后重试。${log}`,
    })
  }
  if (isUnexpectedStoreError(result)) {
    const dirArg = profileDir !== undefined && profileDir.trim() !== '' ? profileDir.trim() : '<profile目录>'
    return Object.freeze({
      applied: false,
      entry: result.target,
      ...(pending.length === 0 ? {} : { pendingBuilds: pending }),
      note: `安装因 pnpm store 版本/路径不兼容被中止（v10/v11 store 不一致，ERR_PNPM_UNEXPECTED_STORE / ERR_PNPM_MODULES_BREAKING_CHANGE）；自动重建未成功，请在终端运行 pnpm install --dir "${dirArg}" --config.confirmModulesPurge=false 后重试。${log}`,
    })
  }
  const buildBlocked = result.packageResult?.kind === 'build-blocked'
    || /ERR_PNPM_IGNORED_BUILDS/u.test(error.diagnostic ?? '')
  if (buildBlocked) {
    const names = pending.length > 0 ? pending
      : normalizeBuildNames(blockedBuildNames(error.diagnostic ?? result.packageResult?.output ?? ''))
    const listed = names.length === 0 ? 'Host 未给出名称（完整输出在 profile 的 pnpm 日志中）' : names.join('、')
    const next = names.length === 0
      ? 'Host 未能自动记录这次拒绝；请在 profile 的 pnpm-workspace.yaml 中写入 allowBuilds（依赖名: true），或运行 pnpm approve-builds 后重试。'
      : pending.length > 0
        ? '确认允许这些依赖运行构建脚本后重试。'
        : '确认允许后，面板会把这些名称写入 profile 的 allowBuilds 并重试一次。'
    return Object.freeze({
      applied: false,
      entry: result.target,
      ...(names.length === 0 ? {} : { pendingBuilds: names }),
      note: `安装被 pnpm 的依赖构建脚本策略拒绝：${listed}。${next}${log}`,
    })
  }
  const tail = diagnosticTail(error.diagnostic ?? result.packageResult?.output)
  return Object.freeze({
    applied: false,
    entry: result.target,
    ...(pending.length === 0 ? {} : { pendingBuilds: pending }),
    note: `${error.code}（${result.application}）${tail === '' ? '' : `：${tail}`}${log}`,
  })
}

function applyChange(result: ChangeResultLike): OwnerConsoleWriteResult {
  const reason = result.error === undefined
    ? result.application === 'restart-required'
      ? '需要重启 profile 后生效'
      : result.application === 'overridden' ? '被更高优先级的覆盖项接管' : ''
    : `${result.error.code}${result.error.diagnostic === undefined ? '' : `：${diagnosticTail(result.error.diagnostic)}`}`
  const warnings = (result.warnings ?? []).length === 0 ? '' : `；警告：${(result.warnings ?? []).join('；')}`
  const builds = (result.pendingBuilds ?? []).length === 0 ? ''
    : `；需要在面板确认允许构建脚本：${normalizeBuildNames(result.pendingBuilds).join('、')}`
  return Object.freeze({
    // A persisted change that only needs a profile restart is still applied;
    // failed/cancelled results and validation refusals stay not applied.
    applied: result.application === 'applied' || result.application === 'restart-required',
    entry: result.target,
    note: `${result.changed ? '已变更' : '无变化'}（${result.application}）${reason === '' ? '' : `；${reason}`}${warnings}${builds}`,
  })
}

/** Keep a Host message or diagnostic short enough for a panel banner. */
function boundedText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

/** Map a rejected `settings.mutate` to a business note instead of throwing through the RPC. */
function writeFailure(entry: string, cause: unknown): OwnerConsoleWriteResult {
  const message = cause instanceof Error ? cause.message : String(cause)
  const note = /not volatile/iu.test(message)
    ? `字段不能实时修改：${boundedText(message, 300)}`
    : /changed since it was read|conflict/iu.test(message)
      ? '配置已被其他操作修改（CAS 冲突）；请刷新面板后重试'
      : /No configurable plugin entry|no volatile fields/iu.test(message)
        ? `该条目当前不可配置（未加载或没有 live 字段）：${boundedText(message, 300)}。条目未加载时请重启 profile 或用 profile patch 修复`
        : `写入失败：${boundedText(message, 400)}`
  return refuse(entry, note)
}

/** The Host holds no pending record for a name the owner approved, so no retry is possible. */
function rejectStaleApproval(entry: string, names: readonly string[]): OwnerConsoleWriteResult {
  return refuse(entry, `Host 未记录这些待批准的构建脚本：${names.join('、')}；且未提供 profile 目录，`
    + '无法写入 allowBuilds。请在 profile 的 pnpm-workspace.yaml 中写入对应条目后重试。')
}

function refuse(entry: string, note: string): OwnerConsoleWriteResult {
  return Object.freeze({ applied: false, entry, note })
}

type LarkHealthFacts = Pick<OwnerConsoleStatus['feishu'], 'connected' | 'connection' | 'lastErrorCode'>
const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

/** Read-only: `larkChannel.health()` is a synchronous snapshot with no I/O. Only the
 * enumerated state and error code pass through; anything else becomes `unknown`. */
function readLarkHealth(provider: unknown): LarkHealthFacts {
  if (provider === undefined || provider === null) return { connected: false, connection: 'absent' }
  let state: unknown
  let code: unknown
  try {
    const read = (provider as { health?: unknown }).health
    const health = typeof read === 'function' ? read.call(provider) as { state?: unknown, lastErrorCode?: unknown } | null : undefined
    state = health?.state
    code = health?.lastErrorCode
  } catch {
    // An inactive or failing provider is reported, never thrown into the panel.
    state = undefined
  }
  if (!includes(LARK_CONNECTIONS, state) || state === 'absent' || state === 'unknown') {
    return { connected: false, connection: 'unknown' }
  }
  return {
    connected: state === 'connected' || state === 'connected-with-gap',
    connection: state,
    ...(includes(LARK_ERROR_CODES, code) ? { lastErrorCode: code } : {}),
  }
}

type TrendSnapshotProvider = { inspectCreatedCapabilityOrdinaryUseTrendSnapshots?: (query: {
  planId?: string, beforeSequence?: number, limit?: number }) => unknown }
const UNVERIFIABLE: OwnerConsoleTrendSnapshots = Object.freeze({ state: 'unverifiable', causal: false, items: Object.freeze([]) })
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

/** Project one control-plane snapshot page onto the bounded panel summary; content-free digests and counts only. */
export function readTrendSnapshots(provider: unknown, planId: string, beforeSequence: number,
  limit: number): OwnerConsoleTrendSnapshots {
  if (provider === undefined || provider === null) return Object.freeze({ state: 'absent', causal: false, items: Object.freeze([]) })
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TREND_SNAPSHOT_PAGE_MAX
    || !Number.isSafeInteger(beforeSequence) || beforeSequence < 0) return UNVERIFIABLE
  try {
    const read = (provider as TrendSnapshotProvider).inspectCreatedCapabilityOrdinaryUseTrendSnapshots
    if (typeof read !== 'function') return UNVERIFIABLE
    const page = record(read.call(provider, {
      ...(planId.trim() === '' ? {} : { planId: planId.trim() }),
      ...(beforeSequence === 0 ? {} : { beforeSequence }),
      limit,
    }))
    if (page['causal'] !== false || !Array.isArray(page['items'])) return UNVERIFIABLE
    const items = page['items'].map(item => {
      const row = record(item)
      const snapshot = record(row['snapshot'])
      const trend = record(snapshot['trend'])
      if (snapshot['causal'] !== false || trend['causal'] !== false) throw new Error('causal snapshot')
      return {
        sequence: row['sequence'], sealedAt: row['sealedAt'], planId: snapshot['planId'], digest: snapshot['digest'],
        inputsDigest: snapshot['inputsDigest'], trendDigest: snapshot['trendDigest'], window: snapshot['window'],
        cohorts: trend['cohorts'], flags: snapshot['flags'],
        strata: list(trend['strata']).map(value => {
          const stratum = record(value)
          const did = record(stratum['differenceInDifferences'])
          const interval = record(did['interval95'])
          return {
            model: stratum['model'],
            differenceInDifferences: did['status'] === 'estimated'
              ? { status: 'estimated', estimate: did['estimate'], low: interval['low'], high: interval['high'] }
              : { status: 'insufficient' },
            parallelTrend: record(stratum['parallelTrend'])['status'],
          }
        }),
      }
    })
    const parsed = OwnerConsoleTrendSnapshotsSchema.safeParse({ state: 'ok', causal: false, items,
      ...(page['nextBeforeSequence'] === undefined ? {} : { nextBeforeSequence: page['nextBeforeSequence'] }) })
    return parsed.success ? Object.freeze(parsed.data) : UNVERIFIABLE
  } catch {
    return UNVERIFIABLE
  }
}

type IntakeAgreementProvider = { inspectIntakeAttentionAgreement?: (input: { scope: { workspace: string, preset: string } }) => unknown }
const INTAKE_UNVERIFIABLE: OwnerConsoleIntakeAgreement = Object.freeze({ state: 'unverifiable', causal: false })

interface IntakeAgreementCellView {
  readonly notifications: number
  readonly items: number
  readonly agreed: number
  readonly disagreed: number
  readonly agreementPpm: number | null
  readonly outcomes: Readonly<Record<typeof INTAKE_AGREEMENT_OUTCOMES[number], number>>
}
function intakeAgreementCell(value: unknown): IntakeAgreementCellView {
  const cell = record(value)
  const outcomes = record(cell['outcomes'])
  return {
    notifications: cell['notifications'] as number, items: cell['items'] as number,
    agreed: cell['agreed'] as number, disagreed: cell['disagreed'] as number,
    agreementPpm: cell['agreementPpm'] as number | null,
    outcomes: Object.fromEntries(INTAKE_AGREEMENT_OUTCOMES.map(outcome => [outcome, outcomes[outcome]])) as
      Readonly<Record<typeof INTAKE_AGREEMENT_OUTCOMES[number], number>>,
  }
}

/** Project Evaluation's intake attention agreement onto the panel summary; counts only, no ids or content. */
export function readIntakeAgreement(provider: unknown, workspace: string, preset: string): OwnerConsoleIntakeAgreement {
  if (provider === undefined || provider === null) return Object.freeze({ state: 'absent', causal: false })
  const scope = { workspace: workspace.trim(), preset: preset.trim() }
  if (scope.workspace === '' || scope.preset === '') return INTAKE_UNVERIFIABLE
  try {
    const read = (provider as IntakeAgreementProvider).inspectIntakeAttentionAgreement
    if (typeof read !== 'function') return INTAKE_UNVERIFIABLE
    const result = read.call(provider, { scope })
    if (result === undefined) return Object.freeze({ state: 'disabled', causal: false })
    const agreement = record(result)
    if (agreement['protocol'] !== 'assistant-evaluation/intake-attention-agreement/v1' || agreement['causal'] !== false) return INTAKE_UNVERIFIABLE
    const byLevel = record(agreement['byLevel'])
    const parsed = OwnerConsoleIntakeAgreementSchema.safeParse({ state: 'ok', causal: false, summary: {
      fromNotifiedAt: agreement['fromNotifiedAt'], toNotifiedAt: agreement['toNotifiedAt'], scanned: agreement['scanned'],
      truncated: agreement['truncated'], provenanceAvailable: agreement['provenanceAvailable'], notIntake: agreement['notIntake'],
      unresolved: agreement['unresolved'], foreign: agreement['foreign'], intake: intakeAgreementCell(agreement['intake']),
      byLevel: INTAKE_AGREEMENT_LEVELS.filter(level => byLevel[level] !== undefined)
        .map(level => ({ level, cell: intakeAgreementCell(byLevel[level]) })),
    } })
    return parsed.success && intakeAgreementConsistent(parsed.data.summary!) ? Object.freeze(parsed.data) : INTAKE_UNVERIFIABLE
  } catch {
    return INTAKE_UNVERIFIABLE
  }
}

type IntakeAgreementHistoryProvider = {
  inspectIntakeAttentionAgreementHistory?: (input: { scope: { workspace: string, preset: string }, limit?: number }) => unknown
}
export interface OwnerConsoleIntakeAgreementHistoryEntry {
  readonly fromNotifiedAt: number
  readonly toNotifiedAt: number
  readonly computedAt: number
  readonly windowMs: number
  readonly scanLimit: number
  readonly truncated: boolean
  readonly provenanceAvailable: boolean
  readonly notIntake: number
  readonly unresolved: number
  readonly foreign: number
  readonly intake: IntakeAgreementCellView
  /** Labeled levels, strongest-last like the current-agreement panel; counts only. */
  readonly byLevel: readonly Readonly<{ level: (typeof INTAKE_AGREEMENT_LEVELS)[number]; cell: IntakeAgreementCellView }>[]
}
/** Labeled count cells keep the same level order as the current-agreement panel. */
export interface OwnerConsoleIntakeAgreementHistory {
  readonly state: 'absent' | 'disabled' | 'unverifiable' | 'ok'
  readonly causal: false
  readonly snapshots?: readonly OwnerConsoleIntakeAgreementHistoryEntry[]
}
const INTAKE_HISTORY_UNVERIFIABLE: OwnerConsoleIntakeAgreementHistory = Object.freeze({ state: 'unverifiable', causal: false })

function historyCellConsistent(cell: ReturnType<typeof intakeAgreementCell>): boolean {
  const total = INTAKE_AGREEMENT_OUTCOMES.reduce((sum, outcome) => sum + cell.outcomes[outcome], 0)
  const decided = cell.agreed + cell.disagreed
  return total === cell.notifications && cell.items <= cell.notifications
    && cell.agreed === cell.outcomes.accepted + cell.outcomes.reacted
    && cell.disagreed === cell.outcomes.rejected + cell.outcomes['expired-unhandled']
    && cell.agreementPpm === (decided === 0 ? null : Math.round(cell.agreed * 1_000_000 / decided))
}

/** Validate one persisted snapshot without ever trusting the provider's arithmetic. */
function intakeAgreementHistoryEntry(value: unknown): OwnerConsoleIntakeAgreementHistoryEntry | undefined {
  try {
    const entry = record(value)
    if (entry['protocol'] !== 'assistant-evaluation/intake-attention-agreement-snapshot/v1'
      || entry['snapshotVersion'] !== 1 || entry['causal'] !== false) return undefined
    const integer = (label: string, minimum = 0): number => {
      const candidate = entry[label]
      return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= minimum ? candidate : Number.NaN
    }
    const from = integer('fromNotifiedAt'), to = integer('toNotifiedAt'), computedAt = integer('computedAt')
    const windowMs = integer('windowMs'), scanLimit = integer('scanLimit', 1)
    const truncated = entry['truncated'], provenanceAvailable = entry['provenanceAvailable']
    const intake = intakeAgreementCell(entry['intake'])
    const levels = record(entry['byLevel'])
    const byLevel = INTAKE_AGREEMENT_LEVELS.filter(level => levels[level] !== undefined)
      .map(level => Object.freeze({ level, cell: intakeAgreementCell(levels[level]) }))
    if (![from, to, computedAt, windowMs, scanLimit].every(Number.isSafeInteger)
      || from < 0 || to <= from || windowMs < 60_000 || typeof truncated !== 'boolean' || typeof provenanceAvailable !== 'boolean'
      || !historyCellConsistent(intake) || byLevel.some(entry => !historyCellConsistent(entry.cell))) return undefined
    const notIntake = integer('notIntake'), unresolved = integer('unresolved'), foreign = integer('foreign')
    if (![notIntake, unresolved, foreign].every(Number.isSafeInteger)
      || intake.notifications + notIntake + unresolved + foreign > scanLimit
      || byLevel.reduce((sum, entry) => sum + entry.cell.notifications, 0) !== intake.notifications) return undefined
    return {
      fromNotifiedAt: from, toNotifiedAt: to, computedAt, windowMs, scanLimit, truncated, provenanceAvailable,
      notIntake, unresolved, foreign, intake, byLevel,
    }
  } catch {
    return undefined
  }
}

/** Project Evaluation's durable agreement snapshots (newest first) onto counts only. */
export function readIntakeAgreementHistory(provider: unknown, workspace: string, preset: string,
  limit = 20): OwnerConsoleIntakeAgreementHistory {
  if (provider === undefined || provider === null) return Object.freeze({ state: 'absent', causal: false })
  const scope = { workspace: workspace.trim(), preset: preset.trim() }
  if (scope.workspace === '' || scope.preset === '' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return INTAKE_HISTORY_UNVERIFIABLE
  try {
    const read = (provider as IntakeAgreementHistoryProvider).inspectIntakeAttentionAgreementHistory
    if (typeof read !== 'function') return INTAKE_HISTORY_UNVERIFIABLE
    const result = read.call(provider, { scope, limit })
    if (result === undefined) return Object.freeze({ state: 'disabled', causal: false })
    const history = record(result)
    if (history['protocol'] !== 'assistant-evaluation/intake-attention-agreement-history/v1' || history['causal'] !== false) return INTAKE_HISTORY_UNVERIFIABLE
    if (!Array.isArray(history['snapshots']) || history['snapshots'].length > limit) return INTAKE_HISTORY_UNVERIFIABLE
    const snapshots: OwnerConsoleIntakeAgreementHistoryEntry[] = []
    for (const item of history['snapshots']) {
      const entry = intakeAgreementHistoryEntry(item)
      if (entry === undefined) return INTAKE_HISTORY_UNVERIFIABLE
      snapshots.push(entry)
    }
    return Object.freeze({ state: 'ok', causal: false, snapshots: Object.freeze(snapshots) })
  } catch {
    return INTAKE_HISTORY_UNVERIFIABLE
  }
}

const EVALUATION_MODULE = '@dsh-ray/assistant-evaluation'

/** Scope-free and read-only: whether `intakeAgreement` can answer at all. Nothing on Evaluation is
 * called, so no notification is scanned; the switch comes from the one enabled Evaluation loader
 * entry's persisted config (Evaluation defaults it off). No scope, count or other config passes through. */
export function readIntakeAgreementAvailability(provider: unknown, loader: unknown): IntakeAgreementAvailability {
  if (provider === undefined || provider === null) return 'absent'
  try {
    if (typeof (provider as IntakeAgreementProvider).inspectIntakeAttentionAgreement !== 'function') return 'unknown'
    const read = (loader as Partial<LoaderService> | undefined | null)?.entries
    if (typeof read !== 'function') return 'unknown'
    const entries = [...read.call(loader)].filter(entry =>
      entry.options.name === EVALUATION_MODULE && entry.options.disabled !== true)
    // Zero or several candidates: the panel cannot tell which one provides the service.
    if (entries.length !== 1) return 'unknown'
    const enabled = record(entries[0]!.options.config)['intakeAttentionAgreementEnabled']
    if (enabled === true) return 'available'
    return enabled === undefined || enabled === false ? 'disabled' : 'unknown'
  } catch {
    return 'unknown'
  }
}

type IntakeAgreementSummary = NonNullable<OwnerConsoleIntakeAgreement['summary']>

/** Evaluation's own arithmetic, re-checked so a self-contradicting answer is never shown as `ok`. */
function intakeAgreementConsistent(summary: IntakeAgreementSummary): boolean {
  const cellConsistent = (cell: IntakeAgreementSummary['intake']) => {
    const o = cell.outcomes
    const total = INTAKE_AGREEMENT_OUTCOMES.reduce((sum, outcome) => sum + o[outcome], 0)
    const decided = cell.agreed + cell.disagreed
    return total === cell.notifications && cell.items <= cell.notifications
      && cell.agreed === o.accepted + o.reacted && cell.disagreed === o.rejected + o['expired-unhandled']
      && cell.agreementPpm === (decided === 0 ? null : Math.round(cell.agreed * 1_000_000 / decided))
  }
  const levels = summary.byLevel.map(entry => entry.cell)
  return summary.fromNotifiedAt < summary.toNotifiedAt
    && summary.intake.notifications + summary.notIntake + summary.unresolved + summary.foreign <= summary.scanned
    && cellConsistent(summary.intake) && levels.every(cellConsistent)
    && levels.reduce((sum, cell) => sum + cell.notifications, 0) === summary.intake.notifications
}
