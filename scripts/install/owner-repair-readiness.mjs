import { realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assertLocalSourceInstaller } from './local-source-maintenance.mjs'

const fail = message => { throw new Error(`Owner repair readiness: ${message}`) }

export function matchesOwnerRepairActivation(record, id, scope, since) {
  return record?.id === id && record.owner === 'plugin-control-plane-adoption-coordinator'
    && record.status === 'active' && Number.isSafeInteger(record.updatedAt) && record.updatedAt >= since
    && record.definition?.execution?.kind === 'host'
    && record.definition.execution.executorId === 'plugin-control-plane-adoption-coordinator-v1'
    && record.definition.execution.ownerRouteId === scope.ownerRouteId
    && record.definition.principal === scope.principalId
    && record.definition.workspace === scope.workspace
    && record.definition.agentPreset === scope.preset
}

export async function ownerRepairActivationInspector({ ownerRepair, installer, homePath, targetProfile, coordinatorProfile }) {
  if (ownerRepair?.homePath !== homePath || ownerRepair.profile !== targetProfile
    || ownerRepair.coordinatorProfile !== coordinatorProfile || !isDeepStrictEqual(installer, ownerRepair.installer)) {
    fail('owner proof does not bind the exact service pair')
  }
  const manifest = ownerRepair.original?.manifest
  const scope = manifest?.controlPlane?.taskObservations?.scope
  const coordinatorId = manifest?.controlPlane?.sourceAdoptions?.handoff?.coordinatorId
  if (manifest?.targetProfile !== targetProfile || manifest.coordinatorProfile !== coordinatorProfile
    || !scope || !['workspace', 'preset', 'principalId', 'ownerRouteId'].every(key =>
      typeof scope[key] === 'string' && scope[key].length > 0)
    || typeof coordinatorId !== 'string' || coordinatorId.length === 0) fail('owner activation contract differs')
  await assertLocalSourceInstaller(installer)
  const modules = [join(installer.root, 'plugins', 'assistant-automations', 'lib', 'operator.js'),
    join(installer.root, 'plugins', 'plugin-control-plane', 'lib', 'store.js')]
  const paths = await Promise.all(modules.map(path => realpath(path)))
  if (paths.some(path => !path.startsWith(`${installer.root}${sep}`))) fail('reviewed activation API escapes installer')
  const [{ listActiveAutomationsLocally }, { controlPlaneDigest }] = await Promise.all(
    paths.map(path => import(pathToFileURL(path).href)))
  if (typeof listActiveAutomationsLocally !== 'function' || typeof controlPlaneDigest !== 'function') {
    fail('reviewed activation API is unavailable')
  }
  const id = `adoption-coordinator-${controlPlaneDigest({ coordinatorId, scope }).slice(0, 40)}`
  const database = join(homePath, 'rsi-coordinators', coordinatorProfile, 'automations.sqlite')
  return since => {
    if (!Number.isSafeInteger(since) || since < 0) fail('invalid activation timestamp')
    const records = listActiveAutomationsLocally(database)
    if (!Array.isArray(records)) fail('reviewed activation inventory is invalid')
    return records.some(record => matchesOwnerRepairActivation(record, id, scope, since))
  }
}
