import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, test } from 'vitest'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type WorkerResult =
  | { ok: true; value: { payloadHash: string; replayed: boolean; result?: unknown } }
  | { ok: false; error: { name?: string; code?: string; message?: string } }

function settlementWorker(input: {
  path: string
  operationId: string
  payload: unknown
  phase: SharedArrayBuffer
}): { ready: Promise<void>; result: Promise<WorkerResult> } {
  const loader = fileURLToPath(new URL('./fixtures/ts-source-loader.mjs', import.meta.url))
  const worker = new Worker(new URL('./fixtures/approval-settlement-worker.mjs', import.meta.url), {
    workerData: input,
    execArgv: ['--no-warnings', '--experimental-transform-types', '--loader', loader],
  })
  let readyResolve!: () => void
  let resultResolve!: (value: WorkerResult) => void
  let resultReject!: (error: Error) => void
  const ready = new Promise<void>(resolve => { readyResolve = resolve })
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resultResolve = resolve
    resultReject = reject
  })
  worker.on('message', (message: { type: 'ready' } | ({ type: 'result' } & WorkerResult)) => {
    if (message.type === 'ready') readyResolve()
    else resultResolve(message)
  })
  worker.on('error', resultReject)
  worker.on('exit', code => {
    if (code !== 0) resultReject(new Error(`approval settlement worker exited with code ${code}`))
  })
  return { ready, result }
}

async function concurrentSettlements(leftPayload: unknown, rightPayload: unknown): Promise<WorkerResult[]> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-approval-race-'))
  roots.push(root)
  const path = join(root, 'delivery.sqlite')
  const seed = new DeliveryStore({ path })
  seed.close()
  const phase = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const left = settlementWorker({ path, operationId: 'shared-operation', payload: leftPayload, phase })
  const right = settlementWorker({ path, operationId: 'shared-operation', payload: rightPayload, phase })
  await Promise.all([left.ready, right.ready])
  expect(Atomics.load(new Int32Array(phase), 0)).toBe(2)
  Atomics.store(new Int32Array(phase), 1, 1)
  Atomics.notify(new Int32Array(phase), 1, 2)
  return Promise.all([left.result, right.result])
}

describe('approval settlement durability', () => {
  test('does not create a settlement when a recovery-only lookup has no durable predecessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-approval-resume-'))
    roots.push(root)
    const store = new DeliveryStore({ path: join(root, 'delivery.sqlite') })

    expect(() => store.beginApprovalSettlement({ operationId: 'missing-operation',
      payload: { decision: 'approved' }, createIfMissing: false }))
      .toThrowError(expect.objectContaining({ code: 'not-found' }))
    expect(() => store.beginApprovalSettlement({ operationId: 'missing-operation',
      payload: { decision: 'approved' }, createIfMissing: false }))
      .toThrowError(expect.objectContaining({ code: 'not-found' }))
    store.close()
  })

  test('rereads the immutable winner when two processes begin the same operation concurrently', async () => {
    const payload = { bindingId: 'binding-1', proposalId: 'proposal-1', decision: 'approved' }
    const results = await concurrentSettlements(payload, payload)

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ok: true, value: expect.objectContaining({ replayed: false }) }),
      expect.objectContaining({ ok: true, value: expect.objectContaining({ replayed: true }) }),
    ]))
  })

  test('fails closed against a different immutable payload that wins the concurrent insert', async () => {
    const results = await concurrentSettlements(
      { bindingId: 'binding-1', proposalId: 'proposal-1', decision: 'approved' },
      { bindingId: 'binding-1', proposalId: 'proposal-1', decision: 'rejected' },
    )

    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'idempotency-conflict' }) }),
    ])
  })
})
