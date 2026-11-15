// The wordmark is exactly "EdgeBoard". It is never altered in any way:
// not lowercased, not uppercased, not spaced, not restyled.

export const WORDMARK = "EdgeBoard";
const ANY_SPELLING = /e\s*d\s*g\s*e[\s_-]*b\s*o\s*a\s*r\s*d/gi;

/** Every distinct wrong spelling of the wordmark found in the text. */
export function wordmarkViolations(text) {
  return [...new Set((String(text).match(ANY_SPELLING) ?? []).filter((m) => m !== WORDMARK))];
}
