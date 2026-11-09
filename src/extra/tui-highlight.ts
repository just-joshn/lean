import {
  measureTextCells,
  type RichTextSpan,
  type TextStyle,
} from "@rezi-ui/core";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { diffKind } from "./tui-replay.ts";
import {
  ONE_DARK_PRO,
  SYNTAX_THEME_NAME,
  chromeFor,
  syntaxTheme,
  toneColor,
  type Chrome,
  type NoticeTone,
  type ThemeName,
} from "./tui-theme.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DOCUMENT_LIMIT = 32;
const DOCUMENT_CHARS = 65_536;
const PRELOAD = [
  "markdown",
  "json",
  "diff",
  "shellscript",
  "typescript",
] as const;

export type PaintSource =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "json"; readonly text: string }
  | { readonly kind: "diff"; readonly text: string }
  | { readonly kind: "file"; readonly text: string; readonly path: string }
  | {
      readonly kind: "plain";
      readonly text: string;
      readonly tone: NoticeTone;
    };

export type VisualRow = {
  readonly spans: readonly RichTextSpan[];
};

export type PaintRequest = {
  readonly theme: ThemeName;
  readonly source: PaintSource;
  readonly width: number;
  readonly prefix?: RichTextSpan;
};

export type Painter = {
  rows(request: PaintRequest): readonly VisualRow[];
  dispose(): void;
};

type Piece = {
  readonly text: string;
  readonly style: TextStyle;
};

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

const aliases = new Map<string, string>();
for (const info of bundledLanguagesInfo) {
  aliases.set(info.id.toLowerCase(), info.id);
  aliases.set(info.name.toLowerCase(), info.id);
  for (const alias of info.aliases ?? [])
    aliases.set(alias.toLowerCase(), info.id);
}

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

export function languageForPath(path: string): string | null {
  const base = path.split(/[/\\]/).pop() ?? "";
  if (base === "" || base === "." || base === "..") return null;
  const named = aliases.get(base.toLowerCase());
  if (named) return named;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return aliases.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

export async function createPainter(options: {
  readonly noColor: boolean;
  readonly onReady: () => void;
}): Promise<Painter> {
  let disposed = false;
  let notify = false;
  let epoch = 0;
  let highlighter: Highlighter | null = null;
  const loaded = new Set<string>();
  const failed = new Set<string>();
  const pending = new Set<string>();
  const cache = new Map<string, readonly Piece[][]>();

  if (!options.noColor) {
    try {
      highlighter = await createHighlighterCore({
        themes: [syntaxTheme],
        langs: [],
        engine: createOnigurumaEngine(import("shiki/wasm")),
      });
      if (disposed) {
        highlighter.dispose();
        highlighter = null;
      } else {
        for (const id of PRELOAD) await load(id, false);
      }
    } catch {
      highlighter?.dispose();
      highlighter = null;
    }
  }
  notify = true;

  function load(id: string, announce: boolean): Promise<void> {
    const engine = highlighter;
    const grammar = grammarFor(id);
    if (
      !engine ||
      !grammar ||
      loaded.has(id) ||
      failed.has(id) ||
      pending.has(id)
    ) {
      return Promise.resolve();
    }
    pending.add(id);
    return engine
      .loadLanguage(grammar)
      .then(() => {
        pending.delete(id);
        if (disposed) return;
        loaded.add(id);
        epoch += 1;
        cache.clear();
        if (announce && notify) {
          queueMicrotask(() => {
            if (!disposed) options.onReady();
          });
        }
      })
      .catch(() => {
        pending.delete(id);
        if (!disposed) failed.add(id);
      });
  }

  function rows(request: PaintRequest): readonly VisualRow[] {
    const width = request.width;
    const chrome = chromeFor(request.theme, options.noColor);
    const prefix = request.prefix;
    const text = request.source.text;
    const plainStyle = styleFor(request.source, chrome, options.noColor);
    if (
      options.noColor ||
      request.theme !== ONE_DARK_PRO ||
      !highlighter ||
      disposed
    ) {
      return project(
        text,
        plainLines(text, plainStyle, request.source, chrome),
        width,
        prefix,
      );
    }
    const lang = languageId(request.source);
    if (!lang) {
      return project(
        text,
        plainLines(text, plainStyle, request.source, chrome),
        width,
        prefix,
      );
    }
    void load(lang, true);
    if (lang === "markdown") {
      for (const embedded of fenceLanguages(text)) void load(embedded, true);
    }
    if (!loaded.has(lang) || failed.has(lang)) {
      return project(
        text,
        plainLines(text, plainStyle, request.source, chrome),
        width,
        prefix,
      );
    }
    const key = `${epoch}\0${lang}\0${text}`;
    let lines = cache.get(key);
    if (!lines) {
      lines = tokenize(text, lang, plainStyle);
      if (text.length <= DOCUMENT_CHARS) {
        cache.set(key, lines);
        while (cache.size > DOCUMENT_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
    }
    return project(text, lines, width, prefix);
  }

  function tokenize(
    text: string,
    lang: string,
    plainStyle: TextStyle,
  ): readonly Piece[][] {
    const engine = highlighter;
    if (!engine) return plainPieces(text, plainStyle);
    try {
      const result = engine.codeToTokens(text, {
        lang,
        theme: SYNTAX_THEME_NAME,
      });
      const lines = result.tokens.map((line) =>
        line.map((token) => ({
          text: token.content,
          style: tokenStyle(
            token.color,
            token.bgColor,
            token.fontStyle,
            plainStyle,
          ),
        })),
      );
      if (!sameText(text, lines)) return plainPieces(text, plainStyle);
      return lines;
    } catch {
      failed.add(lang);
      return plainPieces(text, plainStyle);
    }
  }

  return {
    rows,
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      cache.clear();
      highlighter?.dispose();
      highlighter = null;
    },
  };
}

function grammarFor(id: string) {
  if (!Object.prototype.hasOwnProperty.call(bundledLanguages, id)) return null;
  return bundledLanguages[id as keyof typeof bundledLanguages];
}

function languageId(source: PaintSource): string | null {
  if (source.kind === "markdown") return "markdown";
  if (source.kind === "json") return "json";
  if (source.kind === "diff") return "diff";
  if (source.kind === "file") return languageForPath(source.path);
  return null;
}

function fenceLanguages(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(?:`{3,}|~{3,})([^`~\s]*)/.exec(line);
    const info = match?.[1];
    if (!info) continue;
    const id = aliases.get(info.toLowerCase());
    if (id) found.push(id);
  }
  return found;
}

