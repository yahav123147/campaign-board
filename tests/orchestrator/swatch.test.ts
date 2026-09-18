import { describe, it, expect } from "vitest";
import { swatchColor } from "@/components/swatch";

describe("swatchColor", () => {
  it("recognises a hex colour", () => {
    expect(swatchColor("#12100E")).toBe("#12100E");
    expect(swatchColor("#fff")).toBe("#fff");
  });

  it("recognises rgba and gradients, which palettes use for cards and CTAs", () => {
    expect(swatchColor("rgba(255,255,255,0.06)")).toBe("rgba(255,255,255,0.06)");
    expect(swatchColor("linear-gradient(135deg,#e8849a,#fdc0c7,#e8849a)")).toBe(
      "linear-gradient(135deg,#e8849a,#fdc0c7,#e8849a)",
    );
  });

  it("tolerates the whitespace an agent leaves around a value", () => {
    expect(swatchColor("  #E7C333 ")).toBe("#E7C333");
  });

  it("is not fooled by code that merely mentions a colour", () => {
    expect(swatchColor("background: #fff")).toBeNull();
    expect(swatchColor("npm run dev")).toBeNull();
    expect(swatchColor("#נושא")).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(swatchColor("")).toBeNull();
  });
});
