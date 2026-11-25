// spawnSync's `shell: true`: the command string runs through /bin/sh -c,
// so pipes, variables, redirections, and the shell's own quoting apply.
// The complete command goes in the first argument with an empty args list
// — Node's DEP0190 warning covers separate shell arguments, and the
// compiler refuses that form instead of silently skipping the warning.
// Failure shapes stay data on the result (non-zero status, a signal
// death, the shell's own 127), never a throw.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const echo = spawnSync("echo hello", [], { shell: true, encoding: "utf8" });
console.log(`echo: ${JSON.stringify(echo.stdout)} ${echo.status} ${echo.signal}`);

// The shell splits and expands the line itself.
const quoted = spawnSync("printf '%s-%s' a b", [], { shell: true, encoding: "utf8" });
console.log(`quote: ${JSON.stringify(quoted.stdout)} ${quoted.status}`);

// Pipes, variables, and redirections are the shell's.
const piped = spawnSync("printf 'a\\nb\\n' | wc -l", [], { shell: true, encoding: "utf8" });
console.log(`pipe: ${JSON.stringify(piped.stdout.trim())}`);
const expanded = spawnSync('printf %s "$HOME" > /dev/null; echo done', [], {
  shell: true,
  encoding: "utf8",
});
console.log(`operators: ${JSON.stringify(expanded.stdout.trim())} ${expanded.status}`);

// A non-zero status is data, never a throw.
const failed = spawnSync("exit 3", [], { shell: true });
console.log(`status: ${failed.status} ${failed.signal} ${failed.error === undefined}`);

// The shell itself dying to a signal reports it.
const signaled = spawnSync("kill -TERM $$", [], { shell: true });
console.log(`signal: ${signaled.status} ${signaled.signal}`);

// A command the shell cannot find reports the SHELL's status (127), like
// Node — the spawn succeeded, so there is no ENOENT on the result.
const missing = spawnSync("definitely-not-a-command-xyz", [], {
  shell: true,
  encoding: "utf8",
});
console.log(`missing: ${missing.status} ${missing.signal} ${missing.error === undefined}`);

// shell composes with cwd, input, stdio, and env.
const dir = mkdtempSync(join(tmpdir(), "scr-shell-"));
writeFileSync(join(dir, "marker.txt"), "from-dir\n");
const combined = spawnSync("/bin/cat marker.txt; echo ${MARK:-unset}", [], {
  shell: true,
  cwd: dir,
  input: "unread\n",
  stdio: ["ignore", "pipe", "pipe"],
  env: { MARK: "replaced" },
  encoding: "utf8",
});
console.log(`combined: ${JSON.stringify(combined.stdout)} ${combined.status}`);

// The timeout still fires: `exec` replaces the shell, so the kill lands
// on the sleeping process itself (bounded: 5s sleep, 300ms SIGKILL).
const slow = spawnSync("exec sleep 5", [], {
  shell: true,
  timeout: 300,
  killSignal: "SIGKILL",
});
console.log(
  `timeout: ${slow.status} ${slow.signal} ${(slow.error as NodeJS.ErrnoException | undefined)?.code}`,
);
