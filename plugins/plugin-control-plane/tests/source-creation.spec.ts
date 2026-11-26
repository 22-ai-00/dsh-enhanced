import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createIsolatedWorktree } from '../src/source-workspace.ts'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace, validateSourceCreationFiles,
  validateSourceCreationGrant, verifyCreatedPluginWorkspace, CANDIDATE_PLUGIN_KINDS, normalizeCandidatePluginKind,
  extractCandidatePluginKindFromFiles, extractCandidatePluginKindFromManifestText,
  parseControlledPatchYaml, type SourceCreationGrant } from '../src/source-creation.ts'
import { controlPlaneDigest } from '../src/store.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'

const sourceRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
let repository: string
let cloneRoot: string
const environment = process.env
let baseCommit: string
const roots: string[] = []
const workers: { remove: () => Promise<void> }[] = []
const signal = new AbortController().signal
const grant = (): SourceCreationGrant => ({ id: 'owner-create-1', expiresAt: Date.now() + 60_000,
  maxCreates: 2, namePrefix: 'rsi-created-' })

beforeAll(async () => {
  cloneRoot = await mkdtemp(join(tmpdir(), 'dsh-create-private-clone-'))
  const created = await createSourceCreationFixture(sourceRoot, join(cloneRoot, 'repository'))
  repository = created.repository
  baseCommit = created.baseCommit
}, 60_000)

afterAll(async () => { await rm(cloneRoot, { recursive: true, force: true }) })

async function worktree() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-create-test-')); roots.push(root)
  const isolated = await createIsolatedWorktree({ stateRoot: root, repository, baseCommit, environment })
  workers.push(isolated)
  return isolated.worktree
}

async function inspected(name = 'rsi-created-example', selected: readonly string[] = ['src/index.ts']) {
  return inspectSourceCreationContext({ repository, name, paths: selected, baseCommit, environment, signal,
    assertCurrent: () => undefined, grant: grant() })
}

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.remove()
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})

