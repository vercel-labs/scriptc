import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { runSource } from "../test262/execute.js";
import {
  exclusion,
  matchesExpectation,
  matchesParseNegative,
  metadata,
  pin,
  vendorRoot,
  verifyVendor,
} from "../test262/support.mjs";
import { shardSelect, shardSuffix } from "./shard.js";

const sanitize = process.env.SCRIPTC_SAN === "1";
const upstreamHarness = ["assert.js", "sta.js"]
  .map((name) => readFileSync(join(vendorRoot, "harness", name), "utf8"))
  .join("\n");
const upstreamPropertyHelper = readFileSync(join(vendorRoot, "harness/propertyHelper.js"), "utf8");
const upstreamTypedArrayHelper = readFileSync(
  join(vendorRoot, "harness/testTypedArray.js"),
  "utf8",
);

function runUpstream(
  source: string,
  variant: "strict" | "sloppy" = "strict",
  includes: string[] = [],
): void {
  const context = createContext({});
  runInContext(upstreamHarness, context, { timeout: 5000 });
  if (includes.includes("propertyHelper.js"))
    runInContext(upstreamPropertyHelper, context, { timeout: 5000 });
  if (includes.includes("testTypedArray.js"))
    runInContext(upstreamTypedArrayHelper, context, { timeout: 5000 });
  runInContext(variant === "strict" ? `"use strict";\n${source}` : source, context, {
    timeout: 5000,
  });
}

