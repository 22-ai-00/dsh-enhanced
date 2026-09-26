import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runDoctor, formatFindings } from '../src/diagnose.ts'

describe('runDoctor', () => {
  let root: string
  let dshHome: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rsi-cli-doctor-'))
    dshHome = join(root, '.dsh')
    await mkdir(join(dshHome, 'logs'), { recursive: true })
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  test('识别旧版 assistant-policy event-support oracle 崩溃模式', async () => {
    await writeFile(
      join(dshHome, 'logs', 'web-host.error.log'),
      'Error: event-support oracle refusing unproven registration: '
        + 'plugin does not expose the supported PersistenceCoordinator contract\n',
    )
    const findings = await runDoctor(dshHome)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.profile).toBe('web')
    expect(findings[0]!.advice).toMatch(/0\.1\.32/)
    expect(formatFindings(findings)).toContain('web')
  })

  test('无日志/空日志时无发现', async () => {
    expect(await runDoctor(dshHome)).toEqual([])
    await writeFile(join(dshHome, 'logs', 'x-host.error.log'), '')
    expect(await runDoctor(dshHome)).toEqual([])
    expect(formatFindings([])).toMatch(/未发现已知崩溃模式/)
  })
})
