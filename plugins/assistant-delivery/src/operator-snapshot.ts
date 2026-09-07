import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalConversation, canonicalPrincipal } from './canonical.js'
import { deliverySchemaVersion } from './sqlite.js'
import type { ConversationBinding, DeliveryPrincipal, ExternalPrincipalKey } from './types.js'

export interface ActiveWebOwnerBindingQuery {
  databasePath: string
  sessionId: string
  expectedPrincipal: ExternalPrincipalKey
  workspace: string
  agentPreset: string
}

export interface ActiveWebOwnerBindingSnapshot {
  readonly binding: Readonly<ConversationBinding>
  readonly owner: Readonly<DeliveryPrincipal>
}

export type ActiveWebOwnerBindingInspection =
  | Readonly<{ status: 'matched'; snapshot: ActiveWebOwnerBindingSnapshot }>
  | Readonly<{ status: 'unavailable' | 'mismatch' | 'busy' }>

type Row = {
  binding_id: string; conversation_json: string; binding_principal_json: string; workspace: string; agent_preset: string
  session_id: string; generation: number; policy_ref: string; binding_status: string; binding_created_at: number; binding_updated_at: number; binding_version: number
  owner_id: string; owner_principal_json: string; owner_role: string; owner_status: string; linked_to_id: string | null; owner_created_at: number; owner_updated_at: number; owner_version: number
  lease_state: string | null
}

function unavailable(): ActiveWebOwnerBindingInspection { return Object.freeze({ status: 'unavailable' }) }
function mismatch(): ActiveWebOwnerBindingInspection { return Object.freeze({ status: 'mismatch' }) }
function policyRef(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC').trim() && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 256 && ![...value].some(character => (character.codePointAt(0) ?? 0) <= 0x1f || character.codePointAt(0) === 0x7f)
}
function privateDatabase(path: string): string | undefined {
  try {
    if (!isAbsolute(path)) return undefined
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) return undefined
    const parent = realpathSync(dirname(path)); const resolved = realpathSync(path)
    if (resolved !== join(parent, basename(path))) return undefined
    const directory = statSync(parent)
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) return undefined
    return resolved
  } catch { return undefined }
}
function number(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function identifier(value: unknown, prefix: string): value is string { return typeof value === 'string' && new RegExp(`^${prefix}[0-9a-f-]{8,}$`, 'u').test(value) }

/**
 * Opens an already-existing Delivery database read-only. It never invokes the Delivery migrator,
 * creates a database, pairs an owner, reads message content, or acquires a Session lease.
 */
export function inspectActiveWebOwnerBindingLocally(input: ActiveWebOwnerBindingQuery): ActiveWebOwnerBindingInspection {
  let expected: ExternalPrincipalKey
  try {
    expected = canonicalPrincipal(input.expectedPrincipal)
    if (expected.channel !== 'web' || !isAbsolute(input.workspace) || typeof input.agentPreset !== 'string' || input.agentPreset.length === 0 || typeof input.sessionId !== 'string' || input.sessionId.length === 0) return mismatch()
  } catch { return mismatch() }
  const path = privateDatabase(input.databasePath)
  if (path === undefined) return unavailable()
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100')
    database.exec('BEGIN')
    const version = database.prepare('PRAGMA user_version').get() as { user_version?: unknown }
    if (version.user_version !== deliverySchemaVersion) return unavailable()
    const rows = database.prepare(`
      SELECT binding.id AS binding_id, binding.conversation_json, binding.principal_json AS binding_principal_json,
        binding.workspace, binding.agent_preset, binding.session_id, binding.generation, binding.policy_ref,
        binding.status AS binding_status, binding.created_at AS binding_created_at, binding.updated_at AS binding_updated_at, binding.version AS binding_version,
        owner.id AS owner_id, owner.principal_json AS owner_principal_json, owner.role AS owner_role, owner.status AS owner_status,
        owner.linked_to_id, owner.created_at AS owner_created_at, owner.updated_at AS owner_updated_at, owner.version AS owner_version,
        lease.state AS lease_state
      FROM conversation_bindings AS binding
      JOIN delivery_principals AS owner ON owner.id = binding.principal_id
      LEFT JOIN delivery_session_leases AS lease ON lease.session_id = binding.session_id
      WHERE binding.session_id = ?
      LIMIT 2
    `).all(input.sessionId) as Row[]
    if (rows.length !== 1) return mismatch()
    const row = rows[0]!
    if (row.lease_state !== null && row.lease_state !== 'released') return Object.freeze({ status: 'busy' })
    const conversation = canonicalConversation(JSON.parse(row.conversation_json))
    const bindingPrincipal = canonicalPrincipal(JSON.parse(row.binding_principal_json))
    const ownerPrincipal = canonicalPrincipal(JSON.parse(row.owner_principal_json))
    const expectedConversation = { channel: 'web', account: expected.account, tenant: expected.tenant, kind: 'dm' as const, chat: input.sessionId }
    if (row.conversation_json !== JSON.stringify(conversation) || row.binding_principal_json !== JSON.stringify(bindingPrincipal) || row.owner_principal_json !== JSON.stringify(ownerPrincipal)
      || !equal(conversation, expectedConversation) || row.session_id !== input.sessionId || !identifier(row.binding_id, 'binding_') || !identifier(row.owner_id, 'principal_')
      || bindingPrincipal.channel !== 'web' || !equal(bindingPrincipal, expected) || !equal(ownerPrincipal, expected)
      || row.binding_status !== 'active' || row.owner_role !== 'owner' || row.owner_status !== 'active' || row.linked_to_id !== null
      || row.workspace !== input.workspace || row.agent_preset !== input.agentPreset || !policyRef(row.policy_ref)
      || ![row.generation, row.binding_version, row.owner_version].every(value => number(value, 1))
      || ![row.binding_created_at, row.binding_updated_at, row.owner_created_at, row.owner_updated_at].every(value => number(value))) return mismatch()
    const binding: ConversationBinding = Object.freeze({ id: row.binding_id, conversation: Object.freeze(conversation), principal: Object.freeze(bindingPrincipal), workspace: row.workspace,
      agentPreset: row.agent_preset, sessionId: row.session_id, generation: row.generation, policyRef: row.policy_ref, status: 'active', createdAt: row.binding_created_at, updatedAt: row.binding_updated_at, version: row.binding_version })
    const owner: DeliveryPrincipal = Object.freeze({ id: row.owner_id, principal: Object.freeze(ownerPrincipal), role: 'owner', status: 'active', createdAt: row.owner_created_at, updatedAt: row.owner_updated_at, version: row.owner_version })
    return Object.freeze({ status: 'matched', snapshot: Object.freeze({ binding, owner }) })
  } catch (error) {
    if (error instanceof Error && /(?:busy|locked)/iu.test(error.message)) return Object.freeze({ status: 'busy' })
    return unavailable()
  } finally {
    try { database?.exec('ROLLBACK') } catch {}
    try { database?.close() } catch {}
  }
}
