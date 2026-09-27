import type { RsiSetupManifest } from './rsi-profile.js'
import { readRsiServiceEnvironment, validateRsiServiceEnvironment, type RsiServiceEnvironment } from './rsi-service-environment.js'

export interface RsiServiceEnvironments { target: RsiServiceEnvironment; coordinator: RsiServiceEnvironment }
const hostVariable = 'DSH_SYSTEMD_HOST_ATTESTOR_CONFIG'
const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const

/** Capture selected config paths once; a later shell cannot silently change a
 * registered service. Explicit manifest values can replace a prior binding. */
export async function resolveRsiServiceEnvironments(manifest: RsiSetupManifest, home: string,
  ambient: NodeJS.ProcessEnv = process.env): Promise<RsiServiceEnvironments | undefined> {
  const { loadTrustConfig } = await import('@dsh-enhanced/plugin-control-plane')
  const trust = await loadTrustConfig(manifest.controlPlane.trustPath)
  const targetNames = phases.flatMap(phase => {
    const name = `DSH_RELEASE_${phase.toUpperCase().replaceAll('-', '_')}_CONFIG`
    return trust.releaseAdapters?.[phase]?.environmentAllowlist.includes(name) ? [name] : []
  })
  const coordinatorNames = trust.hostAttestor?.environmentAllowlist.includes(hostVariable) ? [hostVariable] : []
  targetNames.push(...coordinatorNames)
  const existing = await Promise.all([manifest.targetProfile, manifest.coordinatorProfile].map(profile => readRsiServiceEnvironment(home, profile)))
  const explicit = manifest.serviceEnvironment
  if (explicit !== undefined && (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)
    || Object.keys(explicit).sort().join(',') !== 'coordinator,target')) throw new Error('rsi setup: serviceEnvironment must contain target and coordinator')
  if (!explicit && !existing.some(value => value !== undefined) && targetNames.length === 0) return undefined
  const select = async (names: string[], saved: RsiServiceEnvironment | undefined, declared: RsiServiceEnvironment | undefined, profile: string) => {
    const selected: Record<string, string> = declared === undefined ? Object.fromEntries(names.map(name => [name, saved?.[name] ?? ambient[name]])) as Record<string, string> : declared
    if (Object.keys(selected).sort().join('\0') !== [...names].sort().join('\0')) throw new Error('rsi setup: service environment differs from selected trust adapters')
    return validateRsiServiceEnvironment(selected, home, profile)
  }
  const target = await select(targetNames, existing[0], explicit?.target, manifest.targetProfile)
  const coordinator = await select(coordinatorNames, existing[1], explicit?.coordinator, manifest.coordinatorProfile)
  if (target[hostVariable] !== coordinator[hostVariable]) throw new Error('rsi setup: both Hosts must use the same selected Host authority config')
  return { target, coordinator }
}
