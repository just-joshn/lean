import { join } from "node:path";
import type { ReadStream } from "node:tty";
import { EOFError } from "../../exceptions.ts";
import { globalConfigDir } from "../../utils/global-config-dir.ts";
import { recordAsyncDiagnostic, replacement } from "./context.ts";
import { PromptEditor, type EditorOutcome } from "./editor.ts";
import { classifyInput, PromptFrame, type PaintPhase } from "./frame.ts";
import { FileHistory } from "./history.ts";
import { Utf8Decoder, Vt100Parser, type KeyPress } from "./parser.ts";

const decoder = new Utf8Decoder();
const parser = new Vt100Parser();
let typeahead: KeyPress[] = [];
let stdinEnded = false;
let parserTimer: ReturnType<typeof setTimeout> | undefined;
let active: Active | undefined;
let chain: Promise<void> = Promise.resolve();
let historyPath = "";
let history = new FileHistory("");

type Active =
  | {
      kind: "pipe";
      editor: PromptEditor;
      bindingTimer: ReturnType<typeof setTimeout> | undefined;
      finish: (outcome: EditorOutcome) => void;
      paint: () => void;
    }
  | {
      kind: "terminal";
      editor: PromptEditor;
      frame: PromptFrame;
      bindingTimer: ReturnType<typeof setTimeout> | undefined;
      finish: (outcome: EditorOutcome) => void;
      paint: () => void;
      reading: () => boolean;
      sourceRunning: () => boolean;
      suspended: () => boolean;
    };

function stdin(): ReadStream {
  return process.stdin as ReadStream;
}

function interactiveHistory(): FileHistory {
  const path = join(globalConfigDir(), "interactive_history.txt");
  if (path !== historyPath) {
    historyPath = path;
    history = new FileHistory(path);
  }
  return history;
}

function noteEnded(): void {
  if (stdin().readableEnded) stdinEnded = true;
}

function clearParserTimer(): void {
  if (parserTimer) clearTimeout(parserTimer);
  parserTimer = undefined;
}

function armParser(): void {
  clearParserTimer();
  if (!parser.holding()) return;
  parserTimer = setTimeout(() => {
    parserTimer = undefined;
    deliver(parser.flush());
  }, 500);
}

function deliver(keys: KeyPress[]): void {
  for (const key of keys) {
    const current = active;
    if (!current) {
      typeahead.push(key);
      continue;
    }
    if (current.kind === "terminal") {
      const event = classifyInput(key);
      if (event.kind === "cursor") {
        current.frame.report(event.report);
        if (current.sourceRunning() && !current.suspended()) current.paint();
        continue;
      }
      if (!current.reading() || current.suspended()) {
        typeahead.push(key);
        continue;
      }
    }
    const outcome = current.editor.push(key);
    armBinding(current);
    if (outcome.kind !== "pending") current.finish(outcome);
    else current.paint();
  }
}

function armBinding(current: Active): void {
  if (current.bindingTimer) clearTimeout(current.bindingTimer);
  current.bindingTimer = undefined;
  if (!current.editor.held()) return;
  current.bindingTimer = setTimeout(() => {
    current.bindingTimer = undefined;
    if (active !== current) return;
    const outcome = current.editor.flush();
    if (outcome.kind !== "pending") current.finish(outcome);
    else current.paint();
  }, 1000);
}

function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function readInteractive(
  lines: "single" | "multiline" = "single",
): Promise<string> {
  return exclusive(() => readEdited(lines === "multiline", "", true));
}

export function readSetup(defaultText = ""): Promise<string> {
  return exclusive(() => readEdited(false, defaultText, false));
}

export function readBuiltinLimit(): Promise<string> {
  return exclusive(() => readDelimited(Boolean(stdin().isTTY)));
}

function readEdited(
  multiline: boolean,
  initial: string,
  file: boolean,
): Promise<string> {
  const editor = new PromptEditor(initial, multiline);
  const early = applyTypeahead(editor);
  if (early?.kind === "error") return Promise.reject(early.error);
  if (early?.kind === "accept") {
    if (file) interactiveHistory().append(early.text);
    return Promise.resolve(early.text);
  }
  if (file) editor.loadHistory(interactiveHistory().newestFirst());
  if (!stdin().isTTY) return readPipe(editor, file);
  return readTerminal(editor, file);
}

