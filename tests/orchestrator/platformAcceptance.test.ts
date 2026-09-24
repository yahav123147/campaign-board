import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linuxLandingAccepted, PLATFORM_ACCEPTANCE_FILE } from "@/orchestrator/platformAcceptance";
import { linuxLandingAccepted as fromMjs } from "@/lib/platformAcceptance.mjs";

describe("platform acceptance switch", () => {
  it("is open: the WSL2 acceptance evidence exists and was approved", () => {
    // Opened 24.09.2026 after the operator approved the evidence: the full
    // direct pipeline ran on a real WSL2 distribution as an ordinary user with
    // real agents (acceptance run 35927734880: sandboxed build with network
    // none, preview opened in the Windows browser, critic screenshots, QA
    // pass, delivery to the landing branch; run 35977713894 validated the
    // review path). Evidence: docs/superpowers/acceptance/2026-09-20-wsl2.md.
    expect(linuxLandingAccepted()).toBe(true);
  });
  it("is read from one JSON file by both the TypeScript and the .mjs side", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "platform-acceptance.json"), "utf8"));
    expect(raw).toEqual({ linuxLanding: true });
    expect(fromMjs()).toBe(linuxLandingAccepted());
    expect(PLATFORM_ACCEPTANCE_FILE).toBe("config/platform-acceptance.json");
  });
  afterEach(() => vi.restoreAllMocks());
  it("reads the file once per process: it is a release artefact on every sandboxed launch, not a runtime toggle", () => {
    linuxLandingAccepted();
    fromMjs();
    const read = vi.spyOn(fs, "readFileSync");
    expect(linuxLandingAccepted()).toBe(true);
    expect(fromMjs()).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
