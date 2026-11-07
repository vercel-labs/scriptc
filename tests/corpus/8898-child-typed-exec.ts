// child_process from typed code only: execFileSync with typed options and a
// caught failure read through the Error type, and a spawned child whose
// typed listeners report its exit. Nothing here boxes a child or reads an
// error through an untyped view, so the program links none of the child
// unit's checked-dynamic members (tests/harness/corpus-dynamic-tier.test.ts).
import { execFileSync, spawn } from "node:child_process";

console.log(execFileSync("sh", ["-c", "echo typed"], { encoding: "utf8" }).trim());

try {
  execFileSync("sh", ["-c", "exit 4"], { stdio: "pipe" });
  console.log("no error");
} catch (e) {
  const err = e as Error;
  console.log(err.name, err.message.split("\n")[0]);
}

try {
  execFileSync("scriptc-no-such-command-8898", [], { stdio: "pipe" });
  console.log("no error");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.name, err.code, err.message);
}

const child = spawn("sh", ["-c", "exit 2"]);
child.on("exit", (code: number | null) => {
  console.log("exit", code);
});
