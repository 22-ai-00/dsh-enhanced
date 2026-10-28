"""Trusted repository entry: revoke privilege before the private START gate."""
import ctypes
import json
import os
import select
import sys
import time


def main():
    if len(sys.argv) != 3:
        raise RuntimeError("invalid trusted entry arguments")
    deadline = int(sys.argv[1])
    argv = json.loads(sys.argv[2])
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 64
            or not all(isinstance(arg, str) and "\0" not in arg for arg in argv)
            or not argv[0].startswith("/")):
        raise RuntimeError("invalid candidate argv")
    libc = ctypes.CDLL(None, use_errno=True)
    def checked(value, operation):
        if value != 0:
            raise OSError(ctypes.get_errno(), operation)
    os.setgroups([])
    # SETPCAP is needed only by this fixed entry. Drop its bounding bit last.
    last_cap = int(open("/proc/sys/kernel/cap_last_cap", encoding="ascii").read())
    if not 0 <= last_cap <= 63:
        raise RuntimeError("unexpected capability inventory")
    for capability in [cap for cap in range(last_cap + 1) if cap != 8] + [8]:
        checked(libc.prctl(24, capability, 0, 0, 0), "drop capability bounding set")
    os.setresgid(65534, 65534, 65534)
    os.setresuid(65534, 65534, 65534)
    # setres* updates filesystem IDs too; setfs* returns the previous value.
    if libc.setfsgid(65534) != 65534 or libc.setfsuid(65534) != 65534:
        raise RuntimeError("filesystem identity did not drop")
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Capability(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]
    checked(libc.capset(ctypes.byref(Header(0x20080522, 0)), (Capability * 2)()), "clear capabilities")
    checked(libc.prctl(38, 1, 0, 0, 0), "no new privileges")
    os.chdir("/workspace")
    status = open("/proc/self/status", encoding="ascii").read()
    fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    if (os.getresuid() != (65534, 65534, 65534) or os.getresgid() != (65534, 65534, 65534)
            or os.getgroups() or fields["Uid"].split() != ["65534"] * 4
            or fields["Gid"].split() != ["65534"] * 4
            or any(int(fields[name], 16) for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"))
            or fields["NoNewPrivs"].strip() != "1" or fields["Seccomp"].strip() != "2"):
        raise RuntimeError("candidate privilege proof failed")
    os.write(6, b"READY\n")
    remaining = (deadline - time.time() * 1000) / 1000
    if remaining <= 0 or not select.select([6], [], [], remaining)[0]:
        raise TimeoutError("candidate gate deadline ended")
    # Fixed six-byte message: EOF, partial writes and unknown commands fail shut.
    message = b""
    while len(message) < 6:
        remaining = (deadline - time.time() * 1000) / 1000
        if remaining <= 0 or not select.select([6], [], [], remaining)[0]:
            raise TimeoutError("candidate gate deadline ended")
        part = os.read(6, 6 - len(message))
        if not part:
            raise RuntimeError("candidate gate disconnected")
        message += part
    if message != b"START\n":
        raise RuntimeError("candidate start not authorized")
    # Enumerate instead of trusting RLIMIT_NOFILE (which can be lowered below
    # already-open descriptor numbers). No transport/control fd reaches code.
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd >= 3:
            try:
                os.close(fd)
            except OSError:
                pass
    os.execv(argv[0], argv)


try:
    main()
except BaseException as error:
    print("linux trusted candidate entry: " + str(error), file=sys.stderr)
    sys.exit(125)
