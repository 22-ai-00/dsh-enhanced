import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { AssistantDeliveryService, type OwnerRouteAuthority } from '@dsh-ray/assistant-delivery'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { AssistantPolicyService } from '@dsh-ray/assistant-policy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryNotice } from '../src/index.ts'
import { DeliveryNoticesService } from '../src/notices.ts'
import { TYPERT } from '../src/typert.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ')

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type VNode = { type: unknown; props: Record<string, unknown> }

function walk(node: unknown): VNode[] {
  if (Array.isArray(node)) return node.flatMap(walk)
  if (node === null || typeof node !== 'object' || !('type' in node)) return []
  const el = node as VNode
  return [el, ...walk(el.props['children'])]
}

describe('Web owner notice plain-text attachments', () => {
  it('validates optional DeliveryNotice.attachment strictly in Typert schema', () => {
    const list = TYPERT.invocations[0]!
    const codec = list.result.create()
    const text = 'Full UTF-8 attachment 内容 🚀\n<script>alert(1)</script>'
    const valid: DeliveryNotice = {
      id: 'notice-1',
      text: 'Summary…',
      createdAt: 100,
      status: 'accepted',
      attachment: {
        kind: 'text',
        name: `notice-${sha256(text).slice(0, 12)}.md`,
        mediaType: 'text/markdown',
        text,
        sha256: sha256(text),
      },
    }
    expect(codec.parse([valid])).toEqual([valid])
    expect(codec.parse([{ id: 'notice-2', text: 'Plain notice', createdAt: 200 }])).toEqual([
      { id: 'notice-2', text: 'Plain notice', createdAt: 200 },
    ])
    expect(() => codec.parse([{
      ...valid,
      attachment: { ...valid.attachment!, name: '../evil.txt' },
    }])).toThrow()
    expect(() => codec.parse([{
      ...valid,
      attachment: { ...valid.attachment!, mediaType: 'text/html' },
    }])).toThrow()
    expect(() => codec.parse([{
      ...valid,
      attachment: { ...valid.attachment!, sha256: 'not-a-digest' },
    }])).toThrow()
    expect(() => codec.parse([{
      ...valid,
      attachment: { ...valid.attachment!, text: '' },
    }])).toThrow()
  })

  it('propagates over-cap UTF-8 attachments from AssistantDeliveryService through DeliveryNoticesService and strict TypertGateway', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-owner-notices-attach-'))
    roots.push(root)
    const principal = { channel: 'web', account: 'browser', tenant: 'local', user: 'owner' }
    const conversation = { channel: 'web', account: 'browser', tenant: 'local', kind: 'dm' as const, chat: 'owner-chat' }
    const ownerId = 'web/browser/local/owner'
    const authority: OwnerRouteAuthority = {
      id: 'web-owner-notice',
      conversation,
      principal,
      workspace: root,
      agentPreset: 'primary',
      policyRef: 'web-owner',
      minimumGeneration: 1,
    }
    const ctx = new Context()
    contexts.add(ctx)
    ctx.provide('agents' as never, { list: () => [], get: () => undefined } as never)
    ctx.provide('sessions' as never, { list: () => [] } as never)
    ctx.provide('llm' as never, {} as never)
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(TYPERT)
    ctx.provide('remoteAccess' as never, { decide: () => ({ kind: 'deny', reason: 'test-owner-only' }) } as never)
    await ctx.plugin(TypertGatewayService, {})
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [{
        id: 'web-owner-send',
        effect: 'allow',
        subject: { kind: 'background', id: 'proactive-engine', workspace: root, principal: ownerId },
        actions: ['send'],
        resource: { kind: 'message', id: '*' },
        context: { initiators: ['background'] },
      }],
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      retryBaseMs: 1,
      retryMaxMs: 1,
      ownerRoutes: [authority],
      attentionAttachOverCap: true,
    })

    const service = ctx.assistantDelivery
    const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
    store.handoffOwner(principal)
    const access = service.bindNativeWebOwner(ctx, { principal, workspace: root, preset: 'primary' })
    try {
      const binding = store.createBinding({
        conversation,
        principal,
        workspace: root,
        agentPreset: 'primary',
        sessionId: 'owned-session',
        policyRef: 'web-owner',
      })
      const owner = store.getPrincipal(principal)!
      const fullText = `详细通知：\n${words(420)} <script>alert("xss")</script>`
      const overCap = service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: owner.id,
          principalVersion: owner.version,
          workspace: root,
          preset: 'primary',
        },
        sessionId: binding.sessionId,
        idempotencyKey: 'gw-overcap-1',
        text: fullText,
        expiresAt: Date.now() + 60_000,
        attention: { purpose: 'result' },
      })
      const underCap = service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: owner.id,
          principalVersion: owner.version,
          workspace: root,
          preset: 'primary',
        },
        sessionId: binding.sessionId,
        idempotencyKey: 'gw-undercap-1',
        text: 'Short note.',
        expiresAt: Date.now() + 60_000,
        attention: { purpose: 'result' },
      })
      await service.tick()
      await service.whenIdle()
      await service.tick()
      await service.whenIdle()

      new DeliveryNoticesService(ctx, access)
      const peer: Parameters<typeof ctx.typertGateway.invoke>[0]['peer'] = {
        id: 'web-owner-attach-peer' as never,
        ctx,
        principal: { kind: 'owner' },
        signal: new AbortController().signal,
        interactions: 'none',
        dispose: async () => {},
      }
      const listed = await ctx.typertGateway.invoke({
        peer,
        namespace: 'deliveryNotices',
        method: 'list',
        args: { sessionId: 'owned-session' },
      }) as readonly DeliveryNotice[]
      expect(listed).toHaveLength(2)
      expect(listed).toEqual(expect.arrayContaining([
        {
          id: overCap.id,
          text: overCap.intent.text,
          createdAt: overCap.createdAt,
          status: 'accepted',
          attachment: {
            kind: 'text',
            name: `notice-${sha256(fullText).slice(0, 12)}.txt`,
            mediaType: 'text/plain',
            text: fullText,
            sha256: sha256(fullText),
          },
        },
        {
          id: underCap.id,
          text: 'Short note.',
          createdAt: underCap.createdAt,
          status: 'accepted',
        },
      ]))
      const underCapListed = listed.find(item => item.id === underCap.id)!
      expect('attachment' in underCapListed).toBe(false)

      await expect(ctx.typertGateway.invoke({
        peer,
        namespace: 'deliveryNotices',
        method: 'list',
        args: { sessionId: 'foreign-session' },
      })).rejects.toThrow()
      await expect(ctx.typertGateway.invoke({
        peer,
        namespace: 'deliveryNotices',
        method: 'ack',
        args: { sessionId: 'owned-session', ids: [overCap.id], status: 'delivered' },
      })).resolves.toEqual({ acknowledged: 1 })
      await expect(ctx.typertGateway.invoke({
        peer,
        namespace: 'deliveryNotices',
        method: 'ack',
        args: { sessionId: 'owned-session', ids: [overCap.id], status: 'read' },
      })).resolves.toEqual({ acknowledged: 1 })
    } finally {
      await access.dispose()
    }
  })

  it('renders NoticeDock attachments with bounded plain-text preview, XSS-safe text children, and Blob download cleanup in built client bundle', async () => {
    const output = mkdtempSync(join(tmpdir(), 'web-owner-client-attach-'))
    try {
      execFileSync(process.execPath, ['scripts/build-client.mjs'], {
        cwd: new URL('..', import.meta.url),
        stdio: 'pipe',
        env: { ...process.env, DSH_WEB_OWNER_CLIENT_OUT: output },
      })
      const built = readFileSync(join(output, 'client.js'), 'utf8')
      let registration: { factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined

      const xssAndLong = `<script>alert(1)</script><img src=x onerror=alert(2)> ${'字'.repeat(17_000)}`
      const noticeWithAttachment: DeliveryNotice = {
        id: 'n-attach',
        text: '（全文较长，已转为附件）',
        createdAt: 1,
        status: 'accepted',
        attachment: {
          kind: 'text',
          name: 'notice-deadbeefcafe.txt',
          mediaType: 'text/plain',
          text: xssAndLong,
          sha256: sha256(xssAndLong),
        },
      }
      const plainNotice: DeliveryNotice = {
        id: 'n-plain',
        text: '普通提醒',
        createdAt: 2,
        status: 'accepted',
      }

      let stateSlots: unknown[] = []
      let stateCursor = 0
      const setExpandedSpy = vi.fn((updater: unknown) => {
        const next = typeof updater === 'function' ? (updater as (prev: Record<string, boolean>) => Record<string, boolean>)({}) : updater
        stateSlots[1] = next
      })
      const createObjectURL = vi.fn(() => 'blob:mock-notice-1')
      const revokeObjectURL = vi.fn()
      const linkMock = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: vi.fn(),
        remove: vi.fn(),
      }
      const appendChild = vi.fn()
      const createdBlobs: Array<{ parts: string[]; options?: { type?: string } }> = []
      class FakeBlob {
        constructor(public readonly parts: string[], public readonly options?: { type?: string }) {
          createdBlobs.push({ parts, ...(options === undefined ? {} : { options }) })
        }
      }

      runInNewContext(built, {
        window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } },
        Blob: FakeBlob,
        URL: { createObjectURL, revokeObjectURL },
        document: {
          createElement: vi.fn(() => linkMock),
          body: { appendChild },
        },
        setTimeout,
        clearTimeout,
      })
      if (registration === undefined) throw new Error('client did not register a ModuleLoader factory')

      const exports = registration.factory(id => {
        if (id === 'react') {
          return {
            useEffect: () => undefined,
            useRef: (value: unknown) => ({ current: value }),
            useState: (initial: unknown) => {
              const index = stateCursor++
              if (index >= stateSlots.length) stateSlots[index] = initial
              const setter = index === 1 ? setExpandedSpy : vi.fn()
              return [stateSlots[index], setter]
            },
          }
        }
        if (id === 'react/jsx-runtime') {
          return { jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }) }
        }
        return {}
      })

      const NoticeDock = exports.NoticeDock as (props: {
        sessionId: string
        list: (sessionId: string) => Promise<unknown>
        ack: (sessionId: string, ids: readonly string[], status: 'delivered' | 'read') => Promise<unknown>
      }) => VNode
      const ack = vi.fn(async () => ({ acknowledged: 1 }))
      const list = vi.fn(async () => ({ ok: true, value: [noticeWithAttachment, plainNotice] }))

      // Render collapsed state first.
      stateSlots = [[noticeWithAttachment, plainNotice], {}]
      stateCursor = 0
      const collapsedNodes = walk(NoticeDock({ sessionId: 's1', list, ack }))
      const toggleButton = collapsedNodes.find(node => node.type === 'button' && String(node.props['children']).startsWith('查看附件'))
      const downloadButton = collapsedNodes.find(node => node.type === 'button' && String(node.props['children']).startsWith('下载'))
      expect(toggleButton).toBeDefined()
      expect(downloadButton).toBeDefined()
      expect(collapsedNodes.some(node => node.type === 'pre')).toBe(false)

      // Toggling and downloading must NOT trigger 'read' ack.
      ;(toggleButton!.props['onClick'] as () => void)()
      expect(ack).not.toHaveBeenCalled()
      ;(downloadButton!.props['onClick'] as () => void)()
      expect(ack).not.toHaveBeenCalled()
      expect(createdBlobs).toEqual([{ parts: [xssAndLong], options: { type: 'text/plain;charset=utf-8' } }])
      expect(linkMock).toMatchObject({
        href: 'blob:mock-notice-1',
        download: 'notice-deadbeefcafe.txt',
        rel: 'noopener noreferrer',
      })
      expect(appendChild).toHaveBeenCalledWith(linkMock)
      expect(linkMock.click).toHaveBeenCalledOnce()
      expect(linkMock.remove).toHaveBeenCalledOnce()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-notice-1')

      // Render expanded state: bounded preview renders strictly as plain-text child of <pre>, no HTML props.
      stateCursor = 0
      const expandedNodes = walk(NoticeDock({ sessionId: 's1', list, ack }))
      const pre = expandedNodes.find(node => node.type === 'pre')
      expect(pre).toBeDefined()
      expect(pre!.props['dangerouslySetInnerHTML']).toBeUndefined()
      const preText = String(pre!.props['children'])
      expect(preText).toContain('<script>alert(1)</script><img src=x onerror=alert(2)>')
      expect(preText).toContain('预览已截断')
      expect(preText.length).toBeLessThan(16_500)

      // Clicking notice summary still sends 'read' ack.
      const summaryP = expandedNodes.find(node => node.type === 'p' && node.props['children'] === '（全文较长，已转为附件）')
      expect(summaryP).toBeDefined()
      ;(summaryP!.props['onClick'] as () => void)()
      expect(ack).toHaveBeenCalledWith('s1', ['n-attach'], 'read')

      // Defensive helper checks for malformed/non-ASCII download names.
      const safeAttachmentName = exports.safeAttachmentName as (name: string, mediaType: 'text/plain' | 'text/markdown') => string
      expect(safeAttachmentName('../bad/path.md', 'text/markdown')).toBe('notice-attachment.md')
      expect(safeAttachmentName('notice-123.txt', 'text/plain')).toBe('notice-123.txt')
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
