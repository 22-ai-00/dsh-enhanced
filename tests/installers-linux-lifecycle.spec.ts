import { chmod, cp, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { createSystemdUserUnit } from '../plugins/lark-channel/src/systemd.ts'
import { classifyLifecycleScenario } from '../scripts/install/lifecycle-config.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { createInstallerFixtures } from './helpers/installer-fixtures.ts'

const {
  cleanupInstallerFixtures,
  repoRoot,
  installDirectory,
  localInstaller,
  npmInstaller,
  realBwrapUsable,
  digest64,
  supervisedManagedDependencies,
  runInstaller,
  temporaryDshHome,
  lifecycleFixture,
  rsiPairLifecycleFixture,
  lifecycleEnvironment,
  runLifecycle,
  runServiceLifecycle,
  startServiceLifecycle,
  lifecycleResult,
  withGuardianFixtureCleanup,
  startInstaller,
  startLifecycle,
  runRecovery,
  startRecovery,
  holdExternalLifecycleLock,
  waitForFile,
  readLifecycleDatabase,
  preservedLifecycleTransactions,
  readJsonLines,
  readLifecycleSystemdState,
  setLifecycleSystemdControls,
  readLifecycleSystemdLog,
  lifecycleIdentity,
  serviceLifecycleBinding,
  writeBoundLifecycleManifest,
} = createInstallerFixtures()

afterEach(cleanupInstallerFixtures)

describe('one-click installers', () => {
  // These invoke the Linux lifecycle executor itself: its systemd, /proc,
  // bwrap, renameat2, and flock contracts cannot be exercised on macOS.
  describe.skipIf(process.platform !== 'linux')('Linux lifecycle executor integration', () => {
  test('offline upgrade swaps one validated home while preserving custom configuration and durable task state', async () => {
    const f = await lifecycleFixture()
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(result.stdout).toContain('profile 生命周期事务完成：upgrade')
    await expect(readFile(`${f.dshHome}.dsh-enhanced-transaction/state`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const sandboxInvocations = await readJsonLines(f.bwrapLog)
    expect(sandboxInvocations).toHaveLength(8)
    for (const invocation of sandboxInvocations) {
      expect(invocation).toContain('--unshare-all')
      expect(invocation).not.toContain('--share-net')
      expect(invocation).toContain('--die-with-parent')
      expect(invocation).toContain('--new-session')
      expect(invocation).toEqual(expect.arrayContaining(['--ro-bind', '/', '/', '--tmpfs', '/tmp']))
      expect(invocation).toEqual(expect.arrayContaining([
        '--perms', '0400', '--ro-bind-data', '4', '/run/dsh-enhanced-lifecycle-config.mjs',
      ]))
      const bind = invocation.indexOf('--bind-fd')
      expect(invocation.slice(bind, bind + 3)).toEqual(['--bind-fd', '3', f.dshHome])
      const dshHomeVariable = invocation.findIndex((value, index) => value === 'DSH_HOME' && invocation[index - 1] === '--setenv')
      expect(invocation[dshHomeVariable + 1]).toBe(f.dshHome)
    }
  })

  test('offline upgrade leaves original home untouched after isolated activation fails', async () => {
    const f = await lifecycleFixture({ activationFails: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).toBe(`${f.dshHome}.dsh-enhanced-transaction`)
    const preservedManifest = JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8'))
    expect(preservedManifest).toMatchObject({ operation: 'upgrade', profile: 'web', state: 'failed' })
    expect(preservedManifest.failure).toContain('隔离 Host 激活失败')
    const stagedDatabase = join(preserved[0]!, 'staged-home', 'assistant-goals', 'web.sqlite')
    expect(readLifecycleDatabase(stagedDatabase)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(preserved[0]!, 'staged-home', '.activation-ran'), 'utf8')).toBe('')
  })

  test('offline upgrade leaves the original home untouched when package preparation fails before swap', async () => {
    const f = await lifecycleFixture()
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      activationMarker: f.activationMarker, packageFails: true,
    })

    expect(result.status).toBe(42)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test.each([
    '@dsh-enhanced/personal-assistant@1.4.0-rc.2',
    '@dsh-enhanced/personal-assistant@1.4.0+build.7',
  ])('lifecycle executor accepts exact prerelease or build npm spec %s', async target => {
    const f = await lifecycleFixture()

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', target], f.dshHome, f.fakeBin, {
      packageFails: true,
    })

    expect(result.status, result.stderr).toBe(42)
    expect(result.stderr).not.toContain('升级目标必须是本地绝对路径或精确版本')
    expect(await readFile(f.operationLog, 'utf8')).toContain(`\tplugin --profile web add ${target}\n`)
  })

  test.each([
    '@dsh-enhanced/personal-assistant@^1.4.0',
    '@dsh-enhanced/personal-assistant@1.4.x',
    '@dsh-enhanced/personal-assistant@latest',
    '@dsh-enhanced/personal-assistant@next',
  ])('lifecycle executor rejects range or tag npm spec %s before creating a transaction', async target => {
    const f = await lifecycleFixture()

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', target], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('升级目标必须是本地绝对路径或精确版本')
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('offline uninstall archives the complete old profile and preserves all external durable state', async () => {
    const f = await lifecycleFixture({ thirdParty: false })

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const current = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    expect(current.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    const archived = JSON.parse(await readFile(join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json'), 'utf8'))
    expect(archived.dependencies).toMatchObject({ '@dsh-enhanced/personal-assistant': '0.1.0' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'] })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    const repeated = runLifecycle(
      ['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'unsupported' },
    )
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(repeated.stdout).toContain('没有 @dsh-enhanced/* 顶层依赖')
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
  })

  test('uninstall activation failure leaves the original home unchanged and keeps its archive only in staged evidence', async () => {
    const f = await lifecycleFixture({ activationFails: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')
    const sessionBefore = await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe(sessionBefore)
    await expect(stat(join(f.dshHome, 'uninstalled-profiles'))).rejects.toMatchObject({ code: 'ENOENT' })

    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toEqual([`${f.dshHome}.dsh-enhanced-transaction`])
    const stagedHome = join(preserved[0]!, 'staged-home')
    const stagedArchives = await readdir(join(stagedHome, 'uninstalled-profiles'))
    expect(stagedArchives).toHaveLength(1)
    const archived = JSON.parse(await readFile(
      join(stagedHome, 'uninstalled-profiles', stagedArchives[0]!, 'package.json'), 'utf8',
    ))
    expect(archived.dependencies).toMatchObject({ '@dsh-enhanced/personal-assistant': '0.1.0' })
    expect(readLifecycleDatabase(join(stagedHome, 'assistant-goals', 'web.sqlite'))).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
  })

  test('uninstall fails closed without changing a profile that has third-party bundles', async () => {
    const f = await lifecycleFixture({ thirdParty: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/third-party|第三方/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test('upgrade fails closed without changing a profile that has a third-party bundle', async () => {
    const f = await lifecycleFixture({ thirdParty: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/third-party|第三方/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(f.dshLog, 'utf8')).toContain('CALL\t--profile\tweb\t--dump-config\n')
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])
  })

  test('upgrade rejects an ordinary dependency activated as a third-party composed row', async () => {
    const f = await lifecycleFixture({ thirdPartyDependency: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      configAfterUpgrade: '- id: owner-local-plugin\n  name: owner-library\n  config:\n    dataDir: /srv/owner-state',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('rejects enabled non-first-party row owner-local-plugin')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('refuses unbound legacy transaction residue without renaming or deleting unknown homes', async () => {
    const f = await lifecycleFixture()
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    await mkdir(transaction, { mode: 0o700 })
    await writeFile(join(transaction, 'state'), 'swapped\n')
    await rename(f.dshHome, join(transaction, 'original-home'))
    await mkdir(f.dshHome)
    await writeFile(join(f.dshHome, 'failed-new-home'), 'partial')

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unbound|绑定|未知|manifest/iu)
    expect(await readFile(join(f.dshHome, 'failed-new-home'), 'utf8')).toBe('partial')
    expect(readLifecycleDatabase(join(transaction, 'original-home', 'assistant-goals', 'web.sqlite'))).toEqual({
      userVersion: 1, values: ['durable-goal-state'],
    })
  })

  test('bound recovery refuses a manifest carrying an unknown top-level field even with a valid digest (F10)', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const manifest = await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: f.dshHome, state: 'preparing',
    })
    // 未知顶层键不进 bindingFor 白名单，因此重算 digest 仍自洽——这正是信封盲区。
    const smuggled = { ...manifest, smuggledPolicy: { execute: 'arbitrary' } }
    await writeFile(join(transaction, 'manifest.json'), `${JSON.stringify(smuggled, null, 2)}\n`, { mode: 0o600 })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/校验失败|未绑定/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
  })

  test.each(['preparing', 'failed'] as const)('bound %s recovery preserves evidence while leaving the original home intact', async state => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'failed-stage-marker'), state)
    await writeBoundLifecycleManifest({ dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    expect(await readFile(join(preserved[0]!, 'staged-home', 'failed-stage-marker'), 'utf8')).toBe(state)
    const manifest = JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ state, originalIdentity })
  })

  test('bound original-renamed recovery restores an absent home from the original backup', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, state: 'original-renamed', originalIdentity,
    })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('已恢复原 DSH_HOME')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    await expect(readFile(join(preserved[0]!, 'original-home', 'profiles', 'web', 'package.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('bound swapped recovery restores the original and keeps the failed staged home as evidence', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const stagedHome = join(transaction, 'staged-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await mkdir(stagedHome)
    await mkdir(join(stagedHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(stagedHome, '.lifecycle-dump-config'), stringify([
      { id: 'dsh-enhanced-assistant-web-owner', name: '@dsh-enhanced/assistant-web-owner' },
    ]))
    await writeFile(join(stagedHome, 'staged-marker'), 'failed staged home')
    const stagedIdentity = await lifecycleIdentity(stagedHome)
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, stagedHome, state: 'swapped', originalIdentity, stagedIdentity,
    })
    await rename(stagedHome, f.dshHome)

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('原 DSH_HOME 已恢复')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(preserved[0]!, 'failed-home', 'staged-marker'), 'utf8')).toBe('failed staged home')
  })

  test('bound v1 committed recovery without transactionIdentity removes its backup and transaction', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const stagedHome = join(transaction, 'staged-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await cp(backupHome, stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'committed-marker'), 'keep live')
    const stagedIdentity = await lifecycleIdentity(stagedHome)
    const stagedProfileDigest = createHash('sha256')
      .update(await readFile(join(stagedHome, 'profiles', 'web', 'package.json')))
      .digest('hex')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, stagedHome, state: 'committed',
      includeTransactionIdentity: false, originalIdentity, stagedIdentity, stagedProfileDigest,
    })
    const committedManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(committedManifest).not.toHaveProperty('transactionIdentity')
    await rename(stagedHome, f.dshHome)
    expect(await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')).toContain(
      'dsh-enhanced-assistant-web-owner',
    )

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已完成上次提交后的绑定清理')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(stagedIdentity)
    expect(await readFile(join(f.dshHome, 'committed-marker'), 'utf8')).toBe('keep live')
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])
  })

  test('bound v1 cleanup tombstone survives partial deletion and retries without a complete backup tree', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const stagedHome = join(transaction, 'staged-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await cp(backupHome, stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'committed-marker'), 'keep live')
    const stagedIdentity = await lifecycleIdentity(stagedHome)
    const stagedProfileDigest = createHash('sha256')
      .update(await readFile(join(stagedHome, 'profiles', 'web', 'package.json'))).digest('hex')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, stagedHome, state: 'committed',
      includeTransactionIdentity: false, originalIdentity, stagedIdentity, stagedProfileDigest,
    })
    await rename(stagedHome, f.dshHome)

    const crashed = runRecovery('web', f.dshHome, f.fakeBin, { crashDuringCleanup: true })
    expect(crashed.status).not.toBe(0)
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      version: 1, state: 'cleanup-started',
      cleanup: { protocol: 'dsh-enhanced/service-cleanup/v1', phase: 'deleting' },
    })
    await expect(stat(join(transaction, manifest.cleanup.tombstoneName, 'profiles')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const recovered = runRecovery('web', f.dshHome, f.fakeBin)
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(await readFile(join(f.dshHome, 'committed-marker'), 'utf8')).toBe('keep live')
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([
    ['inode', { inode: true, digest: false }],
    ['digest', { inode: false, digest: true }],
  ] as const)('bound recovery fails closed on an original %s mismatch', async (_kind, mismatch) => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const markerPath = join(transaction, 'staged-home', 'evidence')
    await mkdir(dirname(markerPath), { recursive: true })
    await writeFile(markerPath, 'untouched evidence')
    const actualIdentity = await lifecycleIdentity(f.dshHome)
    const originalIdentity = mismatch.inode ? { ...actualIdentity, ino: String(BigInt(actualIdentity.ino) + 1n) } : actualIdentity
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome,
      originalHome: f.dshHome,
      stagedHome: dirname(markerPath),
      state: 'failed',
      originalIdentity,
      originalProfileDigest: mismatch.digest ? '0'.repeat(64) : undefined,
    })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(mismatch.inode ? /身份未知|拒绝重命名|inode/iu : /摘要不匹配|digest/iu)
    expect(await readFile(markerPath, 'utf8')).toBe('untouched evidence')
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([transaction])
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test('a concurrent lifecycle operation is refused while preparation holds the home lock and leaves the original untouched', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const first = startLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageBlock: true })
    const stagedHome = join(`${f.dshHome}.dsh-enhanced-transaction`, 'staged-home')
    await waitForFile(join(stagedHome, '.package-preparation-started'))

    const second = startLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
    const observedSecond = await Promise.race([
      second.done,
      new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
    ])
    await writeFile(join(stagedHome, '.package-preparation-release'), '')
    const secondResult = observedSecond ?? await second.done
    expect(observedSecond, 'the contender must fail immediately rather than wait for the lock').toBeDefined()
    expect(secondResult.status).not.toBe(0)
    expect(secondResult.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })

    const firstResult = await first.done
    expect(firstResult.status, firstResult.stderr).toBe(0)
  })

  test('an externally held lifecycle lock is nonblocking and covers recovery before any residue is moved', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const residueMarker = join(transaction, 'legacy-residue')
    await mkdir(transaction, { mode: 0o700 })
    await writeFile(residueMarker, 'must-not-move')
    const lock = await holdExternalLifecycleLock(`${f.dshHome}.dsh-enhanced-lifecycle.lock`)

    try {
      const recovery = startRecovery('web', f.dshHome, f.fakeBin)
      const result = await Promise.race([
        recovery.done,
        new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
      ])

      expect(result, 'recovery must fail rather than wait for an externally owned lock').toBeDefined()
      expect(result!.status).not.toBe(0)
      expect(result!.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
      expect(await readFile(residueMarker, 'utf8')).toBe('must-not-move')
      expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([transaction])
    } finally {
      await lock.release()
    }
  })

  test('post-upgrade structural validation rejects a newly introduced external state path before activation or swap', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      configAfterUpgrade: "- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'\n- id: newly-installed-state\n  name: '@dsh-enhanced/personal-assistant'\n  config:\n    statePath: /srv/newly-installed/state.json",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects newly-installed-state.statePath: resolves outside canonical DSH_HOME')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(preserved[0]!, 'staged-home', '.lifecycle-dump-config'), 'utf8')).toContain('/srv/newly-installed/state.json')
  })

  test('rejects a descendant symlink escape before a staged package command can write outside DSH_HOME', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const outsideDirectory = join(f.root, 'outside')
    const outsideWrite = join(outsideDirectory, 'escape.txt')
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, join(f.dshHome, 'escape-link'))

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      packageWriteRelative: 'escape-link/escape.txt',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/symbolic|symlink|符号链接/iu)
    await expect(readFile(outsideWrite, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])
  })

  test.each([
    ['a newly created', 'profiles/web/node_modules/new-external', false],
    ['a changed existing', 'profiles/web/node_modules/existing-external', true],
  ] as const)('post-package scan rejects %s external package symlink and leaves the original home unchanged',
    async (_kind, packageSymlinkRelative, existing) => {
      const f = await lifecycleFixture()
      const firstExternal = join(f.root, 'external-package-a')
      const secondExternal = join(f.root, 'external-package-b')
      await mkdir(firstExternal)
      await mkdir(secondExternal)
      if (existing) {
        await mkdir(dirname(join(f.dshHome, packageSymlinkRelative)), { recursive: true })
        await symlink(firstExternal, join(f.dshHome, packageSymlinkRelative))
      }
      const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

      const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
        packageSymlinkRelative,
        packageSymlinkTarget: secondExternal,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/symbolic link|symlink|符号链接|外链/iu)
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toEqual([`${f.dshHome}.dsh-enhanced-transaction`])
      expect(await realpath(join(preserved[0]!, 'staged-home', packageSymlinkRelative))).toBe(secondExternal)
      if (existing) expect(await realpath(join(f.dshHome, packageSymlinkRelative))).toBe(firstExternal)
      else await expect(stat(join(f.dshHome, packageSymlinkRelative))).rejects.toMatchObject({ code: 'ENOENT' })
    })

  test('post-package scan allows an unchanged existing external pnpm package symlink', async () => {
    const f = await lifecycleFixture()
    const externalPackage = join(f.root, 'pnpm-store-package')
    const packageLink = join(f.profileDirectory, 'node_modules', 'existing-external')
    await mkdir(externalPackage)
    await mkdir(dirname(packageLink), { recursive: true })
    await symlink(externalPackage, packageLink)

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(await realpath(packageLink)).toBe(externalPackage)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
  })

  test('rejects a hardlink with a directory entry outside DSH_HOME before the staged package command', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const outsideFile = join(f.root, 'outside-state')
    const insideLink = join(f.dshHome, 'linked-state')
    await writeFile(outsideFile, 'outside must remain unchanged')
    await link(outsideFile, insideLink)

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/hardlink|硬链接|连接到快照外部/iu)
    expect(await readFile(outsideFile, 'utf8')).toBe('outside must remain unchanged')
    expect(await readFile(insideLink, 'utf8')).toBe('outside must remain unchanged')
    expect(await readFile(f.dshLog, 'utf8')).toContain('CALL\t--profile\tweb\t--dump-config\n')
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  })

  test.skipIf(!realBwrapUsable)('real bwrap mounts a /tmp staged home by fd at the logical DSH_HOME after /tmp isolation', async () => {
    // The regression specifically hides /tmp, regardless of the host TMPDIR.
    const root = await temporaryDshHome('/tmp')
    const logicalHome = join(root, 'logical-home')
    const stagedHome = join(root, 'staged-home')
    await mkdir(stagedHome)
    await writeFile(join(stagedHome, 'mounted-marker'), 'staged')
    const stagedHandle = await open(stagedHome, 'r')

    try {
      const result = spawnSync('/usr/bin/bwrap', [
        '--unshare-all', '--die-with-parent', '--new-session',
        '--ro-bind', '/', '/',
        '--tmpfs', '/tmp', '--tmpfs', '/run',
        '--dir', logicalHome,
        '--bind-fd', '3', logicalHome,
        '--proc', '/proc', '--dev', '/dev',
        '--chdir', '/tmp', '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'HOME', '/tmp',
        '--setenv', 'TMPDIR', '/tmp',
        '--setenv', 'DSH_HOME', logicalHome,
        '--', '/bin/sh', '-c', 'test "$DSH_HOME" = "$1" && test "$(cat "$DSH_HOME/mounted-marker")" = staged && printf "%s\n" "$DSH_HOME"',
        'bwrap-smoke', logicalHome,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', stagedHandle.fd], timeout: 5_000 })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`${logicalHome}\n`)
    } finally {
      await stagedHandle.close()
    }
  })

  test.skipIf(!realBwrapUsable)('real bwrap executes a /tmp validator through ro-bind-data after /tmp is hidden', async () => {
    // The regression specifically hides /tmp, regardless of the host TMPDIR.
    const root = await temporaryDshHome('/tmp')
    const validatorPath = join(root, 'validator.mjs')
    await writeFile(validatorPath, [
      "import { readFileSync } from 'node:fs'",
      "if (readFileSync(import.meta.filename, 'utf8').includes('validator-through-fd')) {",
      "  process.stdout.write('validator-through-fd\\n')",
      '}',
      '// validator-through-fd',
      '',
    ].join('\n'))
    const validatorHandle = await open(validatorPath, 'r')

    try {
      const result = spawnSync('/usr/bin/bwrap', [
        '--unshare-all', '--die-with-parent', '--new-session',
        '--ro-bind', '/', '/',
        '--tmpfs', '/tmp', '--tmpfs', '/run',
        '--perms', '0400', '--ro-bind-data', '3', '/run/validator.mjs',
        '--proc', '/proc', '--dev', '/dev',
        '--chdir', '/tmp', '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--', process.execPath, '/run/validator.mjs',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', validatorHandle.fd], timeout: 5_000 })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('validator-through-fd\n')
    } finally {
      await validatorHandle.close()
    }
  })

  test('installer upgrade targets only existing managed dependencies and preserves third-party dependencies', async () => {
    const f = await lifecycleFixture({
      managedDependencies: ['personal-assistant', 'assistant-goals'],
      thirdParty: false,
      thirdPartyDependency: true,
    })
    const manifestBefore = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))

    const result = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--dry-run',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm --dir')
    expect(result.stdout).toContain('install --offline --frozen-lockfile')
    expect(result.stdout).toContain('dsh plugin --profile web add')
    for (const target of [
      join(repoRoot, 'plugins', 'personal-assistant'),
      join(repoRoot, 'plugins', 'assistant-goals'),
    ]) expect(result.stdout).toContain(target)
    for (const absent of ['plugin-control-plane', 'assistant-delivery', 'assistant-web-owner']) {
      expect(result.stdout).not.toContain(join(repoRoot, 'plugins', absent))
    }
    expect(JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))).toEqual(manifestBefore)
  })

  test('npm lifecycle dry-run upgrades only existing managed names at one exact version', async () => {
    const f = await lifecycleFixture({
      managedDependencies: ['personal-assistant', 'assistant-goals'],
      thirdPartyDependency: true,
    })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0', '--dry-run',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('只由完整本地仓库安装器提供')
    expect(result.stdout).toContain('npm cohort（dry-run）：将核验所有 bundle 都已发布为 1.4.0')
    expect(result.stdout).toContain('@dsh-enhanced/personal-assistant@1.4.0')
    expect(result.stdout).toContain('@dsh-enhanced/assistant-goals@1.4.0')
    for (const absent of ['plugin-control-plane', 'assistant-delivery', 'assistant-web-owner']) {
      expect(result.stdout).not.toContain('@dsh-enhanced/' + absent + '@1.4.0')
    }
    expect(result.stdout).not.toContain('owner-library@1.4.0')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
  })

  test('npm upgrade prepares, verifies, fetches, and installs its exact metadata cohort transactionally', async () => {
    const f = await lifecycleFixture()
    const version = '1.4.0-rc.2+build.7'
    const target = `@dsh-enhanced/personal-assistant@${version}`
    const packageBefore = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    const workspaceBefore = await readFile(join(f.profileDirectory, 'pnpm-workspace.yaml'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', version,
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { npmVersion: version }))

    expect(result.status, result.stderr).toBe(0)
    const operations = (await readFile(f.operationLog, 'utf8')).trim().split('\n')
    expect(operations.slice(0, 2)).toEqual([
      `npm-view\tabsent\tview ${target} version --json`,
      `npm-view\tabsent\tview ${target} version --json`,
    ])
    const preparation = operations.find(line => line.startsWith('pnpm-prepare\tabsent\t'))
    expect(preparation).toContain(`add --lockfile-only --save-exact ${target}`)
    expect(preparation).toMatch(/ignore=true\tstore=.+\tcache=.+/u)
    expect(preparation).not.toContain(`cwd=${f.dshHome}`)
    expect(operations.find(line => line.startsWith('pnpm-verify\tabsent\t'))).toContain('install --lockfile-only --frozen-lockfile')
    expect(operations.find(line => line.startsWith('pnpm-fetch\tabsent\t'))).toContain('fetch --frozen-lockfile')
    expect(operations.find(line => line.startsWith('pnpm-offline-install\tpresent\t'))).toContain('install --offline --frozen-lockfile')
    expect(operations.some(line => line.startsWith('pnpm-store-add') || line.startsWith('dsh-add'))).toBe(false)
    const packageAfter = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    expect(packageAfter.dependencies['@dsh-enhanced/personal-assistant']).toBe(version)
    expect(packageAfter.dsh).toEqual(packageBefore.dsh)
    expect(await readFile(join(f.profileDirectory, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspaceBefore)
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toContain(`"${target}"`)
  })

  test('npm upgrade without a coordinator refuses a frozen local cohort before registry access', async () => {
    const f = await lifecycleFixture()
    const cohortRoot = join(f.dshHome, 'rsi-local-cohorts', 'web')
    await mkdir(join(cohortRoot, 'artifacts'), { recursive: true })
    await writeFile(join(cohortRoot, 'receipt.json'), '{"frozen":true}\n')
    await writeFile(join(cohortRoot, 'artifacts', 'bundle.tgz'), 'frozen artifact')
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { npmVersion: '1.4.0' }))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('源码/制品收据迁移')
    expect(await readFile(f.operationLog, 'utf8')).not.toMatch(/npm-view|pnpm-prepare|dsh-add/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(cohortRoot, 'receipt.json'), 'utf8')).toBe('{"frozen":true}\n')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('npm upgrade uses an isolated metadata preparation directory and a fd-bound frozen offline store', async () => {
    const f = await lifecycleFixture({
      temporaryParent: '/tmp', // This case exercises the hidden-/tmp store/cache fd mount contract.
      requirePnpmStore: true, requirePnpmFrozenStore: true, requirePnpmStoreFd: true, requirePnpmProfileCwd: true,
    })
    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, {
      pnpmfileMustNotRun: true, requirePnpmProfileCwd: true, requirePnpmStoreFd: true,
    }))

    expect(result.status, result.stderr).toBe(0)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).toMatch(/^pnpm-prepare\tabsent\tcwd=(?!.*profiles\/web).*\tignore=true\tstore=.+\tcache=.+/mu)
    expect(operations).toMatch(/^pnpm-verify\tabsent\t.*install --lockfile-only --frozen-lockfile/mu)
    expect(operations).toMatch(/^pnpm-fetch\tabsent\t.*fetch --frozen-lockfile/mu)
    expect(operations).toMatch(/^pnpm-offline-install\tpresent\t.*install --offline --frozen-lockfile/mu)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
  })

  test('npm upgrade keeps its lifecycle lock while npm view is blocked and a contender fails busy before any transaction', async () => {
    const f = await lifecycleFixture()
    const args = [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0',
    ]
    const first = startInstaller(npmInstaller, args, f.dshHome, f.fakeBin, { npmBlock: true })
    await waitForFile(join(f.root, 'npm-block-started'))
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })

    const second = startInstaller(npmInstaller, args, f.dshHome, f.fakeBin)
    const observedSecond = await Promise.race([
      second.done,
      new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
    ])

    expect(observedSecond, 'the contender must fail immediately while npm view holds the lifecycle lock').toBeDefined()
    expect(observedSecond!.status).not.toBe(0)
    expect(observedSecond!.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(f.operationLog, 'utf8')).match(/^npm-view/mgu)).toHaveLength(1)

    await writeFile(join(f.root, 'npm-block-release'), '')
    const firstResult = await first.done
    expect(firstResult.status, firstResult.stderr).toBe(0)
  })

  test.each([
    ['group-writable DSH_HOME parent', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => dirname(f.dshHome), 0o020],
    ['other-writable DSH_HOME parent', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => dirname(f.dshHome), 0o002],
    ['group-writable DSH_HOME', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.dshHome, 0o020],
    ['other-writable DSH_HOME', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.dshHome, 0o002],
    ['group-writable profile', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.profileDirectory, 0o020],
    ['other-writable profile', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.profileDirectory, 0o002],
  ] as const)('npm upgrade rejects %s before registry access', async (_label, selectedPath, writableBit) => {
    const f = await lifecycleFixture()
    const unsafePath = selectedPath(f)
    const originalMode = (await stat(unsafePath)).mode & 0o777
    await chmod(unsafePath, originalMode | writableBit)

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/writable|permission|权限|写入|不可写|不安全/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([
    ['preparation', { npmPrepareFails: true }, 'pnpm-prepare', 'metadata preparation failed'],
    ['verification', { npmVerifyFails: true }, 'pnpm-verify', 'metadata verification failed'],
    ['prefetch', { storeFails: true }, 'pnpm-fetch', 'metadata prefetch failed'],
  ] as const)('npm upgrade %s failure leaves all original state untouched and never creates a transaction', async (_phase, options, phaseLog, errorText) => {
    const f = await lifecycleFixture()
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')
    const sessionBefore = await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, options))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(errorText)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).toContain(`${phaseLog}\tabsent\t`)
    expect(operations).not.toContain('pnpm-offline-install\tpresent\t')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe(sessionBefore)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.activationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    const dshCalls = await readFile(f.dshLog, 'utf8')
    expect(dshCalls).toContain('CALL\t--version\n')
    expect(dshCalls).not.toContain('\tplugin\t')
    expect(dshCalls).not.toContain('\t--host\t')
  })

  test.each([
    'tarballUrlBinding',
    'resolutionShapeCheck',
    'dependencyAliasCheck',
  ] as const)('npm upgrade rejects a verification receipt without %s before creating a transaction', async policyFlag => {
    const f = await lifecycleFixture()
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const lockfileBefore = await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { npmReceiptMissingPolicy: policyFlag }))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/final verification.*(?:tarball|resolution|alias)|verification cache/iu)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).toContain('pnpm-verify\tabsent\t')
    expect(operations).toContain('pnpm-fetch\tabsent\t')
    expect(operations).not.toContain('pnpm-offline-install\tpresent\t')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfileBefore)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.activationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm upgrade preserves an external source metadata mutation observed during preparation', async () => {
    const f = await lifecycleFixture()
    const lockfileBefore = await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { npmSourceMetadataMutation: true }))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/metadata|identity|changed|变化/iu)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).toContain('pnpm-prepare\tabsent\t')
    expect(operations).not.toContain('pnpm-offline-install\tpresent\t')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))).toMatchObject({ externalMutation: 'preserve' })
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfileBefore)
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.activationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm upgrade rejects a staged registry configuration drift before offline install or commit', async () => {
    const f = await lifecycleFixture()
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const lockfileBefore = await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')
    const databaseBefore = readLifecycleDatabase(f.databasePath)

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { npmSandboxRegistryDrift: true }))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/effective configuration changed|cannot be reproduced|configuration/iu)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).toContain('pnpm-fetch\tabsent\t')
    expect(operations).not.toContain('pnpm-offline-install\tpresent\t')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(f.profileDirectory, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfileBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual(databaseBefore)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.activationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm upgrade detaches and restores an external Host peer fallback before offline pnpm materialization', async () => {
    const f = await lifecycleFixture()
    const externalPeer = join(f.root, 'host-peer-fallback')
    const peerLink = join(f.profileDirectory, 'node_modules', '@dsh-enhanced', 'lark-channel')
    const unexpectedBin = join(f.root, 'outside-bin', 'lark-channel')
    await mkdir(externalPeer, { recursive: true })
    await writeFile(join(externalPeer, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/lark-channel', version: '0.1.0' }))
    await mkdir(dirname(peerLink), { recursive: true })
    await symlink(externalPeer, peerLink)

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { npmPeerExternalBin: unexpectedBin }))

    expect(result.status, result.stderr).toBe(0)
    expect(await realpath(peerLink)).toBe(externalPeer)
    await expect(stat(unexpectedBin)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
    await expect(stat(f.activationMarker)).resolves.toBeDefined()
    expect(await readFile(f.dshLog, 'utf8')).toContain('CALL\t--profile\tweb\t--host\t127.0.0.1\t--no-open\t--port\t0\n')
  })

  test('npm upgrade rejects workspace configDependencies before pnpm store resolution or metadata preparation', async () => {
    const f = await lifecycleFixture()
    const marker = join(f.root, 'pnpm-store-would-execute')
    await writeFile(join(f.profileDirectory, 'pnpm-workspace.yaml'), 'packages:\n  - .\nconfigDependencies:\n  unsafe-bootstrap: 1\n')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { pnpmStoreMarker: marker }))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/configDependencies|metadata|配置/iu)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).not.toContain('pnpm-prepare\tabsent\t')
    expect(operations).not.toContain('pnpm-store-add\tabsent\t')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm upgrade recovers an old transaction and returns before registry or store access', async () => {
    const f = await lifecycleFixture()
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'recovered-evidence'), 'preserve')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state: 'failed',
    })

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/未.*(?:package|registry|store).*mutation|未访问 npm registry/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    expect(await readFile(join(preserved[0]!, 'staged-home', 'recovered-evidence'), 'utf8')).toBe('preserve')
  })

  test('npm upgrade through a canonical home symlink recovers residue without registry access', async () => {
    const f = await lifecycleFixture()
    const homeAlias = join(f.root, 'home-alias')
    await symlink(f.dshHome, homeAlias)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'canonical-recovery-evidence'), 'preserve')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state: 'failed',
    })

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
    ], homeAlias, undefined, lifecycleEnvironment(homeAlias, f.fakeBin))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/本次未访问 npm registry|本次未开始新的 package、registry、store/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    expect(await readFile(join(preserved[0]!, 'staged-home', 'canonical-recovery-evidence'), 'utf8')).toBe('preserve')
  })

  test('npm uninstall skips registry cohort resolution and pnpm store prefetch', async () => {
    const f = await lifecycleFixture()

    const result = runInstaller(npmInstaller, [
      '--operation', 'uninstall', '--scenario', 'web', '--confirm-dsh-home-stopped',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
  })

  test('supervised uninstall does not require pnpm to be installed', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const runtimeBin = join(f.root, 'runtime-without-pnpm')
    await mkdir(runtimeBin)
    await symlink(process.execPath, join(runtimeBin, 'node'))
    for (const executable of ['bwrap', 'dsh', 'journalctl', 'systemctl']) {
      await symlink(join(f.fakeBin, executable), join(runtimeBin, executable))
    }
    for (const executable of [
      'awk', 'basename', 'cat', 'chmod', 'cp', 'dirname', 'flock', 'grep', 'head', 'id', 'mktemp', 'npm', 'readlink',
      'realpath', 'rm', 'sed', 'sort', 'stat', 'tail', 'tr', 'uname',
    ]) {
      const resolved = spawnSync('/bin/bash', ['-c', `command -v ${executable}`], { encoding: 'utf8' }).stdout.trim()
      await symlink(resolved, join(runtimeBin, executable))
    }
    const environment = {
      ...lifecycleEnvironment(f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }),
      PATH: runtimeBin,
    }
    expect(spawnSync('/bin/bash', ['-c', 'command -v pnpm'], { encoding: 'utf8', env: environment }).status).not.toBe(0)

    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'uninstall', '--scenario', 'supervised', '--confirm-dsh-home-stopped',
    ], f.dshHome, undefined, environment)

    expect(result.status, result.stderr).toBe(0)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('upgrade and uninstall require explicit supported lifecycle scenarios and stopped-home confirmation', async () => {
    const dshHome = await temporaryDshHome()
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), '{}')

    const missingConfirmation = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'web', '--dry-run'], dshHome)
    expect(missingConfirmation.status).toBe(2)
    expect(missingConfirmation.stderr).toContain('--confirm-dsh-home-stopped')
    const hostChange = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--dsh-version', '0.1.2-rc.1', '--dry-run'], dshHome)
    expect(hostChange.status).toBe(2)
    expect(hostChange.stderr).toContain('不会修改全局 DSH')
  })

  test('Linux service lifecycle admits Lark upgrade/uninstall and supervised upgrade/uninstall', async () => {
    const f = await lifecycleFixture({ systemd: {} })
    const supervisedFixture = await lifecycleFixture({ systemd: {}, effectiveScenario: 'supervised' })
    const commonArgs = ['--confirm-dsh-home-stopped', '--dry-run']

    const larkUpgrade = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', 'lark', ...commonArgs,
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))
    const supervisedUpgrade = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', 'supervised', ...commonArgs,
    ], supervisedFixture.dshHome, 'Linux', lifecycleEnvironment(supervisedFixture.dshHome, supervisedFixture.fakeBin))
    const larkUninstall = runInstaller(localInstaller, [
      '--operation', 'uninstall', '--scenario', 'lark', ...commonArgs,
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))
    const supervisedUninstall = runInstaller(localInstaller, [
      '--operation', 'uninstall', '--scenario', 'supervised', ...commonArgs,
    ], supervisedFixture.dshHome, 'Linux', lifecycleEnvironment(
      supervisedFixture.dshHome, supervisedFixture.fakeBin, { expectedScenario: 'supervised' },
    ))

    expect(larkUpgrade.status, larkUpgrade.stderr).toBe(0)
    expect(larkUpgrade.stdout).toContain('Lark service-aware upgrade (Linux systemd --user)')
    expect(larkUpgrade.stdout).toContain('canonical DSH_HOME, runtime-mask them, stop them, and verify PID quiescence')
    expect(larkUpgrade.stdout).toContain('fresh InvocationID journal readiness and stability before backup cleanup')
    expect(larkUpgrade.stdout).toContain('preserve both homes plus the bound manifest without automatic rollback')
    expect(supervisedUpgrade.status, supervisedUpgrade.stderr).toBe(0)
    expect(supervisedUpgrade.stdout).toContain('supervised service-aware upgrade (Linux systemd --user)')
    expect(supervisedUpgrade.stdout).toContain('fresh nonce/catalog-bound Recovery preview')
    expect(supervisedUpgrade.stdout).toContain('newer exact active attestation')
    expect(supervisedUninstall.status, supervisedUninstall.stderr).toBe(0)
    expect(supervisedUninstall.stdout).toContain('Supervised service-aware uninstall (Linux systemd --user)')
    expect(supervisedUninstall.stdout).toMatch(/archive.*complete old profile|完整.*归档/iu)
    expect(supervisedUninstall.stdout).toMatch(/do not actively delete.*profile-external|不主动清除.*profile.*外/iu)
    expect(larkUninstall.status, larkUninstall.stderr).toBe(0)
    expect(larkUninstall.stdout).toContain('Lark service-aware uninstall (Linux systemd --user)')
    expect(larkUninstall.stdout).toContain('Archive the complete old profile and activate a clean Web profile')
    expect(larkUninstall.stdout).toContain('Restart only the previously active units')
    expect(larkUninstall.stdout).toContain('Preserve units, credentials, owner binding, Sessions, Goals and external durable state')
    expect(await readFile(f.systemdLog, 'utf8')).toBe('')
  })

  test.each([
    ['install', { localInstallFails: true }, 71, 'local fixture pnpm install failed'],
    ['build', { localBuildFails: true }, 72, 'local fixture pnpm build failed'],
  ] as const)('local upgrade returns the repository %s failure before lifecycle mutation', async (_phase, options, code, message) => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const sessionBefore = await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')

    const result = runInstaller(join(f.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin, options))

    expect(result.status).toBe(code)
    expect(result.stderr).toContain(message)
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe(sessionBefore)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    const dshCalls = await readFile(f.dshLog, 'utf8')
    expect(dshCalls).not.toContain('\tplugin\t')
  }, 15_000)

  test.each(['local', 'npm'] as const)(
    '%s lifecycle entry rejects unsupported service modes before systemd, transaction, or registry work',
    async source => {
      for (const dryRun of [false, true]) {
        for (const rejected of [
          { operation: 'upgrade', scenario: 'supervised', extra: ['--no-service'], platform: 'Linux' },
          { operation: 'uninstall', scenario: 'supervised', extra: ['--no-service'], platform: 'Linux' },
          { operation: 'upgrade', scenario: 'lark', extra: ['--no-service'], platform: 'Linux' },
          { operation: 'uninstall', scenario: 'lark', extra: ['--no-service'], platform: 'Linux' },
          { operation: 'uninstall', scenario: 'supervised', extra: [] as string[], platform: 'Darwin' },
          { operation: 'uninstall', scenario: 'lark', extra: [] as string[], platform: 'Darwin' },
        ]) {
          const f = await lifecycleFixture({ systemd: {} })
          const script = source === 'local' ? localInstaller : npmInstaller
          const result = runInstaller(script, [
            '--operation', rejected.operation, '--scenario', rejected.scenario,
            '--confirm-dsh-home-stopped', '--yes', ...rejected.extra, ...(dryRun ? ['--dry-run'] : []),
          ], f.dshHome, rejected.platform, lifecycleEnvironment(f.dshHome, f.fakeBin))

          expect(result.status, `${source} ${dryRun ? 'dry' : 'live'} ${rejected.scenario} ${rejected.operation}: ${result.stderr}`).toBe(2)
          expect(await readFile(f.operationLog, 'utf8')).toBe('')
          expect(await readFile(f.systemdLog, 'utf8')).toBe('')
          await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
    },
    15_000,
  )

  test.each(['local', 'npm'] as const)(
    'public %s supervised uninstall dry-run is admitted without systemd, registry, or transaction mutation',
    async source => {
      const f = await lifecycleFixture({
        effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies, systemd: {},
      })
      const script = source === 'local'
        ? join(f.fixtureInstallDirectory, 'install-local.sh')
        : join(f.fixtureInstallDirectory, 'install-npm.sh')
      const result = runInstaller(script, [
        '--operation', 'uninstall', '--scenario', 'supervised',
        '--confirm-dsh-home-stopped', '--yes', '--dry-run',
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }))

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Supervised service-aware uninstall (Linux systemd --user)')
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      expect(await readFile(f.systemdLog, 'utf8')).toBe('')
      await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    15_000,
  )

  test.each(['local', 'npm'] as const)(
    'public %s supervised uninstall dispatches the live service transaction without package or registry work',
    async source => {
      const f = await lifecycleFixture({
        effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
        systemd: { units: [{ profile: 'web', active: true }] },
      })
      const script = source === 'local'
        ? join(f.fixtureInstallDirectory, 'install-local.sh')
        : join(f.fixtureInstallDirectory, 'install-npm.sh')
      const result = runInstaller(script, [
        '--operation', 'uninstall', '--scenario', 'supervised', '--confirm-dsh-home-stopped', '--yes',
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }))

      expect(result.status, result.stderr).toBe(0)
      expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toHaveLength(1)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command[1] === 'stop')).toBe(true)
      await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    15_000,
  )

  test('npm supervised upgrade rejects a source without read-only lifecycle capabilities before registry, store, systemd, or transaction work', async () => {
    const f = await lifecycleFixture({ systemd: {}, effectiveScenario: 'supervised' })
    const shadow = join(f.profileDirectory, 'node_modules', '@dsh-enhanced', 'lark-channel')
    await mkdir(shadow, { recursive: true })
    await writeFile(join(shadow, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
    await writeFile(join(shadow, 'index.js'), 'export const unsupported = true\n')
    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'supervised', '--confirm-dsh-home-stopped', '--yes',
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/read-only operator|只读 operator|cohort/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    expect(await readFile(f.systemdLog, 'utf8')).toBe('')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('supervised service upgrade requires its target unit active before mask, stop, or transaction creation', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised',
      systemd: { units: [{ profile: 'web', active: false }] },
    })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/supervised.*active/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('RSI pair upgrades target and coordinator in one Home transaction', async () => {
    const f = await rsiPairLifecycleFixture()
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8')).version).toBe('0.1.1')
    for (const profile of ['web', f.coordinator]) {
      const cp = JSON.parse(await readFile(join(f.dshHome, 'profiles', profile, 'node_modules', '@dsh-enhanced', 'plugin-control-plane', 'package.json'), 'utf8'))
      expect(cp.version).toBe('0.1.1')
      expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${profile}.service`].activeState).toBe('active')
    }
    expect(await readFile(f.operationLog, 'utf8')).toContain(`pair-add ${f.coordinator}`)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  // Parent lifecycle flow is real; systemd, DSH and retirement API/owner
  // observations remain fixtures. Formal DB/namespace migration is separate.
  test('RSI scanner migration completes before first Host and archives only the changed candidate baseline', async () => {
    const f = await rsiPairLifecycleFixture('complete')
    const ledger = { unknown: ['old-job'], spent: 3, maximum: 4 }
    await writeFile(join(f.dshHome, 'old-ledger.json'), JSON.stringify(ledger), { mode: 0o600 })
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status, result.stderr).toBe(0)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations.indexOf('scanner-api apply')).toBeGreaterThanOrEqual(0)
    expect(operations.indexOf('scanner-host retirement=completed retired=true')).toBeGreaterThan(operations.indexOf('scanner-api apply'))
    expect(JSON.parse(await readFile(join(f.dshHome, 'old-ledger.json'), 'utf8'))).toEqual(ledger)
    expect(await readFile(join(f.dshHome, '.scanner-retired'), 'utf8')).toBe('fixture permanent marker')
    const completed = (await readdir(f.root)).filter(name => name.startsWith('home.dsh-enhanced-transaction.completed-'))
    expect(completed).toHaveLength(1)
    const archived = join(f.root, completed[0]!), manifest = JSON.parse(await readFile(join(archived, 'manifest.json'), 'utf8'))
    const journal = manifest.supervisedLifecycle.scannerRetirement
    expect(journal.phase).toBe('completed')
    expect(journal.unmanagedAutomationsDigest).not.toBe(manifest.supervisedLifecycle.source.unmanagedAutomationsDigest)
    const evidence = await lifecycleProfileTest.readScannerRetirementEvidence(archived, manifest)
    expect(evidence.source.source).toEqual(manifest.supervisedLifecycle.source)
    expect(lifecycleProfileTest.scannerCandidateSource(manifest)).toEqual({ ...manifest.supervisedLifecycle.source,
      unmanagedAutomationsDigest: journal.unmanagedAutomationsDigest })
    for (const key of ['sourceArtifact', 'captureArtifact', 'completionArtifact']) {
      const reference = journal[key], path = join(archived, reference.file)
      expect((await lstat(path)).mode & 0o777).toBe(0o600)
      expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(reference.digest)
    }
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  test('RSI scanner partial maintenance failure preserves original Home and prepared tuple evidence without first Host', async () => {
    const f = await rsiPairLifecycleFixture('partial-fail'), receipt = await readFile(f.receiptPath, 'utf8')
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('injected partial scanner maintenance failure')
    await expect(stat(join(f.dshHome, '.scanner-retired'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.receiptPath, 'utf8')).toBe(receipt)
    expect((await readFile(f.operationLog, 'utf8'))).not.toContain('scanner-host')
    for (const profile of ['web', f.coordinator]) {
      expect(JSON.parse(await readFile(join(f.dshHome, 'profiles', profile, 'node_modules', '@dsh-enhanced', 'plugin-control-plane', 'package.json'), 'utf8')).version).toBe('0.1.0')
      expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${profile}.service`].activeState).toBe('active')
    }
    const failed = (await readdir(f.root)).filter(name => name.startsWith('home.dsh-enhanced-transaction.failed-'))
    expect(failed).toHaveLength(1)
    const archived = join(f.root, failed[0]!), manifest = JSON.parse(await readFile(join(archived, 'manifest.json'), 'utf8'))
    expect(manifest.supervisedLifecycle.scannerRetirement.phase).toBe('prepared')
    const evidence = await lifecycleProfileTest.readScannerRetirementEvidence(archived, manifest)
    expect(evidence.captured.capture.plan.operations).toMatchObject([{ operationId: `owner-revoked:${digest64}`, expectedVersion: 1 }])
    expect(manifest.supervisedLifecycle.scannerRetirement.completionArtifact).toBeUndefined()
    expect(await readFile(join(archived, 'staged-home', '.scanner-retired'), 'utf8')).toBe('fixture permanent marker')
  }, 30_000)

  test('RSI scanner adopted journal refuses manual original-Home replacement without clearing phase or starting source services', async () => {
    const f = await rsiPairLifecycleFixture('complete')
    const failed = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdStartFailsProfile: f.coordinator })
    expect(failed.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`, backup = join(transaction, 'original-home')
    const before = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(before.supervisedLifecycle.scannerRetirement.phase).toBe('completed')
    expect(before.supervisedLifecycle.phase).toBe('post-swap-pending')
    await rename(f.dshHome, join(f.root, 'removed-adopted-candidate'))
    await rename(backup, f.dshHome)
    const priorCommands = (await readLifecycleSystemdLog(f.systemdLog)).length
    const retried = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(retried.status).not.toBe(0)
    expect(retried.stderr).toContain('candidate was adopted')
    const after = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(after.supervisedLifecycle.phase).toBe(before.supervisedLifecycle.phase)
    expect(after.supervisedLifecycle.scannerRetirement).toEqual(before.supervisedLifecycle.scannerRetirement)
    expect((await readLifecycleSystemdLog(f.systemdLog)).slice(priorCommands).some(command => command[1] === 'start')).toBe(false)
    await expect(stat(join(f.dshHome, '.scanner-retired'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  test('RSI scanner cleanup crash keeps all proof archives together and resumes without renewed package or maintenance work', async () => {
    const f = await rsiPairLifecycleFixture('complete')
    const crashed = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', crashAfterCleanupMetadata: true })
    expect(crashed.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`, manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    const evidence = await lifecycleProfileTest.readScannerRetirementEvidence(transaction, manifest)
    expect(evidence.completion.planDigest).toBe(evidence.captured.capture.plan.planDigest)
    const before = await readFile(f.operationLog, 'utf8')
    const recovered = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(recovered.status, recovered.stderr).toBe(0)
    const after = await readFile(f.operationLog, 'utf8')
    expect(after.match(/^pair-add/gmu)?.length).toBe(before.match(/^pair-add/gmu)?.length)
    expect(after.match(/^scanner-api apply/gmu)?.length).toBe(1)
    const completed = (await readdir(f.root)).filter(name => name.startsWith('home.dsh-enhanced-transaction.completed-'))
    expect(completed).toHaveLength(1)
    const archived = join(f.root, completed[0]!), archivedManifest = JSON.parse(await readFile(join(archived, 'manifest.json'), 'utf8'))
    await expect(lifecycleProfileTest.readScannerRetirementEvidence(archived, archivedManifest)).resolves.toEqual(evidence)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  test('RSI pair coordinator package failure preserves the original pair and receipt', async () => {
    const f = await rsiPairLifecycleFixture()
    const receipt = await readFile(f.receiptPath, 'utf8')
    await writeFile(join(f.dshHome, '.fail-coordinator-install'), 'fail')
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('42')
    expect(await readFile(f.receiptPath, 'utf8')).toBe(receipt)
    for (const profile of ['web', f.coordinator]) {
      const cp = JSON.parse(await readFile(join(f.dshHome, 'profiles', profile, 'node_modules', '@dsh-enhanced', 'plugin-control-plane', 'package.json'), 'utf8'))
      expect(cp.version).toBe('0.1.0')
      expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${profile}.service`].activeState).toBe('active')
    }
  }, 30_000)

  test('RSI pair npm upgrade verifies and installs both profiles at the resolved version', async () => {
    const f = await rsiPairLifecycleFixture()
    const result = runInstaller(npmInstaller, ['--operation', 'upgrade', '--scenario', 'supervised',
      '--confirm-dsh-home-stopped', '--plugin-version', '0.1.1'], f.dshHome, undefined,
    lifecycleEnvironment(f.dshHome, f.fakeBin, { npmVersion: '0.1.1', expectedScenario: 'supervised' }))
    expect(result.status, result.stderr).toBe(0)
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations.match(/^pnpm-prepare\tabsent/gmu)).toHaveLength(2)
    expect(operations.match(/^pnpm-fetch\tabsent/gmu)).toHaveLength(2)
    expect(operations.match(/^pnpm-offline-install\tpresent/gmu)).toHaveLength(2)
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8')).version).toBe('0.1.1')
    const installed = JSON.parse(await readFile(join(f.coordinatorPath, 'package.json'), 'utf8'))
    expect(Object.values(installed.dependencies)).toEqual(['0.1.1', '0.1.1', '0.1.1'])
  }, 30_000)

  test('RSI pair rejects a coordinator already running a different cohort before stopping services', async () => {
    const f = await rsiPairLifecycleFixture()
    const path = join(f.coordinatorPath, 'node_modules', '@dsh-enhanced', 'plugin-control-plane', 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.version = '0.1.2'
    await writeFile(path, JSON.stringify(manifest))
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('安装版本与登记不一致')
    expect(await readFile(f.operationLog, 'utf8')).not.toContain('pair-add')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test.each(['installed', 'candidate'])('RSI pair refuses mixed %s target versions before stopping either service', async kind => {
    const f = await rsiPairLifecycleFixture()
    const path = kind === 'installed'
      ? join(f.dshHome, 'profiles', 'web', 'node_modules', '@dsh-enhanced', 'personal-assistant', 'package.json')
      : join(f.targets[0]!, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.version = '0.1.2'
    await writeFile(path, JSON.stringify(manifest))
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/安装版本与登记不一致|目标全部受管包必须使用同一 cohort/u)
    expect(await readFile(f.operationLog, 'utf8')).not.toContain('pair-add')
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('RSI pair keeps an old no-Web coordinator running when rollback readiness cannot be proved', async () => {
    const f = await rsiPairLifecycleFixture()
    const journalPath = join(f.fakeBin, 'journalctl')
    const journal = await readFile(journalPath, 'utf8')
    await writeFile(journalPath, journal.replace(` || invocation === 'original-${f.coordinator}'`, ''))
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('尚未停服')
    expect(await readFile(f.operationLog, 'utf8')).not.toContain('pair-add')
    for (const profile of ['web', f.coordinator]) {
      const service = (await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${profile}.service`]
      expect(service.activeState).toBe('active')
      expect(service.invocationId).toBe(`original-${profile}`)
    }
  }, 15_000)

  test('RSI pair refuses an incomplete frozen local-cohort migration before any package mutation', async () => {
    const f = await rsiPairLifecycleFixture()
    const receipt = JSON.parse(await readFile(f.receiptPath, 'utf8'))
    receipt.sourceRepository = f.root
    await writeFile(f.receiptPath, JSON.stringify(receipt))
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('源码/制品收据迁移')
    expect(await readFile(f.operationLog, 'utf8')).not.toContain('pair-add')
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8')).version).toBe('0.1.0')
    expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${f.coordinator}.service`].invocationId).toBe(`original-${f.coordinator}`)
  }, 15_000)

  test.each(['local', 'npm'] as const)('supervised %s upgrade without a coordinator refuses a frozen local cohort before mutation', async source => {
    const f = await lifecycleFixture({ readiness: 'host', effectiveScenario: 'supervised',
      systemd: { units: [{ profile: 'web', active: true }] } })
    const cohortRoot = join(f.dshHome, 'rsi-local-cohorts', 'web')
    await mkdir(join(cohortRoot, 'artifacts'), { recursive: true })
    await writeFile(join(cohortRoot, 'receipt.json'), '{"frozen":true}\n')
    await writeFile(join(cohortRoot, 'artifacts', 'bundle.tgz'), 'frozen artifact')
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const result = source === 'local'
      ? runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
      : runInstaller(npmInstaller, ['--operation', 'upgrade', '--scenario', 'supervised',
        '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0'], f.dshHome, undefined,
      lifecycleEnvironment(f.dshHome, f.fakeBin, { npmVersion: '1.4.0', expectedScenario: 'supervised' }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('源码/制品收据迁移')
    expect(await readFile(f.operationLog, 'utf8')).not.toMatch(/npm-view|pnpm-prepare|dsh-add/u)
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(cohortRoot, 'receipt.json'), 'utf8')).toBe('{"frozen":true}\n')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test.each(['receipt', 'cohort-directory'])('RSI pair npm upgrade rejects frozen local %s before registry access or stopping services', async kind => {
    const f = await rsiPairLifecycleFixture()
    if (kind === 'receipt') {
      const receipt = JSON.parse(await readFile(f.receiptPath, 'utf8'))
      receipt.sourceRepository = f.root
      await writeFile(f.receiptPath, JSON.stringify(receipt))
    } else {
      await mkdir(join(f.dshHome, 'rsi-local-cohorts', 'web'), { recursive: true })
    }
    const result = runInstaller(npmInstaller, ['--operation', 'upgrade', '--scenario', 'supervised',
      '--confirm-dsh-home-stopped', '--plugin-version', '0.1.1'], f.dshHome, undefined,
    lifecycleEnvironment(f.dshHome, f.fakeBin, { npmVersion: '0.1.1', expectedScenario: 'supervised' }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('源码/制品收据迁移')
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations).not.toMatch(/npm-view|pnpm-prepare|pair-add/u)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8')).version).toBe('0.1.0')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('RSI pair retains both snapshots after stale activation and reconciles without reinstalling', async () => {
    const f = await rsiPairLifecycleFixture()
    const modulePath = join(f.coordinatorPath, 'node_modules', '@dsh-enhanced', 'assistant-automations', 'index.js')
    const source = await readFile(modulePath, 'utf8')
    const readyPath = join(f.root, 'coordinator-ready')
    await writeFile(modulePath, "import { readFileSync, existsSync } from 'node:fs'\n" + source.replace('updatedAt: Date.now()',
      `updatedAt: JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version === '0.1.1' && !existsSync(${JSON.stringify(readyPath)}) ? 0 : Date.now()`))
    const result = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('fresh InvocationID Host ready marker')
    expect(await readFile(f.operationLog, 'utf8')).toContain(`pair-add ${f.coordinator}`)
    expect(JSON.parse(await readFile(f.receiptPath, 'utf8')).version).toBe('0.1.1')
    const backup = join(`${f.dshHome}.dsh-enhanced-transaction`, 'original-home')
    for (const profile of ['web', f.coordinator]) {
      const cp = JSON.parse(await readFile(join(backup, 'profiles', profile, 'node_modules', '@dsh-enhanced', 'plugin-control-plane', 'package.json'), 'utf8'))
      expect(cp.version).toBe('0.1.0')
      expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${profile}.service`].activeState).toBe('inactive')
    }
    const count = (await readFile(f.operationLog, 'utf8')).match(/^pair-add/gmu)?.length
    await writeFile(readyPath, 'ready')
    const recovered = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect((await readFile(f.operationLog, 'utf8')).match(/^pair-add/gmu)?.length).toBe(count)
    expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${f.coordinator}.service`].activeState).toBe('active')
    await expect(stat(backup)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  test('RSI pair recovers an interrupted Home swap without reinstalling either cohort', async () => {
    const f = await rsiPairLifecycleFixture()
    const crashed = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', killLifecycleAfterOriginalRename: true })
    expect(crashed.status).not.toBe(0)
    expect(await readFile(f.operationLog, 'utf8')).toContain(`pair-add ${f.coordinator}`)
    const before = (await readFile(f.operationLog, 'utf8')).match(/^pair-add/gmu)?.length
    const recovered = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect((await readFile(f.operationLog, 'utf8')).match(/^pair-add/gmu)?.length).toBe(before)
    for (const profile of ['web', f.coordinator]) {
      expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${profile}.service`].activeState).toBe('active')
    }
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  test('RSI pair recovery refuses effective coordinator drift and retains the old Home', async () => {
    const f = await rsiPairLifecycleFixture()
    const failed = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdStartFailsProfile: f.coordinator })
    expect(failed.status).not.toBe(0)
    const backup = join(`${f.dshHome}.dsh-enhanced-transaction`, 'original-home')
    expect(existsSync(backup), failed.stderr).toBe(true)
    const configPath = join(f.coordinatorPath, '.lifecycle-dump-config')
    const rows = parse(await readFile(configPath, 'utf8'))
    rows.find((row: { id: string }) => row.id === 'dsh-enhanced-plugin-control-plane').config.adoptionCoordinator.timeoutMs += 1
    await writeFile(configPath, stringify(rows))
    const recovered = runServiceLifecycle(['web', f.dshHome, '0', ...f.targets], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' })
    expect(recovered.status).not.toBe(0)
    expect(recovered.stderr).toContain('有效配置在事务中发生变化')
    expect(existsSync(backup)).toBe(true)
    for (const profile of ['web', f.coordinator]) {
      expect((await readLifecycleSystemdState(f.systemdState)).units[`dsh-profile-${profile}.service`].activeState).toBe('inactive')
    }
  }, 30_000)

  test.each(['lark', 'supervised'] as const)('native generic Host readiness completes %s service upgrade without a Web URL', async expectedScenario => {
    const f = await lifecycleFixture({ readiness: 'host', effectiveScenario: expectedScenario,
      systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario })
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('active')
  }, 15_000)

  test('native generic Host readiness from an old invocation cannot accept a restarted service', async () => {
    const f = await lifecycleFixture({ readiness: 'host', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/fresh InvocationID Host ready marker/u)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('inactive')
  }, 15_000)

  test('a different generic Host readiness protocol cannot pass activation', async () => {
    const f = await lifecycleFixture({ readiness: 'invalid-host', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/隔离 Host 激活失败/u)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  // Delivery schema 23-31 migration matrix: daily gate keeps the first and
  // last versions plus a missing-schema case; the nightly full gate runs every
  // version. The intermediate-only cases are skipped on push runs.
  const fullDeliverySchemaMatrix = [23, 24, 25, 26, 27, 28, 29, 30, 31] as const
  const gatedDeliverySchemaMatrix = (process.env.DSH_NIGHTLY_FULL_MATRIX === '1'
    ? fullDeliverySchemaMatrix
    : [fullDeliverySchemaMatrix[0]!, fullDeliverySchemaMatrix.at(-1)!]) as readonly number[]
  test.each(gatedDeliverySchemaMatrix)('supervised service upgrade completes preview, swap, active acceptance, and cleanup with Delivery schema %s', async deliverySnapshotSchema => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', deliverySnapshotSchema, systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service'].activeState).toBe('active')
  })

  test('supervised service uninstall archives the exact managed profile and preserves external state without post-archive operator work', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [
        { profile: 'web', active: true }, { profile: 'worker', active: true }, { profile: 'dormant', active: false },
      ] },
    })
    const originalManifest = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    const originalPatch = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdLarkProfiles: ['worker', 'dormant'] }, 'service-uninstall',
    )

    expect(result.status, result.stderr).toBe(0)
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    const archive = join(f.dshHome, 'uninstalled-profiles', archives[0]!)
    expect(JSON.parse(await readFile(join(archive, 'package.json'), 'utf8'))).toEqual(originalManifest)
    expect(Object.keys(originalManifest.dependencies).sort()).toEqual(
      supervisedManagedDependencies.map(name => `@dsh-enhanced/${name}`).sort(),
    )
    expect(await readFile(join(archive, 'cordis.patch.yml'), 'utf8')).toBe(originalPatch)
    expect(await readdir(archive)).toEqual(expect.arrayContaining([
      'package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
    ]))
    expect(JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(readLifecycleDatabase(f.databasePath)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    const operatorCalls = await readFile(f.supervisedOperatorLog, 'utf8')
    expect(operatorCalls.trim().split('\n')).toEqual([
      'supervised-operator\tattest-active\tdirect\tarchive=false',
      'supervised-operator\tattest-active\tsandbox\tarchive=false',
    ])
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-web.service']!.invocationId).toMatch(/^fresh-web-/u)
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-worker.service']!.invocationId).toMatch(/^fresh-worker-/u)
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('supervised uninstall accepts an unchanged node_modules hardlink without weakening profile data files', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const packageDirectory = join(f.profileDirectory, 'node_modules', '.pnpm', 'linked')
    await mkdir(packageDirectory, { recursive: true })
    const storeFile = join(f.root, 'pnpm-store-file.js')
    const linkedFile = join(packageDirectory, 'linked-file.js')
    await writeFile(storeFile, 'export default 1\n')
    await link(storeFile, linkedFile)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }, 'service-uninstall',
    )

    expect(result.status, result.stderr).toBe(0)
    const [archive] = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(await readFile(join(f.dshHome, 'uninstalled-profiles', archive!,
      'node_modules', '.pnpm', 'linked', 'linked-file.js'), 'utf8')).toBe('export default 1\n')
  }, 15_000)

  test('supervised preview failure restores the source home and original active set', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const original = await stat(f.dshHome)
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', supervisedMockFailure: 'preview' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('injected supervised preview failure')
    expect(result.stderr).not.toContain('服务恢复未完成')
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add/gmu)).toHaveLength(1)
    const restored = await stat(f.dshHome)
    expect({ dev: restored.dev, ino: restored.ino }).toEqual({ dev: original.dev, ino: original.ino })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service'].activeState).toBe('active')
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('supervised pre-swap restore refuses a disconnected source Lark service and preserves evidence', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
        expectedScenario: 'supervised', supervisedMockFailure: 'preview', systemdLarkDisconnectAfterConnect: true,
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/恢复未完成|Lark|connected/iu)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved.length).toBeGreaterThan(0)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('inactive')
  })

  test('supervised post-swap attestation failure contains services and preserves both homes with v3 evidence', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', supervisedMockFailure: 'post-swap' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('injected supervised post-swap failure')
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(await stat(join(transaction, 'original-home'))).toBeDefined()
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 3, state: 'service-failed', servicePhase: 'service-failed' })
    expect(manifest.supervisedLifecycle).toMatchObject({ phase: 'post-swap-pending', startAttempt: { kind: 'accept-active' } })
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(Object.values(state.units).every(unit => unit.activeState === 'inactive')).toBe(true)
  })

  test('supervised acceptance rejects a disconnected latest Lark state and contains services', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdLarkDisconnectAfterConnect: true },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Lark|connected|ready/iu)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(await stat(join(transaction, 'original-home'))).toBeDefined()
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('inactive')
  })

  test('supervised stability window rejects an in-window connected-disconnected-connected Lark flap even though the latest state recovers (F5)', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      {
        expectedScenario: 'supervised',
        systemdLarkFlapAfterAccept: true,
        serviceStabilityMs: '60',
        serviceStabilitySamples: 2,
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('稳定性窗口内报告了非接受状态')
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(await stat(join(transaction, 'original-home'))).toBeDefined()
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('inactive')
  })

  test('supervised readiness baseline does not swallow a flap inserted after its accepted journal sample', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
        expectedScenario: 'supervised', systemdLarkFlapAtReadinessBaseline: true,
        serviceStabilityMs: '60', serviceStabilitySamples: 2,
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('稳定性窗口内报告了非接受状态')
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('inactive')
  })

  test('supervised acceptance passes a multi-sample stability window when every Lark state stays accepted (F5)', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      {
        expectedScenario: 'supervised',
        serviceStabilityMs: '60',
        serviceStabilitySamples: 3,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('active')
  })

  test('supervised cleanup rejects owner proof drift and preserves both homes', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', supervisedProofDrift: true },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/proof.*drift|proof.*漂移|owner/iu)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(await stat(join(transaction, 'original-home'))).toBeDefined()
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('inactive')
  })

  test('supervised preview rejects mutation of a non-managed durable automation', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', supervisedUnmanagedAutomationDrift: true },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/非受管 Automation|lifecycle phase/iu)
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add/gmu)).toHaveLength(1)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('active')
  })

  test('supervised post-swap start-intent crash recovers without repeating package or preview work', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdCrashBeforeStartProfile: 'web' },
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(crashManifest).toMatchObject({ version: 3, state: 'swapped', servicePhase: 'starting',
      supervisedLifecycle: { phase: 'post-swap-pending', startAttempt: { kind: 'accept-active' } } })
    expect(lifecycleProfileTest.validSupervisedLifecycle(crashManifest.supervisedLifecycle),
      JSON.stringify(crashManifest.supervisedLifecycle, null, 2)).toBe(true)
    expect(lifecycleProfileTest.validSupervisedManifestPhase(crashManifest)).toBe(true)
    expect(await stat(join(transaction, 'original-home'))).toBeDefined()

    const second = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' },
    )
    expect(second.status, second.stderr).toBe(0)
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add/gmu)).toHaveLength(1)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('active')
  })

  test('supervised original-renamed crash restores source with a fresh attestation without repeating package work', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', killLifecycleAfterOriginalRename: true },
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add/gmu)).toHaveLength(1)
    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' },
    )
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(`${recovered.stdout}\n${recovered.stderr}`).toMatch(/original-renamed|恢复/iu)
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add/gmu)).toHaveLength(1)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('active')
  })

  test('supervised uninstall original-renamed crash restores the source home and original active set', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', killLifecycleAfterOriginalRename: true }, 'service-uninstall',
    )

    expect(crashed.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(existsSync(f.dshHome), crashed.stderr).toBe(false)
    const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(crashManifest).toMatchObject({
      version: 3, operation: 'uninstall', expectedScenario: 'supervised', stagedScenario: 'unsupported',
      state: 'original-renamed', servicePhase: 'stopped',
      supervisedLifecycle: { protocol: 'dsh-enhanced/supervised-uninstall/v1', phase: 'clean-target-validated' },
    })
    expect((lifecycleProfileTest as typeof lifecycleProfileTest & { validV3OperationShape(value: unknown): boolean })
      .validV3OperationShape(crashManifest)).toBe(true)
    const operatorCalls = await readFile(f.supervisedOperatorLog, 'utf8')

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(`${recovered.stdout}\n${recovered.stderr}`).toMatch(/original-renamed|恢复/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).not.toBe(operatorCalls)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(join(f.dshHome, 'uninstalled-profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
  }, 15_000)

  test('supervised uninstall post-swap retry does not archive or run the operator a second time', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }, { profile: 'worker', active: true }] },
    })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdJournal: 'stale', systemdLarkProfiles: ['worker'] }, 'service-uninstall',
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      version: 3, operation: 'uninstall', state: 'service-failed', servicePhase: 'service-failed',
      supervisedLifecycle: { protocol: 'dsh-enhanced/supervised-uninstall/v1', phase: 'clean-target-pending' },
    })
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    const archivedManifest = await readFile(
      join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json'), 'utf8',
    )
    const operationsBefore = await readFile(f.operationLog, 'utf8')
    const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')
    expect(operatorBefore).not.toMatch(/preview|archive=true/u)

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdJournal: 'ready' }, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
    expect(await readFile(join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json'), 'utf8'))
      .toBe(archivedManifest)
    expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBefore)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 2 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 2 })
  }, 15_000)

  test('supervised uninstall recovery rejects archive tampering before service or operator mutation', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }, { profile: 'worker', active: true }] },
    })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdJournal: 'stale', systemdLarkProfiles: ['worker'] }, 'service-uninstall',
    )
    expect(first.status).not.toBe(0)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    await writeFile(join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'cordis.patch.yml'), 'tampered\n')
    const systemdBefore = await readFile(f.systemdLog, 'utf8')
    const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')
    const homeBefore = await lifecycleIdentity(f.dshHome)
    const backupBefore = await lifecycleIdentity(join(transaction, 'original-home'))

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdJournal: 'ready' }, 'service-uninstall',
    )

    expect(recovered.status).not.toBe(0)
    expect(recovered.stderr).toMatch(/archive|归档|tree.*digest|摘要/iu)
    expect(await readFile(f.systemdLog, 'utf8'), recovered.stderr).toBe(systemdBefore)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(homeBefore)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(backupBefore)
  }, 15_000)

  test('supervised uninstall recovery rejects malformed service acceptance before external mutation', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', canonicalCleanupFails: true }, 'service-uninstall',
    )
    expect(first.status).not.toBe(0)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    const manifestPath = join(transaction, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(manifest).toMatchObject({
      version: 3, operation: 'uninstall', state: 'cleanup-started', servicePhase: 'service-accepted',
      supervisedLifecycle: { protocol: 'dsh-enhanced/supervised-uninstall/v1', phase: 'clean-target-accepted' },
    })
    const malformed = { ...manifest, serviceAcceptance: [manifest.serviceAcceptance[0], manifest.serviceAcceptance[0]] }
    malformed.updatedAt = '2026-09-11T20:00:00.000Z'
    malformed.bindingDigest = createHash('sha256')
      .update(JSON.stringify(serviceLifecycleBinding(malformed))).digest('hex')
    await writeFile(manifestPath, JSON.stringify(malformed, null, 2) + '\n', { mode: 0o600 })
    const systemdBefore = await readFile(f.systemdLog, 'utf8')
    const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')
    const homeBefore = await lifecycleIdentity(f.dshHome)
    const backupBefore = await lifecycleIdentity(join(transaction, 'original-home'))

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }, 'service-uninstall',
    )

    expect(recovered.status).not.toBe(0)
    expect(recovered.stderr).toMatch(/manifest.*校验失败|service acceptance|未绑定/iu)
    expect(await readFile(f.systemdLog, 'utf8')).toBe(systemdBefore)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(homeBefore)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(backupBefore)
  }, 15_000)

  test('supervised uninstall cleanup tombstone survives a partial-delete crash and retries without repeating acceptance work', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', crashDuringCleanup: true }, 'service-uninstall',
    )

    expect(crashed.status).not.toBe(0)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      version: 3, operation: 'uninstall', state: 'cleanup-started', servicePhase: 'service-accepted',
      cleanup: {
        protocol: 'dsh-enhanced/service-cleanup/v1', phase: 'deleting', tombstoneName: 'cleanup-original-home',
      },
      supervisedLifecycle: { protocol: 'dsh-enhanced/supervised-uninstall/v1', phase: 'clean-target-accepted' },
    })
    const tombstone = join(transaction, manifest.cleanup.tombstoneName)
    await expect(stat(tombstone)).resolves.toBeDefined()
    await expect(stat(join(tombstone, 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    const operationsBefore = await readFile(f.operationLog, 'utf8')
    const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')
    const startsBefore = (await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']!.starts

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
    expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBefore)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']!.starts).toBe(startsBefore)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('supervised uninstall cleanup reaccepts a restarted clean service before deleting transaction metadata', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', crashDuringCleanup: true }, 'service-uninstall',
    )
    expect(crashed.status).not.toBe(0)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    const state = await readLifecycleSystemdState(f.systemdState)
    const web = state.units['dsh-profile-web.service']!
    const startsBeforeRecovery = web.starts
    web.mainPid += 100
    web.invocationId = `external-restart-${web.mainPid}`
    web.nRestarts += 1
    await writeFile(f.systemdState, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')
    const operationsBefore = await readFile(f.operationLog, 'utf8')
    const archiveBefore = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    const systemdBefore = (await readLifecycleSystemdLog(f.systemdLog)).length

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    const accepted = (await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']!
    expect(accepted).toMatchObject({ activeState: 'active', subState: 'running', starts: startsBeforeRecovery + 1 })
    expect(accepted.invocationId).toMatch(/^fresh-web-/u)
    const recoveryCommands = (await readLifecycleSystemdLog(f.systemdLog)).slice(systemdBefore)
    const stopIndex = recoveryCommands.findIndex(command => command[1] === 'stop'
      && command.includes('dsh-profile-web.service'))
    const startIndex = recoveryCommands.findIndex(command => command[1] === 'start'
      && command.includes('dsh-profile-web.service'))
    expect(stopIndex).toBeGreaterThanOrEqual(0)
    expect(startIndex).toBeGreaterThan(stopIndex)
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archiveBefore)
    expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBefore)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test.each([
    ['deleting', { crashDuringCleanup: true }],
    ['metadata-only', { crashAfterCleanupMetadata: true }],
  ] as const)('supervised uninstall %s cleanup survives a second crash during fresh reaccept',
    async (cleanupPhase, firstCrash) => {
      const f = await lifecycleFixture({
        effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
        systemd: { units: [{ profile: 'web', active: true }] },
      })
      const crashed = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
        { expectedScenario: 'supervised', ...firstCrash }, 'service-uninstall',
      )
      expect(crashed.status).not.toBe(0)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const initialManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
      expect(initialManifest).toMatchObject({
        state: 'cleanup-started', servicePhase: 'service-accepted', cleanup: { phase: cleanupPhase },
      })
      const state = await readLifecycleSystemdState(f.systemdState)
      const web = state.units['dsh-profile-web.service']!
      web.mainPid += 100
      web.invocationId = `external-restart-${web.mainPid}`
      web.nRestarts += 1
      await writeFile(f.systemdState, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')

      const interrupted = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
        { expectedScenario: 'supervised', crashAfterCleanupReacceptPending: true, systemdMaskedMetadataEmpty: true },
        'service-uninstall',
      )
      expect(interrupted.status).not.toBe(0)
      expect(JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))).toMatchObject({
        state: 'cleanup-started', servicePhase: 'starting', cleanup: { phase: cleanupPhase },
      })

      const recovered = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
        { expectedScenario: 'supervised', systemdMaskedMetadataEmpty: true }, 'service-uninstall',
      )

      expect(recovered.status, recovered.stderr).toBe(0)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
        activeState: 'active', subState: 'running',
      })
      expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
      await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 20_000)

  test.each([
    ['installed mask with stale loaded cache', { crashAfterCleanupReacceptPending: true }, 'loaded'],
    ['staged mask with stale masked cache', {}, 'masked'],
  ] as const)('supervised uninstall reconciles %s before cleanup', async (_label, residue, cachedLoadState) => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', crashDuringCleanup: true }, 'service-uninstall',
    )
    expect(crashed.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    if (residue.crashAfterCleanupReacceptPending) {
      const state = await readLifecycleSystemdState(f.systemdState)
      const web = state.units['dsh-profile-web.service']!
      web.mainPid += 100
      web.invocationId = `external-restart-${web.mainPid}`
      web.nRestarts += 1
      await writeFile(f.systemdState, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      const interrupted = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
        { expectedScenario: 'supervised', crashAfterCleanupReacceptPending: true }, 'service-uninstall',
      )
      expect(interrupted.status).not.toBe(0)
    }
    const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {
        expectedScenario: 'supervised', systemdCachedLoadStateProfile: 'web', systemdCachedLoadState: cachedLoadState,
      }, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20_000)

  test.each([
    ['mismatched unit id', { systemdRawIdMismatchProfile: 'web' }],
    ['blank numeric field', { systemdRawBlankNumericProfile: 'web' }],
  ] as const)('supervised uninstall cleanup rejects %s before systemd mutation', async (_label, malformed) => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', crashDuringCleanup: true }, 'service-uninstall',
    )
    expect(crashed.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const systemdBefore = (await readLifecycleSystemdLog(f.systemdLog)).length

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised', ...malformed },
      'service-uninstall',
    )

    expect(recovered.status).not.toBe(0)
    const commands = (await readLifecycleSystemdLog(f.systemdLog)).slice(systemdBefore)
    expect(commands.some(command => ['disable', 'enable', 'mask', 'start', 'stop', 'unmask'].includes(command[1]))).toBe(false)
    await expect(stat(transaction)).resolves.toBeDefined()
  }, 20_000)

  test('supervised uninstall cleanup survives a crash after durable reacceptance while the service is active and masked',
    async () => {
      const f = await lifecycleFixture({
        effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
        systemd: { units: [{ profile: 'web', active: true }] },
      })
      const crashed = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
        { expectedScenario: 'supervised', crashDuringCleanup: true }, 'service-uninstall',
      )
      expect(crashed.status).not.toBe(0)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const state = await readLifecycleSystemdState(f.systemdState)
      const web = state.units['dsh-profile-web.service']!
      web.mainPid += 100
      web.invocationId = `external-restart-${web.mainPid}`
      web.nRestarts += 1
      await writeFile(f.systemdState, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      const operatorBefore = await readFile(f.supervisedOperatorLog, 'utf8')
      const operationsBefore = await readFile(f.operationLog, 'utf8')

      const interrupted = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {
          expectedScenario: 'supervised', crashAfterCleanupReacceptGuardian: true, systemdMaskedMetadataEmpty: true,
        }, 'service-uninstall',
      )
      expect(interrupted.status).not.toBe(0)
      expect(JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))).toMatchObject({
        state: 'cleanup-started', servicePhase: 'service-accepted', cleanup: { phase: 'deleting' },
      })
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
        activeState: 'active', subState: 'running', mainPid: expect.any(Number),
      })

      const recovered = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
        { expectedScenario: 'supervised', systemdMaskedMetadataEmpty: true }, 'service-uninstall',
      )

      expect(recovered.status, recovered.stderr).toBe(0)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
        activeState: 'active', subState: 'running',
      })
      expect(await readFile(f.supervisedOperatorLog, 'utf8')).toBe(operatorBefore)
      expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBefore)
      await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    }, 20_000)

  test('supervised uninstall keeps a late same-home unit persistently masked after transaction cleanup', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdDynamicProfile: 'late' }, 'service-uninstall',
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    const containment = manifest.containmentMasks.find((mask: { unit: string }) => (
      mask.unit === 'dsh-profile-late.service'
    ))
    expect(containment).toMatchObject({ target: '/dev/null' })
    const lateStarts = (await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-late.service']!.starts
    const systemdBefore = (await readLifecycleSystemdLog(f.systemdLog)).length
    const archiveBefore = await readdir(join(f.dshHome, 'uninstalled-profiles'))

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-late.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0, starts: lateStarts, unitFileState: 'disabled',
    })
    const recoveryCommands = (await readLifecycleSystemdLog(f.systemdLog)).slice(systemdBefore)
    expect(recoveryCommands.some(command => ['start', 'enable'].includes(command[1])
      && command.includes('dsh-profile-late.service'))).toBe(false)
    const installed = await lstat(containment.path)
    expect(installed.isSymbolicLink()).toBe(true)
    expect({ dev: String(installed.dev), ino: String(installed.ino), uid: installed.uid, mode: installed.mode })
      .toEqual(containment.identity)
    expect(await readlink(containment.path)).toBe('/dev/null')
    await expect(stat(join(f.systemdHome, '.config', 'systemd', 'user', 'default.target.wants',
      'dsh-profile-late.service'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archiveBefore)
    await expect(stat(state.units['dsh-profile-late.service']!.fragmentPath)).resolves.toBeDefined()
  }, 15_000)

  test('supervised uninstall cleanup prepared crash preserves cleanup state while reaccepting on retry', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'supervised', managedDependencies: supervisedManagedDependencies,
      systemd: { units: [{ profile: 'web', active: true }] },
    })
    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', crashAfterCleanupPrepared: true }, 'service-uninstall',
    )
    expect(crashed.status).not.toBe(0)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    const prepared = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(prepared).toMatchObject({
      state: 'cleanup-started', servicePhase: 'service-accepted',
      cleanup: { protocol: 'dsh-enhanced/service-cleanup/v1', phase: 'prepared' },
    })

    const interrupted = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', systemdCrashBeforeStartProfile: 'web' }, 'service-uninstall',
    )
    expect(interrupted.status).not.toBe(0)
    const retried = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(retried).toMatchObject({
      state: 'cleanup-started', cleanup: { protocol: 'dsh-enhanced/service-cleanup/v1' },
    })

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' }, 'service-uninstall',
    )
    expect(recovered.status, recovered.stderr).toBe(0)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('supervised stopped crash before source attestation rebuilds source proof and restores the active set', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', killLifecycleAfterStopped: true },
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const residue = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(residue).toMatchObject({ version: 3, state: 'preparing', servicePhase: 'stopped',
      supervisedLifecycle: { phase: 'source-pending' } })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('inactive')

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' },
    )
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('active')
  })

  test('supervised cleanup without backup remains retryable across consecutive acceptance failures', async () => {
    const f = await lifecycleFixture({ effectiveScenario: 'supervised', systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { expectedScenario: 'supervised', canonicalCleanupFails: true },
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    await rm(join(transaction, 'original-home'), { recursive: true })
    const operations = await readFile(f.operationLog, 'utf8')
    expect(operations.match(/^dsh-add/gmu)).toHaveLength(1)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { expectedScenario: 'supervised', systemdLarkDisconnectAfterConnect: true },
      )
      expect(failed.status).not.toBe(0)
      const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({ version: 3, state: 'cleanup-started', servicePhase: 'service-failed',
        supervisedLifecycle: { phase: 'post-swap-pending', startAttempt: { kind: 'accept-active' } } })
      expect(lifecycleProfileTest.validSupervisedLifecycle(manifest.supervisedLifecycle)).toBe(true)
      expect(lifecycleProfileTest.validSupervisedManifestPhase(manifest)).toBe(true)
      expect(await readFile(f.operationLog, 'utf8')).toBe(operations)
    }

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { expectedScenario: 'supervised' },
    )
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(await readFile(f.operationLog, 'utf8')).toBe(operations)
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState).toBe('active')
  }, 30_000)

  test.each(['local', 'npm'] as const)(
    'public %s Lark upgrade recovers original-renamed v2 residue through a now-dangling DSH_HOME symlink',
    async source => {
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
      ] } })
      const homeAlias = join(f.root, 'home-alias')
      await symlink(f.dshHome, homeAlias)
      const originalIdentity = await lifecycleIdentity(f.dshHome)
      const crashed = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { killLifecycleAfterOriginalRename: true },
      )
      expect(crashed.status).not.toBe(0)
      await expect(stat(homeAlias)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await lstat(homeAlias)).isSymbolicLink()).toBe(true)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
      expect(crashManifest).toMatchObject({ version: 2, state: 'original-renamed', expectedScenario: 'lark' })
      const operationsBeforeRecovery = await readFile(f.operationLog, 'utf8')
      expect(operationsBeforeRecovery.match(/^dsh-add\t/gmu)).toHaveLength(1)

      const script = source === 'local' ? localInstaller : npmInstaller
      const recovered = runInstaller(script, [
        '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', '1.4.0'] : []),
      ], homeAlias, 'Linux', lifecycleEnvironment(homeAlias, f.fakeBin))

      expect(recovered.status).not.toBe(0)
      expect(recovered.stderr).toMatch(/恢复|recovery|重试/iu)
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      expect(await realpath(homeAlias)).toBe(f.dshHome)
      expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBeforeRecovery)
      expect(operationsBeforeRecovery).not.toMatch(/^npm-view|^pnpm-store-add/mu)
      await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toHaveLength(1)
      expect(JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8')))
        .toMatchObject({ version: 2, id: crashManifest.id, state: 'original-renamed' })
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
    },
    15_000,
  )

  test.each([
    { actual: 'lark', declared: 'web', source: 'local' },
    { actual: 'lark', declared: 'web', source: 'npm' },
    { actual: 'supervised', declared: 'web', source: 'local' },
    { actual: 'supervised', declared: 'web', source: 'npm' },
    { actual: 'autonomy', declared: 'web', source: 'local' },
    { actual: 'web', declared: 'autonomy', source: 'local' },
    { actual: 'web', declared: 'lark', source: 'local' },
    { actual: 'web', declared: 'lark', source: 'npm' },
  ] as const)(
    '$source lifecycle rejects actual $actual profile spoofed as $declared before external work',
    async ({ actual, declared, source }) => {
      const f = await lifecycleFixture({
        effectiveScenario: actual,
        systemd: { units: [{ profile: 'web', active: true }] },
      })
      const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
      const script = source === 'local' ? localInstaller : npmInstaller
      const result = runInstaller(script, [
        '--operation', 'upgrade', '--scenario', declared, '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', '1.4.0'] : []),
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

      expect(result.status).not.toBe(0)
      if (actual === 'supervised') expect(result.stderr).toMatch(/supervised|recovery|attestation/iu)
      else expect(result.stderr).toMatch(/scenario|场景|service-aware/iu)
      expect(await readFile(f.dshLog, 'utf8')).toContain('CALL\t--profile\tweb\t--dump-config\n')
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      expect(await readFile(f.systemdLog, 'utf8')).toBe('')
      await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(f.activationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test('scenario classifier ignores standard non-marker platform-disabled rows', async () => {
    const scenario = await classifyLifecycleScenario(`
- id: bash-sandbox
  name: '@deepseek-ai/dsh-sandbox-bash'
  disabled: !!js process.platform === 'win32'
- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-sandbox-pwsh'
  disabled: !!js process.platform !== 'win32'
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
- id: dsh-enhanced-assistant-isolation
  name: '@dsh-enhanced/assistant-isolation'
`)

    expect(scenario).toBe('autonomy')
  })

  test('scenario classifier treats a config-disabled Lark row beside web as web', async () => {
    const scenario = await classifyLifecycleScenario(`
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config:
    enabled: false
`)

    expect(scenario).toBe('web')
  })

  test.each([
    ['duplicate enabled Lark rows', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
- id: lark-owner-alias
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
`],
    ['duplicate config-disabled and enabled Lark rows', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: false }
- id: lark-owner-alias
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
`],
    ['malformed top-level disabled boolean', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  disabled: 'false'
  config: { enabled: true }
`],
    ['dynamic lifecycle marker disabled expression', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  disabled: !!js process.platform === 'win32'
  config: { enabled: true }
`],
    ['malformed Lark enabled boolean', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: 'false' }
`],
    ['mixed enabled Lark and web rows', `
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
`],
  ])('scenario classifier fails closed for %s', async (_label, source) => {
    await expect(classifyLifecycleScenario(source)).rejects.toThrow()
  })

  test('npm Lark upgrade dry-run describes service safety without registry or systemd access', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'lark',
      systemd: { units: [{ profile: 'web', active: true }] },
    })

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped',
      '--plugin-version', 'latest', '--dry-run',
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Lark service-aware upgrade (Linux systemd --user)')
    expect(result.stdout).toContain('runtime-mask')
    expect(result.stdout).toContain('fresh InvocationID journal readiness')
    expect(result.stdout).toContain('preserve both homes plus the bound manifest')
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    expect(await readFile(f.systemdLog, 'utf8')).toBe('')
  })

  test('local and npm Lark upgrade entry points dispatch the service-aware executor', async () => {
    const local = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const localResult = runInstaller(join(local.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
    ], local.dshHome, 'Linux', lifecycleEnvironment(local.dshHome, local.fakeBin))

    expect(localResult.status, localResult.stderr).toBe(0)
    expect((await readLifecycleSystemdLog(local.systemdLog)).some(command => command[1] === 'stop')).toBe(true)

    const npm = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const npmResult = runInstaller(join(npm.fixtureInstallDirectory, 'install-npm.sh'), [
      '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0', '--yes',
    ], npm.dshHome, 'Linux', lifecycleEnvironment(npm.dshHome, npm.fakeBin))

    expect(npmResult.status, npmResult.stderr).toBe(0)
    expect((await readLifecycleSystemdLog(npm.systemdLog)).some(command => command[1] === 'stop')).toBe(true)
    expect(await readFile(npm.operationLog, 'utf8')).toContain('npm-view')
  }, 15_000)

  test.each(['local', 'npm'] as const)(
    '%s Lark uninstall entry point dispatches service-aware lifecycle without registry or store access',
    async source => {
      const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
      const script = source === 'local'
        ? join(f.fixtureInstallDirectory, 'install-local.sh')
        : join(f.fixtureInstallDirectory, 'install-npm.sh')

      const result = runInstaller(script, [
        '--operation', 'uninstall', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', 'latest'] : []),
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

      expect(result.status, result.stderr).toBe(0)
      expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command[1] === 'stop')).toBe(true)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      const current = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
      expect(current).toMatchObject({
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      })
    },
    15_000,
  )

  test('service-aware Lark uninstall archives the profile, preserves home and systemd state, and restores only active units', async () => {
    const f = await lifecycleFixture({
      managedDependencies: ['personal-assistant', 'lark-channel'],
      systemd: { units: [
        { profile: 'web', active: true, dropIn: 'keyring' },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
        { profile: 'foreign-home', active: true, dshHome: '__other__' },
      ] },
    })
    const credentialPath = join(f.dshHome, '.credentials.yaml')
    const settingsPath = join(f.dshHome, 'settings.yaml')
    const unitPath = join(f.systemdHome, '.config', 'systemd', 'user', 'dsh-profile-web.service')
    const keyringPath = `${unitPath}.d/keyring.conf`
    await writeFile(credentialPath, 'lark:\n  appSecret: secret-ref\n', { mode: 0o600 })
    await writeFile(settingsPath, 'owner: ou_owner\n', { mode: 0o600 })
    const unitBefore = await readFile(unitPath, 'utf8')
    const keyringBefore = await readFile(keyringPath, 'utf8')

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
    )

    expect(result.status, result.stderr).toBe(0)
    const current = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    expect(current).toMatchObject({
      name: 'dsh-profile-web',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
    })
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    const archivePath = join(f.dshHome, 'uninstalled-profiles', archives[0]!)
    expect(JSON.parse(await readFile(join(archivePath, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@dsh-enhanced/personal-assistant': '0.1.0',
        '@dsh-enhanced/lark-channel': '0.1.0',
      },
    })
    expect(await readFile(join(archivePath, 'cordis.patch.yml'), 'utf8')).toContain('owner-custom')
    expect(await readFile(credentialPath, 'utf8')).toBe('lark:\n  appSecret: secret-ref\n')
    expect(await readFile(settingsPath, 'utf8')).toBe('owner: ou_owner\n')
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(readLifecycleDatabase(f.databasePath)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    expect(await readFile(unitPath, 'utf8')).toBe(unitBefore)
    expect(await readFile(keyringPath, 'utf8')).toBe(keyringBefore)

    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const stop = commands.find(command => command[1] === 'stop')
    expect(new Set(stop?.slice(2))).toEqual(new Set([
      'dsh-profile-web.service', 'dsh-profile-worker.service', 'dsh-profile-dormant.service',
    ]))
    expect(stop).not.toContain('dsh-profile-foreign-home.service')
    const start = commands.find(command => command[1] === 'start')
    expect(new Set(start?.slice(2))).toEqual(new Set(['dsh-profile-web.service', 'dsh-profile-worker.service']))
    expect(start).not.toContain('dsh-profile-dormant.service')
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.stopObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: 'dsh-profile-web.service', maskPresent: true, unitFileState: 'disabled' }),
      expect.objectContaining({ unit: 'dsh-profile-worker.service', maskPresent: true, unitFileState: 'disabled' }),
      expect.objectContaining({ unit: 'dsh-profile-dormant.service', maskPresent: true, unitFileState: 'disabled' }),
    ]))
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1, unitFileState: 'enabled' })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1, unitFileState: 'enabled' })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0, unitFileState: 'enabled' })
    expect(state.units['dsh-profile-foreign-home.service']).toMatchObject({ activeState: 'active', starts: 0 })
    expect(state.units['dsh-profile-web.service']?.invocationId).toMatch(/^fresh-web-/u)
    expect(state.units['dsh-profile-worker.service']?.invocationId).toMatch(/^fresh-worker-/u)
    const journals = await readLifecycleSystemdLog(f.journalLog)
    for (const profile of ['web', 'worker']) {
      expect(journals).toEqual(expect.arrayContaining([expect.arrayContaining([
        '--unit', `dsh-profile-${profile}.service`,
        expect.stringMatching(new RegExp(`^_SYSTEMD_INVOCATION_ID=fresh-${profile}-`, 'u')),
      ])]))
    }
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  }, 15_000)

  test.each([
    ['legacy foreign fragment', { fragment: 'foreign' as const }],
    ['custom foreign drop-in', { dropIn: 'unknown' as const }],
  ])('Lark uninstall ignores a %s unit owned by another home', async (_label, foreignShape) => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'foreign', active: true, dshHome: '__other__', ...foreignShape },
    ] } })
    await mkdir(join(f.dshHome, 'profiles', 'conflict'), { recursive: true })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
    )

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop'
      && command.includes('dsh-profile-foreign.service'))).toBe(false)
    expect(commands.some(command => command[1] === 'start'
      && command.includes('dsh-profile-foreign.service'))).toBe(false)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-foreign.service'])
      .toMatchObject({ activeState: 'active', starts: 0 })
  }, 15_000)

  test('Lark uninstall ignores a clearly foreign legacy unit with a foreign non-renderer WorkingDirectory', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      {
        profile: 'legacy', active: true, dshHome: '__other__', fragment: 'foreign',
        dropIn: 'unknown', workingDirectory: '__other__',
      },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
    )

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop'
      && command.includes('dsh-profile-legacy.service'))).toBe(false)
    expect(commands.some(command => command[1] === 'start'
      && command.includes('dsh-profile-legacy.service'))).toBe(false)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-legacy.service'])
      .toMatchObject({ activeState: 'active', starts: 0 })
  }, 15_000)

  test('Lark uninstall does not ignore a renderer unit whose DSH_HOME is nested below the current home', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'nested', active: true, dshHome: '__nested__' },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/nested home|same-home|嵌套|证据冲突|拒绝.*忽略|拒绝.*接管/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-nested.service'])
      .toMatchObject({ activeState: 'active', starts: 0 })
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('Lark uninstall rejects a relative unit DSH_HOME before masking or stopping services', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'relative', active: true, dshHome: '__other__', reportedDshHome: 'relative-home' },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ownership|DSH_HOME|absolute|绝对|所有权/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('Lark uninstall fail-closes when a foreign unit changes to conflicting ownership before acceptance', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'foreign', active: true, dshHome: '__other__', fragment: 'foreign' },
    ] } })
    await mkdir(join(f.dshHome, 'profiles', 'foreign'), { recursive: true })
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const lifecycle = startServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { systemdOwnershipChangesProfile: 'foreign' }, 'service-uninstall',
    )

    try {
      const deadline = Date.now() + 6_000
      let ownershipReads = 0
      while (Date.now() < deadline) {
        const state = await readLifecycleSystemdState(f.systemdState)
        const commands = await readLifecycleSystemdLog(f.systemdLog)
        ownershipReads = commands.filter(command => command[1] === 'show'
          && command[2] === 'dsh-profile-foreign.service'
          && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory')).length
        if (state.units['dsh-profile-foreign.service']?.reportedDshHome === f.dshHome
          && ownershipReads >= 2) break
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      }
      expect(ownershipReads).toBeGreaterThanOrEqual(2)
      expect(lifecycle.child.exitCode).toBeNull()
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
      await expect(stat(join(f.dshHome, 'uninstalled-profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
      const commands = await readLifecycleSystemdLog(f.systemdLog)
      expect(commands.some(command => ['stop', 'disable', 'mask'].includes(command[1])
        && command.includes('dsh-profile-foreign.service'))).toBe(false)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-foreign.service'])
        .toMatchObject({ activeState: 'active', starts: 0, reportedDshHome: f.dshHome,
          workingDirectory: join(f.root, 'other-home', 'profiles', 'foreign') })
      const contender = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
      )
      expect(contender.status).not.toBe(0)
      expect(contender.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    } finally {
      const guardianPid = Number(await readFile(join(f.root, 'guardian.pid'), 'utf8').catch(() => '0'))
      if (Number.isSafeInteger(guardianPid) && guardianPid > 1) {
        try { process.kill(-guardianPid, 'SIGKILL') } catch {}
      }
      if (lifecycle.child.pid !== undefined && lifecycle.child.exitCode === null) {
        try { process.kill(-lifecycle.child.pid, 'SIGKILL') } catch {}
      }
      await lifecycle.done
    }
  }, 15_000)

  test('Lark uninstall fail-closes on late conflicting ownership after restart and preserves the backup', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'foreign', active: true, dshHome: '__other__', fragment: 'foreign' },
    ] } })

    const lifecycle = startServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { systemdOwnershipChangesAfterStartProfile: 'foreign' }, 'service-uninstall',
    )

    try {
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const deadline = Date.now() + 6_000
      let ownershipReads = 0
      let manifest: { operation?: string; state?: string } | undefined
      while (Date.now() < deadline) {
        const state = await readLifecycleSystemdState(f.systemdState)
        const commands = await readLifecycleSystemdLog(f.systemdLog)
        ownershipReads = commands.filter(command => command[1] === 'show'
          && command[2] === 'dsh-profile-foreign.service'
          && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory')).length
        manifest = await readFile(join(transaction, 'manifest.json'), 'utf8')
          .then(source => JSON.parse(source)).catch(() => undefined)
        if (state.units['dsh-profile-foreign.service']?.reportedDshHome === f.dshHome
          && state.units['dsh-profile-web.service']?.activeState === 'inactive'
          && ownershipReads >= 2 && manifest?.state === 'swapped') break
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      }
      expect(ownershipReads).toBeGreaterThanOrEqual(2)
      expect(lifecycle.child.exitCode).toBeNull()
      expect(manifest).toMatchObject({ operation: 'uninstall', state: 'swapped' })
      await expect(stat(join(transaction, 'original-home'))).resolves.toBeDefined()
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'inactive' })
      expect(state.units['dsh-profile-foreign.service'])
        .toMatchObject({ activeState: 'active', starts: 0, reportedDshHome: f.dshHome,
          workingDirectory: join(f.root, 'other-home', 'profiles', 'foreign') })
      const commands = await readLifecycleSystemdLog(f.systemdLog)
      expect(commands.some(command => ['stop', 'disable', 'mask'].includes(command[1])
        && command.includes('dsh-profile-foreign.service'))).toBe(false)
      const contender = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
      )
      expect(contender.status).not.toBe(0)
      expect(contender.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    } finally {
      const guardianPid = Number(await readFile(join(f.root, 'guardian.pid'), 'utf8').catch(() => '0'))
      if (Number.isSafeInteger(guardianPid) && guardianPid > 1) {
        try { process.kill(-guardianPid, 'SIGKILL') } catch {}
      }
      if (lifecycle.child.pid !== undefined && lifecycle.child.exitCode === null) {
        try { process.kill(-lifecycle.child.pid, 'SIGKILL') } catch {}
      }
      await lifecycle.done
    }
  }, 15_000)

  test('Lark uninstall accepts an exact same-home installer-generated clean Web baseline sibling', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'baseline', active: true },
    ] } })
    const baselineDirectory = join(f.dshHome, 'profiles', 'baseline')
    const baselineManifest = {
      name: 'dsh-profile-baseline',
      private: true,
      dependencies: {},
      dsh: { profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'live',
      } },
    }
    await writeFile(join(baselineDirectory, 'package.json'), `${JSON.stringify(baselineManifest, null, 2)}\n`)
    await writeFile(join(baselineDirectory, 'cordis.yml'), '[]\n')
    await writeFile(join(baselineDirectory, 'cordis.patch.yml'), '[]\n')
    await writeFile(
      join(baselineDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    )

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { systemdUnsupportedProfile: 'baseline' }, 'service-uninstall',
    )

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(await readFile(join(baselineDirectory, 'package.json'), 'utf8'))).toEqual(baselineManifest)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.find(command => command[1] === 'stop')).toEqual(expect.arrayContaining([
      'dsh-profile-web.service', 'dsh-profile-baseline.service',
    ]))
    expect(commands.find(command => command[1] === 'start')).toEqual(expect.arrayContaining([
      'dsh-profile-web.service', 'dsh-profile-baseline.service',
    ]))
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-baseline.service']).toMatchObject({ activeState: 'active', starts: 1 })
  }, 15_000)

  test('Lark uninstall still rejects an arbitrary unsupported same-home sibling before stopping services', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'custom', active: true },
    ] } })
    const customDirectory = join(f.dshHome, 'profiles', 'custom')
    await writeFile(join(customDirectory, 'package.json'), JSON.stringify({
      name: 'dsh-profile-custom', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2))

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { systemdUnsupportedProfile: 'custom' }, 'service-uninstall',
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/standard Lark|clean Web|installer|baseline|unsupported|标准 Lark|不受支持/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('repeating Lark uninstall on a clean unsupported profile is a no-op without systemd access or a second archive', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const args = ['--operation', 'uninstall', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes']
    const environment = lifecycleEnvironment(f.dshHome, f.fakeBin)
    const first = runInstaller(
      join(f.fixtureInstallDirectory, 'install-local.sh'), args, f.dshHome, 'Linux', environment,
    )
    expect(first.status, first.stderr).toBe(0)
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    const systemdBefore = await readFile(f.systemdLog, 'utf8')

    const repeated = runInstaller(
      join(f.fixtureInstallDirectory, 'install-local.sh'), args, f.dshHome, 'Linux', environment,
    )

    expect(repeated.status, repeated.stderr).toBe(0)
    expect(repeated.stdout).toContain('没有 @dsh-enhanced/* 顶层依赖')
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
    expect(await readFile(f.systemdLog, 'utf8')).toBe(systemdBefore)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('post-swap Lark uninstall failure preserves clean and original homes with every related service stopped', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { systemdJournal: 'stale' }, 'service-uninstall',
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/preserve|保留.*current home.*original-home|readiness|就绪/iu)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({
      version: 2, operation: 'uninstall', expectedScenario: 'lark', stagedScenario: 'unsupported',
      state: 'service-failed', servicePhase: 'service-failed',
    })
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    const current = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    expect(current.dependencies).toEqual({})
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    expect(JSON.parse(await readFile(join(
      f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json',
    ), 'utf8'))).toMatchObject({ dependencies: { '@dsh-enhanced/personal-assistant': '0.1.0' } })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(Object.values(state.units)).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'web', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
      expect.objectContaining({ profile: 'worker', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
      expect.objectContaining({ profile: 'dormant', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
    ]))
  }, 15_000)

  test('post-swap Lark uninstall recovery reaccepts clean unsupported profile without archiving again', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { systemdJournal: 'stale' }, 'service-uninstall',
    )
    expect(first.status).not.toBe(0)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    const firstManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    const archivedManifest = await readFile(join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json'), 'utf8')

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { systemdJournal: 'ready' }, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stdout).toMatch(/重新验收|恢复|完成/iu)
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
    expect(await readFile(join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json'), 'utf8'))
      .toBe(archivedManifest)
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
    await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 2 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 2 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
    expect(firstManifest).toMatchObject({ operation: 'uninstall', stagedScenario: 'unsupported' })
  }, 15_000)

  test.each(['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml'])(
    'post-swap Lark uninstall recovery rejects tampered clean baseline file %s before restart or cleanup',
    async file => {
      const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
      const first = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { systemdJournal: 'stale' }, 'service-uninstall',
      )
      expect(first.status).not.toBe(0)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const backup = join(transaction, 'original-home')
      const backupIdentity = await lifecycleIdentity(backup)
      const startsBefore = (await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']!.starts
      await writeFile(join(f.profileDirectory, file), 'owner-tamper\n')

      const recovered = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { systemdJournal: 'ready' }, 'service-uninstall',
      )

      expect(recovered.status).not.toBe(0)
      expect(recovered.stderr).toMatch(/clean baseline|摘要|installer|不匹配|不是/iu)
      expect(await lifecycleIdentity(backup)).toEqual(backupIdentity)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
        .toMatchObject({ activeState: 'inactive', starts: startsBefore })
      await expect(stat(transaction)).resolves.toBeDefined()
    },
    15_000,
  )

  test('post-swap Lark uninstall recovery rejects a tampered exact clean sibling before restart or cleanup', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'baseline', active: true },
    ] } })
    const baselineDirectory = join(f.dshHome, 'profiles', 'baseline')
    const baselineManifest = {
      name: 'dsh-profile-baseline', private: true, dependencies: {},
      dsh: { profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live',
      } },
    }
    await writeFile(join(baselineDirectory, 'package.json'), `${JSON.stringify(baselineManifest, null, 2)}\n`)
    await writeFile(join(baselineDirectory, 'cordis.yml'), '[]\n')
    await writeFile(join(baselineDirectory, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(baselineDirectory, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { systemdJournal: 'stale', systemdUnsupportedProfile: 'baseline' }, 'service-uninstall',
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupIdentity = await lifecycleIdentity(join(transaction, 'original-home'))
    await writeFile(join(baselineDirectory, 'cordis.patch.yml'), 'owner-tamper\n')

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { systemdJournal: 'ready', systemdUnsupportedProfile: 'baseline' }, 'service-uninstall',
    )

    expect(recovered.status).not.toBe(0)
    expect(recovered.stderr).toMatch(/clean baseline|摘要|installer|不匹配|不是/iu)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(backupIdentity)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-baseline.service'])
      .toMatchObject({ activeState: 'inactive', starts: 1 })
  }, 15_000)

  test.each(['local', 'npm'] as const)(
    'public %s Lark uninstall reaccepts post-swap clean unsupported residue without new archive or registry work',
    async source => {
      const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
      const first = runServiceLifecycle(
        ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, { systemdJournal: 'stale' }, 'service-uninstall',
      )
      expect(first.status).not.toBe(0)
      const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
      const systemdBefore = (await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']!
      expect(systemdBefore).toMatchObject({ activeState: 'inactive', starts: 1 })
      const operationsBefore = await readFile(f.operationLog, 'utf8')
      const script = source === 'local'
        ? join(f.fixtureInstallDirectory, 'install-local.sh')
        : join(f.fixtureInstallDirectory, 'install-npm.sh')
      setLifecycleSystemdControls(f.systemdState, { systemdJournal: 'ready' })

      const recovered = runInstaller(script, [
        '--operation', 'uninstall', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', 'latest'] : []),
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin, { systemdJournal: 'ready' }))

      expect(recovered.status).not.toBe(0)
      expect(recovered.stderr).toMatch(/恢复|recovery|重试/iu)
      expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
      expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBefore)
      expect(operationsBefore).not.toMatch(/^npm-view|^pnpm-store-add/mu)
      await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
        .toMatchObject({ activeState: 'active', starts: 2 })
    },
    15_000,
  )

  test('original-renamed Lark uninstall crash recovery restores the original home and active set', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin,
      { killLifecycleAfterOriginalRename: true }, 'service-uninstall',
    )

    expect(crashed.status).not.toBe(0)
    const transaction = f.dshHome + '.dsh-enhanced-transaction'
    await expect(stat(f.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
    const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(crashManifest).toMatchObject({
      version: 2, operation: 'uninstall', state: 'original-renamed', servicePhase: 'stopped',
      expectedScenario: 'lark', stagedScenario: 'unsupported', originalIdentity,
    })

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0'], f.dshHome, f.fakeBin, {}, 'service-uninstall',
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stderr).toMatch(/original-renamed|原 home.*active service set/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { '@dsh-enhanced/personal-assistant': '0.1.0' },
    })
    await expect(stat(join(f.dshHome, 'uninstalled-profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8')))
      .toMatchObject({ id: crashManifest.id, operation: 'uninstall', state: 'original-renamed' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
  }, 15_000)

  test.each(['web', 'autonomy'] as const)('keeps the %s lifecycle on the stopped-home path', async scenario => {
    const f = await lifecycleFixture({ effectiveScenario: scenario, systemd: {} })

    const result = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', scenario, '--confirm-dsh-home-stopped', '--dry-run',
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('profile 生命周期事务（upgrade）')
    expect(result.stdout).not.toMatch(/systemctl|journalctl/iu)
  })

  test('service-aware upgrade quiesces every profile in the canonical DSH_HOME and restores only the active set', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true, dropIn: 'keyring' },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const keyringPath = join(f.systemdHome, '.config', 'systemd', 'user', 'dsh-profile-web.service.d', 'keyring.conf')
    const keyringBefore = await readFile(keyringPath, 'utf8')

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
    )

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands).toContainEqual([
      '--user', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', 'dsh-profile-*.service',
    ])
    expect(commands).toContainEqual([
      '--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager',
      'dsh-profile-*.service',
    ])
    const stopIndex = commands.findIndex(command => command[1] === 'stop')
    const stop = commands.find(command => command[1] === 'stop')
    expect(new Set(stop?.slice(2))).toEqual(new Set([
      'dsh-profile-web.service', 'dsh-profile-worker.service', 'dsh-profile-dormant.service',
    ]))
    const starts = commands.filter(command => command[1] === 'start')
    expect(starts).toHaveLength(1)
    expect(new Set(starts[0]?.slice(2))).toEqual(new Set(['dsh-profile-web.service', 'dsh-profile-worker.service']))
    expect(starts.flat()).not.toContain('dsh-profile-dormant.service')
    expect(commands.some(command => command[1] === 'disable' || command[1] === 'enable')).toBe(false)
    expect(stopIndex).toBeLessThan(commands.findIndex(command => command[1] === 'start'))
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'active', subState: 'running', starts: 1, nRestarts: 0,
    })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({
      activeState: 'active', subState: 'running', starts: 1, nRestarts: 0,
    })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', starts: 0, mainPid: 0, unitFileState: 'enabled',
    })
    expect(state.units['dsh-profile-web.service']?.invocationId).toMatch(/^fresh-web-/u)
    expect(state.units['dsh-profile-worker.service']?.invocationId).toMatch(/^fresh-worker-/u)
    expect(await readFile(keyringPath, 'utf8')).toBe(keyringBefore)
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])

    const journals = await readLifecycleSystemdLog(f.journalLog)
    for (const profile of ['web', 'worker']) {
      expect(journals).toEqual(expect.arrayContaining([expect.arrayContaining([
        '--unit', `dsh-profile-${profile}.service`,
        expect.stringMatching(new RegExp(`^_SYSTEMD_INVOCATION_ID=fresh-${profile}-`, 'u')),
        '--output=cat', '--no-pager',
      ])]))
    }
  }, 15_000)

  test('service-aware upgrade resets an intentional SIGINT failed state before continuing', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdStopLeavesFailedProfile: 'web' },
    )

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const stopIndex = commands.findIndex(command => command[1] === 'stop')
    const resetIndex = commands.findIndex((command, index) => index > stopIndex
      && command[1] === 'reset-failed' && command.includes('dsh-profile-web.service'))
    const startIndex = commands.findIndex(command => command[1] === 'start')
    expect(resetIndex).toBeGreaterThan(stopIndex)
    expect(resetIndex).toBeLessThan(startIndex)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', subState: 'running' })
  }, 15_000)

  test('service-aware upgrade reads only runtime properties while its bound mask hides static metadata', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdMaskedMetadataEmpty: true, systemdMaskedStaticMetadataOmitted: true },
    )

    expect(result.status, result.stderr).toBe(0)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', subState: 'running' })
  }, 15_000)

  test('service-aware upgrade treats a canonical home alias as the same service home', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const aliasHome = join(f.root, 'home-alias')
    await symlink(f.dshHome, aliasHome, 'dir')
    const unitName = 'dsh-profile-web.service'
    const state = await readLifecycleSystemdState(f.systemdState)
    const unit = state.units[unitName]!
    unit.serviceHome = aliasHome
    unit.reportedDshHome = aliasHome
    unit.workingDirectory = join(aliasHome, 'profiles', 'web')
    await writeFile(unit.fragmentPath, createSystemdUserUnit({
      unitName,
      unitPath: unit.fragmentPath,
      dshHome: aliasHome,
      profile: 'web',
      profileDirectory: join(aliasHome, 'profiles', 'web'),
      nodePath: process.execPath,
      dshPath: join(f.fakeBin, 'dsh'),
      path: `${dirname(process.execPath)}:${f.fakeBin}:/usr/bin:/bin`,
    }), { mode: 0o600 })
    await writeFile(f.systemdState, `${JSON.stringify(state)}\n`, { mode: 0o600 })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop' && command.includes('dsh-profile-web.service'))).toBe(true)
    expect(commands.some(command => command[1] === 'start' && command.includes('dsh-profile-web.service'))).toBe(true)
  }, 15_000)

  test.each([
    ['missing target unit', []],
    ['same unit name for another home', [{ profile: 'web', active: true, dshHome: '__other__' }]],
    ['foreign fragment', [{ profile: 'web', active: true, fragment: 'foreign' }]],
    ['unknown drop-in', [{ profile: 'web', active: true, dropIn: 'unknown' }]],
    ['unsafe keyring drop-in', [{ profile: 'web', active: true, dropIn: 'unsafe-keyring' }]],
  ] as const)('service-aware upgrade rejects %s before stopping or creating a transaction', async (_label, units) => {
    const f = await lifecycleFixture({ systemd: { units } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/service|systemd|unit|drop-in|fragment|DSH_HOME|受管|安全|权限/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a supervised sibling makes a Lark upgrade fail before mask, stop, or transaction creation', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdSupervisedProfile: 'worker' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/supervised|recovery|attestation/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([
    ['stop failure', { systemdStopFailsProfile: 'worker' }],
    ['residual PID', { systemdPidStuckProfile: 'worker' }],
  ] as const)('service-aware upgrade handles %s before package preparation and restores the original active set', async (_label, failure) => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, failure,
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/stop|停止|PID|quiesc|静止|service|systemd|systemctl/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', subState: 'running' })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', subState: 'running' })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
  }, 15_000)

  test('service-aware package failure keeps the old home and restores only the original active services', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageFails: true },
    )

    expect(result.status).not.toBe(0)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
  }, 15_000)

  test('runtime masks prevent an external start during package preparation', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageExternalStartProfile: 'worker' },
    )

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const stopIndex = commands.findIndex(command => command[1] === 'stop')
    const attemptedStartIndexes = commands.map((command, index) => ({ command, index }))
      .filter(({ command }) => command[1] === 'start' && command.includes('dsh-profile-worker.service'))
      .map(({ index }) => index)
    expect(attemptedStartIndexes.some(index => index > stopIndex)).toBe(true)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-worker.service'])
      .toMatchObject({ activeState: 'active', starts: 1 })
  }, 15_000)

  test('filesystem mask and persistent disable barrier are established before stop', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: false },
    ] } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const stopIndex = commands.findIndex(command => command[1] === 'stop')
    const startIndex = commands.findIndex(command => command[1] === 'start')
    expect(commands.some(command => command[1] === 'disable' || command[1] === 'enable')).toBe(false)
    expect(stopIndex).toBeLessThan(startIndex)
  }, 15_000)

  test('restores an originally disabled active unit without enabling it', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true, enabled: false }] } })
    const wantsPath = join(
      f.systemdHome, '.config', 'systemd', 'user', 'default.target.wants', 'dsh-profile-web.service',
    )

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', unitFileState: 'disabled', starts: 1 })
    await expect(lstat(wantsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('refuses a pre-existing user.control mask without stopping or unlinking it', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const controlDirectory = join(f.systemdHome, '.config', 'systemd', 'user.control')
    const maskPath = join(controlDirectory, 'dsh-profile-web.service')
    await mkdir(controlDirectory, { recursive: true, mode: 0o700 })
    await symlink('/dev/null', maskPath)
    const maskBefore = await lstat(maskPath)
    const homeBefore = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/mask|systemd|绑定|身份/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop' || command[1] === 'unmask')).toBe(false)
    expect(await readlink(maskPath)).toBe('/dev/null')
    const maskAfter = await lstat(maskPath)
    expect({ dev: maskAfter.dev, ino: maskAfter.ino }).toEqual({ dev: maskBefore.dev, ino: maskBefore.ino })
    expect(await lifecycleIdentity(f.dshHome)).toEqual(homeBefore)
    await expect(stat(join(f.dshHome, 'profiles', 'web', 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('refuses to unlink a user.control mask whose dev/ino was replaced after ownership was recorded', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const maskPath = join(f.systemdHome, '.config', 'systemd', 'user.control', 'dsh-profile-web.service')

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdReplaceControlMaskOnUnmaskProfile: 'web' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/mask|identity|身份|绑定/iu)
    expect(await readlink(maskPath)).toBe('/dev/null')
    const state = await readLifecycleSystemdState(f.systemdState)
    const replacement = await lstat(maskPath)
    expect({ dev: String(replacement.dev), ino: String(replacement.ino) })
      .toEqual(state.units['dsh-profile-web.service'].replacementMaskIdentity)
  }, 15_000)

  test('a pre-existing runtime mask is never unmasked or converted into lifecycle-owned state', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: false, runtimeMasked: true }] } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].unitFileState)
      .toBe('masked-runtime')
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command[1] === 'unmask')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('post-swap start-intent crash recovery contains the unit before restarting it', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdCrashBeforeStartProfile: 'web' },
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8')))
      .toMatchObject({ version: 2, state: 'swapped', servicePhase: 'starting' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'inactive', unitFileState: 'disabled' })
    const observationsBeforeRecovery = (await readLifecycleSystemdState(f.systemdState)).stopObservations?.length ?? 0
    const beforeRecovery = (await readLifecycleSystemdLog(f.systemdLog)).length

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    const recoveryCommands = (await readLifecycleSystemdLog(f.systemdLog)).slice(beforeRecovery)
    const stopIndex = recoveryCommands.findIndex(command => command[1] === 'stop')
    const startIndex = recoveryCommands.findIndex(command => command[1] === 'start')
    expect(stopIndex).toBeGreaterThanOrEqual(0)
    expect(stopIndex).toBeLessThan(startIndex)
    const recoveryStops = (await readLifecycleSystemdState(f.systemdState)).stopObservations?.slice(observationsBeforeRecovery) ?? []
    expect(recoveryStops[0]).toMatchObject({ unit: 'dsh-profile-web.service', maskPresent: true })
  }, 15_000)

  test('guardian stops a started unit when the lifecycle parent dies after start', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdKillLifecycleDuringStartProfile: 'web' },
    )

    let state = await readLifecycleSystemdState(f.systemdState)
    expect(state.controls.lifecycleParentKilled).toBe(true)
    expect(result.status).not.toBe(0)
    const deadline = Date.now() + 5_000
    while ((state.units['dsh-profile-web.service']?.activeState !== 'inactive'
      || state.units['dsh-profile-web.service']?.mainPid !== 0) && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      state = await readLifecycleSystemdState(f.systemdState)
    }
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
  }, 15_000)

  test('guardian resets failed bookkeeping after stopping a SIGINT-terminated Host', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { guardianDisconnectAfterStart: true, systemdStopLeavesFailedProfile: 'web' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/service crash guardian failed with exit 1/u)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const lastStartIndex = commands.findLastIndex(command => command[1] === 'start')
    expect(commands.some((command, index) => index > lastStartIndex
      && command[1] === 'reset-failed' && command.includes('dsh-profile-web.service'))).toBe(true)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
  }, 15_000)

  test('guardian exits nonzero after parent disconnect even when containment succeeds', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { guardianDisconnectAfterStart: true },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/service crash guardian failed with exit 1/u)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
  }, 15_000)

  test('guardian retries transient census failures through two complete censuses and contains only same-home units', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'foreign', active: true, dshHome: '__other__' },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      {
        guardianDisconnectAfterStart: true,
        systemdDynamicProfile: 'late',
        systemdGuardianListUnitFilesFailureBudget: 1,
        systemdGuardianListUnitsFailureBudget: 1,
        systemdGuardianOwnershipShowFailureBudget: 1,
        systemdGuardianOwnershipShowFailsProfile: 'late',
      },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/service crash guardian failed with exit 1/u)
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
    expect(state.units['dsh-profile-late.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
    expect(state.units['dsh-profile-foreign.service']).toMatchObject({
      activeState: 'active', subState: 'running',
    })
    expect(state.controls).toMatchObject({
      guardianListUnitFilesFailuresRemaining: 0,
      guardianListUnitsFailuresRemaining: 0,
      guardianOwnershipShowFailuresRemaining: 0,
    })
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const lastStartIndex = commands.findLastIndex(command => command[1] === 'start')
    const firstCensusIndex = commands.findIndex((command, index) => index > lastStartIndex
      && command[1] === 'list-unit-files')
    const firstGuardianStopIndex = commands.findIndex((command, index) => index > lastStartIndex
      && command[1] === 'stop' && command.includes('dsh-profile-web.service'))
    expect(firstGuardianStopIndex).toBeGreaterThanOrEqual(0)
    expect(firstGuardianStopIndex).toBeLessThan(firstCensusIndex)
    const dynamicShowIndex = commands.findIndex(command => command[1] === 'show'
      && command[2] === 'dsh-profile-late.service'
      && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory'))
    expect(dynamicShowIndex).toBeGreaterThanOrEqual(0)
    const ownershipShows = commands.filter(command => command[1] === 'show'
      && command[2] === 'dsh-profile-late.service'
      && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory'))
    expect(ownershipShows.length).toBeGreaterThanOrEqual(3)
    expect(commands.filter(command => command[1] === 'list-unit-files').length).toBeGreaterThanOrEqual(4)
    expect(commands.filter(command => command[1] === 'list-units').length).toBeGreaterThanOrEqual(4)
    expect(commands.filter(command => command[1] === 'stop'
      && command.includes('dsh-profile-late.service')).length).toBeGreaterThanOrEqual(2)
    expect(commands.some(command => command[1] === 'stop'
      && command.includes('dsh-profile-foreign.service'))).toBe(false)
  }, 15_000)

  test('guardian keeps retrying persistent ownership failures until it is explicitly killed', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const lifecycle = startServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      {
        guardianDisconnectAfterStart: true,
        systemdDynamicProfile: 'late',
        systemdGuardianOwnershipShowFailureBudget: 100,
        systemdGuardianOwnershipShowFailsProfile: 'late',
      },
    )

    try {
      // A concurrent workspace check can delay the detached guardian's first
      // census; still require two real failed ownership reads before cleanup.
      const deadline = Date.now() + 12_000
      let retryCount = 0
      while (Date.now() < deadline) {
        const commands = await readLifecycleSystemdLog(f.systemdLog)
        retryCount = commands.filter(command => command[1] === 'show'
          && command[2] === 'dsh-profile-late.service'
          && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory')).length
        if (retryCount >= 2) break
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      }
      expect(retryCount).toBeGreaterThanOrEqual(2)
      expect(lifecycle.child.exitCode).toBeNull()
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
        activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
      })
      if (lifecycle.child.pid === undefined) throw new Error('lifecycle test process has no pid')
      process.kill(-lifecycle.child.pid, 'SIGKILL')
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      const contender = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      )
      expect(contender.status).not.toBe(0)
      expect(contender.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    } finally {
      const guardianPid = Number(await readFile(join(f.root, 'guardian.pid'), 'utf8').catch(() => '0'))
      if (Number.isSafeInteger(guardianPid) && guardianPid > 1) {
        try { process.kill(-guardianPid, 'SIGKILL') } catch {}
      }
      if (lifecycle.child.pid !== undefined && lifecycle.child.exitCode === null) {
        try { process.kill(-lifecycle.child.pid, 'SIGKILL') } catch {}
      }
      await lifecycle.done
    }
  }, 25_000)

  test('guardian runtime-mask residue is converted to a bound ledger before recovery unmasks it', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdDynamicProfile: 'late', systemdKillLifecycleDuringStartProfile: 'web' },
    )

    expect(result.status).not.toBe(0)
    let state = await readLifecycleSystemdState(f.systemdState)
    const deadline = Date.now() + 5_000
    while ((state.units['dsh-profile-late.service']?.activeState !== 'inactive'
      || state.units['dsh-profile-late.service']?.mainPid !== 0) && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      state = await readLifecycleSystemdState(f.systemdState)
    }
    expect(state.controls.lifecycleParentKilled).toBe(true)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'inactive', mainPid: 0 })
    expect(state.units['dsh-profile-late.service']).toMatchObject({
      activeState: 'inactive', mainPid: 0, unitFileState: 'masked-runtime',
    })
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'disable' && command.includes('dsh-profile-late.service'))).toBe(true)
    expect(commands.some(command => command[1] === 'mask' && command.includes('dsh-profile-late.service'))).toBe(true)
    const guardianPid = Number(await readFile(join(f.root, 'guardian.pid'), 'utf8'))
    const guardianDeadline = Date.now() + 5_000
    for (;;) {
      const procState = await readFile(`/proc/${guardianPid}/stat`, 'utf8')
        .then(source => source.slice(source.lastIndexOf(') ') + 2, source.lastIndexOf(') ') + 3))
        .catch(error => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
      if (procState === undefined || procState === 'Z') break
      if (Date.now() >= guardianDeadline) throw new Error(`guardian ${guardianPid} did not exit after containment`)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
    }
    const lateStarts = state.units['dsh-profile-late.service'].starts
    const beforeRecovery = commands.length

    const recovered = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
    )

    expect(recovered.status, recovered.stderr).toBe(0)
    state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active' })
    expect(state.units['dsh-profile-late.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, unitFileState: 'disabled', starts: lateStarts,
      boundMaskPresentWhenRuntimeUnmasked: true, boundMaskPersistedWhenRuntimeUnmasked: true,
    })
    const recoveryCommands = (await readLifecycleSystemdLog(f.systemdLog)).slice(beforeRecovery)
    const unmaskIndex = recoveryCommands.findIndex(command => command[1] === 'unmask'
      && command[2] === '--runtime' && command.includes('dsh-profile-late.service'))
    expect(unmaskIndex).toBeGreaterThanOrEqual(0)
    expect(recoveryCommands.some(command => command[1] === 'start'
      && command.includes('dsh-profile-late.service'))).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('guardian never mutates a dynamic unit with conflicting HOME and WorkingDirectory ownership', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    await mkdir(join(f.dshHome, 'profiles', 'conflict'), { recursive: true })
    const lifecycle = startServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { guardianDisconnectAfterStart: true, systemdDynamicProfile: 'conflict', systemdDynamicReportedDshHome: '__other__' },
    )
    const lifecycles = [lifecycle]
    await withGuardianFixtureCleanup(f, lifecycles, async () => {
      // Like the adjacent persistent-owner test, allow startup plus two real
      // censuses. Never interpret an unstarted fixture as an ownership result.
      const deadline = Date.now() + 12_000
      let observed = false
      while (Date.now() < deadline) {
        const commands = await readLifecycleSystemdLog(f.systemdLog)
        const ownershipReads = commands.filter(command => command[1] === 'show'
          && command[2] === 'dsh-profile-conflict.service'
          && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory')).length
        const state = await readLifecycleSystemdState(f.systemdState)
        if (state.units['dsh-profile-conflict.service'] !== undefined && ownershipReads >= 2) { observed = true; break }
        if (lifecycle.child.exitCode !== null || lifecycle.child.signalCode !== null) {
          throw new Error(`lifecycle exited before two ownership observations: ${JSON.stringify(lifecycle.output())}`)
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      }
      if (!observed) throw new Error(`dynamic conflict unit did not reach two ownership observations: ${JSON.stringify(lifecycle.output())}`)
      const commands = await readLifecycleSystemdLog(f.systemdLog)
      expect(commands.some(command => ['stop', 'disable', 'mask'].includes(command[1])
        && command.includes('dsh-profile-conflict.service'))).toBe(false)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-conflict.service'])
        .toMatchObject({ activeState: 'active', unitFileState: 'enabled' })
      expect(lifecycle.child.exitCode).toBeNull()
      const pending = startServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
      lifecycles.push(pending)
      const contender = await lifecycleResult(pending, 'competing lifecycle', 3000)
      expect(contender.status).not.toBe(0)
      expect(contender.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    })
    // 12s observation + 3s cleanup + fixture/contender, matching the neighboring
    // long-lived guardian case rather than changing the global test timeout.
  }, 25_000)

  test('dynamic same-home containment persists a bound mask ledger and completes recovery on retry', async () => {
    const started = Date.now(), durations: Record<string, number> = {}
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    durations.fixture = Date.now() - started
    const lifecycles: ReturnType<typeof startServiceLifecycle>[] = []
    let phase = 'first containment'
    await withGuardianFixtureCleanup(f, lifecycles, async () => {
      const firstStarted = Date.now()
      const pendingFirst = startServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdDynamicProfile: 'late' },
      )

      lifecycles.push(pendingFirst)
      // Keep the original 15s test budget; reserve 3s for exact fixture cleanup.
      const first = await lifecycleResult(pendingFirst, phase, started + 12_000 - Date.now())
      durations.first = Date.now() - firstStarted
      expect(first.status).not.toBe(0)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const firstManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
      const containment = firstManifest.containmentMasks.find((mask: { unit: string }) => (
        mask.unit === 'dsh-profile-late.service'
      ))
      expect(containment).toMatchObject({ target: '/dev/null' })
      const installed = await lstat(containment.path)
      expect({ dev: String(installed.dev), ino: String(installed.ino), uid: installed.uid, mode: installed.mode })
        .toEqual(containment.identity)

      phase = 'recovery'
      const recoveryStarted = Date.now()
      const pendingSecond = startServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
      lifecycles.push(pendingSecond)
      const second = await lifecycleResult(pendingSecond, phase, started + 12_000 - Date.now())
      durations.recovery = Date.now() - recoveryStarted

      expect(second.status, second.stderr).toBe(0)
      await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-late.service']).toMatchObject({
        activeState: 'inactive', starts: 1, unitFileState: 'disabled',
        boundMaskPresentWhenRuntimeUnmasked: true, boundMaskPersistedWhenRuntimeUnmasked: true,
      })
      const recoveryCommands = (await readLifecycleSystemdLog(f.systemdLog)).slice(
        (await readLifecycleSystemdLog(f.systemdLog)).findIndex(command => command[1] === 'unmask'
          && command[2] === '--runtime' && command.includes('dsh-profile-late.service')),
      )
      expect(recoveryCommands[0]).toEqual(expect.arrayContaining([
        '--user', 'unmask', '--runtime', 'dsh-profile-late.service',
      ]))
      expect(recoveryCommands.some(command => command[1] === 'start'
        && command.includes('dsh-profile-late.service'))).toBe(false)
      console.info('lifecycle phase durations', JSON.stringify({ durations, firstStatus: first.status, recoveryStatus: second.status }))
    }).catch(error => {
      throw new Error(`lifecycle phase=${phase} durations=${JSON.stringify(durations)} elapsedMs=${Date.now() - started}\n${String(error)}`, { cause: error })
    })
  }, 15_000)

  test('persisted containment ownership requires coherent HOME and WorkingDirectory evidence', () => {
    const sameHome = '/srv/dsh'
    expect(lifecycleProfileTest.sameHomeOwnershipEvidence(sameHome, `${sameHome}/profiles/late`, sameHome)).toBe(true)
    expect(lifecycleProfileTest.sameHomeOwnershipEvidence('/srv/foreign', `${sameHome}/profiles/late`, sameHome)).toBe(false)
    expect(lifecycleProfileTest.sameHomeOwnershipEvidence(sameHome, '/srv/foreign/profiles/late', sameHome)).toBe(false)
    expect(lifecycleProfileTest.sameHomeOwnershipEvidence(`${sameHome}/nested`, `${sameHome}/nested/profiles/late`, sameHome)).toBe(false)
  })

  test('production lifecycle source cannot enable fake service tools through environment variables', async () => {
    const source = await readFile(join(installDirectory, 'lifecycle-profile.mjs'), 'utf8')

    expect(source).not.toContain('DSH_ENHANCED_TEST_SERVICE_TOOLS')
    expect(source).not.toContain('DSH_ENHANCED_TEST_SSHD_PROOF_PIDS')
    expect(source).not.toContain('DSH_ENHANCED_TEST_SDPAM_PROOF_PIDS')
    expect(source).not.toContain('LIFECYCLE_SYSTEMD_STATE')
    expect(source).toMatch(/entry\.uid !== 0/u)
    expect(source).toMatch(/\['\/usr\/bin', '\/bin'\]\.includes\(dirname\(canonical\)\)/u)
  })

  test('production guardian is detached from the lifecycle process group and contains on terminal signals', async () => {
    const source = await readFile(join(installDirectory, 'lifecycle-profile.mjs'), 'utf8')

    expect(source).toMatch(/const guardian = spawn\(process\.execPath,[\s\S]*?detached: true/du)
    expect(source).toContain("stdio: ['pipe', 'pipe', 'inherit', 3, 4, 5]")
    expect(source).toContain(
      "for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, beginContainment)",
    )
  })

  test('service-aware upgrade handles v1 residue before any transaction rename or deletion', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'legacy-v1-marker'), 'preserve')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state: 'failed',
    })
    await writeFile(join(transaction, 'legacy-v1-marker'), 'present-before-stop')

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
    const state = await readLifecycleSystemdState(f.systemdState)
    const commands = await readLifecycleSystemdLog(f.systemdLog)

    if (commands.some(command => command[1] === 'stop')) {
      expect(state.stopLegacyMarkerExists).toBe(true)
      expect(state.units['dsh-profile-web.service'].maskPresentWhenStopped).toBe(true)
    } else {
      expect(result.status).not.toBe(0)
      expect(await readFile(join(transaction, 'legacy-v1-marker'), 'utf8')).toBe('present-before-stop')
    }
  }, 15_000)

  test('unreadable proc views fail closed for a same-UID process that is not dsh-like', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const opaque = spawn('/usr/bin/python3', ['-c', [
      'import ctypes, time',
      'ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)',
      "print('ready', flush=True)",
      'time.sleep(30)',
    ].join(';')], { cwd: f.root, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      opaque.once('error', rejectReady)
      opaque.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [opaque.pid!] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/无法.*进程|cannot.*process|proc/iu)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
    } finally {
      opaque.kill('SIGKILL')
    }
  }, 15_000)

  test('a proven root sshd auth session with unreadable environ/fd/maps does not block the service upgrade', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const opaque = spawn('/usr/bin/python3', ['-c', [
      'import ctypes, time',
      'libc = ctypes.CDLL(None)',
      'libc.prctl(4, 0, 0, 0, 0)',
      'libc.prctl(15, b"sshd", 0, 0, 0)',
      "print('ready', flush=True)",
      'time.sleep(30)',
    ].join(';')], { cwd: f.root, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      opaque.once('error', rejectReady)
      opaque.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [opaque.pid!], sshdProofPids: [opaque.pid!] },
      )

      expect(result.status, result.stderr).toBe(0)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
        .toMatchObject({ activeState: 'active', subState: 'running' })
    } finally {
      opaque.kill('SIGKILL')
    }
  }, 15_000)

  test('a sshd-comm process whose parent is not a root sshd still fails closed on unreadable environ', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const opaque = spawn('/usr/bin/python3', ['-c', [
      'import ctypes, time',
      'libc = ctypes.CDLL(None)',
      'libc.prctl(4, 0, 0, 0, 0)',
      'libc.prctl(15, b"sshd", 0, 0, 0)',
      "print('ready', flush=True)",
      'time.sleep(30)',
    ].join(';')], { cwd: f.root, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      opaque.once('error', rejectReady)
      opaque.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [opaque.pid!] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/无法确认当前用户进程.*环境/u)
    } finally {
      opaque.kill('SIGKILL')
    }
  }, 15_000)

  test('an ordinary non-dumpable same-UID process without a proven root sshd parent fails closed on unreadable environ', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    // comm 保持 python3（普通进程），仅设 non-dumpable 触发 environ/fd/maps EACCES；
    // 不加入 sshdProofPids，真实证明函数会读到 comm!=sshd 而返回 false → fail-closed。
    const opaque = spawn('/usr/bin/python3', ['-c', [
      'import ctypes, time',
      'libc = ctypes.CDLL(None)',
      'libc.prctl(4, 0, 0, 0, 0)',
      "print('ready', flush=True)",
      'time.sleep(30)',
    ].join(';')], { cwd: f.root, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      opaque.once('error', rejectReady)
      opaque.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [opaque.pid!] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/无法确认当前用户进程.*环境/u)
    } finally {
      opaque.kill('SIGKILL')
    }
  }, 15_000)

  test('a proven systemd (sd-pam) session helper with unreadable environ/fd/maps does not block the service upgrade', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    // non-dumpable 触发 environ/fd/maps EACCES；comm 伪装成 (sd-pam) 会话辅助进程，
    // 经测试证明函数判定为已知 systemd 会话基础设施后放行。
    const opaque = spawn('/usr/bin/python3', ['-c', [
      'import ctypes, time',
      'libc = ctypes.CDLL(None)',
      'libc.prctl(4, 0, 0, 0, 0)',
      "libc.prctl(15, b'(sd-pam)', 0, 0, 0)",
      "print('ready', flush=True)",
      'time.sleep(30)',
    ].join(';')], { cwd: f.root, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      opaque.once('error', rejectReady)
      opaque.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [opaque.pid!], sdPamProofPids: [opaque.pid!] },
      )

      expect(result.status, result.stderr).toBe(0)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
        .toMatchObject({ activeState: 'active', subState: 'running' })
    } finally {
      opaque.kill('SIGKILL')
    }
  }, 15_000)

  test('a proven root sshd auth session with a readable cwd inside DSH_HOME still blocks the upgrade', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    // cwd 必须保持可读（不设 non-dumpable）：这样 proof 豁免后仍能读到 cwd 并检测到 DSH_HOME 引用。
    const opaque = spawn('/usr/bin/python3', ['-c', [
      'import ctypes, time',
      'libc = ctypes.CDLL(None)',
      'libc.prctl(15, b"sshd", 0, 0, 0)',
      "print('ready', flush=True)",
      'time.sleep(30)',
    ].join(';')], { cwd: f.dshHome, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      opaque.once('error', rejectReady)
      opaque.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [opaque.pid!], sshdProofPids: [opaque.pid!] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/拒绝继续/u)
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
        .toMatchObject({ activeState: 'active', starts: 1 })
    } finally {
      opaque.kill('SIGKILL')
    }
  }, 15_000)

  test.each([
    ['cwd', 'import time; print("ready", flush=True); time.sleep(30)'],
    ['fd', 'import os,time; handle=os.open(".", os.O_RDONLY|os.O_DIRECTORY); os.chdir(".."); print("ready", flush=True); time.sleep(30)'],
  ] as const)('a same-UID unmanaged process with %s inside DSH_HOME blocks package work and restores services', async (_reference, source) => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const unmanaged = spawn('/usr/bin/python3', ['-c', source], {
      cwd: f.dshHome, stdio: ['ignore', 'pipe', 'ignore'],
    })
    await new Promise<void>((resolveReady, rejectReady) => {
      unmanaged.once('error', rejectReady)
      unmanaged.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [unmanaged.pid!] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/inventory.*outside|unmanaged|进程.*引用|拒绝继续/iu)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
    } finally {
      unmanaged.kill('SIGKILL')
    }
  }, 15_000)

  test.each(['cwd', 'fd'] as const)('a lifecycle process ancestor with %s inside DSH_HOME is still a strong reference', async reference => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { processAncestorReference: reference },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/inventory.*outside|unmanaged|进程.*引用|拒绝继续/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  }, 15_000)

  test('a PID appearing before rename prevents the home swap', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdQuiescenceDriftProfile: 'worker' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/inactive|PID0|quiesc|静止|systemd/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.dshHome, 'profiles', 'web', 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('an originally inactive target upgrades without being started and is unmasked afterward', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: false },
      { profile: 'worker', active: true },
    ] } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', mainPid: 0, starts: 0, unitFileState: 'enabled',
    })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.find(command => command[1] === 'start')).not.toContain('dsh-profile-web.service')
    expect(commands.some(command => command[1] === 'enable' || command[1] === 'disable')).toBe(false)
    await expect(readlink(join(
      f.systemdHome, '.config', 'systemd', 'user', 'default.target.wants', 'dsh-profile-web.service',
    ))).resolves.toBe(join(f.systemdHome, '.config', 'systemd', 'user', 'dsh-profile-web.service'))
  }, 15_000)

  test.each([
    ['start failure', { systemdStartFailsProfile: 'web' }],
    ['start success followed by an immediate failed state', { systemdReadinessFailsProfile: 'web' }],
    ['fresh invocation without readiness', { systemdJournal: 'stale' as const }],
    ['journal query failure', { systemdJournal: 'fail' as const }],
    ['journal command disappearance', { systemdJournal: 'missing' as const }],
    ['restart loop', { systemdRestartLoopProfile: 'web' }],
  ])('service-aware upgrade preserves both homes and bound evidence after %s', async (_label, failure) => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, failure,
    )

    expect(result.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 2, operation: 'upgrade', profile: 'web', servicePhase: 'service-failed' })
    expect(manifest.services).toHaveLength(3)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    expect(await readFile(join(f.dshHome, 'profiles', 'web', 'upgraded'), 'utf8')).toBe('upgraded\n')
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(Object.values(state.units)).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'web', activeState: 'inactive', mainPid: 0 }),
      expect.objectContaining({ profile: 'worker', activeState: 'inactive', mainPid: 0 }),
      expect.objectContaining({ profile: 'dormant', activeState: 'inactive', mainPid: 0 }),
    ]))
  }, 15_000)

  test('service-aware upgrade preserves sorted resident RSI environment with quoted paths', async () => {
    const environment = {
      DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: '/tmp/dsh rsi/attestor%"\\config.json',
      DSH_RELEASE_PR_CONFIG: '/tmp/dsh rsi/pr config.json',
    }
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true, serviceEnvironment: environment },
    ] } })
    const bindingPath = join(f.dshHome, 'rsi-service-environments', 'web.json')
    const original = await readFile(bindingPath, 'utf8')
    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(bindingPath, 'utf8')).toBe(original)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].serviceEnvironment)
      .toEqual(environment)
  }, 15_000)

  test('service-aware upgrade failure keeps original and staged RSI environment bindings', async () => {
    const environment = { DSH_RELEASE_BUILD_CONFIG: '/tmp/dsh rsi/build%config.json' }
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true, serviceEnvironment: environment },
    ] } })
    const original = await readFile(join(f.dshHome, 'rsi-service-environments', 'web.json'), 'utf8')
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' },
    )
    expect(result.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(await readFile(join(f.dshHome, 'rsi-service-environments', 'web.json'), 'utf8')).toBe(original)
    expect(await readFile(join(transaction, 'original-home', 'rsi-service-environments', 'web.json'), 'utf8'))
      .toBe(original)
  }, 15_000)

  test('service-aware upgrade restores the original RSI binding after package failure', async () => {
    const environment = { DSH_RELEASE_MERGE_CONFIG: '/tmp/dsh rsi/merge config.json' }
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true, serviceEnvironment: environment },
    ] } })
    const bindingPath = join(f.dshHome, 'rsi-service-environments', 'web.json')
    const original = await readFile(bindingPath, 'utf8')
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageFails: true },
    )
    expect(result.status).not.toBe(0)
    expect(await readFile(bindingPath, 'utf8')).toBe(original)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].activeState)
      .toBe('active')
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('service-aware upgrade rejects RSI binding changes inside staged home', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true, serviceEnvironment: { DSH_RELEASE_PR_CONFIG: '/tmp/pr.json' } },
    ] } })
    const bindingPath = join(f.dshHome, 'rsi-service-environments', 'web.json')
    const original = await readFile(bindingPath, 'utf8')
    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { packageWriteRelative: 'rsi-service-environments/web.json' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/Environment|绑定/u)
    expect(await readFile(bindingPath, 'utf8')).toBe(original)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test.each(['binding file', 'effective environment'] as const)(
    'service-aware upgrade rejects %s drift before package work', async drift => {
      const environment = { DSH_RELEASE_SIGN_CONFIG: '/tmp/dsh rsi/sign config.json' }
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true, serviceEnvironment: environment },
      ] } })
      if (drift === 'binding file') {
        await writeFile(join(f.dshHome, 'rsi-service-environments', 'web.json'), `${JSON.stringify({
          schemaVersion: 1, dshHome: f.dshHome, profile: 'web', environment: {
            DSH_RELEASE_SIGN_CONFIG: '/tmp/dsh rsi/other config.json',
          },
        })}\n`)
      } else {
        const state = await readLifecycleSystemdState(f.systemdState)
        state.units['dsh-profile-web.service'].serviceEnvironment.DSH_RELEASE_SIGN_CONFIG = '/tmp/other config.json'
        await writeFile(f.systemdState, `${JSON.stringify(state)}\n`)
      }
      const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Environment|绑定/u)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    }, 15_000,
  )

  test.each(['unknown name', 'unsorted names'] as const)(
    'service-aware upgrade rejects unit RSI Environment with %s', async mutation => {
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true, serviceEnvironment: {
          DSH_RELEASE_BUILD_CONFIG: '/tmp/build.json', DSH_RELEASE_PR_CONFIG: '/tmp/pr.json',
        } },
      ] } })
      const unitPath = join(f.systemdHome, '.config', 'systemd', 'user', 'dsh-profile-web.service')
      let source = await readFile(unitPath, 'utf8')
      if (mutation === 'unknown name') {
        source = source.replace('DSH_RELEASE_BUILD_CONFIG=', 'DSH_RELEASE_OTHER_CONFIG=')
      } else {
        source = source.replace(
          'Environment="DSH_RELEASE_BUILD_CONFIG=/tmp/build.json"\nEnvironment="DSH_RELEASE_PR_CONFIG=/tmp/pr.json"',
          'Environment="DSH_RELEASE_PR_CONFIG=/tmp/pr.json"\nEnvironment="DSH_RELEASE_BUILD_CONFIG=/tmp/build.json"',
        )
      }
      await writeFile(unitPath, source)
      const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/Environment/u)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    }, 15_000,
  )

  test('service-failed recovery reaccepts the swapped home without repeating package preparation', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })

    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' },
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8')))
      .toMatchObject({ version: 2, state: 'service-failed', servicePhase: 'service-failed' })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)

    const second = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'ready' },
    )

    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toMatch(/重新验收|恢复|完成/iu)
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 2 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 2 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
  }, 15_000)

  test('service-failed recovery that fails again preserves both homes and does not repeat package work', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' },
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const firstManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(firstManifest).toMatchObject({ version: 2, state: 'service-failed', servicePhase: 'service-failed' })
    const stagedIdentity = await lifecycleIdentity(f.dshHome)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)

    const second = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdReadinessFailsProfile: 'web' },
    )

    expect(second.status).not.toBe(0)
    expect(second.stderr).toMatch(/readiness|failed|验收|失败/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(stagedIdentity)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    const secondManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(secondManifest).toMatchObject({
      version: 2, id: firstManifest.id, state: 'service-failed', servicePhase: 'service-failed',
    })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(Object.values(state.units)).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'web', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
      expect.objectContaining({ profile: 'worker', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
      expect.objectContaining({ profile: 'dormant', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
    ]))
  }, 15_000)

  test('v2 original-renamed crash recovery restores the original home and active service set', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { killLifecycleAfterOriginalRename: true },
    )

    expect(crashed.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    await expect(stat(f.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(crashManifest).toMatchObject({
      version: 2, state: 'original-renamed', servicePhase: 'stopped', originalIdentity,
    })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stderr).toMatch(/original-renamed|原 home.*active service set/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.dshHome, 'profiles', 'web', 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8')))
      .toMatchObject({ version: 2, id: crashManifest.id, state: 'original-renamed', servicePhase: 'stopped' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
  }, 15_000)

  test.each(['local', 'npm'] as const)(
    'public %s Lark upgrade recovers real original-renamed v2 residue before new work and requires retry',
    async source => {
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
      ] } })
      const originalIdentity = await lifecycleIdentity(f.dshHome)
      const crashed = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { killLifecycleAfterOriginalRename: true },
      )
      expect(crashed.status).not.toBe(0)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
      expect(crashManifest).toMatchObject({ version: 2, state: 'original-renamed', expectedScenario: 'lark' })
      const operationsBeforeRecovery = await readFile(f.operationLog, 'utf8')
      expect(operationsBeforeRecovery.match(/^dsh-add\t/gmu)).toHaveLength(1)

      const script = source === 'local' ? localInstaller : npmInstaller
      const recovered = runInstaller(script, [
        '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', '1.4.0'] : []),
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

      expect(recovered.status).not.toBe(0)
      expect(recovered.stderr).toMatch(/恢复|recovery|重试/iu)
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBeforeRecovery)
      expect(operationsBeforeRecovery).not.toMatch(/^npm-view|^pnpm-store-add/mu)
      await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toHaveLength(1)
      expect(JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8')))
        .toMatchObject({ version: 2, id: crashManifest.id, state: 'original-renamed' })
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
    },
    15_000,
  )

  test.each([
    ['post-package', { configAfterUpgrade: `- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'` }],
    ['post-activation', { configAfterActivation: `- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'` }],
  ] as const)('service-aware upgrade rejects %s scenario drift before swap and restores the original active set',
    async (phase, drift) => {
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
      ] } })
      const originalIdentity = await lifecycleIdentity(f.dshHome)
      const originalConfig = await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')
      const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, drift,
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/scenario|场景|lark|web/iu)
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      expect(await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')).toBe(originalConfig)
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
      expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
      await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toHaveLength(1)
      const stagedActivationMarker = join(preserved[0]!, 'staged-home', '.activation-ran')
      if (phase === 'post-activation') expect(await readFile(stagedActivationMarker, 'utf8')).toBe('')
      else await expect(stat(stagedActivationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    15_000,
  )

  test('cleanup-started recovery without original-home freshly reaccepts and does not repeat package work', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' },
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const manifestPath = join(transaction, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await rm(join(transaction, 'original-home'), { recursive: true })
    const cleanupStarted = { ...manifest, state: 'cleanup-started', servicePhase: 'service-accepted' }
    const rebound = {
      ...cleanupStarted,
      updatedAt: '2026-09-09T12:00:00.000Z',
      bindingDigest: createHash('sha256').update(JSON.stringify(serviceLifecycleBinding(cleanupStarted))).digest('hex'),
    }
    await writeFile(manifestPath, `${JSON.stringify(rebound, null, 2)}\n`, { mode: 0o600 })
    const before = await readFile(f.operationLog, 'utf8')
    setLifecycleSystemdControls(f.systemdState, { systemdJournal: 'ready' })

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stdout).toMatch(/重新验收|恢复|完成/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe(before)
    expect(await preservedLifecycleTransactions(f.dshHome), recovered.stderr).toEqual([])
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', starts: 2 })
  }, 15_000)

  test('canonical cleanup failure preserves a bound transaction and the next run cleans it without repeating package work', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { canonicalCleanupFails: true },
    )

    expect(first.status).not.toBe(0)
    expect(first.stderr).toMatch(/canonical.*cleanup|清理失败|residue/iu)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const firstManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(firstManifest).toMatchObject({
      version: 2, state: 'cleanup-started', servicePhase: 'service-accepted',
    })
    expect(firstManifest.transactionIdentity).toMatchObject(await lifecycleIdentity(transaction))
    expect(firstManifest.originalIdentity).toMatchObject(await lifecycleIdentity(join(transaction, 'original-home')))
    const operationsBeforeRecovery = await readFile(f.operationLog, 'utf8')
    expect(operationsBeforeRecovery.match(/^dsh-add\t/gmu)).toHaveLength(1)

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stdout).toMatch(/重新验收|恢复|完成/iu)
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
    expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBeforeRecovery)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', starts: 2 })
  }, 15_000)

  test.each(['hash', 'identity'] as const)('service-aware upgrade rejects keyring drop-in %s drift before swap', async mutation => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true, dropIn: 'keyring' }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdDropInMutation: mutation },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/drop-in|identity|hash|摘要|身份|变化/iu)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'inactive', subState: 'dead' })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(await lifecycleIdentity(f.dshHome)).toBeDefined()
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 2, operation: 'upgrade', profile: 'web' })
  }, 15_000)
  })
})
