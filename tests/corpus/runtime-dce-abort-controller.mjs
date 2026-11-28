// AbortController and AbortSignal in a program that never touches node:http:
// the class, its controller and its signal stay linked and behave as Node 24
// does, including construction from the global object's computed key in both
// the literal-expression and the runtime-computed forms (the path
// runtime-features selects through dyn.globalConstructor). This is the program
// that pins T1-1's narrowed abortSignal fact: only http's message reads the
// abort unit through a dynamic key now. A global object STORED in a variable
// and read later is a separate (refused) path, SC2020; this program does not
// use it.
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
console.log("second: aborted=" + second.signal.aborted + " reason=" + second.signal.reason.message);

// The global object's computed key, in both forms the lowering accepts.
const inline = new (globalThis["Abort" + "Controller"])();
inline.abort();
console.log("inline: aborted=" + inline.signal.aborted);
const name = "Abort" + "Controller";
const computed = new (globalThis[name])();
computed.abort();
console.log("computed: aborted=" + computed.signal.aborted);
