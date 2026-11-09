import { describe, expect, test } from "vitest";
import { UNSET, recursive_merge } from "./serialize.ts";

describe("recursive_merge", () => {
  test("returns an empty object when nothing is passed", () => {
    expect(recursive_merge()).toEqual({});
  });

  test("copies a single dictionary", () => {
    expect(recursive_merge({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("lets later values override earlier ones", () => {
    expect(recursive_merge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({
      a: 1,
      b: 3,
      c: 4,
    });
  });

  test("merges nested dictionaries", () => {
    expect(
      recursive_merge({ a: { x: 1, y: 2 }, b: 3 }, { a: { y: 3, z: 4 }, c: 5 }),
    ).toEqual({ a: { x: 1, y: 3, z: 4 }, b: 3, c: 5 });
  });

  test("merges deeply nested dictionaries", () => {
    expect(
      recursive_merge(
        { a: { b: { c: 1, d: 2 } } },
        { a: { b: { d: 3, e: 4 } } },
      ),
    ).toEqual({ a: { b: { c: 1, d: 3, e: 4 } } });
  });

  test("replaces a dictionary with a non-dictionary", () => {
    expect(recursive_merge({ a: { x: 1, y: 2 } }, { a: "string" })).toEqual({
      a: "string",
    });
  });

  test("replaces a non-dictionary with a dictionary", () => {
    expect(recursive_merge({ a: "string" }, { a: { x: 1, y: 2 } })).toEqual({
      a: { x: 1, y: 2 },
    });
  });

  test("merges more than two dictionaries", () => {
    expect(
      recursive_merge({ a: 1, b: 2 }, { b: 3, c: 4 }, { c: 5, d: 6 }),
    ).toEqual({
      a: 1,
      b: 3,
      c: 5,
      d: 6,
    });
  });

  test("does not merge lists", () => {
    expect(recursive_merge({ list: [1, 2, 3] }, { list: [4, 5] })).toEqual({
      list: [4, 5],
    });
  });

  test("keeps nested keys when a later dictionary is empty", () => {
    expect(recursive_merge({ a: { x: 1 } }, { a: {} })).toEqual({
      a: { x: 1 },
    });
  });

  test("skips null dictionaries", () => {
    expect(recursive_merge(null, { a: 1 }, undefined, { b: 2 })).toEqual({
      a: 1,
      b: 2,
    });
  });

  test("skips UNSET values, including nested ones", () => {
    expect(recursive_merge({ a: 1, b: UNSET })).toEqual({ a: 1 });
    expect(recursive_merge({ a: 1 }, { a: UNSET, b: 2 })).toEqual({
      a: 1,
      b: 2,
    });
    expect(recursive_merge({ run: { task: UNSET } })).toEqual({ run: {} });
    expect(recursive_merge({ a: { b: { c: UNSET } } })).toEqual({
      a: { b: {} },
    });
    expect(recursive_merge({ run: { task: UNSET, other: "value" } })).toEqual({
      run: { other: "value" },
    });
  });

  test("does not mutate the inputs", () => {
    const first = { a: { x: 1 } };
    const second = { a: { y: 2 } };
    recursive_merge(first, second);
    expect(first).toEqual({ a: { x: 1 } });
    expect(second).toEqual({ a: { y: 2 } });
  });
});
