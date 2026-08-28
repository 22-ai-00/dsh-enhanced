import { describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as lark from '../src/index.ts'

const directMessage = {
  messageId: 'om_1',
  chatId: 'oc_1',
  chatType: 'p2p' as const,
  senderId: 'ou_owner',
  content: 'DSH-CONNECT-A1B2C3D4',
  rawContentType: 'text',
  resources: [],
  mentionAll: false,
  mentionedBot: false,
  createTime: Date.now(),
}

function effectiveDeliveryProfile(databasePath: string): string {
  return `
- id: dsh-enhanced-assistant-delivery
  name: '@dsh-enhanced/assistant-delivery'
  config:
    databasePath: ${JSON.stringify(databasePath)}
`
}

function effectiveLarkDeliveryProfile(databasePath: string): string {
  return `${effectiveDeliveryProfile(databasePath)}
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config:
    enabled: true
    account: primary
    tenant: personal
`
}

function asEffectiveProfile(profilePatch: string): string {
  const rows = [
    ['dsh-enhanced-personal-assistant', '@dsh-enhanced/personal-assistant'],
    ['dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery'],
    ['dsh-enhanced-credentials-keychain', '@dsh-enhanced/credentials-keychain'],
    ['dsh-enhanced-lark-channel', '@dsh-enhanced/lark-channel'],
  ] as const
  let effective = profilePatch
  for (const [id, name] of rows) {
    effective = effective.replace(
      new RegExp(`(^- id: ${id}\\n)(?!  name:)`, 'mu'),
      `$1  name: '${name}'\n`,
    )
  }
  return effective
}

function baseAssistantProfile(dshHome: string, databasePath: string): string {
  return `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy:
      databasePath: ${JSON.stringify(join(dshHome, 'assistant-policy/policy.sqlite'))}
      rules: []
    personalMemory:
      databasePath: ${JSON.stringify(join(dshHome, 'personal-memory/memory.sqlite'))}
    personalWiki:
      vaultRoot: ${JSON.stringify(join(dshHome, 'personal-wiki/vault'))}
      databasePath: ${JSON.stringify(join(dshHome, 'personal-wiki/state.sqlite'))}
    assistantAutomations:
      databasePath: ${JSON.stringify(join(dshHome, 'assistant-automations/state.sqlite'))}
      runsPath: ${JSON.stringify(join(dshHome, 'assistant-automations/runs'))}
- id: dsh-enhanced-assistant-delivery
  config:
    databasePath: ${JSON.stringify(databasePath)}
    spoolPath: ${JSON.stringify(join(dshHome, 'assistant-delivery/spool'))}
    defaultWorkspace: ${JSON.stringify(join(dshHome, 'assistant-workspace'))}
    defaultAgentPreset: standard
`
}

function configuredLarkProfile(input: {
  dshHome: string
  databasePath: string
  ownerUserId?: string
  profile?: string
  version?: string
  agentTools?: 'disable' | 'enable'
  credentialProvider?: 'macos-keychain' | 'linux-secret-service'
}): string {
  const profile = input.profile ?? 'web'
  const version = input.version ?? '22222222222222222222222222222222'
  return lark.configureLarkProfilePatch({
    profilePatch: baseAssistantProfile(input.dshHome, input.databasePath),
    dshHome: input.dshHome,
    appId: 'cli_0123456789abcdef',
    account: 'primary',
    tenant: 'personal',
    domain: 'feishu',
    ownerUserId: input.ownerUserId ?? 'ou_new',
    keychainService: `dsh/lark/${profile}/primary/versions/${version}`,
    keychainAccount: 'primary',
    credentialProvider: input.credentialProvider ?? 'macos-keychain',
    agentTools: input.agentTools ?? 'disable',
  })
}

function inheritedLarkEffectiveProfile(input: {
  profilePatch: string
  dshHome: string
  ownerUserId?: string
}): string {
  return asEffectiveProfile(lark.configureLarkProfilePatch({
    profilePatch: input.profilePatch,
    dshHome: input.dshHome,
    appId: 'cli_0123456789abcdef',
    account: 'primary',
    tenant: 'personal',
    domain: 'feishu',
    ownerUserId: input.ownerUserId ?? 'ou_owner',
    keychainService: 'dsh/lark/web/primary/versions/22222222222222222222222222222222',
    keychainAccount: 'primary',
    credentialProvider: 'macos-keychain',
    agentTools: 'preserve',
  }))
}

describe('Lark onboarding wizard inputs', () => {
  test('serializes the complete profile setup transaction with a crash-safe SQLite lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-setup-lock-'))
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const { withProfileSetupLock } = await import('../src/setup.ts')
    const events: string[] = []
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const entered = new Promise<void>(resolve => { firstEntered = resolve })
    const hold = new Promise<void>(resolve => { releaseFirst = resolve })

    const first = withProfileSetupLock(patchPath, async () => {
      events.push('first-enter')
      firstEntered()
      await hold
      events.push('first-exit')
    }, { timeoutMs: 1_000, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 })
    await entered
    let secondEntered = false
    const second = withProfileSetupLock(patchPath, async () => {
      secondEntered = true
      events.push('second-enter')
    }, { timeoutMs: 1_000, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 })

    await new Promise(resolve => setTimeout(resolve, 25))
    expect(secondEntered).toBe(false)
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter'])
  })

  test('bounds profile lock contention instead of composing from a stale snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-setup-lock-timeout-'))
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const { withProfileSetupLock } = await import('../src/setup.ts')
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const entered = new Promise<void>(resolve => { firstEntered = resolve })
    const hold = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = withProfileSetupLock(patchPath, async () => {
      firstEntered()
      await hold
    }, { timeoutMs: 1_000, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 })
    await entered
    try {
      await expect(withProfileSetupLock(patchPath, async () => {}, {
        timeoutMs: 30,
        pollMs: 5,
        staleMs: 2_000,
        heartbeatMs: 100,
      })).rejects.toThrow(/another setup.*profile/iu)
    } finally {
      releaseFirst()
      await first
    }
  })

  test('recovers the setup lock immediately after its holder is killed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-killed-sqlite-lock-'))
    const patchPath = join(root, 'cordis.patch.yml')
    const lockPath = `${patchPath}.lark-setup-lock.sqlite`
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { DatabaseSync } from 'node:sqlite'
const database = new DatabaseSync(process.argv[1])
database.exec('BEGIN IMMEDIATE')
process.stdout.write('ready\\n')
setInterval(() => {}, 1000)`,
      lockPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.once('data', () => resolve())
      child.once('exit', code => {
        if (code !== null) reject(new Error(`lock holder exited before readiness: ${code}`))
      })
    })
    child.kill('SIGKILL')
    await new Promise<void>(resolve => child.once('exit', () => resolve()))
    const { withProfileSetupLock } = await import('../src/setup.ts')
    let ran = false

    await withProfileSetupLock(patchPath, async () => { ran = true }, {
      timeoutMs: 1_000,
      pollMs: 5,
      staleMs: 100,
      heartbeatMs: 10,
    })

    expect(ran).toBe(true)
  })

  test('recovers a hard crash after candidate rename by rolling back before the next setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-candidate-crash-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const originalPatch = 'original-profile\n'
    const updatedPatch = 'candidate-profile\n'
    await writeFile(patchPath, originalPatch, 'utf8')
    const setupModule = await import('../src/setup.ts') as Record<string, unknown>
    const createLocator = setupModule.createVersionedCredentialLocator as (
      input: Record<string, unknown>,
    ) => unknown
    const persistJournal = setupModule.persistLarkSetupJournal as (input: Record<string, unknown>) => Promise<void>
    const recoverJournal = setupModule.recoverLarkSetupJournal as (input: Record<string, unknown>) => Promise<void>
    expect(persistJournal).toBeTypeOf('function')
    expect(recoverJournal).toBeTypeOf('function')
    const staged = createLocator({
      provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
      version: '22222222222222222222222222222222',
    })
    const removed: unknown[] = []
    let pairCalls = 0
    await persistJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'full',
      phase: 'candidate',
      originalPatch,
      updatedPatch,
      databasePath: join(dshHome, 'assistant-delivery/state.sqlite'),
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      stagedCredential: staged,
      installService: false,
    })
    // Exact durable state left when the process is killed after rename and
    // before profile validation / Delivery handoff.
    await writeFile(patchPath, updatedPatch, 'utf8')

    await recoverJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        pairPrincipal() { pairCalls += 1 },
        removeCredential(locator: unknown) { removed.push(locator) },
      },
    })

    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    expect(pairCalls).toBe(0)
    expect(removed).toEqual([staged])
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each(['before-handoff', 'after-handoff'] as const)(
    'recovers a validated hard crash %s by idempotently converging profile and owner',
    async crashPoint => {
      const root = await mkdtemp(join(tmpdir(), 'lark-validated-crash-'))
      const dshHome = join(root, 'dsh-home')
      const profileDirectory = join(dshHome, 'profiles', 'web')
      await mkdir(profileDirectory, { recursive: true })
      const patchPath = join(profileDirectory, 'cordis.patch.yml')
      const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
      const originalPatch = baseAssistantProfile(dshHome, databasePath)
      const updatedPatch = configuredLarkProfile({ dshHome, databasePath })
      await writeFile(patchPath, updatedPatch, 'utf8')
      const setupModule = await import('../src/setup.ts') as Record<string, unknown>
      const createLocator = setupModule.createVersionedCredentialLocator as (
        input: Record<string, unknown>,
      ) => unknown
      const persistJournal = setupModule.persistLarkSetupJournal as (input: Record<string, unknown>) => Promise<void>
      const recoverJournal = setupModule.recoverLarkSetupJournal as (input: Record<string, unknown>) => Promise<void>
      const previous = createLocator({
        provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
        version: '11111111111111111111111111111111',
      })
      const staged = createLocator({
        provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
        version: '22222222222222222222222222222222',
      })
      const target = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' }
      let deliveryOwner = crashPoint === 'after-handoff' ? 'ou_new' : 'ou_old'
      const removed: unknown[] = []
      let installCalls = 0
      await persistJournal({
        patchPath,
        dshHome,
        profile: 'web',
        operation: 'full',
        phase: 'validated',
        originalPatch,
        updatedPatch,
        databasePath,
        principal: target,
        stagedCredential: staged,
        previousCredential: previous,
        installService: true,
      })

      await recoverJournal({
        patchPath,
        dshHome,
        profile: 'web',
        profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
        operations: {
          readEffectiveProfile() {
            return asEffectiveProfile(updatedPatch)
          },
          pairPrincipal(input: { principal: { user: string } }) { deliveryOwner = input.principal.user },
          removeCredential(locator: unknown) { removed.push(locator) },
          installService() { installCalls += 1 },
        },
      })

      expect(await readFile(patchPath, 'utf8')).toBe(updatedPatch)
      expect(deliveryOwner).toBe('ou_new')
      expect(removed).toEqual([previous])
      expect(removed).not.toContainEqual(staged)
      expect(installCalls).toBe(1)
      await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test('refuses validated recovery when the effective Delivery database drifted from the journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-recovery-database-drift-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const originalPatch = 'original-profile\n'
    const updatedPatch = 'candidate-profile\n'
    const journalDatabasePath = join(dshHome, 'delivery-a.sqlite')
    const effectiveDatabasePath = join(dshHome, 'delivery-b.sqlite')
    await writeFile(patchPath, updatedPatch, 'utf8')
    const { createVersionedCredentialLocator, persistLarkSetupJournal, recoverLarkSetupJournal } =
      await import('../src/setup.ts')
    const staged = createVersionedCredentialLocator({
      provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
      version: '22222222222222222222222222222222',
    })
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'full',
      phase: 'validated',
      originalPatch,
      updatedPatch,
      databasePath: journalDatabasePath,
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      stagedCredential: staged,
      installService: false,
    })
    let pairCalls = 0

    await expect(recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() { return effectiveDeliveryProfile(effectiveDatabasePath) },
        pairPrincipal() { pairCalls += 1 },
        removeCredential() {},
      },
    })).rejects.toThrow(/effective assistant-delivery database changed.*journal/iu)

    expect(pairCalls).toBe(0)
    expect(await readFile(patchPath, 'utf8')).toBe(updatedPatch)
    expect(JSON.parse(await readFile(`${patchPath}.lark-setup.journal.json`, 'utf8')))
      .toMatchObject({ phase: 'validated', databasePath: journalDatabasePath })
  })

  test('refuses validated recovery when effective Lark no longer represents the journal owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-recovery-owner-drift-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databasePath)
    const stagedService = 'dsh/lark/web/primary/versions/22222222222222222222222222222222'
    const updatedPatch = lark.configureLarkProfilePatch({
      profilePatch: originalPatch,
      dshHome,
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_new',
      keychainService: stagedService,
      keychainAccount: 'primary',
      credentialProvider: 'macos-keychain',
      agentTools: 'disable',
    })
    const disabledEffectiveProfile = asEffectiveProfile(updatedPatch).replace('enabled: true', 'enabled: false')
    await writeFile(patchPath, updatedPatch, 'utf8')
    const { createVersionedCredentialLocator, persistLarkSetupJournal, recoverLarkSetupJournal } =
      await import('../src/setup.ts')
    const staged = createVersionedCredentialLocator({
      provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
      version: '22222222222222222222222222222222',
    })
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'full',
      phase: 'validated',
      originalPatch,
      updatedPatch,
      databasePath,
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      stagedCredential: staged,
      installService: false,
    })
    let pairCalls = 0

    await expect(recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() { return disabledEffectiveProfile },
        pairPrincipal() { pairCalls += 1 },
        removeCredential() {},
      },
    })).rejects.toThrow(/effective Lark.*journal owner/iu)

    expect(pairCalls).toBe(0)
    expect(await readFile(patchPath, 'utf8')).toBe(updatedPatch)
    expect(JSON.parse(await readFile(`${patchPath}.lark-setup.journal.json`, 'utf8')))
      .toMatchObject({ phase: 'validated', databasePath })
  })

  test('rolls back before pairing when the effective Delivery database changes during validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-validation-database-drift-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databaseA = join(dshHome, 'delivery-a.sqlite')
    const databaseB = join(dshHome, 'delivery-b.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databaseA)
    await writeFile(patchPath, originalPatch, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let reads = 0
    let pairCalls = 0
    const removed: unknown[] = []

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() {
          reads += 1
          return effectiveDeliveryProfile(reads === 1 ? databaseA : databaseB)
        },
        storeCredential() {},
        readCredential() { return 'secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' }
        },
        validateProfile() {},
        pairPrincipal() { pairCalls += 1 },
        removeCredential(locator) { removed.push(locator) },
      },
    })).rejects.toThrow(/effective assistant-delivery database changed during validation/iu)

    expect(pairCalls).toBe(0)
    expect(removed).toHaveLength(1)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([
    'wrong-lark-package',
    'disabled-credentials-package',
    'wrong-credentials-package',
    'missing-enabled-agent-rule',
  ] as const)('rolls back before pairing when effective validation has %s', async drift => {
    const root = await mkdtemp(join(tmpdir(), 'lark-effective-binding-drift-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databasePath)
    await writeFile(patchPath, originalPatch, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--allow-agent-tools',
    ])
    let pairCalls = 0
    const removed: unknown[] = []

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() {
          const current = readFileSync(patchPath, 'utf8')
          let effective = asEffectiveProfile(current)
          if (!current.includes('dsh-enhanced-lark-channel')) return effective
          if (drift === 'wrong-lark-package') {
            effective = effective.replace("name: '@dsh-enhanced/lark-channel'", "name: '@example/other-lark'")
          } else if (drift === 'disabled-credentials-package') {
            effective = effective.replace(
              "- id: dsh-enhanced-credentials-keychain\n  name: '@dsh-enhanced/credentials-keychain'",
              "- id: dsh-enhanced-credentials-keychain\n  name: '@dsh-enhanced/credentials-keychain'\n  disabled: true",
            )
          } else if (drift === 'wrong-credentials-package') {
            effective = effective.replace(
              "name: '@dsh-enhanced/credentials-keychain'",
              "name: '@example/shared-credentials'",
            )
          } else {
            effective = effective.replace('id: lark-owner-tool-*-primary', 'id: removed-owner-tool-primary')
          }
          return effective
        },
        storeCredential() {},
        readCredential() { return 'secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' }
        },
        validateProfile() {},
        pairPrincipal() { pairCalls += 1 },
        removeCredential(locator) { removed.push(locator) },
      },
    })).rejects.toThrow(/effective (?:Lark binding|Agent policy)/iu)

    expect(pairCalls).toBe(0)
    expect(removed).toHaveLength(1)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('treats an absent staged credential as an idempotent staging recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-staging-before-store-crash-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const { createVersionedCredentialLocator, persistLarkSetupJournal, recoverLarkSetupJournal } =
      await import('../src/setup.ts')
    const staged = createVersionedCredentialLocator({
      provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
      version: '22222222222222222222222222222222',
    })
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'full',
      phase: 'staging',
      originalPatch: 'original-profile\n',
      databasePath: join(dshHome, 'assistant-delivery/state.sqlite'),
      account: 'primary',
      stagedCredential: staged,
      installService: false,
    })

    await recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        removeCredential() {
          throw Object.assign(new Error('credential is already absent'), { code: 'not-found' })
        },
      },
    })

    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('does not block paired recovery when the previous credential was already retired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-paired-after-delete-crash-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databasePath)
    const updatedPatch = configuredLarkProfile({ dshHome, databasePath })
    await writeFile(patchPath, updatedPatch, 'utf8')
    const { createVersionedCredentialLocator, persistLarkSetupJournal, recoverLarkSetupJournal } =
      await import('../src/setup.ts')
    const previous = createVersionedCredentialLocator({
      provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
      version: '11111111111111111111111111111111',
    })
    const staged = createVersionedCredentialLocator({
      provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
      version: '22222222222222222222222222222222',
    })
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'full',
      phase: 'paired',
      originalPatch,
      updatedPatch,
      databasePath,
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      stagedCredential: staged,
      previousCredential: previous,
      installService: false,
    })
    let pairCalls = 0

    await recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() {
          return asEffectiveProfile(updatedPatch)
        },
        pairPrincipal() { pairCalls += 1 },
        removeCredential() {
          throw Object.assign(new Error('credential is already absent'), { code: 'not-found' })
        },
      },
    })

    expect(pairCalls).toBe(1)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps a paired journal and retries pending previous credential cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-paired-pending-cleanup-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databasePath)
    const updatedPatch = configuredLarkProfile({
      dshHome, databasePath, credentialProvider: 'linux-secret-service',
    })
    await writeFile(patchPath, updatedPatch, 'utf8')
    const { createVersionedCredentialLocator, persistLarkSetupJournal, recoverLarkSetupJournal } =
      await import('../src/setup.ts')
    const previous = createVersionedCredentialLocator({
      provider: 'linux-secret-service', dshHome, profile: 'web', account: 'primary',
      version: '11111111111111111111111111111111',
    })
    const staged = createVersionedCredentialLocator({
      provider: 'linux-secret-service', dshHome, profile: 'web', account: 'primary',
      version: '22222222222222222222222222222222',
    })
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'full',
      phase: 'paired',
      originalPatch,
      updatedPatch,
      databasePath,
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      stagedCredential: staged,
      previousCredential: previous,
      installService: true,
    })
    const lockOptions = { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 }
    let pairCalls = 0
    let removeCalls = 0
    let installCalls = 0
    const operations = {
      readEffectiveProfile() {
        return asEffectiveProfile(updatedPatch)
      },
      pairPrincipal() { pairCalls += 1 },
      removeCredential(locator: unknown) {
        expect(locator).toEqual(previous)
        removeCalls += 1
        if (removeCalls === 1) throw new Error('Secret Service temporarily unavailable')
      },
      installService() { installCalls += 1 },
    }

    await expect(recoverLarkSetupJournal({
      patchPath, dshHome, profile: 'web', profileLockOptions: lockOptions, operations,
    })).rejects.toThrow(/profile and owner were committed.*cleanup is pending/iu)

    expect(await readFile(patchPath, 'utf8')).toBe(updatedPatch)
    expect(JSON.parse(await readFile(`${patchPath}.lark-setup.journal.json`, 'utf8')))
      .toMatchObject({ phase: 'paired', previousCredential: previous })
    expect(pairCalls).toBe(1)
    expect(removeCalls).toBe(1)
    expect(installCalls).toBe(0)

    await recoverLarkSetupJournal({
      patchPath, dshHome, profile: 'web', profileLockOptions: lockOptions, operations,
    })

    expect(pairCalls).toBe(2)
    expect(removeCalls).toBe(2)
    expect(installCalls).toBe(1)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps rollback direction after owner handoff fails and staged cleanup is interrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-handoff-aborting-crash-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const seed = baseAssistantProfile(dshHome, join(dshHome, 'assistant-delivery/state.sqlite'))
    const originalPatch = lark.configureLarkProfilePatch({
      profilePatch: seed,
      dshHome,
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_original',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      credentialProvider: 'macos-keychain',
      agentTools: 'disable',
    })
    await writeFile(patchPath, originalPatch, 'utf8')
    const { executeLarkSetupProfileTransaction, recoverLarkSetupJournal } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let stagedWasDeleted = false

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() {
          return asEffectiveProfile(readFileSync(patchPath, 'utf8'))
        },
        storeCredential() {},
        readCredential() { return 'staged-secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' }
        },
        validateProfile() {},
        pairPrincipal() { throw new Error('handoff rejected') },
        removeCredential() {
          stagedWasDeleted = true
          throw Object.assign(new Error('simulated crash after credential deletion'), { code: 'EIO' })
        },
      },
    })).rejects.toThrow(/rollback completed.*cleanup failed/iu)

    expect(stagedWasDeleted).toBe(true)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    expect(JSON.parse(await readFile(`${patchPath}.lark-setup.journal.json`, 'utf8')))
      .toMatchObject({ phase: 'aborting' })
    let recoveryPairCalls = 0
    await recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        pairPrincipal() { recoveryPairCalls += 1 },
        removeCredential() {
          throw Object.assign(new Error('credential is already absent'), { code: 'not-found' })
        },
      },
    })

    expect(recoveryPairCalls).toBe(0)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('replays a validated refresh forward instead of silently rolling it back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-validated-crash-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = configuredLarkProfile({
      dshHome,
      databasePath,
      ownerUserId: 'ou_owner',
      agentTools: 'disable',
    })
    const updatedPatch = lark.refreshLarkAgentPolicyPatch({
      profilePatch: originalPatch,
      dshHome,
      agentTools: 'enable',
    })
    await writeFile(patchPath, originalPatch, 'utf8')
    const { persistLarkSetupJournal, recoverLarkSetupJournal } = await import('../src/setup.ts')
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'refresh',
      phase: 'validated',
      originalPatch,
      updatedPatch,
      installService: false,
    })

    await recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() { return asEffectiveProfile(updatedPatch) },
      },
    })

    expect(await readFile(patchPath, 'utf8')).toBe(updatedPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rolls back validated refresh recovery when effective policy no longer matches the candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-recovery-policy-drift-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = configuredLarkProfile({
      dshHome,
      databasePath,
      ownerUserId: 'ou_owner',
      agentTools: 'disable',
    })
    const updatedPatch = lark.refreshLarkAgentPolicyPatch({
      profilePatch: originalPatch,
      dshHome,
      agentTools: 'enable',
    })
    await writeFile(patchPath, updatedPatch, 'utf8')
    const { persistLarkSetupJournal, recoverLarkSetupJournal } = await import('../src/setup.ts')
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'refresh',
      phase: 'validated',
      originalPatch,
      updatedPatch,
      installService: false,
    })
    const driftedEffective = asEffectiveProfile(updatedPatch)
      .replace('id: lark-owner-tool-*-primary', 'id: removed-owner-tool-primary')

    await expect(recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operations: {
        readEffectiveProfile() { return driftedEffective },
      },
    })).rejects.toThrow(/effective Agent policy does not match/iu)

    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('rolls back validated refresh recovery when its candidate contains a malformed reserved row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-recovery-raw-integrity-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = configuredLarkProfile({ dshHome, databasePath, ownerUserId: 'ou_owner' })
    const updatedPatch = `${originalPatch}
