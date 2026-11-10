import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getConfigFromSpec, getConfigPath, builtinConfigDir } from "./index.ts";
import { PosixPath } from "./fields.ts";
import { LitellmModel } from "../models/litellm-model.ts";
import { ValueError, FileNotFoundError } from "./errors.ts";
import controls from "./loading-source-controls.json" with { type: "json" };

let directory: string;
const cwd = process.cwd();
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lean-config-"));
  mkdirSync(join(directory, "cwd"));
  mkdirSync(join(directory, "env"));
  process.chdir(join(directory, "cwd"));
  vi.stubEnv("MSWEA_CONFIG_DIR", join(directory, "env"));
});
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("pinned config file controls", () => {
  test("searches cwd before configured directory and replaces a suffix", () => {
    writeFileSync("choice.yaml", "from: cwd\n");
    writeFileSync(join(directory, "env", "choice.yaml"), "from: env\n");
    for (const spec of ["choice", "choice.json"]) {
      expect(getConfigPath(spec)).toBe("choice.yaml");
      expect(getConfigFromSpec(spec)).toEqual({ from: "cwd" });
    }
    unlinkSync("choice.yaml");
    expect(getConfigPath("choice")).toBe(join(directory, "env", "choice.yaml"));
    expect(getConfigFromSpec("choice")).toEqual({ from: "env" });
    expect(() => getConfigFromSpec("absent")).toThrow(FileNotFoundError);
    expect(() => getConfigFromSpec("absent")).toThrow(
      controls.missing_control.message
        .replaceAll("<tmp>", directory)
        .replaceAll("<builtin>", builtinConfigDir),
    );
  });

  test("falls back to builtins without replacing existing paths", () => {
    expect(getConfigPath("mini")).toBe(join(builtinConfigDir, "mini.yaml"));
    writeFileSync("mini.yaml", "local: true\n");
    expect(getConfigPath("mini")).toBe("mini.yaml");
  });

  for (const source of controls.cases.filter((row) => "text" in row)) {
    test(source.case, () => {
      writeFileSync("sample.yaml", source.text!);
      expect(getConfigFromSpec("sample")).toEqual(source.value);
    });
  }

  test("a path value bypasses equals-sign config interpretation", () => {
    writeFileSync("equals=name.yaml", "loaded: true\n");
    expect(getConfigFromSpec(new PosixPath("equals=name.yaml"))).toEqual({
      loaded: true,
    });
    expect(getConfigFromSpec("equals=name.yaml")).toEqual({
      equals: "name.yaml",
    });
  });

  for (const source of controls.cases.filter(
    (row) => row.case.includes("=") && row.case !== "path bypasses equals",
  )) {
    test(source.case, () => {
      if ("error_type" in source) {
        expect(() => getConfigFromSpec(source.case)).toThrow(ValueError);
        expect(() => getConfigFromSpec(source.case)).toThrow(source.message);
      } else if (source.case === "a=NaN")
        expect(getConfigFromSpec(source.case)).toEqual({ a: NaN });
      else expect(getConfigFromSpec(source.case)).toEqual(source.value);
    });
  }

  test("does not read a registry path unless it names a file", () => {
    for (const row of controls.registry_controls) {
      const registry =
        row.kind === "directory" ? directory : join(directory, "missing.json");
      const model = new LitellmModel({
        model_name: "m",
        litellm_model_registry: registry,
      });
      expect({
        accepted: true,
        registry_retained: model.config.litellm_model_registry === registry,
      }).toEqual({
        accepted: row.accepted,
        registry_retained: row.registry_retained,
      });
    }
  });

  test("rejects malformed yaml rather than returning an empty config", () => {
    writeFileSync("sample.yaml", "key: [unterminated");
    expect(() => getConfigFromSpec("sample")).toThrow();
  });
});
