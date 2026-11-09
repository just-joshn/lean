import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestRenderer, themePresets, ui } from "@rezi-ui/core";
import { expect, test } from "vitest";
import {
  ONE_DARK_PRO,
  chromeFor,
  controlOverride,
  isThemeName,
  noColorEnabled,
  themeDefinition,
  themeNames,
  toneColor,
} from "./tui-theme.ts";

const asset = (name: string) =>
  fileURLToPath(new URL(`../../assets/one-dark-pro/${name}`, import.meta.url));

test("keeps the pinned One Dark Pro file unchanged", () => {
  const bytes = readFileSync(asset("OneDark-Pro.json"));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "bd098a63d2fdcb932ea67caaf66eb25a51cda1c2179ff37048fe1db7fe13461f",
  );
  const license = readFileSync(asset("LICENSE.txt"), "utf8");
  expect(license).toContain("MIT License");
  expect(license).toContain("Binaryify");
  const pin = readFileSync(asset("SOURCE.txt"), "utf8");
  expect(pin).toContain("75c80ab18d90655e05ad837bb8d89f5e68d5ce53");
});

test("lists one-dark-pro and every built-in preset", () => {
  expect(themeNames()).toEqual([ONE_DARK_PRO, ...Object.keys(themePresets)]);
  expect(isThemeName("one-dark-pro")).toBe(true);
  expect(isThemeName("nord")).toBe(true);
  expect(isThemeName("ayu")).toBe(false);
  expect(noColorEnabled({ NO_COLOR: "" })).toBe(true);
  expect(noColorEnabled({})).toBe(false);
});

test("uses upstream workbench colors for One Dark Pro chrome", () => {
  const chrome = chromeFor(ONE_DARK_PRO, false);
  expect(chrome.canvas).toBe(0x282c34);
  expect(chrome.text).toBe(0xabb2bf);
  expect(chrome.muted).toBe(0x495162);
  expect(chrome.accent).toBe(0x61afef);
  expect(chrome.info).toBe(0x4aa5f0);
  expect(chrome.success).toBe(0x8cc265);
  expect(chrome.warning).toBe(0xd19a66);
  expect(chrome.error).toBe(0xc24038);
  expect(chrome.selectedFg).toBe(0xd7dae0);
  expect(chrome.selectedBg).toBe(0x2c313a);
  expect(chrome.inverse).toBe(0xffffff);
  expect(toneColor(chrome, "error")).toBe(0xc24038);
  expect(toneColor(chrome, "muted")).toBe(chrome.muted);
});

test("does not paint One Dark syntax colors onto another preset", () => {
  const nord = chromeFor("nord", false);
  expect(nord.canvas).not.toBe(0x282c34);
  expect(nord.text).not.toBe(0xabb2bf);
  expect(themeDefinition("nord", false)).toBe(themePresets.nord);
});

test("flattens foreground hues when color is disabled", () => {
  const chrome = chromeFor(ONE_DARK_PRO, true);
  expect(chrome.text).toBe(0xabb2bf);
  expect(chrome.accent).toBe(chrome.text);
  expect(chrome.info).toBe(chrome.text);
  expect(chrome.success).toBe(chrome.text);
  expect(chrome.warning).toBe(chrome.text);
  expect(chrome.error).toBe(chrome.text);
  expect(chrome.selectedFg).toBe(chrome.text);
  expect(chrome.selectedBg).toBe(chrome.canvas);
  expect(controlOverride(ONE_DARK_PRO, true, "secondary")).toBeNull();
  const nord = chromeFor("nord", true);
  expect(nord.success).toBe(nord.text);
  expect(nord.error).toBe(nord.text);
});

test("draws upstream input, tab, and button colors together", () => {
  const theme = themeDefinition(ONE_DARK_PRO, false);
  const scope = (
    kind: "primary" | "tab" | "secondary" | "success" | "danger",
    id: string,
    label: string,
    variant: "solid" | "soft",
  ) => {
    const override = controlOverride(ONE_DARK_PRO, false, kind);
    if (!override) throw new Error(`missing ${kind} scope`);
    return ui.themed(override, [
      ui.button({
        id,
        label,
        dsVariant: variant,
        dsTone:
          kind === "success"
            ? "success"
            : kind === "danger"
              ? "danger"
              : "primary",
        dsSize: "sm",
        px: 0,
        focusConfig: { indicator: "none" },
        pressedStyle: { dim: false },
        style: { dim: false },
      }),
    ]);
  };
  const tree = ui.column({ width: "full", gap: 0 }, [
    scope("secondary", "secondary", "SECONDARY", "soft"),
    scope("tab", "tab", "ACTIVE_TAB", "solid"),
    scope("primary", "primary", "PRIMARY", "solid"),
    scope("success", "allow", "ALLOW", "soft"),
    scope("danger", "deny", "DENY", "soft"),
    ui.textarea({
      id: "prompt",
      value: "INPUT_TEXT",
      rows: 1,
      focusConfig: { indicator: "none" },
    }),
  ]);
  for (const focusedId of [null, "secondary", "tab", "primary", "allow"]) {
    const frame = createTestRenderer().render(tree, {
      theme,
      focusedId,
      viewport: { cols: 80, rows: 16 },
    });
    expect(drawn(frame, "SECONDARY")).toEqual({ fg: 0xc0bdbd, bg: 0x30333d });
    expect(drawn(frame, "ACTIVE_TAB")).toEqual({ fg: 0xdcdcdc, bg: 0x282c34 });
    expect(drawn(frame, "PRIMARY")).toEqual({ fg: 0xffffff, bg: 0x404754 });
    expect(drawn(frame, "ALLOW")).toEqual({ fg: 0x8cc265, bg: 0x30333d });
    expect(drawn(frame, "DENY")).toEqual({ fg: 0xc24038, bg: 0x30333d });
    expect(drawn(frame, "INPUT_TEXT")).toEqual({ fg: 0xabb2bf, bg: 0x1d1f23 });
  }
});

function drawn(
  frame: ReturnType<ReturnType<typeof createTestRenderer>["render"]>,
  label: string,
): { fg: number | undefined; bg: number | undefined } {
  const op = frame.ops.find(
    (item) => item.kind === "drawText" && item.text.includes(label),
  );
  if (op?.kind !== "drawText") throw new Error(`${label} was not drawn`);
  return { fg: op.style?.fg, bg: op.style?.bg };
}
