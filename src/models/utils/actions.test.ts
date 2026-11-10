import { describe, expect, test } from "vitest";
import { FormatError } from "../../exceptions.ts";
import {
  formatTextObservationMessages,
  parseRegexActions,
} from "./actions-text.ts";
import {
  formatToolcallObservationMessages,
  parseToolcallActions,
} from "./actions-toolcall.ts";

const formatTemplate = "{{ error }}";
const observationTemplate =
  "{% if output.exception_info %}<exception>{{output.exception_info}}</exception>\n{% endif %}<returncode>{{output.returncode}}</returncode>\n<output>\n{{output.output}}</output>";

describe("parseToolcallActions", () => {
  test("keeps ordered commands and drops extra argument keys", () => {
    const actions = parseToolcallActions(
      [
        {
          id: "call-1",
          function: {
            name: "bash",
            arguments: '{"command":"echo one","extra":1}',
          },
        },
        {
          id: "call-2",
          function: { name: "bash", arguments: '{"command":"echo two"}' },
        },
      ],
      { format_error_template: formatTemplate },
    );
    expect(actions).toEqual([
      { command: "echo one", tool_call_id: "call-1" },
      { command: "echo two", tool_call_id: "call-2" },
    ]);
  });

  test("rejects an empty tool call list", () => {
    expect(() =>
      parseToolcallActions([], {
        format_error_template: formatTemplate,
        template_kwargs: { finish_reason: "length" },
      }),
    ).toThrow(FormatError);
    try {
      parseToolcallActions([], {
        format_error_template: "reason={{ finish_reason }} {{ error }}",
        template_kwargs: { finish_reason: "length" },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(FormatError);
      if (error instanceof FormatError) {
        expect(error.messages[0]?.content).toContain("No tool calls");
        expect(error.messages[0]?.extra?.interrupt_type).toBe("FormatError");
      }
    }
  });

  test("rejects an unknown tool and invalid arguments before accepting later calls", () => {
    expect(() =>
      parseToolcallActions(
        [
          {
            id: "call-1",
            function: { name: "other", arguments: '{"command":"echo"}' },
          },
        ],
        {
          format_error_template: formatTemplate,
        },
      ),
    ).toThrow(/Unknown tool 'other'/);
    expect(() =>
      parseToolcallActions(
        [{ id: "call-1", function: { name: "bash", arguments: "not-json" } }],
        {
          format_error_template: formatTemplate,
        },
      ),
    ).toThrow(/Error parsing tool call arguments/);
    expect(() =>
      parseToolcallActions(
        [{ id: "call-1", function: { name: "bash", arguments: "{}" } }],
        {
          format_error_template: formatTemplate,
        },
      ),
    ).toThrow(/Missing 'command'/);
  });
});

describe("observation formatting", () => {
  test("pads unexecuted native actions and keeps tool identifiers", () => {
    const messages = formatToolcallObservationMessages({
      actions: [
        { command: "echo one", tool_call_id: "call-1" },
        { command: "echo two", tool_call_id: "call-2" },
      ],
      outputs: [{ output: "one\n", returncode: 0, exception_info: "" }],
      observation_template: observationTemplate,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(messages[0]?.content).toContain("<returncode>0</returncode>");
    expect(messages[1]?.content).toContain("action was not executed");
    expect(messages[1]?.extra?.returncode).toBe(-1);
    expect(messages[1]).toMatchObject({ role: "tool", tool_call_id: "call-2" });
  });

  test("does not pad text observations", () => {
    const messages = formatTextObservationMessages(
      [{ output: "only\n", returncode: 0, exception_info: "" }],
      { observation_template: observationTemplate },
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.tool_call_id).toBeUndefined();
  });

  test("requires exactly one regex action and exposes the count", () => {
    expect(
      parseRegexActions("```mswea_bash_command\necho hi\n```", {
        action_regex: "```mswea_bash_command\\s*\\n(.*?)\\n```",
        format_error_template: "found {{ actions | length }}",
      }),
    ).toEqual([{ command: "echo hi" }]);
    expect(() =>
      parseRegexActions("no action", {
        action_regex: "```mswea_bash_command\\s*\\n(.*?)\\n```",
        format_error_template: "found {{ actions | length }}",
      }),
    ).toThrow(FormatError);
  });
});
