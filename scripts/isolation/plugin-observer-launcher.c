/* Fixed Linux x86-64 observer boundary. Built into the verifier image only. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/ioctl.h>
#include <unistd.h>

#ifdef DSH_PARENT_PRELOAD
__attribute__((constructor)) static void protect_observer(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) _exit(125);
}
#elif defined(DSH_CHILD_PRELOAD)
/* The first filter permits exactly the Node exec. This constructor runs in
 * the dynamic loader before any Node or candidate JavaScript and closes that
 * one-time execveat allowance for the lifetime of the process. */
__attribute__((constructor)) static void close_exec_window(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execve, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execveat, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) _exit(125);
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) _exit(125);
}
#elif defined(DSH_PARENT_PRELOAD_TEST)
int main(void) { return prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) == 0 ? 0 : 1; }
#elif defined(DSH_CHILD_PRELOAD_TEST)
int main(void) {
  int fd = open("/bin/false", O_PATH | O_CLOEXEC);
  if (fd < 0) return 2;
  char *args[] = { "false", NULL }, *environment[] = { NULL };
  errno = 0;
  if (syscall(SYS_execveat, fd, "", args, environment, AT_EMPTY_PATH) != -1 || errno != EPERM) return 3;
  errno = 0;
  if (syscall(SYS_execve, "/bin/false", args, environment) != -1 || errno != EPERM) return 4;
  return 0;
}
#else
#define BLOCK(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#define BLOCK_ENOSYS(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS)

static int restrict_syscalls(int node_fd) {
  const uint32_t writing = O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND | (O_TMPFILE & ~O_DIRECTORY);
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0x40000000U),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* The pinned Node ABI needs no syscall added after Linux 6.1. Unknown
     * future numbers must not silently gain new filesystem write authority. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 451, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BLOCK(__NR_ptrace), BLOCK(__NR_process_vm_readv), BLOCK(__NR_process_vm_writev),
    BLOCK(__NR_kcmp), BLOCK(__NR_kill), BLOCK(__NR_tkill), BLOCK(__NR_tgkill),
    BLOCK(__NR_rt_sigqueueinfo), BLOCK(__NR_rt_tgsigqueueinfo),
    BLOCK(__NR_pidfd_open), BLOCK(__NR_pidfd_getfd), BLOCK(__NR_pidfd_send_signal),
    BLOCK(__NR_prlimit64),
    BLOCK(__NR_socket), BLOCK(__NR_socketpair), BLOCK(__NR_connect),
    BLOCK(__NR_bind), BLOCK(__NR_listen), BLOCK(__NR_accept), BLOCK(__NR_accept4),
    BLOCK(__NR_sendto), BLOCK(__NR_sendmsg), BLOCK(__NR_sendmmsg),
    BLOCK(__NR_recvfrom), BLOCK(__NR_recvmsg), BLOCK(__NR_recvmmsg),
    BLOCK(__NR_io_uring_setup), BLOCK(__NR_io_uring_enter), BLOCK(__NR_io_uring_register),
    BLOCK(__NR_bpf), BLOCK(__NR_perf_event_open), BLOCK(__NR_userfaultfd),
    BLOCK(__NR_sched_setaffinity), BLOCK(__NR_sched_setscheduler),
    BLOCK(__NR_sched_setparam), BLOCK(__NR_sched_setattr), BLOCK(__NR_setpriority),
    BLOCK(__NR_ioprio_set), BLOCK(__NR_process_madvise),
    BLOCK(__NR_fork), BLOCK(__NR_vfork), BLOCK_ENOSYS(__NR_clone3),
    BLOCK(__NR_execve),
    BLOCK(__NR_openat2), BLOCK(__NR_creat),
    BLOCK(__NR_truncate), BLOCK(__NR_ftruncate), BLOCK(__NR_fallocate),
    BLOCK(__NR_chmod), BLOCK(__NR_fchmod), BLOCK(__NR_fchmodat),
    BLOCK(__NR_chown), BLOCK(__NR_fchown), BLOCK(__NR_lchown), BLOCK(__NR_fchownat),
    BLOCK(__NR_link), BLOCK(__NR_linkat), BLOCK(__NR_symlink), BLOCK(__NR_symlinkat),
    BLOCK(__NR_unlink), BLOCK(__NR_unlinkat), BLOCK(__NR_rename), BLOCK(__NR_renameat),
    BLOCK(__NR_renameat2), BLOCK(__NR_mkdir), BLOCK(__NR_mkdirat), BLOCK(__NR_rmdir),
    BLOCK(__NR_mknod), BLOCK(__NR_mknodat), BLOCK(__NR_utime), BLOCK(__NR_utimes),
    BLOCK(__NR_futimesat), BLOCK(__NR_utimensat), BLOCK(__NR_mount), BLOCK(__NR_umount2),
    BLOCK(__NR_pivot_root), BLOCK(__NR_setns), BLOCK(__NR_unshare),
    BLOCK(__NR_open_tree), BLOCK(__NR_move_mount), BLOCK(__NR_fsopen),
    BLOCK(__NR_fsconfig), BLOCK(__NR_fsmount), BLOCK(__NR_fspick),
    BLOCK(__NR_setxattr), BLOCK(__NR_lsetxattr), BLOCK(__NR_fsetxattr),
    BLOCK(__NR_removexattr), BLOCK(__NR_lremovexattr), BLOCK(__NR_fremovexattr),
    /* libuv must set inherited pipe descriptors nonblocking. No other ioctl
     * command, including terminal signalling controls, is available. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, FIONBIO, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fcntl, 0, 11),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BLOCK(F_SETOWN), BLOCK(F_SETSIG), BLOCK(F_SETOWN_EX),
    BLOCK(F_SETLEASE), BLOCK(F_NOTIFY),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, CLONE_THREAD),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CLONE_THREAD, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_open, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, writing),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, writing),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execveat, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t) node_fd, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AT_EMPTY_PATH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter) / sizeof(filter[0]), .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 125;
  int node_fd = open("/usr/local/bin/node", O_PATH | O_CLOEXEC);
  if (node_fd < 0) return 125;
  char *args[] = { "node", "--permission", "--disable-sigusr1",
    "--allow-fs-read=/opt/dsh-plugin-verifier/candidate.mjs",
    "--allow-fs-read=/opt/dsh-plugin-verifier/node_modules",
    "--allow-fs-read=/opt/dsh-plugin-verifier/plugins/assistant-verifier/node_modules",
    "--allow-fs-read=/workspace/plugin/package/lib",
    "--allow-fs-read=/workspace/plugin/package/package.json",
    "--allow-fs-read=/workspace/plugin/package/node_modules",
    "/opt/dsh-plugin-verifier/candidate.mjs", NULL };
  char *env[] = { "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "NODE_ENV=production",
    "LD_PRELOAD=/opt/dsh-plugin-verifier/child-protect.so", NULL };
  if (restrict_syscalls(node_fd) != 0) return 125;
  syscall(SYS_execveat, node_fd, "", args, env, AT_EMPTY_PATH);
  return 125;
}
#endif
