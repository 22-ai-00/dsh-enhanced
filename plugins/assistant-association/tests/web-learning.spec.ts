import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { normalizeAssociationWebLearningConfig } from '../src/config.js'
import { extractEntities } from '../src/entities.js'
import { AssociationStore, openAssociationDatabase } from '../src/sqlite.js'
import { tokenizeAssociationText } from '../src/tokenize.js'
import {
  computeOwnerScopeKey,
  computePrincipalDigest,
  WEB_LEARNING_SOURCE_PLUGIN,
  type AssociationOwnerScope,
  type UpsertNodeInput,
} from '../src/types.js'
import { createInProcessWebLearningRunner, type WebLearningRunner } from '../src/web-learning-runner.js'
import {
  extractWebLearningInterests,
  sanitizeInterestToken,
  scrubInterestText,
} from '../src/web-learning-interests.js'
import {
  buildWebLearningPolicyRequest,
  evaluateWebLearningGate,
  getWebLearningBudgetUsage,
  listWebLearningFetches,
  listWebLearningRuns,
  runWebLearningPass,
  withdrawWebSourceByUrl,
  type WebLearningDeliveryPeer,
  type WebLearningPolicyPeer,
} from '../src/web-learning.js'

const tempDirs: string[] = []
const stores: AssociationStore[] = []
const contexts: Context[] = []

function makeTempDir(prefix = 'assoc-web-learning-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function openTempStore(): { readonly dbPath: string; readonly store: AssociationStore } {
  const dir = makeTempDir()
  const dbPath = join(dir, 'assoc.sqlite')
  const store = new AssociationStore(openAssociationDatabase(dbPath))
  stores.push(store)
  return { dbPath, store }
}