async function runUpstreamAsync(
  source: string,
  variant: "strict" | "sloppy",
  includes: string[] = [],
): Promise<void> {
  const context = createContext({});
  let calls = 0;
  const done = new Promise<void>((resolve, reject) => {
    context.$DONE = (error?: unknown) => {
      calls++;
      if (calls > 1) reject(new Error("Test262 called $DONE more than once"));
      else if (error) reject(error);
      else resolve();
    };
  });
  runInContext(upstreamHarness, context, { timeout: 5000 });
  if (includes.includes("propertyHelper.js"))
    runInContext(upstreamPropertyHelper, context, { timeout: 5000 });
  if (includes.includes("testTypedArray.js"))
    runInContext(upstreamTypedArrayHelper, context, { timeout: 5000 });
  runInContext(variant === "strict" ? `"use strict";\n${source}` : source, context, {
    timeout: 5000,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Test262 async completion timed out")), 5000);
      }),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (calls !== 1) throw new Error(`Test262 called $DONE ${calls} times`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("upstream async completion rejects errors and duplicate calls", async () => {
  await expect(
    runUpstreamAsync("$DONE(new Test262Error('failed'));", "strict"),
  ).rejects.toMatchObject({ message: "failed" });
  await expect(runUpstreamAsync("$DONE(); $DONE();", "strict")).rejects.toThrow(
    "Test262 called $DONE 2 times",
  );
});

test("sloppy script source executes through a CommonJS entry", async () => {
  const source = readFileSync(
    join(vendorRoot, "test/language/expressions/addition/S11.6.1_A4_T1.js"),
    "utf8",
  );
  const meta = metadata(source);
  expect(exclusion(source, meta, "sloppy")).toBeUndefined();
  const context = createContext({});
  runInContext(upstreamHarness, context, { timeout: 5000 });
  runInContext(source, context, { timeout: 5000 });
  const result = await runSource(source, { sanitize, variant: "sloppy" });
  expect(result, JSON.stringify(result, null, 2)).toMatchObject({ status: "pass" });
});

test("Test262 regression inputs retain their pinned upstream bytes", () => {
  verifyVendor();
});

test("negative parse cases require a matching compiler syntax diagnostic", async () => {
  const source =
    "/*---\nnegative: {phase: parse, type: SyntaxError}\n---*/\n$DONOTEVALUATE();\nconst = ;";
  expect(exclusion(source, metadata(source), "strict")).toBeUndefined();
  const result = await runSource(source, { sanitize });
  expect(matchesParseNegative(result, source), JSON.stringify(result, null, 2)).toBe(true);
});

const profileCases = shardSelect<string>(pin.tests, (path) => {
  const source = readFileSync(join(vendorRoot, path), "utf8");
  const variant = metadata(source, path).flags.includes("noStrict") ? "sloppy" : "strict";
  return `${path}#${variant}`;
});
// Vitest rejects an empty describe block when a valid shard owns no cases.
if (profileCases.length > 0)
  describe(`Test262 static script profile${shardSuffix()}`, () => {
    for (const path of profileCases) {
      test(path, async () => {
        const source = readFileSync(join(vendorRoot, path), "utf8");
        const meta = metadata(source, path);
        const variant = meta.flags.includes("noStrict") ? "sloppy" : "strict";
        expect(exclusion(source, meta, variant)).toBeUndefined();
        // Independently check the unchanged test with the original global-script
        // harness. Node is a host sanity check, not the conformance oracle.
        if (meta.negative?.phase === "parse") {
          let error: unknown;
          try {
            runUpstream(source, variant);
          } catch (caught) {
            error = caught;
          }
          expect(error).toMatchObject({ name: "SyntaxError" });
        } else if (meta.flags.includes("async"))
          await runUpstreamAsync(source, variant, meta.includes);
        else runUpstream(source, variant, meta.includes);
        const result = await runSource(source, {
          sanitize,
          variant,
          asyncTest: meta.flags.includes("async"),
          includes: meta.includes,
        });
        if (meta.negative?.phase === "parse") {
          expect(
            matchesParseNegative(result, source, variant),
            JSON.stringify(result, null, 2),
          ).toBe(true);
        } else
          expect(
            matchesExpectation(`${path}#${variant}`, result),
            JSON.stringify(result, null, 2),
          ).toBe(true);
      });
    }
  });

const controls = [
  {
    name: "scalar SameValue",
    status: "pass",
    source: `
assert(true);
assert.sameValue(NaN, NaN);
assert.notSameValue(0, -0);
assert.notSameValue(null, undefined);
assert.sameValue(undefined, undefined);
assert.sameValue(null, null);
assert.notSameValue(1, "1");
`,
  },
  { name: "wrong SameValue", status: "fail", source: "assert.sameValue(1, 2);" },
  { name: "signed zero mismatch", status: "fail", source: "assert.sameValue(0, -0);" },
  { name: "NaN is the same value", status: "fail", source: "assert.notSameValue(NaN, NaN);" },
  {
    name: "scalar array contents",
    status: "pass",
    source: "assert.compareArray([1, NaN, -0, undefined], [1, NaN, -0, undefined]);",
  },
  { name: "array length mismatch", status: "fail", source: "assert.compareArray([1], [1, 2]);" },
  {
    name: "array element mismatch",
    status: "fail",
    source: "assert.compareArray([1, 2], [1, 3]);",
  },
  { name: "array signed zero mismatch", status: "fail", source: "assert.compareArray([0], [-0]);" },
  { name: "assert requires true, not truthiness", status: "fail", source: "assert(1);" },
  {
    name: "exact built-in exception",
    status: "pass",
    source: "assert.throws(TypeError, () => { throw new TypeError('x'); });",
  },
  {
    name: "exact reference exception",
    status: "pass",
    source: "assert.throws(ReferenceError, () => { throw new ReferenceError('x'); });",
  },
  {
    name: "exact evaluation exception",
    status: "pass",
    source: "assert.throws(EvalError, () => { throw new EvalError('x'); });",
  },
  {
    name: "exact URI exception",
    status: "pass",
    source: "assert.throws(URIError, () => { throw new URIError('x'); });",
  },
  {
    name: "reference exception is not a type exception",
    status: "fail",
    source: "assert.throws(TypeError, () => { throw new ReferenceError('x'); });",
  },
  {
    name: "subclassed reference exception is not exact",
    status: "fail",
    source:
      "class E extends ReferenceError {} assert.throws(ReferenceError, () => { throw new E('x'); });",
  },
  {
    name: "wrong built-in exception",
    status: "fail",
    source: "assert.throws(TypeError, () => { throw new RangeError('x'); });",
  },
  {
    name: "subclass is not exact",
    status: "fail",
    source: "class E extends TypeError {} assert.throws(TypeError, () => { throw new E('x'); });",
  },
  { name: "missing exception", status: "fail", source: "assert.throws(TypeError, () => {});" },
  {
    name: "primitive exception",
    status: "fail",
    source: "assert.throws(TypeError, () => { throw 1; });",
  },
  {
    name: "identical references",
    status: "pass",
    source: `
const object = {};
const list = [1];
const fn = function () {};
assert.sameValue(object, object);
assert.sameValue(list, list);
assert.sameValue(fn, fn);
assert.compareArray([object, fn], [object, fn]);
`,
  },
  {
    name: "a reference is not a primitive",
    status: "pass",
    source:
      "assert.notSameValue({}, 1); assert.notSameValue([], undefined); assert.notSameValue(null, {});",
  },
  { name: "reference and primitive mismatch", status: "fail", source: "assert.sameValue([], 0);" },
  {
    name: "identical references are not different",
    status: "fail",
    source: "const object = {}; assert.notSameValue(object, object);",
  },
  {
    name: "array element reference and primitive mismatch",
    status: "fail",
    source: "assert.compareArray([{}], [1]);",
  },
  {
    name: "non-string messages",
    status: "pass",
    source:
      "assert.sameValue(1, 1, false); assert.notSameValue(1, 2, 0); assert(true, null); assert.compareArray([], [], 1);",
  },
  {
    name: "failure with a non-string message",
    status: "fail",
    source: "assert.sameValue(1, 2, false);",
  },
];

describe(`Test262 host assertion contract${shardSuffix()}`, () => {
  for (const control of shardSelect(controls, (item) => `host:${item.name}`)) {
    test(control.name, async () => {
      const nodeRun = () => runUpstream(control.source);
      if (control.status === "pass") expect(nodeRun).not.toThrow();
      else expect(nodeRun).toThrow();
      const result = await runSource(control.source, { sanitize });
      expect(result, JSON.stringify(result, null, 2)).toMatchObject({ status: control.status });
    });
  }

  test("successful early process exit cannot masquerade as test completion", async () => {
    const result = await runSource("process.exit(0);", { sanitize });
    expect(result.status).toBe("fail");
  });

  for (const value of shardSelect(
    ["{}", "[1]", "function () {}"],
    (value) => `reference:${value}`,
  )) {
    test(`distinct reference assertions are explicitly refused: ${value}`, async () => {
      const source = `try { assert.sameValue(${value}, ${value}); } catch { } try { assert.notSameValue(${value}, ${value}); } catch { }`;
      expect(() => runUpstream(source)).not.toThrow();
      const result = await runSource(source, { sanitize });
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "harness-refusal",
        reason: "reference-assertion",
      });
    });
  }

  test("distinct array element references are refused", async () => {
    const source = "try { assert.compareArray([{}], [{}]); } catch { }";
    expect(() => runUpstream(source)).not.toThrow();
    const result = await runSource(source, { sanitize });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "harness-refusal",
      reason: "reference-assertion",
    });
  });

  test("array-like objects remain outside the adapter", async () => {
    const source = "try { assert.compareArray({ 0: 1, length: 1 }, [1]); } catch { }";
    expect(() => runUpstream(source)).not.toThrow();
    const result = await runSource(source, { sanitize });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "harness-refusal",
      reason: "reference-assertion",
    });
  });

  test("non-Error objects do not masquerade as Error assertions", async () => {
    const source =
      'const value = JSON.parse(\'{"constructor":"[builtin TypeError]"}\'); assert.throws(TypeError, () => { throw value; });';
    expect(() => runUpstream(source)).toThrow();
    const result = await runSource(source, { sanitize });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "harness-refusal",
      reason: "non-error-assertion",
    });
  });
});

