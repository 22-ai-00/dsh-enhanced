import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface WorkflowStep {
  name?: string
  uses?: string
  shell?: string
  run?: string
  env?: Record<string, string>
}

interface WorkflowJob {
  needs?: string | string[]
  if?: string
  'runs-on'?: string
  environment?: string
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
}

interface WorkflowDocument {
  on?: {
    push?: { branches?: string[]; tags?: string[] }
    pull_request?: unknown
    schedule?: unknown[]
    workflow_dispatch?: { inputs?: Record<string, unknown> }
  }
  jobs: Record<string, WorkflowJob>
}

function buildPackageDirMap(): Map<string, string> {
  const packageDirs = new Map<string, string>()
  for (const parent of ['plugins', 'packages']) {
    const parentPath = join(repoRoot, parent)
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const manifestPath = join(parentPath, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
      const packageDir = join(parent, entry.name)
      if (typeof manifest.name === 'string') {
        packageDirs.set(manifest.name, packageDir)
      }
      packageDirs.set(`./${parent}/${entry.name}`, packageDir)
    }
  }
  return packageDirs
}

function collectReferencedRepoPaths(steps: WorkflowStep[] | undefined, packageDirs: Map<string, string>): string[] {
  const referenced = new Set<string>()
  for (const step of steps ?? []) {
    const script = step.run ?? ''
    for (const line of script.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue

      const filterMatch = /--filter\s+((?:@[a-z0-9-]+\/)?[a-z0-9-]+|\.\/(?:plugins|packages)\/[a-z0-9-]+)(?=\s|$)/u.exec(trimmed)
      if (filterMatch) {
        const packageName = filterMatch[1]!
        const packageDir = packageDirs.get(packageName)
        expect(packageDir, `Unknown workspace package ${packageName} in command: ${trimmed}`).toBeDefined()
        const specMatches = trimmed.match(/tests\/[^\s'"]+\.spec\.ts/gu) ?? []
        for (const specPath of specMatches) {
          referenced.add(join(packageDir!, specPath))
        }
        continue
      }

      if (trimmed.includes('--dir tests')) {
        const rootSpecs = trimmed.match(/tests\/[^\s'"]+\.spec\.ts/gu) ?? []
        for (const specPath of rootSpecs) {
          referenced.add(specPath)
        }
      }

      const explicitNodeScripts = trimmed.match(/\.\/(?:scripts|plugins|packages)\/[^\s'"]+\.(?:mjs|js|ts)(?=$|[\s'"])/gu) ?? []
      for (const scriptPath of explicitNodeScripts) {
        referenced.add(scriptPath.replace(/^\.\//u, ''))
      }
    }
  }
  return [...referenced]
}

describe('CI and Release workflows', () => {
  test('release.yml enforces an unprivileged verify-npm readback gate between publish and record', async () => {
    const raw = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
    const workflow = parse(raw) as WorkflowDocument

    expect(workflow.on?.push?.tags).toContain('v*')
    expect(workflow.on?.workflow_dispatch?.inputs?.tag).toBeDefined()

    const publish = workflow.jobs.publish
    const verifyNpm = workflow.jobs['verify-npm']
    const record = workflow.jobs.record

    expect(publish).toBeDefined()
    expect(verifyNpm).toBeDefined()
    expect(record).toBeDefined()

    expect(publish?.environment).toBe('npm-release')
    expect(publish?.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'id-token': 'write',
    })

    expect(raw).toContain('dsh-ray-release-ci-gate')
    expect(raw).not.toContain('secrets.NPM_TOKEN')
    expect(raw).not.toContain('NPM_TOKEN')
    expect(raw).not.toContain('dsh-enhanced')
    expect(raw).not.toContain('dsh-rsi')

    const verifyCredsStep = (publish?.steps ?? []).find((step) => step.name === 'Verify npm credentials')
    expect(verifyCredsStep).toBeDefined()
    const verifyCredsRun = verifyCredsStep?.run ?? ''
    expect(verifyCredsRun).toContain('ACTIONS_ID_TOKEN_REQUEST_URL')
    expect(verifyCredsRun).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
    expect(verifyCredsRun).toContain('NODE_AUTH_TOKEN')
    expect(JSON.stringify(verifyCredsStep ?? {})).not.toContain('NPM_TOKEN')

    const publishStep = (publish?.steps ?? []).find((step) => (step.run ?? '').includes('pnpm release:publish'))
    expect(publishStep).toBeDefined()
    const publishRun = publishStep?.run ?? ''
    expect(publishRun).toContain('ACTIONS_ID_TOKEN_REQUEST_URL')
    expect(publishRun).toContain('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
    expect(publishRun).toContain('unset NODE_AUTH_TOKEN')
    expect(publishRun).toContain('_authToken=')
    expect(publishRun.indexOf('unset NODE_AUTH_TOKEN')).toBeLessThan(publishRun.indexOf('pnpm release:publish'))
    expect(publishRun.indexOf('_authToken=')).toBeLessThan(publishRun.indexOf('pnpm release:publish'))
    expect(JSON.stringify(publishStep ?? {})).not.toContain('NPM_TOKEN')

    expect(verifyNpm?.needs).toBe('publish')
    expect(verifyNpm?.['runs-on']).toBe('ubuntu-24.04')
    expect(verifyNpm?.permissions).toEqual({ contents: 'read' })
    expect(verifyNpm?.environment).toBeUndefined()

    const verifyStepsText = (verifyNpm?.steps ?? []).map((step) => `${step.uses ?? ''}\n${step.run ?? ''}`).join('\n')
    expect(verifyStepsText).not.toContain('NPM_TOKEN')
    expect(verifyStepsText).not.toContain('pnpm install')
    expect(verifyStepsText).toContain('node ./scripts/verify-npm-release.mjs')
    expect(verifyStepsText).toContain('--verify-tarball')

    const recordNeeds = Array.isArray(record?.needs) ? record.needs : [record?.needs]
    expect(recordNeeds).toContain('publish')
    expect(recordNeeds).toContain('verify-npm')
    expect(record?.if).toBeUndefined()
    expect(record?.permissions?.contents).toBe('write')
  })

  test('ci.yml preserves job topology and expands macos-verify and windows-acp-smoke with valid on-disk paths', async () => {
    const raw = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(raw).not.toContain('dsh-enhanced')
    expect(raw).not.toContain('dsh-rsi')

    const workflow = parse(raw) as WorkflowDocument

    expect(workflow.on?.push?.branches).toEqual(['dev', 'main'])
    expect(workflow.on?.pull_request).toBeDefined()
    expect(workflow.on?.schedule).toBeDefined()

    expect(Object.keys(workflow.jobs)).toEqual([
      'linux-packages',
      'linux-slow-package-tests',
      'linux-root-tests',
      'verify',
      'macos-verify',
      'windows-acp-smoke',
    ])

    const verify = workflow.jobs.verify
    expect(verify?.needs).toEqual([
      'linux-packages',
      'linux-slow-package-tests',
      'linux-root-tests',
      'macos-verify',
      'windows-acp-smoke',
    ])

    const macos = workflow.jobs['macos-verify']
    expect(macos?.['runs-on']).toBe('macos-latest')
    const macosCommands = (macos?.steps ?? []).map((step) => step.run ?? '').join('\n')
    expect(macosCommands).toContain('pnpm run validate && pnpm run lint')
    expect(macosCommands).toContain('pnpm run build')
    expect(macosCommands).toContain('@dsh-ray/assistant-isolation')
    expect(macosCommands).toContain('tests/native-macos.spec.ts')
    expect(macosCommands).toContain('tests/native-verifier-runner.spec.ts')
    expect(macosCommands).toContain('@dsh-ray/assistant-actions')
    expect(macosCommands).toContain('--filter ./packages/cli ')
    expect(macosCommands).not.toContain('--filter dsh-ray ')
    expect(macosCommands).not.toContain('@dsh-ray/dsh-ray')
    expect(macosCommands).toContain('@dsh-ray/plugin-control-plane')
    expect(macosCommands).toContain('tests/runtime-observer.spec.ts')
    expect(macosCommands).toContain('@dsh-ray/lark-channel')
    expect(macosCommands).toContain('tests/rsi-native-runtime-bootstrap.spec.ts')
    expect(macosCommands).toContain('tests/rsi-release-build.spec.ts')
    expect(macosCommands).toContain('tests/macos-launchd-lock.spec.ts')
    expect(macosCommands).toContain('tests/macos-launchd-service.spec.ts')
    expect(macosCommands).toContain('tests/macos-purge-fallback.spec.ts')

    const windows = workflow.jobs['windows-acp-smoke']
    expect(windows?.['runs-on']).toBe('windows-2025')
    const windowsCommands = (windows?.steps ?? []).map((step) => step.run ?? '').join('\n')
    expect(windowsCommands).toContain('pnpm run validate')
    expect(windowsCommands).toContain('pnpm run build')
    expect(windowsCommands).toContain('@dsh-ray/acp')
    expect(windowsCommands).toContain('plugins/acp/scripts/stdio-smoke.mjs')
    expect(windowsCommands).toContain('--filter ./packages/cli ')
    expect(windowsCommands).not.toContain('--filter dsh-ray ')
    expect(windowsCommands).not.toContain('@dsh-ray/dsh-ray')
    expect(windowsCommands).toContain('@dsh-ray/assistant-isolation')
    expect(windowsCommands).toContain('@dsh-ray/assistant-actions')
    expect(windowsCommands).toContain('tests/ci-workflows.spec.ts')
    expect(windowsCommands).toContain('tests/verify-npm-release.spec.ts')
    expect(windowsCommands).toContain('$LASTEXITCODE')
    expect(windowsCommands).toMatch(/dsh-ray-acp-\$acpVersion\.tgz/u)

    const packageDirs = buildPackageDirMap()
    const macosPaths = collectReferencedRepoPaths(macos?.steps, packageDirs)
    const windowsPaths = collectReferencedRepoPaths(windows?.steps, packageDirs)

    expect(macosPaths.length).toBeGreaterThan(20)
    expect(windowsPaths.length).toBeGreaterThan(20)

    const excludedWindowsPosixSpecs = [
      join('plugins', 'assistant-isolation', 'tests', 'linux-ledger.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'index.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'ledger.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'verified-delivery-service.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'workflow-service.spec.ts'),
    ]
    for (const excludedPath of excludedWindowsPosixSpecs) {
      expect(windowsPaths).not.toContain(excludedPath)
    }

    const requiredMacosSpecs = [
      join('plugins', 'assistant-isolation', 'tests', 'macos-seatbelt-backend.spec.ts'),
      join('plugins', 'assistant-isolation', 'tests', 'cross-platform-config.spec.ts'),
      join('plugins', 'assistant-isolation', 'tests', 'isolated-subprocess.spec.ts'),
    ]
    for (const requiredPath of requiredMacosSpecs) {
      expect(macosPaths).toContain(requiredPath)
    }

    const requiredWindowsSpecs = [
      join('packages', 'cli', 'tests', 'index.spec.ts'),
      join('plugins', 'assistant-isolation', 'tests', 'cross-platform-config.spec.ts'),
      join('plugins', 'assistant-isolation', 'tests', 'windows-job-backend.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'broker-protocol-v2.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'broker-policy-wp08.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'broker-peer-cross-platform.spec.ts'),
      join('plugins', 'assistant-actions', 'tests', 'broker-transport.spec.ts'),
    ]
    for (const requiredPath of requiredWindowsSpecs) {
      expect(windowsPaths).toContain(requiredPath)
    }

    for (const relPath of [...macosPaths, ...windowsPaths]) {
      expect(existsSync(join(repoRoot, relPath)), `Missing referenced CI path: ${relPath}`).toBe(true)
    }
  })
})
