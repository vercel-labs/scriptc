import { snapshot, test } from "node:test";

const log: string[] = [];

test("resolver runs before the serializer", (t) => {
  snapshot.setResolveSnapshotPath((_path: string): string => {
    log.push("resolver");
    throw new Error("resolver failed");
  });
  let caught = "";
  try {
    t.assert.snapshot({
      get value() {
        log.push("serializer");
        return 1;
      },
    });
  } catch (error) {
    caught = (error as Error).message;
  }
  t.diagnostic(`${log.join(",")} | ${caught}`);
});
