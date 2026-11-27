import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parseDocument } from 'yaml'
import {
  DEFAULT_KEY_INPUT_ENV,
  PROVIDER_EXIT_RUNTIME,
  PROVIDER_EXIT_USAGE,
  PROVIDER_EXIT_VERIFY,
  ProviderCommandError,
  consumeRawSecretChunk,
  defaultDumpProfileConfig,
  deriveKeyRef,
  loadDshProviderRuntime,
  parseProviderArgs,
  renderUpdatedCordisPatchYaml,
  renderUpdatedCredentialsYaml,
  runProvider,
  selectTargetProfile,
  type DshConfigurableProvider,
  type DshDiscoveredModel,
  type DshModelDiscoveryRequest,
  type DshProviderRuntime,
  type ParsedDumpConfig,
  type ProviderPrompter,
  type RawSecretReaderState,
} from '../src/provider.ts'

const PATCH_TAGS = [
  { tag: '!js', resolve: (v: string) => v },
  { tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v },
]

const tempRoots: string[] = []

function makeTempDir(prefix = 'dsh-ray-provider-test-'): string {
  const base = process.env.TMPDIR && existsSync(process.env.TMPDIR) ? process.env.TMPDIR : tmpdir()
  const dir = mkdtempSync(join(base, prefix))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function createTestRuntime(overrides: Partial<DshProviderRuntime> = {}): DshProviderRuntime {
  const catalogProviders: DshConfigurableProvider[] = [
    {
      provider: 'anthropic',
      displayName: 'Anthropic',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'anthropic'],
      declared: false,
      defaultBaseURL: 'https://api.anthropic.com',
      nativeAuth: { env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'], oauth: true },
    },
    {
      provider: 'google',
      displayName: 'Google Gemini',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'google'],
      declared: false,
      defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
      nativeAuth: { env: ['GEMINI_API_KEY'], oauth: false },
    },
    {
      provider: 'moonshotai-cn',
      displayName: 'Moonshot AI (China)',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'moonshotai-cn'],
      declared: false,
      defaultBaseURL: 'https://api.moonshot.cn/v1',
      nativeAuth: { env: ['MOONSHOT_API_KEY'], oauth: false },
    },
    {
      provider: 'openai',
      displayName: 'OpenAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
      defaultBaseURL: 'https://api.openai.com/v1',
      nativeAuth: { env: ['OPENAI_API_KEY'], oauth: false },
    },
    {
      provider: 'openrouter',
      displayName: 'OpenRouter',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openrouter'],
      declared: false,
      defaultBaseURL: 'https://openrouter.ai/api/v1',
      nativeAuth: { env: ['OPENROUTER_API_KEY'], oauth: false },
    },
  ]

  const catalogModels: Record<string, DshDiscoveredModel[]> = {
    openrouter: [
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
      { id: 'openai/gpt-5', name: 'GPT-5' },
    ],
    'moonshotai-cn': [
      { id: 'kimi-k2-0711-preview', name: 'Kimi K2' },
    ],
    anthropic: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    ],
  }

  return {
    hostVersion: '0.2.2-rc.5',
    dshPath: '/usr/local/bin/dsh',
    dshPackageJsonPath: '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    protocols: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'],
    catalogProviders,
    deepseekModels: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    async discoverModels(request: DshModelDiscoveryRequest): Promise<DshDiscoveredModel[]> {
      if (request.provider) {
        return catalogModels[request.provider] ?? []
      }
      if (request.baseURL?.includes('custom.example')) {
        return [
          { id: 'qwen-3-coder', name: 'Qwen 3 Coder' },
          { id: 'glm-4.6', name: 'GLM 4.6' },
        ]
      }
      return []
    },
    ...overrides,
  }
}

function createScriptedPrompter(answers: readonly string[], secrets: readonly string[] = []): ProviderPrompter {
  const queue = [...answers]
  const secretQueue = [...secrets]
  return {
    async ask(): Promise<string> {
      if (queue.length === 0) throw new Error('Test prompter ran out of ask() answers')
      return queue.shift()!
    },
    async askSecret(): Promise<string> {
      if (secretQueue.length === 0) return ''
      return secretQueue.shift()!
    },
  }
}

