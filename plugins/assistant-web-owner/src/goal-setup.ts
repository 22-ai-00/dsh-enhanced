import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute, normalize, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as Delivery from '@dsh-enhanced/assistant-delivery'
import { inspectIsolationGrant } from '@dsh-enhanced/assistant-isolation'
import { prepareWebOwnerProfile, type WebOwnerSetupInput } from './setup.js'
import { prepareGoalAdmission } from './goal-admission.js'
import { inspectAutonomyProfile } from './doctor.js'

function fail(reason: string): never { throw new Error(`goal setup: ${reason}`) }
async function patch(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) fail('profile patch must be an existing regular file')
  return await readFile(path, 'utf8')
}
/** Offline configuration only. No pairing, lease acquisition, migration, model call, or goal creation. */
export async function configureGoalAdmission(input: WebOwnerSetupInput, effectiveSource: string, taskPath: string, sessionId: string): Promise<{ path: string; admissionId: string }> {
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
    const before = await patch(path)
    const prepared = prepareWebOwnerProfile(input, before, effectiveSource)
    const profile = inspectAutonomyProfile(prepared.patch, input.profile, input.dshHome)
    const query = { databasePath: prepared.databasePath, sessionId, expectedPrincipal: prepared.principal, workspace: input.workspace, agentPreset: input.preset }
    const observed = inspectActiveWebOwnerBindingLocally(query)
    if (observed.status !== 'matched') fail(`session owner snapshot ${observed.status}; use an existing idle owner session`)
    const inspectGrant = () => inspectIsolationGrant({ stateRoot: profile.stateRoot, grant: profile.grant })
    if (inspectGrant().status !== 'available') fail('persisted isolation grant unavailable; setup does not renew grants')
    const plan = prepareGoalAdmission(input, prepared.patch, effectiveSource, taskSource, observed.snapshot)
    const recheck = async () => {
      if (await patch(path) !== before || !isDeepStrictEqual(inspectActiveWebOwnerBindingLocally(query), observed)
        || inspectGrant().status !== 'available') fail('profile, session or grant changed during setup; no patch committed')
    }
    if (plan.patch === before) { await recheck(); return { path, admissionId: plan.admissionId } }
    await writeFile(temporary, plan.patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await recheck()
    await rename(temporary, path)
    // A DB snapshot and file rename are not one transaction. Runtime admission rechecks authority.
    if (!isDeepStrictEqual(inspectActiveWebOwnerBindingLocally(query), observed) || inspectGrant().status !== 'available') fail('patch written, but authority changed; runtime readiness is not established')
    return { path, admissionId: plan.admissionId }
  } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }) }
}
