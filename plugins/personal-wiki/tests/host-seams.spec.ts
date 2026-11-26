import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PersonalWikiService, type WikiPageChangeEvent } from '../src/service.ts'

const temporaryRoots: string[] = []

function agent(options: { cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId(`wiki-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  return {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
    ctx: new Context(),
    status: 'idle',
    model: { current: () => ({ provider: 'mock', model: 'mock' }), select: () => {} },
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'personal-wiki-host-seams-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [{
      id: 'allow-wiki-service',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['lint', 'propose', 'read', 'rebuild', 'search'],
      resource: { kind: 'wiki', id: '*' },
    }],
  })
  await ctx.plugin(PersonalWikiService, {
    vaultRoot: join(root, 'vault'),
    databasePath: join(root, 'wiki.sqlite'),
    defaultProposalTtlMs: 60_000,
    reconcileIntervalMs: 0,
  })
  return { ctx, root, service: ctx.personalWiki }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function pageInput(title = 'Host seam page', status: 'active' | 'archived' | 'draft' = 'active') {
  return {
    title,
    type: 'concept' as const,
    authority: 'curated' as const,
    status,
    tags: ['host-seam'],
    aliases: [],
    sources: [{ uri: 'https://example.test/host-seam', sha256: 'a'.repeat(64) }],
    body: `# ${title}\n\nVerified wiki content.`,
  }
}

describe('personal-wiki host read and change seams', () => {
  test('inspectHostPages refreshes vault, excludes archived pages by default, and supports includeArchived', async () => {
    const { ctx, root, service } = await harness()
    const fixture = agent({ cwd: '/work/alpha', preset: 'primary' })

    const activeProposal = service.propose(fixture, {
      idempotencyKey: 'host:active',
      principal: 'owner:lark:1',
      mutation: { op: 'create', input: pageInput('Active concept', 'active') },
    })
    const activePage = service.decideProposal({
      proposalId: activeProposal.proposalId,
      principal: 'owner:lark:1',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    }).page!

    const archivedProposal = service.propose(fixture, {
      idempotencyKey: 'host:archived',
      principal: 'owner:lark:1',
      mutation: { op: 'create', input: pageInput('Archived concept', 'archived') },
    })
    const archivedPage = service.decideProposal({
      proposalId: archivedProposal.proposalId,
      principal: 'owner:lark:1',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    }).page!

    const defaultPages = service.inspectHostPages()
    expect(Object.isFrozen(defaultPages)).toBe(true)
    expect(defaultPages.map(page => page.metadata.id)).toEqual([activePage.metadata.id])

    const allPages = service.inspectHostPages({ includeArchived: true })
    expect(allPages.map(page => page.metadata.id).sort()).toEqual(
      [activePage.metadata.id, archivedPage.metadata.id].sort(),
    )

    // Corrupt external file does not crash inspectHostPages; retains last valid snapshot
    await writeFile(join(root, 'vault', 'wiki', 'concepts', 'corrupt.md'), 'not-frontmatter', { mode: 0o600 })
    expect(service.inspectHostPages().map(page => page.metadata.id)).toEqual([activePage.metadata.id])

    await ctx.fiber.restart()
    expect(() => service.inspectHostPages()).toThrow(/disposed/i)
  })

  test('onPageChange fires on proposal commits and external rebuild diffs (added, updated, archived, deleted) with listener isolation', async () => {
    const { ctx, root, service } = await harness()
    const fixture = agent({ cwd: '/work/alpha', preset: 'primary' })
    const events: WikiPageChangeEvent[] = []

    const unsubThrowing = service.onPageChange(() => {
      throw new Error('boom')
    })
    const unsub = service.onPageChange(event => {
      events.push(event)
    })

    // 1. Added via proposal commit
    const create = service.propose(fixture, {
      idempotencyKey: 'change:create',
      principal: 'owner:lark:1',
      mutation: { op: 'create', input: pageInput('Observed page', 'active') },
    })
    const created = service.decideProposal({
      proposalId: create.proposalId,
      principal: 'owner:lark:1',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    }).page!

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'added',
      pageId: created.metadata.id,
      revision: created.revision,
      status: 'active',
    })

    // 2. Updated externally and detected via rebuild/inspectHostPages
    const filePath = join(root, 'vault', created.relativePath)
    const raw = await readFile(filePath, 'utf8')
    await writeFile(`${filePath}.tmp`, raw.replace('Verified wiki content.', 'Updated external content.'), { mode: 0o600 })
    await rename(`${filePath}.tmp`, filePath)
    service.inspectHostPages()

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      kind: 'updated',
      pageId: created.metadata.id,
      previousRevision: created.revision,
      status: 'active',
    })

    // 3. Archived via proposal commit
    const currentRevision = events[1]!.revision!
    const archive = service.propose(fixture, {
      idempotencyKey: 'change:archive',
      principal: 'owner:lark:1',
      mutation: {
        op: 'update',
        pageId: created.metadata.id,
        expectedRevision: currentRevision,
        input: pageInput('Observed page', 'archived'),
      },
    })
    service.decideProposal({
      proposalId: archive.proposalId,
      principal: 'owner:lark:1',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'archive',
    })

    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({
      kind: 'archived',
      pageId: created.metadata.id,
      status: 'archived',
      previousStatus: 'active',
    })

    // 4. Deleted externally and detected via rebuild
    await rm(filePath)
    service.rebuild(fixture)

    expect(events).toHaveLength(4)
    expect(events[3]).toMatchObject({
      kind: 'deleted',
      pageId: created.metadata.id,
      previousStatus: 'archived',
    })

    // Unsubscribe is idempotent and stops further notifications
    unsub()
    unsub()
    unsubThrowing()

    const second = service.propose(fixture, {
      idempotencyKey: 'change:after-unsub',
      principal: 'owner:lark:1',
      mutation: { op: 'create', input: pageInput('Unobserved page', 'active') },
    })
    service.decideProposal({
      proposalId: second.proposalId,
      principal: 'owner:lark:1',
      expectedVersion: 1,
      decision: 'approved',
      reason: 'reviewed',
    })
    expect(events).toHaveLength(4)

    await ctx.fiber.restart()
    expect(() => service.onPageChange(() => {})).toThrow(/disposed/i)
  })
})
