// --stdout-buffering: a prompt shorter than the buffer must be published
// before the program blocks reading stdin, or a parent that waits for the
// prompt before answering deadlocks.
import { readFileSync } from "node:fs";

process.stdout.write("prompt> ");
const input = readFileSync(0, "utf8");
process.stdout.write(`got:${input.trim()}\n`);
