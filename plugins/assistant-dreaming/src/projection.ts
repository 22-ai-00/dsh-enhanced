import { acceptanceDigest } from '@dsh-ray/task-acceptance-contract'
import type { AssistantDeliveryService } from '@dsh-ray/assistant-delivery'
import type { AssistantEvaluationService } from '@dsh-ray/assistant-evaluation'
import type { GoalScope } from '@dsh-ray/assistant-goals'
import type { AssistantGoalsService } from '@dsh-ray/assistant-goals'
import type { AssistantSkillsService } from '@dsh-ray/assistant-skills'
import type { PersonalMemoryService } from '@dsh-ray/personal-memory'
import type { DreamingScopeConfig } from './config.js'

/**
 * Bounded, Host-projected dreaming material. The model never sees raw
 * transcripts, tool arguments, acceptance receipts, credentials or sensitive
 * memory: only redacted summaries of trusted projections (plus optional
 * strictly non-sensitive memory summaries), each carrying a hex digest it may
 * cite as evidence. Truncated or redacted input is dropped, never guessed.
 */

export interface DreamEvidenceItem {
  kind: 'task-projection' | 'goal' | 'skill' | 'memory-summary'
  summary: string
  evidenceRef: string
}

export interface DreamMaterial {
  ownerScopeDigest: string
  generatedAt: number
  items: readonly DreamEvidenceItem[]
  inputBytes: number
}

export type DreamPersonalMemoryPort = Partial<Pick<PersonalMemoryService, 'listLearningTargets'>>

export interface ProjectionInput {
  evaluation: Pick<AssistantEvaluationService, 'canonicalHostScope' | 'listTrustedTaskLearningProjections'>
  delivery: Pick<AssistantDeliveryService, 'validateOwnerRoute'>
  goals: Pick<AssistantGoalsService, 'inspectOwnerGoals'>
  skills: Pick<AssistantSkillsService, 'inspectOwnerActiveSkills' | 'inspectOwnerSkillCandidates'>
  personalMemory?: DreamPersonalMemoryPort
  scope: DreamingScopeConfig
  maxInputBytes: number
}

const MAX_SUMMARY_BYTES = 1_024
const MAX_MEMORY_SUMMARY_BYTES = 256
const ALLOWED_MEMORY_KINDS = new Set(['fact', 'experience', 'preference', 'instruction'])

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

function boundedMemorySummary(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!value.isWellFormed()) return null
  const collapsed = value.normalize('NFC').replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return null
  if ([...collapsed].some(char => {
    const code = char.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })) return null
  if (Buffer.byteLength(collapsed, 'utf8') <= MAX_MEMORY_SUMMARY_BYTES) return collapsed
  let out = ''
  let bytes = 0
  for (const ch of collapsed) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (bytes + chBytes + 1 > MAX_MEMORY_SUMMARY_BYTES) break
    out += ch
    bytes += chBytes
  }
  const trimmed = out.trimEnd()
  return trimmed.length === 0 ? null : `${trimmed}…`
}

export function buildDreamMaterial(input: ProjectionInput): DreamMaterial {
  const { evaluation, delivery, goals, skills, personalMemory, scope, maxInputBytes } = input
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
  const authorityHash = (anchor as { authorityHash?: unknown }).authorityHash
  if (typeof personalMemory?.listLearningTargets === 'function'
    && typeof authorityHash === 'string' && authorityHash.length > 0) {
    try {
      const targets = personalMemory.listLearningTargets({
        owner: {
          authorityId: scope.ownerRouteId,
          authorityHash,
          principalId: scope.principalId,
          principalRecordId: anchor.principalRecordId,
          principalVersion: anchor.principalVersion,
          workspace: scope.workspace,
          agentPreset: scope.preset,
        },
        limit: 8,
      })
      for (const target of targets) {
        if (target === null || typeof target !== 'object') continue
        const raw = target as {
          id?: unknown; version?: unknown; kind?: unknown; content?: unknown; sensitivity?: unknown
        }
        // Strictly non-sensitive summaries only: never admit sensitive or unmarked non-private rows.
        if (raw.sensitivity !== undefined && raw.sensitivity !== 'private') continue
        if (typeof raw.kind !== 'string' || !ALLOWED_MEMORY_KINDS.has(raw.kind)) continue
        const summaryText = boundedMemorySummary(raw.content)
        if (summaryText === null) continue
        accept({
          kind: 'memory-summary',
          summary: `memory (${raw.kind}): ${summaryText}`,
          evidenceRef: acceptanceDigest({
            kind: 'memory-summary',
            id: typeof raw.id === 'string' ? raw.id : '',
            version: typeof raw.version === 'number' ? raw.version : 0,
            contentDigest: acceptanceDigest(summaryText),
          }).slice(0, 64),
        })
      }
    } catch {
      // Optional recall fails soft: missing/unconfigured automaticLearning never breaks dreaming.
    }
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
