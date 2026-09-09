import { chmod, cp, link, lstat, mkdtemp, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { RECOVERY_CATALOG_DIGEST } from '@dsh-enhanced/assistant-recovery'
import { createSystemdUserUnit, systemdServicePaths } from '../plugins/lark-channel/src/systemd.ts'
import { classifyLifecycleScenario } from '../scripts/install/lifecycle-config.mjs'
import {
  assertEffectiveSupervisedGrowthConfig,
  configureSupervisedGrowthProfilePatch,
} from '../plugins/lark-channel/src/supervised-growth-profile.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installDirectory = join(repoRoot, 'scripts', 'install')
const localInstaller = join(installDirectory, 'install-local.sh')
const npmInstaller = join(installDirectory, 'install-npm.sh')
const restartScript = join(installDirectory, 'restart.sh')
const installerLibrary = join(installDirectory, 'common.sh')
const temporaryRoots: string[] = []
const pinnedInstallerSource = readFileSync(npmInstaller, 'utf8')
const pinnedReleaseRef = pinnedInstallerSource.match(/^DSH_ENHANCED_PINNED_RELEASE_REF='([^']+)'$/mu)?.[1]
const pinnedLifecycleConfigHash = pinnedInstallerSource
  .match(/^DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256='([0-9a-f]{64})'$/mu)?.[1]
const pinnedLifecycleProfileHash = pinnedInstallerSource
  .match(/^DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256='([0-9a-f]{64})'$/mu)?.[1]
const pinnedRemoteCommon = pinnedReleaseRef === undefined ? undefined : spawnSync('git', [
  'show', `${pinnedReleaseRef}:scripts/install/common.sh`,
], {
  cwd: repoRoot,
  encoding: 'buffer',
})
const pinnedRemoteLifecycleConfig = pinnedReleaseRef === undefined ? undefined : spawnSync('git', [
  'show', `${pinnedReleaseRef}:scripts/install/lifecycle-config.mjs`,
], { cwd: repoRoot, encoding: 'buffer' })
const pinnedRemoteLifecycleProfile = pinnedReleaseRef === undefined ? undefined : spawnSync('git', [
  'show', `${pinnedReleaseRef}:scripts/install/lifecycle-profile.mjs`,
], { cwd: repoRoot, encoding: 'buffer' })
const realBwrapProbe = spawnSync('/usr/bin/bwrap', [
  '--unshare-all', '--die-with-parent', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true',
], { encoding: 'utf8', timeout: 5_000 })
const realBwrapUsable = realBwrapProbe.status === 0

/**
 * Run an installer entry point.
 *
 * `platform` pins `uname -s` detection the same way {@link runRestart} does, so
 * assertions about a platform-specific resident service (systemd units on
 * Linux, launchd on macOS) stay deterministic on any development host instead
 * of only passing on the CI runner's operating system.
 */
function runInstaller(
  script: string,
  args: readonly string[],
  dshHome: string,
  platform?: string,
  extraEnvironment: Record<string, string | undefined> = {},
) {
  const fixtureScript = join(dirname(dshHome), 'install', basename(script))
  return spawnSync('/bin/bash', [existsSync(fixtureScript) ? fixtureScript : script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DSH_HOME: dshHome,
      ...(platform === undefined ? {} : { DSH_ENHANCED_PLATFORM_OVERRIDE: platform }),
      ...extraEnvironment,
    },
  })
}

function runRestart(args: readonly string[], dshHome: string, platform?: string) {
  return spawnSync('/bin/bash', [restartScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      DSH_HOME: dshHome,
      DSH_ENHANCED_DRY_RUN: '1',
      ...(platform === undefined ? {} : { DSH_ENHANCED_PLATFORM_OVERRIDE: platform }),
    },
  })
}

async function temporaryDshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-enhanced-installer-'))
  temporaryRoots.push(root)
  return root
}

async function configureExistingLark(dshHome: string, profile = 'web'): Promise<void> {
  const profileDirectory = join(dshHome, 'profiles', profile)
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}

const zeroSha256 = '0'.repeat(64)

function withPinnedLifecycleHashes(source: string, configHash: string, profileHash: string): string {
  return source
    .replace(
      /^DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256='[0-9a-f]{64}'$/mu,
      `DSH_ENHANCED_PINNED_LIFECYCLE_CONFIG_SHA256='${configHash}'`,
    )
    .replace(
      /^DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256='[0-9a-f]{64}'$/mu,
      `DSH_ENHANCED_PINNED_LIFECYCLE_PROFILE_SHA256='${profileHash}'`,
    )
}

interface RemoteBootstrapFixture {
  assets: Record<'common.sh' | 'lifecycle-config.mjs' | 'lifecycle-profile.mjs', string>
  assetDirectory: string
  dshHome: string
  fakeBin: string
  hashes: Record<'common.sh' | 'lifecycle-config.mjs' | 'lifecycle-profile.mjs', string>
  logPath: string
  temporaryDirectory: string
}

async function remoteBootstrapFixture(
  replacements: Partial<RemoteBootstrapFixture['assets']> = {},
): Promise<RemoteBootstrapFixture> {
  const root = await temporaryDshHome()
  const assetDirectory = join(root, 'release-assets')
  const fakeBin = join(root, 'bin')
  const temporaryDirectory = join(root, 'tmp')
  const dshHome = join(root, 'dsh-home')
  const logPath = join(root, 'bootstrap.log')
  await Promise.all([
    mkdir(assetDirectory),
    mkdir(fakeBin),
    mkdir(temporaryDirectory, { mode: 0o700 }),
  ])
  const assets = {
    'common.sh': [
      '#!/usr/bin/env bash',
      'printf \'source:common\\n\' >> "$REMOTE_BOOTSTRAP_LOG"',
      'dsh_enhanced_install() {',
      '  { printf \'run\'; printf \'\\t%s\' "$@"; printf \'\\n\'; } >> "$REMOTE_BOOTSTRAP_LOG"',
      '  mkdir -p "$DSH_HOME"',
      '  printf \'mutated\\n\' > "$DSH_HOME/bootstrap-ran"',
      '}',
      '',
    ].join('\n'),
    'lifecycle-config.mjs': '// lifecycle config fixture\n',
    'lifecycle-profile.mjs': '// lifecycle profile fixture\n',
    ...replacements,
  }
  await Promise.all(Object.entries(assets).map(([name, source]) => (
    writeFile(join(assetDirectory, name), source, 'utf8')
  )))
  await writeExecutable(join(fakeBin, 'curl'), [
    '#!/bin/bash',
    'set -euo pipefail',
    "url=''",
    "destination=''",
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    -o) destination="$2"; shift 2 ;;',
    '    -*) shift ;;',
    '    *) url="$1"; shift ;;',
    '  esac',
    'done',
    'asset="$(basename "$url")"',
    'printf \'download\\t%s\\n\' "$url" >> "$REMOTE_BOOTSTRAP_LOG"',
    'cp "$REMOTE_BOOTSTRAP_ASSETS/$asset" "$destination"',
    'if [[ "$REMOTE_BOOTSTRAP_TAMPER" == "$asset" ]]; then',
    '  printf \'tampered\\n\' >> "$destination"',
    'fi',
    '',
  ].join('\n'))
  await writeExecutable(join(fakeBin, 'sha256sum'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'asset="$(basename "$1" .download)"',
    'printf \'verify\\t%s\\n\' "$asset" >> "$REMOTE_BOOTSTRAP_LOG"',
    'exec /usr/bin/sha256sum "$@"',
    '',
  ].join('\n'))
  await writeExecutable(join(fakeBin, 'stat'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'target="${@: -1}"',
    'if [[ -n "${REMOTE_BOOTSTRAP_FOREIGN_STAT_PATH:-}" && "$target" == "$REMOTE_BOOTSTRAP_FOREIGN_STAT_PATH" && "${1:-}" == -c ]]; then',
    '  raw="$(/usr/bin/stat "$@")"',
    '  IFS=: read -r device inode _ mode links type <<< "$raw"',
    "  printf '%s:%s:%s:%s:%s:%s\\n' \"$device\" \"$inode\" \"$REMOTE_BOOTSTRAP_FOREIGN_UID\" \"$mode\" \"$links\" \"$type\"",
    '  exit 0',
    'fi',
    'exec /usr/bin/stat "$@"',
    '',
  ].join('\n'))
  const hashes = Object.fromEntries(Object.entries(assets).map(([name, source]) => [
    name, createHash('sha256').update(source).digest('hex'),
  ])) as RemoteBootstrapFixture['hashes']
  return { assets, assetDirectory, dshHome, fakeBin, hashes, logPath, temporaryDirectory }
}

function runRemoteNpmBootstrap(
  installer: string,
  fixture: RemoteBootstrapFixture,
  args: readonly string[],
  options: {
    lifecycleDigests?: boolean
    foreignStatPath?: string
    tamper?: keyof RemoteBootstrapFixture['assets']
    temporaryDirectory?: string
  } = {},
) {
  return spawnSync('/bin/bash', ['-s', '--', ...args], {
    cwd: dirname(fixture.dshHome),
    encoding: 'utf8',
    input: installer,
    env: {
      PATH: fixture.fakeBin + ':/usr/bin:/bin',
      TMPDIR: options.temporaryDirectory ?? fixture.temporaryDirectory,
      DSH_HOME: fixture.dshHome,
      DSH_ENHANCED_INSTALL_REF: 'v9.8.7',
      DSH_ENHANCED_INSTALL_BASE_URL: 'https://assets.invalid/v9.8.7',
      DSH_ENHANCED_INSTALL_COMMON_SHA256: fixture.hashes['common.sh'],
      ...(options.lifecycleDigests ? {
        DSH_ENHANCED_INSTALL_LIFECYCLE_CONFIG_SHA256: fixture.hashes['lifecycle-config.mjs'],
        DSH_ENHANCED_INSTALL_LIFECYCLE_PROFILE_SHA256: fixture.hashes['lifecycle-profile.mjs'],
      } : {}),
      REMOTE_BOOTSTRAP_ASSETS: fixture.assetDirectory,
      REMOTE_BOOTSTRAP_FOREIGN_STAT_PATH: options.foreignStatPath ?? '',
      REMOTE_BOOTSTRAP_FOREIGN_UID: String((process.getuid?.() ?? 0) + 1),
      REMOTE_BOOTSTRAP_LOG: fixture.logPath,
      REMOTE_BOOTSTRAP_TAMPER: options.tamper ?? '',
    },
  })
}

interface LifecycleFixtureOptions {
  activationFails?: boolean
  effectiveScenario?: 'autonomy' | 'lark' | 'supervised' | 'web'
  managedDependencies?: readonly string[]
  systemd?: LifecycleSystemdFixtureOptions
  thirdParty?: boolean
  thirdPartyDependency?: boolean
}

interface LifecycleSystemdUnitOptions {
  active: boolean
  enabled?: boolean
  dshHome?: string
  dropIn?: 'keyring' | 'unknown' | 'unsafe-keyring'
  fragment?: 'managed' | 'foreign'
  profile: string
  runtimeMasked?: boolean
}

interface LifecycleSystemdFixtureOptions {
  units?: readonly LifecycleSystemdUnitOptions[]
}

interface LifecycleRunOptions {
  activationMarker?: string
  canonicalCleanupFails?: boolean
  configAfterActivation?: string
  configAfterUpgrade?: string
  expectedScenario?: 'autonomy' | 'lark' | 'unsupported' | 'web'
  guardianDisconnectAfterStart?: boolean
  killLifecycleAfterOriginalRename?: boolean
  npmBlock?: boolean
  npmVersion?: string
  packageBlock?: boolean
  packageExternalStartProfile?: string
  packageFails?: boolean
  packageSymlinkRelative?: string
  packageSymlinkTarget?: string
  packageWriteRelative?: string
  processAncestorReference?: 'cwd' | 'fd'
  storeFails?: boolean
  systemdDropInMutation?: 'hash' | 'identity'
  systemdCrashBeforeStartProfile?: string
  systemdDynamicProfile?: string
  systemdGuardianListUnitFilesFailureBudget?: number
  systemdGuardianListUnitsFailureBudget?: number
  systemdGuardianOwnershipShowFailureBudget?: number
  systemdGuardianOwnershipShowFailsProfile?: string
  systemdJournal?: 'fail' | 'missing' | 'ready' | 'stale'
  systemdKillLifecycleDuringStartProfile?: string
  systemdPidStuckProfile?: string
  systemdProcPids?: readonly number[]
  systemdQuiescenceDriftProfile?: string
  systemdReadinessFailsProfile?: string
  systemdReplaceControlMaskOnUnmaskProfile?: string
  systemdRestartLoopProfile?: string
  systemdStartFailsProfile?: string
  systemdStopFailsProfile?: string
  systemdSupervisedProfile?: string
}

