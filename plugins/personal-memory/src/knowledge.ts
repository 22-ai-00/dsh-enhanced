import type { MemoryKnowledge } from './types.js'

/** Conditions are attributed notes, not predicates proven by lexical matching. */
export function normalizeMemoryKnowledge(input: unknown): MemoryKnowledge | undefined {
  if (input === undefined) return undefined
  const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))) throw new Error('invalid memory knowledge fields')
    return value as Record<string, unknown>
  }
  const text = (value: unknown, maxBytes: number): string => {
    if (typeof value !== 'string') throw new Error('memory knowledge text must be a string')
    const normalized = value.normalize('NFC').trim()
    if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
      throw new Error(`memory knowledge text must contain 1 to ${maxBytes} UTF-8 bytes`)
    }
    return normalized
  }
  const list = (value: unknown): readonly string[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length > 4) throw new Error('memory knowledge lists allow at most four notes')
    const notes = [...new Set(value.map(note => text(note, 256)))]
    return notes.length === 0 ? undefined : Object.freeze(notes)
  }
  const value = object(input, ['applicability', 'counterexamples', 'claim'])
  const applicability = list(value.applicability)
  const counterexamples = list(value.counterexamples)
  let claim: MemoryKnowledge['claim']
  if (value.claim !== undefined) {
    const raw = object(value.claim, ['key', 'value'])
    const key = text(raw.key, 128)
    if (!/^[a-z0-9][a-z0-9._:-]*$/.test(key)) throw new Error('memory claim key must be a lowercase ASCII identifier')
    claim = Object.freeze({ key, value: text(raw.value, 256) })
  }
  if (applicability === undefined && counterexamples === undefined && claim === undefined) return undefined
  return Object.freeze({
    ...(applicability === undefined ? {} : { applicability }),
    ...(counterexamples === undefined ? {} : { counterexamples }),
    ...(claim === undefined ? {} : { claim }),
  })
}

/** Index the notes so a relevant exception can be found, without declaring it applicable. */
export function memoryKnowledgeText(knowledge: MemoryKnowledge | undefined): string {
  return [
    ...(knowledge?.applicability ?? []),
    ...(knowledge?.counterexamples ?? []),
    ...(knowledge?.claim === undefined ? [] : [knowledge.claim.key, knowledge.claim.value]),
  ].join('\n')
}