function seedHomeWithProfile(
  root: string,
  profile = 'web',
  patchContent = '[]\n',
): { home: string; dshHome: string; patchPath: string; credentialsPath: string } {
  const home = join(root, 'user-home')
  const dshHome = join(root, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, patchContent, 'utf8')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}` }))
  return {
    home,
    dshHome,
    patchPath,
    credentialsPath: join(dshHome, '.credentials.yaml'),
  }
}

function createBufferWriter() {
  const chunks: string[] = []
  return {
    writer: { write: (chunk: string) => chunks.push(chunk) },
    text: () => chunks.join(''),
  }
}

function parsePatchRows(source: string): Array<{ id?: string; name?: string; disabled?: boolean; config?: Record<string, unknown> }> {
  return parseDocument(source, { customTags: PATCH_TAGS }).toJS() as Array<{
    id?: string
    name?: string
    disabled?: boolean
    config?: Record<string, unknown>
  }>
}

function readDumpFromPatch(patchPath: string, profile: string): ParsedDumpConfig {
  const rawYaml = readFileSync(patchPath, 'utf8')
  const rawItems = parseDocument(rawYaml, { customTags: PATCH_TAGS }).toJS() as Array<{
    id?: string
    name?: string
    disabled?: boolean
    config?: Record<string, unknown>
    insert?: Array<{ id?: string; name?: string; disabled?: boolean; config?: Record<string, unknown> }>
  }>
  const rows: ParsedDumpConfig['rows'] = []
  for (const item of rawItems) {
    if (Array.isArray(item.insert)) {
      for (const nested of item.insert) {
        rows.push({
          id: nested.id ?? '',
          name: nested.name ?? '',
          ...(nested.disabled !== undefined ? { disabled: nested.disabled } : {}),
          ...(nested.config ? { config: nested.config } : {}),
        })
      }
      continue
    }
    rows.push({
      id: item.id ?? '',
      name: item.name ?? '',
      ...(item.disabled !== undefined ? { disabled: item.disabled } : {}),
      ...(item.config ? { config: item.config } : {}),
    })
  }
  return { schemaVersion: 1, profile, rows, rawYaml }
}

describe('provider argument and helper parsing', () => {
  test('parses subcommands and equals/space flags consistently', () => {
    expect(parseProviderArgs([])).toMatchObject({ action: 'setup', setDefault: true, restart: true })
    expect(parseProviderArgs(['help'])).toMatchObject({ action: 'help' })
    expect(parseProviderArgs(['list', '--profile=work', '--json'])).toMatchObject({
      action: 'list',
      profile: 'work',
      json: true,
    })
    expect(parseProviderArgs(['--profile=work', '--json', 'list'])).toMatchObject({
      action: 'list',
      profile: 'work',
      json: true,
    })
    expect(parseProviderArgs(['remove', 'openrouter', '--keep-key', '--yes', '--dry-run'])).toMatchObject({
      action: 'remove',
      provider: 'openrouter',
      keepKey: true,
      yes: true,
      dryRun: true,
    })
    expect(
      parseProviderArgs([
        'setup',
        '--profile', 'web',
        '--provider', 'my-gw',
        '--custom',
        '--model', 'qwen-3',
        '--reasoning-effort', 'high',
        '--base-url', 'https://api.example.com/v1',
        '--api', 'openai-completions',
        '--display-name', 'My Gateway',
        '--api-key-env', 'MY_GW_KEY',
        '--store-key',
        '--key-env-var', 'RAW_KEY',
        '--discover',
        '--no-default',
        '--no-restart',
      ]),
    ).toMatchObject({
      action: 'setup',
      profile: 'web',
      provider: 'my-gw',
      custom: true,
      model: 'qwen-3',
      reasoningEffort: 'high',
      baseURL: 'https://api.example.com/v1',
      api: 'openai-completions',
      displayName: 'My Gateway',
      apiKeyEnv: 'MY_GW_KEY',
      storeKey: true,
      keyEnvVar: 'RAW_KEY',
      discover: true,
      setDefault: false,
      restart: false,
    })
  })

  test('rejects conflicting flags and invalid identifiers', () => {
    expect(() => parseProviderArgs(['--native-auth', '--store-key'])).toThrowError(ProviderCommandError)
    expect(() => parseProviderArgs(['--native-auth', '--api-key-env', 'OPENAI_API_KEY'])).toThrowError(ProviderCommandError)
    expect(() => parseProviderArgs(['--api-key-env', 'bad-name'])).toThrowError(ProviderCommandError)
    expect(() => parseProviderArgs(['--unknown-flag'])).toThrowError(ProviderCommandError)
  })

  test('deriveKeyRef follows DSH provider convention', () => {
    expect(deriveKeyRef('openrouter')).toBe('OPENROUTER_API_KEY')
    expect(deriveKeyRef('moonshotai-cn')).toBe('MOONSHOTAI_CN_API_KEY')
    expect(deriveKeyRef('zai-coding-cn')).toBe('ZAI_CODING_CN_API_KEY')
    expect(deriveKeyRef('deepseek-official')).toBe('DEEPSEEK_API_KEY')
  })
})

describe('YAML patch and DSH v1 credentials preservation', () => {
  test('renderUpdatedCredentialsYaml migrates legacy flat layout to v1 refs and preserves records', () => {
    const legacyFlat = '# existing comment\nDEEPSEEK_API_KEY: sk-legacy-deepseek\n'
    const first = renderUpdatedCredentialsYaml(legacyFlat, {
      set: { key: 'OPENROUTER_API_KEY', value: 'sk-or-123' },
    })
    expect(first.changed).toBe(true)
    const parsed1 = parseDocument(first.content).toJS() as { version: number; refs: Record<string, string> }
    expect(parsed1).toEqual({
      version: 1,
      refs: {
        DEEPSEEK_API_KEY: 'sk-legacy-deepseek',
        OPENROUTER_API_KEY: 'sk-or-123',
      },
    })

    const withRecords = [
      'version: 1',
      'refs:',
      '  OPENROUTER_API_KEY: sk-or-123',
      'records:',
      '  "llm-pi-ai:anthropic":',
      '    access: tok-abc',
      '',
    ].join('\n')
    const second = renderUpdatedCredentialsYaml(withRecords, { removeKey: 'OPENROUTER_API_KEY' })
    expect(second.changed).toBe(true)
    const parsed2 = parseDocument(second.content).toJS() as {
      version: number
      refs: Record<string, string>
      records: Record<string, unknown>
    }
    expect(parsed2.refs).toEqual({})
    expect(parsed2.records).toEqual({ 'llm-pi-ai:anthropic': { access: 'tok-abc' } })
  })

  test('renderUpdatedCordisPatchYaml preserves comments, !js/!!js tags, and sibling plugins', () => {
    const initialPatch = [
      '# header comment',
      '- id: dsh-ray-assistant-dreaming',
      '  name: "@dsh-ray/assistant-dreaming"',
      '  config:',
      '    databasePath: !js dshHomePath(\'dream.sqlite\')',
      '    workspace: !!js dshHomePath(\'workspace\')',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      anthropic:',
      '        apiKeyEnv: ANTHROPIC_API_KEY',
      '',
    ].join('\n')

    const updated = renderUpdatedCordisPatchYaml({
      existingSource: initialPatch,
      piAiUpdates: {
        upsertProvider: {
          id: 'openrouter',
          profile: { apiKeyEnv: 'OPENROUTER_API_KEY' },
        },
      },
      defaultModelUpdate: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
      },
    })

    expect(updated.changed).toBe(true)
    expect(updated.content).toContain('# header comment')
    expect(updated.content).toContain('!js')
    expect(updated.content).toContain('!!js')

    const rows = parsePatchRows(updated.content)
    const piAi = rows.find(row => row.id === 'llm-pi-ai')
    expect(piAi?.config?.providers).toEqual({
      anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' },
    })
    const defaultRow = rows.find(row => row.id === 'agent-default-model')
    expect(defaultRow?.config).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
    })
  })
})

describe('dsh-ray provider commands', () => {
  test('configures DSH built-in catalog provider non-interactively with --store-key and v1 .credentials.yaml', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root)
    const out = createBufferWriter()
    const err = createBufferWriter()
    const runtime = createTestRuntime()

    const exit = await runProvider(dshHome, [
      '--profile', 'web',
      '--provider', 'moonshotai-cn',
      '--store-key',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: { ...process.env, [DEFAULT_KEY_INPUT_ENV]: 'sk-moonshot-secret-xyz' },
      isTTY: false,
      stdout: out.writer,
      stderr: err.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })

    expect(exit).toBe(0)
    expect(err.text()).toBe('')
    expect(out.text()).not.toContain('sk-moonshot-secret-xyz')

    const result = JSON.parse(out.text()) as Record<string, unknown>
    expect(result).toMatchObject({
      ok: true,
      action: 'setup',
      profile: 'web',
      provider: 'moonshotai-cn',
      kind: 'catalog',
      model: 'kimi-k2-0711-preview',
      apiKeyEnv: 'MOONSHOTAI_CN_API_KEY',
      storedCredentialRef: 'MOONSHOTAI_CN_API_KEY',
      setAsDefault: true,
    })

    const credsRaw = readFileSync(credentialsPath, 'utf8')
    const creds = parseDocument(credsRaw).toJS() as { version: number; refs: Record<string, string> }
    expect(creds).toEqual({
      version: 1,
      refs: { MOONSHOTAI_CN_API_KEY: 'sk-moonshot-secret-xyz' },
    })
    if (process.platform !== 'win32') {
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600)
    }

    const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
    const piAi = rows.find(row => row.id === 'llm-pi-ai')
    // Built-in catalog model is omitted from custom models[] so DSH serves its built-in catalog directly.
    expect(piAi?.config?.providers).toEqual({
      'moonshotai-cn': { apiKeyEnv: 'MOONSHOTAI_CN_API_KEY' },
    })
    const adm = rows.find(row => row.id === 'agent-default-model')
    expect(adm?.config).toEqual({
      provider: 'moonshotai-cn',
      model: 'kimi-k2-0711-preview',
    })
  })

  test('supports --no-default, --native-auth, and custom baseURL override on catalog provider', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root, 'web', [
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-v4-flash',
      '',
    ].join('\n'))
    const out = createBufferWriter()
    const runtime = createTestRuntime()

    const exit = await runProvider(dshHome, [
      '--provider', 'anthropic',
      '--base-url', 'https://proxy.corp.example/anthropic/',
      '--native-auth',
      '--no-default',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })

    expect(exit).toBe(0)
    expect(existsSync(credentialsPath)).toBe(false)
    const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
    expect(rows.find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(rows.find(r => r.id === 'llm-pi-ai')?.config?.providers).toEqual({
      anthropic: { baseURL: 'https://proxy.corp.example/anthropic' },
    })
  })

  test('configures custom third-party endpoint via DSH supportedProtocols & discoverModels', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath } = seedHomeWithProfile(root)
    const out = createBufferWriter()
    const runtime = createTestRuntime()

    const badProto = runProvider(dshHome, [
      '--provider', 'corp-gateway',
      '--custom',
      '--base-url', 'https://custom.example/v1',
      '--api', 'unsupported-proto',
      '--model', 'qwen-3-coder',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    await expect(badProto).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_USAGE })

    const exit = await runProvider(dshHome, [
      '--provider', 'corp-gateway',
      '--base-url', 'https://custom.example/v1',
      '--api', 'openai-completions',
      '--discover',
      '--store-key',
      '--reasoning-effort', 'medium',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: { [DEFAULT_KEY_INPUT_ENV]: 'sk-custom-gw-999' },
      isTTY: false,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })

    expect(exit).toBe(0)
    expect(out.text()).not.toContain('sk-custom-gw-999')
    const json = JSON.parse(out.text()) as {
      kind: string
      model: string
      discoveredModels: Array<{ id: string }>
    }
    expect(json.kind).toBe('custom')
    expect(json.model).toBe('qwen-3-coder')
    expect(json.discoveredModels.map(m => m.id)).toEqual(['qwen-3-coder', 'glm-4.6'])

    const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
    expect(rows.find(r => r.id === 'llm-pi-ai')?.config?.providers).toEqual({
      'corp-gateway': {
        apiKeyEnv: 'CORP_GATEWAY_API_KEY',
        baseURL: 'https://custom.example/v1',
        api: 'openai-completions',
        models: [{ id: 'qwen-3-coder', name: 'qwen-3-coder' }],
      },
    })
    expect(rows.find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'corp-gateway',
      model: 'qwen-3-coder',
      reasoningEffort: 'medium',
    })
  })

  test('interactive guided wizard handles built-in search, masked secret, and managed restart', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root)
    const unitDir = join(home, '.config', 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(join(unitDir, 'dsh-profile-web.service'), [
      '[Unit]',
      'Description=DeepSeek Harness profile web',
      '[Service]',
      `Environment="DSH_HOME=${dshHome}"`,
      `WorkingDirectory=${join(dshHome, 'profiles', 'web')}`,
      'ExecStart=/usr/local/bin/dsh --profile web --no-open',
      '',
    ].join('\n'))

    const runnerCalls: Array<{ cmd: string; args: readonly string[] }> = []
    const out = createBufferWriter()
    const runtime = createTestRuntime()
    const prompter = createScriptedPrompter(
      [
        '1',        // mode 1: DSH built-in catalog
        'openrouter',
        '',         // keep DSH default baseURL
        'y',        // set as default model
        '2',        // pick 2nd discovered model: openai/gpt-5
        'y',        // restart running managed service
      ],
      ['sk-openrouter-interactive-secret'],
    )

    const exit = await runProvider(dshHome, [], {
      home,
      platform: 'linux',
      env: { HOME: home },
      isTTY: true,
      prompter,
      stdout: out.writer,
      runner: (cmd, args) => {
        runnerCalls.push({ cmd, args })
        if (cmd === 'pgrep') return { status: 0, stdout: '4321\n', stderr: '' }
        if (cmd === 'ps') return { status: 0, stdout: 'dsh --profile web --no-open\n', stderr: '' }
        if (cmd === 'systemctl') return { status: 0, stdout: '', stderr: '' }
        return { status: 0, stdout: '', stderr: '' }
      },
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })

    expect(exit).toBe(0)
    expect(out.text()).not.toContain('sk-openrouter-interactive-secret')
    expect(out.text()).toContain('openrouter')
    expect(out.text()).toContain('openai/gpt-5')
    expect(runnerCalls.some(c => c.cmd === 'systemctl' && c.args.includes('restart'))).toBe(true)

    const creds = parseDocument(readFileSync(credentialsPath, 'utf8')).toJS() as {
      version: number
      refs: Record<string, string>
    }
    expect(creds.refs.OPENROUTER_API_KEY).toBe('sk-openrouter-interactive-secret')
  })

  test('interactive guided wizard supports custom third-party endpoint with live discovery', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root)
    const out = createBufferWriter()
    const runtime = createTestRuntime()
    const prompter = createScriptedPrompter(
      [
        '2',                     // mode 2: custom API
        'local-vllm',            // custom provider ID
        '1',                     // protocol: openai-completions
        'https://custom.example/v1/',
        'Local vLLM',
        'y',                     // call DSH discoverModels
        '2',                     // choose 2nd discovered model: glm-4.6
        'y',                     // set as default
      ],
      ['sk-vllm-secret-1'],
    )

    const exit = await runProvider(dshHome, [], {
      home,
      platform: 'linux',
      env: {},
      isTTY: true,
      prompter,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })

    expect(exit).toBe(0)
    expect(out.text()).not.toContain('sk-vllm-secret-1')
    const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
    expect(rows.find(r => r.id === 'llm-pi-ai')?.config?.providers).toEqual({
      'local-vllm': {
        apiKeyEnv: 'LOCAL_VLLM_API_KEY',
        baseURL: 'https://custom.example/v1',
        api: 'openai-completions',
        displayName: 'Local vLLM',
        models: [{ id: 'glm-4.6', name: 'glm-4.6' }],
      },
    })
    expect(rows.find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'local-vllm',
      model: 'glm-4.6',
    })
    const creds = parseDocument(readFileSync(credentialsPath, 'utf8')).toJS() as { refs: Record<string, string> }
    expect(creds.refs.LOCAL_VLLM_API_KEY).toBe('sk-vllm-secret-1')
  })

  test('fails closed and rolls back patch and credentials when --dump-config verification fails', async () => {
    const root = makeTempDir()
    const initialPatch = '- id: other-plugin\n  name: other\n  config:\n    ok: true\n'
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root, 'web', initialPatch)
    writeFileSync(credentialsPath, 'version: 1\nrefs:\n  EXISTING_KEY: keep-me\n', { mode: 0o600 })
    const out = createBufferWriter()
    const runtime = createTestRuntime()

    let dumpCalls = 0
    await expect(runProvider(dshHome, [
      '--provider', 'openai',
      '--model', 'gpt-5',
      '--store-key',
    ], {
      home,
      platform: 'linux',
      env: { [DEFAULT_KEY_INPUT_ENV]: 'sk-should-rollback' },
      isTTY: false,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => {
        dumpCalls += 1
        // 1st call inspects current state; 2nd call verifies post-write state -> fail
        if (dumpCalls >= 2) {
          throw new ProviderCommandError('simulated schema verification error', PROVIDER_EXIT_VERIFY)
        }
        return readDumpFromPatch(patchPath, 'web')
      },
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_VERIFY })

    expect(readFileSync(patchPath, 'utf8')).toBe(initialPatch)
    expect(readFileSync(credentialsPath, 'utf8')).toBe('version: 1\nrefs:\n  EXISTING_KEY: keep-me\n')
  })

  test('list and remove subcommands report catalog/configured state and clean up credentials cleanly', async () => {
    const root = makeTempDir()
    const initialPatch = [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      openrouter:',
      '        apiKeyEnv: OPENROUTER_API_KEY',
      '      openai:',
      '        apiKeyEnv: OPENAI_API_KEY',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: openrouter',
      '    model: openai/gpt-5',
      '',
    ].join('\n')
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root, 'web', initialPatch)
    writeFileSync(credentialsPath, [
      'version: 1',
      'refs:',
      '  OPENROUTER_API_KEY: sk-secret-or',
      '  OPENAI_API_KEY: sk-secret-oa',
      '',
    ].join('\n'), { mode: 0o600 })

    const listOut = createBufferWriter()
    const runtime = createTestRuntime()
    await runProvider(dshHome, ['list', '--json'], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: listOut.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(listOut.text()).not.toContain('sk-secret-or')
    const listed = JSON.parse(listOut.text()) as {
      configuredProviders: Array<{ provider: string }>
      credentialRefs: string[]
      builtinCatalogProviders: Array<{ provider: string }>
    }
    expect(listed.configuredProviders.map(p => p.provider)).toEqual(['openai', 'openrouter'])
    expect(listed.credentialRefs).toEqual(['OPENAI_API_KEY', 'OPENROUTER_API_KEY'])
    expect(listed.builtinCatalogProviders.length).toBe(5)

    // Removing currently active default provider without --yes fails in non-TTY mode
    await expect(runProvider(dshHome, ['remove', 'openrouter'], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_USAGE })

    const rmOut = createBufferWriter()
    const rmExit = await runProvider(dshHome, ['remove', 'openrouter', '--yes', '--json'], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: rmOut.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(rmExit).toBe(0)
    const rmResult = JSON.parse(rmOut.text()) as { removedCredentialRef?: string; warnings: string[] }
    expect(rmResult.removedCredentialRef).toBe('OPENROUTER_API_KEY')
    expect(rmResult.warnings.length).toBeGreaterThan(0)

    const rows = parsePatchRows(readFileSync(patchPath, 'utf8'))
    expect(rows.find(r => r.id === 'llm-pi-ai')?.config?.providers).toEqual({
      openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    })
    const creds = parseDocument(readFileSync(credentialsPath, 'utf8')).toJS() as { refs: Record<string, string> }
    expect(creds.refs).toEqual({ OPENAI_API_KEY: 'sk-secret-oa' })
  })

  test('fails closed in non-TTY setup without --provider and supports --dry-run preview', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root)
    const runtime = createTestRuntime()

    await expect(runProvider(dshHome, [], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_USAGE })

    const dryOut = createBufferWriter()
    const dryExit = await runProvider(dshHome, [
      '--provider', 'openai',
      '--model', 'gpt-5',
      '--store-key',
      '--dry-run',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: { [DEFAULT_KEY_INPUT_ENV]: 'sk-dry-run-only' },
      isTTY: false,
      stdout: dryOut.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(dryExit).toBe(0)
    expect(readFileSync(patchPath, 'utf8')).toBe('[]\n')
    expect(existsSync(credentialsPath)).toBe(false)
    expect(JSON.parse(dryOut.text())).toMatchObject({ ok: true, dryRun: true, provider: 'openai' })
  })

  test('reuses @deepseek-ai/dsh-llm-pi-ai directly from synthetic resolved Host package tree (symlink and wrapper)', async () => {
    const root = makeTempDir()
    const dshHome = join(root, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })

    // Build a realistic Host runtime layout: bin/dsh wrapper -> lib/node_modules/@deepseek-ai/dsh
    const runtimeDir = join(root, 'host-runtime')
    const dshPkgDir = join(runtimeDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    const basePkgDir = join(dshPkgDir, 'node_modules', '@deepseek-ai', 'dsh-base')
    const piAiDir = join(basePkgDir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')
    const deepseekDir = join(basePkgDir, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek')
    mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
    mkdirSync(piAiDir, { recursive: true })
    mkdirSync(deepseekDir, { recursive: true })

    writeFileSync(join(dshPkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-test' }))
    writeFileSync(join(basePkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-test' }))
    writeFileSync(join(piAiDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', main: 'index.cjs' }))
    writeFileSync(join(piAiDir, 'index.cjs'), `
      exports.Config = (raw) => raw;
      exports.supportedProtocols = () => ['openai-completions', 'anthropic-messages'];
      exports.apply = (ctx) => {
        ctx.llm.registerConfigurableProviders([
          {
            provider: 'zai-coding-cn',
            displayName: 'Z.AI Coding (China)',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', 'zai-coding-cn'],
            declared: false,
            defaultBaseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
            nativeAuth: { env: ['ZAI_API_KEY'], oauth: false }
          }
        ]);
        ctx.llm.registerModelDiscovery('llm-pi-ai', async (req) => {
          if (req.provider === 'zai-coding-cn') return [{ id: 'glm-4.7', name: 'GLM-4.7' }];
          return [];
        });
      };
    `)
    writeFileSync(join(deepseekDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-deepseek', main: 'index.cjs' }))
    writeFileSync(join(deepseekDir, 'index.cjs'), `exports.DEFAULT_MODELS = [{ id: 'deepseek-v4-flash' }];`)

    const binDsh = join(runtimeDir, 'bin', 'dsh')
    writeFileSync(binDsh, '#!/bin/sh\necho "wrapper"\n')
    chmodSync(binDsh, 0o755)

    // Bind via wrapper PATH first
    const runtimeViaWrapper = await loadDshProviderRuntime({
      dshHome,
      env: { PATH: join(runtimeDir, 'bin') },
      platform: 'linux',
    })
    expect(runtimeViaWrapper.hostVersion).toBe('0.2.2-test')
    expect(runtimeViaWrapper.protocols).toEqual(['openai-completions', 'anthropic-messages'])
    expect(runtimeViaWrapper.catalogProviders.map(p => p.provider)).toEqual(['zai-coding-cn'])
    expect(await runtimeViaWrapper.discoverModels({ provider: 'zai-coding-cn' })).toEqual([{ id: 'glm-4.7', name: 'GLM-4.7' }])
    expect(runtimeViaWrapper.deepseekModels).toEqual([{ id: 'deepseek-v4-flash' }])

    // Also verify symlinked executable resolution
    const symDir = join(root, 'symbin')
    mkdirSync(symDir, { recursive: true })
    const actualEntry = join(dshPkgDir, 'bin.js')
    writeFileSync(actualEntry, '#!/usr/bin/env node\n')
    chmodSync(actualEntry, 0o755)
    symlinkSync(actualEntry, join(symDir, 'dsh'))

    const runtimeViaSymlink = await loadDshProviderRuntime({
      dshHome,
      env: { PATH: symDir },
      platform: 'linux',
    })
    expect(runtimeViaSymlink.hostVersion).toBe('0.2.2-test')
    expect(runtimeViaSymlink.catalogProviders[0]?.provider).toBe('zai-coding-cn')
  })

  test('supports deepseek-official and local-agent switching (traex-agent and agy-agent)', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root)
    mkdirSync(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-ray', 'traex-acp-provider'), { recursive: true })
    const runtime = createTestRuntime()

    const dsOut = createBufferWriter()
    const dsExit = await runProvider(dshHome, [
      '--provider', 'deepseek-official',
      '--store-key',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: { [DEFAULT_KEY_INPUT_ENV]: 'sk-ds-official-secret' },
      isTTY: false,
      stdout: dsOut.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(dsExit).toBe(0)
    expect(JSON.parse(dsOut.text())).toMatchObject({
      kind: 'deepseek-official',
      model: 'deepseek-flash',
      storedCredentialRef: 'DEEPSEEK_API_KEY',
    })
    const creds = parseDocument(readFileSync(credentialsPath, 'utf8')).toJS() as { refs: Record<string, string> }
    expect(creds.refs.DEEPSEEK_API_KEY).toBe('sk-ds-official-secret')
    expect(parsePatchRows(readFileSync(patchPath, 'utf8')).find(r => r.id === 'llm-pi-ai')).toBeUndefined()

    const traexOut = createBufferWriter()
    const traexExit = await runProvider(dshHome, [
      '--provider', 'traex-agent',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: traexOut.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(traexExit).toBe(0)
    expect(JSON.parse(traexOut.text())).toMatchObject({
      kind: 'local-agent',
      provider: 'traex-agent',
      model: 'default',
    })
    const traexPatchText = readFileSync(patchPath, 'utf8')
    expect(traexPatchText).toContain('!!js')
    expect(traexPatchText).toContain('insert:')
    const afterTraexRows = readDumpFromPatch(patchPath, 'web').rows
    expect(afterTraexRows.find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'traex-agent',
      model: 'default',
    })
    const acpAfterTraex = afterTraexRows.find(r => r.id === 'dsh-ray-traex-acp-provider')
    expect(acpAfterTraex?.disabled).toBe(false)
    expect(acpAfterTraex?.config?.enabled).toBe(true)

    const agyOut = createBufferWriter()
    const agyExit = await runProvider(dshHome, [
      '--provider', 'agy-agent',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: agyOut.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(agyExit).toBe(0)
    expect(JSON.parse(agyOut.text())).toMatchObject({
      kind: 'local-agent',
      provider: 'agy-agent',
      model: 'default',
    })
    const afterAgyRows = readDumpFromPatch(patchPath, 'web').rows
    expect(afterAgyRows.find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'agy-agent',
      model: 'default',
    })
    const acpAfterAgy = afterAgyRows.find(r => r.id === 'dsh-ray-traex-acp-provider')
    expect(acpAfterAgy?.config?.enabled).toBe(true)
    expect(acpAfterAgy?.config?.agyEnabled).toBe(true)

    await expect(runProvider(dshHome, [
      '--provider', 'traex-agent',
      '--base-url', 'https://invalid.example',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_USAGE })

    // Missing ACP package rejects local-agent routes with actionable usage error
    const missingAcpRoot = makeTempDir()
    const missingAcpSeed = seedHomeWithProfile(missingAcpRoot)
    await expect(runProvider(missingAcpSeed.dshHome, [
      '--provider', 'agy-agent',
    ], {
      home: missingAcpSeed.home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(missingAcpSeed.patchPath, 'web'),
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_USAGE })
  })

  test('defaultDumpProfileConfig parses DSH YAML --dump-config with !!js tags and rejects unmounted patch errors', async () => {
    const dumped = await defaultDumpProfileConfig({
      dshPath: 'dsh',
      dshHome: '/tmp/dsh',
      profile: 'web',
      env: {},
      detailedRunner: () => ({
        status: 0,
        stdout: [
          '# == @deepseek-ai/dsh-base',
          '- id: plugin-manager',
          '  name: "@deepseek-ai/dsh-plugin-manager"',
          "  disabled: !!js '!ctx.get(\"profileContext\")'",
          '- id: agent-default-model',
          '  name: "@deepseek-ai/dsh-agent-default-model"',
          '  config:',
          '    provider: openrouter',
          '    model: anthropic/claude-sonnet-4',
          '- id: llm-pi-ai',
          '  name: "@deepseek-ai/dsh-llm-pi-ai"',
          '  config:',
          '    providers:',
          '      openrouter:',
          '        apiKeyEnv: OPENROUTER_API_KEY',
          '',
        ].join('\n'),
        stderr: '',
      }),
    })
    expect(dumped.rows.find(r => r.id === 'llm-pi-ai')?.config).toEqual({
      providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } },
    })
    expect(dumped.rows.find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
    })

    await expect(defaultDumpProfileConfig({
      dshPath: 'dsh',
      dshHome: '/tmp/dsh',
      profile: 'web',
      env: {},
      detailedRunner: () => ({
        status: 0,
        stdout: '\n',
        stderr: 'dsh: [/tmp/dsh/profiles/web/cordis.patch.yml] patch: entry "llm-pi-ai" not found\n',
      }),
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_VERIFY })
  })

  test('preserves headers, compat, timeoutMs, rich model fields, and - insert: blocks when updating a provider', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath } = seedHomeWithProfile(root)
    writeFileSync(patchPath, [
      '- insert:',
      '    - id: llm-pi-ai',
      '      name: "@deepseek-ai/dsh-llm-pi-ai"',
      '      config:',
      '        providers:',
      '          my-gw:',
      '            apiKeyEnv: MY_GW_CUSTOM_ENV',
      '            baseURL: https://gw.example.com/v1',
      '            api: openai-completions',
      '            timeoutMs: 45000',
      '            headers:',
      '              X-Custom-Tenant: team-alpha',
      '            compat:',
      '              supportsDeveloperRole: false',
      '            models:',
      '              - id: alpha-1',
      '                name: Alpha One',
      '                contextWindow: 128000',
      '                maxTokens: 8192',
      '                input: [text, image]',
      '    - id: agent-default-model',
      '      name: "@deepseek-ai/dsh-agent-default-model"',
      '      config:',
      '        provider: my-gw',
      '        model: alpha-1',
      '        reasoningEffort: high',
      '',
    ].join('\n'), 'utf8')

    const runtime = createTestRuntime()
    const out = createBufferWriter()
    const exit = await runProvider(dshHome, [
      '--provider', 'my-gw',
      '--model', 'beta-2',
      '--store-key',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: { [DEFAULT_KEY_INPUT_ENV]: 'sk-gw-rotated' },
      isTTY: false,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(exit).toBe(0)
    const parsedDoc = parseDocument(readFileSync(patchPath, 'utf8'), { customTags: PATCH_TAGS }).toJS() as Array<{
      insert?: Array<{ id?: string; config?: Record<string, unknown> }>
    }>
    const insertRows = parsedDoc[0]?.insert ?? []
    const gw = (insertRows.find(r => r.id === 'llm-pi-ai')?.config?.providers as Record<string, Record<string, unknown>> | undefined)?.['my-gw']
    expect(gw).toBeDefined()
    expect(gw?.apiKeyEnv).toBe('MY_GW_CUSTOM_ENV')
    expect(gw?.timeoutMs).toBe(45000)
    expect(gw?.headers).toEqual({ 'X-Custom-Tenant': 'team-alpha' })
    expect(gw?.compat).toEqual({ supportsDeveloperRole: false })
    expect(gw?.models).toEqual([
      { id: 'alpha-1', name: 'Alpha One', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] },
      { id: 'beta-2', name: 'beta-2' },
    ])
    expect(insertRows.find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'my-gw',
      model: 'beta-2',
    })
  })

  test('preserves existing defaultModel and reasoningEffort when rotating key without --model', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath } = seedHomeWithProfile(root)
    writeFileSync(patchPath, [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      openrouter:',
      '        apiKeyEnv: OPENROUTER_API_KEY',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: openrouter',
      '    model: openai/gpt-5',
      '    reasoningEffort: high',
      '',
    ].join('\n'), 'utf8')

    const runtime = createTestRuntime()
    const out = createBufferWriter()
    const exit = await runProvider(dshHome, [
      '--provider', 'openrouter',
      '--store-key',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: { [DEFAULT_KEY_INPUT_ENV]: 'sk-or-rotated' },
      isTTY: false,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(exit).toBe(0)
    expect(JSON.parse(out.text())).toMatchObject({ model: 'openai/gpt-5' })
    expect(parsePatchRows(readFileSync(patchPath, 'utf8')).find(r => r.id === 'agent-default-model')?.config).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    })
  })

  test('fails closed and rolls back when top-level $DSH_HOME/cordis.patch.yml shadows profile config', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root)
    const initialPatch = readFileSync(patchPath, 'utf8')
    writeFileSync(join(dshHome, 'cordis.patch.yml'), [
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: traex-agent',
      '    model: default',
      '',
    ].join('\n'), 'utf8')

    const runtime = createTestRuntime()
    await expect(runProvider(dshHome, [
      '--provider', 'openrouter',
      '--model', 'openai/gpt-5',
      '--store-key',
    ], {
      home,
      platform: 'linux',
      env: { [DEFAULT_KEY_INPUT_ENV]: 'sk-or-should-rollback' },
      isTTY: false,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      // Simulate real DSH dump-config layering: home cordis.patch.yml overrides agent-default-model
      dumpProfileConfig: async () => {
        const local = readDumpFromPatch(patchPath, 'web')
        return {
          rows: [
            ...local.rows,
            {
              id: 'agent-default-model',
              name: '@deepseek-ai/dsh-agent-default-model',
              config: { provider: 'traex-agent', model: 'default' },
            },
          ],
        }
      },
    })).rejects.toMatchObject({
      exitCode: PROVIDER_EXIT_VERIFY,
      message: expect.stringContaining('cordis.patch.yml'),
    })

    expect(readFileSync(patchPath, 'utf8')).toBe(initialPatch)
    expect(existsSync(credentialsPath)).toBe(false)
  })

  test('retains shared credential ref when removing provider used by another profile', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath, credentialsPath } = seedHomeWithProfile(root, 'web')
    const secondPatch = join(dshHome, 'profiles', 'cli', 'cordis.patch.yml')
    mkdirSync(join(dshHome, 'profiles', 'cli'), { recursive: true })
    writeFileSync(join(dshHome, 'profiles', 'cli', 'package.json'), JSON.stringify({ name: 'dsh-profile-cli', private: true }))
    writeFileSync(credentialsPath, 'version: 1\nrefs:\n  OPENROUTER_API_KEY: sk-shared\n', { mode: 0o600 })
    const sharedPatch = [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      openrouter:',
      '        apiKeyEnv: OPENROUTER_API_KEY',
      '',
    ].join('\n')
    writeFileSync(patchPath, sharedPatch, 'utf8')
    writeFileSync(secondPatch, sharedPatch, 'utf8')

    const runtime = createTestRuntime()
    const out1 = createBufferWriter()
    const exit1 = await runProvider(dshHome, [
      '--profile', 'web',
      'remove', 'openrouter',
      '--yes',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: out1.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })
    expect(exit1).toBe(0)
    const parsed1 = JSON.parse(out1.text()) as { removedCredentialRef?: string; warnings: string[] }
    expect(parsed1.removedCredentialRef).toBeUndefined()
    expect(parsed1.warnings.join('\n')).toContain('profile "cli"')
    expect(readFileSync(credentialsPath, 'utf8')).toContain('OPENROUTER_API_KEY: sk-shared')

    // Removing from the last remaining profile cleans up the shared ref
    const out2 = createBufferWriter()
    const exit2 = await runProvider(dshHome, [
      '--profile', 'cli',
      'remove', 'openrouter',
      '--yes',
      '--json',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: out2.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(secondPatch, 'cli'),
    })
    expect(exit2).toBe(0)
    expect(JSON.parse(out2.text())).toMatchObject({ removedCredentialRef: 'OPENROUTER_API_KEY' })
  })

  test('reuses resolveAdapterOptions, internal/config validation, parseCredentialsDocument, and fail-closes invalid boundHost', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath } = seedHomeWithProfile(root)
    const runtimeDir = join(root, 'host-runtime')
    const dshPkgDir = join(runtimeDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    const basePkgDir = join(dshPkgDir, 'node_modules', '@deepseek-ai', 'dsh-base')
    const piAiDir = join(basePkgDir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')
    const deepseekDir = join(basePkgDir, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek')
    const credsLocalDir = join(basePkgDir, 'node_modules', '@deepseek-ai', 'dsh-credentials-local')
    mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
    mkdirSync(piAiDir, { recursive: true })
    mkdirSync(deepseekDir, { recursive: true })
    mkdirSync(credsLocalDir, { recursive: true })

    writeFileSync(join(dshPkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-test' }))
    writeFileSync(join(basePkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-test' }))
    writeFileSync(join(piAiDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', main: 'index.cjs' }))
    writeFileSync(join(piAiDir, 'index.cjs'), `
      exports.Config = (raw) => raw;
      exports.supportedProtocols = () => ['openai-completions', 'anthropic-messages'];
      exports.apply = (ctx) => {
        ctx.on('internal/config', (_fiber, next) => {
          const cfg = next();
          if (cfg && cfg.providers && cfg.providers['bad-gw']) {
            throw new Error('bad-gw rejected by DSH internal/config');
          }
          return cfg;
        });
        ctx.llm.registerConfigurableProviders([
          { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], declared: false, defaultBaseURL: 'https://api.openai.com/v1' }
        ]);
        ctx.llm.registerModelDiscovery('llm-pi-ai', async () => []);
      };
    `)
    writeFileSync(join(deepseekDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-deepseek', main: 'index.cjs' }))
    writeFileSync(join(deepseekDir, 'index.cjs'), `
      exports.resolveAdapterOptions = () => ({ models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
    `)
    writeFileSync(join(credsLocalDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-credentials-local', main: 'index.cjs' }))
    writeFileSync(join(credsLocalDir, 'index.cjs'), `
      exports.parseCredentialsDocument = (text) => {
        if (!text.includes('version: 1')) throw new Error('missing v1 header');
        return { version: 1 };
      };
    `)
    const binDsh = join(runtimeDir, 'bin', 'dsh')
    writeFileSync(binDsh, '#!/bin/sh\necho "wrapper"\n')
    chmodSync(binDsh, 0o755)

    // Invalid bound host fails closed rather than silently falling back to PATH
    writeFileSync(join(dshHome, '.dsh-ray-host.json'), '{not-valid-json', 'utf8')
    await expect(loadDshProviderRuntime({
      dshHome,
      env: { PATH: join(runtimeDir, 'bin') },
      platform: 'linux',
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_RUNTIME })
    rmSync(join(dshHome, '.dsh-ray-host.json'))

    const rt = await loadDshProviderRuntime({
      dshHome,
      env: { PATH: join(runtimeDir, 'bin') },
      platform: 'linux',
    })
    expect(rt.deepseekModels).toEqual([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }])
    expect(rt.validateProvidersConfig).toBeTypeOf('function')
    expect(rt.validateCredentialsDocument).toBeTypeOf('function')

    await expect(runProvider(dshHome, [
      '--provider', 'bad-gw',
      '--base-url', 'https://bad-gw.example/v1',
      '--model', 'm1',
      '--dry-run',
    ], {
      home,
      platform: 'linux',
      env: {},
      isTTY: false,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => rt,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
    })).rejects.toMatchObject({
      exitCode: PROVIDER_EXIT_USAGE,
      message: expect.stringContaining('internal/config'),
    })
  })

  test('interactive wizard rejects --json, validates mode choice, filters >15 models, and respects existing apiKeyEnv', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath } = seedHomeWithProfile(root)
    writeFileSync(patchPath, [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      openrouter:',
      '        apiKeyEnv: CUSTOM_OR_KEY',
      '',
    ].join('\n'), 'utf8')

    const manyModels = Array.from({ length: 20 }, (_, i) => ({
      id: i === 18 ? 'anthropic/claude-sonnet-4' : `vendor/model-${i + 1}`,
      name: `Model ${i + 1}`,
    }))
    const runtime = createTestRuntime({
      discoverModels: async req => (req.provider === 'openrouter' ? manyModels : []),
    })

    await expect(runProvider(dshHome, ['--json'], {
      home,
      platform: 'linux',
      env: {},
      isTTY: true,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      prompter: createScriptedPrompter([]),
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_USAGE })

    await expect(runProvider(dshHome, [], {
      home,
      platform: 'linux',
      env: {},
      isTTY: true,
      stdout: createBufferWriter().writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      prompter: createScriptedPrompter(['9']),
    })).rejects.toMatchObject({ exitCode: PROVIDER_EXIT_USAGE })

    const out = createBufferWriter()
    const exit = await runProvider(dshHome, [], {
      home,
      platform: 'linux',
      env: {},
      isTTY: true,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => runtime,
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
      prompter: createScriptedPrompter(
        [
          '1',        // built-in catalog
          '3',        // openrouter
          '',         // keep default baseURL
          '',         // set as default
          'sonnet',   // keyword filter on >15 models -> unique match anthropic/claude-sonnet-4
        ],
        ['sk-or-custom-ref'],
      ),
    })
    expect(exit).toBe(0)
    expect(out.text()).toContain('匹配到唯一模型：anthropic/claude-sonnet-4')
    const piCfg = parsePatchRows(readFileSync(patchPath, 'utf8')).find(r => r.id === 'llm-pi-ai')?.config as {
      providers: Record<string, { apiKeyEnv?: string }>
    }
    expect(piCfg.providers.openrouter?.apiKeyEnv).toBe('CUSTOM_OR_KEY')
  })

  test('consumeRawSecretChunk handles split bracketed paste, CSI/SS3 arrows, backspace, submit, and cancel', () => {
    const state: RawSecretReaderState = { buffer: '', escapeState: 'none' }
    // Arrow up CSI + SS3 F1 + split bracketed paste start \x1b[200~ across two chunks
    expect(consumeRawSecretChunk(state, '\u001b[A\u001bOP\u001b[20')).toEqual({ action: 'continue' })
    expect(consumeRawSecretChunk(state, '0~sk-test-xyzz\u007f123\u001b[201~')).toEqual({ action: 'continue' })
    expect(state.buffer).toBe('sk-test-xyz123')
    expect(consumeRawSecretChunk(state, '\r')).toEqual({ action: 'submit' })

    const cancelState: RawSecretReaderState = { buffer: 'partial', escapeState: 'none' }
    expect(consumeRawSecretChunk(cancelState, '\u0003')).toEqual({ action: 'cancel' })
  })

  test('selectTargetProfile excludes managed RSI coordinator profiles and rejects targeting them explicitly', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath } = seedHomeWithProfile(root, 'web')
    const coordinatorProfile = 'rsi-web-4b5e57f6eb2f'
    mkdirSync(join(dshHome, 'profiles', coordinatorProfile), { recursive: true })
    writeFileSync(join(dshHome, 'profiles', coordinatorProfile, 'package.json'), JSON.stringify({
      name: `dsh-profile-${coordinatorProfile}`,
      private: true,
    }), 'utf8')
    writeFileSync(join(dshHome, '.rsi-coordinator-0123456789abcdef.json'), JSON.stringify({
      schemaVersion: 1,
      targetProfile: 'web',
      coordinatorProfile,
    }), 'utf8')

    let asked = false
    const failingPrompter: ProviderPrompter = {
      ask: async () => {
        asked = true
        throw new Error('should not prompt when coordinator is filtered out')
      },
      askSecret: async () => 'sk-test-secret',
    }
    expect(await selectTargetProfile(dshHome, undefined, failingPrompter, true)).toBe('web')
    expect(asked).toBe(false)

    await expect(selectTargetProfile(dshHome, coordinatorProfile, failingPrompter, true)).rejects.toMatchObject({
      exitCode: PROVIDER_EXIT_USAGE,
      message: expect.stringContaining('受管自迭代协调器内部 profile'),
    })

    const out = createBufferWriter()
    const listExit = await runProvider(dshHome, ['list', '--json'], {
      home,
      platform: 'linux',
      env: {},
      isTTY: true,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => createTestRuntime(),
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
      prompter: failingPrompter,
    })
    expect(listExit).toBe(0)
    expect(JSON.parse(out.text())).toMatchObject({ ok: true, profile: 'web' })
    expect(asked).toBe(false)
  })

  test('provider list skips TTY profile prompt when multiple user profiles exist and defaults to web', async () => {
    const root = makeTempDir()
    const { home, dshHome, patchPath } = seedHomeWithProfile(root, 'web')
    seedHomeWithProfile(root, 'work')

    let asked = false
    const noPromptPrompter: ProviderPrompter = {
      ask: async () => {
        asked = true
        throw new Error('list subcommand must not block on TTY prompt')
      },
      askSecret: async () => '',
    }

    const out = createBufferWriter()
    const exit = await runProvider(dshHome, ['list', '--json'], {
      home,
      platform: 'linux',
      env: {},
      isTTY: true,
      stdout: out.writer,
      runner: () => ({ status: 1, stdout: '', stderr: '' }),
      loadRuntime: async () => createTestRuntime(),
      dumpProfileConfig: async () => readDumpFromPatch(patchPath, 'web'),
      prompter: noPromptPrompter,
    })
    expect(exit).toBe(0)
    expect(JSON.parse(out.text())).toMatchObject({ ok: true, profile: 'web' })
    expect(asked).toBe(false)
  })
})