function styleFor(
  source: PaintSource,
  chrome: Chrome,
  noColor: boolean,
): TextStyle {
  const fg =
    source.kind === "plain" && !noColor
      ? toneColor(chrome, source.tone)
      : chrome.text;
  return face(fg, chrome.canvas);
}

function plainLines(
  text: string,
  plainStyle: TextStyle,
  source: PaintSource,
  chrome: Chrome,
): readonly Piece[][] {
  return text.split("\n").map((line) => {
    if (source.kind !== "diff") return [{ text: line, style: plainStyle }];
    return [{ text: line, style: diffStyle(line, chrome, plainStyle) }];
  });
}

function plainPieces(text: string, style: TextStyle): Piece[][] {
  return text.split("\n").map((line) => [{ text: line, style }]);
}

function diffStyle(
  line: string,
  chrome: Chrome,
  plainStyle: TextStyle,
): TextStyle {
  const kind = diffKind(line);
  if (kind === "add") return face(chrome.success, chrome.canvas);
  if (kind === "del") return face(chrome.error, chrome.canvas);
  if (kind === "meta") return face(chrome.muted, chrome.canvas);
  return plainStyle;
}

function tokenStyle(
  color: string | undefined,
  background: string | undefined,
  fontStyle: number | undefined,
  plainStyle: TextStyle,
): TextStyle {
  const bits = fontStyle ?? 0;
  const fg = color ? cssColor(color, plainStyle.fg ?? 0) : plainStyle.fg;
  const bg = background
    ? cssColor(background, plainStyle.bg ?? 0)
    : plainStyle.bg;
  return {
    fg,
    bg,
    bold: (bits & 2) !== 0,
    italic: (bits & 1) !== 0,
    underline: (bits & 4) !== 0,
    strikethrough: (bits & 8) !== 0,
    dim: false,
  };
}

