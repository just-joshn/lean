import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { PromptEditor } from "./prompt/editor.ts";
import { FileHistory } from "./prompt/history.ts";
import { Utf8Decoder, Vt100Parser } from "./prompt/parser.ts";
import { codePointWidth } from "./prompt/width.ts";

function feed(
  editor: PromptEditor,
  bytes: number[],
  parser = new Vt100Parser(),
): PromptEditor {
  const decoder = new Utf8Decoder();
  const keys = parser.feed(decoder.decode(Uint8Array.from(bytes)));
  for (const key of keys) editor.push(key);
  return editor;
}

test("edits by code point and measures wide and combining text", () => {
  expect(codePointWidth(0)).toBe(0);
  expect(codePointWidth(1)).toBe(0);
  expect(codePointWidth(0xff01)).toBe(2);
  expect(codePointWidth("é".codePointAt(0) ?? 0)).toBe(1);
  expect(codePointWidth("你".codePointAt(0) ?? 0)).toBe(2);
  expect(codePointWidth(0x0301)).toBe(0);
  const wrapped = new PromptEditor("你好XY", false).presentation();
  expect(wrapped.kind).toBe("document");
  if (wrapped.kind === "document") {
    expect(wrapped.text).toBe("你好XY");
    expect(wrapped.cursor).toBe(4);
  }
  const marked = new PromptEditor("e\u0301", false).presentation();
  expect(marked.kind).toBe("document");
  if (marked.kind === "document") {
    expect(marked.text).toBe("e\u0301");
    expect(marked.cursor).toBe(2);
  }
});

test("ctrl-d at column zero deletes one code point and empty ctrl-d is eof", () => {
  const editor = new PromptEditor("", false);
  const result = feed(editor, [0x61, 0x62, 0x63, 0x01, 0x04, 0x0d]);
  expect(result.text).toBe("bc");
  const empty = new PromptEditor("", false);
  const eof = empty.push({ key: "c-d", data: "\u0004" });
  expect(eof.kind).toBe("error");
  if (eof.kind === "error") expect(eof.error.name).toBe("EOFError");
});

test("a carriage return accepts and a following line feed is another enter", () => {
  const parser = new Vt100Parser();
  const decoder = new Utf8Decoder();
  const keys = parser.feed(decoder.decode(Buffer.from("kept\r\n")));
  expect(keys.map((key) => key.key)).toEqual([
    "k",
    "e",
    "p",
    "t",
    "c-m",
    "c-j",
  ]);
  const first = new PromptEditor("", false);
  let outcome = first.push({ key: "c-m", data: "\r" });
  expect(outcome).toEqual({ kind: "accept", text: "" });
  const second = new PromptEditor("", false);
  feed(second, [...Buffer.from("kept\r")]);
  expect(second.text).toBe("kept");
});

test("multiline enter inserts a newline and escape enter accepts", () => {
  const editor = new PromptEditor("", true);
  feed(editor, [
    ...Buffer.from("ab\u007fZ\rX"),
    0x1b,
    0x5b,
    0x44,
    ...Buffer.from("Y"),
    0x1b,
    0x0d,
  ]);
  expect(editor.text).toBe("aZ\nYX");
});

test("incremental search hits, misses, and walks to an older line", () => {
  const hit = new PromptEditor("", false);
  hit.loadHistory(["other", "two", "one"]);
  feed(hit, [0x12, ...Buffer.from("o\r")]);
  expect(hit.text).toBe("other");
  const miss = new PromptEditor("draft", false);
  miss.loadHistory(["other"]);
  feed(miss, [0x12, ...Buffer.from("zz\r")]);
  expect(miss.text).toBe("draft");
  const older = new PromptEditor("", false);
  older.loadHistory(["target", "newest", "older"]);
  feed(older, [0x12, ...Buffer.from("old\r")]);
  expect(older.text).toBe("older");
});

test("up before history load cannot recall and up after load recalls the newest line", () => {
  const early = new PromptEditor("", false);
  feed(early, [0x1b, 0x5b, 0x41]);
  early.loadHistory(["kept"]);
  expect(early.text).toBe("");
  const later = new PromptEditor("", false);
  later.loadHistory(["kept"]);
  feed(later, [0x1b, 0x5b, 0x41]);
  expect(later.text).toBe("kept");
});

test("utf-8 splits across chunks and an invalid byte becomes a surrogate", () => {
  const decoder = new Utf8Decoder();
  expect(decoder.decode(Uint8Array.from([0xc3]))).toBe("");
  expect(decoder.decode(Uint8Array.from([0xa9]))).toBe("é");
  const broken = new Utf8Decoder();
  const text = broken.decode(Uint8Array.from([0xff]));
  expect(text.codePointAt(0)).toBe(0xdcff);
  const parser = new Vt100Parser();
  expect(parser.feed("\u001b[1;1R").map((key) => key.key)).toEqual([
    "<cursor-position-response>",
  ]);
  expect(parser.feed("\u001b[Mabc").map((key) => key.key)).toEqual([
    "<vt100-mouse-event>",
  ]);
  expect(parser.feed("\u001b[<0;1;1M").map((key) => key.key)).toEqual([
    "<vt100-mouse-event>",
  ]);
});

test("file history keeps plus-lines newest first and skips a duplicate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lean-history-"));
  const path = join(directory, "interactive_history.txt");
  const history = new FileHistory(path);
  history.append("one\ntwo");
  history.append("one\ntwo");
  history.append("three");
  const raw = await readFile(path, "utf8");
  expect(raw.match(/\+one\n/g)).toHaveLength(1);
  expect(history.newestFirst()).toEqual(["three", "one\ntwo"]);
  const again = new FileHistory(path);
  expect(again.newestFirst()).toEqual(["three", "one\ntwo"]);
  await rm(directory, { recursive: true, force: true });
});
