import { createHash } from 'node:crypto'
import type {
  ConversationBinding,
  DeliveryPreferenceFeedback,
  DeliveryPreferenceSelection,
  InboundEnvelope,
} from './types.js'
import { externalPrincipalId } from './canonical.js'

export type FeedbackSignalSelection = DeliveryPreferenceSelection & Readonly<{
  interpretationTrust?: 'explicit-selection' | 'typed-feedback'
}>
export type ObjectiveFeedbackStatus = 'achieved' | 'partial' | 'not-achieved'

export type NaturalPreferenceSelection = Extract<FeedbackSignalSelection, {
  preferenceKey: 'response.language' | 'response.structure' | 'response.verbosity'
}>

/**
 * A closed classification boundary for natural-language presentation requests.
 * Only `ordinary-content` is safe to reuse as implicit language evidence.
 */
export type NaturalPreferenceDirectiveClassification =
  | Readonly<{ kind: 'durable-exact-selection'; selection: NaturalPreferenceSelection }>
  | Readonly<{ kind: 'one-turn-directive' }>
  | Readonly<{ kind: 'ambiguous-or-unsupported-directive' }>
  | Readonly<{ kind: 'ordinary-content' }>

export type ParsedFeedbackCommand =
  | { kind: 'invalid' }
  | { kind: 'signals'; selections: readonly FeedbackSignalSelection[] }
  | { kind: 'objective'; objectiveStatus: ObjectiveFeedbackStatus }

const responseFeedback = Object.freeze([
  'helpful',
  'not-helpful',
  'too-long',
  'too-short',
  'wrong-format',
  'wrong-action',
  'unwanted-reminder',
] as const)

const objectiveFeedback = Object.freeze([
  'achieved',
  'partial',
  'not-achieved',
] as const satisfies readonly ObjectiveFeedbackStatus[])

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
  '- 回复一条自动化或普通 Agent 任务结果，并发送 /feedback achieved|partial|not-achieved（记录该次任务结果）',
  '- /feedback helpful|not-helpful|too-long|too-short|wrong-format|wrong-action|unwanted-reminder',
  '- /feedback verbosity concise|balanced|detailed',
  '- /feedback structure prose|bullets|mixed',
  '- /feedback language zh-CN|en',
  '- /feedback explanation result-first|balanced|tutorial',
  '- /feedback suggestions low|normal',
  '- /feedback ranking recency|familiarity|evidence',
  '',
  'helpful 等只记录偏好，不代表任务成败。任务结果必须回复对应的任务结果消息。',
  '反馈只作用于当前工作区与 preset；命令不接受附件，也不会进入模型。',
].join('\n')

/** Parse a closed, typed grammar. No caller-provided text crosses this boundary. */
export function parseFeedbackCommand(rawInput: string): ParsedFeedbackCommand {
  const normalized = rawInput.trim()
  if (normalized === '') return { kind: 'invalid' }
  const tokens = normalized.split(/[\t\n\r ]+/u)
  if (tokens.length === 1) {
    const value = tokens[0]!
    if ((objectiveFeedback as readonly string[]).includes(value)) {
      return { kind: 'objective', objectiveStatus: value as ObjectiveFeedbackStatus }
    }
    if (!(responseFeedback as readonly string[]).includes(value)) return { kind: 'invalid' }
    const selections: FeedbackSignalSelection[] = [
      {
        preferenceKey: 'feedback.response',
        candidateValue: value as Extract<DeliveryPreferenceSelection, {
          preferenceKey: 'feedback.response'
        }>['candidateValue'],
        interpretationTrust: 'typed-feedback',
      },
    ]
    if (value === 'too-long') {
      selections.push({
        preferenceKey: 'response.verbosity', candidateValue: 'concise',
        interpretationTrust: 'typed-feedback',
      })
    } else if (value === 'too-short') {
      selections.push({
        preferenceKey: 'response.verbosity', candidateValue: 'detailed',
        interpretationTrust: 'typed-feedback',
      })
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
      interpretationTrust: 'explicit-selection',
    } as FeedbackSignalSelection]),
  }
}

