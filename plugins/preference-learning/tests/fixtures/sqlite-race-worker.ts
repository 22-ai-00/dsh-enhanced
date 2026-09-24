import type { ChildProcess } from 'node:child_process'

export interface WorkerMessage {
  type: 'ready' | 'result'
  result?: {
    schemaVersion: number
    schemaTables: number
    journalMode: string
    secureDelete: number
  }
  error?: { name: string; code?: string; message: string }
}

export interface RaceWorker {
  child: ChildProcess
  ready: Promise<void>
  result: Promise<WorkerMessage>
  closed: Promise<void>
}

/** Own the worker until its IPC/stdio have drained, not merely until exit. */
export function observeRaceWorker(child: ChildProcess): RaceWorker {
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384) })
  const ready = Promise.withResolvers<void>()
  const result = Promise.withResolvers<WorkerMessage>()
  const closed = Promise.withResolvers<void>()
  let announced = false
  let received: WorkerMessage | undefined
  let failed = false

  // Startup and result failures may precede the parent's all-ready barrier.
  // Keep both rejections observed without changing what their awaiters receive.
  void ready.promise.catch(() => {})
  void result.promise.catch(() => {})
  const fail = (error: Error): void => {
    failed = true
    if (!announced) ready.reject(error)
    result.reject(error)
  }

  child.on('message', value => {
    if (failed || value === null || typeof value !== 'object') return
    const message = value as WorkerMessage
    if (message.type === 'ready') {
      announced = true
      ready.resolve()
    } else if (message.type === 'result') {
      if (!announced || received !== undefined) {
        fail(new Error('SQLite race worker sent an out-of-order or duplicate result'))
        return
      }
      received = message
    }
  })
  child.once('error', fail)
  // exit can precede delivery of an already-sent IPC result under CI load.
  // close follows channel/stdio drainage; also require a clean process exit
  // so a result followed by a crash cannot masquerade as a successful worker.
  child.once('close', (code, signal) => {
    if (!failed) {
      if (code !== 0 || signal !== null || received === undefined) {
        fail(new Error(`SQLite race worker closed ${signal ?? code ?? 'without exit status'}${stderr === '' ? '' : `: ${stderr}`}${received === undefined ? ' (no result)' : ''}`))
      } else {
        result.resolve(received)
      }
    }
    closed.resolve()
  })
  return { child, ready: ready.promise, result: result.promise, closed: closed.promise }
}
