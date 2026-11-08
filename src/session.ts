import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { MemorySession, protocol } from "@openai/agents";
import { z } from "zod";

const sessionRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    cwd: z.string().min(1),
    items: z.array(protocol.ModelItem),
  })
  .strict();

export type OpenedSession = {
  session: MemorySession;
  save: () => Promise<void>;
  close: () => Promise<void>;
};

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await stat(dir);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}

async function writePrivate(file: string, body: string): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(file, 0o600);
}

export async function openSession(options: {
  file: string;
  cwd: string;
}): Promise<OpenedSession> {
  const cwd = await realpath(options.cwd);
  const file = resolve(cwd, options.file);
  await ensureDir(dirname(file));
  const lockPath = `${file}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    throw new Error(
      `Session lock ${lockPath} is already held. Another process may be using this session. Verify that process is gone before removing the lock file.`,
    );
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await lock.close();
    await rm(lockPath, { force: true });
  };

  try {
    const record = await loadRecord(file, cwd);
    const session = new MemorySession({
      sessionId: record.id,
      initialItems: record.items,
    });
    return {
      session,
      save: async () => {
        if (closed) throw new Error("Session is closed.");
        const next = sessionRecordSchema.parse({
          version: 1,
          id: record.id,
          cwd,
          items: await session.getItems(),
        });
        await writePrivate(file, `${JSON.stringify(next, null, 2)}\n`);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function loadRecord(file: string, cwd: string) {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return { version: 1 as const, id: randomUUID(), cwd, items: [] };
    }
    throw error;
  }
  let record: z.infer<typeof sessionRecordSchema>;
  try {
    record = sessionRecordSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`Session file ${file} is corrupt and was left unchanged.`, {
      cause: error,
    });
  }
  if (record.cwd !== cwd) {
    throw new Error(`Session file belongs to ${record.cwd}, not ${cwd}.`);
  }
  return record;
}
