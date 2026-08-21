import { isAbsolute, join, win32 } from 'node:path'
import { isMap, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'

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
}

const setupKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const providerKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

function requireSetupKey(value: string, field: string): string {
  const normalized = value.trim()
  if (!setupKeyPattern.test(normalized)) throw new Error(`lark-channel setup: invalid ${field}`)
  return normalized
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

function setDefaults(map: YAMLMap, defaults: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (!map.has(key)) map.set(key, value)
  }
}

export function configureLarkProfilePatch(input: LarkProfileSetupInput): string {
  const appId = input.appId.trim()
  if (!/^cli_[0-9a-fA-F]{16}$/u.test(appId)) throw new Error('lark-channel setup: invalid appId')
  const account = requireSetupKey(input.account, 'account')
  const tenant = requireSetupKey(input.tenant, 'tenant')
  const ownerUserId = requireProviderKey(input.ownerUserId, 'ownerUserId')
  const keychainService = requireProviderKey(input.keychainService, 'keychainService')
  const keychainAccount = requireProviderKey(input.keychainAccount, 'keychainAccount')
  const credentialProvider = input.credentialProvider ?? 'macos-keychain'
  if (!['linux-secret-service', 'macos-keychain', 'windows-dpapi'].includes(credentialProvider)) {
    throw new Error('lark-channel setup: invalid credentialProvider')
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
  const principalId = `lark/${account}/${tenant}/${ownerUserId}`

  upsertById(document, rules, {
    id: `lark-channel-credential-${account}`,
    effect: 'allow',
    subject: { kind: 'background', id: 'dsh-enhanced-lark-channel' },
    actions: ['credential.use'],
    resource: { kind: 'credential', id: credentialHandle },
    context: { initiators: ['background'] },
  })
  upsertById(document, rules, {
    id: `lark-owner-ingress-${account}`,
    effect: 'allow',
    subject: { kind: 'external', id: principalId },
    actions: ['approval.decide', 'ingest'],
    resource: { kind: 'message', id: '*' },
    context: { initiators: ['external'] },
  })
  upsertById(document, rules, {
    id: `lark-owner-reply-${account}`,
    effect: 'allow',
    subject: { kind: 'agent', id: 'primary', workspace: join(input.dshHome, 'assistant-workspace') },
    actions: ['reply'],
    resource: { kind: 'message', id: '*' },
    context: { initiators: ['external'] },
  })

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
  }
  for (const [key, value] of Object.entries(channelConfig)) channel.set(key, value)

  return document.toString({ lineWidth: 0 })
}
