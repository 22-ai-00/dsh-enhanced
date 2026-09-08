import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute, normalize, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as Delivery from '@dsh-enhanced/assistant-delivery'
import { inspectIsolationGrant } from '@dsh-enhanced/assistant-isolation'
import { prepareWebOwnerProfile, type WebOwnerSetupInput } from './setup.js'
import { prepareGoalAdmission, parseGoalAdmissionTask } from './goal-admission.js'
import { inspectAutonomyProfile } from './doctor.js'

function fail(reason: string): never { throw new Error(`goal setup: ${reason}`) }
async function patch(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) fail('profile patch must be an existing regular file')
  return await readFile(path, 'utf8')
}
/** DSH resolves this user layer after the composed profile. Read no credential files. */
async function defaultModelSettings(dshHome: string): Promise<string | undefined> {
  const path = join(dshHome, 'settings.yaml')
  let stat
  try { stat = await lstat(path) } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) fail('settings.yaml must be an existing regular file at most 1 MiB')
  return await readFile(path, 'utf8')
}
/** Offline configuration only. No pairing, lease acquisition, migration, model call, or goal creation. */
async function idleOwnerSessions(input: WebOwnerSetupInput, databasePath: string, principal: { channel: 'web'; account: string; tenant: string; user: string }): Promise<readonly string[]> {
  const listActiveIdleWebOwnerBindingsLocally = Delivery.listActiveIdleWebOwnerBindingsLocally
  if (typeof listActiveIdleWebOwnerBindingsLocally !== 'function') fail('upgrade assistant-delivery with the matching autonomy bundle set; readonly owner session list API is unavailable')
  const observed = listActiveIdleWebOwnerBindingsLocally({ databasePath, expectedPrincipal: principal, workspace: input.workspace, agentPreset: input.preset })
  if (observed.status !== 'matched') fail(`owner session list ${observed.status}; no session was selected`)
  return observed.snapshots.map(item => item.binding.sessionId)
}

/** List only real, active and idle bindings matching this exact local Web owner scope. */
export async function listGoalAdmissionSessions(input: WebOwnerSetupInput, effectiveSource: string): Promise<readonly string[]> {
  const directory = join(input.dshHome, 'profiles', input.profile)
  if (!(await lstat(directory)).isDirectory()) fail('install the target profile first')
  const prepared = prepareWebOwnerProfile(input, await patch(join(directory, 'cordis.patch.yml')), effectiveSource)
  return await idleOwnerSessions(input, prepared.databasePath, prepared.principal)
}

export async function configureGoalAdmission(input: WebOwnerSetupInput, effectiveSource: string, taskPath: string, sessionId?: string,
  readEffectiveSource?: () => Promise<string>): Promise<{ path: string; admissionId: string; sessionId: string; repositoryDelivery?: { repository: string; branch: string; paths: string[]; acceptance: 'goal-outcome' | 'goal-step' } }> {
  const inspectActiveWebOwnerBindingLocally = Delivery.inspectActiveWebOwnerBindingLocally
  if (typeof inspectActiveWebOwnerBindingLocally !== 'function') fail('upgrade assistant-delivery with the matching autonomy bundle set; readonly owner snapshot API is unavailable')
  if (input.isolation) fail('initial isolation setup and goal setup are separate operations')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile) || !/^[a-z0-9][a-z0-9-]*$/u.test(input.preset)
    || [input.dshHome, input.workspace].some(value => !isAbsolute(value) || normalize(value) !== value || /[\p{Cc}*]/u.test(value))) fail('invalid profile or scope')
  if (!isAbsolute(taskPath) || await realpath(taskPath) !== taskPath || await realpath(input.workspace) !== input.workspace) fail('use canonical task and workspace paths')
  const within = relative(input.workspace, taskPath)
  if (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)) fail('keep private verification inputs outside the agent workspace')
  const file = await open(taskPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let taskSource: string
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) fail('task file must be private, owned by this user and at most 1 MiB')
    const bytes = Buffer.alloc(1024 * 1024 + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > 1024 * 1024) fail('task file exceeds 1 MiB')
    taskSource = bytes.subarray(0, length).toString('utf8')
  } finally { await file.close() }
  const directory = join(input.dshHome, 'profiles', input.profile)
  if (!(await lstat(directory)).isDirectory()) fail('install the target profile first')
  const lock = join(directory, '.assistant-web-owner-setup.lock')
  try { await mkdir(lock, { mode: 0o700 }) } catch { fail('another setup holds the profile lock') }
  const path = join(directory, 'cordis.patch.yml'); const temporary = `${path}.${randomUUID()}.tmp`
  try {
    if (readEffectiveSource && await readEffectiveSource() !== effectiveSource) fail('effective configuration changed before setup; no patch committed')
    const before = await patch(path)
    const settingsSource = await defaultModelSettings(input.dshHome)
    const prepared = prepareWebOwnerProfile(input, before, effectiveSource)
    const profile = inspectAutonomyProfile(prepared.patch, input.profile, input.dshHome)
    const candidates = sessionId === undefined ? await idleOwnerSessions(input, prepared.databasePath, prepared.principal) : [sessionId]
    if (candidates.length === 0) fail('no idle owner session; open the native Web UI once, then retry')
    if (candidates.length !== 1) fail(`multiple idle owner sessions; choose --session-id from: ${candidates.join(', ')}`)
    const selectedSessionId = candidates[0]!
    const query = { databasePath: prepared.databasePath, sessionId: selectedSessionId, expectedPrincipal: prepared.principal, workspace: input.workspace, agentPreset: input.preset }
    const observed = inspectActiveWebOwnerBindingLocally(query)
    if (observed.status !== 'matched') fail(`session owner snapshot ${observed.status}; use an existing idle owner session`)
    const inspectGrant = () => inspectIsolationGrant({ stateRoot: profile.stateRoot, grant: profile.grant })
    if (inspectGrant().status !== 'available') fail('persisted isolation grant unavailable; setup does not renew grants')
    const eventSupport = parseGoalAdmissionTask(taskSource).repositoryDelivery?.events
      ? await import('@dsh-enhanced/event-triggers').catch(() => fail('install matching event-triggers support for repository events')) : undefined
    const plan = prepareGoalAdmission(input, prepared.patch, effectiveSource, taskSource, observed.snapshot, Date.now(), settingsSource, eventSupport)
    const recheck = async () => {
      if (await patch(path) !== before || !isDeepStrictEqual(await defaultModelSettings(input.dshHome), settingsSource)
        || readEffectiveSource && await readEffectiveSource() !== effectiveSource
        || !isDeepStrictEqual(inspectActiveWebOwnerBindingLocally(query), observed) || inspectGrant().status !== 'available') fail('profile, session or grant changed during setup; no patch committed')
    }
    const result = { path, admissionId: plan.admissionId, sessionId: selectedSessionId, ...(plan.repositoryDelivery ? { repositoryDelivery: plan.repositoryDelivery } : {}) }
    if (plan.patch === before) { await recheck(); return result }
    await writeFile(temporary, plan.patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await recheck()
    await rename(temporary, path)
    // A DB snapshot and file rename are not one transaction. Runtime admission rechecks authority.
    if (!isDeepStrictEqual(inspectActiveWebOwnerBindingLocally(query), observed) || inspectGrant().status !== 'available') fail('patch written, but authority changed; runtime readiness is not established')
    return result
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }) }
}
