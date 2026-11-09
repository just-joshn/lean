import type { PromptPresentation } from "./editor.ts";
import type { PaintPhase } from "./frame.ts";
import type {
  ColorDepth,
  HeightFact,
  TerminalColumns,
  TerminalRows,
  TerminalSize,
} from "./frame-types.ts";
import { codePointWidth } from "./width.ts";

type CellStyle =
  | { readonly kind: "plain" }
  | { readonly kind: "reverse" }
  | { readonly kind: "bold-reverse-key" }
  | { readonly kind: "toolbar-label" }
  | { readonly kind: "toolbar-value" }
  | { readonly kind: "search-match" }
  | { readonly kind: "too-small" }
  | { readonly kind: "exit"; readonly exit: "aborting" | "exiting" };

type StyledSpan = { readonly text: string; readonly style: CellStyle };

type Cell =
  | {
      readonly kind: "char";
      readonly text: string;
      readonly width: 1 | 2;
      readonly style: CellStyle;
      readonly tag?: string;
    }
  | { readonly kind: "wide-tail" }
  | { readonly kind: "empty" };

type GridCursor = { readonly row: number; readonly column: number };

export type Grid = {
  readonly columns: TerminalColumns;
  readonly rows: TerminalRows;
  readonly documentScroll: number;
  readonly showCursor: boolean;
  readonly lines: readonly (readonly Cell[])[];
  readonly cursor: GridCursor;
};

export type LayoutInput = {
  readonly presentation: PromptPresentation;
  readonly size: TerminalSize;
  readonly height: HeightFact;
  readonly previousScreenHeight: number;
  readonly previousDocumentScroll: number;
  readonly phase: PaintPhase;
  readonly depth: ColorDepth;
  readonly bottom: boolean;
  readonly search: boolean;
  readonly argument: boolean;
};

type LaidOut =
  | { readonly kind: "grid"; readonly grid: Grid }
  | { readonly kind: "too-small"; readonly grid: Grid };

type DiffBytes = {
  readonly bytes: string;
  readonly grid: Grid;
  readonly paste: "off" | "on";
  readonly cursorKeysReset: boolean;
};

type DiffInput = {
  readonly previous: Grid | null;
  readonly laid: LaidOut;
  readonly phase: PaintPhase;
  readonly depth: ColorDepth;
  readonly paste: "off" | "on";
  readonly cursorKeysReset: boolean;
};

const BOTTOM_TOOLBAR_SPANS: readonly StyledSpan[] = [
  { text: "Submit message: ", style: { kind: "reverse" } },
  { text: "Esc, then Enter", style: { kind: "bold-reverse-key" } },
  { text: " | Navigate history: ", style: { kind: "reverse" } },
  { text: "Arrow Up/Down", style: { kind: "bold-reverse-key" } },
  { text: " | Search history: ", style: { kind: "reverse" } },
  { text: "Ctrl+R", style: { kind: "bold-reverse-key" } },
];

const SEARCH_LINE_PREFIX: Readonly<Record<"backward" | "forward", string>> = {
  backward: "(reverse-i-search)`",
  forward: "(i-search)`",
};

const SEARCH_LINE_SUFFIX = "': ";

const SEARCH_TOOLBAR_PREFIX: Readonly<Record<"backward" | "forward", string>> =
  {
    backward: "I-search backward: ",
    forward: "I-search: ",
  };

const WINDOW_TOO_SMALL = " Window too small... ";
const REPEAT_LABEL = "Repeat: ";

function openScreenRows(
  terminalRows: number,
  minimumAvailable: number,
  previousScreenHeight: number,
  preferredHeight: number,
): number {
  return Math.min(
    terminalRows,
    Math.max(minimumAvailable, previousScreenHeight, preferredHeight),
  );
}

function doneScreenRows(terminalRows: number, preferredHeight: number): number {
  return Math.min(terminalRows, preferredHeight);
}

export function layoutGrid(input: LayoutInput): LaidOut {
  const preferred = preferredRows(input);
  const canvas =
    input.phase.kind === "done"
      ? doneScreenRows(input.size.rows, preferred)
      : openScreenRows(
          input.size.rows,
          input.height.kind === "known" ? input.height.minimumAvailable : 0,
          input.previousScreenHeight,
          preferred,
        );
  return raster(input, canvas);
}

const PLAIN: CellStyle = { kind: "plain" };
const EMPTY: Cell = { kind: "empty" };
type Character = Extract<Cell, { kind: "char" }>;
type Body = { lines: Cell[][]; cursor: GridCursor };

function character(
  text: string,
  style: CellStyle = PLAIN,
  tag?: string,
): Character {
  return {
    kind: "char",
    text,
    width: codePointWidth(text.codePointAt(0) ?? 0) === 2 ? 2 : 1,
    style,
    tag,
  };
}

