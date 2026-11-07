import * as state from "process-reader";

console.log(state.cwd() === process.cwd());
process.chdir("..");
console.log(state.cwd() === process.cwd(), process.cwd().endsWith("programs"));
state.chdir("programs");
console.log(state.cwd() === process.cwd(), process.cwd().endsWith("programs"));
process.chdir("..");
process.chdir("programs");
console.log(state.cwd() === process.cwd(), state.cwd().endsWith("programs"));
