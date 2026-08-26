import { createHash } from 'node:crypto'
import { isAbsolute, join, win32 } from 'node:path'
import { externalPrincipalId } from '@dsh-enhanced/assistant-delivery'
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

export interface LarkProfileSetupInput {
  profilePatch: string
  dshHome: string
  appId: string
  account: string
  tenant: string
  domain: 'feishu' | 'lark'
  ownerUserId: string
  keychainService: string
  keychainAccount: string
  credentialProvider?: 'linux-secret-service' | 'macos-keychain' | 'windows-dpapi'
  credentialPath?: string
  agentTools?: 'disable' | 'enable' | 'preserve'
}

export interface LarkAgentPolicyRefreshInput {
  profilePatch: string
  dshHome: string
  account?: string
  agentTools: 'disable' | 'enable'
}

const setupKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const providerKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
const presetIdPattern = /^[a-z0-9][a-z0-9-]*$/u
// The grant is expressed as one wildcard allow rather than an enumerated
// allowlist. Tools are registered dynamically by whichever plugins and skills a
// deployment mounts, so any name list is stale the moment a new tool appears:
// the agent then reports a refusal the owner cannot fix from the chat, and every
// addition needs a setup release. Risk is already judged by behaviour in
// `assistant-policy`'s `tools/pre-execute` reviewer, which inspects arguments and
// still routes writes, network access and dangerous commands to approval, so this
// rule decides reachability, not privilege.
//
// Delivery keeps its rule bound to the exact preset, absolute workspace and
// `external` initiator. The local Web foreground grant deliberately accepts
// every preset/workspace because both are user-selectable and can change
// independently; it still applies only to human foreground Agent operations.
const TOOL_WILDCARD = '*'
const FOREGROUND_CAPABILITY_RULE_ID = `dsh-enhanced-foreground-capability-${TOOL_WILDCARD}`

// No capability is denied at this setup layer. Explicit Policy denies retain
// precedence over the wildcard grants, while tool execution additionally stays
// behind the session sandbox/reviewer and parameter-risk gates.
//
// Populating this list again re-denies those ids: Policy resolves `deny` ahead
// of `allow` at any specificity, so entries here override the wildcard.
const deniedExternalTools: readonly string[] = []

// Per-tool ids emitted by earlier releases: first the enumerated allowlist, then
// the denylist that replaced it. Removal must still recognise both. A stale
// allow rule is one `--agent-tools disable` can no longer revoke, and a stale
// deny rule keeps overriding the wildcard and blocking the tool it names.
const retiredToolRuleIds = [
  'bash', 'pwsh', 'read', 'glob', 'grep', 'skill',
  'memory_search', 'wiki_search', 'wiki_read',
  'memory_manage', 'wiki_upsert', 'wiki_lint',
  'automation_create', 'automation_manage', 'automation_run',
  'evolution_propose', 'knowledge_pin', 'knowledge_promote',
  'heartbeat_scratch_update',
] as const

const managedToolRuleSuffixes = [
  TOOL_WILDCARD, ...deniedExternalTools, ...retiredToolRuleIds,
] as const
const managedApprovalSources = [
  'dsh-enhanced-personal-memory',
  'dsh-enhanced-personal-wiki',
  'dsh-enhanced-assistant-automations',
  'dsh-enhanced-assistant-evolution',
] as const
const managedProfileRows = [
  { id: 'dsh-enhanced-lark-channel', packageName: '@dsh-enhanced/lark-channel' },
  { id: 'dsh-enhanced-credentials-keychain', packageName: '@dsh-enhanced/credentials-keychain' },
] as const

interface AgentIdentity {
  preset: string
  workspace: string
}

interface ManagedRuleId {
  kind: 'capability' | 'reply' | 'tool'
  account: string
  tool?: string
  legacySuffix?: string
}

interface ManagedFixedRuleId {
  kind: 'approval' | 'credential' | 'ingress'
  account: string
  sourceId?: typeof managedApprovalSources[number]
}

function requireSetupKey(value: string, field: string): string {
  const normalized = value.trim()
  if (!setupKeyPattern.test(normalized)) throw new Error(`lark-channel setup: invalid ${field}`)
  return normalized
}

function requireAccount(value: string): string {
  const account = requireSetupKey(value, 'account')
  if (account.includes('-legacy-')) {
    throw new Error('lark-channel setup: invalid account (reserved "-legacy-" segment)')
  }
  return account
}

function requireProviderKey(value: string, field: string): string {
  const normalized = value.trim()
  if (!providerKeyPattern.test(normalized)) throw new Error(`lark-channel setup: invalid ${field}`)
  return normalized
}

function asMap(node: Node | null | undefined, label: string): YAMLMap {
  if (!isMap(node)) throw new Error(`lark-channel setup: ${label} must be a YAML mapping`)
  return node
}

function asSequence(node: Node | null | undefined, label: string): YAMLSeq {
  if (!isSeq(node)) throw new Error(`lark-channel setup: ${label} must be a YAML sequence`)
  return node
}

function findRow(rows: YAMLSeq, id: string): YAMLMap | undefined {
  return rows.items.find(item => isMap(item) && item.get('id') === id) as YAMLMap | undefined
}

function ensureRow(document: Document, rows: YAMLSeq, id: string): YAMLMap {
  const existing = findRow(rows, id)
  if (existing !== undefined) return existing
  const created = document.createNode({ id, config: {} })
  if (!isMap(created)) throw new Error('lark-channel setup: failed to create profile row')
  rows.add(created)
  return created
}

function assertManagedProfileRowIntegrity(rows: YAMLSeq): void {
  for (const expected of managedProfileRows) {
    const matches = rows.items.filter(item => isMap(item) && item.get('id') === expected.id) as YAMLMap[]
    if (matches.length > 1) {
      throw new Error(
        `lark-channel setup: managed profile row ${expected.id} is duplicated; refusing to change it`,
      )
    }
    const row = matches[0]
    if (row === undefined) continue
    const name = row.get('name', true) as Node | undefined
    const disabled = row.get('disabled', true) as Node | undefined
    if (name !== undefined && (!isScalar(name) || name.value !== expected.packageName)) {
      throw new Error(
        `lark-channel setup: managed profile row ${expected.id} is shadowed by an invalid package`,
      )
    }
    if (disabled !== undefined && (!isScalar(disabled) || disabled.value !== false)) {
      throw new Error(
        `lark-channel setup: managed profile row ${expected.id} is disabled or invalid`,
      )
    }
  }
}