async function lifecycleFixture(options: LifecycleFixtureOptions = {}) {
  const root = await temporaryDshHome()
  const dshHome = join(root, 'home')
  const profileDirectory = join(dshHome, 'profiles', 'web')
  const fakeBin = join(root, 'bin')
  const fixtureInstallDirectory = join(root, 'install')
  const fixtureInstallerLibrary = join(fixtureInstallDirectory, 'common.sh')
  await mkdir(profileDirectory, { recursive: true })
  await mkdir(fakeBin)
  await mkdir(fixtureInstallDirectory)
  await writeFile(fixtureInstallerLibrary, await readFile(installerLibrary))
  await writeFile(join(fixtureInstallDirectory, 'lifecycle-config.mjs'),
    await readFile(join(installDirectory, 'lifecycle-config.mjs')))
  const lifecycleSource = await readFile(join(installDirectory, 'lifecycle-profile.mjs'), 'utf8')
  const trustCheck = "  const entry = await lstat(canonical)\n"
  const systemTrustFunction = "async function trustedSystemExecutable(path, name) {\n"
  const procLoop = "  const proc = await opendir('/proc')\n  for await (const entry of proc) {"
  const guardianReady = "  try {\n    const result = await operation()"
  const guardianCompletion = '  const completion = new Promise((resolveCompletion, rejectCompletion) => {\n'
  const originalRenamed = "    manifest = await writeManifest(physicalTransactionRoot, manifest, 'original-renamed')\n"
  const canonicalCleanup = 'async function removeCommittedTransaction({ physicalTransactionRoot, transactionRoot, manifest, backupHome }) {\n'
  expect(lifecycleSource).toContain(trustCheck)
  expect(lifecycleSource).toContain(systemTrustFunction)
  expect(lifecycleSource).toContain(procLoop)
  expect(lifecycleSource).toContain(guardianReady)
  expect(lifecycleSource).toContain(guardianCompletion)
  expect(lifecycleSource).toContain(originalRenamed)
  expect(lifecycleSource).toContain(canonicalCleanup)
  await writeFile(join(fixtureInstallDirectory, 'lifecycle-profile.mjs'), lifecycleSource.replace(
    trustCheck,
    trustCheck + `  if (process.env.DSH_ENHANCED_TEST_SERVICE_TOOLS === '1'\n`
      + `    && dirname(canonical) === ${JSON.stringify(fakeBin)}) return canonical\n`,
  ).replace(
    systemTrustFunction,
    systemTrustFunction + `  if (process.env.DSH_ENHANCED_TEST_SERVICE_TOOLS === '1') return await realpath(path)\n`,
  ).replace(
    procLoop,
    "  const procNames = (process.env.DSH_ENHANCED_TEST_PROC_PIDS ?? '').split(',').filter(Boolean)\n"
      + "  if (process.env.DSH_ENHANCED_TEST_INCLUDE_ANCESTORS === '1') procNames.push(...await processAncestorIds())\n"
      + "  const proc = [...new Set(procNames.map(String))].map(name => ({ name }))\n  for (const entry of proc) {",
  ).replace(
    guardianCompletion,
    "  if (process.env.DSH_ENHANCED_TEST_GUARDIAN_PID_FILE) await writeFile(process.env.DSH_ENHANCED_TEST_GUARDIAN_PID_FILE, String(guardian.pid))\n"
      + guardianCompletion,
  ).replace(
    guardianReady,
    "  if (process.env.DSH_ENHANCED_TEST_KILL_PARENT_AFTER_GUARDIAN_START === '1') process.kill(process.pid, 'SIGKILL')\n"
      + "  if (process.env.DSH_ENHANCED_TEST_DISCONNECT_GUARDIAN_AFTER_START === '1') { guardian.stdin.end(); await completion }\n"
      + guardianReady,
  ).replace(
    originalRenamed,
    originalRenamed
      + "    if (process.env.DSH_ENHANCED_TEST_KILL_AFTER_ORIGINAL_RENAME === '1') process.kill(process.pid, 'SIGKILL')\n",
  ).replace(
    canonicalCleanup,
    canonicalCleanup
      + "  if (process.env.DSH_ENHANCED_TEST_FAIL_CANONICAL_CLEANUP === '1') fail('injected canonical cleanup failure')\n",
  ))
  await writeFile(join(fixtureInstallDirectory, 'install-local.sh'),
    `#!/bin/bash\nset -euo pipefail\nsource ${JSON.stringify(fixtureInstallerLibrary)}\ndsh_enhanced_install local ${JSON.stringify(repoRoot)} "$@"\n`)
  await writeFile(join(fixtureInstallDirectory, 'install-npm.sh'),
    `#!/bin/bash\nset -euo pipefail\nsource ${JSON.stringify(fixtureInstallerLibrary)}\ndsh_enhanced_install npm '' "$@"\n`)
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
  const thirdParty = options.thirdParty ?? false
  const managedDependencies = options.managedDependencies ?? ['personal-assistant']
  const dependencies = Object.fromEntries(managedDependencies.map(name => [`@dsh-enhanced/${name}`, '0.1.0']))
  const managedBundles = managedDependencies.map(name => `@dsh-enhanced/${name}`)
  await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: {
      ...dependencies,
      ...(options.thirdPartyDependency ? { 'owner-library': '1.0.0' } : {}),
      ...(thirdParty ? { 'owner-plugin': '1.0.0' } : {}),
    },
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...managedBundles,
      ...(thirdParty ? ['owner-plugin'] : []),
    ] } },
  }, null, 2))
  await writeFile(join(profileDirectory, 'cordis.yml'), '[]\n')
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), '- id: owner-custom\n  config: { value: keep }\n')
  await writeFile(join(profileDirectory, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await writeFile(join(profileDirectory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const effectiveScenario = options.effectiveScenario ?? (options.systemd === undefined ? 'web' : 'lark')
  const effectiveRows = effectiveScenario === 'lark'
    ? [{
        id: 'dsh-enhanced-lark-channel',
        name: '@dsh-enhanced/lark-channel',
        config: { enabled: true },
      }]
    : effectiveScenario === 'supervised'
      ? [
          {
            id: 'dsh-enhanced-lark-channel',
            name: '@dsh-enhanced/lark-channel',
            config: { enabled: true },
          },
          { id: 'dsh-enhanced-assistant-recovery', name: '@dsh-enhanced/assistant-recovery' },
        ]
      : [
          { id: 'dsh-enhanced-assistant-web-owner', name: '@dsh-enhanced/assistant-web-owner' },
          ...(effectiveScenario === 'autonomy'
            ? [{ id: 'dsh-enhanced-assistant-isolation', name: '@dsh-enhanced/assistant-isolation' }]
            : []),
        ]
  await writeFile(join(dshHome, '.lifecycle-dump-config'), stringify(effectiveRows))
  await mkdir(join(dshHome, 'assistant-goals'), { recursive: true })
  const databasePath = join(dshHome, 'assistant-goals', 'web.sqlite')
  const database = new DatabaseSync(databasePath)
  database.exec("PRAGMA user_version = 1; CREATE TABLE goals (value TEXT NOT NULL); INSERT INTO goals VALUES ('durable-goal-state');")
  database.close()
  await mkdir(join(dshHome, 'sessions'), { recursive: true })
  await writeFile(join(dshHome, 'sessions', 'owner-session.jsonl'), 'durable-session')
  const dshLog = join(root, 'dsh.log')
  const bwrapLog = join(root, 'bwrap.log')
  const operationLog = join(root, 'lifecycle-operations.log')
  await writeFile(operationLog, '')
  const lifecycleTarget = join(root, 'managed-target')
  await mkdir(lifecycleTarget)
  await writeFile(join(lifecycleTarget, 'package.json'), JSON.stringify({
    name: `@dsh-enhanced/${managedDependencies[0] ?? 'personal-assistant'}`,
    version: '0.1.0',
  }))
  const activation = `"${process.execPath}" --input-type=module - "$DSH_HOME/assistant-goals/web.sqlite" <<'NODE'
import { DatabaseSync } from 'node:sqlite'
const database = new DatabaseSync(process.argv[2])
database.exec("PRAGMA user_version = 2; INSERT INTO goals VALUES ('migrated-during-activation');")
database.close()
NODE
if [[ -n "$LIFECYCLE_CONFIG_AFTER_ACTIVATION" ]]; then
  printf '%s\n' "$LIFECYCLE_CONFIG_AFTER_ACTIVATION" > "$DSH_HOME/.lifecycle-dump-config"
fi
${options.activationFails ? "printf 'activation failed\\n' >&2; exit 23" : "printf 'dsh web: http://127.0.0.1:43210\\n'; exit 0"}`
  await writeExecutable(join(fakeBin, 'dsh'), String.raw`#!/bin/bash
set -euo pipefail
{ printf 'CALL'; printf '\t%s' "$@"; printf '\n'; } >> "$LIFECYCLE_DSH_LOG"
if [[ " ${'$'}{1:-} " == ' --version ' ]]; then printf '0.1.2-rc.1\n'; exit 0; fi
if [[ " $* " == *' plugin '* && " $* " == *' add '* ]]; then
  transaction_state='absent'
  [[ -e "$LIFECYCLE_ORIGINAL_HOME.dsh-enhanced-transaction" ]] && transaction_state='present'
  printf 'dsh-add\t%s\toffline=%s\timport=%s\t%s\n' "$transaction_state" "${'$'}{npm_config_offline:-}" "${'$'}{npm_config_package_import_method:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "$LIFECYCLE_PACKAGE_FAILS" == '1' ]]; then printf 'package update failed\n' >&2; exit 42; fi
  if [[ "$LIFECYCLE_PACKAGE_BLOCK" == '1' ]]; then
    : > "$DSH_HOME/.package-preparation-started"
    while [[ ! -f "$DSH_HOME/.package-preparation-release" ]]; do sleep 0.05; done
  fi
  if [[ -n "$LIFECYCLE_PACKAGE_EXTERNAL_START_PROFILE" ]]; then
    systemctl --user start "dsh-profile-$LIFECYCLE_PACKAGE_EXTERNAL_START_PROFILE.service" || true
  fi
  if [[ -n "$LIFECYCLE_SYSTEMD_QUIESCENCE_DRIFT_PROFILE" ]]; then
    "${process.execPath}" --input-type=module - "$LIFECYCLE_SYSTEMD_STATE" "$LIFECYCLE_SYSTEMD_QUIESCENCE_DRIFT_PROFILE" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const unit = Object.values(state.units).find(value => value.profile === process.argv[3])
if (unit) { unit.activeState = 'active'; unit.subState = 'running'; unit.mainPid = 49999 }
writeFileSync(process.argv[2], JSON.stringify(state) + '\n')
NODE
  fi
  if [[ -n "$LIFECYCLE_CONFIG_AFTER_UPGRADE" ]]; then
    printf '%s\n' "$LIFECYCLE_CONFIG_AFTER_UPGRADE" > "$DSH_HOME/.lifecycle-dump-config"
  fi
  if [[ -n "$LIFECYCLE_PACKAGE_WRITE_RELATIVE" ]]; then
    printf 'outside-write\n' > "$DSH_HOME/$LIFECYCLE_PACKAGE_WRITE_RELATIVE"
  fi
  if [[ -n "$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE" ]]; then
    mkdir -p "$(dirname "$DSH_HOME/$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE")"
    rm -f -- "$DSH_HOME/$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE"
    ln -s -- "$LIFECYCLE_PACKAGE_SYMLINK_TARGET" "$DSH_HOME/$LIFECYCLE_PACKAGE_SYMLINK_RELATIVE"
  fi
  printf 'upgraded\n' > "$DSH_HOME/profiles/web/upgraded"
  exit 0
fi
if [[ " $* " == *' plugin '* && " $* " == *' list '* ]]; then
  mkdir -p "$DSH_HOME/profiles/web"
  printf '%s\n' '{"name":"dsh-profile-web","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > "$DSH_HOME/profiles/web/package.json"
  printf '%s\n' '[]' > "$DSH_HOME/profiles/web/cordis.yml"
  printf '%s\n' '[]' > "$DSH_HOME/profiles/web/cordis.patch.yml"
  printf '%s\n' '[]' > "$DSH_HOME/.lifecycle-dump-config"
  exit 0
fi
if [[ " $* " == *' --dump-config '* ]]; then
  requested_profile=''
  for ((index = 1; index <= $#; index += 1)); do
    if [[ "${'$'}{!index}" == '--profile' ]]; then next=$((index + 1)); requested_profile="${'$'}{!next}"; break; fi
  done
  if [[ -n "$LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE" && "$requested_profile" == "$LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE" ]]; then
    printf '%s\n' "- id: dsh-enhanced-assistant-recovery" "  name: '@dsh-enhanced/assistant-recovery'"
  elif [[ -d "$DSH_HOME/uninstalled-profiles" ]] \
    && [[ -f "$DSH_HOME/profiles/$requested_profile/package.json" ]] \
    && ! grep -q '"@dsh-enhanced/' "$DSH_HOME/profiles/$requested_profile/package.json"; then
    printf '[]\n'
  elif [[ -f "$DSH_HOME/.lifecycle-dump-config" ]]; then cat "$DSH_HOME/.lifecycle-dump-config"; else printf '[]\n'; fi
  exit 0
fi
if [[ " $* " == *' --host 127.0.0.1 --no-open --port 0 '* ]]; then
  : > "$LIFECYCLE_ACTIVATION_MARKER"
  __ACTIVATION__
fi
exit 2
`.replace('__ACTIVATION__', activation))
  await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
set -euo pipefail
if [[ " \${1:-} " == ' view ' && " \${3:-} " == ' version ' && " \${4:-} " == ' --json ' ]]; then
  transaction_state='absent'
  [[ -e "$LIFECYCLE_ORIGINAL_HOME.dsh-enhanced-transaction" ]] && transaction_state='present'
  printf 'npm-view\t%s\t%s\n' "$transaction_state" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "$LIFECYCLE_NPM_BLOCK" == '1' ]]; then
    : > "$LIFECYCLE_NPM_BLOCK_STARTED"
    while [[ ! -f "$LIFECYCLE_NPM_BLOCK_RELEASE" ]]; do sleep 0.05; done
  fi
  printf '"%s"\n' "$LIFECYCLE_NPM_VERSION"
  exit 0
fi
printf 'unexpected fake npm invocation: %s\n' "$*" >&2
exit 91
`)
  await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
set -euo pipefail
if [[ " \${1:-} " == ' --version ' ]]; then printf '10.0.0\n'; exit 0; fi
if [[ " \${1:-} \${2:-} " == ' store add ' ]]; then
  transaction_state='absent'
  [[ -e "$LIFECYCLE_ORIGINAL_HOME.dsh-enhanced-transaction" ]] && transaction_state='present'
  printf 'pnpm-store-add\t%s\tignore=%s\t%s\n' "$transaction_state" "${'$'}{npm_config_ignore_scripts:-}" "$*" >> "$LIFECYCLE_OPERATION_LOG"
  if [[ "$LIFECYCLE_STORE_FAILS" == '1' ]]; then printf 'store prefetch failed\n' >&2; exit 93; fi
  exit 0
fi
printf 'unexpected fake pnpm invocation: %s\n' "$*" >&2
exit 92
`)
  const systemdHome = join(root, 'systemd-home')
  const systemdState = join(root, 'systemd-state.json')
  const systemdLog = join(root, 'systemd.log')
  const journalLog = join(root, 'journal.log')
  if (options.systemd !== undefined) {
    const unitDirectory = join(systemdHome, '.config', 'systemd', 'user')
    await mkdir(unitDirectory, { recursive: true, mode: 0o700 })
    const wantsDirectory = join(unitDirectory, 'default.target.wants')
    await mkdir(wantsDirectory, { mode: 0o700 })
    const configuredUnits = options.systemd.units ?? [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ]
    const units: Record<string, {
      activeState: string
      controlPid: number
      dropIns: string[]
      fragmentPath: string
      invocationId: string
      mainPid: number
      nRestarts: number
      pathEnvironment: string
      profile: string
      serviceHome: string
      starts: number
      subState: string
      unitFileState: string
      unitFileStateBeforeMask?: string
    }> = {}
    for (const configured of configuredUnits) {
      const serviceHome = configured.dshHome === '__other__' ? join(root, 'other-home') : configured.dshHome ?? dshHome
      const serviceProfileDirectory = join(serviceHome, 'profiles', configured.profile)
      await mkdir(serviceProfileDirectory, { recursive: true, mode: 0o700 })
      const paths = systemdServicePaths({ home: systemdHome, dshHome: serviceHome, profile: configured.profile })
      const source = configured.fragment === 'foreign'
        ? `[Service]\nEnvironment=DSH_HOME=${serviceHome}\nExecStart=/usr/bin/false\n`
        : createSystemdUserUnit({
          ...paths,
          dshHome: serviceHome,
          profile: configured.profile,
          profileDirectory: serviceProfileDirectory,
          nodePath: process.execPath,
          dshPath: join(fakeBin, 'dsh'),
          path: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin`,
        })
      await writeFile(paths.unitPath, source, { mode: 0o600 })
      if (!configured.runtimeMasked && configured.enabled !== false) {
        await symlink(paths.unitPath, join(wantsDirectory, paths.unitName))
      }
      const dropIns: string[] = []
      if (configured.dropIn !== undefined) {
        const dropInDirectory = `${paths.unitPath}.d`
        await mkdir(dropInDirectory, { mode: 0o700 })
        const knownKeyring = configured.dropIn === 'keyring' || configured.dropIn === 'unsafe-keyring'
        const dropIn = join(dropInDirectory, knownKeyring ? 'keyring.conf' : 'owner.conf')
        await writeFile(dropIn, knownKeyring
          ? '[Unit]\nRequires=gnome-keyring-daemon.service\nAfter=gnome-keyring-daemon.service\n'
          : '[Service]\nEnvironment=OWNER_OVERRIDE=1\n', { mode: configured.dropIn === 'unsafe-keyring' ? 0o666 : 0o600 })
        if (configured.dropIn === 'unsafe-keyring') await chmod(dropIn, 0o666)
        dropIns.push(dropIn)
      }
      const unit = paths.unitName
      units[unit] = {
        activeState: configured.active ? 'active' : 'inactive',
        controlPid: 0,
        dropIns,
        fragmentPath: paths.unitPath,
        invocationId: configured.active ? `original-${configured.profile}` : '',
        mainPid: configured.active ? 20_000 + Object.keys(units).length : 0,
        nRestarts: 0,
        pathEnvironment: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin`,
        profile: configured.profile,
        serviceHome,
        starts: 0,
        subState: configured.active ? 'running' : 'dead',
        unitFileState: configured.runtimeMasked ? 'masked-runtime' : configured.enabled === false ? 'disabled' : 'enabled',
        unitFileStateBeforeMask: 'enabled',
      }
    }
    await writeFile(systemdState, `${JSON.stringify({ controls: {}, nextPid: 30_000, units }, null, 2)}\n`, { mode: 0o600 })
    await writeFile(systemdLog, '')
    await writeFile(journalLog, '')
  }
  await writeExecutable(join(fakeBin, 'systemctl'), `#!${process.execPath}
const { appendFileSync, existsSync, lstatSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const logPath = ${JSON.stringify(systemdLog)}
const statePath = ${JSON.stringify(systemdState)}
const controlRoot = ${JSON.stringify(join(systemdHome, '.config', 'systemd', 'user.control'))}
const journalExecutable = ${JSON.stringify(join(fakeBin, 'journalctl'))}
const dshExecutable = ${JSON.stringify(join(fakeBin, 'dsh'))}
appendFileSync(logPath, JSON.stringify(args) + '\\n')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const persist = () => writeFileSync(statePath, JSON.stringify(state) + '\\n')
if (state.firstCommandHomeExists === undefined) {
  state.firstCommandHomeExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME)
  state.firstCommandBackupExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME + '.dsh-enhanced-transaction/original-home')
  state.firstCommandTransactionExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME + '.dsh-enhanced-transaction')
  persist()
}
if (state.firstCommandHomeExists === undefined) {
  state.firstCommandHomeExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME)
  state.firstCommandBackupExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME + '.dsh-enhanced-transaction/original-home')
  persist()
}
if (args[0] !== '--user') process.exit(90)
if (args[1] === 'list-unit-files') {
  if (state.controls.guardianListUnitFilesFailuresRemaining > 0
    && Object.values(state.units).some(unit => unit.starts > 0)) {
    state.controls.guardianListUnitFilesFailuresRemaining -= 1
    persist()
    process.exit(7)
  }
  for (const [name, unit] of Object.entries(state.units)) process.stdout.write(name + ' ' + unit.unitFileState + ' enabled\\n')
  process.exit(0)
}
if (args[1] === 'list-units') {
  if (state.controls.guardianListUnitsFailuresRemaining > 0
    && Object.values(state.units).some(unit => unit.starts > 0)) {
    state.controls.guardianListUnitsFailuresRemaining -= 1
    persist()
    process.exit(7)
  }
  for (const [name, unit] of Object.entries(state.units)) {
    process.stdout.write(name + ' loaded ' + unit.activeState + ' ' + unit.subState + ' DSH profile ' + unit.profile + '\\n')
  }
  process.exit(0)
}
if (args[1] === 'daemon-reload') {
  for (const [name, unit] of Object.entries(state.units)) {
    if (unit.unitFileState === 'masked-runtime') continue
    const wants = process.env.HOME + '/.config/systemd/user/default.target.wants/' + name
    unit.unitFileState = existsSync(wants) ? 'enabled' : 'disabled'
  }
  persist()
  const profile = state.controls.replaceControlMaskOnUnmaskProfile
  const started = Object.values(state.units).some(unit => unit.starts > 0)
  if (profile && started && !state.controls.controlMaskReplaced) {
    const name = 'dsh-profile-' + profile + '.service'
    const maskPath = controlRoot + '/' + name
    try { renameSync(maskPath, maskPath + '.superseded') } catch {}
    symlinkSync('/dev/null', maskPath)
    const replacement = lstatSync(maskPath)
    state.units[name].replacementMaskIdentity = { dev: String(replacement.dev), ino: String(replacement.ino) }
    state.controls.controlMaskReplaced = true
    persist()
  }
  process.exit(0)
}
if (args[1] === 'show') {
  const unit = state.units[args[2]]
  if (!unit) process.exit(4)
  if (state.controls.guardianOwnershipShowFailsProfile === unit.profile && unit.starts > 0
    && args.includes('--property=Environment') && args.includes('--property=WorkingDirectory')
    && state.controls.guardianOwnershipShowFailuresRemaining > 0) {
    state.controls.guardianOwnershipShowFailuresRemaining -= 1
    persist()
    process.exit(7)
  }
  const controlMaskPath = controlRoot + '/' + args[2]
  const lifecycleGuardPath = controlRoot + '/' + args[2] + '.d/dsh-enhanced-lifecycle.conf'
  let controlMasked = false
  try { controlMasked = lstatSync(controlMaskPath).isSymbolicLink() } catch {}
  const dropIns = [...unit.dropIns]
  try { if (lstatSync(lifecycleGuardPath).isFile()) dropIns.unshift(lifecycleGuardPath) } catch {}
  if (state.controls.restartLoopProfile === unit.profile && unit.starts > 0 && unit.activeState === 'active') {
    unit.nRestarts += 1
    unit.invocationId = 'loop-' + unit.profile + '-' + unit.nRestarts
    unit.mainPid += 1
    persist()
  }
  const properties = [
    ['Id', args[2]],
    ['LoadState', controlMasked || unit.unitFileState === 'masked-runtime' ? 'masked' : 'loaded'],
    ['FragmentPath', unit.fragmentPath],
    ['DropInPaths', dropIns.join(' ')],
    ['ActiveState', unit.activeState],
    ['SubState', unit.subState],
    ['MainPID', unit.mainPid],
    ['ControlPID', unit.controlPid],
    ['InvocationID', unit.invocationId],
    ['NRestarts', unit.nRestarts],
    ['UnitFileState', controlMasked ? 'masked' : unit.unitFileState],
    ['WorkingDirectory', unit.serviceHome + '/profiles/' + unit.profile],
    ['Environment', 'DSH_HOME=' + unit.serviceHome + ' PATH=' + unit.pathEnvironment
      + ' DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/' + process.getuid() + '/bus'
      + ' XDG_RUNTIME_DIR=/run/user/' + process.getuid()],
    ['ExecStart', '{ path=' + process.execPath + ' ; argv[]=' + process.execPath + ' '
      + '--disable-warning=ExperimentalWarning ' + dshExecutable + ' --profile ' + unit.profile + ' --no-open ; ignore_errors=no ; }'],
  ]
  const requested = new Set(args.filter(value => value.startsWith('--property='))
    .map(value => value.slice('--property='.length)))
  process.stdout.write(properties
    .filter(([name]) => requested.size === 0 || requested.has(name))
    .map(([name, value]) => name + '=' + value).join('\\n') + '\\n')
  process.exit(0)
}
if (args[1] === 'mask' && args[2] === '--runtime') {
  for (const name of args.slice(3)) {
    const unit = state.units[name]
    if (!unit) continue
    if (unit.unitFileState !== 'masked-runtime') unit.unitFileStateBeforeMask = unit.unitFileState
    unit.unitFileState = 'masked-runtime'
  }
  persist()
  process.exit(0)
}
if (args[1] === 'unmask' && args[2] === '--runtime') {
  for (const name of args.slice(3)) {
    const unit = state.units[name]
    if (!unit) continue
    unit.unitFileState = unit.unitFileStateBeforeMask ?? 'enabled'
    if (state.controls.replaceControlMaskOnUnmaskProfile === unit.profile) {
      const maskPath = controlRoot + '/' + name
      renameSync(maskPath, maskPath + '.superseded')
      symlinkSync('/dev/null', maskPath)
      const replacement = lstatSync(maskPath)
      unit.replacementMaskIdentity = { dev: String(replacement.dev), ino: String(replacement.ino) }
    }
  }
  persist()
  process.exit(0)
}
if (args[1] === 'disable' || args[1] === 'enable') {
  for (const name of args.slice(2)) {
    const unit = state.units[name]
    if (unit) unit.unitFileState = args[1] === 'disable' ? 'disabled' : 'enabled'
  }
  persist()
  process.exit(0)
}
if (args[1] === 'stop') {
  if (state.stopLegacyMarkerExists === undefined) {
    state.stopLegacyMarkerExists = existsSync(process.env.LIFECYCLE_ORIGINAL_HOME
      + '.dsh-enhanced-transaction/legacy-v1-marker')
  }
  for (const name of args.slice(2)) {
    const unit = state.units[name]
    if (!unit) continue
    const maskPath = process.env.HOME + '/.config/systemd/user.control/' + name
    try { unit.maskPresentWhenStopped = lstatSync(maskPath).isSymbolicLink() } catch { unit.maskPresentWhenStopped = false }
    state.stopObservations = [...(state.stopObservations ?? []), {
      unit: name, maskPresent: unit.maskPresentWhenStopped, unitFileState: unit.unitFileState,
    }]
    if (state.controls.stopFailsProfile === unit.profile) { persist(); process.exit(5) }
    unit.activeState = 'inactive'
    unit.subState = 'dead'
    if (state.controls.pidStuckProfile !== unit.profile) unit.mainPid = 0
  }
  persist()
  const mutation = state.controls.dropInMutation
  if (mutation) {
    const dropIn = Object.values(state.units).flatMap(unit => unit.dropIns)[0]
    if (dropIn) {
      if (mutation === 'identity') { writeFileSync(dropIn + '.replacement', '[Unit]\\nAfter=changed.service\\n'); renameSync(dropIn + '.replacement', dropIn) }
      else appendFileSync(dropIn, '# changed\\n')
    }
  }
  if (state.controls.journal === 'missing') unlinkSync(journalExecutable)
  process.exit(0)
}
if (args[1] === 'start' || args[1] === 'restart') {
  const starting = args.slice(2).map(name => state.units[name]).filter(Boolean)
  if (!state.controls.crashTriggered
    && starting.some(unit => state.controls.crashBeforeStartProfile === unit.profile)) {
    state.controls.crashTriggered = true
    persist()
    process.kill(process.ppid, 'SIGKILL')
    process.exit(99)
  }
  for (const name of args.slice(2)) {
    const unit = state.units[name]
    if (!unit) continue
    try { if (lstatSync(controlRoot + '/' + name).isSymbolicLink()) process.exit(8) } catch {}
    if (unit.unitFileState === 'masked-runtime') process.exit(8)
    if (state.controls.startFailsProfile === unit.profile) { persist(); process.exit(6) }
    unit.starts += 1
    if (state.controls.readinessFailsProfile === unit.profile) {
      unit.activeState = 'failed'; unit.subState = 'failed'; unit.mainPid = 0
    } else {
      state.nextPid += 1
      unit.activeState = 'active'; unit.subState = 'running'; unit.mainPid = state.nextPid
      unit.invocationId = 'fresh-' + unit.profile + '-' + state.nextPid
    }
    if (!state.controls.lifecycleParentKilled
      && state.controls.killLifecycleDuringStartProfile === unit.profile) {
      let lifecyclePid = process.ppid
      for (let depth = 0; depth < 8 && lifecyclePid > 1; depth += 1) {
        const command = readFileSync('/proc/' + lifecyclePid + '/cmdline', 'utf8')
        if (command.includes('lifecycle-profile.mjs')) break
        const parentLine = readFileSync('/proc/' + lifecyclePid + '/status', 'utf8')
          .split(String.fromCharCode(10)).find(line => line.startsWith('PPid:'))
        lifecyclePid = Number(parentLine?.trim().split(' ').filter(Boolean)[1])
      }
      state.controls.lifecycleParentKilled = true
      state.controls.killedLifecyclePid = lifecyclePid
      persist()
      if (Number.isSafeInteger(lifecyclePid) && lifecyclePid > 1) process.kill(lifecyclePid, 'SIGKILL')
    }
  }
  if (state.controls.dynamicProfile && !state.controls.dynamicAdded) {
    const source = starting[0]
    const profile = state.controls.dynamicProfile
    const name = 'dsh-profile-' + profile + '.service'
    const fragmentPath = source.fragmentPath.replace(source.unit ?? args[2], name)
    writeFileSync(fragmentPath, readFileSync(source.fragmentPath, 'utf8').replaceAll(source.profile, profile))
    state.units[name] = {
      ...source, profile, activeState: 'active', subState: 'running', mainPid: ++state.nextPid,
      invocationId: 'dynamic-' + profile + '-' + state.nextPid, starts: 1,
      fragmentPath, unitFileState: 'enabled', unitFileStateBeforeMask: 'enabled', dropIns: [],
    }
    state.controls.dynamicAdded = true
  }
  persist()
  process.exit(0)
}
process.exit(91)
`)
  await writeExecutable(join(fakeBin, 'journalctl'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
const state = require(${JSON.stringify(systemdState)})
appendFileSync(${JSON.stringify(journalLog)}, JSON.stringify(args) + '\\n')
if (state.controls.journal === 'fail') process.exit(7)
const invocation = args.find(value => value.startsWith('_SYSTEMD_INVOCATION_ID='))?.slice('_SYSTEMD_INVOCATION_ID='.length)
if (state.controls.journal !== 'stale' && invocation?.startsWith('fresh-')) {
  process.stdout.write('dsh web: http://127.0.0.1:43210\\n')
} else {
  process.stdout.write('old invocation did not become ready\\n')
}
`)
  await writeExecutable(join(fakeBin, 'bwrap'), `#!${process.execPath}
const { appendFileSync, realpathSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const environment = {}
const controls = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LIFECYCLE_')))
let stageHome
let logicalHome
let validatorFd
let validatorPath
let validatorMode
for (let index = 0; index < separator; index += 1) {
  if (args[index] === '--setenv') { environment[args[index + 1]] = args[index + 2]; index += 2; continue }
  if (args[index] === '--bind') { stageHome = args[index + 1]; logicalHome = args[index + 2]; index += 2; continue }
  if (args[index] === '--bind-fd') { stageHome = realpathSync('/proc/self/fd/' + args[index + 1]); logicalHome = args[index + 2]; index += 2; continue }
  if (args[index] === '--perms') { validatorMode = args[index + 1]; index += 1; continue }
  if (args[index] === '--ro-bind-data') { validatorFd = args[index + 1]; validatorPath = args[index + 2]; index += 2; continue }
  if (args[index] === '--ro-bind') { index += 2; continue }
  if (args[index] === '--tmpfs' || args[index] === '--proc' || args[index] === '--dev') { index += 1 }
}
if (controls.LIFECYCLE_BWRAP_LOG) appendFileSync(controls.LIFECYCLE_BWRAP_LOG, JSON.stringify(args) + '\\n')
if (separator < 0 || !args.includes('--unshare-all') || args.includes('--share-net') || !stageHome || !logicalHome
  || validatorMode !== '0400' || validatorFd !== '4' || validatorPath !== '/run/dsh-enhanced-lifecycle-config.mjs') {
  process.stderr.write('fake bwrap rejected unsafe or incomplete sandbox arguments: ' + JSON.stringify({ separator, stageHome, logicalHome, validatorMode, validatorFd, validatorPath }) + '\\n')
  process.exit(97)
}
for (const [key, value] of Object.entries(environment)) {
  if (value === logicalHome || value.startsWith(logicalHome + '/')) environment[key] = stageHome + value.slice(logicalHome.length)
}
Object.assign(environment, controls)
for (const key of ['LIFECYCLE_ACTIVATION_MARKER']) {
  const value = environment[key]
  if (value === logicalHome || value.startsWith(logicalHome + '/')) environment[key] = stageHome + value.slice(logicalHome.length)
}
const command = args.slice(separator + 1)
let validatorCommand = false
for (let index = 0; index < command.length; index += 1) {
  const value = command[index]
  if (value === logicalHome || value.startsWith(logicalHome + '/')) command[index] = stageHome + value.slice(logicalHome.length)
  else if (value === validatorPath) { command[index] = '/proc/self/fd/' + validatorFd; validatorCommand = true }
}
if (validatorCommand) command.splice(1, 0, '--preserve-symlinks-main')
const result = spawnSync(command[0], command.slice(1), {
  env: environment, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe', 3, 4],
})
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) { process.stderr.write(String(result.error) + '\\n'); process.exit(98) }
process.exit(result.status ?? 99)
`)
  return {
    root, dshHome, profileDirectory, fakeBin, databasePath, dshLog, bwrapLog, operationLog, lifecycleTarget,
    activationMarker: join(dshHome, '.activation-ran'),
    fixtureInstallDirectory, fixtureInstallerLibrary, journalLog, systemdHome, systemdLog, systemdState,
  }
}

function lifecycleEnvironment(dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
  return {
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`, DSH_HOME: dshHome, NODE_ENV: 'test',
    DSH_ENHANCED_TEST_SERVICE_TOOLS: '1',
    LIFECYCLE_ACTIVATION_MARKER: options.activationMarker ?? join(dshHome, '.activation-ran'),
    LIFECYCLE_BWRAP_LOG: join(dirname(dshHome), 'bwrap.log'),
    LIFECYCLE_CONFIG_AFTER_ACTIVATION: options.configAfterActivation ?? '',
    LIFECYCLE_CONFIG_AFTER_UPGRADE: options.configAfterUpgrade ?? '',
    LIFECYCLE_DSH_LOG: join(dirname(dshHome), 'dsh.log'),
    LIFECYCLE_DSH_EXECUTABLE: join(fakeBin, 'dsh'),
    LIFECYCLE_NPM_BLOCK: options.npmBlock ? '1' : '0',
    LIFECYCLE_NPM_BLOCK_RELEASE: join(dirname(dshHome), 'npm-block-release'),
    LIFECYCLE_NPM_BLOCK_STARTED: join(dirname(dshHome), 'npm-block-started'),
    LIFECYCLE_NPM_VERSION: options.npmVersion ?? '1.4.0',
    LIFECYCLE_OPERATION_LOG: join(dirname(dshHome), 'lifecycle-operations.log'),
    LIFECYCLE_ORIGINAL_HOME: dshHome,
    LIFECYCLE_PACKAGE_FAILS: options.packageFails ? '1' : '0',
    LIFECYCLE_PACKAGE_EXTERNAL_START_PROFILE: options.packageExternalStartProfile ?? '',
    LIFECYCLE_PACKAGE_BLOCK: options.packageBlock ? '1' : '0',
    LIFECYCLE_PACKAGE_SYMLINK_RELATIVE: options.packageSymlinkRelative ?? '',
    LIFECYCLE_PACKAGE_SYMLINK_TARGET: options.packageSymlinkTarget ?? '',
    LIFECYCLE_PACKAGE_WRITE_RELATIVE: options.packageWriteRelative ?? '',
    LIFECYCLE_STORE_FAILS: options.storeFails ? '1' : '0',
    LIFECYCLE_SYSTEMD_CRASH_BEFORE_START_PROFILE: options.systemdCrashBeforeStartProfile ?? '',
    LIFECYCLE_SYSTEMD_DROPIN_MUTATION: options.systemdDropInMutation ?? '',
    LIFECYCLE_SYSTEMD_DYNAMIC_PROFILE: options.systemdDynamicProfile ?? '',
    LIFECYCLE_JOURNAL_LOG: join(dirname(dshHome), 'journal.log'),
    LIFECYCLE_JOURNAL_EXECUTABLE: join(fakeBin, 'journalctl'),
    LIFECYCLE_SYSTEMD_JOURNAL: options.systemdJournal ?? 'ready',
    LIFECYCLE_SYSTEMD_KILL_LIFECYCLE_DURING_START_PROFILE: options.systemdKillLifecycleDuringStartProfile ?? '',
    DSH_ENHANCED_TEST_DISCONNECT_GUARDIAN_AFTER_START: options.guardianDisconnectAfterStart ? '1' : '',
    DSH_ENHANCED_TEST_GUARDIAN_PID_FILE: join(dirname(dshHome), 'guardian.pid'),
    DSH_ENHANCED_TEST_FAIL_CANONICAL_CLEANUP: options.canonicalCleanupFails ? '1' : '',
    DSH_ENHANCED_TEST_KILL_PARENT_AFTER_GUARDIAN_START: options.systemdKillLifecycleDuringStartProfile === undefined ? '' : '1',
    DSH_ENHANCED_TEST_KILL_AFTER_ORIGINAL_RENAME: options.killLifecycleAfterOriginalRename ? '1' : '',
    LIFECYCLE_SYSTEMD_LOG: join(dirname(dshHome), 'systemd.log'),
    LIFECYCLE_SYSTEMD_PID_STUCK_PROFILE: options.systemdPidStuckProfile ?? '',
    DSH_ENHANCED_TEST_PROC_PIDS: options.systemdProcPids?.join(',') ?? '',
    DSH_ENHANCED_TEST_INCLUDE_ANCESTORS: options.processAncestorReference === undefined ? '' : '1',
    LIFECYCLE_SYSTEMD_QUIESCENCE_DRIFT_PROFILE: options.systemdQuiescenceDriftProfile ?? '',
    LIFECYCLE_SYSTEMD_READINESS_FAILS_PROFILE: options.systemdReadinessFailsProfile ?? '',
    LIFECYCLE_SYSTEMD_REPLACE_CONTROL_MASK_ON_UNMASK_PROFILE: options.systemdReplaceControlMaskOnUnmaskProfile ?? '',
    LIFECYCLE_SYSTEMD_RESTART_LOOP_PROFILE: options.systemdRestartLoopProfile ?? '',
    LIFECYCLE_SYSTEMD_START_FAILS_PROFILE: options.systemdStartFailsProfile ?? '',
    LIFECYCLE_SYSTEMD_STATE: join(dirname(dshHome), 'systemd-state.json'),
    LIFECYCLE_SYSTEMD_STOP_FAILS_PROFILE: options.systemdStopFailsProfile ?? '',
    LIFECYCLE_SYSTEMD_SUPERVISED_PROFILE: options.systemdSupervisedProfile ?? '',
    DSH_ENHANCED_SERVICE_READY_TIMEOUT_MS: '1000',
    DSH_ENHANCED_SERVICE_STABILITY_MS: '0',
    DSH_ENHANCED_SERVICE_STOP_TIMEOUT_MS: '1000',
    HOME: join(dirname(dshHome), 'systemd-home'),
  }
}

function runLifecycle(args: readonly string[], dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
  const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
  const [operation, profile, homePath, dryRun, ...targets] = args
  return spawnSync('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_profile_lifecycle "$@"',
    'lifecycle-test', lifecycleInstallerLibrary, operation!, profile!, homePath!, dryRun!,
    options.expectedScenario ?? 'web', ...targets], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: lifecycleEnvironment(dshHome, fakeBin, options),
  })
}

