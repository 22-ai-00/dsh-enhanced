import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { Config } from './config.js'
import { CredentialLedger } from './ledger.js'
import { CredentialProviderError, readCredential, runCredentialCommand } from './providers.js'
import type {
  CredentialCommandRunner,
  CredentialHandle,
  CredentialLeaseMetadata,
  CredentialLeaseRecord,
  CredentialLeaseRequest,
  CredentialLeaseStatus,
} from './types.js'

export type CredentialsKeychainErrorCode =
  | 'consumer-denied'
  | 'disposed'
  | 'handle-not-found'
  | 'invalid-ttl'
  | 'lease-replayed'
  | 'policy-denied'
  | 'purpose-denied'

export class CredentialsKeychainError extends Error {
  constructor(readonly code: CredentialsKeychainErrorCode, message: string) {
    super(message)
    this.name = 'CredentialsKeychainError'
  }
}

export type CredentialLeaseAbortCode = 'disposed' | 'expired' | 'revoked'

export class CredentialLeaseAbortError extends Error {
  constructor(readonly code: CredentialLeaseAbortCode, message: string) {
    super(message)
    this.name = 'CredentialLeaseAbortError'
  }
}

export interface CredentialsKeychainServiceOptions {
  env?: Readonly<Record<string, string | undefined>>
  run?: CredentialCommandRunner
  now?: () => number
}

export interface CredentialCallbackLease {
  readonly id: string
  readonly handleId: string
  readonly consumer: string
  readonly purpose: string
  readonly expiresAt: number
}

function leaseMetadata(record: CredentialLeaseRecord): CredentialLeaseMetadata {
  return {
    id: record.id,
    handleId: record.handleId,
    consumer: record.consumer,
    purpose: record.purpose,
    status: record.status,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
    ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    version: record.version,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    credentialsKeychain: CredentialsKeychainService
  }
}

export class CredentialsKeychainService extends Service {
  static Config = Config

  private readonly ledger: CredentialLedger
  private readonly policy: AssistantPolicyService
  private readonly handles: ReadonlyMap<string, CredentialHandle>
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly run: CredentialCommandRunner
  private readonly defaultLeaseMs: number
  private readonly maxSecretBytes: number
  private readonly providerTimeoutMs: number
  private readonly controllers = new Map<string, AbortController>()
  private readonly operations = new Set<Promise<unknown>>()
  private active = true

  constructor(ctx: Context, input: import('./config.js').Config, options: CredentialsKeychainServiceOptions = {}) {
    super(ctx, 'credentialsKeychain')
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('credentials-keychain: assistantPolicy service is required')
    const config = Config(input) as Required<import('./config.js').Config>
    if (!isAbsolute(config.databasePath)) throw new Error('credentials-keychain: databasePath must be absolute')
    this.policy = policy
    this.handles = new Map(config.handles.map(handle => [handle.id, Object.freeze(handle)]))
    this.env = options.env ?? process.env
    this.run = options.run ?? runCredentialCommand
    this.defaultLeaseMs = config.defaultLeaseMs
    this.maxSecretBytes = config.maxSecretBytes
    this.providerTimeoutMs = config.providerTimeoutMs
    this.ledger = new CredentialLedger({ path: config.databasePath, ...(options.now === undefined ? {} : { now: options.now }) })
    ctx.effect(() => async () => {
      this.active = false
      for (const [leaseId, controller] of this.controllers) {
        const current = this.ledger.get(leaseId)
        if (current?.status === 'active') {
          this.ledger.settle({ leaseId, expectedVersion: current.version, status: 'failed', failureCode: 'service-disposed' })
        }
        controller.abort(new CredentialLeaseAbortError('disposed', 'credentials-keychain disposed'))
      }
      await Promise.allSettled(this.operations)
      this.ledger.close()
    }, 'credentials-keychain.ledger')
  }

  withSecret<T>(
    caller: Context,
    request: CredentialLeaseRequest,
    callback: (value: string, signal: AbortSignal, lease: CredentialCallbackLease) => Promise<T>,
  ): Promise<T> {
    this.assertActive()
    const operation = this.execute(caller, request, callback)
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }

  revoke(input: {
    operatorId: string
    leaseId: string
    expectedVersion: number
    reason: string
  }): CredentialLeaseMetadata {
    this.assertActive()
    const current = this.ledger.get(input.leaseId)
    if (current === undefined) throw new Error('credentials-keychain: lease does not exist')
    const decision = this.policy.authorize({
      subject: { kind: 'external', id: `local:${input.operatorId}` },
      action: 'credential.revoke',
      resource: { kind: 'credential', id: current.handleId },
      context: { initiator: 'foreground' },
    }, { idempotencyKey: `credential-revoke:${input.leaseId}:${input.expectedVersion}` })
    if (decision.effect !== 'allow') throw new CredentialsKeychainError('policy-denied',
      `credentials-keychain: policy denied revocation: ${decision.reasonCode}`)
    const revoked = this.ledger.revoke({ leaseId: input.leaseId, expectedVersion: input.expectedVersion,
      actor: `local:${input.operatorId}`, reason: input.reason })
    this.controllers.get(input.leaseId)?.abort(new CredentialLeaseAbortError('revoked', 'credential lease revoked'))
    return leaseMetadata(revoked)
  }

