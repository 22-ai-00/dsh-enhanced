// Execute the exact container entry script against a private workspace. The
// pnpm executable here is a fixture; tar, shell, Node, checksums, and every
// input comparison are real. No Docker daemon or real package scripts run.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PREPARED_SOURCE_BUILD_SCRIPT } from '../src/source-build.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('keeps the fixed container command within the durable evidence argument bound', () => {
  expect(Buffer.byteLength(PREPARED_SOURCE_BUILD_SCRIPT)).toBeLessThanOrEqual(32_768)
})

interface Fixture {
  root: string
  workspace: string
  scratch: string
  archive: Buffer
  run(mutation?: string, trust?: 'match' | 'mismatch' | 'absent', capture?: boolean): Promise<{ code: number | null; stdout: string; stderr: string }>
}

function archiveMode(archive: Buffer, entry: string): number | undefined {
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0]
    const mode = Number.parseInt(header.subarray(100, 108).toString('ascii').split('\0')[0]!, 8)
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').split('\0')[0]!, 8)
    if (name === entry) return mode & 0o777
    at += 512 + Math.ceil(size / 512) * 512
  }
  return undefined
}

async function fixture(options: { unsafeBin?: string; nonExecutableBin?: boolean; linkedBin?: boolean;
  linkedGeneratedBinParent?: boolean; scripts?: 'mixed' | 'none' | 'hooks-only' } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'source-build-integrity-'))
  roots.push(root)
  const source = join(root, 'source')
  const workspace = join(root, 'workspace')
  const scratch = join(root, 'scratch')
  const bin = join(root, 'bin')
  const plugin = join(source, 'plugins', 'helper')
  await Promise.all([mkdir(join(plugin, 'src'), { recursive: true }), mkdir(join(plugin, 'tests'), { recursive: true }),
    mkdir(join(plugin, 'bin'), { recursive: true }),
    mkdir(workspace), mkdir(scratch), mkdir(bin)])
  const scripts = options.scripts === 'none' ? undefined : options.scripts === 'hooks-only'
    ? { prepack: 'pnpm build', prepublishOnly: 'node release.js' }
    : { test: 'vitest run', prepack: 'pnpm build', build: 'tsc', prepublishOnly: 'node release.js', typecheck: 'tsc --noEmit' }
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/helper', version: '1.0.0',
    packageManager: 'pnpm@11.7.0', pnpm: { overrides: { fixture: '1.0.0' } }, scripts,
    bin: { helper: options.unsafeBin ?? './run.sh', alternate: './bin/alternate.js', generated: './lib/generated-cli.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } }, files: ['bin', 'run.sh', 'lib', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    main: './lib/index.js', types: './lib/index.d.ts',
    exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' }, './cordis.patch.yml': './cordis.patch.yml' },
    imports: { '#entry': { import: './lib/index.js', default: './lib/index.js' } },
    dependencies: { '@deepseek-ai/cordis': 'catalog:', '@dsh-enhanced/helper-lib': 'workspace:*' },
    devDependencies: { '@types/node': 'catalog:tooling' } }) + '\n')
  await writeFile(join(plugin, 'cordis.patch.yml'), 'mount: "@dsh-enhanced/helper"\n')
  await writeFile(join(plugin, 'README.md'), '# Helper\n')
  await writeFile(join(plugin, 'LICENSE'), 'MIT\n')
  await writeFile(join(plugin, 'src', 'index.ts'), 'export const answer = 42\n')
  await writeFile(join(plugin, 'src', `${'long-name-'.repeat(12)}.ts`), 'export const longPath = true\n')
  await writeFile(join(plugin, 'tests', 'index.spec.ts'), 'export {}\n')
  await mkdir(join(source, 'packages', 'helper-lib'), { recursive: true })
  await mkdir(join(source, 'packages', 'helper-lib', 'bin'))
  await writeFile(join(source, 'packages', 'helper-lib', 'package.json'), '{"name":"@dsh-enhanced/helper-lib","version":"2.3.4","bin":"./bin/helper-lib.js"}\n')
  await writeFile(join(source, 'packages', 'helper-lib', 'bin', 'helper-lib.js'), '#!/usr/bin/env node\n')
  await chmod(join(source, 'packages', 'helper-lib', 'bin', 'helper-lib.js'), 0o755)
  await writeFile(join(plugin, 'bin', 'alternate.js'), '#!/usr/bin/env node\n')
  await chmod(join(plugin, 'bin', 'alternate.js'), 0o755)
  if (options.linkedBin) await symlink('src/index.ts', join(plugin, 'run.sh'))
  else {
    await writeFile(join(plugin, 'run.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(plugin, 'run.sh'), options.nonExecutableBin ? 0o644 : 0o755)
  }
  if (options.linkedGeneratedBinParent) await symlink('src', join(plugin, 'lib'))
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(source, 'pnpm-workspace.yaml'), "packages:\n  - plugins/*\n  - packages/*\ncatalog:\n  '@deepseek-ai/cordis': 4.0.2\ncatalogs:\n  tooling:\n    '@types/node': 22.20.0\n")
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: source, encoding: 'utf8' })
  git('init', '-q'); git('add', '--all')
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
  const archive = execFileSync('/usr/bin/git', ['archive', '--format=tar', 'HEAD'], { cwd: source, maxBuffer: 2_000_000 })
  const baseline = join(root, 'baseline-lock.yaml')
  await writeFile(baseline, 'lockfileVersion: 9\n')
  const pnpm = join(bin, 'pnpm')
  const node = join(bin, 'node')
  await writeFile(node, `#!/bin/sh
set -eu
if [ "$1" = - ]; then
  count=0
  if [ -f "$TEST_SCRATCH/node-count" ]; then count="$(cat "$TEST_SCRATCH/node-count")"; fi
  count="$((count + 1))"
  printf '%s' "$count" > "$TEST_SCRATCH/node-count"
  if [ "$TEST_MUTATION" = pack-archive-race ] && [ "$count" = 4 ]; then printf altered >> "$2"; fi
fi
exec '${process.execPath}' "$@"
`)
  await chmod(node, 0o700)
  await writeFile(pnpm, `#!/bin/sh
set -eu
case "$1" in
  --version) if [ "$TEST_MUTATION" = pnpm-other-version ]; then printf '11.7.1\\n'; else printf '11.7.0\\n'; fi;;
  install) umask > "$TEST_SCRATCH/install-umask"; stat -c %a "$TEST_WORKSPACE/plugins/helper/run.sh" > "$TEST_SCRATCH/bin-mode-at-install"; printf '%s\\n' "$@" > "$TEST_SCRATCH/install-args"; mkdir -p "$TEST_WORKSPACE/node_modules"; printf generated > "$TEST_WORKSPACE/node_modules/dependency";;
  check)
    umask > "$TEST_SCRATCH/check-umask"
    mkdir -p "$TEST_WORKSPACE/plugins/helper/generated-check-umask-dir"
    printf generated > "$TEST_WORKSPACE/plugins/helper/generated-check-umask-file"
    mkdir -p "$TEST_WORKSPACE/plugins/helper/lib"
    printf generated > "$TEST_WORKSPACE/plugins/helper/lib/index.js"
    printf 'export declare const generated: true\\n' > "$TEST_WORKSPACE/plugins/helper/lib/index.d.ts"
    printf '#!/usr/bin/env node\\n' > "$TEST_WORKSPACE/plugins/helper/lib/generated-cli.js"
    chmod 755 "$TEST_WORKSPACE/plugins/helper/lib/generated-cli.js"
    case "$TEST_MUTATION" in
      check-manifest) printf altered > "$TEST_WORKSPACE/plugins/helper/package.json";;
      check-source) printf altered > "$TEST_WORKSPACE/plugins/helper/src/index.ts";;
      check-archive) set -- "$TEST_SCRATCH"/dsh-source-input.*; printf altered >> "$1";;
      check-symlink) rm "$TEST_WORKSPACE/plugins/helper/src/index.ts"; ln -s "$TEST_SCRATCH/target" "$TEST_WORKSPACE/plugins/helper/src/index.ts";;
      check-mode-file) chmod 600 "$TEST_WORKSPACE/plugins/helper/run.sh";;
      check-mode-dir) chmod 770 "$TEST_WORKSPACE/plugins/helper";;
      check-bin-content) printf '#!/bin/sh\\nexit 1\\n' > "$TEST_WORKSPACE/plugins/helper/run.sh";;
      check-bin-size) printf altered >> "$TEST_WORKSPACE/plugins/helper/run.sh";;
      check-bin-symlink) rm "$TEST_WORKSPACE/plugins/helper/run.sh"; ln -s "$TEST_SCRATCH/target" "$TEST_WORKSPACE/plugins/helper/run.sh";;
      check-bin-hardlink) ln "$TEST_WORKSPACE/plugins/helper/run.sh" "$TEST_SCRATCH/hardlink";;
      check-bin-mode-700) chmod 700 "$TEST_WORKSPACE/plugins/helper/run.sh";;
      check-bin-mode-777) chmod 777 "$TEST_WORKSPACE/plugins/helper/run.sh";;
      check-bin-setuid) chmod 4755 "$TEST_WORKSPACE/plugins/helper/run.sh";;
      check-nonbin-exec) chmod 755 "$TEST_WORKSPACE/plugins/helper/src/index.ts";;
      check-dir-special) chmod 2700 "$TEST_WORKSPACE/plugins/helper/tests";;
      check-bin-manifest-expand)
        node -e 'const fs=require("node:fs"); const p=process.argv[1]; const target=process.argv[2]; const original=fs.readFileSync(p); const m=JSON.parse(original.toString("utf8")); m.bin.extra="src/index.ts"; fs.writeFileSync(p,JSON.stringify(m)); fs.chmodSync(target,0o755); fs.writeFileSync(p,original)' "$TEST_WORKSPACE/plugins/helper/package.json" "$TEST_WORKSPACE/plugins/helper/src/index.ts";;
    esac;;
  pack)
    umask > "$TEST_SCRATCH/pack-umask"
    printf started > "$TEST_SCRATCH/pack-started"
    if [ "$TEST_MUTATION" = pack-manifest ]; then printf altered > "$TEST_WORKSPACE/plugins/helper/package.json"; fi
    if [ "$TEST_MUTATION" = pack-source ]; then printf altered > "$TEST_WORKSPACE/plugins/helper/src/index.ts"; fi
    if [ "$TEST_MUTATION" = pack-archive ]; then set -- "$TEST_SCRATCH"/dsh-source-input.*; printf altered >> "$1"; fi
    if [ "$TEST_MUTATION" = pack-transient-manifest ]; then
      cp "$TEST_WORKSPACE/plugins/helper/package.json" "$TEST_SCRATCH/original-package.json"
      printf '{"name":"@dsh-enhanced/foreign","version":"9.0.0"}\n' > "$TEST_WORKSPACE/plugins/helper/package.json"
    fi
    if [ "$TEST_MUTATION" = pack-transient-patch ]; then
      cp "$TEST_WORKSPACE/plugins/helper/cordis.patch.yml" "$TEST_SCRATCH/original-patch"
      printf 'mount: "@dsh-enhanced/foreign"\n' > "$TEST_WORKSPACE/plugins/helper/cordis.patch.yml"
    fi
    if [ "$TEST_MUTATION" = pack-transient-readme ]; then
      cp "$TEST_WORKSPACE/plugins/helper/README.md" "$TEST_SCRATCH/original-readme"
      printf '# Foreign\\n' > "$TEST_WORKSPACE/plugins/helper/README.md"
    fi
    if [ "$TEST_MUTATION" = pack-transient-license ]; then
      cp "$TEST_WORKSPACE/plugins/helper/LICENSE" "$TEST_SCRATCH/original-license"
      printf 'Foreign\\n' > "$TEST_WORKSPACE/plugins/helper/LICENSE"
    fi
    if [ "$TEST_MUTATION" != pack-manifest ]; then
      cp "$TEST_WORKSPACE/plugins/helper/package.json" "$TEST_SCRATCH/package-before-pack"
      node -e '
        const fs=require("node:fs")
        const p=process.argv[1], mutation=process.argv[2], source=JSON.parse(fs.readFileSync(p,"utf8")), x={}
        for(const [key,value] of Object.entries(source)) if(!["scripts","packageManager","pnpm"].includes(key)) x[key]=value
        if(source.scripts!=null){
          const scripts={}, omitted=new Set(["prepublishOnly","prepack","prepare","postpack","publish","postpublish"])
          for(const [key,value] of Object.entries(source.scripts)) if(!omitted.has(key)) scripts[key]=value
          x.scripts=scripts
        }
        if(x.dependencies){x.dependencies["@deepseek-ai/cordis"]="4.0.2";x.dependencies["@dsh-enhanced/helper-lib"]="2.3.4"}
        if(x.devDependencies)x.devDependencies["@types/node"]="22.20.0"
        if(mutation==="pack-transient-deps")x.dependencies["@deepseek-ai/cordis"]="99.0.0"
        if(mutation==="pack-transient-exports")x.exports["."]={default:"./lib/index.js",types:"./lib/index.d.ts"}
        if(mutation==="pack-transient-imports")x.imports["#entry"]={default:"./lib/index.js",import:"./lib/index.js"}
        if(mutation==="pack-transient-retained-script")x.scripts.test="node malicious.js"
        if(mutation==="pack-transient-script-order")x.scripts={typecheck:x.scripts.typecheck,test:x.scripts.test,build:x.scripts.build}
        if(mutation==="pack-transient-hook")x.scripts.prepack="node malicious.js"
        if(mutation==="pack-transient-version")x.version="9.0.0"
        if(mutation==="pack-transient-bundle")x.dsh.bundle.patch="./other.patch.yml"
        if(mutation==="pack-transient-files")x.files=["lib","README.md"]
        fs.writeFileSync(p,JSON.stringify(x))
      ' "$TEST_WORKSPACE/plugins/helper/package.json" "$TEST_MUTATION"
    fi
    cd "$TEST_WORKSPACE/plugins/helper"
    case "$TEST_MUTATION" in
      pack-missing) tar -czf "$TEST_WORKSPACE/.dsh-pack/helper-1.0.0.tgz" --transform='s,^,package/,' package.json README.md LICENSE bin run.sh lib;;
      pack-missing-entry) tar -czf "$TEST_WORKSPACE/.dsh-pack/helper-1.0.0.tgz" --transform='s,^,package/,' package.json cordis.patch.yml README.md LICENSE bin run.sh;;
      pack-duplicate) tar -czf "$TEST_WORKSPACE/.dsh-pack/helper-1.0.0.tgz" --transform='s,^,package/,' package.json package.json cordis.patch.yml README.md LICENSE bin run.sh lib;;
      pack-unsafe) tar -czf "$TEST_WORKSPACE/.dsh-pack/helper-1.0.0.tgz" --transform='s,^,../package/,' package.json cordis.patch.yml README.md LICENSE bin run.sh lib;;
      *) tar -czf "$TEST_WORKSPACE/.dsh-pack/helper-1.0.0.tgz" --transform='s,^,package/,' package.json cordis.patch.yml README.md LICENSE bin run.sh lib;;
    esac
    if [ "$TEST_MUTATION" = pack-symlink ]; then
      mv "$TEST_WORKSPACE/.dsh-pack/helper-1.0.0.tgz" "$TEST_SCRATCH/original-pack.tgz"
      ln -s "$TEST_SCRATCH/original-pack.tgz" "$TEST_WORKSPACE/.dsh-pack/helper-1.0.0.tgz"
    fi
    if [ -f "$TEST_SCRATCH/package-before-pack" ]; then cp "$TEST_SCRATCH/package-before-pack" "$TEST_WORKSPACE/plugins/helper/package.json"; fi
    if [ "$TEST_MUTATION" = pack-transient-manifest ]; then cp "$TEST_SCRATCH/original-package.json" "$TEST_WORKSPACE/plugins/helper/package.json"; fi
    if [ "$TEST_MUTATION" = pack-transient-patch ]; then cp "$TEST_SCRATCH/original-patch" "$TEST_WORKSPACE/plugins/helper/cordis.patch.yml"; fi
    if [ "$TEST_MUTATION" = pack-transient-readme ]; then cp "$TEST_SCRATCH/original-readme" "$TEST_WORKSPACE/plugins/helper/README.md"; fi
    if [ "$TEST_MUTATION" = pack-transient-license ]; then cp "$TEST_SCRATCH/original-license" "$TEST_WORKSPACE/plugins/helper/LICENSE"; fi;;
  *) exit 97;;
esac
`)
  await chmod(pnpm, 0o700)
  // Only the absolute scratch/workspace roots differ from Docker. All shell,
  // archive-verification and phase-ordering code stays byte-identical.
  const script = PREPARED_SOURCE_BUILD_SCRIPT.replaceAll('/opt/dsh-source-baseline/pnpm-lock.yaml', '__DSH_TEST_BASELINE__')
    .replaceAll('/workspace', '__DSH_TEST_WORKSPACE__')
    .replaceAll('/tmp', '__DSH_TEST_SCRATCH__')
    .replaceAll('__DSH_TEST_WORKSPACE__', workspace).replaceAll('__DSH_TEST_SCRATCH__', scratch)
    .replaceAll('__DSH_TEST_BASELINE__', baseline)
  const run = async (mutation = '', trust?: 'match' | 'mismatch' | 'absent', capture = false): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    if (trust === 'absent') await rm(baseline)
    // The outer source builder may itself be exercising a creation grant.
    // This private script receives creation env only from this test's trust input.
    const childEnvironment = { ...process.env }
    delete childEnvironment.DSH_SOURCE_TRUST_LOCKFILE
    delete childEnvironment.DSH_SOURCE_BASE_LOCK_SHA256
    delete childEnvironment.DSH_SOURCE_CAPTURE_PACK
    const child = spawn('/bin/sh', ['-ceu', script], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...childEnvironment, PATH: `${bin}:${process.env.PATH ?? ''}`, PLUGIN_ROOT: 'plugins/helper',
        TEST_WORKSPACE: workspace, TEST_SCRATCH: scratch, TEST_MUTATION: mutation,
        ...(capture ? { DSH_SOURCE_CAPTURE_PACK: 'true' } : {}),
        ...(trust === undefined ? {} : { DSH_SOURCE_TRUST_LOCKFILE: 'true',
          DSH_SOURCE_BASE_LOCK_SHA256: trust === 'mismatch' ? '0'.repeat(64)
            : createHash('sha256').update('lockfileVersion: 9\n').digest('hex') }) } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.stdin.end(archive)
    const code = await new Promise<number | null>((resolvePromise, reject) => {
      child.once('error', reject); child.once('close', resolvePromise)
    })
    return { code, stdout, stderr }
  }
  return { root, workspace, scratch, archive, run }
}

