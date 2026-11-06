import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OwnerConsoleConfig } from './index.js'
import {
  boundedConfig, configFacts, findEntry, isAppId, isEntryId, isEnvName, isProjectBundle, isProjectPackage, isSecretRef,
  type BundleInfoLike, type ChangeResultLike, type LoaderService, type PluginInfoLike, type PluginManagerService,
  type SettingsDescriptor, type SettingsPathOp, type SettingsService,
} from './settings.js'
import {
  INTAKE_AGREEMENT_LEVELS, INTAKE_AGREEMENT_OUTCOMES, LARK_CONNECTIONS, LARK_ERROR_CODES, OwnerConsoleIntakeAgreementSchema,
  OwnerConsoleTrendSnapshotsSchema, TREND_SNAPSHOT_PAGE_MAX,
  type IntakeAgreementAvailability, type OwnerConsoleIntakeAgreement, type OwnerConsoleStatus, type OwnerConsoleTrendSnapshots, type OwnerConsoleWriteResult,
} from './typert.js'
import { componentState, missingRemedy, repairPatch } from './state.js'

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

  async status(): Promise<OwnerConsoleStatus> {
    const settings = this.host.get('settings' as never) as SettingsService | undefined
    const entries = settings?.describe({ redactSecrets: true }) ?? []
    const inventory = await this.inventory()
    const lark = findEntry(entries, ns => LARK.test(ns))
    const traex = findEntry(entries, ns => TRAEX.test(ns))
    const larkValue = configFacts(lark?.value)
    const traexValue = configFacts(traex?.value)
    const installed = (name: string) => inventory.phases.bundles === 'ok'
      && inventory.bundles.some(bundle => bundle.name === name && bundle.installed)
    const larkHealth = readLarkHealth(this.host.get('larkChannel' as never))
    return Object.freeze({
      feishu: Object.freeze({
        ...(lark === undefined ? {} : { entry: lark.ns }),
        mode: larkValue['secretSource'] === 'handle' || (larkValue['secretSource'] === undefined && typeof larkValue['credentialHandle'] === 'string') ? 'handle' : 'env',
        installed: installed('@dsh-enhanced/lark-channel'),
        enabled: larkValue['enabled'] === true,
        appIdConfigured: isAppId(larkValue['appId']),
        ...larkHealth,
      }),
      traex: Object.freeze({
        ...(traex === undefined ? {} : { entry: traex.ns }),
        installed: installed('@dsh-enhanced/traex-acp-provider'),
        enabled: traexValue['enabled'] === true,
        command: typeof traexValue['command'] === 'string' ? traexValue['command'] : '',
      }),
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

  /** Select or remove one installed project bundle layer; dependencies stay installed. */
  async setBundleEnabled(name: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    if (!isProjectPackage(name)) return refuse('', '只允许管理本项目的 @dsh-enhanced/* bundle')
    const manager = this.manager()
    return applyChange(await manager.setBundleEnabled(name, enabled))
  }

  /** Enable or disable one loaded entry of a project bundle. */
  async setPluginEnabled(entryId: string, enabled: boolean): Promise<OwnerConsoleWriteResult> {
    const manager = this.manager()
    if (entryId.trim() === '') return refuse('', 'entryId 不能为空')
    const inventory = await this.inventory()
    const entry = inventory.plugins.find(plugin => plugin.entryId === entryId)
    if (entry === undefined) return refuse(entryId, '该条目不属于本项目的插件，或尚未安装')
    return applyChange(await manager.setPluginEnabled(entryId, enabled))
  }

  /** Remove one project bundle layer after the owner confirms the destructive step. */
  async removeProjectBundle(name: string): Promise<OwnerConsoleWriteResult> {
    if (!isProjectPackage(name)) return refuse('', '只允许移除本项目的 @dsh-enhanced/* bundle')
    const manager = this.manager()
    return applyChange(await manager.removeBundle(name))
  }

  /** Install one project bundle with its declared dependencies, then activate it.
   * The Host's pnpm run can stop at its dependency build-script policy; the names it recorded
   * in `pendingBuilds` are the only ones a retry may approve, so the panel never approves a
   * build script the Host did not surface. */
  async installProjectBundle(spec: string, approvedBuilds: readonly string[] = []): Promise<OwnerConsoleWriteResult> {
    const trimmed = spec.trim()
    if (!isProjectPackage(trimmed)) {
      return refuse('', '只允许安装本项目的 @dsh-enhanced/<name> 包；本地路径和 git 地址不在此面板处理')
    }
    const approvals = [...new Set(approvedBuilds.map(name => name.trim()))]
    if (approvedBuilds.length > MAX_BUILD_NAMES
      || approvals.some(name => name === '' || name.length > 200 || /[*?\r\n]/u.test(name))) {
      return refuse(trimmed, '批准的构建脚本名称无效')
    }
    const manager = this.manager()
    const result = await manager.installBundle(trimmed, {
      enabled: true,
      saveExact: true,
      ...(approvals.length === 0 ? {} : { approvedBuilds: approvals }),
    })
    return applyInstall(result)
  }

  /** Feishu: one owner click, two ways to pair the bot. No plaintext secret is ever accepted. */
  async configureFeishu(appId: string, appSecretEnv: string, credentialHandle: string,
    account: string, tenant: string, discoverAppId: boolean): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const lark = findEntry(this.descriptors(), ns => LARK.test(ns))
    if (lark === undefined) {
      return await this.targetRefusal('dsh-enhanced-lark-channel', '@dsh-enhanced/lark-channel', 'lark-channel')
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
      return await this.targetRefusal('dsh-enhanced-traex-acp-provider', '@dsh-enhanced/traex-acp-provider', 'traex-acp-provider')
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
      const status = await this.status()
      const packageName = status.bundles.find(bundle => bundle.rows.some(row => row.rowId === entry))?.name
        ?? entry.replace(/^dsh-enhanced-/u, '@dsh-enhanced/')
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
    return Object.freeze({ applied: true, entry, note: '已合并写入' + reloaded })
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

/** Install-specific refusal mapping: keep the Host's approval names only when it recorded them, and
 * turn pnpm's raw error box or a compatibility denial into the concrete owner-facing next step. */
export function applyInstall(result: ChangeResultLike): OwnerConsoleWriteResult {
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
  const buildBlocked = result.packageResult?.kind === 'build-blocked'
    || /ERR_PNPM_IGNORED_BUILDS/u.test(error.diagnostic ?? '')
  if (buildBlocked) {
    const names = pending.length > 0 ? pending : blockedBuildNames(error.diagnostic ?? '')
    const listed = names.length === 0 ? 'Host 未给出名称（完整输出在 profile 的 pnpm 日志中）' : names.join('、')
    const next = pending.length > 0
      ? '确认允许这些依赖运行构建脚本后重试。'
      : `Host 未能自动记录这次拒绝；请在 profile 的 pnpm-workspace.yaml 中写入 allowBuilds（${names.length === 0
        ? '依赖名: true'
        : names.map(name => `${name}: true`).join('、')}），或运行 pnpm approve-builds 后重试。`
    return Object.freeze({
      applied: false,
      entry: result.target,
      ...(pending.length === 0 ? {} : { pendingBuilds: pending }),
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

function intakeAgreementCell(value: unknown) {
  const cell = record(value)
  const outcomes = record(cell['outcomes'])
  return {
    notifications: cell['notifications'], items: cell['items'], agreed: cell['agreed'], disagreed: cell['disagreed'],
    agreementPpm: cell['agreementPpm'],
    outcomes: Object.fromEntries(INTAKE_AGREEMENT_OUTCOMES.map(outcome => [outcome, outcomes[outcome]])),
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

const EVALUATION_MODULE = '@dsh-enhanced/assistant-evaluation'

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
