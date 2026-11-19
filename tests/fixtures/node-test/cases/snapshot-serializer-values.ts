// Serializer lists carried in variables work for t.assert.snapshot and
// snapshot.setDefaultSnapshotSerializers, as Node's do: the list is an
// array-typed value whose entries are called in order, and the default list
// backs every snapshot assertion without a list of its own.
import { snapshot, test } from "node:test";

const quote = (value: unknown): string => JSON.stringify(value).replaceAll('"', "'");
const serializers = [
  (value: unknown) => JSON.stringify(value),
  (text: string) => text.replaceAll('"', "'"),
];
const defaults = [quote];
const pretty = [(value: unknown) => JSON.stringify(value, null, 2)];

snapshot.setDefaultSnapshotSerializers(defaults);

test("variable serializers", (t) => {
  t.assert.snapshot({ a: 1 }, { serializers });
  t.assert.snapshot([1, 2], { serializers });
});

test("fileSnapshot with a variable list", (t) => {
  t.assert.fileSnapshot(
    { f: 1, list: ["a"] },
    "tests/fixtures/node-test/cases/snapshot-files/value.json",
    { serializers: pretty },
  );
});

test("defaults from a variable", (t) => {
  t.assert.snapshot({ b: 2 });
});
