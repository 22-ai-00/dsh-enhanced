import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const { buildLocalUpdateCohort, inspectLocalReleaseBuildEnvironment } = await import(
  new URL('../bin/dsh-local-release-adapter.js', import.meta.url).href
) as {
  buildLocalUpdateCohort(input: { build: Record<string, unknown>; workspace: string; output: string; packagePaths: string[] }): void
  inspectLocalReleaseBuildEnvironment(input: { pnpmRoot: string; storeRoot: string }): Record<string, unknown>
}

const bwrap = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true'], { encoding: 'utf8' }).status === 0
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(options: { failSlug?: string; mutateSource?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-cohort-build-'))
  roots.push(root)
  const toolchain = join(root, 'toolchain'), store = join(root, 'store')
  const stage = join(root, 'stage'), workspace = join(stage, 'workspace'), output = join(stage, 'output')
  const secret = join(root, 'host-secret')
  const parentNetworkNamespace = await readlink('/proc/self/ns/net')
  await mkdir(toolchain, { mode: 0o700 })
  await mkdir(join(store, 'v11', 'projects'), { recursive: true, mode: 0o700 })
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await mkdir(output, { mode: 0o700 })
  await writeFile(secret, 'host-only secret', { mode: 0o600 })
  await writeFile(join(toolchain, 'package.json'), '{"version":"11.7.0"}\n', { mode: 0o600 })
  await copyFile('/usr/bin/true', join(toolchain, 'node'))
  await chmod(join(toolchain, 'node'), 0o700)
  await writeFile(join(toolchain, 'pnpm'), `#!/bin/sh
set -eu
[ -z "\${DSH_LOCAL_BUILD_SECRET-}" ] || exit 41
[ -z "\${DSH_HOME-}" ] || exit 42
[ ! -e ${JSON.stringify(secret)} ] || exit 43
[ "$(readlink /proc/self/ns/net)" != ${JSON.stringify(parentNetworkNamespace)} ] || exit 50
mkdir -p ${JSON.stringify(dirname(secret))}
printf 'sandbox-only write\\n' > ${JSON.stringify(secret)}
[ "$(cat ${JSON.stringify(secret)})" = 'sandbox-only write' ] || exit 51
[ ! -e /workspace/.git ] || exit 44
[ ! -e /workspace/node_modules ] || exit 45
if [ "\${1-}" = install ]; then : > /workspace/installed; exit 0; fi
if [ "\${1-}" = --workspace-root ]; then
  ${options.mutateSource ? "printf 'changed source\\n' > /workspace/plugins/alpha/package.json" : ':'}
  exit 0
fi
if [ "\${1-}" = --dir ]; then
  source_path="$2"; shift 2
  [ "\${1-}" = pack ] || exit 46
  [ "\${2-}" = --pack-destination ] || exit 47
  slug="\${source_path##*/}"
  [ "$slug" != ${JSON.stringify(options.failSlug ?? 'never')} ] || exit 48
  printf 'packed %s\\n' "$slug" > "$3/$slug.tgz"
  exit 0
fi
exit 49
`, { mode: 0o700 })
  await mkdir(join(workspace, '.git'), { mode: 0o700 })
  await writeFile(join(workspace, '.git', 'config'), 'private Git metadata')
  await mkdir(join(workspace, 'node_modules'), { mode: 0o700 })
  await writeFile(join(workspace, 'node_modules', 'secret'), 'private module')
  for (const path of ['plugins/alpha', 'packages/helper']) {
    await mkdir(join(workspace, path), { recursive: true, mode: 0o700 })
    await writeFile(join(workspace, path, 'package.json'), JSON.stringify({ name: `@dsh-enhanced/${path.split('/')[1]}`, version: '1.0.0' }))
  }
  const build = inspectLocalReleaseBuildEnvironment({ pnpmRoot: toolchain, storeRoot: store })
  return { root, workspace, output, secret, build, packagePaths: ['plugins/alpha', 'packages/helper'] }
}
const request = (f: Awaited<ReturnType<typeof fixture>>) => ({ build: f.build, workspace: f.workspace,
  output: f.output, packagePaths: f.packagePaths })

test.skipIf(!bwrap)('builds all cohort packages in the pinned sandbox without Home or Git metadata', async () => {
  const f = await fixture()
  process.env.DSH_LOCAL_BUILD_SECRET = 'ambient secret'
  try { buildLocalUpdateCohort(request(f)) } finally { delete process.env.DSH_LOCAL_BUILD_SECRET }
  expect((await readdir(f.output)).sort()).toEqual(['alpha', 'helper'])
  expect(await readFile(join(f.output, 'alpha', 'alpha.tgz'), 'utf8')).toBe('packed alpha\n')
  expect(await readFile(join(f.output, 'helper', 'helper.tgz'), 'utf8')).toBe('packed helper\n')
  expect(await readFile(f.secret, 'utf8')).toBe('host-only secret')
  expect(await readdir(f.workspace)).toEqual(expect.arrayContaining(['.git', 'node_modules']))
  expect((await readdir(join(f.root, 'stage'))).sort()).toEqual(['output', 'workspace'])
})

test.skipIf(!bwrap)('keeps the requested output empty if a later package fails', async () => {
  const f = await fixture({ failSlug: 'helper' })
  expect(() => buildLocalUpdateCohort(request(f))).toThrow(/pinned bwrap command failed/u)
  expect(await readdir(f.output)).toEqual([])
  expect((await readdir(join(f.root, 'stage'))).sort()).toEqual(['output', 'workspace'])
})

test.skipIf(!bwrap)('rejects a candidate build that rewrites copied source inputs', async () => {
  const f = await fixture({ mutateSource: true })
  const original = await readFile(join(f.workspace, 'plugins', 'alpha', 'package.json'), 'utf8')
  expect(() => buildLocalUpdateCohort(request(f))).toThrow(/source file changed during build/u)
  expect(await readFile(join(f.workspace, 'plugins', 'alpha', 'package.json'), 'utf8')).toBe(original)
  expect(await readdir(f.output)).toEqual([])
})

test.skipIf(!bwrap)('rejects ambiguous package paths before running candidate code', async () => {
  const f = await fixture()
  const before = createHash('sha256').update(await readFile(join(f.workspace, 'plugins', 'alpha', 'package.json'))).digest('hex')
  expect(() => buildLocalUpdateCohort({ ...request(f), packagePaths: ['plugins/alpha', 'packages/alpha'] })).toThrow(/ambiguous/u)
  expect(await readdir(f.output)).toEqual([])
  expect(createHash('sha256').update(await readFile(join(f.workspace, 'plugins', 'alpha', 'package.json'))).digest('hex')).toBe(before)
})
