import { displayText, joinSections } from "./tui-display.ts";

export type RecordedAction = {
  readonly callId: string;
  readonly number: number;
  readonly summary: string;
  readonly status: string;
  readonly output: string;
  readonly raw: string;
  readonly sourcePath: string | null;
};

export type ReplayEntry =
  | { readonly kind: "user" | "assistant"; readonly text: string }
  | { readonly kind: "action"; readonly action: RecordedAction };

const CALL_TYPES = new Set(["function_call", "shell_call", "apply_patch_call"]);
const RESULT_TYPES = new Set([
  "function_call_result",
  "shell_call_output",
  "apply_patch_call_output",
]);

export function isUnifiedDiff(text: string): boolean {
  const lines = text.split("\n");
  if (lines.some((line) => line.startsWith("@@"))) return true;
  return (
    lines.some((line) => line.startsWith("--- ")) &&
    lines.some((line) => line.startsWith("+++ "))
  );
}

export function diffKind(line: string): "add" | "del" | "meta" | "text" {
  if (line.startsWith("diff ") || line.startsWith("@@")) return "meta";
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "text";
}

export function demoActions(): readonly RecordedAction[] {
  return [
    {
      callId: "demo-shell",
      number: 1,
      summary: "bash  echo synthetic-fixture",
      status: "synthetic",
      output: "synthetic-fixture\nNo command ran.",
      raw: JSON.stringify(
        {
          synthetic: true,
          callId: "demo-shell",
          note: "No command ran.",
        },
        null,
        2,
      ),
      sourcePath: null,
    },
    {
      callId: "demo-diff",
      number: 2,
      summary: "patch  demo.txt",
      status: "synthetic",
      output: [
        "--- a/demo.txt",
        "+++ b/demo.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
      raw: JSON.stringify(
        {
          synthetic: true,
          callId: "demo-diff",
          note: "No patch ran.",
        },
        null,
        2,
      ),
      sourcePath: null,
    },
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const row = record(part);
    if (!row) continue;
    if (
      (row.type === "output_text" || row.type === "input_text") &&
      typeof row.text === "string"
    ) {
      parts.push(row.text);
    }
  }
  return parts.join("");
}

function callIdOf(row: Record<string, unknown> | null): string {
  const id = row?.callId;
  return typeof id === "string" && id.length > 0 ? id : "";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function summaryOf(
  call: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): string {
  const type = call?.type ?? result?.type;
  if (type === "shell_call" || type === "shell_call_output") {
    const commands = record(call?.action)?.commands;
    const text = Array.isArray(commands)
      ? commands.filter((command) => typeof command === "string").join(" && ")
      : "";
    return text ? `bash  ${text}` : "bash";
  }
  if (type === "apply_patch_call" || type === "apply_patch_call_output") {
    const operation = record(call?.operation);
    const path = textOf(operation?.path) || "patch";
    const move = textOf(operation?.moveTo);
    return move ? `patch  ${path} -> ${move}` : `patch  ${path}`;
  }
  const name = textOf(call?.name) || textOf(result?.name) || "tool";
  const args = oneLine(textOf(call?.arguments));
  return args ? `${name}  ${args}` : name;
}

function shellOutcomes(output: unknown): string[] {
  if (!Array.isArray(output)) return [];
  const labels: string[] = [];
  for (const item of output) {
    const outcome = record(record(item)?.outcome);
    if (!outcome) continue;
    if (outcome.type === "timeout") labels.push("timeout");
    else if (outcome.type === "exit" && typeof outcome.exitCode === "number") {
      labels.push(`exit ${outcome.exitCode}`);
    } else if (outcome.type === "exit") labels.push("exit");
  }
  return labels;
}

function statusOf(result: Record<string, unknown> | undefined): string {
  if (!result) return "no result";
  if (result.type === "shell_call_output") {
    const outcomes = shellOutcomes(result.output);
    if (outcomes.length > 0) return outcomes.join(", ");
  }
  return textOf(result.status) || "no result";
}

function shellText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const blocks: string[] = [];
  for (const item of output) {
    const row = record(item);
    if (!row) continue;
    const stdout = displayText(textOf(row.stdout));
    const stderr = displayText(textOf(row.stderr));
    const block =
      stdout && stderr
        ? joinSections([stdout, `stderr:\n${stderr}`])
        : stdout || stderr;
    if (block) blocks.push(block);
  }
  return joinSections(blocks);
}

function functionText(output: unknown): string {
  if (typeof output === "string") return output;
  const row = record(output);
  if (!row) return "";
  if (row.type === "text") return textOf(row.text);
  if (row.type === "image") return "[image]";
  if (row.type === "file") return "[file]";
  return "";
}

function outputOf(
  call: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): string {
  const type = result?.type ?? call?.type;
  if (type === "shell_call" || type === "shell_call_output") {
    return shellText(result?.output);
  }
  if (type === "function_call" || type === "function_call_result") {
    return displayText(functionText(result?.output));
  }
  const diff = displayText(textOf(record(call?.operation)?.diff));
  const extra = displayText(textOf(result?.output));
  if (diff !== "" && diff === extra) return diff;
  return joinSections([diff, extra]);
}

function rawOf(item: Record<string, unknown>): string {
  const copy = { ...item };
  delete copy.providerData;
  delete copy.signature;
  return JSON.stringify(copy, null, 2);
}

function describe(
  number: number,
  call: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): RecordedAction {
  const callId =
    callIdOf(call ?? null) || callIdOf(result ?? null) || `missing:${number}`;
  return {
    callId,
    number,
    summary: displayText(summaryOf(call, result)),
    status: displayText(statusOf(result)),
    output: displayText(outputOf(call, result)),
    raw: rawOf(result ?? call ?? { callId }),
    sourcePath: readPath(call),
  };
}

function readPath(call: Record<string, unknown> | undefined): string | null {
  if (call?.name !== "read" || typeof call.arguments !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (!isRecord(parsed) || typeof parsed.path !== "string") return null;
    return parsed.path;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function replayItems(items: readonly unknown[]): ReplayEntry[] {
  const calls = new Map<
    string,
    { item: Record<string, unknown>; used: boolean }
  >();
  const results = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const row = record(item);
    const id = callIdOf(row);
    const type = row?.type;
    if (!row || typeof type !== "string" || !id) continue;
    if (CALL_TYPES.has(type) && !calls.has(id)) {
      calls.set(id, { item: row, used: false });
    }
    if (RESULT_TYPES.has(type) && !results.has(id)) results.set(id, row);
  }

  const entries: ReplayEntry[] = [];
  let number = 0;
  for (const item of items) {
    const row = record(item);
    if (!row) continue;
    const type = row.type;
    if (type === undefined || type === "message") {
      if (row.role !== "user" && row.role !== "assistant") continue;
      const text = displayText(contentText(row.content));
      if (!text) continue;
      entries.push({
        kind: row.role === "user" ? "user" : "assistant",
        text,
      });
      continue;
    }
    if (typeof type !== "string") continue;
    const id = callIdOf(row);
    if (CALL_TYPES.has(type)) {
      const known = id ? calls.get(id) : undefined;
      if (known && (known.used || known.item !== row)) continue;
      if (known) known.used = true;
      number += 1;
      entries.push({
        kind: "action",
        action: describe(number, row, id ? results.get(id) : undefined),
      });
      continue;
    }
    if (RESULT_TYPES.has(type) && !(id && calls.has(id))) {
      number += 1;
      entries.push({
        kind: "action",
        action: describe(number, undefined, row),
      });
    }
  }
  return entries;
}
