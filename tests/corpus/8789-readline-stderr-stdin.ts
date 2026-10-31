// createInterface over process.stdin with process.stderr as its output in a
// program that uses no other node:stream surface: the interface's stream
// output needs the general node streams representation, so the lowering
// re-runs in that mode before the fd-backed writable exists. The prompt
// reaches descriptor 2 and close() ends the interface.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stderr });
rl.prompt();
rl.close();
console.log("closed");
