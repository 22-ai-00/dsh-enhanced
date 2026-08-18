#!/usr/bin/env node
/**
 * capture-cli-fixtures.mjs — operator-run capture tool for real CLI fixtures.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │  THIS IS NOT PART OF THE AUTOMATED TEST SUITE.                              │
 * │  It is a manual tool an operator runs, by hand, in an ALREADY-AUTHENTICATED │
 * │  environment to record golden stdout samples from an official coding CLI.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️  WARNING — READ BEFORE RUNNING:
 *   • Running this SPAWNS A REAL CLI AND CONSUMES YOUR SUBSCRIPTION QUOTA. It makes a
 *     live model turn. Only run it when you have explicitly decided to spend that quota.
 *   • Capture requires EXPLICIT AUTHORIZATION. You must pass --i-understand-this-uses-quota.
 *   • Redaction is best-effort and ON BY DEFAULT. You MUST still MANUALLY REVIEW every
 *     generated fixture before committing it. Never commit a sample you have not read.
 *   • Use a boring, safe test prompt. Never include secrets, private paths, or personal
 *     data in the prompt — the CLI may echo it back into its output stream.
 *
 * The captured file is redacted, then written to:
 *     tests/fixtures/<provider>/<version>/<scenario>.json
 * matching the `CliFixture` schema in tests/fixtures/schema.ts. The redacted `lines`
 * are fed verbatim to the src/process.ts decoder by tests/fixtures.spec.ts.
 *
 * This tool intentionally does NOT reuse src/process.ts. It is a deliberately simple,
 * standalone capturer (shell:false spawn, minimal env, line-buffered stdout) so it can
 * run without a build step. The production bridge remains the single source of truth for
 * parsing; this only records raw bytes.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_ROOT = join(HERE, '..', 'tests', 'fixtures')

const PROVIDERS = ['codex', 'claude', 'cursor', 'grok']
const SCENARIOS = ['success', 'partial-then-success', 'terminal-failure', 'malformed', 'auth-source', 'usage']

const HELP = `
capture-cli-fixtures — record redacted golden fixtures from a real coding CLI.

  NOT a test. Run manually, in an already-authenticated shell. CONSUMES QUOTA.

Usage:
  node scripts/capture-cli-fixtures.mjs \\
    --provider <codex|claude|cursor|grok> \\
    --scenario <${SCENARIOS.join('|')}> \\
    --version <cliVersion> \\
    --prompt "<safe test prompt>" \\
    --i-understand-this-uses-quota \\
    [--command <executable>] [--cwd <dir>] [--timeout-ms <n>] [--no-redact] [--dry-run]

Required:
  --provider   Which CLI to record. One of: ${PROVIDERS.join(', ')}.
  --scenario   Fixture scenario name. One of: ${SCENARIOS.join(', ')}.
  --version    The CLI version string you are pinning (e.g. "1.2.3"). Used in the path
               and stored in the fixture. Get it from e.g. \`codex --version\`.
  --prompt     A short, SAFE test prompt. NO secrets, NO private paths, NO personal data.
  --i-understand-this-uses-quota
               Explicit authorization. Without it the tool refuses to spawn anything.

Optional:
  --command    Override the executable (default: the provider's canonical command).
  --cwd        Working directory for the CLI (default: current directory).
  --timeout-ms Whole-invocation timeout in ms (default: 120000).
  --no-redact  DISABLE redaction. Strongly discouraged; the fixture will be marked
               "redacted": false and the loader/tests will REFUSE it. For debugging only.
  --dry-run    Print the argv and target path, then exit WITHOUT spawning (uses no quota).
  --help       Show this help.

Output:
  tests/fixtures/<provider>/<version>/<scenario>.json  (CliFixture schema)

After running:
  1. Open the generated JSON and READ every line.
  2. Confirm no paths, emails, tokens, session ids, or prompt echoes remain.
  3. Only then commit it.
`

function parseArgs(argv) {
  const args = { redact: true, dryRun: false, authorized: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help': case '-h': args.help = true; break
      case '--no-redact': args.redact = false; break
      case '--dry-run': args.dryRun = true; break
      case '--i-understand-this-uses-quota': args.authorized = true; break
      case '--provider': args.provider = argv[++i]; break
      case '--scenario': args.scenario = argv[++i]; break
      case '--version': args.version = argv[++i]; break
      case '--prompt': args.prompt = argv[++i]; break
      case '--command': args.command = argv[++i]; break
      case '--cwd': args.cwd = argv[++i]; break
      case '--timeout-ms': args.timeoutMs = Number(argv[++i]); break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

/** Argv for each provider mirrors src/providers.ts. Keep in sync if the presets change. */
function buildArgv(provider, prompt) {
  switch (provider) {
    case 'codex':
      return { command: 'codex', args: ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', prompt] }
    case 'claude':
      return {
        command: 'claude',
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
          '--no-session-persistence', '--safe-mode', '--permission-mode', 'dontAsk', '--tools', '', prompt],
      }
    case 'cursor':
      return { command: 'cursor-agent', args: ['--print', '--output-format', 'stream-json', prompt] }
    case 'grok':
      return {
        command: 'grok',
        args: ['-p', prompt, '--output-format', 'streaming-json', '--permission-mode', 'dontAsk',
          '--no-auto-update', '--no-memory', '--no-subagents', '--disable-web-search'],
      }
    default:
      throw new Error(`unknown provider: ${provider}`)
  }
}

