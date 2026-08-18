#!/usr/bin/env node

const userAgent = process.env.npm_config_user_agent ?? ''
const execPath = process.env.npm_execpath ?? ''
const usesPnpm = userAgent.startsWith('pnpm/') || /(?:^|[\\/])pnpm(?:\.c?js)?$/i.test(execPath)

if (!usesPnpm) {
  console.error([
    'Refusing to publish a workspace package with npm.',
    'npm does not resolve pnpm catalog: dependency specifiers before upload.',
    'Run `pnpm release:publish` from the repository root instead.',
  ].join('\n'))
  process.exit(1)
}
