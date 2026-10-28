import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { consumeLinuxRepositoryAdmissionRefusal, verifyLinuxRuntime, linuxRuntimeDigest } from '@dsh-enhanced/assistant-isolation'
import type { LinuxRepositoryRunner } from '@dsh-enhanced/assistant-isolation'
import { ControlPlaneCliError } from './errors.js'
import { checkedSourceSnapshot, runLocalBuffer, runLocalCommand } from './source-workspace.js'
import { PREPARED_SOURCE_BUILD_SCRIPT, sourceTree, validateSourceBuildConfig, verifySourcePreparation,
  type LinuxSourceBuildConfig, type SourceBuildResult, type runDockerPreparedChecks } from './source-build.js'
import type { LinuxSourcePreparedEvidence } from './types.js'
import { linuxSourceNotStarted } from './linux-source-preflight.js'

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const maximumArchiveBytes = 64 * 1024 ** 2
export const LINUX_SOURCE_PACK_PATH = '.dsh-native-artifact/package.tgz'
const packMarker = /^DSH_PREPARED_PACK\t([^\t\n]+)\t([0-9]+)\t([a-f0-9]{64})\t([^\t\n]+)\t([^\t\n]+)$/u

/** Retain the full repository command and both archive/pack integrity checks. */
export const LINUX_PREPARED_SOURCE_BUILD_SCRIPT = String.raw`set -eu
umask 077
mkdir -p /workspace/.dsh-pnpm-store /workspace/.dsh-pnpm-cache
cp -R /runtime/0/store/. /workspace/.dsh-pnpm-store/
cp -R /runtime/0/cache/. /workspace/.dsh-pnpm-cache/
chmod -R u+w /workspace/.dsh-pnpm-store /workspace/.dsh-pnpm-cache
` + PREPARED_SOURCE_BUILD_SCRIPT.replaceAll('/opt/dsh-source-baseline/pnpm-lock.yaml', '/runtime/0/pnpm-lock.yaml')
  .replace("if (process.env.DSH_SOURCE_CAPTURE_PACK === 'true') process.stdout.write('DSH_PREPARED_PACK_BYTES_V1\\t' + packed.toString('base64') + '\\n')", '')
  .replace('cd /workspace\nverify_input init', 'cd /workspace\ntest ! -e node_modules\nverify_input init')
  + '\nmkdir -p /workspace/.dsh-native-artifact\ncp -- "$pack" /workspace/.dsh-native-artifact/package.tgz\n'
const buildScriptSha256 = sha(LINUX_PREPARED_SOURCE_BUILD_SCRIPT)

export interface LinuxSourceBuildInput extends Omit<Parameters<typeof runDockerPreparedChecks>[0], 'config' | 'sourceJob'> {
  config: LinuxSourceBuildConfig
  runner: LinuxRepositoryRunner
  sourceJob: { id: string }
}
function fail(message: string): never { throw new ControlPlaneCliError('SOURCE_BOUNDARY', `Linux source build ${message}`) }

