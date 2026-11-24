import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeCalendarGuardedAction, validateCalendarAgainstGrant } from '../src/guards/calendar-guard.ts'
import { executeHttpGuardedAction, isBlockedIpAddress, validateHttpAgainstGrant, validateStrictHttpUrl } from '../src/guards/http-guard.ts'
import { executeLarkGuardedAction, validateLarkAgainstGrant } from '../src/guards/lark-guard.ts'
import { executeShellGuardedAction, validateShellAgainstGrant } from '../src/guards/shell-guard.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

describe('Domain Guards (http, lark, calendar, shell)', () => {
  describe('http-guard', () => {
    it('blocks private, loopback, link-local, metadata, multicast, and IPv4-mapped IPv6 addresses', () => {
      for (const blocked of [
        '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
        '169.254.169.254', '169.254.1.1', '0.0.0.0', '224.0.0.1',
        '::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', 'fc00::1', 'fe80::1',
      ]) {
        expect(isBlockedIpAddress(blocked, false)).toBe(true)
      }
      // Even with allowPrivateNetwork, cloud metadata 169.254.169.254 stays blocked
      expect(isBlockedIpAddress('127.0.0.1', true)).toBe(false)
      expect(isBlockedIpAddress('169.254.169.254', true)).toBe(true)
      expect(isBlockedIpAddress('::ffff:169.254.169.254', true)).toBe(true)
      expect(isBlockedIpAddress('::169.254.169.254', true)).toBe(true)
      expect(isBlockedIpAddress('64:ff9b::169.254.169.254', true)).toBe(true)
      expect(isBlockedIpAddress('93.184.216.34', false)).toBe(false)

      // IPv6 SSRF transition/embedded IPv4 prefixes blocked when allowPrivateNetwork === false
      for (const blockedV6 of [
        '::127.0.0.1',
        '0:0:0:0:0:0:7f00:1',
        '::169.254.169.254',
        '64:ff9b::127.0.0.1',
        '64:ff9b::169.254.169.254',
        '64:ff9b:1::127.0.0.1',
        '2002:7f00:0001::',
        '2002:a9fe:a9fe::',
        '2001::1',
        '2001:2::1',
        '100::1',
      ]) {
        expect(isBlockedIpAddress(blockedV6, false)).toBe(true)
      }
      // Legitimate global unicast IPv6 remains allowed
      for (const publicV6 of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
        expect(isBlockedIpAddress(publicV6, false)).toBe(false)
      }
    })

    it('rejects IPv4-compatible and NAT64 DNS pinning in executeHttpGuardedAction when allowPrivateNetwork is false', async () => {
      const grantDest = {
        classification: 'http-endpoint' as const,
        allowedSchemes: ['https'] as const,
        allowedHosts: ['ssrf.example.test'],
        allowedMethods: ['GET'] as const,
        allowedPathPrefixes: ['/'],
        allowRedirects: false as const,
        allowPrivateNetwork: false as const,
        maxResponseBytes: 1024,
      }
      const reqDest = { classification: 'http-endpoint' as const, scheme: 'https' as const, host: 'ssrf.example.test', path: '/latest' }
      for (const addr of ['::127.0.0.1', '64:ff9b::169.254.169.254', '2002:7f00:0001::']) {
        await expect(executeHttpGuardedAction({
          grantDestination: grantDest,
          requestDestination: reqDest,
          payload: { method: 'GET', url: 'https://ssrf.example.test/latest' },
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          deps: {
            lookup: async () => [{ address: addr, family: 6 }],
          },
        })).rejects.toThrow(/blocked address/)
      }
    })

    it('rejects userinfo, empty userinfo authority, fragments, path traversal, and forbidden headers', () => {
      expect(() => validateStrictHttpUrl('https://user:pass@api.example.test/v1/ok')).toThrow(/userinfo/)
      expect(() => validateStrictHttpUrl('https://:@example.com/v1')).toThrow(/userinfo/)
      expect(() => validateStrictHttpUrl('https://@example.com/v1')).toThrow(/userinfo/)
      expect(() => validateStrictHttpUrl('http://user@[::1]:8080/v1')).toThrow(/userinfo/)
      expect(() => validateStrictHttpUrl('https://example.com/@user/profile?email=a@b.test').pathname).not.toThrow()
      expect(() => validateStrictHttpUrl('https://api.example.test/v1/ok#frag')).toThrow(/fragments/)
      expect(() => validateStrictHttpUrl('https://api.example.test/v1/../secret')).toThrow(/dot path/)
      expect(() => validateStrictHttpUrl('https://api.example.test/v1/%2e%2e/secret')).toThrow(/encoded/)

      const grantDest = {
        classification: 'http-endpoint' as const,
        allowedSchemes: ['https'] as const,
        allowedHosts: ['api.example.test'],
        allowedMethods: ['GET'] as const,
        allowedPathPrefixes: ['/v1'],
        allowRedirects: false as const,
        maxResponseBytes: 1024,
      }
      expect(() => validateHttpAgainstGrant(
        grantDest,
        { classification: 'http-endpoint', scheme: 'https', host: 'api.example.test', path: '/v1/data' },
        { method: 'GET', url: 'https://api.example.test/v1/data', headers: { Authorization: 'Bearer leaked' } },
      )).toThrow(/forbidden HTTP request header/)
    })

    it('rejects DNS rebinding to internal IPs and 3xx redirects, enforces byte cap and secret scrubbing', async () => {
      const grantDest = {
        classification: 'http-endpoint' as const,
        allowedSchemes: ['https'] as const,
        allowedHosts: ['rebind.example.test'],
        allowedMethods: ['GET'] as const,
        allowedPathPrefixes: ['/api'],
        allowRedirects: false as const,
        maxResponseBytes: 32,
        authHeader: 'authorization',
        authScheme: 'Bearer',
      }
      const reqDest = { classification: 'http-endpoint' as const, scheme: 'https' as const, host: 'rebind.example.test', path: '/api/v1' }

      // DNS rebinding attempt (public + metadata IP)
      await expect(executeHttpGuardedAction({
        grantDestination: grantDest,
        requestDestination: reqDest,
        payload: { method: 'GET', url: 'https://rebind.example.test/api/v1' },
        token: 'tok-secret-123',
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        deps: {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }],
        },
      })).rejects.toThrow(/blocked address/)

      // Real local HTTP server test: redirects rejected, byte cap enforced, secret scrubbed
      const server = createServer((req, res) => {
        if (req.url === '/api/redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1/internal' })
          res.end()
          return
        }
        if (req.url === '/api/leak') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('leaked tok-secret-123')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"hello":"world","extra":"0123456789abcdef0123456789abcdef"}')
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const addr = server.address() as { port: number }
      try {
        const localGrant = {
          classification: 'http-endpoint' as const,
          allowedSchemes: ['http'] as const,
          allowedHosts: ['127.0.0.1'],
          allowedPorts: [addr.port],
          allowedMethods: ['GET'] as const,
          allowedPathPrefixes: ['/api'],
          allowRedirects: false as const,
          allowPrivateNetwork: true,
          maxResponseBytes: 24,
          authHeader: 'authorization',
          authScheme: 'Bearer',
        }
        await expect(executeHttpGuardedAction({
          grantDestination: localGrant,
          requestDestination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port: addr.port, path: '/api/redirect' },
          payload: { method: 'GET', url: `http://127.0.0.1:${addr.port}/api/redirect` },
          token: 'tok-secret-123',
          timeoutMs: 2_000,
          signal: new AbortController().signal,
        })).rejects.toThrow(/redirects/)

        await expect(executeHttpGuardedAction({
          grantDestination: localGrant,
          requestDestination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port: addr.port, path: '/api/leak' },
          payload: { method: 'GET', url: `http://127.0.0.1:${addr.port}/api/leak` },
          token: 'tok-secret-123',
          timeoutMs: 2_000,
          signal: new AbortController().signal,
        })).rejects.toThrow(/secret/)

        const ok = await executeHttpGuardedAction({
          grantDestination: localGrant,
          requestDestination: { classification: 'http-endpoint', scheme: 'http', host: '127.0.0.1', port: addr.port, path: '/api/ok' },
          payload: { method: 'GET', url: `http://127.0.0.1:${addr.port}/api/ok` },
          token: 'tok-secret-123',
          timeoutMs: 2_000,
          signal: new AbortController().signal,
        })
        expect(ok.statusCode).toBe(200)
        expect(ok.truncated).toBe(true)
        expect(Buffer.byteLength(ok.body, 'utf8')).toBeLessThanOrEqual(24)
        expect(ok.untrusted).toBe(true)
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  })

  describe('lark-guard', () => {
    const grantDest = {
      classification: 'lark-workspace' as const,
      tenantKey: 'tenant-1',
      apiBaseUrl: 'https://open.feishu.cn',
      allowedChatIds: ['oc_allowed'],
      allowedOpenIds: ['ou_allowed'],
      allowedMsgTypes: ['text'] as const,
      maxTextBytes: 128,
    }

    it('rejects disallowed chatId, msgType, oversized text, and secret leakage', async () => {
      expect(() => validateLarkAgainstGrant(
        'lark.send-message',
        grantDest,
        { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_other' },
        { receiveIdType: 'chat_id', receiveId: 'oc_other', msgType: 'text', content: '{"text":"hi"}', uuid: 'u1' },
      )).toThrow(/chat_id/)

      expect(() => validateLarkAgainstGrant(
        'lark.send-message',
        grantDest,
        { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_allowed' },
        { receiveIdType: 'chat_id', receiveId: 'oc_allowed', msgType: 'interactive', content: '{}', uuid: 'u1' },
      )).toThrow(/msgType/)

      await expect(executeLarkGuardedAction({
        actionId: 'a1',
        operation: 'lark.send-message',
        grantDestination: grantDest,
        requestDestination: { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_allowed' },
        payload: { receiveIdType: 'chat_id', receiveId: 'oc_allowed', msgType: 'text', content: '{"text":"hi"}', uuid: 'u1' },
        token: 'lark_secret_xyz',
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        deps: {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: async () => ({ messageId: 'om_1', observed: { leak: 'lark_secret_xyz' } }),
        },
      })).rejects.toThrow(/secret/)

      const ok = await executeLarkGuardedAction({
        actionId: 'a2',
        operation: 'lark.send-message',
        grantDestination: grantDest,
        requestDestination: { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_allowed' },
        payload: { receiveIdType: 'chat_id', receiveId: 'oc_allowed', msgType: 'text', content: '{"text":"hello"}', uuid: 'u2' },
        token: 'lark_secret_xyz',
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        deps: {
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: async () => ({ messageId: 'om_2', chatId: 'oc_allowed', observed: { code: 0 } }),
        },
      })
      expect(ok.messageId).toBe('om_2')
      expect(ok.untrusted).toBe(true)
    })

    it('rejects dot-segment traversal in replyToMessageId/receiveId/chatId/threadId and mismatched read receiveId', async () => {
      for (const badId of ['.', '..', 'om_1/../../evil', 'om_1\\evil', 'om_1%2e', 'om_1?x=1', 'om_1#f', 'om 1']) {
        await expect(executeLarkGuardedAction({
          actionId: 'a-bad-reply',
          operation: 'lark.reply-message',
          grantDestination: grantDest,
          requestDestination: { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_allowed' },
          payload: { receiveIdType: 'chat_id', receiveId: 'oc_allowed', msgType: 'text', content: 'hi', replyToMessageId: badId, uuid: 'u1' },
          token: 'lark_secret_xyz',
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          deps: {
            lookup: async () => [{ address: '93.184.216.34', family: 4 }],
            requestImpl: async () => ({ statusCode: 200, headers: {}, body: Buffer.from('{"data":{}}'), truncated: false }),
          },
        })).rejects.toMatchObject({ code: 'request-invalid', dispatched: false })
      }

      expect(() => validateLarkAgainstGrant(
        'lark.send-message',
        { ...grantDest, allowedChatIds: ['..'] },
        { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: '..' },
        { receiveIdType: 'chat_id', receiveId: '..', msgType: 'text', content: 'hi', uuid: 'u1' },
      )).toThrow(/forbidden path or URL characters/)

      expect(() => validateLarkAgainstGrant(
        'lark.read-messages',
        grantDest,
        { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'open_id', receiveId: 'oc_allowed' },
        { chatId: 'oc_allowed', pageSize: 10 },
      )).toThrow(/does not match read chatId/)

      expect(() => validateLarkAgainstGrant(
        'lark.read-messages',
        grantDest,
        { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'ou_allowed' },
        { chatId: 'oc_allowed', pageSize: 10 },
      )).toThrow(/does not match read chatId/)

      expect(() => validateLarkAgainstGrant(
        'lark.read-messages',
        grantDest,
        { classification: 'lark-workspace', tenantKey: 'tenant-1', receiveIdType: 'chat_id', receiveId: 'oc_allowed' },
        { chatId: 'oc_allowed', threadId: '..', pageSize: 10 },
      )).toThrow(/threadId contains forbidden/)
    })
  })

  describe('calendar-guard', () => {
    const now = 1_700_000_000_000
    const grantDest = {
      classification: 'calendar-scope' as const,
      provider: 'lark-calendar' as const,
      apiBaseUrl: 'https://open.feishu.cn',
      allowedCalendarIds: ['cal-main'],
      windowStartMs: now - 3_600_000,
      windowEndMs: now + 86_400_000,
      rollingWindowMs: 43_200_000,
      rollingLookbackMs: 3_600_000,
      maxWindowSpanMs: 14_400_000,
      allowMutations: false,
      allowExternalAttendees: false,
      allowedAttendeeDomains: ['company.example'],
    }

    it('enforces calendarId, rolling/static windows, mutation gate, and attendee domain allowlist', async () => {
      expect(() => validateCalendarAgainstGrant(
        'calendar.create-event',
        grantDest,
        { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        { calendarId: 'cal-main', startTimeMs: now, endTimeMs: now + 3_600_000, summary: 'Meeting' },
        now,
      )).toThrow(/mutations are disabled/)

      expect(() => validateCalendarAgainstGrant(
        'calendar.list-events',
        grantDest,
        { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        { calendarId: 'cal-main', startTimeMs: now, endTimeMs: now + 50_000_000 },
        now,
      )).toThrow(/maxWindowSpanMs/)

      expect(() => validateCalendarAgainstGrant(
        'calendar.list-events',
        grantDest,
        { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        { calendarId: 'cal-main', startTimeMs: now + 40_000_000, endTimeMs: now + 45_000_000 },
        now,
      )).toThrow(/rolling window/)

      expect(() => validateCalendarAgainstGrant(
        'calendar.create-event',
        { ...grantDest, allowMutations: true },
        { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        { calendarId: 'cal-main', startTimeMs: now, endTimeMs: now + 3_600_000, attendees: ['external@evil.test'] },
        now,
      )).toThrow(/external attendee domain blocked/)

      const res = await executeCalendarGuardedAction({
        operation: 'calendar.list-events',
        grantDestination: grantDest,
        requestDestination: { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        payload: { calendarId: 'cal-main', startTimeMs: now, endTimeMs: now + 3_600_000 },
        token: 'cal_tok',
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        deps: {
          now: () => now,
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          transport: async () => ({ observed: { items: [] } }),
        },
      })
      expect(res.calendarId).toBe('cal-main')
      expect(res.untrusted).toBe(true)
    })

    it('rejects dot-segment and URL-delimiter path traversal in calendarId and eventId', async () => {
      const mutGrant = { ...grantDest, allowMutations: true, allowedCalendarIds: ['cal-main', '..'] }
      for (const badEventId of ['.', '..', 'evt/../../other', 'evt\\x', 'evt%2e', 'evt?x=1', 'evt#frag', 'evt 1']) {
        await expect(executeCalendarGuardedAction({
          operation: 'calendar.delete-event',
          grantDestination: mutGrant,
          requestDestination: { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
          payload: { calendarId: 'cal-main', eventId: badEventId },
          token: 'cal_tok',
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          deps: {
            now: () => now,
            lookup: async () => [{ address: '93.184.216.34', family: 4 }],
            requestImpl: async () => ({ statusCode: 200, headers: {}, body: Buffer.from('{}'), truncated: false }),
          },
        })).rejects.toMatchObject({ code: 'request-invalid', dispatched: false })
      }

      await expect(executeCalendarGuardedAction({
        operation: 'calendar.get-event',
        grantDestination: mutGrant,
        requestDestination: { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        payload: { calendarId: 'cal-main', eventId: '.' },
        token: 'cal_tok',
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        deps: {
          now: () => now,
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          requestImpl: async () => ({ statusCode: 200, headers: {}, body: Buffer.from('{}'), truncated: false }),
        },
      })).rejects.toMatchObject({ code: 'request-invalid', dispatched: false })

      expect(() => validateCalendarAgainstGrant(
        'calendar.list-events',
        mutGrant,
        { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: '..' },
        { calendarId: '..', startTimeMs: now, endTimeMs: now + 3_600_000 },
        now,
      )).toThrow(/calendarId contains forbidden/)

      // Normal eventId continues to pass tightened allowedPathPrefixes
      let seenPath = ''
      const getRes = await executeCalendarGuardedAction({
        operation: 'calendar.get-event',
        grantDestination: mutGrant,
        requestDestination: { classification: 'calendar-scope', provider: 'lark-calendar', calendarId: 'cal-main' },
        payload: { calendarId: 'cal-main', eventId: 'evt-123' },
        token: 'cal_tok',
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        deps: {
          now: () => now,
          lookup: async () => [{ address: '93.184.216.34', family: 4 }],
          requestImpl: async req => {
            seenPath = req.url.pathname
            return { statusCode: 200, headers: {}, body: Buffer.from('{"data":{"event":{"event_id":"evt-123"}}}'), truncated: false }
          },
        },
      })
      expect(seenPath).toBe('/open-apis/calendar/v4/calendars/cal-main/events/evt-123')
      expect(getRes.eventId).toBe('evt-123')
    })
  })

  describe('shell-guard', () => {
    it('enforces cwd symlink rejection, executable sha256, args prefix, env allowlist, and real execution with shell: false', async () => {
      const dir = await makeTempDir('shell-guard-')
      const safeCwd = join(dir, 'workspace')
      const linkCwd = join(dir, 'symlink-cwd')
      await mkdir(safeCwd, { mode: 0o700 })
      await symlink(safeCwd, linkCwd)

      const scriptPath = join(dir, 'tool.sh')
      await writeFile(scriptPath, '#!/bin/sh\necho ok\n', { mode: 0o755 })
      await chmod(scriptPath, 0o755)

      const nodeBytes = await (await import('node:fs/promises')).readFile(process.execPath)
      const nodeSha = createHash('sha256').update(nodeBytes).digest('hex')

      const grantDest = {
        classification: 'shell-command' as const,
        allowedCwds: [safeCwd],
        allowedCommands: [
          {
            executable: process.execPath,
            executableSha256: nodeSha,
            allowedArgPrefixes: [['-e']],
            maxArgs: 2,
          },
        ],
        allowedEnvKeys: ['SAFE_VAR'],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        allowNetwork: false as const,
      }

      // Symlink cwd escape rejected
      await expect(validateShellAgainstGrant(
        grantDest,
        { classification: 'shell-command', executable: process.execPath, cwd: linkCwd },
        { executable: process.execPath, args: ['-e', 'console.log(1)'], cwd: linkCwd, timeoutMs: 1_000 },
      )).rejects.toThrow(/non-symlink/)

      // LD_PRELOAD blocked
      await expect(validateShellAgainstGrant(
        grantDest,
        { classification: 'shell-command', executable: process.execPath, cwd: safeCwd },
        { executable: process.execPath, args: ['-e', 'console.log(1)'], cwd: safeCwd, env: { LD_PRELOAD: '/tmp/evil.so' }, timeoutMs: 1_000 },
      )).rejects.toThrow(/forbidden environment variable/)

      // Disallowed arg prefix rejected
      await expect(validateShellAgainstGrant(
        grantDest,
        { classification: 'shell-command', executable: process.execPath, cwd: safeCwd },
        { executable: process.execPath, args: ['--version'], cwd: safeCwd, timeoutMs: 1_000 },
      )).rejects.toThrow(/allowedArgPrefixes/)

      // Real execution succeeds cleanly and isolates process.env
      process.env.TEST_HOST_SECRET = 'must_not_leak_to_child'
      try {
        const execResult = await executeShellGuardedAction({
          grantDestination: grantDest,
          requestDestination: { classification: 'shell-command', executable: process.execPath, cwd: safeCwd },
          payload: {
            executable: process.execPath,
            args: ['-e', 'process.stdout.write((process.env.SAFE_VAR||"") + ":" + (process.env.TEST_HOST_SECRET||"none"))'],
            cwd: safeCwd,
            env: { SAFE_VAR: 'hello' },
            timeoutMs: 3_000,
          },
          remainingLeaseMs: 3_000,
          signal: new AbortController().signal,
        })
        expect(execResult.exitCode).toBe(0)
        expect(execResult.stdout).toBe('hello:none')
        expect(execResult.untrusted).toBe(true)
      } finally {
        delete process.env.TEST_HOST_SECRET
      }
    })

    it('rejects symlink executables, case-variant dangerous env keys, and abort during async fs inspection without ReferenceError', async () => {
      const dir = await makeTempDir('shell-guard-hardening-')
      const safeCwd = join(dir, 'workspace')
      await mkdir(safeCwd, { mode: 0o700 })

      const linkExec = join(dir, 'fake-node')
      await symlink(process.execPath, linkExec)

      const symlinkGrant = {
        classification: 'shell-command' as const,
        allowedCwds: [safeCwd],
        allowedCommands: [{ executable: linkExec, maxArgs: 2 }],
        allowedEnvKeys: ['SAFE_VAR', 'PATH', 'node_options', 'ld_preload', 'Path'],
        maxTimeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        allowNetwork: false as const,
      }

      // Symlink executable rejected even if listed in allowedCommands
      await expect(validateShellAgainstGrant(
        symlinkGrant,
        { classification: 'shell-command', executable: linkExec, cwd: safeCwd },
        { executable: linkExec, args: ['-v'], cwd: safeCwd, timeoutMs: 1_000 },
      )).rejects.toThrow(/non-symlink file/)

      const realGrant = {
        ...symlinkGrant,
        allowedCommands: [{ executable: process.execPath, allowedArgPrefixes: [['-e']], maxArgs: 2 }],
      }

      // Case-variant dangerous env keys rejected even if present in allowedEnvKeys
      for (const badEnv of [
        { node_options: '--require=/tmp/evil.js' },
        { ld_preload: '/tmp/evil.so' },
        { dyld_insert_libraries: '/tmp/evil.dylib' },
        { Path: '/tmp/evil' },
      ] as Array<Record<string, string>>) {
        await expect(validateShellAgainstGrant(
          realGrant,
          { classification: 'shell-command', executable: process.execPath, cwd: safeCwd },
          { executable: process.execPath, args: ['-e', 'console.log(1)'], cwd: safeCwd, env: badEnv, timeoutMs: 1_000 },
        )).rejects.toThrow(/forbidden environment variable|PATH override/)
      }

      // Abort while validateShellAgainstGrant awaits realpath/lstat throws ShellGuardError('aborted') cleanly without ReferenceError or spawned child
      const ac = new AbortController()
      let spawned = false
      await expect(executeShellGuardedAction({
        grantDestination: realGrant,
        requestDestination: { classification: 'shell-command', executable: process.execPath, cwd: safeCwd },
        payload: { executable: process.execPath, args: ['-e', 'console.log(1)'], cwd: safeCwd, timeoutMs: 1_000 },
        remainingLeaseMs: 1_000,
        signal: ac.signal,
        deps: {
          realpath: async (p: string) => {
            ac.abort()
            return p
          },
          lstat: async (p: string) => ({
            isDirectory: () => p === safeCwd,
            isFile: () => p === process.execPath,
            isSymbolicLink: () => false,
          }),
          spawnImpl: (() => {
            spawned = true
            throw new Error('spawn should not run after pre-spawn abort')
          }) as never,
        },
      })).rejects.toMatchObject({ name: 'ShellGuardError', code: 'aborted' })
      expect(spawned).toBe(false)
    })
  })
})
