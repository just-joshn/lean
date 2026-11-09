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

export type ScrollEdge = "top" | "bottom";

export type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | {
      readonly kind: "approval";
      readonly detail: string;
      readonly offset: number;
      readonly edge: ScrollEdge;
    };

export type InspectorTab = "output" | "raw";

export type InspectorState = {
  readonly open: boolean;
  readonly tab: InspectorTab;
  readonly callId: string | null;
  readonly offset: number;
  readonly edge: ScrollEdge;
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
  readonly rows: number;
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
  readonly scrollEdge: ScrollEdge;
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

const PROPOSAL_CAP = 6;
const INSPECTOR_CAP = 8;

export type PaneActivity = "transcript" | "proposal" | "inspector";

type PaneHeights = {
  header: number;
  beforeTranscript: number;
  transcript: number;
  proposalLabel: number;
  proposal: number;
  inspectorTitle: number;
  inspectorTabs: number;
  inspector: number;
  record: number;
  beforeComposer: number;
  buttons: number;
  prompt: number;
  afterComposer: number;
  footer: number;
  slash: number;
};

export type PanePlan = {
  readonly chromeWidth: number;
  readonly contentWidth: number;
  readonly proposalWidth: number;
  readonly heights: PaneHeights;
  readonly slashStart: number;
  readonly pageSize: number;
};

type PaneSlot = {
  id: keyof PaneHeights;
  want: number;
  min: number;
  rank: number;
};

const emptyHeights = (): PaneHeights => ({
  header: 0,
  beforeTranscript: 0,
  transcript: 0,
  proposalLabel: 0,
  proposal: 0,
  inspectorTitle: 0,
  inspectorTabs: 0,
  inspector: 0,
  record: 0,
  beforeComposer: 0,
  buttons: 0,
  prompt: 0,
  afterComposer: 0,
  footer: 0,
  slash: 0,
});

export function panePlan(input: {
  readonly rows: number;
  readonly cols: number;
  readonly slashMatches: number;
  readonly slashIndex: number;
  readonly active: PaneActivity;
  readonly transcriptLines: number;
  readonly proposalLines: number;
  readonly inspectorLines: number;
  readonly record: boolean;
}): PanePlan {
  const cols = Math.max(1, Math.floor(input.cols));
  const rows = Math.max(1, Math.floor(input.rows));
  const slots: PaneSlot[] = [
    { id: "header", want: 1, min: 0, rank: 4 },
    { id: "beforeTranscript", want: 1, min: 0, rank: 0 },
    {
      id: "transcript",
      want: 0,
      min: 0,
      rank: input.active === "transcript" ? 100 : 2,
    },
  ];
  if (input.proposalLines > 0) {
    slots.push(
      { id: "proposalLabel", want: 1, min: 0, rank: 6 },
      {
        id: "proposal",
        want: Math.min(PROPOSAL_CAP, input.proposalLines),
        min: 0,
        rank: input.active === "proposal" ? 100 : 2,
      },
      { id: "buttons", want: 1, min: 0, rank: 6 },
    );
  }
  if (input.inspectorLines > 0) {
    slots.push(
      { id: "inspectorTitle", want: 1, min: 0, rank: 6 },
      { id: "inspectorTabs", want: 1, min: 0, rank: 6 },
      {
        id: "inspector",
        want: Math.min(INSPECTOR_CAP, input.inspectorLines),
        min: 0,
        rank: input.active === "inspector" ? 100 : 2,
      },
    );
  }
  if (input.record) slots.push({ id: "record", want: 1, min: 0, rank: 3 });
  slots.push(
    { id: "beforeComposer", want: 1, min: 0, rank: 0 },
    { id: "prompt", want: 1, min: 1, rank: 8 },
    { id: "afterComposer", want: 1, min: 0, rank: 0 },
  );
  if (input.slashMatches > 0) {
    slots.push({
      id: "slash",
      want: input.slashMatches,
      min: 0,
      rank: 1,
    });
  } else {
    slots.push({ id: "footer", want: 1, min: 0, rank: 5 });
  }

  const heights = emptyHeights();
  for (const slot of slots) heights[slot.id] = slot.want;
  const activeId: keyof PaneHeights =
    input.active === "proposal"
      ? "proposal"
      : input.active === "inspector"
        ? "inspector"
        : "transcript";
  const activeLines =
    input.active === "proposal"
      ? input.proposalLines
      : input.active === "inspector"
        ? input.inspectorLines
        : input.transcriptLines;
  const activeCap =
    input.active === "transcript" ? Number.POSITIVE_INFINITY : activeLines;
  const sum = () => {
    let total = 0;
    for (const slot of slots) total += heights[slot.id];
    return total;
  };
  let extra = rows - sum();
  if (extra > 0) {
    const room = Math.max(0, activeCap - heights[activeId]);
    const give = Math.min(extra, room);
    heights[activeId] += give;
    extra -= give;
  }
  if (extra > 0 && activeId !== "transcript") heights.transcript += extra;
  const ranked = [...slots].sort((left, right) => left.rank - right.rank);
  let shrunk = true;
  while (sum() > rows && shrunk) {
    shrunk = false;
    for (const slot of ranked) {
      if (sum() <= rows) break;
      if (heights[slot.id] > slot.min) {
        heights[slot.id] -= 1;
        shrunk = true;
      }
    }
  }
  const floor = activeLines > 0 ? 1 : 0;
  while (heights[activeId] < floor) {
    const donor = ranked.find(
      (slot) => slot.id !== activeId && heights[slot.id] > slot.min,
    );
    if (!donor) break;
    heights[donor.id] -= 1;
    heights[activeId] += 1;
  }
  return {
    chromeWidth: cols,
    contentWidth: Math.max(1, cols - 1),
    proposalWidth: cols,
    heights,
    slashStart: slashStart(input.slashMatches, input.slashIndex, heights.slash),
    pageSize: heights[activeId],
  };
}

function slashStart(count: number, index: number, height: number): number {
  if (height <= 0 || height >= count) return 0;
  const selected = Math.max(0, Math.min(count - 1, index));
  return Math.max(
    0,
    Math.min(count - height, selected - Math.floor((height - 1) / 2)),
  );
}

export function pageTop(
  top: number,
  count: number,
  pageSize: number,
  direction: -1 | 1,
): { top: number; edge: ScrollEdge } {
  const size = Math.max(1, pageSize);
  const maxTop = Math.max(0, count - size);
  const current = Math.max(0, Math.min(maxTop, top));
  const next = Math.max(0, Math.min(maxTop, current + direction * size));
  return { top: next, edge: direction < 0 ? "top" : "bottom" };
}

export function ensuredIndex(
  top: number | null,
  count: number,
  pageSize: number,
  edge: ScrollEdge,
): { index: number; sticky: boolean } {
  if (count <= 0) return { index: 0, sticky: true };
  if (top === null) return { index: count - 1, sticky: true };
  const clamped = Math.max(0, Math.min(count - 1, top));
  if (edge === "bottom") {
    return {
      index: Math.min(count - 1, clamped + Math.max(1, pageSize) - 1),
      sticky: false,
    };
  }
  return { index: clamped, sticky: false };
}

export function screenPlan(state: TuiState, face: PaintFace) {
  const active: PaneActivity =
    state.phase.kind === "approval"
      ? "proposal"
      : state.inspector.open && state.phase.kind === "idle"
        ? "inspector"
        : "transcript";
  const transcript = transcriptRows(
    state.transcript,
    state.cols,
    state.theme,
    face,
  );
  const proposal =
    state.phase.kind === "approval"
      ? proposalRows(state.phase.detail, state.cols, state.theme, face)
      : [];
  const actions = recordedActions(state.transcript);
  const selected =
    actions.find((action) => action.callId === state.inspector.callId) ??
    actions[actions.length - 1];
  const inspector =
    active === "inspector" && selected
      ? inspectorRows(
          selected,
          state.inspector.tab,
          state.cols,
          state.theme,
          face,
        )
      : [];
  return {
    active,
    transcript,
    proposal,
    inspector,
    selected,
    plan: panePlan({
      rows: state.rows,
      cols: state.cols,
      slashMatches: slashMatches(state.draft.text).length,
      slashIndex: state.slashIndex,
      active,
      transcriptLines: transcript.length,
      proposalLines: proposal.length,
      inspectorLines: inspector.length,
      record: active === "transcript" && selected !== undefined,
    }),
  };
}

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

const outcomeRank = { success: 0, muted: 1, warning: 2, error: 3 } as const;

function outcomeTone(status: string): keyof typeof outcomeRank {
  if (status === "completed" || status === "exit 0") return "success";
  if (status === "failed" || status === "error") return "error";
  if (status === "timeout") return "warning";
  const exit = /^exit (\d+)$/.exec(status);
  if (!exit?.[1]) return "muted";
  return exit[1] === "0" ? "success" : "error";
}

export function actionTone(status: string): NoticeTone {
  let best: keyof typeof outcomeRank = "success";
  for (const part of status.split(", ")) {
    const tone = outcomeTone(part);
    if (outcomeRank[tone] > outcomeRank[best]) best = tone;
  }
  return best;
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
    width: Math.max(1, cols),
  });
}

