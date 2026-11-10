export type Doc = { text: string; cursor: number };

export function pointsOf(text: string): string[] {
  return Array.from(text);
}

export function fromPoints(points: string[]): string {
  return points.join("");
}

function lineStarts(points: string[]): number[] {
  const starts = [0];
  for (let index = 0; index < points.length; index += 1) {
    if (points[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function lineIndex(doc: Doc): {
  row: number;
  start: number;
  end: number;
} {
  const points = pointsOf(doc.text);
  const starts = lineStarts(points);
  let row = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    if (start <= doc.cursor) row = index;
  }
  const start = starts[row] ?? 0;
  const next = starts[row + 1];
  const end = next === undefined ? points.length : next - 1;
  return { row, start, end };
}

export function columnOf(doc: Doc): number {
  return doc.cursor - lineIndex(doc).start;
}

export function lineCount(text: string): number {
  return lineStarts(pointsOf(text)).length;
}

export function insertText(doc: Doc, data: string, overwrite = false): Doc {
  const points = pointsOf(doc.text);
  const chunk = pointsOf(data);
  if (overwrite) {
    let count = 0;
    while (
      count < chunk.length &&
      points[doc.cursor + count] !== "\n" &&
      doc.cursor + count < points.length
    )
      count += 1;
    points.splice(doc.cursor, count, ...chunk);
  } else {
    points.splice(doc.cursor, 0, ...chunk);
  }
  return { text: fromPoints(points), cursor: doc.cursor + chunk.length };
}

export function deleteForward(
  doc: Doc,
  count: number,
): { doc: Doc; deleted: string } {
  if (count < 0) return deleteBackward(doc, -count);
  const points = pointsOf(doc.text);
  const deleted = points.splice(doc.cursor, Math.max(0, count));
  return {
    doc: { text: fromPoints(points), cursor: doc.cursor },
    deleted: fromPoints(deleted),
  };
}

export function deleteBackward(
  doc: Doc,
  count: number,
): { doc: Doc; deleted: string } {
  if (count < 0) return deleteForward(doc, -count);
  const start = Math.max(0, doc.cursor - count);
  const points = pointsOf(doc.text);
  const deleted = points.splice(start, doc.cursor - start);
  return {
    doc: { text: fromPoints(points), cursor: start },
    deleted: fromPoints(deleted),
  };
}

export function moveHorizontally(doc: Doc, delta: number): Doc {
  const { start, end } = lineIndex(doc);
  return {
    text: doc.text,
    cursor: Math.min(end, Math.max(start, doc.cursor + delta)),
  };
}

export function lineEdge(doc: Doc, edge: "start" | "end"): Doc {
  const { start, end } = lineIndex(doc);
  return { text: doc.text, cursor: edge === "start" ? start : end };
}

export function bufferEdge(doc: Doc, edge: "start" | "end"): Doc {
  return {
    text: doc.text,
    cursor: edge === "start" ? 0 : pointsOf(doc.text).length,
  };
}

export function indexAt(text: string, row: number, column: number): number {
  const points = pointsOf(text);
  const starts = lineStarts(points);
  const safeRow = Math.max(0, Math.min(row, starts.length - 1));
  const start = starts[safeRow] ?? 0;
  const next = starts[safeRow + 1];
  const end = next === undefined ? points.length : next - 1;
  return Math.max(
    0,
    Math.min(points.length, start + Math.max(0, Math.min(column, end - start))),
  );
}

export function leadingWhitespace(doc: Doc): string {
  const { start, end } = lineIndex(doc);
  const line = fromPoints(pointsOf(doc.text).slice(start, end));
  return line.slice(0, line.length - line.trimStart().length);
}

function isWordChar(char: string): boolean {
  return char.length === 1 && /[A-Za-z0-9_]/.test(char);
}

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

function words(
  chars: string[],
  big: boolean,
): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index] ?? "";
    if (isSpace(char)) {
      index += 1;
      continue;
    }
    const start = index;
    if (big) {
      while (index < chars.length && !isSpace(chars[index] ?? "")) index += 1;
    } else if (isWordChar(char)) {
      while (index < chars.length && isWordChar(chars[index] ?? "")) index += 1;
    } else {
      while (
        index < chars.length &&
        !isSpace(chars[index] ?? "") &&
        !isWordChar(chars[index] ?? "")
      )
        index += 1;
    }
    found.push({ start, end: index });
  }
  return found;
}

export function previousWordStart(
  doc: Doc,
  count: number,
  big: boolean,
): number | null {
  const chars = pointsOf(doc.text).slice(0, doc.cursor).reverse();
  const match = words(chars, big)[count - 1];
  return match ? -match.end : null;
}

export function nextWordEnd(
  doc: Doc,
  count: number,
  big: boolean,
): number | null {
  const after = pointsOf(doc.text).slice(doc.cursor + 1);
  const match = words(after, big)[count - 1];
  return match ? match.end + 1 : null;
}

export function findForward(
  doc: Doc,
  needle: string,
  includeCurrent: boolean,
): number | null {
  if (!needle) return includeCurrent ? 0 : null;
  const after = pointsOf(doc.text).slice(
    includeCurrent ? doc.cursor : doc.cursor + 1,
  );
  const haystack = fromPoints(after);
  const at = haystack.indexOf(needle);
  if (at < 0) return null;
  const pointIndex = pointsOf(haystack.slice(0, at)).length;
  return includeCurrent ? pointIndex : pointIndex + 1;
}

export function findBackward(doc: Doc, needle: string): number | null {
  if (!needle) return null;
  const before = pointsOf(doc.text).slice(0, doc.cursor).reverse();
  const haystack = fromPoints(before);
  const reversed = fromPoints(pointsOf(needle).reverse());
  const at = haystack.indexOf(reversed);
  if (at < 0) return null;
  const pointIndex = pointsOf(haystack.slice(0, at)).length;
  return -pointIndex - pointsOf(needle).length;
}
