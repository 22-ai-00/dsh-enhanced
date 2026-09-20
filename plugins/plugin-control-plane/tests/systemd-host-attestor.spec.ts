import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { Ed25519HostAttestationAuthority, hostAttestationRequestDigest } from '../src/attestation.ts'
import { invokeConfiguredHostAttestor } from '../src/host-attestor.ts'
import { runtimeConfigDigest } from '../src/runtime-observer-protocol.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import type { HostAttestationReceipt, HostAttestationRequest, PluginActivationPlan } from '../src/types.ts'

const roots: string[] = []
const children = new Set<ReturnType<typeof spawn>>()
const servers = new Set<Server>()
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let interpreterRoot: string | undefined
let interpreterPin: { path: string; sha256: string } | undefined
async function privateInterpreter() {
  if (interpreterPin) return interpreterPin
  interpreterRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-systemd-attestor-node-')))
  const path = join(interpreterRoot, 'node')
  await copyFile(await realpath(process.execPath), path); await chmod(path, 0o700)
  interpreterPin = { path, sha256: sha(await readFile(path)) }
  return interpreterPin
}
afterAll(async () => { if (interpreterRoot) await rm(interpreterRoot, { recursive: true, force: true }) })
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  children.clear()
  await Promise.all([...servers].map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))))
  servers.clear()
  for (const root of roots.splice(0)) {
    try { process.kill(Number(await readFile(join(root, 'restart.pid'), 'utf8')), 'SIGKILL') } catch { /* fixture already stopped */ }
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(mode = 'success') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-systemd-attestor-'))); roots.push(root)
  const owner = join(root, 'owner'); const stateRoot = join(owner, 'state'); const profile = join(root, 'home/profiles/test')
  await mkdir(stateRoot, { recursive: true, mode: 0o700 }); await mkdir(profile, { recursive: true, mode: 0o700 })
  const pinned = async (path: string) => ({ path: await realpath(path), sha256: sha(await readFile(path)) })
  const executable = await pinned(resolve('bin/dsh-systemd-host-attestor.js'))
  const interpreter = await privateInterpreter()
  const processHelper = await pinned(resolve('lib/adapter-process.js'))
  const privateKeyPath = join(owner, 'private.pem'); const keys = generateKeyPairSync('ed25519')
  await writeFile(privateKeyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const ledgerPath = join(owner, 'control.sqlite'); await writeFile(ledgerPath, '', { mode: 0o600 })
  const profileFiles = []
  for (const name of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    const path = join(profile, name); await writeFile(path, '{}\n', { mode: 0o600 }); profileFiles.push(await pinned(path))
  }
  const unitProperties = { FragmentPath: join(root, 'test.service'), DropInPaths: '',
    ExecStart: `{ path=${interpreter.path} ; argv[]=${interpreter.path} dsh --profile test --no-open ; ignore_errors=no ; }`,
    Environment: `DSH_HOME=${join(root, 'home')}`, WorkingDirectory: join(root, 'home'), User: '', Group: '', Type: 'simple', KillMode: 'control-group' }
  const ownCgroup = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').map(line => line.match(/^\d+:([^:]*):(.*)$/u))
    .find(match => match && (match[1] === '' || match[1]!.split(',').includes('name=systemd')))![2]!
  const old = { Id: 'dsh-profile-test.service', LoadState: 'loaded', ActiveState: 'active', SubState: 'running',
    MainPID: String(process.pid - 1), ControlPID: '0', InvocationID: '1'.repeat(32), NRestarts: '0', ControlGroup: join(dirname(ownCgroup), 'dsh-profile-test.service'), ...unitProperties }
  await writeFile(join(root, 'observation.json'), JSON.stringify(old), { mode: 0o600 })
  await writeFile(join(root, 'mode'), mode)
  const systemctlPath = join(root, 'systemctl.mjs')
  await writeFile(systemctlPath, `#!/usr/bin/node
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(root)};const mode=readFileSync(root+'/mode','utf8');
const args=process.argv.slice(2);const data=JSON.parse(readFileSync(root+'/observation.json','utf8'));
appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');
if(args[1]==='show') {
  if(args.includes('--property=Job')) data.Job=mode==='pending-job'?'12':'';
  if(mode==='duplicate') process.stdout.write('Id='+data.Id+'\\n');
  process.stdout.write(Object.entries(data).map(([k,v])=>k+'='+v).join('\\n')+'\\n');
} else if(args[1]==='restart') {
  appendFileSync(root+'/restarts','restart\\n');writeFileSync(root+'/restart.pid',String(process.pid));
  if(mode!=='unchanged') {data.InvocationID=data.InvocationID==='1'.repeat(32)?'2'.repeat(32):'3'.repeat(32);data.MainPID=String(Number(data.MainPID)+1);}
  try { data.MainPID=readFileSync(root+'/recovery-pid','utf8'); } catch {}
  if(mode==='drift') data.Environment='DSH_HOME=/other';
  writeFileSync(root+'/observation.json',JSON.stringify(data));
  if(mode==='lost-ack') process.exitCode=7;
  if(mode==='wait') setInterval(()=>{},100);
} else if(args[1]==='stop') {
  appendFileSync(root+'/stops','stop\\n');
  if(mode!=='unchanged') {data.ActiveState='inactive';data.SubState='dead';data.MainPID='0';data.ControlPID='0';data.ControlGroup='';data.InvocationID='';}
  if(mode==='unloaded') {data.LoadState='not-found';delete data.ExecStart;}
  writeFileSync(root+'/observation.json',JSON.stringify(data));
  if(mode==='lost-ack') process.exitCode=7;
} else process.exitCode=64;
`, { mode: 0o700 })
  const now = Date.now()
  const config = { schemaVersion: 1, authority: 'systemd-owner', keyId: 'reload-key', privateKeyPath, stateRoot,
    executable, interpreter, processHelper, systemctl: { ...await pinned(systemctlPath), interpreter }, scope: 'system',
    unit: old.Id, unitProperties, profileFiles,
    authorization: { installationId: '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00', ledger: { id: 'ledger', path: ledgerPath },
      profile: { name: 'test', path: profile }, plan: { id: 'plan', digest: 'a'.repeat(64) }, activation: { id: 'activation', fence: 1 },
      previousHostGeneration: 0, requestDigest: '', notBefore: now - 1000, expiresAt: now + 120000 }, timeoutMs: 5000, stableWindowMs: 75, pollIntervalMs: 25 }
  const configPath = join(owner, 'config.json')
  const save = async () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await save()
  const request: HostAttestationRequest = { schemaVersion: 1, kind: 'dsh-host-attestation-request', operationId: 'host-operation-fixture',
    requestedAt: now, receiptTtlMs: 30000, installationId: config.authorization.installationId,
    ledger: config.authorization.ledger, plan: config.authorization.plan, activation: config.authorization.activation,
    profile: config.authorization.profile, issuer: { mode: 'configured-executable', id: 'systemd-reload', version: 'dsh-systemd-host-attestor-4',
      ...executable, interpreter, authority: config.authority, keyId: config.keyId }, phase: 'reload', requirements: { kind: 'reload', previousHostGeneration: 0 } }
  config.authorization.requestDigest = hostAttestationRequestDigest(request); await save()
  const start = (value: unknown = request) => {
    const child = spawn(interpreter.path, [executable.path, 'attest'], { env: { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: configPath }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child); let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(value))
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveResult => {
      child.once('close', code => { children.delete(child); resolveResult({ code, stdout, stderr }) })
    })
    return { child, result }
  }
  const restarts = async () => (await readFile(join(root, 'restarts'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length
  const verifyRequest = async (receipt: HostAttestationReceipt, value: HostAttestationRequest) => new Ed25519HostAttestationAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), config.authority, config.keyId)
    .verify(receipt, { id: 'plan', digest: 'a'.repeat(64), installationId: value.installationId,
      activation: { id: 'activation', fence: 1 }, createdAt: now - 1000 } as PluginActivationPlan, value)
  const verify = async (receipt: HostAttestationReceipt) => verifyRequest(receipt, request)
  return { root, config, configPath, request, save, start, restarts, verify, verifyRequest }
}

async function readinessFixture(f: Awaited<ReturnType<typeof fixture>>, mode: 'stable' | 'epoch-drift' | 'wrong-context' | 'replayed-challenge' | 'wrong-mac' | 'inactive' | 'inactive-then-active' | 'bad-identity' | 'disconnected' | 'rollback' = 'stable') {
  const reload = await f.start().result; expect(reload.code, reload.stderr).toBe(0)
  const config = f.config as unknown as { schemaVersion: 2; profileFiles: Array<{ path: string; sha256: string }>; readiness: {
    client: { path: string; sha256: string }; observer: unknown; deploymentFiles: Array<{ path: string; sha256: string }>; reloadOperationId: string
  }; authorization: { profile: { path: string }; previousHostGeneration?: number; hostGeneration?: number; requestDigest: string; expiresAt: number } }
  const keyPath = join(f.root, 'owner', 'observer.key'); const socketPath = join(f.root, 'owner', 'observer.sock')
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
  const clientPath = resolve('lib/runtime-observer-protocol.js')
  const observer = { socketPath, keyPath, profilePath: config.authorization.profile.path,
    targets: [{ entryId: 'candidate', module: './node_modules/observer-fixture/index.js', configDigest: 'a'.repeat(64), services: ['candidateService'] }] }
  config.schemaVersion = 2
  delete config.authorization.previousHostGeneration
  config.authorization.hostGeneration = 1
  config.readiness = { client: { path: await realpath(clientPath), sha256: sha(await readFile(clientPath)) }, observer,
    deploymentFiles: config.profileFiles, reloadOperationId: f.request.operationId }
  const request: HostAttestationRequest = { ...f.request, operationId: 'host-readiness-fixture', phase: 'readiness', requirements: { kind: 'readiness', minimumChecks: 2 } }
  config.authorization.requestDigest = hostAttestationRequestDigest(request)
  await f.save()
  const key = await readFile(keyPath); let samples = 0; let behavior = mode
  const server = createServer(socket => {
    let source = ''
    socket.on('data', chunk => { source += chunk.toString('utf8') })
    socket.on('end', () => {
      try {
        const incoming = JSON.parse(source)
        const requestMac = createHmac('sha256', key).update(`dsh-runtime-request/v1\n${JSON.stringify(incoming.challenge)}`).digest('hex')
        if (incoming.schemaVersion !== 1 || incoming.mac !== requestMac) throw new Error('invalid request HMAC')
        if (behavior === 'disconnected') { socket.end(); return }
        samples++
        const challenge = behavior === 'replayed-challenge' ? 'f'.repeat(64) : incoming.challenge
        const epoch = behavior === 'epoch-drift' ? samples : 1
        const invocationId = behavior === 'rollback' ? JSON.parse(readFileSync(join(f.root, 'observation.json'), 'utf8')).InvocationID
          : behavior === 'wrong-context' ? '3'.repeat(32) : '2'.repeat(32)
        const inactive = behavior === 'inactive' || (behavior === 'inactive-then-active' && samples === 1)
        const instance = inactive ? null : { uid: 101, epoch }
        const target = observer.targets[0]!
        const observation = { schemaVersion: 1, kind: 'dsh-runtime-observation', observerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          observerConfigDigest: runtimeConfigDigest(observer), challenge, processId: process.pid, invocationId,
          profilePath: observer.profilePath, observedAt: Date.now(), entries: [{ entryId: 'candidate', module: behavior === 'bad-identity' ? './wrong.js' : target.module,
            configDigest: target.configDigest, active: !inactive, instance, dependencies: [{ name: 'loader', instance }],
            services: [{ name: 'candidateService', instance }] }] }
        const mac = behavior === 'wrong-mac' ? '0'.repeat(64) : createHmac('sha256', key).update(`dsh-runtime-response/v1\n${JSON.stringify(observation)}`).digest('hex')
        socket.end(`${JSON.stringify({ observation, mac })}\n`)
      } catch { socket.destroy() }
    })
  })
  servers.add(server)
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolveListen() }) })
  await chmod(socketPath, 0o600)
  return { request, observer, start: () => f.start(request), samples: () => samples,
    setBehavior: (value: typeof mode) => { behavior = value } }
}

