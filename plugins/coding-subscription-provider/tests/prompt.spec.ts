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

describe('DSH request serialization', () => {
  it('keeps system and ordered messages while omitting historical reasoning', () => {
    const prompt = buildPrompt(request(), 100_000)
    expect(prompt).toContain('Be concise.')
    expect(prompt).toContain('你好')
    expect(prompt).toContain('reasoning-omitted')
    expect(prompt).not.toContain('private')
  })

  it('enforces a UTF-8 prompt bound', () => {
    expect(() => buildPrompt(request(), 10)).toThrow(/configured limit/)
  })
})