function spanCells(spans: readonly StyledSpan[], tag?: string): Cell[] {
  const cells: Cell[] = [];
  for (const span of spans) {
    for (const text of span.text) {
      if (codePointWidth(text.codePointAt(0) ?? 0) === 0) {
        const index =
          cells.at(-1)?.kind === "wide-tail"
            ? cells.length - 2
            : cells.length - 1;
        const base = cells[index];
        if (base?.kind === "char")
          cells[index] = { ...base, text: base.text + text };
      } else {
        const cell = character(text, span.style, tag);
        cells.push(cell);
        if (cell.width === 2) cells.push({ kind: "wide-tail" });
      }
    }
  }
  return cells;
}

function textWidth(text: string): number {
  return Array.from(text).reduce(
    (width, point) => width + codePointWidth(point.codePointAt(0) ?? 0),
    0,
  );
}

function searchSpans(
  text: string,
  needle: string,
  cursor: number,
): StyledSpan[] {
  if (!needle) return [{ text, style: PLAIN }];
  const spans: StyledSpan[] = [];
  let start = 0;
  let match = text.indexOf(needle);
  while (match >= 0) {
    spans.push({ text: text.slice(start, match), style: PLAIN });
    const pointIndex = Array.from(text.slice(0, match)).length;
    const current =
      pointIndex <= cursor && cursor < pointIndex + Array.from(needle).length;
    spans.push({
      text: needle,
      style: current ? { kind: "search-match" } : PLAIN,
    });
    start = match + needle.length;
    match = text.indexOf(needle, start);
  }
  spans.push({ text: text.slice(start), style: PLAIN });
  return spans;
}

function documentBody(input: LayoutInput): Body {
  const view = input.presentation;
  if (view.kind === "single-search") {
    const prefix = SEARCH_LINE_PREFIX[view.direction];
    const cells = spanCells(
      [
        { text: prefix + view.needle + SEARCH_LINE_SUFFIX, style: PLAIN },
        ...searchSpans(view.line, view.needle, view.cursorInLine),
        { text: " ", style: PLAIN },
      ],
      "search",
    );
    const cursor = textWidth(
      prefix + Array.from(view.needle).slice(0, view.needleCursor).join(""),
    );
    const scroll = Math.max(0, cursor - input.size.columns + 1);
    return {
      lines: [cells.slice(scroll, scroll + input.size.columns)],
      cursor: { row: 0, column: cursor - scroll },
    };
  }
  const prefix =
    view.argument.kind === "inline" ? `(arg: ${view.argument.text}) ` : "";
  const prefixLength = Array.from(prefix).length;
  const points = Array.from(prefix + view.text);
  const matchStart =
    view.kind === "multiline-search" &&
    view.needle &&
    Array.from(view.text)
      .slice(view.cursor, view.cursor + Array.from(view.needle).length)
      .join("") === view.needle
      ? view.cursor + prefixLength
      : -1;
  const matchEnd =
    matchStart < 0 || view.kind !== "multiline-search"
      ? -1
      : matchStart + Array.from(view.needle).length;
  const lines: Cell[][] = [[]];
  let row = 0;
  let column = 0;
  let cursor: GridCursor = { row: 0, column: 0 };
  const put = (text: string, style: CellStyle, tag?: string) => {
    const width = codePointWidth(text.codePointAt(0) ?? 0);
    if (width === 0) {
      const line = lines[row]!;
      const index = line.at(-1)?.kind === "wide-tail" ? column - 2 : column - 1;
      const base = line[index];
      if (base?.kind === "char")
        line[index] = { ...base, text: base.text + text };
    } else {
      lines[row]![column] = character(text, style, tag);
      if (width === 2) lines[row]![column + 1] = { kind: "wide-tail" };
    }
    column += width;
  };
  for (let index = 0; index <= points.length; index++) {
    const point = points[index];
    const end = point === undefined || point === "\n";
    const text = end ? " " : point;
    const width = codePointWidth(text.codePointAt(0) ?? 0);
    if (column + width > input.size.columns) {
      row++;
      column = 0;
      lines.push([]);
    }
    if (index === view.cursor + prefixLength) cursor = { row, column };
    const style: CellStyle =
      !end && index >= matchStart && index < matchEnd
        ? { kind: "search-match" }
        : PLAIN;
    put(text, style, index < prefixLength ? "argument" : undefined);
    if (point === "\n") {
      row++;
      column = 0;
      lines.push([]);
    }
  }
  return { lines, cursor };
}

function preferredRows(input: LayoutInput): number {
  return (
    documentBody(input).lines.length +
    Number(input.bottom) +
    Number(input.search) +
    Number(input.argument)
  );
}

