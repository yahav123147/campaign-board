#!/usr/bin/env node
// Opens one URL in the Windows browser from WSL2 exactly the way stage 5.4
// does (the product's own launch builder), then requires the number of Edge
// processes on the Windows side to grow. One minute on a real WSL2 runner,
// independent of whether the design critics let a page reach stage 5.4.
import { spawn, execFileSync } from "node:child_process";
import { importTypeScriptModule } from "./doctor.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:1/council-acceptance-smoke";
const { windowsBrowserLaunch } = await importTypeScriptModule(process.cwd(), "orchestrator/windowsBrowser");
const launch = windowsBrowserLaunch(url);
if (!launch) {
  console.error(`BROWSER OPEN: the launch builder refused ${url}`);
  process.exit(2);
}
const edgeCount = () => {
  try {
    const out = execFileSync("/mnt/c/Windows/System32/tasklist.exe", ["/FI", "IMAGENAME eq msedge.exe", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return (out.match(/msedge\.exe/g) ?? []).length;
  } catch {
    return -1;
  }
};
const before = edgeCount();
console.log(`command: ${launch.command}`);
console.log(`args: ${JSON.stringify(launch.args)}`);
console.log(`script: ${Buffer.from(launch.args[launch.args.length - 1], "base64").toString("utf16le")}`);
console.log(`msedge.exe before: ${before}`);
const child = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (c) => { out += c; });
child.stderr.on("data", (c) => { out += c; });
const code = await new Promise((resolve) => child.on("close", resolve));
console.log(`powershell exited ${code}${out.trim() ? `; output: ${out.trim().slice(0, 500)}` : ""}`);
let after = before;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  after = edgeCount();
  if (after > before) break;
  await new Promise((r) => setTimeout(r, 1_000));
}
console.log(`msedge.exe after: ${after}`);
const ok = code === 0 && before >= 0 && after > before;
console.log(ok ? "BROWSER OPEN: OK (a new Windows browser process appeared)" : "BROWSER OPEN: FAILED");
process.exit(ok ? 0 : 1);
