// Long-lived exports (node-island-gc.test.ts): the island keeps one native
// callback per iteration for the rest of the run, so no collection frees
// any of them. Usage: gc-held <n>
import { requireModule } from "@scriptc/node";

const lib = requireModule("./gc-held.cjs");
const n = Number(process.argv[2] ?? "1000");
for (let i = 0; i < n; i++) {
  const j = i;
  lib.keep(() => j);
}
console.log("kept", n, "sum", lib.callKept());
