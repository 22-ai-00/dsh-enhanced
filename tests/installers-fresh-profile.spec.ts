import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const localInstaller = join(repoRoot, 'scripts', 'install', 'install-local.sh')
const temporaryRoots: string[] = []

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('fresh local installer profile', () => {
  test('composes the safe core scenario and mounts capability discovery without materializing channel state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-enhanced-fresh-installer-'))
    temporaryRoots.push(root)
    const dshHome = join(root, 'dsh-home')
    const fakeBin = join(root, 'bin')
    await mkdir(fakeBin, { recursive: true })
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
if [[ "\${1:-}" == 'install' ]]; then exit 0; fi
if [[ "\${1:-}" == 'build' ]]; then exit 0; fi
exec env PATH="$REAL_PATH" pnpm "$@"
`)
    await writeExecutable(join(fakeBin, 'dsh'), `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
if [[ "$*" == *'--no-open --port 0'* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'
  exit 0
fi
if [[ "\${1:-}" == 'plugin' ]]; then
  profile='web'
  for ((index = 1; index <= $#; index += 1)); do
    if [[ "\${!index}" == '--profile' ]]; then
      next=$((index + 1))
      profile="\${!next}"
    fi
  done
  profile_dir="$DSH_HOME/profiles/$profile"
  mkdir -p "$profile_dir/node_modules/.bin"
  if [[ ! -f "$profile_dir/cordis.patch.yml" ]]; then
    printf '# Fresh DSH profile override\\n[]\\n' > "$profile_dir/cordis.patch.yml"
  fi
  exit 0
fi
profile='web'
for ((index = 1; index <= $#; index += 1)); do
  if [[ "\${!index}" == '--profile' ]]; then
    next=$((index + 1))
    profile="\${!next}"
  fi
done
profile_patch="$DSH_HOME/profiles/$profile/cordis.patch.yml"
cat <<'PROFILE'
- id: dsh-enhanced-personal-assistant
  name: '@dsh-enhanced/personal-assistant'
  config:
    assistantPolicy:
      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
      rules:
      budgets: []
    personalMemory:
      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')
    personalWiki:
      vaultRoot: !!js dshHomePath('personal-wiki/vault')
      databasePath: !!js dshHomePath('personal-wiki/state.sqlite')
    assistantAutomations:
      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')
      runsPath: !!js dshHomePath('assistant-automations/runs')
PROFILE
`)

    const installerArguments = [
      localInstaller,
      '--dsh-version', '0.1.2-rc.1',
      '--lark', 'skip',
      '--no-service',
    ]
    const testEnvironment = {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      DSH_HOME: dshHome,
      DSH_ENHANCED_WEB_PORT: '43191',
      REAL_PATH: process.env.PATH ?? '',
    }
    const result = spawnSync('/bin/bash', installerArguments, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: testEnvironment,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(join(repoRoot, 'plugins', 'plugin-control-plane'))
    const profilePatch = await readFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(profilePatch).toContain('Fresh DSH profile override')
    expect(profilePatch).not.toContain('dsh-enhanced-lark-channel')
    const effective = spawnSync(join(fakeBin, 'dsh'), ['--profile', 'web', '--dump-config'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: testEnvironment,
    })
    expect(effective.status, effective.stderr).toBe(0)
    expect(effective.stdout).toContain('dsh-enhanced-personal-assistant')
    expect(effective.stdout).not.toContain('dsh-enhanced-assistant-delivery')
    expect(effective.stdout).toContain('personalMemory:')
    expect(effective.stdout).toContain('personalWiki:')
    expect(effective.stdout).toContain('assistantAutomations:')
  }, 30_000)

  test('repeats a full local web install without replacing owner config, goals, sessions, or permission budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-enhanced-repeat-installer-'))
    temporaryRoots.push(root)
    const dshHome = join(root, 'dsh-home')
    const fakeHost = join(root, 'fake-host')
    const fakeBin = join(root, 'bin')
    const dshPath = join(fakeHost, 'bin', 'dsh')
    await mkdir(join(fakeHost, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
    await mkdir(dirname(dshPath), { recursive: true })
    await mkdir(fakeBin, { recursive: true })
    await writeFile(join(fakeHost, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.2-rc.1', type: 'module',
    }), 'utf8')
    await writeFile(join(fakeHost, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.js',
    }), 'utf8')
    await writeFile(join(fakeHost, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'index.js'),
      'export async function healProfilesModuleFallback() {}\n', 'utf8')
    await writeExecutable(join(fakeBin, 'pnpm'), `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '11.7.0\\n'; exit 0; fi
if [[ "\${1:-}" == 'install' || "\${1:-}" == 'build' ]]; then exit 0; fi
exec env PATH="$REAL_PATH" pnpm "$@"
`)
    await writeExecutable(dshPath, `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.2-rc.1\\n'; exit 0; fi
profile='web'
for ((index = 1; index <= $#; index += 1)); do
  if [[ "\${!index}" == '--profile' ]]; then next=$((index + 1)); profile="\${!next}"; fi
done
profile_dir="$DSH_HOME/profiles/$profile"
if [[ " $* " == *' plugin '* && " $* " == *' add '* ]]; then
  mkdir -p "$profile_dir/node_modules/.bin"
  node - "$profile_dir/package.json" "$@" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const { basename } = require('node:path')
const path = process.argv[2]
const args = process.argv.slice(3)
const add = args.indexOf('add')
const targets = add < 0 ? [] : args.slice(add + 1)
let manifest = { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
try { manifest = JSON.parse(readFileSync(path, 'utf8')) } catch {}
manifest.dependencies ??= {}
manifest.dsh ??= {}; manifest.dsh.profile ??= {}; manifest.dsh.profile.bundles ??= []
for (const target of targets) {
  const name = '@dsh-enhanced/' + basename(target)
  manifest.dependencies[name] = 'file:' + target
  if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
}
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\\n')
NODE
  if [[ ! -f "$profile_dir/cordis.patch.yml" ]]; then printf '[]\\n' > "$profile_dir/cordis.patch.yml"; fi
  printf '#!/bin/bash\\nexit 0\\n' > "$profile_dir/node_modules/.bin/dsh-web-owner-setup"
  chmod 755 "$profile_dir/node_modules/.bin/dsh-web-owner-setup"
  exit 0
fi
if [[ " $* " == *' --dump-config '* ]]; then cat "$profile_dir/cordis.patch.yml"; exit 0; fi
if [[ " $* " == *' --host 127.0.0.1 --no-open --port 0 '* ]]; then
  printf 'dsh web: http://127.0.0.1:43210\\n'; exit 0
fi
exit 2
`)

    const environment = {
      PATH: `${join(fakeHost, 'bin')}:${fakeBin}:${process.env.PATH ?? ''}`,
      DSH_HOME: dshHome,
      DSH_ENHANCED_WEB_PORT: '43192',
      REAL_PATH: process.env.PATH ?? '',
    }
    const arguments_ = [localInstaller, '--dsh-version', '0.1.2-rc.1', '--scenario', 'web', '--lark', 'skip', '--no-service']
    const first = spawnSync('/bin/bash', arguments_, { cwd: repoRoot, encoding: 'utf8', env: environment })
    expect(first.status, first.stderr).toBe(0)

    const profileDirectory = join(dshHome, 'profiles', 'web')
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    const settingsPath = join(dshHome, 'settings.yaml')
    const goalPath = join(dshHome, 'assistant-goals', 'web.sqlite')
    const sessionPath = join(dshHome, 'sessions', 'owner-session.jsonl')
    const ownerPatch = `- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy:
      rules:
        - id: owner-grant
          effect: allow
      budgets:
        - id: owner-budget
          metric: tool-calls
          limit: 17
          periodMs: 3600000
          scope: global
    ownerCustomValue: keep-on-repeat
`
    const settings = 'permission:\n  defaultPreset: danger-full-access\nownerSetting: preserve\n'
    await writeFile(patchPath, ownerPatch, 'utf8')
    await writeFile(settingsPath, settings, 'utf8')
    await mkdir(dirname(goalPath), { recursive: true })
    const goals = new DatabaseSync(goalPath)
    goals.exec(`CREATE TABLE goal_records (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, original_objective TEXT NOT NULL, definition_json TEXT NOT NULL, native_json TEXT NOT NULL, checkpoint_json TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE goal_history (record_id TEXT NOT NULL REFERENCES goal_records(id) ON DELETE RESTRICT, sequence INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('native', 'checkpoint')), payload_json TEXT NOT NULL, recorded_at INTEGER NOT NULL, PRIMARY KEY(record_id, sequence)) STRICT, WITHOUT ROWID;
CREATE TABLE goal_focus (scope_json TEXT NOT NULL, session_id TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(scope_json, session_id), FOREIGN KEY(record_id) REFERENCES goal_records(id) ON DELETE RESTRICT) STRICT, WITHOUT ROWID;
INSERT INTO goal_records VALUES ('owner-goal', '{}', 'retain the owner goal', '{}', '{}', '{}', 1, 1, 1);
PRAGMA user_version = 3;`)
    goals.close()
    await mkdir(dirname(sessionPath), { recursive: true })
    await writeFile(sessionPath, '{"type":"permission/preset","data":{"preset":"danger-full-access","grant":"owner-grant"}}\n', 'utf8')
    const [patchBefore, settingsBefore, goalBytesBefore, sessionBefore] = await Promise.all([
      readFile(patchPath), readFile(settingsPath), readFile(goalPath), readFile(sessionPath),
    ])

    const second = spawnSync('/bin/bash', arguments_, { cwd: repoRoot, encoding: 'utf8', env: environment })
    expect(second.status, second.stderr).toBe(0)
    const manifest = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8'))
    const desiredBundles = [
      '@dsh-enhanced/personal-assistant', '@dsh-enhanced/plugin-control-plane', '@dsh-enhanced/assistant-delivery',
      '@dsh-enhanced/assistant-goals', '@dsh-enhanced/assistant-web-owner',
    ]
    for (const name of desiredBundles) {
      expect(manifest.dsh.profile.bundles.filter((value: string) => value === name)).toHaveLength(1)
      expect(manifest.dependencies[name]).toMatch(/^file:/u)
    }
    expect(await readFile(patchPath)).toEqual(patchBefore)
    expect(await readFile(settingsPath)).toEqual(settingsBefore)
    expect(await readFile(goalPath)).toEqual(goalBytesBefore)
    expect(await readFile(sessionPath)).toEqual(sessionBefore)
    const preservedGoals = new DatabaseSync(goalPath, { readOnly: true })
    expect(preservedGoals.prepare('SELECT id, original_objective FROM goal_records').all()).toEqual([
      { id: 'owner-goal', original_objective: 'retain the owner goal' },
    ])
    preservedGoals.close()
  }, 30_000)
})
