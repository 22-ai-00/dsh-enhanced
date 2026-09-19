// Real local Docker smoke for the source preparation boundary. No model,
// registry publication, production profile, or owner credential is involved.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectSourceContext } from '../../plugins/plugin-control-plane/lib/source-context.js'
import { runDockerPreparedChecks } from '../../plugins/plugin-control-plane/lib/source-build.js'

const image = process.env.DSH_SOURCE_BUILD_IMAGE
assert.match(image ?? '', /^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/, 'set DSH_SOURCE_BUILD_IMAGE to a locally available pinned image with Node, pnpm and tar')
const root = await mkdtemp(join(tmpdir(), 'dsh-source-docker-smoke-'))
const repository = join(root, 'repository')
const pluginRoot = join(repository, 'plugins', 'smoke-helper')
const env = { PATH: process.env.PATH, HOME: root }
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repository, env, encoding: 'utf8' }).trim()
try {
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'source-smoke', version: '1.0.0', private: true, scripts: { check: 'node check.cjs' } }))
  await writeFile(join(repository, 'check.cjs'), `
    const assert = require('node:assert/strict'); const fs = require('node:fs');
    assert.notEqual(process.getuid(), 0);
    assert.equal(fs.existsSync('.git'), false);
    assert.equal(fs.existsSync('/var/run/docker.sock'), false);
    assert.equal(fs.existsSync(${JSON.stringify(root)}), false);
    assert.equal(process.env.SOURCE_SMOKE_SECRET, undefined);
    assert.throws(() => fs.writeFileSync('/escape', 'no'));
    assert.equal(fs.readFileSync('plugins/smoke-helper/index.js', 'utf8'), 'export const patched = true\\n');
  `)
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/smoke-helper', version: '1.0.0', type: 'module', files: ['index.js'] }))
  await writeFile(join(pluginRoot, 'index.js'), 'export const patched = false\n')
  execFileSync('pnpm', ['install', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: repository, env, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Source boundary smoke'); git('config', 'user.email', 'source-smoke@example.invalid')
  git('add', '--all'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
  const baseCommit = git('rev-parse', 'HEAD')
  await writeFile(join(pluginRoot, 'index.js'), 'export const patched = true\n')
  const inspected = await inspectSourceContext({ repository, name: 'smoke-helper', paths: ['index.js'], baseCommit,
    environment: env, signal: AbortSignal.timeout(15_000), assertCurrent: async () => {} })
  assert.equal(inspected.baseCommit, baseCommit)
  assert.equal(inspected.contents[0].content, 'export const patched = false\n', 'inspection must read the committed base, not dirty candidate bytes')
  const config = { dockerPath: '/usr/bin/docker', image, timeoutMs: 60_000,
    memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, outputBytes: 262_144 }
  const result = await runDockerPreparedChecks({ config, worktree: repository, baseCommit, name: 'smoke-helper',
    scope: ['plugins/smoke-helper'], environment: { ...env, SOURCE_SMOKE_SECRET: 'must-not-cross-boundary' },
    signal: AbortSignal.timeout(70_000), assertCurrent: async () => {}, preparedAt: Date.now() })
  assert.match(result.treeDigest, /^[a-f0-9]{64}$/)
  assert.match(result.evidence.pack.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result.evidence.pack.version, '1.0.0')
  assert.equal(await readFile(join(pluginRoot, 'index.js'), 'utf8'), 'export const patched = true\n')
  const containers = execFileSync('/usr/bin/docker', ['ps', '-aq', '--filter', 'name=dsh-source-prepare-'], { encoding: 'utf8' }).trim()
  assert.equal(containers, '', 'source preparation containers must be removed')
  const evidence = { kind: 'real-local-docker-source-preparation-smoke', image, passed: true,
    checkedAt: new Date().toISOString(), baseCommit, inspectedBaseCommit: inspected.baseCommit, result,
    assertions: ['committed-source-read', 'read-base-matches-build-base', 'nonroot', 'no-host-path', 'no-git-metadata', 'no-docker-socket', 'no-forwarded-secret', 'readonly-root', 'patched-input-checked', 'container-removed'],
    limits: ['synthetic local package; no full repository build', 'no real model or owner route', 'no registry publication or production activation'] }
  if (process.env.DSH_SOURCE_BUILD_EVIDENCE) await writeFile(resolve(process.env.DSH_SOURCE_BUILD_EVIDENCE), JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally { await rm(root, { recursive: true, force: true }) }
