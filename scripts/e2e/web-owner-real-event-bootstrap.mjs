import { createHash } from 'node:crypto'

export const name = 'dsh-enhanced-web-owner-real-event-bootstrap'
export const inject = ['assistantAutomations']

const executorId = 'web-owner-real-event-source/v1'
const catalogDigest = createHash('sha256').update(JSON.stringify({
  protocol: executorId, operation: 'record-untrusted-file-observation', version: 1,
})).digest('hex')

function input() {
  const raw = process.env.DSH_WEB_REAL_EVENT_BOOTSTRAP
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('real event bootstrap configuration is absent')
  let value
  try { value = JSON.parse(raw) } catch { throw new Error('real event bootstrap configuration is invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.workspace !== 'string' || !value.workspace.startsWith('/')
    || typeof value.principal !== 'string' || value.principal.length === 0
    || typeof value.ownerRouteId !== 'string' || value.ownerRouteId.length === 0) {
    throw new Error('real event bootstrap configuration is invalid')
  }
  return value
}

/** A real, bounded Host executor for the ordinary source automation. It has no model or tool lane. */
export function apply(ctx) {
  // The first Host must establish a genuine browser binding before the exact
  // persisted owner route can be configured. It deliberately has no ordinary
  // source automation until the second Host supplies this test-only config.
  if (process.env.DSH_WEB_REAL_EVENT_BOOTSTRAP === undefined) return
  const config = input()
  ctx.inject(['assistantAutomations'], runtime => {
    const automations = runtime.assistantAutomations
    const dispose = automations.registerHostExecutor({
      descriptor: { executorId, contractVersion: 1, catalogDigest },
      accepts: spec => spec.executorId === executorId && spec.executorContractVersion === 1
        && spec.catalogDigest === catalogDigest && spec.runbookId === 'record-untrusted-file-observation'
        && spec.runbookVersion === 1,
      async execute(execution) {
        if (execution.signal.aborted) throw execution.signal.reason
        return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
          sideEffectState: 'none', retryability: 'safe' }
      },
    })
    automations.reconcileSystem({
      owner: executorId, automationId: 'web-owner-real-event-source',
      idempotencyKey: 'web-owner-real-event-source:v1', desiredStatus: 'active',
      definition: {
        name: 'Record real event experiment file observations',
        schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z' },
        workspace: config.workspace, agentPreset: 'standard', timeoutMs: 30_000,
        misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
        principal: config.principal, budgetId: 'real-event-source-runs', budgetAmount: 1,
        execution: {
          kind: 'host', executorId, executorContractVersion: 1,
          runbookId: 'record-untrusted-file-observation', runbookVersion: 1, catalogDigest,
          targetScope: { workspace: config.workspace, preset: 'standard' }, scopeDigest: '0'.repeat(64),
          ownerRouteId: config.ownerRouteId, activationNonce: 'web-owner-real-event-source:v1',
        },
      },
    })
    return dispose
  })
}
