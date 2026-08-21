import type { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-policy'
export { AssistantPolicyService, Config, version }
export type {
  ApprovalDecisionInput,
  ApprovalProposalInput,
  ApprovalProposalResult,
  ApprovalProposalStatus,
  AuditEvent,
  BudgetReservationResult,
  EmergencyStopState,
} from './ledger.js'
export * from './types.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantPolicyService(ctx, config)
}

export default AssistantPolicyService
