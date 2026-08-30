import { createHash } from 'node:crypto'
import type {
  ConversationBinding,
  DeliveryPreferenceFeedback,
  DeliveryPreferenceSelection,
  InboundEnvelope,
} from './types.js'

export type FeedbackSignalSelection = DeliveryPreferenceSelection

export type ParsedFeedbackCommand =
  | { kind: 'invalid' }
  | { kind: 'signals'; selections: readonly FeedbackSignalSelection[] }

const responseFeedback = Object.freeze([
  'helpful',
  'not-helpful',
  'too-long',
  'too-short',
  'wrong-format',
  'wrong-action',
  'unwanted-reminder',
] as const)

const typedPreferences = Object.freeze({
  verbosity: Object.freeze({
    preferenceKey: 'response.verbosity',
    values: Object.freeze(['concise', 'balanced', 'detailed']),
  }),
  structure: Object.freeze({
    preferenceKey: 'response.structure',
    values: Object.freeze(['prose', 'bullets', 'mixed']),
  }),
  language: Object.freeze({
    preferenceKey: 'response.language',
    values: Object.freeze(['zh-CN', 'en']),
  }),
  explanation: Object.freeze({
    preferenceKey: 'response.explanation_depth',
    values: Object.freeze(['result-first', 'balanced', 'tutorial']),
  }),
  suggestions: Object.freeze({
    preferenceKey: 'suggestion.frequency',
    values: Object.freeze(['low', 'normal']),
  }),
  ranking: Object.freeze({
    preferenceKey: 'recommendation.ranking',
    values: Object.freeze(['recency', 'familiarity', 'evidence']),
  }),
} as const satisfies Readonly<Record<string, {
  preferenceKey: DeliveryPreferenceSelection['preferenceKey']
  values: readonly string[]
}>>)

export const feedbackUsage = [
  '反馈命令：',
  '- /feedback helpful|not-helpful|too-long|too-short|wrong-format|wrong-action|unwanted-reminder',
  '- /feedback verbosity concise|balanced|detailed',
  '- /feedback structure prose|bullets|mixed',
  '- /feedback language zh-CN|en',
  '- /feedback explanation result-first|balanced|tutorial',
  '- /feedback suggestions low|normal',
  '- /feedback ranking recency|familiarity|evidence',
  '',
  '反馈只作用于当前工作区与 preset；命令不接受附件，也不会进入模型。',
].join('\n')

/** Parse a closed, typed grammar. No caller-provided text crosses this boundary. */
export function parseFeedbackCommand(rawInput: string): ParsedFeedbackCommand {
  const normalized = rawInput.trim()
  if (normalized === '') return { kind: 'invalid' }
  const tokens = normalized.split(/[\t\n\r ]+/u)
  if (tokens.length === 1) {
    const value = tokens[0]!
    if (!(responseFeedback as readonly string[]).includes(value)) return { kind: 'invalid' }
    const selections: FeedbackSignalSelection[] = [
      {
        preferenceKey: 'feedback.response',
        candidateValue: value as Extract<DeliveryPreferenceSelection, {
          preferenceKey: 'feedback.response'
        }>['candidateValue'],
      },
    ]
    if (value === 'too-long') {
      selections.push({ preferenceKey: 'response.verbosity', candidateValue: 'concise' })
    } else if (value === 'too-short') {
      selections.push({ preferenceKey: 'response.verbosity', candidateValue: 'detailed' })
    }
    return { kind: 'signals', selections: Object.freeze(selections) }
  }
  if (tokens.length !== 2) return { kind: 'invalid' }
  const category = tokens[0]!
  const value = tokens[1]!
  if (!Object.hasOwn(typedPreferences, category)) return { kind: 'invalid' }
  const entry = typedPreferences[category as keyof typeof typedPreferences]
  if (!(entry.values as readonly string[]).includes(value)) return { kind: 'invalid' }
  return {
    kind: 'signals',
    selections: Object.freeze([{
      preferenceKey: entry.preferenceKey,
      candidateValue: value,
    } as FeedbackSignalSelection]),
  }
}

function feedbackSignalIdempotencyKey(
  binding: Readonly<ConversationBinding>,
  envelope: Readonly<InboundEnvelope>,
  selection: Readonly<FeedbackSignalSelection>,
): string {
  const identity = JSON.stringify([
    binding.id,
    binding.version,
    binding.sessionId,
    binding.generation,
    envelope.channel,
    envelope.account,
    envelope.eventId,
    selection.preferenceKey,
    selection.candidateValue,
    'support',
  ])
  const digest = createHash('sha256')
    .update('assistant-delivery-feedback-v1\0')
    .update(identity)
    .digest('hex')
  return `delivery-feedback-v1:${digest}`
}

/** Build the exact Host-attested payload accepted by Preference Learning. */
export function feedbackSignalInput(
  binding: Readonly<ConversationBinding>,
  envelope: Readonly<InboundEnvelope>,
  selection: Readonly<FeedbackSignalSelection>,
  receivedAt: number,
): DeliveryPreferenceFeedback {
  return Object.freeze({
    scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
    ...selection,
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: 'typed-feedback',
    source: 'direct-owner-feedback',
    occurredAt: receivedAt,
    idempotencyKey: feedbackSignalIdempotencyKey(binding, envelope, selection),
  })
}
