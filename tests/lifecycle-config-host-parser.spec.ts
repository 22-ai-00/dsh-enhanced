import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

const sourceHelper = new URL('../scripts/install/lifecycle-config.mjs', import.meta.url)
const parserPackage = dirname(createRequire(import.meta.url).resolve('yaml/package.json'))
const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-host-parser-'))
  roots.push(root)
  const host = join(root, 'host', 'node_modules', '@deepseek-ai', 'dsh')
  const manager = join(host, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager')
  const executable = join(host, 'lib', 'bin.js')
  const helper = join(root, 'remote', 'scripts', 'install', 'lifecycle-config.mjs')
  const home = join(root, 'home')
  await Promise.all([
    mkdir(dirname(executable), { recursive: true }),
    mkdir(join(manager, 'node_modules'), { recursive: true }),
    mkdir(dirname(helper), { recursive: true }),
    mkdir(join(home, 'state'), { recursive: true }),
  ])
  await cp(parserPackage, join(manager, 'node_modules', 'yaml'), { recursive: true })
  await writeFile(executable, '')
  await writeFile(join(host, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module',
    bin: { dsh: './lib/bin.js' },
    dependencies: { '@deepseek-ai/dsh-plugin-manager': '0.2.0-rc.2', 'js-yaml': '^4.2.0' },
  }))
  await writeFile(join(manager, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-plugin-manager', version: '0.2.0-rc.2', type: 'module',
    dependencies: { yaml: '^2.9.0' },
  }))
  await cp(sourceHelper, helper)
  return { root, host, manager, executable, helper, home }
}

