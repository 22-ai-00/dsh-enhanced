"""Fixed Host-side kernel witnesses and pidfd cleanup for repository identities.

No candidate code is evaluated. Namespace FDs remain open across observation
and signaling; pidfds and start ticks prevent numeric PID reuse from granting
authority. The caller additionally owns the frozen cgroup and durable intent.
"""
import array
import fcntl
import json
import os
import select
import signal
import sys

NS_GET_PARENT = 0xB702
NS_GET_OWNER_UID = 0xB704


def fail(message):
    raise RuntimeError("repository user namespace: " + message)


def identity(fd):
    item = os.fstat(fd)
    return {"dev": item.st_dev, "ino": item.st_ino}


def read(path, maximum=65536):
    with open(path, encoding="ascii") as source:
        value = source.read(maximum + 1)
    if len(value) > maximum:
        fail("kernel observation exceeds bound")
    return value


def boot():
    return read("/proc/sys/kernel/random/boot_id").strip().lower()


def owner(fd):
    value = array.array("I", [0])
    fcntl.ioctl(fd, NS_GET_OWNER_UID, value, True)
    return value[0]


def parent(fd):
    return fcntl.ioctl(fd, NS_GET_PARENT)


def mapping_rows(pid, kind):
    return [[int(item) for item in line.split()]
            for line in read("/proc/%d/%s_map" % (pid, kind)).splitlines()]


def exact_maps(pid, mapping):
    for kind in ("uid", "gid"):
        suffix = "Uid" if kind == "uid" else "Gid"
        expected = [[0, mapping["owner" + suffix], 1],
                    [65534, mapping["candidate" + suffix], 1]]
        if mapping_rows(pid, kind) != expected:
            fail("kernel mapping differs")


def status(pid):
    values = {}
    for line in read("/proc/%d/status" % pid).splitlines():
        key, separator, value = line.partition(":")
        if separator:
            values[key] = value.strip()
    return values


def ticks(pid):
    value = read("/proc/%d/stat" % pid)
    fields = value[value.rfind(") ") + 2:].split()
    if len(fields) < 20 or not fields[19].isdigit():
        fail("process start identity unavailable")
    return fields[19]


def alive(fd):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return not poll.poll(0)


def checked_process(pid, expected_ticks, pidfd):
    if not alive(pidfd) or ticks(pid) != expected_ticks:
        fail("process identity changed")
    return status(pid)


def same_current_namespace(pid, fd):
    current = os.open("/proc/%d/ns/user" % pid, os.O_RDONLY)
    try:
        if identity(current) != identity(fd):
            fail("process user namespace changed")
    finally:
        os.close(current)


def ids(values, kind):
    result = [int(item) for item in values[kind].split()]
    if len(result) != 4:
        fail("incomplete process identity")
    return result


def check_host(mapping):
    if os.getuid() != mapping["ownerUid"] or os.getgid() != mapping["ownerGid"]:
        fail("Host owner differs")
    fd = os.open("/proc/self/ns/user", os.O_RDONLY)
    try:
        if identity(fd) != mapping["hostNamespace"]:
            fail("Host namespace differs")
    finally:
        os.close(fd)


def check_anchor_fd(fd, witness):
    if identity(fd) != witness["namespace"] or owner(fd) != witness["ownerUid"]:
        fail("namespace anchor differs")
    up = parent(fd)
    try:
        if identity(up) != witness["parent"] or witness["parent"] != witness["mapping"]["hostNamespace"]:
            fail("namespace parent differs")
    finally:
        os.close(up)


def anchor(mapping, process):
    check_host(mapping)
    current_boot = boot()
    pid = process["pid"]
    pidfd = os.pidfd_open(pid, 0)
    nsfd = None
    try:
        values = checked_process(pid, process["startTicks"], pidfd)
        if ids(values, "Uid") != [mapping["ownerUid"]] * 4 or ids(values, "Gid") != [mapping["ownerGid"]] * 4:
            fail("keeper identity differs")
        exact_maps(pid, mapping)
        nsfd = os.open("/proc/%d/ns/user" % pid, os.O_RDONLY)
        parentfd = parent(nsfd)
        try:
            result = {"schemaVersion": 1, "bootId": current_boot,
                      "mapping": mapping, "namespace": identity(nsfd),
                      "parent": identity(parentfd), "ownerUid": owner(nsfd),
                      "leader": process}
        finally:
            os.close(parentfd)
        if result["parent"] != mapping["hostNamespace"] or result["ownerUid"] != mapping["ownerUid"]:
            fail("keeper namespace is not owned directly by Host")
        if result["namespace"] == result["parent"]:
            fail("keeper did not enter a new user namespace")
        checked_process(pid, process["startTicks"], pidfd)
        exact_maps(pid, mapping)
        same_current_namespace(pid, nsfd)
        checked_process(pid, process["startTicks"], pidfd)
        if boot() != current_boot:
            fail("boot changed")
        return result
    finally:
        if nsfd is not None:
            os.close(nsfd)
        os.close(pidfd)


