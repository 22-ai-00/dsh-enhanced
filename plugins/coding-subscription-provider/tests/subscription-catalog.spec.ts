import { describe, expect, it, vi } from 'vitest'

interface CommandResult {
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

describe('subscription CLI model catalogs', () => {
  it('discovers Claude models and model-specific efforts through a prompt-free initialize control request', async () => {
    const module = await import('../src/subscription-catalog.ts').catch(() => ({}))
    const discover = Reflect.get(module, 'discoverClaudeModels') as undefined | ((
      invocation: { command: string; cwd: string },
      options: Record<string, unknown>,
    ) => Promise<unknown>)
    expect(discover).toBeTypeOf('function')

    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'dsh-model-catalog',
        response: {
          models: [
            {
              value: 'default',
              displayName: 'Default (recommended)',
              description: 'Use the account default model',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
            {
              value: 'haiku',
              displayName: 'Claude Haiku',
              description: 'Fast model',
              supportsEffort: false,
            },
          ],
          account: { apiProvider: 'firstParty' },
        },
      },
    }
    const runCommand = vi.fn(() => Promise.resolve<CommandResult>({
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify(response)}\n`,
      stderr: '',
    }))

    await expect(discover?.({ command: 'claude', cwd: '/repo' }, { runCommand })).resolves.toMatchObject({
      defaultModel: 'default',
      models: [
        {
          id: 'default',
          name: 'Default (recommended)',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
              { id: 'xhigh', name: 'Xhigh' },
              { id: 'max', name: 'Max' },
            ],
          },
        },
        { id: 'haiku', name: 'Claude Haiku' },
      ],
    })
    expect(runCommand).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']),
      expect.objectContaining({
        cwd: '/repo',
        stdin: expect.stringContaining('"subtype":"initialize"'),
      }),
    )
  })

  it('keeps Claude aliases distinguishable when local overrides share one display model', async () => {
    const { discoverClaudeModels } = await import('../src/subscription-catalog.ts')
    const models = ['opus', 'sonnet', 'haiku'].map(alias => ({
      value: alias,
      displayName: 'model_hub/es1_orange_o48',
      description: `Custom ${alias} model`,
      supportsEffort: false,
    }))
    const runCommand = vi.fn(() => Promise.resolve<CommandResult>({
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'dsh-model-catalog',
          response: { models },
        },
      })}\n`,
      stderr: '',
    }))

    await expect(discoverClaudeModels(
      { command: 'claude', cwd: '/repo' },
      { runCommand },
    )).resolves.toMatchObject({
      models: [
        { id: 'opus', name: 'Opus (model_hub/es1_orange_o48)' },
        { id: 'sonnet', name: 'Sonnet (model_hub/es1_orange_o48)' },
        { id: 'haiku', name: 'Haiku (model_hub/es1_orange_o48)' },
      ],
    })
  })

  it('discovers Grok models and exact per-model efforts through prompt-free ACP initialize', async () => {
    const module = await import('../src/subscription-catalog.ts').catch(() => ({}))
    const discover = Reflect.get(module, 'discoverGrokModels') as undefined | ((
      invocation: { command: string; cwd: string },
      options: Record<string, unknown>,
    ) => Promise<unknown>)
    expect(discover).toBeTypeOf('function')

    const response = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'grok', version: '1.0.5' },
        _meta: {
          modelState: {
            currentModelId: 'grok-4.6',
            availableModels: [
              {
                modelId: 'grok-4.6',
                name: 'Grok 4.6',
                description: 'Latest frontier model',
                _meta: {
                  supportsReasoningEffort: true,
                  reasoningEffort: 'xhigh',
                  reasoningEfforts: [
                    { id: 'xhigh', value: 'xhigh', label: 'Extra High Effort', description: 'Highest effort' },
                    { id: 'high', value: 'high', label: 'High Effort', description: 'High effort' },
                    { id: 'medium', value: 'medium', label: 'Medium Effort' },
                    { id: 'low', value: 'low', label: 'Low Effort' },
                  ],
                },
              },
              { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { supportsReasoningEffort: false } },
            ],
          },
        },
      },
    }
    const runCommand = vi.fn(() => Promise.resolve<CommandResult>({
      exitCode: 0,
      signal: null,
      stdout: `${JSON.stringify(response)}\n`,
      stderr: '',
    }))

    await expect(discover?.({ command: 'grok', cwd: '/repo' }, { runCommand })).resolves.toMatchObject({
      defaultModel: 'grok-4.6',
      models: [
        {
          id: 'grok-4.6',
          name: 'Grok 4.6',
          reasoning: {
            efforts: [
              { id: 'xhigh', name: 'Extra High Effort', description: 'Highest effort' },
              { id: 'high', name: 'High Effort' },
              { id: 'medium', name: 'Medium Effort' },
              { id: 'low', name: 'Low Effort' },
            ],
            defaultEffort: 'xhigh',
          },
        },
        { id: 'grok-4.5', name: 'Grok 4.5' },
      ],
    })
    expect(runCommand).toHaveBeenCalledWith(
      'grok',
      ['agent', 'stdio'],
      expect.objectContaining({ cwd: '/repo', stdin: expect.stringContaining('"method":"initialize"') }),
    )
  })

  it('discovers Cursor models through the official prompt-free list flag', async () => {
    const module = await import('../src/subscription-catalog.ts').catch(() => ({}))
    const discover = Reflect.get(module, 'discoverCursorModels') as undefined | ((
      invocation: { command: string; cwd: string },
      options: Record<string, unknown>,
    ) => Promise<unknown>)
    expect(discover).toBeTypeOf('function')

    const runCommand = vi.fn(() => Promise.resolve<CommandResult>({
      exitCode: 0,
      signal: null,
      stdout: 'Available models:\n  * auto (default)\n  - claude-4.6-sonnet\n  - composer-2\n',
      stderr: '',
    }))

    await expect(discover?.({ command: 'cursor-agent', cwd: '/repo' }, { runCommand })).resolves.toMatchObject({
      defaultModel: 'auto',
      models: [
        { id: 'auto', name: 'auto' },
        { id: 'claude-4.6-sonnet', name: 'claude-4.6-sonnet' },
        { id: 'composer-2', name: 'composer-2' },
      ],
    })
    expect(runCommand).toHaveBeenCalledWith(
      'cursor-agent',
      ['--list-models'],
      expect.objectContaining({ cwd: '/repo', stdin: '' }),
    )
  })
})
