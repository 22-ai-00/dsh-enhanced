import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import { validateLearningConfig } from '../../assistant-memory-learning/lib/index.js'
import { validateMemoryReviewConfig } from '../../assistant-verifier/lib/index.js'
import { validateMemoryLearningAdoptionGrant } from '../../personal-memory/lib/index.js'
import { CodingToolProber, discoverCodingToolBinary } from '../src/probes.ts'
import {
  applyDoctorRepair, applyFeishuVaultConfig, configureFeishuEasy, inspectProfileRestartSupport,
  inspectSetupDoctor, promoteLarkOwnerInProfile, triggerProfileRestart, type EasySecretLocator,
} from '../src/doctor-repair.ts'
import { resolveAssistantWorkspace } from '../src/assistant-chat.ts'
import {
  inspectAutonomyWizardStatus, inspectOwnerRoute, readPatchDocument, resolveProfilePaths,
  type AutonomyHostContext,
} from '../src/autonomy-setup.ts'
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
    traex: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: false, command: 'traex' },
    agy: { entry: 'dsh-ray-traex-acp-provider', installed: true, enabled: false, command: 'agy' },
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
        '@dsh-ray/acp': true,
        '@dsh-ray/assistant-isolation': true,
        '@dsh-ray/personal-assistant': true,
        '@dsh-ray/assistant-policy': true,
        '@dsh-ray/assistant-automations': true,
        '@dsh-ray/personal-memory': true,
        '@dsh-ray/personal-wiki': true,
        '@dsh-ray/assistant-memory-learning': true,
        '@dsh-ray/assistant-delivery': true,
        '@dsh-ray/traex-acp-provider': true,
      },
    }, null, 2))

    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-isolation',
      "  name: '@dsh-ray/assistant-isolation'",
      '  config:',
      '    backend: linux-native',
      '- id: dsh-ray-assistant-policy',
      "  name: '@dsh-ray/assistant-policy'",
      '  config:',
      '    toolDefaultEffect: allow',
      '    autoReview:',
      '      enabled: true',
      '- id: dsh-ray-traex-acp-provider',
      "  name: '@dsh-ray/traex-acp-provider'",
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
      ns: 'dsh-ray-traex-acp-provider',
      schema: {},
      value: { enabled: false, command: 'traex' },
      revision: 1,
      applies: 'live',
    }
    const status = baseStatus({
      bundles: [
        { name: '@dsh-ray/acp', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-acp', moduleName: '@dsh-ray/acp' }] },
        { name: '@dsh-ray/assistant-isolation', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-isolation', moduleName: '@dsh-ray/assistant-isolation' }] },
        { name: '@dsh-ray/personal-assistant', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-personal-assistant', moduleName: '@dsh-ray/personal-assistant' }] },
        { name: '@dsh-ray/assistant-policy', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-policy', moduleName: '@dsh-ray/assistant-policy' }] },
        { name: '@dsh-ray/assistant-memory-learning', installed: true, enabled: true, removable: true, error: { code: 'CONFIG_ERROR', diagnostic: 'Invalid memory learning configuration fields' }, rows: [{ rowId: 'dsh-ray-assistant-memory-learning', moduleName: '@dsh-ray/assistant-memory-learning' }] },
        { name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] },
      ],
      plugins: [
        { entryId: 'web-app', moduleName: '@deepseek-ai/dsh-web-app', enabled: true, fiberPhase: 'active' },
        { entryId: 'dsh-ray-acp', moduleName: '@dsh-ray/acp', enabled: true, fiberPhase: 'failed', diagnostic: 'DUPLICATE INSERT ID: cordis-host-runner' },
        { entryId: 'dsh-ray-assistant-isolation', moduleName: '@dsh-ray/assistant-isolation', enabled: true, fiberPhase: 'failed', diagnostic: 'CONFIG_ERROR' },
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
      '@dsh-ray/acp',
      '@dsh-ray/assistant-isolation',
      '@dsh-ray/assistant-memory-learning',
      '@dsh-ray/assistant-policy',
      '@dsh-ray/assistant-automations',
      '@dsh-ray/personal-memory',
      '@dsh-ray/personal-wiki',
    ]))
    expect(mutateMock).toHaveBeenCalledWith('dsh-ray-traex-acp-provider', [
      { op: 'set', path: ['enabled'], value: true },
      { op: 'set', path: ['command'], value: fakeTraex },
    ], 1)

    const updatedPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { bundles: Record<string, boolean> }
    expect(updatedPkg.bundles['@dsh-ray/acp']).toBe(false)
    expect(updatedPkg.bundles['@dsh-ray/assistant-policy']).toBe(false)
    expect(updatedPkg.bundles['@dsh-ray/personal-assistant']).toBe(true)

    const patchDoc = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJSON() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    const pa = patchDoc.find(r => r.id === 'dsh-ray-personal-assistant')!
    expect(pa.config!['assistantPolicy']).toMatchObject({ toolDefaultEffect: 'allow', autoReview: { enabled: true } })
    const paRules = (pa.config!['assistantPolicy'] as { rules: Array<{ id: string }> }).rules
    expect(paRules.some(r => r.id === 'dsh-ray-owner-route-owner-lark-primary')).toBe(true)
    expect(patchDoc.some(r => r.id === 'dsh-ray-assistant-policy')).toBe(false)

    const delivery = patchDoc.find(r => r.id === 'dsh-ray-assistant-delivery')!
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
      bundles: [{ name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] }],
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
      ns: 'dsh-ray-lark-channel',
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
    expect(resMac.note).toContain('dsh-ray restart')
    expect(stored).toHaveLength(1)
    expect(stored[0]!.secret).toBe('super-secret-value-xyz')
    const yamlText = readFileSync(patchPath, 'utf8')
    expect(yamlText).not.toContain('super-secret-value-xyz')
    const doc = parseDocument(yamlText, JS_PARSE_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const kc = doc.find(r => r.id === 'dsh-ray-credentials-keychain')!
    expect(kc.config?.['handles']).toEqual([expect.objectContaining({
      id: 'lark-app-secret-primary',
      provider: 'macos-keychain',
      consumers: ['dsh-ray-lark-channel'],
      purposes: ['connect'],
    })])
    const pa = doc.find(r => r.id === 'dsh-ray-personal-assistant')!
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
    const linuxHandle = (linuxDoc.find(r => r.id === 'dsh-ray-credentials-keychain')!.config!['handles'] as Array<{ path?: string }>)[0]!
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
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
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
    const rulesSame = (docSame.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
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
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
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
    const rulesDisabled = (docDisabled.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
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
    const rulesNew = (docNew.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
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
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
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
    const rulesLegacy = (docLegacy.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['assistantPolicy'] as { rules: Array<Record<string, unknown>> }).rules
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
      ns: 'dsh-ray-assistant-policy',
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
      ns: 'dsh-ray-credentials-keychain',
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
      ns: 'dsh-ray-assistant-delivery',
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
    // Must write into dsh-ray-assistant-policy, NOT create a phantom dsh-ray-personal-assistant row
    expect(parsed.some(r => r.id === 'dsh-ray-personal-assistant')).toBe(false)
    const policyCfg = parsed.find(r => r.id === 'dsh-ray-assistant-policy')!.config!
    expect(policyCfg['toolDefaultEffect']).toBe('deny')
    expect(policyCfg['proposalMaintenanceIntervalMs']).toBe(15_000)
    expect(policyCfg['autoReview']).toEqual({ enabled: true, timeoutMs: 30_000, maxTokens: 512 })
    expect(policyCfg['budgets']).toEqual([{ id: 'custom-budget', metric: 'automation-runs', limit: 5, periodMs: 86_400_000, scope: 'global' }])
    const splitRules = policyCfg['rules'] as Array<Record<string, unknown>>
    expect(splitRules.find(r => r['id'] === 'lark-owner-tool-*-primary')).toMatchObject({ effect: 'deny' })
    expect(splitRules.some(r => r['id'] === 'lark-channel-credential-primary')).toBe(true)

    // Existing non-Lark keychain handle from descriptors must survive whole-value replacement
    const kcHandles = (parsed.find(r => r.id === 'dsh-ray-credentials-keychain')!.config!['handles'] as Array<{ id: string }>).map(h => h.id)
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

  it('detects and repairs missing assistant-verifier databasePath, alias-corrupted policy rules, and YAML aliases cleanly', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    // Simulate a profile hit by the real-world bug: verifier row lacking databasePath + alias-mangled policy rules
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules:',
      '        - id: wizard-lark-mem-extract-desktop',
      '          effect: allow',
      '          subject:',
      '            kind: background',
      '            id: assistant-memory-learning',
      `            workspace: ${join(dshHome, 'assistant-workspace')}`,
      '            principal: lark/primary/personal/ou_owner_a',
      '          actions: [extract]',
      '          resource: { kind: memory, id: learning:lark-memory-extract-desktop }',
      '          context: { initiators: [background] }',
      '        - id: wizard-lark-mem-review-desktop',
      '          effect: allow',
      '          subject:',
      '            source: a1',
      '          actions: [review]',
      '          resource: { kind: memory, id: learning:lark-memory-review-desktop }',
      '          context:',
      '            source: a2',
      '        - id: wizard-lark-growth-tools-desktop',
      '          effect: allow',
      '          subject:',
      '            kind: agent',
      '            id: standard',
      `            workspace: ${join(dshHome, 'assistant-workspace')}`,
      '            principal: lark/primary/personal/ou_owner_a',
      '          actions: [execute]',
      '          resource: { kind: tool, id: growth_* }',
      '          context:',
      '            source: a3',
      '        - id: wizard-lark-verified-workflows-desktop',
      '          effect: allow',
      '          subject:',
      '            source: a4',
      '          actions: [draft]',
      '          resource: { kind: evolution, id: verified-workflows }',
      '          context:',
      '            source: a3',
      '        - id: unrecoverable-custom-rule',
      '          effect: allow',
      '          subject:',
      '            source: a9',
      '          actions: [execute]',
      '          resource: { kind: tool, id: "*" }',
      '          context: { initiators: [external] }',
      '- id: dsh-ray-assistant-verifier',
      '  name: "@dsh-ray/assistant-verifier"',
      '  config:',
      '    memoryReviews:',
      '      authorityId: lark-memory-review-desktop',
      '      maxReviews: 300',
      '',
    ].join('\n'), 'utf8')

    const host = makeHost(dshHome, profileDir, 'desktop')
    const status = baseStatus({
      bundles: [
        { name: '@dsh-ray/assistant-verifier', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-verifier', moduleName: '@dsh-ray/assistant-verifier' }] },
      ],
      plugins: [
        {
          entryId: 'include:dsh-ray-assistant-verifier',
          moduleName: '@dsh-ray/assistant-verifier',
          enabled: true,
          fiberPhase: 'failed',
          diagnostic: 'invalid config: - $.databasePath missing required value (at databasePath)',
        },
      ],
    })
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))

    const report = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 500 })
    const ids = report.issues.map(i => i.id)
    expect(ids).toContain('missing-verifier-database-path')
    expect(ids).toContain('corrupted-policy-alias-rules')
    // Must NOT fall through to generic stalled-bundle disable for assistant-verifier
    expect(ids).not.toContain('stalled-bundle:@dsh-ray/assistant-verifier')

    const repaired = await applyDoctorRepair({
      host,
      status,
      descriptors: [],
      settings: undefined,
      manager: undefined,
      prober,
      issueIds: ['missing-verifier-database-path', 'corrupted-policy-alias-rules'],
      platform: 'darwin',
      env: {},
      now: 501,
    })
    expect(repaired.applied).toBe(true)

    const repairedRaw = readFileSync(patchPath, 'utf8')
    expect(repairedRaw).toContain("databasePath: !!js dshHomePath('assistant-verifier/verification.sqlite')")
    expect(repairedRaw).not.toMatch(/&a\d+|\*a\d+/u)
    const repairedDoc = parseDocument(repairedRaw, JS_PARSE_TAG)
    const rows = repairedDoc.toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    const verifier = rows.find(r => r.id === 'dsh-ray-assistant-verifier')!
    expect(verifier.disabled).toBeUndefined()
    expect(verifier.config?.['databasePath']).toBe("dshHomePath('assistant-verifier/verification.sqlite')")
    expect(verifier.config?.['memoryReviews']).toEqual({ authorityId: 'lark-memory-review-desktop', maxReviews: 300 })

    const pa = rows.find(r => r.id === 'dsh-ray-personal-assistant')!
    const paPolicy = pa.config!['assistantPolicy'] as Record<string, unknown>
    const rules = paPolicy['rules'] as Array<Record<string, unknown>>
    expect(rules.find(r => r['id'] === 'wizard-lark-mem-review-desktop')?.['subject']).toMatchObject({
      kind: 'background',
      id: 'assistant-memory-learning',
    })
    expect(rules.find(r => r['id'] === 'wizard-lark-mem-review-desktop')?.['context']).toEqual({ initiators: ['background'] })
    expect(rules.find(r => r['id'] === 'wizard-lark-verified-workflows-desktop')?.['subject']).toMatchObject({
      kind: 'agent',
      id: 'standard',
    })
    expect(rules.some(r => r['id'] === 'unrecoverable-custom-rule')).toBe(false)

    // Verify applyFeishuVaultConfig resolves legacy YAML anchors (&a1/*a1) instead of turning them into { source: 'a1' }
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules:',
      '        - id: rule-anchor',
      '          effect: allow',
      '          subject: &a1',
      '            kind: background',
      '            id: assistant-memory-learning',
      '          actions: [extract]',
      '          resource: { kind: memory, id: "*" }',
      '          context: &a2',
      '            initiators: [background]',
      '        - id: rule-alias',
      '          effect: allow',
      '          subject: *a1',
      '          actions: [review]',
      '          resource: { kind: memory, id: "*" }',
      '          context: *a2',
      '',
    ].join('\n'), 'utf8')
    const vaultRes = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_alias_test',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_alias_user',
      platform: 'darwin',
      env: {},
      now: 502,
      storeSecretFn: async () => {},
    })
    expect(vaultRes.applied).toBe(true)
    const afterVaultRaw = readFileSync(patchPath, 'utf8')
    expect(afterVaultRaw).not.toContain('source: a1')
    expect(afterVaultRaw).not.toContain('source: a2')
    expect(afterVaultRaw).not.toMatch(/&a\d+|\*a\d+/u)
    const afterVaultRows = parseDocument(afterVaultRaw, JS_PARSE_TAG).toJS() as Array<{ id: string; config?: Record<string, unknown> }>
    const afterRules = ((afterVaultRows.find(r => r.id === 'dsh-ray-personal-assistant')!.config!['assistantPolicy'] as Record<string, unknown>)['rules'] as Array<Record<string, unknown>>)
    expect(afterRules.find(r => r['id'] === 'rule-alias')?.['subject']).toEqual({ kind: 'background', id: 'assistant-memory-learning' })
    expect(afterRules.find(r => r['id'] === 'rule-alias')?.['context']).toEqual({ initiators: ['background'] })
  })

  it('promotes a scanned linked Lark principal to primary owner atomically and honors confirmation and frozen-profile fences', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const deliveryDbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(deliveryDbPath, true)
    // Add pairing_challenges & delivery_preference_projection_outbox plus a linked scanned user
    const seedDb = new DatabaseSync(deliveryDbPath)
    try {
      seedDb.exec(`
        CREATE TABLE pairing_challenges (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE delivery_preference_projection_outbox (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          terminal_at INTEGER,
          failure_code TEXT,
          next_attempt_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          lane_kind TEXT,
          lane_principal_record_id TEXT,
          lane_principal_version INTEGER
        );
      `)
      seedDb.prepare(`INSERT INTO pairing_challenges VALUES ('ch-1', 'active', 1)`).run()
      seedDb.prepare(`INSERT INTO delivery_preference_projection_outbox VALUES ('ob-1', 'pending', NULL, NULL, 100, 1, 'exact', 'principal_lark_1', 1)`).run()
    } finally {
      seedDb.close()
    }

    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      "    defaultWorkspace: !!js dshHomePath('assistant-workspace')",
      '    defaultAgentPreset: standard',
      '- id: dsh-ray-assistant-dreaming',
      '  name: "@dsh-ray/assistant-dreaming"',
      '  config:',
      '    enabled: true',
      '    retired: false',
      '    scope:',
      '      principalId: lark/primary/personal/ou_owner1',
      '',
    ].join('\n'), 'utf8')

    const host = makeHost(dshHome, profileDir, 'desktop')

    // First scan creates linked identity because ou_owner1 is active owner
    const scanned = await applyFeishuVaultConfig({
      host,
      descriptors: [],
      appId: 'cli_aabbccddeeff0011',
      appSecret: 'sec_promote_test',
      account: 'primary',
      tenant: 'personal',
      ownerOpenId: 'ou_new_scanned',
      platform: 'darwin',
      env: {},
      now: 600,
      storeSecretFn: async () => {},
    })
    expect(scanned.applied).toBe(true)
    expect(scanned.ownerBinding).toBe('linked-to-owner')
    expect(scanned.existingAutonomyAnchored).toBe(true)

    // Unconfirmed promotion must refuse
    const unconfirmed = await promoteLarkOwnerInProfile({
      host,
      descriptors: [],
      openId: 'ou_new_scanned',
      account: 'primary',
      tenant: 'personal',
      confirmed: false,
      platform: 'darwin',
      env: {},
      now: 601,
    })
    expect(unconfirmed.applied).toBe(false)
    expect(unconfirmed.errorCode).toBe('confirmation-required')

    // Confirmed promotion hands off owner atomically
    const promoted = await promoteLarkOwnerInProfile({
      host,
      descriptors: [],
      openId: 'ou_new_scanned',
      account: 'primary',
      tenant: 'personal',
      confirmed: true,
      platform: 'darwin',
      env: {},
      now: 602,
    })
    expect(promoted.applied).toBe(true)
    expect(promoted.ownerBinding).toBe('bound-owner')
    expect(promoted.existingAutonomyAnchored).toBe(true)

    const verifyDb = new DatabaseSync(deliveryDbPath, { readOnly: true })
    try {
      const principals = verifyDb.prepare(`SELECT principal_json, role, status, linked_to_id, version FROM delivery_principals ORDER BY principal_json`).all() as Array<{
        principal_json: string; role: string; status: string; linked_to_id: string | null; version: number
      }>
      const oldOwner = principals.find(p => p.principal_json.includes('ou_owner123'))!
      const newOwner = principals.find(p => p.principal_json.includes('ou_new_scanned'))!
      expect(oldOwner.status).toBe('revoked')
      expect(newOwner.role).toBe('owner')
      expect(newOwner.status).toBe('active')
      expect(newOwner.linked_to_id).toBeNull()
      expect(newOwner.version).toBe(2)

      const binding = verifyDb.prepare(`SELECT status FROM conversation_bindings WHERE id = 'binding_1'`).get() as { status: string }
      expect(binding.status).toBe('revoked')

      const challenge = verifyDb.prepare(`SELECT status FROM pairing_challenges WHERE id = 'ch-1'`).get() as { status: string }
      expect(challenge.status).toBe('expired')

      const outbox = verifyDb.prepare(`SELECT failure_code FROM delivery_preference_projection_outbox WHERE id = 'ob-1'`).get() as { failure_code: string }
      expect(outbox.failure_code).toBe('owner-lineage-retired')
    } finally {
      verifyDb.close()
    }
  })

  it('detects managed-service, macOS desktop-app, manual, and frozen-systemd restart support and spawns detached restart safely', async () => {
    const { dshHome, profileDir } = makeTempHome()
    const fakeHome = join(dshHome, 'fake-home')
    mkdirSync(join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true })
    const host = makeHost(dshHome, profileDir, 'desktop')

    // 1) macOS LaunchAgent managed-service
    const plistPath = join(fakeHome, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.desktop.plist')
    writeFileSync(plistPath, '<plist><string>ai.deepseek.dsh.profile.desktop</string></plist>', 'utf8')
    const launchdSupport = inspectProfileRestartSupport({ host, platform: 'darwin', env: {}, home: fakeHome, execPath: '/usr/local/bin/node', argv: [] })
    expect(launchdSupport).toMatchObject({ supported: true, mode: 'managed-service', targetLabel: 'ai.deepseek.dsh.profile.desktop' })

    const spawnedCalls: Array<{ cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv; shell: boolean; detached: boolean }> = []
    const fakeSpawn = vi.fn((cmd: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore'; shell: boolean }) => {
      spawnedCalls.push({ cmd, args, env: opts.env, shell: opts.shell, detached: opts.detached })
      return { pid: 43210, unref: vi.fn() }
    })

    // Unconfirmed must refuse
    expect((await triggerProfileRestart({ host, confirmed: false, platform: 'darwin', env: {}, home: fakeHome, spawnFn: fakeSpawn })).applied).toBe(false)
    expect(fakeSpawn).not.toHaveBeenCalled()

    // Confirmed LaunchAgent restart
    const launchdRes = await triggerProfileRestart({
      host, confirmed: true, platform: 'darwin', env: {}, home: fakeHome, execPath: '/usr/local/bin/node', argv: [], uid: 501, spawnFn: fakeSpawn,
    })
    expect(launchdRes.applied).toBe(true)
    expect(spawnedCalls[0]!.shell).toBe(false)
    expect(spawnedCalls[0]!.detached).toBe(true)
    expect(spawnedCalls[0]!.env['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(spawnedCalls[0]!.args).toContain('/bin/launchctl')
    expect(spawnedCalls[0]!.args).toContain('gui/501/ai.deepseek.dsh.profile.desktop')

    // 2) macOS DeepSeek Harness.app desktop mode (no LaunchAgent plist)
    rmSync(plistPath)
    const desktopSupport = inspectProfileRestartSupport({
      host,
      platform: 'darwin',
      env: {},
      home: fakeHome,
      execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      argv: [],
    })
    expect(desktopSupport).toMatchObject({ supported: true, mode: 'desktop-app', appPath: '/Applications/DeepSeek Harness.app' })
    const desktopRes = await triggerProfileRestart({
      host,
      confirmed: true,
      platform: 'darwin',
      env: {},
      home: fakeHome,
      execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      argv: [],
      pid: 9876,
      ppid: 9800,
      spawnFn: fakeSpawn,
    })
    expect(desktopRes.applied).toBe(true)
    expect(spawnedCalls[1]!.args).toContain('9876')
    expect(spawnedCalls[1]!.args).toContain('9800')
    expect(spawnedCalls[1]!.args).toContain('com.deepseek.dsh')
    expect(spawnedCalls[1]!.args[1]).toContain('lsappinfo')
    expect(spawnedCalls[1]!.args[1]).toContain('SIGTERM')
    expect(spawnedCalls[1]!.env['ELECTRON_RUN_AS_NODE']).toBe('1')

    // 3) Frozen Linux systemd profile refuses automatic restart
    const cohortDir = join(dshHome, 'rsi-local-cohorts', 'desktop')
    mkdirSync(cohortDir, { recursive: true })
    writeFileSync(join(cohortDir, 'receipt.json'), '{}', 'utf8')
    const frozenSupport = inspectProfileRestartSupport({
      host,
      platform: 'linux',
      env: {},
      home: fakeHome,
      execPath: '/usr/bin/node',
      argv: [],
    })
    expect(frozenSupport.supported).toBe(false)
    expect(frozenSupport.mode).toBe('manual')
    const frozenRes = await triggerProfileRestart({
      host,
      confirmed: true,
      platform: 'linux',
      env: {},
      home: fakeHome,
      execPath: '/usr/bin/node',
      argv: [],
      spawnFn: fakeSpawn,
    })
    expect(frozenRes.applied).toBe(false)
    expect(frozenRes.note).toContain('冻结')
    rmSync(cohortDir, { recursive: true, force: true })

    // 4) Non-frozen Linux managed systemd user unit
    mkdirSync(join(fakeHome, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(join(fakeHome, '.config', 'systemd', 'user', 'dsh-profile-desktop.service'), '# DeepSeek Harness profile\n', 'utf8')
    const linuxRes = await triggerProfileRestart({
      host, confirmed: true, platform: 'linux', env: {}, home: fakeHome, execPath: '/usr/bin/node', argv: [], spawnFn: fakeSpawn,
    })
    expect(linuxRes.applied).toBe(true)
    expect(spawnedCalls[2]!.args[3]).toMatch(/^\/(?:usr\/)?bin\/systemctl$/u)
    expect(spawnedCalls[2]!.args).toContain('dsh-profile-desktop.service')
  })

  it('deterministically resolves the default assistant-workspace even when an unconfigured SQLite binding points to a coding repo or patch uses !!js', () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const deliveryDbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    mkdirSync(join(dshHome, 'assistant-delivery'), { recursive: true })
    const db = new DatabaseSync(deliveryDbPath)
    try {
      db.exec(`
        CREATE TABLE delivery_principals (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, principal_json TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, linked_to_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL);
        CREATE TABLE conversation_bindings (id TEXT PRIMARY KEY, conversation_json TEXT NOT NULL, principal_id TEXT NOT NULL, workspace TEXT NOT NULL, agent_preset TEXT NOT NULL, policy_ref TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
      `)
      db.prepare(`INSERT INTO delivery_principals VALUES ('p-web', 'h1', '{"channel":"web","account":"desktop","tenant":"local","user":"operator"}', 'owner', 'active', NULL, 1, 1, 1)`).run()
      db.prepare(`INSERT INTO conversation_bindings VALUES ('b-code', '{"channel":"web"}', 'p-web', '/tmp/some-coding-repo', 'standard', 'owner-dm', 1, 'active', 1)`).run()
    } finally {
      db.close()
    }
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      "    defaultWorkspace: !!js dshHomePath('assistant-workspace')",
      '',
    ].join('\n'), 'utf8')
    const host = makeHost(dshHome, profileDir, 'desktop')
    const resolved = resolveAssistantWorkspace(host as never, {})
    expect(resolved.workspace).toBe(join(realpathSync(dshHome), 'assistant-workspace'))
    expect(resolved.workspace).not.toContain('dshHomePath(')
    expect(resolved.workspace).not.toContain('some-coding-repo')
  })

  it('never leaks literal dshHomePath strings in missing-local-owner-route repair or inspectOwnerRoute', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const workDir = join(dshHome, 'isolated-cwd')
    mkdirSync(workDir, { recursive: true })
    writeFileSync(patchPath, '[]\n', 'utf8')
    const host = makeHost(dshHome, profileDir, 'desktop')
    const status = baseStatus({
      bundles: [
        { name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] },
      ],
    })
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))

    const origCwd = process.cwd()
    process.chdir(workDir)
    try {
      const res = await applyDoctorRepair({
        host,
        status,
        descriptors: [],
        settings: undefined,
        manager: undefined,
        prober,
        issueIds: ['missing-local-owner-route'],
        platform: 'darwin',
        env: {},
        now: 700,
      })
      expect(res.applied).toBe(true)
      expect(existsSync(join(workDir, "dshHomePath('assistant-workspace')"))).toBe(false)
    } finally {
      process.chdir(origCwd)
    }

    const expectedWs = join(realpathSync(dshHome), 'assistant-workspace')
    const rawPatch = readFileSync(patchPath, 'utf8')
    expect(rawPatch).not.toContain("workspace: dshHomePath('assistant-workspace')")
    expect(rawPatch).toContain(`workspace: ${expectedWs}`)

    // Even if an ownerRoute explicitly uses !!js dshHomePath(...), inspectOwnerRoute must evaluate it to a real path
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      '    ownerRoutes:',
      '      - id: owner-web-desktop',
      '        conversation: { channel: web, account: desktop, tenant: local, kind: dm, chat: owner-primary }',
      '        principal: { channel: web, account: desktop, tenant: local, user: operator }',
      "        workspace: !!js dshHomePath('assistant-workspace')",
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 1',
      '',
    ].join('\n'), 'utf8')
    const paths = resolveProfilePaths(host, {})
    const doc = readPatchDocument(paths.patchPath)
    const inspected = inspectOwnerRoute(host, paths, doc.contents as never, [])
    expect(inspected.workspace).toBe(expectedWs)
    expect(inspected.workspace).not.toContain('dshHomePath(')
  })

  it('guides and unblocks AutonomyWizard after owner handoff when old ownerRoutes existed and syncs ownerRoutes immediately when DM binding already exists', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const deliveryDbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(deliveryDbPath, true)
    const ws = join(realpathSync(dshHome), 'assistant-workspace')
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      "    spoolPath: !!js dshHomePath('assistant-delivery/spool')",
      `    defaultWorkspace: ${ws}`,
      '    defaultAgentPreset: standard',
      '    ownerRoutes:',
      '      - id: owner-lark-primary',
      '        conversation: { channel: lark, account: primary, tenant: personal, kind: dm, chat: oc_old }',
      '        principal: { channel: lark, account: primary, tenant: personal, user: ou_owner123 }',
      `        workspace: ${ws}`,
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 1',
      '- id: dsh-ray-assistant-dreaming',
      '  name: "@dsh-ray/assistant-dreaming"',
      '  config:',
      `    databasePath: ${join(dshHome, 'assistant-dreaming', 'desktop.sqlite')}`,
      '    enabled: true',
      '    retired: false',
      `    scope: { workspace: ${ws}, preset: standard, principalId: lark/primary/personal/ou_owner123, ownerRouteId: owner-lark-primary }`,
      '',
    ].join('\n'), 'utf8')

    const host = makeHost(dshHome, profileDir, 'desktop')
    // Promote new owner before it has a DM conversation binding
    const promoted = await promoteLarkOwnerInProfile({
      host, descriptors: [], openId: 'ou_new_owner', account: 'primary', tenant: 'personal', confirmed: true, platform: 'darwin', env: {}, now: 800,
    })
    expect(promoted.applied).toBe(true)
    expect(promoted.existingAutonomyAnchored).toBe(true)
    expect(promoted.note).toContain('一键初始化/修复前置项')

    // Before first DM, inspectAutonomyWizardStatus tells user to send first DM and sync owner route
    const beforeDm = await inspectAutonomyWizardStatus(host, { env: {} })
    expect(beforeDm.ownerRoute.active).toBe(false)
    expect(beforeDm.ownerRoute.missingReason).toContain('ou_new_owner')
    expect(beforeDm.ownerRoute.missingReason).toContain('发送一条私聊消息')

    // Simulate user sending first DM from ou_new_owner after restart
    const db = new DatabaseSync(deliveryDbPath)
    try {
      const row = db.prepare(`SELECT id, principal_json FROM delivery_principals WHERE role = 'owner' AND status = 'active'`).get() as { id: string; principal_json: string }
      db.prepare(`INSERT INTO conversation_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('b_new', 'chash_new', JSON.stringify({ channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_new_dm' }), row.id, row.principal_json, ws, 'standard', 'sess_new', 1, 'owner-dm', 'active', 900, 900, 1)
    } finally {
      db.close()
    }

    // After DM, inspectAutonomyWizardStatus explicitly instructs clicking 一键初始化/修复前置项
    const afterDm = await inspectAutonomyWizardStatus(host, { env: {} })
    expect(afterDm.ownerRoute.active).toBe(false)
    expect(afterDm.ownerRoute.missingReason).toContain('ou_new_owner')
    expect(afterDm.ownerRoute.missingReason).toContain('一键初始化/修复前置项')

    // Running Doctor repair immediately updates owner-lark-primary to ou_new_owner and unlocks AutonomyWizard
    const status = baseStatus({
      bundles: [
        { name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] },
      ],
    })
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))
    const synced = await applyDoctorRepair({
      host, status, descriptors: [], settings: undefined, manager: undefined, prober, issueIds: ['missing-local-owner-route'], platform: 'darwin', env: {}, now: 901,
    })
    expect(synced.applied).toBe(true)

    const unlocked = await inspectAutonomyWizardStatus(host, { env: {} })
    expect(unlocked.ownerRoute.active).toBe(true)
    expect(unlocked.ownerRoute.principalId).toBe('lark/primary/personal/ou_new_owner')

    // And if promoteLarkOwnerInProfile runs when DM binding ALREADY exists, it syncs ownerRoutes directly in one step
    const rePromoted = await promoteLarkOwnerInProfile({
      host, descriptors: [], openId: 'ou_new_owner', account: 'primary', tenant: 'personal', confirmed: true, platform: 'darwin', env: {}, now: 902,
    })
    expect(rePromoted.applied).toBe(true)
    expect(rePromoted.note).toContain('已同步更新 ownerRoutes')
  })

  it('pauses active stale-owner system automations and suppresses their pending incidents on promoteLarkOwnerInProfile', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const deliveryDbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(deliveryDbPath, false)
    const automationsDir = join(dshHome, 'assistant-automations')
    mkdirSync(automationsDir, { recursive: true })
    const automationsDbPath = join(automationsDir, 'state.sqlite')
    const hash = 'a'.repeat(64)
    const autoDb = new DatabaseSync(automationsDbPath)
    autoDb.exec(`
      CREATE TABLE automation_definitions (
        id TEXT PRIMARY KEY,
        create_idempotency_key TEXT NOT NULL UNIQUE,
        system_owner TEXT,
        definition_hash TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1)
      ) STRICT;
      CREATE TABLE automation_incidents (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        stage TEXT NOT NULL,
        state TEXT NOT NULL,
        failure_class TEXT NOT NULL,
        failure_phase TEXT NOT NULL,
        failure_code TEXT NOT NULL,
        side_effect_state TEXT NOT NULL,
        retryability TEXT NOT NULL,
        notification_route_id TEXT NOT NULL,
        lifecycle_generation INTEGER NOT NULL,
        presentation_revision INTEGER NOT NULL,
        alert_status TEXT NOT NULL,
        alert_ref TEXT,
        run_id TEXT,
        opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        version INTEGER NOT NULL
      ) STRICT;
    `)
    const ins = autoDb.prepare(`
      INSERT INTO automation_definitions (id, create_idempotency_key, system_owner, definition_hash, definition_json, status, next_run_at, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, 'active', 1000, 100, 100, 1)
    `)
    ins.run('old-sys', 'k1', 'assistant-memory-learning', hash, JSON.stringify({ principal: 'lark/primary/personal/ou_owner123' }))
    ins.run('new-sys', 'k2', 'assistant-memory-learning', hash, JSON.stringify({ principal: 'lark/primary/personal/ou_new_owner' }))
    ins.run('old-user', 'k3', null, hash, JSON.stringify({ principal: 'lark/primary/personal/ou_owner123' }))
    autoDb.prepare(`
      INSERT INTO automation_incidents (
        id, automation_id, definition_hash, stage, state, failure_class, failure_phase, failure_code,
        side_effect_state, retryability, notification_route_id, lifecycle_generation, presentation_revision,
        alert_status, alert_ref, run_id, opened_at, updated_at, resolved_at, version
      ) VALUES ('inc-old', 'old-sys', ?, 'materialize', 'open', 'policy', 'route', 'denied', 'none', 'after-intervention', 'r', 1, 1, 'pending', NULL, NULL, 100, 100, NULL, 1)
    `).run(hash)
    autoDb.close()

    writeFileSync(patchPath, '', 'utf8')
    const host = makeHost(dshHome, profileDir, 'desktop')
    const res = await promoteLarkOwnerInProfile({
      host, descriptors: [], openId: 'ou_new_owner', account: 'primary', tenant: 'personal', confirmed: true, platform: 'darwin', env: {}, now: 950,
    })
    expect(res.applied).toBe(true)
    expect(res.note).toContain('已自动暂停 1 条旧主人遗留系统自动化')

    const verifyDb = new DatabaseSync(automationsDbPath, { readOnly: true })
    const statuses = Object.fromEntries(
      (verifyDb.prepare('SELECT id, status FROM automation_definitions').all() as Array<{ id: string; status: string }>)
        .map(row => [row.id, row.status]),
    )
    expect(statuses).toEqual({
      'old-sys': 'paused',
      'new-sys': 'active',
      'old-user': 'active',
    })
    const inc = verifyDb.prepare('SELECT alert_status FROM automation_incidents WHERE id = ?').get('inc-old') as { alert_status: string }
    expect(inc.alert_status).toBe('suppressed')
    verifyDb.close()
  })

  it('never auto-disables core bundles on failure and restores disabled personal-assistant on real dsh.profile.bundles manifest', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    // 1) Failed core bundle (@dsh-ray/personal-assistant) must NEVER become auto-fixable stalled-bundle disable
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {
        '@dsh-ray/personal-assistant': '0.1.78',
        '@dsh-ray/assistant-policy': '0.1.78',
        '@dsh-ray/assistant-delivery': '0.1.78',
        '@dsh-ray/lark-channel': '0.1.78',
      },
      dsh: {
        profile: {
          bundles: [
            '@dsh-ray/personal-assistant',
            '@dsh-ray/assistant-delivery',
            '@dsh-ray/lark-channel',
          ],
        },
      },
    }, null, 2), 'utf8')
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules: []',
      '      budgets: []',
      '',
    ].join('\n'), 'utf8')

    const host = {
      get: (name: string) => name === 'profileContext' ? { dir: profileDir, name: 'desktop' } : undefined,
    }
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))
    const failedPaStatus = baseStatus({
      bundles: [
        { name: '@dsh-ray/personal-assistant', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-personal-assistant', moduleName: '@dsh-ray/personal-assistant' }] },
        { name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] },
        { name: '@dsh-ray/lark-channel', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-lark-channel', moduleName: '@dsh-ray/lark-channel' }] },
      ],
      plugins: [
        { entryId: 'pa', moduleName: '@dsh-ray/personal-assistant', enabled: true, fiberPhase: 'failed', diagnostic: 'transient reload error' },
      ],
    })
    const failedReport = await inspectSetupDoctor({ host, status: failedPaStatus, descriptors: [], prober, platform: 'darwin', env: {}, now: 1000 })
    expect(failedReport.issues.some(i => i.id === 'stalled-bundle:@dsh-ray/personal-assistant')).toBe(false)
    const coreIssue = failedReport.issues.find(i => i.id === 'core-bundle-failed:@dsh-ray/personal-assistant')
    expect(coreIssue).toBeDefined()
    expect(coreIssue!.autoFixable).toBe(false)

    // 2) Disabled personal-assistant (omitted from dsh.profile.bundles AND disabled: true in cordis.patch.yml) is detected & atomically restored
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {
        '@dsh-ray/personal-assistant': '0.1.78',
        '@dsh-ray/assistant-policy': '0.1.78',
        '@dsh-ray/assistant-delivery': '0.1.78',
        '@dsh-ray/lark-channel': '0.1.78',
      },
      dsh: {
        profile: {
          bundles: [
            '@dsh-ray/assistant-delivery',
            '@dsh-ray/lark-channel',
          ],
        },
      },
    }, null, 2), 'utf8')
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules:',
      '        - id: keep-existing-rule',
      '          effect: allow',
      '          subject: { kind: agent, id: "*", workspace: "*" }',
      '          actions: ["*"]',
      '          resource: { kind: "*", id: "*" }',
      '          context: { initiators: [foreground] }',
      '      budgets: []',
      '  disabled: true',
      '- id: dsh-ray-lark-channel',
      '  name: "@dsh-ray/lark-channel"',
      '  config:',
      '    enabled: true',
      '    appId: cli_aabbccddeeff0011',
      '',
    ].join('\n'), 'utf8')

    const disabledStatus = baseStatus({
      dependencies: [
        { name: 'assistantPolicy', available: false },
        { name: 'assistantDelivery', available: false },
        { name: 'assistantSkills', available: true },
      ],
      bundles: [
        { name: '@dsh-ray/personal-assistant', installed: true, enabled: false, removable: true, rows: [{ rowId: 'dsh-ray-personal-assistant', moduleName: '@dsh-ray/personal-assistant' }] },
        { name: '@dsh-ray/assistant-policy', installed: true, enabled: false, removable: true, rows: [{ rowId: 'dsh-ray-assistant-policy', moduleName: '@dsh-ray/assistant-policy' }] },
        { name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] },
        { name: '@dsh-ray/lark-channel', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-lark-channel', moduleName: '@dsh-ray/lark-channel' }] },
      ],
      plugins: [
        { entryId: 'lark', moduleName: '@dsh-ray/lark-channel', enabled: true, fiberPhase: 'pending' },
      ],
    })
    const disabledReport = await inspectSetupDoctor({ host, status: disabledStatus, descriptors: [], prober, platform: 'darwin', env: {}, now: 1001 })
    const recoveryIssue = disabledReport.issues.find(i => i.id === 'disabled-core-policy-provider')
    expect(recoveryIssue).toBeDefined()
    expect(recoveryIssue!.autoFixable).toBe(true)
    expect(recoveryIssue!.fixLabel).toContain('personal-assistant')

    let patchDisabledWhenManagerCalled: boolean | undefined
    const manager = {
      listBundles: async () => [],
      listPlugins: async () => [],
      setBundleEnabled: vi.fn(async (_pkg: string, _enabled: boolean) => {
        const currentRows = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJS() as Array<{ id: string; disabled?: boolean }>
        patchDisabledWhenManagerCalled = currentRows.find(r => r.id === 'dsh-ray-personal-assistant')?.disabled
        return { target: _pkg, changed: true, application: 'restart-required' as const }
      }),
      setPluginEnabled: async () => ({ target: '', changed: false, application: 'applied' as const }),
      installBundle: async () => ({ target: '', changed: false, application: 'applied' as const }),
      removeBundle: async () => ({ target: '', changed: false, application: 'applied' as const }),
    }
    const repaired = await applyDoctorRepair({
      host,
      status: disabledStatus,
      descriptors: [],
      settings: undefined,
      manager,
      prober,
      issueIds: ['disabled-core-policy-provider'],
      platform: 'darwin',
      env: {},
      now: 1002,
    })
    expect(repaired.applied).toBe(true)
    expect(repaired.note).toContain('@dsh-ray/personal-assistant')
    expect(manager.setBundleEnabled).toHaveBeenCalledWith('@dsh-ray/personal-assistant', true)
    // Patch file must already have `disabled` cleared BEFORE pluginManager.setBundleEnabled runs!
    expect(patchDisabledWhenManagerCalled).toBeUndefined()

    const updatedPkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(updatedPkg.dsh.profile.bundles).toContain('@dsh-ray/personal-assistant')
    const updatedRows = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    const restoredPa = updatedRows.find(r => r.id === 'dsh-ray-personal-assistant')!
    expect(restoredPa.disabled).toBeUndefined()
    expect((restoredPa.config!['assistantPolicy'] as { rules: Array<{ id: string }> }).rules.some(r => r.id === 'keep-existing-rule')).toBe(true)

    // 3) applyFeishuVaultConfig also clears stale disabled: true on personal-assistant & assistant-delivery
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  disabled: true',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules: []',
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  disabled: true',
      '  config: {}',
      '',
    ].join('\n'), 'utf8')
    const vaultRes = await applyFeishuVaultConfig({
      host: { get: (n: string) => n === 'profileContext' ? { dir: profileDir, name: 'desktop', home: dshHome } : undefined },
      descriptors: [],
      appId: 'cli_0123456789abcdef',
      appSecret: 'sec_clear_disabled',
      account: 'primary',
      tenant: 'personal',
      platform: 'darwin',
      env: {},
      now: 1003,
      storeSecretFn: async () => {},
    })
    expect(vaultRes.applied).toBe(true)
    const afterVault = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJS() as Array<{ id: string; disabled?: boolean }>
    expect(afterVault.find(r => r.id === 'dsh-ray-personal-assistant')?.disabled).toBeUndefined()
    expect(afterVault.find(r => r.id === 'dsh-ray-assistant-delivery')?.disabled).toBeUndefined()
  })

  it('detects and auto-repairs frozen personal-memory learning grant conflict by rotating authority generation', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const memDir = join(dshHome, 'personal-memory')
    mkdirSync(memDir, { recursive: true })
    const memoryDbPath = join(memDir, 'memory.sqlite')
    const memDb = new DatabaseSync(memoryDbPath)
    try {
      memDb.exec(`CREATE TABLE memory_learning_adoptions (
        authority_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        row_kind TEXT NOT NULL,
        grant_json TEXT NOT NULL,
        grant_digest TEXT NOT NULL,
        used_mutations INTEGER NOT NULL DEFAULT 0,
        used_content_bytes INTEGER NOT NULL DEFAULT 0
      )`)
      memDb.prepare(
        `INSERT INTO memory_learning_adoptions VALUES ('lark-memory-adopt-desktop', '', 'grant', '{}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, 0)`,
      ).run()
    } finally {
      memDb.close()
    }

    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: {
        '@dsh-ray/personal-assistant': '0.1.78',
        '@dsh-ray/assistant-verifier': '0.1.78',
        '@dsh-ray/assistant-memory-learning': '0.1.78',
      },
      dsh: {
        profile: {
          bundles: [
            '@dsh-ray/personal-assistant',
            '@dsh-ray/assistant-verifier',
            '@dsh-ray/assistant-memory-learning',
          ],
        },
      },
    }, null, 2), 'utf8')

    const reviewObj = {
      authorityId: 'lark-memory-review-desktop',
      expiresAt: 1_900_000_000_000,
      maxReviews: 300,
    }
    const adoptObj = {
      authorityId: 'lark-memory-adopt-desktop',
      reviewAuthorityId: 'lark-memory-review-desktop',
      reviewAuthorityDigest: '0000000000000000000000000000000000000000000000000000000000000000',
      expiresAt: 1_900_000_000_000,
      maxMutations: 300,
    }
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules:',
      '        - id: wizard-lark-mem-extract-desktop',
      '          effect: allow',
      '          actions: [extract]',
      '          resource: { kind: memory, id: "learning:lark-memory-extract-desktop" }',
      '        - id: wizard-lark-mem-review-desktop',
      '          effect: allow',
      '          actions: [review]',
      '          resource: { kind: memory, id: "learning:lark-memory-review-desktop" }',
      '        - id: wizard-lark-mem-adopt-desktop',
      '          effect: allow',
      '          actions: [adopt]',
      '          resource: { kind: memory, id: "learning:lark-memory-adopt-desktop" }',
      '    personalMemory:',
      "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
      '      automaticLearning:',
      `        authorityId: ${adoptObj.authorityId}`,
      `        reviewAuthorityId: ${adoptObj.reviewAuthorityId}`,
      `        reviewAuthorityDigest: ${adoptObj.reviewAuthorityDigest}`,
      `        expiresAt: ${adoptObj.expiresAt}`,
      `        maxMutations: ${adoptObj.maxMutations}`,
      '- id: dsh-ray-assistant-verifier',
      '  name: "@dsh-ray/assistant-verifier"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-verifier/verification.sqlite')",
      '    memoryReviews:',
      `      authorityId: ${reviewObj.authorityId}`,
      `      expiresAt: ${reviewObj.expiresAt}`,
      `      maxReviews: ${reviewObj.maxReviews}`,
      '- id: dsh-ray-assistant-memory-learning',
      '  name: "@dsh-ray/assistant-memory-learning"',
      '  disabled: false',
      '  config:',
      `    databasePath: ${join(dshHome, 'assistant-memory-learning', 'desktop.sqlite')}`,
      '    authorityId: lark-memory-extract-desktop',
      '    reviewAuthorityId: lark-memory-review-desktop',
      '    reviewAuthorityDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '    adoptionAuthorityId: lark-memory-adopt-desktop',
      '    adoptionGrantDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '    maxExtractions: 300',
      '',
    ].join('\n'), 'utf8')

    const host = makeHost(dshHome, profileDir, 'desktop')
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))
    const status = baseStatus({
      bundles: [
        { name: '@dsh-ray/personal-assistant', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-personal-assistant', moduleName: '@dsh-ray/personal-assistant' }] },
        { name: '@dsh-ray/assistant-verifier', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-verifier', moduleName: '@dsh-ray/assistant-verifier' }] },
        { name: '@dsh-ray/assistant-memory-learning', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-memory-learning', moduleName: '@dsh-ray/assistant-memory-learning' }] },
      ],
      plugins: [
        { entryId: 'pa', moduleName: '@dsh-ray/personal-assistant', enabled: true, fiberPhase: 'failed', diagnostic: 'learning grant authority changed' },
        { entryId: 'ver', moduleName: '@dsh-ray/assistant-verifier', enabled: true, fiberPhase: 'active' },
        { entryId: 'mem', moduleName: '@dsh-ray/assistant-memory-learning', enabled: true, fiberPhase: 'pending' },
      ],
    })

    const report = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 2001 })
    const conflictIssue = report.issues.find(i => i.id === 'memory-learning-grant-conflict')
    expect(conflictIssue).toBeDefined()
    expect(conflictIssue?.autoFixable).toBe(true)
    expect(report.issues.some(i => i.id === 'core-bundle-failed:@dsh-ray/personal-assistant')).toBe(false)

    const repaired = await applyDoctorRepair({
      host,
      status,
      descriptors: [],
      settings: undefined,
      manager: undefined,
      prober,
      issueIds: ['memory-learning-grant-conflict'],
      platform: 'darwin',
      env: {},
      now: 2002,
    })
    expect(repaired.applied).toBe(true)
    expect(repaired.note).toContain('g2')

    const updatedRows = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJS() as Array<{ id: string; config?: Record<string, any> }>
    const pa = updatedRows.find(r => r.id === 'dsh-ray-personal-assistant')!.config!
    const ver = updatedRows.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!
    const mem = updatedRows.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config!
    expect(pa['personalMemory']['automaticLearning']['authorityId']).toBe('lark-memory-adopt-desktop-g2')
    expect(ver['memoryReviews']['authorityId']).toBe('lark-memory-review-desktop-g2')
    expect(mem['authorityId']).toBe('lark-memory-extract-desktop-g2')
    expect(mem['adoptionAuthorityId']).toBe('lark-memory-adopt-desktop-g2')
    expect(mem['reviewAuthorityId']).toBe('lark-memory-review-desktop-g2')
    const rules = pa['assistantPolicy']['rules'] as Array<{ id: string; resource: { id: string } }>
    expect(rules.find(r => r.id === 'wizard-lark-mem-adopt-desktop')?.resource.id).toBe('learning:lark-memory-adopt-desktop-g2')
    expect(rules.find(r => r.id === 'wizard-lark-mem-review-desktop')?.resource.id).toBe('learning:lark-memory-review-desktop-g2')
    expect(rules.find(r => r.id === 'wizard-lark-mem-extract-desktop')?.resource.id).toBe('learning:lark-memory-extract-desktop-g2')

    // Re-inspect MUST report zero memory-learning-grant-conflict issues!
    const afterReport = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 2003 })
    expect(afterReport.issues.some(i => i.id === 'memory-learning-grant-conflict')).toBe(false)
  })

  it('co-repairs memory-learning-grant-conflict when restoring disabled-core-policy-provider, resolves !!js databasePath, and normalizes workItemExperiences: false', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const canonicalHome = realpathSync(dshHome)
    const memDir = join(dshHome, 'personal-memory')
    mkdirSync(memDir, { recursive: true })
    const memDb = new DatabaseSync(join(memDir, 'memory.sqlite'))
    try {
      memDb.exec(`CREATE TABLE memory_learning_adoptions (
        authority_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        row_kind TEXT NOT NULL,
        grant_json TEXT NOT NULL,
        grant_digest TEXT NOT NULL,
        used_mutations INTEGER NOT NULL DEFAULT 0,
        used_content_bytes INTEGER NOT NULL DEFAULT 0
      )`)
      memDb.prepare(
        `INSERT INTO memory_learning_adoptions VALUES ('lark-memory-adopt-desktop', '', 'grant', '{}', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 0, 0)`,
      ).run()
    } finally {
      memDb.close()
    }

    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: {
        '@dsh-ray/personal-assistant': '0.1.78',
        '@dsh-ray/assistant-verifier': '0.1.78',
        '@dsh-ray/assistant-memory-learning': '0.1.78',
        '@dsh-ray/lark-channel': '0.1.78',
      },
      dsh: {
        profile: {
          bundles: [
            '@dsh-ray/assistant-verifier',
            '@dsh-ray/assistant-memory-learning',
            '@dsh-ray/lark-channel',
          ],
        },
      },
    }, null, 2), 'utf8')

    const owner = {
      authorityId: 'owner-lark-primary',
      authorityHash: '1111111111111111111111111111111111111111111111111111111111111111',
      principalId: 'lark/primary/personal/ou_owner_test',
      principalRecordId: 'principal_test_1',
      principalVersion: 1,
      workspace: join(canonicalHome, 'assistant-workspace'),
      agentPreset: 'standard',
    }

    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  disabled: true',
      '  config:',
      '    assistantPolicy:',
      "      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '      rules:',
      '        - id: wizard-lark-mem-adopt-desktop',
      '          effect: allow',
      '          actions: [adopt]',
      '          resource: { kind: memory, id: "learning:lark-memory-adopt-desktop" }',
      '    personalMemory:',
      "      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
      '      automaticLearning:',
      '        authorityId: lark-memory-adopt-desktop',
      `        owner: ${JSON.stringify(owner)}`,
      '        reviewAuthorityId: lark-memory-review-desktop',
      '        reviewAuthorityDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '        expiresAt: 1900000000000',
      '        maxMutations: 300',
      '        maxTotalContentBytes: 1048576',
      '        maxRecordTtlMs: 7776000000',
      '        kinds: [fact, experience]',
      '        operations: [add, replace, remove]',
      '        workItemExperiences: false',
      '- id: dsh-ray-assistant-verifier',
      '  name: "@dsh-ray/assistant-verifier"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-verifier/verification.sqlite')",
      '    memoryReviews:',
      '      authorityId: lark-memory-review-desktop',
      `      owner: ${JSON.stringify(owner)}`,
      '      expiresAt: 1900000000000',
      '      maxReviews: 300',
      '      policy: Independently verify owner statements.',
      '      maxInputBytes: 65536',
      '      maxOutputTokens: 2048',
      '      timeoutMs: 60000',
      '      workItemExperiences: false',
      '- id: dsh-ray-assistant-memory-learning',
      '  name: "@dsh-ray/assistant-memory-learning"',
      '  disabled: false',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-memory-learning/desktop.sqlite')",
      '    authorityId: lark-memory-extract-desktop',
      `    owner: ${JSON.stringify(owner)}`,
      '    expiresAt: 1900000000000',
      '    maxExtractions: 300',
      '    maxPending: 64',
      '    lookbackMs: 604800000',
      '    policy: Extract explicit facts only.',
      '    maxInputBytes: 65536',
      '    maxOutputTokens: 2048',
      '    timeoutMs: 60000',
      '    budgetId: lark-memory-learning-desktop',
      '    budgetAmount: 1',
      '    scanBudgetId: lark-memory-scan-desktop',
      '    scanBudgetAmount: 1',
      '    reviewAuthorityId: lark-memory-review-desktop',
      '    reviewAuthorityDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '    adoptionAuthorityId: lark-memory-adopt-desktop',
      '    adoptionGrantDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '    workItemExperiences: false',
      '',
    ].join('\n'), 'utf8')

    const host = makeHost(dshHome, profileDir, 'desktop')
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))
    const status = baseStatus({
      dependencies: [
        { name: 'assistantPolicy', available: false },
        { name: 'assistantDelivery', available: false },
        { name: 'assistantSkills', available: true },
      ],
      bundles: [
        { name: '@dsh-ray/personal-assistant', installed: true, enabled: false, removable: true, rows: [{ rowId: 'dsh-ray-personal-assistant', moduleName: '@dsh-ray/personal-assistant' }] },
        { name: '@dsh-ray/assistant-verifier', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-verifier', moduleName: '@dsh-ray/assistant-verifier' }] },
        { name: '@dsh-ray/assistant-memory-learning', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-memory-learning', moduleName: '@dsh-ray/assistant-memory-learning' }] },
        { name: '@dsh-ray/lark-channel', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-lark-channel', moduleName: '@dsh-ray/lark-channel' }] },
      ],
      plugins: [
        { entryId: 'lark', moduleName: '@dsh-ray/lark-channel', enabled: true, fiberPhase: 'pending' },
      ],
    })

    // Calling repair with ONLY disabled-core-policy-provider must ALSO co-repair memory-learning-grant-conflict!
    const repaired = await applyDoctorRepair({
      host,
      status,
      descriptors: [],
      settings: undefined,
      manager: undefined,
      prober,
      issueIds: ['disabled-core-policy-provider'],
      platform: 'darwin',
      env: {},
      now: 2100,
    })
    expect(repaired.applied).toBe(true)
    expect(repaired.note).toContain('personal-assistant')
    expect(repaired.note).toContain('g2')

    const updatedRows = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, any> }>
    const paRow = updatedRows.find(r => r.id === 'dsh-ray-personal-assistant')!
    expect(paRow.disabled).toBeUndefined()
    const adoptCfg = paRow.config!['personalMemory']['automaticLearning'] as Record<string, unknown>
    const reviewCfg = updatedRows.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!['memoryReviews'] as Record<string, unknown>
    const memCfg = updatedRows.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config! as Record<string, unknown>

    // !!js databasePath MUST be resolved to a valid absolute path (never leaked as raw "dshHomePath(...)" string!)
    expect(String(memCfg['databasePath'])).not.toContain('dshHomePath(')
    expect(memCfg['databasePath']).toBe(join(canonicalHome, 'assistant-memory-learning', 'desktop.sqlite'))
    // workItemExperiences: false stripped on adoptCfg/reviewCfg, preserved on memCfg to match validateLearningConfig
    expect(Object.hasOwn(adoptCfg, 'workItemExperiences')).toBe(false)
    expect(Object.hasOwn(reviewCfg, 'workItemExperiences')).toBe(false)
    expect(memCfg['workItemExperiences']).toBe(false)
    expect(validateLearningConfig(memCfg as never).workItemExperiences).toBe(false)

    // All three configs pass real plugin schema validators!
    expect(() => validateMemoryReviewConfig(reviewCfg as never)).not.toThrow()
    expect(() => validateMemoryLearningAdoptionGrant(adoptCfg as never)).not.toThrow()
    expect(() => validateLearningConfig(memCfg as never)).not.toThrow()

    const after = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 2101 })
    expect(after.issues.some(i => i.id === 'memory-learning-grant-conflict')).toBe(false)
    expect(after.issues.some(i => i.id === 'disabled-core-policy-provider')).toBe(false)
  })

  it('detects and repairs assistant-memory-learning config_digest drift and verifier review conflicts in split layout', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const canonicalHome = realpathSync(dshHome)
    const owner = {
      authorityId: 'owner-lark-primary',
      authorityHash: '2222222222222222222222222222222222222222222222222222222222222222',
      principalId: 'lark/primary/personal/ou_split_owner',
      principalRecordId: 'principal_split_1',
      principalVersion: 1,
      workspace: join(canonicalHome, 'assistant-workspace'),
      agentPreset: 'standard',
    }
    const learningDbPath = join(canonicalHome, 'assistant-memory-learning', 'desktop.sqlite')
    mkdirSync(join(canonicalHome, 'assistant-memory-learning'), { recursive: true })
    const learningDb = new DatabaseSync(learningDbPath)
    try {
      learningDb.exec(`CREATE TABLE grant_record (authority_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, max_extractions INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT`)
      // Same authority_id and max_extractions, ONLY config_digest differs (e.g., model or policy edited in patch)
      learningDb.prepare(`INSERT INTO grant_record VALUES ('lark-memory-extract-desktop', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 300, 1)`).run()
    } finally {
      learningDb.close()
    }

    const verifierDir = join(canonicalHome, 'assistant-verifier')
    mkdirSync(verifierDir, { recursive: true })
    const reviewDb = new DatabaseSync(join(verifierDir, 'verification.sqlite.memory-reviews'))
    try {
      reviewDb.exec(`CREATE TABLE grants (authority TEXT PRIMARY KEY, digest TEXT NOT NULL, max INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0) STRICT`)
      reviewDb.prepare(`INSERT INTO grants VALUES ('lark-memory-review-desktop', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 300, 0)`).run()
    } finally {
      reviewDb.close()
    }

    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: {
        '@dsh-ray/assistant-policy': '0.1.78',
        '@dsh-ray/personal-memory': '0.1.78',
        '@dsh-ray/assistant-verifier': '0.1.78',
        '@dsh-ray/assistant-memory-learning': '0.1.78',
      },
      dsh: {
        profile: {
          bundles: [
            '@dsh-ray/assistant-policy',
            '@dsh-ray/personal-memory',
            '@dsh-ray/assistant-verifier',
            '@dsh-ray/assistant-memory-learning',
          ],
        },
      },
    }, null, 2), 'utf8')

    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-policy',
      '  name: "@dsh-ray/assistant-policy"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')",
      '    rules:',
      '      - &sharedRule',
      '        id: wizard-lark-mem-extract-desktop',
      '        effect: allow',
      '        actions: [extract]',
      '        resource: { kind: memory, id: "learning:lark-memory-extract-desktop" }',
      '      - id: wizard-lark-mem-review-desktop',
      '        effect: allow',
      '        actions: [review]',
      '        resource: { kind: memory, id: "learning:lark-memory-review-desktop" }',
      '      - id: wizard-lark-mem-adopt-desktop',
      '        effect: allow',
      '        actions: [adopt]',
      '        resource: { kind: memory, id: "learning:lark-memory-adopt-desktop" }',
      '    budgets: []',
      '- id: dsh-ray-personal-memory',
      '  name: "@dsh-ray/personal-memory"',
      '  config:',
      "    databasePath: !!js dshHomePath('personal-memory/memory.sqlite')",
      '    automaticLearning:',
      '      authorityId: lark-memory-adopt-desktop',
      `      owner: ${JSON.stringify(owner)}`,
      '      reviewAuthorityId: lark-memory-review-desktop',
      '      reviewAuthorityDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '      expiresAt: 1900000000000',
      '      maxMutations: 300',
      '      maxTotalContentBytes: 1048576',
      '      maxRecordTtlMs: 7776000000',
      '      kinds: [fact, experience]',
      '      operations: [add, replace, remove]',
      '- id: dsh-ray-assistant-verifier',
      '  name: "@dsh-ray/assistant-verifier"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-verifier/verification.sqlite')",
      '    memoryReviews:',
      '      authorityId: lark-memory-review-desktop',
      `      owner: ${JSON.stringify(owner)}`,
      '      expiresAt: 1900000000000',
      '      maxReviews: 300',
      '      policy: Independently verify owner statements.',
      '      maxInputBytes: 65536',
      '      maxOutputTokens: 2048',
      '      timeoutMs: 60000',
      '      model: { provider: super-relay, model: auto_model/alwaysday1 }',
      '- id: dsh-ray-assistant-memory-learning',
      '  name: "@dsh-ray/assistant-memory-learning"',
      '  disabled: false',
      '  config:',
      `    databasePath: ${learningDbPath}`,
      '    authorityId: lark-memory-extract-desktop',
      `    owner: ${JSON.stringify(owner)}`,
      '    expiresAt: 1900000000000',
      '    maxExtractions: 300',
      '    maxPending: 64',
      '    lookbackMs: 604800000',
      '    policy: Extract explicit facts only.',
      '    maxInputBytes: 65536',
      '    maxOutputTokens: 2048',
      '    timeoutMs: 60000',
      '    budgetId: lark-memory-learning-desktop',
      '    budgetAmount: 1',
      '    scanBudgetId: lark-memory-scan-desktop',
      '    scanBudgetAmount: 1',
      '    reviewAuthorityId: lark-memory-review-desktop',
      '    reviewAuthorityDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '    adoptionAuthorityId: lark-memory-adopt-desktop',
      '    adoptionGrantDigest: 0000000000000000000000000000000000000000000000000000000000000000',
      '    model: { provider: super-relay, model: auto_model/alwaysday1 }',
      '',
    ].join('\n'), 'utf8')

    const host = makeHost(dshHome, profileDir, 'desktop')
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))
    const status = baseStatus({
      bundles: [
        { name: '@dsh-ray/assistant-policy', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-policy', moduleName: '@dsh-ray/assistant-policy' }] },
        { name: '@dsh-ray/personal-memory', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-personal-memory', moduleName: '@dsh-ray/personal-memory' }] },
        { name: '@dsh-ray/assistant-verifier', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-verifier', moduleName: '@dsh-ray/assistant-verifier' }] },
        { name: '@dsh-ray/assistant-memory-learning', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-memory-learning', moduleName: '@dsh-ray/assistant-memory-learning' }] },
      ],
    })

    const before = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 2200 })
    const issue = before.issues.find(i => i.id === 'memory-learning-grant-conflict')
    expect(issue).toBeDefined()
    expect(issue!.detail).toContain('assistant-memory-learning')
    expect(issue!.detail).toContain('assistant-verifier')

    const repaired = await applyDoctorRepair({
      host,
      status,
      descriptors: [],
      settings: undefined,
      manager: undefined,
      prober,
      issueIds: ['memory-learning-grant-conflict'],
      platform: 'darwin',
      env: {},
      now: 2201,
    })
    expect(repaired.applied).toBe(true)

    const updatedRows = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJS() as Array<{ id: string; config?: Record<string, any> }>
    const splitMem = updatedRows.find(r => r.id === 'dsh-ray-personal-memory')!.config!
    const splitPol = updatedRows.find(r => r.id === 'dsh-ray-assistant-policy')!.config!
    const splitVer = updatedRows.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!
    const splitLearner = updatedRows.find(r => r.id === 'dsh-ray-assistant-memory-learning')!.config!

    expect(splitMem['automaticLearning']['authorityId']).toBe('lark-memory-adopt-desktop-g2')
    expect(splitVer['memoryReviews']['authorityId']).toBe('lark-memory-review-desktop-g2')
    expect(splitLearner['authorityId']).toBe('lark-memory-extract-desktop-g2')
    expect(splitLearner['databasePath']).toBe(join(canonicalHome, 'assistant-memory-learning', 'desktop-g2.sqlite'))
    expect((splitPol['rules'] as Array<{ id: string; resource: { id: string } }>).find(r => r.id === 'wizard-lark-mem-extract-desktop')?.resource.id).toBe('learning:lark-memory-extract-desktop-g2')
    expect(() => validateMemoryReviewConfig(splitVer['memoryReviews'])).not.toThrow()
    expect(() => validateMemoryLearningAdoptionGrant(splitMem['automaticLearning'])).not.toThrow()
    expect(() => validateLearningConfig(splitLearner)).not.toThrow()

    const after = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 2202 })
    expect(after.issues.some(i => i.id === 'memory-learning-grant-conflict')).toBe(false)
  })

  it('detects active linked Lark ingress account blocking long-term memory, keeps bulk auto-repair hands-off, and promotes on explicit confirmation', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    const canonicalHome = realpathSync(dshHome)
    const dbPath = join(canonicalHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(dbPath, false)

    const oldPrincipal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_old_owner_1' }
    const oldJson = JSON.stringify(oldPrincipal)
    const oldHash = createHash('sha256').update(oldJson, 'utf8').digest('hex')
    const newPrincipal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new_linked_2' }
    const newJson = JSON.stringify(newPrincipal)
    const newHash = createHash('sha256').update(newJson, 'utf8').digest('hex')
    const newConv = { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_new_dm_2' }

    const rwDb = new DatabaseSync(dbPath)
    try {
      rwDb.prepare(
        `INSERT INTO delivery_principals VALUES (?, ?, ?, 'owner', 'active', NULL, 100, 100, 1)`,
      ).run('principal_old_1', oldHash, oldJson)
      rwDb.prepare(
        `INSERT INTO delivery_principals VALUES (?, ?, ?, 'linked', 'active', 'principal_old_1', 200, 200, 1)`,
      ).run('principal_linked_2', newHash, newJson)
      rwDb.prepare(
        `INSERT INTO conversation_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'owner-dm', 'active', 200, 200, 1)`,
      ).run(
        'binding_linked_2',
        createHash('sha256').update(JSON.stringify(newConv), 'utf8').digest('hex'),
        JSON.stringify(newConv),
        'principal_linked_2',
        newJson,
        join(canonicalHome, 'assistant-workspace'),
        'standard',
        'delivery-new-dm-session-2',
      )
    } finally {
      rwDb.close()
    }

    const oldKey = 'lark/primary/personal/ou_old_owner_1'
    const newKey = 'lark/primary/personal/ou_new_linked_2'
    const syntheticAppId = ['cli', 'aabbccddeeff0011'].join('_')
    writeFileSync(patchPath, [
      '- id: dsh-ray-personal-assistant',
      '  name: "@dsh-ray/personal-assistant"',
      '  config:',
      '    assistantPolicy:',
      `      databasePath: ${join(canonicalHome, 'assistant-policy', 'policy.sqlite')}`,
      '      rules:',
      '        - id: lark-owner-ingress-primary',
      '          effect: allow',
      '          subject:',
      '            kind: external',
      `            id: ${newKey}`,
      '          actions: [approval.decide, ingest]',
      '          resource: { kind: message, id: "*" }',
      '          context: { initiators: [external] }',
      '      budgets: []',
      '- id: dsh-ray-assistant-delivery',
      '  name: "@dsh-ray/assistant-delivery"',
      '  config:',
      `    databasePath: ${dbPath}`,
      `    spoolPath: ${join(canonicalHome, 'assistant-delivery', 'spool')}`,
      `    defaultWorkspace: ${join(canonicalHome, 'assistant-workspace')}`,
      '    defaultAgentPreset: standard',
      '    ownerRoutes:',
      '      - id: owner-lark-primary',
      '        conversation: { channel: lark, account: primary, tenant: personal, kind: dm, chat: oc_old_dm_1 }',
      `        principal: ${JSON.stringify(oldPrincipal)}`,
      `        workspace: ${join(canonicalHome, 'assistant-workspace')}`,
      '        agentPreset: standard',
      '        policyRef: owner-dm',
      '        minimumGeneration: 3',
      '- id: dsh-ray-lark-channel',
      '  name: "@dsh-ray/lark-channel"',
      '  config:',
      '    enabled: true',
      `    appId: ${syntheticAppId}`,
      '    account: primary',
      '    tenant: personal',
      '',
    ].join('\n'), 'utf8')

    const host = makeHost(canonicalHome, profileDir, 'desktop')
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))
    const status = baseStatus({
      bundles: [
        { name: '@dsh-ray/personal-assistant', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-personal-assistant', moduleName: '@dsh-ray/personal-assistant' }] },
        { name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] },
        { name: '@dsh-ray/lark-channel', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-lark-channel', moduleName: '@dsh-ray/lark-channel' }] },
      ],
    })

    const before = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 3000 })
    const linkedIssue = before.issues.find(i => i.id === 'lark-linked-not-primary-owner')
    expect(linkedIssue).toBeDefined()
    expect(linkedIssue!.autoFixable).toBe(false)
    expect(linkedIssue!.detail).toContain(oldKey)
    expect(linkedIssue!.detail).toContain('无已认证的 owner 命名空间')

    // Bulk applyDoctorRepair([]) MUST NOT silently replace primary owner!
    await applyDoctorRepair({
      host, status, descriptors: [], settings: undefined, manager: undefined, prober,
      issueIds: [], platform: 'darwin', env: {}, now: 3001,
    })
    const stillLinked = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 3002 })
    expect(stillLinked.issues.some(i => i.id === 'lark-linked-not-primary-owner')).toBe(true)

    // Explicit targeted applyDoctorRepair(['lark-linked-not-primary-owner']) promotes linked user to owner and syncs ownerRoutes
    const promoted = await applyDoctorRepair({
      host, status, descriptors: [], settings: undefined, manager: undefined, prober,
      issueIds: ['lark-linked-not-primary-owner'], platform: 'darwin', env: {}, now: 3003,
    })
    expect(promoted.applied).toBe(true)
    expect(promoted.note).toContain('ou_new_linked_2')

    const roDb = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const newRow = roDb.prepare(`SELECT role, status, linked_to_id FROM delivery_principals WHERE id = 'principal_linked_2'`).get() as { role: string; status: string; linked_to_id: string | null }
      const oldRow = roDb.prepare(`SELECT status FROM delivery_principals WHERE id = 'principal_old_1'`).get() as { status: string }
      expect(newRow).toEqual({ role: 'owner', status: 'active', linked_to_id: null })
      expect(oldRow).toEqual({ status: 'revoked' })
    } finally {
      roDb.close()
    }

    const updatedRows = parseDocument(readFileSync(patchPath, 'utf8'), JS_PARSE_TAG).toJS() as Array<{ id: string; config?: Record<string, any> }>
    const deliveryCfg = updatedRows.find(r => r.id === 'dsh-ray-assistant-delivery')!.config!
    expect(deliveryCfg['ownerRoutes'][0]['principal']['user']).toBe('ou_new_linked_2')

    const after = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'darwin', env: {}, now: 3004 })
    expect(after.issues.some(i => i.id === 'lark-linked-not-primary-owner')).toBe(false)
  })

  it('validates assistant-isolation backend against platform across Linux, macOS, Windows, and unsupported OSes', async () => {
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))

    const runCase = async (platform: NodeJS.Platform, backend?: string) => {
      const { dshHome, profileDir, patchPath } = makeTempHome()
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: 'profile-desktop',
        bundles: { '@dsh-ray/assistant-isolation': true },
      }, null, 2))
      const patchLines = [
        '- id: dsh-ray-assistant-isolation',
        "  name: '@dsh-ray/assistant-isolation'",
        ...(backend === undefined ? [] : ['  config:', `    backend: ${JSON.stringify(backend)}`]),
      ]
      writeFileSync(patchPath, `${patchLines.join('\n')}\n`, 'utf8')
      const status = baseStatus({
        bundles: [
          { name: '@dsh-ray/assistant-isolation', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-isolation', moduleName: '@dsh-ray/assistant-isolation' }] },
        ],
      })
      const host = makeHost(dshHome, profileDir, 'desktop')
      const report = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform, env: {} })
      return { host, status, report }
    }

    for (const [platform, backend] of [
      ['darwin', 'auto'],
      ['darwin', undefined],
      ['darwin', 'macos-seatbelt'],
      ['win32', 'auto'],
      ['win32', undefined],
      ['win32', 'windows-job'],
    ] as const) {
      const { report } = await runCase(platform, backend)
      expect(report.issues.some(i => i.id === 'unsupported-platform-isolation')).toBe(false)
    }

    for (const [platform, backend] of [
      ['linux', 'macos-seatbelt'],
      ['linux', ' auto '],
      ['win32', 'linux-native'],
      ['freebsd', 'auto'],
    ] as const) {
      const { host, status, report } = await runCase(platform, backend)
      expect(report.issues.some(i => i.id === 'unsupported-platform-isolation')).toBe(true)

      const toggledOff: string[] = []
      const manager = {
        setBundleEnabled: vi.fn(async (pkg: string, enabled: boolean) => {
          if (!enabled) toggledOff.push(pkg)
          return { changed: true, application: 'restart-required', target: pkg }
        }),
      } as unknown as PluginManagerService
      const repair = await applyDoctorRepair({
        host, status, descriptors: [], settings: undefined, manager, prober,
        issueIds: ['unsupported-platform-isolation'], platform, env: {}, now: 12345,
      })
      expect(repair.applied).toBe(true)
      expect(toggledOff).toContain('@dsh-ray/assistant-isolation')
    }
  })

  it('detects and repairs verifier requireAcceptance: true with empty profiles in patch row and descriptor-only without dropping databasePath or memoryReviews', async () => {
    const prober = new CodingToolProber(async () => ({ stdout: '', stderr: '', exitCode: 1, errorCode: 'ENOENT' }))

    // Case 1: issue present in cordis.patch.yml row
    {
      const { dshHome, profileDir, patchPath } = makeTempHome()
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: '@dsh-profile/desktop',
        bundles: { '@dsh-ray/assistant-verifier': true },
      }, null, 2))
      writeFileSync(patchPath, [
        '- id: dsh-ray-assistant-verifier',
        "  name: '@dsh-ray/assistant-verifier'",
        '  config:',
        "    databasePath: !!js dshHomePath('assistant-verifier/verification.sqlite')",
        '    profiles: []',
        '    requireAcceptance: true',
        '    memoryReviews:',
        '      authorityId: mem-rev-desktop',
        '      maxReviews: 200',
        '',
      ].join('\n'), 'utf8')
      const host = makeHost(dshHome, profileDir, 'desktop')
      const status = baseStatus({
        bundles: [
          { name: '@dsh-ray/assistant-verifier', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-verifier', moduleName: '@dsh-ray/assistant-verifier' }] },
        ],
      })
      const before = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'linux', env: {}, now: 100 })
      expect(before.issues.some(i => i.id === 'verifier-require-acceptance-without-profiles')).toBe(true)

      const repaired = await applyDoctorRepair({
        host, status, descriptors: [], settings: undefined, manager: undefined, prober,
        issueIds: ['verifier-require-acceptance-without-profiles'], platform: 'linux', env: {}, now: 101,
      })
      expect(repaired.applied).toBe(true)

      const repairedRaw = readFileSync(patchPath, 'utf8')
      expect(repairedRaw).toContain("!!js dshHomePath('assistant-verifier/verification.sqlite')")
      const rows = parseDocument(repairedRaw, JS_PARSE_TAG).toJS() as Array<{ id: string; config?: Record<string, unknown> }>
      const verifierCfg = rows.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!
      expect(verifierCfg['requireAcceptance']).toBe(false)
      expect(verifierCfg['databasePath']).toBe("dshHomePath('assistant-verifier/verification.sqlite')")
      expect(verifierCfg['memoryReviews']).toEqual({ authorityId: 'mem-rev-desktop', maxReviews: 200 })

      const after = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'linux', env: {}, now: 102 })
      expect(after.issues.some(i => i.id === 'verifier-require-acceptance-without-profiles')).toBe(false)
    }

    // Case 2: descriptor-only (no patch row yet), preserving databasePath !!js dshHomePath(...) and memoryReviews
    {
      const { dshHome, profileDir, patchPath } = makeTempHome()
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: '@dsh-profile/desktop',
        bundles: { '@dsh-ray/assistant-verifier': true },
      }, null, 2))
      writeFileSync(patchPath, '[]\n', 'utf8')
      const host = makeHost(dshHome, profileDir, 'desktop')
      const status = baseStatus({
        bundles: [
          { name: '@dsh-ray/assistant-verifier', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-verifier', moduleName: '@dsh-ray/assistant-verifier' }] },
        ],
      })
      const descriptors: SettingsDescriptor[] = [{
        ns: 'dsh-ray-assistant-verifier',
        schema: {},
        value: {
          requireAcceptance: true,
          profiles: [],
          memoryReviews: { authorityId: 'mem-rev-desc', maxReviews: 100 },
        },
        revision: 1,
        applies: 'live',
      }]
      const before = await inspectSetupDoctor({ host, status, descriptors, prober, platform: 'linux', env: {}, now: 200 })
      expect(before.issues.some(i => i.id === 'verifier-require-acceptance-without-profiles')).toBe(true)

      const repaired = await applyDoctorRepair({
        host, status, descriptors, settings: undefined, manager: undefined, prober,
        issueIds: ['verifier-require-acceptance-without-profiles'], platform: 'linux', env: {}, now: 201,
      })
      expect(repaired.applied).toBe(true)

      const repairedRaw = readFileSync(patchPath, 'utf8')
      expect(repairedRaw).toContain("!!js dshHomePath('assistant-verifier/verification.sqlite')")
      const rows = parseDocument(repairedRaw, JS_PARSE_TAG).toJS() as Array<{ id: string; config?: Record<string, unknown> }>
      const verifierCfg = rows.find(r => r.id === 'dsh-ray-assistant-verifier')!.config!
      expect(verifierCfg['requireAcceptance']).toBe(false)
      expect(verifierCfg['databasePath']).toBe("dshHomePath('assistant-verifier/verification.sqlite')")
      expect(verifierCfg['memoryReviews']).toEqual({ authorityId: 'mem-rev-desc', maxReviews: 100 })

      const after = await inspectSetupDoctor({ host, status, descriptors, prober, platform: 'linux', env: {}, now: 202 })
      expect(after.issues.some(i => i.id === 'verifier-require-acceptance-without-profiles')).toBe(false)
    }

    // Case 3: non-empty profiles with requireAcceptance: true must NOT be flagged
    {
      const { dshHome, profileDir, patchPath } = makeTempHome()
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
        name: '@dsh-profile/desktop',
        bundles: { '@dsh-ray/assistant-verifier': true },
      }, null, 2))
      writeFileSync(patchPath, [
        '- id: dsh-ray-assistant-verifier',
        "  name: '@dsh-ray/assistant-verifier'",
        '  config:',
        "    databasePath: !!js dshHomePath('assistant-verifier/verification.sqlite')",
        '    profiles:',
        '      - id: configured-profile',
        '    requireAcceptance: true',
        '',
      ].join('\n'), 'utf8')
      const host = makeHost(dshHome, profileDir, 'desktop')
      const status = baseStatus({
        bundles: [
          { name: '@dsh-ray/assistant-verifier', installed: true, enabled: true, removable: true, rows: [{ rowId: 'dsh-ray-assistant-verifier', moduleName: '@dsh-ray/assistant-verifier' }] },
        ],
      })
      const report = await inspectSetupDoctor({ host, status, descriptors: [], prober, platform: 'linux', env: {}, now: 300 })
      expect(report.issues.some(i => i.id === 'verifier-require-acceptance-without-profiles')).toBe(false)
    }
  })
})
