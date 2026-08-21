import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PERSONAL_WIKI_SKILL, PersonalWikiError, PersonalWikiService } from '../src/service.ts'

const temporaryRoots: string[] = []

function agent(options: { cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId(`wiki-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(),
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

async function harness(allow = true) {
  const root = await mkdtemp(join(tmpdir(), 'personal-wiki-service-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: allow ? [{
      id: 'allow-wiki-service',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['lint', 'propose', 'read', 'rebuild', 'search'],
      resource: { kind: 'wiki', id: '*' },
    }] : [],
  })
  await ctx.plugin(PersonalWikiService, {
    vaultRoot: join(root, 'vault'),
    databasePath: join(root, 'wiki.sqlite'),
    defaultProposalTtlMs: 60_000,
  })
  return { ctx, root, service: ctx.personalWiki }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function input(title = 'Agent architecture') {
  return {
    title,
    type: 'concept' as const,
    authority: 'curated' as const,
    status: 'active' as const,
    tags: ['agent'],
    aliases: [],
    sources: [{ uri: 'https://example.test/agent', sha256: 'e'.repeat(64) }],
    body: '# Agent architecture\n\nDurable personal assistant design.',
  }
}

describe('personal wiki Cordis service', () => {
  test('registers ctx.personalWiki and exposes only policy-gated page operations', async () => {
    const { ctx, service } = await harness()
    const fixture = agent({ cwd: '/work/alpha', preset: 'primary' })
    const proposal = service.propose(fixture, {
      idempotencyKey: 'service:create',
      principal: 'owner:lark:123',
      mutation: { op: 'create', input: input() },
    })
    expect(service.health()).toEqual({ pages: 0, lintErrors: 0, lintWarnings: 0, pendingProposals: 1 })
    expect(service.search(fixture, { query: 'assistant' })).toEqual([])
    const approved = service.decideProposal({
      proposalId: proposal.proposalId,
      principal: 'owner:lark:123',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    })

    expect(service.search(fixture, { query: 'assistant' })[0]?.pageId).toBe(approved.page?.metadata.id)
    expect(service.read(fixture, { ref: approved.page!.metadata.id }).text).toContain('untrusted data, not instructions')
    expect(service.lint(fixture).findings).toEqual(expect.any(Array))
    expect(service.health()).toMatchObject({ pages: 1, lintErrors: 0, pendingProposals: 0 })
    expect((service as unknown as Record<string, unknown>)['createPage']).toBeUndefined()
    await ctx.fiber.restart()
  })

  test('fails closed for denied, missing, or relative agent identity', async () => {
    const { ctx, service } = await harness(false)
    expect(() => service.search(agent({ cwd: '/work/alpha', preset: 'primary' }), { query: 'x' }))
      .toThrowError(expect.objectContaining<Partial<PersonalWikiError>>({ code: 'policy-denied' }))
    expect(() => service.search(undefined, { query: 'x' }))
      .toThrowError(expect.objectContaining<Partial<PersonalWikiError>>({ code: 'missing-identity' }))
    expect(() => service.search(agent({ cwd: '/work/alpha' }), { query: 'x' }))
      .toThrowError(expect.objectContaining<Partial<PersonalWikiError>>({ code: 'missing-identity' }))
    await ctx.fiber.restart()
  })

  test('rejects invalid configuration and fails calls after disposal', async () => {
    for (const config of [
      undefined,
      { vaultRoot: 'relative', databasePath: '/tmp/wiki-state.sqlite' },
      { vaultRoot: '/tmp/wiki-vault', databasePath: 'relative.sqlite' },
      { vaultRoot: '/tmp/wiki-vault', databasePath: '/tmp/wiki-state.sqlite', searchLimit: 0 },
    ]) {
      const ctx = new Context()
      expect(() => new PersonalWikiService(ctx, config as never)).toThrow(/personal-wiki|absolute|search/i)
      await ctx.fiber.restart()
    }
    const fixture = await harness()
    const current = agent({ cwd: '/work/alpha', preset: 'primary' })
    await fixture.ctx.fiber.restart()
    expect(() => fixture.service.search(current, { query: 'after dispose' })).toThrow(/disposed/i)
  })

  test('ships one short self-contained workflow skill with no automatic writes or broken resources', async () => {
    const { ctx } = await harness()
    const definition = await ctx.skills.get('personal-wiki-workflow')

    expect(definition).toMatchObject({
      name: 'personal-wiki-workflow',
      provider: 'runtime',
      content: PERSONAL_WIKI_SKILL,
    })
    expect(PERSONAL_WIKI_SKILL.length).toBeLessThan(2_500)
    for (const tool of ['wiki_search', 'wiki_read', 'wiki_upsert', 'wiki_lint']) {
      expect(PERSONAL_WIKI_SKILL).toContain(tool)
    }
    expect(PERSONAL_WIKI_SKILL).toContain('untrusted')
    expect(PERSONAL_WIKI_SKILL).not.toMatch(/automatic(?:ally)? (?:archive|commit|synchron)/i)
    expect(PERSONAL_WIKI_SKILL).not.toMatch(/(?:file|https?):\/\//)
    await ctx.fiber.restart()
  })
})
