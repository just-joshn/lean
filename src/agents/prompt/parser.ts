import { ANSI_SEQUENCES } from "./ansi-data.ts";

export type KeyPress = { key: string; data: string };

const exact = new Map<string, string | readonly string[]>();
const properPrefixes = new Set<string>();
for (const [sequence, key] of ANSI_SEQUENCES) {
  exact.set(sequence, key);
  for (let index = 1; index < sequence.length; index += 1)
    properPrefixes.add(sequence.slice(0, index));
}

const cpr = /^\x1b\[\d+;\d+R$/;
const cprPrefix = /^\x1b\[[\d;]*$/;
const mouse = /^\x1b\[(?:<?[\d;]+[mM]|M.{3})$/;
const mousePrefix = /^\x1b\[(?:<?[\d;]*|M.{0,2})$/;

function matchOf(prefix: string): string | readonly string[] | null {
  if (cpr.test(prefix)) return "<cursor-position-response>";
  if (mouse.test(prefix)) return "<vt100-mouse-event>";
  return exact.get(prefix) ?? null;
}

function isLongerPrefix(prefix: string): boolean {
  return (
    properPrefixes.has(prefix) ||
    cprPrefix.test(prefix) ||
    mousePrefix.test(prefix)
  );
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function continuationOk(first: number, extra: number, next: number): boolean {
  if ((next & 0xc0) !== 0x80) return false;
  if (extra !== 1) return true;
  if (first === 0xe0) return next >= 0xa0;
  if (first === 0xf0) return next >= 0x90;
  if (first === 0xf4) return next <= 0x8f;
  return true;
}

export class Utf8Decoder {
  private pending: number[] = [];

  decode(bytes: Uint8Array): string {
    const input = this.pending.concat(Array.from(bytes));
    this.pending = [];
    let index = 0;
    let text = "";
    const surrogate = (byte: number) => {
      text += String.fromCodePoint(0xdc00 + byte);
    };
    while (index < input.length) {
      const first = input[index] ?? 0;
      if (first < 0x80) {
        text += String.fromCodePoint(first);
        index += 1;
        continue;
      }
      let need = 0;
      let min = 0;
      let code = 0;
      if (first >= 0xc2 && first <= 0xdf) {
        need = 2;
        code = first & 0x1f;
        min = 0x80;
      } else if (first >= 0xe0 && first <= 0xef) {
        need = 3;
        code = first & 0x0f;
        min = 0x800;
      } else if (first >= 0xf0 && first <= 0xf4) {
        need = 4;
        code = first & 0x07;
        min = 0x10000;
      } else {
        surrogate(first);
        index += 1;
        continue;
      }
      if (index + need > input.length) {
        const available = input.length - index;
        let illegal = false;
        for (let extra = 1; extra < available; extra += 1) {
          if (!continuationOk(first, extra, input[index + extra] ?? 0)) {
            illegal = true;
            break;
          }
        }
        if (!illegal) {
          this.pending = input.slice(index);
          return text;
        }
        surrogate(first);
        index += 1;
        continue;
      }
      let ok = true;
      for (let extra = 1; extra < need; extra += 1) {
        const next = input[index + extra] ?? 0;
        if (!continuationOk(first, extra, next)) {
          ok = false;
          break;
        }
        code = (code << 6) | (next & 0x3f);
      }
      if (
        !ok ||
        code < min ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        surrogate(first);
        index += 1;
        continue;
      }
      text += String.fromCodePoint(code);
      index += need;
    }
    return text;
  }
}

export class Vt100Parser {
  prefix = "";
  private inPaste = false;
  private paste = "";

  holding(): boolean {
    return this.prefix.length > 0 && isLongerPrefix(this.prefix);
  }

  feed(data: string): KeyPress[] {
    const keys: KeyPress[] = [];
    this.consume(data, keys);
    return keys;
  }

  flush(): KeyPress[] {
    const keys: KeyPress[] = [];
    this.resolve(true, keys);
    return keys;
  }

  private consume(data: string, keys: KeyPress[]): void {
    if (this.inPaste) {
      this.paste += data;
      const end = "\x1b[201~";
      const at = this.paste.indexOf(end);
      if (at < 0) return;
      const content = this.paste.slice(0, at);
      const rest = this.paste.slice(at + end.length);
      this.paste = "";
      this.inPaste = false;
      keys.push({ key: "<bracketed-paste>", data: content });
      this.consume(rest, keys);
      return;
    }
    const points = codePoints(data);
    for (let index = 0; index < points.length; index += 1) {
      if (this.inPaste) {
        this.consume(points.slice(index).join(""), keys);
        return;
      }
      this.prefix += points[index] ?? "";
      this.resolve(false, keys);
    }
  }

  private resolve(flush: boolean, keys: KeyPress[]): void {
    let retry = true;
    while (retry && this.prefix) {
      retry = false;
      const longer = flush ? false : isLongerPrefix(this.prefix);
      const match = matchOf(this.prefix);
      if (!longer && match) {
        this.emit(match, this.prefix, keys);
        this.prefix = "";
      } else if (!longer && !match) {
        retry = true;
        let found = false;
        const points = codePoints(this.prefix);
        for (let size = points.length; size > 0; size -= 1) {
          const head = points.slice(0, size).join("");
          const headMatch = matchOf(head);
          if (!headMatch) continue;
          this.emit(headMatch, head, keys);
          this.prefix = points.slice(size).join("");
          found = true;
          break;
        }
        if (!found) {
          const char = points[0] ?? "";
          this.prefix = points.slice(1).join("");
          this.emit(char, char, keys);
        }
      }
    }
  }

  private emit(
    key: string | readonly string[],
    data: string,
    keys: KeyPress[],
  ): void {
    if (typeof key !== "string") {
      key.forEach((name, index) =>
        this.emit(name, index === 0 ? data : "", keys),
      );
      return;
    }
    if (key === "<bracketed-paste>") {
      this.inPaste = true;
      this.paste = "";
      return;
    }
    keys.push({ key, data });
  }
}
