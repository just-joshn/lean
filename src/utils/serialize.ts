export const UNSET: unique symbol = Symbol("UNSET");

function isDict(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function recursive_merge(
  ...dictionaries: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const dictionary of dictionaries) {
    if (dictionary == null) continue;
    for (const [key, value] of Object.entries(dictionary)) {
      if (value === UNSET) continue;
      const existing = result[key];
      if (isDict(existing) && isDict(value)) {
        result[key] = recursive_merge(existing, value);
      } else if (isDict(value)) {
        result[key] = recursive_merge(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}