const propertyControls = shardSelect(
  [
    {
      name: "data descriptor",
      status: "pass",
      source:
        "const o = { a: 1 }; verifyProperty(o, 'a', { value: 1, writable: true, enumerable: true, configurable: true });",
    },
    {
      name: "wrong value",
      status: "fail",
      source: "const o = { a: 1 }; verifyProperty(o, 'a', { value: 2 });",
    },
    {
      name: "wrong writable",
      status: "fail",
      source: "const o = { a: 1 }; verifyProperty(o, 'a', { writable: false });",
    },
    {
      name: "wrong enumerable",
      status: "fail",
      source: "const o = { a: 1 }; verifyProperty(o, 'a', { enumerable: false });",
    },
    {
      name: "wrong configurable",
      status: "fail",
      source: "const o = { a: 1 }; verifyProperty(o, 'a', { configurable: false });",
    },
    {
      name: "getter and setter fields follow the upstream helper",
      status: "pass",
      source: "const o = { a: 1 }; verifyProperty(o, 'a', { get: 2, set: 3 });",
    },
    {
      name: "absent property",
      status: "pass",
      source: "const o = {}; verifyProperty(o, 'a', undefined);",
    },
    {
      name: "unexpected presence",
      status: "fail",
      source: "const o = { a: 1 }; verifyProperty(o, 'a', undefined);",
    },
    {
      name: "nonconfigurable property",
      status: "pass",
      source:
        "const o = JSON.parse('{}'); Object.defineProperty(o, 'a', { value: 1 }); verifyProperty(o, 'a', { value: 1, writable: false, enumerable: false, configurable: false });",
    },
    {
      name: "restored property",
      status: "pass",
      source:
        "const o = { a: 1 }; verifyProperty(o, 'a', { configurable: true }, { restore: true }); assert.sameValue(o.a, 1);",
    },
    {
      name: "reference value",
      status: "pass",
      source: "const f = function() {}; const o = { a: f }; verifyProperty(o, 'a', { value: f });",
    },
    {
      name: "distinct reference value",
      status: "harness-refusal",
      source:
        "const o = { a: function() {} }; try { verifyProperty(o, 'a', { value: function() {} }); } catch { }",
    },
  ],
  (item) => `property:${item.name}`,
);

