import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { candidateDigest, firstPartyCatalog, type CatalogEntry } from '../src/catalog.ts'
import { runPluginControl } from '../src/cli.ts'

const temporaryRoots: string[] = []

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}

function candidate(id: string): CatalogEntry {
  const value = firstPartyCatalog.entries.find(entry => entry.id === id)
  if (value === undefined) throw new Error(`missing fixture candidate ${id}`)
  return value
}

function planFor(entry: CatalogEntry, profile = 'web') {
  const createdAt = Date.now()
  const digest = candidateDigest(entry, profile)
  return {
    schemaVersion: 1 as const,
    id: `plugin-${digest.slice(0, 24)}`,
    status: 'pending-owner-approval' as const,
    createdAt,
    expiresAt: createdAt + 60_000,
    profile,
    candidate: entry,
    digest,
  }
}

async function fakeDsh(root: string): Promise<string> {
  const bin = join(root, 'bin')
  await mkdir(bin, { recursive: true })
  await executable(join(bin, 'dsh'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == '--version' ]]; then
  printf '%s\\n' "\${DSH_TEST_DSH_VERSION:-0.1.0-rc.8}"
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
  directory="$DSH_HOME/profiles/$profile"
  mkdir -p "$directory"
  printf '%s\\n' "$DSH_TEST_INTEGRITIES" > "$directory/pnpm-lock.yaml"
  printf '%s\\n' "$*" >> "$DSH_TEST_DSH_LOG"
  exit 0
fi
exit 0
`)
  return bin
}

async function withEnvironment<T>(environment: Record<string, string>, action: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  try {
    return await action()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.sequential('plugin-control CLI owner boundary', () => {
  test('approves and activates every integrity-pinned bundle in a staged profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-control-cli-'))
    temporaryRoots.push(root)
    const dshHome = join(root, 'dsh')
    const profilePath = join(dshHome, 'profiles', 'web')
    const plansPath = join(dshHome, 'plugin-control', 'plans')
    await mkdir(profilePath, { recursive: true })
    await mkdir(plansPath, { recursive: true })
    await writeFile(join(profilePath, 'existing-profile-marker'), 'keep me', 'utf8')
    const entry = candidate('lark-assistant')
    const plan = planFor(entry)
    const planPath = join(plansPath, `${plan.id}.json`)
    await writeFile(planPath, `${JSON.stringify(plan)}\n`, 'utf8')
    const bin = await fakeDsh(root)
    const packages = [entry, ...entry.requires]
    const logPath = join(root, 'dsh.log')

    await withEnvironment({
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DSH_HOME: dshHome,
      DSH_TEST_DSH_VERSION: entry.dshBaseline,
      DSH_TEST_INTEGRITIES: packages.map(item => item.integrity).join('\n'),
      DSH_TEST_DSH_LOG: logPath,
    }, async () => {
      await runPluginControl(['approve', '--plan', planPath, '--approved-by', 'owner@example.test'])
      await runPluginControl(['activate', '--plan', planPath, '--dsh-home', dshHome])
    })

    const approved = JSON.parse(await readFile(planPath, 'utf8')) as { status: string; approval?: { principal: string } }
    expect(approved).toMatchObject({ status: 'owner-approved', approval: { principal: 'owner@example.test' } })
    await expect(readFile(join(profilePath, 'existing-profile-marker'), 'utf8')).resolves.toBe('keep me')
    const lock = await readFile(join(profilePath, 'pnpm-lock.yaml'), 'utf8')
    for (const item of packages) expect(lock).toContain(item.integrity)
    const command = await readFile(logPath, 'utf8')
    for (const item of packages) expect(command).toContain(`${item.package}@${item.version}`)
    expect((await readdir(join(dshHome, 'profiles'))).some(name => name.startsWith('stage-') || name.includes('plugin-backup'))).toBe(false)
  })

  test('fails closed before staging when the approved candidate baseline does not match DSH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-control-cli-'))
    temporaryRoots.push(root)
    const dshHome = join(root, 'dsh')
    const profilePath = join(dshHome, 'profiles', 'web')
    await mkdir(profilePath, { recursive: true })
    await writeFile(join(profilePath, 'existing-profile-marker'), 'original', 'utf8')
    const entry = candidate('assistant-health')
    const pending = planFor(entry)
    const plan = { ...pending, status: 'owner-approved' as const, approval: { principal: 'owner@example.test', approvedAt: Date.now() } }
    const planPath = join(root, `${plan.id}.json`)
    await writeFile(planPath, `${JSON.stringify(plan)}\n`, 'utf8')
    const bin = await fakeDsh(root)

    await expect(withEnvironment({
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DSH_HOME: dshHome,
      DSH_TEST_DSH_VERSION: '0.1.0-rc.7',
      DSH_TEST_INTEGRITIES: entry.integrity,
      DSH_TEST_DSH_LOG: join(root, 'dsh.log'),
    }, () => runPluginControl(['activate', '--plan', planPath, '--dsh-home', dshHome]))).rejects.toThrow('requires DSH 0.1.0-rc.8')

    await expect(readFile(join(profilePath, 'existing-profile-marker'), 'utf8')).resolves.toBe('original')
  })
})