it('checks every original archive input, permits generated lib and node_modules, then packs', async () => {
  const f = await fixture()
  expect(archiveMode(f.archive, 'plugins/helper/')).toBe(0o775)
  expect(archiveMode(f.archive, 'plugins/helper/run.sh')).toBe(0o775)
  const result = await f.run()
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/^DSH_PREPARED_PACK\thelper-1\.0\.0\.tgz\t[0-9]+\t[a-f0-9]{64}\tv\S+\t11\.7\.0\n$/u)
  expect(await readFile(join(f.workspace, 'plugins/helper/lib/index.js'), 'utf8')).toBe('generated')
  expect(await readFile(join(f.workspace, 'node_modules/dependency'), 'utf8')).toBe('generated')
  expect(await readFile(join(f.scratch, 'pack-started'), 'utf8')).toBe('started')
  const packedManifest = JSON.parse(execFileSync('/usr/bin/tar', ['-xOzf', join(f.workspace, '.dsh-pack/helper-1.0.0.tgz'), 'package/package.json'], { encoding: 'utf8' })) as Record<string, unknown>
  expect(packedManifest.scripts).toEqual({ test: 'vitest run', build: 'tsc', typecheck: 'tsc --noEmit' })
  expect(Object.keys(packedManifest).at(-1)).toBe('scripts')
  expect(packedManifest).not.toHaveProperty('packageManager')
  expect(packedManifest).not.toHaveProperty('pnpm')
  expect((await lstat(join(f.workspace, 'plugins/helper'))).mode & 0o777).toBe(0o700)
  expect(await readFile(join(f.scratch, 'bin-mode-at-install'), 'utf8')).toBe('755\n')
  expect((await lstat(join(f.workspace, 'plugins/helper/run.sh'))).mode & 0o7777).toBe(0o755)
  expect((await lstat(join(f.workspace, 'plugins/helper/bin/alternate.js'))).mode & 0o7777).toBe(0o755)
  expect((await lstat(join(f.workspace, 'packages/helper-lib/bin/helper-lib.js'))).mode & 0o7777).toBe(0o755)
  expect((await lstat(join(f.workspace, 'plugins/helper/src/index.ts'))).mode & 0o7777).toBe(0o600)
  expect((await lstat(join(f.workspace, 'plugins/helper/package.json'))).mode & 0o777).toBe(0o600)
  expect(Number.parseInt(await readFile(join(f.scratch, 'install-umask'), 'utf8'), 8)).toBe(0o077)
  expect(Number.parseInt(await readFile(join(f.scratch, 'check-umask'), 'utf8'), 8)).toBe(0o022)
  expect(Number.parseInt(await readFile(join(f.scratch, 'pack-umask'), 'utf8'), 8)).toBe(0o077)
  expect((await lstat(join(f.workspace, 'plugins/helper/generated-check-umask-dir'))).mode & 0o777).toBe(0o755)
  expect((await lstat(join(f.workspace, 'plugins/helper/generated-check-umask-file'))).mode & 0o777).toBe(0o644)
})

