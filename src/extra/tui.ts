import type { Model } from "@openai/agents";
import type { VNode } from "@rezi-ui/core";
import { createPainter } from "./tui-highlight.ts";
import { demoActions, plain, replayItems } from "./tui-replay.ts";
import {
  ONE_DARK_PRO,
  isThemeName,
  noColorEnabled,
  themeNames,
  type NoticeTone,
  type ThemeName,
} from "./tui-theme.ts";
import {
  commands,
  inspectorRows,
  proposalRows,
  recordedActions,
  renderTui,
  slashMatches,
  transcriptRows,
  type CommandName,
  type InspectorState,
  type InspectorTab,
  type PaintFace,
  type Phase,
  type TuiState,
  type TranscriptEntry,
} from "./tui-view.ts";

const CANCELLED = "Cancelled. Completed tool side effects are not undone.";
const WAIT = "Wait until the current turn finishes.";
const EXIT_HINT = "Press Ctrl+C again to exit.";
const PAGE_STEP = 5;

export type TurnInput = {
  readonly text: string;
  readonly model: string | Model;
  readonly signal: AbortSignal;
  readonly onText: (delta: string) => void;
  readonly approve: (detail: string) => Promise<boolean>;
};

export type TurnDriver = (input: TurnInput) => Promise<void>;

export type HistoryPort = {
  getItems(): Promise<readonly unknown[]>;
  restore(items: readonly unknown[]): Promise<void>;
  save(): Promise<void>;
  close(): Promise<void>;
};

type ScreenSink = {
  update(state: TuiState): void;
  setTheme(theme: ThemeName): void;
};

const closedInspector: InspectorState = {
  open: false,
  tab: "output",
  callId: null,
  offset: 0,
};

export function demoDriver(): TurnDriver {
  return async (input) => {
    const label = typeof input.model === "string" ? input.model : "demo";
    input.onText(`Demo (${label}). Nothing was executed.\n`);
    if (input.signal.aborted) throw cancelledError();
    if (!input.text.toLowerCase().includes("tool")) return;
    const detail = JSON.stringify({
      tool: "shell",
      action: { commands: ["echo demo-only"], timeout_ms: 1000 },
    });
    const allowed = await input.approve(detail);
    if (input.signal.aborted) throw cancelledError();
    input.onText(
      allowed
        ? "Demo recorded yes. No command ran.\n"
        : "Demo recorded no. No command ran.\n",
    );
  };
}

function cancelledError(): Error {
  const error = new Error("The turn was cancelled.");
  error.name = "AbortError";
  return error;
}

function cloneItems(items: readonly unknown[]): readonly unknown[] {
  return structuredClone(items);
}

function opening(demo: boolean): TranscriptEntry {
  return {
    kind: "notice",
    tone: "info",
    text: demo
      ? "Demo mode. No credentials, no shell, and no saved history."
      : "Lean asks before a shell command or a patch. /help lists commands.",
  };
}

const demoSample: TranscriptEntry = {
  kind: "assistant",
  text: [
    "Synthetic sample. Nothing was executed.",
    "",
    "```ts",
    "const ready = true;",
    "```",
  ].join("\n"),
};

export type TuiController = {
  readonly state: TuiState;
  readonly done: Promise<void>;
  render(): VNode;
  editDraft(text: string, cursor?: number): void;
  submit(): Promise<void>;
  key(name: string, focusedId?: string | null): boolean;
  consumes(name: string, focusedId: string | null): boolean;
  resize(cols: number): void;
  allow(): void;
  deny(): void;
  connect(sink: ScreenSink): void;
  shutdown(): Promise<void>;
};

