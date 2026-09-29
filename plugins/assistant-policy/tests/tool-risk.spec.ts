import { describe, expect, test } from 'vitest'
import { classifyToolRisk } from '../src/tool-risk.ts'

const workspace = '/work/alpha'

describe('parameter-aware tool risk classification', () => {
  test('allows only path-proven workspace reads and workspace-contained writes', () => {
    expect(classifyToolRisk({ name: 'read', arguments: { file_path: 'src/index.ts' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'read_image', arguments: { file_path: '/work/alpha/image.png' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'glob', arguments: { pattern: 'src/**/*.ts' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'glob', arguments: { path: 'src', pattern: '**/*.ts' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'grep', arguments: { pattern: 'TODO', path: 'src' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'write', arguments: { path: 'src/index.ts', content: 'ok' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'edit', arguments: { file_path: '/work/alpha/README.md' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'write', arguments: { path: '../outside.txt' }, workspace }))
      .toBe('ask-human')
    expect(classifyToolRisk({ name: 'edit', arguments: { path: '/work/other/file.ts' }, workspace }))
      .toBe('ask-human')
    expect(classifyToolRisk({ name: 'write', arguments: { content: 'missing target' }, workspace }))
      .toBe('ask-human')
  })

  test('lets auto mode inspect ordinary local paths but reserves credentials and malformed reads for humans', () => {
    for (const [name, arguments_] of [
      ['read', { file_path: '/private/input' }],
      ['read_image', { file_path: '../outside.png' }],
      ['glob', { path: '/opt/dsh', pattern: '**/*.json' }],
      ['grep', { pattern: 'TODO', path: '/opt/dsh' }],
    ] as const) {
      expect(classifyToolRisk({ name, arguments: arguments_, workspace }), `${name} ${JSON.stringify(arguments_)}`)
        .toBe('allow-auto')
    }
    for (const [name, arguments_] of [
      ['read', { file_path: '.codex/auth.json' }],
      ['read', { path: '.env.production' }],
      ['read', {}],
      ['read', { file_path: 'README.md', root: '/etc' }],
      ['read', { file_path: 'README.md', path: true }],
      ['read_image', { url: 'https://example.com/image.png' }],
      ['glob', { pattern: '**/.ssh/**' }],
      ['glob', { pattern: 'src/**', cwd: '/etc' }],
      ['grep', { pattern: 'token', path: '/etc' }],
      ['grep', { pattern: 'TODO', unknown_root: '/etc' }],
    ] as const) {
      expect(classifyToolRisk({ name, arguments: arguments_, workspace }), `${name} ${JSON.stringify(arguments_)}`)
        .toBe('ask-human')
    }
  })

  test('defers an explicit native sandbox upgrade instead of asking twice', () => {
    expect(classifyToolRisk({
      name: 'bash',
      arguments: {
        command: 'curl https://example.com',
        sandbox_permissions: 'danger-full-access',
        justification: 'Download the user-requested source archive.',
      },
      workspace,
    })).toBe('defer-native-approval')
    expect(classifyToolRisk({
      name: 'write',
      arguments: {
        path: '/work/outside/file.ts',
        sandbox_permissions: 'danger-full-access',
        justification: 'Edit the explicitly requested external checkout.',
      },
      workspace,
    })).toBe('defer-native-approval')
    expect(classifyToolRisk({
      name: 'bash',
      arguments: { command: 'curl https://example.com', sandbox_permissions: 'danger-full-access' },
      workspace,
    })).toBe('ask-human')
    expect(classifyToolRisk({
      name: 'pwsh',
      arguments: {
        command: 'Invoke-WebRequest https://example.com',
        sandbox_permissions: 'danger-full-access',
        justification: 'Download the user-requested source archive.',
      },
      workspace,
    })).toBe('defer-native-approval')
    expect(classifyToolRisk({
      name: 'future_external_tool',
      arguments: {
        sandbox_permissions: 'danger-full-access',
        justification: 'This unknown tool merely claims to have native approval.',
      },
      workspace,
    })).toBe('ask-human')
    expect(classifyToolRisk({
      name: 'bash',
      arguments: {
        command: 'curl https://example.com',
        sandbox_permissions: 'require_escalated',
        justification: 'Codex-style value is not a DSH escalation target.',
      },
      workspace,
    })).toBe('ask-human')
  })

  test('uses a narrow argv allowlist for simple read-only shell commands', () => {
    for (const command of [
      'pwd',
      'ls -la src',
      'git status --short',
      'git status --porcelain',
      'git branch --show-current',
      'git rev-parse --show-toplevel',
      'git rev-parse --abbrev-ref HEAD',
      'git diff --no-ext-diff --stat',
      'git diff --no-ext-diff --stat --cached',
      'git diff --no-ext-diff --name-only',
      'git log --oneline -n 10',
      'git log --oneline -n 20',
      'node --version',
      'node -v',
      'npm --version',
      'pnpm --version',
      'python3 --version',
      'go version',
      'cargo --version',
      'rustc --version',
      'tsc --version',
      'git --version',
      'uname -s',
      'uname -m',
    ]) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace }), command).toBe('allow')
    }
  })

  test('allows literal command discovery without executing the discovered command', () => {
    for (const command of ['command -v node', 'command -v curl', 'command -v python3 git pnpm', 'type -p node', 'type -P curl']) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace }), command).toBe('allow')
    }
    for (const command of ['command curl https://example.com', 'command -p rm -rf .', 'command -v node; curl https://example.com',
      'command -v $(curl https://example.com)', 'command -v node > /etc/profile', 'command -v /private/.ssh/id_rsa',
      'command -v --help', 'type -p node; rm -rf .']) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace }), command).toBe('ask-human')
    }
    expect(classifyToolRisk({ name: 'bash', arguments: { command: 'command -v node', workdir: '/etc' }, workspace })).toBe('ask-human')
  })

  test('keeps allowlisted read-only shapes distinct from their mutating or networked neighbours', () => {
    // Each of these differs from an allowlisted entry by one token. None may be
    // auto-approved: the version probes must not become package installs, and a
    // bounded log read must not become an unbounded or operand-taking one.
    for (const command of [
      'go get ./...',
      'go build',
      'npm install',
      'npm --version --registry http://internal',
      'pnpm add left-pad',
      'cargo install ripgrep',
      'git push',
      'git log',
      'git log --oneline -n 50',
      'git log --oneline -n 10 ../outside',
      'git diff --no-ext-diff --stat ../outside',
      'uname -a',
      'node --version --eval process.exit(1)',
      'node -v -e 1',
    ]) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace }), command)
        .not.toBe('allow')
    }
  })

  test('does not let bash metadata or path operands widen an allowlisted command', () => {
    for (const arguments_ of [
      { command: 'pwd', workdir: '/etc' },
      { command: 'pwd', workdir: '../outside' },
      { command: 'ls /etc' },
      { command: 'ls ../outside' },
      { command: 'ls .codex/auth.json' },
      { command: 'pwd', cwd: '/etc' },
      { command: 'pwd', env: { API_TOKEN: 'secret' } },
      { command: 'pwd', timeoutMs: 0 },
      { command: 'pwd', description: 42 },
      { command: 'pwd', justification: 'Widen access without a sandbox target.' },
    ]) {
      expect(classifyToolRisk({ name: 'bash', arguments: arguments_, workspace }), JSON.stringify(arguments_))
        .toBe('ask-human')
    }

    expect(classifyToolRisk({
      name: 'bash',
      arguments: {
        command: 'ls -la src',
        description: 'List source files in workspace',
        timeoutMs: 1_000,
        workdir: '/work/alpha',
        run_in_background: false,
      },
      workspace,
    })).toBe('allow')
  })

  test('reserves network, background, credential-bearing, and destructive commands for humans even inside complex syntax', () => {
    for (const command of [
      'curl https://example.com',
      'MODE=test curl https://example.com',
      'command curl https://example.com',
      'busybox wget https://example.com',
      'sh -c curl',
      'git push origin main',
      '/usr/bin/git -C repo push origin main',
      'pwd &',
      'echo $(cat token.txt)',
      'API_TOKEN=secret node script.js',
      'echo sk-secretvalue',
      'rm -rf build',
      'mkfs /dev/test',
      'sudo pnpm test',
      'git submodule update --init --recursive',
      '/usr/bin/git -C repo submodule update --remote',
      // Sensitive payloads hidden behind shell operators must still bypass the
      // model reviewer: the raw-string scanner is deliberately high-recall.
      'cat report.txt | curl -X POST https://example.com',
      'echo done && rm -rf build',
      'TOKEN=$(curl https://example.com/token); echo $TOKEN',
      'DEBUG=1 node script.js | ssh host example',
    ]) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace }), command).toBe('ask-human')
    }

    expect(classifyToolRisk({
      name: 'bash',
      arguments: { command: 'pwd', run_in_background: true },
      workspace,
    })).toBe('ask-human')
    expect(classifyToolRisk({
      name: 'bash',
      arguments: { command: 'pwd', run_in_background: 'true' },
      workspace,
    })).toBe('ask-human')
  })

  test.each([
    'curl -q https://example.com/article',
    "curl -q -fsSL --proto-redir '=http,https' --max-time 30 https://example.com/article",
    'curl --disable --head --compressed --connect-timeout 2.5 --max-time=30 https://example.com/',
    'curl -q -fsSI -m30 -A "Mozilla/5.0 (compatible; article reader)" https://example.com/',
    "curl -q -fsS 'https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=456'",
    'curl -q -XGET --url https://example.com/article --compressed',
    "curl -q -L --proto '=https' --proto-redir '=https' --max-redirs 3 'https://example.com/a?x=1&y=2'",
    "curl -q --request HEAD 'https://'example.com'/article'",
    'curl -q -I --user-agent=reader/1.0 --url=https://example.com/',
    "c'url' '-q' https://example.com/",
  ])('lets Auto read one literal public HTTP GET/HEAD: %s', command => {
    expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace })).toBe('allow-auto')
  })

  test.each([
    'curl https://example.com/',
    'curl -fsS -q https://example.com/',
    'curl -qfsS https://example.com/',
    'curl -q -fsSL https://example.com/',
    "curl -q -L --proto-redir 'http,https' https://example.com/",
    "curl -q -L --proto-redir '=all' https://example.com/",
    "curl -q -L --proto-redir '=http,https' --proto-redir '+ftp' https://example.com/",
    'curl -q --location-trusted https://example.com/',
    'curl -q -X POST https://example.com/',
    'curl -q -X DELETE https://example.com/',
    'curl -q -d value https://example.com/',
    'curl -q --data-binary @input.txt https://example.com/',
    'curl -q -F file=@input.txt https://example.com/',
    'curl -q -T input.txt https://example.com/',
    'curl -q -fsSoout.txt https://example.com/',
    'curl -q --output=- https://example.com/',
    'curl -q -O https://example.com/',
    'curl -q --remote-header-name https://example.com/',
    'curl -q --trace trace.txt https://example.com/',
    'curl -q --etag-save state https://example.com/',
    'curl -q --hsts state https://example.com/',
    'curl -q --alt-svc state https://example.com/',
    'curl -q -K settings https://example.com/',
    'curl -q --config=- https://example.com/',
    'curl -q -u alice https://example.com/',
    'curl -q -n https://example.com/',
    'curl -q --cert certificate.pem https://example.com/',
    'curl -q -b session https://example.com/',
    'curl -q -H "Accept: text/html" https://example.com/',
    'curl -q --referer @input.txt https://example.com/',
    'curl -q -x proxy.example.com https://example.com/',
    'curl -q --resolve example.com:443:127.0.0.1 https://example.com/',
    'curl -q --connect-to example.com:443:localhost:80 https://example.com/',
    'curl -q --unix-socket socket https://example.com/',
    'curl -q --doh-url https://resolver.example.com/ https://example.com/',
    'curl -q --user-agent @input.txt https://example.com/',
    'curl -q --insecure https://example.com/',
    'curl -q --retry 5 https://example.com/',
    'curl -q --max-time 0 https://example.com/',
    'curl -q --max-time -1 https://example.com/',
    'curl -q --max-time NaN https://example.com/',
    'curl -q --max-redirs -1 https://example.com/',
    'curl -q --next https://example.com/',
    'curl -q https://example.com/ https://other.example.com/',
    'curl -q example.com/article',
    'curl -q file:///etc/passwd',
    'curl -q ftp://example.com/article',
    'curl -q https://alice@example.com/',
    'curl -q https://alice:pw@example.com/',
    'curl -q https://example.com/?access_token=value',
    'curl -q http://localhost/',
    'curl -q http://service.local/',
    'curl -q http://service.internal/',
    'curl -q http://printer/',
    'curl -q http://127.0.0.1/',
    'curl -q http://2130706433/',
    'curl -q http://0x7f000001/',
    "curl -q 'http://[::1]/'",
    "curl -q 'https://example.com/{one,two}'",
    "curl -q 'https://example.com/[1-9]'",
    'curl -q https://example.com/?x=1',
    'curl -q https://example.com/ > output.txt',
    'curl -q https://example.com/ | cat',
    'curl -q https://example.com/ && pwd',
    'curl -q https://example.com/; pwd',
    'curl -q https://example.com/ &',
    'curl -q https://example.com/\npwd',
    "curl -q 'https://example.com/\nignored'",
    'curl -q "https://example.com/$PATH"',
    "curl -q 'https://example.com/$(pwd)'",
    'curl -q "https://example.com/`pwd`"',
    'curl -q https://example.com/\\;pwd',
    'curl -q "https://example.com/',
    'curl -q https://example.com/ # comment',
    '/tmp/curl -q https://example.com/',
    'command curl -q https://example.com/',
    'env curl -q https://example.com/',
    "c'url' -q -X POST https://example.com/",
    "'curl' -q -o output.txt https://example.com/",
    "c'ur'l -q https://example.com/ | cat",
    "cu$'rl' -q https://example.com/",
    'c\\url -q https://example.com/',
    'cu\\\nrl -q https://example.com/',
  ])('keeps unsafe or unknown curl argv under human approval: %s', command => {
    expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace })).toBe('ask-human')
  })

  test('read-only curl does not bypass bash metadata or native escalation checks', () => {
    for (const arguments_ of [
      { command: 'curl -q https://example.com/', run_in_background: true },
      { command: 'curl -q https://example.com/', workdir: '/private' },
      { command: 'curl -q https://example.com/', env: { MODE: 'test' } },
      { command: 'curl -q https://example.com/', timeoutMs: 0 },
    ]) expect(classifyToolRisk({ name: 'bash', arguments: arguments_, workspace })).toBe('ask-human')
    expect(classifyToolRisk({
      name: 'bash',
      arguments: {
        command: 'curl -q https://example.com/',
        sandbox_permissions: 'danger-full-access',
        justification: 'Read the article.',
      },
      workspace,
    })).toBe('defer-native-approval')
  })

  test.each([
    "$'cu\\x72l' -q --data plain https://example.com/",
    "$'cu\\162l' -q --data plain https://example.com/",
    'cu$(printf r)l -q --data plain https://example.com/',
    'cu`printf r`l -q --data plain https://example.com/',
    "'/usr/bin/'c'url' -q --data-binary @input.txt https://example.com/",
    "$'wget' https://example.com/",
    "$'wg\\x65t' https://example.com/",
    '$FETCH https://example.com/',
    '${FETCH} https://example.com/',
    '"$FETCH" https://example.com/',
    "printf done | $'cu\\x72l' -q --data plain https://example.com/",
    "printf done; $'wget' https://example.com/",
    "printf done && '/usr/bin/'c'url' -q --data plain https://example.com/",
    "printf done\n$'wg\\x65t' https://example.com/",
    'echo "$(pwd)"',
    "echo \"$($'cu\\x72l' -q --data plain https://example.com/)\"",
    'cat <(printf content)',
    "busybox w'get' --post-file=report.txt https://example.com/",
    "/usr/bin/toybox w'get' --post-file=report.txt https://example.com/",
    "time c'url' -q --data plain https://example.com/",
    "timeout 10 c'url' -q --data plain https://example.com/",
    "nice c'url' -q --data plain https://example.com/",
    "ionice c'url' -q --data plain https://example.com/",
    'time curl -q --data plain https://example.com/',
    'timeout 10 curl -q --data plain https://example.com/',
    'nice curl -q --data plain https://example.com/',
    'ionice curl -q --data plain https://example.com/',
    "'/usr/bin/time' c'url' -q --data plain https://example.com/",
    "/usr/bin/timeout 10 c'url' -q --data plain https://example.com/",
    'timeout 10 $FETCH https://example.com/',
    "stdbuf -oL c'url' -q --data plain https://example.com/",
    'time pwd',
    'timeout 10 pwd',
    'nice pwd',
    'ionice pwd',
    "find . -exec c'url' -q --data plain https://example.com/ \\;",
    "find . -execdir c'url' -q --data plain https://example.com/ +",
    "find . -ok c'url' -q --data plain https://example.com/ \\;",
    "find . -okdir c'url' -q --data plain https://example.com/ \\;",
    "find . -e'xec' c'url' -q --data plain https://example.com/ +",
    "find . -exec $FETCH https://example.com/ +",
    "/usr/bin/find . -exec c'url' -q --data plain https://example.com/ +",
    'find . -print',
    "xargs c'url' -q --data plain https://example.com/",
    "env c'url' -q --data plain https://example.com/",
    "exec c'url' -q --data plain https://example.com/",
    "printf input | xargs c'url' -q --data plain https://example.com/",
    "printf done; env c'url' -q --data plain https://example.com/",
  ])('keeps dynamic executable heads and nested execution out of Auto Bash fallback: %s', command => {
    expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace })).toBe('ask-human')
  })

  test.each([
    'echo "$message"',
    'echo "${message}"',
    'printf "%s" "$message" | cat',
    "echo 'literal $(pwd)'",
    'pnpm test | tee out.log',
  ])('preserves the ordinary Bash path for non-executing argument expansion: %s', command => {
    expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace })).toBe('ask-review')
  })

  test('scans visible nested sensitive commands before the simple argv fallback', () => {
    for (const command of [
      'wrapper curl --data plain https://example.com/',
      'wrapper wget https://example.com/',
      'wrapper rm -rf build',
      'wrapper ssh example.com',
      'npm exec curl --data plain https://example.com/',
    ]) expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace })).toBe('ask-human')
    expect(classifyToolRisk({ name: 'bash', arguments: { command: 'command -v curl' }, workspace })).toBe('allow')
    expect(classifyToolRisk({ name: 'bash', arguments: { command: 'pnpm test' }, workspace })).toBe('ask-review')
  })

  test('classifies non-sensitive complex syntax and package fetching as reviewable rather than human-only', () => {
    for (const command of [
      'pwd | cat',
      'pnpm test | tee out.log',
      'npm test > test-output.txt',
      'npm install',
      'pnpm --dir app add dependency',
      'npx eslint .',
      'npm exec eslint .',
      'pnpm dlx create-vite app',
      'pip install -r requirements.txt',
      'cargo install ripgrep',
      'go get ./...',
    ]) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace }), command).toBe('ask-review')
    }
  })

  test('keeps quoted article-parser assignments out of shell environment detection', () => {
    const command = `cd /work/alpha && firecrawl scrape "https://example.com/article" --json > .tmp/article.json 2>/dev/null; python3 -c "
import json
d=json.load(open('.tmp/article.json'))
if isinstance(d,dict):
    md=d.get('data',d)
    if isinstance(md,dict):
        print('TITLE:',md.get('metadata',{}).get('title'))
        print('URL:',md.get('metadata',{}).get('sourceURL'))
" 2>&1 | head -20; wc -c .tmp/article.json`
    expect(classifyToolRisk({ name: 'bash', arguments: { command, timeoutMs: 180_000 }, workspace }))
      .toBe('ask-review')
    for (const command of ['MODE=test node script.js', 'echo ok; MODE=test node script.js',
      'echo ok && MODE=test node script.js']) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace })).toBe('ask-human')
    }
  })

  test('lets auto mode load one named skill while runtime skill invocations retain their dedicated guard', () => {
    expect(classifyToolRisk({ name: 'skill', arguments: { name: 'firecrawl-scrape' }, workspace })).toBe('allow-auto')
    expect(classifyToolRisk({ name: 'skill', arguments: { name: '../escape' }, workspace })).toBe('ask-human')
    expect(classifyToolRisk({ name: 'skill', arguments: { name: 'review-pr', extra: true }, workspace })).toBe('ask-human')
    expect(classifyToolRisk({ name: 'skill_run', arguments: { name: 'review-pr' }, workspace })).toBe('ask-review')
    expect(classifyToolRisk({ name: 'skill_status', arguments: { invocation_id: 'run-1' }, workspace })).toBe('ask-review')
    for (const command of ['pnpm test', 'node script.js', 'git status --ignored=matching']) {
      expect(classifyToolRisk({ name: 'bash', arguments: { command }, workspace }), command).toBe('ask-review')
    }
  })

  test('reserves PowerShell commands for humans unless the native tool owns an escalation', () => {
    for (const command of [
      'Get-Location',
      'Invoke-WebRequest https://example.com',
      'Remove-Item -Recurse build',
      'Start-Process powershell',
    ]) {
      expect(classifyToolRisk({ name: 'pwsh', arguments: { command }, workspace }), command)
        .toBe('ask-human')
    }
  })

  test('allows built-in read-only network retrieval without a permission prompt', () => {
    expect(classifyToolRisk({ name: 'web_search', arguments: { query: 'current release' }, workspace }))
      .toBe('allow')
    expect(classifyToolRisk({ name: 'web_fetch', arguments: { url: 'https://example.com/article' }, workspace }))
      .toBe('allow')
  })

  test('allows the dedicated user-question bridge so required clarification can reach the user', () => {
    expect(classifyToolRisk({ name: 'ask_user_question', arguments: { questions: [] }, workspace }))
      .toBe('allow')
  })

  test('asks for unknown non-built-in tools', () => {
    expect(classifyToolRisk({ name: 'future_external_tool', arguments: {}, workspace })).toBe('ask-review')
  })

  test('reserves the bash-equivalent run_code transport for human approval', () => {
    expect(classifyToolRisk({ name: 'run_code', arguments: {}, workspace })).toBe('ask-human')
  })
})
