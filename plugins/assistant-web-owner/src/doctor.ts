import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual, promisify } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { literalAutonomyLinux, validateAutonomyLinuxPaths, type AutonomyLinuxConfig } from './autonomy.js'
import type { IsolationGrant } from '@dsh-enhanced/assistant-isolation'

interface AutonomyDoctorBase {
  stateRoot: string; databasePath: string
  grant: IsolationGrant
  principal: { channel: 'web'; account: string; tenant: string; user: string }
}
export type AutonomyDoctorProfile = AutonomyDoctorBase & ({ backend?: 'docker'; image: string; dockerPath: string; linux?: never } | { backend: 'linux-native'; linux: AutonomyLinuxConfig; image?: never; dockerPath?: never })
function fail(message: string): never { throw new Error(`autonomy doctor: ${message}`) }
function literal(node: unknown, label: string): unknown {
  if (isScalar(node) && (node.tag === undefined || node.tag === 'tag:yaml.org,2002:str')) return node.value
  fail(`${label} must be literal`)
}
function path(node: unknown, label: string, dshHome?: string): string {
  let value: unknown
  if (dshHome !== undefined && isScalar(node) && node.tag === 'tag:yaml.org,2002:js' && typeof node.value === 'string') {
    const match = /^dshHomePath\(['"]([^'"\n]+)['"]\)$/u.exec(node.value)
    if (!match || isAbsolute(match[1]!) || match[1]!.split('/').includes('..')) fail(`${label} has an unsupported expression`)
    value = join(dshHome, match[1]!)
  } else value = literal(node, label)
  if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value || /[\p{Cc}*]/u.test(value)) fail(`${label} must be a canonical absolute path`)
  return value
}
function object(node: unknown, label: string): Record<string, unknown> {
  if (!isMap(node)) fail(`${label} must be a mapping`)
  const result: Record<string, unknown> = Object.create(null)
  for (const pair of node.items) {
    const key = literal(pair.key, label)
    if (typeof key !== 'string') fail(`${label} keys must be strings`)
    result[key] = literal(pair.value, `${label}.${key}`)
  }
  return result
}

/** Inspect the composed profile without evaluating tagged expressions or changing its grants. */
export function inspectAutonomyProfile(source: string, profile: string, dshHome: string): AutonomyDoctorProfile {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile) || !isAbsolute(dshHome) || normalize(dshHome) !== dshHome || /[\p{Cc}*]/u.test(dshHome)) fail('invalid profile or home')
  const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || !isSeq(document.contents)) fail('effective profile must be an unambiguous sequence')
  const rows = document.contents as YAMLSeq
  const config = (slug: string): YAMLMap => {
    const id = `dsh-enhanced-${slug}`; const name = `@dsh-enhanced/${slug}`
    const matches = rows.items.filter(item => isMap(item) && (item.get('id') === id || item.get('name') === name)) as YAMLMap[]
    const row = matches[0]
    if (matches.length !== 1 || !row || literal(row.get('id', true), slug) !== id || literal(row.get('name', true), slug) !== name || (row.has('disabled') && literal(row.get('disabled', true), id) !== false)) fail(`missing, disabled or ambiguous ${slug}`)
    const value = row.get('config', true)
    if (!isMap(value)) fail(`${slug} config must be a mapping`)
    return value
  }
  const isolation = config('assistant-isolation'); const owner = config('assistant-web-owner'); const delivery = config('assistant-delivery')
  const principal = object(owner.get('principal', true), 'Web principal')
  if (!isDeepStrictEqual({ ...principal }, { account: profile, tenant: 'local', user: 'operator' })) fail('expected installer-managed Web owner')
  const workspace = path(owner.get('workspace', true), 'Web workspace')
  const preset = literal(owner.get('preset', true), 'Web preset')
  if (typeof preset !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(preset)) fail('invalid Web preset')
  const grants = isolation.get('grants', true)
  if (!isSeq(grants) || grants.items.length !== 1) fail('expected one installer-managed isolation grant')
  const grant = object(grants.items[0], 'Isolation grant')
  const fields = ['id', 'revision', 'principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset', 'expiresAt', 'maxRuns', 'maxTotalDurationMs']
  if (Object.keys(grant).sort().join(',') !== fields.sort().join(',') || grant.id !== `autonomy-${profile}`
    || grant.principalDigest !== createHash('sha256').update(`web/${profile}/local/operator`).digest('hex')
    || grant.workspace !== workspace || grant.agentPreset !== preset
    || typeof grant.principalRecordId !== 'string' || grant.principalRecordId.length === 0
    || !['revision', 'principalVersion', 'expiresAt', 'maxRuns', 'maxTotalDurationMs'].every(key => Number.isSafeInteger(grant[key]) && (grant[key] as number) > 0)) fail('invalid managed grant or owner scope')
  const stateRoot = path(isolation.get('stateRoot', true), 'Isolation stateRoot')
  const common: AutonomyDoctorBase = { stateRoot,
    databasePath: path(delivery.get('databasePath', true), 'Delivery databasePath', dshHome),
    grant: { ...grant } as unknown as IsolationGrant, principal: { channel: 'web', account: profile, tenant: 'local', user: 'operator' } }
  const backend = isolation.has('backend') ? literal(isolation.get('backend', true), 'Isolation backend') : 'docker'
  if (backend === 'linux-native') {
    if (isolation.has('image') || isolation.has('dockerPath') || isolation.has('socketPath')) fail('mixed native and Docker configuration')
    const linux = literalAutonomyLinux(isolation.get('linux', true))
    validateAutonomyLinuxPaths(linux, stateRoot, dshHome)
    return { ...common, backend, linux }
  }
  if (backend !== 'docker' || isolation.has('linux')) fail('invalid isolation backend')
  const image = literal(isolation.get('image', true), 'Isolation image')
  if (typeof image !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(image)) fail('immutable local isolation image required')
  return { ...common, image, dockerPath: isolation.has('dockerPath') ? path(isolation.get('dockerPath', true), 'Docker path') : '/usr/bin/docker',
    ...(isolation.has('backend') ? { backend: 'docker' as const } : {}) }

}

