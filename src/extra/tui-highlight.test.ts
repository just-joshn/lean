import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { afterEach, expect, test, vi } from "vitest";
import {
  createPainter,
  languageForPath,
  wrapLines,
  type Painter,
  type VisualRow,
} from "./tui-highlight.ts";
import { ONE_DARK_PRO, syntaxTheme, SYNTAX_THEME_NAME } from "./tui-theme.ts";

const cleanup: Painter[] = [];

afterEach(() => {
  for (const painter of cleanup.splice(0)) painter.dispose();
});

async function painter(onReady: () => void = () => {}): Promise<Painter> {
  const created = await createPainter({ noColor: false, onReady });
  cleanup.push(created);
  return created;
}

const typescript = 'const count: number = 42;\nconsole.log("hello");';
const json = '{"path":"demo.ts","count":42,"enabled":true}';
const diff = "--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new";
const shell = 'if test -f demo.ts; then echo "hello"; fi';

test("resolves read paths from Shiki metadata", () => {
  expect(languageForPath("src/main.ts")).toBe("typescript");
  expect(languageForPath("src/main.d.ts")).toBe("typescript");
  expect(languageForPath("Dockerfile")).toBe("docker");
  expect(languageForPath("script.sh")).toBe("shellscript");
  expect(languageForPath("note.txt")).toBeNull();
  expect(languageForPath("notes")).toBeNull();
});

test("matches an independent Oniguruma tokenization of the vendored theme", async () => {
  const face = await painter();
  const oracle = await createHighlighterCore({
    themes: [syntaxTheme],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  try {
    await oracle.loadLanguage(
      (await import("shiki/langs")).bundledLanguages.typescript,
    );
    const tokens = oracle.codeToTokens(typescript, {
      lang: "typescript",
      theme: SYNTAX_THEME_NAME,
    });
    const rows = face.rows({
      theme: ONE_DARK_PRO,
      source: { kind: "file", text: typescript, path: "main.ts" },
      width: 80,
    });
    const keyword = tokens.tokens[0]?.[0];
    expect(keyword?.content).toBe("const");
    expect(keyword?.color?.toLowerCase()).toBe("#c678dd");
    expect(styleOf(rows, "const")).toMatchObject({
      fg: 0xc678dd,
      bold: false,
      italic: false,
    });
    expect(styleOf(rows, "42")).toMatchObject({ fg: 0xd19a66 });
    expect(styleOf(rows, '"hello"')).toMatchObject({ fg: 0x98c379 });
    expect(styleOf(rows, "log")).toMatchObject({ fg: 0x61afef });
  } finally {
    oracle.dispose();
  }
});

test("colors comments, JSON, shell, diffs, and Markdown from the upstream theme", async () => {
  const face = await painter();
  const code = face.rows({
    theme: ONE_DARK_PRO,
    source: {
      kind: "file",
      text: "// a comment\nconst count = 1;",
      path: "main.ts",
    },
    width: 80,
  });
  expect(styleOf(code, "// a comment")).toMatchObject({
    fg: 0x7f848e,
    italic: true,
    bold: false,
  });
  const data = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "json", text: json },
    width: 120,
  });
  expect(styleOf(data, '"path"')).toMatchObject({ fg: 0xe06c75 });
  expect(styleOf(data, '"demo.ts"')).toMatchObject({ fg: 0x98c379 });
  expect(styleOf(data, "true")).toMatchObject({ fg: 0xd19a66 });
  const command = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "file", text: shell, path: "run.sh" },
    width: 80,
  });
  expect(styleOf(command, "if")).toMatchObject({ fg: 0xc678dd });
  expect(styleOf(command, "echo")).toMatchObject({ fg: 0x56b6c2 });
  const patch = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "diff", text: diff },
    width: 80,
  });
  expect(styleOf(patch, "-old")).toMatchObject({ fg: 0xe06c75 });
  expect(styleOf(patch, "+new")).toMatchObject({ fg: 0x98c379 });
  expect(styleOf(patch, "--- a/demo.ts")).toMatchObject({ fg: 0x61afef });
  const markdown = face.rows({
    theme: ONE_DARK_PRO,
    source: {
      kind: "markdown",
      text: "# Heading\n**bold** and *italic* and `inline`",
    },
    width: 80,
  });
  expect(styleOf(markdown, "# Heading")).toMatchObject({ fg: 0xe06c75 });
  expect(styleOf(markdown, "**bold**")).toMatchObject({
    fg: 0xd19a66,
    bold: false,
  });
  expect(styleOf(markdown, "*italic*")).toMatchObject({
    fg: 0xc678dd,
    italic: true,
  });
  expect(styleOf(markdown, "inline")).toMatchObject({ fg: 0x98c379 });
});

