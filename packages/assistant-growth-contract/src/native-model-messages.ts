import { isGrowthRecord } from './canonical.js'

function hasKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isTextMessage(value: unknown, role: 'system' | 'user', text: string): boolean {
  if (!isGrowthRecord(value) || value.role !== role || !Array.isArray(value.content) || value.content.length !== 1) return false
  const block: unknown = value.content[0]
  return isGrowthRecord(block) && hasKeys(block, ['type', 'text']) && block.type === 'text' && block.text === text
}

/**
 * Match the model-facing messages of one isolated, tool-free native Agent turn.
 * The pinned DSH AgentLoop may append its required working-directory snapshot;
 * no other runtime context, extra message, or changed prompt is admitted.
 */
export function matchesIsolatedModelMessages(
  messages: readonly unknown[], expected: Readonly<{ system: string; user: string; workspace: string }>,
): boolean {
  if (!Array.isArray(messages) || ![2, 3].includes(messages.length)
    || !isTextMessage(messages[0], 'system', expected.system)
    || !isTextMessage(messages[1], 'user', expected.user)) return false
  if (messages.length === 2) return true

  const contextText = `Current working directory: ${JSON.stringify(expected.workspace)}.`
  const runtime = messages[2]
  if (!isTextMessage(runtime, 'user',
    `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${contextText}`)
    || !isGrowthRecord(runtime)) return false
  const source = runtime.source
  if (!isGrowthRecord(source) || !hasKeys(source, ['kind', 'form', 'sections'])
    || source.kind !== 'runtime-context' || source.form !== 'snapshot'
    || !Array.isArray(source.sections) || source.sections.length !== 1) return false
  const section: unknown = source.sections[0]
  return isGrowthRecord(section) && hasKeys(section, ['name', 'text'])
    && section.name === 'working-directory:current' && section.text === contextText
}