- id: dsh-enhanced-lark-channel
  config: { enabled: true, account: primary }
`
    await writeFile(patchPath, updatedPatch, 'utf8')
    const { persistLarkSetupJournal, recoverLarkSetupJournal } = await import('../src/setup.ts')
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'refresh',
      phase: 'validated',
      originalPatch,
      updatedPatch,
      installService: false,
    })

    await expect(recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operations: {
        readEffectiveProfile() { return asEffectiveProfile(originalPatch) },
      },
    })).rejects.toThrow(/duplicate reserved row.*lark-channel/iu)

    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('recovers an abandoned journal before staging the next full setup credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-entry-recovery-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const seed = baseAssistantProfile(dshHome, join(dshHome, 'assistant-delivery/state.sqlite'))
    const originalPatch = lark.configureLarkProfilePatch({
      profilePatch: seed,
      dshHome,
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_original',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      credentialProvider: 'macos-keychain',
      agentTools: 'disable',
    })
    const crashedPatch = 'candidate-left-by-killed-process\n'
    await writeFile(patchPath, crashedPatch, 'utf8')
    const setupModule = await import('../src/setup.ts') as Record<string, unknown>
    const createLocator = setupModule.createVersionedCredentialLocator as (
      input: Record<string, unknown>,
    ) => unknown
    const persistJournal = setupModule.persistLarkSetupJournal as (input: Record<string, unknown>) => Promise<void>
    const execute = setupModule.executeLarkSetupProfileTransaction as (input: Record<string, unknown>) => Promise<void>
    const abandoned = createLocator({
      provider: 'macos-keychain', dshHome, profile: 'web', account: 'primary',
      version: '11111111111111111111111111111111',
    })
    await persistJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'full',
      phase: 'candidate',
      originalPatch,
      updatedPatch: crashedPatch,
      databasePath: join(dshHome, 'assistant-delivery/state.sqlite'),
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_abandoned' },
      stagedCredential: abandoned,
      installService: false,
    })
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    const events: string[] = []

    await execute({
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() {
          return asEffectiveProfile(readFileSync(patchPath, 'utf8'))
        },
        storeCredential() { events.push('new-credential-staged') },
        readCredential() { return 'new-secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' }
        },
        validateProfile() {},
        pairPrincipal() { events.push('new-owner-paired') },
        removeCredential(locator: unknown) {
          events.push(JSON.stringify(locator) === JSON.stringify(abandoned)
            ? 'abandoned-credential-removed'
            : 'previous-credential-removed')
        },
      },
    })

    expect(events[0]).toBe('abandoned-credential-removed')
    expect(events[1]).toBe('new-credential-staged')
    expect(await readFile(patchPath, 'utf8')).toContain('lark/primary/personal/ou_new')
  })

  test('retains the live paired journal when previous credential cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-live-pending-cleanup-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = lark.configureLarkProfilePatch({
      profilePatch: baseAssistantProfile(dshHome, databasePath),
      dshHome,
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_original',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      credentialProvider: 'macos-keychain',
      agentTools: 'disable',
    })
    await writeFile(patchPath, originalPatch, 'utf8')
    const { executeLarkSetupProfileTransaction, recoverLarkSetupJournal } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    const lockOptions = { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 }
    const previous = { provider: 'macos-keychain', service: 'dsh/lark/web/primary', account: 'primary' }
    let pairCalls = 0
    let removeCalls = 0
    const removed: unknown[] = []
    const operations = {
      readEffectiveProfile() {
        return asEffectiveProfile(readFileSync(patchPath, 'utf8'))
      },
      storeCredential() {},
      readCredential() { return 'staged-secret' },
      discoverOwner() {
        return { channel: 'lark' as const, account: 'primary', tenant: 'personal', user: 'ou_new' }
      },
      validateProfile() {},
      pairPrincipal() { pairCalls += 1 },
      removeCredential(locator: unknown) {
        removed.push(locator)
        removeCalls += 1
        if (removeCalls === 1) throw new Error('Secret Service temporarily unavailable')
      },
    }

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: lockOptions,
      operations,
    })).rejects.toThrow(/profile and owner were committed.*cleanup is pending/iu)

    expect(await readFile(patchPath, 'utf8')).toContain('lark/primary/personal/ou_new')
    expect(JSON.parse(await readFile(`${patchPath}.lark-setup.journal.json`, 'utf8')))
      .toMatchObject({ phase: 'paired', previousCredential: { provider: 'macos-keychain' } })
    expect(pairCalls).toBe(1)
    expect(removeCalls).toBe(1)
    expect(removed).toEqual([previous])

    await recoverLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      profileLockOptions: lockOptions,
      operations,
    })

    expect(pairCalls).toBe(2)
    expect(removeCalls).toBe(2)
    expect(removed).toEqual([previous, previous])
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('clears an absent staged Linux credential after its store operation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-staging-store-failure-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databasePath)
    await writeFile(patchPath, originalPatch, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let removeCalls = 0
    const removed: unknown[] = []

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'linux-secret-service',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() { return asEffectiveProfile(originalPatch) },
        storeCredential() { throw new Error('Linux Secret Service store failed') },
        readCredential() { throw new Error('must not read an unstored credential') },
        discoverOwner() { throw new Error('must not discover an owner') },
        removeCredential(locator) {
          removed.push(locator)
          removeCalls += 1
          throw Object.assign(new Error('credential is already absent'), { code: 'not-found' })
        },
      },
    })).rejects.toThrow('Linux Secret Service store failed')

    expect(removeCalls).toBe(1)
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatchObject({
      provider: 'linux-secret-service', account: 'primary',
    })
    expect((removed[0] as { service: string }).service)
      .toMatch(/^dsh\/lark\/web\/primary\/versions\/[0-9a-f]{32}$/u)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('recovers an abandoned candidate before install-service validates or restarts the Host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-install-recovery-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const originalPatch = 'active-profile\n'
    const crashedPatch = 'unvalidated-candidate\n'
    await writeFile(patchPath, crashedPatch, 'utf8')
    const { persistLarkSetupJournal } = await import('../src/setup.ts')
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'refresh',
      phase: 'candidate',
      originalPatch,
      updatedPatch: crashedPatch,
      installService: false,
    })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    let validated = ''
    let installCalls = 0
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[],
        runtime: Record<string, unknown>,
      ) => Promise<void>
      await run(['--profile', 'web', '--install-service'], {
        profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
        validateProfile() { validated = readFileSync(patchPath, 'utf8') },
        readEffectiveProfile() {
          return effectiveDeliveryProfile(join(dshHome, 'assistant-delivery/state.sqlite'))
        },
        installResidentService() {
          installCalls += 1
          return { kind: 'launchd', statusCommand: 'status', logCommand: 'log' }
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    expect(validated).toBe(originalPatch)
    expect(installCalls).toBe(1)
    expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('recovers an abandoned candidate before refresh reads the profile snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-recovery-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const originalPatch = configuredLarkProfile({
      dshHome,
      databasePath: join(dshHome, 'assistant-delivery/state.sqlite'),
      ownerUserId: 'ou_owner',
    })
    const crashedPatch = 'unvalidated-candidate\n'
    await writeFile(patchPath, crashedPatch, 'utf8')
    const { persistLarkSetupJournal } = await import('../src/setup.ts')
    await persistLarkSetupJournal({
      patchPath,
      dshHome,
      profile: 'web',
      operation: 'refresh',
      phase: 'candidate',
      originalPatch,
      updatedPatch: crashedPatch,
      installService: false,
    })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    let validateCalls = 0
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[],
        runtime: Record<string, unknown>,
      ) => Promise<void>
      await run(['--profile', 'web', '--refresh-agent-policy', '--disable-agent-tools'], {
        profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
        validateProfile() { validateCalls += 1 },
        readEffectiveProfile() {
          return asEffectiveProfile(readFileSync(patchPath, 'utf8'))
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    expect(validateCalls).toBe(1)
    expect(await readFile(patchPath, 'utf8')).toContain('dsh-enhanced-lark-channel')
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('runs policy refresh inside the same profile transaction lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-lock-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const fakeBin = join(root, 'bin')
    await mkdir(profileDirectory, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const originalPatch = `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy: { rules: [] }
