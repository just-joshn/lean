import {
  ui,
  type ButtonProps,
  type RichTextSpan,
  type TextStyle,
  type VNode,
} from "@rezi-ui/core";
import {
  wrapLines,
  type PaintSource,
  type Painter,
  type VisualRow,
} from "./tui-highlight.ts";
import { isUnifiedDiff, type RecordedAction } from "./tui-replay.ts";
import {
  chromeFor,
  controlOverride,
  toneColor,
  type Chrome,
  type ControlKind,
  type NoticeTone,
  type ThemeName,
} from "./tui-theme.ts";

export { wrapLines };

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
  | { readonly kind: "user" | "assistant"; readonly text: string }
  | {
      readonly kind: "notice" | "tool";
      readonly text: string;
      readonly tone: NoticeTone;
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
  readonly theme: ThemeName;
  readonly paint: number;
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

export type PaintFace = {
  readonly painter: Painter;
  readonly noColor: boolean;
};

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

export function actionTone(status: string): NoticeTone {
  if (status === "completed" || status === "exit 0") return "success";
  if (status === "failed" || status === "error") return "error";
  if (status === "timeout") return "warning";
  const exit = /^exit (\d+)$/.exec(status);
  if (!exit?.[1]) return "muted";
  return exit[1] === "0" ? "success" : "error";
}

export type TranscriptRow = {
  readonly kind: TranscriptEntry["kind"];
  readonly spans: readonly RichTextSpan[];
};

export function transcriptRows(
  entries: readonly TranscriptEntry[],
  cols: number,
  theme: ThemeName,
  face: PaintFace,
): TranscriptRow[] {
  const width = contentWidth(cols);
  const chrome = chromeFor(theme, face.noColor);
  const rows: TranscriptRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "action") {
      for (const row of actionRows(entry.action, width, chrome)) {
        rows.push({ kind: "action", spans: row.spans });
      }
      continue;
    }
    if (entry.kind === "assistant") {
      rows.push({
        kind: "assistant",
        spans: [{ text: "*", style: ink(chrome.accent, chrome.canvas, true) }],
      });
    }
    const source = sourceFor(entry);
    const prefix =
      entry.kind === "user"
        ? { text: "> ", style: ink(chrome.accent, chrome.canvas, true) }
        : undefined;
    for (const row of face.painter.rows({ theme, source, width, prefix })) {
      rows.push({ kind: entry.kind, spans: row.spans });
    }
  }
  return rows;
}

export function proposalRows(
  detail: string,
  cols: number,
  theme: ThemeName,
  face: PaintFace,
): readonly VisualRow[] {
  return face.painter.rows({
    theme,
    source: jsonSource(detail),
    width: Math.max(10, cols),
  });
}

export function inspectorRows(
  action: RecordedAction,
  tab: InspectorTab,
  cols: number,
  theme: ThemeName,
  face: PaintFace,
): readonly VisualRow[] {
  const width = Math.max(10, cols - 1);
  const body = tab === "raw" ? action.raw : action.output;
  if (body.length === 0) {
    return face.painter.rows({
      theme,
      source: { kind: "plain", text: "(empty)", tone: "muted" },
      width,
    });
  }
  const source: PaintSource =
    tab === "raw"
      ? { kind: "json", text: body }
      : isUnifiedDiff(action.output)
        ? { kind: "diff", text: body }
        : action.sourcePath
          ? { kind: "file", text: body, path: action.sourcePath }
          : { kind: "plain", text: body, tone: "muted" };
  return face.painter.rows({ theme, source, width });
}

