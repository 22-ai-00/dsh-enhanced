/**
 * `acceptance.bindWorkerRun` + `acceptance.autoSettle` against the real peer
 * chain: real assistant-policy, real assistant-delivery (owner route and the
 * Host-only `inspectOwnerRouteBinding`), real assistant-automations (external
 * ingest, the frozen run contract and the Host-only
 * `inspectOccurrenceAcceptance`) and real assistant-verifier
 * (`inspectAcceptedTask` and a done receipt from a real child-process
 * criterion). No model, network or timer: every scheduler wake is the real
 * Automations wake, invoked directly with `schedulerEnabled: false`.
 *
 * What stays synthetic, and why:
 * - The native agent run. `DshAutomationRunner` would need a model to execute
 *   the worker prompt, so the task lifecycle (claim/start/complete/quiescent)
 *   is driven at the Automations store, and the run's acceptance preparation
 *   is the runner's own sequence replayed by hand: the real
 *   `assistantDelivery.prepareAgentApproval(agent)` resolves the owner and
 *   binding, then the real (private) `prepareTaskAcceptance` freezes the
 *   contract through the real verifier registration.
 * - The agents. `prepareAgentApproval` gets a structural agent naming the
 *   owner's bound session; work-items `claim`/`report` get a structural worker
 *   agent carrying the `assistantAutomationExecution` the runner would install.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantDeliveryService, type OwnerRouteAuthority } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantVerifierService, createVerifierAuthorities } from '@dsh-enhanced/assistant-verifier'
import type { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import type { Config } from '../src/config.ts'
import { AssistantWorkItemsService } from '../src/service.ts'
import { WorkItemStore } from '../src/store.ts'

const WORKER = 'work-items-worker'
const SOURCE = 'work-items/v1'
const PRESET = 'primary'
const ROUTE = 'route-1'
const PROMPT = 'Write the accepted result.'
const roots: string[] = []
const closers: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Minimal store surface of the real Automations service this test drives. */
interface AutomationsInternals {
  store: {
    createApproved(input: { automationId: string; idempotencyKey: string; definition: unknown }): unknown
    listTasks(input: { automationId: string; limit: number }): Array<{ id: string; occurrenceId: string }>
    acquireDuty(input: { ownerId: string; now: number; leaseMs: number }): { fencingToken: number }
    claimTask(input: { taskId: string; ownerId: string; fencingToken: number; now: number; leaseMs: number }): unknown
    startTask(input: { taskId: string; ownerId: string; fencingToken: number; now: number; leaseMs: number; sessionId: string }): unknown
    completeTask(input: { taskId: string; ownerId: string; fencingToken: number; now: number; outcome: 'succeeded'; outputPreview: string; usage: object }): unknown
    markAcceptedTaskQuiescent(taskId: string, quiescent: boolean): unknown
  }
  coordinator: { ownerId: string }
  prepareTaskAcceptance(input: unknown): void
  notifySchedulerWake(): void
}

function workerAgent(workspace: string, occurrenceId: string): Agent {
  const execution = Object.freeze({ mode: 'production', automationId: WORKER, occurrenceId })
  return {
    ctx: { get: (name: string) => name === 'assistantAutomationExecution' ? execution : undefined },
    session: { header: { cwd: workspace, agentPreset: PRESET } },
  } as unknown as Agent
}

function boundEvents(root: string, itemId: string): number {
  const db = new DatabaseSync(join(root, 'state', 'state.sqlite'), { readOnly: true })
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM work_item_event WHERE item_id = ? AND kind = 'acceptance-bound'").get(itemId) as { count: number }
    return Number(row.count)
  } finally { db.close() }
}

