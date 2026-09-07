import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  inject: ['@deepseek-ai/dsh-api-gateway'],
}

if (packageJson.version !== expectedVersion || packageJson.license !== 'MIT') {
  throw new Error(`assistant-web-owner: expected MIT ${upstreamPackage}@${expectedVersion}, found ${packageJson.version}/${packageJson.license}`)
}
function sameClientMetadata(value) {
  return value !== null && typeof value === 'object'
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['external', 'inject', 'platform'])
    && value.platform === expectedClientMetadata.platform
    && JSON.stringify(value.external) === JSON.stringify(expectedClientMetadata.external)
    && JSON.stringify(value.inject) === JSON.stringify(expectedClientMetadata.inject)
}
if (!sameClientMetadata(packageJson.dsh?.client)) {
  throw new Error('assistant-web-owner: upstream client metadata changed; refusing an incompatible client clone')
}
if (!sameClientMetadata(ownerPackage.dsh?.client)) {
  throw new Error('assistant-web-owner: owner client metadata no longer matches the verified upstream contract')
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
const output = `/* Derived from ${upstreamPackage}@${expectedVersion}; Copyright (c) 2026 DeepSeek; MIT License. */\n${client.replace(expectedRegistration, `window.__ModuleLoader__.load({\n\tid: "${ownerId}",`)}`
if (!output.startsWith(`/* Derived from ${upstreamPackage}@${expectedVersion}; Copyright (c) 2026 DeepSeek; MIT License. */\nwindow.__ModuleLoader__.load({\n\tid: "${ownerId}",`)) {
  throw new Error('assistant-web-owner: failed to rewrite the client module id')
}
const outputDirectory = process.env.DSH_WEB_OWNER_CLIENT_OUT === undefined
  ? new URL('../lib/', import.meta.url)
  : pathToFileURL(resolve(process.env.DSH_WEB_OWNER_CLIENT_OUT) + sep)
await mkdir(outputDirectory, { recursive: true })
await writeFile(new URL('client.js', outputDirectory), output, 'utf8')
await writeFile(new URL('client.d.ts', outputDirectory), `export * from '${upstreamPackage}/client'\n`, 'utf8')
await writeFile(new URL('THIRD_PARTY_LICENSES', outputDirectory), `${upstreamPackage}@${expectedVersion}\n\n${license}`, 'utf8')
