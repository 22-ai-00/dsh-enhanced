#!/usr/bin/env node
/** Operator entry for an existing frozen Linux installation. It prepares new
 * code outside Home and delegates all live changes to the locked v4 lifecycle. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = resolve(dirname(scriptPath), '../..')
const hash = value => createHash('sha256').update(value).digest('hex')
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const fail = message => { throw new Error(`Program upgrade: ${message}`) }

export function parseProgramUpgradeArgs(args) {
  const result = { selector: 'latest', dryRun: false, recover: false, recoverReadiness: false,
    recoverRollbackReadiness: false }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (seen.has(key)) fail(`duplicate option ${key}`)
    seen.add(key)
    if (key === '--dry-run') result.dryRun = true
    else if (key === '--recover') result.recover = true
    else if (key === '--recover-readiness') result.recoverReadiness = true
    else if (key === '--recover-rollback-readiness') result.recoverRollbackReadiness = true
    else if (['--dsh-home', '--profile', '--dsh-version', '--restart-config'].includes(key)) {
      const value = args[++index]
      if (!value || value.startsWith('-')) fail(`${key} requires a value`)
      result[key === '--dsh-home' ? 'home' : key === '--profile' ? 'profile'
        : key === '--restart-config' ? 'restartConfigPath' : 'selector'] = value
    } else fail(`unknown option ${key}`)
  }
  if (!isAbsolute(result.home ?? '') || resolve(result.home) !== result.home
    || !profilePattern.test(result.profile ?? '')
    || !['latest', '0.2.1-rc.2'].includes(result.selector)) fail('expected an absolute Home, an existing profile and a supported Host selector')
  if (result.restartConfigPath !== undefined && (!isAbsolute(result.restartConfigPath)
    || resolve(result.restartConfigPath) !== result.restartConfigPath)) fail('restart config path must be absolute and canonical')
  if ((result.recoverReadiness || result.recoverRollbackReadiness)
    && (result.recover || result.recoverReadiness && result.recoverRollbackReadiness
      || seen.has('--dsh-version'))) {
    fail('readiness recovery cannot select a Host version or another recovery mode')
  }
  return result
}

async function privateJson(path, maximum = 2_097_152) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid())
      || before.mode & 0o077n || before.size < 1n || before.size > BigInt(maximum)) fail(`unsafe metadata: ${path}`)
    const source = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('metadata changed during read')
    return JSON.parse(source.toString('utf8'))
  } finally { await handle.close() }
}

async function runLifecycle(args, env) {
  const child = spawn(process.execPath, [join(repositoryRoot, 'scripts/install/lifecycle-profile.mjs'), ...args],
    { stdio: 'inherit', env })
  const forward = signal => child.kill(signal)
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    return await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', code => accept(code ?? 1))
    })
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm) }
}

export async function runProgramUpgrade(options) {
  if (process.platform !== 'linux') fail('frozen owner program upgrades require Linux systemd')
  const home = await realpath(options.home)
  const root = await realpath(repositoryRoot)
  if (root === home || root.startsWith(home + sep) || home.startsWith(root + sep)) fail('installer and Home must be separate')
  const homeEntry = await lstat(home)
  if (!homeEntry.isDirectory() || homeEntry.uid !== process.getuid() || homeEntry.mode & 0o077) fail('Home is not owner-private')
  const profile = options.profile
  const binding = await privateJson(join(home, '.dsh-rsi-host.json'), 16_384)
  const transactionPath = `${home}.dsh-enhanced-transaction`
  let pending
  try { pending = await privateJson(join(transactionPath, 'manifest.json'), 8_388_608) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (pending) {
    const proof = pending.hostMigration?.localSource
    if (pending.version !== 4 || pending.operation !== 'host-update'
      || pending.homePath !== home || pending.profile !== profile
      || pending.transactionPath !== transactionPath
      || !options.recoverReadiness && !options.recoverRollbackReadiness && proof?.installer?.root !== root
      || proof?.protocol !== 'dsh-enhanced/host-owner-program-update/v1') fail('pending transaction belongs to another reviewed installer or operation')
    if (options.restartConfigPath !== undefined
      && options.restartConfigPath !== proof.ownerUpdate?.restartConfigSourcePath) {
      fail('pending restart config input differs from the frozen transaction')
    }
    if (pending.hostMigration.programReadinessRecovery !== undefined && !options.recoverReadiness) {
      fail('pending signed readiness recovery requires the separately reviewed checkout and --recover-readiness; the original installer must remain unchanged')
    }
    if (pending.hostMigration.rollbackReadinessRecovery !== undefined && !options.recoverRollbackReadiness) {
      fail('pending signed rollback readiness recovery requires the separately reviewed checkout and --recover-rollback-readiness')
    }
    if (options.dryRun) {
      process.stdout.write(options.recoverRollbackReadiness
        ? '将使用独立安装器核验已运行的原服务并完成回滚；保留当前 Home、授权和新数据。\n'
        : options.recoverReadiness
          ? '将使用当前独立安装器核验并恢复候选的就绪检查；保留原安装器、授权和当前数据。\n'
          : '将先恢复现有程序升级事务；不拉取或重建安装器。\n')
      return 0
    }
    const { assertLocalSourceInstaller } = await import('./local-source-maintenance.mjs')
    await assertLocalSourceInstaller(proof.installer)
    const original = pending.hostMigration.plan.originalRuntime
    const env = { ...process.env, DSH_HOME: home, NODE_OPTIONS: '', NODE_PATH: '',
      PATH: [original.binDirectory, dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':') }
    const status = await runLifecycle([options.recoverRollbackReadiness ? 'host-recover-rollback-readiness'
      : options.recoverReadiness ? 'host-recover-readiness' : 'host-recover',
      profile, home, original.dshPath, '/usr/bin/bwrap', '/usr/bin/systemctl', '/usr/bin/journalctl',
      ...(options.recoverReadiness || options.recoverRollbackReadiness ? [root] : [])], env)
    if (status === 0) process.stdout.write('已有程序升级事务已完成恢复。再次运行同一升级命令可检查更新。\n')
    return status
  }
  if (options.recoverRollbackReadiness) {
    if (!isAbsolute(binding.cacheRoot ?? '') || resolve(binding.cacheRoot) !== binding.cacheRoot
      || !/^0\.2\.[01]-rc\.2$/u.test(binding.version ?? '')) fail('completed rollback Host binding differs')
    const binDirectory = join(binding.cacheRoot, binding.version, 'node_modules', '.bin')
    const dshPath = join(binDirectory, 'dsh')
    const env = { ...process.env, DSH_HOME: home, NODE_OPTIONS: '', NODE_PATH: '',
      PATH: [binDirectory, dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':') }
    return runLifecycle(['host-recover-rollback-readiness', profile, home, dshPath,
      '/usr/bin/bwrap', '/usr/bin/systemctl', '/usr/bin/journalctl', root], env)
  }
  if (options.recover || options.recoverReadiness) {
    fail('no pending program upgrade transaction')
  }
  const cohort = await privateJson(join(home, 'rsi-local-cohorts', profile, 'receipt.json'), 20_971_520)
  if (cohort.schemaVersion !== 1 || await realpath(cohort.sourceRepository) !== root
    || cohort.root !== join(home, 'rsi-local-cohorts', profile)) fail('frozen source does not belong to this installer')
  if (options.dryRun) {
    process.stdout.write(`将准备 ${profile} 的新源码、依赖和 DSH ${options.selector}；随后在受管停服事务中保留原 owner、授权、凭据和历史。\n`)
    return 0
  }
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('program upgrade preparation interrupted'))
  process.on('SIGINT', abort); process.on('SIGTERM', abort)
  try {
    const { prepareHostUpdatePlan } = await import(pathToFileURL(join(root, 'packages/dsh-rsi-cli/lib/install-host.js')).href)
    const hostPlan = await prepareHostUpdatePlan({ dshHome: home, selector: options.selector, signal: controller.signal })
    if (!['0.2.0-rc.2', '0.2.1-rc.2'].includes(hostPlan.originalRuntime.version)
      || hostPlan.candidateRuntime.version !== '0.2.1-rc.2'
      || binding.receiptDigest !== hostPlan.originalRuntime.receiptDigest) fail('unsupported or changed bound Host')
    process.stdout.write(`准备程序升级：${profile}；DSH ${hostPlan.originalRuntime.version} → ${hostPlan.candidateRuntime.version}。\n`)
    const { prepareRsiLocalUpdate } = await import(pathToFileURL(join(root, 'plugins/lark-channel/lib/rsi-local-update.js')).href)
    const prepared = await prepareRsiLocalUpdate({ dshHome: home, profile, sourceRepository: root, signal: controller.signal })
    if (prepared.source.sourceCommit === cohort.sourceCommit && hostPlan.status === 'current') {
      if (options.restartConfigPath !== undefined) fail('restart config requires a new reviewed source cohort')
      process.stdout.write(`程序与 DSH 已是当前源码版本（${prepared.source.sourceCommit.slice(0, 12)}），无需停服。\n`)
      return 0
    }
    const parent = join(dirname(home), `.dsh-rsi-program-updates-${hash(home).slice(0, 16)}`)
    await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const parentEntry = await lstat(parent)
    if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink() || parentEntry.uid !== process.getuid()
      || parentEntry.mode & 0o077 || await realpath(parent) !== parent) fail('unsafe program update preparation directory')
    const runRoot = join(parent, randomUUID())
    await mkdir(runRoot, { mode: 0o700 })
    const planPath = join(runRoot, 'host-plan.json')
    await writeFile(planPath, `${JSON.stringify(hostPlan)}\n`, { mode: 0o600, flag: 'wx' })
    const env = { ...process.env, DSH_HOME: home, NODE_OPTIONS: '', NODE_PATH: '',
      PATH: [hostPlan.originalRuntime.binDirectory, dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(':') }
    controller.signal.throwIfAborted()
    const status = await runLifecycle(['host-program-update', profile, home, hostPlan.originalRuntime.dshPath,
      '/usr/bin/bwrap', '/usr/bin/systemctl', '/usr/bin/journalctl', planPath, prepared.root, root,
      join(runRoot, 'auxiliary'), ...(options.restartConfigPath ? [options.restartConfigPath] : [])], env)
    if (status !== 0) return status
    const after = await privateJson(join(home, '.dsh-rsi-host.json'), 16_384)
    const installed = await privateJson(join(home, 'rsi-local-cohorts', profile, 'receipt.json'), 20_971_520)
    if (after.version !== hostPlan.candidateRuntime.version || after.receiptDigest !== hostPlan.candidateRuntime.receiptDigest
      || installed.sourceCommit !== prepared.source.sourceCommit || installed.version !== prepared.cohort.version) {
      fail('lifecycle returned without the expected installed program; preserved recovery evidence requires review')
    }
    process.stdout.write(`程序升级完成：增强包 ${installed.version}，DSH ${after.version}。原主人绑定、授权和历史沿用。\n`)
    return 0
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort) }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  runProgramUpgrade(parseProgramUpgradeArgs(process.argv.slice(2))).then(code => { process.exitCode = code })
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
