import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import { DockerEnvironment } from "./docker.ts";
import { LocalEnvironment } from "./local.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(), spawnSync: vi.fn() };
});

describe("platform processor", () => {
  test("exposes the uname processor through local and Docker template vars", () => {
    vi.mocked(execFileSync).mockReturnValue("arm\n");
    vi.mocked(spawnSync).mockReturnValue({
      stdout: Buffer.from("cid-test\n"),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(new LocalEnvironment().get_template_vars().processor).toBe("arm");
    expect(
      new DockerEnvironment({
        image: "python:3.11",
        executable: "/owned/docker",
      }).get_template_vars().processor,
    ).toBe("arm");
  });

  test("normalizes unknown and failed processor results", () => {
    vi.mocked(execFileSync).mockReturnValue("unknown\n");
    expect(new LocalEnvironment().get_template_vars().processor).toBe("");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("uname unavailable");
    });
    expect(new LocalEnvironment().get_template_vars().processor).toBe("");
  });
});
