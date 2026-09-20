import type { SourceJobOwnerReceipt } from './source-job-types.js'

/**
 * Private, immutable pointer to one owner-verified foreground failure.  It
 * intentionally contains no task text, prompt, tool arguments, or evidence
 * body; consumers must re-read those facts through their fenced Host APIs.
 */
export interface OwnerTaskFailureReference {
  schemaVersion: 1
  owner: SourceJobOwnerReceipt
  outcomeId: string
  projection: {
    subjectKind: 'foreground-turn'
    subjectRef: string
    version: number
    digest: string
    disposition: 'upsert'
    evidenceOutcomeId?: string
  }
  sourceDigest: string
}
