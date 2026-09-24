import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Only our notice UI is distributed here. The owner Host adapter mounts the
// installed DSH controller's native client through its own Loader metadata.
// Copying the build-time peer here mixes old submission types with newer UI.
const bundled = (await build({
  entryPoints: [new URL('../src/client.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
})).outputFiles[0]?.text
if (bundled === undefined) throw new Error('assistant-web-owner: notice client bundle emitted no output')
const output = `window.__ModuleLoader__.load({
  id: '@dsh-enhanced/assistant-web-owner',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ${bundled}
    return module.exports;
  }
});\n`
const directory = process.env.DSH_WEB_OWNER_CLIENT_OUT === undefined
  ? new URL('../lib/', import.meta.url)
  : pathToFileURL(resolve(process.env.DSH_WEB_OWNER_CLIENT_OUT) + sep)
await mkdir(directory, { recursive: true })
await writeFile(new URL('client.js', directory), output, 'utf8')
// tsc emits the actual notice-client declarations; do not re-export an unrelated
// installed Session client type. The explicit output seam is used by build tests.
