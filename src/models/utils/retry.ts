export function retryDelaySeconds(attemptNumber: number): number {
  return Math.min(60, Math.max(4, 2 ** (attemptNumber - 1)));
}

export function retryStopAfterAttempt(): number {
  const raw = process.env.MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT ?? "10";
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
}

export async function retry<T>(options: {
  abort: Array<new (...args: never[]) => Error>;
  sleep?: (milliseconds: number) => Promise<void>;
  fn: () => Promise<T>;
}): Promise<T> {
  const stop = retryStopAfterAttempt();
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let last: unknown;
  for (let attempt = 1; attempt <= stop; attempt += 1) {
    try {
      return await options.fn();
    } catch (error) {
      last = error;
      if (options.abort.some((type) => error instanceof type)) throw error;
      if (attempt === stop) throw error;
      const seconds = retryDelaySeconds(attempt);
      console.warn(
        `Retrying model query in ${seconds} seconds after attempt ${attempt}.`,
      );
      await sleep(seconds * 1000);
    }
  }
  throw last;
}