test("keeps graphemes, blank lines, and source text when the width changes", async () => {
  const face = await painter();
  const emoji = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "plain", text: "ab👩🏽‍💻cd", tone: "muted" },
    width: 4,
  });
  expect(texts(emoji)).toEqual(["ab👩🏽‍💻", "cd"]);
  const blank = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "markdown", text: "a\n\nb" },
    width: 20,
  });
  expect(texts(blank)).toEqual(["a", " ", "b"]);
  const source = `${typescript}\n`;
  const wide = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "file", text: source, path: "main.ts" },
    width: 80,
  });
  const narrow = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "file", text: source, path: "main.ts" },
    width: 8,
  });
  expect(texts(wide)).toEqual(wrapLines(source, 80).map(shown));
  expect(texts(narrow)).toEqual(wrapLines(source, 8).map(shown));
  expect(texts(wide).join("")).toBe(texts(narrow).join(""));
  expect(styleOf(narrow, "const")?.fg).toBe(0xc678dd);
  const prefixed = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "plain", text: "abcdef\ngh", tone: "muted" },
    width: 4,
    prefix: { text: "> ", style: { fg: 0x61afef, bold: true } },
  });
  expect(texts(prefixed)).toEqual(wrapLines("> abcdef\ngh", 4).map(shown));
  expect(prefixed[0]?.spans[0]).toMatchObject({
    text: "> ",
    style: { fg: 0x61afef, bold: true },
  });
});

test("leaves unknown text readable and recolors after a grammar arrives", async () => {
  let paints = 0;
  const face = await painter(() => {
    paints += 1;
  });
  const unknown = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "file", text: "still here", path: "note.txt" },
    width: 40,
  });
  expect(texts(unknown)).toEqual(["still here"]);
  expect(styleOf(unknown, "still here")?.fg).toBe(0xabb2bf);
  const text = "```python\n# comment\n```";
  const before = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "markdown", text },
    width: 40,
  });
  expect(texts(before).join("\n")).toContain("# comment");
  await vi.waitFor(() => expect(paints).toBeGreaterThan(0), {
    timeout: 10_000,
  });
  const after = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "markdown", text },
    width: 40,
  });
  expect(texts(after)).toEqual(texts(before));
  expect(styleOf(after, "# comment")?.fg).not.toBe(
    styleOf(before, "# comment")?.fg,
  );
  expect(styleOf(after, "# comment")?.italic).toBe(true);
});

test("drops syntax hues for other themes, NO_COLOR, and a disposed painter", async () => {
  let paints = 0;
  const face = await createPainter({
    noColor: false,
    onReady: () => {
      paints += 1;
    },
  });
  const nord = face.rows({
    theme: "nord",
    source: { kind: "file", text: "const count = 1;", path: "main.ts" },
    width: 40,
  });
  expect(styleOf(nord, "const")?.fg).not.toBe(0xc678dd);
  const plain = face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "plain", text: "+not-a-diff\nhello", tone: "muted" },
    width: 40,
  });
  expect(styleOf(plain, "+not-a-diff")?.fg).toBe(styleOf(plain, "hello")?.fg);
  face.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "markdown", text: "```ruby\n# x\n```" },
    width: 20,
  });
  face.dispose();
  const atDispose = paints;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(paints).toBe(atDispose);
  expect(
    texts(
      face.rows({
        theme: ONE_DARK_PRO,
        source: { kind: "markdown", text: "still here" },
        width: 20,
      }),
    ),
  ).toEqual(["still here"]);
  face.dispose();

  const quiet = await createPainter({ noColor: true, onReady: () => {} });
  cleanup.push(quiet);
  const mono = quiet.rows({
    theme: ONE_DARK_PRO,
    source: { kind: "file", text: typescript, path: "main.ts" },
    width: 80,
  });
  const colors = new Set(
    mono.flatMap((row) => row.spans.map((span) => span.style?.fg)),
  );
  expect(colors).toEqual(new Set([0xabb2bf]));
});

function texts(rows: readonly VisualRow[]): string[] {
  return rows.map((row) => row.spans.map((span) => span.text).join(""));
}

function shown(line: string): string {
  return line.length > 0 ? line : " ";
}

function styleOf(rows: readonly VisualRow[], text: string) {
  for (const row of rows) {
    for (const span of row.spans) {
      if (span.text === text) return span.style;
    }
  }
  return undefined;
}
