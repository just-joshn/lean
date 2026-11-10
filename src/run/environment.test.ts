import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Message } from "../protocols.ts";
import { main } from "./mini.ts";

const fake = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  query: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: fake.spawn,
    spawnSync: fake.spawnSync,
  };
});
vi.mock("../models/index.ts", () => ({
  getModel: () => ({
    config: {},
    query: fake.query,
    format_message: (message: Message) => message,
    format_observation_messages: () => [],
    get_template_vars: () => ({}),
    serialize: () => ({}),
  }),
}));

const directories: string[] = [];
beforeEach(() => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("unexpected signal");
  });
  vi.stubEnv("MSWEA_CONFIGURED", "1");
  fake.query.mockReset().mockReturnValue({
    role: "assistant",
    extra: { actions: [{ command: "fixture only" }] },
  });
  fake.spawnSync
    .mockReset()
    .mockImplementation((_executable, _args, _options) => ({
      stdout: Buffer.from("cid-owned\n"),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    }));
  fake.spawn.mockReset().mockImplementation(() => {
    throw new Error("unexpected subprocess");
  });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function argumentsFor(environment: string) {
  const directory = await mkdtemp(join(tmpdir(), "lean-run-env-"));
  directories.push(directory);
  const config = join(directory, "config.yaml");
  const output = join(directory, "trajectory.json");
  await writeFile(
    config,
    JSON.stringify({
      agent: { system_template: "system", instance_template: "{{ task }}" },
      environment: { image: "img", executable: "/owned/docker" },
    }),
  );
  return {
    output,
    argv: [
      "-t",
      "task",
      "-c",
      config,
      "-o",
      output,
      "--agent-class",
      "default",
      "--environment-class",
      environment,
    ],
  };
}

function actionResult() {
  const collector = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    pid: undefined,
  });
  fake.spawn.mockReturnValueOnce(collector).mockImplementationOnce(() => {
    queueMicrotask(() => {
      collector.stdout.emit(
        "data",
        Buffer.from("COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\r\nbody\r\n"),
      );
      child.emit("exit", 0, null);
      queueMicrotask(() => collector.emit("close", 0));
    });
    return child;
  });
}

test.each(["local", "docker"])(
  "main composes the actual %s environment and saves its submission",
  async (environment) => {
    const { argv, output } = await argumentsFor(environment);
    actionResult();
    const status = await main(argv);
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(status).toBe(0);
    const saved = JSON.parse(await readFile(output, "utf8"));
    expect(saved.info).toMatchObject({
      exit_status: "Submitted",
      submission: "body\n",
    });
    expect(saved.info.config.environment_type).toBe(
      `minisweagent.environments.${environment}.${environment === "local" ? "LocalEnvironment" : "DockerEnvironment"}`,
    );
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    if (environment === "local")
      expect(fake.spawn.mock.calls[1]?.slice(0, 2)).toEqual([
        "/bin/sh",
        ["-c", "fixture only"],
      ]);
    else
      expect(fake.spawn.mock.calls[1]?.slice(0, 2)).toEqual([
        "/owned/docker",
        ["exec", "-w", "/", "cid-owned", "bash", "-lc", "fixture only"],
      ]);
  },
);

test("main rejects a startup failure before querying or saving a trajectory", async () => {
  const { argv, output } = await argumentsFor("docker");
  fake.spawnSync.mockReturnValue({
    stdout: Buffer.alloc(0),
    stderr: Buffer.from([255]),
    status: 0,
    signal: null,
  });
  expect(await main(argv)).toBe(1);
  expect(fake.spawnSync).toHaveBeenCalledOnce();
  expect(process.stderr.write).toHaveBeenCalledWith(
    "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte\n",
  );
  expect(fake.query).not.toHaveBeenCalled();
  expect(fake.spawn).not.toHaveBeenCalled();
  await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
});
