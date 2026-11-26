import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** Wraps the browser bundle in the module-loader contract the Web shell expects. */
const bundled = (await build({
  entryPoints: [fileURLToPath(new URL('../src/client.ts', import.meta.url))],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  external: ['react', 'react/jsx-runtime'],
  charset: 'utf8',
  legalComments: 'none',
})).outputFiles[0]?.text
if (bundled === undefined) throw new Error('owner-console: client bundle emitted no output')
const directory = new URL('../lib/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('client.js', directory), `window.__ModuleLoader__.load({
  id: '@dsh-ray/owner-console',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ${bundled}
    return module.exports;
  }
});\n`, 'utf8')
