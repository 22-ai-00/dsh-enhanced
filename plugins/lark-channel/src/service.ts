import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { type AssistantDeliveryService, DeliveryAdapterRegistryStoppedError } from '@dsh-enhanced/assistant-delivery'
import { LarkDeliveryAdapter } from './adapter.js'
import { Config } from './config.js'
import { createOfficialLarkTransport, type OfficialLarkTransportOptions } from './sdk.js'
import type { LarkChannelHealth, LarkTransport } from './types.js'

export interface LarkChannelServiceOptions {
  env?: Readonly<Record<string, string | undefined>>
  createTransport?: (options: OfficialLarkTransportOptions) => LarkTransport
  writeLifecycleMarker?: (marker: LarkLifecycleMarker) => void
}

export type LarkLifecycleMarker = 'lark-channel: connected' | 'lark-channel: disconnected'

/** Emit one exact marker to stdout so systemd captures it in this Invocation's journal. */
export function writeLarkLifecycleMarker(marker: LarkLifecycleMarker): void {
  console.info(marker)
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

async function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

export class LarkChannelService extends Service {
  static Config = Config

  private readonly ready = deferred()
  private readonly stopController = new AbortController()
  private readonly lifecycle: Promise<void>
  private adapter: LarkDeliveryAdapter | undefined
  private transport: LarkTransport | undefined
  private transportSignal: AbortSignal | undefined
  private readonly allowedCalendarIds: ReadonlySet<string>
  private disabled = false
  private active = true

  constructor(ctx: Context, input: import('./config.js').Config, options: LarkChannelServiceOptions = {}) {
    super(ctx, 'larkChannel')
    const delivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    if (delivery === undefined) throw new Error('lark-channel: assistantDelivery service is required')
    const config = Config(input) as Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>
    this.allowedCalendarIds = new Set(config.allowedCalendarIds)
    if (!config.enabled) {
      this.disabled = true
      this.lifecycle = Promise.resolve()
      this.ready.resolve()
      ctx.effect(() => () => { this.active = false }, 'lark-channel.disabled')
      return
    }
    const createTransport = options.createTransport ?? createOfficialLarkTransport
    const lifecycleMarker = options.writeLifecycleMarker ?? writeLarkLifecycleMarker
    if (config.credentialHandle !== undefined) {
      const credentials = ctx.get('credentialsKeychain') as CredentialLeaseService | undefined
      if (credentials === undefined) {
        throw new Error('lark-channel: credentialsKeychain service is required for credentialHandle')
      }
      this.lifecycle = this.runCredentialLifecycle(
        ctx, credentials, delivery, config, createTransport, lifecycleMarker,
      )
    } else {
      const envName = config.appSecretEnv
      const appSecret = envName === undefined ? undefined : (options.env ?? process.env)[envName]
      if (appSecret === undefined || appSecret.trim().length === 0) {
        throw new Error(`lark-channel: secret environment variable ${String(envName)} is missing or empty`)
      }
      this.lifecycle = this.runAdapter(delivery, config, createTransport, appSecret, undefined, lifecycleMarker)
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

  /** Read one exact Calendar v4 page without disclosing the app credential. */
  async readCalendarEventPage(input: Readonly<{
    calendarId: string
    startTime: number
    endTime: number
    pageSize: number
    pageToken?: string
    signal: AbortSignal
  }>): Promise<unknown> {
    this.assertActive()
    this.assertCalendarAccess(input.calendarId)
    await awaitWithAbort(this.ready.promise, AbortSignal.any([input.signal, this.stopController.signal]))
    this.assertActive()
    this.assertCalendarAccess(input.calendarId)
    if (input.signal.aborted) throw input.signal.reason
    const transport = this.transport, transportSignal = this.transportSignal
    if (transport?.readCalendarEventPage === undefined || transportSignal === undefined) {
      throw new Error('lark-channel: Calendar v4 read capability is unavailable')
    }
    const signal = AbortSignal.any([input.signal, this.stopController.signal, transportSignal])
    signal.throwIfAborted()
    const result = await transport.readCalendarEventPage({ ...input, signal })
    signal.throwIfAborted()
    if (this.transport !== transport || this.transportSignal !== transportSignal) throw new Error('lark-channel: Calendar credential generation ended')
    this.assertActive()
    this.assertCalendarAccess(input.calendarId)
    if (input.signal.aborted) throw input.signal.reason
    return result
  }

  private async runAdapter(
    delivery: AssistantDeliveryService,
    config: Required<Omit<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>>
      & Pick<import('./config.js').Config, 'appSecretEnv' | 'credentialHandle'>,
    createTransport: (options: OfficialLarkTransportOptions) => LarkTransport,
    appSecret: string,
    credentialSignal?: AbortSignal,
    lifecycleMarker: (marker: LarkLifecycleMarker) => void = writeLarkLifecycleMarker,
  ): Promise<void> {
    const transport = createTransport({
      appId: config.appId,
      appSecret,
      domain: config.domain,
      handshakeTimeoutMs: config.handshakeTimeoutMs,
      requestTimeoutMs: config.requestTimeoutMs,
      imageDownloadTimeoutMs: config.imageDownloadTimeoutMs,
    })
    const generation = new AbortController()
    this.transportSignal = AbortSignal.any([generation.signal, this.stopController.signal, ...(credentialSignal ? [credentialSignal] : [])])
    this.transport = transport
    const adapter = new LarkDeliveryAdapter({
      account: config.account,
      tenant: config.tenant,
      requireMentionInGroups: config.requireMentionInGroups,
      maxTextBytes: config.maxTextBytes,
      staleAfterMs: config.staleAfterMs,
    }, transport, {
      // These exact stdout markers are consumed from one fresh systemd
      // Invocation journal. Cordis' built-in logger only buffers unless a
      // console exporter is installed, so it cannot be the readiness source.
      onConnected: () => lifecycleMarker('lark-channel: connected'),
      onDisconnected: () => lifecycleMarker('lark-channel: disconnected'),
      approvalSecret: appSecret,
      showProgress: config.showProgress,
      progressDetails: config.progressDetails,
      statusReactions: config.statusReactions,
      userQuestionTtlMs: config.userQuestionTtlMs,
      settleApproval: value => delivery.settleApproval(value),
      recoverApprovalSettlement: value => delivery.recoverApprovalSettlement(value),
      settleModelSelection: value => delivery.settleModelSelection(value),
      awaitModelSelection: (value, signal) => delivery.awaitModelSelection(value, signal),
      settlePermissionSelection: value => delivery.settlePermissionSelection(value),
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
      // A stopped registry means the whole plugin tree is tearing down (often
      // because an earlier plugin failed to load, e.g. the web server hit
      // EADDRINUSE). Registering our adapter into that teardown is not the real
      // failure, so do not re-throw it as this service's fatal cause and mask
      // the true one; settle ready and unwind quietly.
      if (error instanceof DeliveryAdapterRegistryStoppedError) {
        this.ready.resolve()
        return
      }
      this.ready.reject(error)
      throw error
    } finally {
      generation.abort(new Error('lark-channel credential generation ended'))
      if (this.transport === transport) { this.transport = undefined; this.transportSignal = undefined }
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
    lifecycleMarker: (marker: LarkLifecycleMarker) => void,
  ): Promise<void> {
    while (!this.stopController.signal.aborted) {
      let renew = false
      await credentials.withSecret(ctx, {
        handleId: config.credentialHandle!,
        purpose: config.credentialPurpose,
        ttlMs: config.credentialLeaseMs,
        idempotencyKey: `lark-channel:${config.account}:lease:${randomUUID()}`,
      }, async (appSecret, credentialSignal) => {
        await this.runAdapter(delivery, config, createTransport, appSecret, credentialSignal, lifecycleMarker)
        renew = credentialSignal.aborted && credentialLeaseAbortCode(credentialSignal.reason) === 'expired'
      })
      if (!renew) return
    }
  }

  private assertActive(): void {
    if (!this.active) throw new Error('lark-channel service is disposed')
  }

  private assertCalendarAccess(calendarId: string): void {
    if (!this.allowedCalendarIds.has(calendarId)) {
      throw new Error('lark-channel: Calendar ID is not explicitly authorized')
    }
  }
}

export const LarkConfig = Config
