import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { critiqueRound, finalVerdictLabel, splitCritiques, type Critique } from "@/orchestrator/runStage5LpBuild";
import { spawnAgent } from "@/orchestrator/spawnAgent";
import { loadAgents } from "@/orchestrator/loadAgents";
import type { Agent } from "@/types";

vi.mock("@/orchestrator/spawnAgent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/orchestrator/spawnAgent")>()), spawnAgent: vi.fn(async () => ({ fullText: "" })) }));
vi.mock("@/orchestrator/loadAgents", () => ({ loadAgents: vi.fn(async () => []) }));

function makeAgent(slug: Agent["slug"], name: string): Agent {
  return { slug, name, role: name, color: "#000", order: 1, active: true, systemPrompt: `אתה ${name}.`, avatarPath: "/tmp/a.png" };
}
const agents = [makeAgent("uri-art-director", "אורי"), makeAgent("roni-creative", "רוני"), makeAgent("avishai-campaigner", "אבישי")];

function critique(name: string, verdict: Critique["verdict"]): Critique {
  return { slug: "roni-creative", name, passed: verdict === "pass", verdict, text: name };
}

const LEAKED = "<invoke name=\"Bash\">\n<parameter name=\"command\">cat <<'EOF'\nפסק דין: עובר\nEOF</parameter>\n</invoke>";

let runsDir: string;
let runDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-5-3-verdict-"));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  runDir = path.join(runsDir, "run-5-3");
  await fs.mkdir(path.join(runDir, "logs"), { recursive: true });
  vi.mocked(spawnAgent).mockClear();
  vi.mocked(loadAgents).mockResolvedValue(agents);
});
afterEach(async () => {
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5 });
});

describe("splitCritiques / finalVerdictLabel", () => {
  it("מפריד עובר, לא עובר ולא הצביע, והתווית הסופית אומרת את האמת", () => {
    const set = [critique("א", "pass"), critique("ב", "fail"), critique("ג", "unreadable")];
    const split = splitCritiques(set);
    expect(split.passing.map((c) => c.name)).toEqual(["א"]);
    expect(split.failing.map((c) => c.name)).toEqual(["ב"]);
    expect(split.silent.map((c) => c.name)).toEqual(["ג"]);
    expect(finalVerdictLabel(true, set)).toBe("✅ כל המבקרים עברו");
    expect(finalVerdictLabel(false, set)).toBe("⚠️ נשארו חוסמים");
    expect(finalVerdictLabel(false, [critique("א", "pass"), critique("ג", "unreadable")])).toContain("ג לא הצביע");
  });
});

describe("critiqueRound", () => {
  const args = () => ({
    runDir, round: 1, shotGroups: [], referenceGroups: [], brandBrief: "", standard: "", pageTypeStructureBlock: "", placementBlock: "", desertWarning: "",
    emit: () => {},
  });

  it("שואל פעם נוספת מבקר שלא החזיר פסק דין, ומקבל את התשובה השנייה", async () => {
    vi.mocked(spawnAgent).mockImplementation(async (opts: { prompt: string }) => {
      if (opts.prompt.startsWith("לא החזרת פסק דין")) return { fullText: "פסק דין: לא עובר\n1. [Hero, 390] חוסם" } as never;
      if (opts.prompt.includes("אתה אורי.")) return { fullText: LEAKED } as never;
      return { fullText: "פסק דין: עובר" } as never;
    });
    const result = await critiqueRound(args());
    expect(vi.mocked(spawnAgent)).toHaveBeenCalledTimes(4);
    const uri = result.find((c) => c.slug === "uri-art-director");
    expect(uri?.verdict).toBe("fail");
    expect(uri?.passed).toBe(false);
    expect(result.filter((c) => c.verdict === "pass")).toHaveLength(2);
  });

  it("מבקר שלא ענה גם בשאלה החוזרת מסומן 'לא הצביע', לא 'לא עובר'", async () => {
    vi.mocked(spawnAgent).mockImplementation(async (opts: { prompt: string }) => {
      if (opts.prompt.includes("אתה אורי.")) return { fullText: LEAKED } as never;
      return { fullText: "פסק דין: עובר" } as never;
    });
    const result = await critiqueRound(args());
    const { failing, silent, passing } = splitCritiques(result);
    expect(failing).toHaveLength(0);
    expect(silent.map((c) => c.name)).toEqual(["אורי"]);
    expect(passing).toHaveLength(2);
    expect(finalVerdictLabel(false, result)).toContain("לא הצביע");
  });
});
