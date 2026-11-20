import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_ASSOCIATION_WEB_LEARNING_CONFIG } from './config.js'
import { extractEntities } from './entities.js'
import type { AssociationStore } from './sqlite.js'
import { tokenizeAssociationText } from './tokenize.js'
import type { AssociationOwnerScope, AssociationWebLearningNormalizedConfig } from './types.js'
import { validateWhitelistedWebUrl } from './web-fetch.js'
import type { WebLearningPlanTarget } from './web-learning-worker.js'

export const INTEREST_SOURCE_PRIORITIES = Object.freeze({
  goal: 1.2,
  'implicit-signal': 1.1,
  'work-item': 1.0,
  'low-coverage': 0.9,
  dream: 0.85,
  abstraction: 0.85,
})

export type WebInterestSourceKind = keyof typeof INTEREST_SOURCE_PRIORITIES

export interface ExtractedWebInterest {
  readonly interestKey: string
  readonly query: string
  readonly tokens: readonly string[]
  readonly priority: number
  readonly sourceKind: WebInterestSourceKind
  readonly originNodeIds: readonly string[]
  readonly updatedAt: number
}

export interface ExtractWebLearningInterestsOptions {
  readonly config?: AssociationWebLearningNormalizedConfig
  readonly allowedDomains?: readonly string[]
  readonly seedUrls?: readonly string[]
  readonly allowSubdomains?: boolean
  readonly cooldownMs?: number
  readonly maxInterestsPerRun?: number
  readonly discoverLinks?: boolean
  readonly nowMs?: number
}

export interface WebLearningInterestExtractionResult {
  readonly interests: readonly ExtractedWebInterest[]
  readonly targets: readonly WebLearningPlanTarget[]
  readonly skippedCooldownCount: number
  readonly rejectedSeedUrls: readonly string[]
}

const MAX_TOKENS_PER_QUERY = 3
const MAX_QUERY_CHARS = 64
const MAX_TOKEN_CHARS = 48
const MAX_CJK_TOKEN_CHARS = 16

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have',
  'will', 'are', 'was', 'were', 'not', 'but', 'can', 'use', 'used', 'using',
  'when', 'what', 'which', 'where', 'how', 'all', 'any', 'has', 'had', 'been',
  'true', 'false', 'null', 'undefined', 'about', 'also', 'than', 'then', 'them',
  'they', 'their', 'there', 'here', 'more', 'some', 'only', 'other', 'such',
  'each', 'over', 'unknown', 'none', 'error', 'failed', 'success', 'completed',
  'active', 'private', 'sensitive', 'http', 'https', 'www', 'localhost',
  'execution', 'objective', 'status', 'task', 'item', 'work', 'goal', 'dream',
])

const SECRET_EXACT_TOKENS = new Set([
  'bearer',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passphrase',
  'passphrases',
  'passwd',
  'pwd',
  'apikey',
  'apikeys',
  'api_key',
  'api-key',
  'access_token',
  'access-token',
  'refresh_token',
  'refresh-token',
  'private_key',
  'private-key',
  'secret_key',
  'secret-key',
  'secretkey',
  'auth_key',
  'auth-key',
  'authkey',
  'access_key',
  'access-key',
  'accesskey',
  'client_secret',
  'client-secret',
  'client_key',
  'client-key',
  'clientkey',
  'auth_token',
  'auth-token',
  'authorization',
  'credential',
  'credentials',
  'creds',
  'cookie',
  'cookies',
  'session_id',
  'session-id',
  'sessionid',
  'ssh_key',
  'ssh-key',
  'sshkey',
  'ssh_keys',
  'ssh-keys',
  'sshkeys',
  'signing_key',
  'signing-key',
  'master_key',
  'master-key',
  'encryption_key',
  'encryption-key',
  'deploy_key',
  'deploy-key',
  'deploykey',
  'jwt_key',
  'jwt-key',
  'jwtkey',
  'jwt_secret',
  'jwt-secret',
  'app_key',
  'app-key',
  'appkey',
  'hmac_key',
  'hmac-key',
  'hmackey',
  'tls_key',
  'tls-key',
  'tlskey',
  'ssl_key',
  'ssl-key',
  'sslkey',
  'aes_key',
  'aes-key',
  'aeskey',
  'kms_key',
  'kms-key',
  'kmskey',
  'fernet_key',
  'fernet-key',
  'fernetkey',
  'cipher_key',
  'cipher-key',
  'cipherkey',
  'pk_key',
  'pk-key',
  'pkkey',
  'pk_keys',
  'pk-keys',
  'pkkeys',
  'sk_key',
  'sk-key',
  'skkey',
  'sk_keys',
  'sk-keys',
  'skkeys',
  'rk_key',
  'rk-key',
  'rkkey',
  'rk_keys',
  'rk-keys',
  'rkkeys',
  'whsec_key',
  'whsec-key',
  'whseckey',
  'whsec_keys',
  'whsec-keys',
  'whseckeys',
  'ghp_key',
  'ghp-key',
  'ghpkey',
  'ghp_keys',
  'ghp-keys',
  'ghpkeys',
  'gho_key',
  'gho-key',
  'ghokey',
  'gho_keys',
  'gho-keys',
  'ghokeys',
  'ghu_key',
  'ghu-key',
  'ghukey',
  'ghu_keys',
  'ghu-keys',
  'ghukeys',
  'ghs_key',
  'ghs-key',
  'ghskey',
  'ghs_keys',
  'ghs-keys',
  'ghskeys',
  'ghr_key',
  'ghr-key',
  'ghrkey',
  'ghr_keys',
  'ghr-keys',
  'ghrkeys',
  'glpat_key',
  'glpat-key',
  'glpatkey',
  'glpat_keys',
  'glpat-keys',
  'glpatkeys',
  'npm_key',
  'npm-key',
  'npmkey',
  'npm_keys',
  'npm-keys',
  'npmkeys',
  'xoxb_key',
  'xoxb-key',
  'xoxbkey',
  'xoxb_keys',
  'xoxb-keys',
  'xoxbkeys',
  'xoxp_key',
  'xoxp-key',
  'xoxpkey',
  'xoxp_keys',
  'xoxp-keys',
  'xoxpkeys',
  'xoxa_key',
  'xoxa-key',
  'xoxakey',
  'xoxa_keys',
  'xoxa-keys',
  'xoxakeys',
  'xoxr_key',
  'xoxr-key',
  'xoxrkey',
  'xoxr_keys',
  'xoxr-keys',
  'xoxrkeys',
  'github_pat_key',
  'github-pat-key',
  'github_pat-key',
  'githubpatkey',
  'github_pat_keys',
  'github-pat-keys',
  'github_pat-keys',
  'githubpatkeys',
])

const SECRET_PREFIX_RE = /^(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[bpar]|glpat)[_-]|^(?:npm|whsec)_|^github_pat_|^akia[0-9a-z]{8,}|^asia[0-9a-z]{8,}|^aiza[0-9a-z_-]{8,}|^ya29\.|^eyj[a-z0-9_-]{8,}/iu
const SECRET_KEY_PART_RE =
  /(?:bearer|token|secret|passphrases?|password|passwd|pwd|api[_-]?key|apikeys|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|secret[_-]?key|auth[_-]?key|access[_-]?key|client[_-]?(?:secret|key)|auth[_-]?token|authorization|credential|credentials|creds|cookie|cookies|session[_-]?id|(?:^|[_.-])ssh[_-]?keys?(?:[_.-]|$)|signing[_-]?key|master[_-]?key|encryption[_-]?key|deploy[_-]?key|jwt[_-]?key|jwt[_-]?secret|(?:app|hmac|tls|ssl|aes|kms|fernet|cipher)[_-]?key|(?:^|[_.-])(?:pk|sk|rk|whsec|ghp|gho|ghu|ghs|ghr|glpat|npm|xox[bpar]|github[_-]?pat)[_-]?keys?(?:[_.-]|$)|(?:^|[_.-])github[_-]?pat$|(?:^|[_.-])jwt(?:$|[_.-])|[A-Za-z0-9][_.-]+pass(?:[_.-]|$))/iu
const CAMEL_PASS_OR_JWT_KEY_RE = /[a-z0-9](?:Pass|Jwt)(?:[^a-z]|$)/u
const AUTH_KEY_PART_RE = /authorization/iu
const BEARER_KEY_PART_RE = /bearer/iu
const SECRET_VALUE_CHAR_RE = /[0-9!@#$%^&*_+/=\\~-]/u
const SCHEME_PREFIX_STICKY_RE =
  /(bearer|basic|token|apikey|api[_-]?key|digest|oauth|signature|mac|negotiate|hoba|mutual|scram-sha-1|scram-sha-256|scram-sha-512|aws4-hmac-sha256|vapid|dpop)[ \t:]+/iyu
const KNOWN_AUTH_SCHEMES = new Set([
  'bearer',
  'basic',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'digest',
  'oauth',
  'signature',
  'mac',
  'negotiate',
  'hoba',
  'mutual',
  'scram-sha-1',
  'scram-sha-256',
  'scram-sha-512',
  'aws4-hmac-sha256',
  'vapid',
  'dpop',
])
const QUOTED_AUTH_SCHEME_STICKY_RE =
  /(?:"([^\s"\r\n]+)"|'([^\s'\r\n]+)'|`([^\s`\r\n]+)`)(?:[ \t]*(?:\r?\n[ \t]+)?[,;][ \t]*(?:\r?\n[ \t]+)?|[ \t]+|\r?\n[ \t]+)/yu
const CAMEL_OR_NUMBERED_SECRET_SUFFIX_RE =
  /(?:ApiKey|Token|Secret|Passphrases?|Password|Passwd|Pass|Key|Cred|Auth|Cookie|Session|Jwt|Bearer|Oauth)\d*$/u
const UNSEPARATED_SECRET_SUFFIX_RE =
  /(?:api[_-]?key|apikeys|apikey|token|tokens|secret[_-]?key|auth[_-]?key|access[_-]?key|client[_-]?key|secret|passphrases?|password|passwd|pwd|bearer|credential|credentials|creds|cookie|cookies|session[_-]?id|ssh[_-]?key|signing[_-]?key|master[_-]?key|encryption[_-]?key|(?:app|hmac|tls|ssl|aes|kms|fernet|cipher|pk|sk|rk|whsec|ghp|gho|ghu|ghs|ghr|glpat|npm|xox[bpar]|github[_-]?pat)[_-]?keys?)$/iu
const PARAMETERIZED_AUTH_SCHEMES = new Set([
  'aws4-hmac-sha256',
  'digest',
  'oauth',
  'signature',
  'mac',
  'scram-sha-1',
  'scram-sha-256',
  'scram-sha-512',
  'vapid',
  'hoba',
  'mutual',
])
const PEM_OPEN_OPT_NL_STICKY_RE = /[ \t]*(?:\r?\n[ \t]*)?-----BEGIN [A-Z0-9 _-]+-----/yu
const PEM_END_STICKY_RE = /[ \t]*-----END [A-Z0-9 _-]+-----/yu
const LINE_ASSIGNMENT_PREFIX =
  '(?:-[ \\t]+|\\*[ \\t]+|,[ \\t]*)?(?:(?:export|local|readonly|declare|const|let|var|set|env)[ \\t]+)*'
const SUBSCRIPT_SEGMENT_SRC =
  '(?:[ \\t]*\\[[ \\t]*(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\'|`[^`\\r\\n]+`|\\$?[A-Za-z0-9_.-]*)[ \\t]*\\])'
