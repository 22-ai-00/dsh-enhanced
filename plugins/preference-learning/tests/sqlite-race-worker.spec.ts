import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import { observeRaceWorker, type WorkerMessage } from './fixtures/sqlite-race-worker.ts'

function fixture() {
  const child = new EventEmitter()
  const worker = observeRaceWorker(child as unknown as ChildProcess)
  return { child, worker }
}
const result: WorkerMessage = {
  type: 'result',
  result: { schemaVersion: 7, schemaTables: 15, journalMode: 'wal', secureDelete: 1 },
}

describe('SQLite race worker IPC settlement', () => {
  test('accepts a buffered result delivered after exit but before close', async () => {
    const { child, worker } = fixture()
    child.emit('message', { type: 'ready' })
    await worker.ready
    child.emit('exit', 0, null)
    let settled = false
    void worker.result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('message', result)
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('close', 0, null)
    await expect(worker.result).resolves.toEqual(result)
    await worker.closed
  })

  test('rejects a clean close without a result instead of inventing success', async () => {
    const { child, worker } = fixture()
    child.emit('message', { type: 'ready' })
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await expect(worker.result).rejects.toThrow('no result')
    await worker.closed
  })

  test.each([[1, null], [null, 'SIGKILL']] as const)('rejects a result followed by abnormal close (%s, %s)', async (code, signal) => {
    const { child, worker } = fixture()
    child.emit('message', { type: 'ready' })
    child.emit('message', result)
    child.emit('close', code, signal)
    await expect(worker.result).rejects.toThrow('SQLite race worker closed')
    await worker.closed
  })

  test('reports startup errors to both barriers and still joins close', async () => {
    const { child, worker } = fixture()
    child.emit('error', new Error('spawn failed'))
    child.emit('close', -2, null)
    await expect(worker.ready).rejects.toThrow('spawn failed')
    await expect(worker.result).rejects.toThrow('spawn failed')
    await worker.closed
  })

  test('rejects a result received before readiness', async () => {
    const { child, worker } = fixture()
    child.emit('message', result)
    child.emit('close', 0, null)
    await expect(worker.ready).rejects.toThrow('out-of-order')
    await expect(worker.result).rejects.toThrow('out-of-order')
    await worker.closed
  })

  test('preserves a reported database error for the migration assertion', async () => {
    const { child, worker } = fixture()
    const failure: WorkerMessage = { type: 'result', error: { name: 'Error', code: 'SQLITE_BUSY', message: 'locked' } }
    child.emit('message', { type: 'ready' })
    child.emit('message', failure)
    child.emit('close', 0, null)
    await expect(worker.result).resolves.toEqual(failure)
    await worker.closed
  })
})
