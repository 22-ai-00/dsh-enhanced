import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, lstat, mkdir, readdir, realpath, rmdir, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { V2_UNIFIED_ROOT_PATTERN } from './linux-execution-contract.js'
import { linuxUserNamespaceProof, validateLinuxUserNamespaceWitness, type LinuxUserNamespaceWitness } from './linux-user-namespace.js'
import {
  parseLinuxV2ProcessCgroup,
  resolveLinuxV2CommonAncestor,
  verifyLinuxV2SystemdUserScopeBridge,
} from './native-cgroup-roots.js'

/** A resource boundary only. The caller must still isolate files, network and credentials. */
export type LinuxCgroupRoots = { mode: 'v1'; cpu: string; memory: string; pids: string; freezer: string }
  | { mode: 'v2'; unified: string }
export interface LinuxCgroupLimits { memoryMiB: number; pidsLimit: number; cpus: number }
export interface LinuxCgroupIdentity { pid: number; startTicks: string; bootId: string; uid: number }
export interface LinuxCgroupDirectory { path: string; dev: number; ino: number }
/** Extra termination authority is bound only by the new repository protocol;
 * it never changes the interpretation of an old cgroup snapshot. */
export interface LinuxCgroupNamespaceTermination {
  witness: LinuxUserNamespaceWitness
  outsideGate?: LinuxCgroupIdentity
}
export interface LinuxCgroupSnapshot {
  schemaVersion: 1
  mode: LinuxCgroupRoots['mode']
  bootId: string
  jobId: string
  nonce: string
  uid: number
  deadline: number
  limits: LinuxCgroupLimits
  directories: Record<string, LinuxCgroupDirectory>
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const HEX = /^[a-f0-9]{32}$/u
const TICKS = /^[1-9][0-9]{0,63}$/u
const V1_MAGIC = 0x27e0eb
const V2_MAGIC = 0x63677270
const CONTROLLERS = ['cpu', 'memory', 'pids', 'freezer'] as const
const PERIOD_US = 100_000

function fail(message: string): never { throw new Error(`linux cgroup: ${message}`) }
const uid = (): number => {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)
    || typeof process.getuid !== 'function' || process.getuid() === 0) fail('non-root Linux x64/arm64 is required')
  return process.getuid()
}
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0
const name = (jobId: string, nonce: string): string => `job-${jobId}-${nonce}`
const keys = (value: object, expected: readonly string[]): boolean => Object.keys(value).sort().join() === [...expected].sort().join()

function validateLimits(value: LinuxCgroupLimits): LinuxCgroupLimits {
  if (!value || !keys(value, ['memoryMiB', 'pidsLimit', 'cpus']) || !positive(value.memoryMiB)
    || value.memoryMiB > 65_536 || !positive(value.pidsLimit) || value.pidsLimit > 4096
    || !Number.isFinite(value.cpus) || value.cpus < 0.1 || value.cpus > 64
    || !positive(Math.floor(value.cpus * PERIOD_US))) fail('invalid resource limits')
  return { ...value }
}

function rootEntries(value: LinuxCgroupRoots, owner: number): Array<[string, string]> {
  if (!value || value.mode !== 'v1' && value.mode !== 'v2') fail('invalid cgroup mode')
  if (value.mode === 'v1' && !keys(value, ['mode', ...CONTROLLERS])
    || value.mode === 'v2' && !keys(value, ['mode', 'unified'])) fail('invalid controller roots')
  const roots: Array<[string, string]> = value.mode === 'v1'
    ? CONTROLLERS.map(controller => [controller, value[controller]]) : [['unified', value.unified]]
  if (new Set(roots.map(([, root]) => root)).size !== roots.length) fail('duplicate controller root')
  for (const [controller, root] of roots) {
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
      || value.mode === 'v2' && (!V2_UNIFIED_ROOT_PATTERN.test(root) || !root.endsWith(`/uid-${owner}`))
      || value.mode === 'v1' && !new RegExp(`^/sys/fs/cgroup/[A-Za-z0-9_,]+/dsh-native/uid-${owner}$`, 'u').test(root)
      || controller.length === 0) fail('unexpected delegated root')
  }
  return roots
}

async function bootId(): Promise<string> {
  const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase()
  if (!UUID.test(value)) fail('boot identity is unavailable')
  return value
}

