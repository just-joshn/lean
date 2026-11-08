import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openSession } from "./session.ts";

const cleanup: (() => Promise<void>)[] = [];

function trackSession(opened: Awaited<ReturnType<typeof openSession>>) {
  cleanup.push(() => opened.close());
  return opened;
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

async function directory() {
  const cwd = await mkdtemp(join(tmpdir(), "lean-session-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

const userMessage = { role: "user" as const, content: "keep apricot" };

test("a saved turn reopens with the same items and a private file", async () => {
  const cwd = await directory();
  const file = join(cwd, ".lean", "history.json");
  const opened = trackSession(await openSession({ file, cwd }));
  await opened.session.addItems([userMessage]);
  await opened.save();
  const id = await opened.session.getSessionId();
  await opened.close();
  await opened.close();

  const again = trackSession(await openSession({ file, cwd }));
  expect(await again.session.getSessionId()).toBe(id);
  expect(await again.session.getItems()).toEqual([userMessage]);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const lock = await stat(`${file}.lock`);
  expect(lock.isFile()).toBe(true);
  expect(lock.mode & 0o777).toBe(0o600);
  await again.close();
  await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("unsaved live items are dropped on close", async () => {
  const cwd = await directory();
  const file = join(cwd, "history.json");
  const opened = trackSession(await openSession({ file, cwd }));
  await opened.session.addItems([userMessage]);
  await opened.close();
  const again = trackSession(await openSession({ file, cwd }));
  expect(await again.session.getItems()).toEqual([]);
  await again.close();
});

test("a second opener is rejected and told how to clear a stale lock", async () => {
  const cwd = await directory();
  const file = join(cwd, "history.json");
  const opened = trackSession(await openSession({ file, cwd }));
  await expect(openSession({ file, cwd })).rejects.toThrow(
    /lock|verify that process is gone before removing/i,
  );
  await opened.close();
  const again = trackSession(await openSession({ file, cwd }));
  expect(await again.session.getItems()).toEqual([]);
  await again.close();
});

test("a corrupt session file is rejected and left unchanged", async () => {
  const cwd = await directory();
  const file = join(cwd, "history.json");
  const original = "{not json";
  await writeFile(file, original);
  await expect(openSession({ file, cwd })).rejects.toThrow(/corrupt/i);
  expect(await readFile(file, "utf8")).toBe(original);
  const again = trackSession(
    await openSession({ file: join(cwd, "other.json"), cwd }),
  );
  await again.close();
});

test("an invalid history item does not replace the last good snapshot", async () => {
  const cwd = await directory();
  const file = join(cwd, "history.json");
  const opened = trackSession(await openSession({ file, cwd }));
  await opened.session.addItems([userMessage]);
  await opened.save();
  const before = await readFile(file, "utf8");
  await opened.session.addItems([JSON.parse('{"type":"nope"}')]);
  await expect(opened.save()).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
  await opened.close();
  const again = trackSession(await openSession({ file, cwd }));
  expect(await again.session.getItems()).toEqual([userMessage]);
  await again.close();
});

test("a session from another workspace is rejected", async () => {
  const cwd = await directory();
  const other = await directory();
  const file = join(cwd, "history.json");
  const opened = trackSession(await openSession({ file, cwd }));
  await opened.session.addItems([userMessage]);
  await opened.save();
  await opened.close();
  const before = await readFile(file, "utf8");
  await expect(openSession({ file, cwd: other })).rejects.toThrow(/belongs/i);
  expect(await readFile(file, "utf8")).toBe(before);
});

test("the stored workspace path is canonical", async () => {
  const cwd = await directory();
  const linkParent = await directory();
  const link = join(linkParent, "workspace");
  await symlink(cwd, link);
  const file = join(cwd, "history.json");
  const opened = trackSession(await openSession({ file, cwd: link }));
  await opened.session.addItems([userMessage]);
  await opened.save();
  await opened.close();
  const again = trackSession(await openSession({ file, cwd }));
  expect(await again.session.getItems()).toEqual([userMessage]);
  await again.close();
});