function feedbackSignalIdempotencyKey(
  binding: Readonly<ConversationBinding>,
  envelope: Readonly<InboundEnvelope>,
  selection: Readonly<FeedbackSignalSelection>,
  principalLineage: Readonly<import('./types.js').DeliveryOwnerLineage>,
  admissionCursor?: Readonly<import('./types.js').DeliveryAdmissionCursor>,
): string {
  const identity = JSON.stringify([
    binding.id,
    binding.version,
    binding.sessionId,
    binding.generation,
    principalLineage.principalRecordId,
    principalLineage.principalVersion,
    admissionCursor?.epoch ?? 'legacy-no-admission-epoch',
    admissionCursor?.sequence ?? 'legacy-no-admission-sequence',
    envelope.channel,
    envelope.account,
    envelope.eventId,
    selection.preferenceKey,
    selection.candidateValue,
    selection.interpretationTrust ?? 'typed-feedback',
    'support',
  ])
  const digest = createHash('sha256')
    .update('assistant-delivery-feedback-v3\0')
    .update(identity)
    .digest('hex')
  return `delivery-feedback-v3:${digest}`
}

/** Build the exact Host-attested payload accepted by Preference Learning. */
export function feedbackSignalInput(
  binding: Readonly<ConversationBinding>,
  envelope: Readonly<InboundEnvelope>,
  selection: Readonly<FeedbackSignalSelection>,
  authorization: Readonly<{
    occurredAt: number
    principalLineage: Readonly<import('./types.js').DeliveryOwnerLineage>
    admissionCursor?: Readonly<import('./types.js').DeliveryAdmissionCursor>
    exposureTarget?: Readonly<{ sourceInboxId: string; sourceOutboxId: string }>
  }>,
): DeliveryPreferenceFeedback {
  return Object.freeze({
    scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
    principalId: externalPrincipalId(binding.principal),
    principalLineage: authorization.principalLineage,
    ...(authorization.admissionCursor === undefined
      ? {}
      : { admissionCursor: authorization.admissionCursor }),
    preferenceKey: selection.preferenceKey,
    candidateValue: selection.candidateValue,
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: selection.interpretationTrust ?? 'typed-feedback',
    source: 'direct-owner-feedback',
    occurredAt: authorization.occurredAt,
    idempotencyKey: feedbackSignalIdempotencyKey(
      binding,
      envelope,
      selection,
      authorization.principalLineage,
      authorization.admissionCursor,
    ),
    ...(authorization.exposureTarget === undefined
      ? {}
      : { exposureTarget: Object.freeze({ ...authorization.exposureTarget }) }),
  }) as DeliveryPreferenceFeedback
}

/**
 * Deterministic local language classifier. It never emits the source text and
 * deliberately abstains for short or genuinely mixed messages.
 */
export function observedResponseLanguage(text: string): 'zh-CN' | 'en' | undefined {
  const withoutCode = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`]*`/gu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
  const han = (withoutCode.match(/\p{Script=Han}/gu) ?? []).length
  const latin = (withoutCode.match(/\p{Script=Latin}/gu) ?? []).length
  if (han >= 4 && han * 2 >= latin) return 'zh-CN'
  if (latin >= 8 && latin >= han * 2) return 'en'
  return undefined
}