- id: dsh-enhanced-assistant-delivery
  config:
    databasePath: ${join(dshHome, 'assistant-delivery/state.sqlite')}
    defaultWorkspace: ${join(dshHome, 'assistant-workspace')}
    defaultAgentPreset: standard
- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    account: primary
    tenant: personal
    appId: cli_0123456789abcdef
`
    await writeFile(patchPath, originalPatch, 'utf8')
    const dsh = join(fakeBin, 'dsh')
    await writeFile(dsh, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(dsh, 0o755)
    const { withProfileSetupLock } = await import('../src/setup.ts')
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const entered = new Promise<void>(resolve => { firstEntered = resolve })
    const hold = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = withProfileSetupLock(patchPath, async () => {
      firstEntered()
      await hold
    }, { timeoutMs: 1_000, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 })
    await entered
    const previousHome = process.env.DSH_HOME
    const previousPath = process.env.PATH
    process.env.DSH_HOME = dshHome
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[],
        runtime: { profileLockOptions: { timeoutMs: number; pollMs: number; staleMs: number; heartbeatMs: number } },
      ) => Promise<void>
      await expect(run(
        ['--profile', 'web', '--refresh-agent-policy', '--allow-agent-tools'],
        { profileLockOptions: { timeoutMs: 30, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 } },
      )).rejects.toThrow(/another setup.*profile/iu)
      expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
    } finally {
      releaseFirst()
      await first
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  test('does not restart a resident Host from an in-flight candidate profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-install-service-lock-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    await writeFile(patchPath, 'active-profile\n', 'utf8')
    const { withProfileSetupLock } = await import('../src/setup.ts')
    let releaseSetup!: () => void
    let setupEntered!: () => void
    const entered = new Promise<void>(resolve => { setupEntered = resolve })
    const hold = new Promise<void>(resolve => { releaseSetup = resolve })
    const setup = withProfileSetupLock(patchPath, async () => {
      setupEntered()
      await hold
    }, { timeoutMs: 1_000, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 })
    await entered
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[],
        runtime: { profileLockOptions: { timeoutMs: number; pollMs: number; staleMs: number; heartbeatMs: number } },
      ) => Promise<void>
      await expect(run(
        ['--profile', 'web', '--install-service'],
        { profileLockOptions: { timeoutMs: 30, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 } },
      )).rejects.toThrow(/another setup.*profile/iu)
      expect(await readFile(patchPath, 'utf8')).toBe('active-profile\n')
    } finally {
      releaseSetup()
      await setup
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  test.each([
    'macos-keychain',
    'linux-secret-service',
    'windows-dpapi',
  ] as const)('uses a unique staged %s locator for same-account reconfiguration', async provider => {
    const root = await mkdtemp(join(tmpdir(), 'lark-staged-credential-'))
    const { createVersionedCredentialLocator } = await import('../src/setup.ts')
    const first = createVersionedCredentialLocator({
      provider,
      dshHome: root,
      profile: 'web',
      account: 'primary',
      version: '11111111111111111111111111111111',
    })
    const second = createVersionedCredentialLocator({
      provider,
      dshHome: root,
      profile: 'web',
      account: 'primary',
      version: '22222222222222222222222222222222',
    })

    expect(second).not.toEqual(first)
    expect(JSON.stringify(second)).not.toContain('generated-secret-value')
    if (provider === 'windows-dpapi') {
      expect(second).toMatchObject({ provider, path: expect.stringContaining('22222222222222222222222222222222') })
    } else {
      expect(second).toMatchObject({
        provider,
        service: 'dsh/lark/web/primary/versions/22222222222222222222222222222222',
        account: 'primary',
      })
    }
  })

  test('recognizes an old credential as setup-owned only with the exact private handle shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-managed-credential-shape-'))
    const dshHome = join(root, 'dsh-home')
    const { findManagedLarkCredentialLocator } = await import('../src/setup.ts')
    const profile = (consumers: string, purposes = '[connect]', maxLeaseMs = '86400000') => `
- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    account: primary
    credentialHandle: lark-app-secret-primary
- id: dsh-enhanced-credentials-keychain
  config:
    handles:
      - id: lark-app-secret-primary
        consumers: ${consumers}
        purposes: ${purposes}
        maxLeaseMs: ${maxLeaseMs}
        provider: macos-keychain
        service: dsh/lark/web/primary/versions/11111111111111111111111111111111
        account: primary
`
    const inspect = (profilePatch: string) => findManagedLarkCredentialLocator({
      profilePatch, dshHome, profile: 'web',
    })

    expect(inspect(profile('[dsh-enhanced-lark-channel]'))).toMatchObject({
      provider: 'macos-keychain',
      service: 'dsh/lark/web/primary/versions/11111111111111111111111111111111',
    })
    expect(inspect(profile('[dsh-enhanced-lark-channel, another-consumer]'))).toBeUndefined()
    expect(inspect(profile('[dsh-enhanced-lark-channel]', '[connect, export]'))).toBeUndefined()
    expect(inspect(profile('[dsh-enhanced-lark-channel]', '[connect]', '1'))).toBeUndefined()
    expect(inspect(`${profile('[dsh-enhanced-lark-channel]')}
      - id: lark-app-secret-primary
        consumers: [dsh-enhanced-lark-channel]
        purposes: [connect]
        maxLeaseMs: 86400000
        provider: macos-keychain
        service: dsh/lark/web/primary/versions/22222222222222222222222222222222
        account: primary
`)).toBeUndefined()
    expect(inspect(`${profile('[dsh-enhanced-lark-channel]')}
      - id: user-backup-secret
        consumers: [user-plugin]
        purposes: [connect]
        maxLeaseMs: 86400000
        provider: macos-keychain
        service: dsh/lark/web/primary/versions/11111111111111111111111111111111
        account: primary
`)).toBeUndefined()

    const windowsPath = join(dshHome, 'credentials-keychain',
      'lark-web-primary-11111111111111111111111111111111.clixml')
    const windowsProfile = `
- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    account: primary
    credentialHandle: lark-app-secret-primary
- id: dsh-enhanced-credentials-keychain
  config:
    handles:
      - id: lark-app-secret-primary
        consumers: [dsh-enhanced-lark-channel]
        purposes: [connect]
        maxLeaseMs: 86400000
        provider: windows-dpapi
        path: ${JSON.stringify(windowsPath)}
      - id: user-backup-secret
        consumers: [user-plugin]
        purposes: [connect]
        maxLeaseMs: 86400000
        provider: windows-dpapi
        path: ${JSON.stringify(windowsPath)}
