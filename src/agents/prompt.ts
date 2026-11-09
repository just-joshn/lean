import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export function globalConfigDir(): string {
  if (process.env.MSWEA_GLOBAL_CONFIG_DIR)
    return process.env.MSWEA_GLOBAL_CONFIG_DIR;
  const name = "mini-swe-agent";
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", name);
  if (platform() === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      name,
    );
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), name);
}

function historyPath(): string {
  return join(globalConfigDir(), "interactive_history.txt");
}

function historyLines(): string[] {
  try {
    return readFileSync(historyPath(), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string);
  } catch {
    return [];
  }
}

function remember(text: string): void {
  if (!text) return;
  const path = historyPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(text)}\n`);
}

export function readPromptLine(multiline = false): Promise<string> {
  if (!multiline || !process.stdin.isTTY) return readLine();
  return readMultiline();
}

function readLine(): Promise<string> {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  return new Promise((resolve) => {
    reader.once("line", (line) => {
      reader.close();
      remember(line);
      resolve(line);
    });
    reader.once("close", () => resolve(""));
  });
}

function readMultiline(): Promise<string> {
  return new Promise((resolve) => {
    const history = historyLines();
    let index = history.length;
    let current = "";
    let escape = false;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdout.write(
      "Submit message: Esc, then Enter | Navigate history: Arrow Up/Down | Search history: Ctrl+R\n",
    );
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        process.kill(process.pid, "SIGINT");
        return;
      }
      if (text === "\u0012") {
        const needle = current.split("\n").at(-1) ?? "";
        const found = [...history]
          .reverse()
          .find((line) => line.includes(needle));
        if (found) current = found;
        return;
      }
      if (text === "\u001b[A" || text === "\u001b[B") {
        index =
          text === "\u001b[A"
            ? Math.max(0, index - 1)
            : Math.min(history.length, index + 1);
        current = history[index] ?? "";
        return;
      }
      if (text === "\u001b") {
        escape = true;
        return;
      }
      if (text === "\r" || text === "\n") {
        if (escape) {
          cleanup();
          remember(current);
          resolve(current);
          return;
        }
        current += "\n";
        escape = false;
        return;
      }
      escape = false;
      current += text;
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode?.(false);
    };
    process.stdin.on("data", onData);
  });
}
