import { WIDE, ZERO_WIDTH } from "./width-data.ts";

function inTable(
  code: number,
  table: readonly (readonly [number, number])[],
): boolean {
  let low = 0;
  let high = table.length - 1;
  const first = table[0];
  const last = table[high];
  if (!first || !last || code < first[0] || code > last[1]) return false;
  while (high >= low) {
    const mid = (low + high) >> 1;
    const range = table[mid];
    if (!range) return false;
    if (code > range[1]) low = mid + 1;
    else if (code < range[0]) high = mid - 1;
    else return true;
  }
  return false;
}

/** max(0, wcwidth(code point)) from wcwidth 0.9.4 with ambiguous width 1. */
export function codePointWidth(code: number): number {
  if (code >= 32 && code < 0x7f) return 1;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (inTable(code, ZERO_WIDTH)) return 0;
  if (inTable(code, WIDE)) return 2;
  return 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += codePointWidth(char.codePointAt(0) ?? 0);
  return width;
}
