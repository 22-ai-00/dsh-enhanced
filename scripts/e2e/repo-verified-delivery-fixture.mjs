import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, isSeq, parseDocument } from 'yaml'
import { readCredential } from '../../plugins/credentials-keychain/lib/providers.js'

export const name = 'repo-verified-delivery-transport-fixture'
export const inject = ['assistantActions']
const initialOid = '1'.repeat(40)

/** Explicit GitHub transport substitute; the model, broker, credentials,
 * acceptance, isolation and scheduling remain their production components. */
export function apply(ctx) {
  const file = process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
  if (!file) throw new Error('fixture log missing')
  const rows = () => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const record = data => appendFileSync(file, `${JSON.stringify(data)}\n`, { mode: 0o600 })
  const actions = ctx.assistantActions
  actions.commit = async input => {
    input.signal.throwIfAborted()
    if (input.request.expectedHeadOid !== initialOid || rows().some(row => row.kind === 'commit')) throw new Error('fixture expected head or duplicate commit')
    const commitOid = createHash('sha1').update(JSON.stringify(input.request.files)).digest('hex')
    record({ kind: 'commit', at: Date.now(), actionId: input.actionId, commitOid, files: input.request.files })
    return { actionId: input.actionId, status: 'succeeded', commitOid }
  }
  actions.workflow = { ...actions.workflow,
    inspect: async input => {
      input.signal.throwIfAborted()
      return { observed: input.kind === 'branch' ? { name: input.grant.branch, commit: { sha: initialOid }, untrusted: true }
        : { full_name: input.grant.repository, untrusted: true } }
    },
    pullRequest: async input => {
      input.signal.throwIfAborted()
      const commit = rows().find(row => row.kind === 'commit')
      if (!commit || commit.commitOid !== input.expectedHeadOid || rows().some(row => row.kind === 'pr')) throw new Error('fixture PR head or duplicate')
      record({ kind: 'pr', at: Date.now(), actionId: input.actionId, headOid: input.expectedHeadOid, number: 17 })
      return { actionId: input.actionId, status: 'succeeded', pullRequestNumber: 17 }
    },
  }
}

export async function configureVerifiedDelivery(home, patchPath, env) {
  const patch = parseDocument(await readFile(patchPath, 'utf8'))
  const find = (node, id) => {
    if (isMap(node)) {
      if (node.get('id') === id) return node
      for (const item of node.items) { const result = find(item.value, id); if (result) return result }
    } else if (isSeq(node)) { for (const item of node.items) { const result = find(item, id); if (result) return result } }
  }
  const config = id => {
    let row = find(patch.contents, id)
    if (!row) { row = patch.createNode({ id, name: `@dsh-enhanced/${id.slice('dsh-enhanced-'.length)}` }); patch.contents.add(row) }
    if (!row.has('config')) row.set('config', patch.createNode({}))
    return row.get('config', true)
  }
  const policy = config('dsh-enhanced-personal-assistant').get('assistantPolicy', true)
  const isolation = config('dsh-enhanced-assistant-isolation').toJSON().grants[0]
  const wake = config('dsh-enhanced-assistant-goals').toJSON().backgroundWake
  const rules = policy.get('rules', true)
  const principalId = rules.toJSON().find(rule => rule.subject?.kind === 'agent' && rule.subject.principal)?.subject.principal
  if (!principalId || !wake) throw new Error('fixture owner route missing')
  const replyResource = rules.toJSON().find(rule => rule.id === `${wake.ownerRouteId}-reply`)?.resource
  if (replyResource?.kind !== 'message' || !replyResource.id) throw new Error('fixture notification binding missing')
  const secretDirectory = join(home, 'repo-fixture-secrets')
  await mkdir(secretDirectory, { mode: 0o700 })
  const secretPath = join(secretDirectory, 'github')
  await writeFile(secretPath, 'non-production-github-fixture', { mode: 0o600 })
  // Check the real provider's file constraints before invoking a model. The
  // actual Actions calls still acquire their own Policy-authorized leases.
  const secret = await readCredential({ provider: 'linux-protected-file', path: secretPath }, {
    env: {}, run: async () => { throw new Error('unexpected fixture subprocess') }, timeoutMs: 1000, maxSecretBytes: 4096,
  })
  if (secret !== 'non-production-github-fixture') throw new Error('fixture credential mismatch')
  config('dsh-enhanced-credentials-keychain').set('handles', patch.createNode([{ id: 'repo-fixture', provider: 'linux-protected-file', path: secretPath,
    consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30000 }]))
  const actions = config('dsh-enhanced-assistant-actions')
  actions.set('stateRoot', join(home, 'assistant-actions'))
  actions.set('grants', patch.createNode([{ id: 'repo-delivery', revision: 1,
    principalDigest: isolation.principalDigest, principalRecordId: isolation.principalRecordId, principalVersion: isolation.principalVersion,
    workspace: isolation.workspace, agentPreset: isolation.agentPreset, repository: 'fixture/orders', branch: 'automation/fix', paths: ['summarize.mjs'],
    credentialHandle: 'repo-fixture', expiresAt: Date.now() + 300000, maxActions: 8, maxTotalBytes: 1048576,
    repoWorkflow: { baseBranch: 'main', allowBranchCreate: false, allowPullRequest: true },
    verifiedDelivery: { ownerRouteId: wake.ownerRouteId, budgetId: wake.budgetId } }]))
  const agent = { kind: 'agent', id: isolation.agentPreset, workspace: isolation.workspace, principal: principalId }
  for (const rule of [
    ...['action_github_grants', 'action_github_inspect', 'action_github_deliver', 'action_github_delivery_status', 'action:github:repo-delivery'].map((id, i) => ({ id: `repo-fixture-agent-${i}`, effect: 'allow', subject: agent, actions: ['execute'], resource: { kind: 'tool', id } })),
    { id: 'repo-fixture-background', effect: 'allow', subject: { ...agent, kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['execute'], resource: { kind: 'tool', id: 'action:github:repo-delivery' } },
    { id: 'repo-fixture-credential', effect: 'allow', subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, actions: ['credential.use'], resource: { kind: 'credential', id: 'repo-fixture' } },
    { id: 'repo-fixture-automation', effect: 'allow', subject: { ...agent, kind: 'background', id: '*' }, actions: ['reconcile', 'execute'], resource: { kind: 'automation', id: 'verified-delivery-*' } },
    { id: 'repo-fixture-notification', effect: 'allow', subject: { ...agent, kind: 'background', id: 'assistant-actions-verified-delivery/v1' }, actions: ['send'], resource: replyResource, context: { initiators: ['background'] } },
  ]) rules.add(patch.createNode(rule))
  patch.contents.add(patch.createNode({ insert: [{ id: name, name: fileURLToPath(import.meta.url) }] }))
  env.DSH_REPO_DELIVERY_FIXTURE_LOG = join(home, 'github-fixture.jsonl')
  await writeFile(patchPath, String(patch), { mode: 0o600 })
}
