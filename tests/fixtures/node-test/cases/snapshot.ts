// @exit: 1
// t.assert.snapshot and t.assert.fileSnapshot in compare mode, against the
// snapshot.ts.snapshot file `node --test-update-snapshots` wrote (then
// edited so that one snapshot differs and one is missing). Values serialize
// with JSON.stringify(value, null, 2) unless options.serializers replace
// it; each test numbers its snapshots under its full name; a differing
// snapshot fails as assert.strictEqual does, and missing snapshots and
// files and throwing serializers throw ERR_INVALID_STATE.
import { describe, test } from "node:test";

describe("values", () => {
  test("records and arrays", (t) => {
    t.assert.snapshot({ zeta: 1, alpha: [1, "two", { b: true, a: null }] });
    t.assert.snapshot([{ id: 3, name: "n" }]);
  });
  test("strings", (t) => {
    t.assert.snapshot("plain");
    t.assert.snapshot("tick ` dollar ${x} backslash \\ newline \n tab \t");
    t.assert.snapshot("unicode é 漢 😀");
  });
  test("scalars", (t) => {
    t.assert.snapshot(42);
    t.assert.snapshot(-0.5);
    t.assert.snapshot(true);
    t.assert.snapshot(null);
    t.assert.snapshot(undefined);
  });
});

test("name with `backticks` and ${braces}", (t) => {
  t.assert.snapshot({ ok: true });
});

describe("serializers", () => {
  test("run in order", (t) => {
    t.assert.snapshot({ n: 5 }, { serializers: [(v: { n: number }) => v.n * 2, (v: number) => `n is ${v}`] });
    t.assert.snapshot("x", { serializers: [(v: string) => v.toUpperCase()] });
    t.assert.snapshot(7, { serializers: [(v: number) => v + 1] });
  });
  test("a throwing serializer", (t) => {
    t.assert.snapshot(1, {
      serializers: [
        () => {
          throw new Error("no");
        },
      ],
    });
  });
  test("a circular value", (t) => {
    const loop: { self?: unknown } = {};
    loop.self = loop;
    t.assert.snapshot(loop);
  });
});

test("counts toward the plan", { plan: 2 }, (t) => {
  t.assert.snapshot(1);
  t.assert.ok(true);
});

test("differs from the stored snapshot", (t) => {
  t.assert.snapshot({ count: 2 });
});

test("missing from the snapshot file", (t) => {
  t.assert.snapshot("new");
});

test("file snapshots", (t) => {
  t.assert.fileSnapshot({ f: 1, list: ["a"] }, "tests/fixtures/node-test/cases/snapshot-files/value.json");
  t.assert.fileSnapshot("text", "tests/fixtures/node-test/cases/snapshot-files/missing.txt");
});
