import type { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService, Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-automations'
export { AssistantAutomationsService, Config, version }
export type { PendingAutomationProposal, SystemAutomationReconcileInput } from './service.js'
export type { PreparationInput, PreparationResult } from './preparation.js'
export * from './types.js'
export { externalEventDigest, parseExternalEventEnvelope } from './external-event.js'
export type { ExternalEventEnvelope } from './external-event.js'
export type {
  AcceptanceContract,
  AcceptedExecution,
  AcceptanceHandle,
  AcceptanceOwner,
  AcceptanceScope,
  AcceptanceTaskInput,
  TaskAcceptanceRegistration,
} from './acceptance.js'
export {
  AutomationOperatorSnapshotError,
  automationDefinitionDigest,
  inspectAutomationInventoryLocally,
  inspectAutomationsOperatorSnapshot,
  listActiveAutomationsLocally,
  listAutomationsLocally,
} from './operator.js'
export type {
  AutomationOperatorFileIdentity,
  AutomationOperatorRecord,
  AutomationOperatorSnapshotErrorCode,
  AutomationsOperatorSnapshot,
} from './operator.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new AssistantAutomationsService(ctx, config)
}

export default AssistantAutomationsService