async function root(path: string, owner: number, mode: LinuxCgroupRoots['mode'], controller: string): Promise<void> {
  if (await realpath(path) !== path) fail('delegated root is not canonical')
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== owner || item.mode & 0o022) fail('delegated root ownership differs')
  if ((await statfs(path)).type !== (mode === 'v1' ? V1_MAGIC : V2_MAGIC)) fail('delegated root filesystem differs')
  const mount = mode === 'v1' ? path.split('/').slice(0, 5).join('/') : '/sys/fs/cgroup'
  const lines = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n')
  if (mode === 'v2' && lines.some(line => line.split(' - ')[1]?.split(' ')[0] === 'cgroup')) {
    fail('hybrid cgroup hierarchy is unsupported')
  }
  const matching = lines.filter(line => {
    const [before, after] = line.split(' - ')
    const fields = before?.split(' '), fs = after?.split(' ')
    return fields?.[4] === mount && fs?.[0] === (mode === 'v1' ? 'cgroup' : 'cgroup2')
      && (mode === 'v2' || fs?.[2]?.split(',').includes(controller))
  })
  if (matching.length !== 1) fail('controller mount identity differs')
  if (mode === 'v2') {
    const [controllersRaw, subtreeRaw] = await Promise.all([
      readFile(join(path, 'cgroup.controllers'), 'utf8'),
      readFile(join(path, 'cgroup.subtree_control'), 'utf8'),
    ])
    const available = new Set(controllersRaw.trim().split(/\s+/u).filter(Boolean))
    const enabled = new Set(subtreeRaw.trim().split(/\s+/u).filter(Boolean))
    for (const required of ['cpu', 'memory', 'pids']) {
      if (!available.has(required) || !enabled.has(required)) fail('delegated cgroup v2 subtree controllers differ')
    }
    const [freezeInfo, killInfo] = await Promise.all([lstat(join(path, 'cgroup.freeze')), lstat(join(path, 'cgroup.kill'))])
    if (!freezeInfo.isFile() || freezeInfo.isSymbolicLink() || !killInfo.isFile() || killInfo.isSymbolicLink()) {
      fail('delegated cgroup v2 freeze or kill interface is unavailable')
    }
  }
}

export interface LinuxV2MigrationAuthority {
  mode: 'direct' | 'systemd-user-scope'
  ancestor: string
}

