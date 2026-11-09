import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createThemeDefinition,
  rgb,
  themePresets,
  type Rgb24,
  type ThemeDefinition,
  type ThemeOverrides,
  type ThemePresetName,
} from "@rezi-ui/core";

export const ONE_DARK_PRO = "one-dark-pro";

export type ThemeName = typeof ONE_DARK_PRO | ThemePresetName;

export type NoticeTone = "muted" | "info" | "success" | "warning" | "error";

export type Chrome = {
  readonly canvas: Rgb24;
  readonly text: Rgb24;
  readonly muted: Rgb24;
  readonly accent: Rgb24;
  readonly border: Rgb24;
  readonly inverse: Rgb24;
  readonly info: Rgb24;
  readonly success: Rgb24;
  readonly warning: Rgb24;
  readonly error: Rgb24;
  readonly selectedFg: Rgb24;
  readonly selectedBg: Rgb24;
};

export type ControlKind =
  "primary" | "tab" | "secondary" | "success" | "danger";

type Workbench = Readonly<Record<string, string>>;

type SyntaxThemeFile = {
  readonly name: "One Dark Pro";
  readonly raw: object;
  readonly colors: Workbench;
};

const themeFile = loadSyntaxTheme();
const backdrop = opaque(themeFile.colors, "editor.background");

// One Dark Pro omits button.foreground. VS Code's fallback for that key is Color.white.
const primaryLabel = rgb(255, 255, 255);

const oneDarkDefinition = createThemeDefinition(
  "One Dark Pro",
  {
    bg: {
      base: backdrop,
      elevated: workbench("input.background"),
      subtle: workbench("list.hoverBackground"),
      overlay: workbench("editorWidget.background"),
    },
    fg: {
      primary: workbench("editor.foreground"),
      secondary: workbench("statusBar.foreground"),
      muted: workbench("editorLineNumber.foreground"),
      inverse: primaryLabel,
    },
    accent: {
      primary: workbench("focusBorder"),
      secondary: workbench("textLink.foreground"),
      tertiary: workbench("terminal.ansiCyan"),
    },
    success: workbench("terminal.ansiGreen"),
    warning: workbench("editorWarning.foreground"),
    error: workbench("editorError.foreground"),
    info: workbench("terminal.ansiBlue"),
    focus: { ring: workbench("focusBorder"), bg: backdrop },
    selected: {
      fg: workbench("list.activeSelectionForeground"),
      bg: workbench("list.activeSelectionBackground"),
    },
    disabled: {
      fg: workbench("editorLineNumber.foreground"),
      bg: backdrop,
    },
    diagnostic: {
      error: workbench("editorError.foreground"),
      warning: workbench("editorWarning.foreground"),
      info: workbench("terminal.ansiBlue"),
      hint: workbench("editorLineNumber.foreground"),
    },
    border: {
      subtle: workbench("panel.border"),
      default: workbench("focusBorder"),
      strong: workbench("tab.activeBorder"),
    },
  },
  {
    focusIndicator: { bold: false, underline: false },
    widget: syntaxWidget(workbench("editor.foreground")),
  },
);

const secondaryBackground = workbench("button.secondaryBackground");
const secondaryForeground = workbench("button.secondaryForeground");

export const syntaxTheme: object = themeFile.raw;
export const SYNTAX_THEME_NAME = themeFile.name;

export function themeNames(): readonly ThemeName[] {
  return [ONE_DARK_PRO, ...presetNames()];
}

export function isThemeName(value: string): value is ThemeName {
  return (
    value === ONE_DARK_PRO ||
    Object.prototype.hasOwnProperty.call(themePresets, value)
  );
}

export function noColorEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return Object.prototype.hasOwnProperty.call(env, "NO_COLOR");
}

export function themeDefinition(
  name: ThemeName,
  noColor: boolean,
): ThemeDefinition {
  const base = name === ONE_DARK_PRO ? oneDarkDefinition : themePresets[name];
  return noColor ? monochrome(base) : base;
}

export function chromeFor(name: ThemeName, noColor: boolean): Chrome {
  const colors = themeDefinition(name, noColor).colors;
  return {
    canvas: colors.bg.base,
    text: colors.fg.primary,
    muted: colors.fg.muted,
    accent: colors.accent.secondary,
    border: colors.border.subtle,
    inverse: colors.fg.inverse,
    info: colors.info,
    success: colors.success,
    warning: colors.warning,
    error: colors.error,
    selectedFg: colors.selected.fg,
    selectedBg: colors.selected.bg,
  };
}

export function toneColor(chrome: Chrome, tone: NoticeTone): Rgb24 {
  if (tone === "info") return chrome.info;
  if (tone === "success") return chrome.success;
  if (tone === "warning") return chrome.warning;
  if (tone === "error") return chrome.error;
  return chrome.muted;
}

export function controlOverride(
  name: ThemeName,
  noColor: boolean,
  kind: ControlKind,
): ThemeOverrides | null {
  if (noColor || name !== ONE_DARK_PRO) return null;
  const fill = { elevated: secondaryBackground, subtle: secondaryBackground };
  if (kind === "primary") {
    return {
      colors: {
        accent: { primary: workbench("button.background") },
        fg: { inverse: primaryLabel },
      },
    };
  }
  if (kind === "tab") {
    return {
      colors: {
        accent: { primary: workbench("tab.activeBackground") },
        fg: { inverse: workbench("tab.activeForeground") },
      },
    };
  }
  if (kind === "secondary") {
    return { colors: { bg: fill, accent: { primary: secondaryForeground } } };
  }
  if (kind === "success") {
    return {
      colors: { bg: fill, success: workbench("terminal.ansiGreen") },
    };
  }
  return { colors: { bg: fill, error: workbench("editorError.foreground") } };
}

