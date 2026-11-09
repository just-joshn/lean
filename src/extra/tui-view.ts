import {
  measureTextCells,
  rgb,
  ui,
  type ThemePresetName,
  type VNode,
} from "@rezi-ui/core";
import { diffKind, isUnifiedDiff, type RecordedAction } from "./tui-replay.ts";

export const commands = [
  { name: "help", summary: "List commands and limits" },
  { name: "theme", summary: "Cycle themes, or /theme <name>" },
  { name: "model", summary: "Set the model for the next turn" },
  { name: "status", summary: "Show the model, workspace, and session" },
  { name: "clear", summary: "Clear the screen without deleting saved history" },
  { name: "exit", summary: "Leave the chat" },
] as const;

export type CommandName = (typeof commands)[number]["name"];

export type TranscriptEntry =
  | {
      readonly kind: "user" | "assistant" | "notice" | "tool";
      readonly text: string;
    }
  | { readonly kind: "action"; readonly action: RecordedAction };

export type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "approval";
      readonly detail: string;
      readonly offset: number;
    };

export type InspectorTab = "output" | "raw";

export type InspectorState = {
  readonly open: boolean;
  readonly tab: InspectorTab;
  readonly callId: string | null;
  readonly offset: number;
};

export type TuiState = {
  readonly demo: boolean;
  readonly cwd: string;
  readonly modelLabel: string;
  readonly providerLabel: string;
  readonly sessionLabel: string;
  readonly trace: boolean;
  readonly theme: ThemePresetName;
  readonly cols: number;
  readonly phase: Phase;
  readonly blocked: boolean;
  readonly exitArmed: boolean;
  readonly draft: { readonly text: string; readonly key: number };
  readonly slashIndex: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly history: readonly string[];
  readonly recall: number | null;
  readonly stash: string | null;
  readonly anchor: number | null;
  readonly inspector: InspectorState;
};

export type TuiHandlers = {
  editDraft: (text: string, cursor?: number) => void;
  allow: () => void;
  deny: () => void;
  toggleInspector: () => void;
  setInspectorTab: (tab: InspectorTab) => void;
  closeInspector: () => void;
};

const orange = rgb(255, 180, 84);
const green = rgb(170, 217, 76);
const red = rgb(240, 113, 120);
const PROPOSAL_ROWS = 6;
const INSPECTOR_ROWS = 8;

export function slashMatches(
  text: string,
): readonly (typeof commands)[number][] {
  if (!text.startsWith("/") || text.includes(" ") || text.includes("\n")) {
    return [];
  }
  const prefix = text.slice(1);
  return commands.filter((command) => command.name.startsWith(prefix));
}

export function recordedActions(
  transcript: readonly TranscriptEntry[],
): readonly RecordedAction[] {
  return transcript.flatMap((entry) =>
    entry.kind === "action" ? [entry.action] : [],
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function wrapLines(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let line = "";
    let cells = 0;
    for (const { segment } of graphemes.segment(paragraph)) {
      const size = measureTextCells(segment);
      if (line !== "" && cells + size > max) {
        lines.push(line);
        line = "";
        cells = 0;
      }
      line += segment;
      cells += size;
    }
    lines.push(line);
  }
  return lines;
}

export function proposalLines(detail: string, cols: number): readonly string[] {
  let formatted = detail;
  try {
    formatted = JSON.stringify(JSON.parse(detail), null, 2);
  } catch {
    formatted = detail;
  }
  const lines = wrapLines(formatted, Math.max(10, cols));
  return lines.length > 0 ? lines : [""];
}

export function actionLabel(action: RecordedAction, cols: number): string {
  const prefix = `${String(action.number).padStart(2, "0")}  `;
  const width = Math.max(prefix.length + 1, cols);
  const room = width - prefix.length - action.status.length - 1;
  let summary = action.summary;
  if (room >= 4 && summary.length > room) {
    summary = `${summary.slice(0, Math.max(1, room - 1))}…`;
  }
  const gap = Math.max(
    1,
    width - prefix.length - summary.length - action.status.length,
  );
  return `${prefix}${summary}${" ".repeat(gap)}${action.status}`.slice(
    0,
    width,
  );
}

function clip(text: string, width: number): VNode {
  return ui.text(text, { textOverflow: "ellipsis", maxWidth: width });
}

export type TranscriptRow = {
  readonly kind: TranscriptEntry["kind"];
  readonly text: string;
};

function contentWidth(cols: number): number {
  return Math.max(10, cols - 1);
}

export function transcriptRows(
  entries: readonly TranscriptEntry[],
  cols: number,
): TranscriptRow[] {
  const width = contentWidth(cols);
  const rows: TranscriptRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "action") {
      rows.push({
        kind: "action",
        text: actionLabel(entry.action, width),
      });
      continue;
    }
    if (entry.kind === "assistant") rows.push({ kind: "assistant", text: "*" });
    const source =
      entry.kind === "user"
        ? `> ${entry.text}`
        : entry.kind === "assistant"
          ? entry.text || "…"
          : entry.text;
    for (const line of wrapLines(source, width)) {
      rows.push({ kind: entry.kind, text: line });
    }
  }
  return rows;
}

