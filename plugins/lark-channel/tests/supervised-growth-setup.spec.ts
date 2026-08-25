import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import {
  assertSupervisedGrowthAutomationGuard,
  activateSupervisedGrowthPatch,
  commitSupervisedGrowthPatch,
  parseSupervisedGrowthSetupArgs,
  sameSupervisedGrowthBinding,
  selectUniqueOwnerBinding,
  verifySupervisedGrowthTraexReadiness,
  verifySupervisedGrowthResidentService,
} from '../src/supervised-growth-setup.ts'

const roots: string[] = []
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const binding = {
  id: 'binding-owner',
  conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
  principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
  workspace: '/work/owner',
  agentPreset: 'standard',
  sessionId: 'session-owner',
  generation: 1,
  policyRef: 'owner-dm',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  version: 1,
} as const

describe('supervised-growth setup guards', () => {
  test('requires an explicit acknowledgement before every existing active job can coexist', () => {
    expect(() => assertSupervisedGrowthAutomationGuard([
      { id: 'owner-created-job', status: 'active' },
    ], false)).toThrow(/ack-existing-automations/i)
    expect(() => assertSupervisedGrowthAutomationGuard([
      { id: 'heartbeat:legacy', owner: 'assistant-heartbeat', status: 'active' },
    ], false)).toThrow(/ack-existing-automations/i)
    expect(() => assertSupervisedGrowthAutomationGuard([
      {
        id: 'heartbeat:legacy-high-privilege',
        owner: 'assistant-heartbeat',
        status: 'active',
        definition: { allowedTools: ['bash', 'read'], provider: 'deepseek-official' },
      },
    ], false)).toThrow(/ack-existing-automations/i)
    expect(() => assertSupervisedGrowthAutomationGuard([
      { id: 'owner-created-job', status: 'active' },
    ], true)).not.toThrow()
  })

  test('refuses no or multiple matching owner DMs instead of guessing a recipient', () => {
    expect(() => selectUniqueOwnerBinding([])).toThrow(/send the bot a new direct message/i)
    expect(() => selectUniqueOwnerBinding([binding, { ...binding, id: 'binding-second' }])).toThrow(/multiple/i)
    expect(selectUniqueOwnerBinding([binding])).toEqual(binding)
  })

  test('treats any durable owner-route/version change as stale before activation', () => {
    expect(sameSupervisedGrowthBinding(binding, { ...binding })).toBe(true)
    expect(sameSupervisedGrowthBinding(binding, { ...binding, version: 2 })).toBe(false)
    expect(sameSupervisedGrowthBinding(binding, { ...binding, status: 'revoked' })).toBe(false)
    expect(sameSupervisedGrowthBinding(binding, {
      ...binding, conversation: { ...binding.conversation, chat: 'oc_other' },
    })).toBe(false)
    expect(sameSupervisedGrowthBinding(binding, { ...binding, agentPreset: 'other' })).toBe(false)
  })

  test('accepts only bounded explicit CLI flags', () => {
    expect(parseSupervisedGrowthSetupArgs(['--profile', 'web', '--timeout-ms', '30000', '--ack-existing-automations']))
      .toMatchObject({ profile: 'web', timeoutMs: 30000, ackExistingAutomations: true })
    expect(() => parseSupervisedGrowthSetupArgs(['--no-service'])).toThrow(/unknown option/i)
    expect(() => parseSupervisedGrowthSetupArgs(['--timeout-ms', '1'])).toThrow(/30000/i)
  })

  test('rolls back the atomic profile update when DSH validation rejects the overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervised-growth-rollback-'))
    roots.push(root)
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original\n', 'utf8')

    await expect(commitSupervisedGrowthPatch({
      patchPath,
      originalPatch: 'original\n',
      updatedPatch: 'updated\n',
      validate: () => { throw new Error('invalid profile') },
    })).rejects.toThrow('invalid profile')
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('original\n')
  })

  test('restores the original profile and resident service if the post-write restart health gate fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervised-growth-restart-rollback-'))
    roots.push(root)
    const patchPath = join(root, 'cordis.patch.yml')
    await writeFile(patchPath, 'original\n', 'utf8')
    let restored = 0

    await expect(activateSupervisedGrowthPatch({
      patchPath,
      originalPatch: 'original\n',
      updatedPatch: 'updated\n',
      validate: () => 'effective updated',
      afterCommit: async () => { throw new Error('resident service is not healthy') },
      restore: async () => { restored += 1 },
    })).rejects.toThrow(/resident service is not healthy/i)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('original\n')
    expect(restored).toBe(1)
  })

  test('requires a bounded, verifiable resident-running state instead of registration alone', async () => {
    const service = {
      kind: 'launchd' as const,
      target: 'gui/501/ai.dsh.web',
      statusCommand: 'launchctl print gui/501/ai.dsh.web',
      logCommand: 'tail -f /tmp/dsh.log',
    }
    await expect(verifySupervisedGrowthResidentService(service, {
      attempts: 1,
      run: () => ({ status: 0, stdout: 'state = exited\nlast exit code = 1\n', stderr: '' }),
    })).rejects.toThrow(/healthy/i)
    await expect(verifySupervisedGrowthResidentService(service, {
      attempts: 1,
      run: (command, args) => {
        expect(command).toBe('/bin/launchctl')
        expect(args).toEqual(['print', 'gui/501/ai.dsh.web'])
        return { status: 0, stdout: 'state = running\n', stderr: '' }
      },
    })).resolves.toBeUndefined()
    await expect(verifySupervisedGrowthResidentService({ ...service, kind: 'windows-task-best-effort' }, {
      attempts: 1,
      run: () => ({ status: 0, stdout: '', stderr: '' }),
    })).rejects.toThrow(/verifiable resident health/i)
  })

  test('fails closed unless the explicit prompt-free TraeX readiness probe returns a usable catalog', async () => {
    const calls: unknown[][] = []
    const readiness = async (...args: unknown[]) => {
      calls.push(args)
      return { models: [{ id: 'default' }] }
    }
    await expect(verifySupervisedGrowthTraexReadiness({
      traexConfig: { enabled: true, cwd: '/work/owner' }, timeoutMs: 30_000,
    }, {
      load: async () => ({ Config: value => value, probeTraexReadiness: readiness }),
    })).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toMatchObject({ timeoutMs: 30_000 })

    await expect(verifySupervisedGrowthTraexReadiness({
      traexConfig: { enabled: true, cwd: '/work/owner' }, timeoutMs: 30_000,
    }, {
      load: async () => ({ Config: value => value, probeTraexReadiness: async () => ({ models: [] }) }),
    })).rejects.toThrow(/no usable TraeX models/i)
    await expect(verifySupervisedGrowthTraexReadiness({
      traexConfig: { enabled: true, cwd: '/work/owner' }, timeoutMs: 30_000,
    }, {
      load: async () => { throw new Error('provider unavailable') },
    })).rejects.toThrow(/provider unavailable/i)
    await expect(verifySupervisedGrowthTraexReadiness({
      traexConfig: { enabled: true, cwd: '/work/owner' }, timeoutMs: 30_000,
    }, {
      load: async () => ({ Config: value => value, probeTraexReadiness: async () => {
        throw new Error('TraeX login required')
      } }),
    })).rejects.toThrow(/login required/i)
    await expect(verifySupervisedGrowthTraexReadiness({
      traexConfig: { enabled: true, cwd: '/work/owner' }, timeoutMs: 10,
    }, {
      load: async () => ({ Config: value => value, probeTraexReadiness: async () => new Promise(() => {}) }),
    })).rejects.toThrow(/timed out/i)
  })

  test('the real pnpm-profile .bin entrypoint prints help and leaves the profile untouched', async () => {
    const build = spawnSync('pnpm', ['--filter', '@dsh-enhanced/lark-channel', 'run', 'build'], {
      cwd: repoRoot, encoding: 'utf8',
    })
    expect(build.status, build.stderr).toBe(0)

    const dshHome = await mkdtemp(join(tmpdir(), 'supervised-growth-profile-bin-'))
    roots.push(dshHome)
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const nodeModules = join(profileDirectory, 'node_modules')
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    await mkdir(join(nodeModules, '@dsh-enhanced'), { recursive: true })
    await writeFile(patchPath, '[]\n', 'utf8')
    await symlink(join(repoRoot, 'plugins', 'lark-channel'), join(nodeModules, '@dsh-enhanced', 'lark-channel'), 'dir')
    await mkdir(join(nodeModules, '.bin'))
    const binary = join(nodeModules, '.bin', 'dsh-supervised-growth-setup')
    await symlink('../@dsh-enhanced/lark-channel/lib/supervised-growth-setup.js', binary, 'file')

    const result = spawnSync(binary, ['--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: dsh-supervised-growth-setup')
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
    await expect(readFile(join(dshHome, 'assistant-delivery', 'state.sqlite'))).rejects.toThrow()
    await expect(readFile(join(dshHome, 'assistant-automations', 'state.sqlite'))).rejects.toThrow()
  })
})
