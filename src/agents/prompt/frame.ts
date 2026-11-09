import { recordAsyncDiagnostic } from "./context.ts";
import type { PromptEditor, PromptPresentation } from "./editor.ts";
import {
  diffGrid,
  layoutGrid,
  type Grid,
  type LayoutInput,
} from "./frame-render.ts";
import type {
  ColorDepth,
  HeightFact,
  TerminalColumns,
  TerminalRows,
  TerminalSize,
} from "./frame-types.ts";
import type { KeyPress } from "./parser.ts";

declare const cprRowBrand: unique symbol;
declare const cprColumnBrand: unique symbol;

export type CprRow = number & { readonly [cprRowBrand]: "cpr-row" };
export type CprColumn = number & { readonly [cprColumnBrand]: "cpr-column" };

export type CursorReport = {
  readonly row: CprRow;
  readonly column: CprColumn;
};

export type FrameOutput = {
  write(chunk: string): boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  readonly isTTY: boolean | undefined;
};

export type PaintPhase =
  | { readonly kind: "open" }
  | { readonly kind: "done"; readonly exit: "keep" | "aborting" | "exiting" };

export type InputEvent =
  | { readonly kind: "cursor"; readonly report: CursorReport }
  | { readonly kind: "key"; readonly key: KeyPress };

type CprCapability = "unknown" | "supported" | "unsupported";

type OriginState =
  | { readonly kind: "unknown" }
  | { readonly kind: "reported"; readonly minimumAvailable: number };

type SessionKind = "single" | "multiline" | "setup";

const sessions = new Map<"single" | "multiline", PromptFrame>();

const CPR_TIMEOUT_MS = 2000;
const CPR_WAIT_MS = 1000;
const CPR_WARNING =
  "WARNING: your terminal doesn't support cursor position requests (CPR).\r\n";

const CPR = /^\x1b\[(\d+);(\d+)R$/;

function isCprRow(value: number): value is CprRow {
  return Number.isInteger(value) && value >= 0;
}

function isCprColumn(value: number): value is CprColumn {
  return Number.isInteger(value) && value >= 0;
}

function isTerminalColumns(value: number): value is TerminalColumns {
  return Number.isInteger(value) && value >= 1;
}

function isTerminalRows(value: number): value is TerminalRows {
  return Number.isInteger(value) && value >= 1;
}

function positive(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1)
    return undefined;
  return value;
}

function terminalSize(
  reportedColumns: number | undefined,
  reportedRows: number | undefined,
): TerminalSize {
  const columns = positive(reportedColumns) ?? 80;
  const rows = positive(reportedRows) ?? 24;
  if (!isTerminalColumns(columns) || !isTerminalRows(rows)) {
    throw new Error("terminal size default was not positive");
  }
  return { columns, rows };
}

export function classifyInput(key: KeyPress): InputEvent {
  if (key.key !== "<cursor-position-response>") return { kind: "key", key };
  const match = CPR.exec(key.data);
  if (!match) return { kind: "key", key };
  const row = Number(match[1]);
  const column = Number(match[2]);
  if (!isCprRow(row) || !isCprColumn(column)) return { kind: "key", key };
  return { kind: "cursor", report: { row, column } };
}

function isDumbTerm(term: string | undefined): boolean {
  if (term === undefined) return false;
  const lower = term.toLowerCase();
  return lower === "dumb" || lower === "unknown";
}

function outputRespondsToCpr(
  output: FrameOutput,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (env.PROMPT_TOOLKIT_NO_CPR === "1") return false;
  if (isDumbTerm(env.TERM)) return false;
  return output.isTTY === true;
}

function namedDepth(value: string | undefined): ColorDepth | undefined {
  if (value === "DEPTH_1_BIT") return "1";
  if (value === "DEPTH_4_BIT") return "4";
  if (value === "DEPTH_8_BIT") return "8";
  if (value === "DEPTH_24_BIT") return "24";
  return undefined;
}

function colorDepthFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ColorDepth {
  if (env.NO_COLOR) return "1";
  const named = namedDepth(env.PROMPT_TOOLKIT_COLOR_DEPTH);
  if (named) return named;
  const term = env.TERM;
  if (isDumbTerm(term)) return "1";
  if (term === "linux" || term === "eterm-color") return "4";
  return "8";
}

