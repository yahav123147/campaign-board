#!/usr/bin/env python3
"""Trusted Linux launcher. No generated process runs outside bubblewrap.

The host owns a Unix listener whose directory is never mounted into the sandbox.
Only the inner trusted bridge accepts on its inherited descriptor. The host TCP
relay connects to this fixed socket; it has no protocol for opening host targets.
The generated Node child inherits only stdio, never bridge or readiness handles.
"""

import json
import os
import platform
import selectors
import signal
import socket
import subprocess
import struct
import sys
import threading
import tempfile
import time

STOP = threading.Event()
ACTIVE = set()
ACTIVE_LOCK = threading.Lock()
MAX_CONNECTIONS = 64


def socket_seccomp_filter(machine):
    """Classic BPF: reject foreign ABIs, VM socket families and io_uring.

    AF_VSOCK can cross ordinary network namespaces on WSL kernels. Both socket
    and socketpair need filtering; io_uring must not create a socket indirectly.
    Only the native x86_64/aarch64 ABI is supported. x32 is expressly rejected.
    """
    architectures = {"x86_64": (0xC000003E, 41, 53), "aarch64": (0xC00000B7, 198, 199)}
    if machine not in architectures:
        raise RuntimeError(f"Linux sandbox does not support this syscall architecture: {machine}")
    audit_arch, socket_nr, socketpair_nr = architectures[machine]
    instructions = []
    labels = {}

    def label(name):
        labels[name] = len(instructions)

    def emit(code, value, yes=None, no=None):
        instructions.append((code, value, yes, no))

    emit(0x20, 4)  # BPF_LD|BPF_W|BPF_ABS: seccomp_data.arch
    emit(0x15, audit_arch, "native", "kill")
    label("native")
    emit(0x20, 0)  # seccomp_data.nr
    emit(0x45, 0x40000000, "kill", "uring_setup")  # x32 syscall-number bit
    label("uring_setup")
    emit(0x15, 425, "deny", "uring_enter")
    label("uring_enter")
    emit(0x15, 426, "deny", "uring_register")
    label("uring_register")
    emit(0x15, 427, "deny", "socket")
    label("socket")
    emit(0x15, socket_nr, "family", "socketpair")
    label("socketpair")
    emit(0x15, socketpair_nr, "family", "allow")
    label("family")
    emit(0x20, 16)  # low word of seccomp_data.args[0] on supported LE ABIs
    for index, family in enumerate((1, 2, 10, 16)):  # UNIX, INET, INET6, NETLINK
        label(f"family{index}")
        emit(0x15, family, "allow", f"family{index + 1}" if index < 3 else "deny")
    label("allow")
    emit(0x06, 0x7FFF0000)  # SECCOMP_RET_ALLOW
    label("deny")
    emit(0x06, 0x00050001)  # SECCOMP_RET_ERRNO|EPERM
    label("kill")
    emit(0x06, 0x80000000)  # SECCOMP_RET_KILL_PROCESS for unknown syscall ABI
    packed = []
    for index, (code, value, yes, no) in enumerate(instructions):
        yes_offset = labels[yes] - index - 1 if yes else 0
        no_offset = labels[no] - index - 1 if no else 0
        if not 0 <= yes_offset <= 255 or not 0 <= no_offset <= 255:
            raise RuntimeError("Invalid sandbox seccomp branch")
        packed.append(struct.pack("=HBBI", code, yes_offset, no_offset, value))
    return b"".join(packed)


def stop_requested(_signal, _frame):
    STOP.set()


