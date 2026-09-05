import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  KNOWN_SESSION_EVENT_TYPES,
  SessionPreparation,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import {
  CodingSubscriptionAdapter,
  Config as CodingSubscriptionConfig,
} from '../plugins/coding-subscription-provider/src/index.ts'
import { LarkDeliveryAdapter } from '@dsh-enhanced/lark-channel'
import type {
  LarkMessage,
  LarkSendInput,
  LarkTransport,
  LarkTransportHandlers,
} from '@dsh-enhanced/lark-channel'

const roots: string[] = []
const onePixelPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function sse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function codexTextResponse(): Response {
  const item = {
    type: 'message',
    id: 'msg-lark-image-e2e',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Codex saw the image.', annotations: [] }],
  }
  return sse([
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: {
      id: 'resp-lark-image-e2e',
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    } },
  ])
}

async function drive(service: Pick<AssistantDeliveryService, 'tick' | 'whenIdle'>): Promise<void> {
  await service.tick()
  await service.whenIdle()
  await service.tick()
  await service.whenIdle()
}

describe('Lark image to Direct Codex', () => {
  test('downloads, stores, persists, and serializes one image as input_image without leaking its Lark key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-image-direct-codex-'))
    roots.push(root)
    const ctx = new Context()
    let codingAdapter: CodingSubscriptionAdapter | undefined
    const png = Uint8Array.from(Buffer.from(onePixelPngBase64, 'base64'))
    const attachmentConfig = {
      dshHome: join(root, 'dsh-home'),
      maxImageBytes: 1_024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4_096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1_000,
    }
    const attachmentStore = new LocalAttachmentStore(ctx, attachmentConfig)

    let handlers: LarkTransportHandlers | undefined
    const downloadMessageImage = vi.fn(async () => ({ data: png, mediaType: 'image/png' as const }))
    const sent: Array<{ chatId: string; input: LarkSendInput }> = []
    const transport: LarkTransport = {
      subscribe(next) {
        handlers = next
        return () => { if (handlers === next) handlers = undefined }
      },
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'reaction-1',
      createProgress: async () => ({ cotId: 'cot-1', messageId: 'om-progress' }),
      writeProgress: async () => {},
      downloadMessageImage,
      send: async (chatId, input) => {
        sent.push({ chatId, input })
        return { messageId: `om-reply-${sent.length}` }
      },
    }
    const submittedBodies: Array<Record<string, unknown>> = []
    const requestResponses = vi.fn(async (body: string) => {
      submittedBodies.push(JSON.parse(body) as Record<string, unknown>)
      return codexTextResponse()
    })
    const forbiddenCliCall = vi.fn(() => {
      throw new Error('Lark image Direct Codex E2E must not invoke a CLI')
    })

    try {
      await mountAgentLoopTestDependencies(ctx, {
        systemPrompt: { persona: '' },
        tools: { mode: 'native' },
      })
      await ctx.plugin(SessionProjectionRegistry)
      const saved = new Map<string, {
        header: SessionHeader
        events: readonly SessionEvent[]
        inheritedEventCount: SessionLogOffset
      }>()
      ctx.on('session/flush', session => {
        saved.set(String(session.id), structuredClone({
          header: session.header,
          events: session.snapshotEvents(),
          inheritedEventCount: session.inheritedEventCount,
        }))
      })
      ctx.provide('sessionPersistence' as never, {
        coordinator: {
          assertEventsSupported(_meta: SessionHeader, events: readonly SessionEvent[]) {
            for (const event of events) {
              if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
              throw new Error(`unknown required session event type: ${event.type}`)
            }
          },
        },
        list: async () => [...saved.values()].map(value => structuredClone(value.header)),
        prepare: async (id: SessionId) => {
          const value = saved.get(String(id))
          if (value === undefined) throw new Error(`session not found: ${id}`)
          const restored = structuredClone(value)
          return SessionPreparation.create(ctx.sessions.prepare(id, {
            seedSource: 'persistence', seed: [...restored.events], meta: restored.header,
            inheritedEventCount: restored.inheritedEventCount,
          }))
        },
      } as never)
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        rules: [
          { id: 'pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
            actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' },
            context: { initiators: ['foreground'] } },
          { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
            actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' },
            context: { initiators: ['external'] } },
          { id: 'reply', effect: 'allow', subject: { kind: 'agent', id: 'standard', workspace: root },
            actions: ['reply'], resource: { kind: 'message', id: '*' },
            context: { initiators: ['external'] } },
        ],
      })
      await ctx.plugin(AssistantDeliveryService, {
        databasePath: join(root, 'delivery.sqlite'),
        spoolPath: join(root, 'spool'),
        schedulerEnabled: false,
        defaultWorkspace: root,
        defaultAgentPreset: 'standard',
        agentProvider: 'codex-subscription',
        agentModel: 'default',
      })
      const codingConfig = CodingSubscriptionConfig()
      codingConfig.cwd = root
      codingConfig.timeoutMs = 10_000
      codingConfig.codex.transport = 'direct-responses'
      codingConfig.codex.directModel = 'gpt-codex-lark-image-e2e'
      codingAdapter = new CodingSubscriptionAdapter(codingConfig, {
        codexCredentials: { requestResponses },
        liveSessions: ctx.sessions,
        getAttachments: () => attachmentStore,
        runText: forbiddenCliCall,
        verifyAuth: forbiddenCliCall,
        discoverCodexModels: forbiddenCliCall,
      })
      ctx.llm.registerAdapter(['codex-subscription'], codingAdapter)
      await ctx.plugin(AgentLoop, { agents: [] })

      const lark = new LarkDeliveryAdapter({
        account: 'bot-1',
        tenant: 'tenant-a',
        requireMentionInGroups: false,
        maxTextBytes: 65_536,
        staleAfterMs: 300_000,
      }, transport, { showProgress: false, statusReactions: false })
      await ctx.assistantDelivery.registerAdapter(lark)
      const pairing = ctx.assistantDelivery.issuePairing('test', {
        channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner',
      })
      ctx.assistantDelivery.confirmPairing({
        challengeId: pairing.challenge.id,
        principal: pairing.challenge.principal,
        code: pairing.code,
      })
      const providerRef = 'img_v3_private_e2e_key'
      const message: LarkMessage = {
        messageId: 'om_lark_image_e2e',
        chatId: 'oc_owner',
        chatType: 'p2p',
        senderId: 'ou_owner',
        content: '',
        rawContentType: 'image',
        resources: [{ type: 'image', fileKey: providerRef, fileName: 'photo.png' }],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      }

      await handlers!.message(message)
      await drive(ctx.assistantDelivery)

      const deliveryStore = (ctx.assistantDelivery as unknown as { deliveryStore: {
        getInboxByProviderEvent(channel: string, account: string, eventId: string): {
          status: string
          failureCode?: string
        } | undefined
      } }).deliveryStore
      const inbox = deliveryStore.getInboxByProviderEvent('lark', 'bot-1', message.messageId)
      expect(inbox?.failureCode).toBeUndefined()
      expect(inbox).toMatchObject({ status: 'processed' })

      expect(downloadMessageImage).toHaveBeenCalledWith(
        message.messageId,
        providerRef,
        { maxBytes: 1_024, signal: expect.any(AbortSignal) },
      )
      expect(requestResponses).toHaveBeenCalledOnce()
      expect(forbiddenCliCall).not.toHaveBeenCalled()

      const persistedImageEvent = [...saved.values()]
        .flatMap(value => value.events)
        .find(event => event.type === 'user/message'
          && event.data.content.some(block => block.type === 'image'))
      expect(persistedImageEvent?.type).toBe('user/message')
      if (persistedImageEvent?.type !== 'user/message') {
        throw new Error('expected a persisted user image event')
      }
      const imageBlock = persistedImageEvent.data.content.find(block => block.type === 'image')
      if (imageBlock?.type !== 'image') throw new Error('expected a persisted image block')
      expect(String(imageBlock.attachment.attachmentId)).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(JSON.stringify([...saved.values()])).not.toContain(providerRef)

      let storedImageDataUrl: string | undefined
      const reloadedCtx = new Context()
      try {
        const reloadedStore = new LocalAttachmentStore(reloadedCtx, attachmentConfig)
        const stored = await reloadedStore.readImage(imageBlock.attachment)
        expect(stored.ref).toEqual(imageBlock.attachment)
        expect(stored.data.byteLength).toBe(imageBlock.attachment.bytes)
        storedImageDataUrl = `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
      } finally {
        await reloadedCtx.fiber.restart()
      }

      const body = submittedBodies[0]!
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain(providerRef)
      const input = body.input as Array<Record<string, unknown>>
      expect(input).toContainEqual({
        role: 'user',
        content: [{
          type: 'input_image',
          detail: 'auto',
          image_url: storedImageDataUrl,
        }],
      })
      expect(sent).toContainEqual({ chatId: 'oc_owner', input: { markdown: 'Codex saw the image.' } })
    } finally {
      codingAdapter?.shutdown()
      await ctx.fiber.restart()
    }
  })
})
