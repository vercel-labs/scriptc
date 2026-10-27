import * as vm from "node:vm";

export type Label = string;
console.log("uses-vm evaluated", vm.runInThisContext("1 + 1"));
