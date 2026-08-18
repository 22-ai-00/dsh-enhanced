import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

interface FakeCatalogProcess {
  readonly stdin: PassThrough
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly messages: Record<string, unknown>[]
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: string, listener: (...args: any[]) => void): this
}

function catalogProcess(): FakeCatalogProcess {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const messages: Record<string, unknown>[] = []
  let pending = ''
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    stdout.end()
    stderr.end()
    queueMicrotask(() => events.emit('close', 0, null))
  }
  const send = (value: unknown): void => { stdout.write(`${JSON.stringify(value)}\n`) }

  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n')
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.length === 0) continue
      const message = JSON.parse(line) as Record<string, unknown>
      messages.push(message)
      if (message.method === 'initialize') {
        send({
          id: message.id,
          result: {
            userAgent: 'dsh_enhanced/0.147.0',
            codexHome: '/redacted',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        })
        send({ method: 'remoteControl/status/changed', params: { status: 'disabled' } })
      }
      if (message.method === 'model/list') {
        const params = message.params as { cursor?: string }
        if (params.cursor === undefined) {
          send({
            id: message.id,
            result: {
              data: [{
                id: 'gpt-5.6-sol',
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6-Sol',
                description: 'Latest frontier agentic coding model.',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Fast responses' },
                  { reasoningEffort: 'ultra', description: 'Maximum reasoning with delegation' },
                ],
                defaultReasoningEffort: 'low',
                inputModalities: ['text', 'image'],
                isDefault: true,
              }],
              nextCursor: 'page-2',
            },
          })
        } else {
          send({
            id: message.id,
            result: {
              data: [{
                id: 'gpt-5.6-luna',
                model: 'gpt-5.6-luna',
                displayName: 'GPT-5.6-Luna',
                description: 'Fast and affordable agentic coding model.',
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: 'low', description: 'Fast responses' },
                  { reasoningEffort: 'high', description: 'Greater reasoning depth' },
                ],
                defaultReasoningEffort: 'high',
                inputModalities: ['text', 'image'],
                isDefault: false,
              }],
              nextCursor: null,
            },
          })
        }
      }
    }
  })
  stdin.on('finish', close)
  queueMicrotask(() => events.emit('spawn'))

  return {
    stdin,
    stdout,
    stderr,
    messages,
    kill() { close(); return true },
    once(event, listener) { events.once(event, listener); return this },
  }
}

describe('Codex app-server model catalog', () => {
  it('discovers paginated models and per-model efforts without starting a thread or turn', async () => {
    const module = await import('../src/codex-catalog.ts').catch(() => ({}))
    const discover = Reflect.get(module, 'discoverCodexModels') as undefined | ((
      invocation: { command: string; cwd: string },
      options: Record<string, unknown>,
    ) => Promise<unknown>)
    expect(discover).toBeTypeOf('function')

    const child = catalogProcess()
    const spawn = vi.fn(() => child)
    await expect(discover?.({ command: 'codex', cwd: '/repo' }, {
      spawn,
      timeoutMs: 1_000,
      killGraceMs: 50,
      maxLineBytes: 64 * 1024,
      maxOutputBytes: 256 * 1024,
      maxStderrBytes: 1024,
      extraEnvNames: [],
    })).resolves.toMatchObject({
      defaultModel: 'gpt-5.6-sol',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6-Sol',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low', description: 'Fast responses' },
              { id: 'ultra', name: 'Ultra', description: 'Maximum reasoning with delegation' },
            ],
            defaultEffort: 'low',
          },
        },
        {
          id: 'gpt-5.6-luna',
          name: 'GPT-5.6-Luna',
          reasoning: {
            efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
            defaultEffort: 'high',
          },
        },
      ],
    })
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['app-server', '--config', 'model_provider="openai"'],
      expect.objectContaining({ cwd: '/repo', shell: false }),
    )
    expect(child.messages.map(message => message.method)).toEqual([
      'initialize', 'initialized', 'model/list', 'model/list',
    ])
    expect(child.messages.some(message => message.method === 'thread/start' || message.method === 'turn/start')).toBe(false)
  })
})
