#!/usr/bin/env node
// Opt-in local supervisor fixture. Never targets an existing DSH service/profile.
import { spawn, execFile } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Ed25519HostAttestationAuthority, hostAttestationRequestDigest } from '../../plugins/plugin-control-plane/lib/attestation.js'

if (process.env.DSH_SYSTEMD_RELOAD_FIXTURE !== '1' || process.platform !== 'linux') throw new Error('set DSH_SYSTEMD_RELOAD_FIXTURE=1 on Linux to run the temporary user-service fixture')
const outputIndex = process.argv.indexOf('--output')
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('--output is required')
const output = process.argv[outputIndex + 1]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const pinned = async path => ({ path: await realpath(path), sha256: sha(await readFile(path)) })
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-systemd-reload-live-')))
const name = `attestor-fixture-${process.pid}-${randomUUID().slice(0, 8)}`
const unit = `dsh-profile-${name}.service`
const run = promisify(execFile)
const supervisor = async args => (await run('/usr/bin/systemctl', ['--user', ...args], { timeout: 10000, maxBuffer: 65536 })).stdout
const owner = join(root, 'owner'); const home = join(root, 'home'); const profile = join(home, 'profiles', name)
let started = false
let evidence
try {
  await mkdir(join(owner, 'state'), { recursive: true, mode: 0o700 })
  await mkdir(process.env.DSH_SYSTEMD_FIXTURE_DSH ? join(home, 'profiles') : profile, { recursive: true, mode: 0o700 })
  const fixtureScript = join(root, 'service.mjs'); await writeFile(fixtureScript, 'setInterval(() => {}, 1000)\n', { mode: 0o600 })
  const nodePath = join(owner, 'node'); await copyFile(await realpath(process.execPath), nodePath); await chmod(nodePath, 0o700)
  const node = await pinned(nodePath)
  const dshPath = process.env.DSH_SYSTEMD_FIXTURE_DSH ? await realpath(process.env.DSH_SYSTEMD_FIXTURE_DSH) : undefined
  let dshVersion
  if (dshPath) {
    const env = { PATH: '/usr/bin:/bin', HOME: root, DSH_HOME: home }
    dshVersion = (await run(node.path, [dshPath, '--version'], { env, timeout: 10000 })).stdout.trim()
    await run(node.path, [dshPath, '--profile', name, '--from-default-profile', 'web', '--dump-config'],
      { env, timeout: 30000, maxBuffer: 1048576 })
  }
  // Always a unique temporary unit/home. The optional real DSH mode uses the
  // shipped web template, no owner channels, model calls or candidate bundle.
  await run('/usr/bin/systemd-run', ['--user', `--unit=${unit}`, '--property=Type=exec', '--property=KillMode=control-group',
    '--property=RuntimeMaxSec=120s', `--property=WorkingDirectory=${home}`, `--setenv=DSH_HOME=${home}`, `--setenv=HOME=${root}`,
    node.path, ...(dshPath ? [dshPath, '--profile', name, '--host', '127.0.0.1', '--port', '0', '--no-open'] : [fixtureScript])], { timeout: 10000, maxBuffer: 65536 })
  started = true
  const properties = ['FragmentPath', 'DropInPaths', 'ExecStart', 'Environment', 'WorkingDirectory', 'User', 'Group', 'Type', 'KillMode']
  const readProperties = async keys => Object.fromEntries((await supervisor(['show', unit, '--no-pager', ...keys.map(key => `--property=${key}`)]))
    .trimEnd().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
  const before = await readProperties(['InvocationID', 'MainPID'])
  const hostReady = async identity => {
    if (!dshPath) return false
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const logs = (await run('/usr/bin/journalctl', ['--user', '-u', unit, `_SYSTEMD_INVOCATION_ID=${identity.InvocationID}`,
        '--no-pager', '--quiet', '--output=cat', '--lines=100'], { timeout: 5000, maxBuffer: 1048576 })).stdout
      if (logs.includes('dsh web: http://127.0.0.1:')) return true
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    throw new Error('temporary DSH Host did not emit its invocation-bound startup marker')
  }
  const beforeHostReady = await hostReady(before)
  const unitProperties = await readProperties(properties)
  unitProperties.ExecStart = unitProperties.ExecStart.replace(/ ; start_time=.* \}$/u, ' ; }')
  const profileFiles = []
  for (const filename of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const path = join(profile, filename)
    if (dshPath) {
      // Shipped core profiles do not install additional packages and therefore
      // may have no pnpm lockfile. This fixture has no candidate dependencies.
      if (filename === 'pnpm-lock.yaml') await writeFile(path, 'lockfileVersion: "9.0"\n', { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
    } else await writeFile(path, '{}\n', { mode: 0o600 })
    profileFiles.push(await pinned(path))
  }
  const executable = await pinned(fileURLToPath(new URL('../../plugins/plugin-control-plane/bin/dsh-systemd-host-attestor.js', import.meta.url)))
  const helper = await pinned(fileURLToPath(new URL('../../plugins/plugin-control-plane/lib/adapter-process.js', import.meta.url)))
  const keys = generateKeyPairSync('ed25519'); const privateKeyPath = join(owner, 'key.pem')
  await writeFile(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const ledgerPath = join(owner, 'control.sqlite'); await writeFile(ledgerPath, '', { mode: 0o600 })
  const now = Date.now()
  const request = { schemaVersion: 1, kind: 'dsh-host-attestation-request', operationId: `host-operation-${randomUUID()}`,
    requestedAt: now, receiptTtlMs: 60000, installationId: randomUUID(), ledger: { id: 'fixture-ledger', path: ledgerPath },
    plan: { id: 'fixture-plan', digest: 'a'.repeat(64) }, activation: { id: 'fixture-activation', fence: 1 },
    profile: { name, path: profile }, issuer: { mode: 'configured-executable', id: 'systemd-reload', version: 'dsh-systemd-host-attestor-1',
      ...executable, interpreter: node, authority: 'fixture-supervisor', keyId: 'fixture-key' }, phase: 'reload', requirements: { kind: 'reload', previousHostGeneration: 0 } }
  const config = { schemaVersion: 1, authority: 'fixture-supervisor', keyId: 'fixture-key', privateKeyPath, stateRoot: join(owner, 'state'),
    executable, interpreter: node, processHelper: helper, systemctl: { ...await pinned('/usr/bin/systemctl'), interpreter: null }, scope: 'user', unit, unitProperties, profileFiles,
    authorization: { installationId: request.installationId, ledger: request.ledger, profile: request.profile, plan: request.plan,
      activation: request.activation, previousHostGeneration: 0, requestDigest: hostAttestationRequestDigest(request), notBefore: now - 1000, expiresAt: now + 120000 },
    timeoutMs: 15000, stableWindowMs: 500, pollIntervalMs: 100 }
  const configPath = join(owner, 'config.json'); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await chmod(configPath, 0o600)
  const invoke = () => new Promise((resolveResult, reject) => {
    const child = spawn(node.path, [executable.path, 'attest'], { env: { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000)
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolveResult(JSON.parse(stdout)); else reject(new Error(`attestor failed ${code}: ${stderr}`)) })
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request))
  })
  const receipt = await invoke()
  await new Ed25519HostAttestationAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), config.authority, config.keyId)
    .verify(receipt, { id: request.plan.id, digest: request.plan.digest, installationId: request.installationId, activation: request.activation, createdAt: now - 1000 }, request)
  const after = await readProperties(['InvocationID', 'MainPID'])
  const afterHostReady = await hostReady(after)
  const replay = await invoke(); const afterReplay = await readProperties(['InvocationID', 'MainPID'])
  if (before.InvocationID === after.InvocationID || before.MainPID === after.MainPID || JSON.stringify(receipt) !== JSON.stringify(replay)
    || JSON.stringify(after) !== JSON.stringify(afterReplay)) throw new Error('fresh supervisor identity / idempotent replay failed')
  evidence = { schemaVersion: 1, kind: 'systemd-reload-attestor-local-supervisor-fixture', observedAt: new Date().toISOString(),
    systemdVersion: (await run('/usr/bin/systemctl', ['--version'], { timeout: 5000 })).stdout.split('\n')[0],
    before, after, afterReplay, signedReceiptVerified: true, byteIdenticalReplay: true, hostGeneration: receipt.hostGeneration,
    fixtureMode: dshPath ? 'real-dsh-shipped-web-template' : 'idle-node',
    ...(dshPath ? { dshVersion, dshCliSha256: sha(await readFile(dshPath)), beforeHostReady, afterHostReady } : {}),
    runtimeDigests: { attestor: executable.sha256, processHelper: helper.sha256, systemctl: config.systemctl.sha256, interpreter: node.sha256 },
    limits: [dshPath ? 'A unique transient user service boots the actual DSH shipped web template in a temporary home; no candidate plugin, model request or owner channel.'
      : 'A unique transient user service containing an idle Node process; not a real DSH Host or candidate plugin.',
      'No production service/profile was modified; no readiness, remaining activation phases, rollout or rollback proof.'] }
} finally {
  if (started) { await supervisor(['stop', unit]); await supervisor(['reset-failed', unit]).catch(() => {}) }
  await rm(root, { recursive: true, force: true })
}
evidence.fixtureRemoved = true
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
process.stdout.write(JSON.stringify(evidence) + '\n')
