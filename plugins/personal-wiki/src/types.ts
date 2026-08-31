import type { ApprovalDispatchRoute, ApprovalDispatchRouteV2 } from '@dsh-enhanced/assistant-policy'

export type WikiPageType = 'concept' | 'decision' | 'meta' | 'person' | 'project' | 'question' | 'source'
export type WikiPageAuthority = 'curated' | 'derived'
export type WikiPageStatus = 'active' | 'archived' | 'draft'

export interface WikiSource {
  uri: string
  sha256: string
}

export interface WikiPageInput {
  title: string
  type: WikiPageType
  authority: WikiPageAuthority
  status: WikiPageStatus
  tags: string[]
  aliases: string[]
  sources: WikiSource[]
  derivedFrom?: string[]
  body: string
}

export interface WikiPageMetadata extends Omit<WikiPageInput, 'body'> {
  id: string
  created: string
  updated: string
}

export interface WikiPage {
  metadata: WikiPageMetadata
  body: string
  relativePath: string
  revision: string
}

export interface WikiSearchRequest {
  query: string
  limit: number
  maxSnippetBytes: number
}

export interface WikiSearchHit {
  pageId: string
  title: string
  relativePath: string
  revision: string
  paragraphIndex: number
  snippet: string
  score: number
  matchedTokens: readonly string[]
  sources: readonly WikiSource[]
}

export interface WikiReadRequest {
  ref: string
  maxBytes: number
  maxParagraphs: number
}

export interface WikiReadResult {
  pageId: string
  title: string
  relativePath: string
  revision: string
  updated: string
  text: string
  bytes: number
  paragraphs: number
  truncated: boolean
  sources: readonly WikiSource[]
}

export type WikiLintCode =
  | 'case-fold-path'
  | 'dead-link'
  | 'derived-provenance'
  | 'duplicate-id'
  | 'duplicate-title-or-alias'
  | 'index-drift'
  | 'invalid-page'
  | 'malformed-frontmatter'
  | 'orphan-page'
  | 'source-hash'
  | 'unsafe-path'

export type WikiLintSeverity = 'error' | 'warning'

export interface WikiLintFinding {
  code: WikiLintCode
  severity: WikiLintSeverity
  relativePath: string
  message: string
  pageId?: string
}

export interface WikiLintRequest {
  limit: number
}

export interface WikiLintReport {
  findings: readonly WikiLintFinding[]
  truncated: boolean
}

export type WikiUpsertMutation =
  | { op: 'create'; input: WikiPageInput }
  | { op: 'update'; pageId: string; expectedRevision: string; input: WikiPageInput }

export interface PreparedWikiWrite {
  op: WikiUpsertMutation['op']
  pageId: string
  relativePath: string
  markdown: string
  targetRevision: string
  expectedRevision?: string
  enforceUniqueNames?: boolean
}

export type WikiProposalStatus = 'approved' | 'conflicted' | 'expired' | 'pending' | 'rejected'

export interface WikiProposalInput {
  idempotencyKey: string
  requester: string
  principal: string
  ttlMs: number
  mutation: WikiUpsertMutation
  dispatch?: Readonly<ApprovalDispatchRouteV2>
}

export interface WikiProposalDecisionInput {
  proposalId: string
  principal: string
  expectedVersion: number
  decision: 'approved' | 'rejected'
  reason: string
}

export interface WikiProposalResult {
  proposalId: string
  policyProposalId?: string
  status: WikiProposalStatus
  version: number
  expiresAt: number
  write: PreparedWikiWrite
  diff: string
  summary: string
  replayed: boolean
  page?: WikiPage
}

export interface StoredWikiProposal {
  proposalId: string
  policyProposalId?: string
  idempotencyKey: string
  requester: string
  principal: string
  requestHash: string
  writeHash: string
  write: PreparedWikiWrite
  status: WikiProposalStatus
  expiresAt: number
  version: number
  /** Present for schema-v2+ intents to bind trusted request replays to the original TTL. */
  ttlMs?: number
  dispatch?: Readonly<ApprovalDispatchRoute>
  resultPageId?: string
}
