import { isAbsolute } from 'node:path'
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'

export interface ManagedProfileMaterializationInput {
  profilePatch: string
  effectiveProfile: string
}

interface ManagedProfileRows {
  document: Document
  rows: YAMLSeq
}

const PERSONAL_ASSISTANT_ROW = 'dsh-enhanced-personal-assistant'
const PERSONAL_ASSISTANT_PACKAGE = '@dsh-enhanced/personal-assistant'
const ASSISTANT_DELIVERY_ROW = 'dsh-enhanced-assistant-delivery'
const ASSISTANT_DELIVERY_PACKAGE = '@dsh-enhanced/assistant-delivery'
const LARK_CHANNEL_ROW = 'dsh-enhanced-lark-channel'
const LARK_CHANNEL_PACKAGE = '@dsh-enhanced/lark-channel'
const CREDENTIALS_KEYCHAIN_ROW = 'dsh-enhanced-credentials-keychain'
const CREDENTIALS_KEYCHAIN_PACKAGE = '@dsh-enhanced/credentials-keychain'
const presetIdPattern = /^[a-z0-9][a-z0-9-]*$/u
const dshHomeWorkspacePattern = /^dshHomePath\((['"])assistant-workspace\1\)$/u

function parseProfileRows(source: string, label: string): ManagedProfileRows {
  const document = parseDocument(source)
  if (document.errors.length > 0) {
    throw new Error(`lark-channel setup: ${label} is invalid YAML: ${document.errors[0]?.message}`)
  }
  if (!isSeq(document.contents)) {
    throw new Error(`lark-channel setup: ${label} must be a YAML sequence`)
  }
  return { document, rows: document.contents }
}

function findRow(rows: YAMLSeq, id: string): YAMLMap | undefined {
  return rows.items.find(item => isMap(item) && item.get('id') === id) as YAMLMap | undefined
}

function validateReservedRow(rows: YAMLSeq, id: string, packageName: string): YAMLMap | undefined {
  const matches = rows.items.filter(item => isMap(item) && item.get('id') === id) as YAMLMap[]
  if (matches.length > 1) {
    throw new Error(`lark-channel setup: duplicate reserved row ${id}`)
  }
  const row = matches[0]
  if (row === undefined) return undefined
  const name = row.get('name')
  if (name !== undefined && name !== packageName) {
    throw new Error(`lark-channel setup: ${id} has a conflicting package name`)
  }
  const disabled = row.get('disabled')
  if (disabled !== undefined && disabled !== false) {
    throw new Error(`lark-channel setup: ${id} must not be disabled`)
  }
  return row
}

function validateRawReservedRows(rows: YAMLSeq): void {
  validateReservedRow(rows, PERSONAL_ASSISTANT_ROW, PERSONAL_ASSISTANT_PACKAGE)
  validateReservedRow(rows, ASSISTANT_DELIVERY_ROW, ASSISTANT_DELIVERY_PACKAGE)
  validateReservedRow(rows, LARK_CHANNEL_ROW, LARK_CHANNEL_PACKAGE)
  validateReservedRow(rows, CREDENTIALS_KEYCHAIN_ROW, CREDENTIALS_KEYCHAIN_PACKAGE)
}

/** Validates every setup-reserved raw override before semantic materialization. */
export function assertRawManagedProfileIntegrity(profilePatch: string): void {
  validateRawReservedRows(parseProfileRows(profilePatch, 'profile patch').rows)
}

function requireMap(node: Node | null | undefined, label: string): YAMLMap {
  if (!isMap(node)) throw new Error(`lark-channel setup: ${label} must be a YAML mapping`)
  return node
}

function requireSequence(node: Node | null | undefined, label: string): YAMLSeq {
  if (!isSeq(node)) throw new Error(`lark-channel setup: ${label} must be a YAML sequence`)
  return node
}

function cloneMap(source: YAMLMap, label: string): YAMLMap {
  const cloned = source.clone()
  if (!isMap(cloned)) throw new Error(`lark-channel setup: failed to clone ${label}`)
  return cloned
}

function ensureRow(document: Document, rows: YAMLSeq, id: string): YAMLMap {
  const existing = findRow(rows, id)
  if (existing !== undefined) return existing
  const created = document.createNode({ id, config: {} })
  if (!isMap(created)) throw new Error('lark-channel setup: failed to create managed profile row')
  rows.flow = false
  rows.add(created)
  return created
}

function hasStringField(map: YAMLMap, key: string): boolean {
  const node = map.get(key, true) as Node | undefined
  return isScalar(node) && typeof node.value === 'string' && node.value.trim().length > 0
}

function hasRequiredPersonalConfig(row: YAMLMap): boolean {
  const config = row.get('config', true) as Node | undefined
  if (!isMap(config)) return false
  const policy = config.get('assistantPolicy', true) as Node | undefined
  const memory = config.get('personalMemory', true) as Node | undefined
  const wiki = config.get('personalWiki', true) as Node | undefined
  const automations = config.get('assistantAutomations', true) as Node | undefined
  return isMap(policy)
    && hasStringField(policy, 'databasePath')
    && isSeq(policy.get('rules', true) as Node | undefined)
    && isMap(memory)
    && hasStringField(memory, 'databasePath')
    && isMap(wiki)
    && hasStringField(wiki, 'vaultRoot')
    && hasStringField(wiki, 'databasePath')
    && isMap(automations)
    && hasStringField(automations, 'databasePath')
    && hasStringField(automations, 'runsPath')
}

function hasRequiredDeliveryConfig(row: YAMLMap): boolean {
  const config = row.get('config', true) as Node | undefined
  return isMap(config)
    && hasStringField(config, 'databasePath')
    && hasStringField(config, 'spoolPath')
    && hasStringField(config, 'defaultWorkspace')
    && hasStringField(config, 'defaultAgentPreset')
}

function rawOverrideNeedsMaterialization(rows: YAMLSeq): boolean {
  const personal = findRow(rows, PERSONAL_ASSISTANT_ROW)
  if (personal === undefined || !hasRequiredPersonalConfig(personal)) return true
  const delivery = findRow(rows, ASSISTANT_DELIVERY_ROW)
  return delivery === undefined || !hasRequiredDeliveryConfig(delivery)
}

function requireEffectiveRow(
  rows: YAMLSeq,
  id: string,
  packageName: string,
): YAMLMap {
  const row = validateReservedRow(rows, id, packageName)
  if (row === undefined || row.get('name') !== packageName) {
    throw new Error(
      `lark-channel setup: effective profile must mount ${packageName} as ${id}`,
    )
  }
  return row
}

function mergeConfigMaps(base: YAMLMap, override: YAMLMap, label: string): YAMLMap {
  const merged = cloneMap(base, label)
  for (const pair of override.items) {
    const key = isScalar(pair.key) && typeof pair.key.value === 'string'
      ? pair.key.value
      : undefined
    if (key === undefined) {
      throw new Error(`lark-channel setup: ${label} keys must be strings`)
    }
    const inherited = merged.get(key, true) as Node | undefined
    const explicit = pair.value as Node | null
    if (isMap(inherited) && isMap(explicit)) {
      merged.set(key, mergeConfigMaps(inherited, explicit, `${label}.${key}`))
    } else {
      merged.set(key, explicit === null ? null : explicit.clone())
    }
  }
  return merged
}

/**
 * An id-targeted Cordis row replaces its complete config mapping. Seed the
 * replacement from the composed row, then overlay every explicit user value
 * recursively so setup neither drops required sibling services nor rewrites a
 * user's custom policy, paths, limits, or provider choices.
 */
function materializeRowConfig(
  target: ManagedProfileRows,
  effectiveRows: YAMLSeq,
  id: string,
  packageName: string,
): YAMLMap {
  const targetRow = ensureRow(target.document, target.rows, id)
  const effectiveRow = requireEffectiveRow(effectiveRows, id, packageName)
  const effectiveConfig = requireMap(
    effectiveRow.get('config', true) as Node,
    `effective ${id} config`,
  )
  const explicitConfig = targetRow.get('config', true) as Node | undefined
  const materialized = explicitConfig === undefined
    ? cloneMap(effectiveConfig, `${id} config`)
    : mergeConfigMaps(
        effectiveConfig,
        requireMap(explicitConfig, `${id} config`),
        `${id} config`,
      )
  targetRow.set('config', materialized)
  return materialized
}

function materializePolicyConfig(
  target: ManagedProfileRows,
  effectiveRows: YAMLSeq,
): void {
  const config = materializeRowConfig(
    target,
    effectiveRows,
    PERSONAL_ASSISTANT_ROW,
    PERSONAL_ASSISTANT_PACKAGE,
  )
  const policy = requireMap(
    config.get('assistantPolicy', true) as Node,
    'assistantPolicy config',
  )
  if (!hasStringField(policy, 'databasePath')) {
    throw new Error('lark-channel setup: assistantPolicy databasePath is required')
  }
  requireSequence(policy.get('rules', true) as Node, 'assistantPolicy rules')
  const memory = requireMap(config.get('personalMemory', true) as Node, 'personalMemory config')
  if (!hasStringField(memory, 'databasePath')) {
    throw new Error('lark-channel setup: personalMemory databasePath is required')
  }
  const wiki = requireMap(config.get('personalWiki', true) as Node, 'personalWiki config')
  if (!hasStringField(wiki, 'vaultRoot') || !hasStringField(wiki, 'databasePath')) {
    throw new Error('lark-channel setup: personalWiki vaultRoot and databasePath are required')
  }
  const automations = requireMap(
    config.get('assistantAutomations', true) as Node,
    'assistantAutomations config',
  )
  if (!hasStringField(automations, 'databasePath') || !hasStringField(automations, 'runsPath')) {
    throw new Error('lark-channel setup: assistantAutomations databasePath and runsPath are required')
  }
}

function materializeDeliveryConfig(
  target: ManagedProfileRows,
  effectiveRows: YAMLSeq,
): void {
  const config = materializeRowConfig(
    target,
    effectiveRows,
    ASSISTANT_DELIVERY_ROW,
    ASSISTANT_DELIVERY_PACKAGE,
  )
  const workspace = config.get('defaultWorkspace', true) as Node | undefined
  const preset = config.get('defaultAgentPreset', true) as Node | undefined
  if (!hasStringField(config, 'databasePath') || !hasStringField(config, 'spoolPath')) {
    throw new Error('lark-channel setup: effective Delivery databasePath and spoolPath are required')
  }
  if (!isScalar(workspace)
    || typeof workspace.value !== 'string'
    || (!isAbsolute(workspace.value) && !dshHomeWorkspacePattern.test(workspace.value))) {
    throw new Error('lark-channel setup: effective Delivery workspace must be an absolute path')
  }
  if (!isScalar(preset) || typeof preset.value !== 'string' || !presetIdPattern.test(preset.value)) {
    throw new Error('lark-channel setup: effective Delivery Agent preset is invalid')
  }
}

/**
 * Materializes only the two managed row configs. Cordis replaces an
 * id-targeted config mapping, so cloning each complete composed config is the
 * minimum safe override: it retains required siblings and unrelated rules
 * while setup changes only its own policy rules and Delivery identity.
 */
export function materializeManagedProfileOverride(input: ManagedProfileMaterializationInput): string {
  const target = parseProfileRows(input.profilePatch, 'profile patch')
  validateRawReservedRows(target.rows)
  if (!rawOverrideNeedsMaterialization(target.rows)) return input.profilePatch
  const effective = parseProfileRows(input.effectiveProfile, 'effective profile')
  materializePolicyConfig(target, effective.rows)
  materializeDeliveryConfig(target, effective.rows)
  return target.document.toString({ lineWidth: 0 })
}

export function managedProfileOverrideNeedsMaterialization(profilePatch: string): boolean {
  const target = parseProfileRows(profilePatch, 'profile patch')
  validateRawReservedRows(target.rows)
  return rawOverrideNeedsMaterialization(target.rows)
}