function runServiceLifecycle(
  args: readonly string[],
  dshHome: string,
  fakeBin: string,
  options: LifecycleRunOptions = {},
) {
  const [profile, homePath, _dryRun, ...targets] = args
  const statePath = join(dirname(dshHome), 'systemd-state.json')
  const serviceInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
  setLifecycleSystemdControls(statePath, options)
  return spawnSync('/bin/bash', [
    '-c', `${options.processAncestorReference === 'fd' ? 'exec 9<"$DSH_HOME"; ' : ''}source "$1"; shift; dsh_enhanced_run_lifecycle_executor service-upgrade "$@"`,
    'service-lifecycle-test', serviceInstallerLibrary, profile!, homePath!, options.expectedScenario ?? 'lark', ...targets,
  ], {
    cwd: options.processAncestorReference === 'cwd' ? dshHome : repoRoot,
    encoding: 'utf8',
    env: lifecycleEnvironment(dshHome, fakeBin, options),
  })
}

function startServiceLifecycle(
  args: readonly string[],
  dshHome: string,
  fakeBin: string,
  options: LifecycleRunOptions = {},
) {
  const [profile, homePath, _dryRun, ...targets] = args
  const statePath = join(dirname(dshHome), 'systemd-state.json')
  const serviceInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
  setLifecycleSystemdControls(statePath, options)
  const child = spawn('/bin/bash', [
    '-c', 'source "$1"; shift; dsh_enhanced_run_lifecycle_executor service-upgrade "$@"',
    'service-lifecycle-test', serviceInstallerLibrary, profile!, homePath!, options.expectedScenario ?? 'lark', ...targets,
  ], {
    cwd: repoRoot, detached: true, env: lifecycleEnvironment(dshHome, fakeBin, options),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return {
    child,
    done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
      child.once('close', status => resolveDone({ status, stdout, stderr }))
    }),
  }
}

function startInstaller(
  script: string,
  args: readonly string[],
  dshHome: string,
  fakeBin: string,
  options: LifecycleRunOptions = {},
) {
  const fixtureScript = join(dirname(dshHome), 'install', basename(script))
  const child = spawn('/bin/bash', [existsSync(fixtureScript) ? fixtureScript : script, ...args], {
    cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin, options),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return {
    child,
    done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
      child.once('close', status => resolveDone({ status, stdout, stderr }))
    }),
  }
}

function startLifecycle(args: readonly string[], dshHome: string, fakeBin: string, options: LifecycleRunOptions = {}) {
  const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
  const [operation, profile, homePath, dryRun, ...targets] = args
  const child = spawn('/bin/bash', ['-c', 'source "$1"; shift; dsh_enhanced_profile_lifecycle "$@"',
    'lifecycle-test', lifecycleInstallerLibrary, operation!, profile!, homePath!, dryRun!,
    options.expectedScenario ?? 'web', ...targets], {
    cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin, options),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return { child,
    done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
      child.once('close', status => resolveDone({ status, stdout, stderr }))
    }),
  }
}

function runRecovery(profile: string, dshHome: string, fakeBin: string) {
  const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
  return spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_recover_profile_lifecycle "$2" "$3" 0',
    'recovery-test', lifecycleInstallerLibrary, profile, dshHome], {
    cwd: repoRoot, encoding: 'utf8', env: lifecycleEnvironment(dshHome, fakeBin),
  })
}

function startRecovery(profile: string, dshHome: string, fakeBin: string) {
  const lifecycleInstallerLibrary = join(dirname(dshHome), 'install', 'common.sh')
  const child = spawn('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_recover_profile_lifecycle "$2" "$3" 0',
    'recovery-test', lifecycleInstallerLibrary, profile, dshHome], {
    cwd: repoRoot, env: lifecycleEnvironment(dshHome, fakeBin),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return {
    child,
    done: new Promise<{ status: number | null; stdout: string; stderr: string }>(resolveDone => {
      child.once('close', status => resolveDone({ status, stdout, stderr }))
    }),
  }
}

async function holdExternalLifecycleLock(path: string) {
  const child = spawn('/usr/bin/python3', ['-c', [
    'import fcntl, os, sys',
    'handle = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)',
    'fcntl.flock(handle, fcntl.LOCK_EX)',
    'sys.stdout.write("LOCKED\\n")',
    'sys.stdout.flush()',
    'sys.stdin.buffer.read()',
  ].join('\n'), path], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`external lock did not become ready: ${stderr}`)), 5_000)
    const inspect = () => {
      if (!stdout.includes('LOCKED\n')) return
      clearTimeout(timeout)
      child.stdout.off('data', inspect)
      resolveReady()
    }
    child.stdout.on('data', inspect)
    child.once('exit', status => {
      if (!stdout.includes('LOCKED\n')) {
        clearTimeout(timeout)
        rejectReady(new Error(`external lock exited with ${status}: ${stderr}`))
      }
    })
  })
  return {
    async release() {
      child.stdin.end()
      await new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
    },
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(path)
      return
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function readLifecycleDatabase(path: string) {
  const database = new DatabaseSync(path, { readOnly: true })
  const userVersion = database.prepare('PRAGMA user_version').get() as { user_version: number }
  const values = database.prepare('SELECT value FROM goals ORDER BY rowid').all() as Array<{ value: string }>
  database.close()
  return { userVersion: userVersion.user_version, values: values.map(({ value }) => value) }
}

async function preservedLifecycleTransactions(dshHome: string): Promise<string[]> {
  const parent = dirname(dshHome)
  const prefix = `${basename(dshHome)}.dsh-enhanced-transaction`
  return (await readdir(parent))
    .filter(name => name === prefix || name.startsWith(`${prefix}.`))
    .map(name => join(parent, name))
    .sort()
}

async function readJsonLines(path: string): Promise<unknown[][]> {
  const source = await readFile(path, 'utf8')
  return source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown[])
}

interface LifecycleSystemdState {
  controls: {
    crashBeforeStartProfile?: string
    crashTriggered?: boolean
    controlMaskReplaced?: boolean
    dynamicAdded?: boolean
    dynamicProfile?: string
    dropInMutation?: 'hash' | 'identity'
    guardianListUnitFilesFailuresRemaining?: number
    guardianListUnitsFailuresRemaining?: number
    guardianOwnershipShowFailuresRemaining?: number
    guardianOwnershipShowFailsProfile?: string
    journal?: 'fail' | 'missing' | 'ready' | 'stale'
    pidStuckProfile?: string
    quiescenceDriftProfile?: string
    readinessFailsProfile?: string
    replaceControlMaskOnUnmaskProfile?: string
    restartLoopProfile?: string
    startFailsProfile?: string
    stopFailsProfile?: string
  }
  firstCommandBackupExists?: boolean
  firstCommandHomeExists?: boolean
  firstCommandTransactionExists?: boolean
  stopLegacyMarkerExists?: boolean
  nextPid: number
  stopObservations?: Array<{ maskPresent: boolean; unit: string; unitFileState: string }>
  units: Record<string, {
    activeState: string
    controlPid: number
    dropIns: string[]
    fragmentPath: string
    invocationId: string
    mainPid: number
    maskPresentWhenStopped?: boolean
    nRestarts: number
    pathEnvironment: string
    profile: string
    serviceHome: string
    starts: number
    subState: string
    unitFileState: string
    unitFileStateBeforeMask?: string
    replacementMaskIdentity?: LifecycleIdentity
  }>
}

async function readLifecycleSystemdState(path: string): Promise<LifecycleSystemdState> {
  return JSON.parse(await readFile(path, 'utf8')) as LifecycleSystemdState
}

