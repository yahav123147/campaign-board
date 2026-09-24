#!/usr/bin/env node
// Reads `python3 -m unittest -v` output on stdin. The live Linux sandbox tests
// skip themselves unless COUNCIL_TEST_LINUX_SANDBOX=1 and namespaces work; a
// skip is silent and CI stayed green without ever exercising the sandbox.
// Here a skip is a failure: zero live tests ran means nothing was proven.
//
// The regex accepts both unittest verbose formats: the pre-3.12 form
// `test_x (module.LinuxSandboxTests) ... ok` and the 3.11/3.12+ form
// `test_x (module.LinuxSandboxTests.test_x) ... ok`.
import { fileURLToPath } from "node:url";

export const MIN_LINUX_SANDBOX_TESTS = 4;
const RAN = /^test_\w+ \(\S*LinuxSandboxTests(?:\.\w+)?\) \.\.\. ok$/gm;

export function countSandboxTestsThatRan(text) {
  return (String(text).match(RAN) ?? []).length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const ran = countSandboxTestsThatRan(input);
    if (ran < MIN_LINUX_SANDBOX_TESTS) {
      console.error(`Live Linux sandbox tests that ran: ${ran} (required ${MIN_LINUX_SANDBOX_TESTS}). A skip is a failure here.`);
      process.exit(1);
    }
    console.log(`Live Linux sandbox tests ran: ${ran}`);
  });
}
