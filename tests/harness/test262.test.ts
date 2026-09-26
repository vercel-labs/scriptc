import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { runSource } from "../test262/execute.js";
import { exclusion, matchesExpectation, metadata, pin, vendorRoot, verifyVendor } from "../test262/support.mjs";
import { shardSelect, shardSuffix } from "./shard.js";

const sanitize = process.env.SCRIPTC_SAN === "1";
const upstreamHarness = ["assert.js", "sta.js"]
  .map((name) => readFileSync(join(vendorRoot, "harness", name), "utf8")).join("\n");

function runUpstream(source: string): void {
  const context = createContext({});
  runInContext(upstreamHarness, context, { timeout: 5000 });
  runInContext(`"use strict";\n${source}`, context, { timeout: 5000 });
}

test("Test262 regression inputs retain their pinned upstream bytes", () => {
  verifyVendor();
});

const profileCases = shardSelect<string>(pin.tests, (path) => `${path}#strict`);
// The initial profile is small enough that a valid shard can own no cases.
// Vitest rejects an empty describe block, so register this suite only when
// this shard actually owns a program. The host checks below still run.
if (profileCases.length > 0) describe(`Test262 static strict profile${shardSuffix()}`, () => {
  for (const path of profileCases) {
    test(path, async () => {
      const source = readFileSync(join(vendorRoot, path), "utf8");
      expect(exclusion(source, metadata(source, path), "strict")).toBeUndefined();
      // Independently check the unchanged test with the original global-script
      // harness. Node is a host sanity check, not the conformance oracle.
      runUpstream(source);
      const result = await runSource(source, { sanitize });
      expect(matchesExpectation(`${path}#strict`, result), JSON.stringify(result, null, 2)).toBe(true);
    });
  }
});

const controls = [
  { name: "scalar SameValue", status: "pass", source: `
assert(true);
assert.sameValue(NaN, NaN);
assert.notSameValue(0, -0);
assert.notSameValue(null, undefined);
assert.sameValue(undefined, undefined);
assert.sameValue(null, null);
assert.notSameValue(1, "1");
` },
  { name: "wrong SameValue", status: "fail", source: "assert.sameValue(1, 2);" },
  { name: "signed zero mismatch", status: "fail", source: "assert.sameValue(0, -0);" },
  { name: "NaN is the same value", status: "fail", source: "assert.notSameValue(NaN, NaN);" },
  { name: "scalar array contents", status: "pass", source: "assert.compareArray([1, NaN, -0, undefined], [1, NaN, -0, undefined]);" },
  { name: "array length mismatch", status: "fail", source: "assert.compareArray([1], [1, 2]);" },
  { name: "array element mismatch", status: "fail", source: "assert.compareArray([1, 2], [1, 3]);" },
  { name: "array signed zero mismatch", status: "fail", source: "assert.compareArray([0], [-0]);" },
  { name: "assert requires true, not truthiness", status: "fail", source: "assert(1);" },
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

  for (const value of shardSelect(["{}", "[1]", "function () {}"], (value) => `reference:${value}`)) {
    test(`reference assertions are explicitly refused: ${value}`, async () => {
      const source = `const value = ${value}; try { assert.sameValue(value, value); } catch { }`;
      expect(() => runUpstream(source)).not.toThrow();
      const result = await runSource(source, { sanitize });
      expect(result, JSON.stringify(result)).toMatchObject({ status: "harness-refusal", reason: "reference-assertion" });
    });
  }

  test("array element identity assertions are refused", async () => {
    const source = "const value = {}; try { assert.compareArray([value], [value]); } catch { }";
    expect(() => runUpstream(source)).not.toThrow();
    const result = await runSource(source, { sanitize });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "harness-refusal", reason: "reference-assertion" });
  });

  test("array-like objects remain outside the adapter", async () => {
    const source = "try { assert.compareArray({ 0: 1, length: 1 }, [1]); } catch { }";
    expect(() => runUpstream(source)).not.toThrow();
    const result = await runSource(source, { sanitize });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "harness-refusal", reason: "reference-assertion" });
  });
});
