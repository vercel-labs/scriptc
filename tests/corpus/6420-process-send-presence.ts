// process.send exists only with an IPC channel: presence checks in every
// truthiness position, typeof, and guarded calls.
const viaIpc = Boolean(process.send);
console.log("Boolean", viaIpc);
console.log("not", !process.send, !!process.disconnect);
console.log("typeof", typeof process.send, typeof process.disconnect);
console.log("ternary", process.send ? "ipc" : "stdout");
if (process.send) {
  process.send({ kind: "log", line: "never" });
} else {
  console.log("if: no channel");
}
let polls = 0;
while (process.send && polls < 3) polls++;
console.log("while", polls);
process.send && process.send({ unused: true });
const sink = !process.send || !process.disconnect ? "console" : "ipc";
console.log("or", sink);
console.log("optional", process.send?.({ value: 1 }));
try {
  process.send!({ value: 2 });
} catch (e) {
  console.log("direct", (e as Error).name, (e as Error).message);
}
