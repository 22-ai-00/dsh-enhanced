import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test.each(['missing', 'old', 'malformed', 'capable', 'capable-interactive'] as const)('Mac recovery script checks CLI capability (%s) before delegating purge', async (cli) => {
  const capable = cli.startsWith('capable')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mac-purge-fallback-')))
  try {
    const home = join(root, 'home'), bin = join(root, 'bin with spaces'), dshHome = join(home, '.dsh')
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    await mkdir(bin)
    await symlink(process.execPath, join(bin, 'node'))
    const plist = join(home, 'Library', 'LaunchAgents', 'ai.deepseek.dsh.profile.web.plist')
    await writeFile(plist, 'foreign service must survive')
    await writeFile(join(dshHome, 'data'), 'owner data must survive')
    for (const [name, body] of Object.entries({ uname: 'printf "Darwin\\n"', npm: 'exit 1',
      launchctl: 'echo unexpected-launchctl >&2; exit 99', rm: 'echo unexpected-rm >&2; exit 99' })) {
      await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`)
      await chmod(join(bin, name), 0o755)
    }
    if (cli !== 'missing') {
      const capability = cli === 'old' ? 'exit 2' : `printf '%s\\n' '${capable ? '{"capabilities":["macos-launchd-ownership-v1"]}' : 'not JSON'}'; exit 0`
      await writeFile(join(bin, 'dsh-rsi'), `#!/bin/bash\nif [[ "$1" == --capabilities ]]; then ${capability}; fi\nprintf 'delegated:%s\\n' "$@"\n`)
      await chmod(join(bin, 'dsh-rsi'), 0o755)
    }
    const result = spawnSync('/bin/bash', [join(process.cwd(), 'scripts/install/purge.sh'),
      ...(cli === 'capable-interactive' ? [] : ['--yes']), '--no-backup'], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, DSH_HOME: dshHome },
    })
    expect(result.status).toBe(capable ? 0 : 1)
    if (capable) {
      expect(result.stdout).toContain('delegated:purge')
      expect(result.stdout).toContain(`delegated:${dshHome}`)
      if (cli === 'capable-interactive') expect(result.stdout).not.toContain('delegated:--yes')
      else expect(result.stdout).toContain('delegated:--yes')
    } else {
      expect(result.stderr).toContain('未操作服务或删除数据')
      expect(result.stdout).not.toContain('delegated:')
    }
    expect(result.stderr).not.toContain('unexpected-')
    expect(await readFile(plist, 'utf8')).toBe('foreign service must survive')
    expect(await readFile(join(dshHome, 'data'), 'utf8')).toBe('owner data must survive')
  } finally { await rm(root, { recursive: true, force: true }) }
})
