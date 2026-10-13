import { createHash } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value
const supportedLegacy = value => value === '0.1.5' || /^0\.1\.5-rc\.([0-9]{1,6})$/u.test(value)
  && Number(/^0\.1\.5-rc\.([0-9]{1,6})$/u.exec(value)[1]) >= 3
const versionOrder = value => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/u.exec(value)
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4])]
}
const earlierVersion = (left, right) => {
  const before = versionOrder(left), after = versionOrder(right)
  for (let index = 0; index < before.length; index++) {
    if (before[index] !== after[index]) return before[index] < after[index]
  }
  return false
}
const keys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
const validRuntime = value => keys(value, ['version', 'root', 'dshPath', 'binDirectory', 'integrity', 'receiptDigest'])
  && (supportedLegacy(value.version) || value.version === '0.2.0-rc.2')
  && absolute(value.root) && absolute(value.dshPath) && absolute(value.binDirectory)
  && typeof value.integrity === 'string' && value.integrity.startsWith('sha512-')
  && hex(value.receiptDigest) && value.dshPath.startsWith(`${value.root}/`)
  && value.binDirectory.startsWith(`${value.root}/`) && value.binDirectory === dirname(value.dshPath)

export function parseHostUpdatePlan(value, homePath) {
  if (!keys(value, ['schemaVersion', 'status', 'canonicalHome', 'bindingPath', 'originalBindingSource',
    'originalBindingDigest', 'originalRuntime', 'candidateRuntime', 'candidateBindingSource'])
    || ![1, 2].includes(value.schemaVersion) || !['current', 'update'].includes(value.status)
    || !absolute(value.canonicalHome) || value.canonicalHome !== homePath
    || value.bindingPath !== `${homePath}/.dsh-rsi-host.json`
    || typeof value.candidateBindingSource !== 'string'
    || value.schemaVersion === 1 && (typeof value.originalBindingSource !== 'string'
      || !hex(value.originalBindingDigest) || digest(value.originalBindingSource) !== value.originalBindingDigest)
    || value.schemaVersion === 2 && (value.status !== 'update' || value.originalBindingSource !== null
      || value.originalBindingDigest !== null || !supportedLegacy(value.originalRuntime?.version)
      || value.candidateRuntime?.version !== '0.2.0-rc.2')
    || !validRuntime(value.originalRuntime) || !validRuntime(value.candidateRuntime)
    || value.originalRuntime.root === value.candidateRuntime.root && value.status === 'update'
      && value.originalRuntime.version === value.candidateRuntime.version) {
    throw new Error('invalid managed Host update plan')
  }
  const parseBinding = source => {
    let parsed
    try { parsed = JSON.parse(source) } catch { throw new Error('invalid managed Host binding') }
    if (!keys(parsed, ['schemaVersion', 'cacheRoot', 'version', 'receiptDigest'])
      || parsed.schemaVersion !== 1 || !absolute(parsed.cacheRoot) || !hex(parsed.receiptDigest)) {
      throw new Error('invalid managed Host binding')
    }
    return parsed
  }
  const before = value.schemaVersion === 1 ? parseBinding(value.originalBindingSource) : null
  const after = parseBinding(value.candidateBindingSource)
  for (const [binding, runtime] of [[after, value.candidateRuntime], ...(before === null ? [] : [[before, value.originalRuntime]])]) {
    if (binding.version !== runtime.version || binding.receiptDigest !== runtime.receiptDigest
      || runtime.root !== `${binding.cacheRoot}/${binding.version}`) {
      throw new Error('managed Host binding does not match runtime receipt')
    }
  }
  const originalCacheRoot = before?.cacheRoot ?? dirname(value.originalRuntime.root)
  if (originalCacheRoot !== after.cacheRoot
    || value.originalRuntime.root !== `${originalCacheRoot}/${value.originalRuntime.version}`
    || value.status === 'current'
    && (value.originalBindingSource !== value.candidateBindingSource
      || JSON.stringify(value.originalRuntime) !== JSON.stringify(value.candidateRuntime))
    || value.status === 'update' && !earlierVersion(value.originalRuntime.version, value.candidateRuntime.version)) {
    throw new Error('managed Host update plan has inconsistent versions')
  }
  return value
}

function quote(value) {
  if (value.includes('\0') || /[\r\n]/u.test(value)) throw new Error('invalid systemd value')
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** Preserve the exact installer-rendered unit except its Host executable and PATH. */
export function candidateHostUnitSource(service, originalSource, oldDshPath, newDshPath, oldHostRoot) {
  if (service.dshPath !== oldDshPath || !absolute(newDshPath)
    || !absolute(oldHostRoot) || !oldDshPath.startsWith(`${oldHostRoot}/`)
    || typeof service.pathEnvironment !== 'string' || !service.pathEnvironment.startsWith('PATH=')) {
    throw new Error('unit Host identity does not match the update plan')
  }
  const oldPath = service.pathEnvironment.slice('PATH='.length)
  const newPath = [dirname(newDshPath), dirname(service.nodePath),
    ...oldPath.split(':').filter(entry => entry !== oldHostRoot && !entry.startsWith(`${oldHostRoot}/`))]
    .filter((entry, index, all) => entry !== '' && absolute(entry) && all.indexOf(entry) === index).join(':')
  const oldPathLine = `Environment=${quote(`PATH=${oldPath}`)}\n`
  const newPathLine = `Environment=${quote(`PATH=${newPath}`)}\n`
  const oldExec = `ExecStart=${quote(service.nodePath)} --disable-warning=ExperimentalWarning ${quote(oldDshPath)} --profile ${service.profile} --no-open\n`
  const newExec = `ExecStart=${quote(service.nodePath)} --disable-warning=ExperimentalWarning ${quote(newDshPath)} --profile ${service.profile} --no-open\n`
  if (originalSource.split(oldPathLine).length !== 2 || originalSource.split(oldExec).length !== 2) {
    throw new Error('unit source is not the captured installer rendering')
  }
  return { source: originalSource.replace(oldPathLine, newPathLine).replace(oldExec, newExec), pathEnvironment: `PATH=${newPath}` }
}

export function classifyHostUnitBytes(current, before, after) {
  if (current === before) return 'before'
  if (current === after) return 'after'
  throw new Error('managed Host unit changed outside the transaction')
}
