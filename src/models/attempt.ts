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
  const parsed = parsedateTz(headers.get("retry-after"));
  if (!parsed) return undefined;
  return mktimeTz(parsed) - now / 1000;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ZONES: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  AST: -400,
  ADT: -300,
  EST: -500,
  EDT: -400,
  CST: -600,
  CDT: -500,
  MST: -700,
  MDT: -600,
  PST: -800,
  PDT: -700,
};

function parsedateTz(
  data: string | null,
): [number, number, number, number, number, number, number] | undefined {
  if (!data?.trim()) return undefined;
  let parts = data.split(/\s+/u).filter(Boolean);
  const first = parts[0] ?? "";
  if (first.endsWith(",") || DAYS.includes(first.toLowerCase())) {
    parts = parts.slice(1);
  } else {
    const comma = first.lastIndexOf(",");
    if (comma >= 0) parts[0] = first.slice(comma + 1);
  }
  if (parts.length === 3) {
    const stuff = parts[0]?.split("-") ?? [];
    if (stuff.length === 3) parts = [...stuff, ...parts.slice(1)];
  }
  if (parts.length === 4) {
    const zone = parts[3] ?? "";
    const sign = Math.max(zone.indexOf("+"), zone.indexOf("-"));
    parts =
      sign > 0
        ? [...parts.slice(0, 3), zone.slice(0, sign), zone.slice(sign)]
        : [...parts, ""];
  }
  if (parts.length < 5) return undefined;
  let [day, month, year, time, zone] = parts.slice(0, 5) as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!day || !month || !year) return undefined;
  let monthIndex = MONTHS.indexOf(month.toLowerCase());
  if (monthIndex < 0) {
    [day, month] = [month, day.toLowerCase()];
    monthIndex = MONTHS.indexOf(month);
    if (monthIndex < 0) return undefined;
  }
  const monthNumber = (monthIndex % 12) + 1;
  if (day.endsWith(",")) day = day.slice(0, -1);
  const swapped = year.indexOf(":");
  if (swapped > 0) [year, time] = [time, year];
  if (year.endsWith(",")) {
    year = year.slice(0, -1);
    if (!year) return undefined;
  }
  if (!/\d/u.test(year[0] ?? "")) [year, zone] = [zone, year];
  if (time.endsWith(",")) time = time.slice(0, -1);
  let clock = time.split(":");
  if (clock.length === 1 && clock[0]?.includes("."))
    clock = clock[0].split(".");
  const [hours, minutes, seconds = "0"] = clock;
  if (!hours || !minutes || clock.length > 3) return undefined;
  const numbers = [year, day, hours, minutes, seconds].map((item) =>
    Number(item),
  );
  if (numbers.some((item) => !Number.isInteger(item))) return undefined;
  let [fullYear, dayNumber, hour, minute, second] = numbers as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (fullYear < 100) fullYear += fullYear > 68 ? 1900 : 2000;
  return [
    fullYear,
    monthNumber,
    dayNumber,
    hour,
    minute,
    second,
    zoneOffset(zone) ?? 0,
  ];
}

function zoneOffset(zone: string): number | null {
  const named = ZONES[zone.toUpperCase()];
  if (named !== undefined) return named === 0 ? 0 : hhmm(named);
  if (!/^[-+]?\d+$/u.test(zone)) return null;
  const raw = Number(zone);
  if (raw === 0) return zone.startsWith("-") ? null : 0;
  return hhmm(raw);
}

function hhmm(offset: number): number {
  const sign = offset < 0 ? -1 : 1;
  const absolute = Math.abs(offset);
  return sign * (Math.floor(absolute / 100) * 3600 + (absolute % 100) * 60);
}

function mktimeTz(
  parts: [number, number, number, number, number, number, number],
): number {
  const [year, month, day, hour, minute, second, offset] = parts;
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000 - offset;
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
