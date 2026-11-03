import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OwnerConsoleConfig } from './index.js'
import {
  boundedConfig, configFacts, findEntry, isAppId, isEntryId, isEnvName, isProjectBundle, isProjectPackage, isSecretRef,
  type BundleInfoLike, type ChangeResultLike, type LoaderService, type PluginInfoLike, type PluginManagerService,
  type SettingsDescriptor, type SettingsPathOp, type SettingsService,
} from './settings.js'
import type { OwnerConsoleStatus, OwnerConsoleWriteResult } from './typert.js'

/** Companions worth surfacing; a missing one is a setup hint, never a hard failure. */
const DEPENDENCIES = ['assistantPolicy', 'assistantDelivery', 'assistantSkills'] as const
const LARK = /(^|[-_/])lark(-channel)?($|[-_/])/u
const TRAEX = /traex/iu
const APP_ID_ENV = ['LARK_APP_ID', 'FEISHU_APP_ID'] as const
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

/** Read-only status plus owner-clicked, one-step writes through the Host settings service.
 * Only `.volatile()` config fields are editable by that service; every write addresses one
 * entry, uses CAS on its revision, and returns a business reason instead of throwing. */
export class OwnerConsoleService extends TypertRemoteService {
  private readonly host: Context

  constructor(ctx: Context, private readonly config: OwnerConsoleConfig) {
    super(ctx, 'ownerConsole')
    this.host = ctx
  }

  private settings(): SettingsService {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    if (settings === undefined) throw new Error('Host settings service is unavailable; this console cannot edit configuration')
    return settings
  }

  private descriptors(): readonly SettingsDescriptor[] {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    return settings?.describe({ redactSecrets: true }) ?? []
  }

  /** Volatile edits update the running fiber references but never re-run apply.
   * A one-step write therefore restarts just this entry with its persisted raw
   * config, so the connector or provider rebuilds from the new plain values. */
  private async reload(entryId: string): Promise<string> {
    const loader = this.host.get('loader' as never) as LoaderService | undefined
    if (loader === undefined) return '；已保存，但 loader 不可用，重启 profile 后生效'
    try {
      const entry = [...loader.entries()].find(candidate => candidate.options.id === entryId || candidate.id === entryId)
      if (entry === undefined) return '；已保存，但未找到该 profile 条目，重启 profile 后生效'
      if (entry.fiber === undefined) {
        await entry.refresh()
        return '；条目已重新加载'
      }
      entry.fiber.update(entry.options.config, true)
      return '；条目已重新加载'
    } catch {
      return '；已保存，但自动重载失败，请重启 profile 后生效'
    }
  }

  private manager(): PluginManagerService {
    const manager = this.host.get('pluginManager' as never) as PluginManagerService | undefined
    if (manager === undefined) throw new Error('Host plugin manager is unavailable; this console cannot manage bundles')
    return manager
  }

  private async inventory(): Promise<Readonly<{ bundles: readonly BundleInfoLike[], plugins: readonly PluginInfoLike[] }>> {
    const manager = this.host.get('pluginManager' as never) as PluginManagerService | undefined
    if (manager === undefined) return Object.freeze({ bundles: [], plugins: [] })
    const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
    return Object.freeze({
      bundles: Object.freeze(bundles.filter(bundle => isProjectPackage(bundle.name))),
      plugins: Object.freeze(plugins.filter(plugin => isProjectPackage(plugin.moduleName))),
    })
  }

