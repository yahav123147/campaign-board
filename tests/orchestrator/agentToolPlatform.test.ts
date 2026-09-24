import { describe, expect, it } from "vitest";
import { assertAgentToolPlatform } from "@/orchestrator/spawnAgent";

describe("client platform activation", () => {
  it("blocks Linux Bash while the switch is closed, independently of optional Claude sandbox warnings", () => {
    // The shipped switch is open since 24.09.2026; the closed path stays covered explicitly.
    expect(() => assertAgentToolPlatform(["Bash", "Write"], "linux", false)).toThrow("awaiting acceptance");
    expect(() => assertAgentToolPlatform(["Bash", "Write"], "linux")).not.toThrow();
  });

  it("keeps the supported Mac agent and Linux read-only agent available", () => {
    expect(() => assertAgentToolPlatform(["Bash"], "darwin")).not.toThrow();
    expect(() => assertAgentToolPlatform(["Read", "Glob"], "linux")).not.toThrow();
    expect(() => assertAgentToolPlatform([], "linux")).not.toThrow();
  });

  it("opens Linux Bash agents only through the acceptance switch, never native Windows", () => {
    expect(() => assertAgentToolPlatform(["Bash"], "linux", false)).toThrow("awaiting acceptance");
    expect(() => assertAgentToolPlatform(["Bash"], "linux", true)).not.toThrow();
    expect(() => assertAgentToolPlatform(["Bash"], "win32", true)).toThrow("Native Windows");
  });
});
