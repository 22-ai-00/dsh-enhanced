#!/usr/bin/env node
/** Install the fixed restart observer outside the target DSH Home. */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SHA = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const safePath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value
  && /^[A-Za-z0-9_/.+@=:-]+$/u.test(value)
const digest = data => createHash('sha256').update(data).digest('hex')
const inside = (parent, child) => child.startsWith(parent + sep)
const fail = message => { throw new Error(`restart-supervisor install: ${message}`) }
const hostCode = path => /\.(?:js|mjs|cjs|node)$/u.test(path) || path.endsWith('/package.json')

async function installedPackageRoot(home, profile, name) {
  const modules = join(home, 'profiles', profile, 'node_modules')
  const direct = await realpath(join(modules, name)).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (direct !== undefined) return direct
  const store = join(modules, '.pnpm')
  const candidates = (await readdir(store)).filter(entry => entry.startsWith(`${name.replace('/', '+')}@`))
  if (candidates.length !== 1) fail(`installed cohort package is ambiguous: ${name}`)
  return await realpath(join(store, candidates[0], 'node_modules', name))
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key?.startsWith('--') || values.has(key)) fail('invalid or duplicate argument')
    if (key === '--dry-run' || key === '--install') values.set(key, true)
    else {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) fail('missing argument value')
      values.set(key, value)
    }
  }
  const names = ['--dsh-home', '--profile', '--source-commit', '--database-path',
    '--delivery-database-path', '--policy-database-path', '--node-path']
  if (values.size !== names.length + 1 || names.some(name => !values.has(name))
    || Number(values.has('--dry-run')) + Number(values.has('--install')) !== 1) {
    fail('expected exact installation arguments')
  }
  const input = {
    dshHome: values.get('--dsh-home'), profile: values.get('--profile'),
    sourceCommit: values.get('--source-commit'), databasePath: values.get('--database-path'),
    deliveryDatabasePath: values.get('--delivery-database-path'),
    policyDatabasePath: values.get('--policy-database-path'), nodePath: values.get('--node-path'),
    mode: values.has('--install') ? 'install' : 'dry-run',
  }
  if (!PROFILE.test(input.profile) || !COMMIT.test(input.sourceCommit)
    || !['dry-run', 'install'].includes(input.mode)
    || [input.dshHome, input.databasePath, input.deliveryDatabasePath,
      input.policyDatabasePath, input.nodePath].some(value => !safePath(value))) {
    fail('invalid profile, commit, path, or mode')
  }
  return input
}

function invoke(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }, maxBuffer: 262_144 })
  if (result.status !== 0) fail(`${command} failed`)
  return result.stdout
}

async function privateFile(path, maxSize = 512_000, allowEmpty = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat(), named = await lstat(path)
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink() || before.nlink !== 1
      || before.uid !== process.getuid() || before.dev !== named.dev || before.ino !== named.ino
      || before.mode & 0o022 || !allowEmpty && before.size < 1 || before.size > maxSize) fail('unsafe input file')
    const source = await handle.readFile(), after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('input changed while reading')
    return source
  } finally { await handle.close() }
}

async function hostIdentity(home, userHome) {
  const bindingSource = await privateFile(join(home, '.dsh-rsi-host.json'), 16_384)
  const binding = JSON.parse(bindingSource.toString('utf8'))
  if (binding.schemaVersion !== 1 || !safePath(binding.cacheRoot)
    || !/^0\.2\.[0-9]+-rc\.[0-9]+$/u.test(binding.version)
    || !SHA.test(binding.receiptDigest)) fail('invalid Home Host binding')
  const hostRoot = join(binding.cacheRoot, binding.version)
  if (!inside(userHome, hostRoot) || await realpath(hostRoot) !== hostRoot) fail('Host escapes private user runtime')
  const receiptPath = join(hostRoot, 'receipt.json')
  const receiptSource = await privateFile(receiptPath, 16_777_216)
  const receipt = JSON.parse(receiptSource.toString('utf8'))
  if (receipt.schemaVersion !== 1 || receipt.version !== binding.version
    || !Array.isArray(receipt.entries) || receipt.entries.length < 2 || receipt.entries.length > 150_000
    || digest(JSON.stringify(receipt)) !== binding.receiptDigest) fail('Host receipt changed')
  const dshPath = join(hostRoot, 'node_modules', '.bin', 'dsh')
  const dshEntry = receipt.entries.find(entry => entry.path === 'node_modules/.bin/dsh')
  if (dshEntry?.type !== 'link' || typeof dshEntry.target !== 'string'
    || await readlink(dshPath) !== dshEntry.target
    || !inside(hostRoot, await realpath(dshPath))) fail('Host executable link changed')
  for (const entry of receipt.entries) {
    if (entry.type !== 'link') continue
    if (typeof entry.path !== 'string' || !/^[a-zA-Z0-9_./+@=-]+$/u.test(entry.path)
      || entry.path.includes('..') || typeof entry.target !== 'string'
      || await readlink(join(hostRoot, entry.path)) !== entry.target) fail('Host link differs from installed receipt')
  }
  let codeCount = 0
  for (const entry of receipt.entries) {
    if (entry.type !== 'file' || !hostCode(entry.path)) continue
    if (!/^[a-zA-Z0-9_./+@=-]+$/u.test(entry.path) || entry.path.includes('..')
      || !SHA.test(entry.sha256)) fail('unsafe Host code receipt entry')
    const path = join(hostRoot, entry.path)
    if (!inside(hostRoot, await realpath(path)) || digest(await privateFile(path, 16_777_216, true)) !== entry.sha256) {
      fail('Host code differs from installed receipt')
    }
    codeCount += 1
  }
  if (codeCount < 2) fail('Host receipt has no executable code')
  return { dshPath, receiptPath, bindingDigest: digest(bindingSource), receiptSourceDigest: digest(receiptSource) }
}

