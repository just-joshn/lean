#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline";
import { createReadStream } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { getGlobalTraceProvider } from "@openai/agents";
import { runTurn } from "./agent.ts";
import {
  createSubscriptions,
  isProviderId,
  providerLabel,
  type ProviderId,
} from "./extra/auth.ts";
import { openSession, type OpenedSession } from "./session.ts";

const USAGE = `Usage: lean [options] [message]

Talk to a coding agent in the current workspace.

Options:
  --help                 Show this help
  --model <name>         Model to use
  --session <path>       Session file, default .lean/history.json
  --trace                Enable metadata-only tracing
  --login <provider>     Sign in to openai or anthropic
  --logout <provider>    Remove a saved subscription
  --provider <provider>  Use a saved openai or anthropic subscription
`;

function formatError(
  error: unknown,
  redact?: (error: unknown) => string,
): string {
  if (redact) return redact(error);
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return message;
  return message.split(key).join("[redacted]");
}

function providerFlag(value: string | undefined): ProviderId {
  if (value !== undefined && isProviderId(value)) return value;
  throw new Error(
    `Unknown provider "${value ?? ""}". Expected openai or anthropic.`,
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function nextLine(
  rl: Interface,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolveLine) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rl.off("line", onLine);
      rl.off("close", onClose);
      resolveLine(value);
    };
    const onAbort = () => finish(undefined);
    const onLine = (line: string) => finish(line);
    const onClose = () => finish(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    rl.once("line", onLine);
    rl.once("close", onClose);
  });
}

function readTtyLine(signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  const input = createReadStream("/dev/tty");
  const rl = createInterface({ input, terminal: false });
  input.on("error", () => {
    rl.close();
  });
  return nextLine(rl, signal).finally(() => {
    rl.close();
    input.destroy();
  });
}

async function approve(
  detail: string,
  signal: AbortSignal,
  rl?: Interface,
): Promise<boolean> {
  if (signal.aborted) return false;
  const interactive =
    Boolean(process.stdin.isTTY) || Boolean(process.stdout.isTTY);
  if (!interactive) {
    process.stderr.write(
      `${detail}\nDenied. No terminal is available for approval.\n`,
    );
    return false;
  }
  process.stderr.write(`${detail}\nApprove? [y/N] `);
  let answer: string | undefined;
  if (process.stdin.isTTY) {
    const reader =
      rl ??
      createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
    answer = await nextLine(reader, signal);
    if (rl === undefined) reader.close();
  } else {
    answer = await readTtyLine(signal);
  }
  if (answer === undefined) return false;
  return /^y(?:es)?$/i.test(answer.trim());
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let values: {
    help?: boolean;
    model?: string;
    session?: string;
    trace?: boolean;
    login?: string;
    logout?: string;
    provider?: string;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean" },
        model: { type: "string" },
        session: { type: "string" },
        trace: { type: "boolean" },
        login: { type: "string" },
        logout: { type: "string" },
        provider: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const subscriptions = createSubscriptions();
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    controller.abort();
    if (interrupts >= 2) process.exit(130);
  };
  process.on("SIGINT", onSigint);
  const cwd = process.cwd();
  let opened: OpenedSession | undefined;
  try {
    if (values.login !== undefined && values.logout !== undefined) {
      throw new Error("Pass either --login or --logout.");
    }
    if (values.provider !== undefined && !isProviderId(values.provider)) {
      throw new Error(
        `Unknown provider "${values.provider}". Expected openai or anthropic.`,
      );
    }
    if (values.login !== undefined) {
      const provider = providerFlag(values.login);
      await subscriptions.login(provider, controller.signal);
      process.stderr.write(`Signed in to ${providerLabel(provider)}.\n`);
      return 0;
    }
    if (values.logout !== undefined) {
      const provider = providerFlag(values.logout);
      await subscriptions.logout(provider);
      process.stderr.write(`Signed out of ${providerLabel(provider)}.\n`);
      return 0;
    }

    const positional = positionals.join(" ");
    const interactive =
      Boolean(process.stdin.isTTY) && positional.trim() === "";
    let piped = "";
    if (!interactive && positional.trim() === "") {
      piped = await readStdin();
      if (piped.trim() === "") {
        process.stderr.write(
          "No prompt was provided. Pass a message or run lean in a terminal.\n",
        );
        return 1;
      }
    }
    const model = await subscriptions.resolveModel({
      provider: values.provider,
      model: values.model,
    });
    const session = await openSession({
      file: resolve(cwd, values.session ?? join(".lean", "history.json")),
      cwd,
    });
    opened = session;
    const runMessage = async (message: string, rl?: Interface) => {
      let text = "";
      await runTurn({
        cwd,
        input: message,
        session: session.session,
        signal: controller.signal,
        model,
        trace: values.trace === true,
        onText(delta) {
          text += delta;
          process.stdout.write(delta);
        },
        approve: (detail) => approve(detail, controller.signal, rl),
      });
      controller.signal.throwIfAborted();
      if (text.length > 0 && !text.endsWith("\n")) process.stdout.write("\n");
      await session.save();
    };
    if (interactive) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
      });
      rl.on("SIGINT", () => controller.abort());
      try {
        while (!controller.signal.aborted) {
          process.stderr.write("> ");
          const line = await nextLine(rl, controller.signal);
          if (line === undefined || controller.signal.aborted) {
            return controller.signal.aborted ? 130 : 0;
          }
          if (line.trim() === "") continue;
          await runMessage(line, rl);
        }
        return 130;
      } finally {
        rl.close();
      }
    }
    await runMessage(positional.trim() ? positional : piped);
    return 0;
  } catch (error) {
    if (controller.signal.aborted) return 130;
    process.stderr.write(`${formatError(error, subscriptions.redact)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    try {
      await opened?.close();
    } finally {
      await subscriptions.close();
    }
    if (values.trace) await getGlobalTraceProvider().forceFlush();
  }
}

if (Reflect.get(import.meta, "main") === true) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${formatError(error)}\n`);
      process.exit(1);
    });
}
