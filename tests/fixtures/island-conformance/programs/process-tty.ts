import * as state from "process-reader";

console.log(state.isTTY().join(","), process.stdout.isTTY === true, process.stderr.isTTY === true);
console.log(state.columns() === process.stdout.columns);
