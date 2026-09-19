export type ControlPlaneCliErrorCode =
  | 'ACTIVATION_BINDING'
  | 'EXECUTOR_FAILED'
  | 'EXECUTOR_OUTPUT_LIMIT'
  | 'EXECUTOR_TIMEOUT'
  | 'FILESYSTEM_STATE'
  | 'HOST_ATTESTATION_REQUIRED'
  | 'HOST_ATTESTOR_NOT_CONFIGURED'
  | 'INVALID_ARGUMENT'
  | 'LOCK_CONFLICT'
  | 'SOURCE_BOUNDARY'

export class ControlPlaneCliError extends Error {
  constructor(readonly code: ControlPlaneCliErrorCode, message: string) {
    super(`plugin-control-plane[${code}]: ${message}`)
    this.name = 'ControlPlaneCliError'
  }
}