test('binds a real Automations worker run to its real verifier contract and settles from the real done receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-real-chain-'))
  roots.push(root)
  // The verifier's process criterion reads this artifact from the workspace.
  await writeFile(join(root, 'result.txt'), 'verified')
  const ctx = new Context()
  closers.push(() => ctx.fiber.dispose().then(() => undefined))

  const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
  const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
  const principalId = 'lark/bot-1/tenant-a/ou_owner'

  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'), proposalMaintenanceIntervalMs: 0, budgets: [],
    rules: [
      { id: 'work-items-admit', effect: 'allow', subject: { kind: 'background', id: SOURCE, workspace: root, principal: principalId }, actions: ['admit'], resource: { kind: 'automation', id: WORKER } },
      { id: 'work-items-ingest', effect: 'allow', subject: { kind: 'external', id: SOURCE }, actions: ['ingest'], resource: { kind: 'automation', id: WORKER } },
      { id: 'work-items-notify', effect: 'allow', subject: { kind: 'background', id: SOURCE, workspace: root, principal: principalId }, actions: ['send'], resource: { kind: 'message', id: '*' }, context: { initiators: ['background'] } },
    ],
  })

  const authority: OwnerRouteAuthority = { id: ROUTE, conversation, principal, workspace: root, agentPreset: PRESET,
    policyRef: 'owner-dm', minimumGeneration: 1 }
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'),
    schedulerEnabled: false, ownerRoutes: [authority] }).await()
  const delivery = ctx.assistantDelivery
  const deliveryStore = (delivery as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  deliveryStore.ensureOwner(principal)
  deliveryStore.createBinding({ conversation, principal, workspace: root, agentPreset: PRESET, policyRef: 'owner-dm', sessionId: 'owner-session-1' })
  const owner = deliveryStore.getPrincipal(principal)!

  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
    allowUnbudgetedExecution: true,
  })
  const automations = ctx.assistantAutomations as unknown as AutomationsInternals
  automations.store.createApproved({ automationId: WORKER, idempotencyKey: 'create:worker', definition: {
    name: 'Work items worker', prompt: PROMPT,
    schedule: { kind: 'at', at: '2026-08-21T10:01:00.000Z' },
    workspace: root, agentPreset: PRESET, provider: 'mock', model: 'mock-model',
    allowedTools: [], timeoutMs: 60_000, maxOutputTokens: 512, maxToolCalls: 0,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'idempotent', maxRetries: 2, principal: principalId,
  } })

  // The verifier profile is pinned to the real Delivery owner's identity.
  const runner = {
    kind: 'runner' as const, id: 'read-result', executable: process.execPath,
    fixedArgs: ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))"],
    timeoutMs: 5_000, maxOutputBytes: 1_024,
  }
  const authorities = createVerifierAuthorities({ authorities: [runner] })
  const verifier = new AssistantVerifierService(ctx, {
    databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, requireAcceptance: true,
    authorities: [runner],
    profiles: [{
      id: 'work-item-result', version: 1,
      scope: { workspace: root, preset: PRESET }, owner: { principalRecordId: owner.id, principalVersion: owner.version },
      taskKind: 'automation-run' as const, objective: PROMPT, validityMs: 600_000,
      bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
      criteria: [{ id: 'result', kind: 'process-behavior' as const, authority: { id: runner.id, digest: authorities[0]!.digest },
        artifactPath: 'result.txt', stdin: '', expectedStdout: 'verified', expectedExitCode: 0 }],
    }],
  })
  await new Promise<void>(resolve => setImmediate(resolve))

  const config: Config = {
    enabled: true, mode: 'active', databasePath: join(root, 'state', 'state.sqlite'), workRoot: join(root, 'work'),
    intakeSourceId: SOURCE, workerAutomationId: WORKER,
    scope: { workspace: root, preset: PRESET, principalId, ownerRouteId: ROUTE, expiresAt: Date.now() + 3_600_000 },
    admission: { allowedKinds: ['review', 'triage'], maxOpenItems: 4, maxAdmitsPerHour: 8, dedupWindowMs: 3_600_000, cooldownMs: 0, maxBriefBytes: 512 },
    acceptance: { autoSettle: { enabled: true }, bindWorkerRun: { enabled: true } },
  }
  await ctx.plugin(AssistantWorkItemsService, config).await()
  const service = ctx.get('assistantWorkItems' as never) as unknown as AssistantWorkItemsService
  const items = new WorkItemStore(join(root, 'state', 'state.sqlite'))
  closers.push(() => items.close())

  // Admission dispatches through the real Automations external ingest.
  const admitted = service.admitDecision({
    protocol: 'work-items/execute-decision/v1', decisionId: 'decision-real-chain', verdict: 'execute',
    origin: 'explicit', mode: 'auto', budgetRemaining: 1,
    mandate: { kind: 'review', title: 'Review', brief: 'Review the change.', originBindingId: 'binding-origin-1', acceptanceRef: 'tac:review/v1' },
  })
  if (admitted.outcome === 'refused') throw new Error(admitted.reasonCode)
  const itemId = admitted.item.id
  const occurrenceId = admitted.dispatch.occurrenceId
  if (occurrenceId === null) throw new Error('not dispatched')
  const task = automations.store.listTasks({ automationId: WORKER, limit: 10 }).find(row => row.occurrenceId === occurrenceId)
  expect(task?.id).toBe(`task-${occurrenceId}`)
  const taskId = task!.id

  // Before the run prepares its contract a wake finds nothing to bind.
  automations.notifySchedulerWake()
  expect(boundEvents(root, itemId)).toBe(0)

  // The runner's production sequence: lease and start the task, resolve the
  // owner route from real Delivery, and freeze the run's contract.
  const ownerId = automations.coordinator.ownerId
  const lease = { ownerId, leaseMs: 10_000 }
  const duty = automations.store.acquireDuty({ ...lease, now: Date.now() })
  automations.store.claimTask({ ...lease, taskId, fencingToken: duty.fencingToken, now: Date.now() })
  automations.store.startTask({ ...lease, taskId, fencingToken: duty.fencingToken, now: Date.now(), sessionId: 'worker-session-1' })
  const route = delivery.prepareAgentApproval({ session: { id: 'owner-session-1', header: { cwd: root, agentPreset: PRESET } } } as unknown as Agent,
    { sourceId: 'dsh-enhanced-assistant-verifier' })
  automations.prepareTaskAcceptance({
    taskId, automationId: WORKER, scope: { workspace: root, preset: PRESET }, objective: PROMPT,
    owner: { principalRecordId: route.principalRecordId, principalVersion: route.principalVersion },
    binding: { id: route.bindingId, version: route.bindingVersion, generation: route.bindingGeneration },
  })

  // The Host-only read now names the frozen contract the verifier holds.
  const handle = ctx.assistantAutomations.inspectOccurrenceAcceptance({ automationId: WORKER, occurrenceId, workspace: root, agentPreset: PRESET })
  expect(handle).toMatchObject({ bindingId: route.bindingId, bindingVersion: route.bindingVersion, bindingGeneration: route.bindingGeneration })
  const contractId = (handle as { contractId: string }).contractId
  const frozen = verifier.inspectAcceptedTask(contractId)
  expect(frozen).toMatchObject({ state: 'awaiting-execution', receipt: null,
    contract: { id: contractId, task: { kind: 'automation-run', ref: `run-${taskId}` }, scope: { workspace: root, preset: PRESET },
      owner: { principalRecordId: owner.id, principalVersion: owner.version } } })

  // The worker claims its item; the next wake late-binds the run's contract.
  service.claim(workerAgent(root, occurrenceId))
  automations.notifySchedulerWake()
  expect(items.lateAcceptanceBinding(itemId)).toMatchObject({ occurrenceId,
    binding: { contractId, contractDigest: frozen!.contract.digest, author: 'assistant-automations', taskKind: 'automation-run', criteria: 1 } })
  expect(boundEvents(root, itemId)).toBe(1)
  // The worker's own `ready` is only a self-report: no verdict yet.
  await service.report(workerAgent(root, occurrenceId), { status: 'ready', summary: 'done', idempotencyKey: 'r-real-chain' })
  automations.notifySchedulerWake()
  expect(service.acceptanceVerdict(itemId)).toBeNull()

  // The run finishes; the real verifier runs the criterion and records a receipt.
  automations.store.completeTask({ taskId, ownerId, fencingToken: duty.fencingToken, now: Date.now(),
    outcome: 'succeeded', outputPreview: 'verified', usage: {} })
  automations.store.markAcceptedTaskQuiescent(taskId, true)
  await verifier.tick()
  const done = verifier.inspectAcceptedTask(contractId)
  expect(done?.state, JSON.stringify(done)).toBe('done')
  const receipt = done!.receipt as { id: string; digest: string }

  // Auto-settle reads the verdict back from the verifier's receipt alone.
  automations.notifySchedulerWake()
  expect(service.acceptanceVerdict(itemId)).toMatchObject({ itemId, verifier: 'assistant-verifier', contractId,
    contractDigest: frozen!.contract.digest, receiptId: receipt.id, receiptDigest: receipt.digest, objectiveStatus: 'achieved', occurrenceId })
  // Binding happened exactly once across all wakes.
  automations.notifySchedulerWake()
  expect(boundEvents(root, itemId)).toBe(1)
})