`
    expect(inspect(windowsProfile)).toBeUndefined()
  })

  test.each([
    'macos-keychain',
    'linux-secret-service',
    'windows-dpapi',
  ] as const)('keeps the old %s credential when candidate validation fails', async provider => {
    const root = await mkdtemp(join(tmpdir(), 'lark-credential-validation-'))
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const { commitValidatedLarkOwnerSetup, createVersionedCredentialLocator } = await import('../src/setup.ts')
    const previous = createVersionedCredentialLocator({
      provider, dshHome: root, profile: 'web', account: 'primary', version: '11111111111111111111111111111111',
    })
    const staged = createVersionedCredentialLocator({
      provider, dshHome: root, profile: 'web', account: 'primary', version: '22222222222222222222222222222222',
    })
    const removed: unknown[] = []

    await expect(commitValidatedLarkOwnerSetup({
      patchPath,
      originalPatch: 'original-profile\n',
      updatedPatch: 'candidate-profile\n',
      profile: 'web',
      databasePath: join(root, 'state.sqlite'),
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      credentialTransition: { previous, staged },
      operations: {
        validateProfile() { throw new Error('candidate rejected') },
        pairPrincipal() { throw new Error('must not pair') },
        removeCredential(locator) { removed.push(locator) },
      },
    })).rejects.toThrow(/candidate rejected/u)

    expect(await readFile(patchPath, 'utf8')).toBe('original-profile\n')
    expect(removed).toEqual([staged])
    expect(removed).not.toContainEqual(previous)
  })

  test.each([
    'macos-keychain',
    'linux-secret-service',
    'windows-dpapi',
  ] as const)('keeps the old %s credential when owner handoff fails', async provider => {
    const root = await mkdtemp(join(tmpdir(), 'lark-credential-handoff-'))
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const { commitValidatedLarkOwnerSetup, createVersionedCredentialLocator } = await import('../src/setup.ts')
    const previous = createVersionedCredentialLocator({
      provider, dshHome: root, profile: 'web', account: 'primary', version: '11111111111111111111111111111111',
    })
    const staged = createVersionedCredentialLocator({
      provider, dshHome: root, profile: 'web', account: 'primary', version: '22222222222222222222222222222222',
    })
    const removed: unknown[] = []

    await expect(commitValidatedLarkOwnerSetup({
      patchPath,
      originalPatch: 'original-profile\n',
      updatedPatch: 'candidate-profile\n',
      profile: 'web',
      databasePath: join(root, 'state.sqlite'),
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      credentialTransition: { previous, staged },
      operations: {
        validateProfile() {},
        pairPrincipal() { throw new Error('handoff rejected') },
        removeCredential(locator) { removed.push(locator) },
      },
    })).rejects.toThrow(/handoff rejected/u)

    expect(await readFile(patchPath, 'utf8')).toBe('original-profile\n')
    expect(removed).toEqual([staged])
    expect(removed).not.toContainEqual(previous)
  })

  test('does not let a stale rollback overwrite a newer profile commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-stale-rollback-'))
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const { commitValidatedLarkOwnerSetup, createVersionedCredentialLocator } = await import('../src/setup.ts')
    const staged = createVersionedCredentialLocator({
      provider: 'macos-keychain',
      dshHome: root,
      profile: 'web',
      account: 'primary',
      version: '22222222222222222222222222222222',
    })
    const removed: unknown[] = []

    await expect(commitValidatedLarkOwnerSetup({
      patchPath,
      originalPatch: 'original-profile\n',
      updatedPatch: 'candidate-profile\n',
      profile: 'web',
      databasePath: join(root, 'state.sqlite'),
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      credentialTransition: { staged },
      operations: {
        validateProfile() {
          writeFileSync(patchPath, 'newer-profile\n', 'utf8')
          throw new Error('candidate rejected')
        },
        pairPrincipal() { throw new Error('must not pair') },
        removeCredential(locator) { removed.push(locator) },
      },
    })).rejects.toThrow(/rollback refused.*changed concurrently/iu)

    expect(await readFile(patchPath, 'utf8')).toBe('newer-profile\n')
    expect(removed).toEqual([])
  })

  test('does not hand off the owner when an external writer replaces the validated candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-external-profile-writer-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databasePath)
    await writeFile(patchPath, originalPatch, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let pairCalls = 0
    const removed: unknown[] = []

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile() { return effectiveDeliveryProfile(databasePath) },
        storeCredential() {},
        readCredential() { return 'secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' }
        },
        validateProfile() { writeFileSync(patchPath, 'newer-profile\n', 'utf8') },
        pairPrincipal() { pairCalls += 1 },
        removeCredential(locator) { removed.push(locator) },
      },
    })).rejects.toThrow(/rollback refused.*changed concurrently/iu)

    expect(pairCalls).toBe(0)
    expect(removed).toEqual([])
    expect(await readFile(patchPath, 'utf8')).toBe('newer-profile\n')
    expect(JSON.parse(await readFile(`${patchPath}.lark-setup.journal.json`, 'utf8')))
      .toMatchObject({ phase: 'candidate' })
  })

  test.each([
    'macos-keychain',
    'linux-secret-service',
    'windows-dpapi',
  ] as const)('retires the previous %s credential only after profile and owner commit', async provider => {
    const root = await mkdtemp(join(tmpdir(), 'lark-credential-success-'))
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    const { commitValidatedLarkOwnerSetup, createVersionedCredentialLocator } = await import('../src/setup.ts')
    const previous = createVersionedCredentialLocator({
      provider, dshHome: root, profile: 'web', account: 'primary', version: '11111111111111111111111111111111',
    })
    const staged = createVersionedCredentialLocator({
      provider, dshHome: root, profile: 'web', account: 'primary', version: '22222222222222222222222222222222',
    })
    const events: string[] = []

    await commitValidatedLarkOwnerSetup({
      patchPath,
      originalPatch: 'original-profile\n',
      updatedPatch: 'candidate-profile\n',
      profile: 'web',
      databasePath: join(root, 'state.sqlite'),
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_new' },
      credentialTransition: { previous, staged },
      operations: {
        validateProfile() { events.push('validated') },
        pairPrincipal() { events.push('paired') },
        removeCredential(locator) {
          expect(locator).toEqual(previous)
          events.push('old-credential-removed')
        },
      },
    })

    expect(await readFile(patchPath, 'utf8')).toBe('candidate-profile\n')
    expect(events).toEqual(['validated', 'paired', 'old-credential-removed'])
  })

  test('keeps concurrent full setup runs from splitting the profile owner and Delivery owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-full-transaction-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const seed = baseAssistantProfile(dshHome, join(dshHome, 'assistant-delivery/state.sqlite'))
    const originalPatch = lark.configureLarkProfilePatch({
      profilePatch: seed,
      dshHome,
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_original',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      credentialProvider: 'macos-keychain',
      agentTools: 'disable',
    })
    await writeFile(patchPath, originalPatch, 'utf8')
    const setupModule = await import('../src/setup.ts') as Record<string, unknown>
    const execute = setupModule.executeLarkSetupProfileTransaction as (input: Record<string, unknown>) => Promise<void>
    expect(execute).toBeTypeOf('function')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'web', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--allow-agent-tools',
    ])
    const events: string[] = []
    let deliveryOwner = 'ou_original'
    let releaseFirst!: () => void
    let firstDiscovering!: () => void
    const firstEntered = new Promise<void>(resolve => { firstDiscovering = resolve })
    const firstHold = new Promise<void>(resolve => { releaseFirst = resolve })
    const lockOptions = { timeoutMs: 1_000, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 }
    const createOperations = (name: 'first' | 'second', owner: string) => ({
      readEffectiveProfile() {
        return asEffectiveProfile(readFileSync(patchPath, 'utf8'))
      },
      storeCredential(locator: unknown) {
        events.push(`${name}:credential-staged`)
        expect(JSON.stringify(locator)).toContain('/versions/')
      },
      readCredential() { return `${name}-secret` },
      async discoverOwner() {
        events.push(`${name}:discover-owner`)
        if (name === 'first') {
          firstDiscovering()
          await firstHold
        }
        return { channel: 'lark', account: 'primary', tenant: 'personal', user: owner }
      },
      validateProfile() { events.push(`${name}:validated`) },
      pairPrincipal(input: { principal: { user: string } }) {
        const currentPatch = readFileSync(patchPath, 'utf8')
        expect(currentPatch).toContain(`lark/primary/personal/${input.principal.user}`)
        deliveryOwner = input.principal.user
        events.push(`${name}:paired`)
      },
      removeCredential() { events.push(`${name}:credential-retired`) },
      afterCommit() { events.push(`${name}:resident-installed`) },
    })
    const common = {
      args,
      dshHome,
      patchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: lockOptions,
    }
    const first = execute({ ...common, operations: createOperations('first', 'ou_first') })
    await firstEntered
    const second = execute({ ...common, operations: createOperations('second', 'ou_second') })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(events).not.toContain('second:credential-staged')
    releaseFirst()
    await Promise.all([first, second])

    const finalPatch = await readFile(patchPath, 'utf8')
    expect(finalPatch).toContain('lark/primary/personal/ou_second')
    expect(deliveryOwner).toBe('ou_second')
    expect(events.indexOf('first:resident-installed')).toBeLessThan(events.indexOf('second:credential-staged'))
    expect(events.indexOf('second:validated')).toBeLessThan(events.indexOf('second:paired'))
    expect(events.at(-1)).toBe('second:resident-installed')
  })

  test('refuses an inherited Lark profile backed by the same Delivery database even when its raw patch has no row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-cross-profile-sequential-'))
    const dshHome = join(root, 'dsh-home')
    const databasePath = join(dshHome, 'assistant-delivery/shared.sqlite')
    const webDirectory = join(dshHome, 'profiles', 'web')
    const fooDirectory = join(dshHome, 'profiles', 'foo')
    await mkdir(webDirectory, { recursive: true })
    await mkdir(fooDirectory, { recursive: true })
    const webPatchPath = join(webDirectory, 'cordis.patch.yml')
    const fooPatchPath = join(fooDirectory, 'cordis.patch.yml')
    const base = baseAssistantProfile(dshHome, databasePath)
    await writeFile(webPatchPath, base, 'utf8')
    await writeFile(fooPatchPath, base, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'foo', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let storeCalls = 0
    let pairCalls = 0

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath: fooPatchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile(profile) {
          return profile === 'web'
            ? effectiveLarkDeliveryProfile(databasePath)
            : effectiveDeliveryProfile(databasePath)
        },
        storeCredential() { storeCalls += 1 },
        readCredential() { return 'secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_foo' }
        },
        validateProfile() {},
        pairPrincipal() { pairCalls += 1 },
        removeCredential() {},
      },
    })).rejects.toThrow(/profile web already owns Lark.*same assistant-delivery database/iu)

    expect(storeCalls).toBe(0)
    expect(pairCalls).toBe(0)
    expect(await readFile(fooPatchPath, 'utf8')).toBe(base)
  })

  test('fails closed when another real profile cannot prove whether it inherited Lark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-cross-profile-unverifiable-'))
    const dshHome = join(root, 'dsh-home')
    const databasePath = join(dshHome, 'assistant-delivery/shared.sqlite')
    const webDirectory = join(dshHome, 'profiles', 'web')
    const fooDirectory = join(dshHome, 'profiles', 'foo')
    await mkdir(webDirectory, { recursive: true })
    await mkdir(fooDirectory, { recursive: true })
    const base = baseAssistantProfile(dshHome, databasePath)
    await writeFile(join(webDirectory, 'cordis.patch.yml'), base, 'utf8')
    const fooPatchPath = join(fooDirectory, 'cordis.patch.yml')
    await writeFile(fooPatchPath, base, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'foo', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let storeCalls = 0

    await expect(executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath: fooPatchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile(profile) {
          if (profile === 'web') throw new Error('profile composition failed')
          return effectiveDeliveryProfile(databasePath)
        },
        storeCredential() { storeCalls += 1 },
        readCredential() { return 'secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_foo' }
        },
        validateProfile() {},
        pairPrincipal() {},
        removeCredential() {},
      },
    })).rejects.toThrow(/cannot verify effective Lark ownership in profile web/iu)

    expect(storeCalls).toBe(0)
    expect(await readFile(fooPatchPath, 'utf8')).toBe(base)
  })

  test('serializes different profiles through canonical aliases of their shared Delivery database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-cross-profile-concurrent-'))
    const dshHome = join(root, 'dsh-home')
    const realDatabasePath = join(dshHome, 'assistant-delivery/shared.sqlite')
    const aliasDatabasePath = join(dshHome, 'delivery-alias.sqlite')
    const webDirectory = join(dshHome, 'profiles', 'web')
    const fooDirectory = join(dshHome, 'profiles', 'foo')
    await mkdir(dirname(realDatabasePath), { recursive: true })
    await mkdir(webDirectory, { recursive: true })
    await mkdir(fooDirectory, { recursive: true })
    await writeFile(realDatabasePath, '', 'utf8')
    await symlink(realDatabasePath, aliasDatabasePath)
    const webPatchPath = join(webDirectory, 'cordis.patch.yml')
    const fooPatchPath = join(fooDirectory, 'cordis.patch.yml')
    const webBase = baseAssistantProfile(dshHome, realDatabasePath)
    const fooBase = baseAssistantProfile(dshHome, aliasDatabasePath)
    await writeFile(webPatchPath, webBase, 'utf8')
    await writeFile(fooPatchPath, fooBase, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = (profile: string) => lark.parseLarkSetupArgs([
      '--profile', profile, '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const entered = new Promise<void>(resolve => { firstEntered = resolve })
    const hold = new Promise<void>(resolve => { releaseFirst = resolve })
    const events: string[] = []
    const operations = (name: 'web' | 'foo') => ({
      readEffectiveProfile(profile: string) {
        const profilePatch = readFileSync(
          profile === 'web' ? webPatchPath : fooPatchPath,
          'utf8',
        )
        const databasePath = profile === 'web' ? realDatabasePath : aliasDatabasePath
        return profilePatch.includes('dsh-enhanced-lark-channel')
          ? asEffectiveProfile(profilePatch)
          : effectiveDeliveryProfile(databasePath)
      },
      storeCredential() { events.push(`${name}:staged`) },
      readCredential() { return `${name}-secret` },
      async discoverOwner() {
        if (name === 'web') {
          firstEntered()
          await hold
        }
        return { channel: 'lark' as const, account: 'primary', tenant: 'personal', user: `ou_${name}` }
      },
      validateProfile() {},
      pairPrincipal() { events.push(`${name}:paired`) },
      removeCredential() {},
    })
    const common = {
      dshHome,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' as const },
      credentialProvider: 'macos-keychain' as const,
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 2_000, heartbeatMs: 100 },
    }
    const first = executeLarkSetupProfileTransaction({
      ...common, args: args('web'), patchPath: webPatchPath, operations: operations('web'),
    })
    await entered
    const second = executeLarkSetupProfileTransaction({
      ...common, args: args('foo'), patchPath: fooPatchPath, operations: operations('foo'),
    }).then(() => undefined, error => error as Error)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(events).not.toContain('foo:staged')
    releaseFirst()
    await first
    expect(await second).toMatchObject({ message: expect.stringMatching(/profile web already owns Lark/iu) })

    expect(events).toEqual(['web:staged', 'web:paired'])
    expect(await readFile(webPatchPath, 'utf8')).toContain('lark/primary/personal/ou_web')
    expect(await readFile(fooPatchPath, 'utf8')).toBe(fooBase)
  })

  test('pairs against the effective custom Delivery database and permits an isolated profile database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-custom-delivery-database-'))
    const dshHome = join(root, 'dsh-home')
    const webDatabasePath = join(dshHome, 'delivery-web.sqlite')
    const fooDatabasePath = join(dshHome, 'custom', 'delivery-foo.sqlite')
    const webDirectory = join(dshHome, 'profiles', 'web')
    const fooDirectory = join(dshHome, 'profiles', 'foo')
    await mkdir(webDirectory, { recursive: true })
    await mkdir(fooDirectory, { recursive: true })
    const webBase = baseAssistantProfile(dshHome, webDatabasePath)
    const fooBase = baseAssistantProfile(dshHome, fooDatabasePath)
    const webPatchPath = join(webDirectory, 'cordis.patch.yml')
    await writeFile(webPatchPath, lark.configureLarkProfilePatch({
      profilePatch: webBase,
      dshHome,
      appId: 'cli_0123456789abcdef',
      account: 'primary',
      tenant: 'personal',
      domain: 'feishu',
      ownerUserId: 'ou_web',
      keychainService: 'dsh/lark/web/primary',
      keychainAccount: 'primary',
      credentialProvider: 'macos-keychain',
      agentTools: 'disable',
    }), 'utf8')
    const fooPatchPath = join(fooDirectory, 'cordis.patch.yml')
    await writeFile(fooPatchPath, fooBase, 'utf8')
    const { executeLarkSetupProfileTransaction } = await import('../src/setup.ts')
    const args = lark.parseLarkSetupArgs([
      '--profile', 'foo', '--account', 'primary', '--tenant', 'personal',
      '--app-id', 'cli_0123456789abcdef', '--no-service', '--disable-agent-tools',
    ])
    let pairedDatabasePath = ''

    await executeLarkSetupProfileTransaction({
      args,
      dshHome,
      patchPath: fooPatchPath,
      application: { appId: 'cli_0123456789abcdef', domain: 'feishu' },
      credentialProvider: 'macos-keychain',
      profileLockOptions: { timeoutMs: 1_000, pollMs: 5, staleMs: 100, heartbeatMs: 10 },
      operations: {
        readEffectiveProfile(profile) {
          if (profile === 'web') return asEffectiveProfile(readFileSync(webPatchPath, 'utf8'))
          const current = readFileSync(fooPatchPath, 'utf8')
          return current.includes('dsh-enhanced-lark-channel')
            ? asEffectiveProfile(current)
            : `- id: dsh-enhanced-assistant-delivery\n  name: '@dsh-enhanced/assistant-delivery'\n  config:\n    databasePath: !!js dshHomePath('custom/delivery-foo.sqlite')\n`
        },
        storeCredential() {},
        readCredential() { return 'secret' },
        discoverOwner() {
          return { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_foo' }
        },
        validateProfile() {},
        pairPrincipal(input) { pairedDatabasePath = input.databasePath },
        removeCredential() {},
      },
    })

    expect(pairedDatabasePath).toBe(fooDatabasePath)
    expect(await readFile(fooPatchPath, 'utf8')).toContain('lark/primary/personal/ou_foo')
  })

  test('refreshes an existing profile policy without entering application or owner onboarding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-policy-refresh-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const fakeBin = join(root, 'bin')
    await mkdir(profileDirectory, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    await writeFile(patchPath, `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy:
      databasePath: ${join(dshHome, 'assistant-policy/policy.sqlite')}
      rules:
        - id: lark-owner-ingress-secondary
          effect: allow
          subject: { kind: external, id: lark/secondary/personal/ou_owner }
          actions: [approval.decide, ingest]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }
        - id: lark-owner-reply-secondary
          effect: allow
          subject: { kind: agent, id: standard, workspace: ${join(dshHome, 'assistant-workspace')} }
          actions: [reply]
          resource: { kind: message, id: "*" }
          context: { initiators: [external] }
    personalMemory:
      databasePath: ${join(dshHome, 'personal-memory/memory.sqlite')}
    personalWiki:
      vaultRoot: ${join(dshHome, 'personal-wiki/vault')}
      databasePath: ${join(dshHome, 'personal-wiki/state.sqlite')}
    assistantAutomations:
      databasePath: ${join(dshHome, 'assistant-automations/state.sqlite')}
      runsPath: ${join(dshHome, 'assistant-automations/runs')}
