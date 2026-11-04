import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LARK_CONNECTIONS, LARK_ERROR_CODES } from '../src/typert.ts'

// owner-console does not depend on lark-channel, so its health enums are copied.
// This reads the sibling source in the monorepo so a new state or error code
// there fails here instead of silently showing as 「状态未知」 in the panel.
const source = readFileSync(new URL('../../lark-channel/src/types.ts', import.meta.url), 'utf8')

function union(name: string): string[] {
  const match = new RegExp(`export type ${name} =([^;]*?)\\n\\n`, 'u').exec(source)
  if (match === null) throw new Error(`lark-channel no longer declares ${name}`)
  return [...match[1]!.matchAll(/'([^']+)'/gu)].map(([, value]) => value!).sort()
}

describe('lark-channel health contract', () => {
  it('mirrors every connection state lark-channel can report', () => {
    expect(LARK_CONNECTIONS.filter(value => value !== 'absent' && value !== 'unknown').sort())
      .toEqual(union('LarkConnectionState'))
  })

  it('mirrors every transport error code lark-channel can report', () => {
    expect([...LARK_ERROR_CODES].sort()).toEqual(union('LarkTransportErrorCode'))
  })
})
