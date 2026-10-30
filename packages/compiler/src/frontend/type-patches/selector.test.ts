import { describe, expect, test } from "vitest";
import { parseSelector, parseTypeText, splitUnion } from "./selector.js";

describe("parseSelector", () => {
  test("members, returns, parameters, elements and index signatures", () => {
    expect(parseSelector("HelpContext.helpWidth")).toEqual({
      file: null,
      root: "HelpContext",
      segments: [{ kind: "member", name: "helpWidth" }],
      text: "HelpContext.helpWidth",
    });
    expect(parseSelector("index.js:parse()")).toMatchObject({
      file: "index.js",
      root: "parse",
      segments: [{ kind: "return" }],
    });
    expect(parseSelector("export=()")).toMatchObject({
      root: "export=",
      segments: [{ kind: "return" }],
    });
    expect(parseSelector("fetchUser(id)")).toMatchObject({
      segments: [{ kind: "param", name: "id" }],
    });
    expect(parseSelector("list()[].name")).toMatchObject({
      segments: [{ kind: "return" }, { kind: "element" }, { kind: "member", name: "name" }],
    });
    expect(parseSelector("Env[string]")).toMatchObject({
      segments: [{ kind: "index", key: "string" }],
    });
  });

  test("malformed selectors say why", () => {
    expect(parseSelector("")).toEqual({ error: "is empty" });
    expect(parseSelector("../x.js:f()")).toEqual({ error: "names a file outside the package" });
    expect(parseSelector("1abc")).toHaveProperty("error");
    expect(parseSelector("a.")).toHaveProperty("error");
    expect(parseSelector("a(1)")).toHaveProperty("error");
  });
});

describe("parseTypeText", () => {
  test("a leading bar widens, anything else replaces", () => {
    expect(parseTypeText("| undefined")).toEqual({ kind: "widen", arms: ["undefined"] });
    expect(parseTypeText("| undefined | null")).toEqual({
      kind: "widen",
      arms: ["undefined", "null"],
    });
    expect(parseTypeText("string | null")).toEqual({ kind: "replace", text: "string | null" });
    expect(parseTypeText("a\nb")).toEqual({ error: "must be one line" });
  });

  test("splitUnion keeps nested unions and arrows together", () => {
    expect(splitUnion("(a | b) | (() => c | d) | { x: e | f }")).toEqual([
      "(a | b)",
      "(() => c | d)",
      "{ x: e | f }",
    ]);
  });
});