async function checkWritableV2Procs(dirPath: string): Promise<boolean> {
  if (resolve(dirPath) !== dirPath || await realpath(dirPath).catch(() => '') !== dirPath) return false
  if ((await statfs(dirPath).catch(() => ({ type: 0 }))).type !== V2_MAGIC) return false
  const procsPath = join(dirPath, 'cgroup.procs')
  const procsInfo = await lstat(procsPath).catch(() => undefined)
  if (!procsInfo || !procsInfo.isFile() || procsInfo.isSymbolicLink()) return false
  try {
    await access(procsPath, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function verifyLinuxV2CallerMigrationAuthority(unifiedRoot: string): Promise<LinuxV2MigrationAuthority> {
  const owner = uid()
  let callerCgroup = ''
  let ancestor: string
  try {
    callerCgroup = parseLinuxV2ProcessCgroup(await readFile('/proc/self/cgroup', 'utf8'))
    ancestor = resolveLinuxV2CommonAncestor(callerCgroup, unifiedRoot)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (resolve(ancestor) !== ancestor || await realpath(ancestor) !== ancestor) fail('cgroup v2 common ancestor is not canonical')
  if ((await statfs(ancestor)).type !== V2_MAGIC) fail('cgroup v2 common ancestor filesystem differs')
  const procsPath = join(ancestor, 'cgroup.procs')
  const procsInfo = await lstat(procsPath)
  if (!procsInfo.isFile() || procsInfo.isSymbolicLink()) fail('cgroup v2 common ancestor cgroup.procs is invalid')
  try {
    await access(procsPath, constants.W_OK)
    return { mode: 'direct', ancestor }
  } catch {
    const userServiceDir = `/sys/fs/cgroup/user.slice/user-${owner}.slice/user@${owner}.service`
    const systemdRoot = `${userServiceDir}/dsh-native/uid-${owner}`
    if (unifiedRoot === systemdRoot && await checkWritableV2Procs(userServiceDir)) {
      try {
        await verifyLinuxV2SystemdUserScopeBridge(owner)
        return { mode: 'systemd-user-scope', ancestor: userServiceDir }
      } catch {
        // Fall through to detailed EACCES diagnostic below.
      }
    }
    fail(`cgroup v2 common ancestor ${procsPath} is not writable for process migration (caller ${callerCgroup} -> ${unifiedRoot}; run under systemd --user / systemd-run --user --scope or place caller in ${unifiedRoot}/host)`)
  }
}

async function verifyLinuxV2TargetMigrationAuthority(pid: number, unifiedRoot: string): Promise<string> {
  let targetCgroup = ''
  let ancestor: string
  try {
    targetCgroup = parseLinuxV2ProcessCgroup(await readFile(`/proc/${pid}/cgroup`, 'utf8'))
    ancestor = resolveLinuxV2CommonAncestor(targetCgroup, unifiedRoot)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  if (!await checkWritableV2Procs(ancestor)) {
    fail(`cgroup v2 common ancestor ${ancestor}/cgroup.procs is not writable for migrating pid ${pid} (${targetCgroup} -> ${unifiedRoot})`)
  }
  return ancestor
}

async function directory(path: string, expected: LinuxCgroupDirectory, owner: number, mode: LinuxCgroupRoots['mode']): Promise<void> {
  if (expected.path !== path || await realpath(path) !== path) fail('job cgroup path changed')
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== owner || item.dev !== expected.dev || item.ino !== expected.ino
    || item.mode & 0o022 || (await statfs(path)).type !== (mode === 'v1' ? V1_MAGIC : V2_MAGIC)) fail('job cgroup identity changed')
}

async function number(path: string): Promise<number> {
  const raw = (await readFile(path, 'utf8')).trim()
  if (!/^[0-9]{1,18}$/u.test(raw)) fail('resource limit was not numeric')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) fail('resource limit overflow')
  return value
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

async function writeAndVerify(path: string, expected: number): Promise<void> {
  await writeFile(path, `${expected}\n`)
  if (await number(path) !== expected) fail('resource limit readback differs')
}

async function readProcesses(path: string): Promise<number[]> {
  // cgroup.procs does not include descendants. A child cgroup would make an
  // apparently empty parent unsafe to settle or delete.
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) fail('nested or linked cgroup is not supported')
  }
  const content = await readFile(join(path, 'cgroup.procs'), 'utf8')
  const values = content.trim() === '' ? [] : content.trim().split(/\s+/u).map(Number)
  if (values.some(pid => !positive(pid)) || new Set(values).size !== values.length || values.length > 16_384) fail('invalid cgroup process inventory')
  return values
}

async function processIdentity(pid: number): Promise<{ startTicks: string; uid: number; state: string } | undefined> {
  if (!positive(pid)) return undefined
  try {
    const [raw, status] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')])
    const close = raw.lastIndexOf(') ')
    const fields = close < 0 ? [] : raw.slice(close + 2).trim().split(/\s+/u)
    const owner = /^Uid:\s+(\d+)/mu.exec(status)
    const startTicks = fields[19]
    if (!TICKS.test(startTicks ?? '') || !owner) return undefined
    return { startTicks: startTicks!, uid: Number(owner[1]), state: fields[0]! }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// Python's pidfd signal operation targets the opened process, even if a numeric PID is reused.
// This fixed helper receives only PID/start-time/cgroup identity; no candidate code or shell is executed.
const PIDFD_KILL = String.raw`import json,os,signal,sys
data=json.loads(sys.argv[1]); expected=data['cgroup']; uid=data['uid']
for pid,ticks in data['processes']:
 try:
  fd=os.pidfd_open(pid,0)
  try:
   raw=open('/proc/%d/stat'%pid).read(); fields=raw[raw.rfind(') ')+2:].split()
   status=open('/proc/%d/status'%pid).read(); groups=open('/proc/%d/cgroup'%pid).read().splitlines()
   if fields[19]!=ticks or int(status.split('Uid:')[1].split()[0])!=uid or not any(line.split(':',2)[1:]==expected for line in groups):
    raise RuntimeError('process identity or cgroup differs')
   signal.pidfd_send_signal(fd,signal.SIGKILL,None,0)
  finally: os.close(fd)
 except ProcessLookupError: pass
`

const PIDFD_ADMIT = String.raw`import json,os,sys,time
data=json.loads(sys.argv[1]); pid=data['pid']; ticks=data['ticks']; uid=data['uid']; boot=data['boot']
fd=os.pidfd_open(pid,0)
try:
 def checked():
  if open('/proc/sys/kernel/random/boot_id').read().strip().lower()!=boot: raise RuntimeError('boot changed')
  if time.time()*1000>=data['deadline']: raise RuntimeError('admission deadline passed')
  raw=open('/proc/%d/stat'%pid).read(); fields=raw[raw.rfind(') ')+2:].split()
  status=open('/proc/%d/status'%pid).read()
  if fields[19]!=ticks or fields[0]=='Z' or int(status.split('Uid:')[1].split()[0])!=uid: raise RuntimeError('process changed')
 checked()
 for path,kind,group in data['groups']:
  with open(path+'/cgroup.procs','w') as out: out.write(str(pid)+'\n')
  checked()
  memberships=open('/proc/%d/cgroup'%pid).read().splitlines()
  if not any(line.split(':',2)[1:]==[kind,group] for line in memberships): raise RuntimeError('cgroup admission differs')
 checked()
finally: os.close(fd)
`

// Verify pidfd identity, frozen cgroup v2 membership AND user-namespace ancestry
// (`NS_GET_PARENT` + `NS_GET_OWNER_UID` + uid/gid maps) before `cgroup.kill`,
// preserving `runtime/linux-userns-proof.py`'s pinned SHA-256 unchanged.
export const V2_NAMESPACE_VERIFY = String.raw`import array,fcntl,json,os,select,sys
NS_GET_PARENT=0xB702; NS_GET_OWNER_UID=0xB704
raw=sys.stdin.buffer.read(1048577)
if len(raw)>1048576: raise RuntimeError('request exceeds bound')
req=json.loads(raw)
if not isinstance(req,dict) or not isinstance(req.get('processes'),list) or len(req['processes'])>16384 or not isinstance(req.get('outsideGates'),list) or len(req['outsideGates'])>1:
 raise RuntimeError('process inventory exceeds bound')
witness=req['witness']; mapping=witness['mapping']
def read(p,maximum=65536):
 with open(p,encoding='ascii') as f: v=f.read(maximum+1)
 if len(v)>maximum: raise RuntimeError('kernel observation exceeds bound')
 return v
def ids(st,kind):
 vals=[int(x) for x in st.get(kind,'').split()]
 if len(vals)!=4: raise RuntimeError('incomplete process identity')
 return vals
def ident(fd): s=os.fstat(fd); return {'dev':s.st_dev,'ino':s.st_ino}
def owner(fd): a=array.array('I',[0]); fcntl.ioctl(fd,NS_GET_OWNER_UID,a,True); return a[0]
def frozen(p): return any(l.strip()=='frozen 1' for l in read(p+'/cgroup.events').splitlines())
if os.getuid()!=mapping['ownerUid'] or os.getgid()!=mapping['ownerGid']: raise RuntimeError('Host owner differs')
hfd=os.open('/proc/self/ns/user',os.O_RDONLY)
try:
 if ident(hfd)!=mapping['hostNamespace']: raise RuntimeError('Host namespace differs')
finally: os.close(hfd)
if read('/proc/sys/kernel/random/boot_id').strip().lower()!=witness['bootId']: raise RuntimeError('boot changed')
cpath=req['cgroupPath']; expected=req['cgroup']
if not isinstance(expected,list) or len(expected)!=2 or expected[0]!='' or not isinstance(expected[1],str) or not expected[1].startswith('/') or not isinstance(cpath,str) or cpath!='/sys/fs/cgroup'+expected[1]:
 raise RuntimeError('cgroup v2 identity differs')
if not frozen(cpath): raise RuntimeError('job group is not frozen')
held=[]; ns=[]
try:
 for item in req['processes']:
  if not isinstance(item,list) or len(item)!=2: raise RuntimeError('invalid process entry')
  pid,expected_ticks=item
  try: pfd=os.pidfd_open(pid,0)
  except ProcessLookupError: continue
  held.append(pfd)
  poll=select.poll(); poll.register(pfd,select.POLLIN)
  if poll.poll(0): continue
  raw_stat=read('/proc/%d/stat'%pid); fields=raw_stat[raw_stat.rfind(') ')+2:].split()
  if len(fields)<20 or not fields[19].isdigit() or fields[19]!=expected_ticks: raise RuntimeError('process identity changed')
  st={}
  for line in read('/proc/%d/status'%pid).splitlines():
   k,sep,v=line.partition(':')
   if sep: st[k]=v.strip()
  memberships=[line.split(':',2)[1:] for line in read('/proc/%d/cgroup'%pid).splitlines()]
  if expected not in memberships: raise RuntimeError('process escaped frozen cgroup v2 group')
  nfd=os.open('/proc/%d/ns/user'%pid,os.O_RDONLY); ns.append(nfd)
  uids=ids(st,'Uid'); gids=ids(st,'Gid')
  outside=any(e['pid']==pid and e['startTicks']==expected_ticks for e in req['outsideGates'])
  if outside and ident(nfd)==mapping['hostNamespace']:
   if uids!=[mapping['ownerUid']]*4 or gids!=[mapping['ownerGid']]*4: raise RuntimeError('original keeper gate changed identity')
  else:
   if any(v not in (mapping['ownerUid'],mapping['candidateUid']) for v in uids): raise RuntimeError('foreign UID in job group')
   if any(v not in (mapping['ownerGid'],mapping['candidateGid']) for v in gids): raise RuntimeError('foreign GID in job group')
   cur=nfd; matched=False
   for _ in range(33):
    if ident(cur)==witness['namespace']:
     if owner(cur)!=witness['ownerUid']: raise RuntimeError('namespace anchor differs')
     up=fcntl.ioctl(cur,NS_GET_PARENT)
     try:
      if ident(up)!=witness['parent'] or witness['parent']!=mapping['hostNamespace']: raise RuntimeError('namespace parent differs')
     finally: os.close(up)
     matched=True; break
    cur=fcntl.ioctl(cur,NS_GET_PARENT); ns.append(cur)
   if not matched: raise RuntimeError('namespace ancestry exceeds bound')
   if ident(nfd)==witness['namespace']:
    for kind,suf in (('uid','Uid'),('gid','Gid')):
     rows=[[int(x) for x in l.split()] for l in read('/proc/%d/%s_map'%(pid,kind)).splitlines()]
     if rows!=[[0,mapping['owner'+suf],1],[65534,mapping['candidate'+suf],1]]: raise RuntimeError('kernel mapping differs')
  cur2=os.open('/proc/%d/ns/user'%pid,os.O_RDONLY)
  try:
   if ident(cur2)!=ident(nfd): raise RuntimeError('process user namespace changed')
  finally: os.close(cur2)
  raw_stat2=read('/proc/%d/stat'%pid); fields2=raw_stat2[raw_stat2.rfind(') ')+2:].split()
  if not poll.poll(0) and (len(fields2)<20 or not fields2[19].isdigit() or fields2[19]!=expected_ticks): raise RuntimeError('process identity changed')
 if not frozen(cpath): raise RuntimeError('cgroup v2 freeze barrier changed')
finally:
 for fd in ns: os.close(fd)
 for fd in held: os.close(fd)
`

async function fixedPythonStdin(source: string, data: object): Promise<void> {
  const payload = JSON.stringify(data)
  if (Buffer.byteLength(payload) > 1_048_576) fail('namespace verification payload exceeds bound')
  const output = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', source],
      { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.stdin.on('error', () => { child.kill('SIGKILL') })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolvePromise({ code, stderr }) })
    child.stdin.end(payload)
  })
  if (output.code !== 0) fail(`v2 namespace verification was unproven: ${output.stderr.slice(-200)}`)
}

async function fixedPython(source: string, data: object): Promise<void> {
  const output = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', '-c', source, JSON.stringify(data)],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); resolvePromise({ code, stderr }) })
  })
  if (output.code !== 0) fail(`pidfd operation was unproven: ${output.stderr.slice(-160)}`)
}