  async status(): Promise<OwnerConsoleStatus> {
    const entries = this.descriptors()
    const inventory = await this.inventory()
    const lark = findEntry(entries, ns => LARK.test(ns))
    const traex = findEntry(entries, ns => TRAEX.test(ns))
    const larkValue = configFacts(lark?.value)
    const traexValue = configFacts(traex?.value)
    return Object.freeze({
      feishu: Object.freeze({
        ...(lark === undefined ? {} : { entry: lark.ns }),
        mode: larkValue['secretSource'] === 'handle' || (larkValue['secretSource'] === undefined && typeof larkValue['credentialHandle'] === 'string') ? 'app' : 'lark-cli',
        enabled: larkValue['enabled'] === true,
        appIdConfigured: isAppId(larkValue['appId']),
        connected: this.host.get('larkChannel' as never) !== undefined,
        setupCommand: `dsh-lark-setup --profile ${process.env['DSH_PROFILE'] ?? 'web'}`,
      }),
      traex: Object.freeze({
        ...(traex === undefined ? {} : { entry: traex.ns }),
        enabled: traexValue['enabled'] === true,
        command: typeof traexValue['command'] === 'string' ? traexValue['command'] : '',
      }),
      dependencies: Object.freeze(DEPENDENCIES.map(name => Object.freeze({
        name, available: this.host.get(name as never) !== undefined,
      }))),
      bundles: Object.freeze(inventory.bundles.map(bundle => Object.freeze({
        name: bundle.name,
        ...(bundle.version === undefined ? {} : { version: bundle.version }),
        enabled: bundle.enabled,
        installed: bundle.installed,
        removable: bundle.removable,
      }))),
      plugins: Object.freeze(inventory.plugins.map(plugin => Object.freeze({
        entryId: plugin.entryId,
        moduleName: plugin.moduleName,
        enabled: plugin.enabled,
        fiberPhase: plugin.fiberPhase,
      }))),
    })
  }

  /** Select or remove one installed project bundle layer; dependencies stay installed. */
  async setBundleEnabled(name: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    if (!isProjectPackage(name)) return refuse('', '只允许管理本项目的 @dsh-enhanced/* bundle')
    return applyChange(this.manager(), await this.manager().setBundleEnabled(name, enabled))
  }

  /** Enable or disable one loaded entry of a project bundle. */
  async setPluginEnabled(entryId: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    const manager = this.manager()
    if (entryId.trim() === '') return refuse('', 'entryId 不能为空')
    const inventory = await this.inventory()
    const entry = inventory.plugins.find(plugin => plugin.entryId === entryId)
    if (entry === undefined) return refuse(entryId, '该条目不属于本项目的插件，或尚未安装')
    return applyChange(manager, await manager.setPluginEnabled(entryId, enabled))
  }

  /** Install one project bundle with its declared dependencies, then activate it. */
  async installProjectBundle(spec: string): Promise<OwnerConsoleWriteResult> {
    const trimmed = spec.trim()
    if (!isProjectPackage(trimmed)) {
      return refuse('', '只允许安装本项目的 @dsh-enhanced/<name> 包；本地路径和 git 地址不在此面板处理')
    }
    return applyChange(this.manager(), await this.manager().installBundle(trimmed, { enabled: true, saveExact: true }))
  }

