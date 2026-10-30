import { describe, expect, test } from "vitest";
import { nodeFrontendServices } from "../services-node.js";
import { applyPatchEdits, patchFile, type PatchRequest } from "./locate.js";
import { parseSelector, parseTypeText, type Selector, type TypePatchOp } from "./selector.js";

function patch(file: string, text: string, patches: Record<string, string>) {
  const requests: PatchRequest[] = Object.entries(patches).map(([sel, type], id) => ({
    id,
    selector: parseSelector(sel) as Selector,
    op: parseTypeText(type) as TypePatchOp,
  }));
  const kind = /\.[cm]?ts$/.test(file) ? "ts" : "js";
  const sf = nodeFrontendServices().parse(`/pkg/${file}`, text, kind);
  const result = patchFile(file, text, sf, requests);
  const out = applyPatchEdits(text, result.edits);
  expect(out.split("\n").length).toBe(text.split("\n").length);
  return { ...result, text: out };
}

const COMMANDER_LIKE = `class Command {
  /**
   * @typedef HelpContext
   * @type {object}
   * @property {boolean} error
   * @property {number} helpWidth
   * @property {function} write - includes stripColor if needed
   *
   * @returns {HelpContext}
   * @private
   */
  _getOutputContext(contextOptions) {
    let helpWidth;
    return { error: false, write: () => {}, helpWidth };
  }
}
module.exports = { Command };
`;

const MS_LIKE = `/**
 * @param {String|Number} val
 * @param {Object} [options]
 * @return {String|Number}
 */
module.exports = function (val, options) {
  return parse(val);
};

/**
 * @param {String} str
 * @return {Number}
 */
function parse(str) {
  if (str.length > 100) {
    return;
  }
  return 1;
}
`;

describe("JSDoc", () => {
  test("a @typedef property widens", () => {
    const r = patch("lib/command.js", COMMANDER_LIKE, { "HelpContext.helpWidth": "| undefined" });
    expect(r.text).toContain("@property {number | undefined} helpWidth");
    expect(r.text).toContain("@returns {HelpContext}");
    expect(r.matches).toMatchObject([
      { line: 6, before: "number", after: "number | undefined", redundant: false },
    ]);
  });

  test("returns of export= and of a file-local function widen", () => {
    const r = patch("index.js", MS_LIKE, {
      "export=()": "| undefined",
      "index.js:parse()": "| undefined",
    });
    expect(r.text).toContain("@return {String|Number | undefined}\n */\nmodule.exports");
    expect(r.text).toContain("@return {Number | undefined}\n */\nfunction parse");
    expect(r.problems).toEqual([]);
  });

  test("a file prefix restricts the root to that file", () => {
    const r = patch("other.js", MS_LIKE, { "index.js:parse()": "| undefined" });
    expect(r.matches).toEqual([]);
    expect(r.text).toBe(MS_LIKE);
  });

  test("parameters, optional parameters and redundancy", () => {
    const r = patch("index.js", MS_LIKE, {
      "export=(options)": "| undefined",
      "parse(str)": "string | undefined",
    });
    expect(r.matches[0]).toMatchObject({ redundant: true });
    expect(r.text).toContain("@param {string | undefined} str");
  });

  test("a replacement on an undocumented declaration inserts a tag", () => {
    const text =
      "/** Adds. */\nfunction add(a, b) { return a + b; }\nfunction sub(a, b) { return a - b; }\n";
    const r = patch("index.js", text, { "add()": "number", "sub(a)": "number" });
    expect(r.text).toBe(
      "/** Adds. @returns {number} */\nfunction add(a, b) { return a + b; }\n/** @param {number} a */ function sub(a, b) { return a - b; }\n",
    );
  });

  test("a widening needs a written type", () => {
    const r = patch("index.js", "function f() { return 1; }\n", { "f()": "| undefined" });
    expect(r.problems[0]!.message).toContain("no written type to widen");
  });

  test("members of exported objects, classes and constructor assignments", () => {
    const text = `class Box {
  constructor() {
    /** @type {string} */
    this.label = "";
  }
  /** @returns {number} */
  size() { return 1; }
}
module.exports = {
  /** @returns {string} */
  name() { return ""; },
  Box,
};
`;
    const r = patch("index.js", text, {
      "Box.label": "| undefined",
      "Box.size()": "| null",
      "export=.name()": "| undefined",
    });
    expect(r.text).toContain("@type {string | undefined} */\n    this.label");
    expect(r.text).toContain("@returns {number | null} */\n  size()");
    expect(r.text).toContain("@returns {string | undefined} */\n  name()");
  });

  test("function types are parenthesized before widening", () => {
    const r = patch("index.js", "/** @type {(a: string) => void} */\nvar cb = null;\n", {
      cb: "| undefined",
    });
    expect(r.text).toContain("@type {((a: string) => void) | undefined}");
  });
});

describe("declaration files", () => {
  const DTS = `export interface Options {
  name: string;
  retries?: number;
  env: Env;
}
export interface Env {
  [key: string]: string;
}
export declare function fetchUser(id: string): Promise<{ email: string; id: string }>;
export declare function load(): User;
interface User { name: string; tags: string[] }
declare function ms(value: string): number;
declare function ms(value: number): string;
declare namespace ms { const version: string; }
export = ms;
`;

  test("members, optional members, index signatures and navigation", () => {
    const r = patch("index.d.ts", DTS, {
      "Options.name": "| undefined",
      "Options.retries": "| undefined",
      "Env[string]": "| undefined",
      "fetchUser().email": "string | null",
      "load().tags[]": "| undefined",
      "Options.env[string]": "| null",
    });
    expect(r.text).toContain("  name: string | undefined;");
    expect(r.text).toContain("[key: string]: string | undefined | null;");
    expect(r.text).toContain("Promise<{ email: string | null; id: string }>");
    expect(r.text).toContain("tags: (string | undefined)[]");
    expect(r.matches.find((m) => m.id === 1)).toMatchObject({ redundant: true });
  });

  test("export= widens every overload, and a replacement of several is refused", () => {
    const r = patch("index.d.ts", DTS, { "export=()": "| undefined" });
    expect(r.text).toContain("declare function ms(value: string): number | undefined;");
    expect(r.text).toContain("declare function ms(value: number): string | undefined;");
    const refused = patch("index.d.ts", DTS, { "export=()": "number" });
    expect(refused.problems[0]!.message).toContain("matches 2 declarations");
    expect(refused.text).toBe(DTS);
  });

  test("namespace members and generic types", () => {
    const r = patch("index.d.ts", DTS, { "ms.version": "| undefined" });
    expect(r.text).toContain("const version: string | undefined;");
    const generic = patch(
      "index.d.ts",
      "export declare function f(): Map<string, { a: number }>;\n",
      { "f().a": "| undefined" },
    );
    expect(generic.problems[0]!.message).toContain("cannot follow");
  });

  test("multi-line types keep their line count when replaced", () => {
    const text = "export interface A {\n  b: {\n    c: number;\n  };\n}\n";
    const r = patch("index.d.ts", text, { "A.b": "string" });
    expect(r.text.startsWith("export interface A {\n  b: string\n\n;")).toBe(true);
  });
});
