// AbortController and AbortSignal in a program that never touches node:http:
// the class, its controller and its signal stay linked and behave as Node 24
// does, including a controller taken through globalThis's computed key (the
// path runtime-features selects through dyn.globalConstructor). This is the
// program that pins T1-1's narrowed abortSignal fact: only http's message
// reads the abort unit through a dynamic key now.
const controller = new AbortController();
const signal = controller.signal;
console.log("initial: " + signal.aborted + " " + String(signal.reason));
let events = 0;
signal.addEventListener("abort", () => {
  events++;
  console.log("abort event: aborted=" + signal.aborted);
});
controller.abort();
console.log("after: aborted=" + signal.aborted + " events=" + events);

// A second controller with an explicit reason: abort() keeps the reason
// readable on the signal.
const second = new AbortController();
second.abort(new Error("stopped"));
console.log("second: aborted=" + second.signal.aborted + " reason=" + (second.signal.reason as Error).message);
