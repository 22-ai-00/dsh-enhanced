import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

/** Wraps the browser bundle in the module-loader contract the Web shell expects. */
const bundled = (await build({
  entryPoints: [new URL('../src/client.tsx', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
})).outputFiles[0]?.text
if (bundled === undefined) throw new Error('owner-console: client bundle emitted no output')
const directory = new URL('../lib/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('client.js', directory), `window.__ModuleLoader__.load({
  id: '@dsh-enhanced/owner-console',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ${bundled}
    return module.exports;
  }
});\n`, 'utf8')