  /** Feishu: one owner click, two ways to pair the bot. No plaintext secret is ever accepted. */
  async configureFeishu(mode: 'lark-cli' | 'app', appId: string, appSecretEnv: string,
    credentialHandle: string, account: string, tenant: string): Promise<OwnerConsoleWriteResult> {
    if (mode !== 'lark-cli' && mode !== 'app') {
      return refuse('', 'unsupported Feishu mode')
    }
    const settings = this.settings()
    const lark = findEntry(this.descriptors(), ns => LARK.test(ns))
    if (lark === undefined) {
      return refuse('', 'lark-channel 未安装，或它没有声明任何可实时修改的配置字段')
    }
    const current = configFacts(lark.value)
    const configured = isAppId(this.config.feishuAppId) ? this.config.feishuAppId : undefined
    const discovered = appId.trim() === '' && mode === 'lark-cli'
      ? APP_ID_ENV.map(name => process.env[name]).find(value => isAppId(value)) ?? configured
      : undefined
    const resolvedAppId = appId.trim() === '' ? discovered : appId.trim()
    if (!isAppId(resolvedAppId)) {
      return refuse(lark.ns, mode === 'lark-cli'
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
    if (handle !== '' && this.host.get('credentialsKeychain' as never) === undefined) {
      return refuse(lark.ns, 'credentials-keychain 未加载；无法引用 keychain secret')
    }
    const resolvedAccount = account.trim() === '' ? current['account'] : account.trim()
    const resolvedTenant = tenant.trim() === '' ? current['tenant'] : tenant.trim()
    if (typeof resolvedAccount !== 'string' || !ACCOUNT.test(resolvedAccount)) {
      return refuse(lark.ns, 'account 缺失或格式无效；请填写当前 owner 的 account，避免更换身份')
    }
    if (typeof resolvedTenant !== 'string' || !ACCOUNT.test(resolvedTenant)) {
      return refuse(lark.ns, 'tenant 缺失或格式无效；请填写当前 owner 的 tenant，避免更换身份')
    }
    await settings.mutate(lark.ns, [
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['appId'], value: resolvedAppId },
      { op: 'set', path: ['account'], value: resolvedAccount },
      { op: 'set', path: ['tenant'], value: resolvedTenant },
      envName === '' ? { op: 'unset', path: ['appSecretEnv'] } : { op: 'set', path: ['appSecretEnv'], value: envName },
      { op: 'set', path: ['secretSource'], value: handle === '' ? 'env' : 'handle' },
      handle === '' ? { op: 'unset', path: ['credentialHandle'] } : { op: 'set', path: ['credentialHandle'], value: handle },
    ], lark.revision)
    const reloaded = await this.reload(lark.ns)
    return Object.freeze({ applied: true, entry: lark.ns,
      note: (handle === '' ? `secret 来自环境变量 ${envName}` : 'secret 保留在 credentials keychain') + reloaded })
  }

  /** TraeX: one owner click toggles the local provider row; command is optional. */
  async configureTraex(enabled: boolean, command: string): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const traex = findEntry(this.descriptors(), ns => TRAEX.test(ns))
    if (traex === undefined) return refuse('', 'traex-acp-provider 未安装，或它没有声明可实时修改的配置字段')
    const value = command.trim()
    if (value !== '' && (value.length > 1_024 || /[\r\n]/u.test(value))) {
      return refuse(traex.ns, 'command 必须是单行且不超过 1024 字符')
    }
    const ops: SettingsPathOp[] = [{ op: 'set', path: ['enabled'], value: enabled }]
    if (value !== '') ops.push({ op: 'set', path: ['command'], value })
    await settings.mutate(traex.ns, ops, traex.revision)
    const reloaded = await this.reload(traex.ns)
    return Object.freeze({ applied: true, entry: traex.ns, note: (enabled ? 'TraeX 行已启用' : 'TraeX 行已停用') + reloaded })
  }

  /** Project bundles only: merge one bounded JSON object into fields the entry exposes live. */
  async configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    if (!isEntryId(entry) || !isProjectBundle(entry)) {
      return refuse('', '只允许修改本项目的 dsh-enhanced 条目')
    }
    const target = findEntry(this.descriptors(), ns => ns === entry)
    if (target === undefined) {
      return refuse(entry, '该条目未安装，或它没有声明可实时修改的配置字段')
    }
    let patch: Readonly<Record<string, unknown>>
    try {
      patch = boundedConfig(config)
    } catch (cause) {
      return refuse(entry, cause instanceof Error ? cause.message : '配置无效')
    }
    const ops: SettingsPathOp[] = Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value }))
    if (ops.length === 0) return refuse(entry, '配置为空，没有可写入的字段')
    await settings.mutate(entry, ops, target.revision)
    const reloaded = await this.reload(entry)
    return Object.freeze({ applied: true, entry, note: '已合并写入' + reloaded })
  }
}

function applyChange(manager: PluginManagerService, result: ChangeResultLike): OwnerConsoleWriteResult {
  void manager
  const reason = result.error === undefined
    ? result.application === 'restart-required'
      ? '需要重启 profile 后生效'
      : result.application === 'overridden' ? '被更高优先级的覆盖项接管' : ''
    : `${result.error.code}${result.error.diagnostic === undefined ? '' : `：${result.error.diagnostic}`}`
  const warnings = (result.warnings ?? []).length === 0 ? '' : `；警告：${(result.warnings ?? []).join('；')}`
  return Object.freeze({
    applied: result.application === 'applied',
    entry: result.target,
    note: `${result.changed ? '已变更' : '无变化'}（${result.application}）${reason === '' ? '' : `；${reason}`}${warnings}`,
  })
}

function refuse(entry: string, note: string): OwnerConsoleWriteResult {
  return Object.freeze({ applied: false, entry, note })
}
