import { describe, expect, it } from "vitest";
import { countSandboxTestsThatRan, MIN_LINUX_SANDBOX_TESTS } from "../../scripts/ci-assert-sandbox-tests-ran.mjs";

const RAN = `test_all_socket_entrypoints_and_abis (test_linux_process_sandbox.SocketFilterTests) ... ok
test_files_network_proc_and_nested_namespaces (test_linux_process_sandbox.LinuxSandboxTests) ... ok
test_preview_streams_and_cancel_reaps_detached_child (test_linux_process_sandbox.LinuxSandboxTests) ... ok
test_force_kill_also_reaps_namespace (test_linux_process_sandbox.LinuxSandboxTests) ... ok
test_early_exit_and_foreign_port_leave_no_listening_bridge (test_linux_process_sandbox.LinuxSandboxTests.test_early_exit_and_foreign_port_leave_no_listening_bridge) ... ok`;
const SKIPPED = `test_files_network_proc_and_nested_namespaces (test_linux_process_sandbox.LinuxSandboxTests) ... skipped 'requires an explicitly enabled, namespace-capable Linux host'`;

describe("CI guard for the live sandbox tests", () => {
  it("counts only LinuxSandboxTests that ended in ok", () => {
    expect(countSandboxTestsThatRan(RAN)).toBe(4);
    expect(countSandboxTestsThatRan(SKIPPED)).toBe(0);
    expect(countSandboxTestsThatRan("")).toBe(0);
  });
  it("requires every live test, so a new skip cannot pass unnoticed", () => {
    expect(MIN_LINUX_SANDBOX_TESTS).toBe(4);
  });
});
