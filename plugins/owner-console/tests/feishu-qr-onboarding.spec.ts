import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocument } from 'yaml'
import {
  buildFeishuRegistrationUrl, encodeFeishuAddons, FeishuQrOnboardingManager,
  isTrustedFeishuRegistrationUrl, renderFeishuQrDataUrl, type FeishuQrFetchFn,
} from '../src/feishu-qr-onboarding.ts'
import { OwnerConsoleService } from '../src/service.ts'
import { FeishuQrOnboardingSnapshotSchema } from '../src/typert.ts'
import type { EasySecretLocator } from '../src/doctor-repair.ts'
import type { BundleInfoLike, SettingsDescriptor, SettingsService } from '../src/settings.ts'

const JS_TAG = { customTags: [{ tag: '!js', resolve: (s: string) => s }, { tag: 'tag:yaml.org,2002:js', resolve: (s: string) => s }] } as never
const fixtureAppId = (hex: string): string => ['cli', hex].join('_')

describe('Feishu official QR onboarding (RFC 8628)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function makeTempProfile(profileName = 'desktop') {
    const root = mkdtempSync(join(tmpdir(), 'owner-console-feishu-qr-'))
    dirs.push(root)
    const dshHome = join(root, '.dsh')
    const profileDir = join(dshHome, 'profiles', profileName)
    mkdirSync(profileDir, { recursive: true })
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, '[]\n', 'utf8')
    return { dshHome, profileDir, patchPath }
  }

  function makeDeliveryDb(dbPath: string, initialOwners: ReadonlyArray<{ id: string; principal: Record<string, string>; role?: 'owner' | 'linked'; status?: 'active' | 'revoked' }> = []) {
    mkdirSync(join(dbPath, '..'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`
        CREATE TABLE delivery_principals (
          id TEXT PRIMARY KEY,
          key_hash TEXT NOT NULL UNIQUE,
          principal_json TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('owner', 'linked')),
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
          linked_to_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          FOREIGN KEY (linked_to_id) REFERENCES delivery_principals(id)
        ) STRICT;
      `)
      for (const row of initialOwners) {
        const json = JSON.stringify(row.principal)
        const hash = createHash('sha256').update(json, 'utf8').digest('hex')
        db.prepare(
          `INSERT INTO delivery_principals (id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, NULL, 100, 100, 1)`,
        ).run(row.id, hash, json, row.role ?? 'owner', row.status ?? 'active')
      }
    } finally {
      db.close()
    }
  }

  function makeHost(dshHome: string, profileDir: string, profileName = 'desktop') {
    return {
      get: (name: string) => {
        if (name === 'profileContext') return { dir: profileDir, name: profileName }
        if (name === 'homePaths') return { dshHome }
        return undefined
      },
    }
  }

  function jsonResp(status: number, body: Record<string, unknown>) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    }
  }

  async function waitUntilTerminal(manager: FeishuQrOnboardingManager, sessionId: string) {
    for (let i = 0; i < 60; i += 1) {
      const snap = manager.status(sessionId)
      if (!['awaiting-scan', 'applying'].includes(snap.state)) return snap
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return manager.status(sessionId)
  }

  it('encodes addons identically to @larksuiteoapi/node-sdk and validates official Feishu/Lark URLs', async () => {
    const url = buildFeishuRegistrationUrl({
      verificationUriComplete: 'https://open.feishu.cn/page/launcher?user_code=ABCD-1234',
      appName: '文鳐助手',
      existingAppId: fixtureAppId('aabbccddeeff0011'),
      calendarReadonly: true,
      businessTools: true,
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('from')).toBe('sdk')
    expect(parsed.searchParams.get('source')).toBe('node-sdk/dsh-enhanced/lark-channel')
    expect(parsed.searchParams.get('tp')).toBe('sdk')
    expect(parsed.searchParams.get('name')).toBe('文鳐助手')
    expect(parsed.searchParams.get('clientID')).toBe(fixtureAppId('aabbccddeeff0011'))

    const encodedAddons = parsed.searchParams.get('addons')!
    expect(encodedAddons).toMatch(/^[A-Za-z0-9_-]+$/u)
    const b64 = encodedAddons.replace(/-/gu, '+').replace(/_/gu, '/')
    const decoded = JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')) as {
      preset: boolean
      scopes: { tenant: string[] }
      events: { items: { tenant: string[] } }
      callbacks: { items: string[] }
    }
    expect(decoded.preset).toBe(true)
    expect(decoded.scopes.tenant).toContain('im:message:send_as_bot')
    expect(decoded.scopes.tenant).toContain('calendar:calendar:readonly')
    expect(decoded.events.items.tenant).toEqual(['im.message.receive_v1'])
    expect(decoded.callbacks.items).toEqual(['card.action.trigger'])

    expect(encodeFeishuAddons(decoded)).toBe(encodedAddons)
    expect(isTrustedFeishuRegistrationUrl('https://open.feishu.cn/page/launcher')).toBe(true)
    expect(isTrustedFeishuRegistrationUrl('https://accounts.larksuite.com/oauth/v1/app/registration')).toBe(true)
    expect(isTrustedFeishuRegistrationUrl('http://open.feishu.cn/page/launcher')).toBe(false)
    expect(isTrustedFeishuRegistrationUrl('https://feishu.cn.evil.com/page/launcher')).toBe(false)
    expect(isTrustedFeishuRegistrationUrl('https://user:pass@open.feishu.cn/page/launcher')).toBe(false)
    expect(isTrustedFeishuRegistrationUrl('javascript:alert(1)')).toBe(false)

    const qrDataUrl = await renderFeishuQrDataUrl(url)
    expect(qrDataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const svg = Buffer.from(qrDataUrl.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
    expect(svg).toContain('<svg')
  })

  it('completes end-to-end QR onboarding, seals secret without leaking it, writes policy rules, and binds owner in empty SQLite', async () => {
    const { dshHome, profileDir, patchPath } = makeTempProfile('desktop')
    const dbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(dbPath, [])

    const stored: Array<{ locator: unknown; secret: string }> = []
    const calls: Array<{ url: string; body: Record<string, string> }> = []
    const sleepCalls: number[] = []
    let pollCount = 0

    const fetchFn: FeishuQrFetchFn = async (url, init) => {
      const body = Object.fromEntries(new URLSearchParams(init.body).entries())
      calls.push({ url, body })
      if (body['action'] === 'begin') {
        return jsonResp(200, {
          device_code: 'secret_device_code_never_expose',
          verification_uri_complete: 'https://open.feishu.cn/page/launcher?code=XYZ',
          expires_in: 600,
          interval: 5,
        })
      }
      pollCount += 1
      if (pollCount === 1) return jsonResp(400, { error: 'authorization_pending' })
      if (pollCount === 2) return jsonResp(400, { error: 'slow_down' })
      return jsonResp(200, {
        client_id: fixtureAppId('aabbccddeeff0011'),
        client_secret: 'super_secret_qr_token_never_leak',
        user_info: { open_id: 'ou_qr_owner_123456', tenant_brand: 'feishu' },
      })
    }

    const larkDesc: SettingsDescriptor = {
      ns: 'dsh-enhanced-lark-channel',
      schema: {},
      value: { enabled: false, appId: fixtureAppId('0000000000000000'), account: 'primary', tenant: 'replace-with-tenant-key' },
      revision: 4,
      applies: 'live',
    }
    const mutate = vi.fn(async () => {})
    const reloadEntry = vi.fn(async () => '；条目已重新加载')
    const settings: SettingsService = { describe: () => [larkDesc], mutate }

    const manager = new FeishuQrOnboardingManager({
      fetchFn,
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async (locator, secret) => { stored.push({ locator, secret }) },
      now: () => 1_700_000_000_000,
      sleep: async (ms) => { sleepCalls.push(ms) },
      platform: 'darwin',
      env: {},
    })

    const started = await manager.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [larkDesc],
      getSettings: () => settings,
      reloadEntry,
      isLarkConnected: () => false,
    }, {
      domain: 'feishu',
      appName: '文鳐助手',
      existingAppId: '',
      account: '',
      tenant: '',
      calendarReadonly: false,
      businessTools: true,
    })

    expect(() => FeishuQrOnboardingSnapshotSchema.parse(started)).not.toThrow()
    expect(started.state).toBe('awaiting-scan')
    expect(started.qrCodeDataUrl).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
    expect(JSON.stringify(started)).not.toContain('secret_device_code_never_expose')

    const finished = await waitUntilTerminal(manager, started.sessionId)
    expect(() => FeishuQrOnboardingSnapshotSchema.parse(finished)).not.toThrow()
    expect(finished.state).toBe('completed')
    expect(finished.applied).toBe(true)
    expect(finished.appId).toBe(fixtureAppId('aabbccddeeff0011'))
    expect(finished.openId).toBe('ou_qr_owner_123456')
    expect(finished.ownerBinding).toBe('bound-owner')
    expect(finished.connected).toBe(false)
    expect(finished.restartRecommended).toBe(true)
    expect(finished.note).toContain('DeepSeek Harness.app')
    expect(finished.note).toContain('dsh-rsi restart')
    expect(mutate).not.toHaveBeenCalled()
    expect(reloadEntry).not.toHaveBeenCalled()
    expect(JSON.stringify(finished)).not.toContain('super_secret_qr_token_never_leak')
    expect(JSON.stringify(finished)).not.toContain('secret_device_code_never_expose')

    // Slow down increased sleep from 5000ms to 10000ms
    expect(sleepCalls).toEqual([5_000, 5_000, 10_000])

    // Secret sealed into OS vault and absent from YAML
    expect(stored).toHaveLength(1)
    expect(stored[0]!.secret).toBe('super_secret_qr_token_never_leak')
    const patchText = readFileSync(patchPath, 'utf8')
    expect(patchText).not.toContain('super_secret_qr_token_never_leak')

    const doc = parseDocument(patchText, JS_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const lark = doc.find(r => r.id === 'dsh-enhanced-lark-channel')!
    expect(lark.config).toMatchObject({
      enabled: true,
      appId: fixtureAppId('aabbccddeeff0011'),
      domain: 'feishu',
      account: 'primary',
      tenant: 'personal', // Replaced placeholder 'replace-with-tenant-key'
      secretSource: 'handle',
      credentialHandle: 'lark-app-secret-primary',
      credentialPurpose: 'connect',
      credentialLeaseMs: 86_400_000,
    })
    expect(patchText).not.toMatch(/&a\d|\*a\d/u)

    const pa = doc.find(r => r.id === 'dsh-enhanced-personal-assistant')!
    const rules = (pa.config!['assistantPolicy'] as { rules: Array<{ id: string }> }).rules.map(r => r.id)
    expect(rules).toEqual(expect.arrayContaining([
      'lark-channel-credential-primary',
      'lark-owner-ingress-primary',
      'lark-owner-reply-primary',
      'lark-owner-capability-*-primary',
      'lark-owner-tool-*-primary',
      'lark-owner-approval-dsh-enhanced-personal-memory-primary',
      'lark-owner-preference-signal-primary',
      'lark-owner-preference-snapshot-primary',
    ]))

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare('SELECT principal_json, key_hash, role, status, linked_to_id FROM delivery_principals').all() as Array<Record<string, unknown>>
      const expectedJson = JSON.stringify({ channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_qr_owner_123456' })
      expect(rows).toEqual([{
        principal_json: expectedJson,
        key_hash: createHash('sha256').update(expectedJson, 'utf8').digest('hex'),
        role: 'owner',
        status: 'active',
        linked_to_id: null,
      }])
    } finally {
      db.close()
    }
  })

  it('auto-switches to accounts.larksuite.com on international Lark account and preserves existing Web owner via linked principal', async () => {
    const { dshHome, profileDir, patchPath } = makeTempProfile('desktop')
    const dbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(dbPath, [{
      id: 'principal_web_existing',
      principal: { channel: 'web', account: 'desktop', tenant: 'local', user: 'operator' },
      role: 'owner',
      status: 'active',
    }])

    const pollUrls: string[] = []
    let pollStep = 0
    const fetchFn: FeishuQrFetchFn = async (url, init) => {
      const body = Object.fromEntries(new URLSearchParams(init.body).entries())
      if (body['action'] === 'begin') {
        return jsonResp(200, {
          device_code: 'dev_switch_1',
          verification_uri_complete: 'https://open.feishu.cn/page/launcher?c=1',
          expires_in: 300,
          interval: 2,
        })
      }
      pollUrls.push(url)
      pollStep += 1
      if (pollStep === 1) {
        return jsonResp(200, { user_info: { tenant_brand: 'lark' } })
      }
      return jsonResp(200, {
        client_id: fixtureAppId('1122334455667788'),
        client_secret: 'lark_intl_secret_value',
        user_info: { open_id: 'ou_lark_intl_999', tenant_brand: 'lark' },
      })
    }

    const manager = new FeishuQrOnboardingManager({
      fetchFn,
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })

    const started = await manager.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
      isLarkConnected: () => true,
    }, {
      domain: 'feishu',
      appName: '文鳐助手',
      existingAppId: '',
      account: '',
      tenant: '',
      calendarReadonly: false,
      businessTools: true,
    })

    const done = await waitUntilTerminal(manager, started.sessionId)
    expect(done.state).toBe('completed')
    expect(done.domain).toBe('lark')
    expect(done.domainSwitched).toBe(true)
    expect(done.ownerBinding).toBe('linked-to-owner')
    // Must NEVER report connected: true from a stale pre-restart connection; restart is always required.
    expect(done.connected).toBe(false)
    expect(done.restartRecommended).toBe(true)
    expect(done.note).toContain('普通私聊')
    expect(done.note).toContain('/permission')
    expect(done.note).toContain('dsh-lark-setup')
    expect(done.note).toContain('dsh-rsi restart')
    expect(pollUrls).toEqual([
      'https://accounts.feishu.cn/oauth/v1/app/registration',
      'https://accounts.larksuite.com/oauth/v1/app/registration',
    ])

    const doc = parseDocument(readFileSync(patchPath, 'utf8'), JS_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    expect(doc.find(r => r.id === 'dsh-enhanced-lark-channel')!.config!['domain']).toBe('lark')

    // Existing Web owner stays untouched as active owner; Lark user is linked to it.
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare('SELECT id, role, status, linked_to_id, principal_json FROM delivery_principals ORDER BY created_at ASC').all() as Array<Record<string, unknown>>
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ id: 'principal_web_existing', role: 'owner', status: 'active', linked_to_id: null })
      expect(rows[1]).toMatchObject({
        role: 'linked',
        status: 'active',
        linked_to_id: 'principal_web_existing',
        principal_json: JSON.stringify({ channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_lark_intl_999' }),
      })
    } finally {
      db.close()
    }
  })

  it('reuses existing matching Lark owner without mutating delivery_principals and handles access_denied, cancel, vault errors, and frozen profiles', async () => {
    const { dshHome, profileDir } = makeTempProfile('desktop')
    const dbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(dbPath, [{
      id: 'principal_lark_existing',
      principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_same_owner' },
      role: 'owner',
      status: 'active',
    }])

    // 1) Reuse existing matching Lark owner
    const reuseMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd1', verification_uri_complete: 'https://open.larksuite.com/page/launcher', expires_in: 60, interval: 2 })
        }
        return jsonResp(200, { client_id: fixtureAppId('aabbccddeeff0011'), client_secret: 'sec_reuse', user_info: { open_id: 'ou_same_owner', tenant_brand: 'lark' } })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const startedReuse = await reuseMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'lark', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const doneReuse = await waitUntilTerminal(reuseMgr, startedReuse.sessionId)
    expect(doneReuse.state).toBe('completed')
    expect(doneReuse.ownerBinding).toBe('reused-owner')

    // 2) access_denied
    const deniedMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd2', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 60, interval: 2 })
        }
        return jsonResp(400, { error: 'access_denied' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const deniedStart = await deniedMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect((await waitUntilTerminal(deniedMgr, deniedStart.sessionId)).state).toBe('denied')

    // 3) Vault write failure redacts secret from error note
    const vaultErrMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd3', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 60, interval: 2 })
        }
        return jsonResp(200, { client_id: fixtureAppId('aabbccddeeff0011'), client_secret: 'TOP_SECRET_MUST_REDACT' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async (_loc, secret) => { throw new Error(`keychain locked while saving ${secret}`) },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const vaultErrStart = await vaultErrMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const vaultErrDone = await waitUntilTerminal(vaultErrMgr, vaultErrStart.sessionId)
    expect(vaultErrDone.state).toBe('failed')
    expect(vaultErrDone.applied).toBe(false)
    expect(vaultErrDone.note).not.toContain('TOP_SECRET_MUST_REDACT')
    expect(vaultErrDone.note).toContain('[REDACTED]')

    // 4) Cancel awaiting-scan session cleanly
    const cancelMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd4', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 600, interval: 5 })
        }
        return jsonResp(400, { error: 'authorization_pending' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      platform: 'darwin',
      env: {},
    })
    const cancelStart = await cancelMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const cancelled = cancelMgr.cancel(cancelStart.sessionId)
    expect(cancelled.state).toBe('cancelled')
    cancelMgr.dispose()

    // 5) Rejects invalid placeholder existingAppId and frozen Linux systemd profile
    const invalidId = await cancelMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: fixtureAppId('0000000000000000'), account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect(invalidId.state).toBe('failed')

    mkdirSync(join(dshHome, 'rsi-local-cohorts', 'desktop'), { recursive: true })
    writeFileSync(join(dshHome, 'rsi-local-cohorts', 'desktop', 'receipt.json'), '{}')
    const frozenMgr = new FeishuQrOnboardingManager({ platform: 'linux', env: {} })
    const frozenRes = await frozenMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect(frozenRes.state).toBe('failed')
    expect(frozenRes.errorCode).toBe('frozen-profile')
  })

  it('wires OwnerConsoleService disposal to abort active QR polling and reports placeholder appId as unconfigured', async () => {
    const { dshHome, profileDir } = makeTempProfile('desktop')
    const ctx = new Context()
    const larkDesc: SettingsDescriptor = {
      ns: 'dsh-enhanced-lark-channel',
      schema: {},
      value: { enabled: false, appId: fixtureAppId('0000000000000000'), account: 'primary', tenant: 'replace-with-tenant-key', credentialHandle: 'lark-app-secret' },
      revision: 1,
      applies: 'live',
    }
    ctx.provide('settings' as never, { describe: () => [larkDesc], mutate: vi.fn(async () => {}) } as never)
    ctx.provide('profileContext' as never, { dir: profileDir, name: 'desktop' } as never)
    ctx.provide('homePaths' as never, { dshHome } as never)

    const qrMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_dispose', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 600, interval: 5 })
        }
        return jsonResp(400, { error: 'authorization_pending' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      platform: 'darwin',
      env: {},
    })
    const svc = new OwnerConsoleService(ctx, { feishuAppId: '' }, undefined, undefined, undefined, undefined, qrMgr)
    const status = await svc.status()
    expect(status.feishu.appIdConfigured).toBe(false)

    const started = await svc.startFeishuQrOnboarding('feishu', '文鳐助手', '', '', '', false, true)
    expect(started.state).toBe('awaiting-scan')
    expect((await svc.feishuQrOnboardingStatus(started.sessionId)).state).toBe('awaiting-scan')

    await ctx.fiber.dispose()
    expect(qrMgr.status(started.sessionId).state).toBe('cancelled')
  })

  it('handles clock expiry, transient network recovery, 4th network error failure, session superseding, applying-phase cancel guard, missing open_id, and split policy layout', async () => {
    const { dshHome, profileDir, patchPath } = makeTempProfile('desktop')

    // A) Clock expiry during polling
    let clock = 1_700_000_000_000
    const expireMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_exp', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 30, interval: 5 })
        }
        return jsonResp(400, { error: 'authorization_pending' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      platform: 'darwin',
      env: {},
    })
    const expStart = await expireMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const expEnd = await waitUntilTerminal(expireMgr, expStart.sessionId)
    expect(expEnd.state).toBe('expired')
    expect(expEnd.errorCode).toBe('expired_token')

    // B) Recovers after 2 transient network errors, succeeds without open_id on split policy layout
    writeFileSync(patchPath, `- id: dsh-enhanced-assistant-policy\n  name: "@dsh-enhanced/assistant-policy"\n  config:\n    rules: []\n`, 'utf8')
    let transientCount = 0
    const splitMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_retry', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 2 })
        }
        transientCount += 1
        if (transientCount <= 2) throw new Error('ECONNRESET')
        return jsonResp(200, { client_id: fixtureAppId('2233445566778899'), client_secret: 'split_secret_ok' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const splitStart = await splitMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const splitDone = await waitUntilTerminal(splitMgr, splitStart.sessionId)
    expect(splitDone.state).toBe('completed')
    expect(splitDone.ownerBinding).toBe('not-returned')
    const splitDoc = parseDocument(readFileSync(patchPath, 'utf8'), JS_TAG).toJSON() as Array<{ id: string; config?: Record<string, unknown> }>
    const policyRules = (splitDoc.find(r => r.id === 'dsh-enhanced-assistant-policy')!.config!['rules'] as Array<{ id: string }>).map(r => r.id)
    expect(policyRules).toContain('lark-channel-credential-primary')

    // C) Fails cleanly after 4 consecutive network errors
    const netFailMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_fail', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 2 })
        }
        throw new Error('ETIMEDOUT')
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const netFailStart = await netFailMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const netFailDone = await waitUntilTerminal(netFailMgr, netFailStart.sessionId)
    expect(netFailDone.state).toBe('failed')
    expect(netFailDone.errorCode).toBe('network-error')

    // D) Superseding an awaiting-scan session aborts the first and hides its stale sessionId
    const supersedeMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_sup', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 600, interval: 5 })
        }
        return jsonResp(400, { error: 'authorization_pending' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      platform: 'darwin',
      env: {},
    })
    const s1 = await supersedeMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const s2 = await supersedeMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect(s2.sessionId).not.toBe(s1.sessionId)
    expect(supersedeMgr.status(s1.sessionId).state).toBe('idle')
    expect(supersedeMgr.status(s2.sessionId).state).toBe('awaiting-scan')
    supersedeMgr.dispose()

    // E) Cancel during 'applying' does NOT abort in-flight atomic commit
    let releaseVault!: () => void
    const vaultGate = new Promise<void>(resolve => { releaseVault = resolve })
    const applyingMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_apply', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 600, interval: 2 })
        }
        return jsonResp(200, { client_id: fixtureAppId('aabbccddeeff0011'), client_secret: 'applying_secret' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => { await vaultGate },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const appStart = await applyingMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    for (let i = 0; i < 40 && applyingMgr.status(appStart.sessionId).state !== 'applying'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(applyingMgr.status(appStart.sessionId).state).toBe('applying')
    const duringCancel = applyingMgr.cancel(appStart.sessionId)
    expect(duringCancel.state).toBe('applying')
    releaseVault()
    const appDone = await waitUntilTerminal(applyingMgr, appStart.sessionId)
    expect(appDone.state).toBe('completed')
  })

  it('resolves !!js dshHomePath workspace without YAML aliases, clears disabled flags, preserves patch account/tenant, and redacts hex secrets', async () => {
    const { dshHome, profileDir, patchPath } = makeTempProfile('desktop')
    const dbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(dbPath, [
      { id: 'principal_owner_web', principal: { channel: 'web', account: 'desktop', tenant: 'local', user: 'operator' }, role: 'owner', status: 'active' },
      // Orphaned active linked row (linked_to_id = NULL) must be re-attached to the active owner
      { id: 'principal_lark_orphan', principal: { channel: 'lark', account: 'work', tenant: 'corp', user: 'ou_orphan_1' }, role: 'linked', status: 'active' },
    ])

    writeFileSync(patchPath, [
      '- id: dsh-enhanced-assistant-delivery',
      '  name: "@dsh-enhanced/assistant-delivery"',
      '  config:',
      "    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')",
      "    defaultWorkspace: !!js dshHomePath('assistant-workspace')",
      '    defaultAgentPreset: standard',
      '- id: dsh-enhanced-credentials-keychain',
      '  name: "@dsh-enhanced/credentials-keychain"',
      '  disabled: true',
      '  config:',
      '    handles: []',
      '- id: dsh-enhanced-lark-channel',
      '  name: "@dsh-enhanced/lark-channel"',
      '  disabled: true',
      '  config:',
      '    enabled: false',
      '    account: work',
      '    tenant: corp',
      '',
    ].join('\n'), 'utf8')

    const mgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_ws', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 2 })
        }
        // Single-poll completion returning international Lark tenant_brand directly
        return jsonResp(200, {
          client_id: fixtureAppId('aabbccddeeff0011'),
          client_secret: 'secret_for_ws_check',
          user_info: { open_id: 'ou_orphan_1', tenant_brand: 'lark' },
        })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })

    const started = await mgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })

    const done = await waitUntilTerminal(mgr, started.sessionId)
    expect(done.state).toBe('completed')
    expect(done.domain).toBe('lark')
    expect(done.domainSwitched).toBe(true)
    expect(done.ownerBinding).toBe('linked-to-owner')

    const yamlText = readFileSync(patchPath, 'utf8')
    expect(yamlText).not.toContain('&a1')
    expect(yamlText).not.toContain('*a1')
    expect(yamlText).not.toContain("workspace: dshHomePath")
    expect(yamlText).not.toContain('disabled: true')

    const rows = parseDocument(yamlText, JS_TAG).toJSON() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    const lark = rows.find(r => r.id === 'dsh-enhanced-lark-channel')!
    expect(lark.disabled).toBeUndefined()
    expect(lark.config).toMatchObject({
      account: 'work',
      tenant: 'corp',
      domain: 'lark',
      credentialHandle: 'lark-app-secret-work',
      credentialPurpose: 'connect',
      credentialLeaseMs: 86_400_000,
    })
    const pa = rows.find(r => r.id === 'dsh-enhanced-personal-assistant')!
    const rules = (pa.config!['assistantPolicy'] as { rules: Array<{ id: string; subject: Record<string, unknown>; resource: Record<string, unknown> }> }).rules
    const replyRule = rules.find(r => r.id === 'lark-owner-reply-work')!
    expect(replyRule.subject['workspace']).toMatch(/\/assistant-workspace$/u)
    expect(String(replyRule.subject['workspace']).startsWith('/')).toBe(true)
    const credRule = rules.find(r => r.id === 'lark-channel-credential-work')!
    expect(credRule.resource['id']).toBe('lark-app-secret-work')

    // Orphaned active linked principal now has linked_to_id set to active owner
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const orphan = db.prepare(`SELECT linked_to_id, status, version FROM delivery_principals WHERE id = 'principal_lark_orphan'`).get() as { linked_to_id: string | null; status: string; version: number }
      expect(orphan).toEqual({ linked_to_id: 'principal_owner_web', status: 'active', version: 2 })
    } finally {
      db.close()
    }

    // Hex-encoded secret must also be redacted when vault store throws
    const rawSecret = 'HEX_SECRET_MUST_NOT_LEAK_99'
    const hexSecret = Buffer.from(rawSecret, 'utf8').toString('hex')
    const hexMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_hex', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 60, interval: 2 })
        }
        return jsonResp(200, { client_id: fixtureAppId('aabbccddeeff0011'), client_secret: rawSecret })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => { throw new Error(`security failed with -X ${hexSecret}`) },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const hexStart = await hexMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const hexDone = await waitUntilTerminal(hexMgr, hexStart.sessionId)
    expect(hexDone.state).toBe('failed')
    expect(hexDone.note).not.toContain(rawSecret)
    expect(hexDone.note).not.toContain(hexSecret)
    expect(hexDone.note).toContain('[REDACTED]')
  })

  it('guards status() expiry race before applyAuthorizedApp, cancel() during in-flight begin, all-revoked SQLite, and invalid account/profileName', async () => {
    const { dshHome, profileDir, patchPath } = makeTempProfile('desktop')

    // 1) Rejects '@' and '-legacy-' in account, and invalid profileName (e.g. spaces)
    const valMgr = new FeishuQrOnboardingManager({
      fetchFn: async () => { throw new Error('unexpected network call during validation test') },
      platform: 'darwin',
      env: {},
    })
    const badAcc = await valMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: 'bad@acct', tenant: '', calendarReadonly: false, businessTools: true })
    expect(badAcc.state).toBe('failed')
    expect(badAcc.errorCode).toBe('invalid-account')

    const legacyAcc = await valMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: 'foo-legacy-bar', tenant: '', calendarReadonly: false, businessTools: true })
    expect(legacyAcc.state).toBe('failed')
    expect(legacyAcc.errorCode).toBe('invalid-account')

    const badProfileDir = join(dshHome, 'profiles', 'bad profile')
    mkdirSync(badProfileDir, { recursive: true })
    writeFileSync(join(badProfileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    const badProfile = await valMgr.start({
      host: makeHost(dshHome, badProfileDir, 'bad profile'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect(badProfile.state).toBe('failed')
    expect(badProfile.errorCode).toBe('invalid-profile-name')

    // 2) cancel() during in-flight action=begin transitions to cancelled cleanly
    let releaseBegin!: () => void
    const beginGate = new Promise<void>(resolve => { releaseBegin = resolve })
    const inFlightCancelMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        await beginGate
        if (init.signal.aborted) throw new Error('aborted')
        return jsonResp(200, { device_code: 'd_late', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 5 })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      platform: 'darwin',
      env: {},
    })
    const pendingStart = inFlightCancelMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const cancelDuringBegin = inFlightCancelMgr.cancel('')
    expect(cancelDuringBegin.state).toBe('cancelled')
    releaseBegin()
    const resolvedStart = await pendingStart
    expect(resolvedStart.state).toBe('cancelled')

    // 3) status() clock expiry race right as poll returns credentials must NOT call applyVaultFn
    let clock = 1_700_000_000_000
    let vaultCalled = false
    let releasePoll!: () => void
    const pollGate = new Promise<void>(resolve => { releasePoll = resolve })
    const raceMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_race', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 30, interval: 2 })
        }
        await pollGate
        return jsonResp(200, { client_id: fixtureAppId('aabbccddeeff0011'), client_secret: 'race_secret' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => { vaultCalled = true },
      now: () => clock,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const raceStart = await raceMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    await new Promise(resolve => setTimeout(resolve, 10))
    clock += 31_000
    const expiredSnap = raceMgr.status(raceStart.sessionId)
    expect(expiredSnap.state).toBe('expired')
    releasePoll()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(vaultCalled).toBe(false)
    expect(raceMgr.status(raceStart.sessionId).state).toBe('expired')

    // 4) All-revoked SQLite table (zero active owners) binds scanned user as owner, and malformed YAML refuses before vault write
    const dbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(dbPath, [
      { id: 'principal_old_revoked', principal: { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_old' }, role: 'owner', status: 'revoked' },
    ])
    writeFileSync(patchPath, 'not: a: valid: [yaml\n', 'utf8')
    let calledOnBadYaml = false
    const badYamlMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_yaml', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 60, interval: 2 })
        }
        return jsonResp(200, { client_id: fixtureAppId('aabbccddeeff0011'), client_secret: 'sec_bad_yaml', user_info: { open_id: 'ou_new_owner' } })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => { calledOnBadYaml = true },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const badYamlStart = await badYamlMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const badYamlDone = await waitUntilTerminal(badYamlMgr, badYamlStart.sessionId)
    expect(badYamlDone.state).toBe('failed')
    expect(calledOnBadYaml).toBe(false)

    // Restore valid patch and confirm all-revoked SQLite binds new owner
    writeFileSync(patchPath, '[]\n', 'utf8')
    const revokedStart = await badYamlMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      getSettings: () => undefined,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const revokedDone = await waitUntilTerminal(badYamlMgr, revokedStart.sessionId)
    expect(revokedDone.state).toBe('completed')
    expect(revokedDone.ownerBinding).toBe('bound-owner')
  })

  it('fails fast before QR request when pluginManager reports required bundles uninstalled or disabled, unrefs poll timers, and rolls back secret on YAML failure', async () => {
    const { dshHome, profileDir, patchPath } = makeTempProfile('desktop')
    const bundleRow = (name: string, installed: boolean, enabled: boolean): BundleInfoLike => ({
      name, installed, enabled, removable: true, optional: false,
    })

    // 1) Preflight rejects missing/disabled bundles before calling fetchFn
    const unexpectedFetch = vi.fn(async () => { throw new Error('must not request QR when bundles missing') })
    const preflightMgr = new FeishuQrOnboardingManager({
      fetchFn: unexpectedFetch,
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      platform: 'darwin',
      env: {},
    })
    const hostWithMissingBundles = {
      get: (name: string) => {
        if (name === 'profileContext') return { dir: profileDir, name: 'desktop' }
        if (name === 'homePaths') return { dshHome }
        if (name === 'pluginManager') {
          return {
            listBundles: async () => [
              bundleRow('@dsh-enhanced/lark-channel', true, true),
              bundleRow('@dsh-enhanced/assistant-delivery', true, false),
              // @dsh-enhanced/credentials-keychain omitted (uninstalled)
            ],
          }
        }
        return undefined
      },
    }
    const missingRes = await preflightMgr.start({
      host: hostWithMissingBundles,
      getDescriptors: () => [],
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect(missingRes.state).toBe('failed')
    expect(missingRes.errorCode).toBe('missing-required-bundles')
    expect(missingRes.note).toContain('@dsh-enhanced/credentials-keychain')
    expect(missingRes.note).toContain('@dsh-enhanced/assistant-delivery')
    expect(unexpectedFetch).not.toHaveBeenCalled()

    // 1b) Cancelling while async pluginManager.listBundles() is hung resolves immediately without waiting on listBundles(), and a late rejection never leaks unhandled
    let rejectLateList!: (err: Error) => void
    const hungBundlesPromise = new Promise<BundleInfoLike[]>((_resolve, reject) => { rejectLateList = reject })
    const cancelPreflightFetch = vi.fn(async () => { throw new Error('must not call fetch after cancel during preflight') })
    const cancelPreflightMgr = new FeishuQrOnboardingManager({
      fetchFn: cancelPreflightFetch,
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      platform: 'darwin',
      env: {},
    })
    const pendingPreflightStart = cancelPreflightMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      listBundles: () => hungBundlesPromise,
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect(cancelPreflightMgr.cancel('').state).toBe('cancelled')
    // Must resolve IMMEDIATELY while hungBundlesPromise is still pending!
    expect((await pendingPreflightStart).state).toBe('cancelled')
    expect(cancelPreflightFetch).not.toHaveBeenCalled()
    // Late rejection after cancel must be swallowed cleanly without unhandledRejection
    rejectLateList(new Error('late pluginManager failure'))
    await new Promise(resolve => setTimeout(resolve, 10))

    // 1c) An injected sleep that rejects with AbortError on cancel exits polling cleanly without unhandledRejection
    const abortRejectSleepMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_sleep_abort', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 5 })
        }
        return jsonResp(400, { error: 'authorization_pending' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      sleep: (_ms, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true })
      }),
      platform: 'darwin',
      env: {},
    })
    const abortSleepStart = await abortRejectSleepMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(abortRejectSleepMgr.cancel(abortSleepStart.sessionId).state).toBe('cancelled')
    await new Promise(resolve => setTimeout(resolve, 10))

    // 2) Preflight passes when all three required bundles are installed and enabled, and defaultSleep unrefs its timer
    const unrefSpy = vi.fn()
    const realSetTimeout = globalThis.setTimeout
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(fn, delay, ...args)
      const origUnref = handle.unref?.bind(handle)
      handle.unref = (() => {
        unrefSpy()
        return origUnref?.() ?? handle
      }) as typeof handle.unref
      return handle
    }) as typeof setTimeout)

    const hostAllBundlesReady = {
      get: (name: string) => {
        if (name === 'profileContext') return { dir: profileDir, name: 'desktop' }
        if (name === 'homePaths') return { dshHome }
        if (name === 'pluginManager') {
          return {
            listBundles: async () => [
              bundleRow('@dsh-enhanced/lark-channel', true, true),
              bundleRow('@dsh-enhanced/credentials-keychain', true, true),
              bundleRow('@dsh-enhanced/assistant-delivery', true, true),
            ],
          }
        }
        return undefined
      },
    }
    const timerMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_unref', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 5 })
        }
        return jsonResp(400, { error: 'authorization_pending' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      platform: 'darwin',
      env: {},
    })
    try {
      const startedTimer = await timerMgr.start({
        host: hostAllBundlesReady,
        getDescriptors: () => [],
      }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
      expect(startedTimer.state).toBe('awaiting-scan')
      await new Promise(resolve => realSetTimeout(resolve, 10))
      expect(unrefSpy).toHaveBeenCalled()
      timerMgr.dispose()
    } finally {
      setTimeoutSpy.mockRestore()
    }

    // 3) End-to-end rollback via FeishuQrOnboardingManager when atomicWritePatchWithBackup fails
    mkdirSync(join(`${patchPath}.bak.1700000000000`, 'blocker'), { recursive: true })
    const storedLocators: EasySecretLocator[] = []
    const deletedLocators: EasySecretLocator[] = []
    const rollbackMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_rb', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 2 })
        }
        return jsonResp(200, { client_id: fixtureAppId('aabbccddeeff0011'), client_secret: 'QR_ROLLBACK_SECRET_XYZ' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async (locator) => { storedLocators.push(locator) },
      deleteSecretFn: async (locator) => { deletedLocators.push(locator) },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const rbStart = await rollbackMgr.start({
      host: hostAllBundlesReady,
      getDescriptors: () => [],
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    const rbDone = await waitUntilTerminal(rollbackMgr, rbStart.sessionId)
    expect(rbDone.state).toBe('failed')
    expect(rbDone.applied).toBe(false)
    expect(rbDone.errorCode).toBe('apply-refused')
    expect(storedLocators).toHaveLength(1)
    expect(deletedLocators).toEqual(storedLocators)
    expect(rbDone.note).toContain('已自动清理本次新建的系统凭据项')
    expect(rbDone.note).not.toContain('QR_ROLLBACK_SECRET_XYZ')
  })

  it('populates post-scan guided metadata and supports confirmed one-click owner promotion & profile restart via OwnerConsoleService', async () => {
    const { dshHome, profileDir, patchPath } = makeTempProfile('desktop')
    const dbPath = join(dshHome, 'assistant-delivery', 'state.sqlite')
    makeDeliveryDb(dbPath, [{
      id: 'principal_web_existing',
      principal: { channel: 'web', account: 'desktop', tenant: 'local', user: 'operator' },
      role: 'owner',
      status: 'active',
    }])
    // Add extra tables matching real @dsh-enhanced/assistant-delivery schema
    const initDb = new DatabaseSync(dbPath)
    try {
      initDb.exec(`
        CREATE TABLE conversation_bindings (
          id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
      `)
    } finally {
      initDb.close()
    }
    writeFileSync(patchPath, [
      '- id: dsh-enhanced-assistant-dreaming',
      '  name: "@dsh-enhanced/assistant-dreaming"',
      '  config:',
      '    enabled: true',
      '    retired: false',
      '    scope:',
      '      principalId: web/desktop/local/operator',
      '',
    ].join('\n'), 'utf8')

    const appId = fixtureAppId('abcdef0123456789')
    const qrMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_guide', verification_uri_complete: 'https://open.feishu.cn/page/launcher?g=1', expires_in: 300, interval: 2 })
        }
        return jsonResp(200, {
          client_id: appId,
          client_secret: 'guided_secret_value',
          user_info: { open_id: 'ou_guided_owner_42', tenant_brand: 'feishu' },
        })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      inspectRestartFn: () => ({
        supported: true,
        mode: 'desktop-app',
        command: '重启 DeepSeek Harness.app',
        appPath: '/Applications/DeepSeek Harness.app',
      }),
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })

    const ctx = new Context()
    ctx.provide('profileContext' as never, { dir: profileDir, name: 'desktop' } as never)
    ctx.provide('homePaths' as never, { dshHome } as never)
    const restartMock = vi.fn(async (input: { confirmed: boolean }) => ({
      applied: input.confirmed,
      entry: 'profile-restart',
      note: input.confirmed ? '正在重启 DeepSeek Harness.app' : '需要确认',
    }))
    const svc = new OwnerConsoleService(ctx, { feishuAppId: '' }, undefined, undefined, undefined, undefined, qrMgr, restartMock)
    try {
      const started = await svc.startFeishuQrOnboarding('feishu', '文鳐专属', '', '', '', false, true)
      const done = await waitUntilTerminal(qrMgr, started.sessionId)
      expect(() => FeishuQrOnboardingSnapshotSchema.parse(done)).not.toThrow()
      expect(done.state).toBe('completed')
      expect(done.appName).toBe('文鳐专属')
      expect(done.account).toBe('primary')
      expect(done.tenant).toBe('personal')
      expect(done.ownerBinding).toBe('linked-to-owner')
      expect(done.existingAutonomyAnchored).toBe(true)
      expect(done.restartSupported).toBe(true)
      expect(done.restartMode).toBe('desktop-app')
      expect(done.restartCommand).toBe('重启 DeepSeek Harness.app')
      expect(done.openPlatformUrl).toBe(`https://open.feishu.cn/app/${appId}`)
      expect(done.businessToolsRequested).toBe(true)
      expect(done.businessCliCommand).toBe(`dsh-lark-setup --profile desktop --app-id ${appId}`)

      // Unconfirmed promotion refuses while keeping completed snapshot intact
      const unconfirmed = await svc.promoteFeishuQrOwner(done.sessionId, false)
      expect(unconfirmed.state).toBe('completed')
      expect(unconfirmed.errorCode).toBe('confirmation-required')
      expect(unconfirmed.ownerBinding).toBe('linked-to-owner')

      // Wrong sessionId returns idle without disturbing current session
      const wrongSession = await svc.promoteFeishuQrOwner('wrong-session-id', true)
      expect(wrongSession.state).toBe('idle')
      expect(qrMgr.status(done.sessionId).state).toBe('completed')

      // Confirmed promotion hands off owner cleanly
      const promoted = await svc.promoteFeishuQrOwner(done.sessionId, true)
      expect(() => FeishuQrOnboardingSnapshotSchema.parse(promoted)).not.toThrow()
      expect(promoted.state).toBe('completed')
      expect(promoted.ownerBinding).toBe('bound-owner')
      expect(promoted.ownerPromoted).toBe(true)
      expect(promoted.errorCode).toBeUndefined()
      expect(promoted.existingAutonomyAnchored).toBe(true)
      expect(promoted.restartRecommended).toBe(true)

      // Restart RPC forwards confirmation flag
      const restartDenied = await svc.restartProfile(false)
      expect(restartDenied.applied).toBe(false)
      const restartOk = await svc.restartProfile(true)
      expect(restartOk.applied).toBe(true)
      expect(restartMock).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }

    // Missing open_id and throwing promoteOwnerFn must keep completed state rather than clobbering it
    const noOpenIdMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_noop', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 2 })
        }
        return jsonResp(200, { client_id: appId, client_secret: 'sec_no_open_id' })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const noOpenStart = await noOpenIdMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: false })
    const noOpenDone = await waitUntilTerminal(noOpenIdMgr, noOpenStart.sessionId)
    expect(noOpenDone.ownerBinding).toBe('not-returned')
    expect(noOpenDone.businessToolsRequested).toBe(false)
    expect(noOpenDone.businessCliCommand).toBeUndefined()
    const missingOpenRes = await noOpenIdMgr.promoteOwner({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
    }, noOpenDone.sessionId, true)
    expect(missingOpenRes.state).toBe('completed')
    expect(missingOpenRes.errorCode).toBe('missing-open-id')

    const errPromoteMgr = new FeishuQrOnboardingManager({
      fetchFn: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body).entries())
        if (body['action'] === 'begin') {
          return jsonResp(200, { device_code: 'd_errp', verification_uri_complete: 'https://open.feishu.cn/page/launcher', expires_in: 300, interval: 2 })
        }
        return jsonResp(200, { client_id: appId, client_secret: 'sec_err_p', user_info: { open_id: 'ou_err_1' } })
      },
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      promoteOwnerFn: async () => { throw new Error('sqlite busy') },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      platform: 'darwin',
      env: {},
    })
    const errStart = await errPromoteMgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: false })
    const errDone = await waitUntilTerminal(errPromoteMgr, errStart.sessionId)
    const errPromo = await errPromoteMgr.promoteOwner({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
    }, errDone.sessionId, true)
    expect(errPromo.state).toBe('completed')
    expect(errPromo.errorCode).toBe('promote-failed')
    expect(errPromo.note).toContain('sqlite busy')
  })

  it('rejects QR preflight when personal-assistant is installed but disabled and no other policy provider is enabled', async () => {
    const { dshHome, profileDir } = makeTempProfile()
    const fetchSpy = vi.fn(async () => { throw new Error('must not call Feishu API when policy provider is disabled') })
    const mgr = new FeishuQrOnboardingManager({
      fetchFn: fetchSpy,
      renderQrFn: async () => 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      storeSecretFn: async () => {},
      platform: 'darwin',
      env: {},
    })
    const res = await mgr.start({
      host: makeHost(dshHome, profileDir, 'desktop'),
      getDescriptors: () => [],
      listBundles: async () => [
        { name: '@dsh-enhanced/lark-channel', installed: true, enabled: true, optional: false, removable: true, rows: [] },
        { name: '@dsh-enhanced/credentials-keychain', installed: true, enabled: true, optional: false, removable: true, rows: [] },
        { name: '@dsh-enhanced/assistant-delivery', installed: true, enabled: true, optional: false, removable: true, rows: [] },
        { name: '@dsh-enhanced/personal-assistant', installed: true, enabled: false, optional: false, removable: true, rows: [] },
      ],
    }, { domain: 'feishu', appName: '文鳐', existingAppId: '', account: '', tenant: '', calendarReadonly: false, businessTools: true })
    expect(res.state).toBe('failed')
    expect(res.errorCode).toBe('missing-required-bundles')
    expect(res.note).toContain('@dsh-enhanced/personal-assistant')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