export function inspectorRows(
  action: RecordedAction,
  tab: InspectorTab,
  cols: number,
  theme: ThemeName,
  face: PaintFace,
): readonly VisualRow[] {
  const width = Math.max(1, cols - 1);
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
      : action.sourcePath
        ? { kind: "file", text: body, path: action.sourcePath }
        : isUnifiedDiff(action.output)
          ? { kind: "diff", text: body }
          : { kind: "plain", text: body, tone: "text" };
  return face.painter.rows({ theme, source, width });
}

export function renderTui(
  state: TuiState,
  handlers: TuiHandlers,
  face: PaintFace,
): VNode {
  const chrome = chromeFor(state.theme, face.noColor);
  const text = ink(chrome.text, chrome.canvas);
  const secondary = ink(chrome.secondary, chrome.canvas);
  const screen = screenPlan(state, face);
  const { plan } = screen;
  const grow =
    state.phase.kind === "approval" && plan.heights.proposal > 0
      ? "proposal"
      : state.inspector.open && plan.heights.inspector > 0
        ? "inspector"
        : "transcript";
  const paneSize = (id: typeof grow, height: number) =>
    id === grow ? { flex: 1 } : { height };
  const width = plan.chromeWidth;
  const matches = slashMatches(state.draft.text);
  const selected = screen.selected;
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
  const children: VNode[] = [];
  if (plan.heights.header > 0) {
    children.push(
      ui.row({ width: "full", height: 1, gap: 0 }, [
        ui.text("* ", { fg: chrome.accent, bold: true, dim: false }),
        ui.text("Lean ", { fg: chrome.text, bold: true, dim: false }),
        ui.text(`${state.cwd} · ${state.modelLabel}`, {
          style: secondary,
          textOverflow: "ellipsis",
          maxWidth: Math.max(1, width - 8),
        }),
      ]),
    );
  }
  if (plan.heights.beforeTranscript > 0) {
    children.push(ui.divider({ color: "border.subtle" }));
  }
  if (screen.transcript.length === 0) {
    if (plan.heights.transcript > 0) {
      children.push(ui.spacer({ size: plan.heights.transcript }));
    }
  } else if (plan.heights.transcript > 0) {
    const target = ensuredIndex(
      state.anchor,
      screen.transcript.length,
      plan.heights.transcript,
      state.scrollEdge,
    );
    children.push(
      ui.virtualList({
        id: "transcript",
        width: "full",
        ...paneSize("transcript", plan.heights.transcript),
        focusable: false,
        keyboardNavigation: false,
        items: screen.transcript,
        itemHeight: 1,
        ensureVisibleIndex: target.index,
        ensureVisibleMode: target.sticky ? "sticky" : "always",
        renderItem: (row) => ui.richText(row.spans),
      }),
    );
  }

  const composer: VNode[] = [];
  if (state.phase.kind === "approval") {
    if (plan.heights.proposalLabel > 0) {
      children.push(
        ui.text("Proposed call. Nothing has run.", {
          fg: chrome.text,
          bold: true,
          dim: false,
        }),
      );
    }
    if (plan.heights.proposal > 0) {
      const target = ensuredIndex(
        state.phase.offset,
        screen.proposal.length,
        plan.heights.proposal,
        state.phase.edge,
      );
      children.push(
        ui.virtualList({
          id: "proposal",
          width: "full",
          ...paneSize("proposal", plan.heights.proposal),
          focusable: false,
          keyboardNavigation: false,
          items: screen.proposal,
          itemHeight: 1,
          ensureVisibleIndex: target.index,
          ensureVisibleMode: "always",
          renderItem: (line) => ui.richText(line.spans),
        }),
      );
    }
    if (plan.heights.buttons > 0)
      composer.push(
        ui.row({ height: 1, gap: 1 }, [
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
  } else if (
    state.phase.kind === "idle" &&
    selected &&
    state.inspector.open &&
    plan.heights.inspector > 0
  ) {
    const target = ensuredIndex(
      state.inspector.offset,
      screen.inspector.length,
      plan.heights.inspector,
      state.inspector.edge,
    );
    if (plan.heights.inspectorTitle > 0) {
      children.push(
        clip(
          `Recorded ${String(selected.number).padStart(2, "0")} · ${selected.summary}`,
          width,
          text,
        ),
      );
    }
    if (plan.heights.inspectorTabs > 0) {
      children.push(
        ui.row({ height: 1, gap: 1 }, [
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
      );
    }
    children.push(
      ui.virtualList({
        id: "inspector-body",
        width: "full",
        ...paneSize("inspector", plan.heights.inspector),
        focusable: false,
        keyboardNavigation: false,
        items: screen.inspector,
        itemHeight: 1,
        ensureVisibleIndex: target.index,
        ensureVisibleMode: "always",
        renderItem: (line) => ui.richText(line.spans),
      }),
    );
  } else if (plan.heights.record > 0 && selected) {
    children.push(
      ui.row({ width: "full", height: 1, gap: 1 }, [
        clip(
          `Recorded ${String(selected.number).padStart(2, "0")} · ${selected.summary}`,
          Math.max(1, width - 12),
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

  if (plan.heights.beforeComposer > 0) {
    children.push(ui.divider({ color: "border.subtle" }));
  }
  if (plan.heights.prompt > 0) {
    children.push(
      ui.focusTrap({ id: "composer", active: true, initialFocus: "prompt" }, [
        ui.column({ gap: 0, width: "full" }, composer),
      ]),
    );
  }
  if (plan.heights.afterComposer > 0) {
    children.push(ui.divider({ color: "border.subtle" }));
  }

  if (plan.heights.slash > 0) {
    const visible = matches.slice(
      plan.slashStart,
      plan.slashStart + plan.heights.slash,
    );
    for (const [offset, command] of visible.entries()) {
      const index = plan.slashStart + offset;
      const mark = index === state.slashIndex ? ">" : " ";
      const selectedRow = index === state.slashIndex;
      children.push(
        clip(
          `${mark} /${command.name}  ${command.summary}`,
          width,
          selectedRow ? ink(chrome.selectedFg, chrome.selectedBg) : text,
        ),
      );
    }
  } else if (plan.heights.footer > 0 && state.phase.kind === "approval") {
    children.push(
      clip(
        state.draft.text === ""
          ? "y allow · n, enter, or esc deny · page up and page down scroll"
          : "esc deny · page up and page down scroll",
        width,
        secondary,
      ),
    );
  } else if (plan.heights.footer > 0 && state.inspector.open) {
    children.push(
      clip("tab output/raw · left right select · esc close", width, secondary),
    );
  } else if (plan.heights.footer > 0) {
    children.push(
      clip(
        selected
          ? "enter send · esc cancel · ctrl-c interrupt · ctrl-o results · /help"
          : "enter send · esc cancel · ctrl-c interrupt · /help",
        width,
        secondary,
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
    return { kind: "plain", text: detail, tone: "text" };
  }
}

function contentWidth(cols: number): number {
  return Math.max(1, cols - 1);
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
