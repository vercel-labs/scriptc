// snapshot.setResolveSnapshotPath: the resolver receives the test file's
// path and names the snapshot file. It runs once per file, on the first
// snapshot assertion, and the snapshots of every test in the program share
// the file it names.
import assert from "node:assert";
import { snapshot, test } from "node:test";

const calls: string[] = [];
snapshot.setResolveSnapshotPath((path: string) => {
  calls.push(path);
  return path.replace(/\.ts$/, ".resolved.snapshot");
});

test("first", (t) => {
  t.assert.snapshot({ id: 1 });
});

test("second", (t) => {
  t.assert.snapshot("two");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]!.endsWith("snapshot-resolve-path.ts"), true);
  t.diagnostic("resolved once");
});

test("replacing the resolver keeps the resolved file", (t) => {
  snapshot.setResolveSnapshotPath((path: string) => {
    calls.push("second");
    return path;
  });
  t.assert.snapshot("three");
  assert.strictEqual(calls.length, 1);
});