function setLifecycleSystemdControls(path: string, options: LifecycleRunOptions): void {
  const state = JSON.parse(readFileSync(path, 'utf8')) as LifecycleSystemdState
  state.controls = {
    dropInMutation: options.systemdDropInMutation,
    crashBeforeStartProfile: options.systemdCrashBeforeStartProfile,
    dynamicProfile: options.systemdDynamicProfile,
    guardianListUnitFilesFailuresRemaining: options.systemdGuardianListUnitFilesFailureBudget ?? 0,
    guardianListUnitsFailuresRemaining: options.systemdGuardianListUnitsFailureBudget ?? 0,
    guardianOwnershipShowFailuresRemaining: options.systemdGuardianOwnershipShowFailureBudget ?? 0,
    guardianOwnershipShowFailsProfile: options.systemdGuardianOwnershipShowFailsProfile,
    journal: options.systemdJournal ?? 'ready',
    killLifecycleDuringStartProfile: options.systemdKillLifecycleDuringStartProfile,
    pidStuckProfile: options.systemdPidStuckProfile,
    quiescenceDriftProfile: options.systemdQuiescenceDriftProfile,
    readinessFailsProfile: options.systemdReadinessFailsProfile,
    replaceControlMaskOnUnmaskProfile: options.systemdReplaceControlMaskOnUnmaskProfile,
    restartLoopProfile: options.systemdRestartLoopProfile,
    startFailsProfile: options.systemdStartFailsProfile,
    stopFailsProfile: options.systemdStopFailsProfile,
  }
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

async function readLifecycleSystemdLog(path: string): Promise<string[][]> {
  return (await readJsonLines(path)) as string[][]
}

type RecoveryState = 'preparing' | 'prepared' | 'validated' | 'original-renamed' | 'swapped' | 'committed' | 'cleanup-started' | 'failed'

interface LifecycleIdentity {
  dev: string
  ino: string
}

interface BoundLifecycleManifest {
  version: 1
  id: string
  homePath: string
  canonicalHome: string
  transactionPath: string
  transactionIdentity?: LifecycleIdentity
  profile: string
  operation: 'upgrade' | 'uninstall'
  originalIdentity: LifecycleIdentity
  originalProfileDigest: string
  stagedIdentity?: LifecycleIdentity
  stagedProfileDigest?: string
  expectedScenario?: 'autonomy' | 'lark' | 'web'
  stagedScenario?: 'autonomy' | 'lark' | 'unsupported' | 'web'
  createdAt: string
  state: RecoveryState
  updatedAt: string
  bindingDigest: string
}

async function lifecycleIdentity(path: string): Promise<LifecycleIdentity> {
  const entry = await stat(path)
  return { dev: String(entry.dev), ino: String(entry.ino) }
}

function lifecycleBinding(manifest: Omit<BoundLifecycleManifest, 'bindingDigest' | 'updatedAt'>) {
  return {
    version: manifest.version,
    id: manifest.id,
    homePath: manifest.homePath,
    canonicalHome: manifest.canonicalHome,
    transactionPath: manifest.transactionPath,
    transactionIdentity: manifest.transactionIdentity,
    profile: manifest.profile,
    operation: manifest.operation,
    originalIdentity: manifest.originalIdentity,
    originalProfileDigest: manifest.originalProfileDigest,
    stagedIdentity: manifest.stagedIdentity,
    stagedProfileDigest: manifest.stagedProfileDigest,
    expectedScenario: manifest.expectedScenario,
    stagedScenario: manifest.stagedScenario,
    createdAt: manifest.createdAt,
    state: manifest.state,
  }
}

function serviceLifecycleBinding(manifest: Record<string, unknown>) {
  return {
    version: manifest.version,
    id: manifest.id,
    homePath: manifest.homePath,
    canonicalHome: manifest.canonicalHome,
    transactionPath: manifest.transactionPath,
    transactionIdentity: manifest.transactionIdentity,
    profile: manifest.profile,
    operation: manifest.operation,
    originalIdentity: manifest.originalIdentity,
    originalProfileDigest: manifest.originalProfileDigest,
    stagedIdentity: manifest.stagedIdentity,
    stagedProfileDigest: manifest.stagedProfileDigest,
    expectedScenario: manifest.expectedScenario,
    stagedScenario: manifest.stagedScenario,
    createdAt: manifest.createdAt,
    state: manifest.state,
    services: manifest.services,
    servicePhase: manifest.servicePhase,
    serviceFailure: manifest.serviceFailure,
    serviceAcceptance: manifest.serviceAcceptance,
    unitUniverse: manifest.unitUniverse,
    serviceMasks: manifest.serviceMasks,
    containmentMasks: manifest.containmentMasks,
    containmentMaskIntents: manifest.containmentMaskIntents,
    serviceStartBarriers: manifest.serviceStartBarriers,
    containmentStartBarriers: manifest.containmentStartBarriers,
  }
}

async function writeBoundLifecycleManifest(options: {
  dshHome: string
  includeTransactionIdentity?: boolean
  originalHome: string
  stagedHome?: string
  state: RecoveryState
  originalProfileDigest?: string
  originalIdentity?: LifecycleIdentity
  stagedIdentity?: LifecycleIdentity
  stagedProfileDigest?: string
}): Promise<BoundLifecycleManifest> {
  const transactionPath = `${options.dshHome}.dsh-enhanced-transaction`
  await mkdir(transactionPath, { recursive: true, mode: 0o700 })
  await chmod(transactionPath, 0o700)
  const createdAt = '2026-09-09T00:00:00.000Z'
  const base = {
    version: 1 as const,
    id: `recovery-${options.state}`,
    homePath: options.dshHome,
    canonicalHome: await realpath(options.dshHome).catch(() => options.dshHome),
    transactionPath,
    ...(options.includeTransactionIdentity === false ? {} : { transactionIdentity: await lifecycleIdentity(transactionPath) }),
    profile: 'web',
    operation: 'upgrade' as const,
    originalIdentity: options.originalIdentity ?? await lifecycleIdentity(options.originalHome),
    originalProfileDigest: options.originalProfileDigest ?? createHash('sha256')
      .update(await readFile(join(options.originalHome, 'profiles', 'web', 'package.json')))
      .digest('hex'),
    stagedIdentity: options.stagedIdentity ?? (options.stagedHome === undefined ? undefined : await lifecycleIdentity(options.stagedHome)),
    stagedProfileDigest: options.stagedProfileDigest,
    createdAt,
    state: options.state,
  }
  const manifest: BoundLifecycleManifest = {
    ...base,
    updatedAt: createdAt,
    bindingDigest: createHash('sha256').update(JSON.stringify(lifecycleBinding(base))).digest('hex'),
  }
  await writeFile(join(transactionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return manifest
}

const yamlOptions = {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
} as const

async function composeSelectedBundleRows(installerOutput: string): Promise<any[]> {
  const paths = [...new Set([...installerOutput.matchAll(new RegExp(`${repoRoot}/plugins/[a-z0-9-]+`, 'gu'))]
    .map(match => match[0]))]
  const rows: any[] = []
  for (const path of paths) {
    const patch = parse(await readFile(join(path, 'cordis.patch.yml'), 'utf8'), yamlOptions) as any[]
    for (const operation of patch) {
      if (Array.isArray(operation.insert)) rows.push(...operation.insert)
      else if (typeof operation.id === 'string') rows.push(operation)
    }
  }
  return rows
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('one-click installers', () => {
  test('offline upgrade swaps one validated home while preserving custom configuration and durable task state', async () => {
    const f = await lifecycleFixture()
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    expect(result.stdout).toContain('profile 生命周期事务完成：upgrade')
    await expect(readFile(`${f.dshHome}.dsh-enhanced-transaction/state`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const sandboxInvocations = await readJsonLines(f.bwrapLog)
    expect(sandboxInvocations).toHaveLength(8)
    for (const invocation of sandboxInvocations) {
      expect(invocation).toContain('--unshare-all')
      expect(invocation).not.toContain('--share-net')
      expect(invocation).toContain('--die-with-parent')
      expect(invocation).toContain('--new-session')
      expect(invocation).toEqual(expect.arrayContaining(['--ro-bind', '/', '/', '--tmpfs', '/tmp']))
      expect(invocation).toEqual(expect.arrayContaining([
        '--perms', '0400', '--ro-bind-data', '4', '/run/dsh-enhanced-lifecycle-config.mjs',
      ]))
      const bind = invocation.indexOf('--bind-fd')
      expect(invocation.slice(bind, bind + 3)).toEqual(['--bind-fd', '3', f.dshHome])
      const dshHomeVariable = invocation.findIndex((value, index) => value === 'DSH_HOME' && invocation[index - 1] === '--setenv')
      expect(invocation[dshHomeVariable + 1]).toBe(f.dshHome)
    }
  })

  test('offline upgrade leaves original home untouched after isolated activation fails', async () => {
    const f = await lifecycleFixture({ activationFails: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).toBe(`${f.dshHome}.dsh-enhanced-transaction`)
    const preservedManifest = JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8'))
    expect(preservedManifest).toMatchObject({ operation: 'upgrade', profile: 'web', state: 'failed' })
    expect(preservedManifest.failure).toContain('隔离 Host 激活失败')
    const stagedDatabase = join(preserved[0]!, 'staged-home', 'assistant-goals', 'web.sqlite')
    expect(readLifecycleDatabase(stagedDatabase)).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(preserved[0]!, 'staged-home', '.activation-ran'), 'utf8')).toBe('')
  })

  test('offline upgrade leaves the original home untouched when package preparation fails before swap', async () => {
    const f = await lifecycleFixture()
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      activationMarker: f.activationMarker, packageFails: true,
    })

    expect(result.status).toBe(42)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test.each([
    '@dsh-enhanced/personal-assistant@1.4.0-rc.2',
    '@dsh-enhanced/personal-assistant@1.4.0+build.7',
  ])('lifecycle executor accepts exact prerelease or build npm spec %s', async target => {
    const f = await lifecycleFixture()

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', target], f.dshHome, f.fakeBin, {
      packageFails: true,
    })

    expect(result.status, result.stderr).toBe(42)
    expect(result.stderr).not.toContain('升级目标必须是本地绝对路径或精确版本')
    expect(await readFile(f.operationLog, 'utf8')).toContain(`\tplugin --profile web add ${target}\n`)
  })

  test.each([
    '@dsh-enhanced/personal-assistant@^1.4.0',
    '@dsh-enhanced/personal-assistant@1.4.x',
    '@dsh-enhanced/personal-assistant@latest',
    '@dsh-enhanced/personal-assistant@next',
  ])('lifecycle executor rejects range or tag npm spec %s before creating a transaction', async target => {
    const f = await lifecycleFixture()

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', target], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('升级目标必须是本地绝对路径或精确版本')
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('offline uninstall archives the complete old profile and preserves all external durable state', async () => {
    const f = await lifecycleFixture({ thirdParty: false })

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const current = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))
    expect(current.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const archives = await readdir(join(f.dshHome, 'uninstalled-profiles'))
    expect(archives).toHaveLength(1)
    const archived = JSON.parse(await readFile(join(f.dshHome, 'uninstalled-profiles', archives[0]!, 'package.json'), 'utf8'))
    expect(archived.dependencies).toMatchObject({ '@dsh-enhanced/personal-assistant': '0.1.0' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'] })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe('durable-session')
    const repeated = runLifecycle(
      ['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin, { expectedScenario: 'unsupported' },
    )
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(repeated.stdout).toContain('没有 @dsh-enhanced/* 顶层依赖')
    expect(await readdir(join(f.dshHome, 'uninstalled-profiles'))).toEqual(archives)
  })

  test('uninstall activation failure leaves the original home unchanged and keeps its archive only in staged evidence', async () => {
    const f = await lifecycleFixture({ activationFails: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')
    const sessionBefore = await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe(sessionBefore)
    await expect(stat(join(f.dshHome, 'uninstalled-profiles'))).rejects.toMatchObject({ code: 'ENOENT' })

    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toEqual([`${f.dshHome}.dsh-enhanced-transaction`])
    const stagedHome = join(preserved[0]!, 'staged-home')
    const stagedArchives = await readdir(join(stagedHome, 'uninstalled-profiles'))
    expect(stagedArchives).toHaveLength(1)
    const archived = JSON.parse(await readFile(
      join(stagedHome, 'uninstalled-profiles', stagedArchives[0]!, 'package.json'), 'utf8',
    ))
    expect(archived.dependencies).toMatchObject({ '@dsh-enhanced/personal-assistant': '0.1.0' })
    expect(readLifecycleDatabase(join(stagedHome, 'assistant-goals', 'web.sqlite'))).toEqual({
      userVersion: 2, values: ['durable-goal-state', 'migrated-during-activation'],
    })
  })

  test('uninstall fails closed without changing a profile that has third-party bundles', async () => {
    const f = await lifecycleFixture({ thirdParty: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['uninstall', 'web', f.dshHome, '0'], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/third-party|第三方/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test('upgrade fails closed without changing a profile that has a third-party bundle', async () => {
    const f = await lifecycleFixture({ thirdParty: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/third-party|第三方/u)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(f.dshLog, 'utf8')).toContain('CALL\t--profile\tweb\t--dump-config\n')
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])
  })

  test('upgrade rejects an ordinary dependency activated as a third-party composed row', async () => {
    const f = await lifecycleFixture({ thirdPartyDependency: true })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      configAfterUpgrade: '- id: owner-local-plugin\n  name: owner-library\n  config:\n    dataDir: /srv/owner-state',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('rejects enabled non-first-party row owner-local-plugin')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('refuses unbound legacy transaction residue without renaming or deleting unknown homes', async () => {
    const f = await lifecycleFixture()
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    await mkdir(transaction, { mode: 0o700 })
    await writeFile(join(transaction, 'state'), 'swapped\n')
    await rename(f.dshHome, join(transaction, 'original-home'))
    await mkdir(f.dshHome)
    await writeFile(join(f.dshHome, 'failed-new-home'), 'partial')

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/unbound|绑定|未知|manifest/iu)
    expect(await readFile(join(f.dshHome, 'failed-new-home'), 'utf8')).toBe('partial')
    expect(readLifecycleDatabase(join(transaction, 'original-home', 'assistant-goals', 'web.sqlite'))).toEqual({
      userVersion: 1, values: ['durable-goal-state'],
    })
  })

  test.each(['preparing', 'failed'] as const)('bound %s recovery preserves evidence while leaving the original home intact', async state => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'failed-stage-marker'), state)
    await writeBoundLifecycleManifest({ dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('原 DSH_HOME 未修改')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    expect(await readFile(join(preserved[0]!, 'staged-home', 'failed-stage-marker'), 'utf8')).toBe(state)
    const manifest = JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ state, originalIdentity })
  })

  test('bound original-renamed recovery restores an absent home from the original backup', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, state: 'original-renamed', originalIdentity,
    })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('已恢复原 DSH_HOME')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    await expect(readFile(join(preserved[0]!, 'original-home', 'profiles', 'web', 'package.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('bound swapped recovery restores the original and keeps the failed staged home as evidence', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const stagedHome = join(transaction, 'staged-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await mkdir(stagedHome)
    await mkdir(join(stagedHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(stagedHome, '.lifecycle-dump-config'), stringify([
      { id: 'dsh-enhanced-assistant-web-owner', name: '@dsh-enhanced/assistant-web-owner' },
    ]))
    await writeFile(join(stagedHome, 'staged-marker'), 'failed staged home')
    const stagedIdentity = await lifecycleIdentity(stagedHome)
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, stagedHome, state: 'swapped', originalIdentity, stagedIdentity,
    })
    await rename(stagedHome, f.dshHome)

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('原 DSH_HOME 已恢复')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(preserved[0]!, 'failed-home', 'staged-marker'), 'utf8')).toBe('failed staged home')
  })

  test('bound v1 committed recovery without transactionIdentity removes its backup and transaction', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const backupHome = join(transaction, 'original-home')
    const stagedHome = join(transaction, 'staged-home')
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    await mkdir(transaction, { mode: 0o700 })
    await rename(f.dshHome, backupHome)
    await cp(backupHome, stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'committed-marker'), 'keep live')
    const stagedIdentity = await lifecycleIdentity(stagedHome)
    const stagedProfileDigest = createHash('sha256')
      .update(await readFile(join(stagedHome, 'profiles', 'web', 'package.json')))
      .digest('hex')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: backupHome, stagedHome, state: 'committed',
      includeTransactionIdentity: false, originalIdentity, stagedIdentity, stagedProfileDigest,
    })
    const committedManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(committedManifest).not.toHaveProperty('transactionIdentity')
    await rename(stagedHome, f.dshHome)
    expect(await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')).toContain(
      'dsh-enhanced-assistant-web-owner',
    )

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已完成上次提交后的绑定清理')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(stagedIdentity)
    expect(await readFile(join(f.dshHome, 'committed-marker'), 'utf8')).toBe('keep live')
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])
  })

  test.each([
    ['inode', { inode: true, digest: false }],
    ['digest', { inode: false, digest: true }],
  ] as const)('bound recovery fails closed on an original %s mismatch', async (_kind, mismatch) => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const markerPath = join(transaction, 'staged-home', 'evidence')
    await mkdir(dirname(markerPath), { recursive: true })
    await writeFile(markerPath, 'untouched evidence')
    const actualIdentity = await lifecycleIdentity(f.dshHome)
    const originalIdentity = mismatch.inode ? { ...actualIdentity, ino: String(BigInt(actualIdentity.ino) + 1n) } : actualIdentity
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome,
      originalHome: f.dshHome,
      stagedHome: dirname(markerPath),
      state: 'failed',
      originalIdentity,
      originalProfileDigest: mismatch.digest ? '0'.repeat(64) : undefined,
    })

    const result = runRecovery('web', f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(mismatch.inode ? /身份未知|拒绝重命名|inode/iu : /摘要不匹配|digest/iu)
    expect(await readFile(markerPath, 'utf8')).toBe('untouched evidence')
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([transaction])
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
  })

  test('a concurrent lifecycle operation is refused while preparation holds the home lock and leaves the original untouched', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const first = startLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageBlock: true })
    const stagedHome = join(`${f.dshHome}.dsh-enhanced-transaction`, 'staged-home')
    await waitForFile(join(stagedHome, '.package-preparation-started'))

    const second = startLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
    const observedSecond = await Promise.race([
      second.done,
      new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
    ])
    await writeFile(join(stagedHome, '.package-preparation-release'), '')
    const secondResult = observedSecond ?? await second.done
    expect(observedSecond, 'the contender must fail immediately rather than wait for the lock').toBeDefined()
    expect(secondResult.status).not.toBe(0)
    expect(secondResult.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })

    const firstResult = await first.done
    expect(firstResult.status, firstResult.stderr).toBe(0)
  })

  test('an externally held lifecycle lock is nonblocking and covers recovery before any residue is moved', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const residueMarker = join(transaction, 'legacy-residue')
    await mkdir(transaction, { mode: 0o700 })
    await writeFile(residueMarker, 'must-not-move')
    const lock = await holdExternalLifecycleLock(`${f.dshHome}.dsh-enhanced-lifecycle.lock`)

    try {
      const recovery = startRecovery('web', f.dshHome, f.fakeBin)
      const result = await Promise.race([
        recovery.done,
        new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
      ])

      expect(result, 'recovery must fail rather than wait for an externally owned lock').toBeDefined()
      expect(result!.status).not.toBe(0)
      expect(result!.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
      expect(await readFile(residueMarker, 'utf8')).toBe('must-not-move')
      expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([transaction])
    } finally {
      await lock.release()
    }
  })

  test('post-upgrade structural validation rejects a newly introduced external state path before activation or swap', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      configAfterUpgrade: "- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'\n- id: newly-installed-state\n  name: '@dsh-enhanced/personal-assistant'\n  config:\n    statePath: /srv/newly-installed/state.json",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects newly-installed-state.statePath: resolves outside canonical DSH_HOME')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    await expect(readFile(f.activationMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(preserved[0]!, 'staged-home', '.lifecycle-dump-config'), 'utf8')).toContain('/srv/newly-installed/state.json')
  })

  test('rejects a descendant symlink escape before a staged package command can write outside DSH_HOME', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const outsideDirectory = join(f.root, 'outside')
    const outsideWrite = join(outsideDirectory, 'escape.txt')
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, join(f.dshHome, 'escape-link'))

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
      packageWriteRelative: 'escape-link/escape.txt',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/symbolic|symlink|符号链接/iu)
    await expect(readFile(outsideWrite, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])
  })

  test.each([
    ['a newly created', 'profiles/web/node_modules/new-external', false],
    ['a changed existing', 'profiles/web/node_modules/existing-external', true],
  ] as const)('post-package scan rejects %s external package symlink and leaves the original home unchanged',
    async (_kind, packageSymlinkRelative, existing) => {
      const f = await lifecycleFixture()
      const firstExternal = join(f.root, 'external-package-a')
      const secondExternal = join(f.root, 'external-package-b')
      await mkdir(firstExternal)
      await mkdir(secondExternal)
      if (existing) {
        await mkdir(dirname(join(f.dshHome, packageSymlinkRelative)), { recursive: true })
        await symlink(firstExternal, join(f.dshHome, packageSymlinkRelative))
      }
      const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

      const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, {
        packageSymlinkRelative,
        packageSymlinkTarget: secondExternal,
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/symbolic link|symlink|符号链接|外链/iu)
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toEqual([`${f.dshHome}.dsh-enhanced-transaction`])
      expect(await realpath(join(preserved[0]!, 'staged-home', packageSymlinkRelative))).toBe(secondExternal)
      if (existing) expect(await realpath(join(f.dshHome, packageSymlinkRelative))).toBe(firstExternal)
      else await expect(stat(join(f.dshHome, packageSymlinkRelative))).rejects.toMatchObject({ code: 'ENOENT' })
    })

  test('post-package scan allows an unchanged existing external pnpm package symlink', async () => {
    const f = await lifecycleFixture()
    const externalPackage = join(f.root, 'pnpm-store-package')
    const packageLink = join(f.profileDirectory, 'node_modules', 'existing-external')
    await mkdir(externalPackage)
    await mkdir(dirname(packageLink), { recursive: true })
    await symlink(externalPackage, packageLink)

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect(await realpath(packageLink)).toBe(externalPackage)
    expect(await readFile(join(f.profileDirectory, 'upgraded'), 'utf8')).toBe('upgraded\n')
  })

  test('rejects a hardlink with a directory entry outside DSH_HOME before the staged package command', async () => {
    const f = await lifecycleFixture({ thirdParty: false })
    const outsideFile = join(f.root, 'outside-state')
    const insideLink = join(f.dshHome, 'linked-state')
    await writeFile(outsideFile, 'outside must remain unchanged')
    await link(outsideFile, insideLink)

    const result = runLifecycle(['upgrade', 'web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/hardlink|硬链接|连接到快照外部/iu)
    expect(await readFile(outsideFile, 'utf8')).toBe('outside must remain unchanged')
    expect(await readFile(insideLink, 'utf8')).toBe('outside must remain unchanged')
    expect(await readFile(f.dshLog, 'utf8')).toContain('CALL\t--profile\tweb\t--dump-config\n')
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  })

  test.skipIf(!realBwrapUsable)('real bwrap mounts a /tmp staged home by fd at the logical DSH_HOME after /tmp isolation', async () => {
    const root = await temporaryDshHome()
    const logicalHome = join(root, 'logical-home')
    const stagedHome = join(root, 'staged-home')
    await mkdir(stagedHome)
    await writeFile(join(stagedHome, 'mounted-marker'), 'staged')
    const stagedHandle = await open(stagedHome, 'r')

    try {
      const result = spawnSync('/usr/bin/bwrap', [
        '--unshare-all', '--die-with-parent', '--new-session',
        '--ro-bind', '/', '/',
        '--tmpfs', '/tmp', '--tmpfs', '/run',
        '--dir', logicalHome,
        '--bind-fd', '3', logicalHome,
        '--proc', '/proc', '--dev', '/dev',
        '--chdir', '/tmp', '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--setenv', 'HOME', '/tmp',
        '--setenv', 'TMPDIR', '/tmp',
        '--setenv', 'DSH_HOME', logicalHome,
        '--', '/bin/sh', '-c', 'test "$DSH_HOME" = "$1" && test "$(cat "$DSH_HOME/mounted-marker")" = staged && printf "%s\n" "$DSH_HOME"',
        'bwrap-smoke', logicalHome,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', stagedHandle.fd], timeout: 5_000 })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`${logicalHome}\n`)
    } finally {
      await stagedHandle.close()
    }
  })

  test.skipIf(!realBwrapUsable)('real bwrap executes a /tmp validator through ro-bind-data after /tmp is hidden', async () => {
    const root = await temporaryDshHome()
    const validatorPath = join(root, 'validator.mjs')
    await writeFile(validatorPath, [
      "import { readFileSync } from 'node:fs'",
      "if (readFileSync(import.meta.filename, 'utf8').includes('validator-through-fd')) {",
      "  process.stdout.write('validator-through-fd\\n')",
      '}',
      '// validator-through-fd',
      '',
    ].join('\n'))
    const validatorHandle = await open(validatorPath, 'r')

    try {
      const result = spawnSync('/usr/bin/bwrap', [
        '--unshare-all', '--die-with-parent', '--new-session',
        '--ro-bind', '/', '/',
        '--tmpfs', '/tmp', '--tmpfs', '/run',
        '--perms', '0400', '--ro-bind-data', '3', '/run/validator.mjs',
        '--proc', '/proc', '--dev', '/dev',
        '--chdir', '/tmp', '--clearenv',
        '--setenv', 'PATH', '/usr/bin:/bin',
        '--', process.execPath, '/run/validator.mjs',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', validatorHandle.fd], timeout: 5_000 })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe('validator-through-fd\n')
    } finally {
      await validatorHandle.close()
    }
  })

  test('installer upgrade targets only existing managed dependencies and preserves third-party dependencies', async () => {
    const f = await lifecycleFixture({
      managedDependencies: ['personal-assistant', 'assistant-goals'],
      thirdParty: false,
      thirdPartyDependency: true,
    })
    const manifestBefore = JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))

    const result = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--dry-run',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm --dir')
    expect(result.stdout).toContain('install --offline --frozen-lockfile')
    expect(result.stdout).toContain('dsh plugin --profile web add')
    for (const target of [
      join(repoRoot, 'plugins', 'personal-assistant'),
      join(repoRoot, 'plugins', 'assistant-goals'),
    ]) expect(result.stdout).toContain(target)
    for (const absent of ['plugin-control-plane', 'assistant-delivery', 'assistant-web-owner']) {
      expect(result.stdout).not.toContain(join(repoRoot, 'plugins', absent))
    }
    expect(JSON.parse(await readFile(join(f.profileDirectory, 'package.json'), 'utf8'))).toEqual(manifestBefore)
  })

  test('npm lifecycle dry-run upgrades only existing managed names at one exact version', async () => {
    const f = await lifecycleFixture({
      managedDependencies: ['personal-assistant', 'assistant-goals'],
      thirdPartyDependency: true,
    })
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0', '--dry-run',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).not.toContain('只由完整本地仓库安装器提供')
    expect(result.stdout).toContain('npm cohort（dry-run）：将核验所有 bundle 都已发布为 1.4.0')
    expect(result.stdout).toContain('@dsh-enhanced/personal-assistant@1.4.0')
    expect(result.stdout).toContain('@dsh-enhanced/assistant-goals@1.4.0')
    for (const absent of ['plugin-control-plane', 'assistant-delivery', 'assistant-web-owner']) {
      expect(result.stdout).not.toContain('@dsh-enhanced/' + absent + '@1.4.0')
    }
    expect(result.stdout).not.toContain('owner-library@1.4.0')
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
  })

  test('npm upgrade resolves and prefetches its exact cohort before creating the offline transaction', async () => {
    const f = await lifecycleFixture()
    const version = '1.4.0-rc.2+build.7'
    const target = `@dsh-enhanced/personal-assistant@${version}`

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', version,
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { npmVersion: version }))

    expect(result.status, result.stderr).toBe(0)
    expect((await readFile(f.operationLog, 'utf8')).trim().split('\n')).toEqual([
      `npm-view\tabsent\tview ${target} version --json`,
      `npm-view\tabsent\tview ${target} version --json`,
      `pnpm-store-add\tabsent\tignore=true\tstore add ${target}`,
      `dsh-add\tpresent\toffline=true\timport=copy\tplugin --profile web add ${target}`,
    ])
  })

  test('npm upgrade keeps its lifecycle lock while npm view is blocked and a contender fails busy before any transaction', async () => {
    const f = await lifecycleFixture()
    const args = [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0',
    ]
    const first = startInstaller(npmInstaller, args, f.dshHome, f.fakeBin, { npmBlock: true })
    await waitForFile(join(f.root, 'npm-block-started'))
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })

    const second = startInstaller(npmInstaller, args, f.dshHome, f.fakeBin)
    const observedSecond = await Promise.race([
      second.done,
      new Promise<undefined>(resolveDelay => setTimeout(resolveDelay, 1_000)),
    ])

    expect(observedSecond, 'the contender must fail immediately while npm view holds the lifecycle lock').toBeDefined()
    expect(observedSecond!.status).not.toBe(0)
    expect(observedSecond!.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(f.operationLog, 'utf8')).match(/^npm-view/mgu)).toHaveLength(1)

    await writeFile(join(f.root, 'npm-block-release'), '')
    const firstResult = await first.done
    expect(firstResult.status, firstResult.stderr).toBe(0)
  })

  test.each([
    ['group-writable DSH_HOME parent', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => dirname(f.dshHome), 0o020],
    ['other-writable DSH_HOME parent', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => dirname(f.dshHome), 0o002],
    ['group-writable DSH_HOME', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.dshHome, 0o020],
    ['other-writable DSH_HOME', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.dshHome, 0o002],
    ['group-writable profile', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.profileDirectory, 0o020],
    ['other-writable profile', (f: Awaited<ReturnType<typeof lifecycleFixture>>) => f.profileDirectory, 0o002],
  ] as const)('npm upgrade rejects %s before registry access', async (_label, selectedPath, writableBit) => {
    const f = await lifecycleFixture()
    const unsafePath = selectedPath(f)
    const originalMode = (await stat(unsafePath)).mode & 0o777
    await chmod(unsafePath, originalMode | writableBit)

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/writable|permission|权限|写入|不可写|不安全/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm upgrade store prefetch failure leaves all original state untouched and never creates a transaction', async () => {
    const f = await lifecycleFixture()
    const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
    const patchBefore = await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')
    const sessionBefore = await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
      '--plugin-version', '1.4.0',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin, { storeFails: true }))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('npm cohort 预取失败')
    expect((await readFile(f.operationLog, 'utf8')).trim().split('\n')).toEqual([
      'npm-view\tabsent\tview @dsh-enhanced/personal-assistant@1.4.0 version --json',
      'npm-view\tabsent\tview @dsh-enhanced/personal-assistant@1.4.0 version --json',
      'pnpm-store-add\tabsent\tignore=true\tstore add @dsh-enhanced/personal-assistant@1.4.0',
    ])
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
    expect(await readFile(join(f.profileDirectory, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
    expect(await readFile(join(f.dshHome, 'sessions', 'owner-session.jsonl'), 'utf8')).toBe(sessionBefore)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(f.activationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    const dshCalls = await readFile(f.dshLog, 'utf8')
    expect(dshCalls).toContain('CALL\t--version\n')
    expect(dshCalls).not.toContain('\tplugin\t')
    expect(dshCalls).not.toContain('\t--host\t')
  })

  test('npm upgrade recovers an old transaction and returns before registry or store access', async () => {
    const f = await lifecycleFixture()
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'recovered-evidence'), 'preserve')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state: 'failed',
    })

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/未.*(?:package|registry|store).*mutation|未访问 npm registry/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    expect(await readFile(join(preserved[0]!, 'staged-home', 'recovered-evidence'), 'utf8')).toBe('preserve')
  })

  test('npm upgrade through a canonical home symlink recovers residue without registry access', async () => {
    const f = await lifecycleFixture()
    const homeAlias = join(f.root, 'home-alias')
    await symlink(f.dshHome, homeAlias)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'canonical-recovery-evidence'), 'preserve')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state: 'failed',
    })

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped',
    ], homeAlias, undefined, lifecycleEnvironment(homeAlias, f.fakeBin))

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/本次未访问 npm registry|本次未开始新的 package、registry、store/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(preserved[0]).not.toBe(transaction)
    expect(await readFile(join(preserved[0]!, 'staged-home', 'canonical-recovery-evidence'), 'utf8')).toBe('preserve')
  })

  test('npm uninstall skips registry cohort resolution and pnpm store prefetch', async () => {
    const f = await lifecycleFixture()

    const result = runInstaller(npmInstaller, [
      '--operation', 'uninstall', '--scenario', 'web', '--confirm-dsh-home-stopped',
    ], f.dshHome, undefined, lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
  })

  test('upgrade and uninstall require explicit supported lifecycle scenarios and stopped-home confirmation', async () => {
    const dshHome = await temporaryDshHome()
    const profile = join(dshHome, 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), '{}')

    const missingConfirmation = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'web', '--dry-run'], dshHome)
    expect(missingConfirmation.status).toBe(2)
    expect(missingConfirmation.stderr).toContain('--confirm-dsh-home-stopped')
    const supervised = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'supervised', '--confirm-dsh-home-stopped', '--dry-run'], dshHome)
    expect(supervised.status).toBe(2)
    expect(supervised.stderr).toMatch(/supervised.*upgrade|upgrade.*supervised|尚未支持/iu)
    const hostChange = runInstaller(localInstaller, ['--operation', 'upgrade', '--scenario', 'web', '--confirm-dsh-home-stopped', '--dsh-version', '0.1.2-rc.1', '--dry-run'], dshHome)
    expect(hostChange.status).toBe(2)
    expect(hostChange.stderr).toContain('不会修改全局 DSH')
  })

  test('Linux service lifecycle admits only Lark upgrade while keeping supervised and Lark uninstall fail closed', async () => {
    const f = await lifecycleFixture({ systemd: {} })
    const commonArgs = ['--confirm-dsh-home-stopped', '--dry-run']

    const larkUpgrade = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', 'lark', ...commonArgs,
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))
    const supervisedUpgrade = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', 'supervised', ...commonArgs,
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))
    const larkUninstall = runInstaller(localInstaller, [
      '--operation', 'uninstall', '--scenario', 'lark', ...commonArgs,
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(larkUpgrade.status, larkUpgrade.stderr).toBe(0)
    expect(larkUpgrade.stdout).toContain('Lark service-aware upgrade (Linux systemd --user)')
    expect(larkUpgrade.stdout).toContain('canonical DSH_HOME, runtime-mask them, stop them, and verify PID quiescence')
    expect(larkUpgrade.stdout).toContain('fresh InvocationID journal readiness and stability before backup cleanup')
    expect(larkUpgrade.stdout).toContain('preserve both homes plus the bound manifest without automatic rollback')
    expect(supervisedUpgrade.status).toBe(2)
    expect(supervisedUpgrade.stderr).toMatch(/supervised.*upgrade|upgrade.*supervised|尚未支持/iu)
    expect(larkUninstall.status).toBe(2)
    expect(larkUninstall.stderr).toMatch(/lark.*uninstall|uninstall.*lark|尚未支持/iu)
  })

  test.each(['local', 'npm'] as const)(
    '%s lifecycle entry rejects unsupported service modes before systemd, transaction, or registry work',
    async source => {
      for (const dryRun of [false, true]) {
        for (const rejected of [
          { operation: 'upgrade', scenario: 'supervised', extra: [] as string[], platform: 'Linux' },
          { operation: 'uninstall', scenario: 'supervised', extra: [] as string[], platform: 'Linux' },
          { operation: 'uninstall', scenario: 'lark', extra: [] as string[], platform: 'Linux' },
          { operation: 'upgrade', scenario: 'lark', extra: ['--no-service'], platform: 'Linux' },
          { operation: 'upgrade', scenario: 'lark', extra: [] as string[], platform: 'Darwin' },
        ]) {
          const f = await lifecycleFixture({ systemd: {} })
          const script = source === 'local' ? localInstaller : npmInstaller
          const result = runInstaller(script, [
            '--operation', rejected.operation, '--scenario', rejected.scenario,
            '--confirm-dsh-home-stopped', '--yes', ...rejected.extra, ...(dryRun ? ['--dry-run'] : []),
          ], f.dshHome, rejected.platform, lifecycleEnvironment(f.dshHome, f.fakeBin))

          expect(result.status, `${source} ${dryRun ? 'dry' : 'live'} ${rejected.scenario} ${rejected.operation}: ${result.stderr}`).toBe(2)
          expect(await readFile(f.operationLog, 'utf8')).toBe('')
          expect(await readFile(f.systemdLog, 'utf8')).toBe('')
          await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
    },
    15_000,
  )

  test.each(['local', 'npm'] as const)(
    'public %s Lark upgrade recovers original-renamed v2 residue through a now-dangling DSH_HOME symlink',
    async source => {
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
      ] } })
      const homeAlias = join(f.root, 'home-alias')
      await symlink(f.dshHome, homeAlias)
      const originalIdentity = await lifecycleIdentity(f.dshHome)
      const crashed = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { killLifecycleAfterOriginalRename: true },
      )
      expect(crashed.status).not.toBe(0)
      await expect(stat(homeAlias)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await lstat(homeAlias)).isSymbolicLink()).toBe(true)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
      expect(crashManifest).toMatchObject({ version: 2, state: 'original-renamed', expectedScenario: 'lark' })
      const operationsBeforeRecovery = await readFile(f.operationLog, 'utf8')
      expect(operationsBeforeRecovery.match(/^dsh-add\t/gmu)).toHaveLength(1)

      const script = source === 'local' ? localInstaller : npmInstaller
      const recovered = runInstaller(script, [
        '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', '1.4.0'] : []),
      ], homeAlias, 'Linux', lifecycleEnvironment(homeAlias, f.fakeBin))

      expect(recovered.status).not.toBe(0)
      expect(recovered.stderr).toMatch(/恢复|recovery|重试/iu)
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      expect(await realpath(homeAlias)).toBe(f.dshHome)
      expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBeforeRecovery)
      expect(operationsBeforeRecovery).not.toMatch(/^npm-view|^pnpm-store-add/mu)
      await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toHaveLength(1)
      expect(JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8')))
        .toMatchObject({ version: 2, id: crashManifest.id, state: 'original-renamed' })
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
    },
    15_000,
  )

  test.each([
    { actual: 'lark', declared: 'web', source: 'local' },
    { actual: 'lark', declared: 'web', source: 'npm' },
    { actual: 'supervised', declared: 'web', source: 'local' },
    { actual: 'supervised', declared: 'web', source: 'npm' },
    { actual: 'autonomy', declared: 'web', source: 'local' },
    { actual: 'web', declared: 'autonomy', source: 'local' },
    { actual: 'web', declared: 'lark', source: 'local' },
    { actual: 'web', declared: 'lark', source: 'npm' },
  ] as const)(
    '$source lifecycle rejects actual $actual profile spoofed as $declared before external work',
    async ({ actual, declared, source }) => {
      const f = await lifecycleFixture({
        effectiveScenario: actual,
        systemd: { units: [{ profile: 'web', active: true }] },
      })
      const manifestBefore = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')
      const script = source === 'local' ? localInstaller : npmInstaller
      const result = runInstaller(script, [
        '--operation', 'upgrade', '--scenario', declared, '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', '1.4.0'] : []),
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

      expect(result.status).not.toBe(0)
      if (actual === 'supervised') expect(result.stderr).toMatch(/supervised|recovery|attestation/iu)
      else expect(result.stderr).toMatch(/scenario|场景|service-aware/iu)
      expect(await readFile(f.dshLog, 'utf8')).toContain('CALL\t--profile\tweb\t--dump-config\n')
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(manifestBefore)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      expect(await readFile(f.systemdLog, 'utf8')).toBe('')
      await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(f.activationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  test('scenario classifier treats a config-disabled Lark row beside web as web', async () => {
    const scenario = await classifyLifecycleScenario(`
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config:
    enabled: false
`)

    expect(scenario).toBe('web')
  })

  test.each([
    ['duplicate enabled Lark rows', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
- id: lark-owner-alias
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
`],
    ['duplicate config-disabled and enabled Lark rows', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: false }
- id: lark-owner-alias
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
`],
    ['malformed top-level disabled boolean', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  disabled: 'false'
  config: { enabled: true }
`],
    ['malformed Lark enabled boolean', `
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: 'false' }
`],
    ['mixed enabled Lark and web rows', `
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
- id: dsh-enhanced-lark-channel
  name: '@dsh-enhanced/lark-channel'
  config: { enabled: true }
`],
  ])('scenario classifier fails closed for %s', async (_label, source) => {
    await expect(classifyLifecycleScenario(source)).rejects.toThrow()
  })

  test('npm Lark upgrade dry-run describes service safety without registry or systemd access', async () => {
    const f = await lifecycleFixture({
      effectiveScenario: 'lark',
      systemd: { units: [{ profile: 'web', active: true }] },
    })

    const result = runInstaller(npmInstaller, [
      '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped',
      '--plugin-version', 'latest', '--dry-run',
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Lark service-aware upgrade (Linux systemd --user)')
    expect(result.stdout).toContain('runtime-mask')
    expect(result.stdout).toContain('fresh InvocationID journal readiness')
    expect(result.stdout).toContain('preserve both homes plus the bound manifest')
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    expect(await readFile(f.systemdLog, 'utf8')).toBe('')
  })

  test('local and npm Lark upgrade entry points dispatch the service-aware executor', async () => {
    const local = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const localResult = runInstaller(join(local.fixtureInstallDirectory, 'install-local.sh'), [
      '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
    ], local.dshHome, 'Linux', lifecycleEnvironment(local.dshHome, local.fakeBin))

    expect(localResult.status, localResult.stderr).toBe(0)
    expect((await readLifecycleSystemdLog(local.systemdLog)).some(command => command[1] === 'stop')).toBe(true)

    const npm = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const npmResult = runInstaller(join(npm.fixtureInstallDirectory, 'install-npm.sh'), [
      '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--plugin-version', '1.4.0', '--yes',
    ], npm.dshHome, 'Linux', lifecycleEnvironment(npm.dshHome, npm.fakeBin))

    expect(npmResult.status, npmResult.stderr).toBe(0)
    expect((await readLifecycleSystemdLog(npm.systemdLog)).some(command => command[1] === 'stop')).toBe(true)
    expect(await readFile(npm.operationLog, 'utf8')).toContain('npm-view')
  }, 15_000)

  test.each(['web', 'autonomy'] as const)('keeps the %s lifecycle on the stopped-home path', async scenario => {
    const f = await lifecycleFixture({ effectiveScenario: scenario, systemd: {} })

    const result = runInstaller(localInstaller, [
      '--operation', 'upgrade', '--scenario', scenario, '--confirm-dsh-home-stopped', '--dry-run',
    ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('profile 生命周期事务（upgrade）')
    expect(result.stdout).not.toMatch(/systemctl|journalctl/iu)
  })

  test('service-aware upgrade quiesces every profile in the canonical DSH_HOME and restores only the active set', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true, dropIn: 'keyring' },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const keyringPath = join(f.systemdHome, '.config', 'systemd', 'user', 'dsh-profile-web.service.d', 'keyring.conf')
    const keyringBefore = await readFile(keyringPath, 'utf8')

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
    )

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands).toContainEqual([
      '--user', 'list-unit-files', '--type=service', '--no-legend', '--no-pager', 'dsh-profile-*.service',
    ])
    expect(commands).toContainEqual([
      '--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager',
      'dsh-profile-*.service',
    ])
    const stopIndex = commands.findIndex(command => command[1] === 'stop')
    const stop = commands.find(command => command[1] === 'stop')
    expect(new Set(stop?.slice(2))).toEqual(new Set([
      'dsh-profile-web.service', 'dsh-profile-worker.service', 'dsh-profile-dormant.service',
    ]))
    const starts = commands.filter(command => command[1] === 'start')
    expect(starts).toHaveLength(1)
    expect(new Set(starts[0]?.slice(2))).toEqual(new Set(['dsh-profile-web.service', 'dsh-profile-worker.service']))
    expect(starts.flat()).not.toContain('dsh-profile-dormant.service')
    expect(commands.some(command => command[1] === 'disable' || command[1] === 'enable')).toBe(false)
    expect(stopIndex).toBeLessThan(commands.findIndex(command => command[1] === 'start'))
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'active', subState: 'running', starts: 1, nRestarts: 0,
    })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({
      activeState: 'active', subState: 'running', starts: 1, nRestarts: 0,
    })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', starts: 0, mainPid: 0, unitFileState: 'enabled',
    })
    expect(state.units['dsh-profile-web.service']?.invocationId).toMatch(/^fresh-web-/u)
    expect(state.units['dsh-profile-worker.service']?.invocationId).toMatch(/^fresh-worker-/u)
    expect(await readFile(keyringPath, 'utf8')).toBe(keyringBefore)
    expect(await preservedLifecycleTransactions(f.dshHome), result.stderr).toEqual([])

    const journals = await readLifecycleSystemdLog(f.journalLog)
    for (const profile of ['web', 'worker']) {
      expect(journals).toEqual(expect.arrayContaining([expect.arrayContaining([
        '--unit', `dsh-profile-${profile}.service`,
        expect.stringMatching(new RegExp(`^_SYSTEMD_INVOCATION_ID=fresh-${profile}-`, 'u')),
        '--output=cat', '--no-pager',
      ])]))
    }
  }, 15_000)

  test('service-aware upgrade treats a canonical home alias as the same service home', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const aliasHome = join(f.root, 'home-alias')
    await symlink(f.dshHome, aliasHome, 'dir')
    const unitName = 'dsh-profile-web.service'
    const state = await readLifecycleSystemdState(f.systemdState)
    const unit = state.units[unitName]!
    unit.serviceHome = aliasHome
    await writeFile(unit.fragmentPath, createSystemdUserUnit({
      unitName,
      unitPath: unit.fragmentPath,
      dshHome: aliasHome,
      profile: 'web',
      profileDirectory: join(aliasHome, 'profiles', 'web'),
      nodePath: process.execPath,
      dshPath: join(f.fakeBin, 'dsh'),
      path: `${dirname(process.execPath)}:${f.fakeBin}:/usr/bin:/bin`,
    }), { mode: 0o600 })
    await writeFile(f.systemdState, `${JSON.stringify(state)}\n`, { mode: 0o600 })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop' && command.includes('dsh-profile-web.service'))).toBe(true)
    expect(commands.some(command => command[1] === 'start' && command.includes('dsh-profile-web.service'))).toBe(true)
  }, 15_000)

  test.each([
    ['missing target unit', []],
    ['same unit name for another home', [{ profile: 'web', active: true, dshHome: '__other__' }]],
    ['foreign fragment', [{ profile: 'web', active: true, fragment: 'foreign' }]],
    ['unknown drop-in', [{ profile: 'web', active: true, dropIn: 'unknown' }]],
    ['unsafe keyring drop-in', [{ profile: 'web', active: true, dropIn: 'unsafe-keyring' }]],
  ] as const)('service-aware upgrade rejects %s before stopping or creating a transaction', async (_label, units) => {
    const f = await lifecycleFixture({ systemd: { units } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/service|systemd|unit|drop-in|fragment|DSH_HOME|受管|安全|权限/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a supervised sibling makes a Lark upgrade fail before mask, stop, or transaction creation', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdSupervisedProfile: 'worker' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/supervised|recovery|attestation/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'mask' || command[1] === 'stop')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each([
    ['stop failure', { systemdStopFailsProfile: 'worker' }],
    ['residual PID', { systemdPidStuckProfile: 'worker' }],
  ] as const)('service-aware upgrade handles %s before package preparation and restores the original active set', async (_label, failure) => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, failure,
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/stop|停止|PID|quiesc|静止|service|systemd|systemctl/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', subState: 'running' })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', subState: 'running' })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
  }, 15_000)

  test('service-aware package failure keeps the old home and restores only the original active services', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageFails: true },
    )

    expect(result.status).not.toBe(0)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
  }, 15_000)

  test('runtime masks prevent an external start during package preparation', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { packageExternalStartProfile: 'worker' },
    )

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const stopIndex = commands.findIndex(command => command[1] === 'stop')
    const attemptedStartIndexes = commands.map((command, index) => ({ command, index }))
      .filter(({ command }) => command[1] === 'start' && command.includes('dsh-profile-worker.service'))
      .map(({ index }) => index)
    expect(attemptedStartIndexes.some(index => index > stopIndex)).toBe(true)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-worker.service'])
      .toMatchObject({ activeState: 'active', starts: 1 })
  }, 15_000)

  test('filesystem mask and persistent disable barrier are established before stop', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: false },
    ] } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const stopIndex = commands.findIndex(command => command[1] === 'stop')
    const startIndex = commands.findIndex(command => command[1] === 'start')
    expect(commands.some(command => command[1] === 'disable' || command[1] === 'enable')).toBe(false)
    expect(stopIndex).toBeLessThan(startIndex)
  }, 15_000)

  test('restores an originally disabled active unit without enabling it', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true, enabled: false }] } })
    const wantsPath = join(
      f.systemdHome, '.config', 'systemd', 'user', 'default.target.wants', 'dsh-profile-web.service',
    )

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', unitFileState: 'disabled', starts: 1 })
    await expect(lstat(wantsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('refuses a pre-existing user.control mask without stopping or unlinking it', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const controlDirectory = join(f.systemdHome, '.config', 'systemd', 'user.control')
    const maskPath = join(controlDirectory, 'dsh-profile-web.service')
    await mkdir(controlDirectory, { recursive: true, mode: 0o700 })
    await symlink('/dev/null', maskPath)
    const maskBefore = await lstat(maskPath)
    const homeBefore = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/mask|systemd|绑定|身份/iu)
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.some(command => command[1] === 'stop' || command[1] === 'unmask')).toBe(false)
    expect(await readlink(maskPath)).toBe('/dev/null')
    const maskAfter = await lstat(maskPath)
    expect({ dev: maskAfter.dev, ino: maskAfter.ino }).toEqual({ dev: maskBefore.dev, ino: maskBefore.ino })
    expect(await lifecycleIdentity(f.dshHome)).toEqual(homeBefore)
    await expect(stat(join(f.dshHome, 'profiles', 'web', 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('refuses to unlink a user.control mask whose dev/ino was replaced after ownership was recorded', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const maskPath = join(f.systemdHome, '.config', 'systemd', 'user.control', 'dsh-profile-web.service')

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdReplaceControlMaskOnUnmaskProfile: 'web' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/mask|identity|身份|绑定/iu)
    expect(await readlink(maskPath)).toBe('/dev/null')
    const state = await readLifecycleSystemdState(f.systemdState)
    const replacement = await lstat(maskPath)
    expect({ dev: String(replacement.dev), ino: String(replacement.ino) })
      .toEqual(state.units['dsh-profile-web.service'].replacementMaskIdentity)
  }, 15_000)

  test('a pre-existing runtime mask is never unmasked or converted into lifecycle-owned state', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: false, runtimeMasked: true }] } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status).not.toBe(0)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'].unitFileState)
      .toBe('masked-runtime')
    expect((await readLifecycleSystemdLog(f.systemdLog)).some(command => command[1] === 'unmask')).toBe(false)
    await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('post-swap start-intent crash recovery contains the unit before restarting it', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdCrashBeforeStartProfile: 'web' },
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8')))
      .toMatchObject({ version: 2, state: 'swapped', servicePhase: 'starting' })
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'inactive', unitFileState: 'disabled' })
    const observationsBeforeRecovery = (await readLifecycleSystemdState(f.systemdState)).stopObservations?.length ?? 0
    const beforeRecovery = (await readLifecycleSystemdLog(f.systemdLog)).length

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    const recoveryCommands = (await readLifecycleSystemdLog(f.systemdLog)).slice(beforeRecovery)
    const stopIndex = recoveryCommands.findIndex(command => command[1] === 'stop')
    const startIndex = recoveryCommands.findIndex(command => command[1] === 'start')
    expect(stopIndex).toBeGreaterThanOrEqual(0)
    expect(stopIndex).toBeLessThan(startIndex)
    const recoveryStops = (await readLifecycleSystemdState(f.systemdState)).stopObservations?.slice(observationsBeforeRecovery) ?? []
    expect(recoveryStops[0]).toMatchObject({ unit: 'dsh-profile-web.service', maskPresent: true })
  }, 15_000)

  test('guardian stops a started unit when the lifecycle parent dies after start', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdKillLifecycleDuringStartProfile: 'web' },
    )

    let state = await readLifecycleSystemdState(f.systemdState)
    expect(state.controls.lifecycleParentKilled).toBe(true)
    expect(result.status).not.toBe(0)
    const deadline = Date.now() + 5_000
    while ((state.units['dsh-profile-web.service']?.activeState !== 'inactive'
      || state.units['dsh-profile-web.service']?.mainPid !== 0) && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      state = await readLifecycleSystemdState(f.systemdState)
    }
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
  }, 15_000)

  test('guardian exits nonzero after parent disconnect even when containment succeeds', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { guardianDisconnectAfterStart: true },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/service crash guardian failed with exit 1/u)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
  }, 15_000)

  test('guardian retries transient census failures through two complete censuses and contains only same-home units', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'foreign', active: true, dshHome: '__other__' },
    ] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      {
        guardianDisconnectAfterStart: true,
        systemdDynamicProfile: 'late',
        systemdGuardianListUnitFilesFailureBudget: 1,
        systemdGuardianListUnitsFailureBudget: 1,
        systemdGuardianOwnershipShowFailureBudget: 1,
        systemdGuardianOwnershipShowFailsProfile: 'late',
      },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/service crash guardian failed with exit 1/u)
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
    expect(state.units['dsh-profile-late.service']).toMatchObject({
      activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
    })
    expect(state.units['dsh-profile-foreign.service']).toMatchObject({
      activeState: 'active', subState: 'running',
    })
    expect(state.controls).toMatchObject({
      guardianListUnitFilesFailuresRemaining: 0,
      guardianListUnitsFailuresRemaining: 0,
      guardianOwnershipShowFailuresRemaining: 0,
    })
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    const lastStartIndex = commands.findLastIndex(command => command[1] === 'start')
    const firstCensusIndex = commands.findIndex((command, index) => index > lastStartIndex
      && command[1] === 'list-unit-files')
    const firstGuardianStopIndex = commands.findIndex((command, index) => index > lastStartIndex
      && command[1] === 'stop' && command.includes('dsh-profile-web.service'))
    expect(firstGuardianStopIndex).toBeGreaterThanOrEqual(0)
    expect(firstGuardianStopIndex).toBeLessThan(firstCensusIndex)
    const dynamicShowIndex = commands.findIndex(command => command[1] === 'show'
      && command[2] === 'dsh-profile-late.service'
      && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory'))
    expect(dynamicShowIndex).toBeGreaterThanOrEqual(0)
    const ownershipShows = commands.filter(command => command[1] === 'show'
      && command[2] === 'dsh-profile-late.service'
      && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory'))
    expect(ownershipShows.length).toBeGreaterThanOrEqual(3)
    expect(commands.filter(command => command[1] === 'list-unit-files').length).toBeGreaterThanOrEqual(4)
    expect(commands.filter(command => command[1] === 'list-units').length).toBeGreaterThanOrEqual(4)
    expect(commands.filter(command => command[1] === 'stop'
      && command.includes('dsh-profile-late.service')).length).toBeGreaterThanOrEqual(2)
    expect(commands.some(command => command[1] === 'stop'
      && command.includes('dsh-profile-foreign.service'))).toBe(false)
  }, 15_000)

  test('guardian keeps retrying persistent ownership failures until it is explicitly killed', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const lifecycle = startServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      {
        guardianDisconnectAfterStart: true,
        systemdDynamicProfile: 'late',
        systemdGuardianOwnershipShowFailureBudget: 100,
        systemdGuardianOwnershipShowFailsProfile: 'late',
      },
    )

    try {
      const deadline = Date.now() + 6_000
      let retryCount = 0
      while (Date.now() < deadline) {
        const commands = await readLifecycleSystemdLog(f.systemdLog)
        retryCount = commands.filter(command => command[1] === 'show'
          && command[2] === 'dsh-profile-late.service'
          && command.includes('--property=Environment') && command.includes('--property=WorkingDirectory')).length
        if (retryCount >= 2) break
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      }
      expect(retryCount).toBeGreaterThanOrEqual(2)
      expect(lifecycle.child.exitCode).toBeNull()
      expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service']).toMatchObject({
        activeState: 'inactive', subState: 'dead', mainPid: 0, controlPid: 0,
      })
      if (lifecycle.child.pid === undefined) throw new Error('lifecycle test process has no pid')
      process.kill(-lifecycle.child.pid, 'SIGKILL')
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      const contender = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      )
      expect(contender.status).not.toBe(0)
      expect(contender.stderr).toMatch(/busy|lock|正在|并发|占用/iu)
    } finally {
      const guardianPid = Number(await readFile(join(f.root, 'guardian.pid'), 'utf8').catch(() => '0'))
      if (Number.isSafeInteger(guardianPid) && guardianPid > 1) {
        try { process.kill(-guardianPid, 'SIGKILL') } catch {}
      }
      if (lifecycle.child.pid !== undefined && lifecycle.child.exitCode === null) {
        try { process.kill(-lifecycle.child.pid, 'SIGKILL') } catch {}
      }
      await lifecycle.done
    }
  }, 15_000)

  test('guardian also stops a dynamic same-home unit when the lifecycle parent dies', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdDynamicProfile: 'late', systemdKillLifecycleDuringStartProfile: 'web' },
    )

    expect(result.status).not.toBe(0)
    let state = await readLifecycleSystemdState(f.systemdState)
    const deadline = Date.now() + 5_000
    while ((state.units['dsh-profile-late.service']?.activeState !== 'inactive'
      || state.units['dsh-profile-late.service']?.mainPid !== 0) && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      state = await readLifecycleSystemdState(f.systemdState)
    }
    expect(state.controls.lifecycleParentKilled).toBe(true)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'inactive', mainPid: 0 })
    expect(state.units['dsh-profile-late.service']).toMatchObject({ activeState: 'inactive', mainPid: 0 })
  }, 15_000)

  test('dynamic same-home containment persists a bound mask ledger and reuses it on retry', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdDynamicProfile: 'late' },
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const firstManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    const containment = firstManifest.containmentMasks.find((mask: { unit: string }) => (
      mask.unit === 'dsh-profile-late.service'
    ))
    expect(containment).toMatchObject({ target: '/dev/null' })
    const installed = await lstat(containment.path)
    expect({ dev: String(installed.dev), ino: String(installed.ino), uid: installed.uid, mode: installed.mode })
      .toEqual(containment.identity)

    const second = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(second.status).not.toBe(0)
    expect(second.stderr).toMatch(/inventory|universe|发生变化/iu)
    expect(second.stderr).not.toMatch(/接管既有|身份不匹配|mask.*冲突/iu)
    const secondManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(secondManifest.containmentMasks).toEqual(firstManifest.containmentMasks)
    expect(await readlink(containment.path)).toBe('/dev/null')
  }, 15_000)

  test('production lifecycle source cannot enable fake service tools through environment variables', async () => {
    const source = await readFile(join(installDirectory, 'lifecycle-profile.mjs'), 'utf8')

    expect(source).not.toContain('DSH_ENHANCED_TEST_SERVICE_TOOLS')
    expect(source).not.toContain('LIFECYCLE_SYSTEMD_STATE')
    expect(source).toMatch(/entry\.uid !== 0/u)
    expect(source).toMatch(/\['\/usr\/bin', '\/bin'\]\.includes\(dirname\(canonical\)\)/u)
  })

  test('production guardian is detached from the lifecycle process group and contains on terminal signals', async () => {
    const source = await readFile(join(installDirectory, 'lifecycle-profile.mjs'), 'utf8')

    expect(source).toMatch(/const guardian = spawn\(process\.execPath,[\s\S]*?detached: true/du)
    expect(source).toContain("stdio: ['pipe', 'pipe', 'inherit', 3, 4, 5]")
    expect(source).toContain(
      "for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, beginContainment)",
    )
  })

  test('service-aware upgrade handles v1 residue before any transaction rename or deletion', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const stagedHome = join(transaction, 'staged-home')
    await mkdir(stagedHome, { recursive: true })
    await writeFile(join(stagedHome, 'legacy-v1-marker'), 'preserve')
    await writeBoundLifecycleManifest({
      dshHome: f.dshHome, originalHome: f.dshHome, stagedHome, state: 'failed',
    })
    await writeFile(join(transaction, 'legacy-v1-marker'), 'present-before-stop')

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)
    const state = await readLifecycleSystemdState(f.systemdState)
    const commands = await readLifecycleSystemdLog(f.systemdLog)

    if (commands.some(command => command[1] === 'stop')) {
      expect(state.stopLegacyMarkerExists).toBe(true)
      expect(state.units['dsh-profile-web.service'].maskPresentWhenStopped).toBe(true)
    } else {
      expect(result.status).not.toBe(0)
      expect(await readFile(join(transaction, 'legacy-v1-marker'), 'utf8')).toBe('present-before-stop')
    }
  }, 15_000)

  test('unreadable proc views fail closed for a same-UID process that is not dsh-like', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const opaque = spawn('/usr/bin/python3', ['-c', [
      'import ctypes, time',
      'ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)',
      "print('ready', flush=True)",
      'time.sleep(30)',
    ].join(';')], { cwd: f.root, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveReady, rejectReady) => {
      opaque.once('error', rejectReady)
      opaque.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [opaque.pid!] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/无法.*进程|cannot.*process|proc/iu)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
    } finally {
      opaque.kill('SIGKILL')
    }
  }, 15_000)

  test.each([
    ['cwd', 'import time; print("ready", flush=True); time.sleep(30)'],
    ['fd', 'import os,time; handle=os.open(".", os.O_RDONLY|os.O_DIRECTORY); os.chdir(".."); print("ready", flush=True); time.sleep(30)'],
  ] as const)('a same-UID unmanaged process with %s inside DSH_HOME blocks package work and restores services', async (_reference, source) => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)
    const unmanaged = spawn('/usr/bin/python3', ['-c', source], {
      cwd: f.dshHome, stdio: ['ignore', 'pipe', 'ignore'],
    })
    await new Promise<void>((resolveReady, rejectReady) => {
      unmanaged.once('error', rejectReady)
      unmanaged.stdout.once('data', () => resolveReady())
    })
    try {
      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { systemdProcPids: [unmanaged.pid!] },
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/inventory.*outside|unmanaged|进程.*引用|拒绝继续/iu)
      expect(await readFile(f.operationLog, 'utf8')).toBe('')
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
    } finally {
      unmanaged.kill('SIGKILL')
    }
  }, 15_000)

  test.each(['cwd', 'fd'] as const)('a lifecycle process ancestor with %s inside DSH_HOME is still a strong reference', async reference => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { processAncestorReference: reference },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/inventory.*outside|unmanaged|进程.*引用|拒绝继续/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
  }, 15_000)

  test('a PID appearing before rename prevents the home swap', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdQuiescenceDriftProfile: 'worker' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/inactive|PID0|quiesc|静止|systemd/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.dshHome, 'profiles', 'web', 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  test('an originally inactive target upgrades without being started and is unmasked afterward', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: false },
      { profile: 'worker', active: true },
    ] } })

    const result = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(result.status, result.stderr).toBe(0)
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({
      activeState: 'inactive', mainPid: 0, starts: 0, unitFileState: 'enabled',
    })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    const commands = await readLifecycleSystemdLog(f.systemdLog)
    expect(commands.find(command => command[1] === 'start')).not.toContain('dsh-profile-web.service')
    expect(commands.some(command => command[1] === 'enable' || command[1] === 'disable')).toBe(false)
    await expect(readlink(join(
      f.systemdHome, '.config', 'systemd', 'user', 'default.target.wants', 'dsh-profile-web.service',
    ))).resolves.toBe(join(f.systemdHome, '.config', 'systemd', 'user', 'dsh-profile-web.service'))
  }, 15_000)

  test.each([
    ['start failure', { systemdStartFailsProfile: 'web' }],
    ['start success followed by an immediate failed state', { systemdReadinessFailsProfile: 'web' }],
    ['fresh invocation without readiness', { systemdJournal: 'stale' as const }],
    ['journal query failure', { systemdJournal: 'fail' as const }],
    ['journal command disappearance', { systemdJournal: 'missing' as const }],
    ['restart loop', { systemdRestartLoopProfile: 'web' }],
  ])('service-aware upgrade preserves both homes and bound evidence after %s', async (_label, failure) => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, failure,
    )

    expect(result.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 2, operation: 'upgrade', profile: 'web', servicePhase: 'service-failed' })
    expect(manifest.services).toHaveLength(3)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    expect(await readFile(join(f.dshHome, 'profiles', 'web', 'upgraded'), 'utf8')).toBe('upgraded\n')
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(Object.values(state.units)).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'web', activeState: 'inactive', mainPid: 0 }),
      expect.objectContaining({ profile: 'worker', activeState: 'inactive', mainPid: 0 }),
      expect.objectContaining({ profile: 'dormant', activeState: 'inactive', mainPid: 0 }),
    ]))
  }, 15_000)

  test('service-failed recovery reaccepts the swapped home without repeating package preparation', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })

    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' },
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8')))
      .toMatchObject({ version: 2, state: 'service-failed', servicePhase: 'service-failed' })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)

    const second = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'ready' },
    )

    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toMatch(/重新验收|恢复|完成/iu)
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 2 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 2 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', starts: 0 })
  }, 15_000)

  test('service-failed recovery that fails again preserves both homes and does not repeat package work', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' },
    )

    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const firstManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(firstManifest).toMatchObject({ version: 2, state: 'service-failed', servicePhase: 'service-failed' })
    const stagedIdentity = await lifecycleIdentity(f.dshHome)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)

    const second = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { systemdReadinessFailsProfile: 'web' },
    )

    expect(second.status).not.toBe(0)
    expect(second.stderr).toMatch(/readiness|failed|验收|失败/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(stagedIdentity)
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    const secondManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(secondManifest).toMatchObject({
      version: 2, id: firstManifest.id, state: 'service-failed', servicePhase: 'service-failed',
    })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(Object.values(state.units)).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: 'web', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
      expect.objectContaining({ profile: 'worker', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
      expect.objectContaining({ profile: 'dormant', activeState: 'inactive', mainPid: 0, controlPid: 0 }),
    ]))
  }, 15_000)

  test('v2 original-renamed crash recovery restores the original home and active service set', async () => {
    const f = await lifecycleFixture({ systemd: { units: [
      { profile: 'web', active: true },
      { profile: 'worker', active: true },
      { profile: 'dormant', active: false },
    ] } })
    const originalIdentity = await lifecycleIdentity(f.dshHome)

    const crashed = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { killLifecycleAfterOriginalRename: true },
    )

    expect(crashed.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    await expect(stat(f.dshHome)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await lifecycleIdentity(join(transaction, 'original-home'))).toEqual(originalIdentity)
    const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(crashManifest).toMatchObject({
      version: 2, state: 'original-renamed', servicePhase: 'stopped', originalIdentity,
    })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stderr).toMatch(/original-renamed|原 home.*active service set/iu)
    expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
    await expect(stat(join(f.dshHome, 'profiles', 'web', 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
    const preserved = await preservedLifecycleTransactions(f.dshHome)
    expect(preserved).toHaveLength(1)
    expect(JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8')))
      .toMatchObject({ version: 2, id: crashManifest.id, state: 'original-renamed', servicePhase: 'stopped' })
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
    expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
  }, 15_000)

  test.each(['local', 'npm'] as const)(
    'public %s Lark upgrade recovers real original-renamed v2 residue before new work and requires retry',
    async source => {
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
      ] } })
      const originalIdentity = await lifecycleIdentity(f.dshHome)
      const crashed = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
        { killLifecycleAfterOriginalRename: true },
      )
      expect(crashed.status).not.toBe(0)
      const transaction = `${f.dshHome}.dsh-enhanced-transaction`
      const crashManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
      expect(crashManifest).toMatchObject({ version: 2, state: 'original-renamed', expectedScenario: 'lark' })
      const operationsBeforeRecovery = await readFile(f.operationLog, 'utf8')
      expect(operationsBeforeRecovery.match(/^dsh-add\t/gmu)).toHaveLength(1)

      const script = source === 'local' ? localInstaller : npmInstaller
      const recovered = runInstaller(script, [
        '--operation', 'upgrade', '--scenario', 'lark', '--confirm-dsh-home-stopped', '--yes',
        ...(source === 'npm' ? ['--plugin-version', '1.4.0'] : []),
      ], f.dshHome, 'Linux', lifecycleEnvironment(f.dshHome, f.fakeBin))

      expect(recovered.status).not.toBe(0)
      expect(recovered.stderr).toMatch(/恢复|recovery|重试/iu)
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBeforeRecovery)
      expect(operationsBeforeRecovery).not.toMatch(/^npm-view|^pnpm-store-add/mu)
      await expect(stat(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toHaveLength(1)
      expect(JSON.parse(await readFile(join(preserved[0]!, 'manifest.json'), 'utf8')))
        .toMatchObject({ version: 2, id: crashManifest.id, state: 'original-renamed' })
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
    },
    15_000,
  )

  test.each([
    ['post-package', { configAfterUpgrade: `- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'` }],
    ['post-activation', { configAfterActivation: `- id: dsh-enhanced-assistant-web-owner\n  name: '@dsh-enhanced/assistant-web-owner'` }],
  ] as const)('service-aware upgrade rejects %s scenario drift before swap and restores the original active set',
    async (phase, drift) => {
      const f = await lifecycleFixture({ systemd: { units: [
        { profile: 'web', active: true },
        { profile: 'worker', active: true },
        { profile: 'dormant', active: false },
      ] } })
      const originalIdentity = await lifecycleIdentity(f.dshHome)
      const originalConfig = await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')
      const originalManifest = await readFile(join(f.profileDirectory, 'package.json'), 'utf8')

      const result = runServiceLifecycle(
        ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, drift,
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/scenario|场景|lark|web/iu)
      expect(await lifecycleIdentity(f.dshHome)).toEqual(originalIdentity)
      expect(await readFile(join(f.dshHome, '.lifecycle-dump-config'), 'utf8')).toBe(originalConfig)
      expect(await readFile(join(f.profileDirectory, 'package.json'), 'utf8')).toBe(originalManifest)
      expect(readLifecycleDatabase(f.databasePath)).toEqual({ userVersion: 1, values: ['durable-goal-state'] })
      await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readFile(f.operationLog, 'utf8')).match(/^dsh-add\t/gmu)).toHaveLength(1)
      const state = await readLifecycleSystemdState(f.systemdState)
      expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-worker.service']).toMatchObject({ activeState: 'active', starts: 1 })
      expect(state.units['dsh-profile-dormant.service']).toMatchObject({ activeState: 'inactive', mainPid: 0, starts: 0 })
      await expect(stat(`${f.dshHome}.dsh-enhanced-transaction`)).rejects.toMatchObject({ code: 'ENOENT' })
      const preserved = await preservedLifecycleTransactions(f.dshHome)
      expect(preserved).toHaveLength(1)
      const stagedActivationMarker = join(preserved[0]!, 'staged-home', '.activation-ran')
      if (phase === 'post-activation') expect(await readFile(stagedActivationMarker, 'utf8')).toBe('')
      else await expect(stat(stagedActivationMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    },
    15_000,
  )

  test('cleanup-started recovery without original-home freshly reaccepts and does not repeat package work', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })
    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdJournal: 'stale' },
    )
    expect(first.status).not.toBe(0)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const manifestPath = join(transaction, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await rm(join(transaction, 'original-home'), { recursive: true })
    const cleanupStarted = { ...manifest, state: 'cleanup-started', servicePhase: 'service-accepted' }
    const rebound = {
      ...cleanupStarted,
      updatedAt: '2026-09-09T12:00:00.000Z',
      bindingDigest: createHash('sha256').update(JSON.stringify(serviceLifecycleBinding(cleanupStarted))).digest('hex'),
    }
    await writeFile(manifestPath, `${JSON.stringify(rebound, null, 2)}\n`, { mode: 0o600 })
    const before = await readFile(f.operationLog, 'utf8')
    setLifecycleSystemdControls(f.systemdState, { systemdJournal: 'ready' })

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stdout).toMatch(/重新验收|恢复|完成/iu)
    expect(await readFile(f.operationLog, 'utf8')).toBe(before)
    expect(await preservedLifecycleTransactions(f.dshHome), recovered.stderr).toEqual([])
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', starts: 2 })
  }, 15_000)

  test('canonical cleanup failure preserves a bound transaction and the next run cleans it without repeating package work', async () => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true }] } })

    const first = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin,
      { canonicalCleanupFails: true },
    )

    expect(first.status).not.toBe(0)
    expect(first.stderr).toMatch(/canonical.*cleanup|清理失败|residue/iu)
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    const firstManifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(firstManifest).toMatchObject({
      version: 2, state: 'cleanup-started', servicePhase: 'service-accepted',
    })
    expect(firstManifest.transactionIdentity).toMatchObject(await lifecycleIdentity(transaction))
    expect(firstManifest.originalIdentity).toMatchObject(await lifecycleIdentity(join(transaction, 'original-home')))
    const operationsBeforeRecovery = await readFile(f.operationLog, 'utf8')
    expect(operationsBeforeRecovery.match(/^dsh-add\t/gmu)).toHaveLength(1)

    const recovered = runServiceLifecycle(['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin)

    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stdout).toMatch(/重新验收|恢复|完成/iu)
    expect(await preservedLifecycleTransactions(f.dshHome)).toEqual([])
    expect(await readFile(f.operationLog, 'utf8')).toBe(operationsBeforeRecovery)
    expect((await readLifecycleSystemdState(f.systemdState)).units['dsh-profile-web.service'])
      .toMatchObject({ activeState: 'active', starts: 2 })
  }, 15_000)

  test.each(['hash', 'identity'] as const)('service-aware upgrade rejects keyring drop-in %s drift before swap', async mutation => {
    const f = await lifecycleFixture({ systemd: { units: [{ profile: 'web', active: true, dropIn: 'keyring' }] } })

    const result = runServiceLifecycle(
      ['web', f.dshHome, '0', f.lifecycleTarget], f.dshHome, f.fakeBin, { systemdDropInMutation: mutation },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/drop-in|identity|hash|摘要|身份|变化/iu)
    await expect(stat(join(f.profileDirectory, 'upgraded'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.operationLog, 'utf8')).toBe('')
    const state = await readLifecycleSystemdState(f.systemdState)
    expect(state.units['dsh-profile-web.service']).toMatchObject({ activeState: 'inactive', subState: 'dead' })
    const transaction = `${f.dshHome}.dsh-enhanced-transaction`
    expect(await lifecycleIdentity(f.dshHome)).toBeDefined()
    const manifest = JSON.parse(await readFile(join(transaction, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ version: 2, operation: 'upgrade', profile: 'web' })
  }, 15_000)

  test('lifecycle transactions reject state paths outside the snapshotted DSH_HOME', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' '    databasePath: /srv/shared/state.sqlite'
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: resolves outside canonical DSH_HOME')
  })

  test('lifecycle state-path validation fails closed for escaping dshHomePath expressions', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' "    databasePath: !!js dshHomePath('../shared/state.sqlite')"
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: only a non-empty relative dshHomePath expression is allowed')
  })

  test('lifecycle state-path validation fails closed for default dshHomePath expressions', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'home')
    const fakeBin = join(root, 'bin')
    await mkdir(dshHome)
    await mkdir(fakeBin)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
