import { parentPort, workerData } from 'node:worker_threads'
import { PolicyLedger } from '../../src/ledger.ts'

const phase = new Int32Array(workerData.phase)
Atomics.add(phase, 0, 1)
parentPort.postMessage({ type: 'ready' })
while (Atomics.load(phase, 1) === 0) Atomics.wait(phase, 1, 0)

try {
  const ledger = new PolicyLedger({ path: workerData.path })
  ledger.close()
  parentPort.postMessage({ type: 'result', ok: true })
} catch (error) {
  parentPort.postMessage({
    type: 'result',
    ok: false,
    error: { name: error?.name, code: error?.code, message: error?.message },
  })
}
