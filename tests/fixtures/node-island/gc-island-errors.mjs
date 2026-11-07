// Island errors the program catches and drops (node-island-gc.test.ts):
// every iteration catches an error island code threw, reads it, and keeps
// nothing. The error's native view is pinned to its island handle and, once
// read as a dynamic value, is in the runtime's error-view cache as well;
// both must let go when the program does. Usage: gc-island-errors <n>
import { requireModule } from "@scriptc/node";

const lib = requireModule("./gc-island-errors.cjs");
const n = Number(process.argv[2] ?? "1000");
let checks = 0;
for (let i = 0; i < n; i++) {
  try {
    lib.fail(i);
  } catch (e) {
    if (e instanceof RangeError && e.message === "island " + i) checks++;
  }
}
console.log("iterations", n, "checks", checks);
console.error(`peak rss ${lib.maxRss()} KiB`);
