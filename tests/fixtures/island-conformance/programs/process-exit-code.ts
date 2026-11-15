import * as state from "process-reader";

console.log(state.exitCode(), process.exitCode);
process.exitCode = 3;
console.log(state.exitCode(), process.exitCode);
state.setExitCode(4);
console.log(state.exitCode(), process.exitCode);
process.exitCode = 5;
console.log(state.exitCode(), process.exitCode);