function applyTypeahead(editor: PromptEditor): EditorOutcome | undefined {
  const pending = typeahead;
  typeahead = [];
  for (let index = 0; index < pending.length; index += 1) {
    const key = pending[index];
    if (!key) continue;
    const outcome = editor.push(key);
    if (outcome.kind !== "pending") {
      typeahead = pending.slice(index + 1);
      return outcome;
    }
  }
  return undefined;
}

function readPipe(editor: PromptEditor, file: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    noteEnded();
    if (stdinEnded && !parser.prefix) {
      reject(new EOFError("EOF when reading a line"));
      return;
    }
    const detach = () => {
      stdin().off("data", onData);
      stdin().off("end", onEnd);
      stdin().pause();
    };
    const finish = (outcome: EditorOutcome) => {
      active = undefined;
      clearParserTimer();
      detach();
      if (outcome.kind === "accept") {
        if (file) interactiveHistory().append(outcome.text);
        resolve(outcome.text);
      } else if (outcome.kind === "error") reject(outcome.error);
    };
    const onData = (chunk: Buffer) => {
      const keys = parser.feed(decoder.decode(chunk));
      armParser();
      deliver(keys);
    };
    const onEnd = () => {
      stdinEnded = true;
      clearParserTimer();
      if (!active) return;
      active = undefined;
      detach();
      reject(new EOFError("EOF when reading a line"));
    };
    active = {
      kind: "pipe",
      editor,
      bindingTimer: undefined,
      finish,
      paint: () => undefined,
    };
    stdin().on("data", onData);
    stdin().on("end", onEnd);
    stdin().resume();
  });
}

function donePhase(
  outcome: { kind: "accept" } | { kind: "error"; error: unknown },
): PaintPhase {
  if (outcome.kind === "accept") return { kind: "done", exit: "keep" };
  if (outcome.error instanceof EOFError)
    return { kind: "done", exit: "exiting" };
  return { kind: "done", exit: "aborting" };
}

type CloseOutcome =
  { kind: "accept"; text: string } | { kind: "error"; error: unknown };

type ReadStatus =
  | { kind: "reading" }
  | { kind: "closing"; sourceRunning: boolean }
  | { kind: "closed" };

class TerminalRead {
  private status: ReadStatus = { kind: "reading" };
  private suspended = false;
  private warningGate: Promise<void> | undefined;
  private readonly editor: PromptEditor;
  private readonly file: boolean;
  private readonly resolveRead: (value: string) => void;
  private readonly rejectRead: (error: unknown) => void;
  private readonly input: ReturnType<typeof stdin>;
  private readonly output: NodeJS.WriteStream;
  private readonly wasRaw: boolean;
  private readonly frame: PromptFrame;
  private readonly slot: Extract<Active, { kind: "terminal" }>;
  private removed = { data: false, end: false, sigint: false };

  constructor(
    editor: PromptEditor,
    file: boolean,
    resolveRead: (value: string) => void,
    rejectRead: (error: unknown) => void,
  ) {
    this.editor = editor;
    this.file = file;
    this.resolveRead = resolveRead;
    this.rejectRead = rejectRead;
    this.input = stdin();
    this.output = process.stdout;
    this.wasRaw = Boolean(this.input.isRaw);
    const kind = file ? (editor.multiline ? "multiline" : "single") : "setup";
    this.frame = PromptFrame.open(kind, this.output);
    this.slot = {
      kind: "terminal",
      editor,
      frame: this.frame,
      bindingTimer: undefined,
      finish: (outcome) => this.finish(outcome),
      paint: () => this.paintFromInput(),
      reading: () => this.status.kind === "reading",
      sourceRunning: () => this.isSourceRunning(),
      suspended: () => this.suspended,
    };
  }

