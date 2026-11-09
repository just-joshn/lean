import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PromptEditor } from "./editor.ts";
import {
  classifyInput,
  PromptFrame,
  type FrameOutput,
  type PaintPhase,
} from "./frame.ts";

const OPEN: PaintPhase = { kind: "open" };
const DONE: PaintPhase = { kind: "done", exit: "keep" };
const FIRST = "\x1b[?2004h\x1b[?1l\x1b[?25l\x1b[0m\x1b[?7l\x1b[0m\x1b[J";
const NEXT = "\x1b[?25l\x1b[?7l";
const END = "\x1b[?7h\x1b[0m\x1b[?12l\x1b[?25h";
const RESET = "\x1b[?2004l";
const TOOLBAR =
  "\x1b[0;7mSubmit message: \x1b[0;1;7mEsc, then Enter\x1b[0;7m | Navig\r\x1b[39Ca";

beforeEach(() => {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("PROMPT_TOOLKIT_COLOR_DEPTH", "DEPTH_8_BIT");
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("PROMPT_TOOLKIT_NO_CPR", "");
});

afterEach(() => vi.unstubAllEnvs());

function setup(columns = 40, rows = 24, report: number | null = 1) {
  const chunks: string[] = [];
  const output: FrameOutput & { columns: number; rows: number } = {
    columns,
    rows,
    isTTY: true,
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
  };
  const frame = PromptFrame.open("setup", output);
  const reportRow = (row: number) => {
    const event = classifyInput({
      key: "<cursor-position-response>",
      data: `\x1b[${row};1R`,
    });
    if (event.kind !== "cursor") throw new Error("expected a cursor report");
    frame.report(event.report);
  };
  if (report !== null) reportRow(report);
  const paint = (editor: PromptEditor, phase: PaintPhase = OPEN) => {
    chunks.length = 0;
    frame.paint(editor, phase);
    return chunks.join("");
  };
  return { frame, output, chunks, paint, reportRow };
}

function search(multiline: boolean) {
  const editor = new PromptEditor("other", multiline);
  editor.push({ key: "c-r", data: "\x12" });
  editor.push({ key: "o", data: "o" });
  return editor;
}

test("wraps twelve characters at the full ten columns", () => {
  const { paint } = setup(10, 8);
  expect(paint(new PromptEditor("a".repeat(12), false))).toBe(
    FIRST +
      "\x1b[0maaaaaaaaa\r\x1b[9Ca\x1b[0m\r\n\x1b[0maa" +
      "\x1b[0m" +
      "\r\n".repeat(6) +
      "\x1b[0m \b\x1b[6A\x1b[2C" +
      END,
  );
});

test("clips the submit toolbar to forty columns without wrapping", () => {
  const { paint } = setup();
  expect(paint(new PromptEditor("", true))).toBe(
    FIRST +
      "\x1b[0m \x1b[0m" +
      "\r\n".repeat(22) +
      "\x1b[0m \x1b[0m\r\n" +
      TOOLBAR +
      "\r\x1b[23A" +
      END,
  );
});

test("single-line reverse search replaces the document and backs up after the match", () => {
  const { paint } = setup();
  paint(new PromptEditor("", false));
  const editor = search(false);
  expect(paint(editor)).toBe(
    NEXT + "\x1b[0m(reverse-i-search)`o': \x1b[0;7mo\x1b[0mther\x1b[8D" + END,
  );
  editor.push({ key: "c-m", data: "\r" });
  expect(paint(editor)).toBe(
    NEXT + "\x1b[20D\x1b[0mother\x1b[0m\x1b[K\x1b[5D" + END,
  );
});

test("multiline search has its own bold label row above the submit toolbar", () => {
  const { paint } = setup();
  expect(paint(search(true))).toBe(
    FIRST +
      "\x1b[0;7mo\x1b[0mther\x1b[0m" +
      "\r\n".repeat(21) +
      "\x1b[0m \x1b[0m\r\n\x1b[0;1mI-search backward: \x1b[0mo\x1b[0m\r\n" +
      TOOLBAR +
      "\r\x1b[A\x1b[20C" +
      END,
  );
});

test("multiline search does not wait for a cursor report", () => {
  const { paint } = setup(40, 24, null);
  expect(paint(search(true))).toBe(
    FIRST +
      "\x1b[0;7mo\x1b[0mther\x1b[0m\r\n" +
      "\x1b[0;1mI-search backward: \x1b[0mo\x1b[20D\x1b[20C" +
      END,
  );
});

