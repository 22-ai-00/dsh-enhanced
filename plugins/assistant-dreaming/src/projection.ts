import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import type { AssistantGoalsService } from '@dsh-enhanced/assistant-goals'
import type { AssistantSkillsService } from '@dsh-enhanced/assistant-skills'
import type { DreamingScopeConfig } from './config.js'

/**
 * Bounded, Host-projected dreaming material. The model never sees raw
 * transcripts, tool arguments, acceptance receipts, credentials or memory: only
 * redacted summaries of trusted projections, each carrying a hex digest it may
 * cite as evidence. Truncated or redacted input is dropped, never guessed.
 */

export interface DreamEvidenceItem {
  kind: 'task-projection' | 'goal' | 'skill'
  summary: string
  evidenceRef: string
}

export interface DreamMaterial {
  ownerScopeDigest: string
  generatedAt: number
  items: readonly DreamEvidenceItem[]
  inputBytes: number
}

export interface ProjectionInput {
  evaluation: Pick<AssistantEvaluationService, 'canonicalHostScope' | 'listTrustedTaskLearningProjections'>
  delivery: Pick<AssistantDeliveryService, 'validateOwnerRoute'>
  goals: Pick<AssistantGoalsService, 'inspectOwnerGoals'>
  skills: Pick<AssistantSkillsService, 'inspectOwnerActiveSkills' | 'inspectOwnerSkillCandidates'>
  scope: DreamingScopeConfig
  maxInputBytes: number
}

const MAX_SUMMARY_BYTES = 1_024

function boundedSummary(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const situation = (value as { situation?: unknown }).situation
  const status = (value as { objective?: { status?: unknown } }).objective?.status
  if (typeof situation !== 'string' || situation.length === 0 || situation.length > 512) return null
  if (typeof status !== 'string' || !['achieved', 'not-achieved'].includes(status)) return null
  const text = `${status}: ${situation}`
  return Buffer.byteLength(text) > MAX_SUMMARY_BYTES ? null : text
}

function boundedText(value: unknown, max = 256): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null
  const text = value.normalize('NFC').trim()
  if (!text.isWellFormed() || Buffer.byteLength(text) > max) return null
  return text
}

export function buildDreamMaterial(input: ProjectionInput): DreamMaterial {
  const { evaluation, delivery, goals, skills, scope, maxInputBytes } = input
  const items: DreamEvidenceItem[] = []
  let inputBytes = 0
  const accept = (item: DreamEvidenceItem): void => {
    const size = Buffer.byteLength(item.summary) + 64
    if (inputBytes + size > maxInputBytes) return
    inputBytes += size
    items.push(Object.freeze(item))
  }
  const anchor = delivery.validateOwnerRoute({
    authorityId: scope.ownerRouteId, principalId: scope.principalId,
    workspace: scope.workspace, agentPreset: scope.preset,
  })
  const goalScope: GoalScope = Object.freeze({
    principalId: scope.principalId,
    principalRecordId: anchor.principalRecordId,
    principalVersion: anchor.principalVersion,
    workspace: scope.workspace,
    preset: scope.preset,
  })
  const hostScope = evaluation.canonicalHostScope({ workspace: scope.workspace, preset: scope.preset })
  const projections = evaluation.listTrustedTaskLearningProjections({ scope: hostScope, limit: 8 })
  for (const receipt of projections.items) {
    const summary = boundedSummary(receipt)
    if (summary === null) continue
    accept({
      kind: 'task-projection',
      summary,
      evidenceRef: acceptanceDigest(receipt).slice(0, 64),
    })
  }
  for (const goal of goals.inspectOwnerGoals(goalScope)) {
    const title = boundedText((goal as { title?: unknown }).title)
    const state = boundedText((goal as { state?: unknown }).state)
    if (title === null || state === null) continue
    accept({
      kind: 'goal',
      summary: `${state}: ${title}`,
      evidenceRef: acceptanceDigest(goal).slice(0, 64),
    })
  }
  for (const skill of skills.inspectOwnerActiveSkills(goalScope)) {
    const name = boundedText((skill as { name?: unknown }).name)
    if (name === null) continue
    accept({
      kind: 'skill',
      summary: `active skill: ${name}`,
      evidenceRef: acceptanceDigest(skill).slice(0, 64),
    })
  }
  const material: DreamMaterial = Object.freeze({
    ownerScopeDigest: acceptanceDigest(scope),
    generatedAt: Date.now(),
    items: Object.freeze(items),
    inputBytes,
  })
  if (Buffer.byteLength(JSON.stringify(material)) > maxInputBytes) {
    throw new Error('assistant-dreaming: bounded material exceeded its input cap')
  }
  return material
}
