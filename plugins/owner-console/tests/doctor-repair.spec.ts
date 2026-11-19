import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { CodingToolProber, discoverCodingToolBinary } from '../src/probes.ts'
import { applyDoctorRepair, applyFeishuVaultConfig, configureFeishuEasy, inspectSetupDoctor, type EasySecretLocator } from '../src/doctor-repair.ts'
import type { AutonomyHostContext } from '../src/autonomy-setup.ts'
import type { PluginManagerService, SettingsDescriptor, SettingsService } from '../src/settings.ts'
import type { OwnerConsoleStatus } from '../src/typert.ts'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeTempHome(): { dshHome: string; profileDir: string; patchPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'owner-console-doctor-'))
  tempDirs.push(root)
  const dshHome = join(root, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  return { dshHome, profileDir, patchPath: join(profileDir, 'cordis.patch.yml') }
}

function makeDeliveryDb(dbPath: string, withLarkOwner = false): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE delivery_principals (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL,
        principal_json TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        linked_to_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE conversation_bindings (
        id TEXT PRIMARY KEY,
        conversation_hash TEXT NOT NULL,
        conversation_json TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        principal_json TEXT NOT NULL,
        workspace TEXT NOT NULL,
        agent_preset TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        policy_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      );
    `)
    if (withLarkOwner) {
      const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner123' }
      const conv = { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_chat456' }
      db.prepare(
        `INSERT INTO delivery_principals VALUES (?, ?, ?, 'owner', 'active', NULL, 100, 100, 1)`,
      ).run('principal_lark_1', 'hash1', JSON.stringify(principal))
      db.prepare(
        `INSERT INTO conversation_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, 'owner-dm', 'active', 100, 200, 1)`,
      ).run('binding_1', 'chash1', JSON.stringify(conv), 'principal_lark_1', JSON.stringify(principal), '/tmp/lark-ws', 'standard', 'sess_1')
    }
  } finally {
    db.close()
  }
}

function makeHost(dshHome: string, profileDir: string, profileName = 'desktop', deliveryService?: unknown): AutonomyHostContext {
  const services: Record<string, unknown> = {
    profileContext: { dir: profileDir, home: dshHome, name: profileName },
    ...(deliveryService === undefined ? {} : { assistantDelivery: deliveryService }),
  }
  return { get: name => services[name] }
}

function baseStatus(overrides: Partial<OwnerConsoleStatus> = {}): OwnerConsoleStatus {
  return {
    feishu: { mode: 'handle', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' },
    traex: { entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: false, command: 'traex' },
    agy: { entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: false, command: 'agy' },
    defaultModel: { entry: 'agent-default-model', available: true, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    llmProviders: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
    dependencies: [],
    evaluation: { intakeAgreement: 'absent' },
    bundles: [],
    plugins: [{ entryId: 'web-app', moduleName: '@deepseek-ai/dsh-web-app', enabled: true, fiberPhase: 'active' }],
    ...overrides,
  }
}

const JS_PARSE_TAG = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }] }

describe('setup doctor, self-healing repair, binary discovery and easy feishu setup', () => {
  it('auto-discovers traex / agy absolute binary paths when GUI PATH lacks ~/.local/bin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-discover-'))
    tempDirs.push(root)
    const home = join(root, 'home')
    const binDir = join(home, '.local', 'bin')
    mkdirSync(binDir, { recursive: true })
    const fakeTraex = join(binDir, 'traex')
    const fakeAgy = join(binDir, 'agy')
    writeFileSync(fakeTraex, '#!/bin/sh\necho "Logged in using Trae"\n', { mode: 0o755 })
    writeFileSync(fakeAgy, '#!/bin/sh\necho "agy"\n', { mode: 0o755 })

    expect(discoverCodingToolBinary('traex', { env: { PATH: '/usr/bin' }, homeDir: home, platform: 'darwin' })).toBe(fakeTraex)
    expect(discoverCodingToolBinary('agy', { env: { PATH: '/usr/bin' }, homeDir: home, platform: 'darwin' })).toBe(fakeAgy)

    const execCalls: string[] = []
    const prober = new CodingToolProber(
      async (command, args) => {
        execCalls.push(`${command}:${args.join(' ')}`)
        if (command === 'traex' || command === 'agy') {
          return { stdout: '', stderr: 'ENOENT', exitCode: 1, errorCode: 'ENOENT' }
        }
        if (command === fakeTraex) {
          return { stdout: 'Logged in using Trae\n', stderr: '', exitCode: 0 }
        }
        if (command === fakeAgy && args[0] === '--version') {
          return { stdout: '1.5.11\n', stderr: '', exitCode: 0 }
        }
        if (command === fakeAgy && args[0] === 'models') {
          return { stdout: '', stderr: 'Error: Please sign in to view available models', exitCode: 1 }
        }
        return { stdout: '', stderr: '', exitCode: 1 }
      },
      () => 1_700_000_000_000,
      tool => (tool === 'traex' ? fakeTraex : fakeAgy),
    )

    const traexRes = await prober.probe('traex', { command: 'traex', installed: true, enabled: false, routeRegistered: false }, true)
    expect(traexRes.binaryFound).toBe(true)
    expect(traexRes.loggedIn).toBe(true)
    expect(traexRes.discoveredPath).toBe(fakeTraex)
    expect(traexRes.needsPathPin).toBe(true)
    expect(traexRes.state).toBe('disabled')

    const agyRes = await prober.probe('agy', { command: '', installed: true, enabled: true, routeRegistered: false }, true)
    expect(agyRes.binaryFound).toBe(true)
    expect(agyRes.loggedIn).toBe(false)
    expect(agyRes.state).toBe('auth-required')
    expect(agyRes.discoveredPath).toBe(fakeAgy)
    expect(agyRes.needsPathPin).toBe(true)
    expect(agyRes.loginCommand).toBe(`${fakeAgy} acp --login`)
    expect(execCalls).toContain(`${fakeTraex}:login status`)
    expect(execCalls).toContain(`${fakeAgy}:models`)
  })

  it('detects and repairs GUI desktop collisions, preserves policy overrides, and binds existing Lark SQLite owner', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    makeDeliveryDb(join(dshHome, 'assistant-delivery', 'state.sqlite'), true)

    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: '@dsh-profile/desktop',
      bundles: {
        '@dsh-enhanced/acp': true,
        '@dsh-enhanced/assistant-isolation': true,
        '@dsh-enhanced/personal-assistant': true,
        '@dsh-enhanced/assistant-policy': true,
        '@dsh-enhanced/assistant-automations': true,
        '@dsh-enhanced/personal-memory': true,
        '@dsh-enhanced/personal-wiki': true,
        '@dsh-enhanced/assistant-memory-learning': true,
        '@dsh-enhanced/assistant-delivery': true,
        '@dsh-enhanced/traex-acp-provider': true,
      },
    }, null, 2))

    writeFileSync(patchPath, [
      '- id: dsh-enhanced-assistant-policy',
      "  name: '@dsh-enhanced/assistant-policy'",
      '  config:',
      '    toolDefaultEffect: allow',
      '    autoReview:',
      '      enabled: true',
      '- id: dsh-enhanced-traex-acp-provider',
      "  name: '@dsh-enhanced/traex-acp-provider'",
      '  config:',
      '    enabled: false',
      '',
    ].join('\n'))

    const fakeTraex = '/Users/owner/.local/bin/traex'
    const prober = new CodingToolProber(
      async (command) => {
        if (command === fakeTraex) return { stdout: 'Logged in using Trae', stderr: '', exitCode: 0 }
        return { stdout: '', stderr: 'ENOENT', exitCode: 1, errorCode: 'ENOENT' }
      },
      () => 1_700_000_000_000,
      tool => (tool === 'traex' ? fakeTraex : undefined),
    )

    const traexDescriptor: SettingsDescriptor = {
      ns: 'dsh-enhanced-traex-acp-provider',
      schema: {},
      value: { enabled: false, command: 'traex' },
      revision: 1,
      applies: 'live',
    }
    const status = baseStatus({
      bundles: [
        { name: '@dsh-enhanced/acp', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-enhanced-acp', moduleName: '@dsh-enhanced/acp' }] },
        { name: '@dsh-enhanced/assistant-isolation', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-enhanced-assistant-isolation', moduleName: '@dsh-enhanced/assistant-isolation' }] },
        { name: '@dsh-enhanced/personal-assistant', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-enhanced-personal-assistant', moduleName: '@dsh-enhanced/personal-assistant' }] },
        { name: '@dsh-enhanced/assistant-policy', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-enhanced-assistant-policy', moduleName: '@dsh-enhanced/assistant-policy' }] },
        { name: '@dsh-enhanced/assistant-memory-learning', installed: true, enabled: true, removable: true, error: { code: 'CONFIG_ERROR', diagnostic: 'Invalid memory learning configuration fields' }, rows: [{ rowId: 'dsh-enhanced-assistant-memory-learning', moduleName: '@dsh-enhanced/assistant-memory-learning' }] },
        { name: '@dsh-enhanced/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-enhanced-assistant-delivery', moduleName: '@dsh-enhanced/assistant-delivery' }] },
      ],
      plugins: [
        { entryId: 'web-app', moduleName: '@deepseek-ai/dsh-web-app', enabled: true, fiberPhase: 'active' },
        { entryId: 'dsh-enhanced-acp', moduleName: '@dsh-enhanced/acp', enabled: true, fiberPhase: 'failed', diagnostic: 'DUPLICATE INSERT ID: cordis-host-runner' },
        { entryId: 'dsh-enhanced-assistant-isolation', moduleName: '@dsh-enhanced/assistant-isolation', enabled: true, fiberPhase: 'failed', diagnostic: 'CONFIG_ERROR' },
      ],
    })

    const host = makeHost(dshHome, profileDir, 'desktop')
    const reportBefore = await inspectSetupDoctor({ host, status, descriptors: [traexDescriptor], prober, platform: 'darwin' })
    const issueIds = reportBefore.issues.map(i => i.id)
    expect(issueIds).toContain('gui-stdio-acp-conflict')
    expect(issueIds).toContain('unsupported-platform-isolation')
    expect(issueIds).toContain('personal-assistant-split-collision')
    expect(issueIds).toContain('unconfigured-memory-learning-crash')
    expect(issueIds).toContain('missing-local-owner-route')
    expect(issueIds).toContain('traex-auto-connect')
    expect(reportBefore.healthy).toBe(false)

    const toggledOff: string[] = []
    const manager = {
      setBundleEnabled: vi.fn(async (pkg: string, enabled: boolean) => {
        if (!enabled) toggledOff.push(pkg)
        return { changed: true, application: 'restart-required', target: pkg }
      }),
    } as unknown as PluginManagerService

    const mutateMock = vi.fn(async () => {})
    const settings: SettingsService = { describe: () => [traexDescriptor], mutate: mutateMock }

    const repairRes = await applyDoctorRepair({
      host, status, descriptors: [traexDescriptor], settings, manager, prober, issueIds: [], platform: 'darwin', now: 12345,
    })
    expect(repairRes.applied).toBe(true)
    expect(toggledOff).toEqual(expect.arrayContaining([
      '@dsh-enhanced/acp',
      '@dsh-enhanced/assistant-isolation',
      '@dsh-enhanced/assistant-memory-learning',
      '@dsh-enhanced/assistant-policy',
      '@dsh-enhanced/assistant-automations',
      '@dsh-enhanced/personal-memory',
      '@dsh-enhanced/personal-wiki',
    ]))
    expect(mutateMock).toHaveBeenCalledWith('dsh-enhanced-traex-acp-provider', [
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['command'], value: fakeTraex },
    ], 1)

    const updatedPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { bundles: Record<string, boolean> }
    expect(updatedPkg.bundles['@dsh-enhanced/acp']).toBe(false)
    expect(updatedPkg.bundles['@dsh-enhanced/assistant-policy']).toBe(false)
    expect(updatedPkg.bundles['@dsh-enhanced/personal-assistant']).toBe(true)

    const patchDoc = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJSON() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    const pa = patchDoc.find(r => r.id === 'dsh-enhanced-personal-assistant')!
    expect(pa.config!['assistantPolicy']).toMatchObject({ toolDefaultEffect: 'allow', autoReview: { enabled: true } })
    const paRules = (pa.config!['assistantPolicy'] as { rules: Array<{ id: string }> }).rules
    expect(paRules.some(r => r.id === 'dsh-enhanced-owner-route-owner-lark-primary')).toBe(true)
    expect(patchDoc.some(r => r.id === 'dsh-enhanced-assistant-policy')).toBe(false)

    const delivery = patchDoc.find(r => r.id === 'dsh-enhanced-assistant-delivery')!
    const ownerRoutes = delivery.config?.['ownerRoutes'] as Array<Record<string, unknown>>
    expect(ownerRoutes).toHaveLength(1)
    expect(ownerRoutes[0]).toMatchObject({
      id: 'owner-lark-primary',
      workspace: '/tmp/lark-ws',
      agentPreset: 'standard',
      minimumGeneration: 3,
    })

    // Ensure SQLite principals were NOT replaced or duplicated when Lark owner already existed.
    const db = new DatabaseSync(join(dshHome, 'assistant-delivery', 'state.sqlite'), { readOnly: true })
    try {
      const count = (db.prepare('SELECT COUNT(*) AS count FROM delivery_principals').get() as { count: number }).count
      expect(count).toBe(1)
    } finally {
      db.close()
    }
  })

  it('bootstraps local web owner in empty delivery SQLite and refuses frozen Linux systemd mutation', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    makeDeliveryDb(join(dshHome, 'assistant-delivery', 'state.sqlite'), false)
    writeFileSync(patchPath, '[]\n')

    const prober = new CodingToolProber(
      async () => ({ stdout: '', stderr: 'ENOENT', exitCode: 1, errorCode: 'ENOENT' }),
      () => 1_700_000_000_000,
      () => undefined,
    )
    const status = baseStatus({
      traex: { installed: false, enabled: false, command: '' },
      agy: { installed: false, enabled: false, command: '' },
      bundles: [{ name: '@dsh-enhanced/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-enhanced-assistant-delivery', moduleName: '@dsh-enhanced/assistant-delivery' }] }],
    })
    const host = makeHost(dshHome, profileDir, 'desktop')
    const repair = await applyDoctorRepair({
      host, status, descriptors: [], settings: undefined, manager: undefined, prober, issueIds: [], platform: 'darwin', now: 99,
    })
    expect(repair.applied).toBe(true)

    const db = new DatabaseSync(join(dshHome, 'assistant-delivery', 'state.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare('SELECT principal_json, role, status FROM delivery_principals').all() as Array<{ principal_json: string; role: string; status: string }>
      expect(rows).toEqual([{
        principal_json: JSON.stringify({ channel: 'web', account: 'desktop', tenant: 'local', user: 'operator' }),
        role: 'owner',
        status: 'active',
      }])
    } finally {
      db.close()
    }

    // Frozen Linux systemd guard check:
    const cohortDir = join(dshHome, 'rsi-local-cohorts', 'assistant')
    mkdirSync(cohortDir, { recursive: true })
    writeFileSync(join(cohortDir, 'receipt.json'), '{}')
    const frozenHost = makeHost(dshHome, join(dshHome, 'profiles', 'assistant'), 'assistant')
    const frozenReport = await inspectSetupDoctor({ host: frozenHost, status, descriptors: [], prober, platform: 'linux' })
    expect(frozenReport.frozenSystemdProfile).toBe(true)
    expect(frozenReport.autoFixableCount).toBe(0)
    const refused = await applyDoctorRepair({
      host: frozenHost, status, descriptors: [], settings: undefined, manager: undefined, prober, issueIds: [], platform: 'linux',
    })
    expect(refused.applied).toBe(false)
  })

  it('seals Feishu App Secret in OS store / 0600 file and wires credentials-keychain + assistantPolicy without plaintext in YAML', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    writeFileSync(patchPath, '[]\n')
    const host = makeHost(dshHome, profileDir, 'desktop')
    const stored: Array<{ locator: unknown; secret: string }> = []
    const larkDesc: SettingsDescriptor = {
      ns: 'dsh-enhanced-lark-channel',
      schema: {},
      value: { enabled: false, account: 'primary', tenant: 'personal' },
      revision: 2,
      applies: 'live',
    }
    const mutate = vi.fn(async () => {})
    const reloadEntry = vi.fn(async () => '；条目已重新加载')
    const resMac = await configureFeishuEasy({
      host,
      descriptors: [larkDesc],
      settings: { describe: () => [larkDesc], mutate },
      reloadEntry,
      appId: 'cli_0123456789abcdef',
      appSecret: 'super-secret-value-xyz',
      account: '',
      tenant: '',
      platform: 'darwin',
      env: {},
      now: 100,
      storeSecretFn: async (locator, secret) => { stored.push({ locator, secret }) },
    })
    expect(resMac.applied).toBe(true)
    expect(resMac.note).not.toContain('super-secret-value-xyz')
    expect(resMac.note).toContain('DeepSeek Harness.app')
    expect(resMac.note).toContain('dsh-rsi restart')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.secret).toBe('super-secret-value-xyz')
    const yamlText = readFileSync(patchPath, 'utf8')
    expect(yamlText).not.toContain('super-secret-value-xyz')
    const doc = parseDocument(yamlText, JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const kc = doc.find(r => r.id === 'dsh-enhanced-credentials-keychain')!
    expect(kc.config?.['handles']).toEqual([expect.objectContaining({
      id: 'lark-app-secret-primary',
      provider: 'macos-keychain',
      consumers: ['dsh-enhanced-lark-channel'],
      purposes: ['connect'],
    })])
    const pa = doc.find(r => r.id === 'dsh-enhanced-personal-assistant')!
    const rules = (pa.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
    expect(rules.some(r => r['id'] === 'lark-channel-credential-primary'
      && (r['resource'] as Record<string, unknown>)['id'] === 'lark-app-secret-primary')).toBe(true)
    // Must NEVER call settings.mutate() or hot-reload keychain/policy/personal-assistant/lark-channel in-process after patching YAML.
    expect(mutate).not.toHaveBeenCalled()
    expect(reloadEntry).not.toHaveBeenCalled()

    // Verify default Linux 0600 file creation cleanly (isolated from runner INVOCATION_ID)
    const resLinux = await configureFeishuEasy({
      host,
      descriptors: [larkDesc],
      settings: { describe: () => [larkDesc], mutate },
      reloadEntry,
      appId: 'cli_0123456789abcdef',
      appSecret: 'linux-secret-123',
      account: 'primary',
      tenant: 'personal',
      platform: 'linux',
      env: {},
      now: 101,
    })
    expect(resLinux.applied).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
    expect(reloadEntry).not.toHaveBeenCalled()
    const linuxDoc = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const linuxHandle = (linuxDoc.find(r => r.id === 'dsh-enhanced-credentials-keychain')!.config!['handles'] as Array<{ path?: string }>)[0]!
    expect(linuxHandle.path).toBeDefined()
    expect(existsSync(linuxHandle.path!)).toBe(true)
    expect(readFileSync(linuxHandle.path!, 'utf8')).toBe('linux-secret-123')
    expect(statSync(linuxHandle.path!).mode & 0o777).toBe(0o600)

    // Verify frozen Linux cohort refuses easy Feishu mutation
    mkdirSync(join(dshHome, 'rsi-local-cohorts', 'desktop'), { recursive: true })
    writeFileSync(join(dshHome, 'rsi-local-cohorts', 'desktop', 'receipt.json'), '{}')
    const refusedEasy = await configureFeishuEasy({
      host,
      descriptors: [larkDesc],
      settings: { describe: () => [larkDesc], mutate },
      appId: 'cli_0123456789abcdef',
      appSecret: 'linux-secret-456',
      account: 'primary',
      tenant: 'personal',
      platform: 'linux',
      env: {},
      now: 102,
    })
    expect(refusedEasy.applied).toBe(false)
  })

  it('rolls back newly written versioned credential (both hook and real Linux 0600 file) when YAML patch write fails', async () => {
    // 1) Hook-based rollback on macOS when atomicWritePatchWithBackup fails (EISDIR on backup target)
    const { dshHome, profileDir, patchPath } = makeTempHome()
    writeFileSync(patchPath, '[]\n', 'utf8')
    const host = makeHost(dshHome, profileDir, 'desktop')
    mkdirSync(join(`${patchPath}.bak.201`, 'blocker'), { recursive: true })

    const storedLocators: EasySecretLocator[] = []
    const deletedLocators: EasySecretLocator[] = []
    const macFailed = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'ROLLBACK_SECRET_MAC_123',
      account: 'primary',
      tenant: 'personal',
      platform: 'darwin',
      env: {},
      now: 201,
      storeSecretFn: async (locator) => { storedLocators.push(locator) },
      deleteSecretFn: async (locator) => { deletedLocators.push(locator) },
    })
    expect(macFailed.applied).toBe(false)
    expect(storedLocators).toHaveLength(1)
    expect(deletedLocators).toEqual(storedLocators)
    expect(macFailed.note).toContain('已自动清理本次新建的系统凭据项')
    expect(macFailed.note).not.toContain('ROLLBACK_SECRET_MAC_123')
    expect(readFileSync(patchPath, 'utf8')).toBe('[]\n')

    // 2) Delete failure during rollback is caught gracefully without throwing or leaking secret
    const macRollbackErr = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'ROLLBACK_ERR_SECRET_456',
      account: 'primary',
      tenant: 'personal',
      platform: 'darwin',
      env: {},
      now: 201,
      storeSecretFn: async () => {},
      deleteSecretFn: async () => { throw new Error('keychain unavailable') },
    })
    expect(macRollbackErr.applied).toBe(false)
    expect(macRollbackErr.note).toContain('回滚新建的系统凭据项也失败')
    expect(macRollbackErr.note).not.toContain('ROLLBACK_ERR_SECRET_456')

    // 3) Real Linux 0600 file creation + real unlinkSync rollback leaves zero orphaned secret files
    const linuxEnv = makeTempHome()
    writeFileSync(linuxEnv.patchPath, '[]\n', 'utf8')
    mkdirSync(join(`${linuxEnv.patchPath}.bak.202`, 'blocker'), { recursive: true })
    const linuxFailed = await applyFeishuVaultConfig({
      host: makeHost(linuxEnv.dshHome, linuxEnv.profileDir, 'desktop'),
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'LINUX_ORPHAN_SECRET_789',
      account: 'primary',
      tenant: 'personal',
      platform: 'linux',
      env: {},
      now: 202,
    })
    expect(linuxFailed.applied).toBe(false)
    expect(linuxFailed.note).toContain('已自动清理本次新建的系统凭据项')
    expect(linuxFailed.note).not.toContain('LINUX_ORPHAN_SECRET_789')
    const kcDir = join(linuxEnv.dshHome, 'credentials-keychain')
    expect(existsSync(kcDir) ? readdirSync(kcDir) : []).toEqual([])
    expect(readFileSync(linuxEnv.patchPath, 'utf8')).toBe('[]\n')
  })

  it('preserves owner-customized capability/tool restrictions and disabled-tools posture on re-scan for the same principal, while creating fresh rules for a new principal', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const host = makeHost(dshHome, profileDir, 'desktop')
    const samePrincipal = 'lark/primary/personal/ou_owner_same'

    // 1) Customized deny/narrowed rules bound to the same principal must be preserved verbatim
    writeFileSync(patchPath, [
      '- id: dsh-enhanced-personal-assistant',
      '  name: "@dsh-enhanced/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      '      rules:',
      '        - id: lark-owner-capability-*-primary',
      '          effect: deny',
      '          subject:',
      '            kind: agent',
      '            id: standard',
      '            workspace: /custom/ws',
      `            principal: ${samePrincipal}`,
      '          actions:',
      '            - "*"',
      '          resource:',
      '            kind: "*"',
      '            id: "*"',
      '          context:',
      '            initiators:',
      '              - external',
      '        - id: lark-owner-tool-*-primary',
      '          effect: allow',
      '          subject:',
      '            kind: agent',
      '            id: standard',
      '            workspace: /custom/ws',
      `            principal: ${samePrincipal}`,
      '          actions:',
      '            - execute',
      '          resource:',
      '            kind: tool',
      '            id: read',
      '          context:',
      '            initiators:',
      '              - external',
      '',
    ].join('\n'), 'utf8')

    const resSame = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_same_principal',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_owner_same',
      platform: 'darwin',
      env: {},
      now: 301,
      storeSecretFn: async () => {},
    })
    expect(resSame.applied).toBe(true)

    const docSame = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const rulesSame = (docSame.find(r => r.id === 'dsh-enhanced-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
    expect(rulesSame.find(r => r['id'] === 'lark-owner-capability-*-primary')).toMatchObject({
      effect: 'deny',
      subject: { workspace: '/custom/ws', principal: samePrincipal },
    })
    expect(rulesSame.find(r => r['id'] === 'lark-owner-tool-*-primary')).toMatchObject({
      effect: 'allow',
      resource: { kind: 'tool', id: 'read' },
      subject: { workspace: '/custom/ws', principal: samePrincipal },
    })

    // 2) Existing owner binding with capability/tool rules removed (`dsh-lark-setup --agent-tools disable`) must NOT re-open tools
    writeFileSync(patchPath, [
      '- id: dsh-enhanced-personal-assistant',
      '  name: "@dsh-enhanced/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      '      rules:',
      '        - id: lark-owner-ingress-primary',
      '          effect: allow',
      '          subject:',
      '            kind: external',
      `            id: ${samePrincipal}`,
      '          actions:',
      '            - approval.decide',
      '            - ingest',
      '          resource:',
      '            kind: message',
      '            id: "*"',
      '          context:',
      '            initiators:',
      '              - external',
      '        - id: lark-owner-reply-primary',
      '          effect: allow',
      '          subject:',
      '            kind: agent',
      '            id: standard',
      '            workspace: /custom/ws',
      `            principal: ${samePrincipal}`,
      '          actions:',
      '            - reply',
      '          resource:',
      '            kind: message',
      '            id: "*"',
      '          context:',
      '            initiators:',
      '              - external',
      '',
    ].join('\n'), 'utf8')

    const resDisabled = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_disabled_tools',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_owner_same',
      platform: 'darwin',
      env: {},
      now: 302,
      storeSecretFn: async () => {},
    })
    expect(resDisabled.applied).toBe(true)
    const docDisabled = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const rulesDisabled = (docDisabled.find(r => r.id === 'dsh-enhanced-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
    expect(rulesDisabled.some(r => r['id'] === 'lark-owner-capability-*-primary')).toBe(false)
    expect(rulesDisabled.some(r => r['id'] === 'lark-owner-tool-*-primary')).toBe(false)

    // 3) Switching to a different principalId creates fresh default rules bound to the new principal
    const resNew = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_new_principal',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_owner_new',
      platform: 'darwin',
      env: {},
      now: 303,
      storeSecretFn: async () => {},
    })
    expect(resNew.applied).toBe(true)
    const docNew = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const rulesNew = (docNew.find(r => r.id === 'dsh-enhanced-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
    expect(rulesNew.find(r => r['id'] === 'lark-owner-capability-*-primary')).toMatchObject({
      effect: 'allow',
      subject: expect.objectContaining({ principal: 'lark/primary/personal/ou_owner_new' }),
    })
    expect(rulesNew.find(r => r['id'] === 'lark-owner-tool-*-primary')).toMatchObject({
      effect: 'allow',
      resource: { kind: 'tool', id: '*' },
      subject: expect.objectContaining({ principal: 'lark/primary/personal/ou_owner_new' }),
    })

    // 4) Legacy unscoped deny rule (no subject.principal) and legacy reply without principal with tools disabled must NOT be widened on re-scan
    writeFileSync(patchPath, [
      '- id: dsh-enhanced-personal-assistant',
      '  name: "@dsh-enhanced/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      '      rules:',
      '        - id: lark-owner-ingress-primary',
      '          effect: allow',
      '          subject:',
      '            kind: external',
      `            id: ${samePrincipal}`,
      '          actions:',
      '            - approval.decide',
      '            - ingest',
      '          resource:',
      '            kind: message',
      '            id: "*"',
      '          context:',
      '            initiators:',
      '              - external',
      '        - id: lark-owner-reply-primary',
      '          effect: allow',
      '          subject:',
      '            kind: agent',
      '            id: standard',
      '            workspace: /custom/ws',
      '          actions:',
      '            - reply',
      '          resource:',
      '            kind: message',
      '            id: "*"',
      '          context:',
      '            initiators:',
      '              - external',
      '        - id: lark-owner-tool-*-primary',
      '          effect: deny',
      '          subject:',
      '            kind: agent',
      '            id: standard',
      '            workspace: /custom/ws',
      '          actions:',
      '            - execute',
      '          resource:',
      '            kind: tool',
      '            id: "*"',
      '          context:',
      '            initiators:',
      '              - external',
      '',
    ].join('\n'), 'utf8')

    const resLegacy = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_legacy_deny',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_owner_same',
      platform: 'darwin',
      env: {},
      now: 304,
      storeSecretFn: async () => {},
    })
    expect(resLegacy.applied).toBe(true)
    const docLegacy = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const rulesLegacy = (docLegacy.find(r => r.id === 'dsh-enhanced-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
    expect(rulesLegacy.find(r => r['id'] === 'lark-owner-tool-*-primary')).toMatchObject({ effect: 'deny' })
    expect(rulesLegacy.some(r => r['id'] === 'lark-owner-capability-*-primary')).toBe(false)
  })

  it('handles split assistant-policy detected via descriptors with required defaults, preserves existing keychain handles, enforces $DSH_HOME SQLite boundary, and rejects >128-char keychain service keys', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    writeFileSync(patchPath, '[]\n', 'utf8')
    const host = makeHost(dshHome, profileDir, 'desktop')

    // Create an external out-of-$DSH_HOME SQLite DB that must NEVER be mutated
    const externalDir = mkdtempSync(join(tmpdir(), 'owner-console-ext-db-'))
    tempDirs.push(externalDir)
    const externalDbPath = join(externalDir, 'external-delivery.sqlite')
    makeDeliveryDb(externalDbPath, false)

    const splitPolicyDesc: SettingsDescriptor = {
      ns: 'dsh-enhanced-assistant-policy',
      schema: {},
      value: {
        databasePath: join(dshHome, 'assistant-policy', 'policy.sqlite'),
        toolDefaultEffect: 'deny',
        proposalMaintenanceIntervalMs: 15_000,
        autoReview: { enabled: true, timeoutMs: 30_000, maxTokens: 512 },
        budgets: [{ id: 'custom-budget', metric: 'automation-runs', limit: 5, periodMs: 86_400_000, scope: 'global' }],
        rules: [
          {
            id: 'lark-owner-tool-*-primary',
            effect: 'deny',
            subject: { kind: 'agent', id: 'standard', workspace: '/ws', principal: 'lark/primary/personal/ou_split_owner' },
            actions: ['execute'],
            resource: { kind: 'tool', id: '*' },
            context: { initiators: ['external'] },
          },
        ],
      },
      revision: 1,
      applies: 'live',
    }
    const keychainDesc: SettingsDescriptor = {
      ns: 'dsh-enhanced-credentials-keychain',
      schema: {},
      value: {
        handles: [
          { id: 'other-service-secret', provider: 'environment', environmentName: 'OTHER_TOKEN', consumers: ['other'], purposes: ['connect'], maxLeaseMs: 60_000 },
        ],
      },
      revision: 1,
      applies: 'live',
    }
    const deliveryDesc: SettingsDescriptor = {
      ns: 'dsh-enhanced-assistant-delivery',
      schema: {},
      value: {
        databasePath: externalDbPath,
        defaultWorkspace: join(dshHome, 'assistant-workspace'),
        defaultAgentPreset: 'standard',
      },
      revision: 1,
      applies: 'live',
    }

    const resSplit = await applyFeishuVaultConfig({
      host,
      descriptors: [splitPolicyDesc, keychainDesc, deliveryDesc],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_split_test',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_split_owner',
      platform: 'darwin',
      env: {},
      now: 401,
      storeSecretFn: async () => {},
    })
    expect(resSplit.applied).toBe(true)

    const yamlText = readFileSync(patchPath, 'utf8')
    expect(yamlText).toContain("databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')")
    const parsed = parseDocument(yamlText, JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    // Must write into dsh-enhanced-assistant-policy, NOT create a phantom dsh-enhanced-personal-assistant row
    expect(parsed.some(r => r.id === 'dsh-enhanced-personal-assistant')).toBe(false)
    const policyCfg = parsed.find(r => r.id === 'dsh-enhanced-assistant-policy')!.config!
    expect(policyCfg['toolDefaultEffect']).toBe('deny')
    expect(policyCfg['proposalMaintenanceIntervalMs']).toBe(15_000)
    expect(policyCfg['autoReview']).toEqual({ enabled: true, timeoutMs: 30_000, maxTokens: 512 })
    expect(policyCfg['budgets']).toEqual([{ id: 'custom-budget', metric: 'automation-runs', limit: 5, periodMs: 86_400_000, scope: 'global' }])
    const splitRules = policyCfg['rules'] as Array<Record<string, unknown>>
    expect(splitRules.find(r => r['id'] === 'lark-owner-tool-*-primary')).toMatchObject({ effect: 'deny' })
    expect(splitRules.some(r => r['id'] === 'lark-channel-credential-primary')).toBe(true)

    // Existing non-Lark keychain handle from descriptors must survive whole-value replacement
    const kcHandles = (parsed.find(r => r.id === 'dsh-enhanced-credentials-keychain')!.config!['handles'] as Array<{ id: string }>).map(h => h.id)
    expect(kcHandles).toEqual(['other-service-secret', 'lark-app-secret-primary'])

    // External out-of-$DSH_HOME SQLite DB must remain completely untouched (0 rows)
    const extDb = new DatabaseSync(externalDbPath, { readOnly: true })
    try {
      const count = (extDb.prepare('SELECT COUNT(*) AS count FROM delivery_principals').get() as { count: number }).count
      expect(count).toBe(0)
    } finally {
      extDb.close()
    }

    // Overlong profileName + account producing macOS keychain service > 128 chars must refuse before calling storeSecretFn
    const longProfile = 'p'.repeat(50)
    const longAccount = 'a'.repeat(50)
    const longProfileDir = join(dshHome, 'profiles', longProfile)
    mkdirSync(longProfileDir, { recursive: true })
    writeFileSync(join(longProfileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    const storeShouldNotRun = vi.fn(async () => {})
    const resTooLong = await applyFeishuVaultConfig({
      host: makeHost(dshHome, longProfileDir, longProfile),
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_too_long',
      account: longAccount,
      tenant: 'personal',
      platform: 'darwin',
      env: {},
      now: 402,
      storeSecretFn: storeShouldNotRun,
    })
    expect(resTooLong.applied).toBe(false)
    expect(resTooLong.note).toContain('128')
    expect(storeShouldNotRun).not.toHaveBeenCalled()
  })
})
