// spawnSync's stdio slot typed as a union of the supported modes: the slot
// expression is evaluated once, in the options object's member order, and the
// mode the call uses is the one the input decision sees.
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

// Members evaluate in source order, so a stdio slot written before `input`
// reads its mode before the input expression runs. The mode below starts
// from a call, so it keeps its union type and the slot resolves at the call;
// the input expression then changes it. The slot has already answered
// "pipe", so the input is piped.
const pickMode = (m: "pipe" | "ignore"): "pipe" | "ignore" => m;
let mode: "pipe" | "ignore" = pickMode("pipe");
const takeInput = (next: "pipe" | "ignore"): string => {
  mode = next;
  return "kept\n";
};
const stdioFirst = spawnSync("/bin/cat", [], {
  stdio: [mode, "pipe", "pipe"],
  input: takeInput("ignore"),
  encoding: "utf8",
});
console.log(`stdio first: ${JSON.stringify(stdioFirst.stdout)} ${stdioFirst.status}`);

// The same members in the other order: the input expression writes the mode
// and the slot, evaluated after it, answers that value.
mode = pickMode("ignore");
const inputFirst = spawnSync("/bin/cat", [], {
  input: takeInput("pipe"),
  stdio: [mode, "pipe", "pipe"],
  encoding: "utf8",
});
console.log(`input first: ${JSON.stringify(inputFirst.stdout)} ${inputFirst.status}`);
