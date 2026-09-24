"""Real kernel tests, explicitly enabled only on a namespace-capable Linux host.

COUNCIL_TEST_LINUX_SANDBOX=1 python3 -m unittest discover -s tests/scripts -p test_linux_process_sandbox.py
No AI calls, browser, external writes, or paid APIs are used.
"""
import json
import importlib.util
import os
from pathlib import Path
import shutil
import socket
import subprocess
import struct
import sys
import tempfile
import time
import unittest
import urllib.request
import uuid


class SocketFilterTests(unittest.TestCase):
    def setUp(self):
        helper = Path(__file__).resolve().parents[2] / "scripts/linux-process-sandbox.py"
        spec = importlib.util.spec_from_file_location("linux_sandbox_filter", helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.filter = module.socket_seccomp_filter

    def evaluate(self, machine, audit, syscall, family=0):
        instructions = list(struct.iter_unpack("=HBBI", self.filter(machine)))
        memory = {0: syscall, 4: audit, 16: family}
        pc = accumulator = 0
        while pc < len(instructions):
            code, yes, no, value = instructions[pc]
            if code == 0x20:
                accumulator = memory[value]
            elif code == 0x15:
                pc += yes if accumulator == value else no
            elif code == 0x45:
                pc += yes if accumulator & value else no
            elif code == 0x06:
                return value
            else:
                self.fail("Unsupported BPF instruction")
            pc += 1
        self.fail("Filter did not return a verdict")

    def test_all_socket_entrypoints_and_abis(self):
        for machine, audit, socket_call, pair_call in [("x86_64", 0xC000003E, 41, 53), ("aarch64", 0xC00000B7, 198, 199)]:
            for call in (socket_call, pair_call):
                for family in (40, 43, 0xFFFF):
                    self.assertEqual(self.evaluate(machine, audit, call, family), 0x50001)
                for family in (1, 2, 10, 16):
                    self.assertEqual(self.evaluate(machine, audit, call, family), 0x7FFF0000)
            for call in (425, 426, 427):
                self.assertEqual(self.evaluate(machine, audit, call), 0x50001)
            self.assertEqual(self.evaluate(machine, audit, 0x40000000 | socket_call, 40), 0x80000000)
            self.assertEqual(self.evaluate(machine, 0x40000003, socket_call, 40), 0x80000000)
        with self.assertRaises(RuntimeError):
            self.filter("i686")


class BubblewrapArgsTests(unittest.TestCase):
    """Host-independent: pins the bwrap argv itself, since the live /dev/tty
    assertion below returns ENXIO on any TTY-less CI step with or without
    --new-session (it is a belt, this is the pin)."""

    def test_new_session_detaches_the_sandbox_from_the_terminal(self):
        helper = Path(__file__).resolve().parents[2] / "scripts/linux-process-sandbox.py"
        spec = importlib.util.spec_from_file_location("sandbox_helper", helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        config = {"bwrap": "/usr/bin/bwrap", "readPaths": [], "writePaths": [], "network": "none",
                  "cwd": "/tmp", "node": sys.executable, "helper": str(helper), "launchDir": "/tmp"}
        args = module.bubblewrap_args(config, 3)
        self.assertIn("--new-session", args)
        self.assertIn("--die-with-parent", args)
        self.assertIn("--unshare-user", args)


@unittest.skipUnless(sys.platform == "linux" and os.environ.get("COUNCIL_TEST_LINUX_SANDBOX") == "1",
                     "requires an explicitly enabled, namespace-capable Linux host")
class LinuxSandboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="council-linux-test-")
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.out = self.work / "out"
        self.launch = self.root / "launch"
        self.out.mkdir(parents=True)
        self.launch.mkdir(mode=0o700)
        self.source = self.work / "source.txt"
        self.source.write_text("unchanged")
        self.private = self.root / "host-private.txt"
        self.private.write_text("host-only-test-fixture")
        self.helper = Path(__file__).resolve().parents[2] / "scripts/linux-process-sandbox.py"
        self.node = str(Path(shutil.which("node")).resolve())
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            if child.stdout:
                child.stdout.close()
            if child.stderr:
                child.stderr.close()
        self.temp.cleanup()

    def config(self, code, port=None):
        script = self.work / "fixture.js"
        script.write_text(code)
        config = dict(version=1, bwrap="/usr/bin/bwrap", python="/usr/bin/python3",
                      helper=str(self.helper), node=self.node, nodeArgs=[str(script)],
                      cwd=str(self.work), readPaths=[str(self.work)], writePaths=[str(self.out)],
                      network="loopback-server" if port else "none", port=port, launchDir=str(self.launch))
        target = self.launch / "launch.json"
        target.write_text(json.dumps(config))
        return target

    def start(self, config):
        child = subprocess.Popen([sys.executable, str(self.helper), "outer", str(config)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(self.out),
                                      "TMPDIR": str(self.out)})
        self.children.append(child)
        return child

    def free_port(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def wait_for_response(self, child, port):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and child.poll() is None:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=.5) as response:
                    return response.read().decode()
            except OSError:
                time.sleep(.05)
        self.fail(f"Preview failed to start: exit={child.poll()}")

    def test_files_network_proc_and_nested_namespaces(self):
        host = socket.socket()
        host.bind(("127.0.0.1", 0))
        host.listen(1)
        self.addCleanup(host.close)
        code = r'''
const fs=require('fs'),net=require('net'),cp=require('child_process');const result={};
const attempts={PRIVATE:()=>fs.readFileSync(PRIVATE_PATH),SOURCE:()=>fs.writeFileSync(SOURCE_PATH,'bad'),ROOT:()=>fs.writeFileSync('/escape','bad'),OUTPUT:()=>fs.writeFileSync(OUTPUT_PATH,'ok'),TTY:()=>fs.openSync('/dev/tty','r')};
for(const [name,fn] of Object.entries(attempts)){try{fn();result[name]='allowed'}catch(e){result[name]=e.code}}
for(const p of ['/mnt','/init','/run'])result[p]=fs.existsSync(p);
result.proc=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).length;
result.nested=cp.spawnSync('/usr/bin/unshare',['-Ur','/usr/bin/true']).status;
const socketProbe=cp.spawnSync('/usr/bin/python3',['-c',`import ctypes,json\nlib=ctypes.CDLL(None,use_errno=True)\nresult=[]\nfor number,args in [(SOCKET_CALL,(40,1,0)),(PAIR_CALL,(40,1,0,0)),(425,(0,0)),(426,(0,0,0,0,0,0)),(427,(0,0,0,0))]:\n lib.syscall(number,*args);result.append(ctypes.get_errno())\nprint(json.dumps(result))`],{encoding:'utf8'});result.vmSockets=JSON.parse(socketProbe.stdout);
function probe(host,port){return new Promise(resolve=>{const s=net.connect({host,port});s.setTimeout(500);s.once('connect',()=>{s.destroy();resolve('connected')});s.once('error',e=>resolve(e.code));s.once('timeout',()=>{s.destroy();resolve('timeout')})})}
Promise.all([probe('127.0.0.1',HOST_PORT),probe('1.1.1.1',443)]).then(r=>{result.loopback=r[0];result.external=r[1];console.log(JSON.stringify(result))});
'''.replace("PRIVATE_PATH", json.dumps(str(self.private))).replace("SOURCE_PATH", json.dumps(str(self.source))).replace("OUTPUT_PATH", json.dumps(str(self.out / "result"))).replace("HOST_PORT", str(host.getsockname()[1])).replace("SOCKET_CALL", "198" if os.uname().machine == "aarch64" else "41").replace("PAIR_CALL", "199" if os.uname().machine == "aarch64" else "53")
        child = self.start(self.config(code))
        stdout, stderr = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 0, stderr)
        result = json.loads(stdout)
        self.assertEqual(result["PRIVATE"], "ENOENT")
        self.assertEqual(result["SOURCE"], "EROFS")
        self.assertEqual(result["ROOT"], "EROFS")
        self.assertEqual(result["OUTPUT"], "allowed")
        # --new-session: no controlling terminal, so the host's /dev/tty
        # cannot be opened and TIOCSTI keystroke injection is out of reach.
        self.assertEqual(result["TTY"], "ENXIO")
        self.assertEqual(self.source.read_text(), "unchanged")
        self.assertEqual(result["loopback"], "ECONNREFUSED")
        self.assertEqual(result["external"], "ENETUNREACH")
        self.assertLessEqual(result["proc"], 3)
        self.assertNotEqual(result["nested"], 0)
        self.assertEqual(result["vmSockets"], [1, 1, 1, 1, 1])
        for key in ("/mnt", "/init", "/run"):
            self.assertFalse(result[key])

    def test_preview_streams_and_cancel_reaps_detached_child(self):
        port = self.free_port()
        marker = "council-detached-" + uuid.uuid4().hex
        code = """
const cp=require('child_process'),http=require('http'),fs=require('fs');
const child=cp.spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)',MARKER],{detached:true,stdio:'ignore'});child.unref();
http.createServer((q,p)=>{const descriptors=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{return [fs.readlinkSync('/proc/self/fd/'+fd)]}catch{return []}});p.end(JSON.stringify({message:'isolated-preview',launchVisible:fs.existsSync(LAUNCH_PATH),descriptors}))}).listen(PORT,'127.0.0.1');
""".replace("MARKER", json.dumps(marker)).replace("LAUNCH_PATH", json.dumps(str(self.launch))).replace("PORT", str(port))
        child = self.start(self.config(code, port))
        payload = json.loads(self.wait_for_response(child, port))
        self.assertEqual(payload["message"], "isolated-preview")
        self.assertFalse(payload["launchVisible"])
        # Match kernel socket identity, not descriptor numbers Node can reuse.
        processes = subprocess.check_output(["ps", "-eo", "pid=,args="], text=True)
        inner = [line.split() for line in processes.splitlines()
                 if f"/usr/bin/python3 {self.helper} inner " in line
                 and line.split()[1] == "/usr/bin/python3"]
        self.assertEqual(len(inner), 1)
        bridge_socket = os.readlink(f"/proc/{inner[0][0]}/fd/{inner[0][4]}")
        self.assertNotIn(bridge_socket, payload["descriptors"])
        child.terminate()
        child.wait(timeout=5)
        self.assertFalse((self.launch / "preview.sock").exists())
        time.sleep(.1)
        listing = subprocess.check_output(["ps", "-eo", "args="], text=True)
        self.assertFalse(any(line.startswith(self.node + " ") and line.endswith(marker) for line in listing.splitlines()))
        with socket.socket() as check:
            # The intent is "no listener remains". Without SO_REUSEADDR a
            # TIME_WAIT left by this test's own HTTP request on the server
            # side also refuses the bind (seen once on WSL2 as an ordinary
            # user); with it, only a live listener does.
            check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            check.bind(("127.0.0.1", port))

    def test_force_kill_also_reaps_namespace(self):
        port = self.free_port()
        marker = "council-force-" + uuid.uuid4().hex
        code = """
const cp=require('child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)',MARKER],{detached:true,stdio:'ignore'});child.unref();
require('http').createServer((q,p)=>p.end('ready')).listen(PORT,'127.0.0.1');
""".replace("MARKER", json.dumps(marker)).replace("PORT", str(port))
        child = self.start(self.config(code, port))
        self.assertEqual(self.wait_for_response(child, port), "ready")
        child.kill()
        child.wait(timeout=5)
        time.sleep(.2)
        listing = subprocess.check_output(["ps", "-eo", "args="], text=True)
        self.assertFalse(any(line.startswith(self.node + " ") and line.endswith(marker) for line in listing.splitlines()))
        # Caller, not the killed launcher, owns post-close removal of launch state.
        shutil.rmtree(self.launch)
        self.assertFalse(self.launch.exists())

    def test_early_exit_and_foreign_port_leave_no_listening_bridge(self):
        port = self.free_port()
        child = self.start(self.config("process.exit(7)", port))
        child.communicate(timeout=5)
        self.assertNotEqual(child.returncode, 0)
        self.assertFalse((self.launch / "preview.sock").exists())
        with socket.socket() as owner:
            owner.bind(("127.0.0.1", port))
            owner.listen(1)
            second = self.start(self.config("setInterval(()=>{},1000)", port))
            second.communicate(timeout=5)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(owner.getsockname()[1], port)


if __name__ == "__main__":
    unittest.main()
