import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadLiveRepositoryInput, mergeLiveCredentialHandles } from '../scripts/e2e/repo-live-input.mjs'
import { parseGoalAdmissionTask } from '../plugins/assistant-web-owner/src/goal-admission.ts'
import { normalizeHandles } from '../plugins/credentials-keychain/src/config.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const valid = (expiresAt = Date.now() + 600_000) => ({ version: 2, repository: 'example/e2e-target', baseBranch: 'main', temporaryBranch: 'e2e/source-retirement', paths: ['summarize.mjs'], credentialHandle: 'github-live-e2e', credential: { id: 'github-live-e2e', provider: 'environment', consumers: ['dsh-enhanced-assistant-actions', 'dsh-enhanced-event-triggers'], purposes: ['github.commit', 'github.observe'], maxLeaseMs: 30_000, reference: { environmentName: 'DSH_E2E_GITHUB_TOKEN' } }, expiresAt, maxActions: 75, maxTotalBytes: 1_048_576, requiredChecks: [{ name: 'CI', appId: 7 }], reviewerIds: [42], minApprovals: 1, event: { maxPolls: 30, maxFires: 4, pollIntervalMs: 2_000, requestTimeoutMs: 10_000 } })
async function input(value: unknown, mode = 0o600) { const root = await mkdtemp(join(tmpdir(), 'repo-live-input-')); roots.push(root); const path = join(root, 'live.json'); await writeFile(path, JSON.stringify(value), { mode }); await chmod(path, mode); return path }

describe('live repository E2E input', () => {
  it('accepts a bounded non-secret provider reference for the temporary profile', async () => {
    const value = await loadLiveRepositoryInput(await input(valid()))
    expect(value.repositoryDelivery).toMatchObject({ repository: 'example/e2e-target', branch: 'e2e/source-retirement', credentialHandle: 'github-live-e2e', acceptance: 'goal-step' })
    expect(JSON.stringify(value)).not.toContain('token')
    expect(value.credential).toEqual(expect.objectContaining({ provider: 'environment', environmentName: 'DSH_E2E_GITHUB_TOKEN' }))
    expect(normalizeHandles(mergeLiveCredentialHandles([], value))).toEqual([value.credential])
    expect(() => mergeLiveCredentialHandles([value.credential], value)).toThrow(/conflicts/)
  })
  it('rejects expired, broad, malformed, or non-private input before setup', async () => {
    await expect(loadLiveRepositoryInput(await input(valid(Date.now() + 1)))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input(valid(Date.now() + 601_000)))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), maxActions: 74 }))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), temporaryBranch: 'main' }))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), credentialHandle: 'token-value' }, 0o644))).rejects.toThrow(/private/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), provider: 'environment' }))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), credentialHandle: 'GitHub' }))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), paths: ['other.mjs'] }))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), event: { ...valid().event, maxPolls: 4 } }))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), event: { ...valid().event, requestTimeoutMs: 30001 } }))).rejects.toThrow(/schema/)
    await expect(loadLiveRepositoryInput(await input({ ...valid(), credential: { ...valid().credential, consumers: ['dsh-enhanced-assistant-actions'] } }))).rejects.toThrow(/not authorized/)
  })
  it('builds a production-parseable admission without carrying the credential reference', async () => {
    const live = await loadLiveRepositoryInput(await input(valid()))
    const admission = { version: 2, objective: 'Repair one file', route: { provider: 'test', model: 'test' }, maxGoalRounds: 6, stepMaxDurationMs: 120_000,
      executionBudget: { mode: 'calls', modelCalls: 24, toolCalls: 40, durationMs: 300_000, maxOutputTokensPerCall: 1024, routes: [{ provider: 'test', model: 'test' }] },
      verification: { artifactPath: 'summarize.mjs', command: 'node summarize.mjs', maxRuns: 12, maxTotalDurationMs: 240_000, maxDurationMs: 5_000, maxOutputBytes: 4096,
        cases: [{ stdin: '[]\n', expectedStdout: '{}\n', expectedExitCode: 0 }] }, repositoryDelivery: live.repositoryDelivery }
    expect(JSON.stringify(admission.repositoryDelivery)).not.toContain('environmentName')
    expect(parseGoalAdmissionTask(JSON.stringify(admission)).repositoryDelivery).toEqual(live.repositoryDelivery)
  })
})