const SUBSCRIPT_CHAIN_CAPTURE_SRC = `((?:${SUBSCRIPT_SEGMENT_SRC}(?:\\.[A-Za-z0-9_.-]+)?)+)`
const LINE_START_ASSIGNMENT_RE = new RegExp(
  `[ \\t]*${LINE_ASSIGNMENT_PREFIX}(?:(["'\`])([A-Za-z0-9_.-]+)\\1|([A-Za-z0-9_.-]+))${SUBSCRIPT_CHAIN_CAPTURE_SRC}?[ \\t]*(?::=|==|:|=)(?![ \\t]*(?:$|[\\r\\n]|["'\`][ \\t]*(?:[,;][ \\t]*)?(?:$|[\\r\\n])))`,
  'yu',
)
const LINE_START_SECRET_SPACE_QUOTE_RE = new RegExp(
  `[ \\t]*${LINE_ASSIGNMENT_PREFIX}(?:(["'\`])([A-Za-z0-9_.-]+)\\1|([A-Za-z0-9_.-]+))[ \\t]+["'\`]`,
  'yu',
)
const INLINE_ASSIGNMENT_RE = new RegExp(
  `(?<![A-Za-z0-9_.-])(?:(["'\`])([A-Za-z0-9_.-]+)\\1|([A-Za-z0-9_.-]+))${SUBSCRIPT_CHAIN_CAPTURE_SRC}?[ \\t]*(?::=|==|:|=)(?![ \\t]*(?:$|["'\`][ \\t]*(?:[,;][ \\t]*)?$))`,
  'gu',
)
const INLINE_SECRET_SPACE_QUOTE_RE =
  /(?<![A-Za-z0-9_.-])(?:(["'`])([A-Za-z0-9_.-]+)\1|([A-Za-z0-9_.-]+))[ \t]+["'`]/gu
const NEXT_KEY_ASSIGNMENT_STICKY_RE = new RegExp(
  `(?:(["'\`])([A-Za-z0-9_.-]+)\\1|([A-Za-z0-9_.-]+))${SUBSCRIPT_CHAIN_CAPTURE_SRC}?([ \\t]*)(:=|==|:|=)([ \\t]*)(\\S)`,
  'yu',
)
const NEXT_SECRET_SPACE_QUOTE_STICKY_RE =
  /(?:(["'`])([A-Za-z0-9_.-]+)\1|([A-Za-z0-9_.-]+))[ \t]+["'`]/yu
const COOKIE_KEY_PART_RE = /(?:^|[_.-])(?:set)?cookies?2?(?:[_.-]|$)/iu
const COOKIE_PAIR_START_STICKY_RE =
  /(?:(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`)|[A-Za-z0-9_.!$%&'*+^`|~-]+)[ \t]*=[ \t]*/yu
const COOKIE_ATTR_FLAG_STICKY_RE =
  /(?:httponly|secure|partitioned|discard|hostonly|samesite)(?=[ \t]*(?:[;,]|$|\r|\n))/iyu
const COOKIE_BARE_FLAG_PREFIX_STICKY_RE = /\$?[A-Za-z][A-Za-z0-9_-]*(?=[ \t]*(?:\r?\n[ \t]+)?[;,])/yu
const COOKIE_BARE_FLAG_FOLDED_STICKY_RE = /\$?[A-Za-z][A-Za-z0-9_-]*(?=[ \t]*\r?\n[ \t]+)/yu
const COOKIE_COLON_SECRET_STICKY_RE =
  /(?:(["'`])([A-Za-z0-9_.-]+)\1|([A-Za-z0-9_.-]+))[ \t]*:[ \t]*/yu
const COOKIE_EXPIRES_DATE_STICKY_RE =
  /expires[ \t]*=[ \t]*(?:[A-Za-z]{3,9},[ \t]+)?\d{1,2}[ \t-]+[A-Za-z]{3,9}[ \t-]+\d{2,4}[ \t]+(?:\d{2}:\d{2}:\d{2}[ \t]+)?[A-Za-z0-9+-]+/iyu
const ARRAY_ELEMENT_OR_CLOSE_STICKY_RE =
  /[ \t]*(?:[,;][ \t]*)?(?:[\]}]|(["'`])[ \t]*(?![ \t]*(?:[,;\r\n\]}]|$)))/yu
const YAML_BLOCK_SCALAR_HEADER_STICKY_RE =
  /[|>](?:[+-]?\d*|\d*[+-]?)(?:[ \t]+#[^\r\n]*)?[ \t]*(?=\r?\n|$)/yu
const AUTH_PARAM_NAME_EQ_STICKY_RE =
  /(?:(["'`])[A-Za-z0-9_.-]+\1|[A-Za-z0-9_.-]+)[ \t]*(?::=|==|=(?!=))/yu
const AUTH_PARAM_NAME_COLON_STICKY_RE = /(?:(["'`])[A-Za-z0-9_.-]+\1|[A-Za-z0-9_.-]+)[ \t]*:(?!=)/yu
const AUTH_PARAM_NAME_COLON_OR_EQ_STICKY_RE =
  /(?:(["'`])[A-Za-z0-9_.-]+\1|[A-Za-z0-9_.-]+)[ \t]*(?::=|==|:(?!=)|=(?!=))/yu
const TITLECASE_SECRET_PREFIX_RE =
  /^(?:ApiKey|Bearer|Token|Secret|Passphrases?|Password|Passwd|Pwd|Credential|Cookie|Session)[a-z0-9]*$/u
const KNOWN_NUM_SECRET_PREFIX_RE =
  /^(?:api[_-]?key|apikey|api|ssh[_-]?key|sshkey|ssh|auth|authorization|token|tokens|secret|secrets|key|keys|pass|passwd|passphrases?|password|passwords|pwd|cred|credential|credentials|cookie|cookies|session|sessions|jwt|jwts|oauth|oauths|bearer|access|refresh|private|client|signing|master|encryption)\d+[A-Za-z0-9]*$/iu
const DIGIT_SEP_SECRET_STEM_RE =
  /^(?:api[_-]?key|apikeys|apikey|signing|master|encryption|access[_-]?key|access|refresh|private|client|jwt|jwts|oauth|oauths|ssh|sshkey|token|tokens|secret[_-]?key|secret|secrets|key|keys|pass|passwd|passphrases?|password|passwords|pwd|creds|cred|credential|credentials|cookie|cookies|session[_-]?id|session|sessions|auth[_-]?key|auth|authorization|bearer)(?:\d*(?:val|value|str|data|item|field)(?:v?\d+)?|v?\d+)?$/iu
const DIGIT_SEP_UNSEPARATED_STEM_RE =
  /(?:api[_-]?key|apikeys|apikey|token|tokens|secret[_-]?key|secret|secrets|passphrases?|password|passwords|passwd|pwd|bearer|credential|credentials|creds|cookie|cookies|session[_-]?id|session|sessions|ssh[_-]?key|sshkey|signing[_-]?key|master[_-]?key|encryption[_-]?key|access[_-]?token|access[_-]?key|refresh[_-]?token|private[_-]?key|client[_-]?(?:secret|key)|auth[_-]?token|auth[_-]?key|authorization|jwt|jwts|oauth|oauths|(?:app|hmac|tls|ssl|aes|kms|fernet|cipher|pk|sk|rk|whsec|ghp|gho|ghu|ghs|ghr|glpat|npm|xox[bpar]|github[_-]?pat)[_-]?keys?)(?:\d*(?:val|value|str|data|item|field)(?:v?\d+)?|v?\d+)?$/iu
const SUBSCRIPT_EXTRACT_RE =
  /\[[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|(\$?[A-Za-z0-9_.-]*))[ \t]*\]|\.([A-Za-z0-9_-]+)/gu
const OBJECT_PROPERTY_ASSIGN_STICKY_RE =
  /(?:(["'`])[A-Za-z0-9_.-]+\1|[A-Za-z0-9_.-]+)[ \t]*(?::(?!=)|=(?!=))/yu
const YAML_MAPPING_KEY_STICKY_RE =
  /(?:(["'`])[A-Za-z0-9_.-]+\1|[A-Za-z0-9_.-]+)[ \t]*:(?![:=])/yu
const DANGEROUS_EXT_RE = /\.(?:sqlite|sqlite3|db|env|pem|key|p12|pfx|crt|cer|pub|der|jks|keystore|kdbx|log|bak|secret|passwd|htpasswd|netrc|npmrc|pypirc|dockercfg)$/iu
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/u
const HEX_LONG_RE = /^[0-9a-f]{20,}$/iu
const NON_HYPHEN_LONG_RE = /^[a-z0-9_]{20,}$/iu
const SAFE_ASCII_TOKEN_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/u
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const SAFE_CJK_TOKEN_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-z0-9_-]{2,16}$/u

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function asDatabase(storeOrDb: AssociationStore | DatabaseSync): DatabaseSync {
  return 'database' in storeOrDb ? storeOrDb.database : storeOrDb
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined
  return row !== undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function collectScopeSensitiveTerms(
  scope?: Partial<Pick<AssociationOwnerScope, 'workspace' | 'principalId'>>,
): {
  readonly exactTerms: ReadonlySet<string>
  readonly substringTerms: readonly string[]
  readonly rawLiterals: readonly string[]
} {
  const exactTerms = new Set<string>()
  const substringTerms = new Set<string>()
  const rawLiterals = new Set<string>()

  if (typeof scope?.workspace === 'string' && scope.workspace.trim().length > 0) {
    const ws = scope.workspace.trim()
    rawLiterals.add(ws)
    const lowerWs = ws.normalize('NFKC').toLocaleLowerCase('en-US')
    exactTerms.add(lowerWs)
    for (const seg of lowerWs.split(/[/\\]+/u)) {
      const cleaned = seg.trim()
      if (cleaned.length >= 2) {
        exactTerms.add(cleaned)
      }
      if (cleaned.length >= 5) {
        substringTerms.add(cleaned)
      }
    }
  }

  if (typeof scope?.principalId === 'string' && scope.principalId.trim().length > 0) {
    const principal = scope.principalId.trim()
    rawLiterals.add(principal)
    const lowerPrincipal = principal.normalize('NFKC').toLocaleLowerCase('en-US')
    exactTerms.add(lowerPrincipal)
    if (lowerPrincipal.length >= 4) {
      substringTerms.add(lowerPrincipal)
    }
    for (const seg of lowerPrincipal.split(/[:/\\@\s]+/u)) {
      const cleaned = seg.trim()
      if (cleaned.length >= 2) {
        exactTerms.add(cleaned)
      }
      if (cleaned.length >= 5) {
        substringTerms.add(cleaned)
      }
    }
    for (const subSeg of lowerPrincipal.split(/[:/\\@\s_-]+/u)) {
      const cleaned = subSeg.trim()
      if (cleaned.length >= 4) {
        exactTerms.add(cleaned)
      }
    }
  }

  return {
    exactTerms,
    substringTerms: [...substringTerms],
    rawLiterals: [...rawLiterals].sort((a, b) => b.length - a.length),
  }
}

function matchStickyAt(re: RegExp, text: string, startIdx: number): RegExpExecArray | null {
  re.lastIndex = startIdx
  return re.exec(text)
}

function findLineEnd(text: string, startIdx: number): number {
  let lineEnd = startIdx
  while (lineEnd < text.length && text[lineEnd] !== '\r' && text[lineEnd] !== '\n') {
    lineEnd += 1
  }
  return lineEnd
}

function inspectLineStartAndMeta(
  text: string,
  lineStart: number,
): { readonly lineEnd: number; readonly hasColonOrEq: boolean; readonly hasQuote: boolean } {
  let i = lineStart
  let hasColonOrEq = false
  let hasQuote = false
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 10 /* '\n' */ || code === 13 /* '\r' */) break
    if (code === 58 /* ':' */ || code === 61 /* '=' */) {
      hasColonOrEq = true
    } else if (code === 34 /* '"' */ || code === 39 /* "'" */ || code === 96 /* '`' */) {
      hasQuote = true
    }
    i += 1
  }
  return { lineEnd: i, hasColonOrEq, hasQuote }
}

function extractSubscriptSegments(subscriptChain: string | undefined): string[] {
  if (subscriptChain === undefined || subscriptChain.length === 0) return []
  const segments: string[] = []
  SUBSCRIPT_EXTRACT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SUBSCRIPT_EXTRACT_RE.exec(subscriptChain)) !== null) {
    const seg = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? ''
    if (seg.length > 0) {
      segments.push(seg)
    }
  }
  return segments
}

type BlockCommentCloseFinder = (openPos: number) => number

function createBlockCommentCloseFinder(text: string): BlockCommentCloseFinder {
  let starSlashPositions: number[] | null = null
  let lastHintIdx = 0
  return (openPos: number): number => {
    if (starSlashPositions === null) {
      starSlashPositions = []
      let searchFrom = 0
      while (searchFrom < text.length) {
        const found = text.indexOf('*/', searchFrom)
        if (found === -1) break
        starSlashPositions.push(found)
        searchFrom = found + 2
      }
    }
    const target = openPos + 2
    const n = starSlashPositions.length
    if (n === 0 || starSlashPositions[n - 1]! < target) {
      return -1
    }
    if (
      lastHintIdx < n &&
      starSlashPositions[lastHintIdx]! >= target &&
      (lastHintIdx === 0 || starSlashPositions[lastHintIdx - 1]! < target)
    ) {
      return starSlashPositions[lastHintIdx]! + 2
    }
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (starSlashPositions[mid]! < target) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    lastHintIdx = lo
    return starSlashPositions[lo]! + 2
  }
}

function isLineStartKeyAssignment(
  text: string,
  lineStart: number,
  inPemBlock: boolean,
  hasColonOrEq = true,
  hasQuote = true,
): boolean {
  if (lineStart >= text.length) return false

  if (hasColonOrEq) {
    const assignMatch = matchStickyAt(LINE_START_ASSIGNMENT_RE, text, lineStart)
    if (assignMatch !== null) {
      if (!inPemBlock) return true
      const baseIdent = assignMatch[3] ?? assignMatch[2] ?? ''
      if (baseIdent.toLowerCase() === 'pass' || SECRET_KEY_PART_RE.test(baseIdent)) {
        return true
      }
      for (const seg of extractSubscriptSegments(assignMatch[4])) {
        if (seg.toLowerCase() === 'pass' || SECRET_KEY_PART_RE.test(seg)) {
          return true
        }
      }
    }
  }

  if (hasQuote) {
    const spaceQuoteMatch = matchStickyAt(LINE_START_SECRET_SPACE_QUOTE_RE, text, lineStart)
    if (spaceQuoteMatch !== null) {
      const key = spaceQuoteMatch[3] ?? spaceQuoteMatch[2] ?? ''
      if (SECRET_KEY_PART_RE.test(key)) {
        return true
      }
    }
  }

  return false
}

function findFirstUnescapedCharOffset(line: string, targetChar: string): number {
  let i = 0
  while (i < line.length) {
    const code = line.charCodeAt(i)
    if (code === 92 /* '\\' */) {
      i += 2
      continue
    }
    if (line[i] === targetChar) {
      return i
    }
    i += 1
  }
  return line.length
}

function stripLineCommentsForAssignmentScan(line: string): string {
  if (!line.includes('/') && !line.includes('#')) {
    return line
  }
  let out = ''
  let lastCopied = 0
  let quote: string | null = null
  let k = 0
  while (k < line.length) {
    const ch = line[k]
    if (quote !== null) {
      if (line.charCodeAt(k) === 92 /* '\\' */) {
        k += 2
        continue
      }
      if (ch === quote) {
        quote = null
      }
      k += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      k += 1
      continue
    }
    if (
      (ch === '#' && (k === 0 || /[\s,;[{]/u.test(line[k - 1] ?? ''))) ||
      (ch === '/' &&
        k + 1 < line.length &&
        line[k + 1] === '/' &&
        (k === 0 || line[k - 1] !== ':'))
    ) {
      out += line.slice(lastCopied, k)
      return out
    }
    if (ch === '/' && k + 1 < line.length && line[k + 1] === '*') {
      out += line.slice(lastCopied, k) + ' '
      let closeIdx = -1
      for (let m = k + 2; m + 1 < line.length; m += 1) {
        if (line[m] === '*' && line[m + 1] === '/') {
          closeIdx = m + 2
          break
        }
      }
      if (closeIdx === -1) {
        return out
      }
      lastCopied = closeIdx
      k = closeIdx
      continue
    }
    k += 1
  }
  return lastCopied === 0 ? line : out + line.slice(lastCopied)
}

function crossedLineHasKeyAssignment(
  text: string,
  lineStart: number,
  inPemBlock: boolean,
  closingQuoteChar: string | null = null,
  requireSecretKey = false,
): boolean {
  if (lineStart >= text.length) return false
  const { lineEnd, hasColonOrEq, hasQuote } = inspectLineStartAndMeta(text, lineStart)
  if (!hasColonOrEq && !hasQuote) return false
  if (isLineStartKeyAssignment(text, lineStart, inPemBlock || requireSecretKey, hasColonOrEq, hasQuote)) {
    return true
  }
  if (inPemBlock || lineEnd <= lineStart) return false

  const rawLine = text.slice(lineStart, lineEnd)
  const rawLimitOffset =
    closingQuoteChar !== null ? findFirstUnescapedCharOffset(rawLine, closingQuoteChar) : rawLine.length
  if (rawLimitOffset === 0) return false
  const line =
    !inPemBlock && closingQuoteChar === null
      ? stripLineCommentsForAssignmentScan(rawLine)
      : rawLine
  const limitOffset = closingQuoteChar !== null ? rawLimitOffset : line.length
  if (limitOffset === 0) return false

  if (hasColonOrEq) {
    INLINE_ASSIGNMENT_RE.lastIndex = 0
    let inlineAssign: RegExpExecArray | null
    while ((inlineAssign = INLINE_ASSIGNMENT_RE.exec(line)) !== null) {
      if (
        inlineAssign.index > limitOffset ||
        (inlineAssign.index === limitOffset && inlineAssign[2] === undefined)
      ) {
        break
      }
      const baseIdent = inlineAssign[3] ?? inlineAssign[2] ?? ''
      if (baseIdent.toLowerCase() === 'pass' || SECRET_KEY_PART_RE.test(baseIdent)) {
        return true
      }
      for (const seg of extractSubscriptSegments(inlineAssign[4])) {
        if (seg.toLowerCase() === 'pass' || SECRET_KEY_PART_RE.test(seg)) {
          return true
        }
      }
    }
  }

  if (hasQuote) {
    INLINE_SECRET_SPACE_QUOTE_RE.lastIndex = 0
    let inlineSpaceQuote: RegExpExecArray | null
    while ((inlineSpaceQuote = INLINE_SECRET_SPACE_QUOTE_RE.exec(line)) !== null) {
      if (
        inlineSpaceQuote.index > limitOffset ||
        (inlineSpaceQuote.index === limitOffset && inlineSpaceQuote[2] === undefined)
      ) {
        break
      }
      const key = inlineSpaceQuote[3] ?? inlineSpaceQuote[2] ?? ''
      if (SECRET_KEY_PART_RE.test(key)) {
        return true
      }
    }
  }

  return false
}

function matchEscapedQuotedValueEnd(text: string, pos: number): number {
  if (pos + 1 >= text.length || text[pos] !== '\\') return -1
  const quote = text[pos + 1]
  if (quote !== '"' && quote !== "'" && quote !== '`') return -1
  let i = pos + 2
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\r' || ch === '\n') return -1
    if (ch === '\\') {
      let j = i
      while (j < text.length && text[j] === '\\') {
        j += 1
      }
      const bsCount = j - i
      if (j < text.length && text[j] === quote) {
        if (bsCount % 2 === 0) {
          return -1
        }
        if (
          bsCount >= 3 &&
          j + 1 < text.length &&
          !/[\s,;\r\n"'`)\]}]/u.test(text[j + 1]!)
        ) {
          i = j + 1
          continue
        }
        return j + 1
      }
      i = j < text.length && text[j] !== '\r' && text[j] !== '\n' ? j + 1 : j
      continue
    }
    i += 1
  }
  return -1
}

function isAuthPrefixBeforeQuote(afterOp: string): boolean {
  const schemePrefixRe = /^[ \t]*(?:(?:["'`][A-Za-z0-9_-]+["'`]|[A-Za-z0-9_-]+)(?:[ \t:]+|[ \t]*[,;][ \t]*))?/yu
  const schemeMatch = matchStickyAt(schemePrefixRe, afterOp, 0)
  let pos = schemeMatch !== null ? schemeMatch[0].length : 0
  if (pos === afterOp.length) return true
  const paramNameEqRe =
    /(?:(["'`])[A-Za-z0-9_.-]+\1|[A-Za-z0-9_.-]+)[ \t]*(?::=|==|:(?!=)|=(?!=))[ \t]*/yu
  const paramValRe =
    /(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|`(?:[^`\\\r\n]|\\.)*`|(?:[^\s"'`<>|,;\\]|\\[^\r\n])+)/yu
  const paramSepRe = /(?:[ \t]*[,;][ \t]*|[ \t]+)/yu
  if (
    schemeMatch !== null &&
    schemeMatch[0].length > 0 &&
    afterOp[pos] === '\\' &&
    matchStickyAt(paramNameEqRe, afterOp, pos) === null
  ) {
    const escCredEnd = matchEscapedQuotedValueEnd(afterOp, pos)
    if (escCredEnd !== -1) {
      const sepAfterCred = matchStickyAt(paramSepRe, afterOp, escCredEnd)
      if (sepAfterCred !== null) {
        pos = paramSepRe.lastIndex
        if (pos === afterOp.length) return true
      }
    }
  }
  while (pos < afterOp.length) {
    const nameEq = matchStickyAt(paramNameEqRe, afterOp, pos)
    if (nameEq === null) return false
    pos = paramNameEqRe.lastIndex
    if (pos === afterOp.length) return true
    if (afterOp[pos] === '\\') {
      const escValEnd = matchEscapedQuotedValueEnd(afterOp, pos)
      if (escValEnd !== -1) {
        pos = escValEnd
      } else {
        const valMatch = matchStickyAt(paramValRe, afterOp, pos)
        if (valMatch === null) return false
        pos = paramValRe.lastIndex
      }
    } else {
      const valMatch = matchStickyAt(paramValRe, afterOp, pos)
      if (valMatch === null) return false
      pos = paramValRe.lastIndex
    }
    const sepMatch = matchStickyAt(paramSepRe, afterOp, pos)
    if (sepMatch === null) return false
    pos = paramSepRe.lastIndex
  }
  return false
}

function isCookiePrefixBeforeQuote(afterOp: string): boolean {
  let pos = 0
  while (pos < afterOp.length && (afterOp[pos] === ' ' || afterOp[pos] === '\t')) {
    pos += 1
  }
  const unquotedValRe = /[^\s"'`<>|;,{}[\]]+/yu
  const sepRe = /(?:[ \t]*[;,][ \t]*)+/yu
  while (pos < afterOp.length) {
    if (matchStickyAt(COOKIE_EXPIRES_DATE_STICKY_RE, afterOp, pos) !== null) {
      pos = COOKIE_EXPIRES_DATE_STICKY_RE.lastIndex
    } else if (matchStickyAt(COOKIE_PAIR_START_STICKY_RE, afterOp, pos) !== null) {
      pos = COOKIE_PAIR_START_STICKY_RE.lastIndex
      if (pos === afterOp.length) return true
      const valMatch = matchStickyAt(unquotedValRe, afterOp, pos)
      if (valMatch !== null) {
        pos = unquotedValRe.lastIndex
      }
    } else if (matchStickyAt(COOKIE_ATTR_FLAG_STICKY_RE, afterOp, pos) !== null) {
      pos = COOKIE_ATTR_FLAG_STICKY_RE.lastIndex
    } else if (matchStickyAt(COOKIE_BARE_FLAG_PREFIX_STICKY_RE, afterOp, pos) !== null) {
      pos = COOKIE_BARE_FLAG_PREFIX_STICKY_RE.lastIndex
    } else {
      const colonMatch = matchStickyAt(COOKIE_COLON_SECRET_STICKY_RE, afterOp, pos)
      const colonKey = colonMatch !== null ? (colonMatch[3] ?? colonMatch[2] ?? '') : ''
      if (colonMatch === null || !SECRET_KEY_PART_RE.test(colonKey)) {
        return false
      }
      pos = COOKIE_COLON_SECRET_STICKY_RE.lastIndex
      if (pos === afterOp.length) return true
      const valMatch = matchStickyAt(unquotedValRe, afterOp, pos)
      if (valMatch !== null) {
        pos = unquotedValRe.lastIndex
      }
    }
    const sepMatch = matchStickyAt(sepRe, afterOp, pos)
    if (sepMatch === null) return false
    pos = sepRe.lastIndex
  }
  return false
}

function findInlineSecretAssignmentBefore(
  slice: string,
  maxOffset: number,
  requireAdjacentToMaxOffset: boolean,
): number {
  let bestIndex = -1

  INLINE_ASSIGNMENT_RE.lastIndex = 0
  let inlineAssign: RegExpExecArray | null
  while ((inlineAssign = INLINE_ASSIGNMENT_RE.exec(slice)) !== null) {
    if (inlineAssign.index >= maxOffset) break
    const baseIdent = inlineAssign[3] ?? inlineAssign[2] ?? ''
    const segments = extractSubscriptSegments(inlineAssign[4])
    const matchesAny = (re: RegExp): boolean =>
      re.test(baseIdent) || segments.some((seg) => re.test(seg))
    const isAuthKey = matchesAny(AUTH_KEY_PART_RE)
    const isCookieKey = matchesAny(COOKIE_KEY_PART_RE)
    if (matchesAny(SECRET_KEY_PART_RE)) {
      if (requireAdjacentToMaxOffset) {
        const afterOp = slice.slice(inlineAssign.index + inlineAssign[0].length, maxOffset)
        const matchesAfterOp = isAuthKey
          ? isAuthPrefixBeforeQuote(afterOp)
          : isCookieKey
            ? isCookiePrefixBeforeQuote(afterOp) || /^[ \t]*$/u.test(afterOp)
            : /^[ \t]*$/u.test(afterOp)
        if (matchesAfterOp) {
          bestIndex = inlineAssign.index
          break
        }
        continue
      }
      bestIndex = inlineAssign.index
      break
    }
  }

  INLINE_SECRET_SPACE_QUOTE_RE.lastIndex = 0
  let spaceQuote: RegExpExecArray | null
  while ((spaceQuote = INLINE_SECRET_SPACE_QUOTE_RE.exec(slice)) !== null) {
    if (spaceQuote.index >= maxOffset) break
    if (bestIndex !== -1 && spaceQuote.index >= bestIndex) break
    const key = spaceQuote[3] ?? spaceQuote[2] ?? ''
    if (SECRET_KEY_PART_RE.test(key)) {
      if (requireAdjacentToMaxOffset) {
        if (spaceQuote.index + spaceQuote[0].length - 1 === maxOffset) {
          return spaceQuote.index
        }
        continue
      }
      return spaceQuote.index
    }
  }

  return bestIndex
}

function findQuotedValueEnd(
  text: string,
  openIdx: number,
  noClosingQuote: Record<string, boolean>,
  isAuthContext = false,
  onAuthParamBoundary?: () => number,
): number {
  const quote = text[openIdx]
  if (quote !== '"' && quote !== "'" && quote !== '`') return -1

  if (!noClosingQuote[quote]) {
    const inPemBlock = matchStickyAt(PEM_OPEN_OPT_NL_STICKY_RE, text, openIdx + 1) !== null
    let i = openIdx + 1
    let onStartLine = true
    let sawEscapedQuoteOnStartLine = false
    while (i < text.length) {
      if (text.charCodeAt(i) === 92 /* '\\' */) {
        if (i + 1 < text.length && (text[i + 1] === '\r' || text[i + 1] === '\n')) {
          i += 1
          continue
        }
        if (onStartLine && i + 1 < text.length && text[i + 1] === quote) {
          sawEscapedQuoteOnStartLine = true
        }
        i += 2
        continue
      }
      const ch = text[i]
      if (ch === quote) {
        if (onStartLine && sawEscapedQuoteOnStartLine) {
          const startLineEnd = findLineEnd(text, openIdx + 1)
          const startLineSlice = text.slice(openIdx + 1, startLineEnd)
          const assignOffset = findInlineSecretAssignmentBefore(
            startLineSlice,
            i - (openIdx + 1),
            true,
          )
          if (assignOffset !== -1) {
            return openIdx + 1 + assignOffset
          }
        }
        if (
          isAuthContext &&
          onAuthParamBoundary !== undefined &&
          isAuthPrefixBeforeQuote(
            onStartLine
              ? text.slice(openIdx + 1, i)
              : text.slice(openIdx + 1, i).replace(/\r?\n[ \t]+/gu, ' '),
          )
        ) {
          const authBoundaryEnd = onAuthParamBoundary()
          if (authBoundaryEnd > openIdx) {
            return authBoundaryEnd
          }
        }
        return i + 1
      }
      if (ch === '\r' || ch === '\n') {
        if (onStartLine && sawEscapedQuoteOnStartLine) {
          const startLineSlice = text.slice(openIdx + 1, i)
          const assignOffset = findInlineSecretAssignmentBefore(
            startLineSlice,
            startLineSlice.length,
            false,
          )
          if (assignOffset !== -1) {
            return openIdx + 1 + assignOffset
          }
        }
        onStartLine = false
        const nextLineStart = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1
        if (inPemBlock) {
          if (matchStickyAt(PEM_END_STICKY_RE, text, nextLineStart) !== null) {
            const pemEndPos = PEM_END_STICKY_RE.lastIndex
            return text[pemEndPos] === quote ? pemEndPos + 1 : pemEndPos
          }
          if (isLineStartKeyAssignment(text, nextLineStart, true)) {
            return i
          }
        } else if (crossedLineHasKeyAssignment(text, nextLineStart, false, quote)) {
          if (isAuthContext && onAuthParamBoundary !== undefined) {
            let np = nextLineStart
            while (np < text.length && (text[np] === ' ' || text[np] === '\t')) np += 1
            if (text[np] === ',' || text[np] === ';') {
              np += 1
              while (np < text.length && (text[np] === ' ' || text[np] === '\t')) np += 1
            }
            if (matchStickyAt(AUTH_PARAM_NAME_EQ_STICKY_RE, text, np) !== null) {
              const nextParamHead = text.slice(np, AUTH_PARAM_NAME_EQ_STICKY_RE.lastIndex)
              const foldedPrefix = text.slice(openIdx + 1, i).replace(/\r?\n[ \t]+/gu, ' ')
              const sep = foldedPrefix.length === 0 || /\s$/u.test(foldedPrefix) ? '' : ' '
              if (isAuthPrefixBeforeQuote(`${foldedPrefix}${sep}${nextParamHead}`)) {
                const authBoundaryEnd = onAuthParamBoundary()
                if (authBoundaryEnd > openIdx) {
                  return authBoundaryEnd
                }
              }
            }
          }
          return findLineEnd(text, openIdx + 1)
        }
        i = nextLineStart
        continue
      }
      i += 1
    }
    if (onStartLine && sawEscapedQuoteOnStartLine) {
      const startLineSlice = text.slice(openIdx + 1, text.length)
      const assignOffset = findInlineSecretAssignmentBefore(
        startLineSlice,
        startLineSlice.length,
        false,
      )
      if (assignOffset !== -1) {
        return openIdx + 1 + assignOffset
      }
    }
    if (inPemBlock) {
      return text.length
    }
    noClosingQuote[quote] = true
  }

  // Unclosed quote fallback: scrub to the end of the current line only
  return findLineEnd(text, openIdx + 1)
}

function findEffectiveLineEndBeforeComment(
  text: string,
  lineStart: number,
  lineEnd: number,
): number {
  let quote: string | null = null
  let k = lineStart
  let trailingCommentStart = -1
  while (k < lineEnd) {
    const ch = text[k]
    if (quote !== null) {
      if (text.charCodeAt(k) === 92 /* '\\' */) {
        k += 2
        continue
      }
      if (ch === quote) {
        quote = null
      }
      trailingCommentStart = -1
      k += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      trailingCommentStart = -1
      k += 1
      continue
    }
    if (
      (ch === '#' && (k === lineStart || /[\s,;[{]/u.test(text[k - 1] ?? ''))) ||
      (ch === '/' &&
        k + 1 < lineEnd &&
        text[k + 1] === '/' &&
        (k === lineStart || text[k - 1] !== ':'))
    ) {
      return trailingCommentStart !== -1 ? trailingCommentStart : k
    }
    if (ch === '/' && k + 1 < lineEnd && text[k + 1] === '*') {
      let closeIdx = -1
      for (let m = k + 2; m + 1 < lineEnd; m += 1) {
        if (text[m] === '*' && text[m + 1] === '/') {
          closeIdx = m
          break
        }
      }
      if (closeIdx === -1) {
        return trailingCommentStart !== -1 ? trailingCommentStart : k
      }
      if (trailingCommentStart === -1) {
        trailingCommentStart = k
      }
      k = closeIdx + 2
      continue
    }
    if (ch !== ' ' && ch !== '\t') {
      trailingCommentStart = -1
    }
    k += 1
  }
  return trailingCommentStart !== -1 ? trailingCommentStart : lineEnd
}

function lineEndsWithContainerToken(text: string, lineStart: number, lineEnd: number): boolean {
  const effectiveEnd = findEffectiveLineEndBeforeComment(text, lineStart, lineEnd)
  let p = effectiveEnd - 1
  while (p >= lineStart && (text[p] === ' ' || text[p] === '\t')) {
    p -= 1
  }
  if (p < lineStart) return false
  const ch = text[p]
  return ch === ',' || ch === '[' || ch === '{'
}

function updatePrevLineEndedWithDelim(
  text: string,
  lineStart: number,
  lineEnd: number,
  prevFlag: boolean,
): boolean {
  const effectiveEnd = findEffectiveLineEndBeforeComment(text, lineStart, lineEnd)
  let p = effectiveEnd - 1
  while (p >= lineStart && (text[p] === ' ' || text[p] === '\t')) {
    p -= 1
  }
  if (p < lineStart) return prevFlag
  const ch = text[p]
  return ch === ',' || ch === '[' || ch === '{'
}

function isContainerContinuationLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  prevLineEndedWithDelimOrComma: boolean,
  braceDepth = 0,
  otherDepth = 0,
): boolean {
  let p = lineStart
  while (p < lineEnd && (text[p] === ' ' || text[p] === '\t')) {
    p += 1
  }
  if (p >= lineEnd) return false
  const firstNonWs = text[p]
  if (
    firstNonWs === '"' ||
    firstNonWs === "'" ||
    firstNonWs === '`' ||
    firstNonWs === '[' ||
    firstNonWs === '{' ||
    firstNonWs === ']' ||
    firstNonWs === '}' ||
    firstNonWs === ',' ||
    firstNonWs === ';'
  ) {
    return true
  }
  if (firstNonWs === '/' && p + 1 < lineEnd && (text[p + 1] === '/' || text[p + 1] === '*')) {
    return true
  }
  if (firstNonWs === '#' && (prevLineEndedWithDelimOrComma || braceDepth > 0 || otherDepth > 0)) {
    return true
  }
  if (
    (firstNonWs === '-' || firstNonWs === '*') &&
    (text[p + 1] === ' ' || text[p + 1] === '\t')
  ) {
    return true
  }
  if (braceDepth > 0 && isObjectPropertyLine(text, lineStart, lineEnd, true)) {
    return true
  }
  if (!prevLineEndedWithDelimOrComma) return false
  return p > lineStart || lineEndsWithContainerToken(text, lineStart, lineEnd)
}

function hasEvenUnescapedQuotes(
  text: string,
  lineStart: number,
  lineEnd: number,
  quoteChar: string,
): boolean {
  let count = 0
  let idx = lineStart
  while (idx < lineEnd) {
    if (text.charCodeAt(idx) === 92 /* '\\' */) {
      idx += 2
      continue
    }
    if (text[idx] === quoteChar) {
      count += 1
    }
    idx += 1
  }
  return count >= 2 && count % 2 === 0
}

function nextNonEmptyLineStartsWithCloser(
  text: string,
  afterLineEnd: number,
  allowBracketClose: boolean,
  allowBraceClose: boolean,
): boolean {
  let pos = afterLineEnd
  while (pos < text.length) {
    if (text[pos] === '\r' && text[pos + 1] === '\n') pos += 2
    else if (text[pos] === '\r' || text[pos] === '\n') pos += 1
    else break
    const lineEnd = findLineEnd(text, pos)
    let p = pos
    while (p < lineEnd && (text[p] === ' ' || text[p] === '\t')) p += 1
    if (p < lineEnd) {
      return (allowBracketClose && text[p] === ']') || (allowBraceClose && text[p] === '}')
    }
    pos = lineEnd
  }
  return false
}

function skipLeadingHorizontalAndBlockComments(
  text: string,
  start: number,
  limit: number,
): number {
  let p = start
  while (p < limit) {
    if (text[p] === ' ' || text[p] === '\t') {
      p += 1
      continue
    }
    if (text[p] === '/' && p + 1 < limit && text[p + 1] === '*') {
      let closeIdx = -1
      for (let k = p + 2; k + 1 < limit; k += 1) {
        if (text[k] === '*' && text[k + 1] === '/') {
          closeIdx = k + 2
          break
        }
      }
      if (closeIdx === -1) return limit
      p = closeIdx
      continue
    }
    break
  }
  return p
}

function isObjectPropertyLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  allowUnquotedCol0 = false,
): boolean {
  let p = lineStart
  while (p < lineEnd && (text[p] === ' ' || text[p] === '\t')) {
    p += 1
  }
  const isCol0 = p === lineStart
  p = skipLeadingHorizontalAndBlockComments(text, p, lineEnd)
  if (p >= lineEnd) return false
  const ch = text[p]
  if (isCol0) {
    if (ch === '"' || ch === "'" || ch === '`') {
      return matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, p) !== null
    }
    if (!allowUnquotedCol0) return false
    const propMatch = matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, p)
    if (propMatch === null) return false
    let valStart = propMatch.index + propMatch[0].length
    while (valStart < lineEnd && (text[valStart] === ' ' || text[valStart] === '\t')) {
      valStart += 1
    }
    if (valStart >= lineEnd) return false
    const valChar = text[valStart]
    if (
      valChar === '"' ||
      valChar === "'" ||
      valChar === '`' ||
      valChar === '[' ||
      valChar === '{'
    ) {
      return true
    }
    const effectiveEnd = findEffectiveLineEndBeforeComment(text, valStart, lineEnd)
    let tailIdx = effectiveEnd - 1
    while (tailIdx >= valStart && (text[tailIdx] === ' ' || text[tailIdx] === '\t')) {
      tailIdx -= 1
    }
    return tailIdx >= valStart && text[tailIdx] === ','
  }
  return matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, p) !== null
}

function isUnquotedCol0NoCommaPropertyLine(
  text: string,
  lineStart: number,
  lineEnd: number,
): boolean {
  if (lineStart >= lineEnd) return false
  const firstCh = text[lineStart]
  if (firstCh === ' ' || firstCh === '\t' || firstCh === '"' || firstCh === "'" || firstCh === '`') {
    return false
  }
  const p = skipLeadingHorizontalAndBlockComments(text, lineStart, lineEnd)
  if (p >= lineEnd) return false
  const ch = text[p]
  if (ch === '"' || ch === "'" || ch === '`') return false
  return matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, p) !== null
}

function propertyLineHasTrailingProse(text: string, lineStart: number, lineEnd: number): boolean {
  const p = skipLeadingHorizontalAndBlockComments(text, lineStart, lineEnd)
  if (p >= lineEnd) return false
  const propMatch = matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, p)
  if (propMatch === null) return false
  let valStart = propMatch.index + propMatch[0].length
  while (valStart < lineEnd && (text[valStart] === ' ' || text[valStart] === '\t')) {
    valStart += 1
  }
  if (valStart >= lineEnd) return false
  const valChar = text[valStart]
  if (valChar === '[' || valChar === '{') return false

  let afterVal = valStart
  if (valChar === '"' || valChar === "'" || valChar === '`') {
    let j = valStart + 1
    while (j < lineEnd) {
      if (text.charCodeAt(j) === 92 /* '\\' */) {
        j += 2
        continue
      }
      if (text[j] === valChar) {
        afterVal = j + 1
        break
      }
      j += 1
    }
    if (afterVal === valStart) return false
  } else {
    while (
      afterVal < lineEnd &&
      text[afterVal] !== ' ' &&
      text[afterVal] !== '\t' &&
      text[afterVal] !== ',' &&
      text[afterVal] !== ';' &&
      text[afterVal] !== '}' &&
      text[afterVal] !== ']'
    ) {
      afterVal += 1
    }
  }

  while (afterVal < lineEnd && (text[afterVal] === ' ' || text[afterVal] === '\t')) {
    afterVal += 1
  }
  if (afterVal >= lineEnd) return false
  const tail = text[afterVal]
  if (
    tail === ',' ||
    tail === ';' ||
    tail === '}' ||
    tail === ']' ||
    tail === '#' ||
    (tail === '/' && (text[afterVal + 1] === '/' || text[afterVal + 1] === '*'))
  ) {
    return false
  }
  return true
}

function findDelimitedValueEnd(
  text: string,
  openIdx: number,
  unclosedDelimiterPositions: Set<number>,
  findBlockCommentClose?: BlockCommentCloseFinder,
): number {
  const openChar = text[openIdx]
  if (openChar !== '[' && openChar !== '{') return -1

  if (unclosedDelimiterPositions.has(openIdx)) {
    return findLineEnd(text, openIdx + 1)
  }
  const resolveBlockClose = findBlockCommentClose ?? createBlockCommentCloseFinder(text)

  const primaryOpen = openChar
  const primaryClose = openChar === '[' ? ']' : '}'
  const otherOpen = openChar === '[' ? '{' : '['

  const unmatchedPrimaryStack: Array<{ readonly pos: number; readonly otherDepth: number }> = [
    { pos: openIdx, otherDepth: 0 },
  ]
  const unmatchedOtherStack: Array<{ readonly pos: number }> = []
  const recordUnclosedAtBreak = (requireZeroOtherDepth: boolean): void => {
    for (const entry of unmatchedPrimaryStack) {
      if (!requireZeroOtherDepth || entry.otherDepth === 0) {
        unclosedDelimiterPositions.add(entry.pos)
      }
    }
    for (const entry of unmatchedOtherStack) {
      unclosedDelimiterPositions.add(entry.pos)
    }
  }

  const firstLineEnd = findLineEnd(text, openIdx + 1)
  let containerEndPos = firstLineEnd
  let unclosedAssignBreakPos = -1
  let tentativeCol0BreakPos = -1
  let sawNonContainerLine = false
  let prevLineEndedWithDelimOrComma = lineEndsWithContainerToken(text, openIdx, firstLineEnd)
  const pickBreakPos = (fallbackPos: number): number => {
    if (unclosedAssignBreakPos !== -1 && tentativeCol0BreakPos !== -1) {
      return Math.min(unclosedAssignBreakPos, tentativeCol0BreakPos)
    }
    if (unclosedAssignBreakPos !== -1) return unclosedAssignBreakPos
    if (tentativeCol0BreakPos !== -1) return tentativeCol0BreakPos
    return fallbackPos
  }

  let i = openIdx + 1
  let primaryDepth = 1
  let otherDepth = 0
  let braceDepth = openChar === '{' ? 1 : 0
  let activeQuote: string | null = null
  let inActiveQuotePem = false
  let inBlockComment = false
  let lineStartedInBlockComment = false
  while (i < text.length) {
    const ch = text[i]
    if (inBlockComment) {
      if (ch === '*' && text[i + 1] === '/') {
        inBlockComment = false
        if (lineStartedInBlockComment) {
          lineStartedInBlockComment = false
          const codeStart = i + 2
          const curLineEnd = findLineEnd(text, codeStart)
          prevLineEndedWithDelimOrComma = updatePrevLineEndedWithDelim(
            text,
            codeStart,
            curLineEnd,
            prevLineEndedWithDelimOrComma,
          )
        }
        i += 2
        continue
      }
      if (ch === '\r' || ch === '\n') {
        const nextLineStart = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1
        const nextLineEnd = findLineEnd(text, nextLineStart)
        const requireSecretKey = braceDepth > 0 || otherDepth > 0
        if (crossedLineHasKeyAssignment(text, nextLineStart, false, null, requireSecretKey)) {
          recordUnclosedAtBreak(false)
          return pickBreakPos(sawNonContainerLine ? containerEndPos : i)
        }
        if (!sawNonContainerLine) {
          containerEndPos = nextLineEnd
        }
        lineStartedInBlockComment = true
        i = nextLineStart
        continue
      }
      i += 1
      continue
    }
    if (activeQuote !== null) {
      if (text.charCodeAt(i) === 92 /* '\\' */) {
        if (i + 1 < text.length && (text[i + 1] === '\r' || text[i + 1] === '\n')) {
          i += 1
          continue
        }
        i += 2
        continue
      }
      if (ch === activeQuote) {
        activeQuote = null
        inActiveQuotePem = false
        i += 1
        continue
      }
      if (ch === '\r' || ch === '\n') {
        const nextLineStart = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1
        const nextLineEnd = findLineEnd(text, nextLineStart)
        const requireSecretKey = braceDepth > 0 || otherDepth > 0
        if (
          crossedLineHasKeyAssignment(
            text,
            nextLineStart,
            inActiveQuotePem,
            activeQuote,
            requireSecretKey,
          )
        ) {
          if (braceDepth > 0 && isObjectPropertyLine(text, nextLineStart, nextLineEnd, true)) {
            if (unclosedAssignBreakPos === -1) {
              unclosedAssignBreakPos = sawNonContainerLine ? containerEndPos : i
            }
          } else if (
            braceDepth > 0 &&
            isUnquotedCol0NoCommaPropertyLine(text, nextLineStart, nextLineEnd)
          ) {
            if (tentativeCol0BreakPos === -1) {
              tentativeCol0BreakPos = sawNonContainerLine ? containerEndPos : i
            }
          } else {
            recordUnclosedAtBreak(false)
            return pickBreakPos(sawNonContainerLine ? containerEndPos : i)
          }
        }
        if (!inActiveQuotePem) {
          const elemMatch = matchStickyAt(ARRAY_ELEMENT_OR_CLOSE_STICKY_RE, text, nextLineStart)
          if (
            (elemMatch !== null && (elemMatch[1] === undefined || elemMatch[1] === activeQuote)) ||
            hasEvenUnescapedQuotes(text, nextLineStart, nextLineEnd, activeQuote)
          ) {
            activeQuote = null
            inActiveQuotePem = false
          }
        }
        let p = nextLineStart
        while (p < nextLineEnd && (text[p] === ' ' || text[p] === '\t')) p += 1
        if (p < nextLineEnd && !sawNonContainerLine) {
          if (
            isContainerContinuationLine(
              text,
              nextLineStart,
              nextLineEnd,
              prevLineEndedWithDelimOrComma,
              braceDepth,
              otherDepth,
            )
          ) {
            containerEndPos = nextLineEnd
            prevLineEndedWithDelimOrComma = updatePrevLineEndedWithDelim(
              text,
              nextLineStart,
              nextLineEnd,
              prevLineEndedWithDelimOrComma,
            )
          } else if (
            braceDepth > 0 &&
            isUnquotedCol0NoCommaPropertyLine(text, nextLineStart, nextLineEnd)
          ) {
            if (tentativeCol0BreakPos === -1) {
              tentativeCol0BreakPos = containerEndPos
            }
            containerEndPos = nextLineEnd
            prevLineEndedWithDelimOrComma = false
          } else {
            sawNonContainerLine = true
          }
        }
        lineStartedInBlockComment = false
        i = nextLineStart
        continue
      }
      i += 1
      continue
    }

    if (ch === '#' && (i === openIdx + 1 || /[\s,;[{]/u.test(text[i - 1] ?? ''))) {
      i = findLineEnd(text, i)
      continue
    }
    if (
      ch === '/' &&
      i + 1 < text.length &&
      text[i + 1] === '/' &&
      (i === openIdx + 1 || text[i - 1] !== ':')
    ) {
      i = findLineEnd(text, i)
      continue
    }
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      const closeEnd = resolveBlockClose(i)
      if (closeEnd !== -1) {
        const curLineEnd = findLineEnd(text, i)
        const closeLineEnd = findLineEnd(text, closeEnd)
        if (closeLineEnd !== curLineEnd) {
          prevLineEndedWithDelimOrComma = updatePrevLineEndedWithDelim(
            text,
            closeEnd,
            closeLineEnd,
            prevLineEndedWithDelimOrComma,
          )
          if (!sawNonContainerLine && closeLineEnd > containerEndPos) {
            containerEndPos = closeLineEnd
          }
        }
        i = closeEnd
        continue
      }
      inBlockComment = true
      i += 2
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      activeQuote = ch
      inActiveQuotePem = matchStickyAt(PEM_OPEN_OPT_NL_STICKY_RE, text, i + 1) !== null
    } else if (ch === primaryOpen) {
      primaryDepth += 1
      if (primaryOpen === '{') braceDepth += 1
      unmatchedPrimaryStack.push({ pos: i, otherDepth })
    } else if (ch === primaryClose) {
      primaryDepth -= 1
      if (primaryClose === '}' && braceDepth > 0) braceDepth -= 1
      if (unmatchedPrimaryStack.length > 0) {
        unmatchedPrimaryStack.pop()
      }
      if (primaryDepth === 0) {
        return i + 1
      }
    } else if (ch === otherOpen) {
      otherDepth += 1
      if (otherOpen === '{') braceDepth += 1
      unmatchedOtherStack.push({ pos: i })
    } else if (ch === (openChar === '[' ? '}' : ']')) {
      if (otherDepth > 0) {
        otherDepth -= 1
      }
      if (unmatchedOtherStack.length > 0) {
        unmatchedOtherStack.pop()
      }
      if (openChar === '[' && braceDepth > 0) {
        braceDepth -= 1
      }
    } else if (ch === '\r' || ch === '\n') {
      const nextLineStart = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1
      const nextLineEnd = findLineEnd(text, nextLineStart)
      const requireSecretKey = braceDepth > 0 || otherDepth > 0
      let matchedNoCommaCol0Secret = false
      if (crossedLineHasKeyAssignment(text, nextLineStart, false, null, requireSecretKey)) {
        if (braceDepth > 0 && isObjectPropertyLine(text, nextLineStart, nextLineEnd, true)) {
          if (
            unclosedAssignBreakPos === -1 &&
            propertyLineHasTrailingProse(text, nextLineStart, nextLineEnd)
          ) {
            unclosedAssignBreakPos = sawNonContainerLine ? containerEndPos : i
          }
        } else if (
          braceDepth > 0 &&
          isUnquotedCol0NoCommaPropertyLine(text, nextLineStart, nextLineEnd)
        ) {
          matchedNoCommaCol0Secret = true
          if (tentativeCol0BreakPos === -1) {
            tentativeCol0BreakPos = sawNonContainerLine ? containerEndPos : i
          }
        } else {
          recordUnclosedAtBreak(false)
          return pickBreakPos(sawNonContainerLine ? containerEndPos : i)
        }
      }
      let p = nextLineStart
      while (p < nextLineEnd && (text[p] === ' ' || text[p] === '\t')) p += 1
      if (p < nextLineEnd && !sawNonContainerLine) {
        if (
          !matchedNoCommaCol0Secret &&
          isContainerContinuationLine(
            text,
            nextLineStart,
            nextLineEnd,
            prevLineEndedWithDelimOrComma,
            braceDepth,
            otherDepth,
          )
        ) {
          containerEndPos = nextLineEnd
          prevLineEndedWithDelimOrComma = updatePrevLineEndedWithDelim(
            text,
            nextLineStart,
            nextLineEnd,
            prevLineEndedWithDelimOrComma,
          )
        } else if (
          braceDepth > 0 &&
          isUnquotedCol0NoCommaPropertyLine(text, nextLineStart, nextLineEnd)
        ) {
          if (tentativeCol0BreakPos === -1) {
            tentativeCol0BreakPos = containerEndPos
          }
          containerEndPos = nextLineEnd
          prevLineEndedWithDelimOrComma = false
        } else if (
          prevLineEndedWithDelimOrComma &&
          nextNonEmptyLineStartsWithCloser(
            text,
            nextLineEnd,
            (primaryClose === ']' && primaryDepth > 0) || (primaryClose === '}' && otherDepth > 0),
            (primaryClose === '}' && primaryDepth > 0) || (primaryClose === ']' && otherDepth > 0),
          )
        ) {
          containerEndPos = nextLineEnd
          prevLineEndedWithDelimOrComma = false
        } else {
          sawNonContainerLine = true
          recordUnclosedAtBreak(false)
          return pickBreakPos(containerEndPos)
        }
      }
      lineStartedInBlockComment = false
      i = nextLineStart
      continue
    }
    i += 1
  }

  recordUnclosedAtBreak(false)
  return pickBreakPos(containerEndPos)
}

function findUnquotedPemValueEnd(text: string, valueStart: number, pemBodyStart: number): number {
  let i = pemBodyStart
  while (i < text.length) {
    const ch = text[i]
    if (ch === '-' && matchStickyAt(PEM_END_STICKY_RE, text, i) !== null) {
      return PEM_END_STICKY_RE.lastIndex
    }
    if (ch === '\r' || ch === '\n') {
      const nextLineStart = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1
      if (isLineStartKeyAssignment(text, nextLineStart, true)) {
        return i >= valueStart ? i : findLineEnd(text, valueStart)
      }
      i = nextLineStart
      continue
    }
    i += 1
  }
  return text.length
}

function findYamlBlockScalarEnd(text: string, matchIndex: number, blockHeaderEnd: number): number {
  let keyLineStart = matchIndex
  while (keyLineStart > 0 && text[keyLineStart - 1] !== '\n' && text[keyLineStart - 1] !== '\r') {
    keyLineStart -= 1
  }
  let listMarkerIndent = 0
  while (
    keyLineStart + listMarkerIndent < matchIndex &&
    (text[keyLineStart + listMarkerIndent] === ' ' || text[keyLineStart + listMarkerIndent] === '\t')
  ) {
    listMarkerIndent += 1
  }
  let keyIndent = listMarkerIndent
  let hasListMarker = false
  if (
    keyLineStart + keyIndent + 1 < matchIndex &&
    (text[keyLineStart + keyIndent] === '-' || text[keyLineStart + keyIndent] === '*') &&
    (text[keyLineStart + keyIndent + 1] === ' ' || text[keyLineStart + keyIndent + 1] === '\t')
  ) {
    hasListMarker = true
    keyIndent += 2
    while (
      keyLineStart + keyIndent < matchIndex &&
      (text[keyLineStart + keyIndent] === ' ' || text[keyLineStart + keyIndent] === '\t')
    ) {
      keyIndent += 1
    }
  }

  let lastContentEnd = blockHeaderEnd
  let pos = blockHeaderEnd
  while (pos < text.length) {
    if (text[pos] === '\r' && text[pos + 1] === '\n') {
      pos += 2
    } else if (text[pos] === '\r' || text[pos] === '\n') {
      pos += 1
    } else {
      break
    }
    const lineStart = pos
    const lineEnd = findLineEnd(text, lineStart)
    let p = lineStart
    while (p < lineEnd && (text[p] === ' ' || text[p] === '\t')) {
      p += 1
    }
    if (p < lineEnd) {
      const indent = p - lineStart
      const isValidIndent = hasListMarker
        ? indent > keyIndent ||
          (indent > listMarkerIndent &&
            !(indent === keyIndent && isLineStartKeyAssignment(text, lineStart, false)))
        : indent > keyIndent
      if (isValidIndent) {
        lastContentEnd = lineEnd
        pos = lineEnd
        continue
      }
      break
    }
    pos = lineEnd
  }
  return lastContentEnd
}

function matchesSecretParts(rawParts: readonly string[], hasDigit = false): boolean {
  const lowerParts = rawParts.map((part) => part.toLowerCase())
  for (let idx = 0; idx < rawParts.length; idx += 1) {
    const rawPart = rawParts[idx]!
    const part = lowerParts[idx]!
    if (
      SECRET_EXACT_TOKENS.has(part) ||
      UNSEPARATED_SECRET_SUFFIX_RE.test(part) ||
      TITLECASE_SECRET_PREFIX_RE.test(rawPart)
    ) {
      return true
    }
    if (
      rawParts.length >= 2 &&
      (hasDigit
        ? DIGIT_SEP_SECRET_STEM_RE.test(part) || DIGIT_SEP_UNSEPARATED_STEM_RE.test(part)
        : /^(?:AUTH|SESSION|CRED|APIKEY|BEARER|TOKEN|SECRET|PASSPHRASES?|PASSWORD|PASSWD|PWD|COOKIE|PASS|JWT|Passphrases?|Pass|Jwt)$/u.test(
            rawPart,
          ))
    ) {
      return true
    }
    if (idx + 1 < lowerParts.length) {
      const nextPart = lowerParts[idx + 1]!
      if (SECRET_EXACT_TOKENS.has(`${part}_${nextPart}`)) {
        return true
      }
      if (
        (part === 'api' ||
          part === 'client' ||
          part === 'jwt' ||
          part === 'deploy' ||
          part === 'app' ||
          part === 'hmac' ||
          part === 'tls' ||
          part === 'ssl' ||
          part === 'aes' ||
          part === 'kms' ||
          part === 'fernet' ||
          part === 'cipher' ||
          part === 'pk' ||
          part === 'sk' ||
          part === 'rk' ||
          part === 'whsec' ||
          part === 'ghp' ||
          part === 'gho' ||
          part === 'ghu' ||
          part === 'ghs' ||
          part === 'ghr' ||
          part === 'glpat' ||
          part === 'npm' ||
          part === 'xoxb' ||
          part === 'xoxp' ||
          part === 'xoxa' ||
          part === 'xoxr' ||
          part === 'githubpat') &&
        nextPart.startsWith('key')
      ) {
        return true
      }
      if (
        idx + 2 < lowerParts.length &&
        part === 'github' &&
        nextPart === 'pat' &&
        lowerParts[idx + 2]!.startsWith('key')
      ) {
        return true
      }
      if (idx === lowerParts.length - 2 && part === 'github' && nextPart === 'pat') {
        return true
      }
    }
  }
  return false
}

function hasSecretStem(ident: string): boolean {
  const hasDigit = /\d/u.test(ident)
  const prep = ident.replace(/([A-Za-z])([vV]\d+)$/u, '$1_$2')
  const camelSplit = prep
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/\d+/gu, '_')
  const camelParts = camelSplit.split(/[._-]+/u).filter((part) => part.length > 0)
  if (matchesSecretParts(camelParts, hasDigit)) return true

  const acronymLowerSplit = prep
    .replace(/([A-Z]{2,})([a-z]+)/gu, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/\d+/gu, '_')
  const acronymParts = acronymLowerSplit.split(/[._-]+/u).filter((part) => part.length > 0)
  return matchesSecretParts(acronymParts, hasDigit)
}

function isIdentifierLikeSecretKey(ident: string): boolean {
  const lower = ident.toLowerCase()
  if (
    SECRET_EXACT_TOKENS.has(lower) ||
    CAMEL_OR_NUMBERED_SECRET_SUFFIX_RE.test(ident) ||
    /[._-]/u.test(lower) ||
    !/[A-Z]/u.test(ident) ||
    /^[A-Z][a-z0-9]*$/u.test(ident) ||
    /^[A-Z]+\d*$/u.test(ident)
  ) {
    return true
  }
  const prep = ident.replace(/([A-Za-z])([vV]\d+)$/u, '$1_$2')
  const splitParts = (raw: string): string[] =>
    raw.split(/[._-]+/u).filter((part) => part.length > 0)
  const noMidBase64DigitSplit = (raw: string): string[] =>
    splitParts(
      raw
        .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
        .replace(/([a-z0-9])([A-Z])/gu, '$1_$2'),
    )
  const acronymNoMidDigitSplit = (raw: string): string[] =>
    splitParts(
      raw
        .replace(/([A-Z]{2,})([a-z]+)/gu, '$1_$2')
        .replace(/([a-z0-9])([A-Z])/gu, '$1_$2'),
    )
  const checkPartsNoMidDigit = (parts: readonly string[]): boolean => {
    const lowerParts = parts.map((p) => p.toLowerCase())
    const strippedLowerParts = parts.map((p) => p.replace(/\d+$/u, '').toLowerCase())
    const isValidAcronymPos = (atIdx: number): boolean =>
      atIdx === 0 ||
      parts
        .slice(0, atIdx)
        .every((prev) => /^(?:[A-Z][a-z]+|[a-z]{2,}|[A-Z]{2,}|[a-z](?=\d))(?:\d+[a-z]*)?$/u.test(prev))
    for (let idx = 0; idx < parts.length; idx += 1) {
      const rawPart = parts[idx]!
      const part = lowerParts[idx]!
      const strippedRaw = rawPart.replace(/\d+$/u, '')
      const strippedPart = strippedLowerParts[idx]!
      if (
        SECRET_EXACT_TOKENS.has(part) ||
        SECRET_EXACT_TOKENS.has(strippedPart) ||
        TITLECASE_SECRET_PREFIX_RE.test(rawPart)
      ) {
        return true
      }
      if (/^[A-Z]?[a-z]+$/u.test(strippedRaw) && UNSEPARATED_SECRET_SUFFIX_RE.test(strippedPart)) {
        return true
      }
      if (
        KNOWN_NUM_SECRET_PREFIX_RE.test(rawPart) &&
        (!/^[A-Z]{2,}\d+/u.test(rawPart) || isValidAcronymPos(idx))
      ) {
        return true
      }
      const digitSepMatch = /^([A-Z][a-z]+|[A-Z]{2,}|[A-Z]|[a-z]+)\d+([A-Za-z0-9]+)$/u.exec(rawPart)
      if (digitSepMatch !== null) {
        const prefix = digitSepMatch[1]!
        const tail = digitSepMatch[2]!
        const prefixValid =
          /^[A-Z]$/u.test(prefix)
            ? idx > 0 && isValidAcronymPos(idx)
            : !/^[A-Z]{2,}$/u.test(prefix) || isValidAcronymPos(idx)
        if (
          prefixValid &&
          (DIGIT_SEP_SECRET_STEM_RE.test(tail) || DIGIT_SEP_UNSEPARATED_STEM_RE.test(tail))
        ) {
          return true
        }
      }
      if (idx > 0) {
        const prevPart = parts[idx - 1]!
        const prevValid =
          /^(?:[A-Z][a-z]+|[A-Z]{2,}|[a-z]+)\d+[a-z]*$/u.test(prevPart) &&
          (!/^[A-Z]{2,}\d+/u.test(prevPart) || isValidAcronymPos(idx - 1)) &&
          (!/^[a-z]\d+[a-z]+$/u.test(prevPart) || isValidAcronymPos(idx - 1))
        if (
          prevValid &&
          (DIGIT_SEP_SECRET_STEM_RE.test(part) || DIGIT_SEP_UNSEPARATED_STEM_RE.test(part))
        ) {
          return true
        }
      }
      if (
        idx + 1 < lowerParts.length &&
        (SECRET_EXACT_TOKENS.has(`${part}_${lowerParts[idx + 1]!}`) ||
          SECRET_EXACT_TOKENS.has(`${strippedPart}_${strippedLowerParts[idx + 1]!}`))
      ) {
        return true
      }
    }
    return false
  }
  if (
    checkPartsNoMidDigit(noMidBase64DigitSplit(prep)) ||
    checkPartsNoMidDigit(acronymNoMidDigitSplit(prep))
  ) {
    return true
  }
  if (
    (/[A-Z][a-z]+$/u.test(ident) ||
      (/[A-Za-z][vV]\d+$/u.test(ident) && !/^[a-z][A-Z]\d+[a-z]/u.test(ident))) &&
    hasSecretStem(ident)
  ) {
    return true
  }
  return false
}

function isNextKeyAssignmentAt(text: string, valueStart: number, allowNonSecretNext: boolean): boolean {
  const hadSpaceBeforeValue =
    valueStart > 0 && (text[valueStart - 1] === ' ' || text[valueStart - 1] === '\t')

  const assignMatch = matchStickyAt(NEXT_KEY_ASSIGNMENT_STICKY_RE, text, valueStart)
  if (assignMatch !== null) {
    const baseIdent = assignMatch[3] ?? assignMatch[2] ?? ''
    const segments = extractSubscriptSegments(assignMatch[4])
    const preOpSpace = assignMatch[5] ?? ''
    const op = assignMatch[6] ?? ''
    const opSpace = assignMatch[7] ?? ''
    const rhsChar = assignMatch[8] ?? ''
    const isSecretIdent = (s: string): boolean =>
      s.toLowerCase() === 'pass' || SECRET_KEY_PART_RE.test(s) || hasSecretStem(s)
    const isSecretNext = isSecretIdent(baseIdent) || segments.some((seg) => isSecretIdent(seg))

    if (isSecretNext) {
      const prevChar = valueStart > 0 ? text[valueStart - 1] : undefined
      const hasBase64Shape =
        segments.length === 0 &&
        ((/[A-Z]/u.test(baseIdent) && /[a-z]/u.test(baseIdent)) || /\d/u.test(baseIdent))
      if (
        !hadSpaceBeforeValue &&
        prevChar !== undefined &&
        !/\s/u.test(prevChar) &&
        preOpSpace.length === 0 &&
        op === '==' &&
        opSpace.length > 0 &&
        hasBase64Shape &&
        !isIdentifierLikeSecretKey(baseIdent) &&
        rhsChar !== '"' &&
        rhsChar !== "'" &&
        rhsChar !== '`' &&
        rhsChar !== '[' &&
        rhsChar !== '{'
      ) {
        return false
      }
      return true
    }

    if (
      allowNonSecretNext &&
      hadSpaceBeforeValue &&
      op !== '==' &&
      (rhsChar === '"' || rhsChar === "'" || rhsChar === '`' || rhsChar === '[' || rhsChar === '{')
    ) {
      return true
    }
    return false
  }

  if (hadSpaceBeforeValue) {
    const spaceQuoteMatch = matchStickyAt(NEXT_SECRET_SPACE_QUOTE_STICKY_RE, text, valueStart)
    if (spaceQuoteMatch !== null) {
      const nextKey = spaceQuoteMatch[3] ?? spaceQuoteMatch[2] ?? ''
      if (SECRET_KEY_PART_RE.test(nextKey)) {
        return true
      }
    }
  }

  return false
}

function matchAuthParamSepEnd(
  text: string,
  pos: number,
  allowSpaceSep: boolean,
  minFoldedIndent?: number,
  allowSemi = allowSpaceSep,
): number {
  let p = pos
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
    p += 1
  }
  if (p < text.length && (text[p] === '\r' || text[p] === '\n')) {
    const folded = matchStickyAt(/\r?\n([ \t]+)/yu, text, p)
    if (folded !== null) {
      const afterFold = folded.index + folded[0].length
      const foldIndent = (folded[1] ?? '').length
      if (
        afterFold < text.length &&
        (text[afterFold] === ',' || (allowSemi && text[afterFold] === ';'))
      ) {
        p = afterFold
      } else if (
        allowSpaceSep &&
        minFoldedIndent !== undefined &&
        foldIndent >= minFoldedIndent &&
        afterFold < text.length
      ) {
        return afterFold
      }
    }
  }
  if (p < text.length && (text[p] === ',' || (allowSemi && text[p] === ';'))) {
    p += 1
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
      p += 1
    }
    if (p < text.length && (text[p] === '\r' || text[p] === '\n')) {
      const folded = matchStickyAt(/\r?\n[ \t]+/yu, text, p)
      if (folded !== null) {
        p = folded.index + folded[0].length
      }
    }
    return p
  }
  if (allowSpaceSep && p > pos) {
    return p
  }
  return -1
}

function consumeSingleAuthParamEnd(
  text: string,
  segStart: number,
  noClosingQuote: Record<string, boolean>,
  allowColonOp = false,
): { readonly endPos: number; readonly isSecretOrQuoted: boolean } | null {
  const nameOpRe = allowColonOp
    ? AUTH_PARAM_NAME_COLON_OR_EQ_STICKY_RE
    : AUTH_PARAM_NAME_EQ_STICKY_RE
  const nameEqMatch = matchStickyAt(nameOpRe, text, segStart)
  if (nameEqMatch === null) return null
  const opEnd = nameOpRe.lastIndex
  const paramKey = text.slice(segStart, opEnd).replace(/[ \t]*(?::=|==|:|=)$/u, '').replace(/^["'`]|["'`]$/gu, '')
  let valStart = opEnd
  while (valStart < text.length && (text[valStart] === ' ' || text[valStart] === '\t')) {
    valStart += 1
  }
  const hadSpaceAfterOp = valStart > opEnd
  if (valStart >= text.length) return { endPos: opEnd, isSecretOrQuoted: SECRET_KEY_PART_RE.test(paramKey) }
  const valChar = text[valStart]
  if (valChar === '[' || valChar === '{') {
    return null
  }
  if (valChar === '"' || valChar === "'" || valChar === '`') {
    return {
      endPos: findQuotedValueEnd(text, valStart, noClosingQuote),
      isSecretOrQuoted: true,
    }
  }
  if (valChar === '\\') {
    const escEnd = matchEscapedQuotedValueEnd(text, valStart)
    if (escEnd !== -1) {
      return {
        endPos: escEnd,
        isSecretOrQuoted: true,
      }
    }
  }
  if (
    hadSpaceAfterOp &&
    (matchStickyAt(AUTH_PARAM_NAME_EQ_STICKY_RE, text, valStart) !== null ||
      (allowColonOp && matchStickyAt(AUTH_PARAM_NAME_COLON_STICKY_RE, text, valStart) !== null) ||
      isNextKeyAssignmentAt(text, valStart, true))
  ) {
    return { endPos: opEnd, isSecretOrQuoted: SECRET_KEY_PART_RE.test(paramKey) }
  }
  const unquotedRe = /[^\s"'`<>|,{}[\]]+/yu
  if (matchStickyAt(unquotedRe, text, valStart) !== null) {
    return {
      endPos: unquotedRe.lastIndex,
      isSecretOrQuoted: SECRET_KEY_PART_RE.test(paramKey),
    }
  }
  return { endPos: opEnd, isSecretOrQuoted: SECRET_KEY_PART_RE.test(paramKey) }
}

function resolveCommaAuthParamsEnd(
  text: string,
  credStart: number,
  noClosingQuote: Record<string, boolean>,
  allowSpaceOrSemiSep = false,
  allowColonOp = false,
  foldedOriginPos?: number,
  requireMultiOrSecretOnColonOp = false,
): number {
  const firstParam = consumeSingleAuthParamEnd(text, credStart, noClosingQuote, allowColonOp)
  if (firstParam === null) return -1
  let endPos = firstParam.endPos
  let paramCount = 1

  let cachedMinFoldedIndent: number | undefined
  while (endPos < text.length) {
    let minFoldedIndent: number | undefined
    if (foldedOriginPos !== undefined && allowSpaceOrSemiSep) {
      let p = endPos
      while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p += 1
      if (p < text.length && (text[p] === '\r' || text[p] === '\n')) {
        if (cachedMinFoldedIndent === undefined) {
          cachedMinFoldedIndent = Math.max(1, getLineIndentAt(text, foldedOriginPos))
        }
        minFoldedIndent = cachedMinFoldedIndent
      }
    }
    const nextSegStart = matchAuthParamSepEnd(
      text,
      endPos,
      allowSpaceOrSemiSep,
      minFoldedIndent,
      allowSpaceOrSemiSep,
    )
    if (nextSegStart === -1) break
    const nextParam = consumeSingleAuthParamEnd(text, nextSegStart, noClosingQuote, allowColonOp)
    if (nextParam === null) break
    endPos = nextParam.endPos
    paramCount += 1
  }
  if (requireMultiOrSecretOnColonOp && paramCount < 2 && !firstParam.isSecretOrQuoted) {
    return -1
  }
  return endPos
}

function getLineIndentAt(text: string, pos: number): number {
  let lineStart = pos
  while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
    lineStart -= 1
  }
  let p = lineStart
  while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
    p += 1
  }
  return p - lineStart
}

function consumePostSchemeCredentialEnd(
  text: string,
  schemeEnd: number,
  afterWsPos: number,
  isKnownScheme: boolean,
  allowSpaceOrSemiAuthParams: boolean,
  isCookie: boolean,
  noClosingQuote: Record<string, boolean>,
  unclosedDelimiterPositions: Set<number>,
  findBlockCommentClose?: BlockCommentCloseFinder,
): number {
  let credPos = afterWsPos
  let wasFolded = false
  let foldedIndent = 0
  if (credPos < text.length && (text[credPos] === '\r' || text[credPos] === '\n')) {
    const foldedMatch = matchStickyAt(/\r?\n([ \t]+)/yu, text, credPos)
    if (foldedMatch !== null) {
      credPos = foldedMatch.index + foldedMatch[0].length
      wasFolded = true
      foldedIndent = (foldedMatch[1] ?? '').length
    }
  }

  if (!isCookie) {
    const schemeLineIndent = getLineIndentAt(text, schemeEnd)
    const allowColonOp = !wasFolded || foldedIndent >= Math.max(1, schemeLineIndent)
    const multiParamEnd = resolveCommaAuthParamsEnd(
      text,
      credPos,
      noClosingQuote,
      allowSpaceOrSemiAuthParams,
      allowColonOp,
      schemeEnd,
    )
    if (multiParamEnd !== -1) {
      return multiParamEnd
    }
  }

  if (
    isNextKeyAssignmentAt(text, credPos, !isCookie) ||
    (wasFolded && matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, credPos) !== null)
  ) {
    return schemeEnd
  }

  if (credPos >= text.length) {
    return schemeEnd
  }

  const credFirstChar = text[credPos]
  if (credFirstChar === '"' || credFirstChar === "'" || credFirstChar === '`') {
    return findQuotedValueEnd(text, credPos, noClosingQuote)
  }
  if (credFirstChar === '\\') {
    const escEnd = matchEscapedQuotedValueEnd(text, credPos)
    if (escEnd !== -1) {
      if (!isCookie) {
        const nextSep = matchAuthParamSepEnd(
          text,
          escEnd,
          allowSpaceOrSemiAuthParams,
          undefined,
          allowSpaceOrSemiAuthParams,
        )
        if (nextSep !== -1) {
          const trailingParamsEnd = resolveCommaAuthParamsEnd(
            text,
            nextSep,
            noClosingQuote,
            allowSpaceOrSemiAuthParams,
            !wasFolded || foldedIndent >= Math.max(1, getLineIndentAt(text, schemeEnd)),
            schemeEnd,
          )
          if (trailingParamsEnd !== -1) {
            return trailingParamsEnd
          }
        }
      }
      return escEnd
    }
  }
  if (credFirstChar === '[' || credFirstChar === '{') {
    return findDelimitedValueEnd(
      text,
      credPos,
      unclosedDelimiterPositions,
      findBlockCommentClose,
    )
  }

  const tokenRe = /[^\s"'`<>|;,{}[\]]{2,}/yu
  const tokenMatch = matchStickyAt(tokenRe, text, credPos)
  if (tokenMatch !== null) {
    const cred = tokenMatch[0]
    if (isKnownScheme) {
      return tokenRe.lastIndex
    }
    if (
      SECRET_VALUE_CHAR_RE.test(cred) ||
      (/[A-Z]/u.test(cred) && /[a-z]/u.test(cred)) ||
      (cred.length >= 8 && !STOPWORDS.has(cred.toLowerCase()))
    ) {
      return tokenRe.lastIndex
    }
  }

  return schemeEnd
}

function resolveAuthValueEnd(
  text: string,
  authStart: number,
  allowScalarOnlyFallback: boolean,
  noClosingQuote: Record<string, boolean>,
  unclosedDelimiterPositions: Set<number>,
  headerLineOriginPos = authStart,
  findBlockCommentClose?: BlockCommentCloseFinder,
): number {
  if (authStart >= text.length) return -1
  const firstChar = text[authStart]
  if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
    const quotedSchemeMatch = matchStickyAt(QUOTED_AUTH_SCHEME_STICKY_RE, text, authStart)
    if (quotedSchemeMatch !== null) {
      const rawScheme = quotedSchemeMatch[1] ?? quotedSchemeMatch[2] ?? quotedSchemeMatch[3] ?? ''
      const schemeEnd = authStart + rawScheme.length + 2
      const afterSchemeSep = quotedSchemeMatch[0].slice(rawScheme.length + 2)
      if (afterSchemeSep.includes(',') || afterSchemeSep.includes(';')) {
        const multiParamEnd = resolveCommaAuthParamsEnd(
          text,
          QUOTED_AUTH_SCHEME_STICKY_RE.lastIndex,
          noClosingQuote,
          true,
          true,
          schemeEnd,
        )
        return multiParamEnd !== -1 ? multiParamEnd : schemeEnd
      }
      const isKnown = KNOWN_AUTH_SCHEMES.has(rawScheme.toLowerCase())
      return consumePostSchemeCredentialEnd(
        text,
        schemeEnd,
        QUOTED_AUTH_SCHEME_STICKY_RE.lastIndex,
        isKnown,
        true,
        false,
        noClosingQuote,
        unclosedDelimiterPositions,
        findBlockCommentClose,
      )
    }
    return findQuotedValueEnd(text, authStart, noClosingQuote, true, () =>
      resolveAuthValueEnd(
        text,
        authStart + 1,
        false,
        noClosingQuote,
        unclosedDelimiterPositions,
        headerLineOriginPos,
        findBlockCommentClose,
      ),
    )
  }
  if (firstChar === '[' || firstChar === '{') {
    return findDelimitedValueEnd(
      text,
      authStart,
      unclosedDelimiterPositions,
      findBlockCommentClose,
    )
  }

  const schemeMatch = matchStickyAt(SCHEME_PREFIX_STICKY_RE, text, authStart)
  if (schemeMatch !== null) {
    const afterWsPos = SCHEME_PREFIX_STICKY_RE.lastIndex
    const delimSepEnd = matchAuthParamSepEnd(text, afterWsPos, false, undefined, true)
    if (delimSepEnd !== -1) {
      const multiParamEnd = resolveCommaAuthParamsEnd(
        text,
        delimSepEnd,
        noClosingQuote,
        true,
        true,
        authStart,
      )
      if (multiParamEnd !== -1) {
        return multiParamEnd
      }
      return afterWsPos
    }
    return consumePostSchemeCredentialEnd(
      text,
      afterWsPos,
      afterWsPos,
      true,
      true,
      false,
      noClosingQuote,
      unclosedDelimiterPositions,
      findBlockCommentClose,
    )
  }

  if (allowScalarOnlyFallback) {
    if (firstChar === ',' || firstChar === ';') {
      const sepEnd = matchAuthParamSepEnd(text, authStart, false, undefined, true)
      if (sepEnd !== -1) {
        const multiParamEnd = resolveCommaAuthParamsEnd(
          text,
          sepEnd,
          noClosingQuote,
          true,
          true,
          headerLineOriginPos,
        )
        if (multiParamEnd !== -1) {
          return multiParamEnd
        }
      }
    }
    const foldedEqParamEnd = resolveCommaAuthParamsEnd(
      text,
      authStart,
      noClosingQuote,
      true,
      false,
      headerLineOriginPos,
    )
    if (foldedEqParamEnd !== -1) {
      return foldedEqParamEnd
    }
    const foldedColonParamEnd = resolveCommaAuthParamsEnd(
      text,
      authStart,
      noClosingQuote,
      true,
      true,
      headerLineOriginPos,
      true,
    )
    if (foldedColonParamEnd !== -1) {
      return foldedColonParamEnd
    }
  } else {
    const directEqParamEnd = resolveCommaAuthParamsEnd(
      text,
      authStart,
      noClosingQuote,
      true,
      false,
      headerLineOriginPos,
    )
    if (directEqParamEnd !== -1) {
      return directEqParamEnd
    }
    const directColonParamEnd = resolveCommaAuthParamsEnd(
      text,
      authStart,
      noClosingQuote,
      true,
      true,
      headerLineOriginPos,
      true,
    )
    if (directColonParamEnd !== -1) {
      return directColonParamEnd
    }
  }

  if (isNextKeyAssignmentAt(text, authStart, true)) {
    return allowScalarOnlyFallback ? -1 : authStart
  }
  if (allowScalarOnlyFallback && matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, authStart) !== null) {
    return -1
  }

  const tokenRe = /[^\s"'`<>|;,{}[\]]{2,}/yu
  const tokenMatch = matchStickyAt(tokenRe, text, authStart)
  if (tokenMatch === null) return -1
  const schemeTok = tokenMatch[0]
  const isKnown = KNOWN_AUTH_SCHEMES.has(schemeTok.toLowerCase())

  const commaSepEnd = matchAuthParamSepEnd(text, tokenRe.lastIndex, false, undefined, true)
  if (commaSepEnd !== -1) {
    const multiParamEnd = resolveCommaAuthParamsEnd(
      text,
      commaSepEnd,
      noClosingQuote,
      true,
      true,
      authStart,
    )
    if (multiParamEnd !== -1) {
      return multiParamEnd
    }
  } else {
    const wsAfterScheme = matchStickyAt(/[ \t:]+/yu, text, tokenRe.lastIndex)
    if (wsAfterScheme !== null) {
      const wsEnd = wsAfterScheme.index + wsAfterScheme[0].length
      const credEnd = consumePostSchemeCredentialEnd(
        text,
        tokenRe.lastIndex,
        wsEnd,
        isKnown,
        true,
        false,
        noClosingQuote,
        unclosedDelimiterPositions,
        findBlockCommentClose,
      )
      if (credEnd > tokenRe.lastIndex) {
        return credEnd
      }
    } else {
      const credEnd = consumePostSchemeCredentialEnd(
        text,
        tokenRe.lastIndex,
        tokenRe.lastIndex,
        isKnown,
        true,
        false,
        noClosingQuote,
        unclosedDelimiterPositions,
        findBlockCommentClose,
      )
      if (credEnd > tokenRe.lastIndex) {
        return credEnd
      }
    }
  }

  if (allowScalarOnlyFallback) {
    if (
      isKnown ||
      SECRET_VALUE_CHAR_RE.test(schemeTok) ||
      (/[A-Z]/u.test(schemeTok) && /[a-z]/u.test(schemeTok)) ||
      (schemeTok.length >= 8 && !STOPWORDS.has(schemeTok.toLowerCase())) ||
      (/^[A-Z]{4,}$/u.test(schemeTok) &&
        countTrailingWordsOnLine(text, tokenRe.lastIndex) <= 1)
    ) {
      return tokenRe.lastIndex
    }
    return -1
  }

  return tokenRe.lastIndex
}

function countTrailingWordsOnLine(text: string, pos: number): number {
  const lineEnd = findLineEnd(text, pos)
  let count = 0
  let p = pos
  while (p < lineEnd) {
    while (p < lineEnd && (text[p] === ' ' || text[p] === '\t')) p += 1
    if (p >= lineEnd) break
    const start = p
    while (p < lineEnd && text[p] !== ' ' && text[p] !== '\t') p += 1
    if (p > start) count += 1
    if (count > 2) break
  }
  return count
}

function isCrossLineSecretScalar(
  tok: string,
  key: string,
  text: string,
  afterTokIdx: number,
): boolean {
  if (SECRET_VALUE_CHAR_RE.test(tok)) return true
  if (/[A-Z]/u.test(tok) && /[a-z]/u.test(tok)) return true
  if (/^[A-Z]{4,}$/u.test(tok)) {
    return countTrailingWordsOnLine(text, afterTokIdx) <= 1 || /[_-]/u.test(key)
  }
  const lower = tok.toLowerCase()
  if (STOPWORDS.has(lower)) return false
  if (tok.length >= 8) return true
  if (tok.length >= 4) {
    return countTrailingWordsOnLine(text, afterTokIdx) <= 1
  }
  return false
}

function getYamlKeyIndentInfo(
  text: string,
  matchIndex: number,
): { readonly listMarkerIndent: number; readonly keyIndent: number; readonly hasListMarker: boolean } {
  let keyLineStart = matchIndex
  while (keyLineStart > 0 && text[keyLineStart - 1] !== '\n' && text[keyLineStart - 1] !== '\r') {
    keyLineStart -= 1
  }
  let listMarkerIndent = 0
  while (
    keyLineStart + listMarkerIndent < matchIndex &&
    (text[keyLineStart + listMarkerIndent] === ' ' || text[keyLineStart + listMarkerIndent] === '\t')
  ) {
    listMarkerIndent += 1
  }
  let keyIndent = listMarkerIndent
  let hasListMarker = false
  if (
    keyLineStart + keyIndent + 1 < matchIndex &&
    (text[keyLineStart + keyIndent] === '-' || text[keyLineStart + keyIndent] === '*') &&
    (text[keyLineStart + keyIndent + 1] === ' ' || text[keyLineStart + keyIndent + 1] === '\t')
  ) {
    hasListMarker = true
    keyIndent += 2
    while (
      keyLineStart + keyIndent < matchIndex &&
      (text[keyLineStart + keyIndent] === ' ' || text[keyLineStart + keyIndent] === '\t')
    ) {
      keyIndent += 1
    }
  }
  return { listMarkerIndent, keyIndent, hasListMarker }
}

function consumeYamlPureCommentEnd(
  text: string,
  startPos: number,
  findBlockCommentClose: BlockCommentCloseFinder,
): number {
  let p = startPos
  while (p < text.length) {
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
      p += 1
    }
    if (p >= text.length || text[p] === '\r' || text[p] === '\n') {
      return p
    }
    if (text[p] === '#' || (text[p] === '/' && text[p + 1] === '/')) {
      return findLineEnd(text, p)
    }
    if (text[p] === '/' && text[p + 1] === '*') {
      const closeEnd = findBlockCommentClose(p)
      if (closeEnd === -1) return -1
      p = closeEnd
      continue
    }
    return -1
  }
  return p
}

function skipLeadingClosedBlockComments(
  text: string,
  startPos: number,
  resolveBlockClose: BlockCommentCloseFinder,
): { readonly codeStart: number; readonly unclosed: boolean } {
  let p = startPos
  while (p < text.length && text[p] === '/' && text[p + 1] === '*') {
    const closeEnd = resolveBlockClose(p)
    if (closeEnd === -1) {
      return { codeStart: p, unclosed: true }
    }
    p = closeEnd
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
      p += 1
    }
  }
  return { codeStart: p, unclosed: false }
}

function findYamlEntryLineExtent(
  text: string,
  entryStart: number,
  entryLineEnd: number,
  resolveBlockClose: BlockCommentCloseFinder,
): number {
  let curEnd = entryLineEnd
  let quote: string | null = null
  let k = entryStart
  while (k < curEnd) {
    const ch = text[k]
    if (quote !== null) {
      if (text.charCodeAt(k) === 92 /* '\\' */) {
        k += 2
        continue
      }
      if (ch === quote) {
        quote = null
      }
      k += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      k += 1
      continue
    }
    if (
      (ch === '#' && (k === entryStart || /[\s,;[{]/u.test(text[k - 1] ?? ''))) ||
      (ch === '/' &&
        k + 1 < curEnd &&
        text[k + 1] === '/' &&
        (k === entryStart || text[k - 1] !== ':'))
    ) {
      break
    }
    if (ch === '/' && k + 1 < curEnd && text[k + 1] === '*') {
      const closeEnd = resolveBlockClose(k)
      if (closeEnd === -1) {
        break
      }
      if (closeEnd > curEnd) {
        curEnd = findLineEnd(text, closeEnd)
      }
      k = closeEnd
      continue
    }
    k += 1
  }
  return curEnd
}

function isYamlListItemMarkerAt(text: string, pos: number): boolean {
  return (
    pos < text.length &&
    (text[pos] === '-' || text[pos] === '*') &&
    (text[pos + 1] === ' ' ||
      text[pos + 1] === '\t' ||
      text[pos + 1] === '\r' ||
      text[pos + 1] === '\n')
  )
}

function findYamlIndentedListEnd(
  text: string,
  matchIndex: number,
  indentedStart: number,
  nlIndentLen: number,
  failedYamlCommentLineStarts?: Set<number>,
  findBlockCommentClose?: BlockCommentCloseFinder,
): number {
  const { keyIndent } = getYamlKeyIndentInfo(text, matchIndex)
  if (nlIndentLen < keyIndent) {
    return -1
  }
  const resolveBlockClose = findBlockCommentClose ?? createBlockCommentCloseFinder(text)

  let lastContentEnd = findYamlEntryLineExtent(
    text,
    indentedStart,
    findLineEnd(text, indentedStart),
    resolveBlockClose,
  )
  let pos = lastContentEnd
  const trailingCommentStarts: number[] = []
  let abortedOnHigherIndent = false
  while (pos < text.length) {
    if (text[pos] === '\r' && text[pos + 1] === '\n') pos += 2
    else if (text[pos] === '\r' || text[pos] === '\n') pos += 1
    else break
    const lineStart = pos
    const lineEnd = findLineEnd(text, lineStart)
    let p = lineStart
    while (p < lineEnd && (text[p] === ' ' || text[p] === '\t')) p += 1
    if (p === lineEnd) {
      trailingCommentStarts.push(p)
      pos = lineEnd
      continue
    }
    if (
      text[p] === '#' ||
      (text[p] === '/' && (text[p + 1] === '/' || text[p + 1] === '*'))
    ) {
      const pureEnd = consumeYamlPureCommentEnd(text, p, resolveBlockClose)
      if (pureEnd !== -1) {
        if (failedYamlCommentLineStarts?.has(p)) {
          break
        }
        trailingCommentStarts.push(p)
        pos = pureEnd
        continue
      }
      if (text[p] === '/' && text[p + 1] === '*') {
        const { codeStart, unclosed } = skipLeadingClosedBlockComments(text, p, resolveBlockClose)
        if (unclosed || codeStart >= text.length) break
        const effectiveIndent = Math.max(p - lineStart, getLineIndentAt(text, codeStart))
        if (effectiveIndent < nlIndentLen) {
          if (effectiveIndent > keyIndent) {
            abortedOnHigherIndent = true
          }
          break
        }
        if (effectiveIndent > nlIndentLen || isYamlListItemMarkerAt(text, codeStart)) {
          trailingCommentStarts.length = 0
          const extEnd = findYamlEntryLineExtent(
            text,
            codeStart,
            findLineEnd(text, codeStart),
            resolveBlockClose,
          )
          lastContentEnd = extEnd
          pos = extEnd
          continue
        }
      }
      break
    }
    const indent = p - lineStart
    if (indent < nlIndentLen) {
      if (indent > keyIndent) {
        abortedOnHigherIndent = true
      }
      break
    }
    if (indent > nlIndentLen || isYamlListItemMarkerAt(text, p)) {
      trailingCommentStarts.length = 0
      const extEnd = findYamlEntryLineExtent(text, p, lineEnd, resolveBlockClose)
      lastContentEnd = extEnd
      pos = extEnd
      continue
    }
    break
  }
  if (!abortedOnHigherIndent && failedYamlCommentLineStarts !== undefined) {
    for (const cStart of trailingCommentStarts) {
      failedYamlCommentLineStarts.add(cStart)
    }
  }
  return lastContentEnd
}

function findYamlIndentedMappingEnd(
  text: string,
  matchIndex: number,
  indentedStart: number,
  nlIndentLen: number,
  failedYamlCommentLineStarts?: Set<number>,
  findBlockCommentClose?: BlockCommentCloseFinder,
): number {
  const { keyIndent } = getYamlKeyIndentInfo(text, matchIndex)
  if (nlIndentLen <= keyIndent) {
    return -1
  }
  if (matchStickyAt(YAML_MAPPING_KEY_STICKY_RE, text, indentedStart) === null) {
    return -1
  }
  const resolveBlockClose = findBlockCommentClose ?? createBlockCommentCloseFinder(text)

  let lastContentEnd = findYamlEntryLineExtent(
    text,
    indentedStart,
    findLineEnd(text, indentedStart),
    resolveBlockClose,
  )
  let pos = lastContentEnd
  const trailingCommentStarts: number[] = []
  let abortedOnHigherIndent = false
  while (pos < text.length) {
    if (text[pos] === '\r' && text[pos + 1] === '\n') pos += 2
    else if (text[pos] === '\r' || text[pos] === '\n') pos += 1
    else break
    const lineStart = pos
    const lineEnd = findLineEnd(text, lineStart)
    let p = lineStart
    while (p < lineEnd && (text[p] === ' ' || text[p] === '\t')) p += 1
    if (p === lineEnd) {
      trailingCommentStarts.push(p)
      pos = lineEnd
      continue
    }
    if (
      text[p] === '#' ||
      (text[p] === '/' && (text[p + 1] === '/' || text[p + 1] === '*'))
    ) {
      const pureEnd = consumeYamlPureCommentEnd(text, p, resolveBlockClose)
      if (pureEnd !== -1) {
        if (failedYamlCommentLineStarts?.has(p)) {
          break
        }
        trailingCommentStarts.push(p)
        pos = pureEnd
        continue
      }
      if (text[p] === '/' && text[p + 1] === '*') {
        const { codeStart, unclosed } = skipLeadingClosedBlockComments(text, p, resolveBlockClose)
        if (unclosed || codeStart >= text.length) break
        const effectiveIndent = Math.max(p - lineStart, getLineIndentAt(text, codeStart))
        if (effectiveIndent < nlIndentLen || effectiveIndent <= keyIndent) {
          if (effectiveIndent > keyIndent) {
            abortedOnHigherIndent = true
          }
          break
        }
        if (
          effectiveIndent > nlIndentLen ||
          matchStickyAt(YAML_MAPPING_KEY_STICKY_RE, text, codeStart) !== null ||
          isYamlListItemMarkerAt(text, codeStart)
        ) {
          trailingCommentStarts.length = 0
          const extEnd = findYamlEntryLineExtent(
            text,
            codeStart,
            findLineEnd(text, codeStart),
            resolveBlockClose,
          )
          lastContentEnd = extEnd
          pos = extEnd
          continue
        }
      }
      break
    }
    const indent = p - lineStart
    if (indent < nlIndentLen || indent <= keyIndent) {
      if (indent > keyIndent) {
        abortedOnHigherIndent = true
      }
      break
    }
    if (
      indent > nlIndentLen ||
      matchStickyAt(YAML_MAPPING_KEY_STICKY_RE, text, p) !== null ||
      isYamlListItemMarkerAt(text, p)
    ) {
      trailingCommentStarts.length = 0
      const extEnd = findYamlEntryLineExtent(text, p, lineEnd, resolveBlockClose)
      lastContentEnd = extEnd
      pos = extEnd
      continue
    }
    break
  }
  if (!abortedOnHigherIndent && failedYamlCommentLineStarts !== undefined) {
    for (const cStart of trailingCommentStarts) {
      failedYamlCommentLineStarts.add(cStart)
    }
  }
  return lastContentEnd
}

function matchCookieListSepEnd(
  text: string,
  pos: number,
): { readonly segStart: number; readonly viaComma: boolean } | null {
  const skipHoriz = (idx: number): number => {
    let p = idx
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
      p += 1
    }
    return p
  }
  const skipObsFold = (idx: number): number => {
    if (idx >= text.length || (text[idx] !== '\r' && text[idx] !== '\n')) return -1
    const folded = matchStickyAt(/\r?\n[ \t]+/yu, text, idx)
    return folded !== null ? folded.index + folded[0].length : -1
  }

  let p = skipHoriz(pos)
  const preFold = skipObsFold(p)
  if (preFold !== -1 && (text[preFold] === ';' || text[preFold] === ',')) {
    p = preFold
  }

  if (text[p] === ';') {
    while (p < text.length && text[p] === ';') {
      p += 1
      p = skipHoriz(p)
      const folded = skipObsFold(p)
      if (folded !== -1) {
        p = folded
      }
    }
    return { segStart: p, viaComma: false }
  }

  if (text[p] === ',') {
    p += 1
    p = skipHoriz(p)
    const folded = skipObsFold(p)
    if (folded !== -1) {
      p = folded
    }
    return { segStart: p, viaComma: true }
  }

  return null
}

interface CookieSegmentResult {
  readonly endPos: number
  readonly endedPreStripped: boolean
  readonly endedBareFlag: boolean
}

function isCookieContinuationStart(text: string, pos: number): boolean {
  if (pos >= text.length) return false
  const nextColonMatch = matchStickyAt(COOKIE_COLON_SECRET_STICKY_RE, text, pos)
  const nextColonKey = nextColonMatch !== null ? (nextColonMatch[3] ?? nextColonMatch[2] ?? '') : ''
  return (
    matchStickyAt(COOKIE_PAIR_START_STICKY_RE, text, pos) !== null ||
    matchStickyAt(
      /(?:"[^"\r\n=]+=[^"\r\n]+"|'[^'\r\n=]+=[^'\r\n]+'|`[^`\r\n=]+=[^`\r\n]+`)/yu,
      text,
      pos,
    ) !== null ||
    matchStickyAt(COOKIE_ATTR_FLAG_STICKY_RE, text, pos) !== null ||
    matchStickyAt(COOKIE_EXPIRES_DATE_STICKY_RE, text, pos) !== null ||
    (nextColonMatch !== null && SECRET_KEY_PART_RE.test(nextColonKey))
  )
}

function consumeCookieSegmentEnd(
  text: string,
  segStart: number,
  allowBareToken: boolean,
  noClosingQuote: Record<string, boolean>,
  unclosedDelimiterPositions: Set<number>,
  findBlockCommentClose?: BlockCommentCloseFinder,
): CookieSegmentResult | null {
  const plain = (endPos: number): CookieSegmentResult => ({
    endPos,
    endedPreStripped: false,
    endedBareFlag: false,
  })
  if (matchStickyAt(COOKIE_EXPIRES_DATE_STICKY_RE, text, segStart) !== null) {
    return plain(COOKIE_EXPIRES_DATE_STICKY_RE.lastIndex)
  }
  const segFirstChar = text[segStart]
  if (segFirstChar === '"' || segFirstChar === "'" || segFirstChar === '`') {
    const quotedEnd = findQuotedValueEnd(text, segStart, noClosingQuote)
    if (
      quotedEnd > segStart + 1 &&
      text.slice(segStart + 1, quotedEnd).includes('=') &&
      matchStickyAt(/[ \t]*=/yu, text, quotedEnd) === null
    ) {
      return plain(quotedEnd)
    }
  }
  const pairMatch = matchStickyAt(COOKIE_PAIR_START_STICKY_RE, text, segStart)
  if (pairMatch !== null) {
    const valStart = COOKIE_PAIR_START_STICKY_RE.lastIndex
    let opEnd = valStart
    while (opEnd > pairMatch.index && (text[opEnd - 1] === ' ' || text[opEnd - 1] === '\t')) {
      opEnd -= 1
    }
    const hadSpaceAfterOp = valStart > opEnd
    if (
      valStart >= text.length ||
      text[valStart] === '\r' ||
      text[valStart] === '\n' ||
      (hadSpaceAfterOp &&
        (text[valStart] === '#' ||
          (text[valStart] === '/' &&
            (text[valStart + 1] === '/' || text[valStart + 1] === '*'))))
    ) {
      return { endPos: opEnd, endedPreStripped: true, endedBareFlag: false }
    }
    const valChar = text[valStart]
    if (valChar === '[' || valChar === '{') {
      return plain(
        findDelimitedValueEnd(text, valStart, unclosedDelimiterPositions, findBlockCommentClose),
      )
    }
    if (valChar === '"' || valChar === "'" || valChar === '`') {
      return plain(findQuotedValueEnd(text, valStart, noClosingQuote))
    }
    if (hadSpaceAfterOp) {
      const nextColonMatch = matchStickyAt(COOKIE_COLON_SECRET_STICKY_RE, text, valStart)
      const nextColonKey = nextColonMatch !== null ? (nextColonMatch[3] ?? nextColonMatch[2] ?? '') : ''
      if (
        matchStickyAt(COOKIE_PAIR_START_STICKY_RE, text, valStart) !== null ||
        (nextColonMatch !== null && SECRET_KEY_PART_RE.test(nextColonKey)) ||
        isNextKeyAssignmentAt(text, valStart, true)
      ) {
        return { endPos: opEnd, endedPreStripped: true, endedBareFlag: false }
      }
    }
    const unquotedValRe = /[^\s"'`<>|;,{}[\]]*/yu
    matchStickyAt(unquotedValRe, text, valStart)
    return plain(unquotedValRe.lastIndex)
  }
  if (matchStickyAt(COOKIE_ATTR_FLAG_STICKY_RE, text, segStart) !== null) {
    return {
      endPos: COOKIE_ATTR_FLAG_STICKY_RE.lastIndex,
      endedPreStripped: false,
      endedBareFlag: true,
    }
  }
  const firstBareFlag =
    matchStickyAt(COOKIE_BARE_FLAG_PREFIX_STICKY_RE, text, segStart) ??
    matchStickyAt(COOKIE_BARE_FLAG_FOLDED_STICKY_RE, text, segStart)
  if (firstBareFlag !== null) {
    let scanPos = firstBareFlag.index + firstBareFlag[0].length
    let lastFlagEnd = scanPos
    while (scanPos < text.length) {
      const sep = matchCookieListSepEnd(text, scanPos)
      let nextSeg = -1
      if (sep !== null) {
        nextSeg = sep.segStart
      } else {
        const wsFold = matchStickyAt(/[ \t]*\r?\n[ \t]+/yu, text, scanPos)
        if (wsFold !== null) {
          nextSeg = wsFold.index + wsFold[0].length
        }
      }
      if (nextSeg === -1 || nextSeg >= text.length) break
      if (isCookieContinuationStart(text, nextSeg)) {
        return { endPos: lastFlagEnd, endedPreStripped: false, endedBareFlag: true }
      }
      const nextBare =
        matchStickyAt(COOKIE_BARE_FLAG_PREFIX_STICKY_RE, text, nextSeg) ??
        matchStickyAt(COOKIE_BARE_FLAG_FOLDED_STICKY_RE, text, nextSeg)
      if (nextBare !== null) {
        lastFlagEnd = nextBare.index + nextBare[0].length
        scanPos = lastFlagEnd
        continue
      }
      break
    }
  }
  const colonSecretMatch = matchStickyAt(COOKIE_COLON_SECRET_STICKY_RE, text, segStart)
  const colonKey = colonSecretMatch !== null ? (colonSecretMatch[3] ?? colonSecretMatch[2] ?? '') : ''
  if (colonSecretMatch !== null && SECRET_KEY_PART_RE.test(colonKey)) {
    const valStart = COOKIE_COLON_SECRET_STICKY_RE.lastIndex
    let opEnd = valStart
    while (
      opEnd > colonSecretMatch.index &&
      (text[opEnd - 1] === ' ' || text[opEnd - 1] === '\t')
    ) {
      opEnd -= 1
    }
    const hadSpaceAfterOp = valStart > opEnd
    if (
      valStart >= text.length ||
      text[valStart] === '\r' ||
      text[valStart] === '\n' ||
      (hadSpaceAfterOp &&
        (text[valStart] === '#' ||
          (text[valStart] === '/' &&
            (text[valStart + 1] === '/' || text[valStart + 1] === '*'))))
    ) {
      return { endPos: opEnd, endedPreStripped: true, endedBareFlag: false }
    }
    const valChar = text[valStart]
    if (AUTH_KEY_PART_RE.test(colonKey)) {
      const authEnd = resolveAuthValueEnd(
        text,
        valStart,
        false,
        noClosingQuote,
        unclosedDelimiterPositions,
        segStart,
        findBlockCommentClose,
      )
      if (authEnd !== -1) {
        return plain(authEnd)
      }
    }
    if (valChar === '"' || valChar === "'" || valChar === '`') {
      return plain(findQuotedValueEnd(text, valStart, noClosingQuote))
    }
    if (valChar === '[' || valChar === '{') {
      return plain(
        findDelimitedValueEnd(text, valStart, unclosedDelimiterPositions, findBlockCommentClose),
      )
    }
    if (hadSpaceAfterOp) {
      const nextColonMatch = matchStickyAt(COOKIE_COLON_SECRET_STICKY_RE, text, valStart)
      const nextColonKey = nextColonMatch !== null ? (nextColonMatch[3] ?? nextColonMatch[2] ?? '') : ''
      if (
        matchStickyAt(COOKIE_PAIR_START_STICKY_RE, text, valStart) !== null ||
        (nextColonMatch !== null && SECRET_KEY_PART_RE.test(nextColonKey)) ||
        isNextKeyAssignmentAt(text, valStart, true)
      ) {
        return { endPos: opEnd, endedPreStripped: true, endedBareFlag: false }
      }
    }
    const unquotedValRe = /[^\s"'`<>|;,{}[\]]*/yu
    matchStickyAt(unquotedValRe, text, valStart)
    return plain(unquotedValRe.lastIndex)
  }
  if (allowBareToken && !isNextKeyAssignmentAt(text, segStart, true)) {
    const tokRe = /[^\s"'`<>|;,{}[\]]+/yu
    if (matchStickyAt(tokRe, text, segStart) !== null) {
      return plain(tokRe.lastIndex)
    }
  }
  return null
}

function skipFoldedCookiePureComments(
  text: string,
  segStart: number,
  resolveBlockClose: BlockCommentCloseFinder,
  failedCommentLineStarts?: Set<number>,
): number {
  let cur = segStart
  if (
    cur >= text.length ||
    (text[cur] !== '#' && !(text[cur] === '/' && (text[cur + 1] === '/' || text[cur + 1] === '*')))
  ) {
    return segStart
  }
  const visited: number[] = []
  while (cur < text.length) {
    if (
      text[cur] === '#' ||
      (text[cur] === '/' && (text[cur + 1] === '/' || text[cur + 1] === '*'))
    ) {
      if (failedCommentLineStarts?.has(cur)) {
        return -1
      }
      const pureEnd = consumeYamlPureCommentEnd(text, cur, resolveBlockClose)
      if (pureEnd === -1) {
        for (const v of visited) failedCommentLineStarts?.add(v)
        return -1
      }
      visited.push(cur)
      const folded = matchStickyAt(/\r?\n[ \t]+/yu, text, pureEnd)
      if (folded === null) {
        for (const v of visited) failedCommentLineStarts?.add(v)
        return -1
      }
      cur = folded.index + folded[0].length
      continue
    }
    if (isCookieContinuationStart(text, cur)) {
      return cur
    }
    for (const v of visited) failedCommentLineStarts?.add(v)
    return -1
  }
  for (const v of visited) failedCommentLineStarts?.add(v)
  return -1
}

function resolveCookieListEnd(
  text: string,
  valueStart: number,
  spaceSeparated: boolean,
  noClosingQuote: Record<string, boolean>,
  unclosedDelimiterPositions: Set<number>,
  findBlockCommentClose?: BlockCommentCloseFinder,
  failedCommentLineStarts?: Set<number>,
): number {
  const resolveBlockClose = findBlockCommentClose ?? createBlockCommentCloseFinder(text)
  let segInfo = consumeCookieSegmentEnd(
    text,
    valueStart,
    !spaceSeparated,
    noClosingQuote,
    unclosedDelimiterPositions,
    resolveBlockClose,
  )
  if (segInfo === null) return -1
  let endPos = segInfo.endPos
  while (endPos < text.length) {
    let segStart: number
    let viaComma = false
    const sep = matchCookieListSepEnd(text, endPos)
    if (sep !== null) {
      segStart = sep.segStart
      viaComma = sep.viaComma
      if (segStart < text.length && endPos < segStart && text.slice(endPos, segStart).includes('\n')) {
        const afterComments = skipFoldedCookiePureComments(
          text,
          segStart,
          resolveBlockClose,
          failedCommentLineStarts,
        )
        if (afterComments === -1) break
        segStart = afterComments
      }
    } else {
      let wsEnd = endPos
      while (wsEnd < text.length && (text[wsEnd] === ' ' || text[wsEnd] === '\t')) {
        wsEnd += 1
      }
      if (wsEnd < text.length && (text[wsEnd] === '\r' || text[wsEnd] === '\n')) {
        const folded = matchStickyAt(/\r?\n[ \t]+/yu, text, wsEnd)
        if (folded === null) break
        wsEnd = folded.index + folded[0].length
        const afterComments = skipFoldedCookiePureComments(
          text,
          wsEnd,
          resolveBlockClose,
          failedCommentLineStarts,
        )
        if (afterComments === -1) break
        wsEnd = afterComments
      } else if (!segInfo.endedPreStripped || wsEnd <= endPos) {
        break
      }
      if (wsEnd >= text.length) break
      const isBareFlagCandidate =
        matchStickyAt(COOKIE_BARE_FLAG_PREFIX_STICKY_RE, text, wsEnd) !== null ||
        matchStickyAt(COOKIE_BARE_FLAG_FOLDED_STICKY_RE, text, wsEnd) !== null
      if (!isCookieContinuationStart(text, wsEnd) && !isBareFlagCandidate) {
        break
      }
      segStart = wsEnd
    }
    if (segStart >= text.length) break
    if (viaComma && !isCookieContinuationStart(text, segStart)) {
      break
    }
    const nextInfo = consumeCookieSegmentEnd(
      text,
      segStart,
      false,
      noClosingQuote,
      unclosedDelimiterPositions,
      resolveBlockClose,
    )
    if (nextInfo === null) {
      break
    }
    segInfo = nextInfo
    endPos = nextInfo.endPos
  }
  return endPos
}

function resolveSecretValueEnd(
  text: string,
  valueStart: number,
  key: string,
  container: string,
  matchIndex: number,
  spaceSeparated: boolean,
  noClosingQuote: Record<string, boolean>,
  unclosedDelimiterPositions: Set<number>,
  failedYamlCommentLineStarts?: Set<number>,
  findBlockCommentClose?: BlockCommentCloseFinder,
  keyParts?: readonly string[],
): number {
  if (valueStart >= text.length) return -1
  const resolveBlockClose = findBlockCommentClose ?? createBlockCommentCloseFinder(text)

  const partsToCheck = keyParts ?? (container.length > 0 ? [key, container] : [key])
  const isAuth = partsToCheck.some((part) => AUTH_KEY_PART_RE.test(part))
  const isBearer = partsToCheck.some((part) => BEARER_KEY_PART_RE.test(part))
  const isCookie = partsToCheck.some((part) => COOKIE_KEY_PART_RE.test(part))

  const yamlHeaderNlPos = (() => {
    if (spaceSeparated) return -1
    const pureEnd = consumeYamlPureCommentEnd(text, valueStart, resolveBlockClose)
    return pureEnd !== -1 &&
      pureEnd < text.length &&
      (text[pureEnd] === '\r' || text[pureEnd] === '\n')
      ? pureEnd
      : -1
  })()

  let effectiveStart = valueStart
  if (
    !spaceSeparated &&
    yamlHeaderNlPos === -1 &&
    text[effectiveStart] === '/' &&
    text[effectiveStart + 1] === '*'
  ) {
    const { codeStart } = skipLeadingClosedBlockComments(text, effectiveStart, resolveBlockClose)
    if (codeStart > effectiveStart) {
      if (codeStart >= text.length) return -1
      effectiveStart = codeStart
    }
  }

  const firstChar = text[effectiveStart]
  if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
    if (isCookie && !spaceSeparated) {
      const cookieEnd = resolveCookieListEnd(
        text,
        effectiveStart,
        spaceSeparated,
        noClosingQuote,
        unclosedDelimiterPositions,
        resolveBlockClose,
        failedYamlCommentLineStarts,
      )
      if (cookieEnd !== -1) {
        return cookieEnd
      }
    }
    if (!spaceSeparated && isAuth) {
      return resolveAuthValueEnd(
        text,
        effectiveStart,
        false,
        noClosingQuote,
        unclosedDelimiterPositions,
        matchIndex,
        resolveBlockClose,
      )
    }
    if (spaceSeparated && isAuth && !isBearer) {
      if (matchStickyAt(SCHEME_PREFIX_STICKY_RE, text, effectiveStart + 1) === null) {
        return -1
      }
    }
    return findQuotedValueEnd(text, effectiveStart, noClosingQuote)
  }

  if (!spaceSeparated && (firstChar === '[' || firstChar === '{')) {
    return findDelimitedValueEnd(text, effectiveStart, unclosedDelimiterPositions, resolveBlockClose)
  }

  if (!spaceSeparated && matchStickyAt(PEM_OPEN_OPT_NL_STICKY_RE, text, effectiveStart) !== null) {
    return findUnquotedPemValueEnd(text, effectiveStart, PEM_OPEN_OPT_NL_STICKY_RE.lastIndex)
  }

  if (!spaceSeparated) {
    const yamlBlockMatch = matchStickyAt(YAML_BLOCK_SCALAR_HEADER_STICKY_RE, text, effectiveStart)
    if (yamlBlockMatch !== null) {
      return findYamlBlockScalarEnd(text, matchIndex, YAML_BLOCK_SCALAR_HEADER_STICKY_RE.lastIndex)
    }
  }

  if (!spaceSeparated && yamlHeaderNlPos !== -1) {
    const nlIndentMatch = matchStickyAt(/\r?\n([ \t]*)/yu, text, yamlHeaderNlPos)
    if (nlIndentMatch !== null) {
      const indentedStart = nlIndentMatch.index + nlIndentMatch[0].length
      const nlIndentLen = (nlIndentMatch[1] ?? '').length
      if (indentedStart < text.length) {
        const { keyIndent } = getYamlKeyIndentInfo(text, matchIndex)
        let yamlContentStart = indentedStart
        let yamlContentIndent = nlIndentLen
        const visitedYamlCommentStarts: number[] = []
        let abortedYamlScan = false
        {
          let scanLineStart = indentedStart
          let scanIndent = nlIndentLen
          while (scanLineStart < text.length) {
            let scanLineEnd = findLineEnd(text, scanLineStart)
            if (scanLineStart === scanLineEnd) {
              if (failedYamlCommentLineStarts?.has(scanLineStart)) {
                abortedYamlScan = true
                break
              }
              visitedYamlCommentStarts.push(scanLineStart)
            } else if (
              text[scanLineStart] === '#' ||
              (text[scanLineStart] === '/' &&
                (text[scanLineStart + 1] === '/' || text[scanLineStart + 1] === '*'))
            ) {
              const pureEnd = consumeYamlPureCommentEnd(text, scanLineStart, resolveBlockClose)
              if (pureEnd !== -1) {
                if (failedYamlCommentLineStarts?.has(scanLineStart)) {
                  abortedYamlScan = true
                  break
                }
                visitedYamlCommentStarts.push(scanLineStart)
                scanLineEnd = pureEnd
              } else if (text[scanLineStart] === '/' && text[scanLineStart + 1] === '*') {
                const { codeStart, unclosed } = skipLeadingClosedBlockComments(
                  text,
                  scanLineStart,
                  resolveBlockClose,
                )
                if (unclosed) {
                  abortedYamlScan = true
                  break
                }
                yamlContentStart = codeStart
                yamlContentIndent = Math.max(scanIndent, getLineIndentAt(text, codeStart))
                break
              } else {
                yamlContentStart = scanLineStart
                yamlContentIndent = scanIndent
                break
              }
            } else {
              yamlContentStart = scanLineStart
              yamlContentIndent = scanIndent
              break
            }
            if (scanLineEnd >= text.length) {
              yamlContentStart = text.length
              break
            }
            const nextStart =
              text[scanLineEnd] === '\r' && text[scanLineEnd + 1] === '\n'
                ? scanLineEnd + 2
                : scanLineEnd + 1
            let np = nextStart
            while (np < text.length && (text[np] === ' ' || text[np] === '\t')) np += 1
            scanLineStart = np
            scanIndent = np - nextStart
          }
        }

        const recordFailedYamlScan = (): void => {
          if (failedYamlCommentLineStarts !== undefined && visitedYamlCommentStarts.length > 0) {
            for (const cStart of visitedYamlCommentStarts) {
              failedYamlCommentLineStarts.add(cStart)
            }
          }
        }

        const yamlChar = yamlContentStart < text.length ? text[yamlContentStart] : ''
        const isYamlListItem =
          !abortedYamlScan &&
          yamlContentStart < text.length &&
          (yamlChar === '-' || yamlChar === '*') &&
          (text[yamlContentStart + 1] === ' ' ||
            text[yamlContentStart + 1] === '\t' ||
            text[yamlContentStart + 1] === '\r' ||
            text[yamlContentStart + 1] === '\n')

        if (isYamlListItem && yamlContentIndent >= keyIndent) {
          const listEnd = findYamlIndentedListEnd(
            text,
            matchIndex,
            yamlContentStart,
            yamlContentIndent,
            failedYamlCommentLineStarts,
            resolveBlockClose,
          )
          if (listEnd !== -1) {
            return listEnd
          }
        }

        if (!abortedYamlScan && yamlContentStart < text.length && yamlContentIndent > keyIndent) {
          if (matchStickyAt(YAML_BLOCK_SCALAR_HEADER_STICKY_RE, text, yamlContentStart) !== null) {
            return findYamlBlockScalarEnd(
              text,
              matchIndex,
              YAML_BLOCK_SCALAR_HEADER_STICKY_RE.lastIndex,
            )
          }
          if (isCookie) {
            if (yamlChar === '[' || yamlChar === '{') {
              return findDelimitedValueEnd(
                text,
                yamlContentStart,
                unclosedDelimiterPositions,
                resolveBlockClose,
              )
            }
            const startsWithPair =
              matchStickyAt(COOKIE_PAIR_START_STICKY_RE, text, yamlContentStart) !== null
            const colonMatch = matchStickyAt(COOKIE_COLON_SECRET_STICKY_RE, text, yamlContentStart)
            const colonKey = colonMatch !== null ? (colonMatch[3] ?? colonMatch[2] ?? '') : ''
            const startsWithSecretColon =
              colonMatch !== null && SECRET_KEY_PART_RE.test(colonKey)
            const startsWithYamlMapKey =
              matchStickyAt(YAML_MAPPING_KEY_STICKY_RE, text, yamlContentStart) !== null
            if (!startsWithPair && !startsWithSecretColon && startsWithYamlMapKey) {
              const yamlMapEnd = findYamlIndentedMappingEnd(
                text,
                matchIndex,
                yamlContentStart,
                yamlContentIndent,
                failedYamlCommentLineStarts,
                resolveBlockClose,
              )
              if (yamlMapEnd !== -1) {
                return yamlMapEnd
              }
            }
            const cookieEnd = resolveCookieListEnd(
              text,
              yamlContentStart,
              false,
              noClosingQuote,
              unclosedDelimiterPositions,
              resolveBlockClose,
              failedYamlCommentLineStarts,
            )
            if (startsWithSecretColon && startsWithYamlMapKey) {
              const firstLineEnd = findLineEnd(text, yamlContentStart)
              let onlyWsOrCommentTail = false
              if (cookieEnd !== -1 && cookieEnd <= firstLineEnd) {
                let tp = cookieEnd
                while (tp < firstLineEnd && (text[tp] === ' ' || text[tp] === '\t')) {
                  tp += 1
                }
                if (
                  tp === firstLineEnd ||
                  text[tp] === '#' ||
                  (text[tp] === '/' && (text[tp + 1] === '/' || text[tp + 1] === '*'))
                ) {
                  onlyWsOrCommentTail = true
                }
              }
              const yamlMapEnd = findYamlIndentedMappingEnd(
                text,
                matchIndex,
                yamlContentStart,
                yamlContentIndent,
                failedYamlCommentLineStarts,
                resolveBlockClose,
              )
              if (
                yamlMapEnd !== -1 &&
                (yamlMapEnd > firstLineEnd || cookieEnd === -1 || onlyWsOrCommentTail)
              ) {
                return cookieEnd === -1 ? yamlMapEnd : Math.max(cookieEnd, yamlMapEnd)
              }
            }
            if (cookieEnd !== -1) {
              return cookieEnd
            }
            recordFailedYamlScan()
            return -1
          }
          if (isAuth) {
            const authEnd = resolveAuthValueEnd(
              text,
              yamlContentStart,
              true,
              noClosingQuote,
              unclosedDelimiterPositions,
              matchIndex,
              resolveBlockClose,
            )
            if (authEnd !== -1) {
              return authEnd
            }
            recordFailedYamlScan()
            return -1
          }

          if (!isAuth && !isCookie) {
            const yamlMapEnd = findYamlIndentedMappingEnd(
              text,
              matchIndex,
              yamlContentStart,
              yamlContentIndent,
              failedYamlCommentLineStarts,
              resolveBlockClose,
            )
            if (yamlMapEnd !== -1) {
              return yamlMapEnd
            }
            const schemeMatch = matchStickyAt(SCHEME_PREFIX_STICKY_RE, text, yamlContentStart)
            if (schemeMatch !== null) {
              const schemeName = (schemeMatch[1] ?? '').toLowerCase()
              const credStart = SCHEME_PREFIX_STICKY_RE.lastIndex
              if (PARAMETERIZED_AUTH_SCHEMES.has(schemeName)) {
                const multiParamEnd = resolveCommaAuthParamsEnd(text, credStart, noClosingQuote, false)
                if (multiParamEnd !== -1) {
                  return multiParamEnd
                }
              }
              if (isNextKeyAssignmentAt(text, credStart, true)) {
                return credStart
              }
              const credFirstChar = text[credStart]
              if (credFirstChar === '"' || credFirstChar === "'" || credFirstChar === '`') {
                return findQuotedValueEnd(text, credStart, noClosingQuote)
              }
              if (credFirstChar === '[' || credFirstChar === '{') {
                return findDelimitedValueEnd(
                  text,
                  credStart,
                  unclosedDelimiterPositions,
                  resolveBlockClose,
                )
              }
              const tokenRe = /[^\s"'`<>|;,{}[\]]{2,}/yu
              if (matchStickyAt(tokenRe, text, credStart) !== null) {
                return tokenRe.lastIndex
              }
            }
            if (
              matchStickyAt(OBJECT_PROPERTY_ASSIGN_STICKY_RE, text, yamlContentStart) === null &&
              !isNextKeyAssignmentAt(text, yamlContentStart, true)
            ) {
              if (yamlChar === '"' || yamlChar === "'" || yamlChar === '`') {
                return findQuotedValueEnd(text, yamlContentStart, noClosingQuote)
              }
              if (yamlChar === '[' || yamlChar === '{') {
                return findDelimitedValueEnd(
                  text,
                  yamlContentStart,
                  unclosedDelimiterPositions,
                  resolveBlockClose,
                )
              }
              const indTokenRe = /[^\s"'`<>|;,{}[\]]{2,}/yu
              const indTokenMatch = matchStickyAt(indTokenRe, text, yamlContentStart)
              if (indTokenMatch !== null) {
                const tok = indTokenMatch[0]
                if (isCrossLineSecretScalar(tok, partsToCheck.join('_'), text, indTokenRe.lastIndex)) {
                  return indTokenRe.lastIndex
                }
              }
            }
          }
        }
        recordFailedYamlScan()
      }
    }
    return -1
  }

  if (!spaceSeparated && !isCookie && !isAuth && isNextKeyAssignmentAt(text, effectiveStart, true)) {
    return effectiveStart
  }

  if (
    isCookie &&
    (!spaceSeparated || matchStickyAt(COOKIE_PAIR_START_STICKY_RE, text, effectiveStart) !== null)
  ) {
    const cookieEnd = resolveCookieListEnd(
      text,
      effectiveStart,
      spaceSeparated,
      noClosingQuote,
      unclosedDelimiterPositions,
      resolveBlockClose,
      failedYamlCommentLineStarts,
    )
    if (cookieEnd !== -1) {
      return cookieEnd
    }
    return -1
  }

  if (!spaceSeparated && isAuth) {
    return resolveAuthValueEnd(
      text,
      effectiveStart,
      false,
      noClosingQuote,
      unclosedDelimiterPositions,
      matchIndex,
      resolveBlockClose,
    )
  }

  const schemeMatch = !isCookie ? matchStickyAt(SCHEME_PREFIX_STICKY_RE, text, effectiveStart) : null
  if (schemeMatch !== null) {
    const schemeName = (schemeMatch[1] ?? '').toLowerCase()
    const credStart = SCHEME_PREFIX_STICKY_RE.lastIndex
    if (!spaceSeparated && PARAMETERIZED_AUTH_SCHEMES.has(schemeName)) {
      const multiParamEnd = resolveCommaAuthParamsEnd(text, credStart, noClosingQuote, false)
      if (multiParamEnd !== -1) {
        return multiParamEnd
      }
    }
    if (!spaceSeparated && isNextKeyAssignmentAt(text, credStart, !isCookie)) {
      return credStart
    }
    const credFirstChar = text[credStart]
    if (credFirstChar === '"' || credFirstChar === "'" || credFirstChar === '`') {
      return findQuotedValueEnd(text, credStart, noClosingQuote)
    }
    if (!spaceSeparated && (credFirstChar === '[' || credFirstChar === '{')) {
      return findDelimitedValueEnd(
        text,
        credStart,
        unclosedDelimiterPositions,
        resolveBlockClose,
      )
    }
    const tokenRe = /[^\s"'`<>|;,{}[\]]{2,}/yu
    const tokenMatch = matchStickyAt(tokenRe, text, credStart)
    if (tokenMatch !== null) {
      if (spaceSeparated && !isBearer && !SECRET_VALUE_CHAR_RE.test(tokenMatch[0])) {
        return -1
      }
      return tokenRe.lastIndex
    }
    return spaceSeparated ? -1 : credStart
  }

  if (spaceSeparated && isAuth && !isBearer) {
    return -1
  }

  const tokenRe = /[^\s"'`<>|;,{}[\]]{2,}/yu
  const tokenMatch = matchStickyAt(tokenRe, text, effectiveStart)
  if (tokenMatch === null) return -1

  if (spaceSeparated && !isBearer && !SECRET_VALUE_CHAR_RE.test(tokenMatch[0])) {
    return -1
  }

  return tokenRe.lastIndex
}

function isSecretAssignmentKey(ident: string): boolean {
  if (ident.toLowerCase() === 'pass') return true
  if (SECRET_KEY_PART_RE.test(ident)) return true
  if (!/[A-Z0-9]/u.test(ident)) return false
  return hasSecretStem(ident)
}

function scrubByKeyPattern(text: string, headRe: RegExp, spaceSeparated: boolean): string {
  headRe.lastIndex = 0
  const noClosingQuote: Record<string, boolean> = {}
  const unclosedDelimiterPositions = new Set<number>()
  const failedYamlCommentLineStarts = new Set<number>()
  const findBlockCommentClose = createBlockCommentCloseFinder(text)
  let out = ''
  let cursor = 0
  let match: RegExpExecArray | null

  const isSecretIdent = (ident: string): boolean =>
    spaceSeparated
      ? SECRET_KEY_PART_RE.test(ident) || CAMEL_PASS_OR_JWT_KEY_RE.test(ident)
      : isSecretAssignmentKey(ident)

  while ((match = headRe.exec(text)) !== null) {
    const baseIdent = match[3] ?? match[2] ?? ''
    const subscriptChain = match[4]
    const segments = extractSubscriptSegments(subscriptChain)
    const baseIsSecret = isSecretIdent(baseIdent)
    const secretSegment = segments.find((seg) => isSecretIdent(seg))
    if (!baseIsSecret && secretSegment === undefined) {
      continue
    }
    const key = secretSegment ?? (segments.length > 0 ? segments[segments.length - 1]! : baseIdent)
    const container = segments.length > 0 ? baseIdent : ''
    const keyParts = segments.length > 0 ? [baseIdent, ...segments] : [baseIdent]
    const valueEnd = resolveSecretValueEnd(
      text,
      headRe.lastIndex,
      key,
      container,
      match.index,
      spaceSeparated,
      noClosingQuote,
      unclosedDelimiterPositions,
      failedYamlCommentLineStarts,
      findBlockCommentClose,
      keyParts,
    )
    if (valueEnd === -1) {
      continue
    }
    out += text.slice(cursor, match.index) + ' '
    cursor = valueEnd
    headRe.lastIndex = valueEnd
  }

  if (cursor === 0) return text
  return out + text.slice(cursor)
}

const URL_BASE_RE = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>|;,)]+/giu
const URL_SEMI_ASSIGN_STICKY_RE = new RegExp(
  `(?:(?:"[^"\\r\\n]+"|'[^'\\r\\n]+'|` +
    '`[^`\\r\\n]+`' +
    `)(?:\\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+)(?:${SUBSCRIPT_SEGMENT_SRC}(?:\\.[A-Za-z0-9_.-]+)?)*[ \\t]*[:=]`,
  'yu',
)
const URL_SEMI_SPACE_KEY_STICKY_RE = /["'`]?([A-Za-z0-9_.-]+)["'`]?[ \t]+/yu
const URL_CONT_SEG_STICKY_RE = /[^\s"'`<>|;,)]+/yu
const SCRUB_ASSIGN_HEAD_RE = new RegExp(
  `(?<![A-Za-z0-9_.-])(?:(["'\`])([A-Za-z0-9_.-]+)\\1|([A-Za-z0-9_.-]+))${SUBSCRIPT_CHAIN_CAPTURE_SRC}?[ \\t]*(?::=|==|:|=)[ \\t]*`,
  'giu',
)
const SCRUB_SPACE_HEAD_RE =
  /(?<![A-Za-z0-9_.-])(?:(["'`])([A-Za-z0-9_.-]+)\1|([A-Za-z0-9_.-]+))[ \t]+/giu

function stripUrlsFromInterestText(text: string): string {
  URL_BASE_RE.lastIndex = 0
  let out = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = URL_BASE_RE.exec(text)) !== null) {
    let end = URL_BASE_RE.lastIndex
    while (end < text.length && (text[end] === ';' || text[end] === ',')) {
      let sepEnd = end + 1
      while (sepEnd < text.length && (text[sepEnd] === ';' || text[sepEnd] === ',')) {
        sepEnd += 1
      }
      if (matchStickyAt(URL_SEMI_ASSIGN_STICKY_RE, text, sepEnd) !== null) {
        break
      }
      const spaceKeyMatch = matchStickyAt(URL_SEMI_SPACE_KEY_STICKY_RE, text, sepEnd)
      if (spaceKeyMatch !== null && SECRET_KEY_PART_RE.test(spaceKeyMatch[1] ?? '')) {
        break
      }
      const segMatch = matchStickyAt(URL_CONT_SEG_STICKY_RE, text, sepEnd)
      if (segMatch === null) {
        break
      }
      end = URL_CONT_SEG_STICKY_RE.lastIndex
    }
    out += text.slice(cursor, match.index) + ' '
    cursor = end
    URL_BASE_RE.lastIndex = end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

const CLI_BASIC_AUTH_RE =
  /(?:^|(?<=[\s;|&(]))(?:-u|--user|--proxy-user)(?:=|[ \t]+)(?:"(?:[^"\r\n:]+:[^"\r\n]*|:[^"\r\n]+)"|'(?:[^'\r\n:]+:[^'\r\n]*|:[^'\r\n]+)'|`(?:[^`\r\n:]+:[^`\r\n]*|:[^`\r\n]+)`|(?:[^\s"'`:<>|;,()]+:[^\s"'`<>|;,()]*|:[^\s"'`<>|;,()]+))/gu
const NAMED_SECRET_KEY_PROP_RE =
  /(?:^|(?<=[\s,{[\-*]))(?:(["'`])(?:name|key)\1|(?:name|key))[ \t]*:[ \t]*(?!=)(?:(["'`])([A-Za-z0-9_.-]+)\2|([A-Za-z0-9_.-]+))/giu
const VALUE_PROP_STICKY_RE = /(?:(["'`])value\1|value)[ \t]*:[ \t]*/iyu
const ANY_PROP_HEAD_STICKY_RE = /(?:(["'`])([A-Za-z0-9_.-]+)\1|([A-Za-z0-9_.-]+))[ \t]*:[ \t]*/yu

function skipSiblingPropValueEnd(
  text: string,
  valStart: number,
  noClosingQuote: Record<string, boolean>,
  unclosedDelimiterPositions: Set<number>,
  findBlockCommentClose: BlockCommentCloseFinder,
): number {
  let p = valStart
  if (p >= text.length) return -1
  if (text[p] === '/' && text[p + 1] === '*') {
    const { codeStart, unclosed } = skipLeadingClosedBlockComments(text, p, findBlockCommentClose)
    if (unclosed || codeStart >= text.length) return -1
    p = codeStart
  }
  const ch = text[p]
  if (ch === '"' || ch === "'" || ch === '`') {
    return findQuotedValueEnd(text, p, noClosingQuote)
  }
  if (ch === '{' || ch === '[') {
    return findDelimitedValueEnd(text, p, unclosedDelimiterPositions, findBlockCommentClose)
  }
  const scalarRe = /[^\s"'`<>|,;{}[\]]+/yu
  if (matchStickyAt(scalarRe, text, p) !== null) {
    return scalarRe.lastIndex
  }
  return -1
}

function scrubNamedSecretValuePairs(text: string): string {
  if (!/\b(?:name|key)\b/iu.test(text) || !/\bvalue\b/iu.test(text)) {
    return text
  }
  NAMED_SECRET_KEY_PROP_RE.lastIndex = 0
  const noClosingQuote: Record<string, boolean> = {}
  const unclosedDelimiterPositions = new Set<number>()
  const failedYamlCommentLineStarts = new Set<number>()
  const findBlockCommentClose = createBlockCommentCloseFinder(text)
  let out = ''
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = NAMED_SECRET_KEY_PROP_RE.exec(text)) !== null) {
    const nameVal = match[3] ?? match[4] ?? ''
    if (!isSecretAssignmentKey(nameVal)) {
      continue
    }
    const pos = NAMED_SECRET_KEY_PROP_RE.lastIndex
    if (pos < text.length && !/[\s,;}\]/#]/u.test(text[pos]!)) {
      continue
    }

    let p = pos
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
      p += 1
    }
    let foundValueKeyStart = -1
    let foundValueEnd = -1

    if (p < text.length && (text[p] === ',' || text[p] === ';')) {
      let cur = p
      for (let propIdx = 0; propIdx < 6 && cur < text.length; propIdx += 1) {
        if (text[cur] !== ',' && text[cur] !== ';') break
        cur += 1
        while (cur < text.length) {
          const ch = text[cur]
          if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            cur += 1
            continue
          }
          if (ch === '#' || (ch === '/' && text[cur + 1] === '/')) {
            cur = findLineEnd(text, cur)
            continue
          }
          if (ch === '/' && text[cur + 1] === '*') {
            const closeEnd = findBlockCommentClose(cur)
            if (closeEnd === -1) {
              cur = text.length
              break
            }
            cur = closeEnd
            continue
          }
          break
        }
        if (cur >= text.length || text[cur] === '}' || text[cur] === ']') break
        if (matchStickyAt(VALUE_PROP_STICKY_RE, text, cur) !== null) {
          const valueKeyStart = cur
          const valueStart = VALUE_PROP_STICKY_RE.lastIndex
          const valueEnd = resolveSecretValueEnd(
            text,
            valueStart,
            nameVal,
            '',
            valueKeyStart,
            false,
            noClosingQuote,
            unclosedDelimiterPositions,
            failedYamlCommentLineStarts,
            findBlockCommentClose,
            [nameVal],
          )
          if (valueEnd !== -1) {
            foundValueKeyStart = valueKeyStart
            foundValueEnd = valueEnd
          }
          break
        }
        const otherProp = matchStickyAt(ANY_PROP_HEAD_STICKY_RE, text, cur)
        if (otherProp === null) break
        const otherKey = (otherProp[3] ?? otherProp[2] ?? '').toLowerCase()
        if (otherKey === 'name' || otherKey === 'key') break
        const skippedEnd = skipSiblingPropValueEnd(
          text,
          ANY_PROP_HEAD_STICKY_RE.lastIndex,
          noClosingQuote,
          unclosedDelimiterPositions,
          findBlockCommentClose,
        )
        if (skippedEnd === -1) break
        cur = skippedEnd
        while (
          cur < text.length &&
          (text[cur] === ' ' || text[cur] === '\t' || text[cur] === '\r' || text[cur] === '\n')
        ) {
          cur += 1
        }
      }
    } else {
      const lineTailEnd = consumeYamlPureCommentEnd(text, pos, findBlockCommentClose)
      if (
        lineTailEnd !== -1 &&
        lineTailEnd < text.length &&
        (text[lineTailEnd] === '\r' || text[lineTailEnd] === '\n')
      ) {
        const { listMarkerIndent, keyIndent, hasListMarker } = getYamlKeyIndentInfo(
          text,
          match.index,
        )
        let linePos = lineTailEnd
        for (let lineCount = 0; lineCount < 8 && linePos < text.length; lineCount += 1) {
          if (text[linePos] === '\r' && text[linePos + 1] === '\n') {
            linePos += 2
          } else if (text[linePos] === '\r' || text[linePos] === '\n') {
            linePos += 1
          } else {
            break
          }
          const lineStart = linePos
          const lineEnd = findLineEnd(text, lineStart)
          let contentStart = lineStart
          while (
            contentStart < lineEnd &&
            (text[contentStart] === ' ' || text[contentStart] === '\t')
          ) {
            contentStart += 1
          }
          if (contentStart === lineEnd) {
            linePos = lineEnd
            continue
          }
          const pureCommentEnd = consumeYamlPureCommentEnd(
            text,
            contentStart,
            findBlockCommentClose,
          )
          if (pureCommentEnd === lineEnd) {
            linePos = lineEnd
            continue
          }
          const indent = contentStart - lineStart
          const isListItemStart =
            (text[contentStart] === '-' || text[contentStart] === '*') &&
            (contentStart + 1 === lineEnd ||
              text[contentStart + 1] === ' ' ||
              text[contentStart + 1] === '\t')
          if (indent < keyIndent || (hasListMarker && indent === listMarkerIndent) || isListItemStart) {
            break
          }
          if (indent > keyIndent) {
            linePos = lineEnd
            continue
          }
          if (matchStickyAt(VALUE_PROP_STICKY_RE, text, contentStart) !== null) {
            const valueKeyStart = contentStart
            const valueStart = VALUE_PROP_STICKY_RE.lastIndex
            const valueEnd = resolveSecretValueEnd(
              text,
              valueStart,
              nameVal,
              '',
              valueKeyStart,
              false,
              noClosingQuote,
              unclosedDelimiterPositions,
              failedYamlCommentLineStarts,
              findBlockCommentClose,
              [nameVal],
            )
            if (valueEnd !== -1) {
              foundValueKeyStart = valueKeyStart
              foundValueEnd = valueEnd
            }
            break
          }
          const siblingProp = matchStickyAt(ANY_PROP_HEAD_STICKY_RE, text, contentStart)
          if (siblingProp !== null) {
            const siblingKey = (siblingProp[3] ?? siblingProp[2] ?? '').toLowerCase()
            if (siblingKey === 'name' || siblingKey === 'key') {
              break
            }
          }
          linePos = lineEnd
        }
      }
    }

    if (foundValueEnd !== -1 && foundValueKeyStart >= cursor) {
      out += text.slice(cursor, foundValueKeyStart) + ' '
      cursor = foundValueEnd
      NAMED_SECRET_KEY_PROP_RE.lastIndex = foundValueEnd
    }
  }

  return cursor === 0 ? text : out + text.slice(cursor)
}

function stripStandalonePrivateKeyPemBlocks(text: string): string {
  let pos = text.indexOf('-----BEGIN ')
  if (pos === -1) return text
  let out = ''
  let cursor = 0
  while (pos !== -1) {
    const headerClose = text.indexOf('-----', pos + 11)
    if (headerClose === -1) break
    const label = text.slice(pos + 11, headerClose)
    if (/^[A-Z0-9 _-]*PRIVATE KEY[A-Z0-9 _-]*$/u.test(label)) {
      const searchFrom = headerClose + 5
      let endIdx = text.indexOf('-----END ', searchFrom)
      let blockEnd = text.length
      while (endIdx !== -1) {
        const endClose = text.indexOf('-----', endIdx + 9)
        if (endClose === -1) break
        const endLabel = text.slice(endIdx + 9, endClose)
        if (/^[A-Z0-9 _-]*PRIVATE KEY[A-Z0-9 _-]*$/u.test(endLabel)) {
          blockEnd = endClose + 5
          break
        }
        endIdx = text.indexOf('-----END ', endClose)
      }
      out += text.slice(cursor, pos) + ' '
      cursor = blockEnd
      pos = text.indexOf('-----BEGIN ', blockEnd)
      continue
    }
    pos = text.indexOf('-----BEGIN ', headerClose)
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

function isFollowedByAssignmentOperator(text: string, pos: number): boolean {
  let i = pos
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1
  }
  const ch = text[i]
  return ch === ':' || ch === '='
}

const CLI_SECRET_FAST_GUARD_RE = /(?:curl|ssh-keygen|docker|-u[:'"`])/iu

const DOCKER_GLOBAL_VALUE_FLAGS = new Set([
  '-h',
  '--host',
  '-c',
  '--context',
  '-l',
  '--log-level',
  '--config',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
])

const CLI_TOKEN_BREAKER_ASCII = (() => {
  const table = new Uint8Array(128)
  for (const ch of ' \t\r\n;|&()<>,{}[]"\'`') {
    table[ch.charCodeAt(0)] = 1
  }
  return table
})()

function isCliTokenBreakerCode(code: number): boolean {
  return code < 128 && CLI_TOKEN_BREAKER_ASCII[code] === 1
}

function findClosingQuoteSameLine(
  text: string,
  openIdx: number,
  failedQuoteLine: Record<string, number>,
  lineId: number,
): number {
  const quote = text[openIdx]
  if (quote !== '"' && quote !== "'" && quote !== '`') return -1
  if (failedQuoteLine[quote] === lineId) return -1
  let j = openIdx + 1
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\r' || ch === '\n') {
      failedQuoteLine[quote] = lineId
      return -1
    }
    if (text.charCodeAt(j) === 92 /* '\\' */) {
      if (j + 1 < text.length && text[j + 1] !== '\r' && text[j + 1] !== '\n') {
        j += 2
        continue
      }
    }
    if (ch === quote) {
      return j + 1
    }
    j += 1
  }
  failedQuoteLine[quote] = lineId
  return -1
}

function consumeCliArgEnd(
  text: string,
  startIdx: number,
  failedQuoteLine: Record<string, number>,
  lineId: number,
): number {
  if (startIdx >= text.length) return -1
  const first = text[startIdx]!
  if (
    first === ' ' ||
    first === '\t' ||
    first === '\r' ||
    first === '\n' ||
    first === ';' ||
    first === '|' ||
    first === '&' ||
    first === '(' ||
    first === ')' ||
    first === '<' ||
    first === '>' ||
    first === ',' ||
    first === '}' ||
    first === ']'
  ) {
    return -1
  }
  let p = startIdx
  while (p < text.length) {
    const ch = text[p]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const qEnd = findClosingQuoteSameLine(text, p, failedQuoteLine, lineId)
      if (qEnd !== -1) {
        p = qEnd
        continue
      }
      if (p === startIdx) {
        p += 1
        continue
      }
      break
    }
    if (ch === '\\' && p + 1 < text.length && text[p + 1] !== '\r' && text[p + 1] !== '\n') {
      p += 2
      continue
    }
    if (
      ch === ' ' ||
      ch === '\t' ||
      ch === '\r' ||
      ch === '\n' ||
      ch === ';' ||
      ch === '|' ||
      ch === '&' ||
      ch === '(' ||
      ch === ')' ||
      ch === '<' ||
      ch === '>' ||
      ch === ',' ||
      ch === '}' ||
      ch === ']'
    ) {
      break
    }
    p += 1
  }
  return p > startIdx ? p : -1
}

function hasColonInRange(text: string, start: number, end: number): boolean {
  for (let k = start; k < end; k += 1) {
    if (text.charCodeAt(k) === 58 /* ':' */) return true
  }
  return false
}

function scrubCommandScopedCliSecrets(text: string): string {
  if (!CLI_SECRET_FAST_GUARD_RE.test(text)) {
    return text
  }

  const hasColon = text.includes(':')
  const failedQuoteLine: Record<string, number> = {}
  let activeCmd: 'none' | 'curl' | 'ssh-keygen' | 'docker' | 'docker-login' = 'none'
  let expectDockerGlobalArg = false
  let lineId = 0
  let out = ''
  let cursor = 0
  let i = 0

  while (i < text.length) {
    const ch = text[i]!
    if (ch === ' ' || ch === '\t') {
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      lineId = i
      activeCmd = 'none'
      expectDockerGlobalArg = false
      continue
    }
    if (ch === '\\' && i + 1 < text.length && (text[i + 1] === '\r' || text[i + 1] === '\n')) {
      i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2
      lineId = i
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      activeCmd = 'none'
      expectDockerGlobalArg = false
      i += 1
      continue
    }
    if (ch === '<' || ch === '>' || ch === ',' || ch === '{' || ch === '}' || ch === '[' || ch === ']') {
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      if (activeCmd !== 'none') {
        const qEnd = findClosingQuoteSameLine(text, i, failedQuoteLine, lineId)
        if (qEnd !== -1) {
          if (activeCmd === 'docker' && expectDockerGlobalArg) {
            expectDockerGlobalArg = false
          }
          i = qEnd
          continue
        }
      }
      i += 1
      continue
    }

    // Check attached `-u:` (anywhere) or `-u":..."` (outside `curl`, where `curl` uses `consumeCliArgEnd` below).
    if (hasColon && ch === '-' && text[i + 1] === 'u' && i + 2 < text.length) {
      const nextCh = text[i + 2]!
      if (nextCh === ':') {
        const argEnd = consumeCliArgEnd(text, i + 3, failedQuoteLine, lineId)
        if (argEnd !== -1) {
          out += text.slice(cursor, i) + ' '
          cursor = argEnd
          i = argEnd
          continue
        }
      } else if (
        activeCmd !== 'curl' &&
        (nextCh === '"' || nextCh === "'" || nextCh === '`')
      ) {
        const qEnd = findClosingQuoteSameLine(text, i + 2, failedQuoteLine, lineId)
        if (qEnd !== -1 && hasColonInRange(text, i + 3, qEnd - 1)) {
          out += text.slice(cursor, i) + ' '
          cursor = qEnd
          i = qEnd
          continue
        }
      }
    }

    // Check `curl`-command-scoped `-u` / `--user` / `-U` / `--proxy-user` (spaced, `=`, attached, or mixed-quoted).
    if (hasColon && activeCmd === 'curl' && ch === '-' && i + 2 < text.length) {
      let valStart = -1
      let isSpaced = false
      const c1 = text[i + 1]
      if (c1 === 'u' || c1 === 'U') {
        if (text[i + 2] === ' ' || text[i + 2] === '\t') {
          let p = i + 2
          while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
            p += 1
          }
          valStart = p
          isSpaced = true
        } else if (text[i + 2] === '=') {
          valStart = i + 3
        } else {
          valStart = i + 2
        }
      } else if (c1 === '-') {
        const c2 = text[i + 2]
        if (
          (c2 === 'u' || c2 === 'U') &&
          i + 6 < text.length &&
          text.slice(i, i + 6).toLowerCase() === '--user'
        ) {
          if (text[i + 6] === ' ' || text[i + 6] === '\t') {
            let p = i + 6
            while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
              p += 1
            }
            valStart = p
            isSpaced = true
          } else if (text[i + 6] === '=') {
            valStart = i + 7
          } else if (text[i + 6] === ':') {
            valStart = i + 6
          }
        } else if (
          (c2 === 'p' || c2 === 'P') &&
          i + 12 < text.length &&
          text.slice(i, i + 12).toLowerCase() === '--proxy-user'
        ) {
          if (text[i + 12] === ' ' || text[i + 12] === '\t') {
            let p = i + 12
            while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
              p += 1
            }
            valStart = p
            isSpaced = true
          } else if (text[i + 12] === '=') {
            valStart = i + 13
          }
        }
      }
      if (valStart !== -1) {
        const valEnd = consumeCliArgEnd(text, valStart, failedQuoteLine, lineId)
        if (valEnd !== -1) {
          if (hasColonInRange(text, valStart, valEnd)) {
            out += text.slice(cursor, i) + ' '
            cursor = valEnd
            i = valEnd
          } else {
            i = isSpaced ? valStart : valEnd
          }
          continue
        }
      }
    }

    // Check `ssh-keygen` `-N` / `-P` passphrase flags.
    if (activeCmd === 'ssh-keygen' && ch === '-' && (text[i + 1] === 'N' || text[i + 1] === 'P')) {
      let valStart = -1
      if (i + 2 < text.length && (text[i + 2] === ' ' || text[i + 2] === '\t')) {
        let p = i + 2
        while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
          p += 1
        }
        valStart = p
      } else if (text[i + 2] === '=') {
        valStart = i + 3
      } else if (i + 2 < text.length && !isCliTokenBreakerCode(text.charCodeAt(i + 2))) {
        valStart = i + 2
      }
      if (valStart !== -1) {
        const valEnd = consumeCliArgEnd(text, valStart, failedQuoteLine, lineId)
        if (valEnd !== -1) {
          out += text.slice(cursor, i) + ' '
          cursor = valEnd
          i = valEnd
          continue
        }
      }
    }

    // Check `docker login` `-p` / `--password` flags (excluding `--password-stdin`).
    if (activeCmd === 'docker-login' && ch === '-') {
      let valStart = -1
      if (text[i + 1] === 'p') {
        if (i + 2 < text.length && (text[i + 2] === ' ' || text[i + 2] === '\t')) {
          let p = i + 2
          while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
            p += 1
          }
          valStart = p
        } else if (text[i + 2] === '=') {
          valStart = i + 3
        } else if (i + 2 < text.length && !isCliTokenBreakerCode(text.charCodeAt(i + 2))) {
          valStart = i + 2
        }
      } else if (i + 10 <= text.length && text.slice(i, i + 10).toLowerCase() === '--password') {
        if (i + 10 < text.length && (text[i + 10] === ' ' || text[i + 10] === '\t')) {
          let p = i + 10
          while (p < text.length && (text[p] === ' ' || text[p] === '\t')) {
            p += 1
          }
          valStart = p
        } else if (text[i + 10] === '=') {
          valStart = i + 11
        }
      }
      if (valStart !== -1) {
        const valEnd = consumeCliArgEnd(text, valStart, failedQuoteLine, lineId)
        if (valEnd !== -1) {
          out += text.slice(cursor, i) + ' '
          cursor = valEnd
          i = valEnd
          continue
        }
      }
    }

    // Consume ordinary command/argument token and update `activeCmd`.
    let tokEnd = i
    while (tokEnd < text.length) {
      const tCode = text.charCodeAt(tokEnd)
      if (
        tCode === 92 /* '\\' */ &&
        tokEnd + 1 < text.length &&
        text[tokEnd + 1] !== '\r' &&
        text[tokEnd + 1] !== '\n'
      ) {
        tokEnd += 2
        continue
      }
      if (tCode < 128 && CLI_TOKEN_BREAKER_ASCII[tCode] === 1) {
        break
      }
      tokEnd += 1
    }
    if (tokEnd === i) {
      i += 1
      continue
    }
    if (ch === '-' && activeCmd !== 'docker') {
      i = tokEnd
      continue
    }

    const tokLower = text.slice(i, tokEnd).toLowerCase()
    const lastSlash = Math.max(tokLower.lastIndexOf('/'), tokLower.lastIndexOf('\\'))
    const baseName = lastSlash >= 0 ? tokLower.slice(lastSlash + 1) : tokLower
    if (baseName === 'curl' || baseName === 'curl.exe') {
      activeCmd = 'curl'
      expectDockerGlobalArg = false
    } else if (baseName === 'ssh-keygen' || baseName === 'ssh-keygen.exe') {
      activeCmd = 'ssh-keygen'
      expectDockerGlobalArg = false
    } else if (baseName === 'docker' || baseName === 'docker.exe') {
      activeCmd = 'docker'
      expectDockerGlobalArg = false
    } else if (activeCmd === 'docker') {
      if (expectDockerGlobalArg) {
        expectDockerGlobalArg = false
      } else if (tokLower.startsWith('-')) {
        if (DOCKER_GLOBAL_VALUE_FLAGS.has(tokLower)) {
          expectDockerGlobalArg = true
        }
      } else if (tokLower === 'login') {
        activeCmd = 'docker-login'
      } else {
        activeCmd = 'none'
      }
    }
    i = tokEnd
  }

  return cursor === 0 ? text : out + text.slice(cursor)
}

export function scrubInterestText(
  raw: string,
  scope?: Partial<Pick<AssociationOwnerScope, 'workspace' | 'principalId'>>,
): string {
  let scrubbed = raw.normalize('NFKC')
  const scopeTerms = collectScopeSensitiveTerms(scope)
  for (const literal of scopeTerms.rawLiterals) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(literal), 'giu'), ' ')
  }

  // Strip CLI basic-auth flags, command-scoped CLI secrets, URLs, emails, paths, IP literals, UUIDs, secrets,
  // and sensitive dotfiles/extensions BEFORE tokenization so path/secret subwords never enter entity extraction.
  // Run `scrubCommandScopedCliSecrets` before URL/path stripping so `docker -H tcp://... login -p ...` keeps
  // its global flag argument intact while parsing.
  scrubbed = scrubCommandScopedCliSecrets(scrubbed)
  if (
    scrubbed.includes(':') &&
    (scrubbed.includes('-u') || scrubbed.includes('--user') || scrubbed.includes('--proxy-user'))
  ) {
    scrubbed = scrubbed.replace(CLI_BASIC_AUTH_RE, ' ')
  }
  if (scrubbed.includes('://')) {
    scrubbed = stripUrlsFromInterestText(scrubbed)
  }
  if (scrubbed.includes('@')) {
    scrubbed = scrubbed.replace(
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
      ' ',
    )
  }
  if (scrubbed.includes('\\')) {
    scrubbed = scrubbed
      .replace(/[A-Za-z]:\\[^\s"'`<>|;,()]+/gu, ' ')
      .replace(/(?<=^|[\s<>|;,()]|(?<!\\)["'`])[^\s"'`<>|;,()\\]*(?:\\+[^\s"'`<>|;,()\\]+)+/gu, ' ')
  }
  if (scrubbed.includes('/')) {
    scrubbed = scrubbed.replace(
      /(?<=^|[\s"'`(,=])(?:~|\.{1,2})?(?!\/\/[^/\s"'`<>|;,()]*(?:$|[\s])|\/\*)(?:\/[^\s"'`<>|;,()]+)+/gu,
      ' ',
    )
  }
  if (scrubbed.includes('-')) {
    scrubbed = scrubbed.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
      ' ',
    )
  }
  if (scrubbed.includes('.')) {
    scrubbed = scrubbed.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, ' ')
  }
  if (scrubbed.includes(':')) {
    scrubbed = scrubbed.replace(/(?:\[[0-9a-f:]+\]|(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})/giu, ' ')
  }
  if (scrubbed.includes(':') || scrubbed.includes('=')) {
    scrubbed = scrubByKeyPattern(scrubbed, SCRUB_ASSIGN_HEAD_RE, false)
  }
  if (scrubbed.includes(':')) {
    scrubbed = scrubNamedSecretValuePairs(scrubbed)
  }
  if (scrubbed.includes('-----BEGIN ')) {
    scrubbed = stripStandalonePrivateKeyPemBlocks(scrubbed)
  }
  scrubbed = scrubByKeyPattern(scrubbed, SCRUB_SPACE_HEAD_RE, true)

  if (scrubbed.includes('_') || scrubbed.includes('-')) {
    scrubbed = scrubbed.replace(
      /\b(?:(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[bpar]|glpat)[_-]|(?:npm|whsec)_)[A-Za-z0-9._-]+\b/giu,
      (match, offset: number, full: string) =>
        isFollowedByAssignmentOperator(full, offset + match.length) && isSecretAssignmentKey(match)
          ? match
          : ' ',
    )
  }
  if (scrubbed.includes('_')) {
    scrubbed = scrubbed.replace(
      /\bgithub_pat_[A-Za-z0-9_]+\b/giu,
      (match, offset: number, full: string) =>
        isFollowedByAssignmentOperator(full, offset + match.length) && isSecretAssignmentKey(match)
          ? match
          : ' ',
    )
  }
  if (scrubbed.includes('AKIA') || scrubbed.includes('ASIA') || scrubbed.includes('AIza')) {
    scrubbed = scrubbed.replace(/\b(?:AKIA|ASIA|AIza)[0-9A-Za-z_-]{8,}\b/gu, ' ')
  }
  if (scrubbed.includes('ya29.') || scrubbed.includes('YA29.')) {
    scrubbed = scrubbed.replace(/\bya29\.[A-Za-z0-9._-]+\b/giu, ' ')
  }
  if (scrubbed.includes('eyJ')) {
    scrubbed = scrubbed.replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*\b/gu, ' ')
  }

  if (scrubbed.includes('.')) {
    scrubbed = scrubbed
      .replace(
        /(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+\.(?:sqlite|sqlite3|db|env|pem|key|p12|pfx|crt|cer|pub|der|jks|keystore|kdbx|log|bak|secret|passwd|htpasswd|netrc|npmrc|pypirc|dockercfg)\b/giu,
        ' ',
      )
      .replace(/(?:^|[\s(,=])\.[A-Za-z0-9._-]+(?=$|[\s),])/gu, ' ')
  }

  return scrubbed
}

export function sanitizeInterestToken(
  token: string,
  scope?: Partial<Pick<AssociationOwnerScope, 'workspace' | 'principalId'>>,
): string | null {
  if (typeof token !== 'string') return null
  const rawTrimmed = token.normalize('NFKC').trim()
  if (rawTrimmed.length < 2 || rawTrimmed.length > 128) return null
  if (/\s|\p{Cc}/u.test(rawTrimmed)) return null

  if (
    rawTrimmed.includes('/') ||
    rawTrimmed.includes('\\') ||
    rawTrimmed.includes('~') ||
    rawTrimmed.includes('@') ||
    rawTrimmed.includes(':') ||
    rawTrimmed.includes('..') ||
    rawTrimmed.includes('+') ||
    rawTrimmed.includes('=') ||
    rawTrimmed.startsWith('.') ||
    rawTrimmed.endsWith('.')
  ) {
    return null
  }

  if (isIP(rawTrimmed) !== 0) return null

  const lower = rawTrimmed.toLocaleLowerCase('en-US')
  if (STOPWORDS.has(lower)) return null
  if (/^\d+$/u.test(lower)) return null
  if (IPV4_RE.test(lower)) return null
  if (UUID_RE.test(lower)) return null
  if (DANGEROUS_EXT_RE.test(lower)) return null
  if (SECRET_PREFIX_RE.test(rawTrimmed)) return null
  if (HEX_LONG_RE.test(lower)) return null

  if (SECRET_EXACT_TOKENS.has(lower)) return null
  if (hasSecretStem(rawTrimmed)) return null
  const subParts = lower.split(/[._-]+/u).filter((part) => part.length > 0)
  for (const part of subParts) {
    if (SECRET_EXACT_TOKENS.has(part)) return null
  }
  if (rawTrimmed.includes('_') && subParts.includes('pass')) {
    return null
  }
  if (lower === 'github_pat' || lower === 'github-pat' || lower === 'githubpat') {
    return null
  }
  if (
    (subParts.includes('api') ||
      subParts.includes('private') ||
      subParts.includes('secret') ||
      subParts.includes('access') ||
      subParts.includes('auth') ||
      subParts.includes('client') ||
      subParts.includes('ssh') ||
      subParts.includes('signing') ||
      subParts.includes('master') ||
      subParts.includes('encryption') ||
      subParts.includes('deploy') ||
      subParts.includes('jwt') ||
      subParts.includes('app') ||
      subParts.includes('hmac') ||
      subParts.includes('tls') ||
      subParts.includes('ssl') ||
      subParts.includes('aes') ||
      subParts.includes('kms') ||
      subParts.includes('fernet') ||
      subParts.includes('cipher') ||
      subParts.includes('pk') ||
      subParts.includes('sk') ||
      subParts.includes('rk') ||
      subParts.includes('whsec') ||
      subParts.includes('ghp') ||
      subParts.includes('gho') ||
      subParts.includes('ghu') ||
      subParts.includes('ghs') ||
      subParts.includes('ghr') ||
      subParts.includes('glpat') ||
      subParts.includes('npm') ||
      subParts.includes('xoxb') ||
      subParts.includes('xoxp') ||
      subParts.includes('xoxa') ||
      subParts.includes('xoxr') ||
      (subParts.includes('github') && subParts.includes('pat'))) &&
    (subParts.includes('key') || subParts.includes('keys'))
  ) {
    return null
  }

  // Reject base64/high-entropy strings >= 20 chars:
  // - any >= 20 char non-hyphenated alphanumeric/underscore token
  // - any >= 20 char token containing underscores or >= 2 digits
  if (lower.length >= 20) {
    if (NON_HYPHEN_LONG_RE.test(lower)) return null
    const digitCount = lower.replace(/[^0-9]/gu, '').length
    if (lower.includes('_') || digitCount >= 2) return null
    if (/[A-Z]/u.test(rawTrimmed) && /[a-z]/u.test(rawTrimmed) && digitCount >= 1) return null
  }

  const scopeTerms = collectScopeSensitiveTerms(scope)
  if (scopeTerms.exactTerms.has(lower)) return null
  for (const term of scopeTerms.substringTerms) {
    if (lower.includes(term)) return null
  }

  if (CJK_CHAR_RE.test(lower)) {
    if (lower.length > MAX_CJK_TOKEN_CHARS || !SAFE_CJK_TOKEN_RE.test(lower)) return null
    return lower
  }

  if (lower.length > MAX_TOKEN_CHARS || !SAFE_ASCII_TOKEN_RE.test(lower)) {
    return null
  }

  return lower
}

function extractCleanTokensFromTextAndEntities(
  rawTextOrParts: string | readonly string[],
  storedEntities: readonly string[],
  scope: AssociationOwnerScope,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const push = (candidate: string): void => {
    const clean = sanitizeInterestToken(candidate, scope)
    if (clean === null || seen.has(clean)) return
    seen.add(clean)
    result.push(clean)
  }

  const parts = typeof rawTextOrParts === 'string' ? [rawTextOrParts] : rawTextOrParts
  const hasNonEmptyRaw = parts.some((part) => part.trim().length > 0)
  const scrubbed = parts
    .filter((part) => part.length > 0)
    .map((part) => scrubInterestText(part, scope))
    .join('\n')
  const scrubbedEntitySet = new Set(extractEntities(scrubbed, 48))
  const scrubbedTokenSet = new Set(tokenizeAssociationText(scrubbed))

  if (!hasNonEmptyRaw) {
    for (const ent of storedEntities) {
      push(ent)
    }
  } else {
    // Only admit stored entities that remain present after sensitive-text scrubbing.
    for (const ent of storedEntities) {
      const normalized = ent.normalize('NFKC').toLocaleLowerCase('en-US').trim()
      if (scrubbedEntitySet.has(normalized) || scrubbedTokenSet.has(normalized)) {
        push(normalized)
      }
    }
    for (const ent of scrubbedEntitySet) {
      push(ent)
    }
    for (const tok of scrubbedTokenSet) {
      push(tok)
    }
  }

  return result
}

function buildBoundedQueryTokens(tokens: readonly string[]): string[] {
  const selected: string[] = []
  let totalChars = 0

  for (const tok of tokens) {
    if (selected.length >= MAX_TOKENS_PER_QUERY) break
    const extraChars = selected.length === 0 ? tok.length : 1 + tok.length
    if (totalChars + extraChars > MAX_QUERY_CHARS) continue
    selected.push(tok)
    totalChars += extraChars
  }

  return selected
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function parseCueTextsAndEntities(raw: string): Array<{
  readonly text: string
  readonly entities: readonly string[]
}> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: Array<{ readonly text: string; readonly entities: readonly string[] }> = []
    for (const item of parsed) {
      if (typeof item === 'string') {
        out.push({ text: item, entities: [] })
      } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as { text?: unknown; entities?: unknown }
        const text = typeof obj.text === 'string' ? obj.text : ''
        const entities = Array.isArray(obj.entities)
          ? obj.entities.filter((v): v is string => typeof v === 'string')
          : []
        if (text.length > 0 || entities.length > 0) {
          out.push({ text, entities })
        }
      }
    }
    return out
  } catch {
    return []
  }
}

function loadHoldoutTaskIds(db: DatabaseSync, ownerScopeKey: string): Set<string> {
  const holdouts = new Set<string>()
  if (!hasTable(db, 'assoc_holdout_assignments')) return holdouts
  const rows = db
    .prepare(
      'SELECT task_id FROM assoc_holdout_assignments WHERE owner_scope_key = ? AND in_holdout = 1',
    )
    .all(ownerScopeKey) as Array<{ task_id: string }>
  for (const row of rows) {
    holdouts.add(row.task_id)
  }
  return holdouts
}

interface RawCandidateInterest {
  readonly tokens: readonly string[]
  readonly query: string
  readonly interestKey: string
  readonly priority: number
  readonly sourceKind: WebInterestSourceKind
  readonly originNodeIds: readonly string[]
  readonly updatedAt: number
}

export function extractWebLearningInterests(
  storeOrDb: AssociationStore | DatabaseSync,
  scope: AssociationOwnerScope,
  options?: ExtractWebLearningInterestsOptions,
): WebLearningInterestExtractionResult {
  const db = asDatabase(storeOrDb)
  const cfg = options?.config ?? DEFAULT_ASSOCIATION_WEB_LEARNING_CONFIG
  const allowedDomains = options?.allowedDomains ?? cfg.allowedDomains
  const seedUrls = options?.seedUrls ?? cfg.seedUrls
  const allowSubdomains = options?.allowSubdomains ?? cfg.allowSubdomains
  const cooldownMs = options?.cooldownMs ?? cfg.cooldownMs
  const maxInterests = Math.max(0, Math.floor(options?.maxInterestsPerRun ?? cfg.maxInterestsPerRun))
  const discoverLinks = options?.discoverLinks ?? cfg.discoverLinks
  const nowMs = options?.nowMs ?? Date.now()

  if (maxInterests === 0 || allowedDomains.length === 0) {
    return {
      interests: [],
      targets: [],
      skippedCooldownCount: 0,
      rejectedSeedUrls: [],
    }
  }

  const holdoutTaskIds = loadHoldoutTaskIds(db, scope.ownerScopeKey)
  const rawCandidates: RawCandidateInterest[] = []

  const addCandidate = (
    tokens: readonly string[],
    priority: number,
    sourceKind: WebInterestSourceKind,
    originNodeIds: readonly string[],
    updatedAt: number,
  ): void => {
    const bounded = buildBoundedQueryTokens(tokens)
    if (bounded.length === 0) return
    const query = bounded.join(' ')
    const interestKey = `int-${sha256Hex(query).slice(0, 16)}`
    rawCandidates.push({
      tokens: bounded,
      query,
      interestKey,
      priority,
      sourceKind,
      originNodeIds,
      updatedAt,
    })
  }

  // 1. Active private goal, work-item, dream, abstraction nodes
  if (hasTable(db, 'assoc_nodes')) {
    const nodeRows = db
      .prepare(`
        SELECT id, kind, title, body, entities_json, updated_at
        FROM assoc_nodes
        WHERE owner_scope_key = ?
          AND status = 'active'
          AND sensitivity = 'private'
          AND kind IN ('goal', 'work-item', 'dream', 'abstraction')
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY updated_at DESC, id ASC
        LIMIT 200
      `)
      .all(scope.ownerScopeKey, nowMs) as Array<{
      id: string
      kind: 'goal' | 'work-item' | 'dream' | 'abstraction'
      title: string
      body: string
      entities_json: string
      updated_at: number
    }>

    for (const row of nodeRows) {
      const cleanTokens = extractCleanTokensFromTextAndEntities(
        [row.title, row.body],
        parseJsonStringArray(row.entities_json),
        scope,
      )
      if (cleanTokens.length === 0) continue
      const priority = INTEREST_SOURCE_PRIORITIES[row.kind]
      addCandidate(cleanTokens, priority, row.kind, [row.id], row.updated_at)
    }
  }

  // Helper: inspect private active episode nodes for a taskId (never sensitive, never holdout)
  const lookupPrivateEpisodeByTaskId = (
    taskId: string,
  ): {
    readonly id: string
    readonly sensitivity: string
    readonly title: string
    readonly body: string
    readonly entities: readonly string[]
  } | null => {
    if (!hasTable(db, 'assoc_nodes')) return null
    const row = db
      .prepare(`
        SELECT id, sensitivity, title, body, entities_json
        FROM assoc_nodes
        WHERE owner_scope_key = ?
          AND kind = 'episode'
          AND status = 'active'
          AND (source_ref = ? OR id = ?)
        LIMIT 1
      `)
      .get(scope.ownerScopeKey, taskId, taskId) as
      | {
          id: string
          sensitivity: string
          title: string
          body: string
          entities_json: string
        }
      | undefined
    if (row === undefined) return null
    return {
      id: row.id,
      sensitivity: row.sensitivity,
      title: row.title,
      body: row.body,
      entities: parseJsonStringArray(row.entities_json),
    }
  }

  // 2. Recent non-holdout assoc_implicit_signals ('re-ask' / 'redo', priority 1.1)
  if (hasTable(db, 'assoc_implicit_signals')) {
    const signalRows = db
      .prepare(`
        SELECT signal_id, kind, evidence_json, created_at
        FROM assoc_implicit_signals
        WHERE owner_scope_key = ?
          AND kind IN ('re-ask', 'redo')
        ORDER BY created_at DESC, signal_id ASC
        LIMIT 100
      `)
      .all(scope.ownerScopeKey) as Array<{
      signal_id: string
      kind: 're-ask' | 'redo'
      evidence_json: string
      created_at: number
    }>

    for (const sig of signalRows) {
      let evidence: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(sig.evidence_json) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          evidence = parsed as Record<string, unknown>
        }
      } catch {
        evidence = {}
      }

      const rawTaskIds = [
        ...(Array.isArray(evidence.taskIds) ? evidence.taskIds : []),
        ...(Array.isArray(evidence.failedTaskIds) ? evidence.failedTaskIds : []),
        ...(Array.isArray(evidence.followUpTaskIds) ? evidence.followUpTaskIds : []),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0)

      if (rawTaskIds.some((taskId) => holdoutTaskIds.has(taskId))) {
        continue
      }

      const originIds: string[] = []
      const collectedTokens: string[] = []
      let sawSensitiveEpisode = false

      for (const taskId of rawTaskIds) {
        const ep = lookupPrivateEpisodeByTaskId(taskId)
        if (ep === null) continue
        if (ep.sensitivity !== 'private') {
          sawSensitiveEpisode = true
          break
        }
        originIds.push(ep.id)
        for (const tok of extractCleanTokensFromTextAndEntities(
          [ep.title, ep.body],
          ep.entities,
          scope,
        )) {
          if (!collectedTokens.includes(tok)) {
            collectedTokens.push(tok)
          }
        }
      }

      if (sawSensitiveEpisode) continue

      for (const field of ['entities', 'topics', 'sharedEntities'] as const) {
        const value = evidence[field]
        if (!Array.isArray(value)) continue
        for (const entry of value) {
          if (typeof entry !== 'string') continue
          const clean = sanitizeInterestToken(entry, scope)
          if (clean !== null && !collectedTokens.includes(clean)) {
            collectedTokens.push(clean)
          }
        }
      }

      if (collectedTokens.length > 0) {
        addCandidate(
          collectedTokens,
          INTEREST_SOURCE_PRIORITIES['implicit-signal'],
          'implicit-signal',
          originIds,
          sig.created_at,
        )
      }
    }
  }

  // 3. Recent non-holdout low-coverage step metrics / replay episodes (candidate_count <= 1, priority 0.9)
  if (hasTable(db, 'assoc_step_metrics')) {
    const metricRows = db
      .prepare(`
        SELECT task_id, candidate_count, occurred_at
        FROM assoc_step_metrics
        WHERE owner_scope_key = ?
          AND in_holdout = 0
          AND candidate_count <= 1
          AND task_id IS NOT NULL
        ORDER BY occurred_at DESC, seq DESC
        LIMIT 100
      `)
      .all(scope.ownerScopeKey) as Array<{
      task_id: string
      candidate_count: number
      occurred_at: number
    }>

    const seenLowCovTasks = new Set<string>()
    for (const metric of metricRows) {
      if (seenLowCovTasks.has(metric.task_id) || holdoutTaskIds.has(metric.task_id)) continue
      seenLowCovTasks.add(metric.task_id)

      const ep = lookupPrivateEpisodeByTaskId(metric.task_id)
      if (ep !== null && ep.sensitivity !== 'private') {
        continue
      }

      const collectedTokens: string[] = []
      const originIds: string[] = []
      if (ep !== null) {
        originIds.push(ep.id)
        for (const tok of extractCleanTokensFromTextAndEntities(
          [ep.title, ep.body],
          ep.entities,
          scope,
        )) {
          if (!collectedTokens.includes(tok)) {
            collectedTokens.push(tok)
          }
        }
      }

      if (hasTable(db, 'assoc_replay_episodes')) {
        const replayRow = db
          .prepare(`
            SELECT in_holdout, cues_json
            FROM assoc_replay_episodes
            WHERE owner_scope_key = ? AND task_id = ?
            LIMIT 1
          `)
          .get(scope.ownerScopeKey, metric.task_id) as
          | { in_holdout: number; cues_json: string }
          | undefined
        if (replayRow !== undefined) {
          if (replayRow.in_holdout === 1) continue
          const cues = parseCueTextsAndEntities(replayRow.cues_json)
          for (const cue of cues) {
            for (const tok of extractCleanTokensFromTextAndEntities(cue.text, cue.entities, scope)) {
              if (!collectedTokens.includes(tok)) {
                collectedTokens.push(tok)
              }
            }
          }
        }
      }

      if (collectedTokens.length > 0) {
        addCandidate(
          collectedTokens,
          INTEREST_SOURCE_PRIORITIES['low-coverage'],
          'low-coverage',
          originIds,
          metric.occurred_at,
        )
      }
    }
  }

  // Merge duplicate queries, keeping highest priority, newest timestamp, and union of originNodeIds
  const mergedByKey = new Map<
    string,
    {
      readonly interestKey: string
      readonly query: string
      readonly tokens: readonly string[]
      priority: number
      sourceKind: WebInterestSourceKind
      readonly originNodeIds: Set<string>
      updatedAt: number
    }
  >()

  for (const cand of rawCandidates) {
    const existing = mergedByKey.get(cand.interestKey)
    if (existing === undefined) {
      mergedByKey.set(cand.interestKey, {
        interestKey: cand.interestKey,
        query: cand.query,
        tokens: cand.tokens,
        priority: cand.priority,
        sourceKind: cand.sourceKind,
        originNodeIds: new Set(cand.originNodeIds),
        updatedAt: cand.updatedAt,
      })
    } else {
      if (cand.priority > existing.priority) {
        existing.priority = cand.priority
        existing.sourceKind = cand.sourceKind
      }
      if (cand.updatedAt > existing.updatedAt) {
        existing.updatedAt = cand.updatedAt
      }
      for (const id of cand.originNodeIds) {
        existing.originNodeIds.add(id)
      }
    }
  }

  const sortedInterests: ExtractedWebInterest[] = [...mergedByKey.values()]
    .map((entry) => ({
      interestKey: entry.interestKey,
      query: entry.query,
      tokens: entry.tokens,
      priority: entry.priority,
      sourceKind: entry.sourceKind,
      originNodeIds: [...entry.originNodeIds].sort(),
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      return a.interestKey.localeCompare(b.interestKey)
    })

  // Load recent fetches for cooldown deduplication
  const cooledInterestKeys = new Set<string>()
  const cooledUrls = new Set<string>()
  if (cooldownMs > 0 && hasTable(db, 'assoc_web_learning_fetches')) {
    const cutoff = nowMs - cooldownMs
    const recentRows = db
      .prepare(`
        SELECT canonical_url, interest_key, status
        FROM assoc_web_learning_fetches
        WHERE owner_scope_key = ? AND fetched_at >= ?
      `)
      .all(scope.ownerScopeKey, cutoff) as Array<{
      canonical_url: string
      interest_key: string
      status: string
    }>
    for (const row of recentRows) {
      if (row.status === 'ok') {
        cooledUrls.add(row.canonical_url)
        cooledInterestKeys.add(row.interest_key)
      }
    }
  }

  const selectedInterests: ExtractedWebInterest[] = []
  const targets: WebLearningPlanTarget[] = []
  const seenTargetUrls = new Set<string>()
  const rejectedSeedUrlSet = new Set<string>()
  let skippedCooldownCount = 0

  for (const interest of sortedInterests) {
    if (selectedInterests.length >= maxInterests) break
    if (cooledInterestKeys.has(interest.interestKey)) {
      skippedCooldownCount += 1
      continue
    }

    const interestTargets: WebLearningPlanTarget[] = []
    let blockedAllByCooldown = seedUrls.length > 0

    for (const seed of seedUrls) {
      const candidateRaw = seed.includes('{query}')
        ? seed.replaceAll('{query}', encodeURIComponent(interest.query))
        : seed
      try {
        const validated = validateWhitelistedWebUrl(candidateRaw, {
          allowedDomains,
          allowSubdomains,
        })
        if (cooledUrls.has(validated.canonicalUrl)) {
          continue
        }
        blockedAllByCooldown = false
        if (seenTargetUrls.has(validated.canonicalUrl)) {
          continue
        }
        seenTargetUrls.add(validated.canonicalUrl)
        interestTargets.push({
          url: validated.canonicalUrl,
          interestKey: interest.interestKey,
          originNodeIds: interest.originNodeIds,
          discoverLinks,
        })
      } catch {
        rejectedSeedUrlSet.add(candidateRaw)
      }
    }

    if (seedUrls.length === 0) {
      selectedInterests.push(interest)
      continue
    }

    if (interestTargets.length === 0) {
      if (blockedAllByCooldown) {
        skippedCooldownCount += 1
      }
      continue
    }

    selectedInterests.push(interest)
    targets.push(...interestTargets)
  }

  return {
    interests: selectedInterests,
    targets,
    skippedCooldownCount,
    rejectedSeedUrls: [...rejectedSeedUrlSet],
  }
}
