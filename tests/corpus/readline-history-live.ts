// The 'history' listener receives the interface's history array itself: the
// object `rl.history` answers, the same array on every event, and a mutation
// made inside the listener changes what recall walks and what the later
// history holds. A secret entry removed from the array is never remembered.
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

const input = new PassThrough();
const rl = createInterface({ input, terminal: true, history: ["kept"], historySize: 6 });
let first: string[] | undefined;
rl.on("history", (history: string[]) => {
  if (first === undefined) first = history;
  console.log("history", JSON.stringify(history), "same", history === rl.history, "first", first === history);
  if (history[0] === "secret") history.shift();
});
rl.on("line", (line: string) =>
  console.log("line", JSON.stringify(line), JSON.stringify(rl.history), "same", first === rl.history),
);
rl.on("close", () => console.log("close", JSON.stringify(rl.history), "same", first === rl.history));
input.write("public\r");
input.write("secret\r");
input.write("\x1b[A");
console.log("recall", JSON.stringify(rl.line));
input.write("\r");
input.write("tail\r");
input.end("partial");
