import { describe, expect, it } from "vitest";
import { availableImageSystemTools, imageSystemToolsLine } from "@/orchestrator/imageSystemTools";

describe("image converter discovery", () => {
  it("discovers Ubuntu cwebp without promising macOS tools", async () => {
    const tools = await availableImageSystemTools("linux", async (file) => file === "/usr/bin/cwebp");
    expect(tools).toEqual(["/usr/bin/cwebp"]);
    expect(imageSystemToolsLine(tools)).not.toContain("sips");
  });

  it("advertises only executable converters on either Mac architecture", async () => {
    const installed = ["/usr/local/bin/cwebp", "/usr/bin/sips"];
    expect(await availableImageSystemTools("darwin", async (file) => installed.includes(file))).toEqual(installed);
  });

  it("directs an installation without converters to the configured Python tools", async () => {
    const tools = await availableImageSystemTools("linux", async () => false);
    expect(tools).toEqual([]);
    expect(imageSystemToolsLine(tools)).toContain("Python");
    expect(imageSystemToolsLine(tools)).not.toContain("sips");
  });
});
