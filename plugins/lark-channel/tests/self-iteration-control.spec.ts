import { Context } from '@deepseek-ai/cordis'
import { AssistantDeliveryService } from '@dsh-ray/assistant-delivery'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { existsSync } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import { LarkChannelService, applySelfIterationProfileToggle } from '../src/service.js'
import { normalizeLarkMessage } from '../src/normalize.js'
import type { LarkInboundConfig, LarkSendInput, LarkTransport, LarkTransportHandlers } from '../src/types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const samplePatch = [
  '- id: dsh-ray-assistant-web-owner',
  '  name: "@dsh-ray/assistant-web-owner"',
  '- id: dsh-ray-owner-console',
  '  name: "@dsh-ray/owner-console"',
  '- id: dsh-ray-lark-channel',
  '  name: "@dsh-ray/lark-channel"',
  '- id: dsh-ray-assistant-delivery',
  '  name: "@dsh-ray/assistant-delivery"',
  '  config:',
  '    ownerRoutes:',
  '      - id: owner-route-1',
  '        conversation: { channel: lark, account: primary-bot, tenant: tenant-a, kind: dm, chat: oc_dm }',
  '- id: dsh-ray-personal-assistant',
  '  name: "@dsh-ray/personal-assistant"',
  '  config:',
  '    personalMemory:',
  "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
  '- id: dsh-ray-assistant-policy',
  '  name: "@dsh-ray/assistant-policy"',
  '- id: dsh-ray-assistant-goals',
  '  name: "@dsh-ray/assistant-goals"',
  '- id: dsh-ray-assistant-work-items',
  '  name: "@dsh-ray/assistant-work-items"',
  '  config:',
  '    enabled: true',
  '    mode: auto',
  '- id: dsh-ray-assistant-proactive',
  '  name: "@dsh-ray/assistant-proactive"',
  '- id: dsh-ray-assistant-growth-driver',
  '  name: "@dsh-ray/assistant-growth-driver"',
  '- id: dsh-ray-assistant-dreaming',
  '  name: "@dsh-ray/assistant-dreaming"',
  '- id: dsh-ray-assistant-memory-learning',
  '  name: "@dsh-ray/assistant-memory-learning"',
  '- id: dsh-ray-assistant-association',
  '  name: "@dsh-ray/assistant-association"',
  '- id: dsh-ray-assistant-evaluation',
  '  name: "@dsh-ray/assistant-evaluation"',
  '- id: dsh-ray-assistant-evolution',
  '  name: "@dsh-ray/assistant-evolution"',
  '- id: dsh-ray-preference-learning',
  '  name: "@dsh-ray/preference-learning"',
].join('\n') + '\n'

const protectedIds = [
  'dsh-ray-assistant-web-owner',
  'dsh-ray-owner-console',
  'dsh-ray-lark-channel',
  'dsh-ray-assistant-delivery',
  'dsh-ray-personal-assistant',
  'dsh-ray-assistant-policy',
  'dsh-ray-assistant-goals',
]

