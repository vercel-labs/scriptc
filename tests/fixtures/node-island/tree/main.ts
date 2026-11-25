// The island module tree on disk (tests/harness/node-island.test.ts): one
// call into a module whose requires span nested directories, so the tree
// the executable installs has several files and levels.
import { callSync } from "@scriptc/node";

console.log(callSync<number>("./parts/index.cjs", "sum"));