function upsertById(document: Document, values: YAMLSeq, value: Record<string, unknown>): void {
  const node = document.createNode(value)
  const id = value.id
  const index = values.items.findIndex(item => isMap(item) && item.get('id') === id)
  if (index === -1) values.add(node)
  else values.items[index] = node
}

function isLiteralAbsolutePath(value: unknown): value is string {
  return typeof value === 'string'
    && (isAbsolute(value) || win32.isAbsolute(value))
    && !value.includes('*')
    && !value.includes('\0')
}

function sequenceEquals(node: Node | null | undefined, expected: readonly string[]): boolean {
  if (!isSeq(node) || node.items.length !== expected.length) return false
  return node.items.every((item, index) => isScalar(item) && item.value === expected[index])
}

function sequenceIncludes(node: Node | null | undefined, expected: string): boolean {
  return isSeq(node) && node.items.some(item => isScalar(item) && item.value === expected)
}

function managedReplyIdentities(rules: YAMLSeq, account: string): AgentIdentity[] {
  const identities = new Map<string, AgentIdentity>()
  for (const item of rules.items) {
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    if (managedId?.kind !== 'reply' || managedId.account !== account) continue
    const identity = managedExternalRuleIdentity(item, managedId)
    if (identity === undefined) {
      throw new Error(`lark-channel setup: managed reply rule ${String(id)} is invalid`)
    }
    identities.set(`${identity.preset}\0${identity.workspace}`, identity)
  }
  return [...identities.values()]
}

function legacyIdentitySuffix(identity: AgentIdentity): string {
  const digest = createHash('sha256')
    .update(identity.preset)
    .update('\0')
    .update(identity.workspace)
    .digest('hex')
    .slice(0, 16)
  return `-legacy-${identity.preset}-${digest}`
}