const naturalPreferenceCorrections = new Map<string, NaturalPreferenceSelection>([
  ['以后简短一点', { preferenceKey: 'response.verbosity', candidateValue: 'concise', interpretationTrust: 'explicit-selection' }],
  ['今后简短一点', { preferenceKey: 'response.verbosity', candidateValue: 'concise', interpretationTrust: 'explicit-selection' }],
  ['从现在起回答简短一点', { preferenceKey: 'response.verbosity', candidateValue: 'concise', interpretationTrust: 'explicit-selection' }],
  ['以后回答详细一点', { preferenceKey: 'response.verbosity', candidateValue: 'detailed', interpretationTrust: 'explicit-selection' }],
  ['今后回答详细一点', { preferenceKey: 'response.verbosity', candidateValue: 'detailed', interpretationTrust: 'explicit-selection' }],
  ['以后用中文回答', { preferenceKey: 'response.language', candidateValue: 'zh-CN', interpretationTrust: 'explicit-selection' }],
  ['今后用中文回答', { preferenceKey: 'response.language', candidateValue: 'zh-CN', interpretationTrust: 'explicit-selection' }],
  ['从现在起用中文回答', { preferenceKey: 'response.language', candidateValue: 'zh-CN', interpretationTrust: 'explicit-selection' }],
  ['以后用英文回答', { preferenceKey: 'response.language', candidateValue: 'en', interpretationTrust: 'explicit-selection' }],
  ['今后用英文回答', { preferenceKey: 'response.language', candidateValue: 'en', interpretationTrust: 'explicit-selection' }],
  ['从现在起用英文回答', { preferenceKey: 'response.language', candidateValue: 'en', interpretationTrust: 'explicit-selection' }],
  ['以后少用列表', { preferenceKey: 'response.structure', candidateValue: 'prose', interpretationTrust: 'explicit-selection' }],
  ['今后少用列表', { preferenceKey: 'response.structure', candidateValue: 'prose', interpretationTrust: 'explicit-selection' }],
  ['以后多用列表', { preferenceKey: 'response.structure', candidateValue: 'bullets', interpretationTrust: 'explicit-selection' }],
  ['今后多用列表', { preferenceKey: 'response.structure', candidateValue: 'bullets', interpretationTrust: 'explicit-selection' }],
  ['from now on, be more concise', { preferenceKey: 'response.verbosity', candidateValue: 'concise', interpretationTrust: 'explicit-selection' }],
  ['keep future answers concise', { preferenceKey: 'response.verbosity', candidateValue: 'concise', interpretationTrust: 'explicit-selection' }],
  ['from now on, be more detailed', { preferenceKey: 'response.verbosity', candidateValue: 'detailed', interpretationTrust: 'explicit-selection' }],
  ['always answer in chinese', { preferenceKey: 'response.language', candidateValue: 'zh-CN', interpretationTrust: 'explicit-selection' }],
  ['from now on, respond in chinese', { preferenceKey: 'response.language', candidateValue: 'zh-CN', interpretationTrust: 'explicit-selection' }],
  ['always answer in english', { preferenceKey: 'response.language', candidateValue: 'en', interpretationTrust: 'explicit-selection' }],
  ['from now on, respond in english', { preferenceKey: 'response.language', candidateValue: 'en', interpretationTrust: 'explicit-selection' }],
  ['always use fewer lists', { preferenceKey: 'response.structure', candidateValue: 'prose', interpretationTrust: 'explicit-selection' }],
  ['always use more bullet points', { preferenceKey: 'response.structure', candidateValue: 'bullets', interpretationTrust: 'explicit-selection' }],
])

const oneShotPreferenceRequests = new Set([
  '回答简短一点', '请简短回答', '回答详细一点', '请详细回答',
  '请用中文回答', '用中文回答', '请用英文回答', '用英文回答', '少用列表', '多用列表',
  'be more concise', 'keep answers concise', 'be more detailed',
  'answer in chinese', 'respond in chinese', 'answer in english', 'respond in english',
  'please answer in chinese', 'please respond in chinese',
  'please answer in english', 'please respond in english',
  'please be concise', 'please be more concise', 'please be detailed', 'please be more detailed',
  'please use fewer lists', 'please use more bullet points',
  'use fewer lists', 'use more bullet points',
])

const oneTurnDirective = Object.freeze({ kind: 'one-turn-directive' } as const)
const ambiguousDirective = Object.freeze({ kind: 'ambiguous-or-unsupported-directive' } as const)
const ordinaryContent = Object.freeze({ kind: 'ordinary-content' } as const)

