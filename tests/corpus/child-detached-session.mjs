// options.detached: on POSIX the child becomes the leader of a new
// session and process group (setsid), where a non-detached child stays in
// the parent's. The probe reads the group and session ids with ps and
// compares them by identity, so the numbers themselves never appear in
// the output. A detached child left unreferenced keeps running after the
// parent's loop empties; the harness reads the shared stdout pipe to EOF,
// so the line it writes last is compared too.
import { spawn, spawnSync } from "node:child_process";

function ps(field, pid) {
  const out = spawnSync("ps", ["-o", field, "-p", String(pid)], { encoding: "utf8" });
  return String(out.stdout).trim().split(/\s+/);
}

const self = ps("pgid=,sid=", process.pid);
console.log("parent ids", self.length === 2);

function ids(child) {
  return new Promise((resolve) => {
    let text = "";
    child.stdout?.on("data", (chunk) => {
      text += String(chunk);
    });
    child.once("close", () => resolve(text.trim().split(/\s+/)));
  });
}

const attached = spawn("sh", ["-c", "ps -o pid=,pgid=,sid= -p $$"], { stdio: ["ignore", "pipe", "ignore"] });
const attachedIds = await ids(attached);
console.log("attached", attachedIds.length === 3, attachedIds[0] !== self[0]);
console.log("attached group", attachedIds[1] === self[0]);
console.log("attached session", attachedIds[2] === self[1]);

const detached = spawn("sh", ["-c", "ps -o pid=,pgid=,sid= -p $$"], {
  detached: true,
  stdio: ["ignore", "pipe", "ignore"],
});
const detachedIds = await ids(detached);
console.log("detached", detachedIds.length === 3);
console.log("detached group", detachedIds[1] === detachedIds[0], detachedIds[1] !== self[0]);
console.log("detached session", detachedIds[2] === detachedIds[0], detachedIds[2] !== self[1]);

// The child outlives the parent: detached and unref'd, it writes after
// the parent's loop has nothing left to do.
const survivor = spawn("sh", ["-c", "sleep 0.2; echo survivor"], {
  detached: true,
  stdio: ["ignore", "inherit", "ignore"],
});
survivor.unref();
survivor.once("close", () => {
  throw new Error("the parent's loop should not wait for an unref'd child");
});
console.log("parent exiting");
