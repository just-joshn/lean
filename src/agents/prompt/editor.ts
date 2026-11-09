import { EOFError, KeyboardInterrupt } from "../../exceptions.ts";
import type { KeyPress } from "./parser.ts";
import {
  type Doc,
  bufferEdge,
  columnOf,
  deleteBackward,
  deleteForward,
  findBackward,
  findForward,
  fromPoints,
  indexAt,
  insertText,
  leadingWhitespace,
  lineCount,
  lineEdge,
  lineIndex,
  moveHorizontally,
  nextWordEnd,
  pointsOf,
  previousWordStart,
} from "./document.ts";

export type EditorOutcome =
  | { kind: "pending" }
  | { kind: "accept"; text: string }
  | { kind: "error"; error: EOFError | KeyboardInterrupt };

export type SearchDirection = "backward" | "forward";

export type SubmitRow =
  { readonly kind: "none" } | { readonly kind: "submit-help" };

export type ArgumentRow =
  | { readonly kind: "hidden" }
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "repeat"; readonly text: string };

export type NeedleEdit = "end-only";

export type DocumentView = {
  readonly kind: "document";
  readonly text: string;
  readonly cursor: number;
  readonly submit: SubmitRow;
  readonly argument: ArgumentRow;
};

export type SingleSearchView = {
  readonly kind: "single-search";
  readonly direction: SearchDirection;
  readonly needle: string;
  readonly needleCursor: number;
  readonly needleEdit: NeedleEdit;
  readonly line: string;
  readonly cursorInLine: number;
};

export type MultilineSearchView = {
  readonly kind: "multiline-search";
  readonly direction: SearchDirection;
  readonly needle: string;
  readonly needleCursor: number;
  readonly needleEdit: NeedleEdit;
  readonly text: string;
  readonly cursor: number;
  readonly submit: SubmitRow;
  readonly argument: ArgumentRow;
};

export type PromptPresentation =
  DocumentView | SingleSearchView | MultilineSearchView;

type Command =
  | "ignore"
  | "self-insert"
  | "newline"
  | "accept"
  | "accept-search"
  | "abort-search"
  | "start-search-backward"
  | "start-search-forward"
  | "search-again-backward"
  | "search-again-forward"
  | "search-backspace"
  | "search-insert"
  | "eof"
  | "interrupt"
  | "delete-char"
  | "backward-delete"
  | "delete-to-end"
  | "kill-word"
  | "backward-kill-word"
  | "unix-rubout"
  | "unix-line-discard"
  | "yank"
  | "left"
  | "right"
  | "up"
  | "down"
  | "line-start"
  | "line-end"
  | "buffer-start"
  | "buffer-end"
  | "word-left"
  | "word-right"
  | "word-end"
  | "history-up"
  | "history-down"
  | "quoted"
  | "clear"
  | "transpose"
  | "transpose-words"
  | "digit"
  | "negative"
  | "paste"
  | "refeed-enter";

type Binding = {
  keys: string[];
  command: Command;
  when?: (editor: PromptEditor) => boolean;
  eager?: boolean;
};

const searching = (editor: PromptEditor) => editor.searching;
const editing = (editor: PromptEditor) => !editor.searching;

