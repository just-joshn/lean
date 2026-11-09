import { expect, test } from "vitest";
import { displayText } from "./tui-display.ts";
import { replayItems } from "./tui-replay.ts";

test.for([
  ["你b\rX", "X b"],
  ["你好\rA", "A 好"],
  ["👍b\rX", "X b"],
  ["ab你cd\rXYZ", "XYZ cd"],
  ["👨‍👩‍👧‍👦\rX", "X "],
  ["👨‍👩‍👧‍👦b\rX", "X b"],
] as const)("displayText(%j) is %j", ([raw, expected]) => {
  expect(displayText(raw)).toBe(expected);
  expect(displayText(expected)).toBe(expected);
});

test.for([
  ["hello\tworld\rX", "Xello\tworld"],
  ["\t@echo\r", "\t@echo"],
  ["all:\r\n\t@echo hello\r\n", "all:\n\t@echo hello\n"],
  ["all:\r\t@echo hello\r", "        @echo hello"],
  ["\t@echo\rX", "X       @echo"],
  ["a\tb\r\u0301", "a\u0301\tb"],
  ["\t@echo\r\u0301", "\t\u0301@echo"],
  ["a\r\u0301b", "b"],
  ["a\u001b[31m\u0301", "a\u0301"],
] as const)("displayText(%j) keeps layout as %j", ([raw, expected]) => {
  expect(displayText(raw)).toBe(expected);
  expect(displayText(expected)).toBe(expected);
});

test("keeps a blank column in shell stdout and the raw wide character", () => {
  const entries = replayItems([
    { type: "shell_call", callId: "shell", action: { commands: ["a"] } },
    {
      type: "shell_call_output",
      callId: "shell",
      output: [{ stdout: "你好\rX", stderr: "err" }],
    },
  ]);
  const action = entries.find((entry) => entry.kind === "action");
  if (action?.kind !== "action") throw new Error("missing shell");
  expect(action.action.output).toBe("X 好\nstderr:\nerr");
  expect(action.action.raw).toContain("你好");
  expect(action.action.output).not.toContain("\u001b");
});
