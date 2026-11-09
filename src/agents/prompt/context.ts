type Failure = {
  readonly error: unknown;
  readonly previous: Failure | undefined;
};

const implicitContexts = new WeakMap<object, Failure>();

export type AsyncDiagnostic = {
  readonly kind: "cpr-background" | "cpr-warning";
  readonly failure: Failure;
};

const asyncDiagnostics: AsyncDiagnostic[] = [];

function objectKey(error: unknown): object | undefined {
  if (typeof error === "object" && error !== null) return error;
  if (typeof error === "function") return error;
  return undefined;
}

function copyUntil(failure: Failure, seen: Set<unknown>): Failure | undefined {
  if (seen.has(failure.error)) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(failure.error);
  const previous = failure.previous
    ? copyUntil(failure.previous, nextSeen)
    : undefined;
  if (failure.previous === previous) return failure;
  return { error: failure.error, previous };
}

function splice(head: Failure, incoming: Failure): Failure {
  const seen = new Set<unknown>();
  const nodes: Failure[] = [];
  for (
    let cursor: Failure | undefined = head;
    cursor;
    cursor = cursor.previous
  ) {
    if (seen.has(cursor.error)) break;
    seen.add(cursor.error);
    nodes.push(cursor);
  }
  const extra = copyUntil(incoming, seen);
  if (!extra) return head;
  let tail: Failure = extra;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node) continue;
    tail =
      node.previous === tail ? node : { error: node.error, previous: tail };
    const key = objectKey(node.error);
    if (key) implicitContexts.set(key, tail);
  }
  return tail;
}

export function replacement(
  error: unknown,
  previous: Failure | undefined,
): Failure {
  const key = objectKey(error);
  const existing = key ? implicitContexts.get(key) : undefined;
  const head: Failure = existing ?? { error, previous: undefined };
  const next = previous ? splice(head, previous) : head;
  if (key) implicitContexts.set(key, next);
  return next;
}

export function implicitContext(error: object): readonly unknown[] {
  const head = implicitContexts.get(error);
  if (!head) return [error];
  const ordered: unknown[] = [];
  const emitted = new Set<unknown>();
  let cursor: Failure | undefined = head;
  while (cursor && !emitted.has(cursor.error)) {
    emitted.add(cursor.error);
    ordered.push(cursor.error);
    cursor = cursor.previous;
  }
  return ordered;
}

function textOf(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function formatImplicitContext(error: object): string {
  const newestFirst = implicitContext(error);
  const oldestFirst = [...newestFirst].reverse();
  return oldestFirst
    .map((item) => textOf(item))
    .join(
      "\n\nDuring handling of the above exception, another exception occurred:\n\n",
    );
}

export function recordAsyncDiagnostic(
  kind: AsyncDiagnostic["kind"],
  error: unknown,
): void {
  asyncDiagnostics.push({ kind, failure: replacement(error, undefined) });
}

export function takeAsyncDiagnostics(): readonly AsyncDiagnostic[] {
  return asyncDiagnostics.splice(0, asyncDiagnostics.length);
}
