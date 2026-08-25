import type { AutomationRecord } from './types.js'
import { AutomationStore } from './store.js'

/** Read-only local inspection for setup tools; never starts the scheduler. */
export function listActiveAutomationsLocally(databasePath: string): AutomationRecord[] {
  const store = new AutomationStore({ path: databasePath })
  try {
    return store.list().filter(record => record.status === 'active')
  } finally {
    store.close()
  }
}
