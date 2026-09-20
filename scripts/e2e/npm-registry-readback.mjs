// Read-only production registry probe. The expected integrity is frozen in an
// earlier committed release record, never learned from this network response.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { fetchRegistryArtifact } from '../../plugins/plugin-control-plane/lib/registry-fetch.js'

if (process.env.DSH_NPM_REGISTRY_LIVE !== '1') throw new Error('Set DSH_NPM_REGISTRY_LIVE=1 for this read-only network probe')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: npm-registry-readback.mjs --output <evidence.json>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(args[1])
const sha256 = value => createHash('sha256').update(value).digest('hex')
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim()
const baseCommit = git('rev-parse', 'HEAD')
const baselinePath = 'scripts/e2e/fixtures/npm-release-0.1.32.json'
const baselineBytes = execFileSync('git', ['show', `${baseCommit}:${baselinePath}`], { cwd: root })
const baseline = JSON.parse(baselineBytes)
const paths = ['plugins/plugin-control-plane/src/registry-fetch.ts', 'plugins/plugin-control-plane/lib/registry-fetch.js',
  'scripts/e2e/npm-registry-readback.mjs']
const runtimeDigests = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(resolve(root, path)))])))
const registry = { id: 'npm-public', locator: 'https://registry.npmjs.org', protocol: 'npm', caPins: [], tokenEnvironment: null }
const evidence = { schemaVersion: 1, kind: 'npm-registry-readback', startedAt: new Date().toISOString(), baseCommit,
  expectedIntegritySource: { path: baselinePath, sha256: sha256(baselineBytes), releaseSourceCommit: baseline.sourceCommit },
  runtimeDigests, registry, authority: 'anonymous-https-read-only', results: [], passed: false,
  limits: ['No publication, owner signing, source-release receipt, installation, Host activation or rollback was exercised.',
    'Network success does not establish full WP16 delivery or npm/Sigstore provenance verification.'] }
try {
  for (const name of ['@dsh-enhanced/plugin-control-plane', '@dsh-enhanced/personal-memory']) {
    const approved = baseline.registry.results.find(item => item.name === name && item.version === '0.1.32' && item.ok)
    if (!approved) throw new Error(`Missing committed baseline for ${name}`)
    const started = Date.now()
    const fetched = await fetchRegistryArtifact({ registry, packageName: name, version: approved.version,
      expectedIntegrity: approved.integrity, timeoutMs: 30_000 }, {})
    const actualIntegrity = `sha512-${createHash('sha512').update(fetched.bytes).digest('base64')}`
    if (actualIntegrity !== approved.integrity) throw new Error('Independent downloaded-byte check failed')
    evidence.results.push({ packageName: name, version: approved.version, expectedIntegrity: approved.integrity,
      downloadedIntegrity: actualIntegrity, downloadedSha256: sha256(fetched.bytes), downloadedBytes: fetched.bytes.length,
      reference: fetched.reference ?? null, durationMs: Date.now() - started, passed: true })
  }
  let rejected = false
  try {
    await fetchRegistryArtifact({ registry, packageName: '@dsh-enhanced/personal-memory', version: '0.1.32',
      expectedIntegrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`, timeoutMs: 30_000 }, {})
  } catch (error) {
    if (!(error instanceof Error) || !/integrity/u.test(error.message)) throw error
    rejected = true
  }
  if (!rejected) throw new Error('Registry metadata overrode the independent expected integrity')
  evidence.mismatchedExpectedIntegrityRejected = rejected
  for (const path of paths) {
    if (sha256(await readFile(resolve(root, path))) !== runtimeDigests[path]) throw new Error('Probe code changed during execution')
  }
  evidence.passed = true
} catch (error) {
  evidence.error = error instanceof Error ? error.message : 'Unexpected probe failure'
  process.exitCode = 1
} finally {
  evidence.finishedAt = new Date().toISOString()
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ passed: evidence.passed, packages: evidence.results.length, output })}\n`)
}