afterEach(async () => {
  while (stores.length > 0) {
    const store = stores.pop()!
    try {
      store.close()
    } catch {
      // Ignore if test already closed store (e.g. restart persistence test).
    }
  }
  while (contexts.length > 0) {
    const ctx = contexts.pop()!
    await ctx.fiber.dispose()
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeScope(label = 'owner-web'): AssociationOwnerScope {
  const principalId = `principal:${label}-secret-99`
  const principalDigest = computePrincipalDigest(principalId)
  const principalRecordId = `pr-${label}`
  const principalVersion = 1
  const workspace = `/Users/alice/private-ws-${label}`
  const agentPreset = 'primary'
  return {
    mode: 'delivery',
    ownerScopeKey: computeOwnerScopeKey({
      mode: 'delivery',
      principalDigest,
      principalRecordId,
      principalVersion,
      workspace,
      agentPreset,
    }),
    principalId,
    principalDigest,
    principalRecordId,
    principalVersion,
    workspace,
    agentPreset,
    authorityId: `auth-${label}`,
  }
}

function seedNode(
  store: AssociationStore,
  scope: AssociationOwnerScope,
  input: {
    readonly id: string
    readonly kind: UpsertNodeInput['kind']
    readonly title: string
    readonly body: string
    readonly sensitivity?: 'private' | 'sensitive'
    readonly trust?: 'trusted' | 'low'
    readonly entities?: readonly string[]
    readonly sourceRef?: string
    readonly updatedAt?: number
  },
): void {
  const now = input.updatedAt ?? 1_700_000_000_000
  const combined = `${input.title}\n${input.body}`
  store.upsertBatch({
    nodes: [
      {
        id: input.id,
        kind: input.kind,
        sourcePlugin: `test:${input.kind}`,
        sourceRef: input.sourceRef ?? input.id,
        sourceVersion: 1,
        ownerScopeKey: scope.ownerScopeKey,
        ownerMode: scope.mode,
        principalDigest: scope.principalDigest,
        principalRecordId: scope.mode === 'delivery' ? scope.principalRecordId : null,
        principalVersion: scope.mode === 'delivery' ? scope.principalVersion : null,
        scopeMode: 'workspace',
        workspace: scope.workspace,
        agentPreset: scope.agentPreset,
        trust: input.trust ?? 'trusted',
        sensitivity: input.sensitivity ?? 'private',
        title: input.title,
        body: input.body,
        entities: input.entities ? [...input.entities] : extractEntities(combined),
        tokens: tokenizeAssociationText(combined),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ],
    edges: [],
    derivedRefs: [],
  })
}

async function createRealPolicyService(
  rules: NonNullable<ConstructorParameters<typeof AssistantPolicyService>[1]['rules']>,
  budgets?: ConstructorParameters<typeof AssistantPolicyService>[1]['budgets'],
): Promise<AssistantPolicyService> {
  const dir = makeTempDir('assoc-policy-test-')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(dir, 'policy.sqlite'),
    rules,
    ...(budgets !== undefined ? { budgets } : {}),
  })
  return ctx.get('assistantPolicy') as AssistantPolicyService
}

function makeAllowPolicyPeer(): {
  readonly policy: WebLearningPolicyPeer
  readonly authorizeCalls: number[]
  readonly evaluateCalls: number[]
} {
  const authorizeCalls: number[] = []
  const evaluateCalls: number[] = []
  return {
    authorizeCalls,
    evaluateCalls,
    policy: {
      getEmergencyStop: () => ({ enabled: false }),
      evaluate: () => {
        evaluateCalls.push(Date.now())
        return { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-web-learn' }
      },
      authorize: (_req, opts) => {
        expect(typeof opts?.idempotencyKey).toBe('string')
        expect(opts?.idempotencyKey?.trim().length).toBeGreaterThan(0)
        authorizeCalls.push(Date.now())
        return { effect: 'allow', reasonCode: 'rule-allow', ruleId: 'allow-web-learn' }
      },
    },
  }
}

describe('web-learning-interests (T-S4-09)', () => {
  test('sanitizeInterestToken blocks paths, secrets, PII, IPs, URLs, UUIDs, and scope identifiers', () => {
    const scope = makeScope('scrub')
    const rejected = [
      '/Users/alice/work/secret.ts',
      'C:\\Users\\alice\\config.env',
      '~/id_rsa',
      'state.sqlite',
      'local.env',
      'tls.pem',
      'signing.key',
      '.env',
      'alice@example.com',
      '127.0.0.1',
      '192.168.1.5',
      '::1',
      '2001:db8::1',
      'https://docs.example.com/a',
      '550e8400-e29b-41d4-a716-446655440000',
      'sk-proj-1234567890abcdef',
      'pk-live-1234567890abcdef',
      'ghp_1234567890abcdef1234',
      'xoxb-123456-789012-abcdef',
      'bearer',
      'token',
      'secret',
      'password',
      'api_key',
      'my_api_key',
      '0123456789abcdef0123',
      'dGhpcyBpcyBhIHNlY3JldA',
      'dGhpcyBpcyBhIHNlY3JldA==',
      scope.principalId,
      'scrub-secret-99',
      `private-ws-scrub`,
    ]
    for (const token of rejected) {
      expect(sanitizeInterestToken(token, scope), `expected rejection for ${token}`).toBeNull()
    }

    expect(sanitizeInterestToken('TypeScript', scope)).toBe('typescript')
    expect(sanitizeInterestToken('vitest', scope)).toBe('vitest')
    expect(sanitizeInterestToken('Node.js', scope)).toBe('node.js')
    expect(sanitizeInterestToken('react-router', scope)).toBe('react-router')
    expect(sanitizeInterestToken('异步关联', scope)).toBe('异步关联')
  })

  test('extracts prioritized interests from goal/work-item/dream/signals/low-coverage while excluding sensitive, holdout, and scrubbed leaks', () => {
    const { store } = openTempStore()
    const scope = makeScope('interests')
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0)

    // Sensitive goal must NEVER be extracted
    seedNode(store, scope, {
      id: 'a:g-sensitive',
      kind: 'goal',
      sensitivity: 'sensitive',
      title: 'Private payroll cryptography audit',
      body: 'quantum-payroll-secret-topic',
      updatedAt: nowMs - 10,
    })

    // Private goal with embedded path/email/secret/principalId -> only clean technical tokens survive
    seedNode(store, scope, {
      id: 'a:g-1',
      kind: 'goal',
      title: `Learn TypeScript generics at /Users/alice/secret-vault/.env for ${scope.principalId}`,
      body: 'Check sk-proj-1234567890abcdef and alice@corp.example.com and 10.0.0.5 with vitest',
      updatedAt: nowMs - 100,
    })

    // Work item (priority 1.0)
    seedNode(store, scope, {
      id: 'a:w-1',
      kind: 'work-item',
      title: 'Harden SQLite WAL checkpointing',
      body: 'Investigate sqlite busy timeout patterns',
      updatedAt: nowMs - 200,
    })

    // Dream node (priority 0.85)
    seedNode(store, scope, {
      id: 'a:dr-1',
      kind: 'dream',
      title: 'Synthesize Cordis fiber lifecycle',
      body: 'Inspect cordis disposer ordering',
      updatedAt: nowMs - 300,
    })

    // Holdout episode + step metric (MUST BE EXCLUDED)
    seedNode(store, scope, {
      id: 'a:e-holdout',
      kind: 'episode',
      sourceRef: 'task-holdout-1',
      title: 'HoldoutOnlyTopic webpack optimization',
      body: 'holdoutonlytopic',
      updatedAt: nowMs - 50,
    })
    store.recordHoldoutAssignment({
      taskId: 'task-holdout-1',
      ownerScopeKey: scope.ownerScopeKey,
      taskKind: 'foreground-turn',
      sessionId: 'sess-h',
      turnNumber: 1,
      inHoldout: true,
      bucketBps: 500,
      rateBps: 1250,
      hmacDigest: 'a'.repeat(64),
      assignedAt: nowMs - 50,
    })
    store.recordMetricsAndExposures(
      [
        {
          taskId: 'task-holdout-1',
          ownerScopeKey: scope.ownerScopeKey,
          inHoldout: true,
          latencyUs: 100,
          timedOut: false,
          fallbackMode: 'holdout',
          injectedCount: 0,
          candidateCount: 0,
          sourceCounts: {},
          occurredAt: nowMs - 50,
        },
        {
          taskId: 'task-lowcov-1',
          ownerScopeKey: scope.ownerScopeKey,
          inHoldout: false,
          latencyUs: 150,
          timedOut: false,
          fallbackMode: 'cold-start',
          injectedCount: 0,
          candidateCount: 1,
          sourceCounts: {},
          occurredAt: nowMs - 150,
        },
      ],
      [],
    )
    store.upsertReplayEpisode({
      taskId: 'task-lowcov-1',
      ownerScopeKey: scope.ownerScopeKey,
      inHoldout: false,
      cues: [{ kind: 'user', text: 'oxlint configuration rules', weight: 1.0 }],
      occurredAt: nowMs - 150,
    })

    // Implicit re-ask signal (priority 1.1) for non-holdout episode, plus another signal referencing holdout task (excluded)
    seedNode(store, scope, {
      id: 'a:e-reask',
      kind: 'episode',
      sourceRef: 'task-reask-1',
      title: 'Troubleshooting playwright selectors',
      body: 'Repeated playwright locator retries',
      updatedAt: nowMs - 120,
    })
    store.database
      .prepare(`
        INSERT INTO assoc_implicit_signals (
          signal_id, owner_scope_key, cluster_id, kind, trust, candidate_only, report_only, evidence_json, created_at
        ) VALUES (?, ?, ?, 're-ask', 'low', 1, 1, ?, ?)
      `)
      .run(
        'sig-non-holdout',
        scope.ownerScopeKey,
        'cluster-1',
        JSON.stringify({ taskIds: ['task-reask-1'] }),
        nowMs - 120,
      )
    store.database
      .prepare(`
        INSERT INTO assoc_implicit_signals (
          signal_id, owner_scope_key, cluster_id, kind, trust, candidate_only, report_only, evidence_json, created_at
        ) VALUES (?, ?, ?, 'redo', 'low', 1, 1, ?, ?)
      `)
      .run(
        'sig-holdout',
        scope.ownerScopeKey,
        'cluster-holdout',
        JSON.stringify({ taskIds: ['task-holdout-1'], entities: ['holdoutsignalentity'] }),
        nowMs - 40,
      )

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: [
        'https://docs.example.com/search?q={query}',
        'https://unlisted.example.org/search?q={query}',
      ],
      maxInterestsPerRun: 10,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const joinedQueries = res.interests.map((i) => i.query).join(' | ')

    expect(joinedQueries).not.toContain('quantum-payroll')
    expect(joinedQueries).not.toContain('holdoutonlytopic')
    expect(joinedQueries).not.toContain('holdoutsignalentity')
    expect(joinedQueries).not.toContain('secret-vault')
    expect(joinedQueries).not.toContain('sk-proj')
    expect(joinedQueries).not.toContain('alice')
    expect(joinedQueries).not.toContain(scope.principalId)
    expect(joinedQueries).toContain('typescript')
    expect(joinedQueries).toContain('playwright')
    expect(joinedQueries).toContain('sqlite')
    expect(joinedQueries).toContain('oxlint')
    expect(joinedQueries).toContain('cordis')

    // Priority ordering: goal (1.2) -> implicit-signal (1.1) -> work-item (1.0) -> low-coverage (0.9) -> dream (0.85)
    expect(res.interests.map((i) => i.sourceKind)).toEqual([
      'goal',
      'implicit-signal',
      'work-item',
      'low-coverage',
      'dream',
    ])

    // Token & length caps
    for (const interest of res.interests) {
      expect(interest.tokens.length).toBeLessThanOrEqual(3)
      expect(interest.query.length).toBeLessThanOrEqual(64)
    }

    // Unlisted seed URL rejected before building plan; only whitelisted targets emitted
    expect(res.rejectedSeedUrls.length).toBeGreaterThan(0)
    expect(res.targets.every((t) => t.url.startsWith('https://docs.example.com/search?q='))).toBe(true)

    // Cooldown deduplication against assoc_web_learning_fetches
    const firstTarget = res.targets[0]!
    store.database
      .prepare(`
        INSERT INTO assoc_web_learning_fetches (
          fetch_id, owner_scope_key, run_id, canonical_url, domain, interest_key, status, bytes_fetched, node_id, fetched_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ok', 128, NULL, ?, NULL)
      `)
      .run(
        'fetch-prev-1',
        scope.ownerScopeKey,
        'run-prev',
        firstTarget.url,
        'docs.example.com',
        firstTarget.interestKey,
        nowMs - 1_000,
      )

    const deduped = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    expect(deduped.skippedCooldownCount).toBe(1)
    expect(deduped.targets.some((t) => t.url === firstTarget.url)).toBe(false)
  })

  test('scrubs special-char & short-token credentials without JSON spillover while preserving prose topics', () => {
    const { store } = openTempStore()
    const scope = makeScope('scrub-special')
    const nowMs = Date.UTC(2026, 10, 20, 12, 30, 0)

    const secretPayload = [
      'password="P@ssw0rd!2024"',
      'JWT_SECRET=sec$ret!1234',
      "API_KEY='key*val#9911'",
      '{"password":"myPass!word99","topic":"debug"}',
      'DATABASE_PASSWORD=abcd!efgh1234',
      'PASSWORD=p@ss$word123',
      'Authorization: Bearer abc',
      'Authorization: "Bearer quotedTok"',
      'token mysecret123',
    ].join(' ')

    const scrubbed = scrubInterestText(secretPayload, scope).toLowerCase()
    for (const leaked of [
      'ssw0rd',
      '2024',
      'sec',
      'ret',
      '1234',
      'key',
      'val',
      '9911',
      'word99',
      'efgh1234',
      'word123',
      'abc',
      'quotedtok',
      'mysecret123',
    ]) {
      expect(scrubbed, `expected scrubInterestText to remove ${leaked}`).not.toContain(leaked)
    }
    expect(scrubbed).toContain('"topic":"debug"')

    seedNode(store, scope, {
      id: 'a:g-special-1',
      kind: 'goal',
      title: 'Token bucket algorithm',
      body: secretPayload,
      updatedAt: nowMs - 10,
    })
    seedNode(store, scope, {
      id: 'a:g-fp-1',
      kind: 'work-item',
      title: 'Basic TypeScript guide',
      body: 'API design patterns',
      updatedAt: nowMs - 20,
    })
    seedNode(store, scope, {
      id: 'a:g-fp-2',
      kind: 'dream',
      title: 'OAuth PKCE flow',
      body: 'Digest authentication RFC',
      updatedAt: nowMs - 30,
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 10,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const serialized = JSON.stringify({
      queries: res.interests.map((i) => ({ query: i.query, tokens: i.tokens })),
      urls: res.targets.map((t) => t.url),
    }).toLowerCase()
    for (const leaked of [
      'ssw0rd',
      '2024',
      'sec',
      'ret',
      '1234',
      'key',
      'val',
      '9911',
      'word99',
      'efgh1234',
      'word123',
      'abc',
      'quotedtok',
      'mysecret123',
    ]) {
      expect(serialized, `expected ${leaked} to be scrubbed from interests/targets`).not.toContain(leaked)
    }

    const tokenBucketInterest = res.interests.find((i) => i.originNodeIds.includes('a:g-special-1'))
    expect(tokenBucketInterest).toBeDefined()
    expect(tokenBucketInterest!.tokens).toEqual(['bucket', 'algorithm', 'topic'])

    const fp1 = res.interests.find((i) => i.originNodeIds.includes('a:g-fp-1'))
    expect(fp1?.tokens).toEqual(['api', 'basic', 'typescript'])

    const fp2 = res.interests.find((i) => i.originNodeIds.includes('a:g-fp-2'))
    expect(fp2?.tokens).toEqual(['pkce', 'rfc', 'oauth'])

    // Verify API design patterns, Basic TypeScript guide, OAuth PKCE flow, Digest authentication RFC,
    // and Token bucket algorithm are not stripped by scrubInterestText
    expect(scrubInterestText('Basic TypeScript guide and API design patterns', scope)).toBe(
      'Basic TypeScript guide and API design patterns',
    )
    expect(scrubInterestText('OAuth PKCE flow and Digest authentication RFC', scope)).toBe(
      'OAuth PKCE flow and Digest authentication RFC',
    )
    expect(scrubInterestText('Token bucket algorithm', scope)).toBe('Token bucket algorithm')
  })

  test('scrubs suffixed credential keys and multiline or unclosed quoted values without leaking', () => {
    const { store } = openTempStore()
    const scope = makeScope('scrub-suffix-multiline')
    const nowMs = Date.UTC(2026, 10, 20, 12, 45, 0)

    const suffixedAndMultilinePayload = [
      'DB_PASSWORD_PROD=prodPass123',
      'API_KEY_V2=myKey991',
      'SECRET_SALT=saltVal99',
      'X_AUTH_TOKEN_HEADER=tokVal123',
      'PROXY_AUTHORIZATION=Basic dXNlcjpwYXNz',
      'X_AUTHORIZATION_HEADER: Bearer authTok77',
      'password="firstLine99\nsecondLine88" debug',
      'private_key="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA12345" debug',
      'version=1.2.3',
      '{"password":"myPass!word99","topic":"debug"}',
    ].join(' ')

    const scrubbed = scrubInterestText(suffixedAndMultilinePayload, scope).toLowerCase()
    for (const leaked of [
      'prodpass123',
      'mykey991',
      'saltval99',
      'tokval123',
      'dxnlcjpwyxnz',
      'authtok77',
      'firstline99',
      'secondline88',
      'miieowibaakcaqea12345',
      'mypass',
      'word99',
    ]) {
      expect(scrubbed, `expected scrubInterestText to remove ${leaked}`).not.toContain(leaked)
    }
    expect(scrubbed).toContain('version=1.2.3')
    expect(scrubbed).toContain('"topic":"debug"')
    expect(scrubbed).toContain('debug')

    // Unclosed quoted secret on a line must scrub to end of line without eating subsequent lines
    expect(scrubInterestText('password="unclosedSecret99 debug', scope)).toBe(' ')
    expect(scrubInterestText('password="unclosedSecret99\ntopic: kubernetes', scope)).toBe(
      ' \ntopic: kubernetes',
    )

    seedNode(store, scope, {
      id: 'a:g-suffix-multiline',
      kind: 'goal',
      title: 'Token bucket algorithm',
      body: suffixedAndMultilinePayload,
      updatedAt: nowMs - 10,
    })
    seedNode(store, scope, {
      id: 'a:g-unclosed-nextline',
      kind: 'work-item',
      title: 'Helm',
      body: 'password="unclosedSecret99\ntopic: kubernetes',
      updatedAt: nowMs - 20,
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 5,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const serialized = JSON.stringify({
      queries: res.interests.map((i) => ({ query: i.query, tokens: i.tokens })),
      urls: res.targets.map((t) => t.url),
    }).toLowerCase()
    for (const leaked of [
      'prodpass123',
      'mykey991',
      'saltval99',
      'tokval123',
      'dxnlcjpwyxnz',
      'authtok77',
      'firstline99',
      'secondline88',
      'miieowibaakcaqea12345',
      'unclosedsecret99',
    ]) {
      expect(serialized, `expected ${leaked} to be scrubbed from interests/targets`).not.toContain(leaked)
    }
    expect(serialized).toContain('kubernetes')
    expect(serialized).toContain('bucket')
  })

  test('scrubs cross-line unclosed quotes, quoted URLs, non-Auth schemes, session/cookie keys, arrays, and subscript/:=/== assignments', () => {
    const { store } = openTempStore()
    const scope = makeScope('scrub-iter5')
    const nowMs = Date.UTC(2026, 10, 20, 12, 55, 0)

    const crossLinePayloads = [
      'password="unclosedSecret99\nAPI_KEY="closedSecret123" debug',
      "password='unclosedSecret99\nAPI_KEY='closedSecret123' debug",
      '{"password":"unclosed,\n"api_key":"secret123"}',
      'password="unclosed1\napi_key="realSecret99\nsecondSecret88" debug',
      'token "unclosed1\ntoken "realSecret99" debug',
      'password="x0leak\npassword="x1leak\npassword="x2leak\npassword="x3leak',
      'password="https://user:sec99@host" api_key="realSecret99" debug',
      'password="unclosed1\napi_key="firstLine99\nsecondLine88" debug',
      'X_AUTH_TOKEN: Bearer tokVal991 debug',
      'API_KEY: Bearer tokVal991 debug',
      'ACCESS_TOKEN: Bearer tokVal991 debug',
      'CLIENT_SECRET: Basic dXNlcjpwYXNz debug',
      'Authorization: Bearer: tokVal991 debug',
      'session_id=sessVal99123 debug',
      'COOKIE=sessVal99123 debug',
      'X_SESSION_ID=sessVal99123 debug',
      'secrets: ["secVal111", "secVal222"] debug',
      'tokens=[tokVal111, tokVal222] debug',
      'secrets=["unclosedArr1\napi_key="realSecret99" debug',
      "env['API_KEY']=\"mySecret99\" debug",
      'config["password"]="mySecret99" debug',
      'password:="mySecret99" debug',
      'password=="mySecret99" debug',
    ]

    for (const payload of crossLinePayloads) {
      const scrubbed = scrubInterestText(payload, scope).toLowerCase()
      for (const leaked of [
        'unclosedsecret99',
        'closedsecret123',
        'secret123',
        'unclosed1',
        'realsecret99',
        'secondsecret88',
        'x0leak',
        'x1leak',
        'x2leak',
        'x3leak',
        'sec99',
        'firstline99',
        'secondline88',
        'tokval991',
        'dxnlcjpwyxnz',
        'sessval99123',
        'secval111',
        'secval222',
        'tokval111',
        'tokval222',
        'unclosedarr1',
        'mysecret99',
      ]) {
        expect(scrubbed, `expected ${payload} to scrub ${leaked}`).not.toContain(leaked)
      }
      if (payload.includes('debug')) {
        expect(scrubbed, `expected ${payload} to preserve debug`).toContain('debug')
      }
    }

    const jsonArrayScrubbed = scrubInterestText(
      '{"secrets": ["secVal111", "secVal222"], "topic": "rust"}',
      scope,
    )
    expect(jsonArrayScrubbed.toLowerCase()).not.toContain('secval111')
    expect(jsonArrayScrubbed.toLowerCase()).not.toContain('secval222')
    expect(jsonArrayScrubbed).toContain('"topic": "rust"')

    expect(scrubInterestText('Cookie parser guide', scope)).toBe('Cookie parser guide')

    // Truncated title with unclosed quote must NOT pair across \n with body in extractWebLearningInterests
    seedNode(store, scope, {
      id: 'a:g-trunc-title',
      kind: 'goal',
      title: 'Fix password="myUnclosedSecret99',
      body: 'Fix password="myUnclosedSecret99" in staging config',
      updatedAt: nowMs - 10,
    })
    seedNode(store, scope, {
      id: 'a:g-json-arr',
      kind: 'work-item',
      title: 'Cargo',
      body: '{"secrets": ["secVal111", "secVal222"], "topic": "rust"}',
      updatedAt: nowMs - 20,
    })
    seedNode(store, scope, {
      id: 'a:g-cookie-prose',
      kind: 'dream',
      title: 'Cookie parser guide',
      body: 'session_id=sessVal99123 X_AUTH_TOKEN: Bearer tokVal991 Authorization: Bearer: tokVal991',
      updatedAt: nowMs - 30,
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 10,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const serialized = JSON.stringify({
      queries: res.interests.map((i) => ({ query: i.query, tokens: i.tokens })),
      urls: res.targets.map((t) => t.url),
    }).toLowerCase()

    for (const leaked of [
      'myunclosedsecret99',
      'secval111',
      'secval222',
      'sessval99123',
      'tokval991',
    ]) {
      expect(serialized, `expected ${leaked} to be scrubbed from interests/targets`).not.toContain(leaked)
    }
    expect(serialized).toContain('staging')
    expect(serialized).toContain('rust')
    expect(serialized).toContain('parser')
  })

  test('scrubInterestText executes in linear time on adversarial dotted, dashed, underscored, and unclosed inputs', () => {
    const scope = makeScope('redos')
    const cases: Array<{
      readonly name: string
      readonly payload: string
      readonly expectedExactLength?: boolean
      readonly expectNoLongA?: boolean
    }> = [
      { name: 'a.', payload: 'a.'.repeat(10_000), expectedExactLength: true },
      { name: 'a-', payload: 'a-'.repeat(10_000), expectedExactLength: true },
      { name: 'a_', payload: 'a_'.repeat(10_000), expectedExactLength: true },
      { name: 'token-repeat-eq', payload: `${'token'.repeat(5_000)}= ` },
      { name: 'unclosed-a', payload: `password="${'a'.repeat(20_000)}`, expectNoLongA: true },
      { name: 'unclosed-escaped', payload: `password="${'\\a'.repeat(10_000)}`, expectNoLongA: true },
      { name: 'many-unclosed-5k-lines', payload: 'password="x0leak\n'.repeat(4_500) },
      { name: 'space-token-5k', payload: 'token '.repeat(5_000), expectedExactLength: true },
      { name: 'closed-kv-4k', payload: 'token="abc" '.repeat(2_000) },
      { name: 'auth-colon-5k', payload: 'authorization: '.repeat(5_000) },
      { name: 'auth-quote-5k', payload: `${'Authorization "x '.repeat(5_000)}${'a'.repeat(5_000)}`, expectedExactLength: true },
      { name: 'unclosed-bracket-25k', payload: `secrets=[${'a'.repeat(25_000)}`, expectNoLongA: true },
      { name: 'many-unclosed-bracket-10k-assign', payload: `${'x secrets=[\n'.repeat(10_000)}API_KEY=1` },
      { name: 'many-unclosed-brace-10k-assign', payload: `${'x credentials={\n'.repeat(10_000)}API_KEY=1` },
      { name: 'many-unclosed-bracket-10k-eof', payload: `${'x secrets=[\n'.repeat(10_000)}plain` },
      { name: 'nested-bracket-brace-5k', payload: `${'secrets=[{\n'.repeat(5_000)}API_KEY=1` },
      { name: 'alternating-unclosed-10k', payload: `${'secrets=[\ncredentials={\n'.repeat(5_000)}plain` },
      { name: 'unclosed-pem-quote-10k', payload: `password="-----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEA1234567890ABCD\n'.repeat(10_000)}` },
      { name: 'unclosed-pem-unquoted-10k', payload: `private_key: -----BEGIN RSA PRIVATE KEY-----\n${'MIIEowIBAAKCAQEA1234567890ABCD\n'.repeat(10_000)}` },
      { name: 'export-const-repeat-10k', payload: `${'export const '.repeat(10_000)}foo` },
      { name: 'yaml-pipe-10k', payload: `private_key: |\n${'  secretline12345\n'.repeat(10_000)}debug` },
      { name: 'many-cookie-semi-10k', payload: `Cookie: ${'a=123; '.repeat(10_000)}debug` },
      { name: 'brace-indented-key-10k-assign', payload: `${'x credentials={\n  "api_key": "1",\n'.repeat(5_000)}API_KEY=1` },
      { name: 'brace-no-comma-props-10k', payload: `secrets={\n${'  token: "sec1"\n'.repeat(10_000)}API_KEY=1` },
      { name: 'nested-arr-obj-5k', payload: `${'secrets=[{\n  "api_key": "1",\n'.repeat(5_000)}API_KEY=1` },
      { name: 'brace-col0-props-10k', payload: `secrets={\n${'token: "sec1",\n'.repeat(10_000)}API_KEY=1` },
      { name: 'many-cookie-bare-flags-10k', payload: `Cookie: a=1; ${'FlagX; '.repeat(10_000)}plain` },
      { name: 'many-auth-space-kv-10k', payload: `Authorization: Bearer ${'k=1 '.repeat(10_000)}debug` },
      { name: 'yaml-list-10k', payload: `api_key:\n${'  - secVal111\n'.repeat(10_000)}debug` },
      { name: 'brace-col0-nocomma-10k', payload: `secrets={\n${'pass: sec1\n'.repeat(10_000)}API_KEY=1` },
      { name: 'unclosed-col0-nocomma-repeat-5k', payload: `${'credentials={\npass: 1\n'.repeat(5_000)}API_KEY=1` },
      { name: 'many-cookie-folded-semi-10k', payload: `Cookie: a=1${';\n  b=2'.repeat(10_000)} debug` },
      { name: 'yaml-nested-map-10k', payload: `credentials:\n${'  pass: secVal111\n'.repeat(10_000)}debug` },
      { name: 'many-block-comments-10k', payload: `secrets=[\n${'  "a", /* c */\n'.repeat(10_000)}] debug` },
      { name: 'unclosed-block-comment-open-10k', payload: `${'x secrets=[ /*\n'.repeat(10_000)}plain` },
      { name: 'yaml-comment-repeat-10k', payload: `${'api_key:\n# api_key:\n'.repeat(5_000)}plain` },
      { name: 'yaml-trailing-comment-10k', payload: `api_key:\n  - secVal111\n${'# api_key:\n'.repeat(10_000)}` },
      { name: 'url-semi-repeat-10k', payload: `https://a${';'.repeat(10_000)}api_key=1` },
      { name: 'url-long-seg-100k', payload: `https://example.com/;${'a'.repeat(100_000)}!` },
      { name: 'many-cookie-bare-flags-folded-10k', payload: `Cookie: a=1; ${'FlagX; '.repeat(10_000)}FlagZ\n  csrf="sec1" debug` },
      { name: 'many-cookie-folded-flags-fail-10k', payload: `Cookie: a=1; ${'FlagX\n  '.repeat(10_000)}plain` },
      { name: 'col0-block-comments-10k', payload: `credentials={\n${'/* start */ // x\n'.repeat(10_000)}pass: secVal\n} debug` },
      { name: 'yaml-slash-comment-repeat-10k', payload: `${'api_key:\n// api_key:\n'.repeat(5_000)}plain` },
      { name: 'yaml-block-comment-repeat-10k', payload: `${'api_key:\n/* api_key: */\n'.repeat(5_000)}plain` },
      { name: 'yaml-nested-open-block-comment-10k', payload: `${'api_key: /*\n'.repeat(5_000)}*/\nplain` },
      { name: 'yaml-unclosed-open-block-comment-10k', payload: `${'api_key: /*\n'.repeat(5_000)}plain` },
      { name: 'many-cookie-folded-comments-10k', payload: `Cookie: a=1;\n${'  # comment\n'.repeat(10_000)}plain` },
      { name: 'many-cookie-folded-cookie-comments-10k', payload: `Cookie: a=1;\n${'  # Cookie: b=2;\n'.repeat(10_000)}plain` },
      { name: 'yaml-mid-block-map-10k', payload: `credentials:\n  pass: 1\n${'  /* mid */\n'.repeat(10_000)}plain` },
      { name: 'yaml-open-block-in-entry-5k', payload: `${'credentials:\n  pass: /*\n'.repeat(5_000)}plain` },
      { name: 'subscript-dot-chain-10k', payload: `env${'[0].x'.repeat(10_000)}=1` },
      { name: 'auth-quote-nl-10k', payload: `Authorization: "Bearer\n${'  foo=1\n'.repeat(5_000)}plain` },
      { name: 'len350k', payload: 'hello world token debug '.repeat(14_550) },
    ]
    for (const testCase of cases) {
      scrubInterestText(testCase.payload.slice(0, 256), scope)
    }
    for (const testCase of cases) {
      const startedAt = performance.now()
      const out = scrubInterestText(testCase.payload, scope)
      const elapsedMs = performance.now() - startedAt
      if (testCase.expectedExactLength) {
        expect(out.length).toBe(testCase.payload.length)
      }
      if (testCase.expectNoLongA) {
        expect(out).not.toContain('aaaaaa')
      }
      expect(elapsedMs, `ReDoS guard failed for ${testCase.name} (${elapsedMs.toFixed(2)}ms)`).toBeLessThan(250)
    }
  })

  test('scrubs multiline/unclosed delimiters, brace values, quoted paths, pre-stripped assignments, prefixed/inline cross-line quotes, multi-pair Cookie headers, unquoted PEMs, and expanded Auth schemes', () => {
    const { store } = openTempStore()
    const scope = makeScope('scrub-iter6')
    const nowMs = Date.UTC(2026, 10, 20, 13, 15, 0)

    const payloads = [
      'secrets=[\n  "secVal111",\n  api_key="realSecret99" debug',
      'secrets=["unclosed1\n"secVal222"] debug',
      'credentials={tokVal991, tokVal992} debug',
      'credentials={"pass":"myPass99"} debug',
      'password="/var/secrets/key" api_key="realSecret99" debug',
      'password="/etc/passwd" api_key="realSecret99" debug',
      "token='/etc/passwd' secret='realSecret99' debug",
      'password="./secret.txt" api_key="realSecret99" debug',
      'password="~/secret" api_key="realSecret99" debug',
      'password=https://user:sec99@host api_key="realSecret99" debug',
      'password=10.0.0.1 api_key="realSecret99" debug',
      'password=admin@example.com api_key="realSecret99" debug',
      'password=sk-abc123456 api_key="realSecret99" debug',
      'password= api_key="realSecret99" debug',
      'password="unclosed1\napi_key=" realSecret99" debug',
      '{"password":"unclosed,\n"api_key":" secret123"}',
      'password="unclosed1\nAPI_KEY="\trealSecret99" debug',
      'password="unclosed1\nexport API_KEY="realSecret99" debug',
      'password="unclosed1\n- api_key: "realSecret99"\ndebug',
      'password="unclosed1\nconst api_key = "realSecret99" debug',
      '{"password": "unclosed1\n,"api_key": "realSecret99"}',
      'password="unclosed1\ndebug api_key="realSecret99" topic',
      'Cookie: sid=abc12345; csrf=xyz78901',
      'Cookie: a=secVal111; b=secVal222',
      'Set-Cookie: sid=abc12345; Expires=Wed, 21 Oct 2015 07:28:00 GMT; csrf=xyz78901',
      'private_key: -----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2Vw\n-----END PRIVATE KEY----- debug',
      'Authorization: Negotiate YIIFsecret99 debug',
      'Authorization: HOBA hobaSecret99 debug',
      'Authorization: DPoP dpopSecret99 debug',
      'Authorization: SCRAM-SHA-256 scramSecret99 debug',
    ]

    for (const payload of payloads) {
      const scrubbed = scrubInterestText(payload, scope).toLowerCase()
      for (const leaked of [
        'secval111',
        'secval222',
        'realsecret99',
        'tokval991',
        'tokval992',
        'mypass99',
        'sec99',
        'secret123',
        'abc12345',
        'xyz78901',
        'mc4caqawbqydk2vw',
        'begin private key',
        'end private key',
        'yiifsecret99',
        'hobasecret99',
        'dpopsecret99',
        'scramsecret99',
      ]) {
        expect(scrubbed, `expected ${payload} to scrub ${leaked}`).not.toContain(leaked)
      }
      if (payload.includes('debug')) {
        expect(scrubbed, `expected ${payload} to preserve debug`).toContain('debug')
      }
    }

    // Empty password= before non-secret quoted topic must preserve topic="debug"
    expect(scrubInterestText('password= topic="debug"', scope)).toBe(' topic="debug"')
    // Base64 == padding must still be scrubbed (not mistaken for an assignment)
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    // Multiline closed array after an unclosed array must still scrub all array elements
    const multiArr = scrubInterestText('secrets=[unclosed\nsecrets=[\n  "secVal111",\n  "secVal222"\n] debug', scope).toLowerCase()
    expect(multiArr).not.toContain('secval111')
    expect(multiArr).not.toContain('secval222')
    expect(multiArr).toContain('debug')
    // Multiline closed string inside array with closing quote on line 2
    expect(scrubInterestText('secrets=["line1\n"] debug', scope)).toBe('  debug')
    // Prose preservation
    expect(scrubInterestText('Basic TypeScript guide', scope)).toBe('Basic TypeScript guide')
    expect(scrubInterestText('Digest authentication RFC', scope)).toBe('Digest authentication RFC')
    expect(scrubInterestText('OAuth PKCE flow', scope)).toBe('OAuth PKCE flow')
    expect(scrubInterestText('API design patterns', scope)).toBe('API design patterns')
    expect(scrubInterestText('Token bucket algorithm', scope)).toBe('Token bucket algorithm')
    expect(scrubInterestText('Cookie parser guide', scope)).toBe('Cookie parser guide')

    // End-to-end extractWebLearningInterests verification across payloads
    payloads.forEach((payload, idx) => {
      seedNode(store, scope, {
        id: `a:g-i6-${idx}`,
        kind: 'goal',
        title: `Cargo ${idx}`,
        body: payload,
        updatedAt: nowMs - idx,
      })
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 50,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const serialized = JSON.stringify({
      queries: res.interests.map((i) => ({ query: i.query, tokens: i.tokens })),
      urls: res.targets.map((t) => t.url),
    }).toLowerCase()

    for (const leaked of [
      'secval111',
      'secval222',
      'realsecret99',
      'tokval991',
      'tokval992',
      'mypass99',
      'secret123',
      'abc12345',
      'xyz78901',
      'mc4caqawbqydk2vw',
      'yiifsecret99',
      'hobasecret99',
      'dpopsecret99',
      'scramsecret99',
    ]) {
      expect(serialized, `expected ${leaked} to be scrubbed from outbound targets`).not.toContain(leaked)
    }
  })

  test('scrubs quoted/multi-pair Cookie headers, multi-param/custom Auth schemes, spaced ==, inline quoted JSON keys, mixed-quote/leading-comma/nested/truncated containers, YAML block scalars, and inline escaped quotes without breaking prose', () => {
    const { store } = openTempStore()
    const scope = makeScope('scrub-iter7')
    const nowMs = Date.UTC(2026, 10, 20, 13, 30, 0)

    const payloads = [
      // Cookie / Set-Cookie multi-pair, quoted, prose-boundary, header variants
      'Cookie: sid=abc12345; api_key="realSecret99" debug',
      'Cookie: sid=abc12345; token="realSecret99" debug',
      'Cookie: sid=abc12345; csrf="realSecret99" debug',
      'Set-Cookie: sid=abc12345; api_key="realSecret99" debug',
      'Cookie: sid=abc12345; csrf=xyz78901; api_key="realSecret99" debug',
      'Cookie: sid=abc12345; csrf="xyz78901" debug',
      'Cookie: sid="abc12345"; csrf="xyz78901" debug',
      "Cookie: sid=abc12345; csrf='xyz78901' debug",
      'Set-Cookie: sid=abc12345; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax; token="realSecret99" debug',
      'Cookie: sid=abc12345 debug note; api_key="realSecret99" topic',
      'Cookie-Header: sid=abc12345; csrf=realSecret99 debug',
      'Cookie sid=abc12345; csrf=realSecret99 debug',
      'Cookie sid=abc12345; api_key="realSecret99" debug',

      // Authorization / Auth Schemes (pre-stripped, empty, k=v, multi-param, custom)
      'Authorization: Bearer sk-abc123456 api_key="realSecret99" debug',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 api_key="realSecret99" debug',
      'Authorization: Bearer  api_key="realSecret99" debug',
      'Authorization: Negotiate sk-abc123456 api_key="realSecret99" debug',
      'Authorization: Bearer token="realSecret99" debug',
      'Authorization: Token api_key="realSecret99" debug',
      'Authorization: AWS4-HMAC-SHA256 Credential="myKey99", Signature="sigSecret99" debug',
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=mySigSecret99 debug',
      'Authorization: Digest username="alice", realm="test", nonce="dcd98b71", response="myDigestSecret99" debug',
      'Authorization: Digest response="realSecret99" debug',
      'Authorization: CustomScheme "realSecret99" debug',
      'Authorization: Bot "myBotSecret99" debug',
      'Authorization: CustomScheme api_key="realSecret99" debug',

      // Spaced ==, crossedLineHasKeyAssignment off-by-one, export const, PEM leading newline
      'password= token == realSecret99 debug',
      'password=10.0.0.1 api_key == realSecret99 debug',
      'password="unclosed1\n  foo "api_key": "realSecret99" debug',
      'password="unclosed1\n{ "api_key": "realSecret99" } debug',
      'password="unclosed1\n1. "api_key": "realSecret99" debug',
      'password="-----BEGIN RSA PRIVATE KEY-----\nexport const API_KEY="realSecret99" debug',
      'private_key="\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA12345\nexport API_KEY="realSecret99" debug',
      'private_key:\n-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA12345\n-----END PRIVATE KEY----- debug',

      // Multiline delimiters, mixed quotes, leading comma, otherDepth > 0, stray closer, EOF truncation, YAML |, escaped quote
      'secrets=["unclosed1\n,"secVal222"] debug',
      'secrets=["unclosed1\n, "secVal222"] debug',
      'secrets=["unclosed1\n  \'secVal222\'"] debug',
      'secrets=["line1\n\'line2 secVal222"] debug',
      'credentials={\n  "pass": "secVal222"\n} debug',
      'credentials={\n  "a": "unclosed1\n  "b": "secVal222"\n} debug',
      'secrets=[{\n  "secVal111",\n  api_key="realSecret99" debug',
      'credentials={\n  "secVal111", [\n  api_key="realSecret99" debug',
      'credentials={ foo] secVal999 } debug',
      'secrets=[\n  "secVal111",\n  "secVal222"\ndebug',
      'credentials={\n  "secVal111",\n  "secVal222"\ndebug',
      'private_key: |\n  realSecret99\n  moreSecret88\ndebug',
      'private_key: |-\n  realSecret99\n  moreSecret88\ndebug',
      'password="foo\\" api_key="realSecret99" debug',
      'password="foo\\" api_key=realSecret99 debug',
    ]

    for (const payload of payloads) {
      const scrubbed = scrubInterestText(payload, scope).toLowerCase()
      for (const leaked of [
        'abc12345',
        'xyz78901',
        'realsecret99',
        'moresecret88',
        'mykey99',
        'sigsecret99',
        'akiaiosfodnn7example',
        'aws4_request',
        'mysigsecret99',
        'alice',
        'dcd98b71',
        'mydigestsecret99',
        'mybotsecret99',
        'customscheme',
        'unclosed1',
        'secval111',
        'secval222',
        'secval999',
        'miieowibaakcaqea12345',
      ]) {
        expect(scrubbed, `expected ${payload} to scrub ${leaked}`).not.toContain(leaked)
      }
      if (payload.includes('debug')) {
        expect(scrubbed, `expected ${payload} to preserve debug`).toContain('debug')
      }
      if (payload.includes('topic')) {
        expect(scrubbed, `expected ${payload} to preserve topic`).toContain('topic')
      }
    }

    // Prose preservation inside Cookie: ... note; ... and standalone prose
    expect(scrubInterestText('Cookie: sid=abc12345 debug note; api_key="realSecret99" topic', scope)).toBe(
      '  debug note;   topic',
    )
    expect(scrubInterestText('Authorization header handling', scope)).toBe('Authorization header handling')
    expect(scrubInterestText('Cookie parser guide', scope)).toBe('Cookie parser guide')
    expect(scrubInterestText('Basic TypeScript guide', scope)).toBe('Basic TypeScript guide')
    expect(scrubInterestText('Digest authentication RFC', scope)).toBe('Digest authentication RFC')
    expect(scrubInterestText('OAuth PKCE flow', scope)).toBe('OAuth PKCE flow')
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('secrets=["line1,\n"] debug', scope)).toBe('  debug')

    // End-to-end extractWebLearningInterests verification across all Iter 6/7 payloads
    payloads.forEach((payload, idx) => {
      seedNode(store, scope, {
        id: `a:g-i7-${idx}`,
        kind: 'goal',
        title: `Cargo ${idx}`,
        body: payload,
        updatedAt: nowMs - idx,
      })
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 60,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const serialized = JSON.stringify({
      queries: res.interests.map((i) => ({ query: i.query, tokens: i.tokens })),
      urls: res.targets.map((t) => t.url),
    }).toLowerCase()

    for (const leaked of [
      'abc12345',
      'xyz78901',
      'realsecret99',
      'moresecret88',
      'mykey99',
      'sigsecret99',
      'akiaiosfodnn7example',
      'aws4_request',
      'mysigsecret99',
      'alice',
      'dcd98b71',
      'mydigestsecret99',
      'mybotsecret99',
      'customscheme',
      'unclosed1',
      'secval111',
      'secval222',
      'secval999',
      'miieowibaakcaqea12345',
    ]) {
      expect(serialized, `expected ${leaked} to be scrubbed from outbound targets`).not.toContain(leaked)
    }
  })

  test('scrubs Iter 7 parameterized Auth schemes, mid-header secret Cookie/Auth params, SetCookie/folded cookies, JSON objects with api_key/token, unindented array closers, YAML comments/list scalars, and inline auth/space quotes', () => {
    const { store } = openTempStore()
    const scope = makeScope('scrub-iter7-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 13, 45, 0)

    const payloads = [
      // R2-1 / C1-1 / C2-1: Auth headers with mid-header secret params, spaced =, and all parameterized schemes
      'Authorization: OAuth oauth_consumer_key="dpf43f3p2l4k3l03", oauth_token="nnch734d00sl2jdk", oauth_signature="myOAuthSig99" debug',
      'Authorization: AWS4-HMAC-SHA256 Credential="myKey99", SecurityToken="tok99", Signature="sigSecret99" debug',
      'Authorization: AWS4-HMAC-SHA256 Credential="myKey99", SessionToken="tok99", Signature="sigSecret99" debug',
      'Authorization: Digest username="alice", auth_token="tok99", response="myDigestSecret99" debug',
      'Authorization: Digest username="alice", response = "myDigestSecret99" debug',
      'Authorization: Signature keyId="myKey99",algorithm="rsa-sha256",signature="mySigSecret99" debug',
      'Authorization: MAC id="h480djs93hd8", ts="1336363200", nonce="dj83hs9s", mac="myMacSecret99" debug',
      'Authorization: SCRAM-SHA-1 r="nonceVal99", c="biws", p="proofVal99" debug',
      'Authorization: SCRAM-SHA-256 r="nonceVal99", c="biws", p="proofVal99" debug',
      'Authorization: SCRAM-SHA-512 r="nonceVal99", c="biws", p="proofVal99" debug',
      'Authorization: Vapid t=myVapidJwt99, k=myPublicKey99 debug',
      'Authorization: HOBA result="myHobaSecret99" debug',
      'Authorization: Mutual username="alice", secret="myMutualSecret99" debug',
      'Authorization: CustomScheme [secVal111, secVal222] debug',

      // R2-2 / C1-4 / C2-2: Cookie headers starting with or containing secret pairs, space-sep ; ;, SetCookie, comma-folded
      'Cookie: session_id=abc12345; csrf=xyz78901 debug',
      'Cookie: api_key="realSecret99"; csrf="xyz78901" debug',
      'Cookie: sid=abc12345; session_id=realSecret99; csrf=xyz78901 debug',
      'Cookie: sid=abc12345; api_key="realSecret99"; csrf=xyz78901 debug',
      'Cookie sid=abc12345; api_key="realSecret99"; csrf=xyz78901 debug',
      'Set-Cookie: sid=abc12345; HttpOnly, csrf=realSecret99 debug',
      'SetCookie: sid=abc12345; csrf=realSecret99 debug',
      'Cookie: sid=abc12345; api_key=[secVal111, secVal222] debug',
      'Cookie: sid=abc12345; api_key: "realSecret99" debug',

      // C1-4 / C2-3: Closed JSON objects with secret keys, unindented final array element, unclosed quote + prose + balanced quote
      'credentials={\n  "api_key": "secVal111",\n  "pass": "secVal222"\n} debug',
      'credentials={\n  "token": "secVal111",\n  "pin": "secVal222"\n} debug',
      'secrets=[\nsecVal111,\nsecVal222\n] debug',
      'secrets=[\n  "unclosed1\n  foo "secVal222"] debug',

      // C1-2 / C2-4: YAML | # comment and list-item - key: |
      'private_key: | # PEM key\n  realSecret99\n  moreSecret88\ndebug',
      '  - private_key: |\n    realSecret99\n  debug',

      // C1-3 / C1-4: Inline escaped quote before Authorization: Bearer "..." / api_key "...", token== without pre-space
      'password="foo\\" Authorization: Bearer "realSecret99" debug',
      'password="foo\\" api_key "realSecret99" debug',
      'password= token== realSecret99 debug',
    ]

    for (const payload of payloads) {
      const scrubbed = scrubInterestText(payload, scope).toLowerCase()
      for (const leaked of [
        'dpf43f3p2l4k3l03',
        'nnch734d00sl2jdk',
        'myoauthsig99',
        'mykey99',
        'tok99',
        'sigsecret99',
        'alice',
        'mydigestsecret99',
        'mysigsecret99',
        'h480djs93hd8',
        'dj83hs9s',
        'mymacsecret99',
        'nonceval99',
        'biws',
        'proofval99',
        'myvapidjwt99',
        'mypublickey99',
        'myhobasecret99',
        'mymutualsecret99',
        'secval111',
        'secval222',
        'abc12345',
        'xyz78901',
        'realsecret99',
        'moresecret88',
        'unclosed1',
      ]) {
        expect(scrubbed, `expected ${payload} to scrub ${leaked}`).not.toContain(leaked)
      }
      expect(scrubbed, `expected ${payload} to preserve debug`).toContain('debug')
    }

    // Prose and base64 preservation must remain 100% intact
    expect(scrubInterestText('Cookie parser guide', scope)).toBe('Cookie parser guide')
    expect(scrubInterestText('SetCookie parser guide', scope)).toBe('SetCookie parser guide')
    expect(scrubInterestText('Authorization header handling', scope)).toBe('Authorization header handling')
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('secrets=["line1,\n"] debug', scope)).toBe('  debug')

    payloads.forEach((payload, idx) => {
      seedNode(store, scope, {
        id: `a:g-i7r-${idx}`,
        kind: 'goal',
        title: `Cargo ${idx}`,
        body: payload,
        updatedAt: nowMs - idx,
      })
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 80,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const serialized = JSON.stringify({
      queries: res.interests.map((i) => ({ query: i.query, tokens: i.tokens })),
      urls: res.targets.map((t) => t.url),
    }).toLowerCase()

    for (const leaked of [
      'dpf43f3p2l4k3l03',
      'nnch734d00sl2jdk',
      'myoauthsig99',
      'mykey99',
      'tok99',
      'sigsecret99',
      'alice',
      'mydigestsecret99',
      'mysigsecret99',
      'h480djs93hd8',
      'dj83hs9s',
      'mymacsecret99',
      'nonceval99',
      'biws',
      'proofval99',
      'myvapidjwt99',
      'mypublickey99',
      'myhobasecret99',
      'mymutualsecret99',
      'secval111',
      'secval222',
      'abc12345',
      'xyz78901',
      'realsecret99',
      'moresecret88',
      'unclosed1',
    ]) {
      expect(serialized, `expected ${leaked} to be scrubbed from outbound targets`).not.toContain(leaked)
    }
  })

  test('scrubs nested/unindented/equals/comma-less containers, all comma-parameterized & folded Auth headers, Cookie2/quoted/flagged cookies, lowercase compound ==, and custom escaped-quote schemes (Iter 8 regressions)', () => {
    const scope = makeScope('scrub-iter8-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 13, 55, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      {
        name: 'unindented-json-in-brace',
        payload: 'credentials={\n"api_key": "secVal111",\n"pass": "secVal222"\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'array-of-objects-json',
        payload: 'secrets=[\n  {\n    "api_key": "secVal111",\n    "pass": "secVal222"\n  }\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'array-of-objects-unquoted',
        payload: 'secrets=[\n  {\n    token: "sec1",\n    value: "realSecret99"\n  }\n] debug',
        secrets: ['sec1', 'realsecret99'],
      },
      {
        name: 'obj-nested-array-json',
        payload: 'credentials={\n  "items": [\n    {\n      "api_key": "secVal111",\n      "pass": "secVal222"\n    }\n  ]\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'obj-nested-array-unquoted',
        payload: 'secrets={\n  items: [\n    {\n      token: "sec1",\n      value: "realSecret99"\n    }\n  ]\n} debug',
        secrets: ['sec1', 'realsecret99'],
      },
      {
        name: 'obj-equals-props',
        payload: 'credentials={\n  api_key = "secVal111",\n  pass = "secVal222"\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'obj-no-comma-multi-props',
        payload: 'secrets={\n  token: "sec1"\n  label: "mid"\n  payload: "realSecret99"\n} debug',
        secrets: ['sec1', 'mid', 'realsecret99'],
      },
      {
        name: 'auth-token-comma-params',
        payload: 'Authorization: Token id="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-bearer-comma-params',
        payload: 'Authorization: Bearer key="myKey99", signature="mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-apikey-comma-params',
        payload: 'Authorization: ApiKey key_id="id99", secret="sec99", signature="sig99" debug',
        secrets: ['id99', 'sec99', 'sig99'],
      },
      {
        name: 'auth-dpop-comma-params',
        payload: 'Authorization: DPoP key="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-custom-comma-params',
        payload: 'Authorization: CustomScheme key1="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-oauth-multiline-folded',
        payload: 'Authorization: OAuth\n  oauth_consumer_key="myKey99",\n  oauth_signature="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-quoted-scheme',
        payload: 'Authorization: "Bearer" "quotedSchemeTok99" debug',
        secrets: ['quotedschemetok99'],
      },
      {
        name: 'cookie-token-space-eq',
        payload: 'Cookie: token = abc12345; csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookie-basic-space-eq',
        payload: 'Cookie: basic = abc12345; csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookie2-header',
        payload: 'Cookie2: $Version=1; sid=abc12345; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'set-cookie-quoted-first',
        payload: 'Set-Cookie: "sid=abc12345"; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'set-cookie-discard-flag',
        payload: 'Set-Cookie: sid=abc12345; Discard; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'set-cookie-hostonly-flag',
        payload: 'Set-Cookie: session_id=abc12345; HostOnly; csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookie-colon-secret-mid',
        payload: 'Cookie: sid=abc12345; api_key: "realSecret99"; csrf=xyz78901 debug',
        secrets: ['abc12345', 'realsecret99', 'xyz78901'],
      },
      {
        name: 'pw-mytoken-eqeq',
        payload: 'password= mytoken== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-usersecret-eqeq',
        payload: 'password= usersecret== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'esc-quote-auth-custom-scheme',
        payload: 'password="foo\\" Authorization: CustomScheme "realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'esc-quote-auth-colon-nospace',
        payload: 'password="foo\\" authorization:Bearer "realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'cross-line-quoted-scalar',
        payload: '"api_key":\n  "crossLineSecret99" debug',
        secrets: ['crosslinesecret99'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i8-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    // Prose and base64 preservation
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('Authorization header handling', scope)).toBe('Authorization header handling')
    expect(scrubInterestText('Cookie parser guide', scope)).toBe('Cookie parser guide')
    expect(scrubInterestText('Cookie: sid=abc12345 debug note; api_key="realSecret99" topic', scope)).toBe(
      '  debug note;   topic',
    )
  })

  test('scrubs col-0/nested/commented containers, folded/space/semi/comma-first/quoted-custom Auth headers, folded/flagged/quoted/mid-Auth/bracket Cookie headers, camelCase/digit ==, escaped-quote inline Auth/Cookie, YAML lists, and <16c lowercase scalars (Iter 9 regressions)', () => {
    const scope = makeScope('scrub-iter9-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 14, 15, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      // 1. Container/Object boundaries
      {
        name: 'col0-obj-token-pass',
        payload: 'credentials={\ntoken: "sec1",\npass: "sec2"\n} debug',
        secrets: ['sec1', 'sec2'],
      },
      {
        name: 'col0-obj-token-value',
        payload: 'credentials={\ntoken: "sec1",\nvalue: "realSecret99"\n} debug',
        secrets: ['sec1', 'realsecret99'],
      },
      {
        name: 'col0-obj-apikey-hyphen',
        payload: 'secrets={\napi-key: "sec1",\nvalue: "realSecret99"\n} debug',
        secrets: ['sec1', 'realsecret99'],
      },
      {
        name: 'col0-obj-apikey-underscore-colon',
        payload: 'credentials={\napi_key: "secVal111",\npass: "secVal222"\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'col0-obj-apikey-underscore-eq',
        payload: 'credentials={\napi_key = "secVal111",\npass = "secVal222"\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'col0-arr-obj',
        payload: 'secrets=[{\ntoken: "sec1",\nvalue: "realSecret99"\n}] debug',
        secrets: ['sec1', 'realsecret99'],
      },
      {
        name: 'nested-arr-unindented-final-in-brace',
        payload: 'credentials={\n  "items": [\nsecVal111,\nsecVal222\n  ],\n  "pass": "secVal333"\n} debug',
        secrets: ['secval111', 'secval222', 'secval333'],
      },
      {
        name: 'arr-comment-after-comma',
        payload: 'secrets=[\n  "secVal111", // first\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'arr-hash-comment-after-comma',
        payload: 'secrets=[\n  "secVal111", # first\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },

      // 2. Folded, space/semi-delimited, comma-first, & quoted-custom-scheme Authorization headers
      {
        name: 'auth-folded-bearer',
        payload: 'Authorization:\n  Bearer realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'auth-folded-custom-scheme',
        payload: 'Authorization:\n  CustomScheme realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'auth-folded-digest',
        payload: 'Authorization:\n  Digest username="alice", response="myDigestSecret99" debug',
        secrets: ['alice', 'mydigestsecret99'],
      },
      {
        name: 'auth-folded-oauth',
        payload: 'Authorization:\n  OAuth oauth_consumer_key="myKey99", oauth_signature="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-bearer-nl-token-nospace',
        payload: 'Authorization: Bearer\n  mySecretTok99 debug',
        secrets: ['mysecrettok99'],
      },
      {
        name: 'auth-bearer-nl-token-space',
        payload: 'Authorization: Bearer \n  mySecretTok99 debug',
        secrets: ['mysecrettok99'],
      },
      {
        name: 'auth-custom-nl-quoted',
        payload: 'Authorization: CustomScheme\n  "realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'auth-quoted-bearer-nl',
        payload: 'Authorization: "Bearer"\n  "realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'auth-quoted-custom-scheme-1',
        payload: 'Authorization: "CustomScheme" "realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'auth-quoted-custom-scheme-2',
        payload: 'Authorization: "CustomScheme" "quotedTok99" debug',
        secrets: ['quotedtok99'],
      },
      {
        name: 'auth-folded-comma-next-line',
        payload: 'Authorization: Digest username="alice"\n  , response="myDigestSecret99" debug',
        secrets: ['alice', 'mydigestsecret99'],
      },
      {
        name: 'auth-bearer-space-kv',
        payload: 'Authorization: Bearer key="myKey99" signature="mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-custom-space-kv',
        payload: 'Authorization: CustomScheme token="tok99" signature="mySig99" debug',
        secrets: ['tok99', 'mysig99'],
      },
      {
        name: 'auth-custom-semi-kv',
        payload: 'Authorization: CustomScheme key="myKey99"; signature="mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-custom-comma-after-scheme',
        payload: 'Authorization: CustomScheme, key="myKey99", signature="mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },

      // 3. Cookie / Set-Cookie folded, multi-flag, $-flag, quoted name, mid-header Auth, bracketed colon secrets
      {
        name: 'cookie-folded-after-colon',
        payload: 'Cookie:\n  sid=abc12345; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'set-cookie-two-bare-flags-short',
        payload: 'Set-Cookie: a=1; X; Y; csrf=xyz78901 debug',
        secrets: ['xyz78901'],
      },
      {
        name: 'set-cookie-two-bare-flags-long',
        payload: 'Set-Cookie: session_id=abc12345; FlagOne; FlagTwo; csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookie-dollar-discard-flag',
        payload: 'Cookie: sid=abc12345; $Discard; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'cookie-quoted-name',
        payload: 'Cookie: "sid"="abc12345"; csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookie-mid-auth-bearer',
        payload: 'Cookie: sid=abc12345; Authorization: Bearer realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'cookie-mid-auth-custom',
        payload: 'Cookie: sid=abc12345; Authorization: CustomScheme realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'cookie-mid-colon-array',
        payload: 'Cookie: sid=abc12345; api_key: [secVal111, secVal222]; csrf=realSecret99 debug',
        secrets: ['abc12345', 'secval111', 'secval222', 'realsecret99'],
      },

      // 4. == base64 exemption, inline escaped-quote Auth/Cookie, YAML lists, <16c lowercase scalars
      {
        name: 'pw-myApiKey-eqeq',
        payload: 'password= myApiKey== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-userToken-eqeq',
        payload: 'password= userToken== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-myToken1-eqeq',
        payload: 'password= myToken1== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-myToken-eqeq',
        payload: 'password= myToken== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-apiToken2-eqeq',
        payload: 'password= apiToken2== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'esc-quote-auth-oauth-realm',
        payload: 'password="foo\\" Authorization: OAuth realm="realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'esc-quote-auth-oauth-params',
        payload: 'password="foo\\" Authorization: OAuth oauth_consumer_key="myKey99", oauth_signature="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'esc-quote-auth-bearer-kv',
        payload: 'password="foo\\" Authorization: Bearer key="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'esc-quote-cookie',
        payload: 'password="foo\\" Cookie: sid="abc12345" debug',
        secrets: ['abc12345'],
      },
      {
        name: 'yaml-list-under-key',
        payload: 'api_key:\n  - secVal111\n  - secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'crossline-lowercase-15c',
        payload: 'api_key:\n  mysecretvaluedd debug',
        secrets: ['mysecretvaluedd'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i9-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    // CamelCase/numbered secret stems rejected by sanitizeInterestToken while preserving oauth
    expect(sanitizeInterestToken('myApiKey', scope)).toBeNull()
    expect(sanitizeInterestToken('userToken', scope)).toBeNull()
    expect(sanitizeInterestToken('myToken1', scope)).toBeNull()
    expect(sanitizeInterestToken('apiToken2', scope)).toBeNull()
    expect(sanitizeInterestToken('oauth', scope)).toBe('oauth')

    // Prose and base64 preservation must remain 100% intact
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('Authorization header handling', scope)).toBe('Authorization header handling')
    expect(scrubInterestText('Authorization: learn how RBAC works', scope)).toBe('  how RBAC works')
    expect(scrubInterestText('Authorization:\n  learn how RBAC works', scope)).toBe(
      'Authorization:\n  learn how RBAC works',
    )
    expect(scrubInterestText('credentials={\ntopic: kubernetes', scope)).toBe(' \ntopic: kubernetes')
    expect(scrubInterestText('Cookie: sid=abc12345 debug note; api_key="realSecret99" topic', scope)).toBe(
      '  debug note;   topic',
    )
  })

  test('scrubs folded Cookie/Set-Cookie headers, pre-stripped URL/path delimiters, folded/comma Auth headers, YAML sequences/mappings, container comments & col-0 properties, and acronym/digit == stems without breaking prose/base64 (Iter 10 regressions)', () => {
    const scope = makeScope('scrub-iter10-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 14, 45, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      // 1. Cookie / Set-Cookie folding, containers, URL delimiters, bare/$ flags, spaced/full Expires, quoted colon
      {
        name: 'cookie-folded-after-semi',
        payload: 'Cookie: sid=abc12345;\n  csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'cookie-folded-colon-and-semi',
        payload: 'Cookie:\n  sid=abc12345;\n  csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'set-cookie-folded-after-flag',
        payload: 'Set-Cookie: sid=abc12345; HttpOnly;\n  csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookie-folded-before-semi',
        payload: 'Cookie: sid=abc12345\n  ; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'cookie-folded-json',
        payload: 'Cookie:\n  {"sid": "abc12345", "csrf": "realSecret99"} debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'cookie-folded-array',
        payload: 'Cookie:\n  [sid=abc12345, csrf=realSecret99] debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'set-cookie-url-preserves-semi',
        payload: 'Set-Cookie: sid=abc12345; origin=https://app.example.com; csrf="realSecret99" debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'cookie-mid-quoted-colon',
        payload: 'Cookie: sid=abc12345; "api_key": "secVal111"; csrf=xyz78901 debug',
        secrets: ['abc12345', 'secval111', 'xyz78901'],
      },
      {
        name: 'esc-quote-cookie-bare-flag',
        payload: 'password="foo\\" Cookie: MyFlag; sid="realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'esc-quote-cookie-dollar-flag',
        payload: 'password="foo\\" Cookie: $Discard; sid="realSecret99" debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'set-cookie-expires-spaced',
        payload: 'Set-Cookie: sid=abc12345; Expires = Wed, 21 Oct 2026 07:28:00 GMT; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },
      {
        name: 'set-cookie-expires-full-weekday',
        payload: 'Set-Cookie: sid=abc12345; Expires=Wednesday, 21 Oct 2026 07:28:00 GMT; csrf=realSecret99 debug',
        secrets: ['abc12345', 'realsecret99'],
      },

      // 2. Pre-stripped path/URL Auth params & generalized Authorization comma/folding
      {
        name: 'auth-bearer-prestripped-path',
        payload: 'Authorization: Bearer key=/secret/path signature="mySig99" debug',
        secrets: ['mysig99'],
      },
      {
        name: 'auth-digest-prestripped-path',
        payload: 'Authorization: Digest uri=/secret/path response="mySig99" debug',
        secrets: ['mysig99'],
      },
      {
        name: 'auth-oauth-prestripped-path',
        payload: 'Authorization: OAuth oauth_callback=/cb/path oauth_signature="mySig99" debug',
        secrets: ['mysig99'],
      },
      {
        name: 'auth-custom-prestripped-path',
        payload: 'Authorization: CustomScheme key=/secret/path signature="mySig99" debug',
        secrets: ['mysig99'],
      },
      {
        name: 'auth-bearer-prestripped-url',
        payload: 'Authorization: Bearer key=https://app.example.com signature="mySig99" debug',
        secrets: ['mysig99'],
      },
      {
        name: 'auth-quoted-custom-comma',
        payload: 'Authorization: "CustomScheme", key="myKey99", signature="mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-quoted-bearer-comma',
        payload: 'Authorization: "Bearer", key="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-bearer-space-comma',
        payload: 'Authorization: Bearer , key="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-bearer-folded-comma',
        payload: 'Authorization: Bearer\n  , key="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-custom-folded-comma',
        payload: 'Authorization: CustomScheme\n  , key="myKey99", sig="realSecret99" debug',
        secrets: ['mykey99', 'realsecret99'],
      },
      {
        name: 'auth-folded-realm-params',
        payload: 'Authorization:\n  realm="myRealm99", response="realSecret99" debug',
        secrets: ['myrealm99', 'realsecret99'],
      },
      {
        name: 'auth-bearer-folded-colon',
        payload: 'Authorization: Bearer\n  key: realSecret99 debug',
        secrets: ['realsecret99'],
      },

      // 3. YAML lists, nested mappings, cross-line Bearer & short scalars
      {
        name: 'yaml-col0-sequence',
        payload: 'api_key:\n- secVal111\n- secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'yaml-nested-scalar-dash',
        payload: 'api_key:\n  -\n    secVal111\ndebug',
        secrets: ['secval111'],
      },
      {
        name: 'yaml-nested-object-items',
        payload: 'api_key:\n  - name: primary\n    value: secVal111\n  - name: secondary\n    value: secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'yaml-nested-mapping',
        payload: 'credentials:\n  pass: secVal222\ndebug',
        secrets: ['secval222'],
      },
      {
        name: 'crossline-bearer-under-apikey',
        payload: 'api_key:\n  Bearer realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'crossline-short-upper',
        payload: 'api_key:\n  MYKEYS debug',
        secrets: ['mykeys'],
      },
      {
        name: 'crossline-short-lower',
        payload: 'api_key:\n  mykeyzz debug',
        secrets: ['mykeyzz'],
      },

      // 4. Container comments & col-0 properties
      {
        name: 'arr-comment-closer-slash',
        payload: 'secrets=[\n  "secVal111", // close ]\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'arr-comment-closer-block',
        payload: 'secrets=[\n  "secVal111", /* close ] */\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'arr-comment-closer-hash',
        payload: 'secrets=[\n  "secVal111", # close ]\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'arr-trailing-block-comment',
        payload: 'secrets=[\n  "secVal111", /* first */\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'obj-block-comment-closer',
        payload: 'credentials={\n  "api_key": "secVal111", /* close } */\n  "pass": "secVal222"\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'col0-quoted-equals-props',
        payload: 'credentials={\n"api_key" = "secVal111",\n"pass" = "secVal222"\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'col0-unquoted-nocomma-token-pass',
        payload: 'credentials={\ntoken: secVal111\npass: secVal222\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'col0-unquoted-nocomma-apikey-pass',
        payload: 'credentials={\napi_key: secVal111\npass: secVal222\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'col0-unquoted-nocomma-pass-value',
        payload: 'credentials={\npass: secVal111\nvalue: realSecret99\n} debug',
        secrets: ['secval111', 'realsecret99'],
      },

      // 5. Secret stems & == padding
      {
        name: 'pw-myapikey1-eqeq',
        payload: 'password=myapikey1== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-mytoken1-eqeq',
        payload: 'password=mytoken1== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-v1token-eqeq',
        payload: 'password=v1token== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-Mytoken-eqeq',
        payload: 'password=Mytoken== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-APITokenValue-eqeq',
        payload: 'password=APITokenValue== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-SSHKeyVal-eqeq',
        payload: 'password=SSHKeyVal== realSecret99 debug',
        secrets: ['realsecret99'],
      },
      {
        name: 'pw-my1token-eqeq',
        payload: 'password=my1token== realSecret99 debug',
        secrets: ['realsecret99'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i10-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    // Secret stem variants rejected by sanitizeInterestToken while preserving oauth
    for (const badToken of ['myapikey1', 'mytoken1', 'APITokenValue', 'SSHKeyVal', 'my1token', 'Mytoken', 'v1token']) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }
    expect(sanitizeInterestToken('oauth', scope)).toBe('oauth')

    // Prose and base64 preservation must remain 100% intact
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('Cookie: sid=abc12345 debug note; api_key="realSecret99" topic', scope)).toBe(
      '  debug note;   topic',
    )
    expect(scrubInterestText('Cookie: sid=abc12345;\n  learn how RBAC works', scope)).toBe(
      ' ;\n  learn how RBAC works',
    )
    expect(scrubInterestText('Authorization:\n  learn how RBAC works', scope)).toBe(
      'Authorization:\n  learn how RBAC works',
    )
    expect(scrubInterestText('credentials={\ntopic: kubernetes', scope)).toBe(' \ntopic: kubernetes')
  })

  test('scrubs multiline block comments, col-0 comments/paths/Bearer values, YAML Cookie/Auth sequences & mid-block comments, acronym/TitleCase/digit == stems, inline/folded/quoted Auth params, Expires-first escaped Cookie, pre-stripped Cookie paths, and URL ;/,key= without breaking prose/base64 (Iter 11 regressions)', () => {
    const scope = makeScope('scrub-iter11-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 15, 15, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      // Area 2: Block comments & col-0 container continuations
      {
        name: 'arr-multiline-block-comment-comma',
        payload: 'secrets=[\n  "secVal111" /* multi\n  line ] comment */,\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'arr-comma-before-multiline-block-comment',
        payload: 'secrets=[\n  "secVal111", /* multi\n  line ] comment */\n  secVal222\n] debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'arr-col0-block-comment-line',
        payload: 'secrets=[\n/* comment */\n"secVal111",\nmyVal9911\n] debug',
        secrets: ['secval111', 'myval9911'],
      },
      {
        name: 'obj-col0-leading-block-comment-close',
        payload: 'credentials={\n/* comment } */\ntoken: secVal111\npass: secVal222\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'obj-col0-mid-block-comment',
        payload: 'credentials={\ntoken: secVal111\n/* comment */\nvalue: myVal9911\n} debug',
        secrets: ['secval111', 'myval9911'],
      },
      {
        name: 'obj-col0-slash-comment',
        payload: 'credentials={\ntoken: secVal111\n// comment\nvalue: myVal9911\n} debug',
        secrets: ['secval111', 'myval9911'],
      },
      {
        name: 'obj-col0-bearer-multiword',
        payload: 'credentials={\ntoken: Bearer myVal111\npass: myVal222\n} debug',
        secrets: ['myval111', 'myval222'],
      },
      {
        name: 'obj-col0-prestripped-path',
        payload: 'credentials={\ntoken: /secret/path\npass: secVal222\n} debug',
        secrets: ['secval222'],
      },

      // Area 3: YAML sequences, mappings & mid-block # comments
      {
        name: 'cookie-yaml-list',
        payload: 'Cookie:\n  - sid=abc12345\n  - csrf=xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookies-yaml-list',
        payload: 'cookies:\n  - sid=abc12345\n  - csrf=xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookies-yaml-mapping',
        payload: 'cookies:\n  sid: abc12345\n  csrf: xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'cookies-yaml-apikey-then-csrf',
        payload: 'cookies:\n  api_key: secVal111\n  csrf: xyz78901\ndebug',
        secrets: ['secval111', 'xyz78901'],
      },
      {
        name: 'auth-yaml-list-indented',
        payload: 'Authorization:\n  - myVal111\n  - myVal222\ndebug',
        secrets: ['myval111', 'myval222'],
      },
      {
        name: 'auth-yaml-list-col0',
        payload: 'Authorization:\n- myVal111\n- myVal222\ndebug',
        secrets: ['myval111', 'myval222'],
      },
      {
        name: 'yaml-comment-before-list',
        payload: 'api_key:\n  # comment\n  - secVal111\n  - secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'yaml-comment-before-map',
        payload: 'credentials:\n  # comment\n  pass: secVal222\ndebug',
        secrets: ['secval222'],
      },
      {
        name: 'yaml-list-mid-comment',
        payload: 'api_key:\n  - secVal111\n  # second\n  - myVal9911\ndebug',
        secrets: ['secval111', 'myval9911'],
      },
      {
        name: 'yaml-col0-list-mid-comment',
        payload: 'api_key:\n- secVal111\n# second\n- myVal9911\ndebug',
        secrets: ['secval111', 'myval9911'],
      },
      {
        name: 'yaml-map-mid-comment',
        payload: 'credentials:\n  pass: secVal111\n  # second\n  value: myVal9911\ndebug',
        secrets: ['secval111', 'myval9911'],
      },

      // Area 4: Secret stems & == guard
      { name: 'pw-TOKENvalue-eqeq', payload: 'password=TOKENvalue== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-SECRETkey-eqeq', payload: 'password=SECRETkey== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-APIKEYvalue-eqeq', payload: 'password=APIKEYvalue== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-mySECRETtoken-eqeq', payload: 'password=mySECRETtoken== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-AUTHtoken-eqeq', payload: 'password=AUTHtoken== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myTokenval-eqeq', payload: 'password=myTokenval== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-MyTokenval-eqeq', payload: 'password=MyTokenval== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-MySubtokenVal-eqeq', payload: 'password=MySubtokenVal== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-API1Key-eqeq', payload: 'password=API1Key== myVal99 debug', secrets: ['myval99'] },
      { name: 'pw-myAPI1token-eqeq', payload: 'password=myAPI1token== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-my1tokenVal-eqeq', payload: 'password=my1tokenVal== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-Ssh1keyVal-eqeq', payload: 'password=Ssh1keyVal== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-v1Apitoken-eqeq', payload: 'password=v1Apitoken== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-api2Key-eqeq', payload: 'password=api2Key== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-mySecret1key-eqeq', payload: 'password=mySecret1key== secVal99 debug', secrets: ['secval99'] },

      // Area 5: Authorization inline/folded colon params & quoted parameter names
      {
        name: 'auth-bearer-quoted-param-names',
        payload: 'Authorization: Bearer "key"="myKey99", "sig"="myVal9911" debug',
        secrets: ['mykey99', 'myval9911'],
      },
      {
        name: 'auth-custom-quoted-param-names',
        payload: 'Authorization: CustomScheme "key"="myKey99", "sig"="myVal9911" debug',
        secrets: ['mykey99', 'myval9911'],
      },
      {
        name: 'auth-bearer-inline-colon',
        payload: 'Authorization: Bearer key: myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'auth-custom-inline-colon',
        payload: 'Authorization: CustomScheme key: myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'auth-digest-inline-colon',
        payload: 'Authorization: Digest username: alice, response: myVal9911 debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'auth-bearer-folded-comma-colon',
        payload: 'Authorization: Bearer\n  , key: "myKey99", sig: "mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-custom-folded-comma-colon',
        payload: 'Authorization: CustomScheme\n  , key: "myKey99", sig: "mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-quoted-scheme-colon-params',
        payload: 'Authorization: "Bearer", key: "myKey99", sig: "hunter99" debug',
        secrets: ['mykey99', 'hunter99'],
      },
      {
        name: 'auth-bearer-folded-multiline-colon',
        payload: 'Authorization: Bearer\n  key: myVal111\n  sig: myVal222\ndebug',
        secrets: ['myval111', 'myval222'],
      },
      {
        name: 'auth-digest-folded-multiline-colon',
        payload: 'Authorization: Digest\n  username: alice\n  response: secVal99\ndebug',
        secrets: ['alice', 'secval99'],
      },
      {
        name: 'auth-custom-folded-multiline-colon',
        payload: 'Authorization: CustomScheme\n  key: myKey99\n  sig: myVal9911 debug',
        secrets: ['mykey99', 'myval9911'],
      },

      // Area 6: Cookie/Set-Cookie & URL ;key= / ,key=
      {
        name: 'esc-quote-setcookie-expires-before-secret',
        payload: 'password="foo\\" Set-Cookie: sid=abc123; Expires=Wed, 21 Oct 2026 07:28:00 GMT; csrf="myVal9911" debug',
        secrets: ['abc123', 'myval9911'],
      },
      {
        name: 'cookie-prestripped-path-space-quoted',
        payload: 'Cookie: sid=abc12345; key=/secret/path csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'setcookie-prestripped-path-space-quoted',
        payload: 'Set-Cookie: sid=abc12345; path=/admin/app csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'cookie-colon-prestripped-path-space-quoted',
        payload: 'Cookie: sid=abc12345; "api_key": /secret/path csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'url-semicolon-apikey',
        payload: 'note=https://app.example.com;api_key="myVal99" debug',
        secrets: ['myval99'],
      },
      {
        name: 'url-comma-apikey',
        payload: 'note=https://app.example.com,api_key="myVal99" debug',
        secrets: ['myval99'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i11-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    // All Iter 10/11 secret stem variants rejected by sanitizeInterestToken while preserving oauth
    for (const badToken of [
      'API1Key', 'myAPI1token', 'my1tokenVal', 'Ssh1keyVal', 'v1Apitoken', 'MySubtokenVal',
      'api2Key', 'myTokenval', 'MyTokenval', 'mySecret1key', 'TOKENvalue', 'SECRETkey',
      'APIKEYvalue', 'mySECRETtoken', 'AUTHtoken', 'myapikey1', 'mytoken1', 'APITokenValue',
      'SSHKeyVal', 'my1token', 'Mytoken', 'v1token',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }
    expect(sanitizeInterestToken('oauth', scope)).toBe('oauth')

    // Prose and base64 preservation must remain 100% intact
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('Cookie: sid=abc12345 debug note; api_key="realSecret99" topic', scope)).toBe(
      '  debug note;   topic',
    )
    expect(scrubInterestText('Cookie: sid=abc12345;\n  learn how RBAC works', scope)).toBe(
      ' ;\n  learn how RBAC works',
    )
    expect(scrubInterestText('Authorization:\n  learn how RBAC works', scope)).toBe(
      'Authorization:\n  learn how RBAC works',
    )
    expect(scrubInterestText('Authorization:\n  topic: kubernetes', scope)).toBe(
      'Authorization:\n  topic: kubernetes',
    )
    expect(scrubInterestText('Authorization: Bearer learn how RBAC works', scope)).toBe('  how RBAC works')
    expect(scrubInterestText('credentials={\ntopic: kubernetes', scope)).toBe(' \ntopic: kubernetes')
  })

  test('scrubs YAML comments/blank lines, folded/semicolon/escaped Auth, folded Cookie paths/flags, digit-separated == stems, container comments with secret words, and URL subscript/space secrets (Iter 12/13)', () => {
    const scope = makeScope('scrub-iter13-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 16, 0, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      // Area 1: YAML # / // comments & blank lines
      {
        name: 'yaml-apikey-hash-blank',
        payload: 'api_key:\n  #\n  myVal9911\ndebug',
        secrets: ['myval9911'],
      },
      {
        name: 'yaml-apikey-hash-comment',
        payload: 'api_key:\n  # comment\n  myVal9911\ndebug',
        secrets: ['myval9911'],
      },
      {
        name: 'yaml-cookie-hash-comment',
        payload: 'Cookie:\n  # comment\n  sid=abc12345; csrf=xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'yaml-cookie-blank-line',
        payload: 'Cookie:\n\n  sid=abc12345; csrf=xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'yaml-cookie-hash-newline-pairs',
        payload: 'Cookie:\n  # comment\n  sid=abc12345\n  csrf=xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'yaml-auth-hash-custom',
        payload: 'Authorization:\n  # comment\n  CustomScheme myVal9911\ndebug',
        secrets: ['myval9911'],
      },
      {
        name: 'yaml-auth-blank-custom',
        payload: 'Authorization:\n\n  CustomScheme myVal9911\ndebug',
        secrets: ['myval9911'],
      },
      {
        name: 'yaml-auth-hash-digest',
        payload: 'Authorization:\n  # comment\n  Digest username="alice", response="myVal9911"\ndebug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'yaml-auth-hash-basic',
        payload: 'authorization:\n  # comment\n  Basic dXNlcjpwYXNz\ndebug',
        secrets: ['dxnlcjpwyxnz'],
      },
      {
        name: 'yaml-cookies-inline-comment',
        payload: 'cookies:\n  api_key: secVal111 # comment\n  csrf: myVal9911\ndebug',
        secrets: ['secval111', 'myval9911'],
      },
      {
        name: 'yaml-keyline-hash-map',
        payload: 'credentials: # my secrets\n  pass: secVal222\ndebug',
        secrets: ['secval222'],
      },
      {
        name: 'yaml-keyline-hash-list',
        payload: 'api_key: # secret list\n  - secVal111\n  - secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'yaml-keyline-slash-map',
        payload: 'credentials: // comment\n  pass: secVal222\ndebug',
        secrets: ['secval222'],
      },

      // Area 2: Authorization folded/indented/semicolon/quoted-scheme/escaped-quote
      {
        name: 'esc-quote-auth-digest-colon',
        payload: 'password="foo\\" Authorization: Digest username: alice, response="myVal9911" debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'esc-quote-auth-bearer-quoted-param',
        payload: "password=\"foo\\\" Authorization: Bearer 'key'='sec1', sig=\"myVal9911\" debug",
        secrets: ['sec1', 'myval9911'],
      },
      {
        name: 'auth-inline-folded-colon',
        payload: 'Authorization: Bearer key: myVal111\n  sig: myVal222\ndebug',
        secrets: ['myval111', 'myval222'],
      },
      {
        name: 'auth-inline-folded-quoted',
        payload: 'Authorization: Bearer key="myVal111"\n  sig="myVal222"\ndebug',
        secrets: ['myval111', 'myval222'],
      },
      {
        name: 'auth-digest-inline-folded',
        payload: 'Authorization: Digest username="alice"\n  response="myVal222"\ndebug',
        secrets: ['alice', 'myval222'],
      },
      {
        name: 'auth-folded-bearer-inline-folded',
        payload: 'Authorization:\n  Bearer key: myVal9911\n  sig: mySig99\ndebug',
        secrets: ['myval9911', 'mysig99'],
      },
      {
        name: 'auth-quoted-custom-folded',
        payload: 'Authorization: "CustomScheme"\n  key: myKey99\n  sig: mySig99\ndebug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-folded-bearer-folded-colon',
        payload: 'Authorization:\n  Bearer\n  key: myKey99\n  sig: myVal9911\ndebug',
        secrets: ['mykey99', 'myval9911'],
      },
      {
        name: 'auth-indented-bearer-folded-colon',
        payload: '  Authorization: Bearer\n  key: hunter99\n  sig: mySig99 debug',
        secrets: ['hunter99', 'mysig99'],
      },
      {
        name: 'auth-semi-newline',
        payload: 'Authorization: Bearer;\n  key: "myKey99", sig: "mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-semi-inline',
        payload: 'Authorization: Bearer; key="myKey99"; sig="mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-quoted-bearer-folded',
        payload: 'Authorization: "Bearer"\n  key: "myKey99"\n  sig: "mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },
      {
        name: 'auth-folded-leading-comma',
        payload: 'Authorization:\n  , key="myKey99", sig="mySig99" debug',
        secrets: ['mykey99', 'mysig99'],
      },

      // Area 3: Cookie/Set-Cookie folded after pre-stripped path/URL or bare flags
      {
        name: 'cookie-prestripped-path-folded',
        payload: 'Cookie: sid=abc12345; path=/admin/app\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'cookie-sid-path-folded',
        payload: 'Cookie: sid=/secret/path\n  csrf=myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'setcookie-prestripped-url-folded',
        payload: 'Set-Cookie: sid=abc12345; path=https://example.com/a/b\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'cookie-bare-flags-folded',
        payload: 'Cookie: sid=abc12345; key=/secret/path; flag1; flag2\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },

      // Area 4: Digit-separated secret stems before ==
      { name: 'pw-APIKEY1val-eqeq', payload: 'password=APIKEY1val== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-BEARER1val-eqeq', payload: 'password=BEARER1val== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-SSHKEY1val-eqeq', payload: 'password=SSHKEY1val== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-TOKEN1str-eqeq', payload: 'password=TOKEN1str== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-SECRET1str-eqeq', payload: 'password=SECRET1str== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-myAPIKEY1val-eqeq', payload: 'password=myAPIKEY1val== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-myBEARER1val-eqeq', payload: 'password=myBEARER1val== secVal99 debug', secrets: ['secval99'] },
      { name: 'pw-SECRET1data-eqeq', payload: 'password=SECRET1data== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-API1keyval-eqeq', payload: 'password=API1keyval== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-AUTH1item-eqeq', payload: 'password=AUTH1item== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-PASSWD1x-eqeq', payload: 'password=PASSWD1x== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-COOKIE1item-eqeq', payload: 'password=COOKIE1item== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-SESSION1item-eqeq', payload: 'password=SESSION1item== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1token-eqeq', payload: 'password=myApp1token== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-prod1Db1password-eqeq', payload: 'password=prod1Db1password== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-svc1Client1key-eqeq', payload: 'password=svc1Client1key== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-myGitHub1token-eqeq', payload: 'password=myGitHub1token== myVal9911 debug', secrets: ['myval9911'] },

      // Area 5: Container comments containing secret words
      {
        name: 'obj-slash-comment-secret-word',
        payload: 'credentials={\n// token: dummy\npass: secVal222\n} debug',
        secrets: ['secval222'],
      },
      {
        name: 'obj-block-comment-secret-word',
        payload: 'credentials={\n/* token: dummy */\npass: secVal222\n} debug',
        secrets: ['secval222'],
      },
      {
        name: 'obj-leading-block-then-col0-prop',
        payload: 'credentials={\n/* start */ token: secVal111\npass: secVal222\n} debug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'arr-slash-comment-secret-word',
        payload: 'secrets=[\n// token: dummy\n"secVal222"\n] debug',
        secrets: ['secval222'],
      },
      {
        name: 'obj-hash-comment-secret-word',
        payload: 'credentials={\n# token: dummy\npass: secVal222\n} debug',
        secrets: ['secval222'],
      },

      // Area 6: URL ; / , negative lookahead
      {
        name: 'url-semi-env-dq',
        payload: 'note=https://app.example.com;env["API_KEY"]="myVal99" debug',
        secrets: ['myval99'],
      },
      {
        name: 'url-semi-env-sq',
        payload: "note=https://app.example.com;env['API_KEY']=\"myVal99\" debug",
        secrets: ['myval99'],
      },
      {
        name: 'url-comma-env-dq',
        payload: 'note=https://app.example.com,env["API_KEY"]="myVal99" debug',
        secrets: ['myval99'],
      },
      {
        name: 'url-semi-subscript-index-space',
        payload: 'https://example.com/a;api_key[0]= myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'url-semi-subscript-index-quoted',
        payload: 'https://example.com/a;api_key[0]="myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'url-semi-password-space-quote',
        payload: 'https://example.com/a;password "myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'url-comma-bearer',
        payload: 'https://example.com/a,Bearer myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'url-semi-env-space-quote',
        payload: 'https://example.com/a;env["api_key"]= "hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-semi-apikey-space-quote',
        payload: 'https://example.com/a;api_key "hunter99" debug',
        secrets: ['hunter99'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i13-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    for (const badToken of [
      'APIKEY1val', 'BEARER1val', 'SSHKEY1val', 'TOKEN1str', 'SECRET1str',
      'myAPIKEY1val', 'myBEARER1val', 'SECRET1data', 'API1keyval', 'AUTH1item',
      'PASSWD1x', 'COOKIE1item', 'SESSION1item', 'myApp1token', 'prod1Db1password',
      'svc1Client1key', 'myGitHub1token',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }
    expect(sanitizeInterestToken('oauth', scope)).toBe('oauth')
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('Cookie: sid=abc12345;\n  learn how RBAC works', scope)).toBe(
      ' ;\n  learn how RBAC works',
    )
    expect(scrubInterestText('Authorization:\n  learn how RBAC works', scope)).toBe(
      'Authorization:\n  learn how RBAC works',
    )
    expect(scrubInterestText('Authorization:\n  topic: kubernetes', scope)).toBe(
      'Authorization:\n  topic: kubernetes',
    )
    expect(scrubInterestText('Authorization: Bearer learn how RBAC works', scope)).toBe('  how RBAC works')
  })

  test('scrubs YAML multi/slash/block comments & block-scalar-after-comment, escaped-quote/operator Auth headers, chained folded Cookie flags/pairs, digit-separated secret stems, multiline container block comments, and chained/spaced subscripts (Iter 14)', () => {
    const scope = makeScope('scrub-iter14-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 16, 30, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
      readonly expectDebug?: boolean
    }> = [
      // Area 1: YAML & comment skipping
      {
        name: 'yaml-double-block-header',
        payload: 'api_key: /* c1 */ /* c2 */\n  myVal9911\ndebug',
        secrets: ['myval9911'],
      },
      {
        name: 'yaml-multiline-block-header',
        payload: 'api_key: /* multi\n  line */\n  myVal9911\ndebug',
        secrets: ['myval9911', 'multi'],
      },
      {
        name: 'yaml-indented-slash-comment',
        payload: 'api_key:\n  // comment\n  myVal9911\ndebug',
        secrets: ['myval9911', 'comment'],
      },
      {
        name: 'yaml-indented-block-comment',
        payload: 'api_key:\n  /* comment */\n  myVal9911\ndebug',
        secrets: ['myval9911', 'comment'],
      },
      {
        name: 'yaml-slash-comment-map',
        payload: 'credentials:\n  // comment\n  pass: secVal222\ndebug',
        secrets: ['secval222', 'comment'],
      },
      {
        name: 'yaml-slash-comment-auth-basic',
        payload: 'authorization:\n  // comment\n  Basic dXNlcjpwYXNz\ndebug',
        secrets: ['dxnlcjpwyxnz', 'comment'],
      },
      {
        name: 'yaml-slash-comment-auth-digest',
        payload: 'authorization:\n  // comment\n  Digest realm="api", nonce="hunter99"\ndebug',
        secrets: ['hunter99', 'comment'],
      },
      {
        name: 'yaml-col0-hash-comment',
        payload: '  credentials:\n# col0 comment\n    pass: secVal222\ndebug',
        secrets: ['secval222'],
      },
      {
        name: 'yaml-slash-comment-cookies',
        payload: 'cookies:\n  // comment\n  sid=abc12345; csrf=xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901', 'comment'],
      },
      {
        name: 'yaml-cookies-hash-subentry',
        payload: 'cookies:\n  api_key: # comment\n    myVal9911\n  csrf: myVal222\ndebug',
        secrets: ['myval9911', 'myval222', 'comment'],
      },
      {
        name: 'yaml-cookies-slash-subentry',
        payload: 'cookies:\n  api_key: // comment\n    myVal9911\n  csrf: myVal222\ndebug',
        secrets: ['myval9911', 'myval222', 'comment'],
      },
      {
        name: 'yaml-comment-then-pipe',
        payload: 'api_key: # comment\n  |\n    myVal9911\n    line2Secret99\ndebug',
        secrets: ['myval9911', 'line2secret99', 'comment'],
      },
      {
        name: 'yaml-mid-multiline-block-map',
        payload: 'credentials:\n  pass: secVal111\n  /* mid\n  comment */\n  value: secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },

      // Area 2: Authorization escaped-quote params, := / ==, folded colon params
      {
        name: 'esc-quote-auth-digest-single',
        payload: 'password="foo\\" Authorization: Digest username=\\"alice\\", response="myVal9911" debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'esc-quote-auth-digest-spaced',
        payload: 'password="foo\\" Authorization: Digest username=\\"alice bob\\", response="myVal9911" debug',
        secrets: ['alice', 'bob', 'myval9911'],
      },
      {
        name: 'auth-digest-coloneq',
        payload: 'Authorization: Digest username="alice", response:="myVal9911" debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'auth-digest-eqeq',
        payload: 'Authorization: Digest username="alice", response=="myVal9911" debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'auth-yaml-comma-colon-params',
        payload: 'Authorization:\n  username: alice, response: myVal9911\ndebug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'auth-quoted-esc-sig',
        payload: 'Authorization: "Bearer key=\\"api\\" sig="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'auth-inside-outer-quote-esc',
        payload: 'x="Authorization: Bearer key=\\"api\\", nonce="hunter99" debug',
        secrets: ['hunter99'],
      },

      // Area 3: Cookie / Set-Cookie folded flags & quoted pairs
      {
        name: 'cookie-folded-quoted-pair',
        payload: 'Cookie: "sid=abc"\n  "csrf=myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'cookie-path-folded-httponly',
        payload: 'Cookie: sid=/secret/path\n  HttpOnly; csrf=myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'cookie-path-folded-version',
        payload: 'Cookie: sid=/secret/path\n  $Version\n  csrf=myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'cookie-folded-version-domain',
        payload: 'Cookie: $Version\n  $Domain\n  csrf=myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'cookie-folded-dollar-flags-semi',
        payload: 'Cookie: $Flag1\n  $Flag2; csrf=myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'setcookie-path-folded-httponly',
        payload: 'Set-Cookie: sid=abc; Path=/secret/path\n  HttpOnly\n  csrf=myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'cookie-folded-bare-flags-chain',
        payload: 'Cookie: sid=abc12345; Flag1\n  Flag2\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'cookie-prestripped-httponly-folded',
        payload: 'Cookie: sid=abc12345; path=/admin/app\n  httponly\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'setcookie-prestripped-secure-folded',
        payload: 'Set-Cookie: sid=abc12345; path=/admin/app\n  Secure\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'cookie-flag1-httponly-semi',
        payload: 'Cookie: sid=abc12345; flag1\n  HttpOnly; csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'cookie-flag1-flag2-semi-nl',
        payload: 'Cookie: sid=abc12345; flag1\n  flag2;\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },

      // Area 4: Digit-separated secret stems
      { name: 'pw-myApp1mytoken-eqeq', payload: 'password=myApp1mytoken== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1accesstoken-eqeq', payload: 'password=myApp1accesstoken== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1sshkey-eqeq', payload: 'password=myApp1sshkey== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1oauth-eqeq', payload: 'password=myApp1oauth== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1jwt-eqeq', payload: 'password=myApp1jwt== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1tokenval-eqeq', payload: 'password=myApp1tokenval== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1secretdata-eqeq', payload: 'password=myApp1secretdata== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1apikeyval-eqeq', payload: 'password=myApp1apikeyval== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-MY1tokenval-eqeq', payload: 'password=MY1tokenval== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-svc1Client1keyval-eqeq', payload: 'password=svc1Client1keyval== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-my1KEYval-eqeq', payload: 'password=my1KEYval== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1tokens-eqeq', payload: 'password=myApp1tokens== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-myApp1secrets-eqeq', payload: 'password=myApp1secrets== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-myApp1passwords-eqeq', payload: 'password=myApp1passwords== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-DB1password-eqeq', payload: 'password=DB1password== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-AWS1secret-eqeq', payload: 'password=AWS1secret== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-my1tokenV2-eqeq', payload: 'password=my1tokenV2== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-app1secretV2-eqeq', payload: 'password=app1secretV2== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-my1KEYv2-eqeq', payload: 'password=my1KEYv2== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-SVC1token-eqeq', payload: 'password=SVC1token== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-FOO1tokenVAL-eqeq', payload: 'password=FOO1tokenVAL== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-a1tokenVAL-eqeq', payload: 'password=a1tokenVAL== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-Svc1signing-eqeq', payload: 'password=Svc1signing== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-Svc1master-eqeq', payload: 'password=Svc1master== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-Svc1encryption-eqeq', payload: 'password=Svc1encryption== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-Svc1access-eqeq', payload: 'password=Svc1access== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-Svc1refresh-eqeq', payload: 'password=Svc1refresh== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-Svc1private-eqeq', payload: 'password=Svc1private== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-Svc1client-eqeq', payload: 'password=Svc1client== hunter99 debug', secrets: ['hunter99'] },
      { name: 'direct-Svc1signing-eq', payload: 'Svc1signing=hunter99 debug', secrets: ['hunter99'] },

      // Area 5: Multi-line /* ... */ block comments inside containers
      {
        name: 'arr-multiline-block-token-dummy',
        payload: 'secrets=[\n/*\ntoken: dummy\n*/\n"secVal222"\n] debug',
        secrets: ['secval222'],
      },
      {
        name: 'obj-multiline-block-token-dummy',
        payload: 'credentials={\n/*\ntoken: dummy\n*/\npass: secVal222\n} debug',
        secrets: ['secval222'],
      },
      {
        name: 'arr-multiline-star-block-comment',
        payload: 'secrets=[\n/* comment\n * token: dummy\n */\n"secVal222"\n] debug',
        secrets: ['secval222'],
      },
      {
        name: 'obj-multiline-star-block-comment',
        payload: 'credentials={\n/* comment\n * token: dummy\n */\npass: secVal222\n} debug',
        secrets: ['secval222'],
      },
      {
        name: 'arr-inline-multiline-block-comment',
        payload: 'api_key=["a", /* multi\n  password=comment_only */\n  "myVal9911"] debug',
        secrets: ['myval9911'],
      },
      {
        name: 'obj-inline-multiline-block-comment',
        payload: 'api_key={\n  a: "x", /* multi\n  password=comment_only */\n  b: "myVal9911"\n} debug',
        secrets: ['myval9911'],
      },
      {
        name: 'unclosed-block-comment-aborts-cleanly',
        payload: 'api_key=["a", /*\npassword=real\n',
        secrets: ['real'],
        expectDebug: false,
      },

      // Area 6: Chained & spaced subscripts + container provenance
      {
        name: 'url-semi-env-0-apikey',
        payload: 'https://example.com/a;env[0]["API_KEY"]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-semi-env-apikey-0',
        payload: 'https://example.com/a;env["API_KEY"][0]="myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'url-comma-env-apikey-0',
        payload: 'https://example.com/a,env["api_key"][0]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-semi-secrets-0-apikey',
        payload: 'https://example.com/a;secrets[0]["api_key"]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-semi-space-bracket',
        payload: 'https://example.com/a;env ["api_key"] = "hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-semi-subscript-space',
        payload: 'https://example.com/a;api_key["sub 1"]="myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'note-url-sq-subscript-0',
        payload: "note=https://app.example.com;env['API_KEY'][0]=\"myVal99\" debug",
        secrets: ['myval99'],
      },
      {
        name: 'direct-secrets-0-apikey',
        payload: 'secrets[0]["api_key"]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'direct-env-secret-0',
        payload: 'env["secret"][0]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'cookies-subscript-0',
        payload: 'cookies[0]=sid=abc123; csrf=myVal9911 debug',
        secrets: ['abc123', 'myval9911'],
      },
      {
        name: 'cookie-cap-subscript-0',
        payload: 'Cookie[0]=sid=abc123; csrf=myVal9911 debug',
        secrets: ['abc123', 'myval9911'],
      },
      {
        name: 'auth-subscript-0',
        payload: 'Authorization[0]=CustomScheme key=myKey99, sig="myVal9911" debug',
        secrets: ['mykey99', 'myval9911'],
      },
      {
        name: 'url-auth-subscript-0',
        payload: 'https://example.com/a;Authorization[0]=CustomScheme key=myKey99, sig="myVal9911" debug',
        secrets: ['mykey99', 'myval9911'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      if (tc.expectDebug !== false) {
        expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')
      }

      for (const title of ['', 'rust', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i14-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    for (const badToken of [
      'myApp1tokenval', 'myApp1secretdata', 'myApp1apikeyval', 'my1tokenval',
      'myApp1mytoken', 'myApp1accesstoken', 'myApp1sshkey', 'myApp1oauth', 'myApp1jwt',
      'MY1tokenval', 'svc1Client1keyval', 'my1KEYval', 'SVC1token', 'FOO1tokenVAL',
      'a1tokenVAL', 'Svc1signing', 'Svc1master', 'Svc1encryption', 'Svc1access',
      'Svc1refresh', 'Svc1private', 'Svc1client', 'myApp1tokens', 'myApp1secrets',
      'myApp1passwords', 'DB1password', 'AWS1secret', 'my1tokenV2', 'app1secretV2',
      'my1KEYv2',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }
    expect(sanitizeInterestToken('oauth', scope)).toBe('oauth')
    expect(sanitizeInterestToken('tokenizer', scope)).toBe('tokenizer')
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('Cookie: sid=abc12345;\n  learn how RBAC works', scope)).toBe(
      ' ;\n  learn how RBAC works',
    )
    expect(scrubInterestText('Authorization:\n  learn how RBAC works', scope)).toBe(
      'Authorization:\n  learn how RBAC works',
    )
    expect(scrubInterestText('Authorization:\n  topic: kubernetes', scope)).toBe(
      'Authorization:\n  topic: kubernetes',
    )
    expect(scrubInterestText('Authorization: Bearer learn how RBAC works', scope)).toBe('  how RBAC works')
  })

  test('scrubs inline/mid-mapping block comments, multi-entry cookies YAML, Auth escaped backslashes/no-scheme/folded-quoted params, comma-quoted/flagged/comment-folded Cookies, digit-separated secret stems & casing, and empty/$idx/quoted-base/dot-chained subscripts (Iter 15)', () => {
    const scope = makeScope('scrub-iter15-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 17, 0, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      // Area 1: Inline & mid-mapping /* ... */ block comments + multi-entry cookies: YAML fallback
      {
        name: 'inline-block-comment-scalar',
        payload: 'api_key: /* c1 */ myVal9911\ndebug',
        secrets: ['myval9911'],
      },
      {
        name: 'inline-block-comment-quoted',
        payload: 'api_key: /* c1 */ "myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'inline-block-comment-cookie',
        payload: 'Cookie: /* c1 */ sid=abc12345; csrf=xyz78901\ndebug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'inline-block-comment-auth',
        payload: 'Authorization: /* c1 */ Basic dXNlcjpwYXNz\ndebug',
        secrets: ['dxnlcjpwyxnz'],
      },
      {
        name: 'inline-multiline-block-comment-scalar',
        payload: 'api_key: /* multi\n  line */ myVal9911\ndebug',
        secrets: ['myval9911', 'multi', 'line'],
      },
      {
        name: 'col0-closing-block-comment-scalar',
        payload: 'api_key:\n  /* multi\nline */ myVal9911\ndebug',
        secrets: ['myval9911', 'multi', 'line'],
      },
      {
        name: 'col0-closing-block-comment-map',
        payload: 'credentials:\n  /* multi\nline */ pass: secVal222\n  value: secVal333\ndebug',
        secrets: ['secval222', 'secval333', 'multi', 'line'],
      },
      {
        name: 'yaml-map-mid-block-comment',
        payload: 'credentials:\n  pass: secVal111\n  /* mid */ value: secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'yaml-map-mid-multiline-block-comment',
        payload: 'credentials:\n  pass: secVal111\n  /* mid\n  line */ value: secVal222\ndebug',
        secrets: ['secval111', 'secval222'],
      },
      {
        name: 'cookies-yaml-multiline-block-entry',
        payload: 'cookies:\n  api_key: /* multi\n  line */\n    myVal9911\n  csrf: myVal222\ndebug',
        secrets: ['myval9911', 'myval222', 'line'],
      },
      {
        name: 'cookies-yaml-2nd-entry-comment',
        payload: 'cookies:\n  token: myVal111\n  api_key: # comment\n    myVal9911\n  csrf: myVal222\ndebug',
        secrets: ['myval111', 'myval9911', 'myval222'],
      },
      {
        name: 'cookies-yaml-secret-then-nonsecret',
        payload: 'cookies:\n  token: myVal111\n  secret: myVal222\n  csrf: myVal333\ndebug',
        secrets: ['myval111', 'myval222', 'myval333'],
      },

      // Area 2: Authorization escaped quotes, escaped backslashes, no-scheme & folded quoted params
      {
        name: 'auth-quoted-no-esc-sig',
        payload: 'Authorization: "Bearer sig="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'auth-quoted-no-scheme-esc',
        payload: 'Authorization: "key=\\"api\\" sig="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'auth-quoted-bearer-esc-tok',
        payload: 'Authorization: "Bearer \\"tokVal99\\" sig="hunter99" debug',
        secrets: ['tokval99', 'hunter99'],
      },
      {
        name: 'auth-quoted-basic-esc-tok',
        payload: 'Authorization: "Basic \\"dXNlcjpwYXNz\\" sig="hunter99" debug',
        secrets: ['dxnlcjpwyxnz', 'hunter99'],
      },
      {
        name: 'auth-quoted-esc-bs-end',
        payload: 'Authorization: "Bearer key=\\"a\\\\\\" sig="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'auth-quoted-esc-bs-mid',
        payload: 'Authorization: "Bearer key=\\"a\\\\\\"b\\" sig="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'x-auth-digest-esc-bs-mid',
        payload: 'x="Authorization: Digest key=\\"a\\\\\\"b\\", nonce="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'esc-quote-digest-bs-mid',
        payload: 'password="foo\\" Authorization: Digest username=\\"a\\\\b\\", response="myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'esc-quote-digest-bs-end',
        payload: 'password="foo\\" Authorization: Digest username=\\"alice\\\\\\", response="myVal9911" debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'auth-quoted-nl-esc-params',
        payload: 'Authorization: "Bearer\n  username=\\"alice\\", response="hunter99" debug',
        secrets: ['alice', 'hunter99'],
      },
      {
        name: 'auth-quoted-nl-after-param',
        payload: 'Authorization: "Bearer key=\\"api\\"\n  sig="hunter99" debug',
        secrets: ['hunter99'],
      },

      // Area 3: Cookie / Set-Cookie comma quoted pairs, attribute flags & folded comments
      {
        name: 'setcookie-comma-quoted-both',
        payload: 'Set-Cookie: "sid=abc12345", "csrf=hunter99" debug',
        secrets: ['abc12345', 'hunter99'],
      },
      {
        name: 'setcookie-comma-quoted-second',
        payload: 'Set-Cookie: sid=abc12345, "csrf=myVal9911" debug',
        secrets: ['abc12345', 'myval9911'],
      },
      {
        name: 'cookie-comma-quoted-both',
        payload: 'Cookie: "sid=abc", "csrf=myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'setcookie-comma-httponly',
        payload: 'Set-Cookie: sid=abc, HttpOnly; csrf=myVal9911 debug',
        secrets: ['myval9911'],
      },
      {
        name: 'cookie-folded-hash-comment',
        payload: 'Cookie: sid=abc12345;\n  # comment\n  csrf="hunter99" debug',
        secrets: ['abc12345', 'hunter99', 'comment'],
      },

      // Area 4: Unified digit-separated secret stems, casing transitions, apikeys/creds & mid-suffix digits
      { name: 'pw-myA1token-eqeq', payload: 'password=myA1token== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1token2val-eqeq', payload: 'password=myApp1token2val== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1apiKEY-eqeq', payload: 'password=myApp1apiKEY== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1apikeys-eqeq', payload: 'password=myApp1apikeys== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1creds-eqeq', payload: 'password=myApp1creds== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-x1KEY-eqeq', payload: 'password=x1KEY== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-v1KEY-eqeq', payload: 'password=v1KEY== hunter99 debug', secrets: ['hunter99'] },
      { name: 'direct-myApp1creds-eq', payload: 'myApp1creds=hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1hmacKEY-eqeq', payload: 'password=myApp1hmacKEY== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-myApp1dbKEY-eqeq', payload: 'password=myApp1dbKEY== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-a1DB1password-eqeq', payload: 'password=a1DB1password== myVal9911 debug', secrets: ['myval9911'] },
      { name: 'pw-myApp1secretkey-eqeq', payload: 'password=myApp1secretkey== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1authkey-eqeq', payload: 'password=myApp1authkey== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1accesskey-eqeq', payload: 'password=myApp1accesskey== hunter99 debug', secrets: ['hunter99'] },
      { name: 'pw-myApp1sessionid-eqeq', payload: 'password=myApp1sessionid== hunter99 debug', secrets: ['hunter99'] },

      // Area 6: Subscript + dot-property chains, empty [], $idx, quoted base subscripts & multi-segment provenance
      {
        name: 'url-semi-env0-dot-apikey',
        payload: 'https://example.com/a;env[0].api_key="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-semi-envprod-dot-apikey',
        payload: 'https://example.com/a;env["prod"].api_key="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'direct-env0-dot-apikey',
        payload: 'env[0].api_key="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'data-token-cookies-provenance',
        payload: 'data["token"]["cookies"]=sid=abc12345; csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'quoted-base-env-apikey',
        payload: '"env"["API_KEY"]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-quoted-base-env-apikey',
        payload: 'https://example.com/a;"env"["API_KEY"]="myVal9911" debug',
        secrets: ['myval9911'],
      },
      {
        name: 'empty-bracket-apikey',
        payload: 'api_key[]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'empty-bracket-tokens',
        payload: 'tokens[]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'empty-bracket-secrets',
        payload: 'secrets[]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-empty-bracket-apikey',
        payload: 'https://example.com/a;api_key[]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-empty-bracket-tokens',
        payload: 'https://example.com/a;tokens[]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'url-comma-empty-bracket-secrets',
        payload: 'https://example.com/a,secrets[]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'quoted-base-apikey-0',
        payload: '"api_key"[0]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'quoted-base-secret-0',
        payload: '"secret"[0]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'env-secret-empty-bracket',
        payload: 'env["secret"][]="hunter99" debug',
        secrets: ['hunter99'],
      },
      {
        name: 'quoted-base-cookies-0',
        payload: '"cookies"[0]=sid=abc12345; csrf=xyz78901 debug',
        secrets: ['abc12345', 'xyz78901'],
      },
      {
        name: 'env-dollar-idx-apikey',
        payload: 'env[$idx]["api_key"]="hunter99" debug',
        secrets: ['hunter99'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i15-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    for (const badToken of [
      'myA1token', 'myApp1token2val', 'myApp1apiKEY', 'myApp1apikeys', 'myApp1creds',
      'x1KEY', 'v1KEY', 'myApp1hmacKEY', 'myApp1dbKEY', 'a1DB1password',
      'myApp1secretkey', 'myApp1authkey', 'myApp1accesskey', 'myApp1sessionid',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }
    expect(sanitizeInterestToken('oauth', scope)).toBe('oauth')
    expect(sanitizeInterestToken('tokenizer', scope)).toBe('tokenizer')
    expect(scrubInterestText('token=YWJjZA== debug', scope)).toBe('  debug')
    expect(scrubInterestText('token=dG9rZW4token== debug', scope)).toBe('  debug')
    expect(scrubInterestText('Authorization:\n  topic: kubernetes', scope)).toBe(
      'Authorization:\n  topic: kubernetes',
    )
    expect(scrubInterestText('Authorization:\n  // comment\n  topic: kubernetes', scope)).toBe(
      'Authorization:\n  // comment\n  topic: kubernetes',
    )
    expect(scrubInterestText('Authorization:\n  learn how RBAC works', scope)).toBe(
      'Authorization:\n  learn how RBAC works',
    )
    expect(scrubInterestText('Cookie: sid=abc12345;\n  learn how RBAC works', scope)).toBe(
      ' ;\n  learn how RBAC works',
    )
  })

  test('scrubs .env/YAML/camelCase pass & key assignments, CLI -u/--user basic auth, ya29/npm/whsec prefixes, K8s/ECS name+value pairs, and standalone PEM blocks while preserving prose (Iter 16)', () => {
    const scope = makeScope('scrub-iter16-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 18, 0, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
      readonly expectDebug?: boolean
    }> = [
      // 1. .env / YAML / camelCase pass & key assignments
      { name: 'env-db-pass', payload: 'DB_PASS=myVal9911 debug', secrets: ['myval9911'] },
      { name: 'env-redis-pass', payload: 'REDIS_PASS=myVal9911 debug', secrets: ['myval9911'] },
      { name: 'env-smtp-pass', payload: 'SMTP_PASS=myVal9911 debug', secrets: ['myval9911'] },
      {
        name: 'yaml-api-key-db-pass',
        payload: 'data:\n  API_KEY: bXlWYWw5OTEx\n  DB_PASS: c2VjcmV0OTk=\ndebug',
        secrets: ['bxlwyww5otex', 'c2vjcmv0otk'],
      },
      { name: 'camel-db-pass', payload: 'dbPass="myVal9911" debug', secrets: ['myval9911'] },
      { name: 'env-jwt-key', payload: 'JWT_KEY=myVal9911 debug', secrets: ['myval9911'] },
      { name: 'env-deploy-key', payload: 'DEPLOY_KEY=myVal9911 debug', secrets: ['myval9911'] },
      { name: 'env-jwt-secret', payload: 'jwt_secret="myVal9911" debug', secrets: ['myval9911'] },

      // 2. CLI basic-auth flags
      {
        name: 'curl-u-url',
        payload: 'curl -u alice:myVal9911 https://api.example.com/v1/users debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'bare-u-flag',
        payload: '-u alice:myCurlPass99 debug',
        secrets: ['alice', 'mycurlpass99'],
      },
      {
        name: 'curl-long-user-space',
        payload: 'curl --user alice:myVal9911 https://api.example.com/v1/users debug',
        secrets: ['alice', 'myval9911'],
      },
      {
        name: 'curl-long-user-eq',
        payload: 'curl --user=alice:myPass9911 https://api.example.com/v1/users debug',
        secrets: ['alice', 'mypass9911'],
      },
      {
        name: 'curl-u-quoted',
        payload: 'curl -u "alice:mySec 9911" debug',
        secrets: ['alice', 'mysec', '9911'],
      },

      // 3. API token prefixes
      { name: 'prefix-npm', payload: 'npm_abc123456789 debug', secrets: ['npm_abc123456789'] },
      { name: 'prefix-whsec', payload: 'whsec_abc123456789 debug', secrets: ['whsec_abc123456789'] },
      {
        name: 'prefix-ya29',
        payload: 'token error ya29.a0AbCdEf1234567890 debug',
        secrets: ['a0abcdef1234567890'],
      },

      // 4. K8s / ECS / CI { name: <SECRET_KEY>, value: <secret> } YAML & JSON pairs
      {
        name: 'k8s-yaml-api-key',
        payload: '- name: API_KEY\n  value: myK8sSec99\ndebug',
        secrets: ['myk8ssec99'],
      },
      {
        name: 'k8s-yaml-db-password',
        payload: '- name: DB_PASSWORD\n  value: myGhSec99\ndebug',
        secrets: ['myghsec99'],
      },
      {
        name: 'json-api-key-value',
        payload: '{"name": "API_KEY", "value": "myJsonSec99"} debug',
        secrets: ['myjsonsec99'],
      },
      {
        name: 'json-db-pass-with-intervening-prop',
        payload: '{"name": "DB_PASS", "type": "secret", "value": "myJsonPass99"} debug',
        secrets: ['myjsonpass99'],
      },
      {
        name: 'yaml-indented-key-jwt',
        payload: 'env:\n  - key: JWT_KEY\n    value: myJwtSec99\ndebug',
        secrets: ['myjwtsec99'],
      },

      // 5. Standalone unkeyed PEM private key blocks
      {
        name: 'pem-rsa-standalone',
        payload:
          '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA99\n-----END RSA PRIVATE KEY-----\ndebug',
        secrets: ['miieowibaakcaqea99'],
      },
      {
        name: 'pem-pgp-standalone',
        payload:
          '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGSecretKeyData99\n-----END PGP PRIVATE KEY BLOCK-----\ndebug',
        secrets: ['lqoybgsecretkeydata99'],
      },
      {
        name: 'pem-unclosed-standalone',
        payload: '-----BEGIN PRIVATE KEY-----\nx9Km2pQ1vR8s\ndebug',
        secrets: ['x9km2pq1vr8s'],
        expectDebug: false,
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      if (tc.expectDebug !== false) {
        expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')
      }

      for (const title of ['', 'rust', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i16-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    for (const badToken of [
      'DB_PASS',
      'db_pass',
      'dbPass',
      'JWT_KEY',
      'DEPLOY_KEY',
      'jwt_secret',
      'npm_abc123456789',
      'whsec_abc123456789',
      'ya29.a0AbCdEf1234567890',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }

    expect(sanitizeInterestToken('oauth', scope)).toBe('oauth')
    expect(sanitizeInterestToken('tokenizer', scope)).toBe('tokenizer')
    expect(scrubInterestText('how to pass unit tests', scope)).toBe('how to pass unit tests')
    expect(scrubInterestText('bypass=true', scope)).toBe('bypass=true')
    expect(scrubInterestText('git push -u origin main', scope)).toBe('git push -u origin main')
    expect(scrubInterestText('{"name": "NODE_ENV", "value": "production"}', scope)).toBe(
      '{"name": "NODE_ENV", "value": "production"}',
    )
    expect(scrubInterestText('- name: LOG_LEVEL\n  value: info', scope)).toBe(
      '- name: LOG_LEVEL\n  value: info',
    )
  })

  test('scrubs passphrase keys, standard crypto/app keys, and single-sided CLI basic-auth while preserving prose and non-secret keys (Iter 17)', () => {
    const scope = makeScope('scrub-iter17-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 18, 30, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      // 1. Passphrase / SSH_PASSPHRASE / GPG_PASSPHRASE / camelCase / YAML
      { name: 'env-ssh-passphrase', payload: 'SSH_PASSPHRASE=myPhrase99 debug', secrets: ['myphrase99'] },
      { name: 'env-gpg-passphrase', payload: 'GPG_PASSPHRASE=myGpgPhrase99 debug', secrets: ['mygpgphrase99'] },
      { name: 'quoted-passphrase', payload: 'passphrase="tr0ub4dor99" debug', secrets: ['tr0ub4dor99'] },
      { name: 'plural-passphrases', payload: 'passphrases="multiPhrase99" debug', secrets: ['multiphrase99'] },
      { name: 'yaml-ssh-passphrase', payload: 'ssh:\n  passphrase: myYamlPhrase99\ndebug', secrets: ['myyamlphrase99'] },
      { name: 'camel-ssh-passphrase', payload: 'sshPassphrase="myCamelPhrase99" debug', secrets: ['mycamelphrase99'] },

      // 2. APP_KEY / HMAC_KEY / TLS_KEY / SSL_KEY / AES_KEY / KMS_KEY
      { name: 'env-app-key-base64', payload: 'APP_KEY=base64:dGhpc0lzQVRlc3Q= debug', secrets: ['dghpc0lzqvrlc3q'] },
      { name: 'env-app-key', payload: 'APP_KEY=xk9mp2vr8s debug', secrets: ['xk9mp2vr8s'] },
      { name: 'env-hmac-key', payload: 'HMAC_KEY=myHmacKey99 debug', secrets: ['myhmackey99'] },
      { name: 'env-tls-key', payload: 'TLS_KEY=myTlsKey99 debug', secrets: ['mytlskey99'] },
      { name: 'env-ssl-key', payload: 'SSL_KEY=mySslKey99 debug', secrets: ['mysslkey99'] },
      { name: 'env-aes-key', payload: 'AES_KEY=myAesKey99 debug', secrets: ['myaeskey99'] },
      { name: 'env-kms-key', payload: 'KMS_KEY=myKmsKey99 debug', secrets: ['mykmskey99'] },
      { name: 'camel-hmac-key', payload: 'hmacKey="myCamelHmac99" debug', secrets: ['mycamelhmac99'] },

      // 3. Single-sided CLI basic-auth flags (-u / --user)
      {
        name: 'curl-u-leading-colon',
        payload: 'curl -u :xk9mp2vr8s https://api.stripe.com/v1/charges debug',
        secrets: ['xk9mp2vr8s'],
      },
      {
        name: 'curl-u-trailing-colon',
        payload: 'curl -u xk9mp2vr8s: https://api.stripe.com/v1/charges debug',
        secrets: ['xk9mp2vr8s'],
      },
      {
        name: 'curl-long-user-eq-leading-colon',
        payload: 'curl --user=:xk9mp2vr8s https://api.stripe.com/v1/charges debug',
        secrets: ['xk9mp2vr8s'],
      },
      {
        name: 'curl-long-user-quoted-trailing-colon',
        payload: 'curl --user "xk9mp2vr8s:" https://api.stripe.com/v1/charges debug',
        secrets: ['xk9mp2vr8s'],
      },
      {
        name: 'curl-u-single-quoted-leading-colon',
        payload: "curl -u ':mySec 9911' debug",
        secrets: ['mysec', '9911'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 20,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i17-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    for (const badToken of [
      'PASSPHRASE',
      'passphrases',
      'SSH_PASSPHRASE',
      'sshPassphrase',
      'APP_KEY',
      'app_key',
      'appkey',
      'HMAC_KEY',
      'hmac-key',
      'TLS_KEY',
      'SSL_KEY',
      'AES_KEY',
      'KMS_KEY',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }

    // Preserve non-secret keys, standalone crypto/app prose terms, and git -u flags
    for (const safeToken of [
      'app',
      'hmac',
      'tls',
      'ssl',
      'aes',
      'kms',
      'primary_key',
      'foreign_key',
      'cache_key',
      'public_key',
    ]) {
      expect(sanitizeInterestToken(safeToken, scope), `expected preservation of ${safeToken}`).toBe(safeToken)
    }
    expect(scrubInterestText('how to configure ssh passphrase authentication', scope)).toBe(
      'how to configure ssh passphrase authentication',
    )
    expect(scrubInterestText('primary_key=id', scope)).toBe('primary_key=id')
    expect(scrubInterestText('cache_key=v1', scope)).toBe('cache_key=v1')
    expect(scrubInterestText('how to configure tls in rust', scope)).toBe('how to configure tls in rust')
    expect(scrubInterestText('hmac sha256 verification', scope)).toBe('hmac sha256 verification')
    expect(scrubInterestText('git push -u origin main', scope)).toBe('git push -u origin main')
    expect(scrubInterestText('git push -u origin feat:main', scope)).toBe('git push -u origin feat:main')
  })

  test('scrubs .env token-prefix key names, client_key, ssh-keygen --passphrase/--password, and FERNET_KEY/CIPHER_KEY while preserving prose (Iter 18)', () => {
    const scope = makeScope('scrub-iter18-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 19, 0, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
      readonly expectDebug?: boolean
    }> = [
      // 1. Token-prefix .env / JSON / K8s assignments & standalone prefixes
      { name: 'env-npm-token', payload: 'NPM_TOKEN=npmTokVal99 debug', secrets: ['npmtokval99'] },
      { name: 'env-sk-secret', payload: 'SK_SECRET=skSecVal99 debug', secrets: ['sksecval99'] },
      { name: 'env-whsec-secret', payload: 'WHSEC_SECRET=whEnvVal99 debug', secrets: ['whenvval99'] },
      { name: 'env-ghp-token', payload: 'GHP_TOKEN=ghpEnvVal99 debug', secrets: ['ghpenvval99'] },
      { name: 'env-pk-key', payload: 'PK_KEY=pkVal99 debug', secrets: ['pkval99'] },
      { name: 'env-npm-prefix-val', payload: 'NPM_TOKEN=npm_abc123456789 debug', secrets: ['npm_abc123456789'] },
      { name: 'json-npm-token', payload: '{"NPM_TOKEN": "npmTokVal99"} debug', secrets: ['npmtokval99'] },
      { name: 'k8s-npm-token', payload: '- name: NPM_TOKEN\n  value: npmTokVal99\ndebug', secrets: ['npmtokval99'] },
      { name: 'standalone-npm-prefix', payload: 'npm_abc123456789 debug', secrets: ['npm_abc123456789'] },
      { name: 'colon-after-ghp-prefix', payload: 'Error ghp_1234567890abcdef: expired debug', secrets: ['ghp_1234567890abcdef'] },

      // 2. client_key / clientKey / CLIENT_KEY
      { name: 'snake-client-key', payload: 'client_key="cliKeySec99" debug', secrets: ['clikeysec99'] },
      { name: 'camel-client-key', payload: 'clientKey="cliKeySec99" debug', secrets: ['clikeysec99'] },
      { name: 'env-client-key', payload: 'CLIENT_KEY=cliKeySec99 debug', secrets: ['clikeysec99'] },

      // 3. ssh-keygen --passphrase/--password & anchored ssh_key
      {
        name: 'ssh-keygen-passphrase',
        payload: 'ssh-keygen --passphrase cliPhraseSec99 debug',
        secrets: ['cliphrasesec99'],
      },
      {
        name: 'ssh-keygen-password',
        payload: 'ssh-keygen --password cliPwdSec99 debug',
        secrets: ['clipwdsec99'],
      },
      { name: 'env-ssh-key', payload: 'SSH_KEY=sshKeyVal99 debug', secrets: ['sshkeyval99'] },
      { name: 'snake-ssh-key', payload: 'ssh_key="sshKeyVal99" debug', secrets: ['sshkeyval99'] },
      { name: 'dash-ssh-key', payload: 'ssh-key: sshKeyVal99 debug', secrets: ['sshkeyval99'] },
      { name: 'versioned-ssh-key', payload: 'my_ssh_key_v1="sshKeyVal99" debug', secrets: ['sshkeyval99'] },

      // 4. FERNET_KEY & CIPHER_KEY
      { name: 'env-fernet-key', payload: 'FERNET_KEY=fernetKeyVal99 debug', secrets: ['fernetkeyval99'] },
      { name: 'env-cipher-key', payload: 'CIPHER_KEY=cipherKeyVal99 debug', secrets: ['cipherkeyval99'] },
      { name: 'camel-fernet-key', payload: 'fernetKey="fernetKeyVal99" debug', secrets: ['fernetkeyval99'] },
      { name: 'camel-cipher-key', payload: 'cipherKey="cipherKeyVal99" debug', secrets: ['cipherkeyval99'] },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 25,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      if (tc.expectDebug !== false) {
        expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')
      }

      for (const title of ['', 'rust', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i18-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    for (const badToken of [
      'CLIENT_KEY',
      'client_key',
      'client-key',
      'clientkey',
      'SSH_KEY',
      'ssh_key',
      'ssh-key',
      'my_ssh_key_v1',
      'FERNET_KEY',
      'fernet_key',
      'fernet-key',
      'fernetkey',
      'CIPHER_KEY',
      'cipher_key',
      'cipher-key',
      'cipherkey',
      'PK_KEY',
      'pk_key',
      'pk-key',
      'pkkey',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }

    for (const safeToken of ['client', 'fernet', 'cipher', 'ssh-keygen']) {
      expect(sanitizeInterestToken(safeToken, scope), `expected preservation of ${safeToken}`).toBe(safeToken)
    }
    expect(scrubInterestText('npm-run-all build', scope)).toBe('npm-run-all build')
    expect(scrubInterestText('http client connection pooling', scope)).toBe('http client connection pooling')
    expect(scrubInterestText('fernet symmetric encryption guide', scope)).toBe(
      'fernet symmetric encryption guide',
    )
    expect(scrubInterestText('block cipher padding mode', scope)).toBe('block cipher padding mode')
  })

  test('scrubs sibling <TOKEN_PREFIX>_KEY assignments, attached curl -u:key / -uuser:pass, and ssh-keygen -N/-P + docker login -p/--password while preserving prose (Iter 19)', () => {
    const scope = makeScope('scrub-iter19-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 20, 0, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
      readonly expectDebug?: boolean
    }> = [
      // 1. Sibling <TOKEN_PREFIX>_KEY across .env, JSON, K8s YAML, camelCase
      { name: 'env-sk-key', payload: 'SK_KEY=skKeyVal99 debug', secrets: ['skkeyval99'] },
      { name: 'env-whsec-key', payload: 'WHSEC_KEY=whKeyVal99 debug', secrets: ['whkeyval99'] },
      { name: 'env-rk-key', payload: 'RK_KEY=rkKeyVal99 debug', secrets: ['rkkeyval99'] },
      { name: 'env-ghp-key', payload: 'GHP_KEY=ghpKeyVal99 debug', secrets: ['ghpkeyval99'] },
      { name: 'env-gho-key', payload: 'GHO_KEY=ghoKeyVal99 debug', secrets: ['ghokeyval99'] },
      { name: 'env-ghu-key', payload: 'GHU_KEY=ghuKeyVal99 debug', secrets: ['ghukeyval99'] },
      { name: 'env-ghs-key', payload: 'GHS_KEY=ghsKeyVal99 debug', secrets: ['ghskeyval99'] },
      { name: 'env-ghr-key', payload: 'GHR_KEY=ghrKeyVal99 debug', secrets: ['ghrkeyval99'] },
      { name: 'env-npm-key', payload: 'NPM_KEY=npmKeyVal99 debug', secrets: ['npmkeyval99'] },
      { name: 'env-glpat-key', payload: 'GLPAT_KEY=glpatKeyVal99 debug', secrets: ['glpatkeyval99'] },
      { name: 'env-github-pat-key', payload: 'GITHUB_PAT_KEY=patKeyVal99 debug', secrets: ['patkeyval99'] },
      { name: 'env-xoxb-key', payload: 'XOXB_KEY=xoxbKeyVal99 debug', secrets: ['xoxbkeyval99'] },
      { name: 'env-xoxp-key', payload: 'XOXP_KEY=xoxpKeyVal99 debug', secrets: ['xoxpkeyval99'] },
      { name: 'camel-sk-key', payload: 'skKey="skCamelVal99" debug', secrets: ['skcamelval99'] },
      { name: 'camel-github-pat-key', payload: 'githubPatKey="patCamelVal99" debug', secrets: ['patcamelval99'] },
      { name: 'json-sk-whsec-key', payload: '{"SK_KEY": "jsonSkVal99", "WHSEC_KEY": "jsonWhVal99"} debug', secrets: ['jsonskval99', 'jsonwhval99'] },
      { name: 'k8s-sk-key', payload: '- name: SK_KEY\n  value: k8sSkVal99\ndebug', secrets: ['k8sskval99'] },
      { name: 'k8s-json-sk-key', payload: '{"name": "SK_KEY", "value": "skK8sKey99"} debug', secrets: ['skk8skey99'] },
      { name: 'colon-after-ghp-token-still-scrubbed', payload: 'Error ghp_1234567890abcdef: expired debug', secrets: ['ghp_1234567890abcdef'] },
      { name: 'colon-after-github-pat-still-scrubbed', payload: 'Error github_pat_1234567890abcdef: expired debug', secrets: ['github_pat_1234567890abcdef'] },

      // 2. Attached curl -u:key and curl -u<user>:<pass>
      { name: 'curl-attached-u-colon', payload: 'curl -u:attKey77 https://api.example.com debug', secrets: ['attkey77'] },
      { name: 'curl-attached-u-colon-quoted', payload: 'curl -u:"attKey 77" https://api.example.com debug', secrets: ['attkey', '77'] },
      { name: 'curl-attached-u-quote-colon', payload: 'curl -u":attKey 77" https://api.example.com debug', secrets: ['attkey', '77'] },
      { name: 'curl-attached-u-user-pass', payload: 'curl -ualice:attPass66 https://api.example.com debug', secrets: ['ualice', 'attpass66'] },
      { name: 'curl-attached-u-user-quoted-pass', payload: 'curl -ualice:"attPass 66" https://api.example.com debug', secrets: ['ualice', 'attpass', '66'] },
      { name: 'curl-attached-u-quoted-pair', payload: 'curl -u"alice:attPass 66" https://api.example.com debug', secrets: ['alice', 'attpass', '66'] },
      { name: 'bare-attached-u-colon', payload: '-u:bareKey88 debug', secrets: ['barekey88'] },

      // 3. ssh-keygen -N/-P & docker login -p/--password
      { name: 'ssh-keygen-N-space', payload: 'ssh-keygen -t ed25519 -N sshNFlag99 debug', secrets: ['sshnflag99'] },
      { name: 'ssh-keygen-P-space', payload: 'ssh-keygen -t ed25519 -P sshPFlag99 debug', secrets: ['sshpflag99'] },
      { name: 'ssh-keygen-N-alpha-only', payload: 'ssh-keygen -t ed25519 -N alphaonlysecret debug', secrets: ['alphaonlysecret'] },
      { name: 'ssh-keygen-N-quoted-eq', payload: 'ssh-keygen -P="old pass" -N "new pass" debug', secrets: ['old', 'new', 'pass'] },
      { name: 'docker-login-p-space', payload: 'docker login -p dockerPass99 debug', secrets: ['dockerpass99'] },
      { name: 'docker-login-u-p-space', payload: 'docker login -u alice -p dockerPass99 debug', secrets: ['dockerpass99'] },
      { name: 'docker-login-password-long', payload: 'docker login --username alice --password dockerLongPass debug', secrets: ['dockerlongpass'] },
      { name: 'docker-login-password-eq-quoted', payload: 'docker login --password="eqval passval 99" debug', secrets: ['eqval', 'passval', '99'] },
      { name: 'backtick-wrapped-docker-login', payload: 'Run `docker login -p tickPass99` debug', secrets: ['tickpass99'] },
      { name: 'apostrophe-before-docker-login', payload: "don't run docker login -p apoPass99 debug", secrets: ['apopass99'] },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 25,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      if (tc.expectDebug !== false) {
        expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')
      }

      for (const title of ['', 'rust', 'rust cargo']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i19-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    for (const badToken of [
      'SK_KEY',
      'sk_key',
      'sk-key',
      'skkey',
      'SK_KEYS',
      'WHSEC_KEY',
      'RK_KEY',
      'GHP_KEY',
      'GHO_KEY',
      'GHU_KEY',
      'GHS_KEY',
      'GHR_KEY',
      'NPM_KEY',
      'GLPAT_KEY',
      'GITHUB_PAT_KEY',
      'githubPatKey',
      'XOXB_KEY',
      'XOXP_KEY',
      'XOXA_KEY',
      'XOXR_KEY',
    ]) {
      expect(sanitizeInterestToken(badToken, scope), `expected rejection for ${badToken}`).toBeNull()
    }

    // Exact preservation guarantees
    expect(scrubInterestText('npm-run-all build', scope)).toBe('npm-run-all build')
    expect(scrubInterestText('git push -u origin main', scope)).toBe('git push -u origin main')
    expect(scrubInterestText('git push -u origin feat:main', scope)).toBe('git push -u origin feat:main')
    expect(scrubInterestText('git checkout -b feat', scope)).toBe('git checkout -b feat')
    expect(scrubInterestText('primary_key=id', scope)).toBe('primary_key=id')
    expect(scrubInterestText('cache_key=v1', scope)).toBe('cache_key=v1')
    expect(scrubInterestText('ssh-keygen', scope)).toBe('ssh-keygen')
    expect(scrubInterestText('ssh-keygen -t ed25519', scope)).toBe('ssh-keygen -t ed25519')
    expect(scrubInterestText('docker login -u alice', scope)).toBe('docker login -u alice')
    expect(scrubInterestText('docker login -u alice --password-stdin', scope)).toBe(
      'docker login -u alice --password-stdin',
    )
    expect(scrubInterestText('docker run -p 8080:80 nginx', scope)).toBe('docker run -p 8080:80 nginx')
    expect(scrubInterestText('curl https://api.example.com; git push -u origin feat:main', scope)).toBe(
      'curl  ; git push -u origin feat:main',
    )
    expect(scrubInterestText('example base64 YWJjZA== usage', scope)).toBe('example base64 YWJjZA== usage')
    expect(scrubInterestText('{"name": "NODE_ENV", "value": "production"}', scope)).toBe(
      '{"name": "NODE_ENV", "value": "production"}',
    )
  })

  test('scrubs standalone pass assignments, curl -U / --proxy-user, and docker -H/-c/--tlscacert login -p while preserving prose and unrelated flags (Iter 20)', () => {
    const scope = makeScope('scrub-iter20-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 20, 30, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
      readonly expectDebug?: boolean
    }> = [
      // 1. Standalone pass assignments (.env, JSON, YAML, K8s JSON/YAML)
      { name: 'env-pass-upper', payload: 'PASS=envPassOnly99 debug', secrets: ['envpassonly99'] },
      { name: 'env-pass-lower', payload: 'pass=envLowerPass99 debug', secrets: ['envlowerpass99'] },
      { name: 'json-pass', payload: '{"pass": "jsonPassOnly99"} debug', secrets: ['jsonpassonly99'] },
      { name: 'yaml-pass', payload: 'pass: yamlPassOnly99\ndebug', secrets: ['yamlpassonly99'] },
      { name: 'k8s-json-pass', payload: '{"name": "PASS", "value": "k8sPass99"} debug', secrets: ['k8spass99'] },
      { name: 'k8s-yaml-pass', payload: '- name: PASS\n  value: k8sYamlPass99\ndebug', secrets: ['k8syamlpass99'] },

      // 2. Curl proxy basic-auth (-U / --proxy-user)
      { name: 'curl-U-space', payload: 'curl -U alice:proxyPass99 https://api.example.com debug', secrets: ['proxypass99'] },
      { name: 'curl-proxy-user-space', payload: 'curl --proxy-user alice:proxyLong99 https://api.example.com debug', secrets: ['proxylong99'] },
      { name: 'curl-proxy-user-eq', payload: 'curl --proxy-user=alice:proxyEq99 https://api.example.com debug', secrets: ['proxyeq99'] },
      { name: 'curl-proxy-user-mixed-quote', payload: 'curl --proxy-user alice:"proxyMix 99" https://api.example.com debug', secrets: ['proxymix', '99'] },
      { name: 'curl-U-eq', payload: 'curl -U=alice:proxyEqShort99 https://api.example.com debug', secrets: ['proxyeqshort99'] },
      { name: 'curl-U-colon-key', payload: 'curl -U:proxyKey99 https://api.example.com debug', secrets: ['proxykey99'] },
      { name: 'curl-U-attached', payload: 'curl -Ualice:proxyAtt99 https://api.example.com debug', secrets: ['ualice', 'proxyatt99'] },
      { name: 'curl-U-quoted', payload: 'curl -U "alice:proxyQuoted 99" https://api.example.com debug', secrets: ['proxyquoted', '99'] },
      { name: 'curl-U-attached-quoted', payload: 'curl -U":proxyKeyQ 99" https://api.example.com debug', secrets: ['proxykeyq', '99'] },

      // 3. docker -H tcp:// / unix:// / --tlscacert / -c login -p
      { name: 'docker-H-tcp-login-p', payload: 'docker -H tcp://127.0.0.1:2375 login -p dockerTcpPass99 debug', secrets: ['dockertcppass99'] },
      { name: 'docker-H-unix-login-p', payload: 'docker -H unix:///var/run/docker.sock login -p dockerSockPass99 debug', secrets: ['dockersockpass99'] },
      { name: 'docker-tlscacert-login-p', payload: 'docker --tlscacert /path/ca.pem login -p dockerTlsPass99 debug', secrets: ['dockertlspass99'] },
      { name: 'docker-c-login-p', payload: 'docker -c prod login -p dockerCtxPass99 debug', secrets: ['dockerctxpass99'] },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 25,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      if (tc.expectDebug !== false) {
        expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')
      }

      for (const title of ['', 'rust']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i20-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    // Exact preservation guarantees (prose, unrelated flags, bypass, sanitizeInterestToken)
    expect(sanitizeInterestToken('pass', scope)).toBe('pass')
    expect(scrubInterestText('pass the integration tests debug', scope)).toBe(
      'pass the integration tests debug',
    )
    expect(scrubInterestText('how to pass unit tests', scope)).toBe('how to pass unit tests')
    expect(scrubInterestText('bypass=true', scope)).toBe('bypass=true')
    expect(scrubInterestText('pip install -U pkg', scope)).toBe('pip install -U pkg')
    expect(scrubInterestText('docker run -p 8080:80 nginx', scope)).toBe('docker run -p 8080:80 nginx')
    expect(scrubInterestText('docker -c prod run -p 8080:80 nginx', scope)).toBe(
      'docker -c prod run -p 8080:80 nginx',
    )
    expect(scrubInterestText('docker login -u alice', scope)).toBe('docker login -u alice')
    expect(scrubInterestText('git push -u origin main', scope)).toBe('git push -u origin main')
    expect(scrubInterestText('git push -u origin feat:main', scope)).toBe('git push -u origin feat:main')
  })

  test('scrubs mixed-quoted and edge-case curl -u / --user credentials while preserving non-curl flags (Iter 21)', () => {
    const scope = makeScope('scrub-iter21-regressions')
    const nowMs = Date.UTC(2026, 10, 20, 21, 0, 0)

    const cases: ReadonlyArray<{
      readonly name: string
      readonly payload: string
      readonly secrets: readonly string[]
    }> = [
      {
        name: 'curl-u-space-dq-pass',
        payload: 'curl -u alice:"blue tiger99" https://api.example.com debug',
        secrets: ['alice', 'blue', 'tiger99'],
      },
      {
        name: 'curl-u-space-sq-pass',
        payload: "curl -u alice:'blue tiger99' https://api.example.com debug",
        secrets: ['alice', 'blue', 'tiger99'],
      },
      {
        name: 'curl-u-eq-dq-pass',
        payload: 'curl -u=alice:"blue tiger99" https://api.example.com debug',
        secrets: ['alice', 'blue', 'tiger99'],
      },
      {
        name: 'curl-user-space-dq-pass',
        payload: 'curl --user alice:"blue tiger99" https://api.example.com debug',
        secrets: ['alice', 'blue', 'tiger99'],
      },
      {
        name: 'curl-user-eq-dq-pass',
        payload: 'curl --user=alice:"blue tiger99" https://api.example.com debug',
        secrets: ['alice', 'blue', 'tiger99'],
      },
      {
        name: 'curl-u-space-dq-user',
        payload: 'curl -u "alice smith":blueTiger99 https://api.example.com debug',
        secrets: ['alice', 'smith', 'bluetiger99'],
      },
      {
        name: 'curl-u-attached-dq-user',
        payload: 'curl -u"alice smith":blueTiger99 https://api.example.com debug',
        secrets: ['alice', 'smith', 'bluetiger99'],
      },
      {
        name: 'curl-u-colon-dq-pass',
        payload: 'curl -u:"pass word" https://api.example.com debug',
        secrets: ['pass', 'word'],
      },
      {
        name: 'curl-user-colon-dq-pass',
        payload: 'curl --user:"pass word" https://api.example.com debug',
        secrets: ['pass', 'word'],
      },
      {
        name: 'curl-u-both-sq',
        payload: "curl -u 'alice smith':'blue tiger99' https://api.example.com debug",
        secrets: ['alice', 'smith', 'blue', 'tiger99'],
      },
    ]

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      maxInterestsPerRun: 25,
    })

    for (const tc of cases) {
      const scrubbed = scrubInterestText(tc.payload, scope).toLowerCase()
      for (const secret of tc.secrets) {
        expect(scrubbed, `expected ${tc.name} scrubInterestText to remove ${secret}`).not.toContain(secret)
      }
      expect(scrubbed, `expected ${tc.name} to preserve curl`).toContain('curl')
      expect(scrubbed, `expected ${tc.name} to preserve debug`).toContain('debug')

      for (const title of ['', 'rust']) {
        const { store } = openTempStore()
        seedNode(store, scope, {
          id: `a:g-i21-${tc.name}-${title.length}`,
          kind: 'goal',
          title,
          body: tc.payload,
          updatedAt: nowMs,
        })
        const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
        const urls = res.targets.map((t) => t.url.toLowerCase()).join(' ')
        for (const secret of tc.secrets) {
          expect(urls, `expected ${tc.name} (title="${title}") target URLs to remove ${secret}`).not.toContain(
            secret,
          )
        }
      }
    }

    // Exact preservation guarantees
    expect(scrubInterestText('git push -u origin main', scope)).toBe('git push -u origin main')
    expect(scrubInterestText('git push -u origin feat:main', scope)).toBe('git push -u origin feat:main')
    expect(scrubInterestText('pip install -U pkg', scope)).toBe('pip install -U pkg')
    expect(scrubInterestText('docker login -u alice', scope)).toBe('docker login -u alice')
    expect(scrubInterestText('docker run -p 8080:80 nginx', scope)).toBe('docker run -p 8080:80 nginx')
    expect(scrubInterestText('git checkout -b feat', scope)).toBe('git checkout -b feat')
    expect(scrubInterestText('curl --user-agent Mozilla5 debug', scope)).toBe('curl --user-agent Mozilla5 debug')
    expect(scrubInterestText('curl -u alice debug', scope)).toBe('curl -u alice debug')
  })
})

describe('web-learning gates & isolation contracts (T-S4-01, T-S4-02)', () => {
  test('T-S4-01/T-S4-02: fail-closed defaults, empty whitelist, emergency stop, interval, idle, route, and policy denials perform 0 runner calls', async () => {
    const { store } = openTempStore()
    const scope = makeScope('gates')
    const nowMs = Date.UTC(2026, 10, 20, 12, 0, 0)
    seedNode(store, scope, {
      id: 'a:g-1',
      kind: 'goal',
      title: 'Learn TypeScript compiler API',
      body: 'typescript compiler diagnostics',
      updatedAt: nowMs - 10_000_000,
    })

    const runnerSpy = vi.fn<WebLearningRunner['run']>()
    const runner: WebLearningRunner = { run: runnerSpy }
    const { policy, authorizeCalls } = makeAllowPolicyPeer()

    // 1. Default config is disabled
    const defaultCfg = normalizeAssociationWebLearningConfig()
    expect(defaultCfg.enabled).toBe(false)
    expect(defaultCfg.allowedDomains).toEqual([])
    const disabledRes = await runWebLearningPass({
      store,
      scope,
      config: defaultCfg,
      policy,
      runner,
      nowMs,
    })
    expect(disabledRes).toMatchObject({ ran: false, status: 'skipped', reason: 'disabled' })

    // 2. Root disabled overrides enabled webLearning
    const enabledCfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      idleMinMs: 0,
      intervalMs: 0,
    })
    const rootDisabledRes = await runWebLearningPass({
      store,
      scope,
      rootEnabled: false,
      config: enabledCfg,
      policy,
      runner,
      nowMs,
    })
    expect(rootDisabledRes).toMatchObject({ ran: false, status: 'skipped', reason: 'disabled' })

    // 3. Empty whitelist fails closed (T-S4-02)
    const emptyWhitelistCfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: [],
      idleMinMs: 0,
    })
    const emptyWlRes = await runWebLearningPass({
      store,
      scope,
      config: emptyWhitelistCfg,
      policy,
      runner,
      nowMs,
    })
    expect(emptyWlRes).toMatchObject({ ran: false, status: 'skipped', reason: 'empty-whitelist' })

    // 4. Emergency stop
    const emergencyRes = await runWebLearningPass({
      store,
      scope,
      config: enabledCfg,
      policy: { ...policy, getEmergencyStop: () => ({ enabled: true }) },
      runner,
      nowMs,
    })
    expect(emergencyRes).toMatchObject({ ran: false, status: 'skipped', reason: 'emergency-stop' })

    // 5. Interval not elapsed
    store.database
      .prepare(`
        INSERT INTO assoc_web_learning_runs (
          run_id, owner_scope_key, started_at, finished_at, status, reason,
          topics_considered, requests_used, pages_fetched, bytes_fetched, nodes_written, details_json
        ) VALUES ('prev-run', ?, ?, ?, 'completed', 'completed', 1, 1, 1, 100, 1, NULL)
      `)
      .run(scope.ownerScopeKey, nowMs - 5_000, nowMs - 4_000)
    const intervalCfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      intervalMs: 60_000,
      idleMinMs: 0,
    })
    const intervalRes = await runWebLearningPass({
      store,
      scope,
      config: intervalCfg,
      policy,
      runner,
      nowMs,
    })
    expect(intervalRes).toMatchObject({
      ran: false,
      status: 'skipped',
      reason: 'interval-not-elapsed',
    })

    // 6. Idle gate: agent-active and not-idle
    const idleCfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      intervalMs: 0,
      idleMinMs: 60_000,
    })
    const agentActiveRes = await runWebLearningPass({
      store,
      scope,
      config: idleCfg,
      policy,
      hasRunningAgent: true,
      lastActivityAt: nowMs - 120_000,
      runner,
      nowMs,
    })
    expect(agentActiveRes).toMatchObject({ ran: false, status: 'skipped', reason: 'agent-active' })

    const notIdleRes = await runWebLearningPass({
      store,
      scope,
      config: idleCfg,
      policy,
      hasRunningAgent: false,
      lastActivityAt: nowMs - 10_000,
      runner,
      nowMs,
    })
    expect(notIdleRes).toMatchObject({ ran: false, status: 'skipped', reason: 'not-idle' })

    // 7. Delivery route invalid / inactive
    const invalidDelivery: WebLearningDeliveryPeer = {
      validateOwnerRoute: () => {
        throw new Error('invalid route')
      },
    }
    const routeInvalidRes = await runWebLearningPass({
      store,
      scope,
      config: enabledCfg,
      policy,
      delivery: invalidDelivery,
      runner,
      nowMs,
    })
    expect(routeInvalidRes).toMatchObject({ ran: false, status: 'skipped', reason: 'route-invalid' })

    const inactiveDelivery: WebLearningDeliveryPeer = {
      validateOwnerRoute: () => ({ ok: true }),
      inspectOwnerRouteState: () => ({ status: 'paused' }),
    }
    const routeInactiveRes = await runWebLearningPass({
      store,
      scope,
      config: enabledCfg,
      policy,
      delivery: inactiveDelivery,
      runner,
      nowMs,
    })
    expect(routeInactiveRes).toMatchObject({
      ran: false,
      status: 'skipped',
      reason: 'route-inactive',
    })

    // Verify NONE of the cheap pre-gates above invoked side-effectful policy.authorize()!
    expect(authorizeCalls).toHaveLength(0)

    // 8. Policy unavailable
    const noPolicyRes = await runWebLearningPass({
      store,
      scope,
      config: enabledCfg,
      runner,
      nowMs,
    })
    expect(noPolicyRes).toMatchObject({
      ran: false,
      status: 'skipped',
      reason: 'policy-unavailable',
    })

    // 9. Budget unavailable / exhausted via policy.getBudgetConfig
    const budgetCfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      intervalMs: 0,
      idleMinMs: 0,
      budgetId: 'web-learn-budget',
      budgetAmount: 2,
    })
    const missingBudgetRes = await runWebLearningPass({
      store,
      scope,
      config: budgetCfg,
      policy: { ...policy, getBudgetConfig: () => undefined },
      runner,
      nowMs,
    })
    expect(missingBudgetRes).toMatchObject({
      ran: false,
      status: 'skipped',
      reason: 'budget-unavailable',
    })

    const exhaustedPolicyBudgetRes = await runWebLearningPass({
      store,
      scope,
      config: budgetCfg,
      policy: {
        ...policy,
        getBudgetConfig: () => ({
          id: 'web-learn-budget',
          metric: 'count',
          limit: 1,
          periodMs: 86_400_000,
          scope: 'background',
        }),
      },
      runner,
      nowMs,
    })
    expect(exhaustedPolicyBudgetRes).toMatchObject({
      ran: false,
      status: 'budget-exhausted',
      reason: 'budget-exhausted',
    })

    // 10. Real AssistantPolicyService default-deny -> policy-denied
    const realDenyPolicy = await createRealPolicyService([])
    const deniedRes = await runWebLearningPass({
      store,
      scope,
      config: enabledCfg,
      policy: realDenyPolicy,
      runner,
      nowMs,
    })
    expect(deniedRes).toMatchObject({
      ran: false,
      status: 'skipped',
      reason: 'policy-denied',
      policyReasonCode: 'default-deny',
    })

    expect(runnerSpy).not.toHaveBeenCalled()
    expect(store.countActiveNodes()).toBe(1) // only the seeded goal node
  })

  test('dry-check evaluateWebLearningGate checks policy.evaluate without calling policy.authorize', () => {
    const { store } = openTempStore()
    const scope = makeScope('dry')
    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      idleMinMs: 0,
    })
    const { policy, authorizeCalls, evaluateCalls } = makeAllowPolicyPeer()

    const decision = evaluateWebLearningGate({
      store,
      scope,
      config: cfg,
      policy,
      nowMs: Date.UTC(2026, 10, 20, 12, 0, 0),
    })

    expect(decision.allowed).toBe(true)
    expect(evaluateCalls).toHaveLength(1)
    expect(authorizeCalls).toHaveLength(0)

    const req = buildWebLearningPolicyRequest(scope)
    expect(req).toEqual({
      subject: {
        kind: 'background',
        id: 'assistant-association:web-learning',
        workspace: scope.workspace,
        principal: scope.principalId,
      },
      action: 'web.learn',
      resource: {
        kind: 'network',
        id: 'assistant-association:web-learning',
      },
      context: {
        initiator: 'background',
      },
    })
  })
})

describe('web-learning budget hard-stop, restart persistence, provenance & withdrawal (T-S4-08, T-S4-10/11)', () => {
  test('T-S4-08: mid-run budget exhaustion saves partial pages and persists exhaustion across SQLite reopen until next UTC day', async () => {
    const { dbPath, store: initialStore } = openTempStore()
    const scope = makeScope('budget')
    const day1 = Date.UTC(2026, 10, 20, 10, 0, 0)
    const day2 = Date.UTC(2026, 10, 21, 10, 0, 0)

    seedNode(initialStore, scope, {
      id: 'a:g-ts',
      kind: 'goal',
      title: 'TypeScript modules',
      body: 'typescript modules',
      updatedAt: day1 - 10_000,
    })
    seedNode(initialStore, scope, {
      id: 'a:g-vitest',
      kind: 'goal',
      title: 'Vitest mocking',
      body: 'vitest mocking',
      updatedAt: day1 - 20_000,
    })
    seedNode(initialStore, scope, {
      id: 'a:g-sqlite',
      kind: 'goal',
      title: 'SQLite transactions',
      body: 'sqlite transactions',
      updatedAt: day1 - 30_000,
    })

    let fetchCount = 0
    const makeRunner = () =>
      createInProcessWebLearningRunner({
        now: () => day1,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetcher: async (url) => {
          fetchCount += 1
          return new Response(
            `<html><head><title>Doc ${fetchCount}</title></head><body>Reference for ${url} typescript vitest sqlite</body></html>`,
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        },
      })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      isolationMode: 'in-process',
      intervalMs: 0,
      idleMinMs: 0,
      cooldownMs: 0,
      maxInterestsPerRun: 3,
      maxRequestsPerRun: 5,
      maxPagesPerRun: 2,
      maxRequestsPerDay: 2,
      maxBytesPerDay: 1_000_000,
      nodeTtlMs: 86_400_000,
    })

    const { policy } = makeAllowPolicyPeer()

    const run1 = await runWebLearningPass({
      store: initialStore,
      scope,
      config: cfg,
      policy,
      runner: makeRunner(),
      nowMs: day1,
    })

    // Stopped immediately at 2 pages / 2 requests!
    expect(run1.ran).toBe(true)
    expect(run1.status).toBe('budget-exhausted')
    expect(run1.requestsUsed).toBe(2)
    expect(run1.pagesFetched).toBe(2)
    expect(run1.nodesWritten).toBe(2)
    expect(fetchCount).toBe(2)

    const usageDay1 = getWebLearningBudgetUsage(initialStore, scope.ownerScopeKey, day1)
    expect(usageDay1.requestsUsed).toBe(2)
    expect(usageDay1.pagesFetched).toBe(2)
    expect(usageDay1.utcDay).toBe('2026-11-20')

    // Close DB and reopen fresh instance (simulating process restart)
    initialStore.close()
    const reopenedStore = new AssociationStore(openAssociationDatabase(dbPath))
    stores.push(reopenedStore)

    const spyRunner: WebLearningRunner = {
      run: vi.fn(async () => {
        throw new Error('should not execute when daily budget exhausted')
      }),
    }

    const run2SameDay = await runWebLearningPass({
      store: reopenedStore,
      scope,
      config: cfg,
      policy,
      runner: spyRunner,
      nowMs: day1 + 60_000,
    })
    expect(run2SameDay).toMatchObject({
      ran: false,
      status: 'budget-exhausted',
      reason: 'daily-budget-exhausted',
      requestsUsed: 0,
      pagesFetched: 0,
      nodesWritten: 0,
    })
    expect(spyRunner.run).not.toHaveBeenCalled()

    // Next UTC day resets daily allowance
    const run3NextDay = await runWebLearningPass({
      store: reopenedStore,
      scope,
      config: cfg,
      policy,
      runner: createInProcessWebLearningRunner({
        now: () => day2,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetcher: async () =>
          new Response(
            '<html><head><title>Day 2 Doc</title></head><body>Fresh day 2 typescript guide</body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          ),
      }),
      nowMs: day2,
    })
    expect(run3NextDay.ran).toBe(true)
    expect(run3NextDay.dailyUsage.utcDay).toBe('2026-11-21')
    expect(run3NextDay.dailyUsage.requestsUsed).toBe(2)
  })

  test('writes trust:low web nodes with sourceUrl/fetchedAt/expiresAt, entity edges, assoc_derived_from, and supports withdrawal & abort safety', async () => {
    const { store } = openTempStore()
    const scope = makeScope('provenance')
    const nowMs = Date.UTC(2026, 10, 20, 14, 0, 0)

    seedNode(store, scope, {
      id: 'a:g-entity-peer',
      kind: 'goal',
      title: 'TypeScript AST Guide',
      body: 'Explore typescript compiler ast transforms',
      entities: ['typescript', 'compiler'],
      updatedAt: nowMs - 10_000,
    })

    const policy = await createRealPolicyService([
      {
        id: 'allow-web-learn',
        effect: 'allow',
        subject: { kind: 'background', id: 'assistant-association:web-learning' },
        actions: ['web.learn'],
        resource: { kind: 'network', id: 'assistant-association:web-learning' },
        context: { initiators: ['background'] },
      },
    ])

    const ttlMs = 7 * 86_400_000
    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      isolationMode: 'in-process',
      intervalMs: 0,
      idleMinMs: 0,
      nodeTtlMs: ttlMs,
    })

    const enqueuedBatches: number[] = []
    const result = await runWebLearningPass({
      store,
      scope,
      config: cfg,
      policy,
      nowMs,
      workerDeps: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetcher: async () =>
          new Response(
            '<html><head><title>TypeScript Compiler Handbook</title></head><body>Guide for typescript compiler APIs and transforms.</body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          ),
      },
      enqueueUpsertNodes: (batch) => {
        enqueuedBatches.push(batch.nodes.length)
        store.upsertBatch(batch)
      },
    })

    expect(result.ran).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.nodesWritten).toBe(1)
    expect(result.edgesWritten).toBe(1)
    expect(enqueuedBatches).toEqual([1])

    const webNodeId = result.writtenNodeIds[0]!
    const stored = store.getNodeById(webNodeId)
    expect(stored).not.toBeNull()
    expect(stored!.kind).toBe('web')
    expect(stored!.trust).toBe('low')
    expect(stored!.sensitivity).toBe('private')
    expect(stored!.sourcePlugin).toBe(WEB_LEARNING_SOURCE_PLUGIN)
    expect(stored!.metadata.sourceUrl).toMatch(/^https:\/\/docs\.example\.com\/search\?q=/u)
    expect(stored!.metadata.fetchedAt).toBe(nowMs)
    expect(stored!.ttlMs).toBe(ttlMs)
    expect(stored!.expiresAt).toBe(nowMs + ttlMs)

    // Verify entity edge + bidirectional assoc_derived_from refs
    const edges = store.loadActiveEdgesPage(20, 0)
    expect(edges).toHaveLength(1)
    expect(edges[0]!.edgeType).toBe('entity')
    expect(edges[0]!.trust).toBe('low')

    const derivedRows = store.database
      .prepare('SELECT source_node_id, target_kind, target_id FROM assoc_derived_from WHERE target_id = ?')
      .all(edges[0]!.edgeId) as Array<{
      source_node_id: string
      target_kind: string
      target_id: string
    }>
    expect(derivedRows.map((r) => r.source_node_id).sort()).toEqual(
      [webNodeId, 'a:g-entity-peer'].sort(),
    )

    // Verify runs & fetches ledger queries
    const runs = listWebLearningRuns(store, scope.ownerScopeKey)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('completed')
    const fetches = listWebLearningFetches(store, scope.ownerScopeKey)
    expect(fetches).toHaveLength(1)
    expect(fetches[0]!.nodeId).toBe(webNodeId)
    expect(fetches[0]!.domain).toBe('docs.example.com')

    // Withdrawal by URL cascade-deletes web node + entity edge and creates tombstone
    const withdrawal = withdrawWebSourceByUrl(
      store,
      scope,
      `${stored!.metadata.sourceUrl!}#section-1`,
      nowMs + 1_000,
    )
    expect(withdrawal.deletedNodeIds).toContain(webNodeId)
    expect(withdrawal.deletedEdgeIds).toContain(edges[0]!.edgeId)
    expect(store.getNodeById(webNodeId)).toBeNull()
    expect(store.loadActiveEdgesPage(20, 0)).toHaveLength(0)
    expect(
      store.isSourceWithdrawn(scope.ownerScopeKey, WEB_LEARNING_SOURCE_PLUGIN, stored!.sourceRef),
    ).toBe(true)

    // Aborted run after runner completes must NOT write late nodes
    const controller = new AbortController()
    const abortingRunner: WebLearningRunner = {
      run: async (plan) => {
        controller.abort()
        return {
          runId: plan.runId,
          status: 'completed',
          reason: 'completed',
          startedAt: nowMs + 2_000,
          finishedAt: nowMs + 2_100,
          requestsUsed: 1,
          pagesFetched: 1,
          bytesFetched: 100,
          pages: [
            {
              sourceUrl: 'https://docs.example.com/late',
              finalUrl: 'https://docs.example.com/late',
              fetchedAt: nowMs + 2_050,
              title: 'Late Page',
              text: 'Should be suppressed by AbortSignal',
              contentType: 'text/html',
              contentDigest: 'b'.repeat(64),
              bytesFetched: 100,
              interestKey: 'int-late',
              originNodeIds: [],
              links: [],
            },
          ],
          attempts: [],
          environmentProof: { pid: process.pid, cwd: process.cwd(), envKeys: [] },
        }
      },
    }
    const abortedRes = await runWebLearningPass({
      store,
      scope,
      config: normalizeAssociationWebLearningConfig({
        enabled: true,
        allowedDomains: ['docs.example.com'],
        seedUrls: ['https://docs.example.com/late'],
        isolationMode: 'in-process',
        intervalMs: 0,
        idleMinMs: 0,
        cooldownMs: 0,
      }),
      policy,
      runner: abortingRunner,
      signal: controller.signal,
      nowMs: nowMs + 2_000,
    })
    expect(abortedRes).toMatchObject({
      ran: false,
      status: 'failed',
      reason: 'aborted',
      nodesWritten: 0,
    })
    expect(store.getNodeById(abortedRes.writtenNodeIds[0] ?? 'nonexistent')).toBeNull()
  })

  test('clamps per-run budget to remaining daily bytes, blocks on byte exhaustion, cascades peer withdrawal, and skips empty targets cleanly', async () => {
    const { store } = openTempStore()
    const scope = makeScope('clamp-peer')
    const nowMs = Date.UTC(2026, 10, 20, 16, 0, 0)
    const { policy } = makeAllowPolicyPeer()

    seedNode(store, scope, {
      id: 'a:g-peer',
      kind: 'goal',
      title: 'Cordis Lifecycle',
      body: 'Understand cordis disposer lifecycle hooks',
      entities: ['cordis', 'lifecycle'],
      updatedAt: nowMs - 10_000,
    })

    // Empty seedUrls -> skipped 'no-targets'
    const noTargetRes = await runWebLearningPass({
      store,
      scope,
      config: normalizeAssociationWebLearningConfig({
        enabled: true,
        allowedDomains: ['docs.example.com'],
        seedUrls: [],
        intervalMs: 0,
        idleMinMs: 0,
      }),
      policy,
      nowMs,
    })
    expect(noTargetRes).toMatchObject({ ran: false, status: 'skipped', reason: 'no-targets' })

    // Seed remaining daily bytes = 250 out of 1000
    store.database
      .prepare(`
        INSERT INTO assoc_web_learning_budget_usage (
          owner_scope_key, utc_day, requests_used, pages_fetched, bytes_fetched, updated_at
        ) VALUES (?, '2026-11-20', 1, 1, 750, ?)
      `)
      .run(scope.ownerScopeKey, nowMs - 5_000)

    const seenPlans: Array<{ maxRequests: number; maxTotalBytes: number; maxBytesPerRequest: number }> = []
    const capturingRunner: WebLearningRunner = {
      run: async (plan) => {
        seenPlans.push({
          maxRequests: plan.budget.maxRequests,
          maxTotalBytes: plan.budget.maxTotalBytes,
          maxBytesPerRequest: plan.budget.maxBytesPerRequest,
        })
        return {
          runId: plan.runId,
          status: 'completed',
          reason: 'completed',
          startedAt: nowMs,
          finishedAt: nowMs + 10,
          requestsUsed: 1,
          pagesFetched: 1,
          bytesFetched: 250,
          pages: [
            {
              sourceUrl: plan.targets[0]!.url,
              finalUrl: plan.targets[0]!.url,
              fetchedAt: nowMs,
              title: 'Cordis Lifecycle Docs',
              text: 'Details about cordis lifecycle and disposer cleanup.',
              contentType: 'text/html',
              contentDigest: 'c'.repeat(64),
              bytesFetched: 250,
              interestKey: plan.targets[0]!.interestKey,
              originNodeIds: ['a:g-peer'],
              links: [],
            },
          ],
          attempts: [
            {
              url: plan.targets[0]!.url,
              finalUrl: plan.targets[0]!.url,
              interestKey: plan.targets[0]!.interestKey,
              ok: true,
              status: 200,
              bytesFetched: 250,
              requestsUsed: 1,
              fetchedAt: nowMs,
            },
          ],
          environmentProof: { pid: process.pid, cwd: process.cwd(), envKeys: [] },
        }
      },
    }

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      intervalMs: 0,
      idleMinMs: 0,
      cooldownMs: 0,
      maxRequestsPerRun: 5,
      maxRequestsPerDay: 10,
      maxBytesPerRequest: 5_000,
      maxTotalBytesPerRun: 10_000,
      maxBytesPerDay: 1_000,
    })

    const runRes = await runWebLearningPass({
      store,
      scope,
      config: cfg,
      policy,
      runner: capturingRunner,
      nowMs,
    })
    expect(runRes.ran).toBe(true)
    expect(seenPlans).toEqual([
      {
        maxRequests: 5, // min(5, 10 - 1)
        maxTotalBytes: 250, // min(10_000, 1_000 - 750)
        maxBytesPerRequest: 5_000, // preserved so worker distinguishes total byte exhaustion from per-request cap
      },
    ])
    expect(runRes.dailyUsage.bytesFetched).toBe(1_000)

    // Subsequent run fails on bytes_fetched >= maxBytesPerDay
    const blockedRes = await runWebLearningPass({
      store,
      scope,
      config: cfg,
      policy,
      runner: capturingRunner,
      nowMs: nowMs + 1_000,
    })
    expect(blockedRes).toMatchObject({
      ran: false,
      status: 'budget-exhausted',
      reason: 'daily-budget-exhausted',
    })
    expect(seenPlans).toHaveLength(1)

    // Withdrawing the peer goal node cascade-deletes the entity edge to the web node
    expect(store.loadActiveEdgesPage(20, 0)).toHaveLength(1)
    const peerWithdraw = store.withdrawSource({
      ownerScopeKey: scope.ownerScopeKey,
      sourcePlugin: 'test:goal',
      sourceRef: 'a:g-peer',
      hardDelete: true,
    })
    expect(peerWithdraw.deletedEdgeIds).toHaveLength(1)
    expect(store.loadActiveEdgesPage(20, 0)).toHaveLength(0)
    expect(store.getNodeById(runRes.writtenNodeIds[0]!)).not.toBeNull()
  })

  test('scrubs compound env vars, quoted/JSON secrets, and multi-word Authorization headers before extracting interests', () => {
    const { store } = openTempStore()
    const scope = makeScope('scrub-compound')
    const nowMs = Date.UTC(2026, 10, 20, 17, 0, 0)

    const payloadText = [
      'DATABASE_PASSWORD=dbPassWord1234',
      'MY_API_KEY=myApiKey88',
      'JWT_SECRET=jwtSecr3t99',
      'SERVICE_TOKEN=svcTok99',
      'DB_PWD=dbPwd99',
      'AWS_CREDENTIAL=awsCred99',
      'token="myQu0tedSecr3t"',
      "token='mySingleSecr3t'",
      '{"token":"jsonSecr3tVal","api_key":"jsonApiKey99"}',
      'Authorization: Bearer myshorttok',
      'Authorization: Basic dXNlcjpwYXNzMTIz',
      'Authorization: Token tokScheme99',
      'Authorization: ApiKey apiKeyScheme99',
      'vitest diagnostics',
    ].join(' ')

    const scrubbedDirect = scrubInterestText(payloadText, scope).toLowerCase()
    for (const leaked of [
      'dbpassword1234',
      'myapikey88',
      'jwtsecr3t99',
      'svctok99',
      'dbpwd99',
      'awscred99',
      'myqu0tedsecr3t',
      'mysinglesecr3t',
      'jsonsecr3tval',
      'jsonapikey99',
      'myshorttok',
      'dxnlcjpwyxnzmtiz',
      'tokscheme99',
      'apikeyscheme99',
    ]) {
      expect(scrubbedDirect, `expected scrubInterestText to remove ${leaked}`).not.toContain(leaked)
    }
    expect(scrubbedDirect).toContain('vitest')

    seedNode(store, scope, {
      id: 'a:g-scrub-secrets',
      kind: 'goal',
      title: 'Basic TypeScript Debugging',
      body: payloadText,
      updatedAt: nowMs - 1_000,
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.python.org'],
      seedUrls: ['https://docs.python.org/3/search.html?q={query}'],
      maxInterestsPerRun: 5,
    })

    const res = extractWebLearningInterests(store, scope, { config: cfg, nowMs })
    const serialized = JSON.stringify({ interests: res.interests, targets: res.targets }).toLowerCase()
    for (const leaked of [
      'dbpassword1234',
      'myapikey88',
      'jwtsecr3t99',
      'svctok99',
      'dbpwd99',
      'awscred99',
      'myqu0tedsecr3t',
      'mysinglesecr3t',
      'jsonsecr3tval',
      'jsonapikey99',
      'myshorttok',
      'dxnlcjpwyxnzmtiz',
      'tokscheme99',
      'apikeyscheme99',
    ]) {
      expect(serialized, `expected ${leaked} to be scrubbed`).not.toContain(leaked)
    }
    expect(serialized).toContain('basic')
    expect(serialized).toContain('typescript')
    expect(serialized).toContain('debugging')
  })

  test('no-targets (empty seedUrls or cooldown) skips policy.authorize, burns 0 Policy budget, and avoids DB spam within intervalMs', async () => {
    const { store } = openTempStore()
    const scope = makeScope('no-targets-auth')
    const nowMs = Date.UTC(2026, 10, 20, 18, 0, 0)

    seedNode(store, scope, {
      id: 'a:g-no-targets',
      kind: 'goal',
      title: 'TypeScript Generics',
      body: 'typescript generics',
      updatedAt: nowMs - 10_000,
    })

    const { policy, authorizeCalls, evaluateCalls } = makeAllowPolicyPeer()
    const runnerSpy = vi.fn<WebLearningRunner['run']>()
    const runner: WebLearningRunner = { run: runnerSpy }

    // 1. Empty seedUrls across repeated ticks within intervalMs
    const emptySeedsCfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: [],
      intervalMs: 3_600_000,
      idleMinMs: 0,
    })

    const r1 = await runWebLearningPass({ store, scope, config: emptySeedsCfg, policy, runner, nowMs })
    const r2 = await runWebLearningPass({
      store,
      scope,
      config: emptySeedsCfg,
      policy,
      runner,
      nowMs: nowMs + 15_000,
    })
    const r3 = await runWebLearningPass({
      store,
      scope,
      config: emptySeedsCfg,
      policy,
      runner,
      nowMs: nowMs + 30_000,
    })

    expect(r1).toMatchObject({ ran: false, status: 'skipped', reason: 'no-targets' })
    expect(r1.runId).not.toBeNull()
    expect(r2).toMatchObject({ ran: false, runId: null, status: 'skipped', reason: 'no-targets' })
    expect(r3).toMatchObject({ ran: false, runId: null, status: 'skipped', reason: 'no-targets' })
    expect(authorizeCalls).toHaveLength(0)
    expect(evaluateCalls).toHaveLength(3)
    expect(runnerSpy).not.toHaveBeenCalled()
    expect(listWebLearningRuns(store, scope.ownerScopeKey)).toHaveLength(1)

    // 2. Real Policy service with budget limit=1: cooldown no-targets must NOT burn the 1-call quota
    const realPolicy = await createRealPolicyService(
      [
        {
          id: 'allow-web-budgeted',
          effect: 'allow',
          subject: { kind: 'background', id: 'assistant-association:web-learning' },
          actions: ['web.learn'],
          resource: { kind: 'network', id: 'assistant-association:web-learning' },
          context: { initiators: ['background'] },
          budget: { id: 'web-once', amount: 1 },
        },
      ],
      [
        {
          id: 'web-once',
          metric: 'tool-calls',
          limit: 1,
          periodMs: 86_400_000,
          scope: 'subject',
        },
      ],
    )

    const seededCfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      intervalMs: 60_000,
      idleMinMs: 0,
      cooldownMs: 86_400_000,
    })
    const firstInterest = extractWebLearningInterests(store, scope, { config: seededCfg, nowMs })
    const targetUrl = firstInterest.targets[0]!.url
    store.database
      .prepare(`
        INSERT INTO assoc_web_learning_fetches (
          fetch_id, owner_scope_key, run_id, canonical_url, domain, interest_key, status, bytes_fetched, node_id, fetched_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ok', 64, NULL, ?, NULL)
      `)
      .run('fetch-cooled', scope.ownerScopeKey, 'run-cooled', targetUrl, 'docs.example.com', firstInterest.targets[0]!.interestKey, nowMs + 100_000)

    const cooledRes = await runWebLearningPass({
      store,
      scope,
      config: seededCfg,
      policy: realPolicy,
      runner,
      nowMs: nowMs + 120_000,
    })
    expect(cooledRes).toMatchObject({ ran: false, status: 'skipped', reason: 'no-targets' })

    // Now expire cooldown: the 1-call Policy budget MUST still be intact and allow the actual fetch!
    const realRunner = createInProcessWebLearningRunner({
      now: () => nowMs + 90_000_000,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () =>
        new Response('<html><head><title>Generics</title></head><body>TypeScript generics docs</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    })
    const realRes = await runWebLearningPass({
      store,
      scope,
      config: seededCfg,
      policy: realPolicy,
      runner: realRunner,
      nowMs: nowMs + 90_000_000,
    })
    expect(realRes.ran).toBe(true)
    expect(realRes.status).toBe('completed')
    expect(realRes.nodesWritten).toBe(1)
  })

  test('stops on first target with max-bytes-exhausted when remainingDailyBytes < maxBytesPerRequest', async () => {
    const { store } = openTempStore()
    const scope = makeScope('daily-byte-cap')
    const nowMs = Date.UTC(2026, 10, 20, 19, 0, 0)
    const { policy } = makeAllowPolicyPeer()

    for (const [id, title] of [
      ['a:g-b1', 'TypeScript Compiler'],
      ['a:g-b2', 'Vitest Runner'],
      ['a:g-b3', 'SQLite Storage'],
    ] as const) {
      seedNode(store, scope, {
        id,
        kind: 'goal',
        title,
        body: title,
        updatedAt: nowMs - 10_000,
      })
    }

    // remainingDailyBytes = 100 (900 used out of 1000) while maxBytesPerRequest = 500
    store.database
      .prepare(`
        INSERT INTO assoc_web_learning_budget_usage (
          owner_scope_key, utc_day, requests_used, pages_fetched, bytes_fetched, updated_at
        ) VALUES (?, '2026-11-20', 0, 0, 900, ?)
      `)
      .run(scope.ownerScopeKey, nowMs - 1_000)

    let fetchCount = 0
    const runner = createInProcessWebLearningRunner({
      now: () => nowMs,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () => {
        fetchCount += 1
        return new Response('x'.repeat(200), {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '200' },
        })
      },
    })

    const cfg = normalizeAssociationWebLearningConfig({
      enabled: true,
      allowedDomains: ['docs.example.com'],
      seedUrls: ['https://docs.example.com/search?q={query}'],
      isolationMode: 'in-process',
      intervalMs: 0,
      idleMinMs: 0,
      cooldownMs: 0,
      maxInterestsPerRun: 3,
      maxRequestsPerRun: 5,
      maxBytesPerRequest: 500,
      maxTotalBytesPerRun: 500,
      maxBytesPerDay: 1_000,
      maxRequestsPerDay: 10,
    })

    const res = await runWebLearningPass({
      store,
      scope,
      config: cfg,
      policy,
      runner,
      nowMs,
    })

    expect(res.ran).toBe(true)
    expect(res.status).toBe('budget-exhausted')
    expect(res.reason).toBe('max-bytes-exhausted')
    expect(res.requestsUsed).toBe(1)
    expect(res.pagesFetched).toBe(0)
    expect(res.bytesFetched).toBe(0)
    expect(fetchCount).toBe(1)
  })
})
