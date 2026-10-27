// spawnSync's env option replaces the child's environment, alone or with
// the other options.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const merged = spawnSync("sh", ["-c", 'echo "$GREETING $HOME_SET"'], {
  env: { ...process.env, GREETING: "hello", HOME_SET: process.env.HOME ? "yes" : "no" },
  encoding: "utf8",
});
console.log(merged.stdout.trim(), merged.status);

const only = spawnSync("/bin/sh", ["-c", 'echo "${GREETING:-unset} ${HOME:-nohome}"'], {
  env: { GREETING: "only" },
  encoding: "utf8",
});
console.log(only.stdout.trim());

const empty = spawnSync("/bin/sh", ["-c", "env | grep -c ."], { env: {}, encoding: "utf8" });
console.log(Number(empty.stdout.trim()) <= 3, empty.status);

const quiet = spawnSync("sh", ["-c", 'echo "$MODE" >&2; exit 4'], {
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MODE: "loud" },
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 5000,
});
console.log(quiet.status, quiet.stderr.toString().trim(), quiet.stdout.toString() === "");

const missing = spawnSync("/nonexistent/tool", [], { env: { A: "1" } });
console.log(missing.status, missing.error?.message);

// The command is found on the replacement environment's PATH, or on the
// default path when the replacement has none, not on the parent's PATH.
const dir = mkdtempSync(join(tmpdir(), "scr-spawn-path-"));
writeFileSync(join(dir, "child-only-tool"), "#!/bin/sh\necho child-only\n");
chmodSync(join(dir, "child-only-tool"), 0o755);
writeFileSync(join(dir, "not-executable"), "#!/bin/sh\necho never\n");
const viaPath = spawnSync("child-only-tool", [], { env: { PATH: `/nonexistent:${dir}` }, encoding: "utf8" });
console.log(viaPath.status, viaPath.stdout.trim());
const defaultPath = spawnSync("sh", ["-c", "echo default"], { env: { A: "1" }, encoding: "utf8" });
console.log(defaultPath.status, defaultPath.stdout.trim());
const notOnPath = spawnSync("sh", ["-c", "echo never"], { env: { PATH: dir }, encoding: "utf8" });
console.log(notOnPath.status, notOnPath.error?.message);
const denied = spawnSync("not-executable", [], { env: { PATH: dir }, encoding: "utf8" });
console.log(denied.status, denied.error?.message);
rmSync(dir, { recursive: true });
