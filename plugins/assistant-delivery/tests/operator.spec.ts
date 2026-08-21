import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import * as delivery from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('trusted local pairing control plane', () => {
  test('pairs one exact principal without returning a pairing secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-operator-'))
    roots.push(root)
    const pairPrincipalLocally = (delivery as Record<string, unknown>).pairPrincipalLocally

    expect(pairPrincipalLocally).toBeTypeOf('function')
    const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'ou_owner' }
    const result = (pairPrincipalLocally as (input: unknown) => unknown)({
      databasePath: join(root, 'delivery.sqlite'),
      principal,
    })

    expect(result).toMatchObject({ principal, role: 'owner', status: 'active' })
    expect(JSON.stringify(result)).not.toMatch(/code|challenge|secret/i)
  })
})
