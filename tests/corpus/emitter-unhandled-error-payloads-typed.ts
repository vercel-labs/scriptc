// emit('error', payload) from typed code with a payload that is not an
// Error: Node's ERR_UNHANDLED_ERROR when nothing listens, the payload as
// given otherwise.
import { EventEmitter, errorMonitor } from "node:events";

interface UnhandledError extends Error {
  code?: string;
  context?: unknown;
}

const e = new EventEmitter();
const record = { id: 3, tags: ["a", "b"] };
const attempts: Array<() => boolean> = [
  () => e.emit("error", "plain string"),
  () => e.emit("error", 12.5),
  () => e.emit("error", record),
  () => e.emit("error", [1, 2, 3]),
  () => e.emit("error", null),
  () => e.emit("error"),
  () => e.emit("error", "a", "b"),
];
for (const attempt of attempts) {
  try {
    attempt();
    console.log("no throw");
  } catch (caught) {
    const err = caught as UnhandledError;
    console.log(err.code, err.message, err.context === record, typeof err.context);
  }
}

let monitored = 0;
e.on(errorMonitor, () => {
  monitored++;
});
try {
  e.emit("error", "watched");
} catch (caught) {
  console.log((caught as UnhandledError).code, monitored);
}

const handled = new EventEmitter();
handled.on("error", (err: unknown) => console.log("got", err instanceof Error ? `Error: ${err.message}` : err));
console.log(handled.emit("error", 7));
console.log(handled.emit("error", { reason: "closed" }));
console.log(handled.emit("error", new Error("real")));
