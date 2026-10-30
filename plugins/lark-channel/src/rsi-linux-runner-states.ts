import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectLinuxRunnerState, prepareLinuxRunnerState, type LinuxRunnerStateSeal } from '@dsh-enhanced/assistant-isolation'
import type { RsiAuthorityResources } from './rsi-authority-resources.js'
import type { RsiSetupManifest } from './rsi-profile.js'
import { rsiBuildResources as io } from './rsi-build.js'

export interface RsiLinuxRunnerStates {
  sourceBuild: LinuxRunnerStateSeal
  creationReview?: LinuxRunnerStateSeal
  creationAdoption?: LinuxRunnerStateSeal
  revisionReview?: LinuxRunnerStateSeal
  revisionRegression?: LinuxRunnerStateSeal
}
const roles = {
  sourceBuild: ['linux-source-build-runner', 'repository'],
  creationReview: ['creation-review-runner', 'verification'],
  creationAdoption: ['creation-adoption-runner', 'verification'],
  revisionReview: ['revision-review-runner', 'verification'],
  revisionRegression: ['revision-regression-runner', 'verification'],
} as const
type Scope = { creation: boolean; revision: boolean }
function fail(message: string): never { throw new Error(`rsi Linux runner states: ${message}`) }
function selected(scope: Scope): Array<keyof RsiLinuxRunnerStates> {
  if (scope.revision && !scope.creation) fail('revision requires creation')
  return ['sourceBuild', ...(scope.creation ? ['creationReview', 'creationAdoption'] as const : []),
    ...(scope.revision ? ['revisionReview', 'revisionRegression'] as const : [])]
}
export function validateRsiLinuxRunnerStates(resources: RsiAuthorityResources, states: RsiLinuxRunnerStates,
  scope: Scope): RsiLinuxRunnerStates {
  const expected = selected(scope)
  if (!states || Object.keys(states).sort().join() !== [...expected].sort().join()) fail('incomplete frozen state references')
  for (const role of expected) {
    const [name, kind] = roles[role], seal = states[role]
    if (!seal || seal.path !== join(resources.stateRoot, 'native-runner-states', `${name}.json`)) fail('state reference path differs')
    inspectLinuxRunnerState({ stateRoot: join(resources.stateRoot, name), stateSeal: seal, kind })
  }
  return structuredClone(states)
}

/** No authority is issued here. Existing installations only inspect the exact
 * references in their original manifest, including never-used revision ledgers. */
export async function prepareRsiLinuxRunnerStates(resources: RsiAuthorityResources, scope: Scope,
  previous?: RsiSetupManifest): Promise<RsiLinuxRunnerStates> {
  if (previous) {
    const build = previous.controlPlane.sourceBuild
    if (!build || !('backend' in build) || build.backend !== 'linux-native' || !build.stateSeal) fail('missing original repository state reference')
    const sealOf = (runner: unknown): LinuxRunnerStateSeal => {
      if (!runner || typeof runner !== 'object' || !Object.hasOwn(runner, 'stateSeal')) fail('missing original verification state reference')
      return (runner as { stateSeal: LinuxRunnerStateSeal }).stateSeal
    }
    return validateRsiLinuxRunnerStates(resources, { sourceBuild: build.stateSeal,
      ...(scope.creation ? { creationReview: sealOf(previous.pluginCreation?.reviews.runner),
        creationAdoption: sealOf(previous.pluginCreation?.capabilities.runner) } : {}),
      ...(scope.revision ? { revisionReview: sealOf(previous.pluginRevision?.reviews.runner),
        revisionRegression: sealOf(previous.pluginRevision?.regressions.runner) } : {}) }, scope)
  }
  const sealRoot = join(resources.stateRoot, 'native-runner-states')
  const directory = async (path: string): Promise<void> => {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await io.directory(path)
  }
  await io.directory(resources.stateRoot)
  await directory(sealRoot)
  const result: Partial<RsiLinuxRunnerStates> = {}
  for (const role of selected(scope)) {
    const [name, kind] = roles[role], stateRoot = join(resources.stateRoot, name)
    await directory(stateRoot)
    result[role] = prepareLinuxRunnerState({ stateRoot, sealPath: join(sealRoot, `${name}.json`), kind, requireEmpty: true })
  }
  return validateRsiLinuxRunnerStates(resources, result as RsiLinuxRunnerStates, scope)
}
