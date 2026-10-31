import { afterAll, expect, test } from "vitest";
import * as ts from "../ts7/adapter.js";
import { isMemberWriteTarget } from "./namespace-member-writes.js";
import { closeSourceParser, parseSourceFile } from "../ts7/source-parser-node.js";

afterAll(closeSourceParser);

/** Whether the first `Math.abs` property access of `source` only writes or
 * deletes the member. */
function writeTarget(source: string, names: string[] = ["abs"]): boolean {
  const file = parseSourceFile("probe.js", source, "js");
  let found: ts.PropertyAccessExpression | null = null;
  ts.walkPreorder(file, (node) => {
    if (found !== null) return;
    if (ts.isPropertyAccessExpression(node) && names.includes(node.name.text)) found = node;
  });
  if (found === null) throw new Error(`no property access in ${source}`);
  return isMemberWriteTarget(found);
}

test("a plain assignment and a delete write the member", () => {
  expect(writeTarget("Math.abs = replacement;")).toBe(true);
  expect(writeTarget("delete Math.abs;")).toBe(true);
  expect(writeTarget("(Math.abs) = replacement;")).toBe(true);
});

test("a read, a call and a compound assignment observe the static lowering", () => {
  expect(writeTarget("const value = Math.abs;")).toBe(false);
  expect(writeTarget("Math.abs(-1);")).toBe(false);
  expect(writeTarget("Math.abs += 1;")).toBe(false);
  expect(writeTarget("Math.abs++;")).toBe(false);
});
