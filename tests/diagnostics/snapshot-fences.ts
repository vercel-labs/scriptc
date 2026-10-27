// t.assert.snapshot and t.assert.fileSnapshot lower with no options and
// with an options object literal whose serializers is an array literal.
// The rest is refused, each with a named diagnostic: options that are not
// an object literal, a serializers list that is not an array literal, and
// a spread serializer.
import { test } from "node:test";

test("snapshots", (t) => {
  t.assert.snapshot({ a: 1 }); // lowers
  t.assert.snapshot(1, { serializers: [(v: number) => `${v}`] }); // lowers
  t.assert.fileSnapshot("text", "out.txt"); // lowers

  const options = { serializers: [(v: unknown) => String(v)] };
  t.assert.snapshot(1, options); // options that are not an object literal

  const serializers = [(v: unknown) => String(v)];
  t.assert.snapshot(1, { serializers }); // a serializers list that is not an array literal
  t.assert.fileSnapshot(1, "out.txt", { serializers: [...serializers] }); // a spread serializer
});