it('emits a single capture frame from the exact already-verified tgz buffer', async () => {
  const f = await fixture()
  const result = await f.run('', undefined, true)
  expect(result.code, result.stderr).toBe(0)
  const lines = result.stdout.trimEnd().split('\n')
  expect(lines).toHaveLength(2)
  const marker = /^DSH_PREPARED_PACK\t[^\t]+\t([0-9]+)\t([a-f0-9]{64})\t[^\t]+\t[^\t]+$/u.exec(lines[0]!)
  expect(marker).not.toBeNull()
  expect(lines[1]).toMatch(/^DSH_PREPARED_PACK_BYTES_V1\t[A-Za-z0-9+/]+={0,2}$/u)
  const captured = Buffer.from(lines[1]!.slice('DSH_PREPARED_PACK_BYTES_V1\t'.length), 'base64')
  const packed = await readFile(join(f.workspace, '.dsh-pack/helper-1.0.0.tgz'))
  expect(captured).toEqual(packed)
  expect(captured.length).toBe(Number(marker![1]))
  expect(createHash('sha256').update(captured).digest('hex')).toBe(marker![2])
})

it('does not inherit an outer creation grant into the default modify fixture', async () => {
  vi.stubEnv('DSH_SOURCE_TRUST_LOCKFILE', 'true')
  vi.stubEnv('DSH_SOURCE_BASE_LOCK_SHA256', '0'.repeat(64))
  const f = await fixture()
  const result = await f.run()
  expect(result.code).toBe(0)
  expect(await readFile(join(f.scratch, 'install-args'), 'utf8')).not.toContain('--trust-lockfile')
})

