import { writeFile } from 'node:fs/promises'
import { artworkSource } from './artwork-source.mjs'

/**
 * Regenerates `src/artwork.ts` from `assets/`. Run by hand when the artwork set
 * changes; the build does not call it, because the generated file is committed and
 * `tests/artwork.spec.ts` fails if it drifts from `assets/`.
 *
 * Pipeline (see README "界面布局"):
 *   python3 scripts/prepare-assets.py   # only when the 11 深海觉醒 source artwork changes
 *   node scripts/build-assets.mjs       # commit the regenerated src/artwork.ts
 */
const source = await artworkSource(new URL('../assets/', import.meta.url))
await writeFile(new URL('../src/artwork.ts', import.meta.url), source, 'utf8')
console.log(`owner-console artwork: ${source.length} chars of inlined data URIs`)