export function renderTui(
  state: TuiState,
  handlers: TuiHandlers,
  face: PaintFace,
): VNode {
  const chrome = chromeFor(state.theme, face.noColor);
  const text = ink(chrome.text, chrome.canvas);
  const muted = ink(chrome.muted, chrome.canvas);
  const matches = slashMatches(state.draft.text);
  const slashIndex =
    matches.length === 0 ? 0 : Math.min(state.slashIndex, matches.length - 1);
  const width = Math.max(10, state.cols);
  const actions = recordedActions(state.transcript);
  const selected =
    actions.find((action) => action.callId === state.inspector.callId) ??
    actions[actions.length - 1];
  const button = (props: ButtonProps, kind: ControlKind): VNode => {
    const node = ui.button({
      ...props,
      dsSize: "sm",
      focusConfig: { indicator: "none" },
      pressedStyle: { dim: false },
      style: { dim: false },
    });
    const override = controlOverride(state.theme, face.noColor, kind);
    return override ? ui.themed(override, [node]) : node;
  };
  const children: VNode[] = [
    ui.row({ width: "full", height: 1, gap: 0 }, [
      ui.text("* ", { fg: chrome.accent, bold: true, dim: false }),
      ui.text("Lean ", { fg: chrome.text, bold: true, dim: false }),
      ui.text(`${state.cwd} · ${state.modelLabel}`, {
        style: muted,
        textOverflow: "ellipsis",
        maxWidth: Math.max(1, width - 8),
      }),
    ]),
    ui.divider({ color: "border.subtle" }),
  ];

  const rows = transcriptRows(state.transcript, state.cols, state.theme, face);
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
        renderItem: (row) => ui.richText(row.spans),
      }),
    );
  }

  const composer: VNode[] = [];
  if (state.phase.kind === "approval") {
    const lines = proposalRows(
      state.phase.detail,
      state.cols,
      state.theme,
      face,
    );
    const offset = Math.max(0, Math.min(lines.length - 1, state.phase.offset));
    children.push(
      ui.text("Proposed call. Nothing has run.", {
        fg: chrome.text,
        bold: true,
        dim: false,
      }),
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
        renderItem: (line) => ui.richText(line.spans),
      }),
    );
    composer.push(
      ui.row({ gap: 1 }, [
        button(
          {
            id: "allow",
            label: "Allow",
            dsVariant: "soft",
            dsTone: "success",
            onPress: handlers.allow,
          },
          "success",
        ),
        button(
          {
            id: "deny",
            label: "Deny",
            dsVariant: "soft",
            dsTone: "danger",
            onPress: handlers.deny,
          },
          "danger",
        ),
      ]),
    );
  } else if (state.phase.kind === "idle" && selected && state.inspector.open) {
    const lines = inspectorRows(
      selected,
      state.inspector.tab,
      state.cols,
      state.theme,
      face,
    );
    const offset = Math.max(
      0,
      Math.min(lines.length - 1, state.inspector.offset),
    );
    children.push(
      clip(
        `Recorded ${String(selected.number).padStart(2, "0")} · ${selected.summary}`,
        width,
        text,
      ),
      ui.row({ gap: 1 }, [
        button(
          {
            id: "tab-output",
            label: "Output",
            dsVariant: state.inspector.tab === "output" ? "solid" : "soft",
            dsTone: state.inspector.tab === "output" ? "primary" : "default",
            onPress: () => handlers.setInspectorTab("output"),
          },
          state.inspector.tab === "output" ? "tab" : "secondary",
        ),
        button(
          {
            id: "tab-raw",
            label: "Raw result",
            dsVariant: state.inspector.tab === "raw" ? "solid" : "soft",
            dsTone: state.inspector.tab === "raw" ? "primary" : "default",
            onPress: () => handlers.setInspectorTab("raw"),
          },
          state.inspector.tab === "raw" ? "tab" : "secondary",
        ),
        button(
          {
            id: "inspect-close",
            label: "Close",
            dsVariant: "soft",
            dsTone: "default",
            onPress: handlers.closeInspector,
          },
          "secondary",
        ),
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
        renderItem: (line) => ui.richText(line.spans),
      }),
    );
  } else if (state.phase.kind === "idle" && selected) {
    children.push(
      ui.row({ width: "full", gap: 1 }, [
        clip(
          `Recorded ${String(selected.number).padStart(2, "0")} · ${selected.summary}`,
          Math.max(10, width - 12),
          text,
        ),
        button(
          {
            id: "inspect",
            label: "Inspect",
            dsVariant: "soft",
            dsTone: "default",
            onPress: handlers.toggleInspector,
          },
          "secondary",
        ),
      ]),
    );
  }

  composer.push(
    ui.row({ width: "full", height: 1, gap: 0 }, [
      ui.text(">", { fg: chrome.accent, bold: true, dim: false }),
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
    ui.divider({ color: "border.subtle" }),
    ui.focusTrap({ id: "composer", active: true, initialFocus: "prompt" }, [
      ui.column({ gap: 0, width: "full" }, composer),
    ]),
    ui.divider({ color: "border.subtle" }),
  );

  if (matches.length > 0) {
    for (const [index, command] of matches.entries()) {
      const mark = index === slashIndex ? ">" : " ";
      const selectedRow = index === slashIndex;
      children.push(
        clip(
          `${mark} /${command.name}  ${command.summary}`,
          width,
          selectedRow ? ink(chrome.selectedFg, chrome.selectedBg) : text,
        ),
      );
    }
  } else if (state.phase.kind === "approval") {
    children.push(
      clip(
        "y allow · n, enter, or esc deny · page up and page down scroll",
        width,
        muted,
      ),
    );
  } else if (state.inspector.open) {
    children.push(
      clip("tab output/raw · left right select · esc close", width, muted),
    );
  } else {
    children.push(
      clip(
        actions.length > 0
          ? "enter send · esc cancel · ctrl-c interrupt · ctrl-o results · /help"
          : "enter send · esc cancel · ctrl-c interrupt · /help",
        width,
        muted,
      ),
    );
  }

  return ui.column(
    {
      height: "full",
      width: "full",
      gap: 0,
      style: { fg: chrome.text, bg: chrome.canvas, dim: false },
    },
    children,
  );
}

function sourceFor(
  entry: Exclude<TranscriptEntry, { kind: "action" }>,
): PaintSource {
  if (entry.kind === "notice" || entry.kind === "tool") {
    return { kind: "plain", text: entry.text, tone: entry.tone };
  }
  return {
    kind: "markdown",
    text: entry.kind === "assistant" ? entry.text || "…" : entry.text,
  };
}

function actionRows(
  action: RecordedAction,
  width: number,
  chrome: Chrome,
): readonly VisualRow[] {
  const head = `${String(action.number).padStart(2, "0")}  ${action.summary}  `;
  const text = `${head}${action.status}`;
  const before = ink(chrome.text, chrome.canvas);
  const after = ink(
    toneColor(chrome, actionTone(action.status)),
    chrome.canvas,
  );
  const rows: VisualRow[] = [];
  let cursor = 0;
  for (const [index, paragraph] of text.split("\n").entries()) {
    if (index > 0) cursor += 1;
    for (const line of wrapLines(paragraph, width)) {
      rows.push({
        spans: splitLine(line, cursor, head.length, before, after),
      });
      cursor += line.length;
    }
  }
  return rows.length > 0 ? rows : [{ spans: [{ text: " ", style: before }] }];
}

function splitLine(
  line: string,
  start: number,
  cut: number,
  before: TextStyle,
  after: TextStyle,
): readonly RichTextSpan[] {
  if (line.length === 0) {
    return [{ text: " ", style: start >= cut ? after : before }];
  }
  const end = start + line.length;
  if (end <= cut) return [{ text: line, style: before }];
  if (start >= cut) return [{ text: line, style: after }];
  const at = cut - start;
  return [
    { text: line.slice(0, at), style: before },
    { text: line.slice(at), style: after },
  ];
}

function jsonSource(detail: string): PaintSource {
  try {
    return { kind: "json", text: JSON.stringify(JSON.parse(detail), null, 2) };
  } catch {
    return { kind: "plain", text: detail, tone: "muted" };
  }
}

function contentWidth(cols: number): number {
  return Math.max(10, cols - 1);
}

function ink(fg: number, bg: number, bold = false): TextStyle {
  return {
    fg,
    bg,
    bold,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };
}

function clip(text: string, width: number, style: TextStyle): VNode {
  return ui.text(text, {
    style,
    textOverflow: "ellipsis",
    maxWidth: width,
  });
}