test("shows Window too small when the toolbar minimums exceed the canvas", () => {
  const { paint } = setup(40, 1);
  const editor = search(true);
  expect(paint(editor)).toBe(
    FIRST +
      "\x1b[0;38;5;231;48;5;52m Window too small... \x1b[21D\x1b[?7h\x1b[0m",
  );
  expect(paint(editor)).toBe("\x1b[?7l\x1b[?7h\x1b[0m");
});

test("keeps the fallback message to one row on a two-row canvas", () => {
  const { paint } = setup(40, 2);
  const editor = search(true);
  editor.argument = "-";
  expect(paint(editor)).toBe(
    FIRST +
      "\x1b[0;38;5;231;48;5;52m Window too small... " +
      "\x1b[0m\r\n\x1b[0m \b\x1b[A\x1b[?7h\x1b[0m",
  );
});

test("paints only a changed cell on the second screen and erases a shortened line", () => {
  const { paint } = setup(10, 4);
  paint(new PromptEditor("abc", false));
  expect(paint(new PromptEditor("abd", false))).toBe(NEXT + "\b\x1b[0md" + END);
  expect(paint(new PromptEditor("a", false))).toBe(
    NEXT + "\x1b[2D\x1b[0m\x1b[K" + END,
  );
});

test("done redraw erases downward without repainting removed document or toolbar rows", () => {
  const { paint } = setup();
  paint(new PromptEditor("aaa\nbbb\nccc", true));
  expect(paint(new PromptEditor("aaa\nbbb", true), DONE)).toBe(
    NEXT +
      "\x1b[2A\x1b[3D\x1b[0m\x1b[J\x1b[0maaa\x1b[0m\r\n" +
      "\x1b[0mbbb\x1b[3D\x1b[0m\r\n\x1b[J" +
      END +
      RESET,
  );
});

test("enables paste and resets cursor keys only once while every diff toggles autowrap and cursor", () => {
  const { frame, chunks, paint, reportRow } = setup(10, 4, null);
  frame.begin();
  expect(chunks).toEqual(["\x1b[?12l\x1b[?25h", "\x1b[6n"]);
  reportRow(1);
  const editor = new PromptEditor("abc", false);
  expect(paint(editor)).toBe(
    FIRST + "\x1b[0mabc\x1b[0m\r\n\r\n\r\n\x1b[0m \b\x1b[3A\x1b[3C" + END,
  );
  expect(paint(editor)).toBe(NEXT + END);
  chunks.length = 0;
  frame.reset();
  expect(chunks).toEqual(["\x1b[?2004l"]);
});

test("keeps wide tails and combining marks with their base at a full-width boundary", () => {
  const { paint } = setup(5, 3);
  expect(paint(new PromptEditor("你e\u0301好X", false))).toBe(
    FIRST +
      "\x1b[0m你e\u0301好\x1b[0m\r\n\x1b[0mX\x1b[0m\r\n\x1b[0m \b\x1b[A\x1b[C" +
      END,
  );
});

test("scrolls just enough to keep the document cursor visible", () => {
  const { paint } = setup(10, 2);
  expect(paint(new PromptEditor("a\nb\nc\nd", false))).toBe(
    FIRST + "\x1b[0mc\x1b[0m\r\n\x1b[0md\b\x1b[C" + END,
  );
});

test("renders the projected repeat argument on a separate row", () => {
  const { paint } = setup(40, 4);
  const editor = new PromptEditor("a", true);
  editor.argument = "-";
  expect(paint(editor)).toBe(
    FIRST +
      "\x1b[0ma\x1b[0m\r\n\x1b[0m \x1b[0m\r\n" +
      "\x1b[0;1mRepeat: \x1b[0m-1\x1b[0m\r\n" +
      TOOLBAR +
      "\r\x1b[3A\x1b[C" +
      END,
  );
});

test.for([
  ["DEPTH_1_BIT", "\x1b[0m"],
  ["DEPTH_4_BIT", "\x1b[0;90m"],
  ["DEPTH_8_BIT", "\x1b[0;38;5;102m"],
  ["DEPTH_24_BIT", "\x1b[0;38;2;136;136;136m"],
])("uses source exit styling at %s", ([depth, style]) => {
  vi.stubEnv("PROMPT_TOOLKIT_COLOR_DEPTH", depth!);
  const { paint } = setup(10, 4);
  expect(
    paint(new PromptEditor("abc", false), { kind: "done", exit: "exiting" }),
  ).toBe(
    FIRST + style + "abc      \r\x1b[9C \r\x1b[0m\r\n\x1b[J" + END + RESET,
  );
});

