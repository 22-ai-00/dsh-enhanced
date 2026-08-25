import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { LarkDeliveryAdapter } from './adapter.js'
import { Config } from './config.js'
import { createOfficialLarkTransport, type OfficialLarkTransportOptions } from './sdk.js'
import type { LarkChannelHealth, LarkTransport } from './types.js'

export interface LarkChannelServiceOptions {
  env?: Readonly<Record<string, string | undefined>>
  createTransport?: (options: OfficialLarkTransportOptions) => LarkTransport
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    larkChannel: LarkChannelService
  }
}

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

interface CredentialLeaseService {
  withSecret<T>(
    caller: Context,
    request: { handleId: string; purpose: string; ttlMs: number; idempotencyKey: string },
    callback: (value: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T>
}

function credentialLeaseAbortCode(reason: unknown): 'disposed' | 'expired' | 'revoked' | undefined {
  if (reason === null || typeof reason !== 'object') return undefined
  const value = reason as { name?: unknown; code?: unknown }
  if (value.name !== 'CredentialLeaseAbortError') return undefined
  return value.code === 'disposed' || value.code === 'expired' || value.code === 'revoked'
    ? value.code
    : undefined
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function waitForAbort(signals: readonly AbortSignal[]): Promise<void> {
  if (signals.some(signal => signal.aborted)) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      for (const signal of signals) signal.removeEventListener('abort', done)
      resolve()
    }
    for (const signal of signals) signal.addEventListener('abort', done, { once: true })
  })
}

export class LarkChannelService extends Service {
  static Config = Config

  private readonly ready = deferred()
  private readonly stopController = new AbortController()
  private readonly lifecycle: Promise<void>
  private adapter: LarkDeliveryAdapter | undefined
  private disabled = false
  private active = true

  constructor(ctx: Context, input: import('./config.js').Config, options: LarkChannelServiceOptions = {}) {
    super(ctx, 'larkChannel')
    const delivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    if (delivery === undefined) throw new Error('lark-channel: assistantDelivery service is required')
    const config = Config(input) as Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>
    if (!config.enabled) {
      this.disabled = true
      this.lifecycle = Promise.resolve()
      this.ready.resolve()
      ctx.effect(() => () => { this.active = false }, 'lark-channel.disabled')
      return
    }
    const createTransport = options.createTransport ?? createOfficialLarkTransport
    if (config.credentialHandle !== undefined) {
      const credentials = ctx.get('credentialsKeychain') as CredentialLeaseService | undefined
      if (credentials === undefined) {
        throw new Error('lark-channel: credentialsKeychain service is required for credentialHandle')
      }
      this.lifecycle = this.runCredentialLifecycle(ctx, credentials, delivery, config, createTransport)
    } else {
      const envName = config.appSecretEnv
      const appSecret = envName === undefined ? undefined : (options.env ?? process.env)[envName]
      if (appSecret === undefined || appSecret.trim().length === 0) {
        throw new Error(`lark-channel: secret environment variable ${String(envName)} is missing or empty`)
      }
      this.lifecycle = this.runAdapter(delivery, config, createTransport, appSecret)
    }
    void this.lifecycle.catch(error => this.ready.reject(error))
    ctx.effect(() => async () => {
      this.active = false
      this.stopController.abort(new Error('lark-channel stopped'))
      await this.lifecycle.catch(() => {})
    }, 'lark-channel.transport')
  }

  async whenReady(): Promise<void> {
    this.assertActive()
    await this.ready.promise
  }

  health(): LarkChannelHealth {
    this.assertActive()
    return this.adapter?.health() ?? {
      state: this.disabled ? 'disabled' : this.stopController.signal.aborted ? 'disconnected' : 'connecting',
      gapGeneration: 0,
    }
  }

  private async runAdapter(
    delivery: AssistantDeliveryService,
    config: Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>,
    createTransport: (options: OfficialLarkTransportOptions) => LarkTransport,
    appSecret: string,
    credentialSignal?: AbortSignal,
  ): Promise<void> {
    const transport = createTransport({
      appId: config.appId,
      appSecret,
      domain: config.domain,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
    })
    const adapter = new LarkDeliveryAdapter({
      account: config.account,
      tenant: config.tenant,
      requireMentionInGroups: config.requireMentionInGroups,
      maxTextBytes: config.maxTextBytes,
      staleAfterMs: config.staleAfterMs,
    }, transport, {
      approvalSecret: appSecret,
      showProgress: config.showProgress,
      statusReactions: config.statusReactions,
      settleApproval: value => delivery.settleApproval(value),
      recoverApprovalSettlement: value => delivery.recoverApprovalSettlement(value),
      settleModelSelection: value => delivery.settleModelSelection(value),
      loadModelPicker: value => delivery.getModelPickerForCallback(value),
      advanceModelPicker: value => delivery.advanceModelPickerForCallback(value),
    })
    this.adapter = adapter
    let unregister: (() => Promise<void>) | undefined
    try {
      unregister = await delivery.registerAdapter(adapter)
      this.ready.resolve()
      await waitForAbort(credentialSignal === undefined
        ? [this.stopController.signal]
        : [this.stopController.signal, credentialSignal])
    } catch (error) {
      this.ready.reject(error)
      throw error
    } finally {
      await unregister?.()
    }
  }

  private async runCredentialLifecycle(
    ctx: Context,
    credentials: CredentialLeaseService,
    delivery: AssistantDeliveryService,
    config: Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>,
    createTransport: (options: OfficialLarkTransportOptions) => LarkTransport,
  ): Promise<void> {
    while (!this.stopController.signal.aborted) {
      let renew = false
      await credentials.withSecret(ctx, {
        handleId: config.credentialHandle!,
        purpose: config.credentialPurpose,
        ttlMs: config.credentialLeaseMs,
        idempotencyKey: `lark-channel:${config.account}:lease:${randomUUID()}`,
      }, async (appSecret, credentialSignal) => {
        await this.runAdapter(delivery, config, createTransport, appSecret, credentialSignal)
        renew = credentialSignal.aborted && credentialLeaseAbortCode(credentialSignal.reason) === 'expired'
      })
      if (!renew) return
    }
  }

  private assertActive(): void {
    if (!this.active) throw new Error('lark-channel service is disposed')
  }
}

export const LarkConfig = Config
