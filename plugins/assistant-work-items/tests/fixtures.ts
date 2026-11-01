import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { WorkItemAdmission } from '../src/admission.ts'
import { normalizeConfig, type Config, type NormalizedConfig } from '../src/config.ts'
import { WorkItemLedger } from '../src/ledger.ts'
import type {
  PeerDeliveryService,
  PeerOwnerRouteReceipt,
  PeerPolicyDecision,
  PeerPolicyRequest,
  PeerPolicyService,
} from '../src/peers.ts'
import { WorkItemStore } from '../src/store.ts'
import type { WorkItemAdmitInput, WorkItemReportStatus } from '../src/types.ts'
import { WorkItemWorkspace } from '../src/workspace.ts'

export const WORKER = 'work-items-worker'
export const SOURCE = 'work-items/v1'
export const WORKSPACE = '/work/alpha'
export const PRESET = 'primary'
export const PRINCIPAL = 'owner:me'
export const ROUTE = 'route-1'
export const AUTHORITY_HASH = 'sha256:authority'
export const INBOX = 'inbox-1'
export const BASELINE_SEQUENCE = 4
export const SETTLE_WINDOW = 604_800_000

const roots: string[] = []
const closers: Array<() => void> = []

afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

export function receipt(input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }): PeerOwnerRouteReceipt {
  return Object.freeze({
    receiptVersion: 2,
    authorityId: input.authorityId,
    authorityHash: AUTHORITY_HASH,
    principalId: input.principalId,
    principalRecordId: 'principal-1',
    principalVersion: 7,
    workspace: input.workspace,
    agentPreset: input.agentPreset,
    bindingVersion: 3,
    generation: 2,
  })
}

/** A delivery peer whose owner route validates; individual methods are overridable. */
export function deliveryPeer(overrides: Partial<PeerDeliveryService> = {}): PeerDeliveryService {
  return {
    validateOwnerRoute: input => receipt(input),
    enqueueBackground: () => Promise.resolve({ id: 'outbox-1' }),
    ...overrides,
  }
}

export function signal(overrides: Partial<WorkItemAdmitInput> = {}): WorkItemAdmitInput {
  return {
    kind: 'review',
    externalId: `ext-${Math.random().toString(36).slice(2)}`,
    title: 'Repair the failed execution',
    brief: 'Inspect and repair what the owner reported.',
    originBindingId: 'binding-origin-1',
    provenance: {
      source: 'owner-foreground-failures',
      sourceVersion: 'assistant-work-items/owner-foreground-failures/v1',
      signalDigest: 'sha256:signal',
      observedAt: 1_700_000_000_000,
      evidence: { inboxId: INBOX, executionStatus: 'failed', completionSequence: BASELINE_SEQUENCE, authorityHash: AUTHORITY_HASH },
    },
    ...overrides,
  }
}

export interface Harness {
  readonly store: WorkItemStore
  readonly ledger: WorkItemLedger
  readonly admission: WorkItemAdmission
  readonly config: NormalizedConfig
  readonly root: string
  now(): number
  advance(ms: number): void
}

/** Fresh plugin instance on a temp SQLite database, in active mode. */
export async function harness(overrides: Partial<Config> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-work-items-'))
  roots.push(root)
  let current = 1_700_000_000_000
  const now = () => current
  const config = normalizeConfig({
    enabled: true,
    mode: 'active',
    databasePath: join(root, 'state', 'state.sqlite'),
    workRoot: join(root, 'work'),
    intakeSourceId: SOURCE,
    workerAutomationId: WORKER,
    scope: { workspace: WORKSPACE, preset: PRESET, principalId: PRINCIPAL, ownerRouteId: ROUTE, expiresAt: current + 86_400_000 },
    admission: {
      allowedKinds: ['review', 'triage'],
      maxOpenItems: 8,
      maxAdmitsPerHour: 20,
      dedupWindowMs: 3_600_000,
      cooldownMs: 0,
      maxBriefBytes: 512,
    },
    ...overrides,
  }, current)
  const workspace = new WorkItemWorkspace(config.workRoot)
  workspace.prepare()
  const store = new WorkItemStore(config.databasePath, { now, settleWindowMs: SETTLE_WINDOW })
  const ledger = new WorkItemLedger({ store, workspace, limits: config.limits, now })
  const policy: PeerPolicyService = {
    authorize(request: PeerPolicyRequest): PeerPolicyDecision {
      void request
      return { effect: 'allow', reasonCode: 'rule-allow' }
    },
  }
  const admission = new WorkItemAdmission({
    config,
    store,
    ledger,
    workspace,
    policy,
    delivery: deliveryPeer(),
    now,
  })
  closers.push(() => store.close())
  return {
    store,
    ledger,
    admission,
    config,
    root,
    now,
    advance(ms: number) { current += ms },
  }
}

export async function admitted(fixture: Harness, overrides: Partial<WorkItemAdmitInput> = {}) {
  return fixture.admission.admit(signal(overrides)).item
}

/** Copy an admit input without the optional provenance field. */
export function withoutProvenance(input: WorkItemAdmitInput): WorkItemAdmitInput {
  const { provenance, ...rest } = input
  void provenance
  return rest
}

export function claim(fixture: Harness, itemId: string, occurrenceId = `occ-${itemId}`) {
  return fixture.ledger.claim({ itemId, runId: occurrenceId, occurrenceId })
}

export function report(fixture: Harness, itemId: string, status: WorkItemReportStatus, occurrenceId = `occ-${itemId}`) {
  return fixture.ledger.report({
    itemId,
    runId: occurrenceId,
    status,
    summary: `worker reported ${status}`,
    artifactPaths: [],
    idempotencyKey: `key-${status}-${itemId}`,
  })
}

/** Admit, claim, and report `ready` — the canonical pending-outcome fixture. */
export async function readyItem(fixture: Harness, overrides: Partial<WorkItemAdmitInput> = {}) {
  const item = await admitted(fixture, overrides)
  claim(fixture, item.id)
  report(fixture, item.id, 'ready')
  return item
}