  start(): void {
    active = this.slot;
    try {
      if (!this.wasRaw) this.input.setRawMode(true);
      process.on("SIGINT", this.onSigint);
      this.input.on("data", this.onData);
      this.input.on("end", this.onEnd);
      this.input.resume();
      this.output.on("resize", this.onResize);
      this.frame.setCprWarning(() => this.warnCpr());
      this.frame.begin();
      this.frame.paint(this.editor, { kind: "open" });
    } catch (error) {
      this.fail(error);
    }
  }

  private readonly onData = (chunk: Buffer): void => {
    const keys = parser.feed(decoder.decode(chunk));
    armParser();
    deliver(keys);
  };

  private readonly onEnd = (): void => {
    stdinEnded = true;
    this.finish({
      kind: "error",
      error: new EOFError("EOF when reading a line"),
    });
  };

  private readonly onSigint = (): void => {
    deliver([{ key: "<sigint>", data: "" }]);
  };

  private readonly onResize = (): void => {
    if (this.status.kind !== "reading") return;
    try {
      this.frame.resize();
      this.frame.paint(this.editor, { kind: "open" });
    } catch (error) {
      this.fail(error);
    }
  };

  private isSourceRunning(): boolean {
    if (this.status.kind === "reading") return true;
    if (this.status.kind === "closing") return this.status.sourceRunning;
    return false;
  }

  private paintFromInput(): void {
    try {
      if (!this.isSourceRunning() || this.suspended) return;
      this.frame.paint(this.editor, { kind: "open" });
    } catch (error) {
      if (this.status.kind === "reading") this.fail(error);
    }
  }

  private paintOpen(): void {
    if (!this.isSourceRunning() || this.suspended) return;
    this.frame.paint(this.editor, { kind: "open" });
  }

  private finish(outcome: EditorOutcome): void {
    if (outcome.kind === "pending") return;
    if (outcome.kind === "accept") {
      void this.close({ kind: "accept", text: outcome.text }, true);
      return;
    }
    void this.close({ kind: "error", error: outcome.error }, true);
  }

  private fail(error: unknown): void {
    void this.close({ kind: "error", error }, false);
  }

  private warnCpr(): void {
    void this.runWarning().catch((error: unknown) => {
      recordAsyncDiagnostic("cpr-warning", error);
    });
  }

  private async close(
    outcome: CloseOutcome,
    donePaint: boolean,
  ): Promise<void> {
    if (this.status.kind !== "reading") return;
    this.status = { kind: "closing", sourceRunning: true };
    let pending =
      outcome.kind === "error"
        ? replacement(outcome.error, undefined)
        : undefined;
    const link = (error: unknown) => {
      pending = replacement(error, pending);
    };
    try {
      try {
        if (donePaint && this.isSourceRunning() && !this.suspended) {
          try {
            this.frame.paint(this.editor, donePhase(outcome));
          } catch (error) {
            link(error);
          } finally {
            let resetFailed = false;
            try {
              this.frame.reset();
            } catch (error) {
              link(error);
              resetFailed = true;
            }
            if (!resetFailed) {
              try {
                this.status = { kind: "closing", sourceRunning: false };
                await this.frame.waitForCprResponses();
                const gate = this.warningGate;
                await gate;
              } catch (error) {
                link(error);
              }
            }
          }
        }
      } finally {
        if (active === this.slot) active = undefined;
        try {
          this.exitResize();
        } catch (error) {
          link(error);
        }
        try {
          this.exitAttach();
        } catch (error) {
          link(error);
        }
        try {
          this.exitRaw();
        } catch (error) {
          link(error);
        }
        try {
          this.exitSigint();
        } catch (error) {
          link(error);
        }
      }
    } finally {
      try {
        clearParserTimer();
        await this.frame.cancelCprBackgroundAndWait();
      } catch (error) {
        link(error);
      } finally {
        this.status = { kind: "closed" };
        if (active === this.slot) active = undefined;
        try {
          if (pending) this.rejectRead(pending.error);
          else if (outcome.kind === "accept") {
            if (this.file) interactiveHistory().append(outcome.text);
            this.resolveRead(outcome.text);
          } else this.rejectRead(outcome.error);
        } catch (error) {
          this.rejectRead(error);
        }
      }
    }
  }

  private exitResize(): void {
    this.output.off("resize", this.onResize);
  }

