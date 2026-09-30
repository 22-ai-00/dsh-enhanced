import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const nativeSource = fileURLToPath(new URL('../../../scripts/isolation/plugin-observer-launcher.c', import.meta.url))

// Probe the actual kernel filter with raw syscalls, without Node permissions.
// The operations use this private temporary tree and harmless read/zero-signal
// requests; no candidate source is run on the Host.
describe.runIf(process.platform === 'linux' && process.arch === 'x64' && existsSync('/usr/bin/cc'))('native observer boundary', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'plugin-observer-native-')); roots.push(root)
    return root
  }
  test('rejects cross-process and filesystem mutations at the syscall boundary', async () => {
    const root = await fixture(), source = join(root, 'probe.c'), executable = join(root, 'probe')
    await writeFile(source, `
#define main dsh_fixed_launcher_main
#include ${JSON.stringify(nativeSource)}
#undef main
#include <sys/socket.h>
#include <sys/resource.h>
#include <sys/wait.h>
int main(int argc, char **argv) {
  if (argc != 2 || restrict_syscalls(-1) != 0) return 2;
  int passed = 0;
#define DENIED(call) do { errno = 0; long result = (call); if (result != -1 || errno != EPERM) return 3; passed++; } while (0)
  if (syscall(__NR_getpid) != getpid()) return 4;
  DENIED(syscall(__NR_kill, getppid(), 0));
  DENIED(syscall(__NR_ptrace, 0, getppid(), 0, 0));
  DENIED(syscall(__NR_process_vm_readv, getppid(), 0, 0, 0, 0, 0));
  struct rlimit limits;
  DENIED(syscall(__NR_prlimit64, getppid(), RLIMIT_NOFILE, NULL, &limits));
  DENIED(syscall(__NR_fcntl, 1, F_SETOWN, getppid()));
  DENIED(syscall(__NR_ioctl, -1, FIONREAD, NULL));
  DENIED(syscall(__NR_pidfd_open, getppid(), 0));
  DENIED(syscall(__NR_socket, AF_UNIX, SOCK_STREAM, 0));
  DENIED(syscall(__NR_openat, AT_FDCWD, argv[1], O_WRONLY | O_CREAT, 0600));
  DENIED(syscall(__NR_chmod, argv[1], 0777));
  DENIED(syscall(452, AT_FDCWD, argv[1], 0777, 0));
  DENIED(syscall(__NR_unlink, argv[1]));
  DENIED(syscall(__NR_mkdir, argv[1], 0700));
  DENIED(syscall(__NR_fork));
  DENIED(syscall(__NR_io_uring_setup, 1, NULL));
  DENIED(syscall(__NR_openat2, AT_FDCWD, argv[1], NULL, 0));
  int fd = open("/etc/hostname", O_RDONLY); if (fd < 0) return 5; close(fd);
  int descriptors[2], nonblocking = 1;
  if (pipe(descriptors) != 0 || ioctl(descriptors[0], FIONBIO, &nonblocking) != 0) return 6;
  close(descriptors[0]); close(descriptors[1]);
  printf("{\\"denied\\":%d,\\"readAllowed\\":true}\\n", passed);
  return 0;
}
`)
    execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable], { timeout: 30_000 })
    const output = execFileSync(executable, [join(root, 'forged')], { encoding: 'utf8', timeout: 5000 })
    expect(JSON.parse(output)).toEqual({ denied: 16, readAllowed: true })
    expect(existsSync(join(root, 'forged'))).toBe(false)
  })

  test('the parent preload prevents a same-UID process from reopening its stdout through procfs', async () => {
    const root = await fixture(), preload = join(root, 'protect.so'), script = join(root, 'parent.mjs')
    execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-DDSH_PARENT_PRELOAD', '-shared', '-fPIC', nativeSource, '-o', preload], { timeout: 30_000 })
    await writeFile(script, `import { spawnSync } from 'node:child_process'
const value = spawnSync(process.execPath, ['-e', ${JSON.stringify("const fs=require('node:fs');try{fs.openSync('/proc/'+process.ppid+'/fd/1','r');process.exit(3)}catch(e){if(e.code!=='EACCES'&&e.code!=='EPERM')process.exit(4);process.stdout.write('denied')}")}],
 { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
if(value.status!==0)process.exit(5)
process.stdout.write(value.stdout)
`)
    const output = execFileSync(process.execPath, ['--disable-sigusr1', script], { encoding: 'utf8', timeout: 10_000,
      env: { PATH: '/usr/bin:/bin', LD_PRELOAD: resolve(preload) } })
    expect(output).toBe('denied')
  })

  test.runIf(existsSync('/usr/bin/setpriv'))('the child preload rejects re-execution after a descriptor is reused', async () => {
    const root = await fixture(), preload = join(root, 'child-lock.so'), source = join(root, 'reexec.c'), executable = join(root, 'reexec')
    execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', '-DDSH_CHILD_PRELOAD', '-shared', '-fPIC', nativeSource, '-o', preload], { timeout: 30_000 })
    await writeFile(source, `
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(void) {
  int fd = open("/usr/bin/true", O_PATH); if (fd < 0) return 2;
  if (dup2(fd, 4) != 4) return 3;
  char *args[] = { "true", NULL }; char *env[] = { NULL };
  errno = 0;
  long value = syscall(SYS_execveat, 4, "", args, env, AT_EMPTY_PATH);
  if (value != -1 || errno != EPERM) return 4;
  errno = 0;
  value = syscall(SYS_execve, "/usr/bin/true", args, env);
  if (value != -1 || errno != EPERM) return 5;
  puts("denied"); return 0;
}
`)
    execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable], { timeout: 30_000 })
    expect(execFileSync('/usr/bin/setpriv', ['--no-new-privs', '/usr/bin/env', `LD_PRELOAD=${preload}`, executable],
      { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } })).toBe('denied\n')
  })
})
