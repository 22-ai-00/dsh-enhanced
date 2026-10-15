import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectDshLaunchAgent } from './launchd.js'
import { withLaunchAgentTargetLock } from './launchd-target-lock.js'

type ServiceInput = { dshHome: string; profile: string }
type ServiceState = Awaited<ReturnType<typeof inspectDshLaunchAgent>>
export type LaunchAgentAction = 'registered' | 'running' | 'restart' | 'restart-if-loaded'
export interface LaunchAgentControlOptions {
  platform?: NodeJS.Platform
  inspect?: (input: ServiceInput) => Promise<ServiceState>
  run?: (command: string, args: string[]) => { status: number | null; stderr?: string }
  lock?: <T>(input: ServiceInput, operation: () => Promise<T>) => Promise<T>
  wait?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

/** Service-only operations never install a plist or run onboarding. */
export async function controlDshLaunchAgent(input: ServiceInput, action: LaunchAgentAction,
  options: LaunchAgentControlOptions = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('launchd service control requires macOS')
  if (!isAbsolute(input.dshHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.profile)) {
    throw new Error('invalid launchd service identity')
  }
  const inspect = options.inspect ?? inspectDshLaunchAgent
  if (action === 'registered' || action === 'running') {
    const state = await inspect(input)
    return state.registered && (action === 'registered' || state.running)
  }
  const run = options.run ?? ((command, args) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 262_144,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['ignore', 'ignore', 'pipe'],
  }))
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('invalid launchd restart deadline')
  return (options.lock ?? withLaunchAgentTargetLock)(input, async () => {
    const before = await inspect(input)
    if (!before.registered) {
      if (action === 'restart-if-loaded') return false
      throw new Error('launchd service is not registered for this DSH_HOME')
    }
    const result = run('/bin/launchctl', ['kickstart', '-k', before.target])
    if (result.status !== 0) throw new Error(`launchd restart failed: ${result.stderr?.trim() || `exit ${result.status}`}`)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = await inspect(input)
      if (current.target !== before.target || current.plistPath !== before.plistPath
        || (current.registered && JSON.stringify(current.identity) !== JSON.stringify(before.identity))) {
        throw new Error('launchd service identity changed during restart')
      }
      if (current.registered && current.running && current.pid !== before.pid) return true
      if (Date.now() >= deadline) throw new Error('launchd restart did not produce a new running Host')
      await (options.wait ?? delay)(Math.min(100, deadline - Date.now()))
    }
  })
}

/** Internal installer dispatch, loaded through the selected Host's resolver. */
export async function runLaunchdControl(args: string[]): Promise<void> {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!name || !['--profile', '--dsh-home', '--action'].includes(name) || values[name] !== undefined
      || !value || value.startsWith('--')) throw new Error('invalid launchd service control arguments')
    values[name] = value
  }
  const action = values['--action']
  if (!action || !['registered', 'running', 'restart', 'restart-if-loaded'].includes(action)
    || !values['--profile'] || !values['--dsh-home']) throw new Error('missing launchd service control arguments')
  const present = await controlDshLaunchAgent({ dshHome: values['--dsh-home'], profile: values['--profile'] }, action as LaunchAgentAction)
  if (!present && action !== 'restart-if-loaded') process.exitCode = 3
}
