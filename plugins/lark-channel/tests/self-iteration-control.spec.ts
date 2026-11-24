import { Context } from '@deepseek-ai/cordis'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import { LarkChannelService, applySelfIterationProfileToggle } from '../src/service.js'
import { normalizeLarkMessage } from '../src/normalize.js'
import type { LarkInboundConfig, LarkTransport } from '../src/types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const samplePatch = [
  '- id: dsh-enhanced-assistant-web-owner',
  '  name: "@dsh-enhanced/assistant-web-owner"',
  '- id: dsh-enhanced-owner-console',
  '  name: "@dsh-enhanced/owner-console"',
  '- id: dsh-enhanced-lark-channel',
  '  name: "@dsh-enhanced/lark-channel"',
  '- id: dsh-enhanced-assistant-delivery',
  '  name: "@dsh-enhanced/assistant-delivery"',
  '  config:',
  '    ownerRoutes:',
  '      - id: owner-route-1',
  '        conversation: { channel: lark, account: primary-bot, tenant: tenant-a, kind: dm, chat: oc_dm }',
  '- id: dsh-enhanced-personal-assistant',
  '  name: "@dsh-enhanced/personal-assistant"',
  '  config:',
  '    personalMemory:',
  "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
  '- id: dsh-enhanced-assistant-policy',
  '  name: "@dsh-enhanced/assistant-policy"',
  '- id: dsh-enhanced-assistant-goals',
  '  name: "@dsh-enhanced/assistant-goals"',
  '- id: dsh-enhanced-assistant-work-items',
  '  name: "@dsh-enhanced/assistant-work-items"',
  '  config:',
  '    enabled: true',
  '    mode: auto',
  '- id: dsh-enhanced-assistant-proactive',
  '  name: "@dsh-enhanced/assistant-proactive"',
  '- id: dsh-enhanced-assistant-growth-driver',
  '  name: "@dsh-enhanced/assistant-growth-driver"',
  '- id: dsh-enhanced-assistant-dreaming',
  '  name: "@dsh-enhanced/assistant-dreaming"',
  '- id: dsh-enhanced-assistant-memory-learning',
  '  name: "@dsh-enhanced/assistant-memory-learning"',
  '- id: dsh-enhanced-assistant-association',
  '  name: "@dsh-enhanced/assistant-association"',
  '- id: dsh-enhanced-assistant-evaluation',
  '  name: "@dsh-enhanced/assistant-evaluation"',
  '- id: dsh-enhanced-assistant-evolution',
  '  name: "@dsh-enhanced/assistant-evolution"',
  '- id: dsh-enhanced-preference-learning',
  '  name: "@dsh-enhanced/preference-learning"',
].join('\n') + '\n'

const protectedIds = [
  'dsh-enhanced-assistant-web-owner',
  'dsh-enhanced-owner-console',
  'dsh-enhanced-lark-channel',
  'dsh-enhanced-assistant-delivery',
  'dsh-enhanced-personal-assistant',
  'dsh-enhanced-assistant-policy',
  'dsh-enhanced-assistant-goals',
]

const toggledIds = [
  'dsh-enhanced-assistant-work-items',
  'dsh-enhanced-assistant-proactive',
  'dsh-enhanced-assistant-growth-driver',
  'dsh-enhanced-assistant-dreaming',
  'dsh-enhanced-assistant-memory-learning',
  'dsh-enhanced-assistant-association',
  'dsh-enhanced-assistant-evaluation',
  'dsh-enhanced-assistant-evolution',
  'dsh-enhanced-preference-learning',
]

