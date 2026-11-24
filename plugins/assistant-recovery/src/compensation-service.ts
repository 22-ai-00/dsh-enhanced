import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { CompensationExecutor } from './compensation-executor.js'
import { CompensationLedger } from './compensation-ledger.js'
import { CompensationRegistry } from './compensation-registry.js'
import {
  RecoveryCompensationError,
  type CompensationAuditEntry,
  type CompensationExecutionResult,
  type CompensationQueryFilter,
  type CompensationRecordInput,
  type CompensatorDescriptor,
  type CompensatorHandler,
  type ExecuteCompensationOptions,
  type PublicCompensationStatus,
  type RecoveryCompensationPort,
} from './compensation-types.js'

export interface AssistantCompensationConfig {
  databasePath?: string
  maxStepDurationMs?: number
}

export const CompensationServiceConfigSchema = Schema.object({
  databasePath: Schema.string().default(':memory:'),
  maxStepDurationMs: Schema.number().step(1).min(100).max(60_000).default(10_000),
}) as Schema<AssistantCompensationConfig>

export class AssistantCompensationService extends Service implements RecoveryCompensationPort {
  static Config = CompensationServiceConfigSchema
  static inject: readonly string[] = []

  readonly registry: CompensationRegistry
  private readonly ledger: CompensationLedger
  private readonly executor: CompensationExecutor
  private active = true

  constructor(ctx: Context, input: AssistantCompensationConfig = {}) {
    super(ctx, 'assistantCompensation')
    const parsed = CompensationServiceConfigSchema(input) as Required<AssistantCompensationConfig>
    if (parsed.databasePath !== ':memory:' && !isAbsolute(parsed.databasePath)) {
      throw new RecoveryCompensationError(
        'invalid-input',
        'assistant-compensation databasePath must be :memory: or an absolute path',
      )
    }
    this.registry = new CompensationRegistry()
    this.ledger = new CompensationLedger({ path: parsed.databasePath })
    try {
      this.ledger.recoverIncomplete()
      this.executor = new CompensationExecutor(this.registry, this.ledger, {
        defaultTimeoutMs: parsed.maxStepDurationMs,
      })
    } catch (error) {
      this.ledger.close()
      throw error
    }

    ctx.effect(() => async () => {
      this.active = false
      await this.executor.dispose()
      this.registry.clear()
      this.ledger.close()
    }, 'assistant-compensation.runtime')
  }

  registerCompensator = (
    handler: CompensatorHandler,
    options: { readonly replace?: boolean; readonly ownerCtx?: Context } = {},
  ): (() => void) => {
    this.assertActive()
    return this.registry.register(handler, options)
  }

  hasCompensator = (kind: string): boolean => {
    this.assertActive()
    return this.registry.has(kind)
  }

  listCompensators = (): readonly CompensatorDescriptor[] => {
    this.assertActive()
    return this.registry.list()
  }

  executeCompensation = async (
    record: CompensationRecordInput,
    options?: ExecuteCompensationOptions,
  ): Promise<CompensationExecutionResult> => {
    this.assertActive()
    return await this.executor.executeCompensation(record, options)
  }

  getCompensationStatus = (
    idOrKey: { readonly id?: string; readonly idempotencyKey?: string },
  ): PublicCompensationStatus | undefined => {
    this.assertActive()
    if (idOrKey.id !== undefined) return this.ledger.getById(idOrKey.id)
    if (idOrKey.idempotencyKey !== undefined) return this.ledger.getByIdempotencyKey(idOrKey.idempotencyKey)
    throw new RecoveryCompensationError('invalid-input', 'id or idempotencyKey is required')
  }

  listCompensations = (filter?: CompensationQueryFilter): readonly PublicCompensationStatus[] => {
    this.assertActive()
    return this.ledger.list(filter)
  }

  listCompensationAudit = (compensationId: string): readonly CompensationAuditEntry[] => {
    this.assertActive()
    return this.ledger.listAudit(compensationId)
  }

  async whenIdle(): Promise<void> {
    this.assertActive()
    await this.executor.whenIdle()
  }

  private assertActive(): void {
    if (!this.active) {
      throw new RecoveryCompensationError('disposed', 'assistant-compensation service is disposed')
    }
  }
}