const bindings: Binding[] = [
  { keys: ["<cursor-position-response>"], command: "ignore" },
  { keys: ["<vt100-mouse-event>"], command: "ignore" },
  { keys: ["<ignore>"], command: "ignore" },
  { keys: ["c-c"], command: "abort-search", when: searching },
  { keys: ["c-g"], command: "abort-search", when: searching },
  { keys: ["c-c"], command: "interrupt", when: editing },
  { keys: ["<sigint>"], command: "interrupt" },
  { keys: ["escape", "c-m"], command: "accept", when: editing },
  { keys: ["escape", "c-j"], command: "accept", when: editing },
  { keys: ["c-m"], command: "accept-search", when: searching },
  { keys: ["c-j"], command: "refeed-enter" },
  {
    keys: ["c-m"],
    command: "newline",
    when: (editor) => editing(editor) && editor.multiline,
  },
  {
    keys: ["c-m"],
    command: "accept",
    when: (editor) => editing(editor) && !editor.multiline,
  },
  {
    keys: ["c-d"],
    command: "eof",
    when: (editor) => editing(editor) && editor.text.length === 0,
  },
  {
    keys: ["c-d"],
    command: "delete-char",
    when: (editor) => editing(editor) && editor.text.length > 0,
  },
  { keys: ["c-h"], command: "search-backspace", when: searching },
  { keys: ["backspace"], command: "search-backspace", when: searching },
  { keys: ["c-h"], command: "backward-delete", when: editing },
  { keys: ["backspace"], command: "backward-delete", when: editing },
  { keys: ["c-r"], command: "search-again-backward", when: searching },
  { keys: ["c-s"], command: "search-again-forward", when: searching },
  { keys: ["c-r"], command: "start-search-backward", when: editing },
  { keys: ["c-s"], command: "start-search-forward", when: editing },
  { keys: ["escape"], command: "accept-search", when: searching, eager: true },
  { keys: ["escape"], command: "ignore", when: editing },
  { keys: ["left"], command: "left", when: editing },
  { keys: ["right"], command: "right", when: editing },
  { keys: ["c-b"], command: "left", when: editing },
  { keys: ["c-f"], command: "right", when: editing },
  { keys: ["up"], command: "up", when: editing },
  { keys: ["down"], command: "down", when: editing },
  { keys: ["c-p"], command: "up", when: editing },
  { keys: ["c-n"], command: "down", when: editing },
  { keys: ["c-a"], command: "line-start", when: editing },
  { keys: ["home"], command: "line-start", when: editing },
  { keys: ["c-e"], command: "line-end", when: editing },
  { keys: ["end"], command: "line-end", when: editing },
  { keys: ["c-up"], command: "history-up", when: editing },
  { keys: ["c-down"], command: "history-down", when: editing },
  { keys: ["escape", "up"], command: "history-up", when: editing },
  { keys: ["escape", "down"], command: "history-down", when: editing },
  { keys: ["escape", "<"], command: "buffer-start", when: editing },
  { keys: ["escape", ">"], command: "buffer-end", when: editing },
  { keys: ["escape", "b"], command: "word-left", when: editing },
  { keys: ["escape", "f"], command: "word-right", when: editing },
  { keys: ["c-left"], command: "word-left", when: editing },
  { keys: ["c-right"], command: "word-right", when: editing },
  { keys: ["escape", "left"], command: "word-left", when: editing },
  { keys: ["escape", "right"], command: "word-right", when: editing },
  { keys: ["delete"], command: "delete-char", when: editing },
  { keys: ["c-k"], command: "delete-to-end", when: editing },
  { keys: ["c-u"], command: "unix-line-discard", when: editing },
  { keys: ["c-w"], command: "unix-rubout", when: editing },
  { keys: ["escape", "d"], command: "kill-word", when: editing },
  { keys: ["escape", "delete"], command: "kill-word", when: editing },
  {
    keys: ["escape", "backspace"],
    command: "backward-kill-word",
    when: editing,
  },
  { keys: ["c-y"], command: "yank", when: editing },
  { keys: ["c-q"], command: "quoted", when: editing },
  { keys: ["c-z"], command: "self-insert", when: editing },
  { keys: ["c-l"], command: "clear", when: editing },
  { keys: ["c-t"], command: "transpose", when: editing },
  { keys: ["escape", "t"], command: "transpose-words", when: editing },
  { keys: ["<bracketed-paste>"], command: "paste" },
  { keys: ["escape", "-"], command: "negative" },
  { keys: ["escape", "0"], command: "digit" },
  { keys: ["escape", "1"], command: "digit" },
  { keys: ["escape", "2"], command: "digit" },
  { keys: ["escape", "3"], command: "digit" },
  { keys: ["escape", "4"], command: "digit" },
  { keys: ["escape", "5"], command: "digit" },
  { keys: ["escape", "6"], command: "digit" },
  { keys: ["escape", "7"], command: "digit" },
  { keys: ["escape", "8"], command: "digit" },
  { keys: ["escape", "9"], command: "digit" },
  {
    keys: ["-"],
    command: "negative",
    when: (editor) => editor.argument !== null,
  },
  { keys: ["0"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["1"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["2"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["3"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["4"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["5"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["6"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["7"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["8"], command: "digit", when: (editor) => editor.argument !== null },
  { keys: ["9"], command: "digit", when: (editor) => editor.argument !== null },
];

const repeatable = new Set<Command>([
  "self-insert",
  "newline",
  "delete-char",
  "backward-delete",
  "left",
  "right",
  "up",
  "down",
  "word-left",
  "word-right",
  "history-up",
  "history-down",
  "yank",
  "unix-rubout",
  "kill-word",
  "backward-kill-word",
]);

type Place = { text: string; cursor: number; index: number };

export class PromptEditor {
  text: string;
  cursor: number;
  multiline: boolean;
  working: string[];
  index: number;
  searching = false;
  needle = "";
  searchDirection: "backward" | "forward" = "backward";
  private origin: Place = { text: "", cursor: 0, index: 0 };
  private preview: Place | null = null;
  argument: string | null = null;
  private quoted = false;
  private clipboard = "";
  private lastCommand: Command | "" = "";
  private preferredColumn: number | null = null;
  private keyBuffer: KeyPress[] = [];
  private queue: KeyPress[] = [];
  clearRequested = false;
  private done: EditorOutcome | null = null;

  constructor(initial: string, multiline: boolean) {
    this.text = initial;
    this.cursor = Array.from(initial).length;
    this.multiline = multiline;
    this.working = [initial];
    this.index = 0;
  }

  loadHistory(newestFirst: readonly string[]): void {
    for (const item of newestFirst) {
      this.working.unshift(item);
      this.index += 1;
    }
  }

  held(): boolean {
    return this.keyBuffer.length > 0;
  }

  push(key: KeyPress): EditorOutcome {
    this.queue.push(key);
    this.drain();
    return this.done ?? { kind: "pending" };
  }

  flush(): EditorOutcome {
    this.match(true);
    this.drain();
    return this.done ?? { kind: "pending" };
  }

  presentation(): PromptPresentation {
    const needle = needleEnd(this.needle);
    const argument = argumentRow(this.multiline, this.argument);
    const shown = this.searching && this.preview ? this.preview : this;
    if (this.searching && !this.multiline) {
      const match = matchOnLine(shown.text, shown.cursor);
      return {
        kind: "single-search",
        direction: this.searchDirection,
        needle: needle.text,
        needleCursor: needle.cursor,
        needleEdit: "end-only",
        line: match.line,
        cursorInLine: match.cursorInLine,
      };
    }
    const submit: SubmitRow = this.multiline
      ? { kind: "submit-help" }
      : { kind: "none" };
    const body = {
      text: shown.text,
      cursor: shown.cursor,
      submit,
      argument,
    };
    if (this.searching) {
      return {
        kind: "multiline-search",
        direction: this.searchDirection,
        needle: needle.text,
        needleCursor: needle.cursor,
        needleEdit: "end-only",
        ...body,
      };
    }
    return { kind: "document", ...body };
  }

  takeClear(): boolean {
    const requested = this.clearRequested;
    this.clearRequested = false;
    return requested;
  }

  private drain(): void {
    while (!this.done && this.queue.length) {
      const key = this.queue.shift();
      if (!key) break;
      this.keyBuffer.push(key);
      this.match(false);
    }
  }

  private match(flush: boolean): void {
    let retry = true;
    while (retry && this.keyBuffer.length) {
      retry = false;
      const names = this.keyBuffer.map((key) => key.key);
      const exactMatches = bindings.filter(
        (binding) =>
          sameKeys(binding.keys, names) && (binding.when?.(this) ?? true),
      );
      const longer = flush
        ? []
        : bindings.filter(
            (binding) =>
              binding.keys.length > names.length &&
              sameKeys(binding.keys.slice(0, names.length), names) &&
              (binding.when?.(this) ?? true),
          );
      const eager = exactMatches.filter((binding) => binding.eager);
      if (eager.length) {
        this.run(eager[eager.length - 1]?.command ?? "ignore");
      } else if (!flush && longer.length) {
        return;
      } else if (exactMatches.length) {
        this.run(exactMatches[exactMatches.length - 1]?.command ?? "ignore");
      } else if (names.length > 1) {
        retry = true;
        this.keyBuffer = this.keyBuffer.slice(1);
      } else if (this.quoted) {
        this.run("self-insert");
      } else if (this.searching && isInsertable(this.keyBuffer[0])) {
        this.run("search-insert");
      } else if (editing(this) && isInsertable(this.keyBuffer[0])) {
        this.run("self-insert");
      } else {
        this.keyBuffer = [];
      }
    }
  }

  private run(command: Command): void {
    const event = this.keyBuffer.at(-1) ?? { key: "", data: "" };
    this.keyBuffer = [];
    const count = this.argumentCount();
    if (command !== "digit" && command !== "negative") this.argument = null;
    if (command === "refeed-enter") {
      this.queue.unshift({ key: "c-m", data: "\r" });
      return;
    }
    this.execute(command, event, count);
    this.lastCommand = command;
    this.quoted = command === "quoted";
  }

  private argumentCount(): number {
    if (this.argument === null || this.argument === "-") return 1;
    const value = Number.parseInt(this.argument, 10);
    return Number.isNaN(value) ? 1 : value;
  }

  private execute(command: Command, event: KeyPress, count: number): void {
    const times = repeatable.has(command) ? count : 1;
    if (command === "ignore" || command === "quoted") return;
    if (command === "interrupt") {
      this.done = {
        kind: "error",
        error: new KeyboardInterrupt("user interrupt"),
      };
      return;
    }
    if (command === "eof") {
      this.done = {
        kind: "error",
        error: new EOFError("EOF when reading a line"),
      };
      return;
    }
    if (command === "accept") {
      this.done = { kind: "accept", text: this.text };
      return;
    }
    if (command === "accept-search") {
      this.acceptSearch();
      return;
    }
    if (command === "abort-search") {
      this.text = this.origin.text;
      this.cursor = this.origin.cursor;
      this.index = this.origin.index;
      this.searching = false;
      this.preview = null;
      return;
    }
    if (
      command === "start-search-backward" ||
      command === "start-search-forward"
    ) {
      this.origin = { text: this.text, cursor: this.cursor, index: this.index };
      this.needle = "";
      this.searchDirection =
        command === "start-search-backward" ? "backward" : "forward";
      this.searching = true;
      this.preview = { ...this.origin };
      return;
    }
    if (
      command === "search-again-backward" ||
      command === "search-again-forward"
    ) {
      this.searchDirection =
        command === "search-again-backward" ? "backward" : "forward";
      this.refreshSearch(false);
      return;
    }
    if (command === "search-insert") {
      this.needle += event.data;
      this.refreshSearch(true);
      return;
    }
    if (command === "search-backspace") {
      this.needle = Array.from(this.needle).slice(0, -1).join("");
      this.refreshSearch(true);
      return;
    }
    if (command === "negative") {
      if (!this.argument?.startsWith("-"))
        this.argument = `-${this.argument ?? ""}`;
      return;
    }
    if (command === "digit") {
      const digit = event.key.slice(-1);
      this.argument = `${this.argument ?? ""}${digit}`;
      return;
    }
    if (command === "paste") {
      this.apply(
        insertText(
          this.doc(),
          event.data.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
        ),
      );
      return;
    }
    if (command === "self-insert") {
      const data = event.data.repeat(Math.max(0, times));
      this.apply(insertText(this.doc(), data));
      return;
    }
    if (command === "newline") {
      const margin = this.multiline ? leadingWhitespace(this.doc()) : "";
      for (let step = 0; step < Math.max(1, times); step += 1)
        this.apply(insertText(this.doc(), `\n${margin}`));
      return;
    }
    if (command === "clear") {
      this.clearRequested = true;
      return;
    }
    if (command === "yank") {
      const data = this.clipboard.repeat(Math.max(0, times));
      this.apply(insertText(this.doc(), data));
      return;
    }
    if (command === "delete-char") {
      this.apply(deleteForward(this.doc(), times).doc);
      return;
    }
    if (command === "backward-delete") {
      this.apply(deleteBackward(this.doc(), times).doc);
      return;
    }
    if (command === "delete-to-end") {
      const { end } = lineIndex(this.doc());
      const countToEnd =
        this.cursor === end && end < Array.from(this.text).length
          ? 1
          : end - this.cursor;
      const result = deleteForward(this.doc(), Math.max(0, countToEnd));
      this.rememberKill(result.deleted);
      this.apply(result.doc);
      return;
    }
    if (command === "unix-line-discard") {
      const result = deleteBackward(this.doc(), columnOf(this.doc()));
      this.clipboard = result.deleted;
      this.apply(result.doc);
      return;
    }
    if (command === "unix-rubout") {
      this.killBackwardWord(true, times);
      return;
    }
    if (command === "backward-kill-word") {
      this.killBackwardWord(false, times);
      return;
    }
    if (command === "kill-word") {
      const relative = nextWordEnd(this.doc(), Math.max(1, times), false);
      if (relative === null) return;
      const result = deleteForward(this.doc(), relative);
      this.rememberKill(result.deleted);
      this.apply(result.doc);
      return;
    }
    if (command === "left")
      this.apply(moveHorizontally(this.doc(), -Math.abs(times)));
    else if (command === "right")
      this.apply(moveHorizontally(this.doc(), Math.abs(times)));
    else if (command === "line-start")
      this.apply(lineEdge(this.doc(), "start"));
    else if (command === "line-end") this.apply(lineEdge(this.doc(), "end"));
    else if (command === "buffer-start")
      this.apply(bufferEdge(this.doc(), "start"));
    else if (command === "buffer-end")
      this.apply(bufferEdge(this.doc(), "end"));
    else if (command === "word-left")
      this.moveWord(previousWordStart(this.doc(), Math.max(1, times), false));
    else if (command === "word-right")
      this.moveWord(nextWordEnd(this.doc(), Math.max(1, times), false));
    else if (command === "word-end")
      this.moveWord(nextWordEnd(this.doc(), Math.max(1, times), false));
    else if (command === "up") this.vertical(-Math.abs(times || 1));
    else if (command === "down") this.vertical(Math.abs(times || 1));
    else if (command === "history-up") this.history(-Math.abs(times || 1));
    else if (command === "history-down") this.history(Math.abs(times || 1));
    else if (command === "transpose") this.transpose();
    else if (command === "transpose-words") this.transposeWords();
  }

  private doc(): Doc {
    return { text: this.text, cursor: this.cursor };
  }

  private apply(doc: Doc): void {
    this.text = doc.text;
    this.cursor = doc.cursor;
    this.preferredColumn = null;
    this.working[this.index] = this.text;
  }

  private moveWord(relative: number | null): void {
    if (relative === null) return;
    const length = Array.from(this.text).length;
    this.apply({
      text: this.text,
      cursor: Math.max(0, Math.min(length, this.cursor + relative)),
    });
  }

  private vertical(delta: number): void {
    const current = lineIndex(this.doc());
    if (delta < 0 && current.row === 0) {
      this.history(delta);
      return;
    }
    if (delta > 0 && current.row >= lineCount(this.text) - 1) {
      this.history(delta);
      return;
    }
    const column = this.preferredColumn ?? columnOf(this.doc());
    this.cursor = indexAt(this.text, current.row + delta, column);
    this.preferredColumn = column;
    this.working[this.index] = this.text;
  }

  private history(delta: number): void {
    const next = Math.max(
      0,
      Math.min(this.working.length - 1, this.index + delta),
    );
    if (next === this.index) return;
    this.index = next;
    this.text = this.working[this.index] ?? "";
    const points = Array.from(this.text);
    this.cursor =
      delta < 0 ? points.length : lineIndex({ text: this.text, cursor: 0 }).end;
    this.preferredColumn = null;
  }

  private rememberKill(deleted: string): void {
    if (
      this.lastCommand === "delete-to-end" ||
      this.lastCommand === "kill-word" ||
      this.lastCommand === "unix-rubout"
    )
      this.clipboard += deleted;
    else this.clipboard = deleted;
  }

  private killBackwardWord(big: boolean, count: number): void {
    const relative = previousWordStart(this.doc(), Math.max(1, count), big);
    if (relative === null) return;
    const result = deleteBackward(this.doc(), -relative);
    if (
      this.lastCommand === "unix-rubout" ||
      this.lastCommand === "backward-kill-word"
    )
      this.clipboard = result.deleted + this.clipboard;
    else this.clipboard = result.deleted;
    this.apply(result.doc);
  }

  private acceptSearch(): void {
    if (this.preview) {
      this.text = this.preview.text;
      this.cursor = this.preview.cursor;
      this.index = this.preview.index;
      this.working[this.index] = this.text;
    }
    this.searching = false;
    this.preview = null;
  }

  private refreshSearch(fromOrigin: boolean): void {
    const base = fromOrigin ? this.origin : (this.preview ?? this.origin);
    const found = searchHistory(
      this.working,
      base,
      this.needle,
      this.searchDirection,
      fromOrigin,
    );
    this.preview = found ?? { ...this.origin };
  }

  private transpose(): void {
    const points = Array.from(this.text);
    if (points.length < 2 || this.cursor === 0) return;
    const at = this.cursor === points.length ? this.cursor - 1 : this.cursor;
    const left = points[at - 1] ?? "";
    const right = points[at] ?? "";
    points[at - 1] = right;
    points[at] = left;
    this.apply({
      text: points.join(""),
      cursor: Math.min(points.length, at + 1),
    });
  }

  private transposeWords(): void {
    const before = previousWordStart(this.doc(), 1, false);
    if (before === null) return;
    const left = this.cursor + before;
    const firstEndRelative = nextWordEnd(
      { text: this.text, cursor: left },
      1,
      false,
    );
    if (firstEndRelative === null) return;
    const firstEnd = left + firstEndRelative;
    const secondEndRelative = nextWordEnd(
      { text: this.text, cursor: firstEnd },
      1,
      false,
    );
    if (secondEndRelative === null) return;
    const secondEnd = firstEnd + secondEndRelative;
    const secondStart =
      secondEnd +
      (previousWordStart({ text: this.text, cursor: secondEnd }, 1, false) ??
        0);
    const points = Array.from(this.text);
    const a = points.slice(left, firstEnd);
    const b = points.slice(secondStart, secondEnd);
    points.splice(secondStart, b.length, ...a);
    points.splice(left, a.length, ...b);
    this.apply({ text: points.join(""), cursor: secondEnd });
  }
}

function needleEnd(needle: string): { text: string; cursor: number } {
  return { text: needle, cursor: pointsOf(needle).length };
}

function argumentRow(multiline: boolean, argument: string | null): ArgumentRow {
  if (argument === null) return { kind: "hidden" };
  if (!multiline) return { kind: "inline", text: argument };
  return { kind: "repeat", text: argument === "-" ? "-1" : argument };
}

function matchOnLine(
  text: string,
  cursor: number,
): { line: string; cursorInLine: number } {
  const doc = { text, cursor };
  const span = lineIndex(doc);
  return {
    line: fromPoints(pointsOf(text).slice(span.start, span.end)),
    cursorInLine: columnOf(doc),
  };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  );
}

function isInsertable(key: KeyPress | undefined): boolean {
  if (!key || !key.data || key.key.startsWith("<")) return false;
  const blocked = new Set([
    "up",
    "down",
    "left",
    "right",
    "delete",
    "backspace",
    "home",
    "end",
    "insert",
    "tab",
    "s-tab",
    "pageup",
    "pagedown",
  ]);
  if (
    blocked.has(key.key) ||
    key.key.startsWith("c-") ||
    key.key.startsWith("escape")
  )
    return false;
  return true;
}

function searchHistory(
  working: readonly string[],
  base: Place,
  needle: string,
  direction: "backward" | "forward",
  includeCurrent: boolean,
): Place | null {
  if (!needle) return { ...base };
  const step = direction === "backward" ? -1 : 1;
  let index = base.index;
  let doc: Doc = { text: working[index] ?? base.text, cursor: base.cursor };
  let first = true;
  while (index >= 0 && index < working.length) {
    const relative =
      direction === "backward"
        ? findBackward(doc, needle)
        : findForward(doc, needle, first && includeCurrent);
    if (relative !== null) {
      const text = working[index] ?? "";
      return { text, cursor: doc.cursor + relative, index };
    }
    first = false;
    index += step;
    if (index < 0 || index >= working.length) break;
    const text = working[index] ?? "";
    doc = {
      text,
      cursor: direction === "backward" ? Array.from(text).length : 0,
    };
  }
  return null;
}
