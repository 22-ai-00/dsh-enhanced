import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
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
if [[ "\${1:-}" == '--version' ]]; then printf '0.1.0-rc.8\\n'; exit 0; fi
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
})
