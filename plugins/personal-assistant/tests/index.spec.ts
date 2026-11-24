import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { apply, name, version } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
}
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('personal-assistant core meta-bundle', () => {
  test('has a stable package entrypoint and exact four core dependencies', () => {
    expect(name).toBe('dsh-enhanced-personal-assistant')
    expect(version).toBe(manifest.version)
    expect(manifest.dependencies).toMatchObject({
      '@dsh-enhanced/assistant-automations': 'workspace:*',
      '@dsh-enhanced/assistant-policy': 'workspace:*',
      '@dsh-enhanced/personal-memory': 'workspace:*',
      '@dsh-enhanced/personal-wiki': 'workspace:*',
    })
  })

  test('mounts one unique meta row and grants local foreground Agents every mounted capability by default', () => {
    expect([...patch.matchAll(/^(?:- id:| {4}- id:) (\S+)$/gm)].map(match => match[1]))
      .toEqual(['permission', 'dsh-enhanced-personal-assistant'])
    expect(patch).toContain("name: '@dsh-enhanced/personal-assistant'")
    expect(patch).toContain('id: dsh-enhanced-foreground-capability-*')
    expect(patch).toMatch(/subject:\s+kind: agent\s+id: ['"]\*['"]\s+workspace: ['"]\*['"]/u)
    expect(patch).toMatch(/actions:\s+- ['"]\*['"]\s+resource:\s+kind: ['"]\*['"]\s+id: ['"]\*['"]/u)
    expect(patch).toMatch(/context:\s+initiators:\s+- foreground/u)
    expect(patch).toContain('budgets: []')
    expect(patch).toContain('schedulerEnabled: false')
    expect(patch).not.toContain('@dsh-enhanced/assistant-delivery')
    expect(patch).not.toContain('@dsh-enhanced/lark-channel')
  })

  test('configures native ask and full, leaving reserved Auto to live Policy registration', () => {
    expect(patch).toMatch(/- id: permission\s+name: '@deepseek-ai\/dsh-permission-presets'/u)
    expect(patch).toMatch(/presets:\s+workspace-write:\s+sandbox: workspace-write\s+approval: ask\s+name: 请求批准/u)
    expect(patch).not.toMatch(/^\s+auto:/mu)
    expect(patch).toMatch(/danger-full-access:\s+sandbox: danger-full-access\s+approval: never/u)
    expect(patch).toContain('defaultPreset: danger-full-access')
    expect(patch).not.toMatch(/^\s+read-only:/mu)
  })

  test('composes the four public Cordis services in one plugin lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-meta-'))
    roots.push(root)
    const ctx = new Context()
    await apply(ctx, {
      assistantPolicy: { databasePath: join(root, 'policy.sqlite'), rules: [{
        id: 'dsh-enhanced-foreground-capability-*',
        effect: 'allow',
        subject: { kind: 'agent', id: '*', workspace: '*' },
        actions: ['*'],
        resource: { kind: '*', id: '*' },
        context: { initiators: ['foreground'] },
      }], budgets: [] },
      personalMemory: { databasePath: join(root, 'memory.sqlite') },
      personalWiki: { vaultRoot: join(root, 'vault'), databasePath: join(root, 'wiki.sqlite') },
      assistantAutomations: { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
        schedulerEnabled: false },
    })
    expect(ctx.assistantPolicy.health()).toMatchObject({ emergencyStop: false })
    expect(ctx.personalMemory.health()).toMatchObject({ activeRecords: 0 })
    expect(ctx.personalMemory.automaticLearningStatus()).toEqual({
      enabled: true,
      mode: 'default-pending-grant',
      configured: false,
    })
    expect(ctx.personalWiki.health()).toMatchObject({ pages: 0 })
    expect(ctx.assistantAutomations.health()).toMatchObject({ activeAutomations: 0 })
    expect(ctx.assistantPolicy.evaluate({
      subject: { kind: 'agent', id: 'standard', workspace: '/work/local' },
      action: 'execute',
      resource: { kind: 'tool', id: 'skill' },
      context: { initiator: 'foreground' },
    })).toMatchObject({ effect: 'allow', ruleId: 'dsh-enhanced-foreground-capability-*' })
    expect(ctx.assistantPolicy.evaluate({
      subject: { kind: 'agent', id: 'standard', workspace: '/work/local' },
      action: 'execute',
      resource: { kind: 'tool', id: 'skill' },
      context: { initiator: 'external' },
    })).toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
    await ctx.fiber.restart()
  })

  test('supports personalMemory.automaticLearning false opt-out and signed grant pass-through', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-learning-'))
    roots.push(root)

    const disabledCtx = new Context()
    await apply(disabledCtx, {
      assistantPolicy: { databasePath: join(root, 'policy-disabled.sqlite'), rules: [], budgets: [] },
      personalMemory: { databasePath: join(root, 'memory-disabled.sqlite'), automaticLearning: false, reconcileIntervalMs: 0 },
      personalWiki: { vaultRoot: join(root, 'vault-disabled'), databasePath: join(root, 'wiki-disabled.sqlite') },
      assistantAutomations: { databasePath: join(root, 'automations-disabled.sqlite'), runsPath: join(root, 'runs-disabled'), schedulerEnabled: false },
    })
    expect(disabledCtx.personalMemory.automaticLearningStatus()).toEqual({
      enabled: false,
      mode: 'disabled',
      configured: false,
    })
    await disabledCtx.fiber.restart()

    const grantedCtx = new Context()
    const owner = {
      authorityId: 'owner-route',
      authorityHash: 'a'.repeat(64),
      principalId: 'lark/app/tenant/owner',
      principalRecordId: 'owner-row',
      principalVersion: 1,
      workspace: root,
      agentPreset: 'primary',
    }
    await apply(grantedCtx, {
      assistantPolicy: { databasePath: join(root, 'policy-granted.sqlite'), rules: [], budgets: [] },
      personalMemory: {
        databasePath: join(root, 'memory-granted.sqlite'),
        reconcileIntervalMs: 0,
        automaticLearning: {
          authorityId: 'adopt-grant',
          owner,
          reviewAuthorityId: 'review-grant',
          reviewAuthorityDigest: 'b'.repeat(64),
          expiresAt: Date.now() + 60_000,
          maxMutations: 5,
          maxTotalContentBytes: 4096,
          maxRecordTtlMs: 60_000,
          kinds: ['fact', 'experience'],
          operations: ['add', 'replace', 'remove'],
        },
      },
      personalWiki: { vaultRoot: join(root, 'vault-granted'), databasePath: join(root, 'wiki-granted.sqlite') },
      assistantAutomations: { databasePath: join(root, 'automations-granted.sqlite'), runsPath: join(root, 'runs-granted'), schedulerEnabled: false },
    })
    expect(grantedCtx.personalMemory.automaticLearningStatus()).toEqual({
      enabled: true,
      mode: 'signed-grant',
      configured: true,
    })
    await grantedCtx.fiber.restart()
  })
})
