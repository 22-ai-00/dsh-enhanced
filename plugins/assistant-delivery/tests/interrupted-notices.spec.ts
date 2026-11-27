import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { InboundCoordinator } from '../src/coordinator.js'
import {
  CLASSIFIED_AGENT_TURN_FAILURE_CODES,
  classifyMidTurnFailure,
  interruptedTurnNoticeForFailureCode,
  isClassifiedAgentTurnFailureCode,
  isNotifiableInterruptedFailureCode,
  timedOutTurnNotice,
} from '../src/interrupted-notices.js'
import { DeliveryStore } from '../src/store.js'
import type { ConversationRef, ExternalPrincipalKey, InboundEnvelope } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const principal: ExternalPrincipalKey = {
  channel: 'lark',
  account: 'bot-1',
  tenant: 'tenant-a',
  user: 'ou_owner',
}

const conversation: ConversationRef = {
  channel: 'lark',
  account: 'bot-1',
  tenant: 'tenant-a',
  kind: 'dm',
  chat: 'oc_chat',
}

function envelope(eventId: string, text = 'hello'): InboundEnvelope {
  return {
    channel: 'lark',
    account: 'bot-1',
    eventId,
    occurredAt: 1_000,
    principal,
    conversation,
    kind: 'text',
    text,
  }
}

describe('mid-turn error classification and non-replay notices', () => {
  test('classifies missing credential, ACP aborted, prompt limit, rate limit, and runtime failures without leaking secrets or paths', () => {
    const secretToken = 'sk-live-secret-1234567890'
    const privatePath = '/data00/home/alice/.dsh/.credentials.yaml'

    const cred = classifyMidTurnFailure({
      upstreamCode: 'MISSING_CREDENTIAL',
      upstreamMessage: `missing api key at ${privatePath} near ${secretToken}`,
    })
    expect(cred).toEqual({ code: 'agent-turn-missing-credential', matchedSpecific: true })
    expect(interruptedTurnNoticeForFailureCode(cred.code)).toContain('凭据')
    expect(interruptedTurnNoticeForFailureCode(cred.code)).toContain('/model')
    expect(interruptedTurnNoticeForFailureCode(cred.code)).toContain('/status')
    expect(interruptedTurnNoticeForFailureCode(cred.code)).not.toContain(secretToken)
    expect(interruptedTurnNoticeForFailureCode(cred.code)).not.toContain(privatePath)

    const acp = classifyMidTurnFailure({
      upstreamCode: 'UNKNOWN',
      upstreamMessage: 'TraeX ACP execution was aborted with Bearer secretABC',
    })
    expect(acp).toEqual({ code: 'agent-turn-provider-aborted', matchedSpecific: true })
    expect(interruptedTurnNoticeForFailureCode(acp.code)).toContain('ACP')
    expect(interruptedTurnNoticeForFailureCode(acp.code)).not.toContain('secretABC')

    const promptLimit = classifyMidTurnFailure({
      error: new Error('prompt-limit: payload exceeded 184320 bytes'),
    })
    expect(promptLimit).toEqual({ code: 'agent-turn-prompt-limit', matchedSpecific: true })
    expect(interruptedTurnNoticeForFailureCode(promptLimit.code)).toContain('/compact')
    expect(interruptedTurnNoticeForFailureCode(promptLimit.code)).toContain('缩小单次读取的文件范围')

    const rate = classifyMidTurnFailure({
      error: Object.assign(new Error('rate limit exceeded 429'), { status: 429 }),
    })
    expect(rate).toEqual({ code: 'agent-turn-rate-limited', matchedSpecific: true })
    expect(interruptedTurnNoticeForFailureCode(rate.code)).toContain('额度')

    const generic = classifyMidTurnFailure({
      error: new Error(`upstream transport blew up with ${secretToken}`),
      turnEndKind: 'error',
    })
    expect(generic).toEqual({ code: 'agent-turn-runtime-failed', matchedSpecific: false })
    expect(interruptedTurnNoticeForFailureCode(generic.code)).not.toContain(secretToken)

    expect(timedOutTurnNotice).toContain('/status')
    expect(timedOutTurnNotice).toContain('/model')
    expect(timedOutTurnNotice).toContain('缩小单次文件读取范围')
  })

  test('InboundCoordinator dead-letters classified mid-turn failures without auto-replay even if processor marked retryable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'delivery-classified-coord-'))
    roots.push(root)
    const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), codeGenerator: () => 'PAIR1234' })
    try {
      const pairing = store.issuePairing(principal, { ttlMs: 60_000, maxAttempts: 3 })
      store.confirmPairing({ challengeId: pairing.challenge.id, principal, code: pairing.code })
      const binding = store.createBinding({
        principal, conversation, workspace: '/work/alpha', agentPreset: 'primary', sessionId: 'sess-1', policyRef: 'owner-dm',
      })
      for (const code of CLASSIFIED_AGENT_TURN_FAILURE_CODES) {
        expect(isClassifiedAgentTurnFailureCode(code)).toBe(true)
        expect(isNotifiableInterruptedFailureCode(code)).toBe(true)
        const rec = store.acceptInbound(envelope(`evt-${code}`)).record
        store.queueInbox(rec.id, binding.id)
      }
      const calls: string[] = []
      const coordinator = new InboundCoordinator({
        store,
        ownerId: 'worker',
        leaseMs: 30_000,
        maxConcurrency: 1,
        maxAttempts: 3,
        retryBaseMs: 10,
        retryMaxMs: 50,
        processor: () => ({
          prepare: async () => ({ outcome: 'prepared', message: { imageAttachments: [] } }),
          process: async (_b, env, _sig, _prep, markDispatching) => {
            calls.push(env.eventId)
            markDispatching?.()
            const code = env.eventId.slice('evt-'.length)
            return { outcome: 'not-processed', failureCode: code, retryable: true }
          },
        }),
      })
      try {
        for (let i = 0; i < CLASSIFIED_AGENT_TURN_FAILURE_CODES.length; i += 1) {
          await coordinator.tick()
          await coordinator.whenIdle()
        }
        expect(calls).toHaveLength(CLASSIFIED_AGENT_TURN_FAILURE_CODES.length)
        for (const code of CLASSIFIED_AGENT_TURN_FAILURE_CODES) {
          const rec = store.getInboxByProviderEvent('lark', 'bot-1', `evt-${code}`)
          expect(rec).toMatchObject({ status: 'dead_letter', attemptCount: 1, failureCode: code })
        }
      } finally {
        await coordinator.stop()
      }
    } finally {
      store.close()
    }
  })
})
