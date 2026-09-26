import { parseLiveQualificationReceipt, type LiveQualificationRequest } from './live-qualification.js'
import { requestPinnedAuthorityReceipt, SourceApprovalClientError,
  type SourceApprovalClientConfig } from './source-approval-client.js'

export function requestLiveQualification(config: SourceApprovalClientConfig,
  request: LiveQualificationRequest, signal?: AbortSignal) {
  if (request.protocol !== 'dsh-live-qualification/v1'
    || !/^live-qualification-[a-f0-9]{64}$/u.test(request.batchId)
    || !/^[a-f0-9]{64}$/u.test(request.batchDigest)
    || Object.keys(request).sort().join(',') !== 'batchDigest,batchId,protocol') {
    throw new SourceApprovalClientError('FAILED', 'live qualification request is invalid')
  }
  return requestPinnedAuthorityReceipt(config, request, value => {
    try {
      const receipt = parseLiveQualificationReceipt(value)
      if (receipt.batchId !== request.batchId || receipt.batchDigest !== request.batchDigest) throw new Error('batch differs')
      return receipt
    } catch { throw new SourceApprovalClientError('FAILED', 'live qualification authority returned an invalid receipt') }
  }, signal)
}
