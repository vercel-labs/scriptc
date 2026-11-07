import { afterAll, expect, test, vi } from "vitest";
import * as ts from "../../ts7/adapter.js";
import { closeSourceParser, parseSourceFile } from "../../ts7/source-parser-node.js";
import { Lowerer } from "../lowerer.js";
import { jsSourcePatchesCollectionPrototype } from "./collection-methods.js";

afterAll(closeSourceParser);

function context(source: string) {
  const file = parseSourceFile("collections.js", source, "js");
  const lowerer = new Lowerer({ getTypeChecker: () => ({}) } as unknown as ts.Program, file, []);
  let constructor: ts.NewExpression | undefined;
  ts.walkPreorder(file, (node) => {
    if (!constructor && ts.isNewExpression(node)) constructor = node;
  });
  if (!constructor) throw new Error("fixture has no constructor");
  return { lowerer, constructor };
}

test("a file that never patches a collection prototype is scanned once", () => {
  // Every write target below `Other.prototype` reaches the prototype test, so
  // the number of `stdlibGlobalMember` calls counts the file's scans.
  const writes = Array.from({ length: 25 }, (_, i) => `Other.prototype.m${i} = ${i};`).join("\n");
  const { lowerer, constructor } = context(
    `class Other {}\n${writes}\nconst set = new Set([1]);\n`,
  );
  const member = vi.spyOn(lowerer, "stdlibGlobalMember").mockReturnValue(null);
  expect(jsSourcePatchesCollectionPrototype(lowerer, constructor, "Set")).toBe(false);
  const scanned = member.mock.calls.length;
  // One scan looks at each write site at most once.
  expect(scanned).toBeGreaterThan(0);
  expect(scanned).toBeLessThanOrEqual(25);
  for (let i = 0; i < 20; i++)
    expect(jsSourcePatchesCollectionPrototype(lowerer, constructor, "Set")).toBe(false);
  expect(member.mock.calls.length).toBe(scanned);
});

test("a file that patches a collection prototype answers from the first scan", () => {
  const { lowerer, constructor } = context(`Set.prototype.add = function () {};\nnew Set([1]);\n`);
  const member = vi.spyOn(lowerer, "stdlibGlobalMember").mockReturnValue("prototype");
  expect(jsSourcePatchesCollectionPrototype(lowerer, constructor, "Set")).toBe(true);
  const scanned = member.mock.calls.length;
  expect(scanned).toBe(1);
  for (let i = 0; i < 20; i++)
    expect(jsSourcePatchesCollectionPrototype(lowerer, constructor, "Set")).toBe(true);
  expect(member.mock.calls.length).toBe(scanned);
});