export async function createTuiController(options: {
  driver: TurnDriver;
  cwd: string;
  modelLabel: string;
  model: string | Model;
  providerLabel: string;
  sessionLabel: string;
  demo: boolean;
  trace?: boolean;
  theme?: ThemeName;
  noColor?: boolean;
  cols?: number;
  history?: HistoryPort | null;
  redact?: (error: unknown) => string;
  resolveModel?: (name: string) => Promise<string | Model>;
}): Promise<TuiController> {
  const noColor = options.noColor ?? noColorEnabled(process.env);
  let invalidatePaint = () => {};
  const painter = await createPainter({
    noColor,
    onReady: () => invalidatePaint(),
  });
  const face: PaintFace = { painter, noColor };
  const history = options.history ?? null;
  const redact =
    options.redact ??
    ((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const key = process.env.OPENAI_API_KEY;
      return key ? message.split(key).join("[redacted]") : message;
    });
  let replayed: ReturnType<typeof replayItems> = [];
  try {
    replayed =
      history && !options.demo ? replayItems(await history.getItems()) : [];
  } catch (error) {
    painter.dispose();
    throw error;
  }
  let backendModel = options.model;
  let draftCursor = 0;
  let state: TuiState = {
    demo: options.demo,
    cwd: options.cwd,
    modelLabel: options.modelLabel,
    providerLabel: options.providerLabel,
    sessionLabel: options.sessionLabel,
    trace: options.trace === true,
    theme: options.theme ?? ONE_DARK_PRO,
    paint: 0,
    cols: options.cols ?? process.stdout.columns ?? 80,
    phase: { kind: "idle" },
    blocked: false,
    exitArmed: false,
    draft: { text: "", key: 0 },
    slashIndex: 0,
    transcript: options.demo
      ? [
          opening(true),
          demoSample,
          ...demoActions().map((action) => ({
            kind: "action" as const,
            action,
          })),
        ]
      : replayed.length > 0
        ? replayed
        : [opening(false)],
    history: [],
    recall: null,
    stash: null,
    anchor: null,
    inspector: closedInspector,
  };
  let stopped = false;
  let busy = false;
  let sink: ScreenSink | null = null;
  let publish = false;
  let abort: AbortController | null = null;
  let pending: ((allowed: boolean) => void) | null = null;
  let proposalAt = -1;
  let streamAt = -1;
  let active: Promise<void> | null = null;
  let shutting: Promise<void> | null = null;
  let finish = () => {};
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });

  const handlers = {
    editDraft,
    allow,
    deny,
    toggleInspector,
    setInspectorTab,
    closeInspector,
  };

  invalidatePaint = () => {
    if (stopped) return;
    commit({ ...state, paint: state.paint + 1 });
  };

  function commit(next: TuiState) {
    if (stopped) return;
    state = next;
    if (publish) sink?.update(state);
  }

  function patch(partial: Partial<TuiState>) {
    commit({ ...state, ...partial });
  }

  function notice(text: string, tone: NoticeTone = "info") {
    if (stopped) return;
    patch({
      transcript: [...state.transcript, { kind: "notice", text, tone }],
    });
  }

  function fail(error: unknown) {
    notice(redact(error), "error");
  }

  function editDraft(text: string, cursor = text.length) {
    try {
      draftCursor = cursor;
      if (text === state.draft.text) {
        if (state.exitArmed) patch({ exitArmed: false });
        return;
      }
      patch({
        draft: { text, key: state.draft.key },
        exitArmed: false,
        recall: null,
        stash: null,
        slashIndex: 0,
      });
    } catch (error) {
      fail(error);
    }
  }

  function replaceDraft(text: string, extra: Partial<TuiState> = {}) {
    draftCursor = text.length;
    patch({
      ...extra,
      draft: { text, key: state.draft.key + 1 },
      exitArmed: false,
    });
  }

  function inspectorLines(): number {
    const action = recordedActions(state.transcript).find(
      (item) => item.callId === state.inspector.callId,
    );
    if (!action) return 1;
    return inspectorRows(
      action,
      state.inspector.tab,
      state.cols,
      state.theme,
      face,
    ).length;
  }

  function consumes(name: string, focusedId: string | null): boolean {
    if (name === "q") return focusedId !== "prompt";
    if (
      name === "ctrl+c" ||
      name === "escape" ||
      name === "pageup" ||
      name === "pagedown"
    ) {
      return true;
    }
    if (focusedId !== "prompt") return false;
    if (name === "ctrl+o") return state.phase.kind === "idle";
    if (name === "left" || name === "right") {
      return (
        state.inspector.open &&
        state.draft.text === "" &&
        state.phase.kind === "idle"
      );
    }
    if (name === "ctrl+d") {
      return state.draft.text === "" && state.phase.kind === "idle";
    }
    if (name === "tab") {
      if (slashMatches(state.draft.text).length > 0) return true;
      return (
        state.inspector.open &&
        state.draft.text === "" &&
        state.phase.kind === "idle"
      );
    }
    if (name === "up" || name === "down")
      return !state.draft.text.includes("\n");
    if (name === "y" || name === "n") {
      return state.phase.kind === "approval" && state.draft.text === "";
    }
    return name === "enter";
  }

  function allow() {
    settle(true);
  }

  function deny() {
    settle(false);
  }

  function settle(allowed: boolean) {
    if (state.phase.kind !== "approval") return;
    const resolveApproval = pending;
    pending = null;
    if (!resolveApproval) return;
    const transcript = state.transcript.slice();
    const current = transcript[proposalAt];
    if (current?.kind === "tool") {
      transcript[proposalAt] = {
        kind: "tool",
        tone: allowed ? "success" : "warning",
        text: allowed
          ? "Allowed. The turn is still running."
          : "Denied. The proposed call was not approved.",
      };
    }
    proposalAt = -1;
    if (!stopped) patch({ phase: { kind: "running" }, transcript });
    resolveApproval(allowed);
  }

  function approve(detail: string): Promise<boolean> {
    if (stopped || abort?.signal.aborted) return Promise.resolve(false);
    return new Promise((resolveApproval) => {
      pending = resolveApproval;
      proposalAt = state.transcript.length;
      patch({
        phase: { kind: "approval", detail, offset: 0 },
        anchor: null,
        inspector: { ...state.inspector, open: false, offset: 0 },
        transcript: [
          ...state.transcript,
          {
            kind: "tool",
            tone: "info",
            text: "Proposed call. Nothing has run.",
          },
        ],
      });
    });
  }

  function onText(delta: string) {
    const visible = plain(delta);
    if (stopped || visible === "") return;
    const transcript = state.transcript.slice();
    const current = transcript[streamAt];
    if (streamAt >= 0 && current?.kind === "assistant") {
      transcript[streamAt] = {
        kind: "assistant",
        text: current.text + visible,
      };
    } else {
      streamAt = transcript.length;
      transcript.push({ kind: "assistant", text: visible });
    }
    patch({ transcript });
  }

  function cancelTurn() {
    abort?.abort();
    if (pending) settle(false);
  }

  function requestExit() {
    if (stopped) return;
    stopped = true;
    setTimeout(() => {
      void shutdown();
    }, 0);
  }

  function onCtrlC() {
    if (state.phase.kind !== "idle") {
      cancelTurn();
      return;
    }
    if (state.draft.text !== "") {
      draftCursor = 0;
      patch({
        draft: { text: "", key: state.draft.key + 1 },
        exitArmed: true,
        recall: null,
        stash: null,
        transcript: [
          ...state.transcript,
          { kind: "notice", tone: "info", text: EXIT_HINT },
        ],
      });
      return;
    }
    if (!state.exitArmed) {
      patch({
        exitArmed: true,
        transcript: [
          ...state.transcript,
          { kind: "notice", tone: "info", text: EXIT_HINT },
        ],
      });
      return;
    }
    requestExit();
  }

  function onArrow(direction: -1 | 1) {
    const matches = slashMatches(state.draft.text);
    if (matches.length > 0) {
      patch({
        slashIndex: Math.max(
          0,
          Math.min(matches.length - 1, state.slashIndex + direction),
        ),
      });
      return;
    }
    if (state.history.length === 0 && direction < 0) return;
    if (direction < 0) {
      if (state.recall === null) {
        replaceDraft(state.history[state.history.length - 1] ?? "", {
          recall: state.history.length - 1,
          stash: state.draft.text,
        });
        return;
      }
      if (state.recall > 0) {
        replaceDraft(state.history[state.recall - 1] ?? "", {
          recall: state.recall - 1,
          stash: state.stash,
        });
      }
      return;
    }
    if (state.recall === null) return;
    if (state.recall < state.history.length - 1) {
      replaceDraft(state.history[state.recall + 1] ?? "", {
        recall: state.recall + 1,
        stash: state.stash,
      });
      return;
    }
    replaceDraft(state.stash ?? "", { recall: null, stash: null });
  }

  function onPage(direction: -1 | 1) {
    if (state.phase.kind === "approval") {
      const count = proposalRows(
        state.phase.detail,
        state.cols,
        state.theme,
        face,
      ).length;
      patch({
        phase: {
          kind: "approval",
          detail: state.phase.detail,
          offset: Math.max(
            0,
            Math.min(count - 1, state.phase.offset + direction * PAGE_STEP),
          ),
        },
      });
      return;
    }
    if (state.inspector.open && state.phase.kind === "idle") {
      const count = inspectorLines();
      patch({
        inspector: {
          ...state.inspector,
          offset: Math.max(
            0,
            Math.min(count - 1, state.inspector.offset + direction * PAGE_STEP),
          ),
        },
      });
      return;
    }
    const last =
      transcriptRows(state.transcript, state.cols, state.theme, face).length -
      1;
    if (last < 0) return;
    const current =
      state.anchor === null ? last : Math.max(0, Math.min(last, state.anchor));
    const next = Math.max(0, Math.min(last, current + direction * PAGE_STEP));
    patch({ anchor: next >= last ? null : next });
  }

  function toggleInspector() {
    if (state.phase.kind !== "idle") return;
    if (state.inspector.open) {
      patch({ inspector: { ...state.inspector, open: false, offset: 0 } });
      return;
    }
    const actions = recordedActions(state.transcript);
    const last = actions[actions.length - 1];
    if (!last) return;
    const current =
      actions.find((action) => action.callId === state.inspector.callId) ??
      last;
    patch({
      inspector: {
        open: true,
        tab: "output",
        callId: current.callId,
        offset: 0,
      },
    });
  }

  function moveInspector(direction: -1 | 1) {
    if (!state.inspector.open || state.phase.kind !== "idle") return;
    const actions = recordedActions(state.transcript);
    if (actions.length === 0) return;
    const index = actions.findIndex(
      (action) => action.callId === state.inspector.callId,
    );
    const next =
      actions[
        (Math.max(0, index) + direction + actions.length) % actions.length
      ];
    if (!next) return;
    patch({
      inspector: { ...state.inspector, callId: next.callId, offset: 0 },
    });
  }

  function setInspectorTab(tab: InspectorTab) {
    if (!state.inspector.open) return;
    patch({ inspector: { ...state.inspector, tab, offset: 0 } });
  }

  function closeInspector() {
    if (!state.inspector.open) return;
    patch({ inspector: { ...state.inspector, open: false, offset: 0 } });
  }

  function onTab() {
    const matches = slashMatches(state.draft.text);
    if (matches.length > 0) {
      const selected = matches[Math.min(state.slashIndex, matches.length - 1)];
      if (!selected) return;
      replaceDraft(`/${selected.name} `, { slashIndex: 0 });
      return;
    }
    if (!state.inspector.open) return;
    setInspectorTab(state.inspector.tab === "output" ? "raw" : "output");
  }

  function onEnter() {
    const text = state.draft.text;
    if (
      text.endsWith("\\") &&
      !text.includes("\n") &&
      draftCursor === text.length
    ) {
      replaceDraft(`${text.slice(0, -1)}\n`);
      return;
    }
    if (state.phase.kind === "approval" && text === "") {
      deny();
      return;
    }
    void submit().catch(fail);
  }

  function key(name: string, focusedId: string | null = "prompt"): boolean {
    if (!consumes(name, focusedId)) return false;
    try {
      if (name === "q") return true;
      if (name === "ctrl+c") onCtrlC();
      else if (name === "escape") {
        if (state.phase.kind === "approval") deny();
        else if (state.phase.kind === "running") cancelTurn();
        else closeInspector();
      } else if (name === "ctrl+d") onCtrlC();
      else if (name === "ctrl+o") toggleInspector();
      else if (name === "tab") onTab();
      else if (name === "left") moveInspector(-1);
      else if (name === "right") moveInspector(1);
      else if (name === "up") onArrow(-1);
      else if (name === "down") onArrow(1);
      else if (name === "pageup") onPage(-1);
      else if (name === "pagedown") onPage(1);
      else if (name === "y") allow();
      else if (name === "n") deny();
      else if (name === "enter") onEnter();
    } catch (error) {
      fail(error);
    }
    return true;
  }

  async function runCommand(name: CommandName, arg: string) {
    if (name === "help") {
      notice(
        [
          ...commands.map((command) => `/${command.name}  ${command.summary}`),
          "Enter sends the draft. A trailing backslash then Enter inserts a newline only at the end of a single line.",
          "/clear hides the screen only. Saved history stays on disk.",
          "Ctrl-O opens a saved result after the turn is saved. Tab switches Output and Raw result.",
          "Lines that are not one of these commands are sent to the model.",
        ].join("\n"),
      );
      return;
    }
    if (name === "theme") {
      const names = themeNames();
      const requested = arg.trim();
      const next = requested
        ? isThemeName(requested)
          ? requested
          : null
        : (names[(names.indexOf(state.theme) + 1) % names.length] ??
          ONE_DARK_PRO);
      if (!next) {
        notice(
          `Unknown theme "${requested}". Themes: ${names.join(", ")}.`,
          "warning",
        );
        return;
      }
      patch({ theme: next });
      sink?.setTheme(next);
      notice(`Theme is ${next}.`);
      return;
    }
    if (name === "model") {
      const requested = arg.trim();
      if (!requested) {
        notice(`Model is ${state.modelLabel}.`);
        return;
      }
      if (!options.resolveModel) {
        notice("This session cannot change models.");
        return;
      }
      try {
        const resolved = await options.resolveModel(requested);
        if (stopped) return;
        backendModel = resolved;
        const modelLabel = typeof resolved === "string" ? resolved : requested;
        patch({ modelLabel });
        notice(`Model is ${modelLabel}.`);
      } catch (error) {
        notice(redact(error), "error");
      }
      return;
    }
    if (name === "status") {
      notice(
        [
          `Model: ${state.modelLabel}`,
          `Provider: ${state.providerLabel}`,
          `Workspace: ${state.cwd}`,
          `Session: ${state.sessionLabel}`,
          `Theme: ${state.theme}`,
          `Trace: ${state.trace ? "on" : "off"}`,
          `Turn: ${state.phase.kind}`,
        ].join("\n"),
      );
      return;
    }
    if (name === "clear") {
      patch({
        anchor: null,
        inspector: closedInspector,
        transcript: [
          {
            kind: "notice",
            tone: "info",
            text: "Cleared the screen. Saved history was not deleted.",
          },
        ],
      });
      return;
    }
    requestExit();
  }

  async function replaceSavedTurn(start: number, before: readonly unknown[]) {
    if (!history || options.demo || stopped) return;
    const items = await history.getItems();
    if (stopped) return;
    const offset = replayItems(before).reduce(
      (count, entry) => count + (entry.kind === "action" ? 1 : 0),
      0,
    );
    const suffix = replayItems(items.slice(before.length)).map((entry) =>
      entry.kind === "action"
        ? {
            kind: "action" as const,
            action: { ...entry.action, number: entry.action.number + offset },
          }
        : entry,
    );
    patch({
      transcript: [...state.transcript.slice(0, start), ...suffix],
    });
  }

  async function turn(text: string) {
    let before: readonly unknown[] = [];
    try {
      if (history && !options.demo)
        before = cloneItems(await history.getItems());
    } catch (error) {
      notice(redact(error), "error");
      return;
    }
    if (stopped) return;
    const start = state.transcript.length;
    const controller = new AbortController();
    abort = controller;
    streamAt = -1;
    proposalAt = -1;
    replaceDraft("", {
      phase: { kind: "running" },
      inspector: { ...state.inspector, open: false, offset: 0 },
      transcript: [...state.transcript, { kind: "user", text }],
      history: [...state.history, text],
      recall: null,
      stash: null,
      anchor: null,
      slashIndex: 0,
    });
    let saved = false;
    let blocked = state.blocked;
    let message = "";
    try {
      await options.driver({
        text,
        model: backendModel,
        signal: controller.signal,
        onText,
        approve,
      });
      if (controller.signal.aborted) throw cancelledError();
      if (!options.demo) await history?.save();
      saved = true;
    } catch (error) {
      message = controller.signal.aborted ? CANCELLED : redact(error);
      if (history && !options.demo && !saved) {
        try {
          await history.restore(cloneItems(before));
        } catch (restoreError) {
          blocked = true;
          message = `${message}\nCould not restore the session. Later turns are refused so a partial turn cannot be saved.\n${redact(restoreError)}`;
        }
      }
    } finally {
      if (abort === controller) abort = null;
      streamAt = -1;
      if (pending) {
        const resolveApproval = pending;
        pending = null;
        resolveApproval(false);
      }
    }
    if (stopped) {
      if (blocked) state = { ...state, blocked: true };
      return;
    }
    if (!saved) {
      patch({
        phase: { kind: "idle" },
        blocked,
        anchor: null,
        draft: { text, key: state.draft.key + 1 },
        transcript: [
          ...state.transcript.slice(0, start),
          {
            kind: "notice",
            tone: controller.signal.aborted && !blocked ? "warning" : "error",
            text: message || CANCELLED,
          },
        ],
      });
      draftCursor = text.length;
      return;
    }
    patch({ phase: { kind: "idle" }, blocked });
    try {
      await replaceSavedTurn(start, before);
    } catch (error) {
      notice(redact(error), "error");
    }
  }

  async function submit() {
    if (busy || state.blocked || state.phase.kind !== "idle") {
      notice(
        state.blocked && !busy && state.phase.kind === "idle"
          ? "Turns are refused because restoring the session failed."
          : WAIT,
        state.blocked && !busy && state.phase.kind === "idle"
          ? "error"
          : "info",
      );
      return;
    }
    const text = state.draft.text;
    if (text.trim() === "") return;
    const trimmed = text.trim();
    busy = true;
    const task = (async () => {
      if (trimmed.startsWith("/")) {
        const space = trimmed.search(/\s/);
        const name = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
        const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
        const command = commands.find((item) => item.name === name);
        if (command) {
          replaceDraft("", { phase: { kind: "running" } });
          try {
            await runCommand(command.name, arg);
          } finally {
            if (!stopped) patch({ phase: { kind: "idle" } });
          }
          return;
        }
      }
      await turn(text);
    })();
    active = task;
    try {
      await task;
    } catch (error) {
      fail(error);
      if (!stopped && state.phase.kind !== "idle") {
        patch({ phase: { kind: "idle" } });
      }
    } finally {
      if (active === task) active = null;
      busy = false;
    }
  }

  async function shutdown(): Promise<void> {
    if (shutting) return shutting;
    const task = (async () => {
      stopped = true;
      abort?.abort();
      if (pending) {
        const resolveApproval = pending;
        pending = null;
        resolveApproval(false);
      }
      const running = active;
      if (running) await running.catch(() => undefined);
      try {
        await history?.close();
      } catch (error) {
        process.stderr.write(`${redact(error)}\n`);
      }
      painter.dispose();
      sink = null;
      finish();
    })();
    shutting = task;
    return task;
  }

  return {
    get state() {
      return state;
    },
    done,
    render: () => renderTui(state, handlers, face),
    editDraft,
    submit,
    key,
    consumes,
    resize(cols: number) {
      const next = Math.max(1, Math.floor(cols));
      if (state.phase.kind !== "approval") {
        const count = state.inspector.open ? inspectorLines() : 0;
        patch({
          cols: next,
          inspector: state.inspector.open
            ? {
                ...state.inspector,
                offset: Math.min(
                  state.inspector.offset,
                  Math.max(0, count - 1),
                ),
              }
            : state.inspector,
        });
        return;
      }
      const count = proposalRows(
        state.phase.detail,
        next,
        state.theme,
        face,
      ).length;
      patch({
        cols: next,
        phase: {
          kind: "approval",
          detail: state.phase.detail,
          offset: Math.min(state.phase.offset, Math.max(0, count - 1)),
        },
      });
    },
    allow,
    deny,
    connect(next) {
      sink = next;
      publish = true;
      if (!stopped) sink.update(state);
      sink.setTheme(state.theme);
    },
    shutdown,
  };
}