  private exitAttach(): void {
    if (this.slot.bindingTimer) clearTimeout(this.slot.bindingTimer);
    this.slot.bindingTimer = undefined;
    this.input.off("end", this.onEnd);
    this.removed.end = true;
    this.input.off("data", this.onData);
    this.removed.data = true;
  }

  private exitSigint(): void {
    if (this.removed.sigint) return;
    process.off("SIGINT", this.onSigint);
    this.removed.sigint = true;
  }

  private exitRaw(): void {
    if (this.input.isTTY && !this.wasRaw && this.input.isRaw)
      this.input.setRawMode(false);
    this.input.pause();
  }

  private detachTemporary(): void {
    if (!this.removed.end) this.input.off("end", this.onEnd);
    if (!this.removed.data) this.input.off("data", this.onData);
  }

  private reattachTemporary(): void {
    if (this.removed.data) return;
    this.input.on("data", this.onData);
    if (!this.removed.end) this.input.on("end", this.onEnd);
  }

  private enterCooked(): void {
    if (this.input.isRaw) this.input.setRawMode(false);
  }

  private exitCooked(): void {
    if (!this.wasRaw) this.input.setRawMode(true);
  }

  private withCookedAndDetached(write: () => void): void {
    this.detachTemporary();
    let pending = undefined as ReturnType<typeof replacement> | undefined;
    let enteredCooked = false;
    try {
      try {
        this.enterCooked();
        enteredCooked = true;
        write();
      } catch (error) {
        pending = replacement(error, pending);
      }
    } finally {
      if (enteredCooked) {
        try {
          this.exitCooked();
        } catch (error) {
          pending = replacement(error, pending);
        }
      }
      try {
        this.reattachTemporary();
      } catch (error) {
        pending = replacement(error, pending);
      }
    }
    if (pending) throw pending.error;
  }

  private async runWarning(): Promise<void> {
    if (!this.isSourceRunning()) {
      this.frame.writeCprWarning();
      return;
    }
    const previous = this.warningGate;
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.warningGate = gate;
    // Prelude failures leave this gate pending. The source finally is not entered.
    await previous;
    await this.frame.waitForCprResponses();
    this.frame.erase();
    this.suspended = true;
    let pending = undefined as ReturnType<typeof replacement> | undefined;
    try {
      try {
        this.withCookedAndDetached(() => this.frame.writeCprWarning());
      } catch (error) {
        pending = replacement(error, pending);
      } finally {
        try {
          this.suspended = false;
          this.frame.reset();
          this.frame.askForCpr();
          this.paintOpen();
        } catch (error) {
          pending = replacement(error, pending);
        } finally {
          resolveGate?.();
        }
      }
    } finally {
      this.suspended = false;
    }
    if (pending) throw pending.error;
  }
}

function readTerminal(editor: PromptEditor, file: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    new TerminalRead(editor, file, resolve, reject).start();
  });
}

function readDelimited(tty: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    noteEnded();
    if (stdinEnded) {
      reject(new EOFError("EOF when reading a line"));
      return;
    }
    let buffer = Buffer.alloc(0);
    const detach = () => {
      stdin().off("data", onData);
      stdin().off("end", onEnd);
    };
    const finish = (text: string, rest: Buffer) => {
      detach();
      if (rest.length) stdin().unshift(rest);
      stdin().pause();
      resolve(text);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = tty ? firstDelimiter(buffer) : buffer.indexOf(0x0a);
      if (end < 0) return;
      finish(
        buffer.subarray(0, end).toString("utf8"),
        buffer.subarray(end + 1),
      );
    };
    const onEnd = () => {
      stdinEnded = true;
      detach();
      if (buffer.length === 0) reject(new EOFError("EOF when reading a line"));
      else resolve(buffer.toString("utf8"));
    };
    stdin().on("data", onData);
    stdin().on("end", onEnd);
    stdin().resume();
    if (tty) process.stdout.write("READY\n");
  });
}

function firstDelimiter(buffer: Buffer): number {
  const cr = buffer.indexOf(0x0d);
  const lf = buffer.indexOf(0x0a);
  if (cr < 0) return lf;
  if (lf < 0) return cr;
  return Math.min(cr, lf);
}
