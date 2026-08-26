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

const setupKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const providerKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
const presetIdPattern = /^[a-z0-9][a-z0-9-]*$/u
// The grant is expressed as one wildcard allow plus an explicit denylist rather
// than an enumerated allowlist. Tools are registered dynamically by whichever
// plugins and skills a deployment mounts, so any name list is stale the moment a
// new tool appears: the agent then reports a refusal the owner cannot fix from
// the chat, and every addition needs a setup release. Risk is already judged by
// behaviour in `assistant-policy`'s `tools/pre-execute` reviewer, which inspects
// arguments and still routes writes, network access and dangerous commands to
// approval, so this rule decides reachability, not privilege.
//
// `TOOL_WILDCARD` keeps the rule bound to the exact preset, absolute workspace
// and `external` initiator; only the tool id is a pattern.
const TOOL_WILDCARD = '*'

// Durable-state mutators that must not be reachable from an external turn even
// when the reviewer would have asked. Policy evaluates `deny` ahead of `allow`
// at any specificity, so these override the wildcard.
const deniedExternalTools = [
  'memory_manage',
  'wiki_upsert',
  'wiki_lint',
  'automation_create',
  'automation_manage',
  'automation_run',
  'evolution_propose',
  'knowledge_pin',
  'knowledge_promote',
  'heartbeat_scratch_update',
] as const

// Per-tool ids emitted by earlier releases that used an enumerated allowlist.
// Removal must still recognise them, otherwise upgrading leaves stale allow
// rules that `--agent-tools disable` can no longer revoke.
const retiredToolRuleIds = [
  'bash', 'pwsh', 'read', 'glob', 'grep', 'skill',
  'memory_search', 'wiki_search', 'wiki_read',
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

interface AgentIdentity {
  preset: string
  workspace: string
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

function managedReplyIdentities(rules: YAMLSeq, account: string): AgentIdentity[] {
  const base = `lark-owner-reply-${account}`
  const identities = new Map<string, AgentIdentity>()
  for (const item of rules.items) {
    if (!isMap(item)) continue
    const id = item.get('id')
    if (id !== base && (typeof id !== 'string' || !id.startsWith(`${base}-legacy-`))) continue
    const resource = item.get('resource', true) as Node | undefined
    const context = item.get('context', true) as Node | undefined
    const subject = item.get('subject', true) as Node | undefined
    if (item.get('effect') !== 'allow'
      || !isMap(subject)
      || !isMap(resource)
      || !isMap(context)
      || subject.get('kind') !== 'agent'
      || resource.get('kind') !== 'message'
      || resource.get('id') !== '*'
      || !sequenceEquals(item.get('actions', true) as Node | undefined, ['reply'])
      || !sequenceEquals(context.get('initiators', true) as Node | undefined, ['external'])) {
      throw new Error(`lark-channel setup: managed reply rule ${String(id)} is invalid`)
    }
    const preset = subject.get('id')
    const workspace = subject.get('workspace')
    if (typeof preset !== 'string' || !presetIdPattern.test(preset) || !isLiteralAbsolutePath(workspace)) {
      throw new Error(`lark-channel setup: managed reply rule ${String(id)} has an invalid Agent identity`)
    }
    identities.set(`${preset}\0${workspace}`, { preset, workspace })
  }
  return [...identities.values()]
}

function removeManagedReplyRules(rules: YAMLSeq, account: string): void {
  const base = `lark-owner-reply-${account}`
  for (let index = rules.items.length - 1; index >= 0; index -= 1) {
    const item = rules.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    if (id === base || (typeof id === 'string' && id.startsWith(`${base}-legacy-`))) {
      rules.items.splice(index, 1)
    }
  }
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
  input: { account: string; identity: AgentIdentity; legacy?: boolean },
): void {
  const suffix = input.legacy ? legacyIdentitySuffix(input.identity) : ''
  upsertById(document, rules, {
    id: `lark-owner-reply-${input.account}${suffix}`,
    effect: 'allow',
    subject: { kind: 'agent', id: input.identity.preset, workspace: input.identity.workspace },
    actions: ['reply'],
    resource: { kind: 'message', id: '*' },
    context: { initiators: ['external'] },
  })
}

function upsertExternalToolRules(
  document: Document,
  rules: YAMLSeq,
  input: { account: string; identity: AgentIdentity; legacy?: boolean },
): void {
  const suffix = input.legacy ? legacyIdentitySuffix(input.identity) : ''
  const subject = { kind: 'agent', id: input.identity.preset, workspace: input.identity.workspace }
  // One reachability grant for every tool the mounted preset exposes.
  upsertById(document, rules, {
    id: `lark-owner-tool-${TOOL_WILDCARD}-${input.account}${suffix}`,
    effect: 'allow',
    subject,
    actions: ['execute'],
    resource: { kind: 'tool', id: TOOL_WILDCARD },
    context: { initiators: ['external'] },
  })
  // Emitted after the grant so a partially written patch never leaves the
  // wildcard in place without its denials.
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

function removeExternalToolRules(rules: YAMLSeq, account: string): void {
  for (let index = rules.items.length - 1; index >= 0; index -= 1) {
    const item = rules.items[index]
    if (!isMap(item)) continue
    const id = item.get('id')
    if (typeof id !== 'string') continue
    const managed = managedToolRuleSuffixes.some(tool => {
      const base = `lark-owner-tool-${tool}-${account}`
      return id === base || id.startsWith(`${base}-legacy-`)
    })
    if (managed) rules.items.splice(index, 1)
  }
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

function setDefaults(map: YAMLMap, defaults: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (!map.has(key)) map.set(key, value)
  }
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
  const personalAssistant = findRow(rows, 'dsh-enhanced-personal-assistant')
  if (personalAssistant === undefined) {
    throw new Error('lark-channel setup: dsh-enhanced-personal-assistant profile override is required')
  }
  const personalConfig = asMap(personalAssistant.get('config', true) as Node, 'personal-assistant config')
  const policy = asMap(personalConfig.get('assistantPolicy', true) as Node, 'assistantPolicy config')
  const rules = asSequence(policy.get('rules', true) as Node, 'assistantPolicy rules')
  const principalId = externalPrincipalId({ channel: 'lark', account, tenant, user: ownerUserId })
  const agent = configuredAgentIdentity(rows, input.dshHome)
  const legacyAgents = managedReplyIdentities(rules, account)
    .filter(identity => identity.preset !== agent.preset || identity.workspace !== agent.workspace)
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
  if (agentToolsMode === 'disable') removeExternalToolRules(rules, account)
  if (agentToolsMode === 'enable') {
    removeExternalToolRules(rules, account)
    upsertExternalToolRules(document, rules, { account, identity: agent })
    for (const legacyAgent of legacyAgents) {
      upsertExternalToolRules(document, rules, { account, identity: legacyAgent, legacy: true })
    }
  }
  removeManagedReplyRules(rules, account)
  upsertExternalReplyRule(document, rules, { account, identity: agent })
  for (const legacyAgent of legacyAgents) {
    upsertExternalReplyRule(document, rules, {
      account,
      identity: legacyAgent,
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