/** A read-only snapshot, never pairing, migration, or an authorization for future execution. */
export function inspectAutonomyOwner(profile: AutonomyDoctorProfile): { status: 'matched' | 'unavailable' | 'mismatch' } {
  let database: DatabaseSync | undefined
  try {
    if (!lstatSync(profile.databasePath).isFile() || realpathSync(profile.grant.workspace) !== profile.grant.workspace) return { status: 'unavailable' }
    database = new DatabaseSync(profile.databasePath, { readOnly: true })
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN;')
    // Deliberately pinned rather than imported: each Delivery schema must be
    // reviewed before this self-contained read-only gate accepts it. v25 adds
    // foreground completion sequencing, v26 restart fences, v27 progress
    // handles, v28 foreground termination, v29 report/reply sidecars, v30 owner feedback and v31 attention audit.
    // Principal authority is unchanged from v24; reply state is not an owner receipt.
    // Unknown versions fail closed.
    const schemaVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (![24, 25, 26, 27, 28, 29, 30, 31].includes(schemaVersion)) return { status: 'unavailable' }
    const row = database.prepare('SELECT principal_json, role, status, version, linked_to_id FROM delivery_principals WHERE id = ?').get(profile.grant.principalRecordId)
    if (!row || row.role !== 'owner' || row.status !== 'active' || row.version !== profile.grant.principalVersion || row.linked_to_id !== null
      || typeof row.principal_json !== 'string' || !isDeepStrictEqual(JSON.parse(row.principal_json), profile.principal)) return { status: 'mismatch' }
    return { status: 'matched' }
  } catch { return { status: 'unavailable' } } finally { database?.close() }
}

/** Verify only the persisted backend descriptor; never fetch, prepare or renew. */
export async function probeAutonomyProfileRuntime(profile: AutonomyDoctorProfile): Promise<void> {
  if (profile.backend === 'linux-native') {
    const { verifyLinuxRuntime } = await import('@dsh-enhanced/assistant-isolation')
    const { probeLinuxIsolationRuntime } = await import('@dsh-enhanced/assistant-isolation/native-resources')
    await verifyLinuxRuntime(profile.linux.runtime)
    await probeLinuxIsolationRuntime(profile.linux)
  } else {
    const { probeIsolationRuntime } = await import('@dsh-enhanced/assistant-isolation')
    await probeIsolationRuntime(profile.image, profile.dockerPath)
  }
}

export async function runAutonomyDoctor(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: dsh-autonomy-doctor [--profile web] [--dsh-home <absolute-path>]\nChecks the installed finite isolation grant, paired owner and a temporary backend-specific probe. Does not activate a Host, renew grants, or test model/Goal/Actions readiness.\n')
    return
  }
  let profile = 'web'; let dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]; const value = argv[++index]
    if (!['--profile', '--dsh-home'].includes(option ?? '') || !value || value.startsWith('--')) fail('invalid arguments')
    if (option === '--profile') profile = value; else dshHome = value
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile) || !isAbsolute(dshHome) || normalize(dshHome) !== dshHome || /[\p{Cc}*]/u.test(dshHome)) fail('invalid profile or home')
  const dump = async () => {
    try { return (await promisify(execFile)('dsh', ['--profile', profile, '--dump-config'], { env: { ...process.env, DSH_HOME: dshHome }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout }
    catch { fail('could not compose profile; inspect installed bundles and configuration') }
  }
  const parsed = inspectAutonomyProfile(await dump(), profile, dshHome)
  const { inspectIsolationGrant, probeIsolationRuntime } = await import('@dsh-enhanced/assistant-isolation')
  if (typeof inspectIsolationGrant !== 'function' || typeof probeIsolationRuntime !== 'function') fail('install the matching assistant-isolation version with grant diagnostics; no state was changed')
  const owner = inspectAutonomyOwner(parsed)
  const grant = inspectIsolationGrant({ stateRoot: parsed.stateRoot, grant: parsed.grant })
  // Report persisted state before dispatching a disposable, separately bounded probe.
  process.stdout.write(`${JSON.stringify({ scope: 'finite-isolation', owner, grant, modelAndGoals: 'not-checked', externalActions: 'not-checked' })}\n`)
  if (owner.status !== 'matched' || grant.status !== 'available') fail('owner or persisted grant checks failed; no authority was renewed')
  await probeAutonomyProfileRuntime(parsed)
  if (!isDeepStrictEqual(inspectAutonomyProfile(await dump(), profile, dshHome), parsed)
    || inspectAutonomyOwner(parsed).status !== 'matched'
    || inspectIsolationGrant({ stateRoot: parsed.stateRoot, grant: parsed.grant }).status !== 'available') fail('configuration or authority changed during probe; retry diagnostics')
  process.stdout.write('Finite isolation configuration, owner, persisted grant and temporary runtime probe passed. This is a diagnostic snapshot; Policy, live resource admission, model budgets, Goal verification and external Actions still require their own checks.\n')
}
