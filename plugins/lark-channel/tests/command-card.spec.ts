import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import type { DeliveryAdapterContext, OutboundIntent } from '@dsh-ray/assistant-delivery'
import { LarkDeliveryAdapter } from '../src/adapter.ts'
import { tryBuildLarkCommandCard } from '../src/command-card.ts'
import { LARK_APPROVAL_CARD_MAX_BYTES, renderLarkMessage } from '../src/sdk.ts'
import {
  LarkTransportError,
  type LarkSendInput,
  type LarkSendOptions,
  type LarkTransport,
  type LarkTransportHandlers,
} from '../src/types.ts'

function cardElements(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(cardElements)
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(cardElements)]
}

function makeIntent(overrides: Partial<OutboundIntent> = {}): OutboundIntent {
  return {
    idempotencyKey: 'cmd-1',
    bindingId: 'binding-1',
    target: {
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
    },
    text: 'reply',
    format: 'plain',
    replyToEventId: 'om_in',
    ...overrides,
  }
}

describe('tryBuildLarkCommandCard & command card rendering', () => {
  test('builds Card 2.0 help cards with grouped markdown commands and plain_text preset descriptions', () => {
    const hostileDesc = '**evil** [click](https://evil.invalid) <at user_id="all">all</at>'
    const text = [
      '会话命令：',
      '- /new（/clear）：开始空白新会话；旧会话保留。',
      '- /help：显示当前实际可用命令。',
      '',
      'DSH / 当前 preset 命令：',
      `- /compact：${hostileDesc}`,
    ].join('\n')

    const commandCard = tryBuildLarkCommandCard(text)
    expect(commandCard).toBeDefined()
    const rendered = renderLarkMessage({ commandCard: commandCard! })
    expect(rendered.msgType).toBe('interactive')
    const card = JSON.parse(rendered.content) as {
      schema: string
      config: { summary: { content: string } }
      header: { template: string; icon: { tag: string; token: string } }
      body: { elements: Array<Record<string, unknown>> }
    }
    expect(card.schema).toBe('2.0')
    expect(card.config.summary.content.length).toBeGreaterThanOrEqual(8)
    expect(card.config.summary.content.length).toBeLessThanOrEqual(60)
    expect(card.header.template).toBe('blue')
    expect(card.header.icon).toEqual({ tag: 'standard_icon', token: 'info_outlined' })

    const elements = cardElements(card.body.elements)
    expect(elements.some(el => el.tag === 'note' || el.tag === 'action' || el.tag === 'form')).toBe(false)
    expect(elements.filter(el => el.tag === 'interactive_container').every(el =>
      Array.isArray(el.behaviors) && el.behaviors.length === 0)).toBe(true)

    const markdownText = elements
      .filter(el => el.tag === 'markdown')
      .map(el => String(el.content ?? ''))
      .join('\n')
    expect(markdownText).toContain('`/new`')
    expect(markdownText).toContain('`/help`')
    expect(markdownText).not.toContain(hostileDesc)

    expect(elements.some(el => el.tag === 'div'
      && (el.text as { tag?: unknown; content?: unknown } | undefined)?.tag === 'plain_text'
      && (el.text as { content?: unknown } | undefined)?.content === `/compact：${hostileDesc}`)).toBe(true)
  })

  test('builds Card 2.0 status and unreadable-session cards with dynamic values in plain_text', () => {
    const hostileModel = '**gpt-fake** [link](https://evil.invalid)'
    const statusText = [
      '当前会话',
      '- 第 3 代（sess_abcd）',
      '- 状态：运行中',
      '- 上下文消息：14',
      '- 已记录轮次：5',
      `- 模型：${hostileModel}`,
      '',
      '/new 会开始空白新 session 并保留旧会话；/stop 只停止当前任务，不清空上下文。',
    ].join('\n')

    const statusCard = JSON.parse(renderLarkMessage({ commandCard: tryBuildLarkCommandCard(statusText)! }).content) as Record<string, unknown>
    const statusElements = cardElements(statusCard)
    const columnSet = statusElements.find(el => el.tag === 'column_set') as {
      columns: Array<{ width: string; weight: number }>
    } | undefined
    expect(columnSet?.columns).toHaveLength(2)
    expect(columnSet?.columns.every(col => col.width === 'weighted' && col.weight === 1)).toBe(true)
    expect(statusElements
      .filter(el => el.tag === 'markdown')
      .some(el => String(el.content ?? '').includes(hostileModel))).toBe(false)
    expect(statusElements.some(el => el.tag === 'div'
      && (el.text as { tag?: unknown; content?: unknown } | undefined)?.tag === 'plain_text'
      && (el.text as { content?: unknown } | undefined)?.content === hostileModel)).toBe(true)

    const unreadableText = [
      '当前会话暂时无法恢复；原历史未删除。',
      '- 会话：第 3 代（sess_abcd）',
      '- 诊断：**corrupted** [link](https://evil.invalid)',
      '',
      '请先修复或升级对应 DSH 插件后重试；也可发送 /new 开始空白新会话，旧会话仍会保留。',
    ].join('\n')
    const unreadableCard = JSON.parse(renderLarkMessage({ commandCard: tryBuildLarkCommandCard(unreadableText)! }).content) as {
      header: { template: string; icon: { token: string } }
      body: unknown
    }
    expect(unreadableCard.header.template).toBe('orange')
    expect(unreadableCard.header.icon.token).toBe('warning_outlined')
    expect(cardElements(unreadableCard.body).some(el => el.tag === 'div'
      && (el.text as { tag?: unknown; content?: unknown } | undefined)?.tag === 'plain_text'
      && String((el.text as { content?: unknown } | undefined)?.content ?? '').includes('**corrupted**'))).toBe(true)
  })

  test('builds Card 2.0 /version, /autonomy, /learning, and /feedback cards with plain_text dynamic payloads', () => {
    const versionText = [
      '助手版本：dsh-ray v0.2.0（CLI v0.2.0）',
      'Host（@deepseek-ai/dsh）：运行 0.2.2；绑定 0.2.2（ready）',
      '当前 Profile：assistant',
      '插件概览：核心插件 36 个；自演进插件 1 个（启用 1 个）',
      '自演进插件列表：**evil-plugin**@0.1.0',
      '自迭代演进统计（已采集）：',
      '- 累计自迭代次数：11',
    ].join('\n')

    const samples = [
      versionText,
      '自迭代控制命令（仅限 owner，不进入模型）：\n- /autonomy enable（或「开启自迭代」）',
      '已开启 profile assistant 的自迭代能力（更新 3 项配置）。',
      '当前身份不是此会话的 owner；本次自迭代控制未执行。',
      '学习控制命令：\n- /learning status：查看当前工作区与 preset 的学习状态。',
      '组件状态：已启用\n管理员开关：已开启\n收集状态：运行中\nowner 控制：未暂停\n- 已保存信号：3',
      '当前 owner 与 lineage 的 T1 偏好摘要（不含原始内容）：\n- key=response.verbosity\n  value=**concise**',
      '已暂停当前工作区与 preset 的偏好学习。\n\n组件状态：已启用\n收集状态：已暂停',
      '尚未删除任何学习记录。若确定永久删除当前工作区与 preset 的记录，请发送 /learning forget confirm。',
      '反馈命令：\n- 回复一条自动化或普通 Agent 任务结果，并发送 /feedback achieved|partial|not-achieved（记录该次任务结果）',
      '当前任务反馈：**achieved**，版本 1。\n继续回复原任务结果：\n/feedback status',
      '已把该次任务结果记录为 achieved；同一次任务只计一票。',
      '当前身份不能提交反馈；本次反馈未记录。',
    ]

    for (const sample of samples) {
      const commandCard = tryBuildLarkCommandCard(sample)
      expect(commandCard).toBeDefined()
      const card = JSON.parse(renderLarkMessage({ commandCard: commandCard! }).content) as {
        schema: string
        config: { summary: { content: string } }
        body: { elements: Array<Record<string, unknown>> }
      }
      expect(card.schema).toBe('2.0')
      expect(card.config.summary.content.length).toBeGreaterThanOrEqual(8)
      expect(card.config.summary.content.length).toBeLessThanOrEqual(60)
      const elements = cardElements(card.body.elements)
      expect(elements.some(el => el.tag === 'note' || el.tag === 'action' || el.tag === 'form')).toBe(false)
      const markdownText = elements
        .filter(el => el.tag === 'markdown')
        .map(el => String(el.content ?? ''))
        .join('\n')
      expect(markdownText).not.toContain('**evil-plugin**')
      expect(markdownText).not.toContain('**concise**')
      expect(markdownText).not.toContain('https://evil.invalid')
      expect(markdownText).not.toContain('**achieved**')
    }
  })

  test('ignores arbitrary plain strings, /learning export JSON, and oversized texts', () => {
    expect(tryBuildLarkCommandCard('')).toBeUndefined()
    expect(tryBuildLarkCommandCard('hello')).toBeUndefined()
    expect(tryBuildLarkCommandCard('delegated:disableSelfIteration:true')).toBeUndefined()

    const learningExport = JSON.stringify({
      format: 'dsh-preference-learning',
      records: [],
      version: 1,
    }, null, 2)
    expect(tryBuildLarkCommandCard(learningExport)).toBeUndefined()

    const hugeText = `当前 owner 与 lineage 的 T1 偏好摘要（不含原始内容）：\n- ${'a'.repeat(21 * 1_024)}`
    expect(tryBuildLarkCommandCard(hugeText)).toBeUndefined()
  })
})

