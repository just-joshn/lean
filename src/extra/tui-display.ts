import { measureTextCells } from "@rezi-ui/core";

const TAB_STOP = 8;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Atom = {
  text: string;
  cells: number;
};

type Line = {
  atoms: Atom[];
  end: number;
};

type Mode = "ground" | "esc" | "csi" | "osc" | "osc-esc";

export function displayText(raw: string): string {
  const lines: Line[] = [];
  let line = blank();
  lines.push(line);
  let column = 0;
  for (const { segment } of graphemes.segment(stripControls(raw))) {
    if (hasLayout(segment)) {
      for (const char of segment) {
        if (char === "\n") {
          line = blank();
          lines.push(line);
          column = 0;
          continue;
        }
        if (char === "\r") {
          column = 0;
          continue;
        }
        if (char === "\t") {
          const width = TAB_STOP - (column % TAB_STOP);
          column = place(line, column, { text: "\t", cells: width });
          continue;
        }
        const measured = measureTextCells(char);
        column = place(line, column, {
          text: char,
          cells: measured > 0 ? measured : 0,
        });
      }
      continue;
    }
    const measured = measureTextCells(segment);
    column = place(line, column, {
      text: segment,
      cells: measured > 0 ? measured : 0,
    });
  }
  return lines.map(lineText).join("\n");
}

export function joinSections(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (part === "") continue;
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += part;
  }
  return out;
}

function blank(): Line {
  return { atoms: [], end: 0 };
}

function hasLayout(segment: string): boolean {
  return (
    segment.includes("\n") || segment.includes("\r") || segment.includes("\t")
  );
}

function lineText(line: Line): string {
  let text = "";
  for (const atom of line.atoms) text += atom.text;
  return text;
}

function place(line: Line, column: number, atom: Atom): number {
  if (atom.text === "") return column;
  if (atom.cells === 0) return placeMark(line, column, atom.text);
  if (column >= line.end) {
    line.atoms.push(atom);
    line.end += atom.cells;
    return line.end;
  }
  const writing =
    atom.text === "\t"
      ? { text: " ".repeat(atom.cells), cells: atom.cells }
      : atom;
  const start = column;
  const endCol = column + writing.cells;
  const next: Atom[] = [];
  let cursor = 0;
  let inserted = false;
  for (const current of line.atoms) {
    const atomStart = cursor;
    const atomEnd = cursor + current.cells;
    if (current.cells === 0) {
      if (atomStart < start || atomStart >= endCol) next.push(current);
      continue;
    }
    cursor = atomEnd;
    if (atomEnd <= start || atomStart >= endCol) {
      next.push(current);
      continue;
    }
    const left = Math.max(0, start - atomStart);
    const right = Math.max(0, atomEnd - endCol);
    if (left > 0) next.push({ text: " ".repeat(left), cells: left });
    if (!inserted) {
      next.push(writing);
      inserted = true;
    }
    if (right > 0) next.push({ text: " ".repeat(right), cells: right });
  }
  if (!inserted) next.push(writing);
  line.atoms = next;
  line.end = 0;
  for (const item of next) line.end += item.cells;
  return endCol;
}

function placeMark(line: Line, column: number, text: string): number {
  if (line.atoms.length === 0 || column >= line.end) {
    const last = line.atoms[line.atoms.length - 1];
    if (last && last.text !== "\t") last.text += text;
    else line.atoms.push({ text, cells: 0 });
    return column;
  }
  let cursor = 0;
  for (const [index, atom] of line.atoms.entries()) {
    const atomEnd = cursor + atom.cells;
    const covers =
      atom.cells > 0 ? column >= cursor && column < atomEnd : column === cursor;
    if (covers) {
      if (atom.text === "\t") {
        line.atoms.splice(index + 1, 0, { text, cells: 0 });
      } else atom.text += text;
      return column;
    }
    if (atom.cells > 0) cursor = atomEnd;
  }
  line.atoms.push({ text, cells: 0 });
  return column;
}

function stripControls(raw: string): string {
  const out: string[] = [];
  let mode: Mode = "ground";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const kept = raw.charAt(index);
    if (mode === "esc") {
      if (code === 0x5b) mode = "csi";
      else if (code === 0x5d) mode = "osc";
      else mode = "ground";
      continue;
    }
    if (mode === "csi") {
      if (code === 0x1b) mode = "esc";
      else if (code >= 0x40 && code <= 0x7e) mode = "ground";
      continue;
    }
    if (mode === "osc") {
      if (code === 0x07) mode = "ground";
      else if (code === 0x1b) mode = "osc-esc";
      continue;
    }
    if (mode === "osc-esc") {
      if (code === 0x5c) mode = "ground";
      else if (code === 0x5b) mode = "csi";
      else if (code === 0x5d) mode = "osc";
      else mode = "ground";
      continue;
    }
    if (code === 0x1b) {
      mode = "esc";
      continue;
    }
    if (code === 0x0d || code === 0x0a || code === 0x09) {
      out.push(kept);
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    out.push(kept);
  }
  return out.join("");
}