def candidate(witness, process):
    mapping = witness["mapping"]
    check_host(mapping)
    if boot() != witness["bootId"]:
        fail("boot changed")
    pid = process["pid"]
    pidfd = os.pidfd_open(pid, 0)
    nsfd = None
    try:
        values = checked_process(pid, process["startTicks"], pidfd)
        if ids(values, "Uid") != [mapping["candidateUid"]] * 4 or ids(values, "Gid") != [mapping["candidateGid"]] * 4:
            fail("candidate did not drop all identities")
        if values.get("Groups") != "" or any(int(values[key], 16) != 0 for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")):
            fail("candidate retained groups or capabilities")
        if values.get("NoNewPrivs") != "1" or values.get("Seccomp") != "2" or int(values.get("Seccomp_filters", "0")) < 1:
            fail("candidate privilege or syscall fence differs")
        if len(values.get("NSpid", "").split()) < 2:
            fail("candidate PID namespace missing")
        exact_maps(pid, mapping)
        nsfd = os.open("/proc/%d/ns/user" % pid, os.O_RDONLY)
        check_anchor_fd(nsfd, witness)
        result = {"schemaVersion": 1, "pid": pid, "startTicks": process["startTicks"],
                  "bootId": witness["bootId"], "namespace": identity(nsfd),
                  "uid": mapping["candidateUid"], "gid": mapping["candidateGid"],
                  "groups": [], "capabilities": "0", "noNewPrivileges": True, "seccomp": 2}
        after = checked_process(pid, process["startTicks"], pidfd)
        for key in ("Uid", "Gid", "Groups", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp", "Seccomp_filters", "NSpid"):
            if after.get(key) != values.get(key):
                fail("candidate security state changed")
        exact_maps(pid, mapping)
        same_current_namespace(pid, nsfd)
        checked_process(pid, process["startTicks"], pidfd)
        return result
    finally:
        if nsfd is not None:
            os.close(nsfd)
        os.close(pidfd)


def descendant_anchor(fd, witness, held):
    """Keep each FD while walking; missing/replaced ancestry never grants kill."""
    current = fd
    for _ in range(33):
        if identity(current) == witness["namespace"]:
            check_anchor_fd(current, witness)
            return
        current = parent(current)
        held.append(current)
    fail("namespace ancestry exceeds bound")


def kill_members(request):
    witness = request["witness"]
    mapping = witness["mapping"]
    check_host(mapping)
    if boot() != witness["bootId"]:
        fail("boot changed")
    freezer = request["freezerPath"]
    expected_suffix = request["cgroup"][1]
    if request["cgroup"][0] != "freezer" or not freezer.startswith("/sys/fs/cgroup/") or not freezer.endswith(expected_suffix):
        fail("freezer identity differs")
    if read(freezer + "/freezer.state").strip() != "FROZEN":
        fail("job group is not frozen")
    held = []
    namespaces = []
    try:
        for item in request["processes"]:
            pid, expected_ticks = item
            try:
                pidfd = os.pidfd_open(pid, 0)
            except ProcessLookupError:
                continue
            held.append(pidfd)
            if not alive(pidfd):
                continue
            values = checked_process(pid, expected_ticks, pidfd)
            memberships = [line.split(":", 2)[1:] for line in read("/proc/%d/cgroup" % pid).splitlines()]
            if request["cgroup"] not in memberships:
                fail("process escaped frozen group")
            nsfd = os.open("/proc/%d/ns/user" % pid, os.O_RDONLY)
            namespaces.append(nsfd)
            outside = any(entry["pid"] == pid and entry["startTicks"] == expected_ticks for entry in request["outsideGates"])
            if outside and identity(nsfd) == mapping["hostNamespace"]:
                if ids(values, "Uid") != [mapping["ownerUid"]] * 4 or ids(values, "Gid") != [mapping["ownerGid"]] * 4:
                    fail("original keeper gate changed identity")
            else:
                if any(value not in (mapping["ownerUid"], mapping["candidateUid"]) for value in ids(values, "Uid")):
                    fail("foreign UID in job group")
                if any(value not in (mapping["ownerGid"], mapping["candidateGid"]) for value in ids(values, "Gid")):
                    fail("foreign GID in job group")
                descendant_anchor(nsfd, witness, namespaces)
                if identity(nsfd) == witness["namespace"]:
                    exact_maps(pid, mapping)
            same_current_namespace(pid, nsfd)
            checked_process(pid, expected_ticks, pidfd)
        # All members are independently checked before any signal is sent.
        if read(freezer + "/freezer.state").strip() != "FROZEN":
            fail("freezer barrier changed")
        for fd in held:
            try:
                signal.pidfd_send_signal(fd, signal.SIGKILL, None, 0)
            except ProcessLookupError:
                pass
        return {"signaled": len(held)}
    finally:
        for fd in namespaces:
            os.close(fd)
        for fd in held:
            os.close(fd)


def main():
    raw = sys.stdin.buffer.read(1048577)
    if len(raw) > 1048576:
        fail("request exceeds bound")
    request = json.loads(raw)
    operation = request.get("operation")
    if operation == "anchor":
        result = anchor(request["mapping"], request["identity"])
    elif operation == "candidate":
        result = candidate(request["witness"], request["identity"])
    elif operation == "kill":
        if not isinstance(request["processes"], list) or len(request["processes"]) > 16384 or len(request["outsideGates"]) > 1:
            fail("process inventory exceeds bound")
        result = kill_members(request)
    else:
        fail("unsupported operation")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