const toggledIds = [
  'dsh-ray-assistant-work-items',
  'dsh-ray-assistant-proactive',
  'dsh-ray-assistant-growth-driver',
  'dsh-ray-assistant-dreaming',
  'dsh-ray-assistant-memory-learning',
  'dsh-ray-assistant-association',
  'dsh-ray-assistant-evaluation',
  'dsh-ray-assistant-evolution',
  'dsh-ray-preference-learning',
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
    expect(disabledRows.find(row => row.id === 'dsh-ray-assistant-work-items')?.config?.enabled).toBe(false)
    for (const id of protectedIds) {
      expect(disabledRows.find(row => row.id === id)?.disabled).not.toBe(true)
    }
    expect(disabledRows.find(row => row.id === 'dsh-ray-assistant-delivery')?.config?.ownerRoutes).toHaveLength(1)

    const enabled = await applySelfIterationProfileToggle({ dshHome: home, profile: 'lark', enable: true })
    expect(enabled).toMatchObject({ ok: true, state: 'enabled' })
    const enabledRows = parse(await readFile(patchPath, 'utf8')) as Array<{ id: string; disabled?: boolean; config?: Record<string, any> }>
    for (const id of toggledIds) {
      expect(enabledRows.find(row => row.id === id)?.disabled).toBeUndefined()
    }
    expect(enabledRows.find(row => row.id === 'dsh-ray-assistant-work-items')?.config?.enabled).toBe(true)
  })

  test('toggles nested insert: sequences, clears retired flag, and guards assistant-dreaming enabled on 6 prerequisites + lineWidth: 0', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lark-toggle-insert-'))
    roots.push(home)
    const patchPath = join(home, 'profiles', 'lark', 'cordis.patch.yml')
    await mkdir(join(home, 'profiles', 'lark'), { recursive: true, mode: 0o700 })
    const longPath = '/data00/very/long/nested/workspace/path/exceeding/eighty/characters/to/verify/line-width-zero/no-wrap'
    const nestedPatch = [
      '- insert:',
      '    - id: dsh-ray-lark-channel',
      '      name: "@dsh-ray/lark-channel"',
      '    - id: dsh-ray-assistant-work-items',
      '      name: "@dsh-ray/assistant-work-items"',
      '      disabled: true',
      '      config:',
      '        enabled: false',
      '    - id: dsh-ray-assistant-dreaming',
      '      name: "@dsh-ray/assistant-dreaming"',
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
    expect(inserted.find(r => r.id === 'dsh-ray-lark-channel')?.disabled).toBeUndefined()
    expect(inserted.find(r => r.id === 'dsh-ray-assistant-work-items')).toMatchObject({
      config: { enabled: true },
    })
    expect(inserted.find(r => r.id === 'dsh-ray-assistant-work-items')?.disabled).toBeUndefined()
    const dreamingIncomplete = inserted.find(r => r.id === 'dsh-ray-assistant-dreaming')!
    expect(dreamingIncomplete.disabled).toBeUndefined()
    expect(dreamingIncomplete.config?.enabled).toBe(false)
    expect(dreamingIncomplete.config).not.toHaveProperty('retired')

    // 2. Complete dreaming prerequisites (all 6 fields including map scope): enables dreaming & clears retired
    const completeDreamPatch = [
      '- id: dsh-ray-assistant-dreaming',
      '  name: "@dsh-ray/assistant-dreaming"',
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
    const victimInitial = '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  config:\n    enabled: true\n'
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
          '- id: dsh-ray-assistant-dreaming',
          '  name: "@dsh-ray/assistant-dreaming"',
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
          '- id: dsh-ray-assistant-dreaming',
          '  name: "@dsh-ray/assistant-dreaming"',
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
          '- id: dsh-ray-assistant-dreaming',
          '  name: "@dsh-ray/assistant-dreaming"',
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
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-ray-assistant-work-items').disabled).toBeUndefined()

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
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-ray-assistant-work-items').disabled).toBe(true)

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
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-ray-assistant-work-items').disabled).toBeUndefined()

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
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-ray-assistant-work-items').disabled).toBe(true)

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
    expect(parse(await readFile(patchPath, 'utf8')).find((r: { id: string }) => r.id === 'dsh-ray-assistant-work-items').disabled).toBeUndefined()

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

  test('LarkChannelService routes DM and @bot group /version, /autonomy version, and NL queries without waking LLM (with and without ownerConsole)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-service-version-query-'))
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
          id, ctx, session,
          model: { select: () => {}, current: () => ({ provider: 'fixture', model: 'fixture' }) },
          status: 'idle', whenIdle: async () => {},
          runMaintenance: (fn: (signal: AbortSignal) => unknown) => fn(new AbortController().signal),
          cancel: () => {},
        }
        await opts.setup?.(ctx, agent)
        return { agent, dispose: async () => {} }
      },
      resume: vi.fn(async () => { throw new Error('LLM should not wake for version queries') }),
    } as never)
    ctx.provide('sessions' as never, { list: async () => [], flush: async () => true } as never)
    ctx.provide('llm' as never, { complete: async (req: unknown) => { llmRequests.push(req); return {} } } as never)

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
    const drive = async () => {
      await delivery.tick()
      await delivery.whenIdle()
      await delivery.tick()
      await delivery.whenIdle()
    }
    const now = Date.now()

    // 1. Standalone (without ownerConsole): DM /version & NL self-iteration query + @bot group linked /autonomy version
    const cases: Array<{ id: string; chatType: 'p2p' | 'group'; sender: string; content: string; mentioned: boolean }> = [
      { id: 'om_ver_dm', chatType: 'p2p', sender: 'ou_owner', content: '/version', mentioned: false },
      { id: 'om_ver_nl_dm', chatType: 'p2p', sender: 'ou_owner', content: '自己迭代了多少次？', mentioned: false },
      { id: 'om_ver_group_linked', chatType: 'group', sender: 'ou_linked', content: '@_user_1 /autonomy version', mentioned: true },
      { id: 'om_ver_group_nl_owner', chatType: 'group', sender: 'ou_owner', content: '@_user_1 查看版本', mentioned: true },
    ]
    for (const [index, entry] of cases.entries()) {
      const normalized = normalizeLarkMessage(inboundConfig, {
        messageId: entry.id,
        chatId: entry.chatType === 'p2p' ? `oc_dm_${entry.sender}` : 'oc_group',
        chatType: entry.chatType,
        senderId: entry.sender,
        content: entry.content,
        rawContentType: 'text',
        resources: [],
        mentionAll: false,
        mentionedBot: entry.mentioned,
        createTime: now + index,
      }, now + index)
      expect(normalized.outcome).toBe('accept')
      if (normalized.outcome === 'accept') await delivery.acceptInbound(normalized.envelope)
      await drive()
      const reply = sends.at(-1)?.text ?? ''
      expect(reply).toContain('助手版本：dsh-ray v')
      expect(reply).toContain('自迭代演进统计')
      expect(reply).not.toContain('自迭代控制服务尚未启用')
    }

    // 2. With ownerConsole.versionInfo registered: delegates cleanly
    const versionInfo = vi.fn(async () => ({
      schemaVersion: 1 as const,
      protocol: 'dsh-ray/version/v1' as const,
      generatedAt: now + 100,
      assistant: { name: 'dsh-ray' as const, version: '0.1.83' },
      host: { packageName: '@deepseek-ai/dsh' as const, boundVersion: '0.2.2-rc.5', boundStatus: 'ready', runningVersion: '0.2.2-rc.5' },
      profile: 'lark',
      plugins: { state: 'ok' as const, coreCount: 36, evolvedCount: 2, activeEvolvedCount: 2, core: [], evolved: [] },
      selfIteration: {
        dataState: 'data' as const,
        totalIterations: 11,
        workItemsTotal: 4,
        workItemsSettled: 3,
        growthUsageJobsTotal: 2,
        dreamingRuns: 1,
        recoveryRuns: 1,
        goalStrategyRuns: 1,
        candidatesGenerated: 2,
        candidatesAdopted: 1,
        pluginsCreated: 1,
        pluginsRevised: 0,
        taskVerificationsDone: 1,
        rollbacks: 0,
        evolutionRulesAdopted: 2,
        associationParamVersion: 4,
        associationProfileAdoptions: 2,
        evaluationAttentionTuningAdoptions: 1,
        evaluationLooseningDecisionsAdopted: 1,
        activeMemories: 9,
        activePreferenceOverlays: 2,
        workflowCandidatesPromoted: 1,
        skillDeployments: 1,
        selfUpgrades: 1,
        backupSnapshotsCount: 2,
      },
    }))
    ctx.provide('ownerConsole' as never, { versionInfo } as never)

    const delegated = normalizeLarkMessage(inboundConfig, {
      messageId: 'om_ver_delegated',
      chatId: 'oc_dm_ou_owner',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '/version',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now + 20,
    }, now + 20)
    expect(delegated.outcome).toBe('accept')
    if (delegated.outcome === 'accept') await delivery.acceptInbound(delegated.envelope)
    await drive()

    expect(versionInfo).toHaveBeenCalledOnce()
    expect(sends.at(-1)?.text).toContain('累计自迭代次数：11')
    expect(sends.at(-1)?.text).toContain('核心插件 36 个')
    expect(llmRequests).toEqual([])
    await ctx.fiber.restart()
  })

  test('LarkChannelService routes /update & /upgrade via shared auto-update launcher, rejects /update foo, and reconciles completion & rollback notices on connect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-auto-update-reconcile-'))
    roots.push(root)
    const home = join(root, 'dsh-home')
    const workspace = join(root, 'workspace')
    await mkdir(join(home, 'profiles', 'web', '.dsh'), { recursive: true })
    await mkdir(join(home, '.dsh-ray'), { recursive: true, mode: 0o700 })
    await mkdir(workspace, { recursive: true })

    // Use real CLI auto-update helpers via dynamic import of built packages/cli
    const {
      autoUpdateNotifyPath,
      autoUpdateStatusPath,
      clearAutoUpdateNotifyMarker,
      inspectPendingAutoUpdateNotification,
      launchUnattendedAutoUpgrade,
    } = await import('../../../packages/cli/lib/index.js')

    // Seed a completed run BEFORE LarkChannelService connects to test startup reconciliation
    const completedRunId = 'auto-update-boot-ok'
    await writeFile(autoUpdateNotifyPath(home), JSON.stringify({
      schemaVersion: 1,
      runId: completedRunId,
      channel: 'lark',
      account: 'primary-bot',
      chatId: 'oc_dm_ou_owner',
      requestedAt: new Date(Date.now() - 5_000).toISOString(),
    }), { mode: 0o600 })
    await writeFile(autoUpdateStatusPath(home), JSON.stringify({
      schemaVersion: 1,
      runId: completedRunId,
      status: 'succeeded',
      version: '0.2.2',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }), { mode: 0o600 })

    const ctx = new Context()
    const sends: Array<{ chatId: string; input: LarkSendInput }> = []
    let handlers: LarkTransportHandlers | undefined
    const transport: LarkTransport = {
      subscribe: next => {
        handlers = next
        return () => { handlers = undefined }
      },
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'r1',
      createProgress: async () => ({ cotId: 'cot1', messageId: 'om_cot1' }),
      writeProgress: async () => {},
      send: async (chatId, input) => {
        sends.push({ chatId, input })
        return { messageId: `om_s_${sends.length}` }
      },
    }

    const llmRequests: unknown[] = []
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:owner' }, actions: ['pair.issue'],
          resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
        { id: 'owner', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-1/ou_owner' },
          actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
        { id: 'reply-owner', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace, principal: 'lark/primary-bot/tenant-1/ou_owner' },
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
    ctx.provide('llm' as never, {
      get: () => undefined,
      stream: async function* (req: unknown) {
        llmRequests.push(req)
        yield { type: 'text-delta', text: 'unexpected' }
        yield { type: 'finish', reason: { kind: 'completed' } }
      },
    } as never)

    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      defaultWorkspace: workspace,
      defaultAgentPreset: 'primary',
      schedulerEnabled: false,
    })
    const delivery = ctx.get('assistantDelivery') as AssistantDeliveryService
    const principal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-1', user: 'ou_owner' }
    const pairing = delivery.issuePairing('owner', principal)
    delivery.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })

    const launchedCalls: Array<Record<string, unknown>> = []
    const service = new LarkChannelService(ctx, {
      enabled: true,
      account: 'primary-bot',
      tenant: 'tenant-1',
      appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET',
      domain: 'feishu',
      requireMentionInGroups: true,
      groupTopicThreads: false,
      maxTextBytes: 16_384,
      staleAfterMs: 60_000,
    }, {
      env: { LARK_APP_SECRET: 'secret-1', DSH_HOME: home, DSH_PROFILE: 'web' },
      dshHome: home,
      profile: 'web',
      createTransport: () => transport,
      writeLifecycleMarker: () => {},
      reconcilePollMs: 40,
      loadAutoUpdateCli: async () => ({
        launchUnattendedAutoUpgrade: async opts => {
          launchedCalls.push(opts as unknown as Record<string, unknown>)
          return await launchUnattendedAutoUpgrade(opts, {
            runUpgrade: async () => ({
              exitCode: 0,
              report: {
                schemaVersion: 1,
                command: 'upgrade',
                action: 'check',
                ok: true,
                ready: true,
                dshHome: home,
                mode: 'standard-local',
                frozenSystemd: { detected: false, profiles: [] },
                packages: {
                  cliPackageVersion: '0.2.2',
                  installedEnhancedVersion: '0.2.0',
                  targetEnhancedVersion: '0.2.2',
                  upgradeAvailable: true,
                  boundHost: { status: 'ready', upgradeAvailable: false },
                  profiles: [],
                },
                registry: { url: 'https://registry.npmjs.org', checked: true, status: 'ok', latestEnhancedVersion: '0.2.2' },
                readiness: { ok: true, bindingOk: true, ledgersOk: true, profiles: [], blockedReasons: [] },
                plan: { canExecute: true, steps: [], rollbackSupported: true, backupFiles: [] },
              },
            }),
            collectDoctor: async () => ({ ok: true, profiles: [] }) as never,
            spawnDetached: () => 5555,
            runnerScriptPath: '/opt/dsh-ray/lib/auto-update-runner.js',
            nodeExecutable: '/usr/bin/node',
          })
        },
        inspectPendingAutoUpdateNotification,
        clearAutoUpdateNotifyMarker,
      }),
    })

    await service.whenReady()
    // 1. Reconciled startup completion marker and cleared it atomically
    await vi.waitFor(() => {
      expect(sends.some(s => 'commandCard' in s.input && JSON.stringify(s.input.commandCard).includes('自动升级完成：当前版本 v0.2.2'))).toBe(true)
      expect(existsSync(autoUpdateNotifyPath(home))).toBe(false)
    }, { timeout: 10_000 })

    // 2. Owner sends invalid `/update foo` -> usage error, zero LLM / launcher calls
    const now = 2_000_000
    const badUpdate = normalizeLarkMessage({
      account: 'primary-bot',
      tenant: 'tenant-1',
      requireMentionInGroups: true,
      maxTextBytes: 16_384,
      staleAfterMs: 60_000,
    }, {
      messageId: 'om_upd_bad',
      chatId: 'oc_dm_ou_owner',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '/update foo',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now,
    }, now)
    expect(badUpdate.outcome).toBe('accept')
    if (badUpdate.outcome === 'accept') await delivery.acceptInbound(badUpdate.envelope)
    await delivery.tick()
    await delivery.whenIdle()
    await delivery.tick()
    await delivery.whenIdle()
    expect(launchedCalls).toHaveLength(0)
    expect(JSON.stringify(sends.at(-1)?.input)).toContain('用法：/update 或 /upgrade')

    // 3. Owner sends exact `/update` -> writes 0600 notify marker & launches background updater
    const goodUpdate = normalizeLarkMessage({
      account: 'primary-bot',
      tenant: 'tenant-1',
      requireMentionInGroups: true,
      maxTextBytes: 16_384,
      staleAfterMs: 60_000,
    }, {
      messageId: 'om_upd_ok',
      chatId: 'oc_dm_ou_owner',
      chatType: 'p2p',
      senderId: 'ou_owner',
      content: '/Update ',
      rawContentType: 'text',
      resources: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: now + 10,
    }, now + 10)
    expect(goodUpdate.outcome).toBe('accept')
    if (goodUpdate.outcome === 'accept') await delivery.acceptInbound(goodUpdate.envelope)
    await delivery.tick()
    await delivery.whenIdle()
    await delivery.tick()
    await delivery.whenIdle()

    expect(launchedCalls).toHaveLength(1)
    expect(launchedCalls[0]).toMatchObject({
      dshHome: home,
      profile: 'web',
      notify: expect.objectContaining({
        channel: 'lark',
        account: 'primary-bot',
        chatId: 'oc_dm_ou_owner',
      }),
    })
    expect(JSON.stringify(sends.at(-1)?.input)).toContain('🔄 已启动后台自动升级与服务恢复（v0.2.0 -> v0.2.2）')
    expect(existsSync(autoUpdateNotifyPath(home))).toBe(true)

    // 4. Simulate background runner rollback/failure WITHOUT restarting lark-channel -> poll reconciles & sends alert!
    const statusJson = JSON.parse(await readFile(autoUpdateStatusPath(home), 'utf8')) as { runId: string }
    await writeFile(autoUpdateStatusPath(home), JSON.stringify({
      schemaVersion: 1,
      runId: statusJson.runId,
      status: 'failed',
      error: 'doctor failed after rollback',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }), { mode: 0o600 })

    await vi.waitFor(() => {
      expect(sends.some(s => JSON.stringify(s.input).includes('⚠️ 自动升级失败并已回滚保护：doctor failed after rollback'))).toBe(true)
      expect(existsSync(autoUpdateNotifyPath(home))).toBe(false)
    }, { timeout: 10_000 })
    expect(llmRequests).toEqual([])
    expect(handlers).toBeDefined()
    await ctx.fiber.restart()
  })

  test('LarkChannelService ignores non-lark (channel: web) auto-update markers without polling or sending Feishu messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-auto-update-ignore-web-'))
    roots.push(root)
    const home = join(root, 'dsh-home')
    const workspace = join(root, 'workspace')
    await mkdir(join(home, 'profiles', 'web', '.dsh'), { recursive: true })
    await mkdir(join(home, '.dsh-ray'), { recursive: true, mode: 0o700 })
    await mkdir(workspace, { recursive: true })

    const {
      autoUpdateNotifyPath,
      autoUpdateStatusPath,
      clearAutoUpdateNotifyMarker,
      inspectPendingAutoUpdateNotification,
      launchUnattendedAutoUpgrade,
    } = await import('../../../packages/cli/lib/index.js')

    await writeFile(autoUpdateNotifyPath(home), JSON.stringify({
      schemaVersion: 1,
      runId: 'auto-update-web-only',
      channel: 'web',
      account: 'owner-console',
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
    }), { mode: 0o600 })

    let inspectCalls = 0
    let clearCalls = 0

    const startServiceWithMarker = async () => {
      const ctx = new Context()
      const sends: Array<{ chatId: string; input: LarkSendInput }> = []
      const transport: LarkTransport = {
        subscribe: () => () => {},
        connect: async () => {},
        disconnect: async () => {},
        addReaction: async () => 'r1',
        createProgress: async () => ({ cotId: 'cot1', messageId: 'om_cot1' }),
        writeProgress: async () => {},
        send: async (chatId, input) => {
          sends.push({ chatId, input })
          return { messageId: `om_s_${sends.length}` }
        },
      }
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, `policy-${inspectCalls}.sqlite`),
        rules: [
          { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:owner' }, actions: ['pair.issue'],
            resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
        ],
      })
      ctx.provide('agents' as never, {
        create: async () => { throw new Error('unused') },
        resume: vi.fn(async () => { throw new Error('unused') }),
      } as never)
      ctx.provide('sessions' as never, { list: async () => [], flush: async () => true } as never)
      ctx.provide('llm' as never, { get: () => undefined, stream: async function* () {} } as never)
      await ctx.plugin(AssistantDeliveryService, {
        databasePath: join(root, `delivery-${inspectCalls}.sqlite`),
        spoolPath: join(root, `spool-${inspectCalls}`),
        defaultWorkspace: workspace,
        defaultAgentPreset: 'primary',
        schedulerEnabled: false,
      })

      const service = new LarkChannelService(ctx, {
        enabled: true,
        account: 'primary-bot',
        tenant: 'tenant-1',
        appId: 'cli_0123456789abcdef',
        appSecretEnv: 'LARK_APP_SECRET',
        domain: 'feishu',
        requireMentionInGroups: true,
        groupTopicThreads: false,
        maxTextBytes: 16_384,
        staleAfterMs: 60_000,
      }, {
        env: { LARK_APP_SECRET: 'secret-1', DSH_HOME: home, DSH_PROFILE: 'web' },
        dshHome: home,
        profile: 'web',
        createTransport: () => transport,
        writeLifecycleMarker: () => {},
        reconcilePollMs: 25,
        loadAutoUpdateCli: async () => ({
          launchUnattendedAutoUpgrade,
          inspectPendingAutoUpdateNotification: async dshHomeArg => {
            inspectCalls += 1
            return await inspectPendingAutoUpdateNotification(dshHomeArg)
          },
          clearAutoUpdateNotifyMarker: async dshHomeArg => {
            clearCalls += 1
            return await clearAutoUpdateNotifyMarker(dshHomeArg)
          },
        }),
      })
      await service.whenReady()
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(sends).toEqual([])
      expect(clearCalls).toBe(0)
      expect(existsSync(autoUpdateNotifyPath(home))).toBe(true)
      await ctx.fiber.restart()
    }

    // Pending status (status file absent): inspected once, then poll cleared immediately without waiting
    await startServiceWithMarker()
    expect(inspectCalls).toBe(1)

    // Ready succeeded status for channel: 'web': still ignored without sending or deleting marker
    await writeFile(autoUpdateStatusPath(home), JSON.stringify({
      schemaVersion: 1,
      runId: 'auto-update-web-only',
      status: 'succeeded',
      version: '0.2.2',
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }), { mode: 0o600 })
    await startServiceWithMarker()
    expect(inspectCalls).toBe(2)
  })
})