function run(input: Awaited<ReturnType<typeof fixture>>, source: string, extraEnv: Record<string, string> = {}) {
  const code = [
    "import { pathToFileURL } from 'node:url'",
    'const [helper, home, executable, source] = process.argv.slice(2)',
    'const { validateLifecycleConfig } = await import(pathToFileURL(helper).href)',
    'await validateLifecycleConfig(source, { dshHome: home, dshExecutable: executable })',
  ].join(';')
  return spawnSync(process.execPath, ['--input-type=module', '--eval', code, 'isolated-runner',
    input.helper, input.home, input.executable, source], {
    cwd: input.root,
    encoding: 'utf8',
    env: { PATH: dirname(process.execPath), ...extraEnv },
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('detached lifecycle YAML parser', () => {
  test('uses the exact DSH 0.2 Host declared parser closure without evaluating !!js', async () => {
    const input = await fixture()
    const source = "- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n  config:\n    databasePath: !!js dshHomePath('state/policy.sqlite')\n"
    const accepted = run(input, source)
    expect(accepted.status, accepted.stderr).toBe(0)
    expect(accepted.stderr).toBe('')

    const rejectedExpression = run(input, source.replace("dshHomePath('state/policy.sqlite')", 'process.exit(7)'))
    expect(rejectedExpression.status).toBe(1)
    expect(rejectedExpression.stderr).toContain('only a non-empty relative dshHomePath expression is allowed')
    const rejectedEscape = run(input, source.replace("!!js dshHomePath('state/policy.sqlite')", join(input.root, 'outside.sqlite')))
    expect(rejectedEscape.status).toBe(1)
    expect(rejectedEscape.stderr).toContain('resolves outside canonical DSH_HOME')
  })

  test('uses the 0.2.1 Host parser from its matching plugin manager', async () => {
    const input = await fixture()
    for (const file of [join(input.host, 'package.json'), join(input.manager, 'package.json')]) {
      const manifest = JSON.parse(await readFile(file, 'utf8'))
      manifest.version = '0.2.1-rc.2'
      if (manifest.dependencies?.['@deepseek-ai/dsh-plugin-manager']) {
        manifest.dependencies['@deepseek-ai/dsh-plugin-manager'] = '0.2.1-rc.2'
      }
      await writeFile(file, JSON.stringify(manifest))
    }
    const result = run(input, "- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n")
    expect(result.status, result.stderr).toBe(0)
  })

  test('rejects a mismatched Host or parser dependency rather than using ambient YAML', async () => {
    const input = await fixture()
    const source = "- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n"
    await mkdir(join(input.root, 'remote', 'node_modules'), { recursive: true })
    await cp(parserPackage, join(input.root, 'remote', 'node_modules', 'yaml'), { recursive: true })
    const hostPath = join(input.host, 'package.json')
    const host = JSON.parse(await readFile(hostPath, 'utf8'))
    await writeFile(hostPath, JSON.stringify({ ...host, version: '0.2.0-rc.1' }))
    const wrongHost = run(input, source)
    expect(wrongHost.status).toBe(1)
    expect(wrongHost.stderr).toContain('canonical DSH executable')
    await writeFile(hostPath, JSON.stringify(host))

    const managerPath = join(input.manager, 'package.json')
    const manager = JSON.parse(await readFile(managerPath, 'utf8'))
    await writeFile(managerPath, JSON.stringify({ ...manager, version: '0.2.0-rc.1' }))
    const wrongManager = run(input, source)
    expect(wrongManager.status).toBe(1)
    expect(wrongManager.stderr).toContain('canonical DSH executable')

    await writeFile(managerPath, JSON.stringify({ ...manager, dependencies: {} }))
    const missingDeclaration = run(input, source)
    expect(missingDeclaration.status).toBe(1)
    expect(missingDeclaration.stderr).toContain('canonical DSH executable')
  })

  test('rejects NODE_PATH parser leakage outside the Host installation', async () => {
    const input = await fixture()
    const contaminant = join(input.root, 'contaminant')
    await mkdir(contaminant, { recursive: true })
    await cp(parserPackage, join(contaminant, 'yaml'), { recursive: true })
    await rm(join(input.manager, 'node_modules', 'yaml'), { recursive: true })
    const result = run(input, "- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n", { NODE_PATH: contaminant })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('canonical DSH executable')

    const insideClosure = join(input.root, 'host', 'node_modules', 'contaminant')
    await mkdir(insideClosure, { recursive: true })
    await cp(parserPackage, join(insideClosure, 'yaml'), { recursive: true })
    const internalLeak = run(input, "- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n", { NODE_PATH: insideClosure })
    expect(internalLeak.status).toBe(1)
    expect(internalLeak.stderr).toContain('canonical DSH executable')
  })

  test('retains canonical legacy Host direct-yaml fallback', async () => {
    const input = await fixture()
    const hostPath = join(input.host, 'package.json')
    const host = JSON.parse(await readFile(hostPath, 'utf8'))
    await writeFile(hostPath, JSON.stringify({
      ...host, version: '0.1.5-rc.1', dependencies: { yaml: '^2.9.0' },
    }))
    await cp(parserPackage, join(input.host, 'node_modules', 'yaml'), { recursive: true })
    const result = run(input, "- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n")
    expect(result.status, result.stderr).toBe(0)
  })

  test('uses the legacy Host declared filesystem skill parser without ambient YAML', async () => {
    const input = await fixture()
    const hostPath = join(input.host, 'package.json')
    const host = JSON.parse(await readFile(hostPath, 'utf8'))
    await writeFile(hostPath, JSON.stringify({
      ...host, version: '0.1.5-rc.3',
      dependencies: { '@deepseek-ai/dsh-skill-filesystem': '^0.1.5-rc.3', 'js-yaml': '^4.2.0' },
    }))
    const skill = join(input.host, 'node_modules', '@deepseek-ai', 'dsh-skill-filesystem')
    await mkdir(join(skill, 'node_modules'), { recursive: true })
    await writeFile(join(skill, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-skill-filesystem', version: '0.1.5-rc.3',
      dependencies: { yaml: '^2.4.2' },
    }))
    await cp(parserPackage, join(skill, 'node_modules', 'yaml'), { recursive: true })
    const source = "- id: first-party\n  name: '@dsh-enhanced/assistant-web-owner'\n  config:\n    statePath: !!js dshHomePath('state/policy.sqlite')\n"
    const accepted = run(input, source)
    expect(accepted.status, accepted.stderr).toBe(0)

    await writeFile(join(skill, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-skill-filesystem', version: '0.1.5-rc.3', dependencies: {},
    }))
    const rejected = run(input, source)
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('canonical DSH executable')
  })
})