describe('prepared source creation using the real public generator and base lock', () => {
  it('inspects the generated plugin without changing the source checkout', async () => {
    const before = execFileSync('/usr/bin/git', ['worktree', 'list', '--porcelain'], { cwd: repository, encoding: 'utf8' })
    const view = await inspected('rsi-created-example', ['src/index.ts', 'package.json'])
    expect(view.baseCommit).toBe(baseCommit)
    expect(view.generatorDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(view.files.map(file => file.path)).toContain('cordis.patch.yml')
    expect(view.contents[0]?.content).toContain("dsh-ray-rsi-created-example")
    expect(JSON.parse(view.contents[1]!.content)).toMatchObject({ name: '@dsh-ray/rsi-created-example', version: '0.1.0' })
    expect(execFileSync('/usr/bin/git', ['worktree', 'list', '--porcelain'], { cwd: repository, encoding: 'utf8' })).toBe(before)
  }, 20_000)

  it('inspects a generated plugin when TMPDIR is a symlink to its physical directory', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-create-tmp-alias-')))
    roots.push(root)
    const alias = join(root, 'alias')
    await symlink(root, alias, 'dir')
    const previous = process.env.TMPDIR
    try {
      process.env.TMPDIR = alias
      expect(tmpdir()).toBe(alias)
      const view = await inspected('rsi-created-symlink-tmp')
      expect(view.files.some(file => file.path === 'package.json')).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  }, 20_000)

  it('writes candidate source and a single Host lock importer while preserving generated Host files', async () => {
    const current = await worktree()
    const view = await inspected()
    const files = [{ path: 'src/index.ts', content: 'export const tool = true\n' },
      { path: 'README.md', content: '# New owner tool\n' },
      { path: 'tests/integration/case.spec.ts', content: 'export const checked = true\n' }]
    const creation = { grant: grant(), generatorDigest: view.generatorDigest }
    const result = await prepareCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
      files, environment, signal, assertCurrent: () => undefined, creation })
    expect(result).toEqual({ scope: [`plugins/${view.name}`, 'plugins/README.md', 'pnpm-lock.yaml'], generatorDigest: view.generatorDigest })
    expect(await readFile(join(current, 'plugins', view.name, 'src', 'index.ts'), 'utf8')).toBe(files[0]!.content)
    expect(await readFile(join(current, 'plugins', view.name, 'tests', 'integration', 'case.spec.ts'), 'utf8')).toBe(files[2]!.content)
    const lock = await readFile(join(current, 'pnpm-lock.yaml'), 'utf8')
    const original = await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8')
    const importer = lock.match(/\n  plugins\/rsi-created-example:\n[\s\S]*?(?=\npackages:\n)/u)?.[0]
    expect(importer).toBeDefined()
    expect(lock.replace(importer!, '')).toBe(original)
    expect(importer).toContain("'@deepseek-ai/cordis'")
    expect(importer).toContain("'@types/node'")
    expect(importer).toContain('typescript')
    expect(importer).toContain('vitest')
    await expect(verifyCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
      environment, signal, assertCurrent: () => undefined, creation, files })).resolves.toEqual(result)
    if (process.env.DSH_CREATION_REAL_FROZEN === '1') {
      let output: string
      try {
        output = execFileSync('pnpm', ['--filter', `@dsh-ray/${view.name}`, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'], {
          cwd: current, encoding: 'utf8', timeout: 180_000, maxBuffer: 4_194_304,
          env: { ...process.env, CI: '1', NPM_CONFIG_OFFLINE: 'true', COREPACK_ENABLE_NETWORK: '0' },
        })
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string; status?: number }
        throw new Error(`real offline frozen install exited ${failed.status}: ${failed.stdout?.slice(-2_000) ?? ''} ${failed.stderr?.slice(-2_000) ?? ''}`)
      }
      expect(output).toContain('Done in')
      // Install acts only on the private worktree; the source projection still
      // needs to remain exact after pnpm has populated ignored node_modules.
      await expect(verifyCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
        environment, signal, assertCurrent: () => undefined, creation, files })).resolves.toEqual(result)
    }
    if (process.env.DSH_CREATION_REAL_DOCKER === '1') {
      execFileSync('/usr/bin/git', ['add', '--all', '--', ...result.scope], { cwd: current })
      const tree = execFileSync('/usr/bin/git', ['write-tree'], { cwd: current, encoding: 'utf8' }).trim()
      const archive = spawnSync('/usr/bin/git', ['archive', '--format=tar', tree], { cwd: current, maxBuffer: 128 * 1024 * 1024 })
      expect(archive.status).toBe(0)
      const image = process.env.DSH_CREATION_TEST_IMAGE
      if (!image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error('test Docker image must be an explicit immutable sha256 ID')
      const nonce = randomUUID()
      const name = `dsh-creation-probe-${nonce}`
      const label = `dsh.source.creation.probe=${nonce}`
      const baseLockSha256 = createHash('sha256').update(execFileSync('/usr/bin/git',
        ['show', `${baseCommit}:pnpm-lock.yaml`], { cwd: current })).digest('hex')
      const command = ['run', '--rm', '-i', '--pull', 'never', '--name', name, '--label', label,
        '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--user', '65534:65534', '--pids-limit', '512', '--memory', '4096m', '--cpus', '2',
        '--tmpfs', '/workspace:rw,nosuid,nodev,mode=1777,size=2048m,exec',
        '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=512m,exec', '--workdir', '/workspace',
        '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
        '--env', `DSH_SOURCE_BASE_LOCK_SHA256=${baseLockSha256}`, '--entrypoint', '/bin/sh', image,
        '-ceu', `set -eu; tar -x -C /workspace; cd /workspace; test "$(pnpm --version)" = 11.7.0;
          test "$(sha256sum /opt/dsh-source-baseline/pnpm-lock.yaml | cut -d ' ' -f1)" = "$DSH_SOURCE_BASE_LOCK_SHA256";
          pnpm install --offline --frozen-lockfile --ignore-scripts --trust-lockfile`]
      let run: ReturnType<typeof spawnSync> | undefined
      let launchError: unknown
      try {
        run = spawnSync('/usr/bin/docker', command,
          { input: archive.stdout, encoding: 'utf8', timeout: 240_000, maxBuffer: 8_388_608, env: { PATH: '/usr/bin:/bin' } })
      } catch (error) { launchError = error }
      const inspected = spawnSync('/usr/bin/docker', ['inspect', name], { encoding: 'utf8', timeout: 10_000,
        maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin' } })
      if (inspected.status === 0) {
        const value = JSON.parse(inspected.stdout) as [{ Name?: string; Image?: string;
          Config?: { Image?: string; Labels?: Record<string, string> } }]
        if (value.length !== 1 || value[0]?.Name !== `/${name}` || value[0].Config?.Image !== image
          || value[0].Config?.Labels?.['dsh.source.creation.probe'] !== nonce) {
          throw new Error('test Docker residue identity differs; refusing to remove it')
        }
        const removed = spawnSync('/usr/bin/docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 20_000,
          maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin' } })
        if (removed.status !== 0) throw new Error(`test Docker residue cleanup failed: ${removed.stderr}`)
      } else if (inspected.status !== 1) throw new Error(`test Docker residue inspection failed: ${inspected.stderr}`)
      if (launchError !== undefined) throw launchError
      if (run === undefined) throw new Error('test Docker process did not start')
      expect(run.status, `${run.error?.message ?? ''} ${run.stdout?.slice(-2_000)} ${run.stderr?.slice(-2_000)}`).toBe(0)
      expect(run.stdout).toContain('Lockfile is up to date')
    }
  }, 240_000)

  it('rejects invalid grant shape, namespace and protected candidate paths', async () => {
    expect(() => validateSourceCreationGrant({ ...grant(), maxCreates: 0 })).toThrow('invalid')
    expect(() => validateSourceCreationGrant({ ...grant(), extra: true })).toThrow('invalid')
    expect(() => validateSourceCreationGrant({ ...grant(), namePrefix: 'rsi' })).toThrow('invalid')
    for (const path of ['package.json', 'cordis.patch.yml', 'LICENSE', 'tsconfig.json', 'src/version.ts',
      'src/../package.json', 'tests/x/../../package.json', '/tmp/escape', 'src/../../outside', 'lib/index.js']) {
      expect(() => validateSourceCreationFiles([{ path, content: 'x' }])).toThrow()
    }
    await expect(inspected('assistant-health')).rejects.toThrow('namespace')
    await expect(inspectSourceCreationContext({ repository, name: 'assistant-health', paths: [], baseCommit,
      environment, signal, assertCurrent: () => undefined, grant: { ...grant(), namePrefix: 'assistant-' } })).rejects.toThrow('already exists')
  }, 20_000)

  it('rejects a package identity collision in another directory of the pinned base', async () => {
    const current = await worktree()
    const alias = join(current, 'packages', 'different-directory')
    await mkdir(alias)
    await writeFile(join(alias, 'package.json'), JSON.stringify({ name: '@dsh-ray/rsi-created-example', version: '1.0.0' }))
    execFileSync('/usr/bin/git', ['add', '--', 'packages/different-directory/package.json'], { cwd: current })
    execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'colliding package fixture'], { cwd: current })
    const collidingBase = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: current, encoding: 'utf8' }).trim()
    await expect(inspectSourceCreationContext({ repository: current, name: 'rsi-created-example', paths: [],
      baseCommit: collidingBase, environment, signal, assertCurrent: () => undefined, grant: grant() }))
      .rejects.toThrow('package identity already exists')
  }, 20_000)

  it('rejects worktree template drift before executing the generator', async () => {
    const current = await worktree()
    const view = await inspected()
    await writeFile(join(current, 'templates', 'plugin', 'README.md.tpl'), 'tampered\n')
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
      files: [{ path: 'README.md', content: 'text' }], environment, signal,
      assertCurrent: () => undefined, creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow()
  }, 20_000)

  it('detects Host manifest and existing lock projection changes after proposal writes', async () => {
    const current = await worktree()
    const view = await inspected()
    const creation = { grant: grant(), generatorDigest: view.generatorDigest }
    const candidateFiles = [{ path: 'README.md', content: '# source\n' }]
    const options = { worktree: current, baseCommit, name: view.name, environment, signal,
      assertCurrent: () => undefined, creation }
    await prepareCreatedPluginWorkspace({ ...options, files: candidateFiles })
    const manifest = join(current, 'plugins', view.name, 'package.json')
    const originalManifest = await readFile(manifest, 'utf8')
    await writeFile(manifest, `${originalManifest}\n`)
    await expect(verifyCreatedPluginWorkspace({ ...options, files: candidateFiles })).rejects.toThrow('Host-owned generated file')
    const tamperedScripts = JSON.stringify({
      ...JSON.parse(originalManifest) as Record<string, unknown>,
      scripts: { build: 'echo pwned' },
    }, null, 2) + '\n'
    await writeFile(manifest, tamperedScripts)
    await expect(verifyCreatedPluginWorkspace(options)).rejects.toThrow('cannot alter immutable field scripts')
    await writeFile(manifest, originalManifest)
    const tsconfig = join(current, 'plugins', view.name, 'tsconfig.json')
    const originalTsconfig = await readFile(tsconfig, 'utf8')
    await writeFile(tsconfig, `${originalTsconfig}\n`)
    await expect(verifyCreatedPluginWorkspace(options)).rejects.toThrow('Host-owned generated file')
    await writeFile(tsconfig, originalTsconfig)
    const lockPath = join(current, 'pnpm-lock.yaml')
    await writeFile(lockPath, (await readFile(lockPath, 'utf8')).replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'"))
    await expect(verifyCreatedPluginWorkspace(options)).rejects.toThrow('lock importer changed')
  }, 20_000)

  it('rejects a symlink inserted into candidate source after preparation', async () => {
    const current = await worktree()
    const view = await inspected()
    const creation = { grant: grant(), generatorDigest: view.generatorDigest }
    const options = { worktree: current, baseCommit, name: view.name, environment, signal,
      assertCurrent: () => undefined, creation }
    await prepareCreatedPluginWorkspace({ ...options, files: [{ path: 'README.md', content: '# source\n' }] })
    await symlink('/tmp', join(current, 'plugins', view.name, 'src', 'escape'))
    await expect(verifyCreatedPluginWorkspace(options)).rejects.toThrow('non-regular entry')
  }, 20_000)

  it('counts fixed scaffold files against the final 64-file candidate bound', async () => {
    const current = await worktree()
    const view = await inspected()
    const files = Array.from({ length: 65 - view.files.length }, (_, index) => ({
      path: `src/generated-${index}.ts`, content: `export const item${index} = true\n`,
    }))
    expect(() => validateSourceCreationFiles(files)).not.toThrow()
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
      files, environment, signal, assertCurrent: () => undefined,
      creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow('file bound')
  }, 20_000)

  it('counts fixed scaffold bytes against the final 256 KiB candidate bound', async () => {
    const current = await worktree()
    const view = await inspected()
    const files = ['README.md', 'src/index.ts', 'src/new.ts', 'tests/index.spec.ts']
      .map(path => ({ path, content: 'x'.repeat(65_536) }))
    expect(() => validateSourceCreationFiles(files)).not.toThrow()
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
      files, environment, signal, assertCurrent: () => undefined,
      creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow('bounds')
  }, 20_000)

  it('rejects ambiguous base lock selections before adding an importer', async () => {
    const current = await worktree()
    const lockPath = join(current, 'pnpm-lock.yaml')
    const old = await readFile(lockPath, 'utf8')
    const injected = "  plugins/ambiguity-probe:\n    devDependencies:\n      '@types/node':\n        specifier: 'catalog:'\n        version: 0.0.0\n"
    await writeFile(lockPath, old.replace('\npackages:\n', `\n${injected}\npackages:\n`))
    execFileSync('/usr/bin/git', ['add', 'pnpm-lock.yaml'], { cwd: current })
    execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'ambiguous fixture'], { cwd: current })
    const ambiguousBase = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: current, encoding: 'utf8' }).trim()
    const view = await inspectSourceCreationContext({ repository: current, name: 'rsi-created-example', paths: [],
      baseCommit: ambiguousBase, environment, signal, assertCurrent: () => undefined, grant: grant() })
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit: ambiguousBase, name: view.name,
      files: [{ path: 'README.md', content: '# source\n' }], environment, signal,
      assertCurrent: () => undefined, creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow('ambiguous')
  }, 20_000)

  it.each([
    ['duplicate importer', (lock: string) => lock.replace('\n  plugins/hello:\n', '\n  plugins/hello:\n  plugins/hello:\n'), 'duplicate'],
    ['missing catalog specifier', (lock: string) => lock.replaceAll("'@types/node':\n        specifier: 'catalog:'",
      "'@types/node':\n        specifier: workspace:*"), 'absent or ambiguous'],
  ])('rejects %s in fixed base lock', async (_case, mutate, message) => {
    const current = await worktree()
    const lockPath = join(current, 'pnpm-lock.yaml')
    const original = await readFile(lockPath, 'utf8')
    const changed = mutate(original)
    expect(changed).not.toBe(original)
    await writeFile(lockPath, changed)
    execFileSync('/usr/bin/git', ['add', 'pnpm-lock.yaml'], { cwd: current })
    execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'lock fixture'], { cwd: current })
    const changedBase = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: current, encoding: 'utf8' }).trim()
    const view = await inspectSourceCreationContext({ repository: current, name: 'rsi-created-example', paths: [],
      baseCommit: changedBase, environment, signal, assertCurrent: () => undefined, grant: grant() })
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit: changedBase, name: view.name,
      files: [{ path: 'README.md', content: '# source\n' }], environment, signal,
      assertCurrent: () => undefined, creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow(message)
  }, 20_000)

  it('supports tool/service/channel/ui creation with controlled package.json, cordis.patch.yml, and lockfile sync, and rejects tampering', async () => {
    expect(CANDIDATE_PLUGIN_KINDS).toEqual(['tool', 'service', 'channel', 'ui'])
    expect(normalizeCandidatePluginKind(undefined)).toBe('tool')

    // Digest compatibility: omitted pluginKind and explicit 'tool' strip pluginKind in persisted intents,
    // whereas 'service' / 'channel' / 'ui' produce distinct bound digests.
    const normalizeIntent = (intent: { mode: 'create'; name: string; files: { path: string; content: string }[]; baseCommit: string; pluginKind?: 'tool' | 'service' | 'channel' | 'ui' }) =>
      intent.pluginKind === undefined || intent.pluginKind === 'tool'
        ? { mode: intent.mode, name: intent.name, files: intent.files, baseCommit: intent.baseCommit }
        : intent
    const baseIntent = { mode: 'create' as const, name: 'rsi-created-service',
      files: [{ path: 'README.md', content: '# svc\n' }], baseCommit }
    const digestDefault = controlPlaneDigest(normalizeIntent(baseIntent))
    const digestTool = controlPlaneDigest(normalizeIntent({ ...baseIntent, pluginKind: 'tool' }))
    const digestService = controlPlaneDigest(normalizeIntent({ ...baseIntent, pluginKind: 'service' }))
    expect(digestTool).toBe(digestDefault)
    expect(digestService).not.toBe(digestDefault)

    for (const kind of ['service', 'channel', 'ui'] as const) {
      const pluginName = `rsi-created-${kind}`
      const view = await inspectSourceCreationContext({
        repository, name: pluginName, paths: ['package.json', 'cordis.patch.yml'],
        baseCommit, environment, signal, assertCurrent: () => undefined, grant: grant(),
      })
      const baseManifest = JSON.parse(view.contents.find(c => c.path === 'package.json')!.content) as Record<string, unknown>
      const updatedManifest = {
        ...baseManifest,
        description: `Candidate ${kind} capability`,
        dsh: {
          ...(baseManifest.dsh as Record<string, unknown>),
          pluginKind: kind,
        },
        dependencies: {
          ...(baseManifest.dependencies as Record<string, string> | undefined),
          '@deepseek-ai/schemastery': 'catalog:',
        },
        peerDependencies: {
          ...(baseManifest.peerDependencies as Record<string, string> | undefined),
          '@dsh-ray/assistant-delivery': '>=0.1.0',
        },
        peerDependenciesMeta: {
          ...(baseManifest.peerDependenciesMeta as Record<string, { optional: boolean }> | undefined),
          '@dsh-ray/assistant-delivery': { optional: true },
        },
      }
      const updatedPatch = [
        '- insert:',
        `    - id: dsh-ray-${pluginName}`,
        `      name: '@dsh-ray/${pluginName}'`,
        '      inject:',
        '        - assistantAutomations',
        '      config:',
        '        enabled: true',
        '',
      ].join('\n')
      const files = [
        { path: 'README.md', content: `# ${kind} plugin\n` },
        { path: 'package.json', content: `${JSON.stringify(updatedManifest, null, 2)}\n` },
        { path: 'cordis.patch.yml', content: updatedPatch },
      ]
      expect(extractCandidatePluginKindFromFiles(files)).toBe(kind)

      const current = await worktree()
      const creation = { grant: grant(), generatorDigest: view.generatorDigest }
      const prep = await prepareCreatedPluginWorkspace({
        worktree: current, baseCommit, name: pluginName, files,
        environment, signal, assertCurrent: () => undefined, creation,
      })
      expect(prep.scope).toContain('pnpm-lock.yaml')
      const verified = await verifyCreatedPluginWorkspace({
        worktree: current, baseCommit, name: pluginName, files,
        environment, signal, assertCurrent: () => undefined, creation,
      })
      expect(verified.generatorDigest).toBe(view.generatorDigest)
      const lockContent = await readFile(join(current, 'pnpm-lock.yaml'), 'utf8')
      expect(lockContent).toContain(`plugins/${pluginName}:`)
      expect(lockContent).toContain("'@deepseek-ai/schemastery':")
    }

    // Tamper checks against controlled manifest & patch invariants
    const tamperView = await inspectSourceCreationContext({
      repository, name: 'rsi-created-tamper', paths: ['package.json', 'cordis.patch.yml'],
      baseCommit, environment, signal, assertCurrent: () => undefined, grant: grant(),
    })
    const tamperBase = JSON.parse(tamperView.contents.find(c => c.path === 'package.json')!.content) as Record<string, unknown>
    const creation = { grant: grant(), generatorDigest: tamperView.generatorDigest }

    const rejectCases: { label: string; files: { path: string; content: string }[]; pattern: RegExp }[] = [
      {
        label: 'invalid pluginKind in dsh metadata',
        files: [{ path: 'package.json', content: JSON.stringify({ ...tamperBase, dsh: { ...(tamperBase.dsh as object), pluginKind: 'kernel' } }) }],
        pattern: /pluginKind is invalid/u,
      },
      {
        label: 'altering package name',
        files: [{ path: 'package.json', content: JSON.stringify({ ...tamperBase, name: '@dsh-ray/hijacked' }) }],
        pattern: /cannot alter package name/u,
      },
      {
        label: 'altering scripts',
        files: [{ path: 'package.json', content: JSON.stringify({ ...tamperBase, scripts: { postinstall: 'curl bad' } }) }],
        pattern: /cannot alter immutable field scripts/u,
      },
      {
        label: 'adding dsh.protection',
        files: [{ path: 'package.json', content: JSON.stringify({ ...tamperBase, dsh: { ...(tamperBase.dsh as object), protection: { sealed: false } } }) }],
        pattern: /disallowed dsh key protection/u,
      },
      {
        label: 'non-catalog dependency',
        files: [{ path: 'package.json', content: JSON.stringify({ ...tamperBase, dependencies: { lodash: '^4.17.21' } }) }],
        pattern: /must use catalog:/u,
      },
      {
        label: 'non-optional peerDependency',
        files: [{ path: 'package.json', content: JSON.stringify({ ...tamperBase, peerDependencies: { '@dsh-ray/assistant-delivery': '*' }, peerDependenciesMeta: { '@dsh-ray/assistant-delivery': { optional: false } } }) }],
        pattern: /must be marked optional/u,
      },
      {
        label: 'cordis.patch.yml wrong package name',
        files: [{ path: 'cordis.patch.yml', content: '- insert:\n    - id: dsh-ray-rsi-created-tamper\n      name: "@dsh-ray/other"\n' }],
        pattern: /must mount @dsh-ray\/rsi-created-tamper/u,
      },
      {
        label: 'cordis.patch.yml multiple insert entries',
        files: [{ path: 'cordis.patch.yml', content: '- insert:\n    - id: dsh-ray-rsi-created-tamper\n      name: "@dsh-ray/rsi-created-tamper"\n    - id: extra\n      name: "@dsh-ray/extra"\n' }],
        pattern: /insert must contain exactly one entry/u,
      },
    ]

    for (const c of rejectCases) {
      const current = await worktree()
      await expect(prepareCreatedPluginWorkspace({
        worktree: current, baseCommit, name: 'rsi-created-tamper', files: c.files,
        environment, signal, assertCurrent: () => undefined, creation,
      })).rejects.toThrow(c.pattern)
    }
  }, 90_000)

  it('aligns dsh.kind, dsh.ui/channel/client, exports["./client"], cordis.patch.yml declarations, and peer range security with assistant-verifier', async () => {
    const view = await inspectSourceCreationContext({
      repository, name: 'rsi-created-verifier-ui', paths: ['package.json', 'cordis.patch.yml'],
      baseCommit, environment, signal, assertCurrent: () => undefined, grant: grant(),
    })
    const baseManifest = JSON.parse(view.contents.find(c => c.path === 'package.json')!.content) as Record<string, unknown>
    const baseExports = baseManifest.exports as Record<string, unknown>
    const uiManifest = {
      ...baseManifest,
      exports: {
        ...baseExports,
        './client': { types: './lib/client.d.ts', default: './lib/client.js' },
      },
      dsh: {
        ...(baseManifest.dsh as Record<string, unknown>),
        kind: 'ui',
        ui: { routes: ['/rsi-created-verifier-ui'], title: 'UI Panel' },
        client: { entry: './lib/client.js' },
      },
      peerDependencies: {
        ...(baseManifest.peerDependencies as Record<string, string>),
        '@dsh-ray/assistant-delivery': 'workspace:*',
      },
      peerDependenciesMeta: {
        ...(baseManifest.peerDependenciesMeta as Record<string, { optional: boolean }>),
        '@dsh-ray/assistant-delivery': { optional: true },
      },
    }
    const uiPatch = [
      '- insert:',
      '    - id: dsh-ray-rsi-created-verifier-ui',
      "      name: '@dsh-ray/rsi-created-verifier-ui'",
      '      inject: [typert]',
      '      ui:',
      '        panel: true',
      '      routes:',
      '        - path: /rsi-created-verifier-ui',
      '          label: Verifier UI',
      '      sections:',
      '        - id: main',
      '      settings:',
      '        refreshMs: 5000',
      '      channel:',
      '        bridge: false',
      '      services:',
      '        - uiHelper',
      '      provides:',
      '        - uiHelper',
      '',
    ].join('\n')
    const uiFiles = [
      { path: 'README.md', content: '# UI plugin\n' },
      { path: 'package.json', content: `${JSON.stringify(uiManifest, null, 2)}\n` },
      { path: 'cordis.patch.yml', content: uiPatch },
    ]
    expect(extractCandidatePluginKindFromFiles(uiFiles)).toBe('ui')
    expect(extractCandidatePluginKindFromManifestText(uiFiles[1]!.content)).toBe('ui')
    const parsedPatch = parseControlledPatchYaml(uiPatch)
    expect(parsedPatch.inject).toEqual(['typert'])
    expect(parsedPatch.routes).toEqual([{ path: '/rsi-created-verifier-ui', label: 'Verifier UI' }])
    expect(parsedPatch.provides).toEqual(['uiHelper'])

    const current = await worktree()
    const creation = { grant: grant(), generatorDigest: view.generatorDigest }
    await prepareCreatedPluginWorkspace({
      worktree: current, baseCommit, name: 'rsi-created-verifier-ui', files: uiFiles,
      environment, signal, assertCurrent: () => undefined, creation,
    })
    await expect(verifyCreatedPluginWorkspace({
      worktree: current, baseCommit, name: 'rsi-created-verifier-ui', files: uiFiles,
      environment, signal, assertCurrent: () => undefined, creation,
    })).resolves.toMatchObject({ generatorDigest: view.generatorDigest })

    // Channel manifest with dsh.kind + dsh.channel + string exports['./client']
    const chanManifest = {
      ...baseManifest,
      exports: { ...baseExports, './client': './lib/client.js' },
      dsh: { ...(baseManifest.dsh as Record<string, unknown>), kind: 'channel', channel: { adapter: 'webhook' } },
    }
    expect(extractCandidatePluginKindFromManifestText(JSON.stringify(chanManifest))).toBe('channel')

    // Rejections for mismatched dsh.kind vs dsh.pluginKind, unsafe exports['./client'], unsafe peerDependencies, and YAML attack vectors
    const badManifests = [
      JSON.stringify({ ...baseManifest, dsh: { ...(baseManifest.dsh as object), kind: 'ui', pluginKind: 'service' } }),
      JSON.stringify({ ...baseManifest, exports: { ...baseExports, './client': '../escape.js' } }),
      JSON.stringify({ ...baseManifest, exports: { ...baseExports, './client': './src/client.js' } }),
      JSON.stringify({ ...baseManifest, exports: { ...baseExports, './secret': './package.json' } }),
      JSON.stringify({ ...baseManifest, exports: { ...baseExports, '.': './lib/hijack.js' } }),
      JSON.stringify({ ...baseManifest, peerDependencies: { '@dsh-ray/assistant-delivery': 'file:../evil' }, peerDependenciesMeta: { '@dsh-ray/assistant-delivery': { optional: true } } }),
      JSON.stringify({ ...baseManifest, peerDependencies: { '@dsh-ray/assistant-delivery': 'http://evil.invalid/pkg.tgz' }, peerDependenciesMeta: { '@dsh-ray/assistant-delivery': { optional: true } } }),
      JSON.stringify({ ...baseManifest, peerDependencies: { '@dsh-ray/assistant-delivery': 'git+https://evil.invalid/repo.git' }, peerDependenciesMeta: { '@dsh-ray/assistant-delivery': { optional: true } } }),
    ]
    for (const content of badManifests) {
      const wt = await worktree()
      await expect(prepareCreatedPluginWorkspace({
        worktree: wt, baseCommit, name: 'rsi-created-verifier-ui',
        files: [{ path: 'package.json', content }],
        environment, signal, assertCurrent: () => undefined, creation,
      })).rejects.toThrow(/outside candidate authority|cannot alter immutable|disallowed/u)
    }

    const badYamls = [
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n      ui: !!js/function 'function(){}'\n",
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n      routes: &a [1]\n",
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n      routes: *a\n",
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n      <<: *a\n",
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n\tdisabled: false\n",
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n      ui: '{{secret}}'\n",
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\r\n      name: '@dsh-ray/rsi-created-verifier-ui'\r\n",
      "---\n- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n",
      "- insert:\n    - id: dsh-ray-rsi-created-verifier-ui\n      name: '@dsh-ray/rsi-created-verifier-ui'\n      ui:\n        __proto__: {}\n",
    ]
    for (const content of badYamls) {
      expect(() => validateSourceCreationFiles([{ path: 'cordis.patch.yml', content }])).toThrow(/outside candidate authority|forbidden|unsafe|invalid key/u)
    }
  }, 90_000)
})
