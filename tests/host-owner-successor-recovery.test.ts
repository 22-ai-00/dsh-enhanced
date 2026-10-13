import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'host-owner-successor-recovery-')))
  roots.push(root)
  const homePath = join(root, 'home')
  const stagedPath = join(root, 'staged-home')
  const foreignPath = join(root, 'foreign-home')
  const backupPath = join(root, 'original-home')
  for (const path of [homePath, stagedPath, foreignPath]) await mkdir(path, { mode: 0o700 })
  const original = await lstat(homePath)
  const staged = await lstat(stagedPath)
  const foreign = await lstat(foreignPath)
  const identity = { dev: String(original.dev), ino: String(original.ino), uid: original.uid, mode: original.mode }
  const stagedIdentity = { dev: String(staged.dev), ino: String(staged.ino), uid: staged.uid, mode: staged.mode }
  const intent = { currentCandidateIdentity: identity,
    successorTransactionId: '11111111-1111-4111-8111-111111111111' }
  const child = (candidateEverStarted: boolean) => ({ id: intent.successorTransactionId,
    originalIdentity: identity, stagedIdentity,
    hostMigration: { candidateEverStarted } })
  return { root, homePath, stagedPath, foreignPath, backupPath, original, staged, foreign, intent, child }
}

test('initial pending, archived without child, and empty child require the exact live candidate inode', async () => {
  const setup = await fixture()
  const decide = (homeIdentity = setup.original, emptyActiveDirectory = false) =>
    lifecycleProfileTest.ownerSuccessorRecoveryDecision({ intent: setup.intent, homeIdentity, emptyActiveDirectory })
  expect(decide()).toBe('prepare-child')
  expect(decide(setup.original, true)).toBe('clean-empty-child')
  expect(() => decide(setup.foreign)).toThrow('no bound transaction for the current Home')
  expect(() => decide(setup.foreign, true)).toThrow('no bound transaction for the current Home')
  expect(() => lifecycleProfileTest.ownerSuccessorRecoveryDecision({ intent: setup.intent }))
    .toThrow('no bound transaction for the current Home')
})

test('child transaction must keep the signed current candidate as its original identity', async () => {
  const setup = await fixture()
  const child = setup.child(false)
  expect(() => lifecycleProfileTest.ownerSuccessorRecoveryDecision({ intent: setup.intent,
    activeManifest: { ...child, originalIdentity: { ...child.originalIdentity, ino: String(setup.foreign.ino) } },
    homeIdentity: setup.original })).toThrow('child baseline differs')
  expect(() => lifecycleProfileTest.ownerSuccessorRecoveryDecision({ intent: setup.intent,
    activeManifest: { ...child, id: '22222222-2222-4222-8222-222222222222' },
    homeIdentity: setup.original })).toThrow('child baseline differs')
  expect(() => lifecycleProfileTest.ownerSuccessorRecoveryDecision({ intent: setup.intent,
    activeManifest: child, emptyActiveDirectory: true, homeIdentity: setup.original }))
    .toThrow('child baseline differs')
})

test('prestart recovery permits current original, rename gap with bound backup, and staged plus backup only', async () => {
  const setup = await fixture()
  const child = setup.child(false)
  const decide = (homeIdentity?: typeof setup.original, backupIdentity?: typeof setup.original) =>
    lifecycleProfileTest.ownerSuccessorRecoveryDecision({ intent: setup.intent,
      activeManifest: child, homeIdentity, backupIdentity })
  expect(decide(setup.original)).toBe('recover-child')
  await rename(setup.homePath, setup.backupPath)
  const backup = await lstat(setup.backupPath)
  expect(decide(undefined, backup)).toBe('recover-child')
  expect(() => decide(undefined)).toThrow('prestart Home identities are unknown')
  await rename(setup.stagedPath, setup.homePath)
  const liveStaged = await lstat(setup.homePath)
  expect(decide(liveStaged, backup)).toBe('recover-child')
  expect(() => decide(liveStaged)).toThrow('prestart Home identities are unknown')
  expect(() => decide(setup.foreign, backup)).toThrow('prestart Home identities are unknown')
  expect(() => decide(liveStaged, setup.foreign)).toThrow('prestart Home identities are unknown')
})

test('poststart recovery accepts only the bound staged Home, never original, missing, or foreign', async () => {
  const setup = await fixture()
  const child = setup.child(true)
  const decide = (homeIdentity?: typeof setup.original) =>
    lifecycleProfileTest.ownerSuccessorRecoveryDecision({ intent: setup.intent,
      activeManifest: child, homeIdentity, backupIdentity: setup.original })
  expect(decide(setup.staged)).toBe('recover-child')
  for (const homeIdentity of [setup.original, setup.foreign, undefined]) {
    expect(() => decide(homeIdentity)).toThrow('started owner successor candidate is unavailable')
  }
})
