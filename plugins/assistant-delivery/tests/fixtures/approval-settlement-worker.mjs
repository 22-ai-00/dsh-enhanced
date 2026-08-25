import { parentPort, workerData } from 'node:worker_threads'
import { DeliveryStore } from '../../src/store.ts'

const phase = new Int32Array(workerData.phase)
let synchronized = false
const store = new DeliveryStore({
  path: workerData.path,
  now: () => {
    if (!synchronized) {
      synchronized = true
      Atomics.add(phase, 0, 1)
      parentPort.postMessage({ type: 'ready' })
      while (Atomics.load(phase, 1) === 0) Atomics.wait(phase, 1, 0)
    }
    return 5_000
  },
})

try {
  const value = store.beginApprovalSettlement({
    operationId: workerData.operationId,
    payload: workerData.payload,
  })
  parentPort.postMessage({ type: 'result', ok: true, value })
} catch (error) {
  parentPort.postMessage({
    type: 'result',
    ok: false,
    error: { name: error?.name, code: error?.code, message: error?.message },
  })
} finally {
  store.close()
}
