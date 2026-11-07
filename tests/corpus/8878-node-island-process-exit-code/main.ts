// @requires-libnode
// @exit: 6
// process.exitCode is one value for the program and the package it runs in
// a Node island: each side reads what the other assigned, a code the
// program assigned before Node started is there when it starts, and the
// process exits with the last one.
import { exitCode, onExit, setExitCode, tryExitCode } from "process-state";

process.exitCode = 2;
// The first island call starts Node: it starts with the program's code.
console.log(exitCode(), process.exitCode);
process.exitCode = 3;
console.log(exitCode(), process.exitCode);
setExitCode(4);
console.log(exitCode(), process.exitCode);
process.exitCode = 5;
console.log(exitCode(), process.exitCode);
// Cleared by island code: undefined on both sides.
setExitCode(undefined);
console.log(exitCode(), process.exitCode);
// A code Node refuses is refused, and nothing changes.
console.log(tryExitCode(1.5), exitCode(), process.exitCode);
setExitCode(7);
onExit((line) => console.log(line));
process.on("exit", (code) => console.log(`program exit listener ${code} ${process.exitCode}`));
process.exitCode = 6;