printf '%s\n' '- id: custom-state' "  name: '@dsh-enhanced/personal-assistant'" '  config:' '    databasePath: !!js dshHomePath()'
`)

    const result = spawnSync('/bin/bash', ['-c', 'source "$1"; dsh_enhanced_validate_lifecycle_state_paths web "$2"',
      'state-path-test', installerLibrary, dshHome], {
      cwd: repoRoot, encoding: 'utf8', env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('lifecycle configuration rejects custom-state.databasePath: only a non-empty relative dshHomePath expression is allowed')
  })

  test('keeps the shared installer compatible with macOS Bash 3.2 empty-array semantics', async () => {
    const source = await readFile(installerLibrary, 'utf8')

    expect(source).not.toMatch(/\b(?:mapfile|readarray)\b/u)
    expect(source).not.toMatch(/\|\s+(?:LC_ALL=C\s+)?sort -V/u)
    expect(source).toContain('if [[ -n "${selected_slugs[0]+set}" ]]')
    expect(source).toContain('if [[ -n "${add_ons[0]+set}" ]]')
    expect(source).toContain('${overlay_args[@]+"${overlay_args[@]}"}')
  })

  test.skipIf(pinnedRemoteCommon === undefined || pinnedRemoteCommon.status !== 0)('remote bootstrap hash matches its pinned release asset when that tag is available locally', async () => {
    // A shallow checkout may not contain release tags.  The test deliberately
    // skips there instead of using the network; release-version fixture tests
    // separately cover future pin rewriting.
    const pinnedHash = pinnedInstallerSource.match(/^DSH_ENHANCED_PINNED_COMMON_SHA256='([0-9a-f]{64})'$/mu)?.[1]

    expect(pinnedHash).toBe(createHash('sha256').update(pinnedRemoteCommon!.stdout).digest('hex'))
  })

  test('remote lifecycle helper pins are both zero sentinels or both release hashes', () => {
    expect(pinnedLifecycleConfigHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(pinnedLifecycleProfileHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(pinnedLifecycleConfigHash === zeroSha256).toBe(pinnedLifecycleProfileHash === zeroSha256)
  })

  test.skipIf(
    pinnedLifecycleConfigHash === undefined
      || pinnedLifecycleProfileHash === undefined
      || pinnedLifecycleConfigHash === zeroSha256
      || pinnedLifecycleProfileHash === zeroSha256
      || pinnedRemoteLifecycleConfig === undefined
      || pinnedRemoteLifecycleConfig.status !== 0
      || pinnedRemoteLifecycleProfile === undefined
      || pinnedRemoteLifecycleProfile.status !== 0,
  )('remote lifecycle helper hashes match their pinned release assets when that tag is available locally', () => {
    expect(pinnedLifecycleConfigHash).toBe(
      createHash('sha256').update(pinnedRemoteLifecycleConfig!.stdout).digest('hex'),
    )
    expect(pinnedLifecycleProfileHash).toBe(
      createHash('sha256').update(pinnedRemoteLifecycleProfile!.stdout).digest('hex'),
    )
  })

  test('remote npm install with lifecycle zero sentinels downloads, verifies, and sources only common.sh', async () => {
    const fixture = await remoteBootstrapFixture()
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'])

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(fixture.logPath, 'utf8')).toBe([
      'download\thttps://assets.invalid/v9.8.7/common.sh',
      'verify\tcommon.sh',
      'source:common',
      'run\tnpm\t\t--dry-run',
      '',
    ].join('\n'))
    expect(await readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).toBe('mutated\n')
    expect(await readdir(fixture.temporaryDirectory)).toEqual([])
  })

  test('remote npm bootstrap rejects an unsafe custom TMPDIR before download or source', async () => {
    const fixture = await remoteBootstrapFixture()
    await chmod(fixture.temporaryDirectory, 0o777)
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/TMPDIR|temporary|临时/iu)
    await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(fixture.temporaryDirectory)).toEqual([])
  })

  test('remote npm bootstrap rejects a private TMPDIR beneath a foreign-owned ancestor before download or source',
    async () => {
      const fixture = await remoteBootstrapFixture()
      const foreignAncestor = join(fixture.temporaryDirectory, 'foreign-ancestor')
      const privateTmp = join(foreignAncestor, 'private-tmp')
      await mkdir(foreignAncestor, { mode: 0o755 })
      await mkdir(privateTmp, { mode: 0o700 })
      const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

      const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'], {
        foreignStatPath: foreignAncestor,
        temporaryDirectory: privateTmp,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/TMPDIR|临时目录祖先所有者不受信任/iu)
      await expect(stat(fixture.logPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(fixture.dshHome, 'bootstrap-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(privateTmp)).toEqual([])
    },
  )

  test('remote npm bootstrap accepts a private custom TMPDIR', async () => {
    const fixture = await remoteBootstrapFixture()
    const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

    const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, ['--dry-run'])

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(fixture.logPath, 'utf8')).toContain('source:common\n')
    expect(await readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).toBe('mutated\n')
    expect(await readdir(fixture.temporaryDirectory)).toEqual([])
  })

  test.each(['upgrade', 'uninstall'] as const)(
    'remote npm %s with lifecycle zero sentinels fails before downloads or source',
    async operation => {
      const fixture = await remoteBootstrapFixture()
      const zeroPinnedInstallerSource = withPinnedLifecycleHashes(pinnedInstallerSource, zeroSha256, zeroSha256)

      const result = runRemoteNpmBootstrap(zeroPinnedInstallerSource, fixture, [
        '--operation', operation, '--confirm-dsh-home-stopped', '--scenario', 'web', '--dry-run',
      ])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('固定发布未包含已校验的 lifecycle helper')
      await expect(readFile(fixture.logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(fixture.temporaryDirectory)).toEqual([])
    },
  )

  test.each(['upgrade', 'uninstall'] as const)(
    'remote npm %s lifecycle bootstrap downloads one release cohort and verifies every asset before source',
    async operation => {
      const fixture = await remoteBootstrapFixture()

      const result = runRemoteNpmBootstrap(pinnedInstallerSource, fixture, [
        '--operation', operation, '--confirm-dsh-home-stopped', '--scenario', 'web', '--dry-run',
      ], { lifecycleDigests: true })

      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(fixture.logPath, 'utf8')).toBe([
        'download\thttps://assets.invalid/v9.8.7/common.sh',
        'verify\tcommon.sh',
        'download\thttps://assets.invalid/v9.8.7/lifecycle-config.mjs',
        'download\thttps://assets.invalid/v9.8.7/lifecycle-profile.mjs',
        'verify\tlifecycle-config.mjs',
        'verify\tlifecycle-profile.mjs',
        'source:common',
        `run\tnpm\t\t--operation\t${operation}\t--confirm-dsh-home-stopped\t--scenario\tweb\t--dry-run`,
        '',
      ].join('\n'))
      expect(await readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).toBe('mutated\n')
      expect(await readdir(fixture.temporaryDirectory)).toEqual([])
    },
  )

  test.each(['common.sh', 'lifecycle-config.mjs', 'lifecycle-profile.mjs'] as const)(
    'remote npm lifecycle bootstrap rejects tampered %s before source or home mutation',
    async tamperedAsset => {
      const fixture = await remoteBootstrapFixture()

      const result = runRemoteNpmBootstrap(pinnedInstallerSource, fixture, [
        '--operation', 'upgrade', '--confirm-dsh-home-stopped', '--scenario', 'web', '--dry-run',
      ], { lifecycleDigests: true, tamper: tamperedAsset })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('远程 ' + tamperedAsset + ' 完整性校验失败')
      const log = await readFile(fixture.logPath, 'utf8')
      expect(log).not.toContain('source:common')
      expect(log).not.toContain('\nrun\t')
      await expect(readFile(join(fixture.dshHome, 'bootstrap-ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(fixture.temporaryDirectory)).toEqual([])
    },
  )

  test('collects an interactive model route before its npm cohort is preflighted', async () => {
    const source = await readFile(installerLibrary, 'utf8')
    const routeSelection = source.indexOf('dsh_enhanced_prompt_model_route model_provider model_name model_base_url model_api model_display_name')
    const cohortPreflight = source.indexOf('dsh_enhanced_resolve_npm_cohort "$plugin_version" "$dry_run"')

    expect(routeSelection).toBeGreaterThan(-1)
    expect(cohortPreflight).toBeGreaterThan(routeSelection)
  })

  test('local installer defaults to the safe core scenario with capability discovery and excludes optional bundles', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：web')
    expect(result.stdout).toContain('部署场景：core')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'plugin-control-plane'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-policy'))
    expect(result.stdout).not.toContain('部署模式：')
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'acp'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'hello'))
    expect(result.stdout).toContain('Agent 工具授权：preserve')
    expect(result.stdout).toContain('权限默认值：保留现有 Settings')
    expect(result.stdout).toContain('立即使用：dsh --profile web')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('standard Lark installs automatic preference learning without the supervised operations stack', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip', '--agent-tools', 'disable',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('Agent 工具授权：disable')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')} `
      + '--profile web --refresh-agent-policy --disable-agent-tools',
    )
    expect(result.stdout).not.toContain('--install-service')
  })

  test('repairs the legacy Evolution-to-Evaluation bundle closure without expanding Lark into supervised', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify({
      dependencies: { '@dsh-enhanced/assistant-evolution': '0.1.7' },
      dsh: { profile: { bundles: ['@dsh-enhanced/assistant-evolution'] } },
    }, null, 2), 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--scenario', 'lark', '--lark', 'skip',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('旧 profile 含 assistant-evolution 但缺少 assistant-evaluation')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
  })

  test('explicit standard is byte-for-byte the default dry-run and does not mount Evolution', async () => {
    const implicitHome = await temporaryDshHome()
    const explicitHome = await temporaryDshHome()

    const implicit = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], implicitHome)
    const explicit = runInstaller(localInstaller, ['--dry-run', '--mode', 'standard', '--lark', 'skip'], explicitHome)

    expect(implicit.status, implicit.stderr).toBe(0)
    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout.replaceAll(explicitHome, '<DSH_HOME>')).toBe(
      implicit.stdout.replaceAll(implicitHome, '<DSH_HOME>'),
    )
    expect(explicit.stdout).not.toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(explicit.stdout).not.toContain('dsh-supervised-growth-setup')
  })

  test('npm installer tracks the latest DSH and applies one release selector to every published bundle', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', 'personal-web', '--plugin-version', '0.2.0',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('目标 profile：personal-web')
    expect(result.stdout).toContain('@deepseek-ai/dsh@latest')
    expect(result.stdout).toContain('@dsh-enhanced/personal-assistant@0.2.0')
    expect(result.stdout).toContain('@dsh-enhanced/plugin-control-plane@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/lark-channel@0.2.0')
    expect(result.stdout).not.toContain('@dsh-enhanced/acp@')
    expect(result.stdout).not.toContain('@dsh-enhanced/hello@')
  })

  test('npm cohort preflight resolves latest once from the personal-assistant anchor and verifies every bundle', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
  view)
    case "$2" in
      @dsh-enhanced/personal-assistant@latest|@dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0|@dsh-enhanced/traex-acp-provider@1.4.0)
        printf '%s\\n' '"1.4.0"'
        ;;
      *) exit 9 ;;
    esac
    ;;
  *) exit 9 ;;