function configuredAgentIdentity(rows: YAMLSeq, dshHome: string): { preset: string; workspace: string } {
  const delivery = findRow(rows, 'dsh-enhanced-assistant-delivery')
  if (delivery === undefined) {
    throw new Error('lark-channel setup: dsh-enhanced-assistant-delivery profile row is required')
  }
  const config = asMap(delivery.get('config', true) as Node, 'assistant-delivery config')
  const preset = config.get('defaultAgentPreset')
  if (typeof preset !== 'string' || !presetIdPattern.test(preset)) {
    throw new Error('lark-channel setup: assistant-delivery defaultAgentPreset is invalid')
  }
  const configuredWorkspace = config.get('defaultWorkspace')
  const defaultExpression = /^dshHomePath\((['"])assistant-workspace\1\)$/u
  const defaultWorkspace = !isAbsolute(dshHome) && win32.isAbsolute(dshHome)
    ? win32.join(dshHome, 'assistant-workspace')
    : join(dshHome, 'assistant-workspace')
  const workspace = typeof configuredWorkspace === 'string' && defaultExpression.test(configuredWorkspace)
    ? defaultWorkspace
    : configuredWorkspace
  if (!isLiteralAbsolutePath(workspace)) {
    throw new Error('lark-channel setup: assistant-delivery defaultWorkspace is invalid')
  }
  return { preset, workspace }
}

function upsertExternalReplyRule(
  document: Document,
  rules: YAMLSeq,
  input: { account: string; identity: AgentIdentity; principal: string; legacy?: boolean },
): void {
  const suffix = input.legacy ? legacyIdentitySuffix(input.identity) : ''
  upsertById(document, rules, {
    id: `lark-owner-reply-${input.account}${suffix}`,
    effect: 'allow',
    subject: {
      kind: 'agent',
      id: input.identity.preset,
      workspace: input.identity.workspace,
      principal: input.principal,
    },
    actions: ['reply'],
    resource: { kind: 'message', id: '*' },
    context: { initiators: ['external'] },
  })
}

function upsertExternalToolRules(
  document: Document,
  rules: YAMLSeq,
  input: { account: string; identity: AgentIdentity; principal: string; legacy?: boolean },
): void {
  const suffix = input.legacy ? legacyIdentitySuffix(input.identity) : ''
  const subject = {
    kind: 'agent',
    id: input.identity.preset,
    workspace: input.identity.workspace,
    principal: input.principal,
  }
  // Tool reachability alone is insufficient for plugin tools whose service
  // performs a second Policy check (memory.search, wiki.read, automation
  // propose, and future domains). Keep the Agent identity exact, but allow its
  // full external capability plane; tools/pre-execute and every explicit deny
  // still run before/inside the operation.
  upsertById(document, rules, {
    id: `lark-owner-capability-${TOOL_WILDCARD}-${input.account}${suffix}`,
    effect: 'allow',
    subject,
    actions: [TOOL_WILDCARD],
    resource: { kind: TOOL_WILDCARD, id: TOOL_WILDCARD },
    context: { initiators: ['external'] },
  })
  // One reachability grant for every tool the mounted preset exposes.
  upsertById(document, rules, {
    id: `lark-owner-tool-${TOOL_WILDCARD}-${input.account}${suffix}`,
    effect: 'allow',
    subject,
    actions: ['execute'],
    resource: { kind: 'tool', id: TOOL_WILDCARD },
    context: { initiators: ['external'] },
  })
  // Keep any explicitly configured denials after the broad reachability grant
  // so deny precedence remains obvious in the serialized policy.
  for (const tool of deniedExternalTools) {
    upsertById(document, rules, {
      id: `lark-owner-tool-${tool}-${input.account}${suffix}`,
      effect: 'deny',
      subject,
      actions: ['execute'],
      resource: { kind: 'tool', id: tool },
      context: { initiators: ['external'] },
    })
  }
}

function upsertForegroundCapabilityRule(document: Document, rules: YAMLSeq): void {
  upsertById(document, rules, {
    id: FOREGROUND_CAPABILITY_RULE_ID,
    effect: 'allow',
    subject: { kind: 'agent', id: TOOL_WILDCARD, workspace: TOOL_WILDCARD },
    actions: [TOOL_WILDCARD],
    resource: { kind: TOOL_WILDCARD, id: TOOL_WILDCARD },
    context: { initiators: ['foreground'] },
  })
}

function isManagedForegroundRuleId(id: string): boolean {
  return id === FOREGROUND_CAPABILITY_RULE_ID
    // Migrate account-scoped ids written before the foreground grant was
    // separated from Lark onboarding. They all represented this same local
    // capability and are safe to collapse into one idempotent rule.
    || id.startsWith('lark-foreground-capability-')
    || id.startsWith('lark-foreground-tool-')
}

function isReservedForegroundRuleId(id: string): boolean {
  return id.startsWith('dsh-enhanced-foreground-capability-')
    || id.startsWith('lark-foreground-capability-')
    || id.startsWith('lark-foreground-tool-')
}

function isUnrestrictedForegroundAllow(item: YAMLMap): boolean {
  const subject = item.get('subject', true) as Node | undefined
  const resource = item.get('resource', true) as Node | undefined
  const context = item.get('context', true) as Node | undefined
  return item.get('effect') === 'allow'
    && isMap(subject)
    && subject.get('kind') === 'agent'
    && subject.get('id') === TOOL_WILDCARD
    && subject.get('workspace') === TOOL_WILDCARD
    // Rebuilding a principal-restricted foreground rule without the principal
    // would widen it, even when its remaining wildcard shape is unchanged.
    && subject.get('principal') === undefined
    && sequenceEquals(item.get('actions', true) as Node | undefined, [TOOL_WILDCARD])
    && isMap(resource)
    && resource.get('kind') === TOOL_WILDCARD
    && resource.get('id') === TOOL_WILDCARD
    && isMap(context)
    && sequenceEquals(context.get('initiators', true) as Node | undefined, ['foreground'])
}

function isSafeRestrictiveForegroundRule(item: YAMLMap): boolean {
  if (item.get('effect') === 'deny') return true
  if (item.get('effect') !== 'allow') return false
  const subject = item.get('subject', true) as Node | undefined
  const context = item.get('context', true) as Node | undefined
  if (!isMap(subject) || subject.get('kind') !== 'agent' || !isMap(context)
    || !sequenceEquals(context.get('initiators', true) as Node | undefined, ['foreground'])) {
    return false
  }
  const principal = subject.get('principal')
  // A literal principal narrows the local rule. A glob is still setup-wide
  // authority and is not accepted as a hand-edited restriction.
  return principal === undefined
    || (typeof principal === 'string' && !principal.includes(TOOL_WILDCARD))
}

function assertManagedForegroundRuleIntegrity(rules: YAMLSeq): void {
  const seenIds = new Set<string>()
  for (const item of rules.items) {
    if (!isMap(item)) continue
    const id = item.get('id')
    if (typeof id !== 'string' || !isReservedForegroundRuleId(id)) continue
    if (seenIds.has(id)) {
      throw new Error(`lark-channel setup: duplicate managed foreground rule ${id}; refusing to change it`)
    }
    seenIds.add(id)
    if (isManagedForegroundRuleId(id)
      && (isUnrestrictedForegroundAllow(item) || isSafeRestrictiveForegroundRule(item))) continue
    throw new Error(
      `lark-channel setup: managed foreground rule ${id} is unsafe or malformed; refusing to change Agent policy`,
    )
  }
}

function hasManagedForegroundRules(rules: YAMLSeq): boolean {
  const managed = rules.items.filter(item => isMap(item)
    && typeof item.get('id') === 'string'
    && isManagedForegroundRuleId(item.get('id') as string)) as YAMLMap[]
  return managed.length > 0 && managed.every(isUnrestrictedForegroundAllow)
}

function removeManagedForegroundRules(rules: YAMLSeq, includeDenies = false): void {
  for (let index = rules.items.length - 1; index >= 0; index -= 1) {
    const item = rules.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    if (typeof id !== 'string' || !isManagedForegroundRuleId(id)) continue
    if (includeDenies && item.get('effect') === 'deny') {
      const context = item.get('context', true) as Node | undefined
      if (!isMap(context)
        || !sequenceEquals(context.get('initiators', true) as Node | undefined, ['foreground'])) {
        throw new Error(
          `lark-channel setup: managed foreground deny ${id} may protect external requests; `
          + 'refusing to remove it while enabling Agent policy',
        )
      }
      rules.items.splice(index, 1)
      continue
    }
    // Disable may safely remove either the canonical allow or a local narrowed
    // allow, but preserves denies because deleting one could widen another
    // rule. Explicit enable deliberately retires those denies before rebuilding
    // the requested full-control grant.
    if (isUnrestrictedForegroundAllow(item)
      || (item.get('effect') === 'allow' && isSafeRestrictiveForegroundRule(item))) {
      rules.items.splice(index, 1)
    }
  }
}

function parseManagedAccountTail(tail: string): Pick<ManagedRuleId, 'account' | 'legacySuffix'> | undefined {
  const legacyIndex = tail.indexOf('-legacy-')
  const account = legacyIndex === -1 ? tail : tail.slice(0, legacyIndex)
  if (!setupKeyPattern.test(account) || account.includes('-legacy-')) return undefined
  if (legacyIndex === -1) return { account }
  const legacySuffix = tail.slice(legacyIndex)
  if (legacySuffix.length <= '-legacy-'.length) return undefined
  return { account, legacySuffix }
}

function parseManagedRuleId(id: string): ManagedRuleId | undefined {
  const replyPrefix = 'lark-owner-reply-'
  if (id.startsWith(replyPrefix)) {
    const tail = parseManagedAccountTail(id.slice(replyPrefix.length))
    return tail === undefined ? undefined : { kind: 'reply', ...tail }
  }

  const capabilityPrefix = `lark-owner-capability-${TOOL_WILDCARD}-`
  if (id.startsWith(capabilityPrefix)) {
    const tail = parseManagedAccountTail(id.slice(capabilityPrefix.length))
    return tail === undefined ? undefined : { kind: 'capability', ...tail }
  }

  for (const tool of managedToolRuleSuffixes) {
    const toolPrefix = `lark-owner-tool-${tool}-`
    if (!id.startsWith(toolPrefix)) continue
    const tail = parseManagedAccountTail(id.slice(toolPrefix.length))
    return tail === undefined ? undefined : { kind: 'tool', tool, ...tail }
  }
  return undefined
}

function isReservedManagedExternalRuleId(id: string): boolean {
  return id.startsWith('lark-owner-reply-')
    || id.startsWith('lark-owner-capability-')
    || id.startsWith('lark-owner-tool-')
}

function managedExternalRuleIdentity(
  item: YAMLMap,
  managedId: ManagedRuleId,
): AgentIdentity | undefined {
  const subject = item.get('subject', true) as Node | undefined
  const resource = item.get('resource', true) as Node | undefined
  const context = item.get('context', true) as Node | undefined
  if (!isMap(subject) || !isMap(resource) || !isMap(context)
    || subject.get('kind') !== 'agent'
    || typeof subject.get('id') !== 'string'
    || !presetIdPattern.test(subject.get('id') as string)
    || !isLiteralAbsolutePath(subject.get('workspace'))
    || !sequenceEquals(context.get('initiators', true) as Node | undefined, ['external'])) return undefined
  const identity = {
    preset: subject.get('id') as string,
    workspace: subject.get('workspace') as string,
  }
  if (managedId.legacySuffix !== undefined
    && managedId.legacySuffix !== legacyIdentitySuffix(identity)) return undefined
  const principal = subject.get('principal')
  if (principal !== undefined && !isCanonicalLarkPrincipalForAccount(principal, managedId.account)) {
    return undefined
  }

  if (managedId.kind === 'reply') {
    return item.get('effect') === 'allow'
      && sequenceEquals(item.get('actions', true) as Node | undefined, ['reply'])
      && resource.get('kind') === 'message'
      && resource.get('id') === TOOL_WILDCARD
      ? identity
      : undefined
  }
  if (managedId.kind === 'tool') {
    return (item.get('effect') === 'allow' || item.get('effect') === 'deny')
      && sequenceEquals(item.get('actions', true) as Node | undefined, ['execute'])
      && resource.get('kind') === 'tool'
      // One retired release changed only the rule id while retaining the old
      // wildcard resource. Treat that exact Agent/execute/tool shape as ours
      // too, so upgrades can still revoke it.
      && (resource.get('id') === managedId.tool
        || (managedId.tool !== TOOL_WILDCARD && resource.get('id') === TOOL_WILDCARD))
      ? identity
      : undefined
  }
  return (item.get('effect') === 'allow' || item.get('effect') === 'deny')
    && sequenceEquals(item.get('actions', true) as Node | undefined, [TOOL_WILDCARD])
    && resource.get('kind') === TOOL_WILDCARD
    && resource.get('id') === TOOL_WILDCARD
    ? identity
    : undefined
}

function assertManagedExternalRuleIntegrity(
  rules: YAMLSeq,
): void {
  const seenIds = new Set<string>()
  for (const item of rules.items) {
    if (!isMap(item)) continue
    const id = item.get('id')
    // These ids are setup-reserved. Exact current and explicit legacy shapes
    // are accepted by the strict recognizer above; every other mutation is
    // ambiguous and fails closed, regardless of which privilege plane it was
    // changed to. User policy must use a non-reserved id.
    if (typeof id !== 'string' || !isReservedManagedExternalRuleId(id)) continue
    if (seenIds.has(id)) {
      throw new Error(`lark-channel setup: duplicate managed Agent rule ${id}; refusing to change it`)
    }
    seenIds.add(id)
    const managedId = parseManagedRuleId(id)
    if (managedId !== undefined && managedExternalRuleIdentity(item, managedId) !== undefined) continue
    throw new Error(
      `lark-channel setup: reserved managed Agent rule ${id} is malformed; refusing to change Agent policy`,
    )
  }
}

function isCanonicalLarkPrincipalForAccount(value: unknown, account: string): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return parts.length === 4
    && parts[0] === 'lark'
    && parts[1] === encodeURIComponent(account)
    && isCanonicalPrincipalComponent(parts[2], setupKeyPattern)
    && isCanonicalPrincipalComponent(parts[3], providerKeyPattern)
}

function isCanonicalPrincipalComponent(value: string | undefined, pattern: RegExp): boolean {
  if (value === undefined || value === '' || value.includes(TOOL_WILDCARD)) return false
  try {
    const decoded = decodeURIComponent(value)
    return pattern.test(decoded) && encodeURIComponent(decoded) === value
  } catch {
    return false
  }
}

function parseManagedFixedRuleId(id: string): ManagedFixedRuleId | undefined {
  const fixedPrefixes = [
    { prefix: 'lark-channel-credential-', kind: 'credential' },
    { prefix: 'lark-owner-ingress-', kind: 'ingress' },
  ] as const
  for (const candidate of fixedPrefixes) {
    if (!id.startsWith(candidate.prefix)) continue
    const account = id.slice(candidate.prefix.length)
    if (!setupKeyPattern.test(account) || account.includes('-legacy-')) return undefined
    return { kind: candidate.kind, account }
  }
  for (const sourceId of managedApprovalSources) {
    const prefix = `lark-owner-approval-${sourceId}-`
    if (!id.startsWith(prefix)) continue
    const account = id.slice(prefix.length)
    if (!setupKeyPattern.test(account) || account.includes('-legacy-')) return undefined
    return { kind: 'approval', account, sourceId }
  }
  return undefined
}

function isReservedManagedFixedRuleId(id: string): boolean {
  return id.startsWith('lark-channel-credential-')
    || id.startsWith('lark-owner-ingress-')
    || id.startsWith('lark-owner-approval-')
}

function managedFixedRuleMatches(item: YAMLMap, managedId: ManagedFixedRuleId): boolean {
  const subject = item.get('subject', true) as Node | undefined
  const resource = item.get('resource', true) as Node | undefined
  const context = item.get('context', true) as Node | undefined
  if (item.get('effect') !== 'allow' || !isMap(subject) || !isMap(resource) || !isMap(context)) {
    return false
  }
  if (managedId.kind === 'credential') {
    return subject.get('kind') === 'background'
      && subject.get('id') === 'dsh-enhanced-lark-channel'
      && sequenceEquals(item.get('actions', true) as Node | undefined, ['credential.use'])
      && resource.get('kind') === 'credential'
      && resource.get('id') === `lark-app-secret-${managedId.account}`
      && sequenceEquals(context.get('initiators', true) as Node | undefined, ['background'])
  }
  if (managedId.kind === 'ingress') {
    return subject.get('kind') === 'external'
      && isCanonicalLarkPrincipalForAccount(subject.get('id'), managedId.account)
      && sequenceEquals(
        item.get('actions', true) as Node | undefined,
        ['approval.decide', 'ingest'],
      )
      && resource.get('kind') === 'message'
      && resource.get('id') === TOOL_WILDCARD
      && sequenceEquals(context.get('initiators', true) as Node | undefined, ['external'])
  }
  const principal = subject.get('principal')
  return subject.get('kind') === 'background'
    && subject.get('id') === managedId.sourceId
    && isLiteralAbsolutePath(subject.get('workspace'))
    // Principal-scoped approvals are current, while exact legacy approvals
    // without a principal are still attributable to setup by the remaining
    // source/action/resource/context tuple.
    && (principal === undefined || isCanonicalLarkPrincipalForAccount(principal, managedId.account))
    && sequenceEquals(item.get('actions', true) as Node | undefined, ['approval.send'])
    && resource.get('kind') === 'message'
    && resource.get('id') === TOOL_WILDCARD
    && sequenceEquals(context.get('initiators', true) as Node | undefined, ['background'])
}

function assertManagedFixedRuleIntegrity(
  rules: YAMLSeq,
  currentAccount: string | undefined,
): void {
  const seenIds = new Set<string>()
  for (const item of rules.items) {
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedFixedRuleId(id) : undefined
    if (typeof id !== 'string' || !isReservedManagedFixedRuleId(id)) continue
    if (seenIds.has(id)) {
      throw new Error(`lark-channel setup: duplicate managed fixed rule ${id}; refusing to change it`)
    }
    seenIds.add(id)
    if (managedId !== undefined && managedFixedRuleMatches(item, managedId)) continue
    const scope = managedId === undefined
      ? 'reserved fixed'
      : managedId.account === currentAccount ? 'fixed' : 'retired fixed'
    throw new Error(
      `lark-channel setup: ${scope} rule ${id} is malformed/ambiguous; refusing to change it`,
    )
  }
}

function sweepRetiredManagedFixedRules(
  rules: YAMLSeq,
  currentAccount: string | undefined,
): void {
  assertManagedFixedRuleIntegrity(rules, currentAccount)
  for (let index = rules.items.length - 1; index >= 0; index -= 1) {
    const item = rules.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedFixedRuleId(id) : undefined
    if (managedId !== undefined
      && managedId.account !== currentAccount
      && managedFixedRuleMatches(item, managedId)) rules.items.splice(index, 1)
  }
}

function parseManagedCredentialHandleId(id: string): string | undefined {
  const prefix = 'lark-app-secret-'
  if (!id.startsWith(prefix)) return undefined
  const account = id.slice(prefix.length)
  return setupKeyPattern.test(account) && !account.includes('-legacy-') ? account : undefined
}

function managedCredentialHandleMatches(item: YAMLMap): boolean {
  const provider = item.get('provider')
  const commonShape = sequenceEquals(
    item.get('consumers', true) as Node | undefined,
    ['dsh-enhanced-lark-channel'],
  )
    && sequenceEquals(item.get('purposes', true) as Node | undefined, ['connect'])
    && item.get('maxLeaseMs') === 86_400_000
  if (!commonShape) return false
  if (provider === 'windows-dpapi') return isLiteralAbsolutePath(item.get('path'))
  return (provider === 'linux-secret-service' || provider === 'macos-keychain')
    && typeof item.get('service') === 'string'
    && typeof item.get('account') === 'string'
}

function sweepRetiredManagedCredentialHandles(
  rows: YAMLSeq,
  currentAccount: string | undefined,
): void {
  const credentialsRow = findRow(rows, 'dsh-enhanced-credentials-keychain')
  if (credentialsRow === undefined) return
  const credentials = asMap(credentialsRow.get('config', true) as Node, 'credentials-keychain config')
  const handles = credentials.get('handles', true) as Node | undefined
  if (handles === undefined) return
  const handleList = asSequence(handles, 'credentials-keychain handles')
  let foundCurrent = false
  for (let index = handleList.items.length - 1; index >= 0; index -= 1) {
    const item = handleList.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedAccount = typeof id === 'string' ? parseManagedCredentialHandleId(id) : undefined
    if (managedAccount === undefined) continue
    if (managedAccount === currentAccount) {
      if (foundCurrent) {
        throw new Error(
          `lark-channel setup: current credential handle ${id} is duplicate; refusing to overwrite it`,
        )
      }
      foundCurrent = true
      if (!managedCredentialHandleMatches(item)) {
        throw new Error(
          `lark-channel setup: current credential handle ${id} is ambiguous; refusing to overwrite it`,
        )
      }
      continue
    }
    if (managedCredentialHandleMatches(item)) {
      handleList.items.splice(index, 1)
      continue
    }
    if (sequenceIncludes(
      item.get('consumers', true) as Node | undefined,
      'dsh-enhanced-lark-channel',
    )) {
      throw new Error(
        `lark-channel setup: retired credential handle ${id} is ambiguous; refusing to remove it`,
      )
    }
  }
}

function hasManagedExternalWildcardAllow(
  rules: YAMLSeq,
  account: string,
  ownerPrincipal: string | undefined,
): boolean {
  if (ownerPrincipal === undefined) return false
  const wildcardKinds = new Map<string, Set<ManagedRuleId['kind']>>()
  let foundCandidate = false
  for (const item of rules.items) {
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    if (managedId === undefined
      || managedId.account !== account
      || managedId.kind === 'reply') continue
    foundCandidate = true
    const identity = managedExternalRuleIdentity(item, managedId)
    const subject = item.get('subject', true) as Node | undefined
    if (identity === undefined
      || item.get('effect') !== 'allow'
      || !isMap(subject)
      || (subject.get('principal') !== undefined && subject.get('principal') !== ownerPrincipal)) {
      return false
    }
    const isWildcard = managedId.kind === 'capability'
      || (managedId.kind === 'tool' && managedId.tool === TOOL_WILDCARD)
    if (!isWildcard) continue
    const identityKey = `${identity.preset}\0${identity.workspace}`
    const kinds = wildcardKinds.get(identityKey) ?? new Set<ManagedRuleId['kind']>()
    if (kinds.has(managedId.kind)) return false
    kinds.add(managedId.kind)
    wildcardKinds.set(identityKey, kinds)
  }
  if (!foundCandidate || wildcardKinds.size === 0) return false
  // Earlier setup versions paired the wildcard allow with managed per-tool
  // denies. Rebuilding only the allow for a new account would silently widen
  // that historical policy, so preserve mode fails closed whenever any
  // setup-managed rule for the source account is restrictive or malformed.
  return [...wildcardKinds.values()].every(kinds =>
    kinds.has('capability') && kinds.has('tool'))
}

function scopeManagedExternalAllowsToOwner(
  rules: YAMLSeq,
  account: string,
  ownerPrincipal: string,
): void {
  for (const item of rules.items) {
    if (!isMap(item) || item.get('effect') !== 'allow') continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    if (managedId === undefined || managedId.account !== account) continue
    const subject = item.get('subject', true) as Node | undefined
    // Integrity validation runs first, so a setup-reserved rule reaching this
    // branch always has the strict Agent subject shape.
    if (!isMap(subject)) {
      throw new Error(`lark-channel setup: managed Agent rule ${id} is malformed`)
    }
    const rulePrincipal = subject.get('principal')
    if (rulePrincipal === undefined) {
      // Earlier releases emitted external allows without a principal. Narrow
      // them in place before preserve can retain the rule.
      subject.set('principal', ownerPrincipal)
      continue
    }
    if (rulePrincipal !== ownerPrincipal) {
      throw new Error(
        `lark-channel setup: managed Agent rule ${id} targets a different owner principal; `
        + 'refusing to preserve it',
      )
    }
  }
}

function hasManagedExternalRuleCandidate(rules: YAMLSeq, account: string): boolean {
  return rules.items.some(item => {
    if (!isMap(item)) return false
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    return managedId !== undefined
      && managedId.kind !== 'reply'
      && managedId.account === account
  })
}

function hasManagedExternalAllowCandidate(rules: YAMLSeq, account: string): boolean {
  return rules.items.some(item => {
    if (!isMap(item) || item.get('effect') !== 'allow') return false
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    return managedId !== undefined
      && managedId.kind !== 'reply'
      && managedId.account === account
  })
}

function removeAllManagedExternalToolRules(rules: YAMLSeq, includeDenies = false): void {
  for (let index = rules.items.length - 1; index >= 0; index -= 1) {
    const item = rules.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    if (managedId !== undefined
      && managedId.kind !== 'reply'
      && (includeDenies || item.get('effect') === 'allow')
      && managedExternalRuleIdentity(item, managedId) !== undefined) rules.items.splice(index, 1)
  }
}

function removeManagedExternalToolRulesOutsideAccount(rules: YAMLSeq, account: string): void {
  for (let index = rules.items.length - 1; index >= 0; index -= 1) {
    const item = rules.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    if (managedId !== undefined
      && managedId.kind !== 'reply'
      && managedId.account !== account
      && item.get('effect') === 'allow'
      && managedExternalRuleIdentity(item, managedId) !== undefined) rules.items.splice(index, 1)
  }
}

function removeAllManagedReplyRules(rules: YAMLSeq): void {
  for (let index = rules.items.length - 1; index >= 0; index -= 1) {
    const item = rules.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    const managedId = typeof id === 'string' ? parseManagedRuleId(id) : undefined
    if (managedId?.kind === 'reply'
      && managedExternalRuleIdentity(item, managedId) !== undefined) rules.items.splice(index, 1)
  }
}

function removeAllManagedExternalAgentRules(rules: YAMLSeq, includeDenies = false): void {
  removeAllManagedExternalToolRules(rules, includeDenies)
  removeAllManagedReplyRules(rules)
}

function upsertApprovalRules(
  document: Document,
  rules: YAMLSeq,
  input: { account: string; workspace: string; principal: string },
): void {
  for (const sourceId of managedApprovalSources) {
    upsertById(document, rules, {
      id: `lark-owner-approval-${sourceId}-${input.account}`,
      effect: 'allow',
      subject: {
        kind: 'background',
        id: sourceId,
        workspace: input.workspace,
        principal: input.principal,
      },
      actions: ['approval.send'],
      resource: { kind: 'message', id: '*' },
      context: { initiators: ['background'] },
    })
  }
}

function configuredOwnerPrincipal(rules: YAMLSeq, account: string): string | undefined {
  const rule = rules.items.find(item => isMap(item) && item.get('id') === `lark-owner-ingress-${account}`)
  if (!isMap(rule) || rule.get('effect') !== 'allow') return undefined
  const subject = rule.get('subject', true) as Node | undefined
  const resource = rule.get('resource', true) as Node | undefined
  const context = rule.get('context', true) as Node | undefined
  if (!isMap(subject) || !isMap(resource) || !isMap(context)
    || subject.get('kind') !== 'external'
    || !sequenceEquals(rule.get('actions', true) as Node | undefined, ['approval.decide', 'ingest'])
    || resource.get('kind') !== 'message'
    || resource.get('id') !== TOOL_WILDCARD
    || !sequenceEquals(context.get('initiators', true) as Node | undefined, ['external'])) return undefined
  const principal = subject.get('id')
  return isCanonicalLarkPrincipalForAccount(principal, account) ? principal : undefined
}

function setDefaults(map: YAMLMap, defaults: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (!map.has(key)) map.set(key, value)
  }
}

export function refreshLarkAgentPolicyPatch(input: LarkAgentPolicyRefreshInput): string {
  if (!isLiteralAbsolutePath(input.dshHome)) {
    throw new Error('lark-channel setup: DSH home must be an absolute path')
  }
  if (input.agentTools !== 'disable' && input.agentTools !== 'enable') {
    throw new Error('lark-channel setup: refresh agentTools mode must be enable or disable')
  }

  const document = parseDocument(input.profilePatch)
  if (document.errors.length > 0) {
    throw new Error(`lark-channel setup: profile patch is invalid YAML: ${document.errors[0]?.message}`)
  }
  const rows = asSequence(document.contents, 'profile patch')
  assertManagedProfileRowIntegrity(rows)
  const personalAssistant = findRow(rows, 'dsh-enhanced-personal-assistant')
  if (personalAssistant === undefined) {
    throw new Error('lark-channel setup: dsh-enhanced-personal-assistant profile override is required')
  }
  const personalConfig = asMap(personalAssistant.get('config', true) as Node, 'personal-assistant config')
  const policy = asMap(personalConfig.get('assistantPolicy', true) as Node, 'assistantPolicy config')
  const rules = asSequence(policy.get('rules', true) as Node, 'assistantPolicy rules')

  // Exact-principal rules remain attributable even after their account is
  // retired. Do not let explicit enable/disable report success while one of
  // those executable rules survives because its context was hand-edited.
  assertManagedExternalRuleIntegrity(rules)
  assertManagedForegroundRuleIntegrity(rules)

  // Foreground Web/direct reachability is a profile concern, not a channel
  // binding concern. Apply it even when Lark is absent or deliberately skipped.
  removeManagedForegroundRules(rules, input.agentTools === 'enable')
  if (input.agentTools === 'enable') upsertForegroundCapabilityRule(document, rules)

  const lark = findRow(rows, 'dsh-enhanced-lark-channel')
  if (lark === undefined) {
    removeAllManagedExternalAgentRules(rules)
    sweepRetiredManagedFixedRules(rules, undefined)
    sweepRetiredManagedCredentialHandles(rows, undefined)
    if (input.account !== undefined) {
      throw new Error('lark-channel setup: no enabled Lark account exists to match the requested account')
    }
    return document.toString({ lineWidth: 0 })
  }
  const channel = asMap(lark.get('config', true) as Node, 'lark-channel config')
  const configuredAccountValue = channel.get('account')
  if (typeof configuredAccountValue !== 'string') {
    throw new Error('lark-channel setup: existing Lark channel account is invalid')
  }
  const configuredAccount = requireAccount(configuredAccountValue)
  assertManagedExternalRuleIntegrity(rules)
  sweepRetiredManagedFixedRules(rules, configuredAccount)
  sweepRetiredManagedCredentialHandles(rows, configuredAccount)
  if (channel.get('enabled') !== true) {
    // No disabled channel may leave an executable Agent rule behind, including
    // reply grants and rules for retired account ids.
    removeAllManagedExternalAgentRules(rules)
    if (input.account !== undefined) {
      throw new Error('lark-channel setup: no enabled Lark account exists to match the requested account')
    }
    return document.toString({ lineWidth: 0 })
  }
  if (input.account !== undefined && requireAccount(input.account) !== configuredAccount) {
    throw new Error(`lark-channel setup: configured account is ${configuredAccount}; refusing a different account`)
  }
  const agent = configuredAgentIdentity(rows, input.dshHome)
  const principal = configuredOwnerPrincipal(rules, configuredAccount)
  if (input.agentTools === 'enable' && principal === undefined) {
    throw new Error(
      `lark-channel setup: enabled account ${configuredAccount} has no canonical owner ingress; `
      + 'refusing to enable Agent policy',
    )
  }
  const legacyAgents = managedReplyIdentities(rules, configuredAccount)
    .filter(identity => identity.preset !== agent.preset || identity.workspace !== agent.workspace)

  removeAllManagedExternalAgentRules(rules, input.agentTools === 'enable')
  if (principal !== undefined) {
    upsertExternalReplyRule(document, rules, { account: configuredAccount, identity: agent, principal })
    for (const legacyAgent of legacyAgents) {
      upsertExternalReplyRule(document, rules, {
        account: configuredAccount,
        identity: legacyAgent,
        principal,
        legacy: true,
      })
    }
    if (input.agentTools === 'enable') {
      upsertExternalToolRules(document, rules, {
        account: configuredAccount,
        identity: agent,
        principal,
      })
      for (const legacyAgent of legacyAgents) {
        upsertExternalToolRules(document, rules, {
          account: configuredAccount,
          identity: legacyAgent,
          principal,
          legacy: true,
        })
      }
    }
  }
  return document.toString({ lineWidth: 0 })
}

export function configureLarkProfilePatch(input: LarkProfileSetupInput): string {
  const appId = input.appId.trim()
  if (!/^cli_[0-9a-fA-F]{16}$/u.test(appId)) throw new Error('lark-channel setup: invalid appId')
  const account = requireAccount(input.account)
  const tenant = requireSetupKey(input.tenant, 'tenant')
  const ownerUserId = requireProviderKey(input.ownerUserId, 'ownerUserId')
  const keychainService = requireProviderKey(input.keychainService, 'keychainService')
  const keychainAccount = requireProviderKey(input.keychainAccount, 'keychainAccount')
  const credentialProvider = input.credentialProvider ?? 'macos-keychain'
  if (!['linux-secret-service', 'macos-keychain', 'windows-dpapi'].includes(credentialProvider)) {
    throw new Error('lark-channel setup: invalid credentialProvider')
  }
  const agentToolsMode = input.agentTools ?? 'preserve'
  if (!['disable', 'enable', 'preserve'].includes(agentToolsMode)) {
    throw new Error('lark-channel setup: invalid agentTools mode')
  }
  const credentialHandle = `lark-app-secret-${account}`

  const document = parseDocument(input.profilePatch)
  if (document.errors.length > 0) {
    throw new Error(`lark-channel setup: profile patch is invalid YAML: ${document.errors[0]?.message}`)
  }
  const rows = asSequence(document.contents, 'profile patch')
  assertManagedProfileRowIntegrity(rows)
  const existingLarkRow = findRow(rows, 'dsh-enhanced-lark-channel')
  let previousAccount: string | undefined
  if (existingLarkRow !== undefined) {
    const existingChannel = asMap(existingLarkRow.get('config', true) as Node, 'lark-channel config')
    const existingAccount = existingChannel.get('account')
    if (existingAccount !== undefined) {
      if (typeof existingAccount !== 'string') {
        throw new Error('lark-channel setup: existing Lark channel account is invalid')
      }
      previousAccount = requireAccount(existingAccount)
    }
  }
  const personalAssistant = findRow(rows, 'dsh-enhanced-personal-assistant')
  if (personalAssistant === undefined) {
    throw new Error('lark-channel setup: dsh-enhanced-personal-assistant profile override is required')
  }
  const personalConfig = asMap(personalAssistant.get('config', true) as Node, 'personal-assistant config')
  const policy = asMap(personalConfig.get('assistantPolicy', true) as Node, 'assistantPolicy config')
  const rules = asSequence(policy.get('rules', true) as Node, 'assistantPolicy rules')
  const grantSourceAccount = previousAccount ?? account
  const principalId = externalPrincipalId({ channel: 'lark', account, tenant, user: ownerUserId })
  assertManagedExternalRuleIntegrity(rules)
  assertManagedForegroundRuleIntegrity(rules)
  assertManagedFixedRuleIntegrity(rules, account)
  const sourceOwnerPrincipal = configuredOwnerPrincipal(rules, grantSourceAccount)
  const preserveOwnerPrincipal = sourceOwnerPrincipal
    ?? (previousAccount === undefined ? principalId : undefined)
  if (agentToolsMode === 'preserve'
    && previousAccount !== undefined
    && sourceOwnerPrincipal === undefined
    && hasManagedExternalAllowCandidate(rules, grantSourceAccount)) {
    throw new Error(
      `lark-channel setup: enabled account ${grantSourceAccount} has no canonical owner ingress; `
      + 'refusing to preserve ambiguous Agent grants',
    )
  }
  if (agentToolsMode === 'preserve' && preserveOwnerPrincipal !== undefined) {
    scopeManagedExternalAllowsToOwner(rules, grantSourceAccount, preserveOwnerPrincipal)
  }
  const preservedExternalGrant = hasManagedExternalWildcardAllow(
    rules,
    grantSourceAccount,
    preserveOwnerPrincipal,
  )
  const preservedForegroundGrant = hasManagedForegroundRules(rules)
  const ownerBindingChanged = (previousAccount !== undefined && previousAccount !== account)
    || (sourceOwnerPrincipal !== undefined && sourceOwnerPrincipal !== principalId)
  if (agentToolsMode === 'preserve'
    && ownerBindingChanged
    && hasManagedExternalRuleCandidate(rules, grantSourceAccount)
    && !preservedExternalGrant) {
    throw new Error(
      'lark-channel setup: cannot preserve restrictive or ambiguous external Agent rules '
      + 'while changing the Lark owner binding; rerun with agentTools enable or disable',
    )
  }
  const agent = configuredAgentIdentity(rows, input.dshHome)
  const legacyAgents = previousAccount === undefined || previousAccount === account
    ? managedReplyIdentities(rules, account)
      .filter(identity => identity.preset !== agent.preset || identity.workspace !== agent.workspace)
    : []
  sweepRetiredManagedFixedRules(rules, account)
  upsertById(document, rules, {
    id: `lark-channel-credential-${account}`,
    effect: 'allow',
    subject: { kind: 'background', id: 'dsh-enhanced-lark-channel' },
    actions: ['credential.use'],
    resource: { kind: 'credential', id: credentialHandle },
    context: { initiators: ['background'] },
  })
  upsertApprovalRules(document, rules, { account, workspace: agent.workspace, principal: principalId })
  upsertById(document, rules, {
    id: `lark-owner-ingress-${account}`,
    effect: 'allow',
    subject: { kind: 'external', id: principalId },
    actions: ['approval.decide', 'ingest'],
    resource: { kind: 'message', id: '*' },
    context: { initiators: ['external'] },
  })
  // Rebuild setup-managed external rules from a single exact account owner.
  // This also sweeps rules left by retired accounts and migrates legacy rules
  // which predate principal-scoped Agent subjects.
  const retainCurrentExternalRules = agentToolsMode === 'preserve'
    && !ownerBindingChanged
    && !preservedExternalGrant
  if (retainCurrentExternalRules) removeManagedExternalToolRulesOutsideAccount(rules, account)
  else removeAllManagedExternalToolRules(rules, agentToolsMode === 'enable')
  if (agentToolsMode === 'disable') removeManagedForegroundRules(rules)
  if (agentToolsMode === 'enable') {
    removeManagedForegroundRules(rules, true)
    upsertForegroundCapabilityRule(document, rules)
    upsertExternalToolRules(document, rules, { account, identity: agent, principal: principalId })
    for (const legacyAgent of legacyAgents) {
      upsertExternalToolRules(document, rules, {
        account,
        identity: legacyAgent,
        principal: principalId,
        legacy: true,
      })
    }
  }
  if (agentToolsMode === 'preserve') {
    if (preservedForegroundGrant) {
      removeManagedForegroundRules(rules)
      upsertForegroundCapabilityRule(document, rules)
    }
    if (preservedExternalGrant) {
      upsertExternalToolRules(document, rules, { account, identity: agent, principal: principalId })
      for (const legacyAgent of legacyAgents) {
        upsertExternalToolRules(document, rules, {
          account,
          identity: legacyAgent,
          principal: principalId,
          legacy: true,
        })
      }
    }
  }
  removeAllManagedReplyRules(rules)
  upsertExternalReplyRule(document, rules, { account, identity: agent, principal: principalId })
  for (const legacyAgent of legacyAgents) {
    upsertExternalReplyRule(document, rules, {
      account,
      identity: legacyAgent,
      principal: principalId,
      legacy: true,
    })
  }

  const credentialsRow = ensureRow(document, rows, 'dsh-enhanced-credentials-keychain')
  const credentials = asMap(credentialsRow.get('config', true) as Node, 'credentials-keychain config')
  setDefaults(credentials, {
    databasePath: join(input.dshHome, 'credentials-keychain/ledger.sqlite'),
    defaultLeaseMs: 300_000,
    maxSecretBytes: 65_536,
    providerTimeoutMs: 5_000,
  })
  let handles = credentials.get('handles', true) as Node | undefined
  if (handles === undefined) {
    credentials.set('handles', document.createNode([]))
    handles = credentials.get('handles', true) as Node
  }
  const handleList = asSequence(handles, 'credentials-keychain handles')
  sweepRetiredManagedCredentialHandles(rows, account)
  const commonHandle = {
    id: credentialHandle,
    consumers: ['dsh-enhanced-lark-channel'],
    purposes: ['connect'],
    maxLeaseMs: 86_400_000,
  }
  if (credentialProvider === 'windows-dpapi') {
    const path = input.credentialPath
    if (path === undefined || path.length > 1_024 || path.includes('\0')
      || (!isAbsolute(path) && !win32.isAbsolute(path))) {
      throw new Error('lark-channel setup: invalid credentialPath')
    }
    upsertById(document, handleList, { ...commonHandle, provider: credentialProvider, path })
  } else {
    upsertById(document, handleList, {
      ...commonHandle,
      provider: credentialProvider,
      service: keychainService,
      account: keychainAccount,
    })
  }

  const larkRow = ensureRow(document, rows, 'dsh-enhanced-lark-channel')
  const channel = asMap(larkRow.get('config', true) as Node, 'lark-channel config')
  channel.delete('appSecretEnv')
  const channelConfig = {
    enabled: true,
    account,
    tenant,
    appId,
    credentialHandle,
    credentialPurpose: 'connect',
    credentialLeaseMs: 86_400_000,
    domain: input.domain,
    requireMentionInGroups: true,
    showProgress: true,
    statusReactions: true,
    maxTextBytes: 65_536,
    staleAfterMs: 300_000,
    handshakeTimeoutMs: 15_000,
    imageDownloadTimeoutMs: 30_000,
  }
  for (const [key, value] of Object.entries(channelConfig)) channel.set(key, value)

  return document.toString({ lineWidth: 0 })
}
