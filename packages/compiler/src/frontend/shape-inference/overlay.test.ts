import { afterAll, expect, test } from "vitest";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";
import { neutralizeDocTags, OVERLAY_MARK } from "./overlay.js";

afterAll(closeSourceParser);

test("neutralizeDocTags rewrites JSDoc comments and keeps literals", () => {
  const source = [
    "/** @param {number} a */",
    "function f(a) {",
    '  const s = "/** @type {number} */";',
    "  const t = `/** @returns {string} ${a} */`;",
    "  const r = /\\/\\*\\* @param \\*\\//;",
    "  // /** @type {string} */",
    `  /** @type {string} ${OVERLAY_MARK} */ const u = s + t;`,
    "  return a / 2 /** @returns {number} */;",
    "}",
  ].join("\n");
  const out = neutralizeDocTags(parseSourceFile("overlay.js", source, "js"));
  expect(out.length).toBe(source.length);
  expect(out.split("\n")).toEqual([
    "/** -param {number} a */",
    "function f(a) {",
    '  const s = "/** @type {number} */";',
    "  const t = `/** @returns {string} ${a} */`;",
    "  const r = /\\/\\*\\* @param \\*\\//;",
    "  // /** @type {string} */",
    `  /** @type {string} ${OVERLAY_MARK} */ const u = s + t;`,
    "  return a / 2 /** -returns {number} */;",
    "}",
  ]);
});