it.each(['check-manifest', 'check-source', 'check-archive', 'check-symlink', 'check-mode-file', 'check-mode-dir',
  'check-bin-content', 'check-bin-size', 'check-bin-symlink', 'check-bin-hardlink', 'check-bin-mode-700',
  'check-bin-mode-777', 'check-bin-setuid', 'check-nonbin-exec', 'check-dir-special', 'check-bin-manifest-expand'])
('stops after check changes an original input: %s', async mutation => {
  const f = await fixture()
  const result = await f.run(mutation)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(/source build input (?:archive )?changed|original (?:file|directory) replaced/u)
  await expect(readFile(join(f.scratch, 'pack-started'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  [{ unsafeBin: '../src/index.ts' }, /unsafe archive path/u],
  [{ unsafeBin: '/tmp/foreign' }, /unsafe archive path/u],
  [{ nonExecutableBin: true }, /not an executable regular input/u],
  [{ linkedBin: true }, /not an executable regular input/u],
  [{ linkedGeneratedBinParent: true }, /bin parent is not a directory/u],
] as const)('rejects unsafe immutable bin authority before install: %j', async (options, reason) => {
  const f = await fixture(options)
  const result = await f.run()
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(reason)
  await expect(readFile(join(f.scratch, 'install-args'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['pack-manifest', 'pack-source', 'pack-archive'])('rejects a pack that changes an original input: %s', async mutation => {
  const f = await fixture()
  const result = await f.run(mutation)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(/source build input (?:archive )?changed/u)
  expect(await readFile(join(f.scratch, 'pack-started'), 'utf8')).toBe('started')
  expect(result.stdout).not.toContain('DSH_PREPARED_PACK')
})

it.each(['pack-transient-manifest', 'pack-transient-patch', 'pack-transient-readme', 'pack-transient-license',
  'pack-transient-deps', 'pack-transient-exports', 'pack-transient-imports', 'pack-transient-retained-script', 'pack-transient-script-order',
  'pack-transient-hook', 'pack-transient-version', 'pack-transient-bundle', 'pack-transient-files',
  'pack-missing', 'pack-missing-entry', 'pack-duplicate', 'pack-unsafe', 'pack-symlink',
  'pack-archive-race'])('rejects invalid actual packed artifact: %s', async mutation => {
  const f = await fixture()
  const result = await f.run(mutation)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(/source packed artifact changed/u)
  expect(result.stdout).not.toContain('DSH_PREPARED_PACK')
})

it('accepts pnpm dependency locator normalization while preserving fixed manifest fields', async () => {
  const f = await fixture()
  const result = await f.run('pack-normalized-deps')
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('DSH_PREPARED_PACK')
})

it.each(['none', 'hooks-only'] as const)('accepts the native published scripts shape for %s source scripts', async scripts => {
  const f = await fixture({ scripts })
  const result = await f.run()
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toContain('DSH_PREPARED_PACK')
  const packedManifest = JSON.parse(execFileSync('/usr/bin/tar', ['-xOzf', join(f.workspace, '.dsh-pack/helper-1.0.0.tgz'), 'package/package.json'], { encoding: 'utf8' })) as Record<string, unknown>
  if (scripts === 'none') expect(packedManifest).not.toHaveProperty('scripts')
  else expect(packedManifest.scripts).toEqual({})
})

it('uses trust-lockfile only with a matching immutable image baseline and pnpm 11.7.0', async () => {
  const f = await fixture()
  const result = await f.run('', 'match')
  expect(result.code).toBe(0)
  expect(await readFile(join(f.scratch, 'install-args'), 'utf8')).toContain('--trust-lockfile\n')
})

it('rejects creation trust-lockfile with a different pnpm version before install', async () => {
  const f = await fixture()
  const result = await f.run('pnpm-other-version', 'match')
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(/requires pinned pnpm/u)
  await expect(readFile(join(f.scratch, 'install-args'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['mismatch', 'absent'] as const)('rejects a creation trust-lockfile request without matching image baseline: %s', async trust => {
  const f = await fixture()
  const result = await f.run('', trust)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toMatch(/source creation baseline lock/u)
  await expect(readFile(join(f.scratch, 'pack-started'))).rejects.toMatchObject({ code: 'ENOENT' })
})
