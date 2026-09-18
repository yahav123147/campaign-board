// What the board calls itself, and why it is not written in the UI source.
//
// The board is packaged and sent to clients (scripts/package-client.mjs), and
// the packaging scanner refuses any packaged text file that carries a tenant's
// private material, brand name included. The neutrality test asserts the same
// thing over the prompts and the UI. So an operator's own name for the board
// cannot live in a component: it is configuration, resolved here, with a
// neutral default for an installation that has not chosen one.

/** The name the board shows when the installation names none. Tenant-neutral. */
export const DEFAULT_BOARD_NAME = "בורד הקמפיינים";

/**
 * Longest name the header will show. The board name sits in a sticky bar
 * beside the progress dots, so a runaway string would push the navigation off
 * the row rather than simply look wrong.
 */
export const MAX_BOARD_NAME_CHARS = 48;

/**
 * The board's name from whatever the profile (or the config endpoint) says,
 * falling back to the neutral default.
 *
 * Anything that is not usable text resolves to the default rather than to an
 * empty header: a blank string, whitespace, a number, a missing field.
 */
export function boardNameFrom(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BOARD_NAME;
  const name = value.trim();
  if (!name) return DEFAULT_BOARD_NAME;
  return name.length > MAX_BOARD_NAME_CHARS ? name.slice(0, MAX_BOARD_NAME_CHARS).trimEnd() : name;
}
