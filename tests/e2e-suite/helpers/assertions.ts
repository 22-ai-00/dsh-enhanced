import { createHash } from 'node:crypto'
import { expect } from 'vitest'

export const isLinux = process.platform === 'linux'
export const isMacOS = process.platform === 'darwin'
export const isWindows = process.platform === 'win32'

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function getExport<T>(mod: Record<string, unknown>, exportName: string): T {
  expect(mod).toBeTypeOf('object')
  const value = mod[exportName]
  expect(value, `Expected module export "${exportName}" to be defined`).toBeDefined()
  return value as T
}

export function getExportFn<T extends (...args: never[]) => unknown>(
  mod: Record<string, unknown>,
  exportName: string,
): T {
  const value = getExport<unknown>(mod, exportName)
  expect(typeof value, `Expected exported "${exportName}" to be a function`).toBe('function')
  return value as T
}

export function getMethod<T extends (...args: never[]) => unknown>(
  target: unknown,
  methodName: string,
): T {
  expect(target, `Expected target object for method "${methodName}"`).toBeTruthy()
  const record = target as Record<string, unknown>
  const fn = record[methodName]
  expect(typeof fn, `Expected method "${methodName}" on service/runtime`).toBe('function')
  return fn.bind(target) as T
}

export function expectNoSecretLeak(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length === 0) continue
    expect(text).not.toContain(secret)
  }
}
