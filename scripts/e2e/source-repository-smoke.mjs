// Owner-invoked engineering proof of the full repository source-build gate.
// This checks the current workspace snapshot, including uncommitted changes;
// it does not grant an Agent access to the repository-wide scope used here.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { runDockerPreparedChecks } from '../../plugins/plugin-control-plane/lib/source-build.js'

assert.equal(process.env.DSH_SOURCE_REPOSITORY_LIVE, '1', 'set DSH_SOURCE_REPOSITORY_LIVE=1 to run the full offline repository check')
const image = process.env.DSH_SOURCE_BUILD_IMAGE
assert.match(image ?? '', /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u)
const repository = await realpath(fileURLToPath(new URL('../..', import.meta.url)))
const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const baseCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repository, env: environment, encoding: 'utf8' }).trim()
const abort = new AbortController()
const stop = () => abort.abort(new Error('owner stopped repository source check'))
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  const result = await runDockerPreparedChecks({
    config: { dockerPath: '/usr/bin/docker', image, profile: 'repository', timeoutMs: 1_800_000,
      repositorySandbox: { seccompPath: resolve(repository, 'scripts/isolation/source-builder-seccomp.json') },
      memoryMiB: 16_384, cpus: 8, pidsLimit: 1_024, workspaceMiB: 4_096, temporaryMiB: 2_048, outputBytes: 65_536 },
    worktree: repository, baseCommit, name: 'plugin-control-plane', scope: ['.'], environment,
    signal: abort.signal, assertCurrent: async () => abort.signal.throwIfAborted(), preparedAt: Date.now(),
  })
  assert.equal(result.evidence.environment.pnpmVersion, '11.7.0')
  assert.equal(result.evidence.commands[0].exitCode, 0)
  assert.ok(result.evidence.pack.sizeBytes > 0)
  const evidence = { kind: 'real-local-docker-full-repository-source-check', passed: true,
    checkedAt: new Date().toISOString(), baseCommit,
    lockSha256: createHash('sha256').update(await readFile(resolve(repository, 'pnpm-lock.yaml'))).digest('hex'),
    result,
    limits: ['owner-invoked full workspace snapshot, not a model-produced patch',
      'nested sandbox profile removes Docker system-path masks; /sys is hidden but /proc masks are not restored',
      'default conditional integration skips still apply inside the container',
      'no pending plan, registry publication, production activation, or durable job resume'],
  }
  if (process.env.DSH_SOURCE_BUILD_EVIDENCE) await writeFile(resolve(process.env.DSH_SOURCE_BUILD_EVIDENCE), JSON.stringify(evidence, null, 2) + '\n')
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
