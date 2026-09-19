// Download historical npm bytes and prepare a payload in memory. Never invoke
// the sender, load credentials, or send a registry write.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { fetchRegistryArtifact } from '../../plugins/plugin-control-plane/lib/registry-fetch.js'
import { prepareNpmPublish } from '../../plugins/plugin-control-plane/lib/npm-publish.js'

if (process.env.DSH_NPM_PUBLISH_PREPARATION_LIVE !== '1') throw new Error('Set DSH_NPM_PUBLISH_PREPARATION_LIVE=1 for read-only preparation')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: npm-publish-preparation-readback.mjs --output <evidence.json>')
const root = fileURLToPath(new URL('../../', import.meta.url)); const output = resolve(args[1])
const sha = value => createHash('sha256').update(value).digest('hex')
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const baselinePath = 'docs/evidence/release-0.1.32-2026-09-13.json'
const baselineBytes = execFileSync('git', ['show', `${baseCommit}:${baselinePath}`], { cwd: root })
const baseline = JSON.parse(baselineBytes)
const paths = ['plugins/plugin-control-plane/src/npm-publish.ts', 'plugins/plugin-control-plane/lib/npm-publish.js',
  'plugins/plugin-control-plane/src/registry-fetch.ts', 'plugins/plugin-control-plane/lib/registry-fetch.js',
  'scripts/e2e/npm-publish-preparation-readback.mjs']
const runtimeDigests = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(resolve(root, path)))])))
const registry = { id: 'npm-public', locator: 'https://registry.npmjs.org/', protocol: 'npm', caPins: [], tokenEnvironment: null }
const evidence = { schemaVersion: 1, kind: 'npm-publish-preparation-readback', startedAt: new Date().toISOString(), baseCommit,
  expectedIntegritySource: { path: baselinePath, sha256: sha(baselineBytes) }, runtimeDigests,
  authority: 'anonymous-https-read-only', registryWrites: 0, results: [], passed: false,
  limits: ['Historical published tarballs only; no publish sender was invoked and no token was read.',
    'Prepared payload compatibility does not prove npm acceptance, production publication or Host activation.'] }
try {
  for (const packageName of ['@dsh-enhanced/plugin-control-plane', '@dsh-enhanced/personal-memory']) {
    const approved = baseline.registry.results.find(item => item.name === packageName && item.version === '0.1.32' && item.ok)
    if (!approved) throw new Error('Missing committed integrity baseline')
    const fetched = await fetchRegistryArtifact({ registry, packageName, version: approved.version,
      expectedIntegrity: approved.integrity, timeoutMs: 30_000 }, {})
    if (!fetched.reference) throw new Error('Missing exact tarball reference')
    const prepared = prepareNpmPublish({ locator: registry.locator, packageName, version: approved.version,
      tarball: fetched.bytes, tag: 'next', expectedRegistryReference: fetched.reference })
    const payload = JSON.parse(prepared.body.toString('utf8'))
    const attachmentName = `${packageName}-${approved.version}.tgz`
    const attachment = payload._attachments[attachmentName]
    const dist = payload.versions[approved.version].dist
    if (!Buffer.from(attachment.data, 'base64').equals(fetched.bytes) || attachment.length !== fetched.bytes.length
      || dist.integrity !== approved.integrity || dist.tarball !== fetched.reference
      || payload['dist-tags'].next !== approved.version || payload.access !== 'public'
      || prepared.url !== `${registry.locator}${packageName.replace('/', '%2f')}`) throw new Error('Prepared npm payload differs from expected contract')
    evidence.results.push({ packageName, version: approved.version, tarballReference: fetched.reference,
      downloadedBytes: fetched.bytes.length, tarballSha256: sha(fetched.bytes), tarballIntegrity: approved.integrity,
      preparedUrl: prepared.url, attachmentName, payloadBytes: prepared.body.length, payloadSha256: sha(prepared.body), passed: true })
  }
  for (const path of paths) if (sha(await readFile(resolve(root, path))) !== runtimeDigests[path]) throw new Error('Probe runtime changed during execution')
  evidence.passed = true
} catch (error) { evidence.error = error instanceof Error ? error.message : 'Preparation failed'; process.exitCode = 1 }
finally {
  evidence.finishedAt = new Date().toISOString()
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ passed: evidence.passed, packages: evidence.results.length, registryWrites: 0, output })}\n`)
}