async function withLifecycleLock(home, task) {
  const tmp = await lstat('/tmp')
  if (!tmp.isDirectory() || tmp.uid !== 0 || (tmp.mode & 0o7777) !== 0o1777) fail('unsafe /tmp')
  const lockPath = `/tmp/.dsh-enhanced-lifecycle-${process.getuid()}-${digest(home)}.lock`
  const lock = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const opened = await lock.stat(), linked = await lstat(lockPath)
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid()
      || (opened.mode & 0o777) !== 0o600 || linked.dev !== opened.dev || linked.ino !== opened.ino) fail('unsafe lifecycle lock')
    const result = spawnSync('/usr/bin/flock', ['-n', '-E', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', lock.fd], timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    })
    if (result.status === 75) fail('lifecycle lock busy')
    if (result.status !== 0) fail('lifecycle lock failed')
    return await task()
  } finally { await lock.close() }
}

/** Validate an installed cohort, then return content for external files only. */
export async function planRestartSupervisorInstall(input, dependencies = {}) {
  if (!PROFILE.test(input.profile) || !COMMIT.test(input.sourceCommit)
    || [input.dshHome, input.databasePath, input.deliveryDatabasePath,
      input.policyDatabasePath, input.nodePath].some(value => !safePath(value))) {
    fail('invalid fixed installation input')
  }
  const home = await realpath(input.dshHome)
  if (home !== input.dshHome) fail('Home must be canonical')
  const userHome = await realpath(dependencies.userHome ?? homedir())
  if (inside(home, userHome) || home === userHome) fail('external config must be outside DSH Home')
  if (await lstat(`${home}.dsh-enhanced-transaction`).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })) fail('Home upgrade transaction exists')
  const host = await hostIdentity(home, userHome)
  const receiptPath = join(home, 'rsi-local-cohorts', input.profile, 'receipt.json')
  const receipt = JSON.parse((await privateFile(receiptPath, 2_000_000)).toString('utf8'))
  if (receipt.sourceCommit !== input.sourceCommit
    || receipt.root !== join(home, 'rsi-local-cohorts', input.profile)
    || !Array.isArray(receipt.packages)) fail('cohort receipt does not match expected source')
  const packageRoots = new Map()
  const trustedFiles = []
  if (receipt.packages.length < 2 || receipt.packages.length > 128) fail('unexpected cohort package count')
  for (const proof of receipt.packages) {
    if (!/^@dsh-enhanced\/[a-z0-9-]+$/u.test(proof.name)
      || !Array.isArray(proof.files) || proof.files.length < 2
      || packageRoots.has(proof.name)) fail('invalid cohort package inventory')
    const rootPath = await installedPackageRoot(home, input.profile, proof.name)
    if (!inside(home, rootPath)) fail('installed package escapes Home')
    packageRoots.set(proof.name, rootPath)
    const manifest = JSON.parse((await privateFile(join(rootPath, 'package.json'))).toString('utf8'))
    if (manifest.name !== proof.name || manifest.version !== receipt.version) fail('installed package version changed')
    const files = proof.files.filter(item => typeof item.path === 'string'
      && (item.path === 'package.json' || item.path === 'cordis.patch.yml'
        || /^(?:lib|bin)\/[a-z0-9._/-]+\.(?:js|mjs|cjs)$/u.test(item.path)))
    if (files.length < 2 || !files.some(item => item.path === 'package.json')) fail('cohort misses executable code')
    for (const file of files) {
      const actual = await realpath(join(rootPath, file.path))
      if (!SHA.test(file.sha256) || !inside(rootPath, actual)
        || digest(await privateFile(actual, 2_000_000)) !== file.sha256) {
        fail(`installed helper is not frozen by cohort: ${proof.name}/${file.path}`)
      }
      trustedFiles.push({ path: actual, digest: file.sha256 })
    }
  }
  const deliveryRoot = packageRoots.get('@dsh-enhanced/assistant-delivery')
  const policyRoot = packageRoots.get('@dsh-enhanced/assistant-policy')
  if (!deliveryRoot || !policyRoot) fail('cohort lacks Delivery or Policy')
  const helper = join(deliveryRoot, 'bin/dsh-restart-supervisor.js')
  const policyEvaluatorPath = join(policyRoot, 'lib/evaluator.js')
  if (!trustedFiles.some(file => file.path === helper)
    || !trustedFiles.some(file => file.path === policyEvaluatorPath)) fail('cohort misses required helper code')
  const profilePatchPath = join(home, 'profiles', input.profile, 'cordis.patch.yml')
  const profilePatch = await privateFile(profilePatchPath, 2_000_000)
  const parsed = YAML.parseDocument(profilePatch.toString('utf8'), {
    uniqueKeys: true, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  if (parsed.errors.length !== 0) fail('invalid frozen profile patch')
  const entries = parsed.toJS()
  const policyEntries = Array.isArray(entries)
    ? entries.filter(entry => entry?.id === 'dsh-enhanced-personal-assistant')
    : []
  if (policyEntries.length !== 1 || !policyEntries[0]?.config?.assistantPolicy) {
    fail('profile patch lacks one explicit Policy configuration')
  }
  const policyConfig = policyEntries[0].config.assistantPolicy
  const automationConfig = policyEntries[0].config.assistantAutomations
  if (policyConfig.databasePath !== "dshHomePath('assistant-policy/policy.sqlite')"
    || input.policyDatabasePath !== join(home, 'assistant-policy', 'policy.sqlite')
    || !Array.isArray(policyConfig.rules)
    || automationConfig?.databasePath !== "dshHomePath('assistant-automations/state.sqlite')") {
    fail('Policy/Automations database or rules are not pinned by profile')
  }
  const policyRules = policyConfig.rules
  const deliveryEntries = Array.isArray(entries)
    ? entries.filter(entry => entry?.id === 'dsh-enhanced-assistant-delivery') : []
  if (deliveryEntries.length !== 1 || !deliveryEntries[0]?.config) {
    fail('profile patch lacks one explicit Delivery configuration')
  }
  const deliveryConfig = deliveryEntries[0].config
  const restartConfig = deliveryConfig.restart
  if (deliveryConfig.databasePath !== "dshHomePath('assistant-delivery/state.sqlite')"
    || input.deliveryDatabasePath !== join(home, 'assistant-delivery', 'state.sqlite')
    || restartConfig?.databasePath !== input.databasePath
    || restartConfig.databasePath !== join(home, 'assistant-delivery', 'restart.sqlite')
    || typeof restartConfig.ownerRouteId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(restartConfig.ownerRouteId)
    || !Array.isArray(deliveryConfig.ownerRoutes) || deliveryConfig.ownerRoutes.length !== 1
    || deliveryConfig.ownerRoutes[0]?.id !== restartConfig.ownerRouteId) {
    fail('Delivery restart database or owner route is not frozen by profile')
  }
  const node = await realpath(input.nodePath)
  const nodeStat = await stat(node)
  if (!nodeStat.isFile() || !(nodeStat.mode & 0o111)) fail('invalid Node executable')
  const unit = `dsh-profile-${input.profile}.service`
  const show = dependencies.showUnit ?? (name => invoke('/usr/bin/systemctl', ['--user', 'show', name,
    '-p', 'Id', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'FragmentPath', '-p', 'DropInPaths']))
  const properties = new Map(show(unit).trim().split('\n').map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]
  }))
  const fragment = properties.get('FragmentPath')
  if (properties.get('Id') !== unit || properties.get('LoadState') !== 'loaded'
    || properties.get('ActiveState') !== 'active' || properties.get('SubState') !== 'running'
    || properties.get('DropInPaths') !== '' || !safePath(fragment)) fail('target unit is not the expected active plain Host')
  const unitSource = await privateFile(fragment, 128_000)
  const unitText = unitSource.toString('utf8')
  if (!unitText.includes('StartLimitIntervalSec=600\nStartLimitBurst=3\n')
    || !unitText.includes(`WorkingDirectory=${join(home, 'profiles', input.profile)}\n`)
    || !unitText.includes(`Environment="DSH_HOME=${home}"\n`)
    || !unitText.includes(`"${host.dshPath}" --profile ${input.profile} --no-open\n`)) {
    fail('target unit does not run this cohort profile')
  }
  const unitDigest = digest(unitSource)
  const stateDir = join(userHome, '.local', 'state', 'dsh-enhanced', 'restart-supervisor', input.profile)
  const unitDir = join(userHome, '.config', 'systemd', 'user')
  const configPath = join(stateDir, 'config.json')
  if ([stateDir, unitDir, configPath, helper, node].some(value => !safePath(value))
    || [stateDir, unitDir].some(value => value === home || inside(home, value))) fail('unsafe external path')
  const serviceName = `dsh-restart-supervisor-${input.profile}.service`
  const timerName = `dsh-restart-supervisor-${input.profile}.timer`
  const config = {
    dshHome: home, profile: input.profile, databasePath: input.databasePath,
    deliveryDatabasePath: input.deliveryDatabasePath,
    policyDatabasePath: input.policyDatabasePath, policyEvaluatorPath,
    automationDatabasePath: join(home, 'assistant-automations', 'state.sqlite'),
    profilePatchDigest: digest(profilePatch), cohortReceiptDigest: digest(await privateFile(receiptPath, 2_000_000)),
    sourceCommit: input.sourceCommit, trustedFiles, policyRules,
    hostBindingDigest: host.bindingDigest, hostReceiptPath: host.receiptPath,
    hostReceiptSourceDigest: host.receiptSourceDigest,
    restartOwnerRouteId: restartConfig.ownerRouteId,
    unit, expectedUnitDigest: unitDigest,
    readyTimeoutMs: 120_000, stableWindowMs: 12_000, maxRestarts: 3, windowMs: 600_000,
  }
  const service = `[Unit]\nDescription=DSH fixed restart observer for ${input.profile}\n
[Service]\nType=oneshot\nWorkingDirectory=${stateDir}\nUnsetEnvironment=DSH_HOME\nExecStart=${node} ${helper} --config ${configPath} --once\nTimeoutStartSec=180\nNoNewPrivileges=yes\n` 
  const timer = `[Unit]\nDescription=Poll DSH restart requests for ${input.profile}\n
[Timer]\nOnBootSec=15s\nOnUnitInactiveSec=2s\nAccuracySec=1s\nUnit=${serviceName}\nPersistent=false\n
[Install]\nWantedBy=timers.target\n`
  return { home, stateDir, unitDir, configPath, serviceName, timerName,
    servicePath: join(unitDir, serviceName), timerPath: join(unitDir, timerName),
    configSource: `${JSON.stringify(config)}\n`, serviceSource: service, timerSource: timer,
    sourceCommit: input.sourceCommit, helper }
}

