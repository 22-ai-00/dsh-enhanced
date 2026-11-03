import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OwnerConsoleConfig } from './index.js'
import {
  boundedConfig, configFacts, findEntry, isAppId, isEntryId, isEnvName, isProjectBundle, isSecretRef,
  type SettingsDescriptor, type SettingsService,
} from './settings.js'
import type { OwnerConsoleStatus, OwnerConsoleWriteResult } from './typert.js'

/** Companions worth surfacing; a missing one is a setup hint, never a hard failure. */
const DEPENDENCIES = ['assistantPolicy', 'assistantDelivery', 'assistantSkills'] as const
const LARK = /(^|[-_/])lark(-channel)?($|[-_/])/u
const TRAEX = /traex/iu
const APP_ID_ENV = ['LARK_APP_ID', 'FEISHU_APP_ID'] as const

/** Read-only status plus owner-clicked, one-step writes through the Host settings service. */
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

  status(): OwnerConsoleStatus {
    const entries = this.descriptors()
    const lark = findEntry(entries, ns => LARK.test(ns))
    const traex = findEntry(entries, ns => TRAEX.test(ns))
    const larkValue = configFacts(lark?.value)
    const traexValue = configFacts(traex?.value)
    return Object.freeze({
      feishu: Object.freeze({
        ...(lark === undefined ? {} : { entry: lark.ns }),
        mode: this.config.feishuMode,
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
      bundles: Object.freeze(entries.filter(entry => isProjectBundle(entry.ns)).map(entry => Object.freeze({
        entry: entry.ns,
        enabled: configFacts(entry.value)['enabled'] === true,
        config: Object.freeze(configFacts(entry.value)),
      }))),
    })
  }

  /** Feishu: one owner click writes only the lark-channel entry; no plaintext secret is accepted. */
  async configureFeishu(mode: 'lark-cli' | 'app', appId: string, appSecretEnv: string,
    credentialHandle: string, account: string, tenant: string): Promise<OwnerConsoleWriteResult> {
    if (mode !== 'lark-cli' && mode !== 'app') throw new Error('unsupported Feishu mode')
    const settings = this.settings()
    const descriptors = this.descriptors()
    const lark = findEntry(descriptors, ns => LARK.test(ns))
    if (lark === undefined) throw new Error('lark-channel is not installed in this profile')
    const discovered = mode === 'lark-cli' && appId === ''
      ? APP_ID_ENV.map(name => process.env[name]).find(value => isAppId(value))
      : undefined
    const resolvedAppId = appId === '' ? discovered : appId
    if (!isAppId(resolvedAppId)) {
      throw new Error(mode === 'lark-cli'
        ? '一键模式需要 Host 环境中的 LARK_APP_ID 或 FEISHU_APP_ID；否则请填写 appId'
        : 'appId must look like cli_0123456789abcdef')
    }
    const hasEnv = appSecretEnv !== ''
    const hasHandle = credentialHandle !== ''
    if (hasEnv === hasHandle) throw new Error('provide exactly one secret reference: appSecretEnv or credentialHandle')
    if (hasEnv && !isEnvName(appSecretEnv)) throw new Error('appSecretEnv must be an environment variable name')
    if (hasHandle && !isSecretRef(credentialHandle)) throw new Error('credentialHandle is invalid')
    const owner = account === '' ? 'feishu' : account
    const tenantValue = tenant === '' ? 'feishu' : tenant
    for (const value of [owner, tenantValue]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u.test(value)) throw new Error('account and tenant must be simple identifiers')
    }
    await settings.update(lark.ns, {
      enabled: true, appId: resolvedAppId, account: owner, tenant: tenantValue,
      ...(hasEnv ? { appSecretEnv } : {}), ...(hasHandle ? { credentialHandle } : {}),
    }, lark.revision)
    return Object.freeze({ applied: true, entry: lark.ns,
      note: hasHandle ? 'secret stays in the credentials keychain' : 'secret stays in the named environment variable' })
  }

  /** TraeX: one owner click toggles the local provider row; command is optional. */
  async configureTraex(enabled: boolean, command: string): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    const traex = findEntry(this.descriptors(), ns => TRAEX.test(ns))
    if (traex === undefined) throw new Error('traex-acp-provider is not installed in this profile')
    if (command !== '' && (command.length > 1_024 || /[\r\n]/u.test(command))) throw new Error('command must be one bounded line')
    await settings.update(traex.ns, { enabled, ...(command === '' ? {} : { command }) }, traex.revision)
    return Object.freeze({ applied: true, entry: traex.ns, note: enabled ? 'TraeX row enabled' : 'TraeX row disabled' })
  }

  /** Project bundles only: merge one JSON object into the named entry's configuration. */
  async configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<OwnerConsoleWriteResult> {
    const settings = this.settings()
    if (!isEntryId(entry) || !isProjectBundle(entry)) throw new Error('only this project\'s dsh-enhanced bundles can be configured here')
    const target = findEntry(this.descriptors(), ns => ns === entry)
    if (target === undefined) throw new Error('the named profile entry is not installed')
    const patch = boundedConfig(config)
    await settings.update(entry, patch, target.revision)
    return Object.freeze({ applied: true, entry, note: 'configuration merged; the running entry reloads through settings' })
  }
}

