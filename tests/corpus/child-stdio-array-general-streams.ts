// child.stdio in a program that needs the general stream representation (it
// moves a file stream into the child's stdin): the same array, whose piped
// slots are the bridged runtime streams child.stdin/stdout/stderr answer.
import { spawn } from "node:child_process";
import { createReadStream, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-stdio-array-"));
const input = join(dir, "input.txt");
writeFileSync(input, "through cat\n");

const child = spawn("cat", [], { stdio: ["pipe", "pipe", "inherit"] });
const stdio = child.stdio;
console.log("length", stdio.length, "stable", stdio === child.stdio);
console.log(
  "slots",
  stdio[0] === child.stdin,
  stdio[1] === child.stdout,
  stdio[2] === child.stderr,
);
console.log("nulls", stdio[0] === null, stdio[1] === null, stdio[2] === null);
if (child.stdin) createReadStream(input).pipe(child.stdin);
child.stdout?.pipe(process.stdout);
console.log(
  "exit",
  await new Promise((resolve) => child.on("close", (code) => resolve(code))),
);
