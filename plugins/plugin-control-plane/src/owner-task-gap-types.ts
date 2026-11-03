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

/** New background subject; never serialized as a foreground Inbox reference. */
export interface OwnerWorkItemFailureReference {
  schemaVersion: 2
  sourceProtocol: 'assistant-delivery/work-item-engineering-context/v1'
  owner: SourceJobOwnerReceipt
  outcomeId: string
  projection: { subjectKind:'work-item';subjectRef:string;version:number;digest:string;disposition:'upsert';evidenceOutcomeId?:string }
  sourceDigest: string
  presentationDigest: string
  context: { manifestDigest:string;objectiveDigest:string;objectiveBytes:number }
}
export type AnyOwnerTaskFailureReference = OwnerTaskFailureReference | OwnerWorkItemFailureReference