esac
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort "$2" "$3" personal-assistant plugin-control-plane traex-acp-provider; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary, 'latest', '0',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('resolved=1.4.0')
    expect(await readFile(logPath, 'utf8')).toBe([
      'view @dsh-enhanced/personal-assistant@latest version --json',
      'view @dsh-enhanced/personal-assistant@1.4.0 version --json',
      'view @dsh-enhanced/plugin-control-plane@1.4.0 version --json',
      'view @dsh-enhanced/traex-acp-provider@1.4.0 version --json',
      '',
    ].join('\n'))
  })

  test('npm cohort preflight rejects a partial publication before any profile command can run', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    const profileLogPath = join(root, 'profile.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$2" in
  @dsh-enhanced/personal-assistant@latest|@dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0)
    printf '%s\\n' '"1.4.0"'
    ;;
  @dsh-enhanced/assistant-delivery@1.4.0)
    printf '%s\\n' '"1.3.9"'
    ;;
  *) exit 9 ;;
esac
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane assistant-delivery || exit $?; printf profile-mutated >> "$PROFILE_LOG"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath, PROFILE_LOG: profileLogPath },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@dsh-enhanced/assistant-delivery@1.4.0')
    await expect(readFile(profileLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('npm cohort preflight resolves the same anchor again on a repeated install', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
printf '%s\\n' '"1.4.0"'
`)

    const result = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane && dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant plugin-control-plane',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect((await readFile(logPath, 'utf8')).match(/@latest version --json/g)?.length).toBe(2)
    expect((await readFile(logPath, 'utf8')).match(/@1\.4\.0 version --json/g)?.length).toBe(4)
  })

  test('npm cohort preflight keeps an explicit exact version and makes dry-run registry-free', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$2" in
  @dsh-enhanced/personal-assistant@1.4.0|@dsh-enhanced/plugin-control-plane@1.4.0) printf '%s\\n' '"1.4.0"' ;;
  *) exit 9 ;;
esac
`)

    const explicit = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort 1.4.0 0 personal-assistant plugin-control-plane; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const dryRun = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 1 personal-assistant plugin-control-plane; printf "resolved=%s\\n" "$DSH_ENHANCED_RESOLVED_PLUGIN_VERSION"',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const environmentDefault = spawnSync('/bin/bash', [
      npmInstaller, '--dry-run', '--lark', 'skip',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        DSH_HOME: join(root, 'dsh-home'),
        DSH_ENHANCED_VERSION: '1.4.0',
        NPM_LOG: logPath,
      },
    })

    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout).toContain('resolved=1.4.0')
    expect(await readFile(logPath, 'utf8')).toContain('view @dsh-enhanced/personal-assistant@1.4.0 version --json')
    expect(dryRun.status, dryRun.stderr).toBe(0)
    expect(dryRun.stdout).toContain('resolved=<npm-anchor:latest>')
    expect(dryRun.stdout).toContain('不会访问 npm registry')
    expect(environmentDefault.status, environmentDefault.stderr).toBe(0)
    expect(environmentDefault.stdout).toContain('@dsh-enhanced/personal-assistant@1.4.0')
    expect((await readFile(logPath, 'utf8')).match(/\n/g)?.length).toBe(3)
  })

  test('npm cohort preflight rejects malformed registry data and unsafe selectors without running a command', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'npm.log')
    const markerPath = join(root, 'selector-ran')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf '%s\\n' "$*" >> "$NPM_LOG"
