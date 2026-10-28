"""Compile the fixed, reviewed syscall policy for bubblewrap; never load it here.

The policy is the existing vendored Moby-derived source builder allowlist, with
its three explicit namespace extensions removed for ordinary jobs. libseccomp
is a system dependency, not a Docker dependency. Its public C ABI is documented
at https://github.com/seccomp/libseccomp/blob/main/include/seccomp.h.in .
"""
import ctypes
import hashlib
import json
import os
import platform
import sys

POLICY_SHA256 = "b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342"
ALLOW = 0x7fff0000
ERRNO = 0x00050000
ARCHES = {"x86_64": "amd64", "aarch64": "arm64"}
OPS = {"SCMP_CMP_NE": 1, "SCMP_CMP_EQ": 4, "SCMP_CMP_MASKED_EQ": 7}


class Arg(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]


def fail(message):
    raise RuntimeError("Linux seccomp: " + message)


def selected(rule, architecture, kernel):
    include = rule.get("includes", {})
    exclude = rule.get("excludes", {})
    # No host capability is granted by this policy. In particular, namespace-
    # local CAP_SYS_ADMIN must not activate the broad host-capability allowlist.
    if include.get("caps"):
        return False
    if "arches" in include and architecture not in include["arches"]:
        return False
    if architecture in exclude.get("arches", []):
        return False
    if "minKernel" in include and kernel < tuple(map(int, include["minKernel"].split("."))):
        return False
    return True


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("ordinary", "repository"):
        fail("expected ordinary or repository profile")
    architecture = ARCHES.get(platform.machine())
    if sys.platform != "linux" or architecture is None:
        fail("unsupported platform")
    kernel = tuple(map(int, platform.release().split(".")[:2]))
    if kernel < (5, 4):
        fail("Linux 5.4 or later is required")
    with open(os.path.join(os.path.dirname(__file__), "linux-seccomp-policy.json"), "rb") as source:
        content = source.read(65537)
    if hashlib.sha256(content).hexdigest() != POLICY_SHA256:
        fail("fixed syscall policy changed")
    policy = json.loads(content)
    if policy["defaultAction"] != "SCMP_ACT_ERRNO" or policy.get("defaultErrnoRet", 1) != 1:
        fail("unexpected default action")
    rules = policy["syscalls"]
    if [rule["names"] for rule in rules[-3:]] != [["unshare"], ["clone"], ["mount", "umount2", "pivot_root"]]:
        fail("namespace extension inventory changed")
    if sys.argv[1] == "ordinary":
        rules = rules[:-3]
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                          ctypes.c_uint, ctypes.POINTER(Arg)]
    lib.seccomp_rule_add_array.restype = ctypes.c_int
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_export_bpf.restype = ctypes.c_int
    context = lib.seccomp_init(ERRNO | 1)
    if not context:
        fail("could not create filter")
    try:
        for rule in rules:
            if not selected(rule, architecture, kernel):
                continue
            action = ALLOW if rule["action"] == "SCMP_ACT_ALLOW" else ERRNO | rule.get("errnoRet", 1)
            args = rule.get("args", [])
            comparisons = (Arg * len(args))(*(Arg(arg["index"], OPS[arg["op"]],
                                                arg["value"], arg.get("valueTwo", 0)) for arg in args))
            for name in rule["names"]:
                number = lib.seccomp_syscall_resolve_name(name.encode("ascii"))
                if number == -1:
                    # Names for other architectures and future syscalls remain
                    # denied by default; they never become unrestricted.
                    continue
                result = lib.seccomp_rule_add_array(context, action, number, len(args), comparisons)
                if result != 0:
                    fail("cannot encode rule for %s (%d)" % (name, result))
        if lib.seccomp_export_bpf(context, sys.stdout.fileno()) != 0:
            fail("cannot export filter")
    finally:
        lib.seccomp_release(context)


if __name__ == "__main__":
    main()