describe('LarkDeliveryAdapter command card routing & fallback', () => {
  function makeTransport(sendImpl?: LarkTransport['send']) {
    const send = vi.fn(sendImpl ?? (async (_chatId: string, _input: LarkSendInput, _options?: LarkSendOptions) => ({
      messageId: 'om_sent',
    })))
    const transport: LarkTransport = {
      subscribe: (_handlers: LarkTransportHandlers) => () => {},
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'reaction-1',
      createProgress: async () => ({ cotId: 'cot-1', messageId: 'om_cot' }),
      writeProgress: async () => {},
      uploadTextFile: vi.fn(async () => 'file_v2_uploaded'),
      send,
    }
    return { transport, send }
  }

  test('routes plain slash-command replies as commandCard, preserves markdown/attachments/synthetic plain text, and falls back on format_error', async () => {
    const { transport, send } = makeTransport()
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot',
      tenant: 'tenant-a',
      requireMentionInGroups: true,
      maxTextBytes: 65_536,
      staleAfterMs: 60_000,
    }, transport, { now: () => 1_000 })
    await adapter.start({ accept: vi.fn(), receipt: vi.fn() } as unknown as DeliveryAdapterContext)

    const helpText = '会话命令：\n- /new（/clear）：开始空白新会话；旧会话保留。'
    await expect(adapter.send(makeIntent({ idempotencyKey: 'help-1', text: helpText, format: 'plain' }),
      new AbortController().signal)).resolves.toEqual({ outcome: 'accepted', providerMessageId: 'om_sent' })
    expect(send).toHaveBeenLastCalledWith('oc_dm', {
      commandCard: expect.objectContaining({ title: '可用命令与操作指南' }),
    }, expect.objectContaining({ requestKey: 'help-1' }))

    await adapter.send(makeIntent({ idempotencyKey: 'md-1', text: helpText, format: 'markdown' }),
      new AbortController().signal)
    expect(send).toHaveBeenLastCalledWith('oc_dm', { markdown: helpText }, expect.objectContaining({ requestKey: 'md-1' }))

    await adapter.send(makeIntent({ idempotencyKey: 'plain-1', text: 'delegated:disableSelfIteration:true', format: 'plain' }),
      new AbortController().signal)
    expect(send).toHaveBeenLastCalledWith('oc_dm', { text: 'delegated:disableSelfIteration:true' },
      expect.objectContaining({ requestKey: 'plain-1' }))

    await adapter.send(makeIntent({
      idempotencyKey: 'att-1',
      text: helpText,
      format: 'plain',
      attachment: {
        kind: 'text',
        name: 'help.txt',
        mediaType: 'text/plain',
        text: helpText,
        sha256: createHash('sha256').update(helpText, 'utf8').digest('hex'),
      },
    }), new AbortController().signal)
    expect(send).toHaveBeenNthCalledWith(4, 'oc_dm', { fileKey: 'file_v2_uploaded' },
      expect.objectContaining({ requestKey: 'att-1:attachment' }))
    expect(send).toHaveBeenLastCalledWith('oc_dm', { text: helpText },
      expect.objectContaining({ requestKey: 'att-1' }))

    send.mockRejectedValueOnce(new LarkTransportError('format_error', 'rejected command card'))
    send.mockResolvedValueOnce({ messageId: 'om_fallback' })
    await expect(adapter.send(makeIntent({ idempotencyKey: 'help-fallback', text: helpText, format: 'plain' }),
      new AbortController().signal)).resolves.toEqual({ outcome: 'accepted', providerMessageId: 'om_fallback' })
    expect(send).toHaveBeenLastCalledWith('oc_dm', { text: helpText },
      expect.objectContaining({ requestKey: 'help-fallback:command-card-fallback' }))

    const oversizedBoundaryCard = tryBuildLarkCommandCard(
      `当前 owner 与 lineage 的 T1 偏好摘要（不含原始内容）：\n- ${'a'.repeat(19 * 1_024)}`,
    )
    expect(oversizedBoundaryCard).toBeDefined()
    expect(Buffer.byteLength(renderLarkMessage({ commandCard: oversizedBoundaryCard! }).content, 'utf8'))
      .toBeLessThan(LARK_APPROVAL_CARD_MAX_BYTES)
  })

  test('renders /update, /upgrade, /help with /update, usage warnings, and completion/rollback notices as Card 2.0', () => {
    const helpWithUpdate = tryBuildLarkCommandCard([
      '会话命令：',
      '- /new（/clear）：开始空白新会话；旧会话保留。',
      '- /update（/upgrade）：在后台升级整体助手并自动重启恢复（仅限 owner）；不进入模型。',
      '- /help：显示当前实际可用命令。',
    ].join('\n'))
    expect(helpWithUpdate).toBeDefined()
    const helpRendered = renderLarkMessage({ commandCard: helpWithUpdate! }).content
    expect(helpRendered).toContain('/update')

    const launchingCard = tryBuildLarkCommandCard(
      '🔄 已启动后台自动升级与服务恢复（v0.2.0 -> v0.2.2），完成后服务将自动重启恢复并通知结果，全程无需人工干预。',
    )
    expect(launchingCard).toMatchObject({ template: 'green' })

    const currentCard = tryBuildLarkCommandCard('当前已是最新版本 v0.2.2 且服务运行正常，无需升级。')
    expect(currentCard).toMatchObject({ template: 'green' })

    const completedCard = tryBuildLarkCommandCard('✅ 自动升级完成：当前版本 v0.2.2，服务已恢复运行。')
    expect(completedCard).toMatchObject({ template: 'green' })

    const usageWarnCard = tryBuildLarkCommandCard('用法：/update 或 /upgrade（不接受额外参数）；如需升级并恢复整体助手，请直接发送 /update。')
    expect(usageWarnCard).toMatchObject({ template: 'orange' })

    const failedCard = tryBuildLarkCommandCard('⚠️ 自动升级失败并已回滚保护：doctor failed')
    expect(failedCard).toMatchObject({ template: 'orange' })
  })
})
