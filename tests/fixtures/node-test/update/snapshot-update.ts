// Run with --test-update-snapshots (before the program arguments): the
// snapshot assertions record their values, the run writes
// snapshot-update.ts.snapshot with sorted keys and out/value.json, and the
// flag is in process.execArgv instead of process.argv.
import { describe, test } from "node:test";

console.log(JSON.stringify(process.argv.slice(2)), JSON.stringify(process.execArgv));

describe("suite", () => {
  test("values", (t) => {
    t.assert.snapshot({ b: 1, a: "x`${y}\\z\n" });
    t.assert.snapshot([1, 2]);
    t.assert.snapshot("é 😀 \u0001");
  });
  test("serializers", (t) => {
    t.assert.snapshot(3, { serializers: [(v: number) => v * 2] });
  });
});

test("zz last", (t) => {
  t.assert.snapshot(undefined);
});

test("aa `first` ${x}", (t) => {
  t.assert.snapshot(null);
  t.assert.fileSnapshot({ f: [1] }, "out/value.json");
});
