import { measureTextCells } from "@rezi-ui/core";

const TAB_STOP = 8;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Atom = {
  text: string;
  cells: number;
};

type Mode = "ground" | "esc" | "csi" | "osc" | "osc-esc";

export function displayText(raw: string): string {
  const lines: Atom[][] = [[]];
  let column = 0;
  let mode: Mode = "ground";
  let index = 0;

  const line = () => lines[lines.length - 1] ?? [];

  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    if (mode === "esc") {
      index += 1;
      if (code === 0x5b) mode = "csi";
      else if (code === 0x5d) mode = "osc";
      else mode = "ground";
      continue;
    }
    if (mode === "csi") {
      index += 1;
      if (code === 0x1b) mode = "esc";
      else if (code >= 0x40 && code <= 0x7e) mode = "ground";
      continue;
    }
    if (mode === "osc") {
      index += 1;
      if (code === 0x07) mode = "ground";
      else if (code === 0x1b) mode = "osc-esc";
      continue;
    }
    if (mode === "osc-esc") {
      index += 1;
      if (code === 0x5c) mode = "ground";
      else if (code === 0x5b) mode = "csi";
      else if (code === 0x5d) mode = "osc";
      else mode = "ground";
      continue;
    }
    if (code === 0x1b) {
      mode = "esc";
      index += 1;
      continue;
    }
    if (code === 0x0d) {
      if (raw.charCodeAt(index + 1) === 0x0a) {
        index += 1;
        continue;
      }
      column = 0;
      index += 1;
      continue;
    }
    if (code === 0x0a) {
      lines.push([]);
      column = 0;
      index += 1;
      continue;
    }
    if (code === 0x09) {
      const width = TAB_STOP - (column % TAB_STOP);
      column = writeAtom(line(), column, { text: "\t", cells: width });
      index += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      index += 1;
      continue;
    }
    const segment = graphemeAt(raw, index);
    const measured = measureTextCells(segment);
    column = writeAtom(line(), column, {
      text: segment,
      cells: measured > 0 ? measured : 0,
    });
    index += segment.length;
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

function graphemeAt(text: string, index: number): string {
  const next = graphemes.segment(text.slice(index))[Symbol.iterator]().next();
  return next.value?.segment ?? text[index] ?? "";
}

function lineText(atoms: readonly Atom[]): string {
  let text = "";
  for (const atom of atoms) text += atom.text;
  return text;
}

function writeAtom(atoms: Atom[], column: number, atom: Atom): number {
  if (atom.text === "") return column;
  const end = widthOf(atoms);
  const at = Math.min(column, end);
  if (at === end) {
    const last = atoms[atoms.length - 1];
    if (atom.cells === 0 && last) {
      last.text += atom.text;
      return at;
    }
    atoms.push(atom);
    return at + atom.cells;
  }
  const cells = explode(atoms);
  const incoming =
    atom.text === "\t" ? Array<string>(atom.cells).fill(" ") : explode([atom]);
  for (let offset = 0; offset < incoming.length; offset += 1) {
    const next = incoming[offset];
    if (next === undefined) continue;
    const slot = at + offset;
    if (slot < cells.length) cells[slot] = next;
    else cells.push(next);
  }
  atoms.splice(0, atoms.length, ...collapse(cells));
  return at + incoming.length;
}

function widthOf(atoms: readonly Atom[]): number {
  let total = 0;
  for (const atom of atoms) total += atom.cells;
  return total;
}

function explode(atoms: readonly Atom[]): string[] {
  const cells: string[] = [];
  for (const atom of atoms) {
    if (atom.text === "\t") {
      for (let index = 0; index < atom.cells; index += 1) cells.push(" ");
      continue;
    }
    const width = Math.max(atom.cells, atom.text === "" ? 0 : 1);
    cells.push(atom.text);
    for (let index = 1; index < width; index += 1) cells.push("\0");
  }
  return cells;
}

function collapse(cells: readonly string[]): Atom[] {
  const atoms: Atom[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const text = cells[index];
    if (text === undefined || text === "\0") continue;
    let width = 1;
    while (cells[index + width] === "\0") width += 1;
    atoms.push({ text, cells: width });
  }
  return atoms;
}