function presetNames(): ThemePresetName[] {
  return Object.keys(themePresets).filter((name): name is ThemePresetName =>
    Object.prototype.hasOwnProperty.call(themePresets, name),
  );
}

function loadSyntaxTheme(): SyntaxThemeFile {
  const path = fileURLToPath(
    new URL("../../assets/one-dark-pro/OneDark-Pro.json", import.meta.url),
  );
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed))
    throw new Error("One Dark Pro theme is not an object.");
  if (parsed.name !== "One Dark Pro") {
    throw new Error("One Dark Pro theme name does not match.");
  }
  if (!isRecord(parsed.colors)) {
    throw new Error("One Dark Pro theme has no colors.");
  }
  if (!Array.isArray(parsed.tokenColors)) {
    throw new Error("One Dark Pro theme has no tokenColors.");
  }
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.colors)) {
    if (typeof value !== "string") {
      throw new Error(`One Dark Pro color ${key} is not a string.`);
    }
    colors[key] = value;
  }
  return { name: "One Dark Pro", raw: parsed, colors };
}

function workbench(key: string): Rgb24 {
  return blended(themeFile.colors, key, backdrop);
}

function opaque(colors: Workbench, key: string): Rgb24 {
  const value = requiredColor(colors, key);
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match?.[1]) throw new Error(`One Dark Pro color ${key} is not opaque.`);
  return packed(match[1]);
}

function blended(colors: Workbench, key: string, ground: Rgb24): Rgb24 {
  const value = requiredColor(colors, key);
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match?.[1]) throw new Error(`One Dark Pro color ${key} is not hex.`);
  const rgb24 = packed(match[1]);
  if (!match[2]) return rgb24;
  return blend(ground, rgb24, Number.parseInt(match[2], 16) / 255);
}

function requiredColor(colors: Workbench, key: string): string {
  const value = colors[key];
  if (value === undefined) throw new Error(`One Dark Pro is missing ${key}.`);
  return value;
}

function blend(ground: Rgb24, value: Rgb24, opacity: number): Rgb24 {
  const mix = (from: number, to: number) =>
    Math.round(from + (to - from) * opacity);
  const channel = (packedColor: number, shift: number) =>
    (packedColor >> shift) & 0xff;
  return rgb(
    mix(channel(ground, 16), channel(value, 16)),
    mix(channel(ground, 8), channel(value, 8)),
    mix(channel(ground, 0), channel(value, 0)),
  );
}

function packed(hex: string): Rgb24 {
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  );
}

function syntaxWidget(text: Rgb24): ThemeDefinition["widget"] {
  const plain = {
    keyword: text,
    type: text,
    string: text,
    number: text,
    comment: text,
    operator: text,
    punctuation: text,
    function: text,
    variable: text,
    cursorFg: backdrop,
    cursorBg: text,
  };
  const added = blended(
    themeFile.colors,
    "diffEditor.insertedTextBackground",
    backdrop,
  );
  const removed = blended(themeFile.colors, "inlineChatDiff.removed", backdrop);
  return {
    syntax: plain,
    diff: {
      addBg: added,
      deleteBg: removed,
      addFg: text,
      deleteFg: text,
      hunkHeader: text,
      lineNumber: text,
      border: workbench("panel.border"),
    },
    logs: {
      trace: text,
      debug: text,
      info: workbench("terminal.ansiBlue"),
      warn: workbench("editorWarning.foreground"),
      error: workbench("editorError.foreground"),
    },
    toast: {
      info: workbench("terminal.ansiBlue"),
      success: workbench("terminal.ansiGreen"),
      warning: workbench("editorWarning.foreground"),
      error: workbench("editorError.foreground"),
    },
    chart: {
      primary: text,
      accent: workbench("textLink.foreground"),
      muted: workbench("editorLineNumber.foreground"),
      success: workbench("terminal.ansiGreen"),
      warning: workbench("editorWarning.foreground"),
      danger: workbench("editorError.foreground"),
    },
  };
}

function monochrome(theme: ThemeDefinition): ThemeDefinition {
  const mono = theme.colors.fg.primary;
  const base = theme.colors.bg.base;
  const flat = {
    keyword: mono,
    type: mono,
    string: mono,
    number: mono,
    comment: mono,
    operator: mono,
    punctuation: mono,
    function: mono,
    variable: mono,
    cursorFg: base,
    cursorBg: mono,
  };
  return createThemeDefinition(
    theme.name,
    {
      ...theme.colors,
      fg: { ...theme.colors.fg, secondary: mono, muted: mono, inverse: base },
      accent: { primary: mono, secondary: mono, tertiary: mono },
      success: mono,
      warning: mono,
      error: mono,
      info: mono,
      focus: { ring: mono, bg: base },
      selected: { fg: mono, bg: base },
      disabled: { fg: mono, bg: base },
      diagnostic: { error: mono, warning: mono, info: mono, hint: mono },
      border: { subtle: mono, default: mono, strong: mono },
    },
    {
      spacing: theme.spacing,
      focusIndicator: { bold: false, underline: false },
      widget: {
        syntax: flat,
        diff: {
          addBg: base,
          deleteBg: base,
          addFg: mono,
          deleteFg: mono,
          hunkHeader: mono,
          lineNumber: mono,
          border: mono,
        },
        logs: { trace: mono, debug: mono, info: mono, warn: mono, error: mono },
        toast: { info: mono, success: mono, warning: mono, error: mono },
        chart: {
          primary: mono,
          accent: mono,
          muted: mono,
          success: mono,
          warning: mono,
          danger: mono,
        },
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
