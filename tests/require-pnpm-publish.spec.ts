import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const guardScript = join(repoRoot, 'scripts', 'require-pnpm-publish.mjs')

function runGuard(environment: Record<string, string>) {
  return spawnSync(process.execPath, [guardScript], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      ...environment,
    },
  })
}

describe('publish package-manager guard', () => {
  test('accepts pnpm publish', () => {
    const result = runGuard({
      npm_config_user_agent: 'pnpm/11.7.0 npm/? node/v24.0.0 linux x64',
      npm_execpath: '/opt/pnpm/bin/pnpm.cjs',
    })

    expect(result.status, result.stderr).toBe(0)
  })

  test('rejects npm publish before catalog specifiers can reach the registry', () => {
    const result = runGuard({
      npm_config_user_agent: 'npm/11.12.1 node/v24.7.0 linux x64 workspaces/false',
      npm_execpath: '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing to publish a workspace package with npm')
    expect(result.stderr).toContain('pnpm release:publish')
  })
})
