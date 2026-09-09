import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { prepareRealRoute } from '../scripts/e2e/web-owner-real-route.mjs'

const paths: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'web-owner-real-route-'))
  paths.push(root)
  const source = join(root, 'source'), home = join(root, 'home'), workspace = join(root, 'workspace')
  await Promise.all([mkdir(source), mkdir(home), mkdir(workspace)])
  return { root, source, home, workspace }
}
const route = { displayName: 'Super Relay', apiKeyEnv: 'SUPER_RELAY_API_KEY', api: 'openai-responses', baseURL: 'https://relay.example/v1', models: [{ id: 'auto_model/alwaysday1', name: 'alwaysday1' }, { id: 'other' }] }
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('web owner real route preparation', () => {
  test('copies only the selected gateway route and keeps a credential in child env', async () => {
    const { source, home, workspace } = await fixture()
    await writeFile(join(source, 'settings.yaml'), JSON.stringify({ unrelated: { value: true }, 'llm-pi-ai': { providers: { selected: route, other: { ...route, apiKeyEnv: 'OTHER_KEY' } } } }))
    await writeFile(join(source, '.credentials.yaml'), 'refs:\n  SUPER_RELAY_API_KEY: private-test-value\n', { mode: 0o600 })
    const env: Record<string, string | undefined> = { DSH_WEB_REAL_PROVIDER: 'selected', DSH_WEB_REAL_MODEL: 'auto_model/alwaysday1', DSH_WEB_REAL_SOURCE_HOME: source }
    const prepared = await prepareRealRoute({ env, home, workspace })
    const settings = parse(await readFile(join(home, 'settings.yaml'), 'utf8'))
    expect(settings).toEqual({ 'agent-default-model': { provider: 'selected', model: 'auto_model/alwaysday1' }, 'llm-pi-ai': { providers: { selected: route } } })
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).not.toContain('private-test-value')
    expect(env.SUPER_RELAY_API_KEY).toBe('private-test-value')
    expect(prepared).toMatchObject({ provider: 'selected', model: 'auto_model/alwaysday1', bundles: [], proof: { provider: 'selected', model: 'auto_model/alwaysday1', api: 'openai-responses' } })
    expect(JSON.stringify(prepared.proof)).not.toContain('relay.example')
  })

  test('refuses unsafe sources without disclosing secret values', async () => {
    const { source, home, workspace } = await fixture()
    await writeFile(join(source, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: { selected: { ...route, baseURL: 'https://private:test-secret@relay.example/v1' } } } }))
    await expect(prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'selected', DSH_WEB_REAL_MODEL: 'auto_model/alwaysday1', DSH_WEB_REAL_SOURCE_HOME: source }, home, workspace })).rejects.toThrow('must not contain credentials')
    await expect(prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'missing', DSH_WEB_REAL_SOURCE_HOME: source }, home, workspace })).rejects.toThrow('could not read a valid selected gateway route')
    await expect(prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'selected', DSH_WEB_REAL_SOURCE_HOME: source }, home: source, workspace })).rejects.toThrow('source and target')
    await writeFile(join(source, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: { selected: { ...route, headers: { Authorization: 'Bearer test-secret' } } } } }))
    await expect(prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'selected', DSH_WEB_REAL_MODEL: 'auto_model/alwaysday1', DSH_WEB_REAL_SOURCE_HOME: source }, home, workspace })).rejects.toThrow('unsupported or sensitive')
    await writeFile(join(home, 'settings.yaml'), 'existing: true\n')
    await writeFile(join(source, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: { selected: route } } }))
    await expect(prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'selected', DSH_WEB_REAL_MODEL: 'auto_model/alwaysday1', DSH_WEB_REAL_SOURCE_HOME: source, SUPER_RELAY_API_KEY: 'child-only' }, home, workspace })).rejects.toThrow('target settings.yaml already exists')
  })

  test('requires a selected model unless the route has one clear model', async () => {
    const { source, home, workspace } = await fixture()
    await writeFile(join(source, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: { selected: route } } }))
    await expect(prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'selected', DSH_WEB_REAL_SOURCE_HOME: source, SUPER_RELAY_API_KEY: 'child-only' }, home, workspace })).rejects.toThrow('DSH_WEB_REAL_MODEL is required')
    await writeFile(join(source, 'settings.yaml'), JSON.stringify({ 'llm-pi-ai': { providers: { selected: { ...route, models: [route.models[0]] } } } }))
    await expect(prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'selected', DSH_WEB_REAL_SOURCE_HOME: source, SUPER_RELAY_API_KEY: 'child-only' }, home, workspace })).resolves.toMatchObject({ model: 'auto_model/alwaysday1' })
  })

  test('preserves the direct Responses codex default', async () => {
    const { home, workspace } = await fixture()
    const prepared = await prepareRealRoute({ env: {}, home, workspace })
    const calls: unknown[] = []
    const patch: any = { contents: { add: (node: unknown) => calls.push(node) }, createNode: (node: unknown) => node }
    prepared.configurePatch(patch, (...args: unknown[]) => calls.push(args))
    expect(prepared).toMatchObject({ provider: 'codex-subscription', model: 'gpt-5.6-terra', bundles: ['coding-subscription-provider'], proof: { provider: 'codex-subscription', model: 'gpt-5.6-terra', api: 'direct-responses' } })
    expect(calls).toContainEqual([patch, 'dsh-enhanced-coding-subscription-provider', '@dsh-enhanced/coding-subscription-provider', expect.objectContaining({ codex: { enabled: true, transport: 'direct-responses', directModel: 'gpt-5.6-terra' } })])
    expect(calls).toContainEqual({ id: 'agent-default-model', config: { provider: 'codex-subscription', model: 'default' } })
  })

  test.each([
    ['default model', undefined, 'default'],
    ['requested model', 'gpt-5.6-terra', 'gpt-5.6-terra'],
  ])('prepares TraeX ACP with an isolated workspace and %s', async (_name, requested, model) => {
    const { home, workspace } = await fixture()
    const prepared = await prepareRealRoute({ env: { DSH_WEB_REAL_PROVIDER: 'traex-agent', ...(requested === undefined ? {} : { DSH_WEB_REAL_MODEL: requested }) }, home, workspace })
    const calls: unknown[] = []
    const patch: any = { contents: { add: (node: unknown) => calls.push(node) }, createNode: (node: unknown) => node }
    prepared.configurePatch(patch, (...args: unknown[]) => calls.push(args))
    expect(prepared).toMatchObject({ provider: 'traex-agent', model, bundles: ['traex-acp-provider'], proof: { provider: 'traex-agent', model, api: 'acp', command: 'traex', cwd: resolve(workspace) } })
    expect(calls).toContainEqual([patch, 'dsh-enhanced-traex-acp-provider', '@dsh-enhanced/traex-acp-provider', { enabled: true, cwd: resolve(workspace), models: [model] }])
    expect(calls).toContainEqual({ id: 'agent-default-model', config: { provider: 'traex-agent', model } })
  })
})
