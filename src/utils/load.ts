import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PosixPath } from "../config/fields.ts";
import { ValueError } from "../config/errors.ts";

const nativeSpecs = new WeakMap<Function, string>();

export function componentIdentity(instance: object): string {
  const ctor = instance.constructor;
  if (
    Object.hasOwn(ctor, "typeName") &&
    "typeName" in ctor &&
    typeof ctor.typeName === "string"
  )
    return ctor.typeName;
  return nativeSpecs.get(ctor) ?? ctor.name;
}

export function loadClass<T extends Function>(
  spec: string,
  bindings: Record<string, T>,
  kind: string,
): T {
  for (const [shortcut, ctor] of Object.entries(bindings)) {
    if (
      spec === shortcut ||
      (Object.hasOwn(ctor, "typeName") &&
        "typeName" in ctor &&
        spec === ctor.typeName)
    )
      return ctor;
  }
  if (!spec.startsWith("import:"))
    throw new ValueError(
      `Unknown ${kind}: ${spec} (available: ${Object.keys(bindings).join(", ")})`,
    );
  const hash = spec.lastIndexOf("#");
  const moduleSpec = spec.slice("import:".length, hash < 0 ? undefined : hash);
  const exportName = hash < 0 ? "default" : spec.slice(hash + 1);
  const require = createRequire(resolve(process.cwd(), "__lean_loader__.js"));
  const loaded: unknown = require(
    moduleSpec.startsWith("file:") ? fileURLToPath(moduleSpec) : moduleSpec,
  );
  const ctor: unknown =
    loaded !== null &&
    (typeof loaded === "object" || typeof loaded === "function")
      ? Reflect.get(loaded, exportName)
      : undefined;
  if (typeof ctor !== "function")
    throw new TypeError(
      `Module ${moduleSpec} has no callable export ${exportName}`,
    );
  if (!nativeSpecs.has(ctor)) nativeSpecs.set(ctor, spec);
  return ctor as T;
}

export function copyConfig<T>(value: T): T {
  if (value instanceof PosixPath) return new PosixPath(value.text) as T;
  if (Array.isArray(value)) return value.map(copyConfig) as T;
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, copyConfig(entry)]),
    ) as T;
  return value;
}
