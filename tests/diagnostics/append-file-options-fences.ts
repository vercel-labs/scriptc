// fs.appendFileSync's three-argument options stance: the lowering opens
// with "a" and lets the runtime create the file with the process umask
// default, so the creation mode, every other disposition flag, the
// creation-flushing write, and an effectful undocumented key each keep a
// NAMED refusal instead of silently appending differently.
import * as fs from "node:fs";

const file = "/tmp/scr-append-options-fences.txt";
fs.appendFileSync(file, "a", { mode: 0o600 });
fs.appendFileSync(file, "b", { flag: "ax" });
fs.appendFileSync(file, "c", { flush: true });
fs.appendFileSync(file, "d", { extra: Number(process.argv.length) });
console.log("unreachable");