function archiveEnvironment(input: LinuxSourceBuildInput): NodeJS.ProcessEnv {
  return { ...input.environment, GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null' }
}

/** Commit archives enable export-subst, unlike tree archives. Reject active
 * substitutions through Git's parser so the archive retains exact tree bytes. */
async function rejectArchiveSubstitutions(input: LinuxSourceBuildInput, temporary: string): Promise<void> {
  const environment = { ...archiveEnvironment(input), GIT_INDEX_FILE: join(temporary, 'index') }
  const paths = await runLocalBuffer('git', ['-c', 'core.attributesFile=/dev/null', 'ls-files', '-z'],
    input.worktree, environment, { maximumOutput: 8 * 1024 ** 2, signal: input.signal })
  const git = spawn('/usr/bin/git', ['-c', 'core.attributesFile=/dev/null', 'check-attr', '--cached', '-z', 'export-subst', '--stdin'],
    { cwd: input.worktree, env: environment, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  const closed = new Promise<number | null>(resolve => {
    git.once('error', () => resolve(null)); git.once('close', resolve)
  })
  const stop = (): void => { git.kill('SIGKILL') }
  git.stdin.on('error', stop)
  git.stderr.resume()
  input.signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 60_000), chunks: Buffer[] = []
  let size = 0
  try {
    git.stdin.end(paths)
    for await (const chunk of git.stdout) {
      input.signal.throwIfAborted()
      const bytes = chunk as Buffer
      if ((size += bytes.length) > 24 * 1024 ** 2) fail('archive attributes exceed bound')
      chunks.push(bytes)
    }
    if (await closed !== 0) fail('archive attribute lookup failed')
    input.signal.throwIfAborted()
    const fields = Buffer.concat(chunks, size).toString('utf8').split('\0')
    if (fields.pop() !== '' || fields.length !== (paths.toString('utf8').split('\0').length - 1) * 3) fail('archive attribute output differs')
    for (let index = 0; index < fields.length; index += 3) {
      if (fields[index + 1] !== 'export-subst' || !['unset', 'unspecified'].includes(fields[index + 2]!)) {
        fail(`export-subst cannot preserve exact source bytes: ${JSON.stringify(fields[index])}`)
      }
    }
  } finally { clearTimeout(timer); input.signal.removeEventListener('abort', stop); stop(); await closed }
}

/** First pass keeps only a digest; only the admitted factory retains archive bytes. */
async function archive(input: LinuxSourceBuildInput, commit: string, collect: boolean): Promise<{ sizeBytes: number; sha256: string; bytes?: Buffer }> {
  input.signal.throwIfAborted()
  const git = spawn('/usr/bin/git', ['-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar', commit], {
    cwd: input.worktree, env: archiveEnvironment(input), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  })
  let diagnostic = ''
  git.stderr.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4096) })
  const closed = new Promise<{ code: number | null; error?: Error }>(resolve => {
    git.once('error', error => resolve({ code: null, error }))
    git.once('close', code => resolve({ code }))
  })
  const stop = (): void => { git.kill('SIGKILL') }
  input.signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 60_000)
  const hash = createHash('sha256'), chunks: Buffer[] = []
  let sizeBytes = 0
  try {
    for await (const chunk of git.stdout) {
      input.signal.throwIfAborted()
      const bytes = chunk as Buffer
      sizeBytes += bytes.length
      if (sizeBytes > maximumArchiveBytes) fail('archive exceeds 64MiB')
      hash.update(bytes)
      if (collect) chunks.push(bytes)
    }
    const result = await closed
    input.signal.throwIfAborted()
    if (result.code !== 0 || result.error || sizeBytes < 1) fail(`archive failed: ${result.error?.message ?? diagnostic}`)
    return { sizeBytes, sha256: hash.digest('hex'), ...(collect ? { bytes: Buffer.concat(chunks, sizeBytes) } : {}) }
  } finally {
    clearTimeout(timer); input.signal.removeEventListener('abort', stop); stop(); await closed
  }
}

