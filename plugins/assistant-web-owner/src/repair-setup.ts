import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import * as Skills from '@dsh-enhanced/assistant-skills'
import { prepareWebOwnerProfile, type WebOwnerSetupInput } from './setup.js'

function fail(reason: string): never { throw new Error(`repair setup: ${reason}`) }
const { validateExternalHoldoutProfiles, validateRepairProfiles } = Skills as unknown as {
  validateExternalHoldoutProfiles(values: readonly unknown[]): readonly unknown[]
  validateRepairProfiles(values: unknown, holdouts: readonly unknown[]): readonly unknown[]
}
type RepairProfile = { id: string, scope: { principalId: string, principalRecordId: string, principalVersion: number, workspace: string, preset: string }, skillName: string, taskFamilyId: string, description: string, externalHoldoutProfileId: string, provider: string, model: string, allowedTools: string[], maxGoalRounds: number, maxModelCalls: number, maxToolCalls: number, maxOutputTokens: number, maxDurationMs: number, canaryRuns: number, maxCanaryRuns: number, maxIterations?: number, followupProfileIds?: string[], bindings?: unknown[] }
export type RepairAdmissionTask = { repairProfiles: RepairProfile[], externalHoldouts: unknown[], ownerRouteId: string }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0')
const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max

/** Strict private operator input. It contains no task, source Goal, credentials, or evaluator cases. */
export function parseRepairAdmissionTask(source: string): RepairAdmissionTask {
  let value: unknown; try { value = JSON.parse(source) } catch { fail('admission file must be JSON') }
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'externalHoldouts,ownerRouteId,repairProfiles' || !Array.isArray(value.repairProfiles) || value.repairProfiles.length < 1 || value.repairProfiles.length > 4 || !Array.isArray(value.externalHoldouts) || !text(value.ownerRouteId, 4096)) fail('admission fields are invalid')
  for (const p of value.repairProfiles) {
    if (!plain(p) || !plain(p.scope) || Object.keys(p).some(key => !['id','scope','skillName','taskFamilyId','description','externalHoldoutProfileId','provider','model','allowedTools','maxGoalRounds','maxModelCalls','maxToolCalls','maxOutputTokens','maxDurationMs','canaryRuns','maxCanaryRuns','maxIterations','followupProfileIds','bindings'].includes(key)) || Object.keys(p.scope).sort().join(',') !== 'preset,principalId,principalRecordId,principalVersion,workspace' || ![p.id,p.skillName,p.taskFamilyId,p.description,p.externalHoldoutProfileId,p.provider,p.model,p.scope.principalId,p.scope.principalRecordId,p.scope.workspace,p.scope.preset].every(item => text(item, 4096)) || !isAbsolute(p.scope.workspace as string) || !Array.isArray(p.allowedTools) || p.allowedTools.length < 1 || p.allowedTools.some(item => !text(item, 128) || /^(?:skill_|goal_create$|goal_control$|set_goal$|update_goal$)/u.test(item)) || !integer(p.scope.principalVersion, 1, Number.MAX_SAFE_INTEGER) || !integer(p.maxGoalRounds, 1, 32) || !integer(p.maxModelCalls, 1, 128) || !integer(p.maxToolCalls, 1, 512) || !integer(p.maxOutputTokens, 1, 65536) || !integer(p.maxDurationMs, 1000, 300000) || !integer(p.canaryRuns, 1, 32) || !integer(p.maxCanaryRuns, p.canaryRuns as number, 100) || (p.maxIterations !== undefined && !integer(p.maxIterations, 1, 4)) || (p.followupProfileIds !== undefined && (!Array.isArray(p.followupProfileIds) || p.followupProfileIds.length > Number(p.maxIterations ?? 1) - 1 || p.followupProfileIds.some(id => !text(id, 128)))) || (p.bindings !== undefined && !Array.isArray(p.bindings))) fail('repair profile is invalid or exceeds fixed authority')
  }
  return structuredClone(value) as RepairAdmissionTask
}
function config(rows: YAMLSeq, id: string): YAMLMap {
  const found = rows.items.filter(item => isMap(item) && item.get('id') === id) as YAMLMap[]
  if (found.length !== 1 || !found[0]!.has('config') || !isMap(found[0]!.get('config', true))) fail(`require one configured ${id}`)
  return found[0]!.get('config', true) as unknown as YAMLMap
}
function owner(databasePath: string, account: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const rows = database.prepare("SELECT id, principal_json, role, status, version FROM delivery_principals WHERE role='owner' AND status='active'").all() as Array<{ id: unknown, principal_json: unknown, role: unknown, status: unknown, version: unknown }>
    const matches = rows.filter(row => row.role === 'owner' && row.status === 'active' && text(row.id, 4096) && integer(row.version, 1, Number.MAX_SAFE_INTEGER) && (() => { try { const principal = JSON.parse(String(row.principal_json)); return principal?.channel === 'web' && principal.account === account && principal.tenant === 'local' && principal.user === 'operator' } catch { return false } })())
    if (matches.length !== 1) fail('current Web owner is unavailable')
    return { id: matches[0]!.id as string, version: matches[0]!.version as number }
  } finally { database.close() }
}
export function prepareRepairAdmission(input: WebOwnerSetupInput, source: string, effective: string, taskSource: string): { patch: string, id: string, databasePath: string, owner: { id: string, version: number } } {
  if (typeof validateExternalHoldoutProfiles !== 'function' || typeof validateRepairProfiles !== 'function') fail('matching assistant-skills validator exports are required')
  const base = prepareWebOwnerProfile(input, source, effective)
  const task = parseRepairAdmissionTask(taskSource); const doc = parseDocument(base.patch)
  if (doc.errors.length || !isSeq(doc.contents)) fail('prepared patch is not a sequence')
  const rows = doc.contents; const skills = config(rows, 'dsh-enhanced-assistant-skills'); const delivery = config(rows, 'dsh-enhanced-assistant-delivery')
  const goals = config(rows, 'dsh-enhanced-assistant-goals'); const verifier = config(rows, 'dsh-enhanced-assistant-verifier')
  const current = owner(base.databasePath, input.profile)
  const principalId = `web/${input.profile}/local/operator`
  if (task.repairProfiles.some(({ scope }) => scope.principalId !== principalId || scope.principalRecordId !== current.id || scope.principalVersion !== current.version || scope.workspace !== input.workspace || scope.preset !== input.preset)) fail('repair profile scope does not match the current owner')
  const routes = delivery.get('ownerRoutes', true); const execution = goals.get('executionBudget', true); const profiles = verifier.get('profiles', true)
  const executionRoutes = isMap(execution) ? execution.get('routes', true) : undefined
  if (!isSeq(routes) || !routes.items.some(item => isMap(item) && item.get('id') === task.ownerRouteId && item.get('workspace') === input.workspace && item.get('agentPreset') === input.preset) || !isMap(execution) || execution.get('mode') !== 'calls' || !integer(execution.get('modelCalls'), 1, 128) || !integer(execution.get('toolCalls'), 1, 512) || !integer(execution.get('durationMs'), 1_000, 300_000) || !integer(execution.get('maxOutputTokensPerCall'), 1, 65536) || !isSeq(executionRoutes) || task.repairProfiles.some(profile => profile.maxModelCalls > Number(execution.get('modelCalls')) || profile.maxToolCalls > Number(execution.get('toolCalls')) || profile.maxDurationMs > Number(execution.get('durationMs')) || profile.maxOutputTokens > Number(execution.get('maxOutputTokensPerCall')) || !executionRoutes.items.some(route => isMap(route) && route.get('provider') === profile.provider && route.get('model') === profile.model)) || profiles === undefined) fail('current owner route, finite Goals execution budget, exact model route, or Verifier profiles are missing')
  let holdouts: unknown = skills.get('externalHoldouts', true); if (holdouts === undefined) { holdouts = doc.createNode([]); skills.set('externalHoldouts', holdouts as never) }
  if (!isSeq(holdouts)) fail('externalHoldouts must be a sequence')
  // Validate the complete post-merge value with the published Skills contract
  // before changing the YAML document. This is the admission gate, not a
  // deferred runtime failure.
  const existingHoldouts = holdouts.items.map(item => (item as YAMLMap | undefined)?.toJSON())
  const nextHoldouts = validateExternalHoldoutProfiles([...existingHoldouts, ...task.externalHoldouts.filter(value => !existingHoldouts.some(old => plain(old) && plain(value) && old.id === value.id))])
  const existingRepair = skills.get('repairProfiles', true)
  const existingProfiles = isSeq(existingRepair) ? existingRepair.items.map(item => (item as YAMLMap | undefined)?.toJSON()) : []
  validateRepairProfiles([...existingProfiles, ...task.repairProfiles.filter(value => !existingProfiles.some(old => plain(old) && old.id === value.id))], nextHoldouts)
  for (const value of task.externalHoldouts) { const id = plain(value) ? value.id : undefined; const same = holdouts.items.filter(item => isMap(item) && item.get('id') === id) as YAMLMap[]; if (same.length > 1 || (same[0] && !isDeepStrictEqual(same[0].toJSON(), value))) fail('holdout conflicts with existing configuration'); if (!same[0]) holdouts.add(doc.createNode(value)) }
  let repair: unknown = skills.get('repairProfiles', true); if (repair === undefined) { repair = doc.createNode([]); skills.set('repairProfiles', repair as never) }
  if (!isSeq(repair)) fail('repairProfiles must be a sequence')
  for (const value of task.repairProfiles) { const same = repair.items.filter(item => isMap(item) && item.get('id') === value.id) as YAMLMap[]; if (same.length > 1 || (same[0] && !isDeepStrictEqual(same[0].toJSON(), value))) fail('repair profile conflicts with existing configuration'); if (!same[0]) repair.add(doc.createNode(value)) }
  return { patch: doc.toString({ lineWidth: 0 }), id: task.repairProfiles.map(value => value.id).join(', '), databasePath: base.databasePath, owner: current }
}
async function privateJson(path: string, workspace: string): Promise<string> {
  if (!isAbsolute(path) || await realpath(path) !== path || await realpath(workspace) !== workspace || (relative(workspace, path) !== '..' && !relative(workspace, path).startsWith(`..${sep}`) && !isAbsolute(relative(workspace, path)))) fail('use a canonical private admission path outside the workspace')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); try { const stat = await file.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024 * 1024) fail('admission file must be private, owned, regular and at most 1 MiB'); return await file.readFile({ encoding: 'utf8' }) } finally { await file.close() }
}
export async function configureRepairAdmission(input: WebOwnerSetupInput, effective: string, taskPath: string, reread?: () => Promise<string>): Promise<{ path: string, id: string }> {
  const directory = join(input.dshHome, 'profiles', input.profile); if (!(await lstat(directory)).isDirectory()) fail('install the target profile first')
  const task = await privateJson(taskPath, input.workspace); const lock = join(directory, '.assistant-web-owner-setup.lock'); try { await mkdir(lock, { mode: 0o700 }) } catch { fail('another setup holds the profile lock') }
  const path = join(directory, 'cordis.patch.yml'); const temporary = `${path}.${randomUUID()}.tmp`
  try { if (reread && await reread() !== effective) fail('effective configuration changed before setup; no patch committed'); const before = await readFile(path, 'utf8'); const plan = prepareRepairAdmission(input, before, effective, task); if (plan.patch !== before) { await writeFile(temporary, plan.patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); if (await readFile(path, 'utf8') !== before || reread && await reread() !== effective || !isDeepStrictEqual(owner(plan.databasePath, input.profile), plan.owner)) fail('configuration, owner, or budget changed during setup; no patch committed'); await rename(temporary, path) } return { path, id: plan.id } } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }) }
}
