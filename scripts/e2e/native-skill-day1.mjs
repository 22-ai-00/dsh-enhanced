/** Real Day1 source -> native skill -> signed, after-freeze comparison. No promotion. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sha = value => createHash('sha256').update(value).digest('hex')
const root = process.env.DSH_NATIVE_SKILL_EVIDENCE_ROOT
const image = process.env.DSH_NATIVE_SKILL_IMAGE
const dockerPath = process.env.DSH_NATIVE_SKILL_DOCKER ?? '/usr/bin/docker'
const credentialModule = process.env.DSH_NATIVE_SKILL_CREDENTIALS_MODULE
const credentialPath = process.env.DSH_NATIVE_SKILL_CREDENTIALS_PATH
assert.ok(root && isAbsolute(root) && resolve(root) === root && root !== '/', 'Set a fresh absolute DSH_NATIVE_SKILL_EVIDENCE_ROOT; existing runs cannot resume')
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u, 'Set DSH_NATIVE_SKILL_IMAGE to an existing immutable local Docker image containing sh and node')
assert.ok(isAbsolute(dockerPath), 'Docker path must be absolute')
assert.equal(Boolean(credentialModule), Boolean(credentialPath), 'Credentials module and path must be supplied together, or use SUPER_RELAY_API_KEY in the environment')
if (credentialModule) assert.ok(isAbsolute(credentialModule) && isAbsolute(credentialPath), 'Credential module and path must be absolute')

const runtimePath = join(repo, 'plugins/assistant-evaluation/lib/benchmark/native-skills.js')
const relayPath = join(repo, 'plugins/assistant-evaluation/lib/benchmark/super-relay.js')
const { createNativeSkillGoalRuntime, runNativeSkillBenchmark, nativeSkillRuntimeIdentity } = await import(pathToFileURL(runtimePath))
const { createSuperRelayNativeAdapterFactory } = await import(pathToFileURL(relayPath))
const Credentials = credentialModule ? (await import(pathToFileURL(credentialModule))).default : undefined
const transport = Object.freeze({ timeoutMs: 180_000 })
const relayFactory = createSuperRelayNativeAdapterFactory(transport)
const inspectedImage = await promisify(execFile)(dockerPath, ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 10_000, maxBuffer: 8192 })
assert.equal(inspectedImage.stdout.trim(), image, 'The exact local image must already exist; this probe never pulls images')
// No recursive creation, overwrite or resume: an operator chooses each distinct experiment.
await mkdir(root, { mode: 0o700 })
assert.equal(await realpath(root), root, 'Evidence root must not traverse symlinks')
for (const name of ['source-workspace', 'source-state', 'authority']) await mkdir(join(root, name), { mode: 0o700 })
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' })
const scriptDigest = sha(await readFile(fileURLToPath(import.meta.url)))
const credentialProviderDigest = credentialModule ? sha(await readFile(credentialModule)) : null
const adapterDigest = sha(JSON.stringify({ scriptDigest, relayDigest: sha(await readFile(relayPath)), credentialProviderDigest, transport }))
const model = {
  provider: 'super-relay', model: 'auto_model/alwaysday1', maxOutputTokens: 4096, temperature: null,
  inputLimitMode: 'upper-bound', outputLimitMode: 'provider',
  inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null,
  adapterDigest, tokenCounterDigest: sha(await readFile(relayPath)),
}
const objective = 'Build a literal non-recursive template renderer that preserves unknown placeholders.'
const task = {
  objective,
  publicPrompt: `Use goal_create to create a native Goal with exactly this objective: ${objective} Set start_native_rounds=true and max_goal_rounds=3. In the native Goal, implement a Node.js program answer.js reading one JSON object {template, values} from stdin. Replace every known {{key}} where key matches [a-z][a-z0-9_]* with its string value in one literal, non-recursive pass; leave unknown placeholders unchanged, and append one newline. Use isolation_run grant benchmark-work; files must be supplied inline and artifacts must include answer.js. The container has Node.js. Host filesystem and shell access are unavailable. If skill_status is available, inspect available skills and reuse the exact matching skill using skill_run in this new Goal, rather than rewriting the program. Respect the existing tool schemas and use a fresh invocation id. Completion will be checked independently.`,
  artifactPath: 'answer.js',
  verification: {
    command: 'node artifact < input',
    cases: [{ stdin: JSON.stringify({ template: '{{value}} {{missing}}', values: { value: '{{missing}}-smoke' } }), expectedStdout: '{{missing}}-smoke {{missing}}\n', expectedExitCode: 0 }],
    maxDurationMs: 5000, maxOutputBytes: 4096,
  },
}
const common = {
  model, task, persona: 'Complete the requested program using the native Goal and the granted tools. Independent verification determines success. Use a matching reusable skill when it is available.',
  budget: { durationMs: 900_000, inputTokens: 3_200_000, outputTokens: 32_768, costUsdMicros: null, toolCalls: 24 },
  execution: { modelCalls: 12, maxOutputTokensPerCall: 4096, maxGoalRounds: 3 },
  image, dockerPath, stepMaxDurationMs: 240_000,
}
const factory = async (selectedModel, environment) => {
  if (Credentials) await environment.ctx.plugin(Credentials, { path: credentialPath, watch: false })
  const binding = await relayFactory(selectedModel, environment)
  const stream = binding.adapter.stream.bind(binding.adapter)
  // Bounded diagnostics contain codes and durations only, never credentials or request bodies.
  binding.adapter.stream = async function* (options) {
    const startedAt = Date.now()
    try { yield* stream(options) } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/u.test(error.code) ? error.code : 'UNCLASSIFIED'
      await appendFile(join(root, 'transport-errors.jsonl'), `${JSON.stringify({ startedAt, durationMs: Date.now() - startedAt, code, callerAborted: options.signal?.aborted ?? false })}\n`, { mode: 0o600 })
      throw error
    }
  }
  return binding
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
await writeFile(join(root, 'authority/key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
const authorityConfig = join(root, 'authority/config.json')
await writeFile(authorityConfig, JSON.stringify({ prospective: { generator: 'template-render/v1' }, privateKeyPath: join(root, 'authority/key.pem'), statePath: join(root, 'authority/state.sqlite'), limits: { maxToolCalls: 24, maxOutputBytes: 4096 } }), { mode: 0o600, flag: 'wx' })
const authorityCli = join(repo, 'plugins/assistant-skills/lib/holdout-cli.js')
const { stdout } = await promisify(execFile)(process.execPath, [authorityCli, '--inspect-config', authorityConfig], { timeout: 10_000, maxBuffer: 65_536 })
const pins = JSON.parse(stdout)
await save('input.json', { protocol: 'native-skill-day1-probe/v1', common, transport, scriptDigest, credentialProviderDigest, runtimeDigest: nativeSkillRuntimeIdentity(model.provider), generatorDigest: pins.generatorDigest })
console.log(JSON.stringify({ event: 'prepared', root, provider: model.provider, model: model.model, transport }))

const shutdown = new AbortController()
const stop = () => shutdown.abort(new Error('native skill probe stopped'))
process.on('SIGINT', stop); process.on('SIGTERM', stop)
const timer = setTimeout(() => shutdown.abort(new Error('native skill probe deadline')), 55 * 60_000)
timer.unref()
let source, control, failure, result
try {
  source = await createNativeSkillGoalRuntime({ ...common, cellId: 'training', workspace: join(root, 'source-workspace'), stateRoot: join(root, 'source-state'), factory, signal: shutdown.signal,
    source: { name: 'literal-template-renderer', description: 'Create a reusable Node.js literal non-recursive template renderer.', validityMs: 3_600_000 }, lifecycle: value => { control = value } })
  const training = await source.execute()
  await save('training.json', training)
  console.log(JSON.stringify({ event: 'training', outcome: training.snapshot.outcome, modelCalls: training.meter.modelCalls, inputTokens: training.meter.inputTokens, outputTokens: training.meter.outputTokens }))
  const captured = await source.captureVerifiedSkill()
  console.log(JSON.stringify({ event: 'captured', candidateId: captured.selection.candidateId, definitionDigest: captured.snapshot.definitionDigest }))
  const config = { ...common, id: 'day1-template-reuse', stateRoot: join(root, 'comparison'), workspaceRoot: join(root, 'cells'), repeats: 2, seed: 17,
    expiresAt: Math.min(Date.now() + 45 * 60_000, captured.snapshot.expiresAt - 60_000),
    authority: { executable: process.execPath, args: [authorityCli, '--config', authorityConfig], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: pins.generatorDigest },
    verification: { command: 'node artifact < input', maxDurationMs: 5000, maxOutputBytes: 4096 } }
  result = await runNativeSkillBenchmark(config, captured, factory, shutdown.signal)
} catch (error) {
  failure = { message: error instanceof Error ? error.message : String(error) }
} finally {
  shutdown.abort()
  try { await control?.close() } catch { failure ??= { message: 'native skill source cleanup unconfirmed' } }
  clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop)
}
if (failure) {
  await save('failure.json', { event: 'failed', ...failure, runtime: control?.snapshot() })
  console.error(JSON.stringify({ event: 'failed', root, error: failure.message, cleanup: control?.snapshot().cleanup ?? 'not-created' }))
  process.exitCode = 1
} else {
  await save('summary.json', result)
  console.log(JSON.stringify({ event: 'completed', root, report: result.report, reuse: result.reuse, training: result.training, promotionAuthorized: false }))
  if (!result.report.complete) process.exitCode = 1
}
