import { randomBytes } from "node:crypto";

export function generateRunId(date: Date = new Date(), entropy?: string): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  const suffix = entropy ?? randomBytes(8).toString("hex");
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(suffix)) {
    throw new TypeError("Run id entropy must be 6-64 URL-safe characters");
  }
  return `${yyyy}-${mm}-${dd}-${hh}${mi}${ss}-${millis}-${suffix}`;
}

export function briefToSlug(brief: string): string {
  const ascii = brief
    .toLowerCase()
    .replace(/[֐-׿]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  return ascii.slice(0, 50) || "campaign";
}