/** Whole-repository Linux preparation. The runner owns authorization, budget and cgroup receipts. */
export async function runLinuxPreparedChecks(provided: LinuxSourceBuildInput): Promise<SourceBuildResult<LinuxSourcePreparedEvidence>> {
  const attempt: { request?: Parameters<LinuxRepositoryRunner['run']>[1]; cleanupFailed: boolean } = { cleanupFailed: false }
  try { return await runLinuxPreparedChecksOwned(provided, attempt) }
  catch (error) {
    if (!attempt.cleanupFailed && /^source-job-[a-f0-9]{64}$/u.test(provided.sourceJob?.id)) {
      const request = attempt.request
      throw linuxSourceNotStarted(error, { runner: provided.runner, key: provided.sourceJob.id,
        consume: request === undefined ? () => true : () => consumeLinuxRepositoryAdmissionRefusal(error, provided.runner, provided.sourceJob.id, request) })
    }
    throw error
  }
}
async function runLinuxPreparedChecksOwned(provided: LinuxSourceBuildInput,
  attempt: { request?: Parameters<LinuxRepositoryRunner['run']>[1]; cleanupFailed: boolean }): Promise<SourceBuildResult<LinuxSourcePreparedEvidence>> {
  validateSourceBuildConfig(provided.config)
  const input: LinuxSourceBuildInput = { ...provided,
    signal: AbortSignal.any([provided.signal, AbortSignal.timeout(provided.config.timeoutMs)]) }
  input.signal.throwIfAborted()
  if (process.platform !== 'linux' || !/^source-job-[a-f0-9]{64}$/u.test(input.sourceJob?.id)
    || !/^[a-z0-9][a-z0-9-]*$/u.test(input.name)
    || input.capturePack !== undefined && input.capturePack !== true || input.config.expiresAt <= Date.now()) fail('durable authority is invalid')
  await input.assertCurrent()
  await verifyLinuxRuntime(input.config.runtime)
  input.signal.throwIfAborted()
  const runtimeDigest = linuxRuntimeDigest(input.config.runtime)
  if (runtimeDigest !== input.runner.runtimeDigest) fail('runner runtime differs')
  attempt.cleanupFailed = true
  await verifySourcePreparation(input)
  attempt.cleanupFailed = false
  attempt.cleanupFailed = true
  const authorized = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment, undefined, input.signal)
  attempt.cleanupFailed = false
  const baseLock = input.creation || input.revision ? await runLocalBuffer('git', ['show', `${input.baseCommit}:pnpm-lock.yaml`],
    input.worktree, input.environment, { maximumOutput: 8_388_608, signal: input.signal }) : undefined
  attempt.cleanupFailed = true
  const snapshot = await sourceTree(input.worktree, input.baseCommit, input.scope, input.environment, input.signal)
  attempt.cleanupFailed = false
  try {
    attempt.cleanupFailed = true
    const before = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment, snapshot.tree, input.signal)
    attempt.cleanupFailed = false
    if (before.checkedTreeDigest !== authorized.checkedTreeDigest || before.checkedPatchDigest !== authorized.checkedPatchDigest) fail('staged source differs from verified workspace')
    attempt.cleanupFailed = true
    await verifySourcePreparation(input)
    attempt.cleanupFailed = false
    const packageJson = JSON.parse(await runLocalCommand('git', ['show', `${snapshot.tree}:plugins/${input.name}/package.json`],
      input.worktree, input.environment, { capture: true, maximumOutput: 65536, signal: input.signal })) as { version?: unknown }
    if (typeof packageJson.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageJson.version)) fail('package version is invalid')
    await rejectArchiveSubstitutions(input, snapshot.temporary)
    // A tree archive otherwise uses the current time. A fixed, unreferenced
    // commit gives both archive passes identical metadata without changing HEAD.
    const commit = (await runLocalCommand('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
      'commit-tree', snapshot.tree, '-m', 'DSH immutable source archive'], input.worktree,
    { ...input.environment, GIT_AUTHOR_NAME: 'DSH', GIT_AUTHOR_EMAIL: 'source@dsh.invalid',
      GIT_COMMITTER_NAME: 'DSH', GIT_COMMITTER_EMAIL: 'source@dsh.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' },
    { capture: true, maximumOutput: 128, signal: input.signal })).trim()
    if (!/^[a-f0-9]{40}$/u.test(commit)) fail('archive commit is invalid')
    const declared = await archive(input, commit, false)
    const env = ['PATH=/runtime/0/bin:/runtime/0/pnpm-native:/usr/bin:/bin', 'HOME=/tmp', 'CI=true',
      'TMPDIR=/tmp', 'LANG=C', 'LC_ALL=C', 'NODE_OPTIONS=', 'NODE_PATH=', 'npm_config_ignore_scripts=true',
      'npm_config_userconfig=/dev/null', 'npm_config_globalconfig=/dev/null', 'COREPACK_ENABLE_PROJECT_SPEC=0',
      'npm_config_store_dir=/workspace/.dsh-pnpm-store', 'pnpm_config_store_dir=/workspace/.dsh-pnpm-store', 'npm_config_cache_dir=/workspace/.dsh-pnpm-cache',
      'pnpm_config_cache_dir=/workspace/.dsh-pnpm-cache', 'XDG_CACHE_HOME=/workspace/.dsh-pnpm-cache',
      'XDG_DATA_HOME=/workspace/.dsh-pnpm-data', 'PNPM_HOME=/workspace/.dsh-pnpm-home',
      'DSH_TEST_PNPM_ROOT=/runtime/0/pnpm-native', `PLUGIN_ROOT=plugins/${input.name}`,
      `VITEST_MAX_WORKERS=${Math.max(1, Math.min(4, Math.floor(input.config.cpus)))}`,
      ...(baseLock === undefined ? [] : ['DSH_SOURCE_TRUST_LOCKFILE=true', `DSH_SOURCE_BASE_LOCK_SHA256=${sha(baseLock)}`])]
    await input.assertCurrent()
    attempt.cleanupFailed = true
    await verifySourcePreparation(input)
    attempt.cleanupFailed = false
    const started = Date.now()
    const request = {
      argv: ['/bin/sh', '-c', 'exec /usr/bin/env -i "$@" < /input/source.tar', 'dsh-linux-source',
        ...env, '/bin/sh', '-ceu', LINUX_PREPARED_SOURCE_BUILD_SCRIPT],
      archive: { bytes: declared.sizeBytes, sha256: declared.sha256 }, artifacts: [LINUX_SOURCE_PACK_PATH],
    }
    attempt.request = request
    const outcome = await input.runner.run(input.sourceJob.id, request, async (runnerSignal: AbortSignal) => {
      const admitted: LinuxSourceBuildInput = { ...input, signal: AbortSignal.any([input.signal, runnerSignal]) }
      admitted.signal.throwIfAborted()
      await admitted.assertCurrent()
      await verifySourcePreparation(admitted)
      const loaded = await archive(admitted, commit, true)
      if (loaded.sizeBytes !== declared.sizeBytes || loaded.sha256 !== declared.sha256 || !loaded.bytes) fail('archive changed before admission')
      return loaded.bytes
    }, input.signal)
    const durationMs = Date.now() - started
    await input.assertCurrent()
    input.signal.throwIfAborted()
    if (outcome.runtimeDigest !== runtimeDigest || outcome.contractDigest !== input.runner.contractDigest) fail('execution binding differs')
    if (!outcome.result.quiescent || outcome.result.status !== 'succeeded' || outcome.result.exitCode !== 0 || !outcome.receiptBinding) {
      throw new ControlPlaneCliError('EXECUTOR_FAILED', `Linux source build ${outcome.result.status}: ${outcome.result.reason ?? ''}; ${outcome.result.stderr?.slice(-4096) ?? ''}`)
    }
    const stdout = outcome.result.stdout ?? '', stderr = outcome.result.stderr ?? ''
    const match = packMarker.exec(stdout.trimEnd())
    if (!match || stdout !== match[0] + '\n' || stderr !== '') fail('pack evidence marker is invalid')
    const bytes = outcome.artifacts[0]?.bytes
    if (outcome.artifacts.length !== 1 || outcome.artifacts[0]?.path !== LINUX_SOURCE_PACK_PATH || !bytes
      || bytes.length < 1 || bytes.length > 32 * 1024 ** 2 || bytes.length !== Number(match[2])
      || sha(bytes) !== match[3] || outcome.artifacts[0].sha256 !== match[3]
      || match[4] !== input.config.runtime.versions.node || match[5] !== input.config.runtime.versions.pnpm) fail('binary pack differs from evidence')
    await verifyLinuxRuntime(input.config.runtime)
    attempt.cleanupFailed = true
    await verifySourcePreparation(input)
    attempt.cleanupFailed = false
    const after = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment, undefined, input.signal)
    if (after.checkedTreeDigest !== before.checkedTreeDigest || after.checkedPatchDigest !== before.checkedPatchDigest) fail('source changed while isolated build ran')
    return { treeDigest: after.checkedTreeDigest, patchDigest: after.checkedPatchDigest, checkedAt: Date.now(),
      ...(input.capturePack ? { packArtifact: Buffer.from(bytes) } : {}), evidence: Object.freeze({
        schemaVersion: 3, kind: 'dsh-source-prepared-evidence', boundary: 'linux-native-repository-v1', runtimeDigest,
        executionContractDigest: outcome.contractDigest, buildScriptSha256,
        archive: Object.freeze({ sizeBytes: declared.sizeBytes, sha256: declared.sha256 }), receipt: Object.freeze({ ...outcome.receiptBinding }),
        environment: Object.freeze({ npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true,
          nodeVersion: match[4]!, pnpmVersion: match[5]! }),
        checks: Object.freeze(['source-archive-integrity', 'frozen-offline-install', 'repository-pnpm-check', 'source-input-recheck', 'package-integrity'] as const),
        pack: Object.freeze({ name: match[1]!, version: packageJson.version, sizeBytes: bytes.length, sha256: match[3]! }),
        durationMs, logDigest: sha(stdout + '\0' + stderr), preparedAt: input.preparedAt,
      }) }
  } finally {
    const earlierCleanupUnproven = attempt.cleanupFailed
    attempt.cleanupFailed = true
    await snapshot.cleanup()
    attempt.cleanupFailed = earlierCleanupUnproven
  }
}
