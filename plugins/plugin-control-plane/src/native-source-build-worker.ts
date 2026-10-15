/** Fixed code run inside the native macOS Seatbelt. Candidate package scripts,
 * tests, tsconfig files and JavaScript are never executed during preparation. */
export const NATIVE_SOURCE_COMPILER = String.raw`
import { readFileSync } from 'node:fs'
import { isAbsolute, posix, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const fail = reason => { process.stderr.write(String(reason).slice(0, 4096)); process.exitCode = 1 }
try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 64
    || typeof input.modulesPath !== 'string' || !isAbsolute(input.modulesPath)) throw new Error('invalid compiler input')
  const modulesPath = resolve(input.modulesPath)
  const ts = await import(pathToFileURL(resolve(modulesPath, 'typescript/lib/typescript.js')).href)
  const virtualRoot = '/candidate'
  const sources = new Map()
  let total = 0
  for (const file of input.files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string'
      || !/^(?:src\/)?[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:ts|tsx)$/u.test(file.path)
      || file.path.split('/').some(part => part === '.' || part === '..' || part === '')
      || Buffer.byteLength(file.content) > 65_536) throw new Error('unsafe compiler source')
    total += Buffer.byteLength(file.content)
    if (total > 262_144) throw new Error('compiler source limit')
    const key = posix.join(virtualRoot, file.path)
    if (sources.has(key)) throw new Error('duplicate compiler source')
    sources.set(key, file.content)
  }
  const roots = [...sources.keys()].filter(name => name.startsWith('/candidate/src/') && /\.tsx?$/u.test(name))
  if (roots.length < 1) throw new Error('missing plugin TypeScript source')
  const options = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2024.d.ts'],
    rootDir: '/candidate/src', outDir: '/candidate/lib', strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    noImplicitOverride: true, noFallthroughCasesInSwitch: true,
    noUnusedLocals: true, noUnusedParameters: true, verbatimModuleSyntax: true,
    isolatedModules: true, skipLibCheck: true, declaration: true,
    sourceMap: false, declarationMap: false, noEmitOnError: true,
    typeRoots: [resolve(modulesPath, '@types')], types: ['node'] }
  const permitted = new Set(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt'])
  const outputs = new Map()
  const host = ts.createCompilerHost(options, true)
  const originalRead = host.readFile.bind(host)
  const originalExists = host.fileExists.bind(host)
  const withinRuntime = path => path === modulesPath || path.startsWith(modulesPath + sep)
  host.readFile = path => sources.get(path) ?? (withinRuntime(path) ? originalRead(path) : undefined)
  host.fileExists = path => sources.has(path) || withinRuntime(path) && originalExists(path)
  host.directoryExists = path => path === '/candidate' || path === '/candidate/src'
    || [...sources.keys()].some(key => key.startsWith(path + '/'))
    || withinRuntime(path) && ts.sys.directoryExists(path)
  host.getDirectories = path => withinRuntime(path) ? ts.sys.getDirectories(path) : []
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (name.startsWith('.')) {
      if (withinRuntime(containingFile)) return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
      const target = posix.resolve(posix.dirname(containingFile), name)
      if (!target.startsWith('/candidate/src/')) return undefined
      return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
    }
    if (withinRuntime(containingFile)) return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
    if (!permitted.has(name) && !name.startsWith('node:')) return undefined
    if (name.startsWith('node:')) return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
    const manifest = JSON.parse(readFileSync(resolve(modulesPath, name, 'package.json'), 'utf8'))
    const declaration = manifest.exports?.['.']?.types ?? manifest.types
    if (typeof declaration !== 'string' || !/^\.?\/?[A-Za-z0-9._/-]+\.d\.ts$/u.test(declaration)
      || declaration.split('/').includes('..')) return undefined
    const entry = resolve(modulesPath, name, declaration)
    if (!withinRuntime(entry) || !host.fileExists(entry)) return undefined
    return { resolvedFileName: entry, extension: ts.Extension.Dts, isExternalLibraryImport: true }
  })
  host.writeFile = (fileName, content) => {
    if (!fileName.startsWith('/candidate/lib/') || !/\.(?:js|d\.ts)$/u.test(fileName)
      || Buffer.byteLength(content) > 131_072 || outputs.size >= 128 || outputs.has(fileName)) throw new Error('unsafe compiler output')
    outputs.set(fileName.slice('/candidate/'.length), content)
  }
  const program = ts.createProgram(roots, options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) throw new Error('semantic TypeScript diagnostics: ' + ts.formatDiagnostics(diagnostics.slice(0, 8), {
    getCanonicalFileName: name => name, getCurrentDirectory: () => virtualRoot, getNewLine: () => '\n' }).slice(0, 4096))
  const emitted = program.emit()
  if (emitted.emitSkipped || emitted.diagnostics.length || !outputs.has('lib/index.js') || !outputs.has('lib/index.d.ts')) {
    throw new Error('TypeScript JS/declaration emit failed')
  }
  const files = [...outputs].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }))
  process.stdout.write(JSON.stringify({ schemaVersion: 1, typescriptVersion: ts.version, checks: ['semantic-typecheck', 'js-declaration-emit'], files }))
} catch (error) { fail(error instanceof Error ? error.message : 'compiler failure') }
`
