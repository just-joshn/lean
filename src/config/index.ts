import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, parseDocument } from "yaml";

export const builtinConfigDir = dirname(fileURLToPath(import.meta.url));

export function getConfigPath(spec: string): string {
  const name = spec.endsWith(".yaml") ? spec : `${spec}.yaml`;
  const candidates = [
    resolve(name),
    resolve(process.env.MSWEA_CONFIG_DIR || ".", name),
    join(builtinConfigDir, name),
    join(builtinConfigDir, "extra", name),
    join(builtinConfigDir, "benchmarks", name),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new Error(
      `Could not find config file for ${spec} (tried: ${candidates.join(", ")})`,
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
    value = raw;
  }
  const keys = key.split(".");
  if (keys.some((part) => part === ""))
    throw new Error(
      `Invalid config spec ${JSON.stringify(spec)}: empty config key`,
    );
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

export function getConfigFromSpec(spec: string): Record<string, unknown> {
  if (spec.includes("=")) return nested(spec);
  const text = readFileSync(getConfigPath(spec), "utf8");
  const document = parseDocument(text);
  if (document.errors.length > 0) throw document.errors[0];
  const parsed = parseYaml(text);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {};
}
