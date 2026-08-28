// lstatSync (the no-follow stat), Stats.isSymbolicLink()/mtimeMs, and
// the mkdir lock idiom (RouteStore's acquireLock): mkdirSync as an
// atomic try-lock whose EEXIST is a catchable errno error, staleness
// judged through statSync(...).mtimeMs. Timing facts are BOUNDED (the
// mtime is recent, not an exact tick), so the output is deterministic.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-lstat-"));
const target = join(dir, "target");
const link = join(dir, "link");
mkdirSync(target);
writeFileSync(join(target, "payload.txt"), "pointed-at");

// symlinkSync has no lowering yet, so ask the Node binary available on every
// differential host to create it. A Windows directory junction needs no
// developer-mode symlink privilege. Backdate the target's atime so the
// lstat snapshot proves its metadata came from the link, not the target.
execFileSync(
  "node",
  [
    "-e",
    "const fs=require('node:fs');fs.utimesSync(process.argv[1],946684800,946684800);" +
      "fs.symlinkSync(process.argv[1],process.argv[2],process.platform==='win32'?'junction':'dir')",
    target,
    link,
  ],
  { stdio: "pipe" },
);
const viaStat = statSync(link); // follows
const viaLstat = lstatSync(link); // does not
console.log("stat follows:", viaStat.isDirectory(), viaStat.isSymbolicLink());
console.log(
  "lstat sees the link:",
  viaLstat.isSymbolicLink(),
  viaLstat.isDirectory(),
  viaLstat.atimeMs !== viaStat.atimeMs,
  viaLstat.size === target.length,
  viaLstat.blocks,
  viaLstat.nlink,
);
console.log("plain directory:", lstatSync(target).isSymbolicLink());
try {
  lstatSync(join(dir, "nope"));
} catch (e) {
  if (e instanceof Error) {
    console.log("lstat missing:", `${(e as NodeJS.ErrnoException).code}`, e.message.includes("lstat"));
  }
}

// mtimeMs: a fresh file's mtime is recent (within the last hour) and not
// in the future (a minute of clock skew allowed) — bounded facts.
const now = Date.now();
const mtime = statSync(join(target, "payload.txt")).mtimeMs;
console.log("mtime sane:", now - mtime < 3600_000, mtime <= now + 60_000);

// The lock idiom: mkdirSync succeeds once, then throws catchable EEXIST;
// the holder's staleness reads through statSync(...).mtimeMs.
const lockPath = join(dir, "routes.lock");
function tryLock(): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST") {
      const heldFor = Date.now() - statSync(lockPath).mtimeMs;
      console.log("held, fresh:", heldFor < 10_000);
      return false;
    }
    throw e;
  }
}
console.log("first lock:", tryLock());
console.log("second lock:", tryLock());
rmSync(lockPath, { recursive: true });
console.log("relock after release:", tryLock());

rmSync(dir, { recursive: true, force: true });
console.log("done:", !existsSync(dir));