function raster(input: LayoutInput, canvas: number): LaidOut {
  const columns = input.size.columns;
  const chrome =
    Number(input.bottom) + Number(input.search) + Number(input.argument);
  const tooSmall = chrome > canvas;
  const lines: Cell[][] = Array.from({ length: canvas }, () =>
    Array<Cell>(columns).fill(EMPTY),
  );
  let cursor: GridCursor = { row: 0, column: 0 };
  let documentScroll = 0;
  const lastLine = (row: number) => {
    const line = lines[row];
    if (!line) return;
    for (let x = 0; x < columns; x++) {
      const cell = line[x];
      if (cell?.kind === "char")
        line[x] = { ...cell, tag: `${cell.tag ?? ""} last-line` };
      else if (cell?.kind !== "wide-tail")
        line[x] = character(" ", PLAIN, "transparent last-line");
    }
  };
  const clippedRow = (row: number, cells: Cell[], fill: Cell = EMPTY) => {
    if (!lines[row]) return;
    lines[row] = Array.from({ length: columns }, (_, x) => cells[x] ?? fill);
    lastLine(row);
  };
  if (tooSmall) {
    const cells = spanCells([
      { text: WINDOW_TOO_SMALL, style: { kind: "too-small" } },
    ]);
    lines[0] = Array.from({ length: columns }, (_, x) => cells[x] ?? EMPTY);
    lastLine(canvas - 1);
  } else {
    const body = documentBody(input);
    const bodyHeight = canvas - chrome;
    documentScroll = Math.min(
      input.previousDocumentScroll,
      Math.max(0, body.lines.length - bodyHeight),
    );
    documentScroll = Math.max(
      Math.min(documentScroll, body.cursor.row),
      body.cursor.row - bodyHeight + 1,
      0,
    );
    for (let row = 0; row < bodyHeight; row++) {
      const line = body.lines[row + documentScroll] ?? [];
      lines[row] = Array.from({ length: columns }, (_, x) => line[x] ?? EMPTY);
    }
    lastLine(bodyHeight - 1);
    cursor = {
      row: Math.max(0, body.cursor.row - documentScroll),
      column: body.cursor.column,
    };
    let row = bodyHeight;
    const view = input.presentation;
    if (
      input.argument &&
      view.kind !== "single-search" &&
      view.argument.kind === "repeat"
    ) {
      clippedRow(
        row++,
        spanCells([
          { text: REPEAT_LABEL, style: { kind: "toolbar-label" } },
          { text: view.argument.text, style: { kind: "toolbar-value" } },
        ]),
      );
    }
    if (input.search && view.kind === "multiline-search") {
      const prefix = SEARCH_TOOLBAR_PREFIX[view.direction];
      const cells = spanCells([
        { text: prefix, style: { kind: "toolbar-label" } },
        { text: view.needle, style: { kind: "toolbar-value" } },
        { text: " ", style: { kind: "toolbar-label" } },
      ]);
      const column = textWidth(
        prefix + Array.from(view.needle).slice(0, view.needleCursor).join(""),
      );
      const scroll = Math.max(0, column - columns + 1);
      clippedRow(
        row,
        cells.slice(scroll),
        character(" ", { kind: "toolbar-label" }, "transparent"),
      );
      cursor = { row: row++, column: column - scroll };
    }
    if (input.bottom) {
      clippedRow(
        row,
        spanCells(BOTTOM_TOOLBAR_SPANS),
        character(" ", { kind: "reverse" }),
      );
    }
  }
  if (input.phase.kind === "done" && input.phase.exit !== "keep") {
    const style: CellStyle = { kind: "exit", exit: input.phase.exit };
    for (const line of lines) {
      for (let x = 0; x < columns; x++) {
        const cell = line[x];
        if (cell?.kind === "char") line[x] = { ...cell, style };
        else if (cell?.kind !== "wide-tail")
          line[x] = character(" ", style, "transparent");
      }
    }
  }
  return {
    kind: tooSmall ? "too-small" : "grid",
    grid: {
      columns,
      rows: input.size.rows,
      documentScroll,
      showCursor: !tooSmall,
      lines,
      cursor,
    },
  };
}

function styleBytes(style: CellStyle, depth: ColorDepth): string {
  switch (style.kind) {
    case "reverse":
    case "search-match":
      return "\x1b[0;7m";
    case "bold-reverse-key":
      return "\x1b[0;1;7m";
    case "toolbar-label":
      return "\x1b[0;1m";
    case "exit":
      return {
        "1": "\x1b[0m",
        "4": "\x1b[0;90m",
        "8": "\x1b[0;38;5;102m",
        "24": "\x1b[0;38;2;136;136;136m",
      }[depth];
    case "too-small":
      return {
        "1": "\x1b[0m",
        "4": "\x1b[0;97;41m",
        "8": "\x1b[0;38;5;231;48;5;52m",
        "24": "\x1b[0;38;2;255;255;255;48;2;85;0;0m",
      }[depth];
    default:
      return "\x1b[0m";
  }
}

