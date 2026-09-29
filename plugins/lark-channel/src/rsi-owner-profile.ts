import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { externalPrincipalId, ownerRouteAuthorityHash, type ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'
import { listAutomationsLocally } from '@dsh-enhanced/assistant-automations'
import { isMap, isSeq, parseDocument, stringify, type YAMLMap } from 'yaml'

function fail(message: string): never { throw new Error(`rsi owner profile: ${message}`) }
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) fail(`invalid ${label}`)
  return value
}
function path(value: unknown, home: string, label: string): string {
  const raw = text(value, label), expression = /^dshHomePath\((['"])([^'"\\]+)\1\)$/u.exec(raw)
  const resolved = expression ? join(home, expression[2]!) : raw
  if (expression && expression[2]!.split('/').some(part => !part || part === '.' || part === '..')
    || !isAbsolute(resolved) || resolve(resolved) !== resolved) fail(`${label} must be a canonical path or bounded dshHomePath expression`)
  return resolved
}
function rows(effective: string): Map<string, YAMLMap> {
  const document = parseDocument(effective, { uniqueKeys: true })
  if (document.errors.length || !isSeq(document.contents)) fail('invalid effective YAML')
  const result = new Map<string, YAMLMap>()
  for (const item of document.contents.items) {
    if (!isMap(item)) fail('invalid effective row')
    const id: unknown = item.get('id')
    if (typeof id !== 'string' || result.has(id)) fail('invalid or duplicate effective row')
    result.set(id, item)
  }
  return result
}
function config(entries: Map<string, YAMLMap>, id: string): YAMLMap {
  const entry = entries.get(id)
  const value: unknown = entry?.get('config', true)
  if (!entry || entry.get('disabled') === true || !isMap(value)) fail(`enabled ${id} config is required`)
  return value
}

/** Pure authority resolution. The caller adds a missing route only within its journaled compiler output. */
export function resolveRsiOwnerRoute(delivery: Record<string, any>, owner: ActiveLarkOwnerBinding, home: string, expectedId?: string) {
  if (owner.status !== 'active' || owner.owner?.status !== 'active' || owner.owner.role !== 'owner'
    || !owner.owner.id || !isDeepStrictEqual(owner.owner.principal, owner.principal)
    || owner.conversation.channel !== 'lark' || owner.conversation.kind !== 'dm' || owner.principal.channel !== 'lark'
    || ![owner.version, owner.generation, owner.owner.version].every(value => Number.isSafeInteger(value) && value >= 1)) fail('active owner receipt is invalid')
  const workspace = path(delivery.defaultWorkspace, home, 'Delivery workspace')
  const preset = text(delivery.defaultAgentPreset, 'Delivery preset')
  if (workspace !== owner.workspace || preset !== owner.agentPreset || delivery.policyRef !== undefined && delivery.policyRef !== owner.policyRef) fail('owner binding differs from effective delivery scope')
  const routes = delivery.ownerRoutes
  if (!Array.isArray(routes)) fail('Delivery owner routes are missing')
  const ids = new Set<string>()
  for (const route of routes) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) fail('invalid owner route')
    const id = text(route.id, 'owner route id')
    if (ids.has(id)) fail('owner route id is duplicated')
    ids.add(id)
  }
  const matching = routes.filter(route => isDeepStrictEqual(route.conversation, owner.conversation))
  if (matching.length > 1) fail('no unique effective route matches active owner')
  let authority = matching[0] as Record<string, any> | undefined
  if (authority) {
    for (const key of ['principal', 'workspace', 'agentPreset', 'policyRef'] as const) {
      if (!isDeepStrictEqual(authority[key], owner[key])) fail(`owner route ${key} conflicts with active owner`)
    }
    if (!Number.isSafeInteger(authority.minimumGeneration) || authority.minimumGeneration < 1
      || authority.minimumGeneration > owner.generation) fail('owner route minimumGeneration conflicts with active owner')
  } else {
    const lineage = { owner: owner.owner.id, conversation: owner.conversation, principal: owner.principal,
      workspace, agentPreset: preset, policyRef: owner.policyRef }
    const id = `rsi-owner-${createHash('sha256').update(JSON.stringify(lineage)).digest('hex').slice(0,32)}`
    if (ids.has(id)) fail('stable owner route id conflicts with an existing route')
    authority = { id, conversation: owner.conversation, principal: owner.principal, workspace,
      agentPreset: preset, policyRef: owner.policyRef, minimumGeneration: owner.generation }
  }
  if (expectedId !== undefined && authority.id !== expectedId) fail('owner route id differs from frozen manifest')
  return { workspace, preset, principal: externalPrincipalId(owner.principal), authority,
    created: matching.length === 0,
    route: { id: authority.id as string, authorityHash: ownerRouteAuthorityHash(authority as Parameters<typeof ownerRouteAuthorityHash>[0]) } }
}

/** Resolve owner lookup independently of Recovery/Health/Heartbeat deployment. */
export function rsiOwnerBindingQuery(effective: string, home: string) {
  const entries = rows(effective), delivery = config(entries, 'dsh-enhanced-assistant-delivery'), lark = config(entries, 'dsh-enhanced-lark-channel')
  return { account: text(lark.get('account'), 'Lark account'), tenant: text(lark.get('tenant'), 'Lark tenant'),
    workspace: path(delivery.get('defaultWorkspace'), home, 'Delivery workspace'),
    agentPreset: text(delivery.get('defaultAgentPreset'), 'Delivery preset') }
}
function automations(effective: string): YAMLMap {
  const entries = rows(effective)
  const standalone = entries.get('dsh-enhanced-assistant-automations'), personal = entries.get('dsh-enhanced-personal-assistant')
  if (standalone && standalone.get('disabled') !== true) {
    if (personal && personal.get('disabled') !== true) fail('ambiguous standalone and embedded Automations providers')
    return config(entries, 'dsh-enhanced-assistant-automations')
  }
  const value = config(entries, 'dsh-enhanced-personal-assistant').get('assistantAutomations', true)
  if (!isMap(value)) fail('assistantAutomations config is required')
  return value
}
export function rsiDatabasePaths(effective: string, home: string) {
  return { deliveryDatabasePath: path(config(rows(effective), 'dsh-enhanced-assistant-delivery').get('databasePath'), home, 'Delivery database'),
    automationsDatabasePath: path(automations(effective).get('databasePath'), home, 'Automations database') }
}
export interface RsiAutomationInventory {
  databasePath: string
  schedulerEnabled: boolean
  records: ReturnType<typeof listAutomationsLocally>
}
function missingPrivateDatabase(databasePath: string): boolean {
  try { lstatSync(databasePath); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // A fresh coordinator has no database directory yet. Prove absence under a
  // private physical ancestor without creating directories or masking symlinks.
  let parent = dirname(databasePath)
  for (;;) {
    try {
      const metadata = lstatSync(parent)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(parent) !== parent
        || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) fail('missing Automations database has an unsafe parent')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const next = dirname(parent)
      if (next === parent) fail('missing Automations database has no private parent')
      parent = next
    }
  }
}
export function rsiAutomationInventory(effective: string, home: string): RsiAutomationInventory {
  const value = automations(effective), databasePath = path(value.get('databasePath'), home, 'Automations database')
  const enabled = value.get('schedulerEnabled')
  if (enabled !== undefined && typeof enabled !== 'boolean') fail('invalid schedulerEnabled')
  return { databasePath, schedulerEnabled: enabled === true,
    records: missingPrivateDatabase(databasePath) ? [] : listAutomationsLocally(databasePath).filter(record => record.status !== 'deleted') }
}
export function rsiCoordinatorAutomationDatabasePath(home: string, profile: string): string {
  return join(home, 'rsi-coordinators', profile, 'automations.sqlite')
}
export type RsiAutomationInventories = [RsiAutomationInventory, RsiAutomationInventory, RsiAutomationInventory, RsiAutomationInventory]
/** Capture both source ledgers and both destination ledgers. A coordinator switches to a private database. */
export async function captureRsiAutomationInventories(inspect: (effective: string, home: string) => Promise<RsiAutomationInventory>,
  target: string, coordinator: string, home: string, profile: string): Promise<RsiAutomationInventories> {
  const current = await Promise.all([inspect(target, home), inspect(coordinator, home)])
  const planned = current.map((value, index) => stringify([{ id: 'dsh-enhanced-assistant-automations', config: {
    databasePath: index === 0 ? value.databasePath : rsiCoordinatorAutomationDatabasePath(home, profile), schedulerEnabled: true,
  } }]))
  const next = await Promise.all(planned.map(value => inspect(value, home)))
  return structuredClone([...current, ...next]) as RsiAutomationInventories
}
export function assertRsiSchedulerActivation(inventories: RsiAutomationInventories, acknowledged: boolean): void {
  for (let index = 0; index < 2; index++) {
    const before = inventories[index]!, after = inventories[index + 2]!
    if (after.schedulerEnabled && (!before.schedulerEnabled || before.databasePath !== after.databasePath)
      && (before.records.length > 0 || after.records.length > 0) && !acknowledged) {
      fail('existing active or paused Automations require --ack-existing-automations before scheduler activation')
    }
  }
}
