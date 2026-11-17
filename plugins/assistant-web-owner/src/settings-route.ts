import { isMap, isScalar, parseDocument } from 'yaml'

export interface ConfiguredDefaultModelRoute { provider: string; model: string }
function fail(reason: string): never { throw new Error(`goal setup: ${reason}`) }
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid task fields')
}
function route(value: unknown): asserts value is ConfiguredDefaultModelRoute {
  shape(value, ['provider', 'model'])
  for (const field of ['provider', 'model']) {
    const item = value[field]
    if (typeof item !== 'string' || item.length === 0 || item.length > 200 || item.trim() !== item || /[\p{Cc}]/u.test(item)) fail('invalid model route')
  }
}
/** Read only the public, effective default-route fields from DSH's user settings layer. */
export function parseSettingsDefaultModelRoute(source: string): ConfiguredDefaultModelRoute | undefined {
  if (Buffer.byteLength(source, 'utf8') > 1024 * 1024) fail('settings.yaml exceeds 1 MiB')
  const document = parseDocument(source)
  if (document.errors.length > 0 || !isMap(document.contents) || document.contents.tag !== undefined) fail('settings.yaml must be an untagged YAML mapping')
  const selected = document.contents.get('agent-default-model', true)
  if (selected === undefined) return undefined
  if (!isMap(selected) || selected.tag !== undefined) fail('settings.agent-default-model must be an untagged YAML mapping')
  const fields: Record<string, unknown> = {}
  for (const key of ['provider', 'model']) {
    const value = selected.get(key, true)
    if (!isScalar(value) || value.tag !== undefined || typeof value.value !== 'string') fail('settings.agent-default-model must contain public provider and model strings')
    fields[key] = value.value
  }
  route(fields)
  return fields
}
