import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { Context } from '../plugins/assistant-goals/node_modules/@deepseek-ai/cordis'
import { ToolCallId } from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-llm'
import SystemPrompt from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-tools'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const roots: string[] = []
const contexts: Context[] = []
const slug = 'native-example'
const toolName = `${slug}_echo`

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function generatedPackage() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-tools-template-'))
  roots.push(root)
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'plugins'), { recursive: true })
  await cp(join(repo, 'templates', 'plugin'), join(root, 'templates', 'plugin'), { recursive: true })
  await cp(join(repo, 'scripts', 'create-plugin.mjs'), join(root, 'scripts', 'create-plugin.mjs'))
  await cp(join(repo, 'LICENSE'), join(root, 'LICENSE'))
  await cp(join(repo, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'))
  await writeFile(join(root, 'plugins', 'README.md'), '<!-- plugin-catalog:end -->\n')
  execFileSync(process.execPath, [join(root, 'scripts', 'create-plugin.mjs'), slug], { cwd: root, stdio: 'pipe' })

  const plugin = join(root, 'plugins', slug)
  const modules = join(plugin, 'node_modules')
  await mkdir(join(modules, '@deepseek-ai'), { recursive: true })
  await mkdir(join(modules, '@types'), { recursive: true })
  for (const name of ['cordis', 'dsh-system-prompt', 'dsh-tools']) {
    await symlink(resolve(repo, 'plugins', 'assistant-goals', 'node_modules', '@deepseek-ai', name), join(modules, '@deepseek-ai', name), 'dir')
  }
  await symlink(resolve(repo, 'node_modules', '@types', 'node'), join(modules, '@types', 'node'), 'dir')
  await symlink(resolve(repo, 'node_modules', 'vitest'), join(modules, 'vitest'), 'dir')
  return plugin
}

function build(plugin: string) {
  execFileSync(join(repo, 'node_modules', '.bin', 'tsc'), ['-p', join(plugin, 'tsconfig.build.json')], { cwd: plugin, stdio: 'pipe' })
}

test('generated manifest pins the optional Host Tools contract and default entry loads without Tools', async () => {
  const plugin = await generatedPackage()
  const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')) as {
    peerDependencies: Record<string, string>
    peerDependenciesMeta: Record<string, { optional: boolean }>
    devDependencies: Record<string, string>
  }
  expect(manifest.peerDependencies['@deepseek-ai/dsh-tools']).toBe('>=0.1.5-rc.3 <0.1.6')
  expect(manifest.peerDependenciesMeta['@deepseek-ai/dsh-tools']).toEqual({ optional: true })
  expect(manifest.devDependencies['@deepseek-ai/dsh-tools']).toBe('catalog:')
  expect(manifest.devDependencies['@deepseek-ai/dsh-system-prompt']).toBe('catalog:')
  build(plugin)
  await rm(join(plugin, 'node_modules', '@deepseek-ai', 'dsh-tools'))
  const resolution = execFileSync(process.execPath, ['-e',
    "const { createRequire } = require('node:module'); try { createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-tools'); process.stdout.write('resolved') } catch (error) { process.stdout.write(error.code) }",
    join(plugin, 'package.json')], { cwd: plugin, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
  expect(resolution).toBe('MODULE_NOT_FOUND')
  const entry = await import(pathToFileURL(join(plugin, 'lib', 'index.js')).href)
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = await ctx.plugin(entry)
  expect(fiber.state).toBe(2)
  expect(ctx.get('tools')).toBeUndefined()
})

test('README example builds and registers a native tool only while its required service and plugin are active', async () => {
  const plugin = await generatedPackage()
  const readme = await readFile(join(plugin, 'README.md'), 'utf8')
  const examples = [...readme.matchAll(/```ts\n([\s\S]*?)\n```/g)].map(match => match[1])
  expect(examples).toHaveLength(2)
  await writeFile(join(plugin, 'src', 'index.ts'), `${examples[0]}\n`)
  await writeFile(join(plugin, 'tests', 'index.spec.ts'), `${examples[1]}\n`)
  build(plugin)
  execFileSync(join(repo, 'node_modules', '.bin', 'tsc'), ['-p', join(plugin, 'tsconfig.json')], { cwd: plugin, stdio: 'pipe' })
  execFileSync(join(repo, 'node_modules', '.bin', 'vitest'), ['run', 'tests/index.spec.ts', '--root', plugin], { cwd: plugin, stdio: 'pipe' })
  const { default: examplePlugin } = await import(pathToFileURL(join(plugin, 'lib', 'index.js')).href)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  const consumer = ctx.plugin(examplePlugin)
  await consumer.await()
  expect(consumer.state).toBe(0)
  expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).not.toContain(toolName)

  let provider = await ctx.plugin(ToolRuntime, { mode: 'native' })
  await consumer.await()
  expect(consumer.state).toBe(2)
  expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toContain(toolName)
  const result = await ctx.tools.execute({
    callId: ToolCallId('native-template-call-1'), name: toolName,
    arguments: { text: 'hello from native Tools' }, signal: new AbortController().signal,
  })
  expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'hello from native Tools' }] })

  await provider.dispose()
  await consumer.await()
  expect(consumer.state).toBe(0)
  expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).not.toContain(toolName)

  provider = await ctx.plugin(ToolRuntime, { mode: 'native' })
  await consumer.await()
  expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).toContain(toolName)
  await consumer.dispose()
  expect((await ctx.systemPrompt.assemble()).tools.map(tool => tool.name)).not.toContain(toolName)
  await provider.dispose()
}, 30_000)
