// spawnSync's stdio slot typed as a union of the supported modes: the slot
// expression is evaluated once, as the options object's evaluation does, and
// the mode the call uses is the one the input decision sees.
import { spawnSync } from "node:child_process";

let reads = 0;
const stdinSlot = (): "pipe" | "ignore" => {
  reads += 1;
  return reads === 1 ? "pipe" : "ignore";
};

// The slot reads "pipe" first, so the input is piped; a second read would
// answer "ignore" and drop it.
const piped = spawnSync("/bin/cat", [], {
  stdio: [stdinSlot(), "pipe", "pipe"],
  input: "kept\n",
  encoding: "utf8",
});
console.log(`stdin slot: ${reads} ${JSON.stringify(piped.stdout)} ${piped.status}`);

// The same for a call that answers "ignore": the input is dropped and the
// expression still runs once.
reads = 0;
const ignoreSlot = (): "pipe" | "ignore" => {
  reads += 1;
  return "ignore";
};
const ignored = spawnSync("/bin/cat", [], {
  stdio: [ignoreSlot(), "pipe", "pipe"],
  input: "dropped\n",
  encoding: "utf8",
});
console.log(`ignore slot: ${reads} ${JSON.stringify(ignored.stdout)} ${ignored.status}`);