def terminate_and_wait(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()
    child.wait()


def relay(client, target):
    """Bounded streaming with half-close support; no unbounded queued buffers."""
    with ACTIVE_LOCK:
        ACTIVE.update((client, target))
    try:
        client.settimeout(1)
        target.settimeout(1)
        peers = {client: target, target: client}
        with selectors.DefaultSelector() as selector:
            for sock in peers:
                selector.register(sock, selectors.EVENT_READ)
            while peers and not STOP.is_set():
                for key, _ in selector.select(.25):
                    source = key.fileobj
                    data = source.recv(65536)
                    if data:
                        peers[source].sendall(data)
                    else:
                        peers[source].shutdown(socket.SHUT_WR)
                        selector.unregister(source)
                        del peers[source]
    except (OSError, ValueError):
        pass
    finally:
        with ACTIVE_LOCK:
            ACTIVE.discard(client)
            ACTIVE.discard(target)
        client.close()
        target.close()


def accept_connections(listener, connect, child):
    workers = []
    listener.settimeout(.2)
    try:
        while not STOP.is_set() and child.poll() is None:
            workers = [worker for worker in workers if worker.is_alive()]
            try:
                client, _ = listener.accept()
            except socket.timeout:
                continue
            if len(workers) >= MAX_CONNECTIONS:
                client.close()
                continue
            try:
                target = connect()
            except OSError:
                client.close()
                continue
            worker = threading.Thread(target=relay, args=(client, target), daemon=True)
            workers.append(worker)
            worker.start()
    finally:
        STOP.set()
        listener.close()
        with ACTIVE_LOCK:
            sockets = list(ACTIVE)
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        for worker in workers:
            worker.join(timeout=2)


def inner(listener_fd, ready_fd, port, command):
    listener = socket.socket(fileno=listener_fd)
    listener.set_inheritable(False)
    os.set_inheritable(ready_fd, False)
    child = subprocess.Popen(command, close_fds=True, stdin=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 50
        while not STOP.is_set() and child.poll() is None:
            try:
                probe = socket.create_connection(("127.0.0.1", port), timeout=.2)
                probe.close()
                os.write(ready_fd, b"R")
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Sandbox preview did not bind its internal port within 50 seconds")
                STOP.wait(.05)
        else:
            raise RuntimeError("Sandbox preview stopped before becoming ready")
        os.close(ready_fd)
        ready_fd = -1
        accept_connections(listener, lambda: socket.create_connection(("127.0.0.1", port), timeout=2), child)
        return child.poll() or 0
    finally:
        listener.close()
        if ready_fd >= 0:
            os.close(ready_fd)
        terminate_and_wait(child)


def bubblewrap_args(config, filter_fd):
    # --new-session calls setsid(): without it the sandboxed process keeps the
    # board's controlling terminal, and --dev /dev hands it the host's
    # /dev/tty. That is the TIOCSTI keystroke-injection escape (CVE-2017-5226)
    # bubblewrap's own manual warns about, and WSL2's kernel has no
    # dev.tty.legacy_tiocsti switch to close it. The child is non-interactive
    # and takes its stdio from pipes, so losing the terminal costs nothing.
    args = [config["bwrap"], "--unshare-user", "--unshare-pid", "--unshare-net",
            "--unshare-ipc", "--unshare-uts", "--disable-userns", "--assert-userns-disabled",
            "--cap-drop", "ALL", "--die-with-parent", "--new-session", "--seccomp", str(filter_fd)]
    # Empty root, never --ro-bind / /. No host home, /run, /mnt, /init or IPC.
    for entry in ("/usr", "/lib", "/lib64", "/bin", "/sbin"):
        if os.path.islink(entry):
            args += ["--symlink", os.readlink(entry), entry]
        elif os.path.isdir(entry):
            args += ["--ro-bind", entry, entry]
    args += ["--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev"]
    reads = set(config["readPaths"] + [config["node"], config["helper"]])
    for entry in sorted(reads, key=lambda value: (value.count("/"), value)):
        args += ["--ro-bind", entry, entry]
    for entry in sorted(config["writePaths"], key=lambda value: (value.count("/"), value)):
        args += ["--bind", entry, entry]
    args += ["--remount-ro", "/", "--chdir", config["cwd"], "--"]
    return args


def outer(config):
    if config.get("version") != 1 or config.get("network") not in ("none", "loopback-server"):
        raise RuntimeError("Unsupported Linux sandbox contract")
    preview = config["network"] == "loopback-server"
    command = [config["node"]] + config["nodeArgs"]
    host = unix = child = None
    policy = None
    ready_read = ready_write = -1
    unix_path = os.path.join(config["launchDir"], "preview.sock")
    try:
        policy = tempfile.TemporaryFile(dir=config["launchDir"])
        policy.write(socket_seccomp_filter(platform.machine()))
        policy.seek(0)
        args = bubblewrap_args(config, policy.fileno())
        if preview:
            port = config.get("port")
            if type(port) is not int or not 1024 <= port <= 65535:
                raise RuntimeError("Preview requires a fixed unprivileged port")
            host = socket.socket()
            host.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            host.bind(("127.0.0.1", port))  # Reserve ownership; not ready/listening yet.
            unix = socket.socket(socket.AF_UNIX)
            unix.bind(unix_path)
            unix.listen(MAX_CONNECTIONS)
            ready_read, ready_write = os.pipe()
            args += [config["python"], config["helper"], "inner", str(unix.fileno()),
                     str(ready_write), str(port), json.dumps(command)]
            child = subprocess.Popen(args, pass_fds=(unix.fileno(), ready_write, policy.fileno()), stdin=subprocess.DEVNULL)
            policy.close()
            policy = None
            unix.close()  # Only the inner process accepts. No host acceptor.
            unix = None
            os.close(ready_write)
            ready_write = -1
            with selectors.DefaultSelector() as selector:
                selector.register(ready_read, selectors.EVENT_READ)
                deadline = time.monotonic() + 55
                while not STOP.is_set() and child.poll() is None:
                    if selector.select(.2):
                        if os.read(ready_read, 1) != b"R":
                            raise RuntimeError("Sandbox preview bridge exited before readiness")
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Sandbox preview bridge timed out before readiness")
                else:
                    raise RuntimeError("Sandbox preview stopped before readiness")
            os.close(ready_read)
            ready_read = -1
            host.listen(MAX_CONNECTIONS)
            def connect_inner():
                connection = socket.socket(socket.AF_UNIX)
                connection.settimeout(2)
                try:
                    connection.connect(unix_path)
                    return connection
                except OSError:
                    connection.close()
                    raise
            accept_connections(host, connect_inner, child)
        else:
            child = subprocess.Popen(args + command, pass_fds=(policy.fileno(),), stdin=subprocess.DEVNULL)
            policy.close()
            policy = None
            while child.poll() is None and not STOP.wait(.1):
                pass
        status = child.poll()
        return status if status is not None else (143 if STOP.is_set() else 0)
    finally:
        STOP.set()
        if child is not None:
            terminate_and_wait(child)
        if policy is not None:
            policy.close()
        for sock in (host, unix):
            if sock is not None:
                sock.close()
        for descriptor in (ready_read, ready_write):
            if descriptor >= 0:
                os.close(descriptor)
        if preview and os.path.exists(unix_path):
            os.unlink(unix_path)


if __name__ == "__main__":
    for name in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(name, stop_requested)
    try:
        if sys.argv[1] == "outer":
            with open(sys.argv[2], encoding="utf8") as source:
                code = outer(json.load(source))
        elif sys.argv[1] == "inner":
            code = inner(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), json.loads(sys.argv[5]))
        else:
            raise RuntimeError("Unknown Linux sandbox launcher mode")
    except Exception as error:
        print(f"Linux sandbox unavailable or failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
    sys.exit(code)
