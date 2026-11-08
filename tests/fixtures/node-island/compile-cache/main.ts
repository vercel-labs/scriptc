// What a launch does with Node's compile cache (tests/harness/
// node-island-compile-cache.test.ts): `none` never starts Node; the other
// modes load the island package and end in the way their name says.
import { cacheDirectory, exitFromIsland, later, sum } from "cache-pkg";

const mode = process.argv[2] ?? "return";
if (mode === "none") {
  console.log("no island");
} else {
  console.log("sum", sum(1, 2));
  if (mode === "directory") console.log(cacheDirectory());
  if (mode === "exit") process.exit(0);
  if (mode === "island-exit") exitFromIsland(0);
  if (mode === "later") console.log(later());
  if (mode === "stay") setInterval(() => {}, 1000);
}
