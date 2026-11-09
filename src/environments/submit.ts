import { Submitted } from "../exceptions.ts";
import type { ExecutionOutput } from "../protocols.ts";

const SENTINEL = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";

function splitLinesKeep(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  const pattern = /\r\n|\r|\n|\v|\f|\u001c|\u001d|\u001e|\u0085|\u2028|\u2029/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length;
    lines.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) lines.push(text.slice(last));
  return lines;
}

export function checkSubmitted(output: ExecutionOutput): void {
  const lines = splitLinesKeep(output.output.replace(/^\s+/u, ""));
  const first = lines[0];
  if (first && first.trim() === SENTINEL && output.returncode === 0) {
    const submission = lines.slice(1).join("");
    throw new Submitted({
      role: "exit",
      content: submission,
      extra: { exit_status: "Submitted", submission },
    });
  }
}