function renderRow(row: TranscriptRow): VNode {
  if (row.kind === "assistant" && row.text === "*") {
    return ui.text("*", { fg: orange, bold: true });
  }
  const shown = row.text.length > 0 ? row.text : " ";
  if (row.kind === "notice" || row.kind === "tool") {
    return ui.text(shown, { dim: true });
  }
  return ui.text(shown);
}

function renderDiffLine(line: string, colorDiff: boolean): VNode {
  const shown = line.length > 0 ? line : " ";
  if (!colorDiff) return ui.text(shown);
  const kind = diffKind(line);
  if (kind === "add") return ui.text(shown, { fg: green });
  if (kind === "del") return ui.text(shown, { fg: red });
  if (kind === "meta") return ui.text(shown, { dim: true });
  return ui.text(shown);
}

export function renderTui(state: TuiState, handlers: TuiHandlers): VNode {
  const matches = slashMatches(state.draft.text);
  const slashIndex =
    matches.length === 0 ? 0 : Math.min(state.slashIndex, matches.length - 1);
  const width = Math.max(10, state.cols);
  const actions = recordedActions(state.transcript);
  const selected =
    actions.find((action) => action.callId === state.inspector.callId) ??
    actions[actions.length - 1];
  const children: VNode[] = [
    ui.row({ width: "full", height: 1, gap: 0 }, [
      ui.text("* ", { fg: orange, bold: true }),
      ui.text("Lean ", { bold: true }),
      ui.text(`${state.cwd} · ${state.modelLabel}`, {
        style: { dim: true },
        textOverflow: "ellipsis",
        maxWidth: Math.max(1, width - 8),
      }),
    ]),
    ui.divider(),
  ];

  const rows = transcriptRows(state.transcript, state.cols);
  if (rows.length === 0) {
    children.push(ui.spacer({ flex: 1 }));
  } else {
    const last = rows.length - 1;
    const pinned =
      state.anchor === null ? null : Math.max(0, Math.min(last, state.anchor));
    children.push(
      ui.virtualList({
        id:
          pinned === null ? "transcript" : `transcript:${pinned}:${state.cols}`,
        flex: 1,
        width: "full",
        focusable: false,
        keyboardNavigation: false,
        items: rows,
        itemHeight: 1,
        ensureVisibleIndex: pinned ?? last,
        ensureVisibleMode: pinned === null ? "sticky" : "always",
        renderItem: (row) => renderRow(row),
      }),
    );
  }

  const composer: VNode[] = [];
  if (state.phase.kind === "approval") {
    const lines = proposalLines(state.phase.detail, state.cols);
    const offset = Math.max(0, Math.min(lines.length - 1, state.phase.offset));
    children.push(
      ui.text("Proposed call. Nothing has run.", { style: { bold: true } }),
      ui.virtualList({
        id: "proposal",
        width: "full",
        height: Math.min(PROPOSAL_ROWS, lines.length),
        focusable: false,
        keyboardNavigation: false,
        items: lines,
        itemHeight: 1,
        ensureVisibleIndex: offset,
        ensureVisibleMode: "always",
        renderItem: (line) => ui.text(line.length > 0 ? line : " "),
      }),
    );
    composer.push(
      ui.row({ gap: 1 }, [
        ui.button({
          id: "allow",
          label: "Allow",
          intent: "success",
          dsSize: "sm",
          onPress: handlers.allow,
        }),
        ui.button({
          id: "deny",
          label: "Deny",
          intent: "danger",
          dsSize: "sm",
          onPress: handlers.deny,
        }),
      ]),
    );
  } else if (state.phase.kind === "idle" && selected && state.inspector.open) {
    const body = state.inspector.tab === "raw" ? selected.raw : selected.output;
    const shown = body.length > 0 ? body : "(empty)";
    const colorDiff =
      state.inspector.tab === "output" && isUnifiedDiff(selected.output);
    const lines = wrapLines(shown, Math.max(10, state.cols - 1));
    const offset = Math.max(
      0,
      Math.min(lines.length - 1, state.inspector.offset),
    );
    children.push(
      clip(
        `Recorded ${String(selected.number).padStart(2, "0")} · ${selected.summary}`,
        width,
      ),
      ui.row({ gap: 1 }, [
        ui.button({
          id: "tab-output",
          label: "Output",
          intent: state.inspector.tab === "output" ? "primary" : "secondary",
          dsSize: "sm",
          onPress: () => handlers.setInspectorTab("output"),
        }),
        ui.button({
          id: "tab-raw",
          label: "Raw result",
          intent: state.inspector.tab === "raw" ? "primary" : "secondary",
          dsSize: "sm",
          onPress: () => handlers.setInspectorTab("raw"),
        }),
        ui.button({
          id: "inspect-close",
          label: "Close",
          dsSize: "sm",
          onPress: handlers.closeInspector,
        }),
      ]),
      ui.virtualList({
        id: "inspector-body",
        width: "full",
        height: Math.min(INSPECTOR_ROWS, Math.max(1, lines.length)),
        focusable: false,
        keyboardNavigation: false,
        items: lines,
        itemHeight: 1,
        ensureVisibleIndex: offset,
        ensureVisibleMode: "always",
        renderItem: (line) => renderDiffLine(line, colorDiff),
      }),
    );
  } else if (state.phase.kind === "idle" && selected) {
    children.push(
      ui.row({ width: "full", gap: 1 }, [
        clip(
          `Recorded ${String(selected.number).padStart(2, "0")} · ${selected.summary}`,
          Math.max(10, width - 12),
        ),
        ui.button({
          id: "inspect",
          label: "Inspect",
          dsSize: "sm",
          onPress: handlers.toggleInspector,
        }),
      ]),
    );
  }

  composer.push(
    ui.row({ width: "full", height: 1, gap: 0 }, [
      ui.text(">", { fg: orange, bold: true }),
      ui.textarea({
        id: "prompt",
        key: `p${state.draft.key}`,
        value: state.draft.text,
        rows: 1,
        placeholder: "",
        focusConfig: { indicator: "none" },
        onInput: (value, cursor) => handlers.editDraft(value, cursor),
      }),
    ]),
  );

  children.push(
    ui.divider(),
    ui.focusTrap({ id: "composer", active: true, initialFocus: "prompt" }, [
      ui.column({ gap: 0, width: "full" }, composer),
    ]),
    ui.divider(),
  );

  if (matches.length > 0) {
    for (const [index, command] of matches.entries()) {
      const mark = index === slashIndex ? ">" : " ";
      children.push(
        clip(`${mark} /${command.name}  ${command.summary}`, width),
      );
    }
  } else if (state.phase.kind === "approval") {
    children.push(
      clip(
        "y allow · n, enter, or esc deny · page up and page down scroll",
        width,
      ),
    );
  } else if (state.inspector.open) {
    children.push(
      clip("tab output/raw · left right select · esc close", width),
    );
  } else {
    children.push(
      clip(
        actions.length > 0
          ? "enter send · esc cancel · ctrl-c interrupt · ctrl-o results · /help"
          : "enter send · esc cancel · ctrl-c interrupt · /help",
        width,
      ),
    );
  }

  return ui.column({ height: "full", width: "full", gap: 0 }, children);
}
