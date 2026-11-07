// @requires-libnode
// console passed into a Node island is the island's own console, so
// island code sees `logger === console` and prints through it; a console
// method passed into an island is called back with the island's arguments
// and formats them as Node's method does.
import { useLogger, callFn, isConsole, describe, useUntyped } from "logkit";

console.log(isConsole(console), isConsole({}), describe(console));
console.log(useLogger(console));
console.log(useUntyped(console));
callFn(console.log);
callFn(console.error);
const { warn } = console;
callFn(warn);
useLogger({
  log: (...args) => console.log("program logger", ...args),
  error: (...args) => console.error("program logger", ...args),
});
console.log("done");
