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

  test('reserves external, credential-sensitive, and unproven read targets for humans', () => {
    for (const [name, arguments_] of [
      ['read', { file_path: '/private/input' }],
      ['read', { file_path: '.codex/auth.json' }],
      ['read', { path: '.env.production' }],
      ['read', {}],
      ['read', { file_path: 'README.md', root: '/etc' }],
      ['read', { file_path: 'README.md', path: true }],
      ['read_image', { file_path: '../outside.png' }],
      ['read_image', { url: 'https://example.com/image.png' }],
      ['glob', { pattern: '/etc/**' }],
      ['glob', { pattern: '**/.ssh/**' }],
      ['glob', { pattern: 'src/**', cwd: '/etc' }],
      ['grep', { pattern: 'token', path: '/etc' }],
      ['grep', { pattern: 'TODO', include: '../outside/**' }],
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

  test('reserves network, background, complex, credential-bearing, and destructive commands for humans', () => {
    for (const command of [
      'curl https://example.com',
      'MODE=test curl https://example.com',
      'command curl https://example.com',
      'busybox wget https://example.com',
      'sh -c curl',
      'git push origin main',
      '/usr/bin/git -C repo push origin main',
      'pwd &',
      'pwd | cat',
      'echo $(cat token.txt)',
      'API_TOKEN=secret node script.js',
      'echo sk-secretvalue',
      'rm -rf build',
      'mkfs /dev/test',
      'sudo pnpm test',
      'pnpm --dir app add dependency',
      'npx eslint .',
      'npm exec eslint .',
      'pnpm dlx create-vite app',
      'git submodule update --init --recursive',
      '/usr/bin/git -C repo submodule update --remote',
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

  test('lets only unclassified potentially low-risk actions reach automatic review', () => {
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

  test('reserves built-in network tools for humans without consulting the model reviewer', () => {
    for (const name of ['web_search', 'web_fetch']) {
      expect(classifyToolRisk({ name, arguments: { query: 'current release' }, workspace }), name)
        .toBe('ask-human')
    }
  })

  test('asks for unknown non-built-in tools', () => {
    expect(classifyToolRisk({ name: 'future_external_tool', arguments: {}, workspace })).toBe('ask-review')
  })

  test('reserves the bash-equivalent run_code transport for human approval', () => {
    expect(classifyToolRisk({ name: 'run_code', arguments: {}, workspace })).toBe('ask-human')
  })
})
