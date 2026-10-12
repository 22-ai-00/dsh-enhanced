import { createRequire } from 'node:module'
import { chmod, cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function nativeInstallerHost(root: string, executableSource: string): Promise<string> {
  const hostRoot = join(root, 'fake-host', 'node_modules', '@deepseek-ai', 'dsh')
  const hostModules = dirname(hostRoot)
  const executable = join(hostRoot, 'lib', 'bin.sh')
  const require = createRequire(import.meta.url)
  const cordis = dirname(require.resolve('@deepseek-ai/cordis/package.json'))
  const yaml = dirname(require.resolve('yaml/package.json'))
  const store = join(process.cwd(), 'node_modules', '.pnpm')
  const bootStore = (await readdir(store)).find(name => name.startsWith('@deepseek-ai+dsh-app-boot@0.2.0-rc.2_'))
  if (bootStore === undefined) throw new Error('locked DSH 0.2 app-boot is not installed')
  const boot = join(store, bootStore, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(join(hostRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module',
    bin: { dsh: 'lib/bin.sh' },
    dependencies: {
      '@deepseek-ai/dsh-app-boot': '0.2.0-rc.2',
      '@deepseek-ai/dsh-plugin-manager': '0.2.0-rc.2',
      '@deepseek-ai/cordis': '4.0.4',
    },
    exports: { './package.json': './package.json' },
  }))
  await writeFile(executable, executableSource)
  await chmod(executable, 0o755)
  const manager = join(hostModules, 'dsh-plugin-manager')
  await mkdir(manager)
  await writeFile(join(manager, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-plugin-manager', version: '0.2.0-rc.2', dependencies: { yaml: '^2.9.0' },
  }))
  await cp(yaml, join(root, 'fake-host', 'node_modules', 'yaml'), { recursive: true })
  await symlink(await realpath(boot), join(hostModules, 'dsh-app-boot'))
  await symlink(await realpath(cordis), join(hostModules, 'cordis'))
  return executable
}

export async function nativeInstallerSetupPackage(
  profile: string,
  packageSuffix: string,
  executableName: string,
  moduleName: string,
  setupSource: string,
): Promise<string> {
  const packageRoot = join(profile, 'node_modules', '@dsh-enhanced', packageSuffix)
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  let previous: { bin?: Record<string, string> } = {}
  try { previous = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) } catch {}
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: `@dsh-enhanced/${packageSuffix}`, version: '0.0.0', type: 'module',
    bin: { ...previous.bin, [executableName]: `./bin/${executableName}.js` },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n')
  const executable = join(packageRoot, 'bin', `${executableName}.js`)
  await writeFile(executable, 'export {}\n')
  await chmod(executable, 0o755)
  await writeFile(join(packageRoot, 'lib', `${moduleName}.js`), setupSource)
  return executable
}

export async function nativeWebSetupPackage(profile: string, setupSource: string): Promise<string> {
  return nativeInstallerSetupPackage(profile, 'assistant-web-owner', 'dsh-web-owner-setup', 'setup', setupSource)
}
