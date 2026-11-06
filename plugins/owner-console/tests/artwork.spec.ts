import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { artworkSource } from '../scripts/artwork-source.mjs'

// The build never rewrites `src/`: the generated file is committed. This keeps it
// in step with `assets/`, so a re-compressed asset cannot silently ship stale bytes.
it('commits the artwork generated from the committed assets', async () => {
  const expected = await artworkSource(new URL('../assets/', import.meta.url))
  const committed = await readFile(new URL('../src/artwork.ts', import.meta.url), 'utf8')
  expect(committed).toBe(expected)
  expect(committed).toContain("export const WENYAO_HERO_DATA_URI: string =\n  'data:image/webp;base64,")
  expect(committed).not.toContain('/Users/')
})