function showBottomToolbar(
  presentation: PromptPresentation,
  phase: PaintPhase,
  height: HeightFact,
): boolean {
  if (phase.kind !== "open" || height.kind !== "known") return false;
  switch (presentation.kind) {
    case "single-search":
      return false;
    case "document":
    case "multiline-search":
      return presentation.submit.kind === "submit-help";
    default: {
      const unreachable: never = presentation;
      return unreachable;
    }
  }
}

function showSearchToolbar(
  presentation: PromptPresentation,
  phase: PaintPhase,
): boolean {
  if (phase.kind !== "open") return false;
  switch (presentation.kind) {
    case "multiline-search":
      return true;
    case "document":
    case "single-search":
      return false;
    default: {
      const unreachable: never = presentation;
      return unreachable;
    }
  }
}

function showArgumentRow(presentation: PromptPresentation): boolean {
  switch (presentation.kind) {
    case "single-search":
      return false;
    case "document":
    case "multiline-search":
      return presentation.argument.kind === "repeat";
    default: {
      const unreachable: never = presentation;
      return unreachable;
    }
  }
}

type CprWaiter = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

type CprTask = {
  readonly done: Promise<void>;
  cancel: () => void;
};

class ResetAdapter {
  paste: "off" | "on" = "off";
  cursorVisible: boolean | null = null;
  private readonly emit: (chunk: string) => void;

  constructor(emit: (chunk: string) => void) {
    this.emit = emit;
  }

  disablePaste(): void {
    this.emit("\x1b[?2004l");
  }

  // The frame never changes the cursor shape, so this source reset step writes nothing.
  resetCursorShape(): void {}

  showCursor(): void {
    if (this.cursorVisible !== false && this.cursorVisible !== null) return;
    this.cursorVisible = true;
    this.emit("\x1b[?12l\x1b[?25h");
  }

  noteDiff(hid: boolean, shown: boolean): void {
    if (hid) this.cursorVisible = false;
    if (shown) this.cursorVisible = true;
  }

  // Node already submitted the bytes. This boundary is not a drain.
  flush(): void {}
}

export class PromptFrame {
  private output: FrameOutput;
  private readonly adapter: ResetAdapter;
  private capability: CprCapability;
  private origin: OriginState = { kind: "unknown" };
  private previous: Grid | null = null;
  private cursorKeysReset = false;
  private cprTimer: ReturnType<typeof setTimeout> | undefined;
  private cprWaiters: CprWaiter[] = [];
  private cprBackground = new Set<CprTask>();
  private onUnsupported: (() => void) | undefined;

  private constructor(output: FrameOutput) {
    this.output = output;
    this.adapter = new ResetAdapter((chunk) => this.write(chunk));
    this.capability = outputRespondsToCpr(output, process.env)
      ? "unknown"
      : "unsupported";
  }

  static open(kind: SessionKind, output: FrameOutput): PromptFrame {
    if (kind === "setup") return new PromptFrame(output);
    const existing = sessions.get(kind);
    if (existing) {
      existing.output = output;
      return existing;
    }
    const created = new PromptFrame(output);
    sessions.set(kind, created);
    return created;
  }

  begin(): void {
    this.reset();
    this.askForCpr();
  }

  setCprWarning(warn: () => void): void {
    this.onUnsupported = warn;
  }

  report(report: CursorReport): void {
    const size = this.size();
    this.capability = "supported";
    this.origin = {
      kind: "reported",
      minimumAvailable: size.rows - report.row + 1,
    };
    this.cprWaiters.shift()?.resolve();
  }

  resize(): void {
    this.erase();
    this.askForCpr();
  }