function normalizedNaturalPreferenceText(text: string): string | undefined {
  if (Buffer.byteLength(text, 'utf8') > 96 || /[\r\n`"“”'‘’]/u.test(text)) return undefined
  return text.normalize('NFC').trim().replace(/[。！？.!?]+$/u, '').trim().toLowerCase()
}

function durableSelection(
  selection: NaturalPreferenceSelection,
): NaturalPreferenceDirectiveClassification {
  return Object.freeze({
    kind: 'durable-exact-selection' as const,
    selection: Object.freeze({ ...selection }),
  })
}

function languageSelection(language: string): NaturalPreferenceSelection {
  return {
    preferenceKey: 'response.language',
    candidateValue: language === '中文' || language === 'chinese' ? 'zh-CN' : 'en',
    interpretationTrust: 'explicit-selection',
  }
}

function exactDurablePreferenceSelection(
  normalized: string,
): NaturalPreferenceSelection | undefined {
  const catalogSelection = naturalPreferenceCorrections.get(normalized)
  if (catalogSelection !== undefined) return catalogSelection

  const chineseLanguage = /^(?:(?:请|请你|麻烦|麻烦你)\s*)?(?:以后|今后|从现在起)(?:都|一直)?(?:请|请你)?\s*(?:用|使用)(中文|英文)(?:回答|回复)$/u.exec(normalized)
  if (chineseLanguage?.[1] !== undefined) return languageSelection(chineseLanguage[1])

  const englishLanguage = /^(?:please\s+)?(?:from now on,?\s*|in (?:the )?future,?\s*|always\s+)(?:please\s+)?(?:answer|respond|reply)(?: to me)? in (chinese|english)$/u.exec(normalized)
  if (englishLanguage?.[1] !== undefined) return languageSelection(englishLanguage[1])

  const chineseVerbosity = /^(?:(?:请|请你|麻烦|麻烦你)\s*)?(?:以后|今后|从现在起)(?:都|一直)?(?:请|请你)?\s*(?:(?:回答|回复)(?:得)?(简短|详细)(?:一点|些)?|(简短|详细)(?:一点|些)?(?:回答|回复))$/u.exec(normalized)
  const chineseVerbosityValue = chineseVerbosity?.[1] ?? chineseVerbosity?.[2]
  if (chineseVerbosityValue !== undefined) {
    return {
      preferenceKey: 'response.verbosity',
      candidateValue: chineseVerbosityValue === '简短' ? 'concise' : 'detailed',
      interpretationTrust: 'explicit-selection',
    }
  }

  const englishVerbosity = /^(?:please\s+)?(?:(?:from now on|in (?:the )?future|always),?\s+(?:please\s+)?(?:be\s+)?(?:more\s+)?(concise|detailed)|keep future answers (concise|detailed))$/u.exec(normalized)
  const englishVerbosityValue = englishVerbosity?.[1] ?? englishVerbosity?.[2]
  if (englishVerbosityValue !== undefined) {
    return {
      preferenceKey: 'response.verbosity',
      candidateValue: englishVerbosityValue === 'concise' ? 'concise' : 'detailed',
      interpretationTrust: 'explicit-selection',
    }
  }

  const chineseStructure = /^(?:(?:请|请你|麻烦|麻烦你)\s*)?(?:以后|今后|从现在起)(?:都|一直)?(?:请|请你)?\s*(少用|多用)(?:列表|项目符号)$/u.exec(normalized)
  if (chineseStructure?.[1] !== undefined) {
    return {
      preferenceKey: 'response.structure',
      candidateValue: chineseStructure[1] === '少用' ? 'prose' : 'bullets',
      interpretationTrust: 'explicit-selection',
    }
  }

  const englishStructure = /^(?:please\s+)?(?:from now on,?\s*|in (?:the )?future,?\s*|always\s+)(?:please\s+)?use (fewer lists|more bullet points)$/u.exec(normalized)
  if (englishStructure?.[1] !== undefined) {
    return {
      preferenceKey: 'response.structure',
      candidateValue: englishStructure[1] === 'fewer lists' ? 'prose' : 'bullets',
      interpretationTrust: 'explicit-selection',
    }
  }

  return undefined
}

function isExactOneTurnPreferenceDirective(normalized: string): boolean {
  if (oneShotPreferenceRequests.has(normalized)) return true

  const chineseTemporary = /^(?:这次|本次|此次)(?:请|请你)?\s*(?:(?:用|使用)(?:中文|英文)(?:回答|回复)(?:(?:这个|本次|当前)(?:问题|回答|回复))?|(?:回答|回复)(?:得)?(?:简短|详细)(?:一点|些)?|(?:简短|详细)(?:一点|些)?(?:回答|回复)|少用(?:列表|项目符号)|多用(?:列表|项目符号))$/u
  const chineseDirective = /^(?:(?:请|请你|麻烦|麻烦你)\s*)?(?:(?:用|使用)(?:中文|英文)(?:回答|回复)(?:(?:这个|本次|当前)(?:问题|回答|回复)|本题|这道题)?|(?:回答|回复)(?:这个问题|本题|这道题)?(?:得)?(?:简短|详细)(?:一点|些)?|(?:简短|详细)(?:一点|些)?(?:回答|回复)|少用(?:列表|项目符号)|多用(?:列表|项目符号))$/u
  const englishTemporary = /^(?:this time,?\s*|for this (?:answer|response|question),?\s*)(?:please\s+)?(?:(?:answer|respond|reply)(?: to me)? in (?:chinese|english)|answer (?:this|this question|this response) in (?:chinese|english)|(?:respond|reply) to (?:this|this question|this response) in (?:chinese|english)|be (?:more )?(?:concise|detailed)|use (?:fewer lists|more bullet points))$/u
  const englishDirective = /^(?:(?:please|(?:could|would|can) you(?: please)?)\s+)?(?:(?:answer|respond|reply)(?: to me)? in (?:chinese|english)|answer (?:this|this question|this response) in (?:chinese|english)|(?:respond|reply) to (?:this|this question|this response) in (?:chinese|english)|be (?:more )?(?:concise|detailed)|use (?:fewer lists|more bullet points))$/u
  return chineseTemporary.test(normalized)
    || chineseDirective.test(normalized)
    || englishTemporary.test(normalized)
    || englishDirective.test(normalized)
}

function containsPotentialPreferenceDirective(text: string): boolean {
  const normalized = text.normalize('NFC').toLowerCase()
  const chineseLanguage = /(?:(?:用|使用|说|写).{0,8}(?:中文|英文)|(?:中文|英文).{0,12}(?:回答|回复|答复))/su
  const chineseUnsupportedLanguage = /(?:用|使用)[^，。！？\r\n]{1,16}(?:语|文)(?:回答|回复|答复)/su
  const chinesePresentation = /(?:(?:回答|回复|答复).{0,12}(?:简短|简洁|详细|列表|项目符号)|(?:简短|简洁|详细|列表|项目符号).{0,12}(?:回答|回复|答复))/su
  const chineseDirectStyle = /(?:(?:请|请你|麻烦|麻烦你|这次|本次|此次|以后|今后|从现在起).{0,16}(?:简短|简洁|详细)(?:一点|一些|些)?|(?:简短|简洁|详细)(?:一点|一些|些)?(?:回答|回复)|(?:少用|多用)(?:列表|项目符号))/su
  const chineseFutureStyle = /(?:以后|今后|从现在起).{0,32}(?:回答|回复|答复|语言|语气|风格|格式|中文|英文|简短|简洁|详细|列表|项目符号)/su
  const englishLanguage = /(?:(?:answer|respond|reply|write|speak).{0,32}\b(?:chinese|english)\b|\b(?:chinese|english)\b.{0,32}(?:answer|response|respond|reply))/su
  const englishUnsupportedLanguage = /(?:answer|respond|reply).{0,24}\bin\s+[a-z][a-z-]{2,20}\b/su
  const englishPresentation = /(?:(?:answer|response|respond|reply).{0,32}\b(?:concise|detailed|brief|list|lists|bullet|bullets|tone|style|format)\b|\b(?:concise|detailed|brief|lists?|bullets?|tone|style|format)\b.{0,32}(?:answer|response|respond|reply))/su
  const englishDirectStyle = /\b(?:be (?:more )?(?:concise|detailed)|use (?:fewer lists|more bullet points))\b/su
  const englishFutureStyle = /(?:from now on|in the future|future answers?|always).{0,48}(?:answer|response|respond|reply|language|tone|style|format|chinese|english|concise|detailed|lists?|bullets?)/su
  return chineseLanguage.test(normalized)
    || chineseUnsupportedLanguage.test(normalized)
    || chinesePresentation.test(normalized)
    || chineseDirectStyle.test(normalized)
    || chineseFutureStyle.test(normalized)
    || englishLanguage.test(normalized)
    || englishUnsupportedLanguage.test(normalized)
    || englishPresentation.test(normalized)
    || englishDirectStyle.test(normalized)
    || englishFutureStyle.test(normalized)
}

/**
 * Classify a whole user message without interpreting arbitrary prose. Exact
 * supported directives are separated from directive-like mixtures; callers
 * must admit implicit behavior evidence only for `ordinary-content`.
 */
export function classifyNaturalPreferenceDirective(
  text: string,
): NaturalPreferenceDirectiveClassification {
  const normalized = normalizedNaturalPreferenceText(text)
  if (normalized !== undefined) {
    const selection = exactDurablePreferenceSelection(normalized)
    if (selection !== undefined) return durableSelection(selection)
    if (isExactOneTurnPreferenceDirective(normalized)) return oneTurnDirective
  }
  return containsPotentialPreferenceDirective(text) ? ambiguousDirective : ordinaryContent
}

/** Closed whole-message grammar; quoted prose, code, multiline, and long text abstain. */
export function parseNaturalPreferenceCorrection(text: string): NaturalPreferenceSelection | undefined {
  const classification = classifyNaturalPreferenceDirective(text)
  return classification.kind === 'durable-exact-selection'
    ? classification.selection
    : undefined
}

/** One-turn style requests must not become durable preferences or opposite language evidence. */
export function isOneShotPreferenceRequest(text: string): boolean {
  return classifyNaturalPreferenceDirective(text).kind === 'one-turn-directive'
}
