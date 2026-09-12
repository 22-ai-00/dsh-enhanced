import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evaluationRoot = join(repositoryRoot, 'plugins', 'assistant-evaluation')
const acceptanceContractRoot = join(repositoryRoot, 'node_modules', '@dsh-enhanced', 'task-acceptance-contract')
const temporaryRoots: string[] = []
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(command: string, args: readonly string[], cwd = repositoryRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  expect(result.status, `${command} ${args.join(' ')}\n${result.stderr}`).toBe(0)
  return result
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('assistant-evaluation holdout package contract', () => {
  test('packs an importable public holdout surface without private evaluation material', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-evaluation-holdout-pack-'))
    temporaryRoots.push(root)
    const packRoot = join(root, 'pack')
    await mkdir(packRoot)

    run(pnpm, ['--dir', evaluationRoot, 'run', 'build'])
    run(pnpm, ['--dir', evaluationRoot, 'pack', '--pack-destination', packRoot, '--json'])

    const tarballs = (await readdir(packRoot)).filter(path => path.endsWith('.tgz'))
    expect(tarballs).toHaveLength(1)
    const tarball = join(packRoot, tarballs[0]!)
    const listing = run('tar', ['-tzf', tarball]).stdout.trim().split('\n').filter(Boolean)
    expect(listing).toContain('package/lib/benchmark/holdout.js')
    expect(listing).toContain('package/lib/benchmark/holdout.d.ts')
    expect(listing).toContain('package/bin/dsh-benchmark.js')
    expect(listing.some(path => /(?:^|\/)(?:tests?|fixtures|evidence)(?:\/|$)/iu.test(path))).toBe(false)
    expect(listing.filter(path => /evidence/iu.test(path)
      && !/^package\/lib\/.+-evidence\.(?:d\.ts|js)(?:\.map)?$/u.test(path))).toEqual([])
    expect(listing.some(path => /(?:^|\/)(?:private[-_.]?key[^/]*|[^/]+\.(?:key|pem|p12|pfx|jwk|sqlite|sqlite3|db))(?:$|\/)/iu.test(path))).toBe(false)

    const packageRoot = join(root, 'app', 'node_modules', '@dsh-enhanced', 'assistant-evaluation')
    await mkdir(packageRoot, { recursive: true })
    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', packageRoot])
    const privateKeyMarkers = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----', '-----BEGIN OPENSSH PRIVATE KEY-----']
    for (const path of listing.filter(path => !path.endsWith('/'))) {
      const bytes = await readFile(join(packageRoot, path.replace(/^package\//u, '')))
      expect(privateKeyMarkers.some(marker => bytes.includes(marker)), path).toBe(false)
    }
    await symlink(acceptanceContractRoot, join(dirname(packageRoot), 'task-acceptance-contract'), 'dir')

    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
      exports?: Record<string, unknown>
    }
    expect(manifest.exports?.['./benchmark/holdout']).toEqual({
      types: './lib/benchmark/holdout.d.ts',
      default: './lib/benchmark/holdout.js',
    })
    expect(manifest.bin).toEqual({ 'dsh-benchmark': './bin/dsh-benchmark.js' })
    await expect(access(join(packageRoot, 'bin', 'dsh-benchmark.js'), constants.X_OK)).resolves.toBeUndefined()

    const probe = run(process.execPath, ['--input-type=module', '--eval', `
      const holdout = await import('@dsh-enhanced/assistant-evaluation/benchmark/holdout')
      const required = [
        'HOLDOUT_PROTOCOL_V1', 'HoldoutEvidenceStore', 'createHoldoutEvidenceVerifier', 'holdoutEnvelopeDigest',
        'openHoldoutProvider', 'parseSignedHoldoutManifest', 'runIndependentHoldout',
        'runIndependentHoldoutInContext',
      ]
      const missing = required.filter(name => !(name in holdout))
      if (missing.length > 0) throw new Error('missing holdout exports: ' + missing.join(', '))
      process.stdout.write(JSON.stringify(required))
    `], join(root, 'app'))
    expect(JSON.parse(probe.stdout)).toContain('runIndependentHoldout')
  }, 45_000)
})