  listLeases(input: { status?: CredentialLeaseStatus; limit?: number } = {}): CredentialLeaseMetadata[] {
    this.assertActive()
    return this.ledger.list(input).map(leaseMetadata)
  }

  listHandles(): Array<Pick<CredentialHandle, 'consumers' | 'id' | 'maxLeaseMs' | 'provider' | 'purposes'>> {
    this.assertActive()
    return [...this.handles.values()].map(handle => ({
      id: handle.id,
      provider: handle.provider,
      consumers: [...handle.consumers],
      purposes: [...handle.purposes],
      maxLeaseMs: handle.maxLeaseMs,
    }))
  }

  health(): { handles: number; activeLeases: number; failedLeases: number } {
    this.assertActive()
    return {
      handles: this.handles.size,
      activeLeases: this.ledger.list({ status: 'active', limit: 1_000 }).length,
      failedLeases: this.ledger.list({ status: 'failed', limit: 1_000 }).length,
    }
  }

  private async execute<T>(
    caller: Context,
    request: CredentialLeaseRequest,
    callback: (value: string, signal: AbortSignal, lease: CredentialCallbackLease) => Promise<T>,
  ): Promise<T> {
    const consumer = caller.fiber.name
    const handle = this.handles.get(request.handleId)
    if (handle === undefined) throw new CredentialsKeychainError('handle-not-found', 'credential handle does not exist')
    if (!handle.consumers.includes(consumer)) {
      throw new CredentialsKeychainError('consumer-denied', 'caller is not allowlisted for this credential handle')
    }
    if (!handle.purposes.includes(request.purpose)) {
      throw new CredentialsKeychainError('purpose-denied', 'purpose is not allowlisted for this credential handle')
    }
    const ttlMs = request.ttlMs ?? Math.min(this.defaultLeaseMs, handle.maxLeaseMs)
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > handle.maxLeaseMs) {
      throw new CredentialsKeychainError('invalid-ttl', 'credential lease TTL exceeds the handle limit')
    }
    const decision = this.policy.authorize({
      subject: { kind: 'background', id: consumer },
      action: 'credential.use',
      resource: { kind: 'credential', id: handle.id },
      context: { initiator: 'background' },
    }, { idempotencyKey: `credential-use:${request.idempotencyKey}` })
    if (decision.effect !== 'allow') throw new CredentialsKeychainError('policy-denied',
      `credentials-keychain: policy denied use: ${decision.reasonCode}`)
    const begun = this.ledger.begin({ handleId: handle.id, consumer, purpose: request.purpose,
      idempotencyKey: request.idempotencyKey, ttlMs })
    if (begun.replayed) throw new CredentialsKeychainError('lease-replayed',
      `credential lease request was already ${begun.record.status}`)
    const controller = new AbortController()
    this.controllers.set(begun.record.id, controller)
    const timer = setTimeout(() => {
      const current = this.ledger.get(begun.record.id)
      if (current?.status === 'active') {
        this.ledger.settle({ leaseId: current.id, expectedVersion: current.version,
          status: 'expired', failureCode: 'lease-expired' })
      }
      controller.abort(new CredentialLeaseAbortError('expired', 'credential lease expired'))
    }, ttlMs)
    timer.unref?.()
    try {
      const value = await readCredential(handle, { env: this.env, run: this.run,
        timeoutMs: this.providerTimeoutMs, maxSecretBytes: this.maxSecretBytes })
      const result = await callback(value, controller.signal, {
        id: begun.record.id, handleId: handle.id, consumer, purpose: request.purpose,
        expiresAt: begun.record.expiresAt,
      })
      const current = this.ledger.get(begun.record.id)
      if (current?.status === 'active') {
        this.ledger.settle({ leaseId: current.id, expectedVersion: current.version,
          status: controller.signal.aborted ? 'expired' : 'completed',
          ...(controller.signal.aborted ? { failureCode: 'lease-expired' } : {}) })
      }
      return result
    } catch (error) {
      const current = this.ledger.get(begun.record.id)
      if (current?.status === 'active') {
        this.ledger.settle({ leaseId: current.id, expectedVersion: current.version,
          status: controller.signal.aborted ? 'expired' : 'failed',
          failureCode: controller.signal.aborted
            ? 'lease-expired'
            : error instanceof CredentialProviderError ? error.code : 'callback-failed' })
      }
      throw error
    } finally {
      clearTimeout(timer)
      this.controllers.delete(begun.record.id)
    }
  }

  private assertActive(): void {
    if (!this.active) throw new CredentialsKeychainError('disposed', 'credentials-keychain service is disposed')
  }
}
