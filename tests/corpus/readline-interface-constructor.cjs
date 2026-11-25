// Node does not export readline.InterfaceConstructor (the documented class
// heading is internal): a program cannot name it, so this reads the namespace
// dynamically and pins the absence.
const readline = require("node:readline");

console.log(typeof readline.InterfaceConstructor, readline.InterfaceConstructor === undefined);
console.log(Object.keys(readline).includes("InterfaceConstructor"));
console.log(typeof readline.Interface);
