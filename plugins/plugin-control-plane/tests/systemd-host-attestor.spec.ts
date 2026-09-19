import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { Ed25519HostAttestationAuthority, hostAttestationRequestDigest } from '../src/attestation.ts'
import { invokeConfiguredHostAttestor } from '../src/host-attestor.ts'
import type { PluginControlTrustConfig } from '../src/trust.ts'
import type { HostAttestationReceipt, HostAttestationRequest, PluginActivationPlan } from '../src/types.ts'

const roots: string[] = []
const children = new Set<ReturnType<typeof spawn>>()
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
  const old = { Id: 'dsh-profile-test.service', LoadState: 'loaded', ActiveState: 'active', SubState: 'running',
    MainPID: '12001', ControlPID: '0', InvocationID: '1'.repeat(32), NRestarts: '0', ControlGroup: '/fixture/dsh-profile-test.service', ...unitProperties }
  await writeFile(join(root, 'observation.json'), JSON.stringify(old), { mode: 0o600 })
  await writeFile(join(root, 'mode'), mode)
  const systemctlPath = join(root, 'systemctl.mjs')
  await writeFile(systemctlPath, `#!/usr/bin/node
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(root)};const mode=readFileSync(root+'/mode','utf8');
const args=process.argv.slice(2);const data=JSON.parse(readFileSync(root+'/observation.json','utf8'));
appendFileSync(root+'/calls',JSON.stringify(args)+'\\n');
if(args[1]==='show') {
  if(mode==='duplicate') process.stdout.write('Id='+data.Id+'\\n');
  process.stdout.write(Object.entries(data).map(([k,v])=>k+'='+v).join('\\n')+'\\n');
} else if(args[1]==='restart') {
  appendFileSync(root+'/restarts','restart\\n');writeFileSync(root+'/restart.pid',String(process.pid));
  if(mode!=='unchanged') {data.InvocationID=data.InvocationID==='1'.repeat(32)?'2'.repeat(32):'3'.repeat(32);data.MainPID=String(Number(data.MainPID)+1);}
  if(mode==='drift') data.Environment='DSH_HOME=/other';
  writeFileSync(root+'/observation.json',JSON.stringify(data));
  if(mode==='lost-ack') process.exitCode=7;
  if(mode==='wait') setInterval(()=>{},100);
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
    profile: config.authorization.profile, issuer: { mode: 'configured-executable', id: 'systemd-reload', version: 'dsh-systemd-host-attestor-1',
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
  const verify = async (receipt: HostAttestationReceipt) => new Ed25519HostAttestationAuthority(keys.publicKey.export({ type: 'spki', format: 'pem' }), config.authority, config.keyId)
    .verify(receipt, { id: 'plan', digest: 'a'.repeat(64), installationId: request.installationId,
      activation: { id: 'activation', fence: 1 }, createdAt: now - 1000 } as PluginActivationPlan, request)
  return { root, config, configPath, request, save, start, restarts, verify }
}

describe.skipIf(process.platform !== 'linux')('owner systemd reload attestor', () => {
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