test("horizontally scrolls single-line search to keep the needle cursor on screen", () => {
  const { paint } = setup(12, 4);
  expect(paint(search(false))).toBe(
    FIRST +
      "\x1b[0mi-search)`o\r\x1b[11C'\x1b[0m\r\n\r\n\r\n" +
      "\x1b[0m \b\x1b[3A\x1b[11C" +
      END,
  );
});

test("reserves an extra cursor cell after an exactly full document row", () => {
  const { paint } = setup(10, 8, null);
  expect(paint(new PromptEditor("a".repeat(10), false))).toBe(
    FIRST + "\x1b[0maaaaaaaaa\r\x1b[9Ca\x1b[0m\r\n\x1b[0m \b" + END,
  );
});

test("interprets a report using the size at arrival rather than the size at paint", () => {
  const { paint, output } = setup(10, 4, 3);
  const editor = new PromptEditor("a", false);
  expect(paint(editor)).toBe(
    FIRST + "\x1b[0ma\x1b[0m\r\n\x1b[0m \b\x1b[A\x1b[C" + END,
  );
  output.rows = 8;
  expect(paint(editor)).toBe(
    "\x1b[?25l\x1b[0m\x1b[?7l\b\x1b[0m\x1b[J\x1b[0ma" +
      "\x1b[0m\r\n\x1b[0m \b\x1b[A\x1b[C" +
      END,
  );
});

test("treats row zero as a real report and caps its minimum at the terminal height", () => {
  const { paint } = setup(10, 4, 0);
  expect(paint(new PromptEditor("a", false))).toBe(
    FIRST + "\x1b[0ma\x1b[0m\r\n\r\n\r\n\x1b[0m \b\x1b[3A\x1b[C" + END,
  );
});

test("retains the scroll position until the cursor leaves the visible document", () => {
  const { paint } = setup(10, 2);
  const editor = new PromptEditor("a\nb\nc\nd", false);
  paint(editor);
  editor.cursor = 4;
  expect(paint(editor)).toBe(NEXT + "\x1b[A\b" + END);
  editor.cursor = 2;
  expect(paint(editor)).toBe(
    NEXT + "\x1b[0mb\x1b[0m\r\n\x1b[0mc\x1b[A\b" + END,
  );
});

test("renders the single-line argument prefix without a repeat toolbar", () => {
  const { paint } = setup(20, 4);
  const editor = new PromptEditor("abc", false);
  editor.argument = "-";
  expect(paint(editor)).toBe(
    FIRST +
      "\x1b[0m(arg: -) abc\x1b[0m\r\n\r\n\r\n\x1b[0m \b\x1b[3A\x1b[12C" +
      END,
  );
});

test.for([
  ["DEPTH_1_BIT", "\x1b[0m"],
  ["DEPTH_4_BIT", "\x1b[0;97;41m"],
  ["DEPTH_8_BIT", "\x1b[0;38;5;231;48;5;52m"],
  ["DEPTH_24_BIT", "\x1b[0;38;2;255;255;255;48;2;85;0;0m"],
])("uses source Window too small colors at %s", ([depth, style]) => {
  vi.stubEnv("PROMPT_TOOLKIT_COLOR_DEPTH", depth!);
  const { paint } = setup(40, 1);
  expect(paint(search(true))).toBe(
    FIRST + style + " Window too small... \x1b[21D\x1b[?7h\x1b[0m",
  );
});

test("drops the previous grid on a size change while retaining its tracked cursor", () => {
  const { paint, output } = setup(20, 8);
  const editor = new PromptEditor("a".repeat(12), false);
  paint(editor);
  output.columns = 10;
  expect(paint(editor)).toBe(
    "\x1b[?25l\x1b[0m\x1b[?7l\r\x1b[0m\x1b[J\x1b[0maaaaaaaaa\r\x1b[9Ca" +
      "\x1b[0m\r\n\x1b[0maa\x1b[0m" +
      "\r\n".repeat(6) +
      "\x1b[0m \b\x1b[6A\x1b[2C" +
      END,
  );
});
