"""Fixed repository keeper launcher. No candidate command executes here."""
import ctypes
import hashlib
import json
import os
import select
import signal
import stat
import subprocess
import sys
import time


def main():
    if len(sys.argv) != 5:
        raise RuntimeError("invalid user namespace launcher arguments")
    mapping = json.loads(sys.argv[1])
    deadline = int(sys.argv[2])
    node, worker = sys.argv[3:]
    owner, group = os.getuid(), os.getgid()
    if (owner == 0 or mapping["schemaVersion"] != 1
            or mapping["ownerUid"] != owner or mapping["ownerGid"] != group
            or mapping["candidateUid"] in (0, owner)
            or mapping["candidateGid"] in (0, group)):
        raise RuntimeError("invalid keeper mapping")
    current = os.stat("/proc/self/ns/user")
    if mapping["hostNamespace"] != {"dev": current.st_dev, "ino": current.st_ino}:
        raise RuntimeError("host user namespace changed")
    for kind, path in (("uid", "/usr/bin/newuidmap"), ("gid", "/usr/bin/newgidmap")):
        helper = mapping["helpers"][kind]
        info = os.lstat(path)
        if (helper["path"] != path or not stat.S_ISREG(info.st_mode)
                or info.st_uid != 0 or info.st_nlink != 1
                or info.st_mode & 0o022 or not info.st_mode & stat.S_ISUID
                or info.st_size > 1048576):
            raise RuntimeError("unsafe mapping helper")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            content = os.read(fd, 1048577)
            stable = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_mode,
                                    value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if (len(content) != info.st_size or stable(os.fstat(fd)) != stable(info)
                    or hashlib.sha256(content).hexdigest() != helper["sha256"]):
                raise RuntimeError("mapping helper changed")
        finally:
            os.close(fd)

    libc = ctypes.CDLL(None, use_errno=True)
    def checked(result, operation):
        if result != 0:
            raise OSError(ctypes.get_errno(), operation)
    def remaining():
        value = (deadline - time.time() * 1000) / 1000
        if value <= 0:
            raise TimeoutError("namespace deadline ended")
        return value
    # If the Host disappears, neither this monitor nor the mapped keeper may
    # survive it. The mapping handshake also fails closed on either pipe EOF.
    checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0), "launcher parent-death signal")
    parent_pid = os.getppid()
    if parent_pid == 1:
        raise RuntimeError("Host already exited")
    ready_r, ready_w = os.pipe()
    start_r, start_w = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(ready_r)
            os.close(start_w)
            checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0), "keeper parent-death signal")
            if os.getppid() == 1:
                raise RuntimeError("launcher exited")
            checked(libc.unshare(0x10000000), "unshare user namespace")
            os.write(ready_w, b"R")
            os.close(ready_w)
            if not select.select([start_r], [], [], remaining())[0] or os.read(start_r, 1) != b"S":
                raise RuntimeError("mapping was not authorized")
            os.close(start_r)
            os.setgroups([])
            os.setresgid(0, 0, 0)
            os.setresuid(0, 0, 0)
            checked(libc.unshare(0x00020000 | 0x40000000 | 0x08000000 | 0x04000000), "keeper namespaces")
            checked(libc.mount(None, b"/", None, 0x4000 | 0x40000, None), "private mounts")
            checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0), "mapped keeper parent-death signal")
            # fd 4/5 are the bounded archive and binary channels. Python makes
            # its own pipes non-inheritable; only these Host channels survive.
            for fd in (0, 1, 2, 4, 5):
                os.set_inheritable(fd, True)
            os.execve(node, [node, worker], {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
        except BaseException as error:
            os.write(2, ("linux user namespace child: " + str(error) + "\n").encode())
            os._exit(125)
    os.close(ready_w)
    os.close(start_r)
    pidfd = os.pidfd_open(child)
    try:
        if not select.select([ready_r], [], [], min(5, remaining()))[0] or os.read(ready_r, 1) != b"R":
            raise RuntimeError("keeper did not reach mapping gate")
        for kind, outside in (("uid", mapping["candidateUid"]), ("gid", mapping["candidateGid"])):
            helper = mapping["helpers"][kind]
            subprocess.run([helper["path"], str(child), "0", str(owner if kind == "uid" else group),
                            "1", "65534", str(outside), "1"], check=True,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.PIPE, close_fds=True,
                           env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
                           timeout=min(5, remaining()))
        os.write(start_w, b"S")
        os.close(start_w)
        start_w = None
        # Close monitor copies: EOF on Host disconnect belongs to the keeper,
        # and EOF on fd 5 must not wait for an unrelated monitor descriptor.
        for fd in (0, 4, 5):
            os.close(fd)
        while True:
            waited, status = os.waitpid(child, os.WNOHANG)
            if waited:
                return os.waitstatus_to_exitcode(status)
            if os.getppid() != parent_pid:
                raise RuntimeError("Host disconnected")
            time.sleep(min(0.02, remaining()))
    finally:
        os.close(ready_r)
        if start_w is not None:
            os.close(start_w)
        try:
            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(pidfd)
        # SIGKILL cannot be ignored. This bounded monitor never waits for
        # candidate stdout or an inherited control descriptor during cleanup.
        until = time.monotonic() + 2
        while time.monotonic() < until:
            try:
                if os.waitpid(child, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break
            time.sleep(0.01)


try:
    code = main()
    sys.exit(code if code >= 0 else 128 - code)
except BaseException as error:
    if isinstance(error, SystemExit):
        raise
    print("linux user namespace launcher: " + str(error), file=sys.stderr)
    sys.exit(125)
