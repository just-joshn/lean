import { existsSync, readFileSync } from "node:fs";
import { dirname, join, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { PosixPath } from "./fields.ts";
import { FileNotFoundError, ValueError } from "./errors.ts";

export const builtinConfigDir = dirname(fileURLToPath(import.meta.url));

export function getConfigPath(spec: string | PosixPath): string {
  const text = new PosixPath(String(spec)).text;
  const suffix = extname(text);
  const name =
    suffix === ".yaml"
      ? text
      : `${suffix ? text.slice(0, -suffix.length) : text}.yaml`;
  const candidates = [
    name,
    ...[
      process.env.MSWEA_CONFIG_DIR ?? ".",
      builtinConfigDir,
      join(builtinConfigDir, "extra"),
      join(builtinConfigDir, "benchmarks"),
    ].map((base) => (isAbsolute(name) ? name : join(base, name))),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new FileNotFoundError(
      `Could not find config file for ${name} (tried: [${candidates.map((candidate) => `PosixPath('${new PosixPath(candidate).text}')`).join(", ")}])`,
    );
  return found;
}

function nested(spec: string): Record<string, unknown> {
  const splitAt = spec.indexOf("=");
  const key = spec.slice(0, splitAt);
  const raw = spec.slice(splitAt + 1);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw === "NaN" ? NaN : raw;
  }
  const keys = key.split(".");
  if (keys.some((part) => part === ""))
    throw new ValueError(`Invalid config spec '${spec}': empty config key`);
  const result: Record<string, unknown> = {};
  let current = result;
  for (const part of keys.slice(0, -1)) {
    const next: Record<string, unknown> = {};
    current[part] = next;
    current = next;
  }
  current[keys.at(-1) ?? ""] = value;
  return result;
}

export function getConfigFromSpec(spec: string | PosixPath): unknown {
  if (typeof spec === "string" && spec.includes("=")) return nested(spec);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(getConfigPath(spec)),
  );
  const document = parseDocument(text, { version: "1.1", uniqueKeys: false });
  if (document.errors.length > 0) throw document.errors[0];
  return document.toJS();
}
