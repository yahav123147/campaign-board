const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^(?:rgba?|hsla?|linear-gradient|radial-gradient)\([^()]*(?:\([^()]*\)[^()]*)*\)$/i;

/**
 * The CSS colour a code span holds, or null if it is ordinary code.
 * Agents write palettes as tables of `#RRGGBB`, and a hex code is not something
 * anyone can approve by reading it.
 */
export function swatchColor(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (HEX.test(value)) return value;
  if (FUNCTIONAL.test(value)) return value;
  return null;
}
