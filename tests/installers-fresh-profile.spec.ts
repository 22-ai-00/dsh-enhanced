import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { isMap, isSeq, parseDocument } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const localInstaller = join(repoRoot, 'scripts', 'install', 'install-local.sh')
const temporaryRoots: string[] = []

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}

function hasForegroundGrant(profilePatch: string): boolean {
  const document = parseDocument(profilePatch)
  if (!isSeq(document.contents)) return false
  const personal = document.contents.items.find(item => isMap(item)
    && (item.get('id') as unknown) === 'dsh-enhanced-personal-assistant')
  if (!isMap(personal)) return false
  const config = personal.get('config', true)
  if (!isMap(config)) return false
  const policy = config.get('assistantPolicy', true)
  if (!isMap(policy)) return false
  const rules = policy.get('rules', true)
  return isSeq(rules) && rules.items.some(item => isMap(item)
    && (item.get('id') as unknown) === 'dsh-enhanced-foreground-capability-*')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('fresh local installer profile', () => {
  test.each([
    { label: 'default allow', agentTools: undefined, expectedGrant: true },
    { label: 'explicit disable', agentTools: 'disable', expectedGrant: false },
  ])('commits a usable $label override on an actual fresh DSH_HOME with --lark skip', async ({
    agentTools,
    expectedGrant,
  }) => {
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
  printf '#!/bin/bash\\nexec "%s" "%s" "$@"\\n' "$REAL_NODE" "$LARK_SETUP" \
    > "$profile_dir/node_modules/.bin/dsh-lark-setup"
  chmod 755 "$profile_dir/node_modules/.bin/dsh-lark-setup"
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
if [[ -f "$profile_patch" ]] \
  && grep -q '^- id: dsh-enhanced-personal-assistant$' "$profile_patch"; then
  awk '
    $0 == "- id: dsh-enhanced-personal-assistant" {
      print
      print "  name: " sprintf("%c", 39) "@dsh-enhanced/personal-assistant" sprintf("%c", 39)
      next
    }
    $0 == "- id: dsh-enhanced-assistant-delivery" {
      print
      print "  name: " sprintf("%c", 39) "@dsh-enhanced/assistant-delivery" sprintf("%c", 39)
      next
    }
    { print }
  ' "$profile_patch"
  exit 0
fi
cat <<'PROFILE'
- id: dsh-enhanced-assistant-delivery
  name: '@dsh-enhanced/assistant-delivery'
  config:
    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')
    spoolPath: !!js dshHomePath('assistant-delivery/spool')
    defaultWorkspace: !!js dshHomePath('assistant-workspace')
    defaultAgentPreset: standard
- id: dsh-enhanced-personal-assistant
  name: '@dsh-enhanced/personal-assistant'
  config:
    assistantPolicy:
      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
      rules:
        - id: deployment-deny-background-shell
          effect: deny
          subject: { kind: background, id: '*' }
          actions: [execute]
          resource: { kind: tool, id: bash }
          context: { initiators: [background] }
        - id: dsh-enhanced-foreground-capability-*
          effect: allow
          subject: { kind: agent, id: '*', workspace: '*' }
          actions: ['*']
          resource: { kind: '*', id: '*' }
          context: { initiators: [foreground] }
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
      ...(agentTools === undefined ? [] : ['--agent-tools', agentTools]),
    ]
    const testEnvironment = {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      DSH_HOME: dshHome,
      REAL_NODE: process.execPath,
      REAL_PATH: process.env.PATH ?? '',
      LARK_SETUP: join(repoRoot, 'plugins', 'lark-channel', 'bin', 'dsh-lark-setup.js'),
    }
    const result = spawnSync('/bin/bash', installerArguments, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: testEnvironment,
    })

    expect(result.status, result.stderr).toBe(0)
    const profilePatch = await readFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(profilePatch).toContain('dsh-enhanced-personal-assistant')
    expect(profilePatch).toContain('dsh-enhanced-assistant-delivery')
    expect(profilePatch).toContain('deployment-deny-background-shell')
    expect(hasForegroundGrant(profilePatch)).toBe(expectedGrant)
    expect(profilePatch).not.toContain('dsh-enhanced-lark-channel')
    const effective = spawnSync(join(fakeBin, 'dsh'), ['--profile', 'web', '--dump-config'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: testEnvironment,
    })
    expect(effective.status, effective.stderr).toBe(0)
    expect(hasForegroundGrant(effective.stdout)).toBe(expectedGrant)
    expect(effective.stdout).toContain("dshHomePath('assistant-delivery/state.sqlite')")
    expect(effective.stdout).toContain("dshHomePath('assistant-delivery/spool')")
    expect(effective.stdout).toContain('personalMemory:')
    expect(effective.stdout).toContain('personalWiki:')
    expect(effective.stdout).toContain('assistantAutomations:')
  }, 30_000)
})
