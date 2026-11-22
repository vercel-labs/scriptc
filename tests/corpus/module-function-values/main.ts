/* node:module's compiler-folded functions as VALUES. isBuiltin answers at
 * run time over the same rule the literal fold uses (node: prefix, the four
 * prefix-only ids), syncBuiltinESMExports calls the same refresh a statement
 * call performs, and both keep Node's name and length, hold identity across
 * spellings (named import, namespace member, boxed namespace), and answer
 * through the boxed namespace as they do in Node. */
import * as nodeModule from "node:module";
import { isBuiltin, syncBuiltinESMExports } from "node:module";
const boxed: any = nodeModule;
const isB = isBuiltin;
console.log("isBuiltin", typeof isB, isB.name, isB.length);
console.log("call", isB("fs"), isB("node:fs"), isB("node:node:fs"), isB(""), isB("test"), isB("node:test"), isB("sea"), isB("node:sea"));
console.log("identity", isB === isBuiltin, isB === boxed.isBuiltin, typeof boxed.isBuiltin);
console.log("boxed call", boxed.isBuiltin("node:path"), boxed.isBuiltin("path/posix"));
const sync = syncBuiltinESMExports;
console.log("sync", typeof sync, sync.name, sync.length);
sync();
console.log("boxedSync", typeof boxed.syncBuiltinESMExports);
boxed.syncBuiltinESMExports();
console.log("done");

// The runtime rule for a held isBuiltin: a non-string answers false (Node's
// Set membership, not an argument-type throw), extra arguments are ignored,
// .call/.apply reach the same function, and a computed name takes the same
// node: prefix rule. The sync function ignores arguments and answers
// undefined.
function tryIt(label: string, fn: () => unknown) {
  try {
    console.log(label, String(fn()));
  } catch (error: any) {
    console.log(label, "threw", error.name, JSON.stringify(error.message));
  }
}
function probeName(name: string) {
  tryIt("computed " + name, () => isBuiltin(name));
  tryIt("upper " + name, () => isBuiltin(name.toUpperCase()));
}
probeName("node:fs");
probeName("test");
tryIt("call", () => isBuiltin.call(null, "fs"));
tryIt("apply", () => isBuiltin.apply(null, ["test"]));
tryIt("extra args", () => (isBuiltin as any)("fs", 1, 2));
tryIt("number arg", () => (isBuiltin as any)(42));
tryIt("sync extra", () => (syncBuiltinESMExports as any)(1));
tryIt("sync no args", () => (syncBuiltinESMExports as any)());
