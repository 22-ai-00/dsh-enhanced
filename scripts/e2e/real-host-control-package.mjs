// Owner fixture utility: resolve native peers from the actual DSH CLI closure.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const treeDigest = async directory => {
  const files = []
  for (const path of (await readdir(directory, { recursive: true })).sort()) {
    const stat = await lstat(join(directory, path))
    if (stat.isDirectory()) continue
    assert.ok(stat.isFile(), 'built package tree must contain only regular files and directories')
    files.push([path, sha(await readFile(join(directory, path)))])
  }
  return sha(JSON.stringify(files))
}

export async function prepareRealHostControlPackage(dsh, controlPackage) {
  const controlSource = new URL('../../plugins/plugin-control-plane/', import.meta.url)
  // Use the real Host peer closure. In particular dsh-scope owns a module-local
  // Symbol, so loading a second workspace copy would lose native Agent identity.
  await mkdir(controlPackage)
  await cp(new URL('lib/', controlSource), join(controlPackage, 'lib'), { recursive: true })
  const controlBuild = { libTreeSha256: await treeDigest(join(controlPackage, 'lib')),
    manifestSha256: sha(await readFile(new URL('package.json', controlSource))) }
  assert.equal(controlBuild.libTreeSha256, await treeDigest(fileURLToPath(new URL('lib/', controlSource))))
  const manifest = JSON.parse(await readFile(new URL('package.json', controlSource), 'utf8'))
  await writeFile(join(controlPackage, 'package.json'), JSON.stringify(manifest))
  const hostRequire = createRequire(dsh), workspaceRequire = createRequire(new URL('package.json', controlSource))
  const peerPackages = {}
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    const require = dependency.startsWith('@deepseek-ai/') ? hostRequire : workspaceRequire
    let packageRoot = dirname(require.resolve(dependency))
    while (JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '{}'; throw error
    })).name !== dependency) {
      const parent = dirname(packageRoot)
      if (parent === packageRoot) throw new Error(`cannot locate dependency ${dependency}`)
      packageRoot = parent
    }
    const destination = join(controlPackage, 'node_modules', dependency)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(packageRoot, destination, 'dir')
    peerPackages[dependency] = { version: JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version,
      entrySha256: sha(await readFile(require.resolve(dependency))) }
  }
  return { controlUrl: pathToFileURL(join(controlPackage, 'lib/index.js')), controlBuild, peerPackages }
}
