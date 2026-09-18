export const MAX_BRIEF_CHARS = 50_000;
export const MAX_FEEDBACK_CHARS = 20_000;
export const MAX_EDITED_OUTPUT_CHARS = 200_000;

export function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}