/** Minimal, subscription-favouring env: forward only benign names; never API keys. */
function buildEnv() {
  const allow = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CURSOR_CONFIG_DIR',
    'GROK_HOME', 'GROK_CONFIG_DIR', 'XAI_CONFIG_DIR',
  ])
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (allow.has(name) && value !== undefined) env[name] = value
  }
  return env
}

/**
 * Best-effort scrubber. Applied to every captured line before it is written.
 * Removes/replaces: absolute filesystem paths, the operator's home dir, emails,
 * likely tokens/api keys/secrets (Bearer, sk-*, long hex/base64), UUIDs and
 * session ids, and any verbatim echo of the prompt.
 *
 * NOTE: this is defense-in-depth, not a guarantee. Manual review is still mandatory.
 */
function makeRedactor(prompt) {
  const home = homedir()
  // Escape a string for safe inclusion in a RegExp.
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rules = [
    // Home directory (do this before the generic path rule).
    ...(home ? [[new RegExp(escape(home), 'g'), '<HOME>']] : []),
    // Unix absolute paths under common user roots.
    [/\/(?:Users|home|root)\/[^\s"'\\/]+/g, '/<REDACTED_PATH>'],
    // Windows user profile paths (with either slash style).
    [/[A-Za-z]:\\Users\\[^\s"'\\]+/g, 'C:\\<REDACTED_PATH>'],
    [/[A-Za-z]:\/Users\/[^\s"'/]+/g, 'C:/<REDACTED_PATH>'],
    // Emails.
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>'],
    // Bearer tokens.
    [/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer <TOKEN>'],
    // OpenAI-style secret keys and similar prefixed keys.
    [/\b(?:sk|pk|rk|xai|ghp|gho|ghs|glpat)-[A-Za-z0-9_-]{10,}/g, '<APIKEY>'],
    // JSON fields whose names smell like a secret.
    [/("(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|auth[_-]?token|client[_-]?secret|session[_-]?id|sessionId|id_token)"\s*:\s*)"[^"]*"/gi,
      '$1"<REDACTED>"'],
    // UUIDs (session/thread/request ids).
    [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<UUID>'],
    // Long hex blobs (>= 32 chars) — hashes, raw tokens.
    [/\b[0-9a-fA-F]{32,}\b/g, '<HEX>'],
    // Long base64/base64url blobs (>= 40 chars) — likely tokens.
    [/\b[A-Za-z0-9_-]{40,}={0,2}\b/g, '<BASE64>'],
  ]
  const trimmedPrompt = (prompt ?? '').trim()
  return function redact(line) {
    let out = line
    for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement)
    // Replace verbatim echoes of the prompt last, so path/token rules run on original text.
    if (trimmedPrompt.length >= 4) {
      out = out.split(trimmedPrompt).join('<PROMPT>')
    }
    return out
  }
}

async function captureLines({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildEnv(),
    })
    const lines = []
    let pending = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGINT')
      setTimeout(() => child.kill('SIGKILL'), 3_000)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      pending += chunk
      let nl
      while ((nl = pending.indexOf('\n')) !== -1) {
        let line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        lines.push(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })

    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (pending.length > 0) lines.push(pending)
      resolve({ lines, stderr, code, signal })
    })
  })
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`Error: ${error.message}`)
    console.error(HELP)
    process.exit(2)
  }
  if (args.help || process.argv.length <= 2) {
    console.log(HELP)
    process.exit(args.help ? 0 : 2)
  }

  const problems = []
  if (!PROVIDERS.includes(args.provider)) problems.push(`--provider must be one of: ${PROVIDERS.join(', ')}`)
  if (!SCENARIOS.includes(args.scenario)) problems.push(`--scenario must be one of: ${SCENARIOS.join(', ')}`)
  if (!args.version) problems.push('--version is required (the pinned CLI version)')
  if (!args.prompt) problems.push('--prompt is required (a short, SAFE test prompt)')
  if (problems.length > 0) {
    console.error('Error:\n  - ' + problems.join('\n  - '))
    console.error(HELP)
    process.exit(2)
  }

  const { command: presetCommand, args: cliArgs } = buildArgv(args.provider, args.prompt)
  const command = args.command ?? presetCommand
  const cwd = args.cwd ?? process.cwd()
  const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 120_000
  const targetDir = join(FIXTURES_ROOT, args.provider, args.version)
  const targetFile = join(targetDir, `${args.scenario}.json`)

  console.error('==============================================================')
  console.error('  capture-cli-fixtures — this consumes real subscription quota')
  console.error('==============================================================')
  console.error(`  provider : ${args.provider}`)
  console.error(`  scenario : ${args.scenario}`)
  console.error(`  version  : ${args.version}`)
  console.error(`  command  : ${command} ${cliArgs.map(a => (a === '' ? '""' : a)).join(' ')}`)
  console.error(`  cwd      : ${cwd}`)
  console.error(`  redact   : ${args.redact ? 'ON (still review manually!)' : 'OFF — output will be REFUSED by the loader'}`)
  console.error(`  output   : ${targetFile}`)
  console.error('==============================================================')

  if (args.dryRun) {
    console.error('Dry run: not spawning. No quota consumed.')
    process.exit(0)
  }
  if (!args.authorized) {
    console.error('Refusing to run without --i-understand-this-uses-quota.')
    console.error('This spawns a real CLI and spends your subscription quota. Re-run with the flag once you accept that.')
    process.exit(2)
  }

  console.error('Spawning CLI… (Ctrl-C to abort)')
  let captured
  try {
    captured = await captureLines({ command, args: cliArgs, cwd, timeoutMs })
  } catch (error) {
    console.error(`Failed to run ${command}: ${error.message}`)
    process.exit(1)
  }

  const redact = args.redact ? makeRedactor(args.prompt) : line => line
  const redactedLines = captured.lines.map(redact).filter(line => line.length > 0)

  const fixture = {
    provider: args.provider,
    cliVersion: args.version,
    scenario: args.scenario,
    capturedAt: new Date().toISOString(),
    redacted: args.redact,
    lines: redactedLines,
  }

  mkdirSync(targetDir, { recursive: true })
  writeFileSync(targetFile, JSON.stringify(fixture, null, 2) + '\n', 'utf8')

  console.error('--------------------------------------------------------------')
  console.error(`Wrote ${redactedLines.length} redacted line(s) to:`)
  console.error(`  ${targetFile}`)
  console.error(`CLI exited: code=${captured.code} signal=${captured.signal ?? 'null'}`)
  if (!args.redact) {
    console.error('!! REDACTION WAS DISABLED — this fixture is marked "redacted": false and')
    console.error('!! WILL BE REFUSED by tests/fixtures/schema.ts. Do not commit it.')
  }
  console.error('')
  console.error('NEXT: open the file, read EVERY line, and confirm no paths/emails/tokens/')
  console.error('session-ids/prompt-echoes remain before you commit it.')
  console.error('--------------------------------------------------------------')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
