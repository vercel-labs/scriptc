// A default serializer that installs a new default list while it runs: the
// assertion in flight keeps walking the list it started with, and the next
// assertion runs through the replacement, as in Node.
import { snapshot, test } from "node:test";

test("reentrant replacement", (t) => {
  let replaced = false;
  snapshot.setDefaultSnapshotSerializers([
    (value: unknown) => {
      if (!replaced) {
        replaced = true;
        snapshot.setDefaultSnapshotSerializers([(next: unknown) => `second:${String(next)}`]);
      }
      return `first:${String(value)}`;
    },
  ]);
  t.assert.snapshot("a");
  t.assert.snapshot("b");
});