async function killWithPidfds(path: string, owner: number, mode: LinuxCgroupRoots['mode'], namespaceTermination?: LinuxCgroupNamespaceTermination): Promise<void> {
  const processes: Array<[number, string]> = []
  for (const pid of await readProcesses(path)) {
    const current = await processIdentity(pid)
    if (!current) continue
    if (current.state === 'Z' || !namespaceTermination && current.uid !== owner) fail('cgroup contains an unexpected process')
    processes.push([pid, current.startTicks])
  }
  if (!processes.length) return
  const relative = path.slice('/sys/fs/cgroup/'.length).split('/').slice(mode === 'v1' ? 1 : 0).join('/')
  const membership = mode === 'v1' ? ['freezer', `/${relative}`] : ['', `/${relative}`]
  if (namespaceTermination) {
    if (mode !== 'v1') fail('mapped repository termination requires verified v1 freezer')
    await linuxUserNamespaceProof({ operation: 'kill', witness: namespaceTermination.witness,
      outsideGates: namespaceTermination.outsideGate ? [namespaceTermination.outsideGate] : [],
      cgroup: membership, freezerPath: path, processes })
  } else await fixedPython(PIDFD_KILL, { uid: owner, cgroup: membership, processes })
}

/** Existing jobs are recovery-only: dispatch is never inferred from a cgroup directory.
 * The Host must persist jobId/nonce and its dispatch intent before create(), and
 * persist the returned snapshot before releasing a trusted process's start gate.
 * This primitive does not supply that durable journal or discover orphan groups.
 * One Host controller must own each resource set, including recovered leases.
 */
