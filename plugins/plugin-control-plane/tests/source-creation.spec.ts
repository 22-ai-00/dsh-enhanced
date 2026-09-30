import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createIsolatedWorktree } from '../src/source-workspace.ts'
import { inspectSourceCreationContext, prepareCreatedPluginWorkspace, validateSourceCreationFiles,
  validateSourceCreationGrant, verifyCreatedPluginWorkspace, type SourceCreationGrant } from '../src/source-creation.ts'
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
})

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
    expect(view.contents[0]?.content).toContain("dsh-enhanced-rsi-created-example")
    expect(JSON.parse(view.contents[1]!.content)).toMatchObject({ name: '@dsh-enhanced/rsi-created-example', version: '0.1.0' })
    expect(execFileSync('/usr/bin/git', ['worktree', 'list', '--porcelain'], { cwd: repository, encoding: 'utf8' })).toBe(before)
  })

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
        output = execFileSync('pnpm', ['--filter', `@dsh-enhanced/${view.name}`, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'], {
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
  })

  it('rejects a package identity collision in another directory of the pinned base', async () => {
    const current = await worktree()
    const alias = join(current, 'packages', 'different-directory')
    await mkdir(alias)
    await writeFile(join(alias, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/rsi-created-example', version: '1.0.0' }))
    execFileSync('/usr/bin/git', ['add', '--', 'packages/different-directory/package.json'], { cwd: current })
    execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'colliding package fixture'], { cwd: current })
    const collidingBase = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: current, encoding: 'utf8' }).trim()
    await expect(inspectSourceCreationContext({ repository: current, name: 'rsi-created-example', paths: [],
      baseCommit: collidingBase, environment, signal, assertCurrent: () => undefined, grant: grant() }))
      .rejects.toThrow('package identity already exists')
  })

  it('rejects worktree template drift before executing the generator', async () => {
    const current = await worktree()
    const view = await inspected()
    await writeFile(join(current, 'templates', 'plugin', 'README.md.tpl'), 'tampered\n')
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
      files: [{ path: 'README.md', content: 'text' }], environment, signal,
      assertCurrent: () => undefined, creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow()
  })

  it('detects Host manifest and existing lock projection changes after proposal writes', async () => {
    const current = await worktree()
    const view = await inspected()
    const creation = { grant: grant(), generatorDigest: view.generatorDigest }
    const options = { worktree: current, baseCommit, name: view.name, environment, signal,
      assertCurrent: () => undefined, creation }
    await prepareCreatedPluginWorkspace({ ...options, files: [{ path: 'README.md', content: '# source\n' }] })
    const manifest = join(current, 'plugins', view.name, 'package.json')
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}\n`)
    await expect(verifyCreatedPluginWorkspace(options)).rejects.toThrow('Host-owned generated file')
    await writeFile(manifest, (await readFile(manifest, 'utf8')).trimEnd() + '\n')
    const lockPath = join(current, 'pnpm-lock.yaml')
    await writeFile(lockPath, (await readFile(lockPath, 'utf8')).replace("lockfileVersion: '9.0'", "lockfileVersion: '8.0'"))
    await expect(verifyCreatedPluginWorkspace(options)).rejects.toThrow('lock importer changed')
  })

  it('rejects a symlink inserted into candidate source after preparation', async () => {
    const current = await worktree()
    const view = await inspected()
    const creation = { grant: grant(), generatorDigest: view.generatorDigest }
    const options = { worktree: current, baseCommit, name: view.name, environment, signal,
      assertCurrent: () => undefined, creation }
    await prepareCreatedPluginWorkspace({ ...options, files: [{ path: 'README.md', content: '# source\n' }] })
    await symlink('/tmp', join(current, 'plugins', view.name, 'src', 'escape'))
    await expect(verifyCreatedPluginWorkspace(options)).rejects.toThrow('non-regular entry')
  })

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
  })

  it('counts fixed scaffold bytes against the final 256 KiB candidate bound', async () => {
    const current = await worktree()
    const view = await inspected()
    const files = ['README.md', 'src/index.ts', 'src/new.ts', 'tests/index.spec.ts']
      .map(path => ({ path, content: 'x'.repeat(65_536) }))
    expect(() => validateSourceCreationFiles(files)).not.toThrow()
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit, name: view.name,
      files, environment, signal, assertCurrent: () => undefined,
      creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow('bounds')
  })

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
  })

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
    execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'lock fixture'], { cwd: current })
    const changedBase = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: current, encoding: 'utf8' }).trim()
    const view = await inspectSourceCreationContext({ repository: current, name: 'rsi-created-example', paths: [],
      baseCommit: changedBase, environment, signal, assertCurrent: () => undefined, grant: grant() })
    await expect(prepareCreatedPluginWorkspace({ worktree: current, baseCommit: changedBase, name: view.name,
      files: [{ path: 'README.md', content: '# source\n' }], environment, signal,
      assertCurrent: () => undefined, creation: { grant: grant(), generatorDigest: view.generatorDigest } })).rejects.toThrow(message)
  })
})