printf '%s\\n' '{not-json'
`)

    const malformed = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort latest 0 personal-assistant',
      'installer-test', installerLibrary,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })
    const unsafe = spawnSync('/bin/bash', [
      '-c',
      'source "$1"; dsh_enhanced_resolve_npm_cohort "latest; touch $2" 0 personal-assistant',
      'installer-test', installerLibrary, markerPath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_LOG: logPath },
    })

    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('无效的版本数据')
    expect(unsafe.status).toBe(2)
    expect(unsafe.stderr).toContain('不支持 range')
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(logPath, 'utf8')).toBe('view @dsh-enhanced/personal-assistant@latest version --json\n')
  })

  test('npm supervised dry-run describes one unresolved anchor cohort for every required bundle', async () => {
    const dshHome = await temporaryDshHome()
    const installer = await readFile(npmInstaller, 'utf8')
    const release = installer.match(/^DSH_ENHANCED_PINNED_RELEASE_REF='v([^']+)'$/mu)?.[1]
    expect(release).toMatch(/^\d+\.\d+\.\d+$/u)

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--scenario', 'supervised', '--lark', 'configure',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    const selected = [...result.stdout.matchAll(/@dsh-enhanced\/([a-z0-9-]+)@([^\s]+)/gu)]
    expect(selected.length).toBeGreaterThan(0)
    expect(result.stdout).toContain('npm cohort（dry-run）：将先解析 @dsh-enhanced/personal-assistant@latest 的精确版本')
    expect(result.stdout).toContain('<npm-anchor:latest>')
    const slugs = new Set(selected.map(match => match[1]))
    for (const required of [
      'personal-assistant', 'assistant-delivery', 'assistant-evaluation',
      'assistant-evolution', 'assistant-growth-experiments', 'preference-learning', 'assistant-heartbeat',
      'assistant-health', 'assistant-recovery', 'lark-channel',
    ]) expect(slugs.has(required), `missing ${required}`).toBe(true)
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000')
  })

  test('npm installer with its sibling common uses the source verified host range', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(npmInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('超出 dsh-enhanced 已验证范围 >=0.1.2-rc.1 <0.2.0')
  })

  test('remote npm installer exports the verified range paired with its pinned common', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const remoteCommon = join(root, 'common.sh')
    await mkdir(fakeBin, { recursive: true })
    await writeFile(remoteCommon, [
      '#!/usr/bin/env bash',
      'dsh_enhanced_install() {',
      "  printf 'remote-range=%s\\n' \"$DSH_ENHANCED_VERIFIED_HOST_RANGE\"",
      '}',
      '',
    ].join('\n'), 'utf8')
    await writeExecutable(join(fakeBin, 'curl'), `#!/bin/bash
cp "$REMOTE_COMMON" "$4"
`)
    const commonHash = createHash('sha256').update(await readFile(remoteCommon)).digest('hex')
    const installer = await readFile(npmInstaller, 'utf8')
    const releaseManifest = JSON.parse(await readFile(join(repoRoot, 'release-manifest.json'), 'utf8'))
    const pinnedRange = installer.match(
      /^DSH_ENHANCED_PINNED_VERIFIED_HOST_RANGE='([^']+)'$/mu,
    )?.[1]
    expect(pinnedRange).toBe(releaseManifest.current.verifiedHostRange)

    const result = spawnSync('/bin/bash', ['-s', '--', '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
      input: installer,
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: join(root, 'dsh-home'),
        DSH_ENHANCED_INSTALL_BASE_URL: 'https://installer.invalid/v0.1.24',
        DSH_ENHANCED_INSTALL_COMMON_SHA256: commonHash,
        REMOTE_COMMON: remoteCommon,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`remote-range=${pinnedRange}`)
    expect(result.stdout).not.toContain('remote-range=>=0.1.2-rc.1 <0.2.0')
  })

  test('refuses incompatible stored permission defaults before changing the installation', async () => {
    for (const preset of ['read-only', 'unrecognized-local-preset']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status).toBe(2)
      expect(result.stderr).toContain(`permission.defaultPreset=${preset}`)
      expect(result.stderr).toContain('不会覆盖用户设置')
      expect(result.stdout).not.toContain('dsh plugin')
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('preserves every supported stored permission default', async () => {
    for (const preset of ['workspace-write', 'auto', 'danger-full-access']) {
      const dshHome = await temporaryDshHome()
      const settingsPath = join(dshHome, 'settings.yaml')
      await writeFile(settingsPath, `permission:\n  defaultPreset: ${preset}\n`, 'utf8')
      const before = await readFile(settingsPath, 'utf8')

      const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

      expect(result.status, result.stderr).toBe(0)
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
    }
  })

  test('Recovery README primary command installs every activator dependency then invokes it after Lark onboarding', async () => {
    const dshHome = await temporaryDshHome()
    const readme = await readFile(join(repoRoot, 'plugins', 'assistant-recovery', 'README.md'), 'utf8')
    const documentedCommand = readme.match(/^\.\/scripts\/install\/install-local\.sh --scenario supervised --lark configure$/mu)?.[0]
    expect(documentedCommand).toBeDefined()
    const [, ...documentedArgs] = documentedCommand!.split(/\s+/u)

    const result = runInstaller(localInstaller, [
      '--dry-run', ...documentedArgs,
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署模式：supervised-growth')
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'personal-assistant'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-delivery'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'lark-channel'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evolution'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-evaluation'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-growth-experiments'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'preference-learning'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-heartbeat'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-health'))
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'assistant-recovery'))
    expect(result.stdout).not.toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    expect(result.stdout).toContain('dsh-lark-setup --profile web')
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000')
    expect(result.stdout).not.toContain('overlay：未应用')
  })

  test('supervised-growth installs TraeX only when explicitly requested', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--with', 'traex',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
  })

  test('selected supervised bundles compose into a real effective tree accepted by the activator', async () => {
    const dshHome = await temporaryDshHome()
    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure',
    ], dshHome)
    expect(result.status, result.stderr).toBe(0)

    const installedRows = await composeSelectedBundleRows(result.stdout)
    const lark = installedRows.find(row => row.id === 'dsh-enhanced-lark-channel')
    expect(lark).toBeDefined()
    lark.config = { ...lark.config, enabled: true, account: 'primary', tenant: 'personal' }
    const effectiveBefore = stringify(installedRows)
    const binding = {
      id: 'binding-owner-dm',
      conversation: { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'oc_owner' },
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' },
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      sessionId: 'session-owner', generation: 1, policyRef: 'owner-dm', status: 'active',
      createdAt: 1, updatedAt: 1, version: 1,
    } as const
    const overlay = parse(configureSupervisedGrowthProfilePatch({
      profilePatch: '[]\n', effectiveConfig: effectiveBefore, dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    }), yamlOptions) as any[]
    const composed = new Map(installedRows.map(row => [row.id, row]))
    for (const row of overlay) composed.set(row.id, row)

    expect(assertEffectiveSupervisedGrowthConfig({
      effectiveConfig: stringify([...composed.values()]), dshHome, binding,
      activationState: 'preview',
      activationNonce: 'installer-compose-preview',
      recoveryCatalogDigest: RECOVERY_CATALOG_DIGEST,
    })).toMatchObject({
      workspace: join(dshHome, 'assistant-workspace'),
      agentPreset: 'standard',
      activationState: 'preview',
      automationId: 'recovery:supervised-growth',
    })
  })

  test('supervised-growth passes an explicit acknowledgement only to its activator', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'configure', '--ack-existing-automations',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('dsh-supervised-growth-setup --profile web --timeout-ms 300000 --ack-existing-automations')
  })

  test('supervised-growth refuses to run without an owner onboarding path', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'supervised-growth', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('supervised-growth 需要飞书 onboarding')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('rejects an unknown deployment mode before planning installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--mode', 'unbounded', '--lark', 'skip',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--mode 只能是 standard 或 supervised-growth')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('matches npm SemVer precedence and excludes prereleases without a same-core comparator', () => {
    const result = spawnSync('/bin/bash', [
      '-c', [
        'source "$1"',
        'dsh_enhanced_version_ge 0.1.0-rc.8 0.1.0-rc.7',
        '! dsh_enhanced_version_ge 0.1.0-rc.7 0.1.0-rc.8',
        'dsh_enhanced_version_ge 0.1.0 0.1.0-rc.8',
        '! dsh_enhanced_version_ge 0.1.0-rc.8 0.1.0',
        'dsh_enhanced_version_ge 0.1.2-rc.1 0.1.0-rc.8',
        'dsh_enhanced_version_ge 0.1.2-rc.10 0.1.2-rc.2',
        '! dsh_enhanced_version_ge 0.1.2-rc.2 0.1.2-rc.10',
        'dsh_enhanced_version_ge 0.1.2-rc.beta 0.1.2-rc.1',
        '! dsh_enhanced_version_ge 0.1.2-rc.1 0.1.2-rc.beta',
        'dsh_enhanced_version_ge 0.1.2-rc.1.0 0.1.2-rc.1',
        '! dsh_enhanced_version_ge 0.1.2-rc.1 0.1.2-rc.1.0',
        'dsh_enhanced_version_ge 0.1.2+build.2 0.1.2+build.1',
        'dsh_enhanced_version_ge 0.1.2+build.1 0.1.2+build.2',
        "dsh_enhanced_version_in_range 0.1.2-rc.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2-rc.2 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2-rc.1.0 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.2+build.1 '>=0.1.2-rc.1 <0.2.0'",
        "dsh_enhanced_version_in_range 0.1.3 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.2-alpha.9 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.2-rc.0 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.1.3-alpha.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.2.0-alpha.1 '>=0.1.2-rc.1 <0.2.0'",
        "! dsh_enhanced_version_in_range 0.2.0 '>=0.1.2-rc.1 <0.2.0'",
      ].join('\n'),
      'installer-test', installerLibrary,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
  })

  test('resolves latest but preserves an installed newer DSH version', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.3\n'; fi
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\n'; fi
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_ensure_dsh latest 0 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, INSTALL_LOG: logPath },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('DSH latest 已解析为：0.1.2-rc.1')
    expect(result.stdout).toContain('保留现有版本，避免降级')
    expect(await readFile(logPath, 'utf8')).toBe('npm view @deepseek-ai/dsh dist-tags.latest\n')
  })

  test('requires explicit acknowledgement for a host outside the verified range', async () => {
    const dshHome = await temporaryDshHome()
    const blocked = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8',
    ], dshHome)
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain('超出 dsh-enhanced 已验证范围 >=0.1.2-rc.1 <0.2.0')
    expect(blocked.stderr).toContain('--ack-unverified-host')
    expect(blocked.stdout).not.toContain('dsh plugin')

    const acknowledged = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--dsh-version', '0.1.0-rc.8', '--ack-unverified-host',
    ], dshHome)
    expect(acknowledged.status, acknowledged.stderr).toBe(0)
    expect(acknowledged.stderr).toContain('已确认继续使用未经验证的 DSH host 版本')
    expect(acknowledged.stdout).toContain('@deepseek-ai/dsh@0.1.0-rc.8')
  })

  test('local installer replaces an incompatible DSH and executes build, install, and validation', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    const setupDirectory = join(dshHome, 'profiles', 'web', 'node_modules', '.bin')
    await mkdir(setupDirectory, { recursive: true })
    await writeExecutable(join(setupDirectory, 'dsh-lark-setup'), `#!/bin/bash
printf 'lark-setup %s\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.0.0\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh-new'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
printf 'npm %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; exit 0; fi
if [[ "$*" == 'install --global @deepseek-ai/dsh@0.1.2-rc.1' ]]; then
  cp "$FAKE_BIN/dsh-new" "$FAKE_BIN/dsh"
  chmod 755 "$FAKE_BIN/dsh"
fi
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)

    const result = spawnSync('/bin/bash', [localInstaller, '--lark', 'skip'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_BIN: fakeBin,
        FAKE_PREFIX: root,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('npm install --global @deepseek-ai/dsh@0.1.2-rc.1')
    expect(log).toContain('pnpm install')
    expect(log).toContain('pnpm build')
    expect(log).toContain('dsh plugin --profile web add')
    expect(log).toContain('dsh --profile web --dump-config')
    expect(log).toContain('dsh --profile web --host 127.0.0.1 --no-open --port 0')
    expect(log).not.toContain('lark-setup')
  })

  test('fails before Feishu onboarding when a real activation probe reports a pending service', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await writeFile(join(dshHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: {
        '@dsh-enhanced/assistant-evolution': '0.1.7',
        '@dsh-enhanced/assistant-evaluation': '0.1.7',
      },
    }, null, 2), 'utf8')
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf '%s\\n' 'Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate' >&2
  printf '%s\\n' '@dsh-enhanced/assistant-evolution: pending (waiting for service: assistantEvaluation)' >&2
  exit 1
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$INSTALL_LOG"
EOF
  chmod 755 "$bin/dsh-lark-setup"
fi
`)

    const result = spawnSync('/bin/bash', [
      localInstaller, '--scenario', 'lark', '--lark', 'skip', '--no-service', '--yes',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('waiting for service: assistantEvaluation')
    expect(result.stderr).toContain('尚未继续飞书授权、凭据写入或常驻服务启动')
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('--no-open --port 0')
    expect(log).not.toContain('lark-setup')
    expect(log).not.toContain('systemctl --user show-environment')
  })

  test('supervised-growth invokes the installed activator only after the installed Lark setup completes', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const logPath = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await configureExistingLark(dshHome)
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
if [[ "\${1:-}" == 'prefix' ]]; then printf '%s\\n' "$FAKE_PREFIX"; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
printf 'pnpm %s\\n' "$*" >> "$INSTALL_LOG"
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'yes\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "\${1:-}" == '--user' && "\${2:-}" == 'show' ]]; then
  printf '%s\\n' 'ActiveState=active' 'SubState=running' 'NRestarts=0' 'ExecMainStatus=0'
fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$INSTALL_LOG"
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$INSTALL_LOG"
EOF
  cat > "$bin/dsh-supervised-growth-setup" <<'EOF'
#!/bin/bash
printf 'supervised-setup %s\\n' "$*" >> "$INSTALL_LOG"
printf 'supervised growth activated\\n'
EOF
  chmod 755 "$bin/dsh-lark-setup" "$bin/dsh-supervised-growth-setup"
fi
`)

    const result = spawnSync('/bin/bash', [localInstaller, '--mode', 'supervised-growth', '--lark', 'keep', '--yes'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        INSTALL_LOG: logPath,
        FAKE_PREFIX: root,
        DSH_ENHANCED_SERVICE_STABILITY_SECONDS: '0',
        // The fake bin stubs systemd tooling, so pin the detected platform
        // instead of inheriting the host's own `uname -s`.
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'Linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('supervised growth activated')
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('systemctl --user show-environment')
    expect(log).toContain('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(log).toContain('systemctl --user show dsh-profile-web.service')
    expect(log).toContain('loginctl show-user')
    expect(log).not.toContain('--no-open --port 0')
    const larkSetup = log.indexOf('lark-setup --profile web --install-service')
    const activator = log.indexOf('supervised-setup --profile web --timeout-ms 300000')
    const serviceDoctor = log.indexOf('systemctl --user is-active --quiet dsh-profile-web.service')
    expect(larkSetup).toBeGreaterThanOrEqual(0)
    expect(activator).toBeGreaterThan(larkSetup)
    expect(serviceDoctor).toBeGreaterThan(activator)
  })

  test('Linux service stability verification stops a restart loop and reports its journal', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const showCount = join(root, 'show-count')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == '--user' && "\${2:-}" == 'show' ]]; then
  count=0
  if [[ -f "$SHOW_COUNT" ]]; then count="$(cat "$SHOW_COUNT")"; fi
  count=$((count + 1))
  printf '%s' "$count" > "$SHOW_COUNT"
  if [[ "$count" == '1' ]]; then restarts=0; else restarts=1; fi
  printf 'ActiveState=active\\nSubState=running\\nNRestarts=%s\\nExecMainStatus=0\\n' "$restarts"
fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'journalctl'), `#!/bin/bash
printf 'journalctl %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' 'simulated DSH activation failure'
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_verify_linux_service_stability web',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        SHOW_COUNT: showCount,
        DSH_ENHANCED_SERVICE_STABILITY_SECONDS: '0',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('restarts=0->1')
    expect(result.stderr).toContain('simulated DSH activation failure')
    expect(result.stderr).toContain('已停止该服务以避免无限重启')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain('systemctl --user show dsh-profile-web.service')
    expect(log).toContain('journalctl --user -u dsh-profile-web.service -n 80 --no-pager')
    expect(log).toContain('systemctl --user stop dsh-profile-web.service')
  })

  test('checks TraeX login before changing its global default or restarting the managed Lark service', async () => {
    const root = await temporaryDshHome()
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await configureExistingLark(dshHome)
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    await writeFile(join(dshHome, 'settings.yaml'), originalSettings, 'utf8')
    await writeExecutable(join(fakeBin, 'node'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf 'v24.7.0\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'npm'), `#!/bin/bash
if [[ "$*" == 'view @deepseek-ai/dsh dist-tags.latest' ]]; then printf '0.1.2-rc.1\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
if [[ "\${1:-}" == 'show-user' ]]; then printf 'yes\\n'; fi
exit 0
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
exit 0
`)
    await writeExecutable(join(fakeBin, 'traex'), `#!/bin/bash
if [[ "\${1:-}" == 'login' && "\${2:-}" == 'status' ]]; then
  printf '%s\\n' 'not logged in'
  exit 1
