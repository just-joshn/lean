import {
  receiveResponse,
  ResponseReadError,
  type ReceivedResponse,
} from "./received-response.ts";

export interface AttemptDependencies {
  receive?: typeof receiveResponse;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface AttemptPolicy {
  sdkRetries: number;
  wrapperAttempts: number;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

function retryAfter(
  response: ReceivedResponse,
  now: number,
): number | undefined {
  const headers = response.headers;
  if (!headers) return undefined;
  for (const [name, divisor] of [
    ["retry-after-ms", 1000],
    ["retry-after", 1],
  ] as const) {
    const value = headers.get(name);
    if (value === null) continue;
    const text = value.trim();
    if (/^[+-]?(?:inf(?:inity)?|nan)$/iu.test(text)) {
      return /nan/iu.test(text)
        ? NaN
        : text.startsWith("-")
          ? -Infinity
          : Infinity;
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text)) continue;
    const numeric = Number(text);
    return numeric === Infinity ? 121 : numeric / divisor;
  }
  const date = Date.parse(headers.get("retry-after") ?? "");
  return Number.isNaN(date) ? undefined : (date - now) / 1000;
}

function sdkRetryable(response: ReceivedResponse, now: number): boolean {
  const delay = retryAfter(response, now);
  if (delay !== undefined && Number.isFinite(delay) && delay > 120)
    return false;
  const directive = response.headers?.get("x-should-retry");
  if (directive === "true") return true;
  if (directive === "false") return false;
  return [408, 409, 429].includes(response.status) || response.status >= 500;
}

export async function attemptResponse(
  url: string,
  init: RequestInit,
  policy: AttemptPolicy,
  dependencies: AttemptDependencies = {},
): Promise<ReceivedResponse> {
  const receive = dependencies.receive ?? receiveResponse;
  const sleep =
    dependencies.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = dependencies.random ?? Math.random;
  const now = dependencies.now ?? Date.now;
  let wrapper = 0;
  for (;;) {
    const sdkRetries = wrapper === 0 ? policy.sdkRetries : 0;
    let received: ReceivedResponse | undefined;
    let failure: unknown;
    for (let sdkAttempt = 0; sdkAttempt <= sdkRetries; sdkAttempt += 1) {
      policy.signal?.throwIfAborted();
      const timeout =
        policy.timeoutSeconds === undefined
          ? undefined
          : AbortSignal.timeout(policy.timeoutSeconds * 1000);
      const signal =
        policy.signal && timeout
          ? AbortSignal.any([policy.signal, timeout])
          : (policy.signal ?? timeout);
      received = undefined;
      try {
        received = await receive(url, { ...init, signal });
        if (received.ok) return received;
        if (!sdkRetryable(received, now())) break;
      } catch (error) {
        if (error instanceof ResponseReadError) throw error.cause;
        policy.signal?.throwIfAborted();
        failure = error;
      }
      if (sdkAttempt === sdkRetries) break;
      const directed = received ? retryAfter(received, now()) : undefined;
      const delay =
        directed !== undefined &&
        Number.isFinite(directed) &&
        directed > 0 &&
        directed <= 120
          ? directed * 1000
          : Math.min(500 * 2 ** Math.min(sdkAttempt, 1000), 8000) *
            (1 - 0.25 * random());
      await sleep(delay);
    }
    policy.signal?.throwIfAborted();
    if (wrapper >= policy.wrapperAttempts) {
      if (received) return received;
      throw failure;
    }
    wrapper += 1;
  }
}
