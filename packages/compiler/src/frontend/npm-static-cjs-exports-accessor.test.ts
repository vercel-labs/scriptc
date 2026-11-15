import { describe, expect, test } from "vitest";
import { exportReads } from "./npm-static-cjs-exports-accessor.js";
import { nodeFrontendServices } from "./services-node.js";

function normalize(source: string): string | null {
  return nodeFrontendServices().cjsExportsAccessor(source, "/pkg/index.js");
}

const HEAD = `'use strict';
function assemble() {
\tconst table = {};
\ttable.red = 31;
\treturn table;
}
`;

describe("an accessor installed as module.exports", () => {
  test("is respelled as the getter's value, read as often as Node reads it", () => {
    const source = `${HEAD}
// Make the export immutable
Object.defineProperty(module, 'exports', {
\tenumerable: true,
\tget: assemble
});
`;
    const out = normalize(source);
    expect(out).not.toBeNull();
    // Node's reads of the export while the module loads: one whose value is
    // not used, one tested for truth, and then three, two or one more.
    expect(out).toContain(`module.exports = ${exportReads("assemble")};`);
    expect(exportReads("assemble").match(/assemble\(\)/g)).toHaveLength(7);
    expect(exportReads("assemble")).toMatch(
      /^\(assemble\(\), assemble\(\) \? \(.*isProxy\(assemble\(\)\) \? assemble\(\) : \(.*, assemble\(\)\)\) : assemble\(\)\)$/,
    );
    expect(out).not.toContain("defineProperty");
    // Every other line stays where it was.
    expect(out!.split("\n").length).toBe(source.split("\n").length);
    expect(out!.split("\n").slice(0, 8)).toEqual(source.split("\n").slice(0, 8));
  });

  test("keeps every shape whose getter call Node could tell from the respelling", () => {
    const statement =
      "Object.defineProperty(module, 'exports', { enumerable: true, get: assemble });\n";
    // The control: the plain shape is respelled.
    expect(normalize(HEAD + statement)).not.toBeNull();
    // Not the last statement: later code can read or replace the export.
    expect(normalize(HEAD + statement + "console.log(1);\n")).toBeNull();
    // The getter reads its receiver, which is the module object.
    expect(normalize("function assemble() { return this.id; }\n" + statement)).toBeNull();
    expect(normalize("function assemble() { return arguments.length; }\n" + statement)).toBeNull();
    // The getter is not a top-level function declaration nothing reassigns.
    expect(normalize("const assemble = () => ({});\n" + statement)).toBeNull();
    expect(normalize(HEAD + "assemble = null;\n" + statement)).toBeNull();
    expect(
      normalize(HEAD + "Object.defineProperty(module, 'exports', { get() { return {}; } });\n"),
    ).toBeNull();
    // The export object is named elsewhere in the file.
    expect(normalize(HEAD + "exports.early = 1;\n" + statement)).toBeNull();
    expect(normalize(HEAD + "const m = module;\n" + statement)).toBeNull();
    // A descriptor with a setter or a value is another shape.
    expect(
      normalize(
        HEAD + "Object.defineProperty(module, 'exports', { get: assemble, set: assemble });\n",
      ),
    ).toBeNull();
    // Another property of the module object, or another object.
    expect(
      normalize(HEAD + "Object.defineProperty(module, 'id', { get: assemble });\n"),
    ).toBeNull();
    expect(
      normalize(HEAD + "Object.defineProperty(exports, 'exports', { get: assemble });\n"),
    ).toBeNull();
    // `Object` is the file's own binding.
    expect(normalize("const Object = {};\n" + HEAD + statement)).toBeNull();
  });
});