describe('Lark self-iteration NL & slash controls', () => {
  test('toggles Contract 1 rows in cordis.patch.yml while keeping protected rows, !!js tags, and ownerRoutes intact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lark-toggle-patch-'))
    roots.push(home)
    const patchPath = join(home, 'profiles', 'lark', 'cordis.patch.yml')
    await mkdir(join(home, 'profiles', 'lark'), { recursive: true, mode: 0o700 })
    await writeFile(patchPath, samplePatch, { mode: 0o600 })

    const disabled = await applySelfIterationProfileToggle({ dshHome: home, profile: 'lark', enable: false })
    expect(disabled).toMatchObject({ ok: true, state: 'disabled' })
    const afterDisable = await readFile(patchPath, 'utf8')
    expect(afterDisable).toContain("!!js dshHomePath('personal-memory/memory.sqlite')")
    const disabledRows = parse(afterDisable) as Array<{ id: string; disabled?: boolean; config?: Record<string, any> }>
    for (const id of toggledIds) {
      expect(disabledRows.find(row => row.id === id)?.disabled).toBe(true)
    }
    expect(disabledRows.find(row => row.id === 'dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(false)
    for (const id of protectedIds) {
      expect(disabledRows.find(row => row.id === id)?.disabled).not.toBe(true)
    }
    expect(disabledRows.find(row => row.id === 'dsh-enhanced-assistant-delivery')?.config?.ownerRoutes).toHaveLength(1)

    const enabled = await applySelfIterationProfileToggle({ dshHome: home, profile: 'lark', enable: true })
    expect(enabled).toMatchObject({ ok: true, state: 'enabled' })
    const enabledRows = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, any> }>
    for (const id of toggledIds) {
      expect(enabledRows.find(row => row.id === id)?.disabled).toBeUndefined()
    }
    expect(enabledRows.find(row => row.id === 'dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(true)
  })

  test('toggles nested insert: sequences, clears retired flag, and guards assistant-dreaming enabled on 6 prerequisites + lineWidth: 0', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lark-toggle-insert-'))
    roots.push(home)
    const patchPath = join(home, 'profiles', 'lark', 'cordis.patch.yml')
    await mkdir(join(home, 'profiles', 'lark'), { recursive: true, mode: 0o700 })
    const longPath = '/data00/very/long/nested/workspace/path/exceeding/eighty/characters/to/verify/line-width-zero/no-wrap'
    const nestedPatch = [
      '- insert:',
      '    - id: dsh-enhanced-lark-channel',
      '      name: "@dsh-enhanced/lark-channel"',
      '    - id: dsh-enhanced-assistant-work-items',
      '      name: "@dsh-enhanced/assistant-work-items"',
      '      disabled: true',
      '      config:',
      '        enabled: false',
      '    - id: dsh-enhanced-assistant-dreaming',
      '      name: "@dsh-enhanced/assistant-dreaming"',
      '      disabled: true',
      '      config:',
      '        enabled: false',
      '        retired: true',
      `        databasePath: !!js dshHomePath('${longPath}/dreaming.sqlite')`,
    ].join('\n') + '\n'
    await writeFile(patchPath, nestedPatch, { mode: 0o600 })

    // 1. Incomplete dreaming prerequisites: clears disabled & retired, keeps enabled: false, preserves single-line !!js tag
    const enabled = await applySelfIterationProfileToggle({ dshHome: home, profile: 'lark', enable: true })
    expect(enabled).toMatchObject({ ok: true, state: 'enabled' })
    const afterEnableRaw = await readFile(patchPath, 'utf8')
    expect(afterEnableRaw).toContain(`!!js dshHomePath('${longPath}/dreaming.sqlite')`)
    const afterEnable = parse(afterEnableRaw) as Array<{
      insert?: Array<{ id: string; disabled?: boolean; config?: Record<string, any> }>
    }>
    const inserted = afterEnable[0]!.insert!
    expect(inserted.find(r => r.id === 'dsh-enhanced-lark-channel')?.disabled).toBeUndefined()
    expect(inserted.find(r => r.id === 'dsh-enhanced-assistant-work-items')).toMatchObject({
      config: { enabled: true },
    })
    expect(inserted.find(r => r.id === 'dsh-enhanced-assistant-work-items')?.disabled).toBeUndefined()
    const dreamingIncomplete = inserted.find(r => r.id === 'dsh-enhanced-assistant-dreaming')!
    expect(dreamingIncomplete.disabled).toBeUndefined()
    expect(dreamingIncomplete.config?.enabled).toBe(false)
    expect(dreamingIncomplete.config).not.toHaveProperty('retired')

    // 2. Complete dreaming prerequisites (all 6 fields including map scope): enables dreaming & clears retired
    const completeDreamPatch = [
      '- id: dsh-enhanced-assistant-dreaming',
      '  name: "@dsh-enhanced/assistant-dreaming"',
      '  disabled: true',
      '  config:',
      '    enabled: false',
      '    retired: true',
      '    scope:',
      '      workspace: /tmp/ws',
      '      preset: standard',
      '      principalId: lark/primary-bot/tenant-a/ou_owner',
      '      ownerRouteId: owner-route-1',
      "    databasePath: !js dshHomePath('assistant-dreaming/lark.sqlite')",
      '    provider: openai',
      '    model: gpt-5',
      '    budgetId: dreaming-daily',
      '    budgetAmount: 5',
    ].join('\n') + '\n'
    await writeFile(patchPath, completeDreamPatch, { mode: 0o600 })
    const enabledComplete = await applySelfIterationProfileToggle({ dshHome: home, profile: 'lark', enable: true })
    expect(enabledComplete).toMatchObject({ ok: true, state: 'enabled' })
    const afterComplete = parse(await readFile(patchPath, 'utf8')) as Array<{
      id: string; disabled?: boolean; config?: Record<string, any>
    }>
    expect(afterComplete[0]?.disabled).toBeUndefined()
    expect(afterComplete[0]?.config?.enabled).toBe(true)
    expect(afterComplete[0]?.config).not.toHaveProperty('retired')

    const disabled = await applySelfIterationProfileToggle({ dshHome: home, profile: 'lark', enable: false })
    expect(disabled).toMatchObject({ ok: true, state: 'disabled' })
    const afterDisable = parse(await readFile(patchPath, 'utf8')) as Array<{
      id: string; disabled?: boolean; config?: Record<string, any>
    }>
    expect(afterDisable[0]?.disabled).toBe(true)
    expect(afterDisable[0]?.config?.enabled).toBe(false)
  })

  test('fails closed on symlinked cordis.patch.yml, profiles/<profile>, and dshHome (including / and /.) and rejects invalid dreaming prerequisites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-toggle-hardening-'))
    roots.push(root)

    // 1. Symlinked cordis.patch.yml must fail closed without reading/mutating target or replacing symlink
    const homePatchLink = join(root, 'home-patch-link')
    await mkdir(join(homePatchLink, 'profiles', 'lark'), { recursive: true, mode: 0o700 })
    const victimPatch = join(root, 'victim-patch.yml')
    const victimInitial = '- id: dsh-enhanced-assistant-work-items\n  name: "@dsh-enhanced/assistant-work-items"\n  config:\n    enabled: true\n'
    await writeFile(victimPatch, victimInitial, { mode: 0o600 })
    const patchSymlink = join(homePatchLink, 'profiles', 'lark', 'cordis.patch.yml')
    await symlink(victimPatch, patchSymlink)
    const patchLinkRes = await applySelfIterationProfileToggle({ dshHome: homePatchLink, profile: 'lark', enable: false })
    expect(patchLinkRes.ok).toBe(false)
    expect((await lstat(patchSymlink)).isSymbolicLink()).toBe(true)
    expect(await readFile(victimPatch, 'utf8')).toBe(victimInitial)

    // 2. Symlinked profiles/<profile> must fail closed without mutating outside directory
    const homeProfileLink = join(root, 'home-profile-link')
    await mkdir(join(homeProfileLink, 'profiles'), { recursive: true, mode: 0o700 })
    const outsideProfile = join(root, 'outside-profile')
    await mkdir(outsideProfile, { recursive: true, mode: 0o700 })
    const outsidePatch = join(outsideProfile, 'cordis.patch.yml')
    await writeFile(outsidePatch, victimInitial, { mode: 0o600 })
    await symlink(outsideProfile, join(homeProfileLink, 'profiles', 'lark'))
    const profileLinkRes = await applySelfIterationProfileToggle({ dshHome: homeProfileLink, profile: 'lark', enable: false })
    expect(profileLinkRes.ok).toBe(false)
    expect(await readFile(outsidePatch, 'utf8')).toBe(victimInitial)

    // 3. Symlinked dshHome (exact, trailing /, and trailing /.) must fail closed without mutating target
    const realHome = join(root, 'real-home')
    await mkdir(join(realHome, 'profiles', 'lark'), { recursive: true, mode: 0o700 })
    const realPatch = join(realHome, 'profiles', 'lark', 'cordis.patch.yml')
    await writeFile(realPatch, victimInitial, { mode: 0o600 })
    const symlinkHome = join(root, 'symlink-home')
    await symlink(realHome, symlinkHome)
    for (const suffix of ['', '/', '/.']) {
      const res = await applySelfIterationProfileToggle({ dshHome: `${symlinkHome}${suffix}`, profile: 'lark', enable: false })
      expect(res.ok, `symlink dshHome suffix=${suffix}`).toBe(false)
      expect(await readFile(realPatch, 'utf8')).toBe(victimInitial)
    }
    // Real dshHome with trailing / and /. succeeds
    for (const suffix of ['/', '/.']) {
      const res = await applySelfIterationProfileToggle({ dshHome: `${realHome}${suffix}`, profile: 'lark', enable: false })
      expect(res.ok, `real dshHome suffix=${suffix}`).toBe(true)
    }

    // 4. Invalid dreaming prerequisites (string scope, relative/non-canonical paths, budgetAmount > 10_000_000) keep enabled: false
    const invalidCases = [
      {
        name: 'string scope',
        yaml: [
          '- id: dsh-enhanced-assistant-dreaming',
          '  name: "@dsh-enhanced/assistant-dreaming"',
          '  disabled: true',
          '  config:',
          '    enabled: false',
          '    retired: false',
          '    scope: owner-scope',
          '    databasePath: /tmp/dream.sqlite',
          '    provider: openai',
          '    model: gpt-5',
          '    budgetId: dreaming-daily',
          '    budgetAmount: 5000',
        ].join('\n') + '\n',
      },
      {
        name: 'relative paths',
        yaml: [
          '- id: dsh-enhanced-assistant-dreaming',
          '  name: "@dsh-enhanced/assistant-dreaming"',
          '  disabled: true',
          '  config:',
          '    enabled: false',
          '    scope:',
          '      workspace: relative/ws',
          '      preset: standard',
          '      principalId: lark/primary/t/u',
          '      ownerRouteId: route-1',
          '    databasePath: relative/dream.sqlite',
          '    provider: openai',
          '    model: gpt-5',
          '    budgetId: dreaming-daily',
          '    budgetAmount: 5000',
        ].join('\n') + '\n',
      },
      {
        name: 'non-canonical workspace and oversized budgetAmount',
        yaml: [
          '- id: dsh-enhanced-assistant-dreaming',
          '  name: "@dsh-enhanced/assistant-dreaming"',
          '  disabled: true',
          '  config:',
          '    enabled: false',
          '    scope:',
          '      workspace: /tmp/ws/../other',
          '      preset: standard',
          '      principalId: lark/primary/t/u',
          '      ownerRouteId: route-1',
          '    databasePath: /tmp/dream.sqlite',
          '    provider: openai',
          '    model: gpt-5',
          '    budgetId: dreaming-daily',
          '    budgetAmount: 99999999',
        ].join('\n') + '\n',
      },
    ]
    for (const c of invalidCases) {
      await writeFile(realPatch, c.yaml, { mode: 0o600 })
      const res = await applySelfIterationProfileToggle({ dshHome: realHome, profile: 'lark', enable: true })
      expect(res.ok, c.name).toBe(true)
      const parsed = parse(await readFile(realPatch, 'utf8')) as Array<{ config?: Record<string, unknown> }>
      expect(parsed[0]?.config?.enabled, c.name).toBe(false)
      expect(parsed[0]?.config, c.name).not.toHaveProperty('retired')
    }
  })

  test('LarkChannelService wires owner-authorized DM and mentioned group NL/slash controls without waking the LLM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-service-autonomy-'))
    roots.push(root)
    const home = join(root, 'dsh-home')
    const patchPath = join(home, 'profiles', 'lark', 'cordis.patch.yml')
    await mkdir(join(home, 'profiles', 'lark'), { recursive: true, mode: 0o700 })
    await writeFile(patchPath, samplePatch, { mode: 0o600 })

    const ctx = new Context()
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
          resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
        { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-a/ou_owner' },
          actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
        { id: 'linked', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-a/ou_linked' },
          actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
        { id: 'reply-owner', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: 'lark/primary-bot/tenant-a/ou_owner' },
          actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground', 'external'] } },
        { id: 'reply-linked', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: 'lark/primary-bot/tenant-a/ou_linked' },
          actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground', 'external'] } },
      ],
    })
    const llmRequests: unknown[] = []
    ctx.provide('agents' as never, {
      create: async (opts: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; setup?: (agentCtx: Context, agent?: unknown) => Promise<unknown> }) => {
        const id = opts.sessionId
        const session = {
          id,
          header: { id, cwd: opts.meta?.cwd ?? workspace, agentPreset: opts.meta?.agentPreset ?? 'primary' },
          append: () => {},
          snapshotEvents: () => [],
          deriveMessages: () => [],
        }
        const agent = {
          id,
          ctx,
          session,
          model: { select: () => {}, current: () => ({ provider: 'fixture', model: 'fixture' }) },
          status: 'idle',
          whenIdle: async () => {},
          runMaintenance: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal),
          cancel: () => {},
        }
        await opts.setup?.(ctx, agent)
        return { agent, dispose: async () => {} }
      },
      resume: vi.fn(async () => { throw new Error('LLM should not wake for control commands') }),
    } as never)
    ctx.provide('sessions' as never, {
      list: async () => [],
      flush: async () => true,
    } as never)
    ctx.provide('llm' as never, {
      complete: async (req: unknown) => { llmRequests.push(req); return {} },
    } as never)

    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      defaultWorkspace: workspace,
      defaultAgentPreset: 'primary',
      schedulerEnabled: false,
    })

    const sends: Array<{ text: string }> = []
    const transport: LarkTransport = {
      subscribe: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'reaction-1',
      createProgress: async () => ({ cotId: 'cot-1', messageId: 'om_cot' }),
      writeProgress: async () => {},
      send: async (_chatId, input) => {
        sends.push({ text: 'text' in input ? input.text : JSON.stringify(input) })
        return { messageId: `om_out_${sends.length}` }
      },
    }
    const drive = async () => {
      await delivery.tick()
      await delivery.whenIdle()
      await delivery.tick()
      await delivery.whenIdle()
    }
    const runUpgrade = vi.fn(async () => ({ ok: true as const, state: 'upgraded' as const, message: '升级完成并已恢复。' }))
    const service = new LarkChannelService(ctx, {
      enabled: true,
      account: 'primary-bot',
      tenant: 'tenant-a',
      appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET',
    }, {
      env: { LARK_APP_SECRET: 'secret-value' },
      createTransport: () => transport,
      writeLifecycleMarker: () => {},
      dshHome: home,
      profile: 'lark',
      runUpgrade,
    })
    await service.whenReady()

    const delivery = ctx.assistantDelivery
    const ownerPrincipal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' }
    const ownerPairing = delivery.issuePairing('test', ownerPrincipal)
    delivery.confirmPairing({ challengeId: ownerPairing.challenge.id, principal: ownerPrincipal, code: ownerPairing.code })

    const linkedPrincipal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_linked' }
    const linkedPairing = delivery.issuePairing('test', linkedPrincipal)
    delivery.confirmPairing({ challengeId: linkedPairing.challenge.id, principal: linkedPrincipal, code: linkedPairing.code })

    const inboundConfig: LarkInboundConfig = {
      account: 'primary-bot',
      tenant: 'tenant-a',
      requireMentionInGroups: true,
      maxTextBytes: 4096,
      staleAfterMs: 300_000,
    }
    const now = Date.now()

    // Non-owner (linked) group command fails closed without modifying cordis.patch.yml
    const nonOwnerGroup = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_non_owner',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_linked',
      content: '@_user_1 关闭自迭代',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: now,
    }, now)
    expect(nonOwnerGroup.outcome).toBe('accept')
    if (nonOwnerGroup.outcome === 'accept') await delivery.acceptInbound(nonOwnerGroup.envelope)
    await drive()
    expect(sends.at(-1)?.text).toContain('当前身份不是此会话的 owner')
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-enhanced-assistant-work-items').disabled).toBeUndefined()

    // Owner group @bot uppercase slash command disables self-iteration
    const ownerUpperDisable = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_owner_upper_disable',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_owner',
      content: '@_user_1 /AUTONOMY DISABLE',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: now + 1,
    }, now + 1)
    expect(ownerUpperDisable.outcome).toBe('accept')
    if (ownerUpperDisable.outcome === 'accept') await delivery.acceptInbound(ownerUpperDisable.envelope)
    await drive()
    expect(sends.at(-1)?.text).toContain('已关闭')
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-enhanced-assistant-work-items').disabled).toBe(true)

    // Re-enable before testing lowercase /autonomy disable
    const ownerRestore = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_owner_restore',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '开启自迭代',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now + 2,
    }, now + 2)
    expect(ownerRestore.outcome).toBe('accept')
    if (ownerRestore.outcome === 'accept') await delivery.acceptInbound(ownerRestore.envelope)
    await drive()
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-enhanced-assistant-work-items').disabled).toBeUndefined()

    // Owner group @bot slash command disables self-iteration
    const ownerDisable = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_owner_disable',
      chatId: 'oc_group',
      chatType: 'group',
      senderId: 'ou_owner',
      content: '@_user_1 /autonomy disable',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: now + 3,
    }, now + 3)
    expect(ownerDisable.outcome).toBe('accept')
    if (ownerDisable.outcome === 'accept') await delivery.acceptInbound(ownerDisable.envelope)
    await drive()
    expect(sends.at(-1)?.text).toContain('已关闭')
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-enhanced-assistant-work-items').disabled).toBe(true)

    // Owner DM NL command re-enables self-iteration
    const ownerEnable = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_owner_enable',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '开启自迭代',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now + 4,
    }, now + 4)
    expect(ownerEnable.outcome).toBe('accept')
    if (ownerEnable.outcome === 'accept') await delivery.acceptInbound(ownerEnable.envelope)
    await drive()
    expect(sends.at(-1)?.text).toContain('已开启')
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-enhanced-assistant-work-items').disabled).toBeUndefined()

    // Owner DM NL upgrade invokes runUpgrade
    const ownerUpgrade = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_owner_upgrade',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '升级整体助手',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now + 5,
    }, now + 5)
    expect(ownerUpgrade.outcome).toBe('accept')
    if (ownerUpgrade.outcome === 'accept') await delivery.acceptInbound(ownerUpgrade.envelope)
    await drive()
    expect(runUpgrade).toHaveBeenCalledWith({ dshHome: home, profile: 'lark' })
    expect(sends.at(-1)?.text).toContain('升级完成并已恢复')
    expect(llmRequests).toEqual([])

    await ctx.fiber.restart()
  })

  test('LarkChannelService delegates to ownerConsole.controlSelfIteration(action, true) and maps note -> message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-service-owner-console-'))
    roots.push(root)
    const ctx = new Context()
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' }, actions: ['pair.issue'],
          resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
        { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-a/ou_owner' },
          actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
        { id: 'reply-owner', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: 'lark/primary-bot/tenant-a/ou_owner' },
          actions: ['history', 'reply'], resource: { kind: 'message', id: '*' }, context: { initiators: ['foreground', 'external'] } },
      ],
    })
    ctx.provide('agents' as never, {
      create: async (opts: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; setup?: (agentCtx: Context, agent?: unknown) => Promise<unknown> }) => {
        const id = opts.sessionId
        const session = {
          id,
          header: { id, cwd: opts.meta?.cwd ?? workspace, agentPreset: opts.meta?.agentPreset ?? 'primary' },
          append: () => {},
          snapshotEvents: () => [],
          deriveMessages: () => [],
        }
        const agent = {
          id, ctx, session,
          model: { select: () => {}, current: () => ({ provider: 'fixture', model: 'fixture' }) },
          status: 'idle', whenIdle: async () => {},
          runMaintenance: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal),
          cancel: () => {},
        }
        await opts.setup?.(ctx, agent)
        return { agent, dispose: async () => {} }
      },
      resume: vi.fn(async () => { throw new Error('LLM should not wake') }),
    } as never)
    ctx.provide('sessions' as never, { list: async () => [], flush: async () => true } as never)
    ctx.provide('llm' as never, { complete: async () => ({}) } as never)

    const controlSelfIteration = vi.fn(async (action: string, confirmed: boolean) => ({
      ok: true,
      action,
      state: 'disabled' as const,
      note: `delegated:${action}:${confirmed}`,
    }))
    ctx.provide('ownerConsole' as never, { controlSelfIteration } as never)

    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      defaultWorkspace: workspace,
      defaultAgentPreset: 'primary',
      schedulerEnabled: false,
    })

    const sends: Array<{ text: string }> = []
    const transport: LarkTransport = {
      subscribe: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'reaction-1',
      createProgress: async () => ({ cotId: 'cot-1', messageId: 'om_cot' }),
      writeProgress: async () => {},
      send: async (_chatId, input) => {
        sends.push({ text: 'text' in input ? input.text : JSON.stringify(input) })
        return { messageId: `om_out_${sends.length}` }
      },
    }
    const service = new LarkChannelService(ctx, {
      enabled: true,
      account: 'primary-bot',
      tenant: 'tenant-a',
      appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET',
    }, {
      env: { LARK_APP_SECRET: 'secret-value' },
      createTransport: () => transport,
      writeLifecycleMarker: () => {},
    })
    await service.whenReady()

    const delivery = ctx.assistantDelivery
    const ownerPrincipal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' }
    const ownerPairing = delivery.issuePairing('test', ownerPrincipal)
    delivery.confirmPairing({ challengeId: ownerPairing.challenge.id, principal: ownerPrincipal, code: ownerPairing.code })

    const inboundConfig: LarkInboundConfig = {
      account: 'primary-bot',
      tenant: 'tenant-a',
      requireMentionInGroups: true,
      maxTextBytes: 4096,
      staleAfterMs: 300_000,
    }
    const now = Date.now()
    const accepted = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_delegate_owner_console',
      chatId: 'oc_dm',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '关闭自迭代',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now,
    }, now)
    expect(accepted.outcome).toBe('accept')
    if (accepted.outcome === 'accept') await delivery.acceptInbound(accepted.envelope)
    await delivery.tick()
    await delivery.whenIdle()
    await delivery.tick()
    await delivery.whenIdle()

    expect(controlSelfIteration).toHaveBeenCalledOnce()
    expect(controlSelfIteration).toHaveBeenCalledWith('disableSelfIteration', true)
    expect(sends.at(-1)?.text).toBe('delegated:disableSelfIteration:true')
    await ctx.fiber.restart()
  })
})
