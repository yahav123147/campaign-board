import { constants } from "node:fs";
import fs from "node:fs/promises";

/** Fixed installation paths only. Never advertise a converter merely because
 * it was present on the machine used to develop the application. */
export async function availableImageSystemTools(
  platform: NodeJS.Platform = process.platform,
  executable: (file: string) => Promise<boolean> = async (file) => {
    try {
      await fs.access(file, constants.X_OK);
      return (await fs.stat(file)).isFile();
    } catch { return false; }
  },
): Promise<string[]> {
  const candidates = [
    ...(platform === "darwin" ? ["/opt/homebrew/bin/cwebp"] : []),
    "/usr/local/bin/cwebp", "/usr/bin/cwebp",
    ...(platform === "darwin" ? ["/usr/bin/sips"] : []),
  ];
  const present = await Promise.all(candidates.map(executable));
  return candidates.filter((_, index) => present[index]);
}

export function imageSystemToolsLine(tools: readonly string[]): string {
  return tools.length
    ? `כלי מערכת שאומתו כמותקנים להמרת תמונות: ${tools.map((tool) => `\`${tool}\``).join(", ")}.`
    : "לא נמצאו ממירי תמונות נוספים במערכת. השתמש במפרש Python ובכלים המפורטים למעלה.";
}
