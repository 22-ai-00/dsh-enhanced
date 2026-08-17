#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templateRoot = join(repoRoot, 'templates', 'plugin')
const pluginsRoot = join(repoRoot, 'plugins')
const packageScope = '@dsh-enhanced'
const catalogMarker = '<!-- plugin-catalog:end -->'

function fail(message) {
  console.error(`create-plugin: ${message}`)
  process.exit(1)
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

async function templateFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await templateFiles(path))
    if (entry.isFile()) files.push(path)
  }
  return files
}

const args = process.argv.slice(2).filter(arg => arg !== '--')
if (args.length !== 1) fail('usage: pnpm create:plugin <kebab-case-name>')

const [slug] = args
if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)) {
  fail('name must be lower-case kebab-case and start with a letter')
}

const targetRoot = join(pluginsRoot, slug)
try {
  await stat(targetRoot)
  fail(`plugins/${slug} already exists`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const replacements = new Map([
  ['{{PLUGIN_NAME}}', slug],
  ['{{PLUGIN_TITLE}}', titleFromSlug(slug)],
  ['{{PLUGIN_ID}}', `dsh-enhanced-${slug}`],
  ['{{PACKAGE_NAME}}', `${packageScope}/${slug}`],
])

for (const source of await templateFiles(templateRoot)) {
  const templateRelative = relative(templateRoot, source)
  const outputRelative = templateRelative.endsWith('.tpl')
    ? templateRelative.slice(0, -4)
    : templateRelative
  const destination = join(targetRoot, outputRelative)
  let content = await readFile(source, 'utf8')
  for (const [token, value] of replacements) content = content.replaceAll(token, value)
  if (content.includes('{{')) fail(`unresolved template token in ${templateRelative}`)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content)
}

await cp(join(repoRoot, 'LICENSE'), join(targetRoot, 'LICENSE'))

const catalogPath = join(pluginsRoot, 'README.md')
const catalog = await readFile(catalogPath, 'utf8')
if (!catalog.includes(catalogMarker)) fail(`missing ${catalogMarker} in plugins/README.md`)
const row = `| [${slug}](${slug}) | \`${packageScope}/${slug}\` | 实验性 | ${titleFromSlug(slug)} plugin. |\n`
await writeFile(catalogPath, catalog.replace(catalogMarker, `${row}\n${catalogMarker}`))

console.log(`Created plugins/${slug}`)
console.log(`Next: implement the plugin, document its permissions, then run pnpm check.`)