function cssColor(value: string, ground: number): number {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match?.[1]) return ground;
  const rgb24 =
    (Number.parseInt(match[1].slice(0, 2), 16) << 16) |
    (Number.parseInt(match[1].slice(2, 4), 16) << 8) |
    Number.parseInt(match[1].slice(4, 6), 16);
  if (!match[2]) return rgb24;
  const opacity = Number.parseInt(match[2], 16) / 255;
  const channel = (packed: number, shift: number) => (packed >> shift) & 0xff;
  const mix = (from: number, to: number) =>
    Math.round(from + (to - from) * opacity);
  return (
    (mix(channel(ground, 16), channel(rgb24, 16)) << 16) |
    (mix(channel(ground, 8), channel(rgb24, 8)) << 8) |
    mix(channel(ground, 0), channel(rgb24, 0))
  );
}

function face(fg: number, bg: number): TextStyle {
  return {
    fg,
    bg,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    dim: false,
  };
}

function sameText(text: string, lines: readonly Piece[][]): boolean {
  const joined = lines
    .map((line) => line.map((piece) => piece.text).join(""))
    .join("\n");
  return joined === text;
}

function project(
  text: string,
  lines: readonly Piece[][],
  width: number,
  prefix: RichTextSpan | undefined,
): VisualRow[] {
  const sourceLines = text.split("\n");
  const fallback = lines[0]?.[0]?.style ?? face(0xabb2bf, 0x282c34);
  const usable =
    lines.length === sourceLines.length ? lines : plainPieces(text, fallback);
  const rows: VisualRow[] = [];
  for (const [index, line] of usable.entries()) {
    const pieces = line.length > 0 ? line : [{ text: "", style: fallback }];
    const style = pieces[0]?.style ?? fallback;
    const lead = index === 0 && prefix ? [prefixPiece(prefix)] : [];
    rows.push(...pack(lead, pieces, width, style));
  }
  return rows.length > 0
    ? rows
    : [{ spans: [space(face(0xabb2bf, 0x282c34))] }];
}

function prefixPiece(prefix: RichTextSpan): Piece {
  return { text: prefix.text, style: prefix.style ?? {} };
}

function pack(
  lead: readonly Piece[],
  pieces: readonly Piece[],
  width: number,
  blankStyle: TextStyle,
): VisualRow[] {
  const max = Math.max(1, width);
  const body = pieces.every((piece) => piece.text === "") ? [] : atoms(pieces);
  const atomsInLine = [...atoms(lead), ...body];
  if (atomsInLine.length === 0) return [{ spans: [space(blankStyle)] }];
  const rows: RichTextSpan[][] = [];
  let spans: RichTextSpan[] = [];
  let cells = 0;
  for (const atom of atomsInLine) {
    if (spans.length > 0 && cells + atom.cells > max) {
      rows.push(spans);
      spans = [];
      cells = 0;
    }
    const last = spans[spans.length - 1];
    if (last && sameStyle(last.style, atom.style)) {
      spans[spans.length - 1] = {
        text: last.text + atom.text,
        style: last.style,
      };
    } else {
      spans.push({ text: atom.text, style: atom.style });
    }
    cells += atom.cells;
  }
  if (spans.length > 0) rows.push(spans);
  return rows.map((row) => ({ spans: row }));
}

function atoms(
  pieces: readonly Piece[],
): { text: string; cells: number; style: TextStyle }[] {
  const text = pieces.map((piece) => piece.text).join("");
  const styles: TextStyle[] = [];
  for (const piece of pieces) {
    for (let index = 0; index < piece.text.length; index += 1) {
      styles.push(piece.style);
    }
  }
  const out: { text: string; cells: number; style: TextStyle }[] = [];
  for (const { segment, index } of graphemes.segment(text)) {
    out.push({
      text: segment,
      cells: measureTextCells(segment),
      style: styles[index] ?? pieces[0]?.style ?? {},
    });
  }
  return out;
}

function sameStyle(
  left: TextStyle | undefined,
  right: TextStyle | undefined,
): boolean {
  return (
    left?.fg === right?.fg &&
    left?.bg === right?.bg &&
    left?.bold === right?.bold &&
    left?.italic === right?.italic &&
    left?.underline === right?.underline &&
    left?.strikethrough === right?.strikethrough &&
    left?.dim === right?.dim
  );
}

function space(style: TextStyle): RichTextSpan {
  return { text: " ", style };
}
