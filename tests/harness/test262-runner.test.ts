import { expect, test } from "vitest";
import { boundedRun } from "../test262/execute.js";
import { compileFailureStatus, exclusion, metadata, prepare, summarize, variants } from "../test262/support.mjs";

const source = (yaml: string, body = "assert.sameValue(1, 1);") => `/*---\n${yaml}\n---*/\n${body}`;

test("Test262 YAML metadata handles block text, lists, features and negative phases", () => {
  const meta = metadata(source(`description: >
  flags: [noStrict] inside a description is not a flag
flags:
  - onlyStrict
features: [BigInt]
includes: [propertyHelper.js]
negative:
  phase: parse
  type: SyntaxError`));
  expect(meta.flags).toEqual(["onlyStrict"]);
  expect(meta.negative).toEqual({ phase: "parse", type: "SyntaxError" });
  expect(meta.features).toEqual(["BigInt"]);
  expect(meta.includes).toEqual(["propertyHelper.js"]);
});

test("metadata generates the upstream variants without rewriting execution goals", () => {
  expect(variants(metadata(source("description: plain")))).toEqual(["sloppy", "strict"]);
  for (const [flag, expected] of [["onlyStrict", "strict"], ["noStrict", "sloppy"], ["module", "module"], ["raw", "raw"]]) {
    expect(variants(metadata(source(`flags: [${flag}]`)))).toEqual([expected]);
  }
  expect(() => metadata(source("flags: [onlyStrict, noStrict]"))).toThrow();
  expect(variants(metadata(source("flags: [module, raw]")))).toEqual(["module"]);
  expect(() => metadata(source("flags: [futureFlag]"))).toThrow();
  expect(() => metadata(source("negative: {phase: compile, type: SyntaxError}"))).toThrow();
});

test("unsupported execution requirements and assertion reflection remain exclusions", () => {
  for (const [head, body] of [
    ["negative: {phase: parse, type: SyntaxError}", "invalid syntax"],
    ["negative: {phase: runtime, type: TypeError}", "throw new TypeError();"],
    ["flags: [async]", "$DONE();"],
    ["includes: [propertyHelper.js]", "verifyProperty({}, 'x', {});"],
    ["description: global script", "assert.sameValue(this, globalThis);"],
    ["description: reflection", "assert.sameValue(typeof assert, 'function');"],
    ["description: mutation", "assert.sameValue = () => {};"],
    ["description: unsupported helper", "assert.throws(TypeError, () => {});"],
  ]) {
    const text = source(head!, body);
    expect(exclusion(text, metadata(text), "strict")).toBeTypeOf("string");
  }
  const text = source("description: scalar", "// globalThis and this in comments are harmless\nassert.sameValue('this', 'this');");
  expect(exclusion(text, metadata(text), "strict")).toBeUndefined();
  expect(exclusion(text, metadata(text), "sloppy")).toBe("execution:sloppy");
});

test("the compareArray include only admits the implemented assertion form", () => {
  const accepted = source("includes: [compareArray.js]", "assert.compareArray([1, NaN], [1, NaN]);");
  expect(exclusion(accepted, metadata(accepted), "strict")).toBeUndefined();
  const globalHelper = source("includes: [compareArray.js]", "compareArray([1], [1]);");
  expect(exclusion(globalHelper, metadata(globalHelper), "strict")).toBe("harness:compareArray-surface");
});

test("the adapter retains the test body without a function or try/catch wrapper", () => {
  const body = source("description: lexical", "const x = 1;\nassert.sameValue(x, 1);");
  const result = prepare(body);
  expect(result.startsWith('"use strict";\n')).toBe(true);
  expect(result).toContain(`\n${body}\n`);
  expect(result).not.toContain("try {");
});

test("reports keep exclusions, refusals, failures and passes separate", () => {
  expect(summarize([
    { status: "pass" }, { status: "compile-refusal" }, { status: "fail" },
    { status: "excluded", reason: "execution:sloppy" },
    { status: "excluded", reason: "execution:sloppy" },
  ])).toEqual({
    counts: { pass: 1, "compile-refusal": 1, fail: 1, excluded: 2 },
    exclusions: { "execution:sloppy": 2 },
  });
});

test("internal compiler failures cannot be classified as intentional refusals", () => {
  for (const code of ["SC0004", "SC9001", "SC9002"]) {
    expect(compileFailureStatus([{ code, loc: { file: "/tmp/harness.ts" } }])).toBe("compiler-error");
  }
  for (const code of ["SC3003", "SC3004"]) expect(compileFailureStatus([{ code }])).toBe("build-error");
  for (const code of ["SC2020", "SC3001", "SC3002"]) expect(compileFailureStatus([{ code }])).toBe("compile-refusal");
  expect(compileFailureStatus([{ code: "SC2020", loc: { file: "/tmp/harness.ts" } }])).toBe("harness-refusal");
});

test("a stuck process is killed and reported as a timeout", async () => {
  const result = await boundedRun(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100);
  expect(result.timeout).toBe(true);
  expect(result.code).not.toBe(0);
});
