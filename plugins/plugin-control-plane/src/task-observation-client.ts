import { parsePostActivationObservation } from './post-activation.js'
import { requestPinnedAuthorityReceipt, SourceApprovalClientError, type SourceApprovalClientConfig } from './source-approval-client.js'
import type { TaskObservationRequest } from './task-observation-types.js'

export function requestTaskObservation(config: SourceApprovalClientConfig, request: TaskObservationRequest, signal?: AbortSignal) {
  if (request.protocol !== 'dsh-task-observation/v1' || !/^task-observation-[a-f0-9]{64}$/u.test(request.observationId)
    || !/^[a-f0-9]{64}$/u.test(request.observationDigest)
    || Object.keys(request).sort().join(',') !== 'observationDigest,observationId,protocol') throw new Error('invalid task observation request')
  return requestPinnedAuthorityReceipt(config, request, value => {
    try {
      const receipt = parsePostActivationObservation(value)
      if (receipt.observationId !== request.observationId || receipt.evidence.probeDigest !== request.observationDigest) throw new Error('task observation receipt differs')
      return receipt
    } catch { throw new SourceApprovalClientError('FAILED', 'task observation authority returned an invalid receipt') }
  }, signal)
}
