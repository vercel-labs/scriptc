// @normalize-pid
// spawnSync with the shell enabled and a sparse argument list. Node builds
// the line with `args.join(" ")`, which reads a hole as the empty string:
// the hole leaves its separator in the line and nothing else. The list is
// non-empty by its length, so DEP0190 is reported once, as for any list.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

const shelled: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: true };

// A hole between two arguments: two separators inside the quotes.
const middle: string[] = [];
middle[0] = '"x';
middle[2] = 'y"';
console.log(middle.length, 1 in middle);
console.log("middle:", JSON.stringify(spawnSync("echo", middle, shelled).stdout));

// Leading and trailing holes.
const edges: string[] = [];
edges[1] = "inner";
edges.length = 4;
console.log("edges:", JSON.stringify(spawnSync("echo '['", edges, shelled).stdout));

// Nothing but holes: the line is the command and its separators.
const holes: string[] = [];
holes.length = 3;
console.log("holes:", JSON.stringify(spawnSync("echo solo", holes, shelled).stdout));

// An inline `shell: true` takes the same line.
console.log(
  "literal:",
  JSON.stringify(spawnSync("echo", middle, { encoding: "utf8", shell: true }).stdout),
);

// The shell decided at run time.
const run = (shell: boolean): string => {
  const options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell };
  return spawnSync("echo", shell ? middle : ["dense"], options).stdout;
};
console.log("runtime:", JSON.stringify(run(true)), JSON.stringify(run(false)));
