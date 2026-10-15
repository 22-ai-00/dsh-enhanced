import { describe, expect, test, vi } from 'vitest'
import { controlDshLaunchAgent, runLaunchdControl } from '../src/launchd-control.ts'

const input = { dshHome: '/Users/test/.dsh', profile: 'web' }
const active = { target: 'gui/501/ai.deepseek.dsh.profile.web', plistPath: '/Users/test/Library/LaunchAgents/ai.deepseek.dsh.profile.web.plist',
  registered: true, running: true, pid: 123, identity: { nodePath: '/usr/bin/node', dshPath: '/opt/dsh.js', dshSha256: 'a'.repeat(64) } }
const absent = { ...active, registered: false, running: false, pid: 0, identity: null }
const lock = async <T>(_input: typeof input, operation: () => Promise<T>) => operation()

describe('Mac installer service control', () => {
  test('distinguishes a registered but inactive service from a running Host', async () => {
    const inspect = vi.fn(async () => ({ ...active, running: false, pid: 0 }))
    expect(await controlDshLaunchAgent(input, 'registered', { platform: 'darwin', inspect })).toBe(true)
    expect(await controlDshLaunchAgent(input, 'running', { platform: 'darwin', inspect })).toBe(false)
  })

  test('never restarts a foreign or uninspectable service', async () => {
    const inspect = vi.fn(async () => { throw new Error('loaded service belongs to another installation') })
    const run = vi.fn()
    await expect(controlDshLaunchAgent(input, 'restart', { platform: 'darwin', inspect, run, lock })).rejects.toThrow('another installation')
    expect(run).not.toHaveBeenCalled()
  })

  test('only the optional model reload tolerates an absent service', async () => {
    const inspect = vi.fn(async () => absent), run = vi.fn()
    expect(await controlDshLaunchAgent(input, 'restart-if-loaded', { platform: 'darwin', inspect, run, lock })).toBe(false)
    await expect(controlDshLaunchAgent(input, 'restart', { platform: 'darwin', inspect, run, lock })).rejects.toThrow('not registered')
    expect(run).not.toHaveBeenCalled()
  })

  test('requires a fresh running PID after a successful kickstart', async () => {
    const inspect = vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(active).mockResolvedValue({ ...active, pid: 456 })
    const run = vi.fn(() => ({ status: 0, stderr: '' })), wait = vi.fn(async () => {})
    expect(await controlDshLaunchAgent(input, 'restart', { platform: 'darwin', inspect, run, wait, lock })).toBe(true)
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith('/bin/launchctl', ['kickstart', '-k', active.target])
  })

  test('preserves restart failure and rejects identity changes during restart', async () => {
    const inspect = vi.fn(async () => active)
    await expect(controlDshLaunchAgent(input, 'restart', { platform: 'darwin', inspect, lock,
      run: () => ({ status: 5, stderr: 'restart denied' }) })).rejects.toThrow('restart denied')
    inspect.mockResolvedValueOnce(active).mockResolvedValue({ ...active, pid: 456,
      identity: { ...active.identity, dshSha256: 'b'.repeat(64) } })
    await expect(controlDshLaunchAgent(input, 'restart', { platform: 'darwin', inspect, lock,
      run: () => ({ status: 0 }) })).rejects.toThrow('identity changed')
  })

  test('does not report the old PID as a completed restart', async () => {
    await expect(controlDshLaunchAgent(input, 'restart', { platform: 'darwin', inspect: async () => active,
      run: () => ({ status: 0 }), lock, timeoutMs: 1 })).rejects.toThrow('new running Host')
  })

  test('validates the internal dispatch before inspecting or mutating services', async () => {
    await expect(runLaunchdControl(['--profile', 'web', '--action', 'purge'])).rejects.toThrow('missing launchd')
    await expect(runLaunchdControl(['--profile', 'web', '--profile', 'other'])).rejects.toThrow('invalid launchd')
  })
})
