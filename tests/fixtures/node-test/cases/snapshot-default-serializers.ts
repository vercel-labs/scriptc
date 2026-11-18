// snapshot.setDefaultSnapshotSerializers: every snapshot assertion that
// passes no serializers of its own runs the value through the module's list,
// in order, and through the assertion's own list instead when it has one.
// (Node validates the list as an array of functions before storing it; the
// lowering takes an array literal or an array-typed value of functions, so
// a bad list is a compile error here.)
import { test } from "node:test";
import { snapshot } from "node:test";

test("default list applies", (t) => {
  snapshot.setDefaultSnapshotSerializers([(value: unknown) => `custom:${String(value)}`]);
  t.assert.snapshot({ a: 1 });
  t.assert.snapshot([1, 2]);
});

test("assertion list wins over the default", (t) => {
  t.assert.snapshot("value", { serializers: [(value: string) => `own:${value}`] });
});

test("default list chains in order", (t) => {
  snapshot.setDefaultSnapshotSerializers([
    (value: unknown) => `[${String(value)}]`,
    (value: unknown) => String(value).toUpperCase(),
  ]);
  t.assert.snapshot("abc");
});
