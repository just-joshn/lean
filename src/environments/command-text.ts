import { constants } from "node:os";

function pythonRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === quote) out += `\\${quote}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 32 || code === 0x7f)
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return `${out}${quote}`;
}

function pythonList(values: string[]): string {
  return `[${values.map(pythonRepr).join(", ")}]`;
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export function commandExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  return signal ? -constants.signals[signal] : (code ?? 1);
}

export function decodeOutput(bytes: Buffer, universalNewlines = true): string {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return universalNewlines
    ? text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    : text;
}

function decodeError(
  bytes: Buffer,
  start: number,
  end: number,
  reason: string,
): never {
  const where =
    end === start + 1
      ? `byte 0x${(bytes[start] ?? 0).toString(16).padStart(2, "0")} in position ${start}`
      : `bytes in position ${start}-${end - 1}`;
  throw Object.assign(
    namedError(
      "UnicodeDecodeError",
      `'utf-8' codec can't decode ${where}: ${reason}`,
    ),
    {
      encoding: "utf-8",
      object: bytes,
      start,
      end,
      reason,
    },
  );
}

export function strictText(bytes: Buffer): string {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    const width =
      lead < 0x80
        ? 1
        : lead >= 0xc2 && lead <= 0xdf
          ? 2
          : lead >= 0xe0 && lead <= 0xef
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 0;
    if (!width) decodeError(bytes, index, index + 1, "invalid start byte");
    for (let step = 1; step < width; step += 1) {
      if (index + step >= bytes.length)
        decodeError(bytes, index, index + step, "unexpected end of data");
      const value = bytes[index + step] ?? 0;
      const min =
        step === 1 && lead === 0xe0
          ? 0xa0
          : step === 1 && lead === 0xf0
            ? 0x90
            : 0x80;
      const max =
        step === 1 && lead === 0xed
          ? 0x9f
          : step === 1 && lead === 0xf4
            ? 0x8f
            : 0xbf;
      if (value < min || value > max)
        decodeError(bytes, index, index + step, "invalid continuation byte");
    }
    index += width;
  }
  return decodeOutput(bytes);
}

export function pythonStrip(value: string): string {
  return value.replace(
    /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,
    "",
  );
}

export function calledProcessError(
  cmd: string[],
  returncode: number,
  stdout: string,
  stderr: string,
): Error {
  const signal = Object.entries(constants.signals).find(
    ([, value]) => value === -returncode,
  )?.[0];
  const message =
    returncode < 0
      ? `Command '${pythonList(cmd)}' died with <Signals.${signal}: ${-returncode}>.`
      : `Command '${pythonList(cmd)}' returned non-zero exit status ${returncode}.`;
  return Object.assign(namedError("CalledProcessError", message), {
    cmd,
    returncode,
    output: stdout,
    stdout,
    stderr,
  });
}

export function timeoutExpiredError(
  cmd: string[],
  timeout: number,
  stdout: Buffer,
  stderr: Buffer,
): Error {
  const output = stdout.length ? stdout : null;
  return Object.assign(
    namedError(
      "TimeoutExpired",
      `Command '${pythonList(cmd)}' timed out after ${timeout} seconds`,
    ),
    {
      cmd,
      timeout,
      output,
      stdout: output,
      stderr: stderr.length ? stderr : null,
    },
  );
}