if (propertyControls.length > 0)
  describe(`Test262 property helper contract${shardSuffix()}`, () => {
    for (const control of propertyControls) {
      test(control.name, async () => {
        if (control.status === "fail")
          expect(() => runUpstream(control.source, "strict", ["propertyHelper.js"])).toThrow();
        else
          expect(() => runUpstream(control.source, "strict", ["propertyHelper.js"])).not.toThrow();
        const result = await runSource(control.source, {
          sanitize,
          includes: ["propertyHelper.js"],
        });
        expect(result, JSON.stringify(result, null, 2)).toMatchObject({ status: control.status });
      });
    }
  });

const typedArrayControls = shardSelect(
  [
    {
      name: "every constructor with array, array-like and buffer arguments",
      status: "pass",
      source:
        "testWithTypedArrayConstructors(function(TA, makeCtorArg) { var sample = new TA(makeCtorArg([40, 41, 42])); assert.sameValue(sample.length, 3); assert.sameValue(sample[2], 42); }, null, ['passthrough', 'arraylike', 'arraybuffer']);",
    },
    {
      name: "failing element assertion",
      status: "fail",
      source:
        "testWithTypedArrayConstructors(function(TA, makeCtorArg) { var sample = new TA(makeCtorArg([40, 41, 42])); assert.sameValue(sample[2], 43); });",
    },
    {
      name: "failure in one constructor",
      status: "fail",
      source:
        "testWithTypedArrayConstructors(function(TA) { assert(TA !== Int16Array, 'Int16Array'); });",
    },
    {
      name: "passthrough factories visit each constructor once",
      status: "pass",
      source:
        "var count = 0; testWithTypedArrayConstructors(function(TA, makeCtorArg) { assert.sameValue(new TA(makeCtorArg(4)).length, 4); count++; }, null, ['passthrough']); assert.sameValue(count, typedArrayConstructors.length);",
    },
    {
      name: "explicit constructor list",
      status: "pass",
      source:
        "var names = []; testWithTypedArrayConstructors(function(TA) { names.push(TA.name); }, [Uint8Array, Float64Array], ['passthrough']); assert.compareArray(names, ['Uint8Array', 'Float64Array']);",
    },
    {
      name: "float constructor classification",
      status: "pass",
      source:
        "assert(isFloatTypedArrayConstructor(Float32Array)); assert(!isFloatTypedArrayConstructor(Int8Array)); assert.sameValue(floatTypedArrayConstructorPrecision(Float64Array), 'double');",
    },
    {
      name: "unknown argument factory feature",
      status: "fail",
      source: "testWithTypedArrayConstructors(function() {}, null, ['unknown']);",
    },
  ],
  (item) => `typed-array:${item.name}`,
);

if (typedArrayControls.length > 0)
  describe(`Test262 typed array helper contract${shardSuffix()}`, () => {
    for (const control of typedArrayControls) {
      test(control.name, async () => {
        const includes = ["compareArray.js", "testTypedArray.js"];
        if (control.status === "fail")
          expect(() => runUpstream(control.source, "strict", includes)).toThrow();
        else expect(() => runUpstream(control.source, "strict", includes)).not.toThrow();
        const result = await runSource(control.source, { sanitize, includes });
        expect(result, JSON.stringify(result, null, 2)).toMatchObject({ status: control.status });
      });
    }
  });

const asyncControls = shardSelect(
  [
    {
      name: "promise completion",
      status: "pass",
      body: "Promise.resolve(1).then(value => { assert.sameValue(value, 1); $DONE(); });",
    },
    {
      name: "completion error",
      status: "fail",
      body: "Promise.resolve().then(() => { $DONE('failure'); });",
    },
    { name: "missing completion", status: "fail", body: "Promise.resolve().then(() => {});" },
    { name: "duplicate completion", status: "fail", body: "$DONE(); $DONE();" },
    {
      name: "completion marker spoof",
      status: "fail",
      body: "console.log('__scriptc_test262_complete__');",
    },
  ],
  (item) => `async:${item.name}`,
);

if (asyncControls.length > 0)
  describe(`Test262 async host contract${shardSuffix()}`, () => {
    for (const control of asyncControls) {
      test(control.name, async () => {
        const source = `/*---\nflags: [async]\n---*/\n${control.body}`;
        expect(exclusion(source, metadata(source), "strict")).toBeUndefined();
        const result = await runSource(source, { sanitize, asyncTest: true });
        expect(result, JSON.stringify(result, null, 2)).toMatchObject({ status: control.status });
      });
    }
  });
