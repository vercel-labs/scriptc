// spawn's `detached` option as a RUNTIME boolean — the portable daemon
// idiom `detached: process.platform !== "win32"` — reaches the same
// POSIX_SPAWN_SETSID flag as the literal form: a detached child leads its
// own process group (pgid == pid), a non-detached one stays in the
// parent's group.
import { spawn } from "node:child_process";

const PGID = "ps -o pgid= -p $$ | tr -d ' '";
const mode = process.platform !== "win32";

const lead = spawn("/bin/sh", ["-c", PGID], { detached: mode, stdio: ["ignore", "pipe", "ignore"] });
let leadOut = "";
if (lead.stdout) {
  lead.stdout.setEncoding("utf8");
  lead.stdout.on("data", (chunk: string) => {
    leadOut += chunk;
  });
}
lead.on("close", () => {
  console.log("detached leads its own group:", leadOut.trim() === String(lead.pid));

  const joined = spawn("/bin/sh", ["-c", PGID], {
    detached: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let joinedOut = "";
  if (joined.stdout) {
    joined.stdout.setEncoding("utf8");
    joined.stdout.on("data", (chunk: string) => {
      joinedOut += chunk;
    });
  }
  joined.on("close", () => {
    console.log("non-detached stays behind:", joinedOut.trim() !== String(joined.pid));
  });
});
