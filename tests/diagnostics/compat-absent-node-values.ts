// Node values scriptc does not provide, one use each: every statement
// below is refused. The compatibility ledger cites this program for
// marking the rows a verified absence. A JavaScript source reads the
// functions among them as functions that refuse when they are called, and
// is refused the other values by name where it reads them.
import { snapshot } from "node:test";

// test: snapshot configuration.
snapshot.setDefaultSnapshotSerializers([]);
snapshot.setResolveSnapshotPath((path: string) => `${path}.snapshot`);

// process: the entry module object, finalization callbacks and abort.
console.log(process.mainModule);
process.finalization.registerBeforeExit({ n: 1 }, () => {});
process.finalization.unregister({ n: 1 });
process.abort();
// End with a nonblank context line so diagnostic snapshots carry no trailing whitespace.