async function rollbackFixture(action: 'restore' | 'stop' = 'stop', mode = 'success') {
  const f = await fixture()
  const ready = action === 'restore' ? await readinessFixture(f, 'rollback') : undefined
  const observed = JSON.parse(await readFile(join(f.root, 'observation.json'), 'utf8'))
  observed.MainPID = '99999999' // absent PID; rollback must independently prove prior process exit
  await writeFile(join(f.root, 'observation.json'), JSON.stringify(observed))
  await writeFile(join(f.root, 'mode'), mode)
  await writeFile(join(f.root, 'recovery-pid'), String(process.pid))
  f.config.schemaVersion = 3
  Reflect.deleteProperty(f.config.authorization, 'hostGeneration')
  f.config.authorization.previousHostGeneration = action === 'restore' ? 1 : 0
  if (action === 'stop') {
    await rm(f.request.profile.path, { recursive: true })
    f.config.profileFiles = []
    Object.assign(f.config, { readiness: null })
  } else {
    // Restore verifies both supervisor and runtime windows, with repeated
    // descriptor-pinned interpreter hashing. Allow that work under suite load.
    f.config.timeoutMs = 10000
    const value = f.config as unknown as { readiness: { reloadOperationId?: string } }
    delete value.readiness.reloadOperationId
  }
  const request: HostAttestationRequest = { ...f.request, operationId: 'rollback-operation', phase: 'rollback',
    requirements: { kind: 'rollback', action, previousHostGeneration: f.config.authorization.previousHostGeneration,
      baselineFiles: f.config.profileFiles, minimumChecks: 2 } }
  f.config.authorization.requestDigest = hostAttestationRequestDigest(request); await f.save()
  const stops = async () => (await readFile(join(f.root, 'stops'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length
  return { ...f, ready, request, stops, startRollback: () => f.start(request) }
}

describe.skipIf(process.platform !== 'linux')('owner systemd reload attestor', () => {
  test.each(['restore', 'stop'] as const)('attests physical %s and reconciles byte-identical replay without another action', async action => {
    const f = await rollbackFixture(action)
    const first = await f.startRollback().result; expect(first.code, first.stderr).toBe(0)
    const receipt = JSON.parse(first.stdout); await f.verifyRequest(receipt, f.request)
    expect(receipt).toMatchObject({ phase: 'rollback', outcome: 'passed', hostGeneration: action === 'restore' ? 2 : 1,
      evidence: { action, profileRestored: true, failures: 0 } })
    const replay = await f.startRollback().result; expect(replay.code, replay.stderr).toBe(0); expect(replay.stdout).toBe(first.stdout)
    expect(await f.restarts()).toBe(action === 'restore' ? 2 : 0); expect(await f.stops()).toBe(action === 'stop' ? 1 : 0)
  }, 30_000)

  test.each(['restore', 'stop'] as const)('reconciles lost %s acknowledgement without redispatch', async action => {
    const f = await rollbackFixture(action, 'lost-ack')
    const first = await f.startRollback().result; expect(first.code).toBe(1); expect(first.stdout).toBe('')
    const later = await f.startRollback().result; expect(later.code, later.stderr).toBe(0)
    await f.verifyRequest(JSON.parse(later.stdout), f.request)
    expect(await f.restarts()).toBe(action === 'restore' ? 2 : 0); expect(await f.stops()).toBe(action === 'stop' ? 1 : 0)
  }, 30_000)

  test('does not stop when the originally absent profile has reappeared', async () => {
    const f = await rollbackFixture(); await mkdir(f.request.profile.path)
    const result = await f.startRollback().result; expect(result.code).toBe(1); expect(await f.stops()).toBe(0)
  })

  test('does not sign stop while the prior Host process remains alive', async () => {
    const f = await rollbackFixture()
    const observed = JSON.parse(await readFile(join(f.root, 'observation.json'), 'utf8')); observed.MainPID = String(process.pid)
    await writeFile(join(f.root, 'observation.json'), JSON.stringify(observed))
    const result = await f.startRollback().result; expect(result.code).toBe(1); expect(result.stdout).toBe('')
    expect(result.stderr).toContain('prior Host process still exists'); expect(await f.stops()).toBe(1)
  })

  test('rejects stale cached stop after a successor starts and after a newer generation is reserved', async () => {
    const f = await rollbackFixture(); const result = await f.startRollback().result; expect(result.code, result.stderr).toBe(0)
    const path = join(f.root, 'observation.json'); const observed = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...observed, ActiveState: 'active', SubState: 'running', MainPID: String(process.pid), InvocationID: '3'.repeat(32) }))
    expect((await f.startRollback().result).code).toBe(1)
    await writeFile(path, JSON.stringify(observed))
    const db = new DatabaseSync(join(f.config.stateRoot, 'reload.sqlite'))
    try { db.exec(`INSERT INTO reloads(operation_id,request_digest,config_digest,scope_id,generation,activation_id,prior)
      SELECT 'newer',request_digest,config_digest,scope_id,generation+1,'newer',prior FROM reloads`) } finally { db.close() }
    const stale = await f.startRollback().result; expect(stale.code).toBe(1); expect(stale.stderr).toContain('superseded')
    expect(await f.stops()).toBe(1)
  }, 30_000)

  test('rejects restored profile drift and inactive runtime without signing recovery', async () => {
    const f = await rollbackFixture('restore'); f.ready!.setBehavior('inactive')
    const result = await f.startRollback().result; expect(result.code).toBe(1); expect(result.stdout).toBe('')
    expect(await f.restarts()).toBe(2)
    await writeFile(f.config.profileFiles[0]!.path, 'changed')
    const drift = await f.startRollback().result; expect(drift.code).toBe(1); expect(await f.restarts()).toBe(2)
  }, 30_000)

  test('proves stop of a transient unit that disappears after dispatch', async () => {
    const f = await rollbackFixture('stop', 'unloaded')
    const first = await f.startRollback().result; expect(first.code, first.stderr).toBe(0)
    const replay = await f.startRollback().result; expect(replay.code, replay.stderr).toBe(0); expect(replay.stdout).toBe(first.stdout)
    expect(await f.stops()).toBe(1)
  }, 30_000)

  test('refuses unsettled supervisor jobs before recovery dispatch', async () => {
    const f = await rollbackFixture('stop', 'pending-job')
    const result = await f.startRollback().result; expect(result.code).toBe(1); expect(result.stderr).toContain('unsettled')
    expect(await f.stops()).toBe(0)
  })

  test('verifies explicit baseline-file absence throughout restored runtime observation', async () => {
    const f = await rollbackFixture('restore')
    const missing = f.config.profileFiles[1]!
    const ready = f.config as unknown as { readiness: { deploymentFiles: Array<{ path: string; sha256: string }> } }
    ready.readiness.deploymentFiles = [f.config.profileFiles[0]!]
    await rm(missing.path); Object.assign(missing, { sha256: null })
    f.config.authorization.requestDigest = hostAttestationRequestDigest(f.request); await f.save()
    const first = await f.startRollback().result; expect(first.code, first.stderr).toBe(0)
    await f.verifyRequest(JSON.parse(first.stdout), f.request)
    await writeFile(missing.path, 'reappeared')
    const replay = await f.startRollback().result; expect(replay.code).toBe(1); expect(replay.stdout).toBe('')
    expect(await f.restarts()).toBe(2)
  }, 30_000)

  test('cached restore rejects changed authenticated runtime without redispatch', async () => {
    const f = await rollbackFixture('restore'); const first = await f.startRollback().result; expect(first.code, first.stderr).toBe(0)
    f.ready!.setBehavior('epoch-drift')
    const replay = await f.startRollback().result; expect(replay.code).toBe(1); expect(replay.stdout).toBe('')
    expect(await f.restarts()).toBe(2)
  }, 30_000)

  test('rejects an invisible supervisor cgroup hierarchy before stopping', async () => {
    const f = await rollbackFixture()
    const path = join(f.root, 'observation.json'); const observed = JSON.parse(await readFile(path, 'utf8'))
    observed.ControlGroup = '/missing-hierarchy-fixture/target.service'
    await writeFile(path, JSON.stringify(observed))
    const result = await f.startRollback().result; expect(result.code).toBe(1); expect(result.stdout).toBe('')
    expect(await f.stops()).toBe(0)
  })

  // These two integration cases compose three bounded subprocess operations
  // plus interpreter setup. Their aggregate deadline must exceed the suite's
  // 15 s default; individual attestor/runner deadlines remain unchanged.
  test('binds readiness to the latest signed reload over the HMAC observer channel and replays without restart', async () => {
    const f = await fixture()
    // Exercise the on-disk v1 journal migration before recording this reload.
    const journalPath = join(f.config.stateRoot, 'reload.sqlite')
    const legacy = new DatabaseSync(journalPath)
    legacy.exec(`CREATE TABLE reloads (
      operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, config_digest TEXT NOT NULL,
      scope_id TEXT NOT NULL, generation INTEGER NOT NULL, activation_id TEXT NOT NULL,
      prior TEXT NOT NULL, observation TEXT, receipt TEXT,
      UNIQUE(scope_id, generation), UNIQUE(scope_id, activation_id));`)
    legacy.close(); await chmod(journalPath, 0o600)
    const ready = await readinessFixture(f)
    const first = await ready.start().result
    expect(first.code, first.stderr).toBe(0)
    const receipt = JSON.parse(first.stdout); await f.verifyRequest(receipt, ready.request)
    expect(receipt).toMatchObject({ phase: 'readiness', hostGeneration: 1, evidence: { kind: 'readiness', checks: expect.any(Number), failures: 0 } })
    expect(receipt.evidence.checks).toBeGreaterThanOrEqual(2)
    const replay = await ready.start().result
    expect(replay.code, replay.stderr).toBe(0); expect(replay.stdout).toBe(first.stdout)
    expect(await f.restarts()).toBe(1); expect(ready.samples()).toBeGreaterThanOrEqual(4)
  }, 30_000)

  test('signs readiness through the descriptor-pinned Host runner', async () => {
    const f = await fixture(); const ready = await readinessFixture(f)
    const prior = process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
    process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = f.configPath
    try {
      const trust = { hostAttestor: { ...ready.request.issuer, timeoutMs: 10000, environmentAllowlist: ['DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'] } } as unknown as PluginControlTrustConfig
      const throughRunner = await invokeConfiguredHostAttestor(trust, ready.request)
      await f.verifyRequest(throughRunner, ready.request)
      const replay = await ready.start().result
      expect(replay.code, replay.stderr).toBe(0)
      // The runner parses/validates into its public receipt field order; raw
      // executable stdout byte equality is checked separately above.
      expect(throughRunner).toEqual(JSON.parse(replay.stdout))
      expect(await f.restarts()).toBe(1)
    } finally { if (prior === undefined) delete process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG; else process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = prior }
  }, 30_000)

  test.each(['epoch-drift', 'wrong-context', 'replayed-challenge', 'wrong-mac'] as const)('rejects %s observer output without another restart', async mode => {
    const f = await fixture(); const ready = await readinessFixture(f, mode)
    const result = await ready.start().result
    expect(result.code).toBe(1); expect(result.stdout).toBe('')
    expect(await f.restarts()).toBe(1)
  })

  test('signs a stable inactive candidate as a failed readiness receipt and replays it without restart', async () => {
    const f = await fixture(); const ready = await readinessFixture(f, 'inactive')
    const first = await ready.start().result
    expect(first.code, first.stderr).toBe(0)
    const receipt = JSON.parse(first.stdout); await f.verifyRequest(receipt, ready.request)
    expect(receipt).toMatchObject({ phase: 'readiness', outcome: 'failed', hostGeneration: 1,
      evidence: { kind: 'readiness', checks: expect.any(Number), failures: expect.any(Number) } })
    expect(receipt.evidence.checks).toBeGreaterThanOrEqual(2)
    expect(receipt.evidence.failures).toBe(receipt.evidence.checks)
    const replay = await ready.start().result
    expect(replay.code, replay.stderr).toBe(0); expect(replay.stdout).toBe(first.stdout)
    expect(await f.restarts()).toBe(1)
  }, 30_000)

  test.each(['inactive-then-active', 'bad-identity'] as const)('does not sign %s as a failed readiness result', async mode => {
    const f = await fixture(); const ready = await readinessFixture(f, mode)
    const result = await ready.start().result
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(await f.restarts()).toBe(1)
  })

  test('does not sign a disconnected observer as a failed readiness result', async () => {
    const f = await fixture(); const ready = await readinessFixture(f, 'disconnected')
    const result = await ready.start().result
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(await f.restarts()).toBe(1)
    const db = new DatabaseSync(join(f.config.stateRoot, 'reload.sqlite'))
    try { expect(db.prepare('SELECT receipt FROM readiness WHERE operation_id = ?').get(ready.request.operationId)).toEqual({ receipt: null }) } finally { db.close() }
  })

  test('does not turn a retained failed readiness operation into passed when the candidate later activates', async () => {
    const f = await fixture(); const ready = await readinessFixture(f, 'inactive')
    const first = await ready.start().result; expect(first.code, first.stderr).toBe(0)
    ready.setBehavior('stable')
    const later = await ready.start().result
    expect(later.code).toBe(1); expect(later.stdout).toBe(''); expect(await f.restarts()).toBe(1)
  }, 30_000)

  test.each(['missing', 'legacy', 'superseded'] as const)('refuses readiness when the retained reload is %s', async state => {
    const f = await fixture(); const ready = await readinessFixture(f)
    const db = new DatabaseSync(join(f.config.stateRoot, 'reload.sqlite'))
    try {
      if (state === 'missing') db.exec('DELETE FROM reloads')
      else if (state === 'legacy') db.exec('UPDATE reloads SET request = NULL')
      else db.exec(`INSERT INTO reloads(operation_id, request_digest, config_digest, scope_id, generation, activation_id, prior)
        SELECT 'pending-generation', request_digest, config_digest, scope_id, 2, 'pending-activation', prior FROM reloads`)
    } finally { db.close() }
    const result = await ready.start().result
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(await f.restarts()).toBe(1)
  })

  test('refuses a cached readiness receipt after its observed runtime identity drifts', async () => {
    const f = await fixture(); const ready = await readinessFixture(f)
    const first = await ready.start().result; expect(first.code, first.stderr).toBe(0)
    ready.setBehavior('epoch-drift')
    const second = await ready.start().result
    expect(second.code).toBe(1); expect(second.stdout).toBe(''); expect(await f.restarts()).toBe(1)
  })

  test('concurrent first readiness calls return byte-identical receipts without another reload', async () => {
    const f = await fixture(); const ready = await readinessFixture(f)
    const results = await Promise.all([ready.start().result, ready.start().result])
    expect(results.every(result => result.code === 0), JSON.stringify(results)).toBe(true)
    expect(results[0]!.stdout).toBe(results[1]!.stdout); expect(await f.restarts()).toBe(1)
  })

  test('rejects a changed observer client pin, deployment pin, legacy request and expired authorization before readiness', async () => {
    const f = await fixture(); const ready = await readinessFixture(f)
    const config = f.config as unknown as { readiness: { client: { sha256: string }; deploymentFiles: Array<{ path: string; sha256: string }> }; authorization: {
      requestDigest: string; expiresAt: number; plan: { id: string; digest: string }
    } }
    config.readiness.client.sha256 = '0'.repeat(64); await f.save()
    expect((await ready.start().result).code).toBe(1)
    config.readiness.client.sha256 = sha(await readFile(resolve('lib/runtime-observer-protocol.js')))
    config.readiness.deploymentFiles[0]!.sha256 = '0'.repeat(64); await f.save()
    expect((await ready.start().result).code).toBe(1)
    config.readiness.deploymentFiles[0]!.sha256 = sha(await readFile(config.readiness.deploymentFiles[0]!.path)); await f.save()
    const legacy = { ...ready.request, requirements: { kind: 'reload', previousHostGeneration: 0 } } as unknown as HostAttestationRequest
    config.authorization.requestDigest = hostAttestationRequestDigest(legacy); await f.save()
    expect((await f.start(legacy).result).code).toBe(1)
    const wrongContext = { ...ready.request, plan: { id: 'other-plan', digest: 'b'.repeat(64) } }
    config.authorization.plan = wrongContext.plan; config.authorization.requestDigest = hostAttestationRequestDigest(wrongContext); await f.save()
    expect((await f.start(wrongContext).result).code).toBe(1)
    config.authorization.plan = ready.request.plan
    config.authorization.requestDigest = hostAttestationRequestDigest(ready.request); config.authorization.expiresAt = Date.now() - 1; await f.save()
    expect((await ready.start().result).code).toBe(1)
    expect(await f.restarts()).toBe(1)
  })

  test('signs exact reload evidence and replays a byte-identical receipt without restarting', async () => {
    const f = await fixture(); const first = await f.start().result
    expect(first.code, first.stderr).toBe(0)
    const receipt = JSON.parse(first.stdout); await f.verify(receipt)
    expect(receipt.hostGeneration).toBe(1); expect(receipt.phase).toBe('reload')
    const second = await f.start().result; expect(second.code, second.stderr).toBe(0); expect(second.stdout).toBe(first.stdout)
    expect(await f.restarts()).toBe(1)
    const db = new DatabaseSync(join(f.config.stateRoot, 'reload.sqlite'), { readOnly: true })
    try { const row = db.prepare('SELECT observation FROM reloads').get()!; expect(JSON.parse(String(row.observation)).successor.InvocationID).toBe('2'.repeat(32)) } finally { db.close() }
  })
  test('works through the actual descriptor-pinned Host runner', async () => {
    const f = await fixture(); const prior = process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
    process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = f.configPath
    try {
      const trust = { hostAttestor: { ...f.request.issuer, timeoutMs: 10000, environmentAllowlist: ['DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'] } } as unknown as PluginControlTrustConfig
      await f.verify(await invokeConfiguredHostAttestor(trust, f.request)); expect(await f.restarts()).toBe(1)
    } finally { if (prior === undefined) delete process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG; else process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = prior }
  })
  test('concurrent identical operations dispatch only one restart', async () => {
    const f = await fixture(); const results = await Promise.all([f.start().result, f.start().result])
    expect(results.some(result => result.code === 0), JSON.stringify(results)).toBe(true)
    expect(await f.restarts()).toBe(1)
    const retry = await f.start().result; expect(retry.code, retry.stderr).toBe(0); await f.verify(JSON.parse(retry.stdout))
  })
  test('lost restart acknowledgement reconciles supervisor state without resubmission', async () => {
    const f = await fixture('lost-ack'); expect((await f.start().result).code).toBe(1)
    const reconciled = await f.start().result; expect(reconciled.code, reconciled.stderr).toBe(0)
    await f.verify(JSON.parse(reconciled.stdout)); expect(await f.restarts()).toBe(1)
  })
  test('a killed attestor resumes by observation without another restart', async () => {
    const f = await fixture('wait'); const running = f.start()
    const deadline = Date.now() + 5000
    while (await f.restarts() === 0) { if (Date.now() > deadline) throw new Error('fixture did not dispatch'); await new Promise(resolveWait => setTimeout(resolveWait, 20)) }
    running.child.kill('SIGKILL')
    // The external supervisor command outlives the killed owner; this fixture owns its cleanup.
    const commandPid = Number(await readFile(join(f.root, 'restart.pid'), 'utf8')); process.kill(commandPid, 'SIGKILL')
    await running.result
    const reconciled = await f.start().result; expect(reconciled.code, reconciled.stderr).toBe(0); expect(await f.restarts()).toBe(1)
  })
  test.each(['unchanged', 'drift', 'duplicate'])('rejects %s supervisor observations without a passing receipt', async mode => {
    const f = await fixture(mode)
    if (mode === 'unchanged') { f.config.timeoutMs = 1500; await f.save() }
    const result = await f.start().result
    expect(result.code).toBe(1); expect(result.stdout).toBe('')
    await f.start().result; expect(await f.restarts()).toBe(mode === 'duplicate' ? 0 : 1)
  })
  test.each(['readiness', 'shadow', 'health'])('rejects unsupported %s before acquiring supervisor authority', async phase => {
    const f = await fixture(); expect((await f.start({ ...f.request, phase }).result).code).toBe(1)
    expect(await readFile(join(f.root, 'calls'), 'utf8').catch(() => '')).toBe('')
    expect(await readFile(join(f.config.stateRoot, 'reload.sqlite')).catch(() => null)).toBe(null)
  })
  test('rejects forged scope, generation, helper pin and unsafe owner config before restart', async () => {
    const f = await fixture()
    for (const request of [{ ...f.request, activation: { id: 'other', fence: 1 } }, { ...f.request, requirements: { kind: 'reload', previousHostGeneration: 9 } },
      { ...f.request, operationId: 'forged-operation' }, { ...f.request, requestedAt: f.request.requestedAt + 1 },
      { ...f.request, receiptTtlMs: 60000 }, { ...f.request, issuer: { ...f.request.issuer, id: 'forged-issuer' } }]) {
      expect((await f.start(request).result).code).toBe(1)
    }
    f.config.processHelper.sha256 = '0'.repeat(64); await f.save(); expect((await f.start().result).code).toBe(1)
    await chmod(f.configPath, 0o644); expect((await f.start().result).code).toBe(1); expect(await f.restarts()).toBe(0)
  })
  test('rejects profile drift and an operation replacement after dispatch', async () => {
    const f = await fixture(); const first = await f.start().result; expect(first.code, first.stderr).toBe(0)
    expect((await f.start({ ...f.request, operationId: 'host-operation-replacement' }).result).code).toBe(1)
    await writeFile(join(f.config.authorization.profile.path, 'cordis.patch.yml'), 'changed\n')
    expect((await f.start().result).code).toBe(1); expect(await f.restarts()).toBe(1)
  })
  test('refuses to restart its own service cgroup', async () => {
    const f = await fixture()
    const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').map(line => line.match(/^\d+:([^:]*):(.*)$/u))
      .find(match => match && (match[1] === '' || match[1]!.split(',').includes('name=systemd')))?.[2]
    expect(cgroup).toBeTruthy()
    const path = join(f.root, 'observation.json'); const observation = JSON.parse(await readFile(path, 'utf8')); observation.ControlGroup = cgroup
    await writeFile(path, JSON.stringify(observation)); expect((await f.start().result).code).toBe(1); expect(await f.restarts()).toBe(0)
  })
  test('does not allow a newly authorized operation to leapfrog an unresolved generation', async () => {
    const f = await fixture('unchanged'); f.config.timeoutMs = 1500; await f.save()
    expect((await f.start().result).code).toBe(1); expect(await f.restarts()).toBe(1)
    f.request.operationId = 'host-operation-next'; f.request.requirements = { kind: 'reload', previousHostGeneration: 1 }
    f.request.activation.id = 'activation-next'; f.config.authorization.previousHostGeneration = 1
    f.config.authorization.requestDigest = hostAttestationRequestDigest(f.request); await f.save()
    expect((await f.start().result).code).toBe(1); expect(await f.restarts()).toBe(1)
  })
  test('advances installation generations across alternating profiles', async () => {
    const a = await fixture(); const b = await fixture()
    b.config.stateRoot = a.config.stateRoot
    const secondPath = join(b.root, 'home/profiles/second')
    await rename(b.config.authorization.profile.path, secondPath)
    b.config.profileFiles = b.config.profileFiles.map(pin => ({ ...pin, path: pin.path.replace('/profiles/test/', '/profiles/second/') }))
    b.config.authorization.profile.path = secondPath
    b.config.authorization.profile.name = 'second'; b.config.unit = 'dsh-profile-second.service'
    b.config.unitProperties.ExecStart = b.config.unitProperties.ExecStart.replace('--profile test', '--profile second')
    const bPath = join(b.root, 'observation.json'); const bObservation = JSON.parse(await readFile(bPath, 'utf8'))
    bObservation.Id = b.config.unit; bObservation.ExecStart = b.config.unitProperties.ExecStart; await writeFile(bPath, JSON.stringify(bObservation))
    b.request.operationId = 'host-operation-second'; b.request.plan.id = 'second-plan'; b.request.activation.id = 'second-activation'
    b.request.requirements = { kind: 'reload', previousHostGeneration: 1 }; b.config.authorization.previousHostGeneration = 1
    b.config.authorization.requestDigest = hostAttestationRequestDigest(b.request); await b.save()
    const first = await a.start().result; expect(first.code, first.stderr).toBe(0); expect(JSON.parse(first.stdout).hostGeneration).toBe(1)
    const second = await b.start().result; expect(second.code, second.stderr).toBe(0); expect(JSON.parse(second.stdout).hostGeneration).toBe(2)
    a.request.operationId = 'host-operation-third'; a.request.plan.id = 'third-plan'; a.request.activation.id = 'third-activation'
    a.request.requirements = { kind: 'reload', previousHostGeneration: 2 }; a.config.authorization.previousHostGeneration = 2
    a.config.authorization.requestDigest = hostAttestationRequestDigest(a.request); await a.save()
    const third = await a.start().result; expect(third.code, third.stderr).toBe(0); expect(JSON.parse(third.stdout).hostGeneration).toBe(3)
    expect(await a.restarts()).toBe(2); expect(await b.restarts()).toBe(1)
  }, 25000)
})
