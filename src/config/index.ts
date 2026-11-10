import { existsSync, readFileSync } from "node:fs";
import { dirname, join, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, type Tags } from "yaml";
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

function jsonLoads(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const match = /^[ \t\r\n]*(Infinity|-Infinity|NaN)[ \t\r\n]*$/.exec(raw);
    if (!match) return raw;
    if (match[1] === "NaN") return Number.NaN;
    if (match[1] === "-Infinity") return Number.NEGATIVE_INFINITY;
    return Number.POSITIVE_INFINITY;
  }
}

// PyYAML 6 safe_load keeps `1e2` and the keys y/n/Y/N as strings, and still
// accepts yes/off as booleans. The yaml package's 1.2 core schema does neither.
function pyyamlSafeTags(tags: Tags): Tags {
  return tags.map((tag) => {
    if (typeof tag !== "object" || !tag.test) return tag;
    if (tag.tag === "tag:yaml.org,2002:bool" && tag.test.test("y"))
      return {
        ...tag,
        test: /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/,
      };
    if (tag.tag === "tag:yaml.org,2002:bool" && tag.test.test("n"))
      return {
        ...tag,
        test: /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/,
      };
    if (tag.tag === "tag:yaml.org,2002:float" && tag.format === "EXP")
      return {
        ...tag,
        test: /^[-+]?(?:[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)[eE][-+][0-9]+$/,
      };
    return tag;
  });
}

function nested(spec: string): Record<string, unknown> {
  const splitAt = spec.indexOf("=");
  const key = spec.slice(0, splitAt);
  const raw = spec.slice(splitAt + 1);
  const value = jsonLoads(raw);
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
  const document = parseDocument(text, {
    version: "1.1",
    uniqueKeys: false,
    customTags: pyyamlSafeTags,
  });
  if (document.errors.length > 0) throw document.errors[0];
  return document.toJS();
}