- id: dsh-enhanced-assistant-delivery
  config:
    databasePath: ${join(dshHome, 'assistant-delivery/state.sqlite')}
    spoolPath: ${join(dshHome, 'assistant-delivery/spool')}
    defaultWorkspace: ${join(dshHome, 'assistant-workspace')}
    defaultAgentPreset: standard
- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    account: secondary
    tenant: personal
    appId: cli_0123456789abcdef
`, 'utf8')
    const dsh = join(fakeBin, 'dsh')
    await writeFile(dsh, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(dsh, 0o755)
    const previousHome = process.env.DSH_HOME
    const previousPath = process.env.PATH
    process.env.DSH_HOME = dshHome
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[], runtime: Record<string, unknown>,
      ) => Promise<void>
      await run(['--profile', 'web', '--refresh-agent-policy', '--allow-agent-tools'], {
        readEffectiveProfile() {
          return asEffectiveProfile(readFileSync(patchPath, 'utf8'))
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }

    const output = await readFile(patchPath, 'utf8')
    expect(output).toContain('appId: cli_0123456789abcdef')
    expect(output).toContain('lark-owner-reply-secondary')
    expect(output).toContain('lark-owner-tool-*-secondary')
    expect(output).toContain('principal: lark/secondary/personal/ou_owner')
    expect(output).toContain('dsh-enhanced-foreground-capability-*')
  })

  test('refreshes an effective-only enabled Lark owner without materializing or deleting raw channel credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-effective-only-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = baseAssistantProfile(dshHome, databasePath)
    await writeFile(patchPath, originalPatch, 'utf8')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[], runtime: Record<string, unknown>,
      ) => Promise<void>
      await run(['--profile', 'web', '--refresh-agent-policy', '--allow-agent-tools'], {
        validateProfile() {},
        readEffectiveProfile() {
          return inheritedLarkEffectiveProfile({
            profilePatch: readFileSync(patchPath, 'utf8'),
            dshHome,
          })
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    const output = await readFile(patchPath, 'utf8')
    expect(output).toContain('lark-owner-tool-*-primary')
    expect(output).toContain('principal: lark/primary/personal/ou_owner')
    expect(output).not.toMatch(/^- id: dsh-enhanced-lark-channel$/mu)
    expect(output).not.toMatch(/^- id: dsh-enhanced-credentials-keychain$/mu)
  })

  test('uses effective disabled Lark semantics and preserves raw channel credentials during refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-effective-disabled-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const originalPatch = configuredLarkProfile({
      dshHome,
      databasePath,
      ownerUserId: 'ou_owner',
      agentTools: 'enable',
    })
    await writeFile(patchPath, originalPatch, 'utf8')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[], runtime: Record<string, unknown>,
      ) => Promise<void>
      await run(['--profile', 'web', '--refresh-agent-policy', '--allow-agent-tools'], {
        validateProfile() {},
        readEffectiveProfile() {
          return asEffectiveProfile(readFileSync(patchPath, 'utf8'))
            .replace('enabled: true', 'enabled: false')
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    const output = await readFile(patchPath, 'utf8')
    expect(output).not.toContain('lark-owner-tool-*-primary')
    expect(output).not.toContain('lark-owner-reply-primary')
    expect(output).toContain('enabled: true')
    expect(output).toContain('dsh/lark/web/primary/versions/22222222222222222222222222222222')
  })

  test.each([
    'duplicate-lark',
    'disabled-lark',
    'dynamic-disabled-lark',
    'wrong-package-lark',
    'wrong-package-credentials',
  ] as const)('fails closed before effective semantic replacement for raw %s integrity', async corruption => {
    const root = await mkdtemp(join(tmpdir(), 'lark-refresh-raw-integrity-'))
    const dshHome = join(root, 'dsh-home')
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
    const validPatch = configuredLarkProfile({
      dshHome,
      databasePath,
      ownerUserId: 'ou_owner',
      agentTools: 'disable',
    })
    let corruptedPatch = validPatch
    if (corruption === 'duplicate-lark') {
      corruptedPatch += `
- id: dsh-enhanced-lark-channel
  config: { enabled: true, account: primary }
