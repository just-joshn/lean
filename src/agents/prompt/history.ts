import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const utf8 = new TextEncoder();

function utf8Replace(text: string): Uint8Array {
  let safe = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    safe += code !== undefined && code >= 0xd800 && code <= 0xdfff ? "?" : char;
  }
  return utf8.encode(safe);
}

function stamp(): string {
  const date = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}000`;
}

export class FileHistory {
  private entries: string[] = [];
  private loaded = false;
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  newestFirst(): string[] {
    this.load();
    return this.entries;
  }

  append(text: string): void {
    if (!text) return;
    this.load();
    const newest = this.entries[0];
    if (newest === text) return;
    this.entries.unshift(text);
    mkdirSync(dirname(this.path), { recursive: true });
    const body = text
      .split("\n")
      .map((line) => `+${line}\n`)
      .join("");
    appendFileSync(this.path, utf8Replace(`\n# ${stamp()}\n${body}`));
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    const oldest: string[] = [];
    let lines: string[] = [];
    const add = () => {
      if (!lines.length) return;
      oldest.push(lines.join("").slice(0, -1));
      lines = [];
    };
    let rest = raw;
    while (rest) {
      const newline = rest.indexOf("\n");
      const line = newline === -1 ? rest : rest.slice(0, newline + 1);
      rest = newline === -1 ? "" : rest.slice(newline + 1);
      if (line.startsWith("+")) lines.push(line.slice(1));
      else add();
    }
    add();
    this.entries = oldest.reverse();
  }
}
