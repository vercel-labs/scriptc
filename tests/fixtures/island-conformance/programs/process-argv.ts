import * as state from "process-reader";

console.log(JSON.stringify(state.argv()), state.argvLength() === process.argv.length);
