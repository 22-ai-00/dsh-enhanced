import { createMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/prompt.ts'

function request(): GenerateOptions {
  return {
    provider: 'codex-subscription',
    model: 'default',
    system: 'Be concise.',
    messages: [
      createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }),
      createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'other', model: 'model' },
        content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'Hello' }],
      }),
    ],
  }
}

function skillCatalog(
  text: string,
  update = false,
  entries: readonly { name: string; description: string }[] = [{ name: 'test-skill', description: 'test skill' }],
) {
  return createMessage({
    role: 'user',
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      entries,
      ...(update ? { update: true } : {}),
    } as never,
    content: [{ type: 'text', text }],
  })
}

function malformedCatalogUpdate(text: string) {
  return createMessage({
    role: 'user',
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries: 'not-an-entry-list',
    } as never,
    content: [{ type: 'text', text }],
  })
}

function conversationTexts(prompt: string): string[] {
  const request = JSON.parse(prompt.slice(prompt.indexOf('{'))) as {
    conversation: { content: { text?: string }[] }[]
  }
  return request.conversation.flatMap(message => message.content.flatMap(block => block.text ?? []))
}

describe('DSH request serialization', () => {
  it('keeps system and ordered messages while omitting historical reasoning', () => {
    const prompt = buildPrompt(request(), 100_000)
    expect(prompt).toContain('Be concise.')
    expect(prompt).toContain('你好')
    expect(prompt).toContain('reasoning-omitted')
    expect(prompt).not.toContain('private')
  })

  it('enforces a UTF-8 prompt bound', () => {
    try {
      buildPrompt(request(), 10)
      expect.unreachable('expected the serialized request to exceed the byte limit')
    } catch (error: unknown) {
      expect(error).toMatchObject({
        message: expect.stringMatching(/configured limit/),
        cause: 'prompt-limit',
      })
    }
  })

  it('serializes only the newest complete skill catalog after a catalog replacement', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [
        skillCatalog(`obsolete-catalog:${'x'.repeat(5_000)}`),
        createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'other', model: 'model' },
          content: [{ type: 'text', text: 'catalog acknowledged' }],
        }),
        skillCatalog('stale-replacement', true),
        createMessage({
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'message after stale replacement' }],
        }),
        skillCatalog('current-catalog', true),
        createMessage({
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'answer this request' }],
        }),
      ],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual([
      'catalog acknowledged',
      'message after stale replacement',
      'current-catalog',
      'answer this request',
    ])
  })

  it('keeps every skill catalog when no catalog carries an explicit replacement marker', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [skillCatalog('first-catalog'), skillCatalog('second-catalog')],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual(['first-catalog', 'second-catalog'])
  })

  it('does not let a malformed catalog source retire an earlier valid catalog', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [skillCatalog('valid-catalog'), malformedCatalogUpdate('malformed-catalog')],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual(['valid-catalog', 'malformed-catalog'])
  })

  it('does not prune from an older replacement marker when the newest valid catalog is unmarked', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [
        skillCatalog('initial-catalog'),
        skillCatalog('older-replacement', true),
        skillCatalog('newest-unmarked-catalog'),
      ],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual([
      'initial-catalog',
      'older-replacement',
      'newest-unmarked-catalog',
    ])
  })

  it('keeps an explicit empty replacement while retiring all earlier catalogs', () => {
    const prompt = buildPrompt({
      ...request(),
      messages: [skillCatalog('obsolete-catalog'), skillCatalog('empty-catalog', true, [])],
    }, 2_000)

    expect(conversationTexts(prompt)).toEqual(['empty-catalog'])
  })
})