fi
exit 1
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
printf 'dsh %s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" == *'--dump-config'* ]]; then
  printf '%s\\n' "name: '@dsh-enhanced/traex-acp-provider'"
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  bin="$DSH_HOME/profiles/web/node_modules/.bin"
  mkdir -p "$bin"
  cat > "$bin/dsh-lark-setup" <<'EOF'
#!/bin/bash
printf 'lark-setup %s\\n' "$*" >> "$COMMAND_LOG"
EOF
  cat > "$bin/dsh-model-setup" <<'EOF'
#!/bin/bash
printf 'model-setup %s\\n' "$*" >> "$COMMAND_LOG"
EOF
  chmod 755 "$bin/dsh-lark-setup" "$bin/dsh-model-setup"
fi
`)

    const result = spawnSync('/bin/bash', [
      localInstaller, '--scenario', 'lark', '--lark', 'keep', '--model-provider', 'traex-agent', '--yes',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSH_HOME: dshHome,
        COMMAND_LOG: commandLog,
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('traex 未确认登录')
    const log = await readFile(commandLog, 'utf8')
    expect(log).not.toContain('model-setup --dsh-home')
    expect(log).not.toContain('systemctl --user restart dsh-profile-web.service')
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(originalSettings)
  })

  test('agent-route rollback restores the exact pre-write settings and profile patch', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const settingsPath = join(dshHome, 'settings.yaml')
    const profilePatch = join(profileDirectory, 'cordis.patch.yml')
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    const originalPatch = '# owner overlay\n[]\n'
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(settingsPath, originalSettings, 'utf8')
    await writeFile(profilePatch, originalPatch, 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', [
        'source "$1"',
        'snapshot="$(dsh_enhanced_snapshot_agent_route_configuration "$2" "$3")" || exit $?',
        "printf 'agent-default-model:\\n  provider: traex-agent\\n' > \"$3/settings.yaml\"",
        "printf '%s\\n' '- id: dsh-enhanced-traex-acp-provider' '  config: { enabled: true }' > \"$3/profiles/$2/cordis.patch.yml\"",
        'dsh_enhanced_restore_agent_route_configuration "$snapshot" "$2" "$3"',
      ].join('\n'),
      'installer-test', installerLibrary, 'web', dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings)
    expect(await readFile(profilePatch, 'utf8')).toBe(originalPatch)
  })

  test('agent-route transaction restores files when SIGTERM lands after the model write', async () => {
    const dshHome = await temporaryDshHome()
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const settingsPath = join(dshHome, 'settings.yaml')
    const profilePatch = join(profileDirectory, 'cordis.patch.yml')
    const originalSettings = 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n'
    const originalPatch = '# owner overlay\n[]\n'
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(settingsPath, originalSettings, 'utf8')
    await writeFile(profilePatch, originalPatch, 'utf8')

    // `$$` is the pid of the subshell that installed the EXIT/TERM traps: inside
    // a `name() ( ... )` subshell function bash keeps `$$` pointing at that
    // shell, so the signal reaches the rollback owner. `$BASHPID` is unset on
    // macOS bash 3.2, and deriving a pid via `exec sh -c 'echo $PPID'` returns
    // the command substitution's own child instead, which exits 143 without ever
    // running the restore.
    //
    // Signalling `$$` is fatal to the shell that runs it, so the transaction runs
    // in a nested shell; the outer shell survives to observe its 143 and to keep
    // the rollback assertions below reachable.
    const result = spawnSync('/bin/bash', [
      '-c', [
        'inner=$(cat <<\'SCRIPT\'',
        'source "$1"',
        'dsh_enhanced_apply_model() {',
        `  printf 'agent-default-model:\\n  provider: traex-agent\\n' > "$2/settings.yaml"`,
        `  printf '%s\\n' '- id: dsh-enhanced-traex-acp-provider' > "$2/profiles/$1/cordis.patch.yml"`,
        '  kill -TERM "$$"',
        '}',
        'dsh_enhanced_verify_model_route() { return 1; }',
        'dsh_enhanced_apply_verified_agent_model "$2" "$3" traex-agent "" "" "" "" 0 1',
        'SCRIPT',
        ')',
        '/bin/bash -c "$inner" installer-test "$1" "$2" "$3"',
        'status=$?',
        '[[ "$status" == 143 ]]',
      ].join('\n'),
      'installer-test', installerLibrary, 'web', dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('已恢复原有 settings/profile patch')
    expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings)
    expect(await readFile(profilePatch, 'utf8')).toBe(originalPatch)
  })

  test('auto mode keeps an existing enabled Feishu bot and only restarts its service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    expect(result.stdout).toContain('检测到已有启用的 Lark channel；跳过临时 Host')
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const installService = `${larkSetup} --profile web --install-service`
    expect(result.stdout).toContain(installService)
    expect(result.stdout).not.toContain('--refresh-agent-policy')
  })

  test('recognizes a home-layer Lark binding as the effective profile binding', async () => {
    const dshHome = await temporaryDshHome()
    await writeFile(join(dshHome, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')

    const result = runInstaller(localInstaller, ['--dry-run', '--yes'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('部署场景：lark')
    expect(result.stdout).toContain('飞书处理：保留当前应用配置')
    expect(result.stdout).toContain('检测到已有启用的 Lark channel；跳过临时 Host')
  })

  test('a profile-layer Lark disable overrides a configured home layer', async () => {
    const dshHome = await temporaryDshHome()
    const profilePatch = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(dirname(profilePatch), { recursive: true })
    await writeFile(join(dshHome, 'cordis.patch.yml'), `- id: dsh-enhanced-lark-channel
  config:
    enabled: true
    appId: cli_0123456789abcdef
`, 'utf8')
    await writeFile(profilePatch, `- id: dsh-enhanced-lark-channel
  disabled: true
`, 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_lark_is_configured "$2" "$3"',
      'installer-test', installerLibrary, profilePatch, join(dshHome, 'cordis.patch.yml'),
    ], { encoding: 'utf8' })

    expect(result.status).toBe(1)
  })

  test('fresh configure mode preserves Agent tool reachability unless it is explicitly authorized', async () => {
    const dshHome = await temporaryDshHome()

    // The trailing assertions describe the Linux systemd preflight, so pin the
    // platform rather than depending on the host running this suite.
    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'configure'], dshHome, 'Linux')

    expect(result.status, result.stderr).toBe(0)
    const larkSetup = join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-lark-setup')
    const setupCommands = result.stdout
      .split('\n')
      .filter(line => line.includes('dsh-lark-setup'))
    expect(setupCommands).toEqual([
      `  $ ${larkSetup} --profile web`,
    ])
    expect(result.stdout).toContain('将在飞书授权前验证 user manager')
    expect(result.stdout).toContain('常驻服务与 Linux logout persistence')
  })

  test('Linux service preflight enables lingering without sudo before checking the user manager', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'id'), `#!/bin/bash
printf 'id %s\n' "$*" >> "$COMMAND_LOG"
printf '424242\n'
`)
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' && "\${2:-}" == 'enable-linger' ]]; then
  touch "$LINGER_STATE"
  exit 0
fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('已为当前用户启用 logout persistence')
    expect(result.stdout).toContain('user manager 与 logout persistence 已就绪')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`loginctl show-user ${process.geteuid?.() ?? process.getuid?.()}`)
    expect(log).toContain('loginctl --no-ask-password enable-linger')
    expect(log).toContain('systemctl --user show-environment')
    expect(log).not.toContain('sudo')
    expect(log).not.toContain('id -u')
  })

  test('Linux service preflight stops before OAuth when lingering needs explicit administrator approval', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then printf 'no\n'; exit 0; fi
exit 1
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_prepare_linux_resident_service 0',
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sudo loginctl enable-linger "$(id -u)"')
    expect(result.stderr).toContain('尚未开始飞书授权')
    const log = await readFile(commandLog, 'utf8')
    expect(log).not.toContain('systemctl')
  })

  test('interactive Linux preflight explains and runs exactly one fixed sudo action after confirmation', async () => {
    const root = await temporaryDshHome()
    const fakeBin = join(root, 'bin')
    const commandLog = join(root, 'commands.log')
    const lingerState = join(root, 'linger-enabled')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == 'show-user' ]]; then
  if [[ -f "$LINGER_STATE" ]]; then printf 'yes\n'; else printf 'no\n'; fi
  exit 0
fi
if [[ "\${1:-}" == '--no-ask-password' ]]; then exit 1; fi
if [[ "\${1:-}" == 'enable-linger' ]]; then touch "$LINGER_STATE"; exit 0; fi
exit 2
`)
    await writeExecutable(join(fakeBin, 'systemctl'), `#!/bin/bash
printf 'systemctl %s\n' "$*" >> "$COMMAND_LOG"
exit 0
`)
    await writeExecutable(join(fakeBin, 'sudo'), `#!/bin/bash
printf 'sudo %s\n' "$*" >> "$COMMAND_LOG"
if [[ "\${1:-}" == '--' ]]; then shift; fi
"$@"
`)

    const result = spawnSync('/bin/bash', [
      '-c', `source "$1"
dsh_enhanced_trusted_system_command() { printf '%s/%s\\n' "$FAKE_BIN" "$1"; }
dsh_enhanced_prepare_linux_resident_service 0 force`,
      'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '\n',
      env: {
        PATH: `${fakeBin}:/usr/bin:/bin`,
        COMMAND_LOG: commandLog,
        LINGER_STATE: lingerState,
        FAKE_BIN: fakeBin,
        DSH_ENHANCED_PLATFORM_OVERRIDE: 'linux',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('唯一的提权动作')
    expect(result.stderr).toContain('现在通过 sudo 启用？[Y/n]')
    expect(result.stdout).toContain('密码由 sudo 直接读取，不会进入安装器')
    const log = await readFile(commandLog, 'utf8')
    expect(log).toContain(`sudo -- ${join(fakeBin, 'loginctl')} enable-linger`)
    expect(log.match(/^sudo /gmu)).toHaveLength(1)
    expect(log).toContain('systemctl --user show-environment')
  })

  test('requires explicit confirmation before planning a danger-full-access default', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--permission', 'danger-full-access',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('--confirm-dangerous-full-access')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('prints the bounded headless model route check only when requested', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("dsh --profile headless Reply\\ with\\ exactly\\ DSH_ROUTE_READY")
  })

  test('an agent-route default verifies structurally instead of a headless model call', async () => {
    const dshHome = await temporaryDshHome()
    // The runtime resolves the settings.yaml user-layer selection, which is what
    // the verifier reads; a real run would have just written it.
    await writeFile(join(dshHome, 'settings.yaml'),
      'agent-default-model:\n  provider: traex-agent\n  model: default\n', 'utf8')

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-route', 'verify',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('agent route traex-agent 不发送模型请求')
    expect(result.stdout).toContain('校验 profile web 已注册适配器并检查本机登录')
    // No headless model call is planned for an agent route.
    expect(result.stdout).not.toContain('DSH_ROUTE_READY')
  })

  test('the effective-default reader returns the settings.yaml user-layer provider', async () => {
    const dshHome = await temporaryDshHome()
    await writeFile(join(dshHome, 'settings.yaml'),
      'ui-theme:\n  preference: dark\nagent-default-model:\n  provider: traex-agent\n  model: default\nllm-pi-ai:\n  providers: {}\n', 'utf8')

    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('traex-agent')
  })

  test('the effective-default reader also parses a flow-style settings document', async () => {
    // dsh-model-setup writes block style, but a hand-edited or legacy file may be
    // flow style; the reader must still resolve the provider so agent-route
    // verification does not fall back to a headless model call.
    const dshHome = await temporaryDshHome()
    const read = async (document: string): Promise<string> => {
      await writeFile(join(dshHome, 'settings.yaml'), document, 'utf8')
      const result = spawnSync('/bin/bash', [
        '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
      ], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout.trim()
    }

    expect(await read('{ agent-default-model: { provider: traex-agent, model: default } }\n')).toBe('traex-agent')
    expect(await read('{ ui-theme: { preference: dark }, agent-default-model: { provider: super-relay, model: glm5.2 } }\n')).toBe('super-relay')
    expect(await read('ui-theme:\n  preference: dark\n')).toBe('')
  })

  test('a fresh install then read resolves the agent-route provider end to end', async () => {
    // Regression for the flow-style serialization bug: with no prior settings
    // file, dsh-model-setup must write block-style YAML the installer can parse.
    const dshHome = await temporaryDshHome()
    const setupBin = join(repoRoot, 'plugins', 'personal-assistant', 'bin', 'dsh-model-setup.js')
    const write = spawnSync(process.execPath, [
      setupBin, '--dsh-home', dshHome, '--provider', 'traex-agent', '--enable-in-profile', 'web',
    ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dshHome } })
    expect(write.status, write.stderr).toBe(0)

    const read = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_effective_default_provider "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout.trim()).toBe('traex-agent')
  })

  test('non-interactive default keeps the composed model without configuring a route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, ['--dry-run', '--lark', 'skip'], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：本次跳过；使用 profile 已组合的默认模型。')
    expect(result.stdout).not.toContain('dsh-model-setup')
  })

  test('resolves dsh-model-setup from the pnpm shim, then falls back to a node-run package bin', async () => {
    const dshHome = await temporaryDshHome()
    const base = join(dshHome, 'profiles', 'web', 'node_modules')
    const binDir = join(base, '.bin')
    const paScript = join(base, '@dsh-enhanced', 'personal-assistant', 'bin', 'dsh-model-setup.js')
    const apScript = join(base, '@dsh-enhanced', 'assistant-policy', 'bin', 'dsh-model-setup.js')

    const resolve = (): { status: number | null; stdout: string } => spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_resolve_model_setup web "$2"', 'installer-test', installerLibrary, dshHome,
    ], { encoding: 'utf8' })

    // No launcher anywhere -> non-zero, no output.
    const none = resolve()
    expect(none.status).not.toBe(0)
    expect(none.stdout).toBe('')

    // Package bin present but no shim -> node fallback (prefers personal-assistant).
    await mkdir(join(base, '@dsh-enhanced', 'assistant-policy', 'bin'), { recursive: true })
    await writeFile(apScript, '// stub\n', 'utf8')
    const apOnly = resolve()
    expect(apOnly.status, apOnly.stdout).toBe(0)
    expect(apOnly.stdout).toBe(`node\n${apScript}\n`)

    await mkdir(join(base, '@dsh-enhanced', 'personal-assistant', 'bin'), { recursive: true })
    await writeFile(paScript, '// stub\n', 'utf8')
    const preferPa = resolve()
    expect(preferPa.stdout).toBe(`node\n${paScript}\n`)

    // An executable shim wins over the package bins.
    await mkdir(binDir, { recursive: true })
    await writeExecutable(join(binDir, 'dsh-model-setup'), '#!/bin/bash\nexit 0\n')
    const withShim = resolve()
    expect(withShim.stdout).toBe(`${join(binDir, 'dsh-model-setup')}\n`)
  })

  test('configuring deepseek-official plans an env-only key store into settings and credentials', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('模型配置：provider=deepseek-official model=deepseek-v4-flash')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --provider deepseek-official --model deepseek-v4-flash`,
    )
    // The key is never an argument; without one in the environment the plan
    // still writes the route and names the credential reference to set later.
    expect(result.stdout).toContain('未检测到 API Key，稍后请设置 DEEPSEEK_API_KEY')
    expect(result.stdout).not.toContain('--store-key')
  })

  test('an available key env var upgrades the deepseek plan to store the credential', async () => {
    const dshHome = await temporaryDshHome()

    const result = spawnSync('/bin/bash', [localInstaller,
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', DSH_HOME: dshHome, DSH_ENHANCED_MODEL_API_KEY: 'plat-secret' },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('把环境中的 API Key 存入 .credentials.yaml')
    expect(result.stdout).toContain('--provider deepseek-official --store-key')
  })

  test('a custom gateway route plans llm-pi-ai transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'super-relay', '--model-name', 'glm5.2',
      '--model-base-url', 'https://super-relay.example/v1', '--model-api', 'openai-completions',
      '--model-display-name', 'Super Relay',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      '--provider super-relay --model glm5.2 --base-url https://super-relay.example/v1'
      + ' --api openai-completions --display-name Super\\ Relay',
    )
  })

  test('rejects a custom gateway route without a base URL and deepseek with transport fields', async () => {
    const dshHome = await temporaryDshHome()

    const missingBaseUrl = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'super-relay', '--model-name', 'glm5.2',
    ], dshHome)
    expect(missingBaseUrl.status).toBe(2)
    expect(missingBaseUrl.stderr).toContain('自定义模型 provider 需要 --model-base-url')
    expect(missingBaseUrl.stdout).not.toContain('dsh plugin')

    const misplacedFields = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official', '--model-base-url', 'https://x/v1',
    ], dshHome)
    expect(misplacedFields.status).toBe(2)
    expect(misplacedFields.stderr).toContain('仅适用于自定义 provider')
    expect(misplacedFields.stdout).not.toContain('dsh plugin')
  })

  test('non-interactive configure without a provider guides the owner to the model flags', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model', 'configure',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('非交互配置模型需要 --model-provider')
  })

  test('restarts the resident service after (re)configuring the model on a managed profile', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    // Keeping the existing Feishu bot leaves a managed resident service, so a
    // model (re)configuration must restart it to load the new default/route.
    // The restart is delegated to the platform's own supervisor, so pin the
    // detected platform and assert both real branches.
    const linux = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'keep', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome, 'Linux')

    expect(linux.status, linux.stderr).toBe(0)
    expect(linux.stdout).toContain('常驻服务：将重启以加载新模型配置。')
    expect(linux.stdout).toContain('systemctl --user restart dsh-profile-web.service')

    const darwin = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'keep', '--model-provider', 'deepseek-official', '--model-name', 'deepseek-v4-flash',
    ], dshHome, 'Darwin')

    expect(darwin.status, darwin.stderr).toBe(0)
    expect(darwin.stdout).toContain('常驻服务：将重启以加载新模型配置。')
    expect(darwin.stdout).toContain('launchctl kickstart -k')
  })

  test('does not restart a service when the model step is skipped or no service is managed', async () => {
    const skipHome = await temporaryDshHome()
    const skipModel = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model', 'skip',
    ], skipHome)
    expect(skipModel.status, skipModel.stderr).toBe(0)
    expect(skipModel.stdout).not.toContain('常驻服务：将重启以加载新模型配置。')

    // core scenario configures a model but manages no channel/service.
    const coreHome = await temporaryDshHome()
    const core = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'deepseek-official',
    ], coreHome)
    expect(core.status, core.stderr).toBe(0)
    expect(core.stdout).not.toContain('常驻服务：将重启以加载新模型配置。')
  })

  test('model menu writes UI separately from its machine-readable selection', () => {
    const configured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 1', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '2\n' })
    expect(configured.status, configured.stderr).toBe(0)
    expect(configured.stdout).toBe('configure')
    expect(configured.stderr).toContain('检测到当前 profile 已能解析默认模型')

    const unconfigured = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_model_mode 0', 'installer-test', installerLibrary,
    ], { encoding: 'utf8', input: '\n' })
    expect(unconfigured.status, unconfigured.stderr).toBe(0)
    expect(unconfigured.stdout).toBe('configure')
    expect(unconfigured.stderr).toContain('尚未配置可用的默认模型')
  })

  test('selecting the local TraeX route plans bundle install, default selection, and profile enable', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    // The provider bundle is pulled into the top-level install set...
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'traex-acp-provider'))
    // ...and the default-model write enables the route in this profile's patch.
    expect(result.stdout).toContain('模型配置：provider=traex-agent')
    expect(result.stdout).toContain(
      `${join(dshHome, 'profiles', 'web', 'node_modules', '.bin', 'dsh-model-setup')} `
      + `--dsh-home ${dshHome} --provider traex-agent --enable-in-profile web`,
    )
    // Agent routes never touch an API key.
    expect(result.stdout).not.toContain('--store-key')
    expect(result.stdout).not.toContain('存入 .credentials.yaml')
    expect(result.stdout).toContain('无需 API Key')
    expect(result.stdout).toContain('本轮已配置 TraeX，正在执行免额度的适配器与登录校验')
    expect(result.stdout).toContain('agent route traex-agent 不发送模型请求')
    expect(result.stdout).not.toContain('DSH_ROUTE_READY')
  })

  test('rejects gateway transport fields on the TraeX agent route', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--model-provider', 'traex-agent', '--model-base-url', 'https://x/v1',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('不适用于本机 agent route traex-agent')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('the model prompt offers TraeX only when a local traex command is present', () => {
    const scriptWithTraex = 'export PATH="$2:$PATH"; source "$1"; '
      + 'dsh_enhanced_prompt_model_route p m b a d >/dev/null; printf "provider=%s" "$p"'
    const fakeBin = join(tmpdir(), `dsh-fake-traex-${Date.now()}`)

    return (async () => {
      await mkdir(fakeBin, { recursive: true })
      await writeExecutable(join(fakeBin, 'traex'), '#!/bin/bash\nexit 0\n')

      const withTraex = spawnSync('/bin/bash', ['-c', scriptWithTraex, 'installer-test', installerLibrary, fakeBin], {
        encoding: 'utf8', input: '3\n',
      })
      expect(withTraex.status, withTraex.stderr).toBe(0)
      expect(withTraex.stderr).toContain('本机 TraeX')
      expect(withTraex.stdout).toBe('provider=traex-agent')

      // Without a traex command on PATH, option 3 is not offered and is invalid.
      const withoutTraex = spawnSync('/bin/bash', [
        '-c', 'export PATH="/nonexistent-only"; source "$1"; dsh_enhanced_prompt_model_route p m b a d; printf "rc=%s" "$?"',
        'installer-test', installerLibrary,
      ], { encoding: 'utf8', input: '3\n' })
      expect(withoutTraex.stderr).not.toContain('本机 TraeX')

      await rm(fakeBin, { recursive: true, force: true })
    })()
  })

  test('explicit configure mode reruns onboarding and can avoid installing a service', async () => {
    const dshHome = await temporaryDshHome()
    await configureExistingLark(dshHome)

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'configure', '--no-service',
    ], dshHome)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('飞书处理：选择已有应用或创建新应用，并覆盖当前 channel 配置')
    expect(result.stdout).toContain('dsh-lark-setup --profile web --no-service')
  })

  test('Feishu menu writes UI separately from its machine-readable selection', () => {
    const result = spawnSync('/bin/bash', [
      '-c', 'source "$1"; dsh_enhanced_choose_lark_mode 1', 'installer-test', installerLibrary,
    ], {
      encoding: 'utf8',
      input: '2\n',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('configure')
    expect(result.stderr).toContain('检测到当前 profile 已启用飞书 Bot')
  })

  test('rejects unsafe profile names before planning any installation', async () => {
    const dshHome = await temporaryDshHome()

    const result = runInstaller(localInstaller, [
      '--dry-run', '--lark', 'skip', '--profile', '../web',
    ], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('profile 名称不合法')
    expect(result.stdout).not.toContain('dsh plugin')
  })

  test('restart command rebuilds and kickstarts web without installation or onboarding', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart([], dshHome, 'darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('launchctl kickstart -k gui/')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.web')
    expect(result.stdout).not.toContain('dsh plugin')
    expect(result.stdout).not.toContain('dsh-lark-setup')
  })

  test('restart command accepts the profile as its only optional argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['personal-web'], dshHome, 'darwin')

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('pnpm build')
    expect(result.stdout).toContain('/ai.deepseek.dsh.profile.personal-web')
  })

  test('restart command rejects more than one argument', async () => {
    const dshHome = await temporaryDshHome()

    const result = runRestart(['web', 'extra'], dshHome)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('只接受一个可选的 profile 参数')
  })

  test('restart command uses systemd on Linux and Task Scheduler on Windows', async () => {
    const dshHome = await temporaryDshHome()

    const linux = runRestart(['web'], dshHome, 'linux')
    expect(linux.status, linux.stderr).toBe(0)
    expect(linux.stdout).toContain('systemctl --user restart dsh-profile-web.service')

    const windows = runRestart(['web'], dshHome, 'windows')
    expect(windows.status, windows.stderr).toBe(0)
    expect(windows.stdout).toContain('schtasks.exe /End /TN DSH\\ profile\\ web')
    expect(windows.stdout).toContain('schtasks.exe /Run /TN DSH\\ profile\\ web')
  })
})
