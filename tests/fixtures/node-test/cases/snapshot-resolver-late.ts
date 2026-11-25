// A resolver installed after a snapshot already resolved the default file
// does not redirect the assertions that follow: Node keeps the file it
// resolved, and the new resolver is never called.
import assert from "node:assert/strict";
import { snapshot, test } from "node:test";

const calls: string[] = [];

test("default file first", (t) => {
  t.assert.snapshot("one");
});

test("a later resolver keeps the default file", (t) => {
  snapshot.setResolveSnapshotPath((path: string): string => {
    calls.push(path);
    return path.replace(/\.ts$/, ".resolved.snapshot");
  });
  t.assert.snapshot("two");
  assert.deepStrictEqual(calls, []);
});
