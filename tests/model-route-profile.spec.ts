import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'
import { nativeInstallerHost } from './native-installer-host-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-model-route-profile-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const composed = join(root, 'composed.yml')
  const captured = join(root, 'captured.yml')
  await mkdir(bin)
  await writeFile(composed, source)
  const executable = await nativeInstallerHost(root, `#!/bin/bash
set -euo pipefail
if [[ "\${1:-}" == --version ]]; then echo 0.2.0-rc.2; exit; fi
if [[ "\${1:-}" == --profile && "\${2:-}" == assistant && "\${3:-}" == --dump-config ]]; then cat "$MODEL_COMPOSED"; exit; fi
if [[ "\${1:-}" == --profile && "\${2:-}" == headless && "\${3:-}" == --patch ]]; then
  if [[ "\${5:-}" == --dump-config ]]; then
    if [[ "\${MODEL_WRONG_HEADLESS:-}" == 1 ]]; then
      printf '%s\\n' '- id: agent-default-model' '  name: unrelated-plugin' '  config: {provider: wrong, model: wrong}'
    else cat "$4"; fi
    exit
  fi
  cp "$4" "$MODEL_CAPTURED"
  echo DSH_ROUTE_READY
  exit
fi
exit 42
`)
  await symlink(executable, join(bin, 'dsh'))
  return { root, captured, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
    MODEL_COMPOSED: composed, MODEL_CAPTURED: captured } }
}

test('DSH 0.2 verifies the target profile model without booting its background plugins or consuming global legacy settings', async () => {
  const { root, captured, env } = await fixture(`- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: target-provider
    model: target-model
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      target-provider:
        baseURL: http://127.0.0.1:1/v1
- id: unrelated-background-plugin
  name: '@dsh-enhanced/assistant-automations'
`)
  const legacy = 'agent-default-model:\n  provider: unrelated-old-provider\n'
  await writeFile(join(root, 'settings.yaml'), legacy)
  const pending = spawnSync('/bin/bash', ['-c', 'source scripts/install/common.sh; dsh_enhanced_effective_default_provider "$1" assistant; dsh_enhanced_verify_model_route verify 0 assistant "$1"', 'test', root], { env, encoding: 'utf8' })
  expect(pending.status).not.toBe(0)
  expect(pending.stdout).toContain('target-provider')
  expect(pending.stderr).toContain('待迁移的 settings.yaml')
  expect(await readFile(join(root, 'settings.yaml'), 'utf8')).toBe(legacy)
  await expect(readFile(captured)).rejects.toMatchObject({ code: 'ENOENT' })
  await rm(join(root, 'settings.yaml'))
  const result = spawnSync('/bin/bash', ['-c', 'source scripts/install/common.sh; dsh_enhanced_effective_default_provider "$1" assistant; dsh_enhanced_verify_model_route verify 0 assistant "$1"', 'test', root], { env, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('target-provider')
  const rows = parse(await readFile(captured, 'utf8'))
  expect(rows.map((row: { id: string }) => row.id)).toEqual(['agent-default-model', 'llm-pi-ai'])
  expect(rows[0].config).toEqual({ provider: 'target-provider', model: 'target-model' })
})

test.each(['[]', '- id: agent-default-model\n  config: {}\n- id: agent-default-model\n  config: {}\n',
  '- id: agent-default-model\n  disabled: !!js false\n  config: {provider: target, model: target}\n',
])('DSH 0.2 refuses absent, ambiguous or dynamically disabled target models without dispatching (%s)', async source => {
  const { root, captured, env } = await fixture(source)
  const result = spawnSync('/bin/bash', ['-c', 'source scripts/install/common.sh; dsh_enhanced_verify_model_route verify 0 assistant "$1" custom', 'test', root], { env, encoding: 'utf8' })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('未向其他 profile 的默认模型发送请求')
  await expect(readFile(captured)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('DSH 0.2 refuses an overlay that the headless profile did not apply before dispatch', async () => {
  const { root, captured, env } = await fixture('- id: agent-default-model\n  name: custom-default\n  config: {provider: requested, model: requested}\n')
  const result = spawnSync('/bin/bash', ['-c', 'source scripts/install/common.sh; dsh_enhanced_verify_model_route verify 0 assistant "$1" requested', 'test', root], {
    env: { ...env, MODEL_WRONG_HEADLESS: '1' }, encoding: 'utf8',
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('headless verification route differs')
  await expect(readFile(captured)).rejects.toMatchObject({ code: 'ENOENT' })
})