export class LinuxCgroupLease {
  readonly snapshot: LinuxCgroupSnapshot
  #allowAdmission: boolean
  #closing = false
  #operation: Promise<void> = Promise.resolve()
  #namespaceTermination?: LinuxCgroupNamespaceTermination
  private constructor(snapshot: LinuxCgroupSnapshot, allowAdmission: boolean) {
    this.snapshot = Object.freeze({ ...snapshot, limits: Object.freeze({ ...snapshot.limits }),
      directories: Object.freeze(Object.fromEntries(Object.entries(snapshot.directories).map(([key, value]) => [key, Object.freeze({ ...value })]))) })
    this.#allowAdmission = allowAdmission
    this.#closing = !allowAdmission
  }
  static async create(input: { roots: LinuxCgroupRoots; jobId: string; nonce: string; limits: LinuxCgroupLimits; deadline: number }): Promise<LinuxCgroupLease> {
    const owner = uid(), roots = rootEntries(input.roots, owner), limits = validateLimits(input.limits)
    if (!UUID.test(input.jobId) || !HEX.test(input.nonce) || !positive(input.deadline) || input.deadline <= Date.now()) fail('invalid job identity or deadline')
    const initialBoot = await bootId()
    for (const [controller, path] of roots) await root(path, owner, input.roots.mode, controller)
    if (input.roots.mode === 'v2') await verifyLinuxV2CallerMigrationAuthority(input.roots.unified)
    const directories: Record<string, LinuxCgroupDirectory> = {}
    try {
      for (const [key, parent] of roots) {
        const path = join(parent, name(input.jobId, input.nonce))
        await mkdir(path, { mode: 0o700 })
        const item = await lstat(path)
        if (!item.isDirectory() || item.uid !== owner) fail('job cgroup was not created by owner')
        directories[key] = { path, dev: item.dev, ino: item.ino }
      }
      const path = (key: string): string => directories[key]?.path ?? fail('missing controller')
      if (input.roots.mode === 'v1') {
        await writeAndVerify(join(path('memory'), 'memory.limit_in_bytes'), limits.memoryMiB * 1024 * 1024)
        // Swapping must not evade the memory cap. Kernels without memsw support are refused.
        await writeAndVerify(join(path('memory'), 'memory.memsw.limit_in_bytes'), limits.memoryMiB * 1024 * 1024)
        await writeAndVerify(join(path('pids'), 'pids.max'), limits.pidsLimit)
        await writeAndVerify(join(path('cpu'), 'cpu.cfs_period_us'), PERIOD_US)
        await writeAndVerify(join(path('cpu'), 'cpu.cfs_quota_us'), Math.floor(limits.cpus * PERIOD_US))
        if ((await readFile(join(path('freezer'), 'freezer.state'), 'utf8')).trim() !== 'THAWED') fail('freezer is unavailable')
      } else {
        await writeAndVerify(join(path('unified'), 'memory.max'), limits.memoryMiB * 1024 * 1024)
        await writeAndVerify(join(path('unified'), 'memory.swap.max'), 0)
        await writeAndVerify(join(path('unified'), 'pids.max'), limits.pidsLimit)
        await writeFile(join(path('unified'), 'cpu.max'), `${Math.floor(limits.cpus * PERIOD_US)} ${PERIOD_US}\n`)
        if ((await readFile(join(path('unified'), 'cpu.max'), 'utf8')).trim() !== `${Math.floor(limits.cpus * PERIOD_US)} ${PERIOD_US}`) fail('CPU quota readback differs')
        if ((await readFile(join(path('unified'), 'cgroup.freeze'), 'utf8')).trim() !== '0') fail('freezer is unavailable')
        await readFile(join(path('unified'), 'cgroup.kill'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error })
      }
      if (await bootId() !== initialBoot) fail('boot changed during cgroup creation')
      return new LinuxCgroupLease({ schemaVersion: 1, mode: input.roots.mode, bootId: initialBoot,
        jobId: input.jobId, nonce: input.nonce, uid: owner, deadline: input.deadline, limits, directories }, true)
    } catch (error) {
      // Only remove provably empty directories created by this invocation. A failed
      // cleanup is part of the error; the caller must retain the unknown reservation.
      const cleanup: unknown[] = []
      for (const value of Object.values(directories).reverse()) {
        try { if ((await readProcesses(value.path)).length !== 0) throw new Error('nonempty cgroup'); await rmdir(value.path) }
        catch (failure) { cleanup.push(failure) }
      }
      if (cleanup.length) throw new AggregateError([error, ...cleanup], 'linux cgroup preparation cleanup unproven')
      throw error
    }
  }
  static async recover(snapshot: LinuxCgroupSnapshot, namespaceTermination?: LinuxCgroupNamespaceTermination): Promise<LinuxCgroupLease> {
    if (!snapshot || !keys(snapshot, ['schemaVersion', 'mode', 'bootId', 'jobId', 'nonce', 'uid', 'deadline', 'limits', 'directories'])
      || snapshot.schemaVersion !== 1 || snapshot.uid !== uid() || !UUID.test(snapshot.bootId)
      || !UUID.test(snapshot.jobId) || !HEX.test(snapshot.nonce) || !positive(snapshot.deadline)) fail('invalid recovery snapshot')
    validateLimits(snapshot.limits)
    const roots = snapshot.mode === 'v1'
      ? Object.fromEntries(CONTROLLERS.map(key => [key, snapshot.directories[key]?.path.split('/').slice(0, -1).join('/')]))
      : { unified: snapshot.directories.unified?.path.split('/').slice(0, -1).join('/') }
    rootEntries({ mode: snapshot.mode, ...roots } as LinuxCgroupRoots, snapshot.uid)
    const expected = snapshot.mode === 'v1' ? CONTROLLERS : ['unified']
    if (!keys(snapshot.directories, expected)) fail('recovery controller inventory differs')
    const lease = new LinuxCgroupLease(snapshot, false)
    if (namespaceTermination) lease.bindUserNamespace(namespaceTermination)
    await lease.#verify(true)
    return lease
  }
  /** Bind a Host-observed immutable anchor before releasing candidate START.
   * Recovery receives the original witness from its versioned private journal. */
  bindUserNamespace(value: LinuxCgroupNamespaceTermination): void {
    if (!value || !keys(value, value.outsideGate ? ['witness', 'outsideGate'] : ['witness'])) fail('invalid namespace termination binding')
    const witness = validateLinuxUserNamespaceWitness(value.witness)
    if (!['v1', 'v2'].includes(this.snapshot.mode) || witness.bootId !== this.snapshot.bootId || witness.ownerUid !== this.snapshot.uid) fail('namespace termination owner differs')
    const gate = value.outsideGate
    if (gate && (!keys(gate, ['pid', 'startTicks', 'bootId', 'uid']) || !positive(gate.pid) || !TICKS.test(gate.startTicks)
      || gate.bootId !== this.snapshot.bootId || gate.uid !== this.snapshot.uid)) fail('invalid original keeper gate')
    const binding = Object.freeze({ witness, ...(gate ? { outsideGate: Object.freeze({ ...gate }) } : {}) })
    if (this.#namespaceTermination && JSON.stringify(this.#namespaceTermination) !== JSON.stringify(binding)) fail('namespace termination binding changed')
    this.#namespaceTermination = binding
  }
  async #verify(allowMissing = false): Promise<void> {
    if (await bootId() !== this.snapshot.bootId) fail('job boot identity changed')
    const roots = this.snapshot.mode === 'v1'
      ? Object.fromEntries(CONTROLLERS.map(key => [key, this.snapshot.directories[key]!.path.split('/').slice(0, -1).join('/')]))
      : { unified: this.snapshot.directories.unified!.path.split('/').slice(0, -1).join('/') }
    for (const [key, parent] of rootEntries({ mode: this.snapshot.mode, ...roots } as LinuxCgroupRoots, this.snapshot.uid)) {
      await root(parent, this.snapshot.uid, this.snapshot.mode, key)
      try { await directory(join(parent, name(this.snapshot.jobId, this.snapshot.nonce)), this.snapshot.directories[key]!, this.snapshot.uid, this.snapshot.mode) }
      catch (error) { if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const limits = this.snapshot.limits
    const path = (key: string): string => this.snapshot.directories[key]?.path ?? fail('missing controller')
    if (this.snapshot.mode === 'v1') {
      if ((!allowMissing || await exists(path('memory'))) && (await number(join(path('memory'), 'memory.limit_in_bytes')) !== limits.memoryMiB * 1024 * 1024
        || await number(join(path('memory'), 'memory.memsw.limit_in_bytes')) !== limits.memoryMiB * 1024 * 1024)
        || (!allowMissing || await exists(path('pids'))) && await number(join(path('pids'), 'pids.max')) !== limits.pidsLimit
        || (!allowMissing || await exists(path('cpu'))) && (await number(join(path('cpu'), 'cpu.cfs_period_us')) !== PERIOD_US
        || await number(join(path('cpu'), 'cpu.cfs_quota_us')) !== Math.floor(limits.cpus * PERIOD_US))) fail('resource limits changed')
    } else if ((!allowMissing || await exists(path('unified'))) && (await number(join(path('unified'), 'memory.max')) !== limits.memoryMiB * 1024 * 1024
      || await number(join(path('unified'), 'memory.swap.max')) !== 0
      || await number(join(path('unified'), 'pids.max')) !== limits.pidsLimit
      || (await readFile(join(path('unified'), 'cpu.max'), 'utf8')).trim() !== `${Math.floor(limits.cpus * PERIOD_US)} ${PERIOD_US}`)) fail('resource limits changed')
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation)
    // A failed operation must not strand cleanup behind a rejected queue.
    this.#operation = result.then(() => {}, () => {})
    return result
  }
  #assertAdmissionOpen(): void {
    if (this.#closing || Date.now() >= this.snapshot.deadline) fail('job no longer admits a process')
  }
  async admit(identity: LinuxCgroupIdentity): Promise<void> {
    if (!this.#allowAdmission || this.#closing || Date.now() >= this.snapshot.deadline) fail('job no longer admits a process')
    if (!identity || !keys(identity, ['pid', 'startTicks', 'bootId', 'uid']) || !positive(identity.pid)
      || !TICKS.test(identity.startTicks) || identity.uid !== this.snapshot.uid || identity.bootId !== this.snapshot.bootId) fail('invalid process identity')
    // Consume the one attempt synchronously. No second caller can enter while
    // the first awaits identity or controller I/O; failures never reopen it.
    this.#allowAdmission = false
    return this.#serialize(async () => {
      try {
        this.#assertAdmissionOpen()
        await this.#verify()
        this.#assertAdmissionOpen()
        const current = await processIdentity(identity.pid)
        this.#assertAdmissionOpen()
        if (!current || current.uid !== this.snapshot.uid || current.startTicks !== identity.startTicks || current.state === 'Z') fail('process identity differs')
        if (this.snapshot.mode === 'v2') {
          const unifiedParent = this.snapshot.directories.unified!.path.split('/').slice(0, -1).join('/')
          await verifyLinuxV2TargetMigrationAuthority(identity.pid, unifiedParent)
          this.#assertAdmissionOpen()
        }
        // The trusted supervisor stays behind its start gate until this promise
        // resolves. pidfd detects death/reuse; cgroup.procs still accepts a PID,
        // so the caller must retain and reap that blocked trusted process.
        const groups = Object.entries(this.snapshot.directories).sort(([left], [right]) => {
          if (left === 'freezer') return -1
          if (right === 'freezer') return 1
          return left.localeCompare(right, 'en')
        }).map(([, value]) => {
          const parts = value.path.slice('/sys/fs/cgroup/'.length).split('/')
          const relative = parts.slice(this.snapshot.mode === 'v1' ? 1 : 0).join('/')
          return [value.path, this.snapshot.mode === 'v1' ? parts[0] : '', `/${relative}`]
        })
        this.#assertAdmissionOpen()
        await fixedPython(PIDFD_ADMIT, { pid: identity.pid, ticks: identity.startTicks, uid: identity.uid,
          boot: identity.bootId, deadline: this.snapshot.deadline, groups })
        this.#assertAdmissionOpen()
        const after = await processIdentity(identity.pid)
        this.#assertAdmissionOpen()
        if (!after || after.uid !== current.uid || after.startTicks !== current.startTicks || after.state === 'Z') fail('admitted process changed')
        for (const value of Object.values(this.snapshot.directories)) {
          if (!(await readProcesses(value.path)).includes(identity.pid)) fail('process escaped cgroup admission')
          this.#assertAdmissionOpen()
        }
        await this.#verify()
        this.#assertAdmissionOpen()
      } catch (error) { this.#closing = true; throw error }
    })
  }
  async observe(): Promise<{ quiescent: boolean; processes: Record<string, number[]> }> {
    return this.#serialize(() => this.#observe())
  }
  async #observe(): Promise<{ quiescent: boolean; processes: Record<string, number[]> }> {
    await this.#verify(this.#closing)
    const processes: Record<string, number[]> = {}
    for (const [key, value] of Object.entries(this.snapshot.directories)) {
      processes[key] = this.#closing && !(await exists(value.path)) ? [] : await readProcesses(value.path)
    }
    return { quiescent: Object.values(processes).every(value => value.length === 0), processes }
  }
  async terminateAndProve(timeoutMs: number): Promise<boolean> {
    if (!positive(timeoutMs) || timeoutMs > 30_000) fail('invalid termination deadline')
    // Fence admission before awaiting either the operation queue or the kernel.
    this.#closing = true
    this.#allowAdmission = false
    const deadline = Date.now() + timeoutMs
    return this.#serialize(() => this.#terminateAndProve(deadline))
  }
  async #terminateAndProve(deadline: number): Promise<boolean> {
    await this.#verify(true)
    if ((await this.#observe()).quiescent) return true
    if (Date.now() >= deadline) return false
    if (this.snapshot.mode === 'v2') {
      const path = this.snapshot.directories.unified!.path
      if (!(await exists(path))) return false
      const isFrozen = async (): Promise<boolean> => /^frozen 1$/mu.test(await readFile(join(path, 'cgroup.events'), 'utf8'))
      await writeFile(join(path, 'cgroup.freeze'), '1\n')
      while (Date.now() < deadline && !(await isFrozen())) await pause(20)
      if (!(await isFrozen())) return false
      try {
        const relative = path.slice('/sys/fs/cgroup/'.length)
        const allowedUids = this.#namespaceTermination
          ? new Set([this.snapshot.uid, this.#namespaceTermination.witness.mapping.candidateUid])
          : new Set([this.snapshot.uid])
        const processes: Array<[number, string]> = []
        for (const pid of await readProcesses(path)) {
          const current = await processIdentity(pid)
          if (!current) continue
          if (current.state === 'Z' || !allowedUids.has(current.uid)) fail('cgroup contains an unexpected process')
          const cgroupLines = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw error
          })
          if (cgroupLines !== undefined && !cgroupLines.split('\n').some(line => line.trim() === `0::/${relative}`)) {
            fail('process escaped frozen cgroup v2 group')
          }
          processes.push([pid, current.startTicks])
        }
        if (this.#namespaceTermination && processes.length > 0) {
          await fixedPythonStdin(V2_NAMESPACE_VERIFY, {
            witness: this.#namespaceTermination.witness,
            outsideGates: this.#namespaceTermination.outsideGate ? [this.#namespaceTermination.outsideGate] : [],
            cgroupPath: path,
            cgroup: ['', `/${relative}`],
            processes,
          })
        }
        if (!(await isFrozen())) fail('cgroup v2 freeze barrier changed')
        await writeFile(join(path, 'cgroup.kill'), '1\n')
      } finally {
        await writeFile(join(path, 'cgroup.freeze'), '0\n')
      }
    } else {
      const freezer = this.snapshot.directories.freezer!.path
      // A missing freezer with live processes elsewhere is ambiguous. Never
      // turn a partial deletion into permission to signal unrelated processes.
      if (!(await exists(freezer))) return false
      await writeFile(join(freezer, 'freezer.state'), 'FROZEN\n')
      while (Date.now() < deadline && (await readFile(join(freezer, 'freezer.state'), 'utf8')).trim() !== 'FROZEN') await pause(20)
      if ((await readFile(join(freezer, 'freezer.state'), 'utf8')).trim() !== 'FROZEN') return false
      try { await killWithPidfds(freezer, this.snapshot.uid, 'v1', this.#namespaceTermination) }
      finally { await writeFile(join(freezer, 'freezer.state'), 'THAWED\n') }
    }
    while (Date.now() < deadline) {
      if ((await this.#observe()).quiescent) return true
      await pause(20)
    }
    return (await this.#observe()).quiescent
  }
  async removeWhenEmpty(): Promise<boolean> {
    this.#closing = true
    this.#allowAdmission = false
    return this.#serialize(() => this.#removeWhenEmpty())
  }
  async #removeWhenEmpty(): Promise<boolean> {
    if (!(await this.#observe()).quiescent) return false
    await pause(20)
    if (!(await this.#observe()).quiescent) return false
    for (const value of Object.values(this.snapshot.directories).reverse()) {
      if (await exists(value.path)) {
        await directory(value.path, value, this.snapshot.uid, this.snapshot.mode)
        await rmdir(value.path)
      }
    }
    for (const value of Object.values(this.snapshot.directories)) if (await exists(value.path)) return false
    return true
  }
}
