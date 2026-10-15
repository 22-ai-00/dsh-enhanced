import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { NATIVE_SOURCE_COMPILER } from '../src/native-source-build-worker.js'
import { packNativeCreatedPlugin } from '../src/native-source-pack.js'

const modulesPath = realpathSync(join(import.meta.dirname, '..', '..', '..', 'node_modules'))
const fixed = new Map([
  ['package.json', JSON.stringify({ name: '@dsh-enhanced/rsi-helper', version: '0.1.0',
    main: './lib/index.js', types: './lib/index.d.ts',
    files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'], dsh: { bundle: { patch: './cordis.patch.yml' } } })],
  ['README.md', '# Helper\n'], ['LICENSE', 'MIT\n'], ['cordis.patch.yml', 'plugins: []\n'],
])

function compile(source: string, extraFiles: Array<{ path: string; content: string }> = []) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', NATIVE_SOURCE_COMPILER], {
    input: JSON.stringify({ schemaVersion: 1, modulesPath, files: [{ path: 'src/index.ts', content: source }, ...extraFiles] }),
    encoding: 'utf8', timeout: 15_000,
  })
}

describe('fixed native compiler and Host packer', () => {
  it('runs semantic TypeScript compilation and emits deterministic safe package bytes', () => {
    const built = compile('export const answer: number = 42\n')
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
    const output = JSON.parse(built.stdout) as { checks: string[]; files: Array<{ path: string; content: string }> }
    expect(output.checks).toEqual(['semantic-typecheck', 'js-declaration-emit'])
    const emitted = new Map(output.files.map(file => [file.path, file.content]))
    expect(emitted.get('lib/index.js')).toContain('answer = 42')
    expect(emitted.get('lib/index.d.ts')).toContain('answer: number')
    const first = packNativeCreatedPlugin('rsi-helper', fixed, emitted)
    const second = packNativeCreatedPlugin('rsi-helper', fixed, emitted)
    expect(first.bytes.equals(second.bytes)).toBe(true)
    expect(first.bytes.length).toBeLessThanOrEqual(512 * 1024)
    expect(gunzipSync(first.bytes).includes(Buffer.from('package/lib/index.js'))).toBe(true)
  })

  it('rejects a semantic type error before emit', () => {
    const built = compile('export const answer: number = "wrong"\n')
    expect(built.status).toBe(1)
    expect(built.stderr).toContain('semantic TypeScript diagnostics')
    expect(built.stdout).toBe('')
  })

  it('checks an unimported TSX source and rejects its semantic error before emit', () => {
    const built = compile('export const answer: number = 42\n', [
      { path: 'src/orphan.tsx', content: 'export const orphan: number = "wrong"\n' },
    ])
    expect(built.status).toBe(1)
    expect(built.stderr).toContain('semantic TypeScript diagnostics')
    expect(built.stderr).toContain('orphan.tsx')
    expect(built.stdout).toBe('')
  })

  it('resolves the approved Cordis runtime type from the pinned modules tree', () => {
    const built = compile("import type { Context } from '@deepseek-ai/cordis'\nexport function apply(ctx: Context): void { void ctx }\n")
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' })
    const output = JSON.parse(built.stdout) as { files: Array<{ path: string; content: string }> }
    expect(output.files.find(file => file.path === 'lib/index.js')?.content).toContain('function apply')
  })

  it('rejects path injection in Host pack input', () => {
    expect(() => packNativeCreatedPlugin('rsi-helper', fixed, new Map([
      ['lib/index.js', 'export {}'], ['lib/index.d.ts', 'export {}'], ['lib/../escape.js', 'x'],
    ]))).toThrow(/compiler output is unsafe/u)
  })

})
