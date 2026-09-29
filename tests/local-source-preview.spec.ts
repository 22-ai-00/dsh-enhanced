import { describe, expect, test } from 'vitest'
import * as yaml from 'yaml'
import { buildLocalSourcePreviewOverlay, assertLocalSourcePreviewDerivation } from '../scripts/install/local-source-preview.mjs'

const baseline = (providers?: string[]) => yaml.stringify([
  { id: 'dsh-enhanced-lark-channel', name: '@dsh-enhanced/lark-channel', config: { enabled: true, account: 'owner' } },
  { id: 'dsh-enhanced-assistant-health', name: '@dsh-enhanced/assistant-health', config: {
    marker: 'keep', ...(providers === undefined ? {} : { requiredProviders: providers }),
  } },
  { id: 'other', config: { enabled: true } },
])
function compose(source: string, overlay: string) {
  const changes = new Map(yaml.parse(overlay).map((row: { id: string }) => [row.id, row]))
  return yaml.stringify(yaml.parse(source).map((row: { id: string }) => changes.get(row.id) ?? row))
}

describe('pre-owner local source preview', () => {
  test.each([undefined, [], ['credentialsKeychain'], ['credentialsKeychain', 'larkChannel', 'assistantDelivery']])(
    'preserves existing Health requirements for %j', providers => {
      const source = baseline(providers)
      const overlay = buildLocalSourcePreviewOverlay(source, yaml)
      const preview = compose(source, overlay)
      expect(() => assertLocalSourcePreviewDerivation({ persistedConfig: source, previewConfig: preview }, yaml)).not.toThrow()
      const health = yaml.parse(preview)[1].config
      if (providers === undefined) expect(health).not.toHaveProperty('requiredProviders')
      else expect(health.requiredProviders).toEqual(providers.filter(value => value !== 'larkChannel'))
      expect(health.marker).toBe('keep')
    },
  )
  test('does not invent an absent Health row', () => {
    const source = yaml.stringify([yaml.parse(baseline())[0]])
    const preview = compose(source, buildLocalSourcePreviewOverlay(source, yaml))
    expect(() => assertLocalSourcePreviewDerivation({ persistedConfig: source, previewConfig: preview }, yaml)).not.toThrow()
    expect(yaml.parse(preview)).toHaveLength(1)
  })
  test.each(['drop-provider', 'extra-setting', 'row-order', 'extra-row'])('rejects %s drift', change => {
    const source = baseline(['larkChannel', 'credentialsKeychain'])
    const rows = yaml.parse(compose(source, buildLocalSourcePreviewOverlay(source, yaml)))
    if (change === 'drop-provider') rows[1].config.requiredProviders = []
    if (change === 'extra-setting') rows[2].config.enabled = false
    if (change === 'row-order') rows.reverse()
    if (change === 'extra-row') rows.push({ id: 'added' })
    expect(() => assertLocalSourcePreviewDerivation({ persistedConfig: source, previewConfig: yaml.stringify(rows) }, yaml)).toThrow('beyond')
  })
  test('preserves inert JS tags and rejects changing them to plain strings', () => {
    const source = baseline() + '  path: !!js process.exit(77)\n'
    const preview = source.replace('enabled: true', 'enabled: false')
    expect(() => assertLocalSourcePreviewDerivation({ persistedConfig: source, previewConfig: preview }, yaml)).not.toThrow()
    expect(() => assertLocalSourcePreviewDerivation({ persistedConfig: source,
      previewConfig: preview.replace('!!js process.exit(77)', 'process.exit(77)') }, yaml)).toThrow('beyond')
  })
  test.each([
    baseline().replace('enabled: true', 'enabled: !!js true'),
    baseline().replace('enabled: true', 'enabled: false'),
    baseline() + '- id: dsh-enhanced-lark-channel\n',
    baseline() + '- id: dsh-enhanced-assistant-health\n',
    baseline(['larkChannel']).replace('- larkChannel', '- !!js larkChannel'),
    baseline().replace('@dsh-enhanced/lark-channel', '@dsh-enhanced/other'),
    baseline().replace('@dsh-enhanced/assistant-health', '@dsh-enhanced/other'),
    baseline() + '- id: duplicate-module\n  name: "@dsh-enhanced/lark-channel"\n',
    baseline() + '- id: duplicate-module\n  name: "@dsh-enhanced/assistant-health"\n',
  ])('rejects ambiguous or dynamic input', source => {
    expect(() => buildLocalSourcePreviewOverlay(source, yaml)).toThrow()
  })
})
