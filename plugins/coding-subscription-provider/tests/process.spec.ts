import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  buildSubscriptionEnv,
  CliProcessExitError,
  parseAssistantText,
  runCliText,
  type SpawnProcess,
} from '../src/process.ts'
import { buildInvocation } from '../src/providers.ts'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kills: (NodeJS.Signals | number | undefined)[] = []
  kill(signal?: NodeJS.Signals | number): boolean { this.kills.push(signal); return true }
  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void { this.emit('close', code, signal) }
}

function fakeSpawn(child: FakeChild): SpawnProcess {
  return vi.fn(() => child) as unknown as SpawnProcess
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = []
  for await (const value of iterable) values.push(value)
  return values
}

describe('CLI process bridge', () => {
  it('spawns shell-free and streams Codex agent messages only', async () => {
    const child = new FakeChild()
    const spawn = fakeSpawn(child)
    const result = collect(runCliText(buildInvocation('codex', { cwd: '/repo', prompt: 'x' }), { spawn }))
    await Promise.resolve()
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","content":"hello"}}\n')
    child.stdout.write('{"type":"turn.completed"}\n')
    child.stderr.write('private diagnostic\n')
    child.finish()
    await expect(result).resolves.toEqual(['hello'])
    expect(spawn).toHaveBeenCalledWith('codex', expect.any(Array), expect.objectContaining({ cwd: '/repo', shell: false, detached: process.platform !== 'win32' }))
  })

  it('parses all supported streaming shapes', () => {
    expect(parseAssistantText('claude', '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"a"}}}')).toBe('a')
    expect(parseAssistantText('claude', '{"type":"result","subtype":"success","is_error":false,"result":"b"}')).toBe('b')
    expect(parseAssistantText('cursor', '{"type":"assistant","message":"c"}')).toBe('c')
    expect(parseAssistantText('cursor', '{"type":"result","subtype":"success","is_error":false,"result":"d"}')).toBe('d')
    expect(parseAssistantText('grok', '{"type":"update","delta":{"text":"e"}}')).toBe('e')
    expect(parseAssistantText('cursor', '{"type":"assistant","message":{"content":"f"}}')).toBe('f')
    expect(parseAssistantText('grok', '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"g"}}}')).toBe('g')
    expect(parseAssistantText('grok', '{"sessionUpdate":"agent_message_chunk","content":{"text":"h"}}')).toBe('h')
    expect(parseAssistantText('grok', '{"type":"content_block_delta","delta":{"type":"text_delta","text":"i"}}')).toBe('i')
    expect(parseAssistantText('grok', '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"j"}}}}')).toBe('j')
    expect(parseAssistantText('grok', '{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"k"}}}')).toBe('k')
  })

  it('interrupts then kills an aborted child', async () => {
    const child = new FakeChild()
    const controller = new AbortController()
    const stream = runCliText(buildInvocation('cursor', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(child), signal: controller.signal, killGraceMs: 1 })
    const pending = collect(stream)
    const rejected = expect(pending).rejects.toThrow('aborted')
    await Promise.resolve()
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 5))
    child.finish()
    await rejected
    expect(child.kills).toEqual(expect.arrayContaining(['SIGINT', 'SIGKILL']))
  })

  it('does not settle after SIGKILL until ChildProcess close proves teardown', async () => {
    const child = new FakeChild()
    const controller = new AbortController()
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), signal: controller.signal, killGraceMs: 1 },
    ))
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    const rejected = expect(pending).rejects.toMatchObject({ cause: 'abort' })
    await Promise.resolve()
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(child.kills).toEqual(expect.arrayContaining(['SIGINT', 'SIGKILL']))
    expect(settled).toBe(false)

    child.finish(null, 'SIGKILL')
    await rejected
    expect(settled).toBe(true)
  })

  it('waits for close after a child error and preserves the original error', async () => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child) },
    ))
    const spawnError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    const rejected = expect(pending).rejects.toBe(spawnError)
    await Promise.resolve()
    child.emit('error', spawnError)
    await Promise.resolve()
    expect(settled).toBe(false)

    child.finish(null, null)
    await rejected
    expect(settled).toBe(true)
  })

  it('does not spawn an already-aborted invocation', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()
    await expect(collect(runCliText(buildInvocation('codex', { cwd: '/repo', prompt: 'x' }), { spawn: spawn as unknown as SpawnProcess, signal: controller.signal }))).rejects.toThrow('before CLI spawn')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses a minimal inherited environment and never lets API keys override subscriptions', () => {
    const oldOpenAi = process.env.OPENAI_API_KEY
    const oldLowerOpenAi = process.env.openai_api_key
    const oldClaude = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const oldExtra = process.env.DSH_TEST_ALLOWED
    process.env.OPENAI_API_KEY = 'must-not-pass'
    process.env.openai_api_key = 'must-not-pass-either'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'subscription-login'
    process.env.DSH_TEST_ALLOWED = 'allowed'
    const env = buildSubscriptionEnv(['DSH_TEST_ALLOWED', 'OPENAI_API_KEY', 'openai_api_key'])
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.openai_api_key).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.DSH_TEST_ALLOWED).toBe('allowed')
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAi
    if (oldLowerOpenAi === undefined) delete process.env.openai_api_key; else process.env.openai_api_key = oldLowerOpenAi
    if (oldClaude === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaude
    if (oldExtra === undefined) delete process.env.DSH_TEST_ALLOWED; else process.env.DSH_TEST_ALLOWED = oldExtra
  })

  it('never inherits a Claude setup token, even after explicit opt-in', () => {
    const oldClaude = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'subscription-login'
    expect(buildSubscriptionEnv(['CLAUDE_CODE_OAUTH_TOKEN']).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    if (oldClaude === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldClaude
  })

  it('does not expose non-JSON stdout as assistant text', () => {
    expect(parseAssistantText('codex', 'warning: update available')).toBeUndefined()
  })

  it('suppresses a terminal full result after partial chunks', async () => {
    const child = new FakeChild()
    const result = collect(runCliText(buildInvocation('claude', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(child) }))
    await Promise.resolve()
    child.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"part"}}}\n')
    child.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"part complete"}\n')
    child.finish()
    await expect(result).resolves.toEqual(['part'])
  })

  it('applies output limits in UTF-8 bytes', async () => {
    const child = new FakeChild()
    const result = collect(runCliText(buildInvocation('cursor', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(child), maxOutputBytes: 3 }))
    await Promise.resolve()
    child.stdout.write('{"type":"assistant","message":"你好"}\n')
    child.finish()
    await expect(result).rejects.toThrow('3 bytes')
  })

  it('rejects an oversized final line even when an earlier newline shares its chunk', async () => {
    const child = new FakeChild()
    const result = collect(runCliText(buildInvocation('codex', { cwd: '/repo', prompt: 'x' }), {
      spawn: fakeSpawn(child),
      maxLineBytes: 16,
      killGraceMs: 1,
    }))
    const rejected = expect(result).rejects.toThrow('16 bytes')
    await Promise.resolve()
    child.stdout.end(`\n${'x'.repeat(17)}`)
    await new Promise(resolve => setTimeout(resolve, 0))
    child.finish()
    await rejected
  })

  it('returns timeout as an error and accepts a recognized Grok message plus clean close', async () => {
    const timedChild = new FakeChild()
    const timed = collect(runCliText(buildInvocation('grok', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(timedChild), timeoutMs: 1, killGraceMs: 1 }))
    const timedOut = expect(timed).rejects.toThrow('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
    timedChild.finish()
    await timedOut
    expect(timedChild.kills).toContain('SIGINT')

    const normalChild = new FakeChild()
    const normal = collect(runCliText(buildInvocation('grok', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(normalChild) }))
    await Promise.resolve()
    normalChild.stdout.write('{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}\n')
    normalChild.finish()
    await expect(normal).resolves.toEqual(['ok'])
    expect(normalChild.kills).toEqual([])
  })

  it.each([
    { code: 2 as number | null, signal: null as NodeJS.Signals | null },
    { code: 0 as number | null, signal: 'SIGTERM' as NodeJS.Signals | null },
    { code: null as number | null, signal: null as NodeJS.Signals | null },
  ])('rejects ambiguous or unsuccessful child close ($code, $signal)', async ({ code, signal }) => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child) },
    ))
    const rejected = expect(pending).rejects.toBeInstanceOf(CliProcessExitError)
    await Promise.resolve()
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n')
    child.finish(code, signal)
    await rejected
  })

  it('keeps the initiating termination error ahead of the later close status', async () => {
    const child = new FakeChild()
    const controller = new AbortController()
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), signal: controller.signal, killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({ cause: 'abort' })
    await Promise.resolve()
    controller.abort()
    child.finish(null, 'SIGINT')
    await rejected
  })

  it.each([
    {
      name: 'malformed NDJSON',
      line: 'not-json\n',
      reason: 'MALFORMED_JSON',
    },
    {
      name: 'no JSON events',
      line: '\n',
      reason: 'NO_JSON_EVENTS',
    },
    {
      name: 'only unknown JSON events',
      line: '{"type":"future.extension"}\n',
      reason: 'UNRECOGNIZED_EVENTS',
    },
    {
      name: 'valid JSON with a non-event shape',
      line: '[]\n',
      reason: 'UNRECOGNIZED_EVENTS',
    },
    {
      name: 'recognized events without assistant text',
      line: '{"type":"thread.started"}\n',
      reason: 'NO_ASSISTANT_TEXT',
    },
  ])('fails closed for $name', async ({ line, reason }) => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      cause: 'protocol',
      reason,
    })
    await Promise.resolve()
    child.stdout.write(line)
    child.finish()
    await rejected
  })

  it.each(['codex', 'claude', 'cursor'] as const)('requires a successful terminal result from %s', async provider => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation(provider, { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child) },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      reason: 'MISSING_SUCCESS_TERMINAL',
    })
    await Promise.resolve()
    if (provider === 'codex') {
      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n')
    } else if (provider === 'cursor') {
      child.stdout.write('{"type":"system","subtype":"init","apiKeySource":"login"}\n')
      child.stdout.write('{"type":"assistant","message":"partial"}\n')
    } else {
      child.stdout.write('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"partial"}}}\n')
    }
    child.finish()
    await rejected
  })

  it('accepts Cursor only after subscription auth init and a successful result', async () => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('cursor', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child) },
    ))
    await Promise.resolve()
    child.stdout.write('{"type":"system","subtype":"init","apiKeySource":"login"}\n')
    child.stdout.write('{"type":"assistant","message":"answer"}\n')
    child.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"answer"}\n')
    child.stdout.write('{"type":"future.extension"}\n')
    child.finish()
    await expect(pending).resolves.toEqual(['answer'])
  })

  it.each([
    {
      name: 'missing init',
      lines: [
        '{"type":"assistant","message":"answer"}\n',
        '{"type":"result","subtype":"success","is_error":false,"result":"answer"}\n',
      ],
      reason: 'MISSING_AUTH_EVENT',
    },
    {
      name: 'API-key auth',
      lines: ['{"type":"system","subtype":"init","apiKeySource":"env"}\n'],
      reason: 'UNEXPECTED_AUTH_SOURCE',
    },
  ])('fails Cursor subscription auth when $name is observed', async ({ lines, reason }) => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('cursor', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_SUBSCRIPTION_AUTH_ERROR',
      cause: 'subscription-auth',
      reason,
    })
    await Promise.resolve()
    for (const line of lines) child.stdout.write(line)
    child.finish()
    await rejected
  })

  it('rejects an explicit failed result even when text was emitted', async () => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('claude', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      cause: 'protocol',
      reason: 'REPORTED_FAILURE',
    })
    await Promise.resolve()
    child.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n')
    child.stdout.write('{"type":"result","subtype":"error","is_error":true}\n')
    child.finish()
    await rejected
  })

  it.each([
    { provider: 'claude' as const, result: '{"type":"result","result":"partial"}', reason: 'INVALID_TERMINAL' },
    { provider: 'cursor' as const, result: '{"type":"result","subtype":"future","is_error":false,"result":"partial"}', reason: 'INVALID_TERMINAL' },
    { provider: 'claude' as const, result: '{"type":"result","subtype":"cancelled","is_error":false,"result":"partial"}', reason: 'REPORTED_FAILURE' },
    { provider: 'cursor' as const, result: '{"type":"result","subtype":"interrupted","is_error":false,"result":"partial"}', reason: 'REPORTED_FAILURE' },
  ])('rejects $provider terminal result unless it is explicitly successful ($reason)', async ({ provider, result, reason }) => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation(provider, { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      cause: 'protocol',
      reason,
    })
    await Promise.resolve()
    if (provider === 'cursor') child.stdout.write('{"type":"system","subtype":"init","apiKeySource":"login"}\n')
    child.stdout.write('{"type":"assistant","message":"partial"}\n')
    child.stdout.write(`${result}\n`)
    child.finish()
    await rejected
  })

  it('waits for child teardown when a stream consumer closes early', async () => {
    const child = new FakeChild()
    const iterator = runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 10 },
    )[Symbol.asyncIterator]()
    const first = iterator.next()
    await Promise.resolve()
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n')
    await expect(first).resolves.toEqual({ done: false, value: 'partial' })
    const closing = iterator.return?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(child.kills).toContain('SIGINT')
    child.finish()
    await expect(closing).resolves.toMatchObject({ done: true })
  })
})
