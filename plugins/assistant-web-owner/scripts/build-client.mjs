import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const upstreamPackage = '@deepseek-ai/dsh-api-session-controller'
const ownerId = '@dsh-enhanced/assistant-web-owner'
const expectedVersion = '0.1.2-rc.1'
const require = createRequire(import.meta.url)
const packagePath = require.resolve(`${upstreamPackage}/package.json`)
const upstreamRoot = dirname(packagePath)
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
const ownerPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expectedClientMetadata = {
  platform: 'web',
  external: ['@deepseek-ai/dsh-api-gateway/client'],
  inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-conversation'],
}
const expectedUpstreamClientMetadata = {
  platform: 'web',
  external: ['@deepseek-ai/dsh-api-gateway/client'],
  inject: ['@deepseek-ai/dsh-api-gateway'],
}

if (packageJson.version !== expectedVersion || packageJson.license !== 'MIT') {
  throw new Error(`assistant-web-owner: expected MIT ${upstreamPackage}@${expectedVersion}, found ${packageJson.version}/${packageJson.license}`)
}
function sameClientMetadata(value, expected) {
  return value !== null && typeof value === 'object'
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['external', 'inject', 'platform'])
    && value.platform === expected.platform
    && JSON.stringify(value.external) === JSON.stringify(expected.external)
    && JSON.stringify(value.inject) === JSON.stringify(expected.inject)
}
if (!sameClientMetadata(packageJson.dsh?.client, expectedUpstreamClientMetadata)) {
  throw new Error('assistant-web-owner: upstream client metadata changed; refusing an incompatible client clone')
}
if (!sameClientMetadata(ownerPackage.dsh?.client, expectedClientMetadata)) {
  throw new Error('assistant-web-owner: owner client metadata no longer declares the required Session Controller and notice UI dependencies')
}
const client = await readFile(join(upstreamRoot, 'lib', 'client.js'), 'utf8')
const license = await readFile(join(upstreamRoot, 'LICENSE'), 'utf8')
const expectedRegistration = `window.__ModuleLoader__.load({\n\tid: "${upstreamPackage}",`
if (!client.startsWith(expectedRegistration)) {
  throw new Error('assistant-web-owner: upstream client registration format changed; refusing to publish an unscoped client')
}
if ((client.match(/id: "@deepseek-ai\/dsh-api-session-controller"/g) ?? []).length !== 1) {
  throw new Error('assistant-web-owner: upstream client has an unexpected registration-id count')
}
if (client.includes(`require("${upstreamPackage}")`) || client.includes(`require("${upstreamPackage}/client")`)) {
  throw new Error('assistant-web-owner: upstream client requires its own module id; a one-id clone is unsafe')
}
const bundledNotices = (await build({
  entryPoints: [new URL('../src/client.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
})).outputFiles[0]?.text
if (bundledNotices === undefined) throw new Error('assistant-web-owner: notice client bundle emitted no output')
const noticeWrapper = `\nconst ownerNoticeModule = (() => { var module = { exports: {} }; var exports = module.exports; ${bundledNotices}\nreturn module.exports })();\nif (!inject.includes("slots")) inject.push("slots");\nconst sessionControllerApply = apply;\nasync function composedApply(ctx) {\n  const baseDispose = await sessionControllerApply(ctx);\n  const noticeDispose = await ownerNoticeModule.apply(ctx);\n  return async () => { await noticeDispose(); if (typeof baseDispose === 'function') await baseDispose(); };\n}\n`
const composedClient = client
  .replace('exports.apply = apply;', () => `${noticeWrapper}exports.apply = composedApply;`)
  .replace(expectedRegistration, () => `window.__ModuleLoader__.load({\n\tid: "${ownerId}",`)
const output = `/* Derived from ${upstreamPackage}@${expectedVersion}; Copyright (c) 2026 DeepSeek; MIT License. */\n${composedClient}`
if (!output.startsWith(`/* Derived from ${upstreamPackage}@${expectedVersion}; Copyright (c) 2026 DeepSeek; MIT License. */\nwindow.__ModuleLoader__.load({\n\tid: "${ownerId}",`)) {
  throw new Error('assistant-web-owner: failed to rewrite the client module id')
}
if (!output.includes('deliveryNotices/list') || !output.includes("conversation.input.dock")) throw new Error('assistant-web-owner: notice client was not composed into the owner client')
const outputDirectory = process.env.DSH_WEB_OWNER_CLIENT_OUT === undefined
  ? new URL('../lib/', import.meta.url)
  : pathToFileURL(resolve(process.env.DSH_WEB_OWNER_CLIENT_OUT) + sep)
await mkdir(outputDirectory, { recursive: true })
await writeFile(new URL('client.js', outputDirectory), output, 'utf8')
await writeFile(new URL('client.d.ts', outputDirectory), `export * from '${upstreamPackage}/client'\n`, 'utf8')
await writeFile(new URL('THIRD_PARTY_LICENSES', outputDirectory), `${upstreamPackage}@${expectedVersion}\n\n${license}`, 'utf8')
