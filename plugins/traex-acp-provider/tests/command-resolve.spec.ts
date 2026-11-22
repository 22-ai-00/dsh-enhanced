import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { resolveAcpCommand } from '../src/command-resolve.ts'

describe('resolveAcpCommand', () => {
  it('preserves explicit paths verbatim without fallback', () => {
    const checked: string[] = []
    const isExecutable = (candidate: string): boolean => {
      checked.push(candidate)
      return true
    }

    expect(resolveAcpCommand('/custom/bin/agy', 'agy', { platform: 'darwin', isExecutable })).toBe('/custom/bin/agy')
    expect(resolveAcpCommand('./bin/traex', 'traex', { platform: 'linux', isExecutable })).toBe('./bin/traex')
    expect(resolveAcpCommand('C:\\Tools\\agy.exe', 'agy', { platform: 'win32', isExecutable })).toBe('C:\\Tools\\agy.exe')
    expect(resolveAcpCommand('D:traex.exe', 'traex', { platform: 'win32', isExecutable })).toBe('D:traex.exe')
    expect(checked).toEqual([])
  })

  it('prefers PATH over standard user and OS directories', () => {
    const found = new Set(['/custom/path/agy', '/Users/alice/.local/bin/agy', '/opt/homebrew/bin/agy'])
    const resolved = resolveAcpCommand('agy', 'agy', {
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: { PATH: '/custom/path:/usr/bin:/bin' },
      isExecutable: candidate => found.has(candidate),
    })
    expect(resolved).toBe('/custom/path/agy')
  })

  it('discovers agy and traex in standard POSIX user/OS install directories under minimal PATH', () => {
    const checkedAgy: string[] = []
    const agyInLocalBin = resolveAcpCommand('agy', 'agy', {
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      isExecutable: candidate => {
        checkedAgy.push(candidate)
        return candidate === '/Users/alice/.local/bin/agy'
      },
    })
    expect(agyInLocalBin).toBe('/Users/alice/.local/bin/agy')
    expect(checkedAgy).toEqual([
      '/usr/bin/agy',
      '/bin/agy',
      '/usr/sbin/agy',
      '/sbin/agy',
      '/Users/alice/.local/bin/agy',
    ])

    const agyInAntigravityBin = resolveAcpCommand('agy', 'agy', {
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: candidate => candidate === '/Users/alice/.antigravity/antigravity/bin/agy',
    })
    expect(agyInAntigravityBin).toBe('/Users/alice/.antigravity/antigravity/bin/agy')

    const agyInPnpm = resolveAcpCommand('agy', 'agy', {
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: candidate => candidate === '/Users/alice/Library/pnpm/agy',
    })
    expect(agyInPnpm).toBe('/Users/alice/Library/pnpm/agy')

    const checkedTraex: string[] = []
    const traexInHomebrew = resolveAcpCommand('traex', 'traex', {
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: candidate => {
        checkedTraex.push(candidate)
        return candidate === '/opt/homebrew/bin/traex'
      },
    })
    expect(traexInHomebrew).toBe('/opt/homebrew/bin/traex')
    expect(checkedTraex).not.toContain('/Users/alice/.antigravity/antigravity/bin/traex')
    expect(checkedTraex).toContain('/Users/alice/.local/bin/traex')
    expect(checkedTraex).toContain('/Users/alice/.npm-global/bin/traex')
    expect(checkedTraex).toContain('/Users/alice/Library/pnpm/traex')
  })

  it('discovers Windows executables in APPDATA npm and LOCALAPPDATA Programs directories', () => {
    const agyCmd = resolveAcpCommand('agy', 'agy', {
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      env: {
        PATH: 'C:\\Windows\\System32',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      },
      isExecutable: candidate => candidate === 'C:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe',
    })
    expect(agyCmd).toBe('C:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity\\bin\\agy.exe')

    const traexCmd = resolveAcpCommand('traex', 'traex', {
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      env: {
        PATH: 'C:\\Windows\\System32',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      },
      isExecutable: candidate => candidate === 'C:\\Users\\alice\\AppData\\Local\\Programs\\Trae\\bin\\traex.cmd',
    })
    expect(traexCmd).toBe('C:\\Users\\alice\\AppData\\Local\\Programs\\Trae\\bin\\traex.cmd')

    const npmGlobal = resolveAcpCommand('traex', 'traex', {
      platform: 'win32',
      homeDir: 'C:\\Users\\alice',
      env: {
        PATH: 'C:\\Windows\\System32',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      },
      isExecutable: candidate => candidate === 'C:\\Users\\alice\\AppData\\Roaming\\npm\\traex.cmd',
    })
    expect(npmGlobal).toBe('C:\\Users\\alice\\AppData\\Roaming\\npm\\traex.cmd')
  })

  it('passes bare names through unchanged when not found anywhere so ENOENT -> CLI_NOT_FOUND holds', () => {
    expect(resolveAcpCommand('agy', 'agy', {
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: { PATH: '/usr/bin:/bin' },
      isExecutable: () => false,
    })).toBe('agy')
  })

  it('checks real filesystem executable bits and follows symlinks on POSIX', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'traex-cmd-resolve-'))
    try {
      const binDir = join(root, '.local', 'bin')
      const realDir = join(root, 'real')
      mkdirSync(binDir, { recursive: true })
      mkdirSync(realDir, { recursive: true })

      const nonExec = join(binDir, 'nonexec-agy')
      writeFileSync(nonExec, '#!/bin/sh\n', 'utf8')
      chmodSync(nonExec, 0o644)
      expect(resolveAcpCommand('nonexec-agy', 'agy', {
        homeDir: root,
        env: { PATH: '/usr/bin:/bin' },
      })).toBe('nonexec-agy')

      const target = join(realDir, 'agy-real')
      writeFileSync(target, '#!/bin/sh\n', 'utf8')
      chmodSync(target, 0o755)
      const linked = join(binDir, 'agy')
      symlinkSync(target, linked)

      expect(resolveAcpCommand('agy', 'agy', {
        homeDir: root,
        env: { PATH: '/usr/bin:/bin' },
      })).toBe(linked)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
