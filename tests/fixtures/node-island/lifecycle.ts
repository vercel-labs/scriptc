// Loading Node on first use (tests/harness/node-island.test.ts): the
// argument selects whether and how the program calls into Node.
import { readFileSync } from "node:fs";
import { callSync } from "@scriptc/node";

const mode = process.argv[2] ?? "call";
// Whether libnode is mapped into the process, from /proc/self/maps; other
// platforms report "unknown".
const mapped = (): boolean | string =>
  process.platform === "linux"
    ? readFileSync("/proc/self/maps", "utf8").includes("libnode")
    : "unknown";
console.log("mapped before", mapped());
if (mode !== "never") {
  console.log(callSync<number>("./helper.cjs", "answer"));
  console.log("mapped after", mapped());
}
if (mode === "exit") process.exit(5);
if (mode === "fork") console.log(callSync<string>("./helper.cjs", "forkSelf"));
if (mode === "unreadable") {
  try {
    callSync("./helper.cjs", "unreadable");
  } catch (error) {
    console.log("caught", error instanceof Error, JSON.stringify((error as Error).message));
  }
}
console.log("done");
