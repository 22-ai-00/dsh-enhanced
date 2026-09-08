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

/** Shared REST-shaped remote state for the event/acceptance transport fixtures. */
export function repositoryFixtureSnapshot() {
  const file = process.env.DSH_REPO_DELIVERY_FIXTURE_LOG
  const rows = file && existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const commit = rows.find(row => row.kind === 'commit'), created = rows.find(row => row.kind === 'pr')
  const ready = !!(process.env.DSH_REPO_EVENT_STATE && existsSync(process.env.DSH_REPO_EVENT_STATE) && JSON.parse(readFileSync(process.env.DSH_REPO_EVENT_STATE, 'utf8')).ready)
  const headOid = commit?.commitOid ?? initialOid
  const pullRequest = created ? { number: 17, state: 'open', merged: false, head: { ref: 'automation/fix', sha: headOid, repo: { full_name: 'fixture/orders' } }, base: { ref: 'main', repo: { full_name: 'fixture/orders' } } } : null
  const checks = [{ id: 1, name: 'tests', app: { id: 7 }, head_sha: headOid, status: ready ? 'completed' : 'in_progress', conclusion: ready ? 'success' : null }]
  const reviews = ready && pullRequest ? [{ id: 1, user: { id: 42 }, commit_id: headOid, state: 'APPROVED' }] : []
  return { ready, headOid, pullRequest, checks, reviews }
}

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
      if (process.env.DSH_REPO_EVENT_STATE) {
        const state = repositoryFixtureSnapshot()
        const observed = input.kind === 'branch' ? { name: input.grant.branch, commit: { sha: state.headOid }, untrusted: true }
          : input.kind === 'pull-request' ? state.pullRequest
          : { pullRequest: state.pullRequest, headOid: state.headOid, items: input.kind === 'checks' ? state.checks : state.reviews, truncated: false, untrusted: true }
        appendFileSync(`${file}.readbacks`, `${JSON.stringify({ kind: input.kind, ready: state.ready, headOid: state.headOid, at: Date.now() })}\n`, { mode: 0o600 })
        return { observed }
      }
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

export async function prepareRepositoryFixture(home, patchPath, env) {
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
  const isolation = config('dsh-enhanced-assistant-isolation').toJSON().grants[0]
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
    consumers: ['dsh-enhanced-assistant-actions', ...(process.env.DSH_REPO_EVENT_SOURCE === 'fixture' ? ['dsh-enhanced-event-triggers'] : [])], purposes: ['github.commit', ...(process.env.DSH_REPO_EVENT_SOURCE === 'fixture' ? ['github.observe'] : [])], maxLeaseMs: 30000 }]))
  patch.contents.add(patch.createNode({ insert: [{ id: name, name: fileURLToPath(import.meta.url) }] }))
  env.DSH_REPO_DELIVERY_FIXTURE_LOG = join(home, 'github-fixture.jsonl')
  if (process.env.DSH_REPO_EVENT_SOURCE === 'fixture') { env.DSH_REPO_EVENT_STATE = join(home, 'repository-event-fixture.json'); env.DSH_REPO_EVENT_SOURCE_LOG = join(home, 'repository-event-source.jsonl'); await writeFile(env.DSH_REPO_EVENT_STATE, '{"ready":false}', { mode: 0o600 }) }
  await writeFile(patchPath, String(patch), { mode: 0o600 })
  return { repository: 'fixture/orders', baseBranch: 'main', branch: 'automation/fix', paths: ['summarize.mjs'],
    credentialHandle: 'repo-fixture', expiresAt: Math.min(isolation.expiresAt, Date.now() + 420000),
    maxActions: process.env.DSH_REPO_EVENT_SOURCE === 'fixture' ? 100 : 8, maxTotalBytes: 1048576, openPullRequest: true,
    ...(process.env.DSH_REPO_EVENT_SOURCE === 'fixture' ? { acceptance: 'goal-step', outcome: { requiredChecks: [{ name: 'tests', appId: 7 }], reviewerIds: [42], minApprovals: 1, timeoutMs: 10000, freshnessMs: 30000 }, events: { credentialHandle: 'repo-fixture', maxPolls: 180, maxFires: 4, pollIntervalMs: 2000, requestTimeoutMs: 10000 } } : {}) }
}
