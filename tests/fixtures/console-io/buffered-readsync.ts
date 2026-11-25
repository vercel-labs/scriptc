import { readSync } from "node:fs";
process.stdout.write("prompt> ");
const buf = Buffer.alloc(64);
const n = readSync(0, buf, 0, 64, null);
process.stdout.write(`got:${buf.toString("utf8", 0, n).trim()}\n`);