function cellKey(cell: Cell): string {
  if (cell.kind === "empty") return "transparent";
  if (cell.kind === "wide-tail") return "wide-tail";
  return `${cell.style.kind === "plain" ? "" : cell.style.kind}${cell.tag ?? ""}`;
}

function contentColumn(line: readonly Cell[]): number {
  let last = 0;
  for (let x = 0; x < line.length; x++) {
    const cell = line[x];
    if (
      cell?.kind === "wide-tail" ||
      (cell?.kind === "char" &&
        (cell.text !== " " ||
          [
            "reverse",
            "bold-reverse-key",
            "search-match",
            "exit",
            "too-small",
          ].includes(cell.style.kind)))
    )
      last = x;
  }
  return last;
}

export function diffGrid(input: DiffInput): DiffBytes {
  const grid = input.laid.grid;
  const width = grid.columns;
  const sameSize =
    input.previous?.columns === width && input.previous.rows === grid.rows;
  let previous = sameSize ? input.previous : null;
  let cursor = input.previous?.cursor ?? { row: 0, column: 0 };
  let bytes = input.paste === "off" ? "\x1b[?2004h" : "";
  if (!input.cursorKeysReset) bytes += "\x1b[?1l";
  if (input.previous?.showCursor !== false) bytes += "\x1b[?25l";
  let lastKey: string | null = null;
  let lastAttrs: string | null = null;
  const reset = () => {
    bytes += "\x1b[0m";
    lastKey = lastAttrs = null;
  };
  const forward = (amount: number) =>
    amount === 0 ? "" : amount === 1 ? "\x1b[C" : `\x1b[${amount}C`;
  const backward = (amount: number) =>
    amount === 0 ? "" : amount === 1 ? "\b" : `\x1b[${amount}D`;
  const move = (next: GridCursor) => {
    const column = cursor.column;
    if (next.row > cursor.row) {
      reset();
      bytes += "\r\n".repeat(next.row - cursor.row) + forward(next.column);
      cursor = next;
      return;
    }
    if (next.row < cursor.row) {
      const amount = cursor.row - next.row;
      bytes += amount === 1 ? "\x1b[A" : `\x1b[${amount}A`;
    }
    if (column >= width - 1) bytes += "\r" + forward(next.column);
    else if (next.column < column) bytes += backward(column - next.column);
    else if (next.column > column) bytes += forward(next.column - column);
    cursor = next;
  };
  if (!previous) reset();
  bytes += "\x1b[?7l";
  if (input.phase.kind === "done" || !previous) {
    move({ row: 0, column: 0 });
    reset();
    bytes += "\x1b[J";
    previous = null;
  }
  const previousHeight = previous?.lines.length ?? 0;
  for (
    let row = 0;
    row < Math.min(Math.max(grid.lines.length, previousHeight), grid.rows);
    row++
  ) {
    const line = grid.lines[row] ?? [];
    const old = previous?.lines[row] ?? [];
    const last = Math.min(width - 1, contentColumn(line));
    for (let column = 0; column <= last;) {
      const cell = line[column] ?? EMPTY;
      const before = old[column] ?? EMPTY;
      const text =
        cell.kind === "char" ? cell.text : cell.kind === "wide-tail" ? "" : " ";
      const oldText =
        before.kind === "char"
          ? before.text
          : before.kind === "wide-tail"
            ? ""
            : " ";
      const charWidth = cell.kind === "char" ? cell.width : 1;
      if (text !== oldText || cellKey(cell) !== cellKey(before)) {
        move({ row, column });
        const attrs = styleBytes(
          cell.kind === "char" ? cell.style : PLAIN,
          input.depth,
        );
        const key = cellKey(cell);
        if (lastKey !== key) {
          if (!lastKey || attrs !== lastAttrs) bytes += attrs;
          lastKey = key;
          lastAttrs = attrs;
        }
        bytes += text;
        cursor = { row, column: column + charWidth };
      }
      column += charWidth;
    }
    if (last < Math.min(width - 1, contentColumn(old))) {
      move({ row, column: last + 1 });
      reset();
      bytes += "\x1b[K";
    }
  }
  if (grid.lines.length > previousHeight)
    move({ row: grid.lines.length - 1, column: 0 });
  if (input.phase.kind === "done") {
    move({ row: grid.lines.length, column: 0 });
    bytes += "\x1b[J";
  } else move(grid.cursor);
  bytes += "\x1b[?7h";
  reset();
  if (grid.showCursor) bytes += "\x1b[?12l\x1b[?25h";
  return {
    bytes,
    grid: { ...grid, cursor },
    paste: "on",
    cursorKeysReset: true,
  };
}
