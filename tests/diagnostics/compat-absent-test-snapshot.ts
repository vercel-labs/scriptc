// node:test's snapshot path resolver has no lowering: snapshot.setDefaultSnapshotSerializers
// compiles, this member is refused.
import { snapshot } from "node:test";

snapshot.setResolveSnapshotPath((path: string) => `${path}.snapshot`);
// End with a nonblank context line so diagnostic snapshots carry no trailing whitespace.
