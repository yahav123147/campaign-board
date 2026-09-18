/**
 * Shared between the orchestrator and the browser UI, so it must stay free of
 * Node-only imports. The marker prefixes the Stage 7.5 output when production
 * pauses for the client's creative-mode choice; the UI switches to the mode
 * picker on it and the express auto-approver never approves a 7.5 gate anyway.
 */
export type CreativeMode = "typography" | "ai-variation";

export const CREATIVE_MODES: readonly CreativeMode[] = ["typography", "ai-variation"];

/**
 * אסור לשנות את המחרוזת: היא נשמרת בתוך run.json כתחילית של output, וריצות
 * ישנות מזוהות דרך startsWith. שינוי נוסח היה תוקע שער פתוח בלי כפתורים.
 */
export const CREATIVE_MODE_CHOICE_MARKER = "🎛️ בחירת מצב קריאייטיב";

export function isCreativeMode(value: unknown): value is CreativeMode {
  return CREATIVE_MODES.includes(value as CreativeMode);
}

/**
 * Runner-generated feedback strings the UI start/retry buttons send. They are
 * control signals, not human feedback: the Stage 7.5 mode pause must still
 * happen when one of these arrives, because nothing is lost by pausing.
 */
export const SUBTASK_START_SENTINEL = "התחל את תת-המשימה.";
export const SUBTASK_RETRY_SENTINEL = "נסה שוב, השגיאה הקודמת תוקנה.";
export const RUNNER_FEEDBACK_SENTINELS: readonly string[] = [
  SUBTASK_START_SENTINEL,
  SUBTASK_RETRY_SENTINEL,
];
