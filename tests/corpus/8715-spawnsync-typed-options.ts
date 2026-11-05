// SpawnSyncOptionsWithStringEncoding is a real record: a typed options
// const (or a runner function's options parameter) flows to spawnSync at
// runtime. cwd/input/timeout/shell read their fields (undefined takes the
// literal path's default) and the stdio modes compute at the call, so a
// runner can pass one options value to many commands.
//
// A record MAY enable shell at run time, where Node warns DEP0190 whenever
// the args list is non-empty, and a native build has no warning channel —
// so the typed form takes the command-line shape (an empty args list) and
// the compiler refuses a call that passes separate args.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Runner = (command: string, options: SpawnSyncOptionsWithStringEncoding) => string;
const defaultRunner: Runner = (command, options): string =>
  spawnSync(command, [], options).stdout.trim();

const dir = mkdtempSync(join(tmpdir(), "scr-sync-typed-"));
const marker = join(dir, "marker.sh");
writeFileSync(marker, "#!/bin/sh\nprintf 'from-dir\\n'\n");
chmodSync(marker, 0o755);

// cwd reads at the call: the child resolves the relative command in ITS
// directory.
const inDir: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", cwd: dir };
console.log(`cwd: ${defaultRunner("./marker.sh", inDir)}`);

// input is piped to the child's stdin.
const fed: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", input: "typed input\n" };
console.log(`input: ${JSON.stringify(defaultRunner("/bin/cat", fed))}`);

// A bare record takes every optional member's default.
const bare: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" };
console.log(`bare: ${JSON.stringify(spawnSync("/bin/echo", [], bare).stdout)}`);

// A runtime stdio string applies to all three fds; the stderr slot keeps
// the capture while stdout is ignored (Node types the ignored capture
// null, the documented spawnSync stance — status is the honest signal).
const quiet: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", stdio: "ignore" };
console.log(`quiet: ${spawnSync("/bin/cat", [], quiet).status}`);

// A runtime stdio ARRAY reads each fd's entry; fd 0 "ignore" drops the
// input option, exactly like the literal path.
const tuple: SpawnSyncOptionsWithStringEncoding = {
  encoding: "utf8",
  input: "dropped",
  stdio: ["ignore", "pipe", "pipe"],
};
console.log(`tuple: ${JSON.stringify(spawnSync("/bin/cat", [], tuple).stdout.trim())}`);

// shell reads at the call: the command line runs through /bin/sh -c.
const shelled: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: true };
console.log(`shell: ${JSON.stringify(spawnSync("echo a   b", [], shelled).stdout)}`);

// timeout reads at the call (bounded: `exec` replaces the shell, so the
// 300ms SIGTERM lands on the 5s sleep itself).
const slow: SpawnSyncOptionsWithStringEncoding = {
  encoding: "utf8",
  shell: true,
  timeout: 300,
};
const killed = spawnSync("exec sleep 5", [], slow);
console.log(`timeout: ${killed.status} ${killed.signal}`);
