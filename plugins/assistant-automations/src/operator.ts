import type { AutomationRecord } from './types.js'
import { AutomationStore } from './store.js'

/** Read-only local inspection for setup tools; never starts the scheduler. */
export function listAutomationsLocally(databasePath: string): AutomationRecord[] {
  const store = new AutomationStore({ path: databasePath })
  try {
    return store.list()
  } finally {
    store.close()
  }
}

/** Compatibility projection retained for callers that only gate active work. */
export function listActiveAutomationsLocally(databasePath: string): AutomationRecord[] {
  return listAutomationsLocally(databasePath).filter(record => record.status === 'active')
}
