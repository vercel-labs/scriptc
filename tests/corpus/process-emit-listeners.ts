// process.emit dispatches synchronously to the listeners process.on
// registered, with exactly the arguments the emit carried: the uncaught
// channel, the warning channel (including a value that is not an Error), the
// rejection channels, and the lifecycle registries. A `once` wrapper leaves
// the list before its call, a regular listener stays registered for the next
// emit and for the process's own exit, and off removes by identity.
const uncaught: any = (err: unknown) => console.log("ue", (err as Error).message);
process.on("uncaughtException", uncaught);
console.log(process.emit("uncaughtException", new Error("boom")));
console.log(process.emit("uncaughtException", new Error("again")));
process.off("uncaughtException", uncaught);
console.log(process.emit("uncaughtException", new Error("after off")));

const warnings: any[] = [];
const onWarning: any = (warning: unknown) => warnings.push(warning);
process.on("warning", onWarning);
console.log(process.emit("warning", "plain text"));
console.log(process.emit("warning"));
process.once("exit", () => console.log("warnings", warnings.length, typeof warnings[0]));

const rejections: any[] = [];
const onRejection: any = (reason: unknown, promise: unknown) => rejections.push(reason);
process.on("unhandledRejection", onRejection);
console.log(process.emit("unhandledRejection", "why", 1));

process.on("beforeExit", (code) => console.log("bx", code));
console.log(process.emit("beforeExit", 5));
process.on("exit", (code) => console.log("exit", code));
console.log(process.emit("exit", 7));
console.log(process.emit("exit", 8));
console.log("end", rejections.length);
