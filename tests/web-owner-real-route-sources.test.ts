import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { prepareRealRoute } from '../scripts/e2e/web-owner-real-route.mjs'

const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'web-owner-real-route-sources-'))
  paths.push(root)
  const source = join(root, 'source'), home = join(root, 'home'), workspace = join(root, 'workspace')
  await Promise.all([mkdir(source), mkdir(home), mkdir(workspace)])
  return { source, home, workspace }
}
const chat = { displayName: 'Benchmark chat provider', api: 'openai-completions', baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'BENCHMARK_API_KEY', headers: { 'x-source': 'x-benchmark-source' }, compat: { maxTokensField: 'max_tokens' },
  models: [{ id: 'benchmark-chat-model', name: 'benchmark-chat', contextWindow: 256000 }] }
const deepseek = { displayName: 'Benchmark general provider', api: 'openai-completions', baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'BENCHMARK_API_KEY', compat: { maxTokensField: 'max_tokens' },
  models: [{ id: 'benchmark-general-model', name: 'flash' }, { id: 'glm-5.3-flash', name: 'glm' }] }
const env = (source: string, extra: Record<string, string> = {}) => ({ DSH_WEB_REAL_SOURCE_HOME: source,
  DSH_WEB_REAL_PROVIDER: 'benchmark-gateway', DSH_WEB_REAL_MODEL: 'benchmark-chat-model', BENCHMARK_API_KEY: 'child-only', ...extra }) as Record<string, string | undefined>
const settingsWith = (providers: Record<string, unknown>) => JSON.stringify({ 'llm-pi-ai': { providers } })
// Mirrors the real web profile: other rows use !!js, the gateway row is plain YAML.
const profilePatch = (rows: string) => `- id: dsh-enhanced-personal-assistant
  config:
    databasePath: !!js "process.env.HOME + '/assistant.sqlite'"
${rows}`
const piAiRow = (providers: Record<string, unknown>, extra = '') =>
  `- id: llm-pi-ai\n${extra}  config:\n${stringify({ providers }).replace(/^(?=.)/gmu, '    ')}`
async function writeProfile(source: string, text: string, name = 'web') {
  await mkdir(join(source, 'profiles', name), { recursive: true })
  await writeFile(join(source, 'profiles', name, 'cordis.patch.yml'), text)
}
async function exists(path: string) { return stat(path).then(() => true, () => false) }

describe('web owner real route headers', () => {
  test('copies a vetted public routing header and records only its name', async () => {
    const { source, home, workspace } = await fixture()
    await writeFile(join(source, 'settings.yaml'), settingsWith({ benchmark-gateway: { ...chat, headers: { 'X-Source': 'x-benchmark-source' } } }))
    const prepared = await prepareRealRoute({ env: env(source), home, workspace })
    const written = parse(await readFile(join(home, 'settings.yaml'), 'utf8'))
    expect(written['llm-pi-ai'].providers.benchmark-gateway).toEqual(chat)
    expect(prepared.proof).toEqual({ provider: 'benchmark-gateway', model: 'benchmark-chat-model', api: 'openai-completions', headerNames: ['x-source'] })
    expect(JSON.stringify(prepared.proof)).not.toContain('dogfooding')
  })

  const many = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`x-tag-${index}`, 'v']))
  test.each([
    ['authorization', { Authorization: 'secret-value-1' }],
    ['cookie', { Cookie: 'secret-value-1' }],
    ['x-api-key', { 'x-api-key': 'secret-value-1' }],
    ['x-auth-token', { 'x-auth-token': 'secret-value-1' }],
    ['x-client-secret', { 'x-client-secret': 'secret-value-1' }],
    ['at- value', { 'x-source': 'at-secret-value-1' }],
    ['sk- value', { 'x-source': 'sk-secret-value-1' }],
    ['bearer value', { 'x-source': 'Bearer secret-value-1' }],
    ['CRLF value', { 'x-source': 'secret-value-1\r\nx-injected: 1' }],
    ['LF value', { 'x-source': 'secret-value-1\n' }],
    ['overlong value', { 'x-source': `secret-value-1${'a'.repeat(128)}` }],
    ['empty value', { 'x-source': '' }],
    ['non-string value', { 'x-source': 1 }],
    ['object value', { 'x-source': { nested: 'secret-value-1' } }],
    ['non-x name', { 'user-agent': 'secret-value-1' }],
    ['case duplicate', { 'x-source': 'secret-value-1', 'X-Source': 'secret-value-1' }],
    ['too many headers', many],
    ['empty object', {}],
    ['array', ['secret-value-1']],
  ])('refuses %s without disclosing names or values', async (_name, headers) => {
    const { source, home, workspace } = await fixture()
    await writeFile(join(source, 'settings.yaml'), settingsWith({ benchmark-gateway: { ...chat, headers } }))
    const error = await prepareRealRoute({ env: env(source), home, workspace }).then(() => undefined, (e: Error) => e)
    expect(error?.message).toBe('web-owner real route: gateway route headers are unsupported or sensitive')
    expect(error?.message).not.toMatch(/secret-value|authorization|cookie|x-api|x-auth/iu)
    expect(await exists(join(home, 'settings.yaml'))).toBe(false)
  })
})