async function writeExact(path, source, mode) {
  const previous = await readFile(path).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (previous !== undefined) {
    const meta = await lstat(path)
    if (!meta.isFile() || meta.isSymbolicLink() || meta.uid !== process.getuid()) fail('existing installation file unsafe')
    if (previous.equals(Buffer.from(source))) { await chmod(path, mode); return }
  }
  const staged = `${path}.${randomUUID()}.tmp`
  await writeFile(staged, source, { flag: 'wx', mode })
  await rename(staged, path)
}

export async function installRestartSupervisorPlan(plan, dependencies = {}) {
  await mkdir(plan.stateDir, { recursive: true, mode: 0o700 })
  await chmod(plan.stateDir, 0o700)
  await mkdir(plan.unitDir, { recursive: true, mode: 0o700 })
  await writeExact(plan.configPath, plan.configSource, 0o600)
  await writeExact(plan.servicePath, plan.serviceSource, 0o600)
  await writeExact(plan.timerPath, plan.timerSource, 0o600)
  const systemctl = dependencies.systemctl ?? ((...args) => invoke('/usr/bin/systemctl', ['--user', ...args]))
  systemctl('daemon-reload')
  systemctl('enable', '--now', plan.timerName)
}

async function main() {
  const input = parseArgs(process.argv.slice(2))
  const home = await realpath(input.dshHome)
  if (home !== input.dshHome) fail('Home must be canonical')
  const plan = await withLifecycleLock(home, async () => {
    const value = await planRestartSupervisorInstall(input)
    if (input.mode === 'install') await installRestartSupervisorPlan(value)
    return value
  })
  process.stdout.write(`${JSON.stringify({ mode: input.mode, configPath: plan.configPath,
    servicePath: plan.servicePath, timerPath: plan.timerPath, helper: plan.helper,
    sourceCommit: plan.sourceCommit })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
