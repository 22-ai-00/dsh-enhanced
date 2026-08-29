import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  buildSubscriptionEnv,
  CliProcessExitError,
  parseAssistantText,
  runCliText,
  type ProviderFailureContext,
  type SpawnProcess,
} from '../src/process.ts'
import { buildInvocation, type CliInvocation } from '../src/providers.ts'

class FakeChild extends EventEmitter {
  stdin: PassThrough | null = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kills: (NodeJS.Signals | number | undefined)[] = []
  kill(signal?: NodeJS.Signals | number): boolean { this.kills.push(signal); return true }
  spawn(): void { this.emit('spawn') }
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
    expect(spawn).toHaveBeenCalledWith('codex', expect.any(Array), expect.objectContaining({
      cwd: '/repo', shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    }))
    expect(child.stdin?.read()?.toString()).toBe('x')
  })

  it('streams a prompt larger than the former 128 KiB limit through a real child stdin', async () => {
    const prompt = `large-private-prompt:${'界'.repeat(96 * 1024)}`
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(128 * 1024)
    const script = [
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', chunk => { input += chunk })",
      "process.stdin.on('end', () => {",
      "  const bytes = Buffer.byteLength(input, 'utf8')",
      "  const transport = process.argv.includes(input) ? 'argv-leak' : 'stdin-only'",
      "  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', content: `${bytes}:${transport}` } }) + '\\n')",
      "  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')",
      '})',
    ].join(';')
    const invocation: CliInvocation = {
      provider: 'codex',
      command: process.execPath,
      args: ['--eval', script],
      prompt,
      promptTransport: 'stdin',
      cwd: process.cwd(),
      shell: false,
    }

    expect(invocation.args.join('\0')).not.toContain(prompt)
    await expect(collect(runCliText(invocation, { timeoutMs: 10_000 }))).resolves.toEqual([
      `${Buffer.byteLength(prompt, 'utf8')}:stdin-only`,
    ])
  })

  it('uses and removes a mode-0600 private prompt file for Grok Windows transport', async () => {
    const prompt = 'windows-private-prompt-content'
    const child = new FakeChild()
    let promptPath: string | undefined
    const spawn: SpawnProcess = (_command, args) => {
      const promptFlag = args.indexOf('--prompt-file')
      const value = args[promptFlag + 1]
      if (promptFlag < 0 || value === undefined) throw new Error('missing prepared prompt path')
      promptPath = value
      expect(args.join('\0')).not.toContain(prompt)
      expect(readFileSync(value, 'utf8')).toBe(prompt)
      if (process.platform !== 'win32') expect(statSync(value).mode & 0o777).toBe(0o600)
      queueMicrotask(() => {
        child.spawn()
        child.stdout.write('{"type":"text","data":"ok"}\n')
        child.stdout.write('{"type":"end","stopReason":"end_turn"}\n')
        child.finish()
      })
      return child
    }

    const invocation = buildInvocation('grok', { cwd: '/repo', prompt }, 'win32')
    await expect(collect(runCliText(invocation, { spawn }))).resolves.toEqual(['ok'])
    expect(promptPath).toBeDefined()
    expect(existsSync(promptPath!)).toBe(false)
    expect(existsSync(dirname(promptPath!))).toBe(false)
    expect(child.stdin?.read()).toBeNull()
  })

  it('removes the Grok Windows prompt file when spawn throws before submission', async () => {
    let promptPath: string | undefined
    let context: ProviderFailureContext | undefined
    const spawn: SpawnProcess = (_command, args) => {
      const promptFlag = args.indexOf('--prompt-file')
      promptPath = args[promptFlag + 1]
      throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    }
    const invocation = buildInvocation('grok', { cwd: '/repo', prompt: 'private' }, 'win32')
    await expect(collect(runCliText(invocation, {
      spawn,
      onSettled: value => { context = value },
    }))).rejects.toThrow('spawn failed')
    expect(promptPath).toBeDefined()
    expect(existsSync(promptPath!)).toBe(false)
    expect(existsSync(dirname(promptPath!))).toBe(false)
    expect(context).toMatchObject({ phase: 'spawn', promptSubmissionState: 'not-submitted' })
  })

  it.each([
    ['error', 'WRITE_FAILED'] as const,
    ['close', 'CLOSED_EARLY'] as const,
  ])('fails safely when prompt stdin emits %s', async (event, reason) => {
    const secret = 'prompt-content-must-not-enter-errors'
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: secret }),
      { spawn: fakeSpawn(child), killGraceMs: 100, onSettled: value => { context = value } },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROMPT_INPUT_ERROR',
      cause: 'prompt-input',
      reason,
      message: expect.not.stringContaining(secret),
    })
    await Promise.resolve()
    child.spawn()
    if (event === 'error') child.stdin?.emit('error', new Error(`write failed: ${secret}`))
    else child.stdin?.emit('close')
    expect(child.kills).toContain('SIGINT')
    child.finish(null, 'SIGINT')
    await rejected
    expect(context).toMatchObject({ phase: 'prompt', promptSubmissionState: 'unknown' })
  })

  it('fails before submission when a spawned child has no stdin pipe', async () => {
    const child = new FakeChild()
    child.stdin = null
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'private' }),
      { spawn: fakeSpawn(child), killGraceMs: 100, onSettled: value => { context = value } },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROMPT_INPUT_ERROR', reason: 'MISSING_STDIN', cause: 'prompt-input',
    })
    await Promise.resolve()
    child.spawn()
    child.finish(null, 'SIGINT')
    await rejected
    expect(context).toMatchObject({ phase: 'prompt', promptSubmissionState: 'not-submitted' })
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

  it.each([
    {
      name: 'a Codex command execution item',
      provider: 'codex' as const,
      lines: ['{"type":"item.started","item":{"type":"command_execution","command":"pwd","status":"in_progress"}}\n'],
    },
    {
      name: 'a malformed Codex item lifecycle without a passive item type',
      provider: 'codex' as const,
      lines: ['{"type":"item.started","item":{"status":"in_progress"}}\n'],
    },
    {
      name: 'a Claude tool_use assistant block',
      provider: 'claude' as const,
      lines: ['{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"README.md"}}]}}\n'],
    },
    {
      name: 'a Claude server_tool_use stream block',
      provider: 'claude' as const,
      lines: ['{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search"}}}\n'],
    },
    {
      name: 'a Claude input_json_delta',
      provider: 'claude' as const,
      lines: ['{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}}\n'],
    },
    {
      name: 'a Claude tool_progress event',
      provider: 'claude' as const,
      lines: ['{"type":"tool_progress","tool_use_id":"toolu_1","tool_name":"Read","elapsed_time_seconds":0.1}\n'],
    },
    {
      name: 'a non-empty Claude native tool catalog',
      provider: 'claude' as const,
      lines: ['{"type":"system","subtype":"init","tools":["Read"]}\n'],
    },
    {
      name: 'an official Cursor tool_call event',
      provider: 'cursor' as const,
      lines: [
        '{"type":"system","subtype":"init","apiKeySource":"login"}\n',
        '{"type":"tool_call","subtype":"started","call_id":"toolu_1","tool_call":{"readToolCall":{"args":{"path":"README.md"}}}}\n',
      ],
    },
    {
      name: 'a Cursor tool_result event',
      provider: 'cursor' as const,
      lines: [
        '{"type":"system","subtype":"init","apiKeySource":"login"}\n',
        '{"type":"tool_result","call_id":"toolu_1","result":{"content":"contents"}}\n',
      ],
    },
    {
      name: 'a Grok headless tool_call event',
      provider: 'grok' as const,
      lines: ['{"type":"tool_call","toolCallId":"call-1","toolName":"list_dir","status":"pending"}\n'],
    },
    {
      name: 'a Grok ACP tool_call_update event',
      provider: 'grok' as const,
      lines: ['{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed"}}}\n'],
    },
    {
      name: 'a Grok native tool_use terminal',
      provider: 'grok' as const,
      lines: ['{"type":"end","stopReason":"tool_use"}\n'],
    },
    {
      name: 'a non-empty Grok native tool catalog',
      provider: 'grok' as const,
      lines: ['{"type":"available_commands","tools":["read_file"],"commands":[]}\n'],
    },
  ])('fails closed immediately for $name', async ({ provider, lines }) => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation(provider, { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100, onSettled: value => { context = value } },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      cause: 'protocol',
      reason: 'NATIVE_TOOL_EVENT',
    })
    await Promise.resolve()
    child.spawn()
    for (const line of lines) child.stdout.write(line)
    await Promise.resolve()
    expect(child.kills).toContain('SIGINT')
    child.finish(null, 'SIGINT')

    await rejected
    expect(context).toMatchObject({
      phase: 'terminal',
      terminalReason: 'native-tool-event',
      teardownState: 'completed',
    })
  })

  it('accepts Grok 1.0.5 native streaming-json success events', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('grok', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { context = value } },
    ))
    await Promise.resolve()
    child.spawn()
    child.stdout.write('{"type":"available_commands","tools":[],"commands":[]}\n')
    child.stdout.write('{"type":"text","data":"GROK_PROVIDER_"}\n')
    child.stdout.write('{"type":"text","data":"OK"}\n')
    child.stdout.write('{"type":"usage","stopReason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}\n')
    child.stdout.write('{"type":"end","stopReason":"end_turn","num_turns":1}\n')
    child.finish()

    await expect(pending).resolves.toEqual(['GROK_PROVIDER_', 'OK'])
    expect(context).toMatchObject({
      phase: 'terminal',
      assistantTextObserved: true,
      terminalReason: 'success',
      exitCode: 0,
      signal: null,
    })
  })

  it('requires Grok native end even after a legacy successful result', async () => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('grok', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child) },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      reason: 'MISSING_SUCCESS_TERMINAL',
    })
    await Promise.resolve()
    child.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"legacy answer"}\n')
    child.finish()

    await rejected
  })

  it('fails closed when Grok 1.0.5 emits a native error event', async () => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('grok', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      reason: 'REPORTED_FAILURE',
    })
    await Promise.resolve()
    child.spawn()
    child.stdout.write('{"type":"error","message":"model request failed"}\n')
    child.finish(1, null)

    await rejected
    expect(child.kills).toContain('SIGINT')
  })

  it('interrupts then kills an aborted child', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const controller = new AbortController()
      const stream = runCliText(buildInvocation('cursor', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(child), signal: controller.signal, killGraceMs: 1 })
      const pending = collect(stream)
      const rejected = expect(pending).rejects.toThrow('aborted')
      await Promise.resolve()
      controller.abort()
      await vi.advanceTimersByTimeAsync(1)
      expect(child.kills).toEqual(expect.arrayContaining(['SIGINT', 'SIGKILL']))
      expect(child.stdin?.destroyed).toBe(true)
      child.finish(null, 'SIGKILL')
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not arm SIGKILL when SIGINT synchronously closes the child', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      child.kill = (signal?: NodeJS.Signals | number): boolean => {
        child.kills.push(signal)
        child.finish(null, signal === 'SIGINT' ? 'SIGINT' : null)
        return true
      }
      const controller = new AbortController()
      const calls: ProviderFailureContext[] = []
      const pending = collect(runCliText(
        buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
        { spawn: fakeSpawn(child), signal: controller.signal, killGraceMs: 10, onSettled: value => { calls.push(value) } },
      ))
      const rejected = expect(pending).rejects.toMatchObject({ cause: 'abort' })
      await Promise.resolve()
      child.spawn()
      controller.abort()
      await rejected
      await vi.advanceTimersByTimeAsync(100)
      expect(child.kills).toEqual(['SIGINT'])
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ teardownState: 'completed', exitCode: null, signal: 'SIGINT' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles with an explicit live-process risk when close never follows SIGKILL', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const controller = new AbortController()
      const calls: ProviderFailureContext[] = []
      const pending = collect(runCliText(
        buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
        { spawn: fakeSpawn(child), signal: controller.signal, killGraceMs: 10, onSettled: value => { calls.push(value) } },
      ))
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      const rejected = expect(pending).rejects.toMatchObject({ cause: 'abort' })
      await Promise.resolve()
      child.spawn()
      controller.abort()
      await vi.advanceTimersByTimeAsync(10)
      expect(child.kills).toEqual(expect.arrayContaining(['SIGINT', 'SIGKILL']))
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(10)
      await rejected
      expect(settled).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        phase: 'child-close',
        promptSubmissionState: 'submitted',
        teardownState: 'timed-out',
      })
      expect(calls[0]?.exitCode).toBeUndefined()
      expect(calls[0]?.signal).toBeUndefined()
      expect(child.listenerCount('close')).toBe(1)
      expect(child.stdout.listenerCount('data')).toBe(1)
      expect(child.stderr.listenerCount('data')).toBe(1)
      child.finish(null, 'SIGKILL')
      expect(calls).toHaveLength(1)
      expect(child.listenerCount('close')).toBe(0)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
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

  it('does not miss an abort that occurs while spawn() is returning', async () => {
    const child = new FakeChild()
    const controller = new AbortController()
    let context: ProviderFailureContext | undefined
    const spawn = vi.fn(() => {
      controller.abort()
      return child
    }) as unknown as SpawnProcess
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn, signal: controller.signal, killGraceMs: 100, onSettled: value => { context = value } },
    ))
    const rejected = expect(pending).rejects.toMatchObject({ cause: 'abort' })
    await Promise.resolve()
    expect(child.kills).toContain('SIGINT')
    child.finish(null, 'SIGINT')
    await rejected
    expect(context).toMatchObject({ promptSubmissionState: 'not-submitted', teardownState: 'completed', signal: 'SIGINT' })
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
    await expect(result).rejects.toMatchObject({ message: expect.stringContaining('3 bytes'), cause: 'output-limit' })
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

  it('returns timeout as an error and accepts a recognized Grok message plus successful end', async () => {
    const timedChild = new FakeChild()
    const timed = collect(runCliText(buildInvocation('grok', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(timedChild), timeoutMs: 1, killGraceMs: 100 }))
    const timedOut = expect(timed).rejects.toThrow('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
    timedChild.finish()
    await timedOut
    expect(timedChild.kills).toContain('SIGINT')

    const normalChild = new FakeChild()
    const normal = collect(runCliText(buildInvocation('grok', { cwd: '/repo', prompt: 'x' }), { spawn: fakeSpawn(normalChild) }))
    await Promise.resolve()
    normalChild.stdout.write('{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}\n')
    normalChild.stdout.write('{"type":"end","stopReason":"end_turn"}\n')
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

  it('classifies the Codex non-repository cwd rejection without exposing stderr', async () => {
    const child = new FakeChild()
    const diagnostics: string[] = []
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/workspace-parent', prompt: 'x' }),
      { spawn: fakeSpawn(child), onDiagnostic: value => { diagnostics.push(value) } },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_WORKING_DIRECTORY_ERROR',
      cause: 'working-directory',
      provider: 'codex',
      message: 'codex CLI refused its configured working directory',
    })
    await Promise.resolve()
    child.spawn()
    child.stderr.write('Reading additional input from stdin...\n')
    child.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.\n')
    child.finish(1, null)
    await rejected
    expect(diagnostics).toEqual([
      'Reading additional input from stdin...\nNot inside a trusted directory and --skip-git-repo-check was not specified.',
    ])
  })

  it.each([
    {
      name: 'an ambiguous null-code close',
      provider: 'codex' as const,
      code: null as number | null,
      signal: null as NodeJS.Signals | null,
      diagnostic: 'Not inside a trusted directory and --skip-git-repo-check was not specified.\n',
    },
    {
      name: 'a different nonzero exit code',
      provider: 'codex' as const,
      code: 2 as number | null,
      signal: null as NodeJS.Signals | null,
      diagnostic: 'Not inside a trusted directory and --skip-git-repo-check was not specified.\n',
    },
    {
      name: 'a signalled exit',
      provider: 'codex' as const,
      code: 1 as number | null,
      signal: 'SIGTERM' as NodeJS.Signals | null,
      diagnostic: 'Not inside a trusted directory and --skip-git-repo-check was not specified.\n',
    },
    {
      name: 'the same text from another provider',
      provider: 'claude' as const,
      code: 1 as number | null,
      signal: null as NodeJS.Signals | null,
      diagnostic: 'Not inside a trusted directory and --skip-git-repo-check was not specified.\n',
    },
    {
      name: 'only the diagnostic prefix',
      provider: 'codex' as const,
      code: 1 as number | null,
      signal: null as NodeJS.Signals | null,
      diagnostic: 'Not inside a trusted directory.\n',
    },
    {
      name: 'the diagnostic mixed with an unrelated failure',
      provider: 'codex' as const,
      code: 1 as number | null,
      signal: null as NodeJS.Signals | null,
      diagnostic: 'Not inside a trusted directory and --skip-git-repo-check was not specified.\nwrapper failed for another reason\n',
    },
    {
      name: 'the diagnostic after stdout protocol output',
      provider: 'codex' as const,
      code: 1 as number | null,
      signal: null as NodeJS.Signals | null,
      stdout: '{"type":"thread.started"}\n',
      diagnostic: 'Not inside a trusted directory and --skip-git-repo-check was not specified.\n',
    },
  ])('keeps $name as a generic process exit', async ({ provider, code, signal, stdout, diagnostic }) => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation(provider, { cwd: '/workspace-parent', prompt: 'x' }),
      { spawn: fakeSpawn(child) },
    ))
    const rejected = expect(pending).rejects.toBeInstanceOf(CliProcessExitError)
    await Promise.resolve()
    child.spawn()
    if (stdout !== undefined) child.stdout.write(stdout)
    child.stderr.write(diagnostic)
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
      reason: 'UNKNOWN_EVENT',
    },
    {
      name: 'valid JSON with a non-event shape',
      line: '[]\n',
      reason: 'UNKNOWN_EVENT',
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

  it.each([
    {
      provider: 'claude' as const,
      line: '{"type":"stream_event","event":{"type":"future_active"}}\n',
    },
    {
      provider: 'grok' as const,
      line: '{"type":"stream_event","event":{"type":"future_active"}}\n',
    },
    {
      provider: 'grok' as const,
      line: '{"sessionUpdate":"future_active"}\n',
    },
    {
      provider: 'grok' as const,
      line: '{"method":"session/update","params":{"update":{"sessionUpdate":"future_active"}}}\n',
    },
  ])('fails closed for an unknown nested $provider event', async ({ provider, line }) => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation(provider, { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      reason: 'UNKNOWN_EVENT',
    })
    await Promise.resolve()
    child.stdout.write(line)
    child.finish(null, 'SIGINT')
    await rejected
  })

  it('rejects a tool envelope emitted after a successful terminal event', async () => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      reason: 'EVENT_AFTER_TERMINAL',
    })
    await Promise.resolve()
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","content":"answer"}}\n')
    child.stdout.write('{"type":"turn.completed"}\n')
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","content":"{\\"protocol\\":\\"dsh-tool-calls/v1\\",\\"calls\\":[]}"}}\n')
    child.finish(null, 'SIGINT')
    await rejected
  })

  it.each([
    {
      provider: 'codex' as const,
      line: '{"type":"turn.failed"}\n',
      terminalReason: 'reported-failure',
    },
    {
      provider: 'claude' as const,
      line: '{"type":"result","subtype":"mystery","is_error":false}\n',
      terminalReason: 'invalid-terminal',
    },
  ])('records terminal context for $terminalReason', async ({ provider, line, terminalReason }) => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation(provider, { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100, onSettled: value => { context = value } },
    ))
    const rejected = expect(pending).rejects.toMatchObject({ cause: 'protocol' })
    await Promise.resolve()
    child.spawn()
    child.stdout.write(line)
    child.finish(null, 'SIGINT')
    await rejected
    expect(context).toMatchObject({ phase: 'terminal', terminalReason })
  })

  it.each(['codex', 'claude', 'cursor', 'grok'] as const)('requires a successful terminal result from %s', async provider => {
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
    } else if (provider === 'grok') {
      child.stdout.write('{"type":"text","data":"partial"}\n')
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
    child.finish()
    await expect(pending).resolves.toEqual(['answer'])
  })

  it('fails closed for an unknown event even after recognized text', async () => {
    const child = new FakeChild()
    const pending = collect(runCliText(
      buildInvocation('cursor', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), killGraceMs: 100 },
    ))
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'CLI_PROTOCOL_ERROR',
      reason: 'UNKNOWN_EVENT',
    })
    await Promise.resolve()
    child.stdout.write('{"type":"system","subtype":"init","apiKeySource":"login"}\n')
    child.stdout.write('{"type":"assistant","message":"answer"}\n')
    child.stdout.write('{"type":"future.extension"}\n')
    child.finish(null, 'SIGINT')
    await rejected
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
    { provider: 'grok' as const, result: '{"type":"end","stopReason":"cancelled"}', reason: 'REPORTED_FAILURE' },
    { provider: 'grok' as const, result: '{"type":"end","stopReason":"max_tokens"}', reason: 'REPORTED_FAILURE' },
    { provider: 'grok' as const, result: '{"type":"end","stopReason":"max_turn_requests"}', reason: 'REPORTED_FAILURE' },
    { provider: 'grok' as const, result: '{"type":"end","stopReason":"future_reason"}', reason: 'INVALID_TERMINAL' },
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

  it('reports submitted lifecycle context after a spawn event on a clean close', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const result = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { context = value } },
    ))
    await Promise.resolve()
    child.spawn()
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","content":"hi"}}\n')
    child.stdout.write('{"type":"turn.completed"}\n')
    child.finish()
    await expect(result).resolves.toEqual(['hi'])
    expect(context).toMatchObject({
      phase: 'terminal',
      promptSubmissionState: 'submitted',
      assistantTextObserved: true,
      terminalReason: 'success',
      teardownState: 'not-started',
    })
    // A clean close never enters teardown, so no teardown metric; forward latency anchors exist.
    expect(context?.metrics?.spawnToTerminalMs).toBeTypeOf('number')
    expect(context?.metrics?.teardownDurationMs).toBeUndefined()
  })

  it('anchors spawn latency metrics to the child spawn event, not spawn() return', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const result = collect(runCliText(
        buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
        { spawn: fakeSpawn(child), onSettled: value => { context = value } },
      ))
      await Promise.resolve()
      now = 100
      child.spawn()
      now = 130
      child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","content":"hi"}}\n')
      now = 160
      child.stdout.write('{"type":"turn.completed"}\n')
      now = 170
      child.finish()
      await expect(result).resolves.toEqual(['hi'])
      expect(context?.metrics).toMatchObject({
        spawnToFirstEventMs: 30,
        eventToFirstTextMs: 0,
        spawnToTerminalMs: 60,
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('omits spawn-anchored metrics when no spawn event was observed', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { context = value } },
    ))
    const spawnError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    const rejected = expect(pending).rejects.toBe(spawnError)
    await Promise.resolve()
    child.emit('error', spawnError)
    child.finish(null, null)
    await rejected
    expect(context?.metrics?.spawnToFirstEventMs).toBeUndefined()
    expect(context?.metrics?.spawnToTerminalMs).toBeUndefined()
  })

  it('keeps submission not-submitted when a spawn error precedes any spawn event', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { context = value } },
    ))
    const spawnError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' })
    const rejected = expect(pending).rejects.toBe(spawnError)
    await Promise.resolve()
    child.emit('error', spawnError)
    child.finish(null, null)
    await rejected
    expect(context).toMatchObject({ promptSubmissionState: 'not-submitted', assistantTextObserved: false })
  })

  it('keeps submission not-submitted for a non-ENOENT pre-spawn error (e.g. EACCES)', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { context = value } },
    ))
    const spawnError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const rejected = expect(pending).rejects.toBe(spawnError)
    await Promise.resolve()
    child.emit('error', spawnError)
    child.finish(null, null)
    await rejected
    expect(context).toMatchObject({ promptSubmissionState: 'not-submitted', assistantTextObserved: false })
  })

  it('records submission when stdin finishes before an error even if the spawn event was missed', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { context = value } },
    ))
    const rejected = expect(pending).rejects.toBeDefined()
    await Promise.resolve()
    // Child output activates the defensive stdin fallback even though the reduced
    // process shim omitted its spawn event. A full writable finish proves submission.
    child.stdout.write('{"type":"noise"}\n')
    await Promise.resolve()
    child.emit('error', Object.assign(new Error('late failure'), { code: 'EPIPE' }))
    child.finish(null, null)
    await rejected
    expect(context).toMatchObject({ promptSubmissionState: 'submitted' })
  })

  it('records observed assistant text and exit status when a submitted turn fails at close', async () => {
    const child = new FakeChild()
    let context: ProviderFailureContext | undefined
    const pending = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { context = value } },
    ))
    const rejected = expect(pending).rejects.toBeInstanceOf(CliProcessExitError)
    await Promise.resolve()
    child.spawn()
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n')
    child.finish(2, null)
    await rejected
    expect(context).toMatchObject({
      phase: 'child-close',
      promptSubmissionState: 'submitted',
      assistantTextObserved: true,
      exitCode: 2,
      signal: null,
    })
  })

  it('reports a not-submitted context when the signal is already aborted before spawn', async () => {
    const controller = new AbortController()
    controller.abort()
    let context: ProviderFailureContext | undefined
    const spawn = vi.fn()
    await expect(collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: spawn as unknown as SpawnProcess, signal: controller.signal, onSettled: value => { context = value } },
    ))).rejects.toThrow('before CLI spawn')
    expect(spawn).not.toHaveBeenCalled()
    expect(context).toMatchObject({ phase: 'spawn', promptSubmissionState: 'not-submitted', assistantTextObserved: false })
  })

  it('reports a not-submitted context when spawn throws synchronously', async () => {
    let context: ProviderFailureContext | undefined
    const spawn = (() => { throw Object.assign(new Error('no exec'), { code: 'ENOENT' }) }) as unknown as SpawnProcess
    await expect(collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn, onSettled: value => { context = value } },
    ))).rejects.toThrow('no exec')
    expect(context).toMatchObject({ phase: 'spawn', promptSubmissionState: 'not-submitted' })
  })

  it('completes teardown and records a teardown metric when an abort tears the child down', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const controller = new AbortController()
      let context: ProviderFailureContext | undefined
      const pending = collect(runCliText(
        buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
        { spawn: fakeSpawn(child), signal: controller.signal, killGraceMs: 1, onSettled: value => { context = value } },
      ))
      const rejected = expect(pending).rejects.toMatchObject({ cause: 'abort' })
      await Promise.resolve()
      child.spawn()
      controller.abort()
      await vi.advanceTimersByTimeAsync(1)
      child.finish(null, 'SIGKILL')
      await rejected
      expect(context).toMatchObject({ teardownState: 'completed', exitCode: null, signal: 'SIGKILL' })
      expect(context?.metrics?.teardownDurationMs).toBeTypeOf('number')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports settled context exactly once even when the diagnostic sink throws', async () => {
    const child = new FakeChild()
    const calls: ProviderFailureContext[] = []
    const result = collect(runCliText(
      buildInvocation('codex', { cwd: '/repo', prompt: 'x' }),
      { spawn: fakeSpawn(child), onSettled: value => { calls.push(value); throw new Error('sink boom') } },
    ))
    await Promise.resolve()
    child.spawn()
    child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","content":"hi"}}\n')
    child.stdout.write('{"type":"turn.completed"}\n')
    child.finish()
    await expect(result).resolves.toEqual(['hi'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ phase: 'terminal', terminalReason: 'success' })
  })
})
