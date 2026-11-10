import { describe, expect, test } from "vitest";
import { UndefinedError, renderStrict } from "./render.ts";

describe("renderStrict", () => {
  test("throws the missing name instead of rendering it", () => {
    expect(() => renderStrict("{{ missing }}", {})).toThrow(UndefinedError);
    expect(() => renderStrict("{{ missing }}", {})).toThrow(
      "'missing' is undefined",
    );
  });

  test("throws when a conditional reads a missing name", () => {
    expect(() =>
      renderStrict("{% if missing %}yes{% else %}no{% endif %}", {}),
    ).toThrow("'missing' is undefined");
  });

  test("allows defined and default to mention a missing name", () => {
    expect(
      renderStrict("{% if missing is defined %}yes{% else %}no{% endif %}", {}),
    ).toBe("no");
    expect(renderStrict("{{ missing | default('x') }}", {})).toBe("x");
    expect(renderStrict("{{ missing | default('x', true) }}", {})).toBe("x");
  });

  test("does not evaluate the branch that is not taken", () => {
    expect(
      renderStrict("{% if false %}{{ missing }}{% else %}ok{% endif %}", {}),
    ).toBe("ok");
    expect(
      renderStrict("{% if false and missing %}x{% else %}y{% endif %}", {}),
    ).toBe("y");
    expect(
      renderStrict("{% if true or missing %}y{% else %}n{% endif %}", {}),
    ).toBe("y");
  });

  test("throws for a missing nested attribute and a missing attribute on a dict", () => {
    expect(() => renderStrict("{{ missing.nested }}", {})).toThrow(
      "'missing' is undefined",
    );
    expect(() =>
      renderStrict(
        "{% if missing.nested is defined %}y{% else %}n{% endif %}",
        {},
      ),
    ).toThrow("'missing' is undefined");
    expect(() => renderStrict("{{ obj.missing }}", { obj: { a: 1 } })).toThrow(
      "'dict object' has no attribute 'missing'",
    );
  });

  test("uses Python truthiness", () => {
    expect(
      renderStrict("{% if items %}yes{% else %}no{% endif %}", { items: [] }),
    ).toBe("no");
    expect(
      renderStrict("{% if items %}yes{% else %}no{% endif %}", { items: [1] }),
    ).toBe("yes");
    expect(renderStrict("{% if n %}yes{% else %}no{% endif %}", { n: 0 })).toBe(
      "no",
    );
    expect(
      renderStrict("{% if s %}yes{% else %}no{% endif %}", { s: "" }),
    ).toBe("no");
    expect(
      renderStrict("{% if d %}yes{% else %}no{% endif %}", { d: {} }),
    ).toBe("no");
  });

  test("renders slices, loops, and length", () => {
    expect(
      renderStrict("{{ output.output[:5] }}|{{ output.output[-3:] }}", {
        output: { output: "abcdefghij" },
      }),
    ).toBe("abcde|hij");
    expect(renderStrict("{{ xs | length }}", { xs: [1, 2, 3] })).toBe("3");
    expect(
      renderStrict("{% for x in xs %}{{ x }},{% endfor %}", { xs: ["a", "b"] }),
    ).toBe("a,b,");
    expect(
      renderStrict("{{ xs[1] }}{{ xs[-1] }}", { xs: ["a", "b", "c"] }),
    ).toBe("bc");
  });

  test("preserves whitespace and Python boolean text", () => {
    expect(renderStrict("{%- if true -%} yes {%- endif -%}", {})).toBe("yes");
    expect(renderStrict("{% if true %}\n yes\n{% endif %}\n", {})).toBe(
      "\n yes\n",
    );
    expect(renderStrict("{{ flag }}", { flag: true })).toBe("True");
    expect(renderStrict("{{ flag }}", { flag: false })).toBe("False");
    expect(renderStrict("{{ n }}", { n: null })).toBe("None");
    expect(
      renderStrict(
        "{%- if system == 'Darwin' -%}mac{%- else -%}other{%- endif -%}",
        {
          system: "Darwin",
        },
      ),
    ).toBe("mac");
  });

  test("renders tojson with sorted keys, ascii, and HTML escapes", () => {
    expect(
      renderStrict("{{ value | tojson }}", { value: { b: 1, a: "<x>&'" } }),
    ).toBe('{"a": "\\u003cx\\u003e\\u0026\\u0027", "b": 1}');
    expect(renderStrict("{{ value | tojson }}", { value: "héllo\n" })).toBe(
      '"h\\u00e9llo\\n"',
    );
    expect(
      renderStrict("{{ value | tojson }}", {
        value: { z: 1, a: [true, null, "ø"] },
      }),
    ).toBe('{"a": [true, null, "\\u00f8"], "z": 1}');
  });

  test("selects the truncation branch from finish_reason", () => {
    const template =
      "{% if finish_reason is defined and (finish_reason == 'length' or (finish_reason == 'tool_calls' and not has_tool_calls)) %}cut{% else %}err {{ error }}{% endif %}";
    expect(
      renderStrict(template, {
        finish_reason: "length",
        has_tool_calls: false,
        error: "nope",
      }),
    ).toBe("cut");
    expect(
      renderStrict(template, {
        finish_reason: "stop",
        has_tool_calls: true,
        error: "bad",
      }),
    ).toBe("err bad");
  });
});
