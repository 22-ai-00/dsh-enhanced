import type { Fiber } from '@deepseek-ai/cordis'
import type { AssistantAutomationsService, Config as AutomationsConfig } from '@dsh-enhanced/assistant-automations'
import type { Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'

export type ScannerRetirementOperation = Parameters<AssistantAutomationsService['retireSystemOwned']>[0]
export type ScannerRetirementResult = ReturnType<AssistantAutomationsService['retireSystemOwned']>

const prefixes: Readonly<Record<string, string>> = {
  'assistant-growth-usage': 'usage-scan-',
  'assistant-memory-learning': 'memory-scan-',
  'plugin-control-plane-task-observations': 'task-observation-scan-',
  'plugin-control-plane-live-qualification': 'live-qualification-scan-',
}

/**
 * Internal installer writer for a stopped, privately staged Home. The caller
 * must bind the stage, effective configuration, revoked owner proof and exact
 * operations before entry, and independently verify the resulting transition.
 * Run inside the installer's bounded subprocess; this function does not acquire
 * a lifecycle lock, authorize a production Home, or attest its own mutations.
 *
 * Uses the same public Automations method as scanner guards. Policy emergency
 * stop, rules, original budget accounts, idempotency and audit all still apply.
 * A partial failure retains its original operation tuples; never derive new
 * versions or keys to retry. Audit entries append on authorized replay too.
 */
export async function applyScannerRetirementMaintenance(input: {
  policyConfig: PolicyConfig
  automationsConfig: AutomationsConfig
  operations: readonly ScannerRetirementOperation[]
  signal: AbortSignal
}): Promise<readonly ScannerRetirementResult[]> {
  const signal = input.signal
  signal.throwIfAborted()
  const { policyConfig, automationsConfig, operations } = structuredClone({
    policyConfig: input.policyConfig, automationsConfig: input.automationsConfig, operations: input.operations,
  })
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 4) {
    throw new Error('scanner retirement maintenance requires one to four frozen operations')
  }
  const owners = new Set<string>()
  for (const operation of operations) {
    const prefix = Object.hasOwn(prefixes, operation.owner) ? prefixes[operation.owner] : undefined
    if (prefix === undefined || owners.has(operation.owner)
      || !new RegExp(`^${prefix}[a-f0-9]{64}$`, 'u').test(operation.automationId)
      || !/^[a-f0-9]{64}$/u.test(operation.definitionHash) || !/^[a-f0-9]{64}$/u.test(operation.evidenceDigest)
      || !/^owner-revoked:[a-f0-9]{64}$/u.test(operation.operationId) || operation.reason !== 'owner-revoked'
      || !Number.isSafeInteger(operation.expectedVersion) || operation.expectedVersion < 1) {
      throw new Error('invalid frozen scanner retirement operation')
    }
    owners.add(operation.owner)
  }
  // Optional peers are loaded only for this explicitly invoked installer path.
  const [{ Context }, { AssistantPolicyService }, { AssistantAutomationsService }] = await Promise.all([
    import('@deepseek-ai/cordis'), import('@dsh-enhanced/assistant-policy'), import('@dsh-enhanced/assistant-automations'),
  ])
  signal.throwIfAborted()
  const policy = AssistantPolicyService.Config(policyConfig)
  const automations = AssistantAutomationsService.Config(automationsConfig)
  const context = new Context()
  const errors: unknown[] = []
  const results: ScannerRetirementResult[] = []
  const removeLogger = context.logger.exporter({ export(message) {
    // The pinned Cordis fork reports disposer errors here instead of rejecting
    // Fiber.dispose(). They must not be mistaken for successful quiescence.
    if (message.type === 'error') errors.push(new Error('scanner retirement service lifecycle failed', { cause: message.args[0] }))
  } })
  let policyFiber: Fiber | undefined
  let automationsFiber: Fiber | undefined
  try {
    policyFiber = context.plugin(AssistantPolicyService, { ...policy, proposalMaintenanceIntervalMs: 0 })
    await policyFiber.await()
    if (!context.get('assistantPolicy')) throw new Error('retirement Policy service is unavailable')
    signal.throwIfAborted()
    automationsFiber = context.plugin(AssistantAutomationsService, {
      ...automations, schedulerEnabled: false, reconcileIntervalMs: 0,
    })
    await automationsFiber.await()
    if (!context.get('assistantAutomations')) throw new Error('retirement Automations service is unavailable')
    for (const operation of operations) {
      signal.throwIfAborted()
      results.push(context.assistantAutomations.retireSystemOwned(operation))
    }
    signal.throwIfAborted()
  } catch (error) {
    errors.push(error)
  } finally {
    // Stop the dependent service before its Policy provider. Root effects can
    // dispose concurrently, so a root-only dispose is insufficient here.
    for (const fiber of [automationsFiber, policyFiber, context.fiber]) {
      try { await fiber?.dispose() } catch (error) { errors.push(error) }
    }
    removeLogger()
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'scanner retirement maintenance did not settle cleanly')
  return Object.freeze(results.map(result => Object.freeze(structuredClone(result))))
}
