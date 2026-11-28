// @normalize-pid
// Posting a port its own entangled other end answers true and reports Node's
// warning on the next tick, so the process 'warning' listeners run after
// postMessage returned. A clone that fails transfers nothing, leaves the
// channel intact and reports no warning.
import { MessageChannel } from "node:worker_threads";

const raw = (value) => /** @type {any} */ (value);
const events = [];
process.on("warning", (warning) => events.push("warning:" + warning.message));
const first = new MessageChannel();
events.push("before");
const answer = raw(first.port1).postMessage("x", [first.port2]);
events.push("after:" + answer);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log(events.join(" | "));
const second = new MessageChannel();
let warnings = 0;
process.on("warning", () => {
  warnings++;
});
try {
  raw(second.port1).postMessage({ f: () => 1 }, [second.port2]);
} catch (error) {
  console.log("clone failed", error.name);
}
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("warnings after failed clone", warnings);
second.port1.close();
const sequence = [];
process.on("warning", (warning) => sequence.push("w:" + warning.message));
const one = new MessageChannel();
one.port1.postMessage("1", [one.port2]);
process.nextTick(() => sequence.push("tick"));
const two = new MessageChannel();
two.port1.postMessage("2", [two.port2]);
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("sequence", sequence.join(" | "));
// A replacement installed at the call sees the warning there, with the
// arguments the call passes; one installed afterwards does not.
const calls = [];
process.emitWarning = (message, type) => calls.push(String(type) + ":" + String(message));
const replaced = new MessageChannel();
replaced.port1.postMessage("r", [replaced.port2]);
process.emitWarning = () => calls.push("replacement-after");
await new Promise((resolve) => setTimeout(resolve, 20));
console.log("calls", JSON.stringify(calls));
