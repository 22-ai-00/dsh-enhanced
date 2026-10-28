#!/usr/bin/env node
import { chownSync, lstatSync, mkdirSync, readFileSync, realpathSync, statfsSync } from 'node:fs'

// One-time, root-run resource delegation. This command executes no candidate
// program and never changes an existing controller or service configuration.
// Production installation must first verify its fixed digest and install this
// file under a root-owned, non-user-writable path. Do not authorize sudo Node
// against a user-writable checkout; this source file is not a privileged broker.
const V1_MAGIC = 0x27e0eb
const CONTROLLERS = ['cpu', 'memory', 'pids', 'freezer']
function fail(message) { throw new Error(`prepare Linux cgroups: ${message}`) }

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() !== 0) fail('root Linux x64/arm64 is required')
if (process.argv.length !== 5 || process.argv[2] !== '--uid' || !/^[1-9][0-9]{0,9}$/u.test(process.argv[3])
  || process.argv[4] !== '--v1') fail('usage: prepare-linux-cgroups --uid <numeric non-root UID> --v1')
const uid = Number(process.argv[3])
if (!Number.isSafeInteger(uid) || uid > 2_147_483_647) fail('invalid UID')

const mountinfo = readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
const mounts = new Map()
for (const line of mountinfo) {
  const [before, after] = line.split(' - ')
  const fields = before?.split(' '), fs = after?.split(' ')
  if (fs?.[0] !== 'cgroup' || !fields?.[4]?.startsWith('/sys/fs/cgroup/')) continue
  const options = fs[2]?.split(',') ?? []
  for (const controller of CONTROLLERS) if (options.includes(controller)) {
    if (mounts.has(controller)) fail(`multiple ${controller} cgroup mounts`)
    mounts.set(controller, fields[4])
  }
}
if (mounts.size !== CONTROLLERS.length) fail('CPU, memory, PID and freezer v1 controllers are required')

function checkedDirectory(path, owner, mode) {
  if (realpathSync(path) !== path) fail('noncanonical controller directory')
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || info.mode & 0o022
    || (info.mode & 0o700) !== 0o700 || statfsSync(path).type !== V1_MAGIC) fail('controller directory ownership or filesystem differs')
  if (mode === 'parent' && (info.mode & 0o005) !== 0o005) fail('delegation parent cannot be traversed')
}

process.umask(0o022)
const roots = {}
for (const controller of CONTROLLERS) {
  const mount = mounts.get(controller)
  if (!/^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+$/u.test(mount) || statfsSync(mount).type !== V1_MAGIC) fail('unexpected controller mount')
  const parent = `${mount}/dsh-native`
  try { mkdirSync(parent, { mode: 0o755 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  checkedDirectory(parent, 0, 'parent')
  const path = `${parent}/uid-${uid}`
  let created = false
  try { mkdirSync(path, { mode: 0o700 }); created = true }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  if (created) chownSync(path, uid, 0)
  checkedDirectory(path, uid, 'leaf')
  roots[controller] = path
}
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, mode: 'v1', uid, roots })}\n`)
