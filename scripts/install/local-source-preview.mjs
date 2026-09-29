import { isDeepStrictEqual } from 'node:util'

const LARK = 'dsh-enhanced-lark-channel'
const HEALTH = 'dsh-enhanced-assistant-health'
const fail = message => { throw new Error(`Local source preview: ${message}`) }

function signature(node, yaml) {
  if (node === null) return null
  if (yaml.isScalar(node)) return ['scalar', node.tag ?? null, node.value]
  if (yaml.isSeq(node)) return ['sequence', node.tag ?? null, node.items.map(item => signature(item, yaml))]
  if (yaml.isMap(node)) return ['map', node.tag ?? null, node.items.map(pair => {
    if (!yaml.isScalar(pair.key) || pair.key.tag || typeof pair.key.value !== 'string') fail('dynamic mapping key')
    return [pair.key.value, signature(pair.value, yaml)]
  }).sort(([left], [right]) => left.localeCompare(right))]
  fail('aliases or dynamic configuration nodes are unsupported')
}

function parse(source, yaml) {
  const document = yaml.parseDocument(source, { uniqueKeys: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (document.errors.length || document.warnings.length || !yaml.isSeq(document.contents)) fail('unsupported configuration')
  signature(document.contents, yaml)
  const rows = new Map()
  for (const row of document.contents.items) {
    const id = yaml.isMap(row) ? row.get('id', true) : undefined
    if (!yaml.isScalar(id) || id.tag || typeof id.value !== 'string' || rows.has(id.value)) fail('missing or duplicate row identity')
    rows.set(id.value, row)
  }
  return { document, rows }
}

function expectedPreview(source, yaml) {
  const parsed = parse(source, yaml)
  for (const [id, row] of parsed.rows) {
    const name = row.get('name', true)
    for (const [expectedId, expectedName] of [[LARK, '@dsh-enhanced/lark-channel'], [HEALTH, '@dsh-enhanced/assistant-health']]) {
      if (id === expectedId && (!yaml.isScalar(name) || name.tag || name.value !== expectedName)
        || yaml.isScalar(name) && name.value === expectedName && id !== expectedId) fail('Lark/Health module identity differs')
    }
  }
  const lark = parsed.rows.get(LARK)
  const disabled = lark?.get('disabled', true)
  if (!lark || disabled !== undefined && (!yaml.isScalar(disabled) || disabled.tag || disabled.value !== false)) fail('Lark row must be active')
  const config = lark.get('config', true)
  const enabled = yaml.isMap(config) ? config.get('enabled', true) : undefined
  if (!yaml.isScalar(enabled) || enabled.tag || enabled.value !== true) fail('Lark must be statically enabled')
  config.set('enabled', false)
  const changed = new Set([LARK])
  const health = parsed.rows.get(HEALTH)
  const healthConfig = health?.get('config', true)
  if (healthConfig !== undefined && !yaml.isMap(healthConfig)) fail('Health configuration must be a static mapping')
  const providers = healthConfig?.get('requiredProviders', true)
  if (providers !== undefined) {
    if (!yaml.isSeq(providers) || providers.tag || providers.items.some(value =>
      !yaml.isScalar(value) || value.tag || typeof value.value !== 'string')) fail('Health providers must be static strings')
    if (providers.items.some(value => value.value === 'larkChannel')) {
      providers.items = providers.items.filter(value => value.value !== 'larkChannel')
      changed.add(HEALTH)
    }
  }
  return { ...parsed, changed }
}

/** Pre-owner profiles need not declare Lark as a Health provider. Preserve that
 * absence, and preserve every existing check other than Lark's preview link. */
export function buildLocalSourcePreviewOverlay(source, yaml) {
  const { document, changed } = expectedPreview(source, yaml)
  document.contents.items = document.contents.items.filter(row => changed.has(row.get('id')))
  return document.toString({ lineWidth: 0 })
}

export function assertLocalSourcePreviewDerivation({ persistedConfig, previewConfig }, yaml) {
  const expected = expectedPreview(persistedConfig, yaml)
  const actual = parse(previewConfig, yaml)
  if (!isDeepStrictEqual(signature(expected.document.contents, yaml), signature(actual.document.contents, yaml))) {
    fail('preview changed configuration beyond the Lark channel and its existing Health requirement')
  }
}
