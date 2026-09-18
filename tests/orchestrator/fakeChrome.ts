/**
 * The fake browser both browser-owning suites run against: a root process plus
 * a child that ignores SIGTERM, so only a process-group owner can end the
 * tree. Both PIDs are published to a fixture file, and every test that uses it
 * proves they are dead before it returns.
 *
 * FAKE_CHROME_MODE picks the behaviour: "ready" (the default) serves a CDP
 * endpoint, "never-ready" never writes a port, "crash" exits at once, and
 * "port-then-exit" announces a port and dies.
 */
export const FAKE_CHROME = `#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
const cp = require("child_process");

const mode = process.env.FAKE_CHROME_MODE || "ready";
const fixture = process.env.FAKE_CHROME_FIXTURE;
const flags = process.argv.slice(2);
const userDataDir = (flags.find((f) => f.startsWith("--user-data-dir=")) || "").split("=")[1];

// A grandchild that refuses SIGTERM: the supervisor must escalate to KILL on the group.
const child = cp.spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
  stdio: "ignore",
});

const record = (extra) => fs.writeFileSync(fixture, JSON.stringify({
  chromePid: process.pid,
  childPid: child.pid,
  executable: process.argv[1],
  flags,
  ...extra,
}));

if (mode === "crash") {
  record({});
  process.exit(9);
}
if (mode === "port-then-exit") {
  // A browser that announces a port and dies: readiness polling must notice.
  record({ port: 9 });
  fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), "9\\n/devtools/browser/fake\\n");
  process.exit(0);
}
if (mode === "never-ready") {
  record({});
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Browser: "FakeChrome/1.0" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    record({ port });
    fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), port + "\\n/devtools/browser/fake\\n");
  });
}
`;
