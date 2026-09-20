import { parseSourceReleaseAuthorization } from './release.js'
import { requestSourceAuthorityReceipt, SourceApprovalClientError, validateSourceApprovalClientConfig,
  type SourceApprovalClientConfig, type SourceAuthorityRequest } from './source-approval-client.js'
import type { SourceReleaseAuthorization } from './types.js'

export type SourceReleaseClientConfig = SourceApprovalClientConfig
export function validateSourceReleaseClientConfig(value: unknown): asserts value is SourceReleaseClientConfig {
  validateSourceApprovalClientConfig(value)
}
export interface SourceReleaseAuthorizationRequest extends Omit<SourceAuthorityRequest, 'protocol'> {
  protocol: 'dsh-source-release-authorization/v1'
}

/** Uses the existing owned subprocess transport; this helper cannot run release phases. */
export async function requestSourceReleaseAuthorization(config: SourceReleaseClientConfig, request: SourceReleaseAuthorizationRequest,
  signal?: AbortSignal): Promise<SourceReleaseAuthorization> {
  if (request?.protocol !== 'dsh-source-release-authorization/v1') throw new SourceApprovalClientError('FAILED', 'source release request protocol is invalid')
  return requestSourceAuthorityReceipt(config, request, value => {
    let authorization: SourceReleaseAuthorization
    try { authorization = parseSourceReleaseAuthorization(value) } catch {
      throw new SourceApprovalClientError('FAILED', 'source release authority returned an invalid authorization')
    }
    if (authorization.planId !== request.planId || authorization.planDigest !== request.planDigest) {
      throw new SourceApprovalClientError('FAILED', 'source release authorization targets another plan')
    }
    return authorization
  }, signal)
}
