// spawnSync's 3-tuple stdio slots may be runtime values typed as a union of
// the three literals (pi's resolve-config-value builds one from a flag):
// each value evaluates once and maps to its mode at the call. fd 0 carries
// `input` only when the slot at runtime is "pipe" — "ignore" and "inherit"
// take the child's fd 0 away, as Node does.
import { spawnSync } from "node:child_process";

type Mode = "pipe" | "ignore" | "inherit";

function cat(mode: Mode, input: string | undefined): string {
  const r = spawnSync("/bin/sh", ["-c", "cat"], {
    encoding: "utf8",
    input,
    stdio: [mode, "pipe", "pipe"],
  });
  return `stdin=${mode} status=${r.status} out=${JSON.stringify(r.stdout)}`;
}

console.log(cat("pipe", "hello\n"));
console.log(cat("ignore", "hello\n"));
console.log(cat("pipe", undefined));

// The output slots map the same way: "inherit" hands the child the parent's
// fd, "ignore" sends it to /dev/null.
function echo(which: "stdout" | "stderr", mode: Mode): void {
  const r = spawnSync("/bin/sh", ["-c", "printf 'child-$which\\n' 1>&2"], {
    encoding: "utf8",
    stdio: ["ignore", which === "stdout" ? mode : "pipe", which === "stderr" ? mode : "pipe"],
  });
  console.log(`fd=${which} mode=${mode} status=${r.status}`);
}

echo("stdout", "inherit");
echo("stdout", "ignore");
echo("stderr", "inherit");
echo("stderr", "ignore");

// The census shape: a flag-computed slot beside literal ones, with the
// options a config resolver passes.
const commandFromStdin = process.argv.length > 99;
const inline = spawnSync("/bin/sh", ["-c", "printf 'inline\\n'"], {
  encoding: "utf8",
  input: commandFromStdin ? "x" : undefined,
  timeout: 10000,
  stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
  shell: false,
  windowsHide: true,
});
console.log(`inline status ${inline.status} out ${JSON.stringify(inline.stdout)}`);