  paint(editor: PromptEditor, phase: PaintPhase): void {
    if (editor.clearRequested) {
      this.clearScreen();
      editor.takeClear();
    }
    const size = this.size();
    const presentation = editor.presentation();
    const height = this.heightFact();
    const input: LayoutInput = {
      presentation,
      size,
      height,
      previousScreenHeight: this.previous?.lines.length ?? 0,
      previousDocumentScroll: this.previous?.documentScroll ?? 0,
      phase,
      depth: colorDepthFromEnv(process.env),
      bottom: showBottomToolbar(presentation, phase, height),
      search: showSearchToolbar(presentation, phase),
      argument: showArgumentRow(presentation),
    };
    const laid = layoutGrid(input);
    const diff = diffGrid({
      previous: this.previous,
      laid,
      phase,
      depth: input.depth,
      paste: this.adapter.paste,
      cursorKeysReset: this.cursorKeysReset,
    });
    this.write(diff.bytes);
    this.adapter.noteDiff(
      this.previous?.showCursor !== false,
      diff.grid.showCursor,
    );
    this.previous = diff.grid;
    this.adapter.paste = diff.paste;
    this.cursorKeysReset = diff.cursorKeysReset;
    if (phase.kind === "done") this.reset();
  }

  // Geometry is forgotten before output. CPR capability and its timer stay.
  reset(): void {
    this.previous = null;
    this.origin = { kind: "unknown" };
    if (this.adapter.paste === "on") {
      this.adapter.disablePaste();
      this.adapter.paste = "off";
    }
    this.adapter.resetCursorShape();
    this.adapter.showCursor();
    this.adapter.flush();
  }

  private size(): TerminalSize {
    return terminalSize(this.output.columns, this.output.rows);
  }

  private heightFact(): HeightFact {
    if (this.origin.kind !== "reported") return { kind: "unknown" };
    if (this.origin.minimumAvailable > 0) {
      return { kind: "known", minimumAvailable: this.origin.minimumAvailable };
    }
    return { kind: "unknown" };
  }

  private write(chunk: string): void {
    this.output.write(chunk);
  }

  askForCpr(): void {
    if (this.capability === "unsupported") return;
    if (this.capability === "supported") {
      this.enqueueCpr();
      this.write("\x1b[6n");
      return;
    }
    if (this.cprWaiters.length > 0) return;
    this.enqueueCpr();
    this.write("\x1b[6n");
    if (this.cprTimer) return;
    this.armSupportTimer();
  }

  async waitForCprResponses(): Promise<void> {
    if (this.cprWaiters.length === 0 || this.capability === "unsupported")
      return;
    const snapshot = [...this.cprWaiters];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), CPR_WAIT_MS);
    });
    const arrived = Promise.all(snapshot.map((waiter) => waiter.promise)).then(
      () => "done" as const,
    );
    const result = await Promise.race([arrived, timeout]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") {
      for (const waiter of snapshot) waiter.resolve();
      this.cprWaiters = [];
    }
  }

  async cancelCprBackgroundAndWait(): Promise<void> {
    const tasks = [...this.cprBackground];
    this.cprBackground.clear();
    for (const task of tasks) task.cancel();
    await Promise.all(tasks.map((task) => task.done));
  }

  writeCprWarning(): void {
    this.write(CPR_WARNING);
    this.adapter.flush();
  }

  erase(): void {
    const cursor = this.previous?.cursor ?? { row: 0, column: 0 };
    let bytes = "";
    if (cursor.column === 1) bytes += "\b";
    else if (cursor.column > 1) bytes += `\x1b[${cursor.column}D`;
    if (cursor.row === 1) bytes += "\x1b[A";
    else if (cursor.row > 1) bytes += `\x1b[${cursor.row}A`;
    bytes += "\x1b[J\x1b[0m\x1b[?7h";
    this.write(bytes);
    this.adapter.flush();
    this.reset();
  }

  private clearScreen(): void {
    this.erase();
    this.write("\x1b[2J\x1b[0;0H");
    this.askForCpr();
  }

  private enqueueCpr(): void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.cprWaiters.push({ promise, resolve });
  }

  private armSupportTimer(): void {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    let settled = false;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      this.cprTimer = undefined;
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      try {
        if (this.capability !== "unknown") {
          finish();
          return;
        }
        this.capability = "unsupported";
        if (outputRespondsToCpr(this.output, process.env))
          this.onUnsupported?.();
        finish();
      } catch (error) {
        finish(error);
      }
    }, CPR_TIMEOUT_MS);
    timer.unref?.();
    this.cprTimer = timer;
    const task: CprTask = {
      done: done.catch((error: unknown) => {
        recordAsyncDiagnostic("cpr-background", error);
      }),
      cancel: () => {
        clearTimeout(timer);
        finish();
      },
    };
    this.cprBackground.add(task);
  }
}
