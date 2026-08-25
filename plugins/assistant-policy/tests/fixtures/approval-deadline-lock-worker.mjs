import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

const { path, clockBuffer, deadline, holdMs } = workerData
const clock = new Int32Array(clockBuffer)
const database = new DatabaseSync(path)
database.exec('PRAGMA busy_timeout = 5000')
database.exec('BEGIN IMMEDIATE')
parentPort.postMessage({ type: 'locked' })

setTimeout(() => {
  Atomics.store(clock, 0, deadline)
  database.exec('COMMIT')
  database.close()
  parentPort.postMessage({ type: 'released' })
}, holdMs)
