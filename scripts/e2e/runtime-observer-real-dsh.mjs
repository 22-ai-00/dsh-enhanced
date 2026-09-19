#!/usr/bin/env node
// Explicitly opt-in, temporary Host/profile only. No model calls or production writes.
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { queryRuntimeObserver, runtimeConfigDigest } from '../../plugins/plugin-control-plane/lib/runtime-observer.js'

if (process.env.DSH_RUNTIME_OBSERVER_FIXTURE !== '1' || !process.env.DSH_RUNTIME_OBSERVER_DSH || process.platform !== 'linux') {
  throw new Error('requires Linux, DSH_RUNTIME_OBSERVER_FIXTURE=1 and DSH_RUNTIME_OBSERVER_DSH=/absolute/path/to/dsh')
}
const output = process.argv[process.argv.indexOf('--output') + 1]
if (!process.argv.includes('--output') || !output) throw new Error('--output is required')
const run = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ro-live-')))
const home = join(root, 'home'); const owner = join(root, 'owner')
const name = `observer-fixture-${process.pid}-${randomUUID().slice(0, 8)}`
const profile = join(home, 'profiles', name); const unit = `dsh-profile-${name}.service`
const dsh = await realpath(process.env.DSH_RUNTIME_OBSERVER_DSH)
const node = await realpath(process.execPath)
const controlUrl = new URL('../../plugins/plugin-control-plane/lib/index.js', import.meta.url)
const candidateUrl = new URL('../../plugins/assistant-policy/lib/index.js', import.meta.url)
const supervisor = async args => (await run('/usr/bin/systemctl', ['--user', ...args], { timeout: 15000, maxBuffer: 65536 })).stdout
let dispatched = false
let evidence
try {
  await mkdir(owner, { mode: 0o700 }); await mkdir(join(home, 'profiles'), { recursive: true })
  const env = { PATH: '/usr/bin:/bin', HOME: root, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  const dshVersion = (await run(node, [dsh, '--version'], { env, timeout: 10000 })).stdout.trim()
  await run(node, [dsh, '--profile', name, '--from-default-profile', 'web', '--dump-config'], { env, timeout: 30000, maxBuffer: 1048576 })
  const keyPath = join(owner, 'observer.key'); await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
  const candidateConfig = { databasePath: join(owner, 'policy.sqlite'), autoReview: { enabled: false }, rules: [], budgets: [] }
  const config = { socketPath: join(owner, 'observer.sock'), keyPath, profilePath: profile,
    targets: [{ entryId: 'include:observed-candidate', module: candidateUrl.href,
      configDigest: runtimeConfigDigest(candidateConfig), services: ['assistantPolicy'] }] }
  const patch = disabled => [{ insert: [
    { id: 'observer-control', name: controlUrl.href, config: { catalogPath: join(owner, 'catalog.json'), trustPath: join(owner, 'trust.json'),
      statePath: join(owner, 'state'), runtimeObserver: config } },
    { id: 'observed-candidate', name: candidateUrl.href, config: candidateConfig, disabled },
  ] }]
  const patchPath = join(profile, 'cordis.patch.yml')
  await writeFile(patchPath, JSON.stringify(patch(false)), { mode: 0o600 })
  // Mark possible dispatch before crossing the supervisor boundary, so finally
  // also attempts stop if systemd-run's acknowledgement is lost.
  dispatched = true
  const launch = () => run('/usr/bin/systemd-run', ['--user', `--unit=${unit}`, '--property=Type=exec', '--property=KillMode=control-group',
    '--property=RuntimeMaxSec=120s', `--property=WorkingDirectory=${home}`, `--setenv=DSH_HOME=${home}`, `--setenv=HOME=${root}`,
    '--setenv=DSH_TELEMETRY_DISABLED=1', node, dsh, '--profile', name, '--host', '127.0.0.1', '--port', '0', '--no-open'], { timeout: 15000, maxBuffer: 65536 })
  await launch()
  const identity = async () => Object.fromEntries((await supervisor(['show', unit, '--property=MainPID', '--property=InvocationID', '--property=ActiveState']))
    .trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
  const observe = async expectedActive => {
    const deadline = Date.now() + 30000; let last
    while (Date.now() < deadline) {
      try {
        const current = await queryRuntimeObserver(config)
        if (current.entries[0]?.active !== expectedActive) throw new Error('candidate lifecycle state differs')
        const state = await identity()
        if (state.ActiveState !== 'active' || current.processId !== Number(state.MainPID) || current.invocationId !== state.InvocationID) throw new Error('supervisor binding differs')
        return { supervisor: state, observation: current }
      } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    const logs = (await run('/usr/bin/journalctl', ['--user', '-u', unit, '--no-pager', '--quiet', '--output=cat', '--lines=25'], { timeout: 5000, maxBuffer: 65536 })).stdout
    throw new Error(`runtime fixture failed: ${String(last)}\n${logs}`)
  }
  const active = await observe(true)
  const replay = await observe(true)
  if (JSON.stringify(active.observation.entries) !== JSON.stringify(replay.observation.entries)
    || active.observation.observerId !== replay.observation.observerId
    || active.observation.challenge === replay.observation.challenge) throw new Error('stable fresh-challenge sampling failed')
  await supervisor(['stop', unit])
  try { await lstat(config.socketPath); throw new Error('Host stop retained the observer socket') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(patchPath, JSON.stringify(patch(true)), { mode: 0o600 })
  await launch()
  const disabled = await observe(false)
  if (active.observation.observerId === disabled.observation.observerId
    || active.observation.invocationId === disabled.observation.invocationId) throw new Error('Host instance did not change')
  evidence = { schemaVersion: 1, kind: 'runtime-observer-real-dsh-fixture', observedAt: new Date().toISOString(), dshVersion,
    dshCliSha256: sha(await readFile(dsh)), candidatePackage: '@dsh-enhanced/assistant-policy',
    candidateVersion: JSON.parse(await readFile(new URL('../../plugins/assistant-policy/package.json', import.meta.url), 'utf8')).version,
    runtimeDigests: { observer: sha(await readFile(new URL('../../plugins/plugin-control-plane/lib/runtime-observer.js', import.meta.url))),
      controlEntry: sha(await readFile(fileURLToPath(controlUrl))), candidateEntry: sha(await readFile(fileURLToPath(candidateUrl))) },
    active, replay, disabled, socketRemovedOnHostStop: true,
    limits: ['Actual DSH process with local built Control Plane and Policy package entries, referenced by file URL in a disposable profile; no npm install/publication or candidate artifact byte attestation.',
      'Authenticated live Loader/Fiber lifecycle observation only; no signed readiness receipt, Control Plane promotion, behavioral quality proof, model call or production activation.'] }
} finally {
  if (dispatched) { await supervisor(['stop', unit]); await supervisor(['reset-failed', unit]).catch(() => {}) }
  await rm(root, { recursive: true, force: true })
}
evidence.fixtureRemoved = true
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
process.stdout.write(JSON.stringify(evidence) + '\n')
