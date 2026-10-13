"""Linux-only fail-closed filesystem and network sandbox for the memory worker."""
import ctypes
import errno
import os
import platform
import sys
from pathlib import Path

def restrict(read_paths, write_paths):
    if platform.machine() != "x86_64":
        raise RuntimeError("Sandbox is audited for Linux x86_64 only")
    libc = ctypes.CDLL(None, use_errno=True)
    def check(value):
        if value < 0:
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
        return value
    abi = check(libc.syscall(444, 0, 0, 1))
    if abi < 3:
        raise RuntimeError("Landlock ABI >= 3 required; no unsandboxed fallback")
    # ABI 3 includes REFER and TRUNCATE. Restrict every supported filesystem operation.
    access = (1 << 15) - 1
    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]
    class Rule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int)]
    attr = Ruleset(access)
    fd = check(libc.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0))
    for path, writable in [(p, False) for p in read_paths] + [(p, True) for p in write_paths]:
        p = Path(path).resolve(strict=True)
        target = os.open(p, os.O_PATH | os.O_CLOEXEC)
        allowed = access if writable else (1 | 4 | 8)  # execute, read file, read directory
        if not p.is_dir():
            allowed &= 1 | 2 | 4 | (1 << 14)
        rule = Rule(allowed, target)
        check(libc.syscall(445, fd, 1, ctypes.byref(rule), 0))
        os.close(target)
    check(libc.prctl(38, 1, 0, 0, 0))  # NO_NEW_PRIVS
    check(libc.syscall(446, fd, 0))
    os.close(fd)
    # Deny socket creation/connection, bind, sendto/sendmsg; model IO uses stdin/stdout.
    # Check architecture first to prevent alternate-ABI syscall bypasses.
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                    ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]
    instructions = [(0x20,0,0,4),(0x15,1,0,0xc000003e),(0x06,0,0,0x80000000),
                    (0x20,0,0,0),(0x35,0,1,0x40000000),(0x06,0,0,0x80000000)]
    for syscall in [41,42,44,46,49,101,310,311]: # network + ptrace/process_vm
        instructions += [(0x15,0,1,syscall),(0x06,0,0,0x50000 | errno.EPERM)]
    instructions += [(0x06,0,0,0x7fff0000)]
    filters = (Filter * len(instructions))(*(Filter(*x) for x in instructions))
    program = Program(len(instructions), filters)
    check(libc.prctl(22, 2, ctypes.byref(program), 0, 0))

if __name__ == "__main__":
    import json
    spec = json.loads(sys.argv[1])
    restrict(spec["read"], spec["write"])
    os.chdir(spec["cwd"])
    os.execve(spec["command"][0], spec["command"], spec["env"])