`
    } else if (corruption === 'disabled-lark') {
      corruptedPatch = validPatch.replace(
        '- id: dsh-enhanced-lark-channel\n',
        '- id: dsh-enhanced-lark-channel\n  disabled: true\n',
      )
    } else if (corruption === 'dynamic-disabled-lark') {
      corruptedPatch = validPatch.replace(
        '- id: dsh-enhanced-lark-channel\n',
        "- id: dsh-enhanced-lark-channel\n  disabled: !!js process.env('LARK_DISABLED')\n",
      )
    } else if (corruption === 'wrong-package-lark') {
      corruptedPatch = validPatch.replace(
        '- id: dsh-enhanced-lark-channel\n',
        "- id: dsh-enhanced-lark-channel\n  name: '@example/other-lark'\n",
      )
    } else {
      corruptedPatch = validPatch.replace(
        '- id: dsh-enhanced-credentials-keychain\n',
        "- id: dsh-enhanced-credentials-keychain\n  name: '@example/shared-credentials'\n",
      )
    }
    await writeFile(patchPath, corruptedPatch, 'utf8')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    let validateCalls = 0
    try {
      const run = lark.runLarkSetup as unknown as (
        argv: readonly string[], runtime: Record<string, unknown>,
      ) => Promise<void>
      await expect(run(['--profile', 'web', '--refresh-agent-policy', '--disable-agent-tools'], {
        validateProfile() { validateCalls += 1 },
        readEffectiveProfile() { return asEffectiveProfile(validPatch) },
      })).rejects.toThrow(
        /(?:managed profile row.*(?:duplicated|shadowed|disabled|invalid)|duplicate reserved row|conflicting package|must not be disabled)/iu,
      )
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    expect(validateCalls).toBe(0)
    expect(await readFile(patchPath, 'utf8')).toBe(corruptedPatch)
    await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each(['enable-missing-rule', 'disable-retained-rules'] as const)(
    'rolls back policy refresh when effective validation reports %s',
    async mode => {
      const root = await mkdtemp(join(tmpdir(), 'lark-refresh-effective-policy-'))
      const dshHome = join(root, 'dsh-home')
      const profileDirectory = join(dshHome, 'profiles', 'web')
      await mkdir(profileDirectory, { recursive: true })
      const patchPath = join(profileDirectory, 'cordis.patch.yml')
      const databasePath = join(dshHome, 'assistant-delivery/state.sqlite')
      const originalPatch = configuredLarkProfile({
        dshHome,
        databasePath,
        ownerUserId: 'ou_owner',
        agentTools: mode === 'disable-retained-rules' ? 'enable' : 'disable',
      })
      await writeFile(patchPath, originalPatch, 'utf8')
      const previousHome = process.env.DSH_HOME
      process.env.DSH_HOME = dshHome
      try {
        const run = lark.runLarkSetup as unknown as (
          argv: readonly string[], runtime: Record<string, unknown>,
        ) => Promise<void>
        await expect(run([
          '--profile', 'web', '--refresh-agent-policy',
          mode === 'disable-retained-rules' ? '--disable-agent-tools' : '--allow-agent-tools',
        ], {
          validateProfile() {},
          readEffectiveProfile() {
            const current = readFileSync(patchPath, 'utf8')
            if (current === originalPatch) return asEffectiveProfile(current)
            if (mode === 'disable-retained-rules') return asEffectiveProfile(originalPatch)
            return asEffectiveProfile(current)
              .replace('id: lark-owner-tool-*-primary', 'id: removed-owner-tool-primary')
          },
        })).rejects.toThrow(/effective Agent policy does not match/iu)
      } finally {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
      }

      expect(await readFile(patchPath, 'utf8')).toBe(originalPatch)
      await expect(readFile(`${patchPath}.lark-setup.journal.json`, 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test('does not mutate Delivery pairing state when candidate profile validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-validated-owner-commit-'))
    const profileDirectory = join(root, 'dsh-home', 'profiles', 'web')
    const fakeBin = join(root, 'bin')
    await mkdir(profileDirectory, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(root, 'dsh-home', 'assistant-delivery', 'state.sqlite')
    await mkdir(join(root, 'dsh-home', 'assistant-delivery'), { recursive: true })
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    await writeFile(databasePath, 'original-delivery-state\n', 'utf8')
    const dsh = join(fakeBin, 'dsh')
    await writeFile(dsh, '#!/bin/sh\necho invalid-candidate >&2\nexit 1\n', 'utf8')
    await chmod(dsh, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    try {
      const commit = (await import('../src/setup.ts') as Record<string, unknown>)
        .commitValidatedLarkOwnerSetup as (input: unknown) => Promise<void>
      expect(commit).toBeTypeOf('function')
      await expect(commit({
        patchPath,
        originalPatch: 'original-profile\n',
        updatedPatch: 'candidate-profile\n',
        profile: 'web',
        databasePath,
        principal: { channel: 'lark', account: 'secondary', tenant: 'personal', user: 'ou_new' },
      })).rejects.toThrow(/DSH rejected.*invalid-candidate/iu)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
    expect(await readFile(patchPath, 'utf8')).toBe('original-profile\n')
    expect(await readFile(databasePath, 'utf8')).toBe('original-delivery-state\n')
  })

  test('restores the original profile when the validated Delivery owner handoff fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-owner-handoff-rollback-'))
    const profileDirectory = join(root, 'dsh-home', 'profiles', 'web')
    const fakeBin = join(root, 'bin')
    await mkdir(profileDirectory, { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const databasePath = join(root, 'dsh-home', 'assistant-delivery', 'state.sqlite')
    await mkdir(join(root, 'dsh-home', 'assistant-delivery'), { recursive: true })
    await writeFile(patchPath, 'original-profile\n', 'utf8')
    await writeFile(databasePath, 'not-a-sqlite-database\n', 'utf8')
    const dsh = join(fakeBin, 'dsh')
    await writeFile(dsh, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(dsh, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${previousPath ?? ''}`
    try {
      const { commitValidatedLarkOwnerSetup } = await import('../src/setup.ts')
      await expect(commitValidatedLarkOwnerSetup({
        patchPath,
        originalPatch: 'original-profile\n',
        updatedPatch: 'candidate-profile\n',
        profile: 'web',
        databasePath,
        principal: { channel: 'lark', account: 'secondary', tenant: 'personal', user: 'ou_new' },
      })).rejects.toThrow()
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
    expect(await readFile(patchPath, 'utf8')).toBe('original-profile\n')
  })

  test('recognizes only the exact one-time phrase from a direct message', () => {
    const match = (lark as Record<string, unknown>).matchOwnerHandshake
    expect(match).toBeTypeOf('function')
    const identify = match as (input: unknown) => unknown

    expect(identify({ message: directMessage, phrase: 'DSH-CONNECT-A1B2C3D4', account: 'primary', tenant: 'personal' }))
      .toEqual({ channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' })
    expect(identify({ message: { ...directMessage, chatType: 'group' }, phrase: directMessage.content,
      account: 'primary', tenant: 'personal' })).toBeUndefined()
    expect(identify({ message: directMessage, phrase: 'DSH-CONNECT-WRONG000',
      account: 'primary', tenant: 'personal' })).toBeUndefined()
  })

  test('parses a profile and domain without accepting secret arguments', () => {
    const parseArgs = (lark as Record<string, unknown>).parseLarkSetupArgs
    expect(parseArgs).toBeTypeOf('function')
    const parse = parseArgs as (argv: string[]) => unknown

    expect(parse(['--profile', 'web', '--domain', 'feishu'])).toMatchObject({ profile: 'web', domain: 'feishu' })
    expect(parse([])).toMatchObject({ agentTools: 'preserve' })
    expect(parse(['--allow-agent-tools'])).toMatchObject({ agentTools: 'enable' })
    expect(parse(['--disable-agent-tools'])).toMatchObject({ agentTools: 'disable' })
    expect(() => parse(['--allow-agent-tools', '--disable-agent-tools'])).toThrow(/mutually exclusive/i)
    expect(parse(['--profile', 'web', '--refresh-agent-policy', '--allow-agent-tools'])).toMatchObject({
      profile: 'web',
      refreshAgentPolicy: true,
      agentTools: 'enable',
    })
    expect(() => parse(['--refresh-agent-policy'])).toThrow(/refresh-agent-policy.*agent-tools/i)
    expect(() => parse([
      '--refresh-agent-policy', '--allow-agent-tools', '--create-app',
    ])).toThrow(/refresh-agent-policy.*create-app/i)
    expect(() => parse([
      '--refresh-agent-policy', '--allow-agent-tools', '--no-service',
    ])).toThrow(/refresh-agent-policy.*no-service/i)
    expect(() => parse([
      '--refresh-agent-policy', '--allow-agent-tools', '--app-id', 'cli_0123456789abcdef',
    ])).toThrow(/refresh-agent-policy.*app-id/i)
    expect(parse(['--create-app', '--app-name', 'My DSH'])).toMatchObject({
      createApp: true,
      appName: 'My DSH',
      manageService: true,
    })
    expect(parse(['--profile', 'web', '--install-service'])).toMatchObject({
      profile: 'web',
      installServiceOnly: true,
      manageService: true,
    })
    expect(parse(['--no-service'])).toMatchObject({ manageService: false })
    expect(() => parse(['--install-service', '--no-service'])).toThrow(/install-service.*no-service/i)
    expect(() => parse(['--install-service', '--allow-agent-tools'])).toThrow(/install-service.*agent-tools/i)
    expect(parse(['--create-app', '--app-id', 'cli_0123456789abcdef'])).toMatchObject({
      createApp: true,
      appId: 'cli_0123456789abcdef',
    })
    expect(() => parse(['--app-secret', 'do-not-accept'])).toThrow(/secret.*not accepted/i)
  })

  test('offers existing or new applications with a minimal official template', () => {
    const registrationOptions = (lark as Record<string, unknown>).createLarkRegistrationOptions
    expect(registrationOptions).toBeTypeOf('function')

    const options = (registrationOptions as (input: unknown) => Record<string, unknown>)({
      domain: 'feishu',
      appName: 'DSH Personal Assistant',
      signal: new AbortController().signal,
      onQRCodeReady() {},
      onStatusChange() {},
    })
    expect(options).not.toHaveProperty('createOnly')
    expect(options).toMatchObject({
      domain: 'accounts.feishu.cn',
      larkDomain: 'accounts.larksuite.com',
      source: 'dsh-enhanced/lark-channel',
      appPreset: {
        name: 'DSH Personal Assistant',
      },
      addons: {
        preset: false,
        scopes: { tenant: [
          'application:bot.basic_info:read',
          'im:message.group_at_msg:readonly',
          'im:message.p2p_msg:readonly',
          'im:message.reactions:write_only',
          'im:message:send_as_bot',
          'im:resource',
        ] },
        events: { items: { tenant: ['im.message.receive_v1'] } },
        callbacks: { items: ['card.action.trigger'] },
      },
    })

    const update = (registrationOptions as (input: unknown) => Record<string, unknown>)({
      domain: 'feishu',
      appName: 'DSH Personal Assistant',
      appId: 'cli_0123456789abcdef',
      signal: new AbortController().signal,
      onQRCodeReady() {},
      onStatusChange() {},
    })
    expect(update).toMatchObject({ appId: 'cli_0123456789abcdef' })
    expect(update).not.toHaveProperty('createOnly')
  })

  test('keeps an automatically received secret out of Keychain process arguments', () => {
    const writeRequest = (lark as Record<string, unknown>).createKeychainWriteRequest
    expect(writeRequest).toBeTypeOf('function')
    const secret = 'generated-secret-value'
    const request = (writeRequest as (service: string, account: string, secret: string) => {
      args: string[]
      input: Buffer
    })('dsh/lark/web/primary', 'primary', secret)

    expect(request.args).toEqual(['-i'])
    expect(request.args.join(' ')).not.toContain(secret)
    expect(request.input.toString('utf8')).not.toContain(secret)
    expect(request.input.toString('utf8')).toContain(Buffer.from(secret, 'utf8').toString('hex'))
  })

  test('passes Linux Secret Service and Windows DPAPI values only through stdin', () => {
    const linuxRequest = (lark as Record<string, unknown>).createSecretServiceWriteRequest
    const windowsRequest = (lark as Record<string, unknown>).createWindowsDpapiWriteRequest
    expect(linuxRequest).toBeTypeOf('function')
    expect(windowsRequest).toBeTypeOf('function')
    const secret = 'generated-secret-value'

    const linux = (linuxRequest as (service: string, account: string, secret: string) => {
      executable: string; args: string[]; input: Buffer
    })('dsh/lark/web/primary', 'primary', secret)
    expect(linux.executable).toBe('/usr/bin/secret-tool')
    expect(linux.args).toEqual([
      'store', '--label=DSH Lark web/primary', 'service', 'dsh/lark/web/primary', 'account', 'primary',
    ])
    expect(linux.args.join(' ')).not.toContain(secret)
    expect(linux.input.toString('utf8')).toBe(secret)

    const windows = (windowsRequest as (path: string, secret: string) => {
      executable: string; args: string[]; input: Buffer
    })('C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml', secret)
    expect(windows.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windows.args.join(' ')).not.toContain(secret)
    expect(windows.input.toString('utf8')).toBe(secret)
  })

  test('preflights Linux Secret Service by storing, reading, and clearing a generated canary', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    expect(preflight).toBeTypeOf('function')
    const verify = preflight as (input: {
      environment: NodeJS.ProcessEnv
      executableAvailable: () => boolean
      randomBytes: (size: number) => Buffer
      run: (input: Record<string, unknown>) => { status: number; signal: null; stdout?: string; stderr?: string }
    }) => void
    const canary = Buffer.alloc(16, 16).toString('hex')
    const secret = Buffer.alloc(32, 32).toString('hex')
    const observed: Array<Record<string, unknown>> = []
    verify({
      environment: {
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000',
      },
      executableAvailable: () => true,
      randomBytes(size) {
        return Buffer.alloc(size, size)
      },
      run(input) {
        const copy = {
          ...input,
          args: [...input.args as string[]],
          ...(input.input instanceof Buffer ? { input: input.input.toString('utf8') } : {}),
        }
        observed.push(copy)
        if ((input.args as string[])[0] === 'lookup') {
          return { status: 0, signal: null, stdout: secret }
        }
        return { status: 0, signal: null, stderr: '' }
      },
    })

    expect(observed).toHaveLength(3)
    expect(observed[0]).toMatchObject({
      executable: '/usr/bin/secret-tool',
      args: [
        'store',
        `--label=DSH Lark setup-preflight/${canary}`,
        'service', `dsh/lark/setup-preflight/${canary}`, 'account', 'setup-probe',
      ],
      input: secret,
      environment: {
        PATH: '/usr/bin:/bin',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        XDG_RUNTIME_DIR: '/run/user/1000',
      },
    })
    expect(observed[1]).toMatchObject({
      args: ['lookup', 'service', `dsh/lark/setup-preflight/${canary}`, 'account', 'setup-probe'],
      captureStdout: true,
    })
    expect(observed[2]).toMatchObject({
      args: ['clear', 'service', `dsh/lark/setup-preflight/${canary}`, 'account', 'setup-probe'],
    })
  })

  test('rejects a missing Linux secret-tool before running a canary command', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    expect(preflight).toBeTypeOf('function')
    let runCalls = 0

    expect(() => (preflight as (input: {
      environment: NodeJS.ProcessEnv
      executableAvailable: () => boolean
      run: () => never
    }) => void)({
      environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      executableAvailable: () => false,
      run() {
        runCalls += 1
        throw new Error('must not run')
      },
    })).toThrow(/cannot find \/usr\/bin\/secret-tool.*install libsecret-tools/iu)
    expect(runCalls).toBe(0)
  })

  test('rejects a missing Linux user D-Bus session before running a canary command', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    expect(preflight).toBeTypeOf('function')
    let runCalls = 0

    expect(() => (preflight as (input: {
      environment: NodeJS.ProcessEnv
      executableAvailable: () => boolean
      run: () => never
    }) => void)({
      environment: {},
      executableAvailable: () => true,
      run() {
        runCalls += 1
        throw new Error('must not run')
      },
    })).toThrow(/no user D-Bus session.*not via sudo or a detached SSH session/iu)
    expect(runCalls).toBe(0)
  })

  test('treats libsecret no-match clear as an idempotent cleanup success', async () => {
    const { isLinuxSecretServiceClearAbsent } = await import('../src/setup.ts')
    expect(isLinuxSecretServiceClearAbsent({ status: 1, signal: null, stderr: '' })).toBe(true)
    expect(isLinuxSecretServiceClearAbsent({
      status: 1,
      signal: null,
      stderr: 'Cannot spawn a message bus',
    })).toBe(false)
    expect(isLinuxSecretServiceClearAbsent({
      status: 1,
      signal: null,
      stderr: '',
      error: { code: 'ENOENT' },
    })).toBe(false)
  })

  test('does not report a cleanup failure when a failed canary store has no item to clear', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    const format = (lark as Record<string, unknown>).formatLarkSetupError
    expect(preflight).toBeTypeOf('function')
    expect(format).toBeTypeOf('function')
    const verify = preflight as (input: {
      environment: NodeJS.ProcessEnv
      executableAvailable: () => boolean
      randomBytes: (size: number) => Buffer
      run: (input: { args: readonly string[] }) => { status: number; signal: null; stderr: string }
    }) => void
    const secret = 'failed-canary-secret-must-not-appear'
    const canary = Buffer.alloc(16, 16).toString('hex')
    const commands: string[] = []
    let diagnostic: unknown
    try {
      verify({
        environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        executableAvailable: () => true,
        randomBytes(size) {
          return Buffer.alloc(size, size)
        },
        run(input) {
          commands.push(input.args[0]!)
          return input.args[0] === 'store'
            ? { status: 1, signal: null, stderr: `provider unavailable: ${secret}` }
            : { status: 1, signal: null, stderr: '' }
        },
      })
    } catch (error) {
      diagnostic = error
    }
    const output = (format as (error: unknown) => string)(diagnostic)

    expect(commands).toEqual(['store', 'clear'])
    expect(output).toContain('Linux Secret Service credential store failed')
    expect(output).not.toContain('canary cleanup also failed')
    expect(output).not.toContain(secret)
    expect(output).not.toContain(canary)
  })

  test('renders a credential-safe diagnostic when Linux credential store and cleanup both fail', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    const format = (lark as Record<string, unknown>).formatLarkSetupError
    expect(preflight).toBeTypeOf('function')
    expect(format).toBeTypeOf('function')
    const verify = preflight as (input: {
      environment: NodeJS.ProcessEnv
      executableAvailable: () => boolean
      randomBytes: (size: number) => Buffer
      run: () => { status: number; signal: null; stderr: string }
    }) => void
    const secret = 'must-not-appear-in-a-diagnostic'
    let diagnostic: unknown
    try {
      verify({
        environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        executableAvailable: () => true,
        randomBytes(size) {
          return Buffer.alloc(size, size)
        },
        run() {
          return { status: 1, signal: null, stderr: `provider error: ${secret}` }
        },
      })
    } catch (error) {
      diagnostic = error
    }
    const output = (format as (error: unknown) => string)(diagnostic)

    expect(output).toContain('preflight failed and canary cleanup also failed')
    expect(output).toContain('Linux Secret Service credential store failed')
    expect(output).toContain('Linux Secret Service credential cleanup failed')
    expect(output).not.toContain(secret)
  })

  test('preserves a static primary diagnostic when the canary cleanup runner throws', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    const format = (lark as Record<string, unknown>).formatLarkSetupError
    expect(preflight).toBeTypeOf('function')
    expect(format).toBeTypeOf('function')
    const primarySecret = 'primary-provider-secret-output'
    const cleanupSecret = 'cleanup-provider-secret-output'
    let diagnostic: unknown
    try {
      (preflight as (input: {
        environment: NodeJS.ProcessEnv
        executableAvailable: () => boolean
        randomBytes: (size: number) => Buffer
        run: (input: { args: readonly string[] }) => { status: number; signal: null; stderr: string }
      }) => void)({
        environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        executableAvailable: () => true,
        randomBytes(size) {
          return Buffer.alloc(size, size)
        },
        run(input) {
          if (input.args[0] === 'clear') throw new Error(cleanupSecret)
          return { status: 1, signal: null, stderr: primarySecret }
        },
      })
    } catch (error) {
      diagnostic = error
    }
    const output = (format as (error: unknown) => string)(diagnostic)

    expect(output).toContain('preflight failed and canary cleanup also failed')
    expect(output).toContain('Linux Secret Service credential store failed')
    expect(output).toContain('Linux Secret Service credential cleanup failed')
    expect(output).not.toContain(primarySecret)
    expect(output).not.toContain(cleanupSecret)
  })

  test('clears and redacts the canary when Secret Service readback differs', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    expect(preflight).toBeTypeOf('function')
    const returnedSecret = 'wrong-secret-must-not-appear'
    const commands: string[] = []
    let diagnostic: unknown
    try {
      (preflight as (input: {
        environment: NodeJS.ProcessEnv
        executableAvailable: () => boolean
        randomBytes: (size: number) => Buffer
        run: (input: { args: readonly string[] }) => {
          status: number; signal: null; stdout?: string; stderr: string
        }
      }) => void)({
        environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        executableAvailable: () => true,
        randomBytes(size) {
          return Buffer.alloc(size, size)
        },
        run(input) {
          commands.push(input.args[0]!)
          return input.args[0] === 'lookup'
            ? { status: 0, signal: null, stdout: returnedSecret, stderr: '' }
            : { status: 0, signal: null, stderr: '' }
        },
      })
    } catch (error) {
      diagnostic = error
    }
    const output = diagnostic instanceof Error ? diagnostic.message : String(diagnostic)

    expect(commands).toEqual(['store', 'lookup', 'clear'])
    expect(output).toContain('could not read back its generated test credential')
    expect(output).not.toContain(returnedSecret)
    expect(output).not.toContain(Buffer.alloc(16, 16).toString('hex'))
  })

  test('cleans the canary after a timed-out Linux Secret Service operation', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    const format = (lark as Record<string, unknown>).formatLarkSetupError
    expect(preflight).toBeTypeOf('function')
    expect(format).toBeTypeOf('function')
    const verify = preflight as (input: {
      environment: NodeJS.ProcessEnv
      executableAvailable: () => boolean
      randomBytes: (size: number) => Buffer
      run: (input: { args: readonly string[] }) => {
        status: null; signal: 'SIGTERM'; error: { code: 'ETIMEDOUT' }; stderr: string
      }
    }) => void
    const secret = 'timed-out-canary-must-not-appear'
    const canary = Buffer.alloc(16, 16).toString('hex')
    const commands: string[] = []
    let diagnostic: unknown
    try {
      verify({
        environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
        executableAvailable: () => true,
        randomBytes(size) {
          return Buffer.alloc(size, size)
        },
        run(input) {
          commands.push(input.args[0]!)
          return {
            status: null,
            signal: 'SIGTERM',
            error: { code: 'ETIMEDOUT' },
            stderr: `provider output: ${secret}`,
          }
        },
      })
    } catch (error) {
      diagnostic = error
    }
    const output = (format as (error: unknown) => string)(diagnostic)

    expect(commands).toEqual(['store', 'clear'])
    expect(output).toContain('preflight failed and canary cleanup also failed')
    expect(output).toContain('Linux Secret Service credential store did not respond')
    expect(output).toContain('Linux Secret Service credential cleanup did not respond')
    expect(output).not.toContain(secret)
    expect(output).not.toContain(canary)
  })

  test('clears the canary when its Linux Secret Service lookup fails', () => {
    const preflight = (lark as Record<string, unknown>).assertLinuxSecretServiceAvailable
    expect(preflight).toBeTypeOf('function')
    const verify = preflight as (input: {
      environment: NodeJS.ProcessEnv
      executableAvailable: () => boolean
      randomBytes: (size: number) => Buffer
      run: (input: { args: readonly string[] }) => { status: number; signal: null; stderr: string }
    }) => void
    const commands: string[] = []

    expect(() => verify({
      environment: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      executableAvailable: () => true,
      randomBytes(size) {
        return Buffer.alloc(size, size)
      },
      run(input) {
        commands.push(input.args[0]!)
        return {
          status: input.args[0] === 'lookup' ? 1 : 0,
          signal: null,
          stderr: '',
        }
      },
    })).toThrow('Linux Secret Service credential lookup failed')
    expect(commands).toEqual(['store', 'lookup', 'clear'])
  })

  test('runs credential preflight before journal recovery or cloud authorization', async () => {
    const providerForPlatform = (lark as Record<string, unknown>).credentialProviderForPlatform
    expect(providerForPlatform).toBeTypeOf('function')
    let observedProvider: unknown
    await expect(lark.runLarkSetup([
      '--profile', 'web', '--create-app', '--app-id', 'cli_0123456789abcdef', '--no-service',
    ], {
      preflightCredentialProvider(provider) {
        observedProvider = provider
        throw new Error('preflight stopped setup')
      },
      readEffectiveProfile() {
        throw new Error('profile recovery must not run before preflight')
      },
    })).rejects.toThrow('preflight stopped setup')
    expect(observedProvider).toBe((providerForPlatform as (platform: NodeJS.Platform) => unknown)(process.platform))
  })

  test('recognizes a package-bin symlink as the main CLI entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-setup-entry-'))
    const target = join(root, 'setup.js')
    const executable = join(root, 'dsh-lark-setup')
    await writeFile(target, '#!/usr/bin/env node\n')
    await symlink(target, executable)
    const isMainEntry = (lark as Record<string, unknown>).isMainEntry

    expect(isMainEntry).toBeTypeOf('function')
    expect((isMainEntry as (moduleUrl: string, argvPath: string) => boolean)(pathToFileURL(target).href, executable)).toBe(true)
  })
})