describe('web owner real route profile-patch source', () => {
  test('reads the plain llm-pi-ai row when settings.yaml is absent', async () => {
    const { source, home, workspace } = await fixture()
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: chat, 'benchmark-general': deepseek })))
    const chatRoute = await prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace })
    expect(chatRoute.proof).toMatchObject({ provider: 'benchmark-gateway', model: 'benchmark-chat-model', headerNames: ['x-source'] })
    expect(parse(await readFile(join(home, 'settings.yaml'), 'utf8'))['llm-pi-ai'].providers).toEqual({ benchmark-gateway: chat })
    const other = join(home, '..', 'home-2'); await mkdir(other)
    const deepseekRoute = await prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web',
      DSH_WEB_REAL_PROVIDER: 'benchmark-general', DSH_WEB_REAL_MODEL: 'benchmark-general-model' }), home: other, workspace })
    expect(deepseekRoute.proof).toEqual({ provider: 'benchmark-general', model: 'benchmark-general-model', api: 'openai-completions' })
  })

  test('keeps settings.yaml as the first choice', async () => {
    const { source, home, workspace } = await fixture()
    const preferred = { ...chat, displayName: 'from settings' }
    await writeFile(join(source, 'settings.yaml'), settingsWith({ benchmark-gateway: preferred }))
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: { ...chat, displayName: 'from profile' } })))
    await prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace })
    expect(parse(await readFile(join(home, 'settings.yaml'), 'utf8'))['llm-pi-ai'].providers.benchmark-gateway.displayName).toBe('from settings')
  })

  test('falls back to the profile only when settings.yaml lacks the provider', async () => {
    const { source, home, workspace } = await fixture()
    await writeFile(join(source, 'settings.yaml'), settingsWith({ unrelated: deepseek }))
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: chat })))
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace }))
      .resolves.toMatchObject({ provider: 'benchmark-gateway' })
  })

  test('ignores a disabled duplicate row and refuses a profile whose only match is disabled', async () => {
    const { source, home, workspace } = await fixture()
    // The disabled row even carries !!js: tags are refused only in the selected row.
    const disabled = piAiRow({ benchmark-gateway: { ...chat, displayName: 'disabled' } }, '  disabled: true\n')
      .replace('baseURL: https://gateway.example/v1', 'baseURL: !!js "process.env.URL"')
    await writeProfile(source, profilePatch(`${disabled}${piAiRow({ benchmark-gateway: { ...chat, displayName: 'enabled' } })}`))
    await prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace })
    expect(parse(await readFile(join(home, 'settings.yaml'), 'utf8'))['llm-pi-ai'].providers.benchmark-gateway.displayName).toBe('enabled')
    const other = await fixture()
    await writeProfile(other.source, profilePatch(piAiRow({ benchmark-gateway: chat }, '  disabled: true\n')))
    await expect(prepareRealRoute({ env: env(other.source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home: other.home, workspace: other.workspace }))
      .rejects.toThrow('web-owner real route: could not read a valid selected gateway route')
    expect(await exists(join(other.home, 'settings.yaml'))).toBe(false)
  })

  test.each([
    ['missing provider', () => profilePatch(piAiRow({ other: chat }))],
    ['ambiguous rows', () => profilePatch(`${piAiRow({ benchmark-gateway: chat })}${piAiRow({ benchmark-gateway: chat }).replace('llm-pi-ai', 'llm-pi-ai-2')}`)],
    ['row that is not llm-pi-ai', () => profilePatch(piAiRow({ benchmark-gateway: chat }).replace('id: llm-pi-ai', 'id: lookalike'))],
    ['disabled row', () => profilePatch(piAiRow({ benchmark-gateway: chat }, '  disabled: true\n'))],
    ['!!js in the selected row', () => profilePatch(piAiRow({ benchmark-gateway: chat }).replace("baseURL: https://gateway.example/v1", 'baseURL: !!js "process.env.URL"'))],
    ['mapping at the top level', () => stringify({ 'llm-pi-ai': { providers: { benchmark-gateway: chat } } })],
    ['malformed YAML', () => '- id: llm-pi-ai\n  config: [unterminated\n'],
  ])('refuses a profile with a %s', async (_name, text) => {
    const { source, home, workspace } = await fixture()
    await writeProfile(source, text())
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace }))
      .rejects.toThrow(/could not read a valid selected gateway route|not plain YAML data/u)
    expect(await exists(join(home, 'settings.yaml'))).toBe(false)
  })

  test('refuses an alias in the selected row and a missing profile file', async () => {
    const { source, home, workspace } = await fixture()
    await writeProfile(source, `- id: llm-pi-ai\n  config:\n    providers:\n      benchmark-gateway:\n        displayName: &name shared\n        api: openai-completions\n        baseURL: https://gateway.example/v1\n        apiKeyEnv: BENCHMARK_API_KEY\n        models: [{ id: chat-seed-evolving, name: *name }]\n`)
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace })).rejects.toThrow('not plain YAML data')
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'absent' }), home, workspace }))
      .rejects.toThrow('could not read a valid selected gateway route')
  })

  test.each(['../web', 'web/../web', '.hidden', ''.padEnd(65, 'a')])('refuses profile name %j', async profile => {
    const { source, home, workspace } = await fixture()
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: chat })))
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: profile }), home, workspace }))
      .rejects.toThrow('invalid DSH_WEB_REAL_SOURCE_PROFILE')
  })

  test('a malformed settings.yaml still fails closed instead of falling back', async () => {
    const { source, home, workspace } = await fixture()
    await writeFile(join(source, 'settings.yaml'), 'llm-pi-ai: [unterminated\n')
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: chat })))
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace }))
      .rejects.toThrow('could not read a valid selected gateway route')
  })

  test('without a profile, a missing settings.yaml behaves as before', async () => {
    const { source, home, workspace } = await fixture()
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: chat })))
    await expect(prepareRealRoute({ env: env(source), home, workspace })).rejects.toThrow('could not read a valid selected gateway route')
  })

  test('profile routes keep every existing route check', async () => {
    const { source, home, workspace } = await fixture()
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: { ...chat, baseURL: 'https://user:pw@gateway.example/v1' } })))
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace })).rejects.toThrow('must not contain credentials')
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: { ...chat, apiKey: 'inline' } })))
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home, workspace })).rejects.toThrow('unsupported or sensitive fields')
    await writeProfile(source, profilePatch(piAiRow({ benchmark-gateway: chat })))
    await expect(prepareRealRoute({ env: env(source, { DSH_WEB_REAL_SOURCE_PROFILE: 'web' }), home: source, workspace })).rejects.toThrow('source and target')
  })
})
