// @normalize-pid
// execFileSync with `shell: true` (terminal-size's shape): Node joins the
// file and its arguments with single spaces and runs the string through
// `/bin/sh -c`, so a command that is a shell builtin works. The capture,
// encoding and Buffer rules are execFileSync's.
import { execFileSync } from "node:child_process";

const echoed = execFileSync("echo", ["hi"], { shell: true, encoding: "utf8" });
console.log(JSON.stringify(echoed));

const printed = execFileSync("printf", ["%s-%s", "a", "b"], {
  shell: true,
  encoding: "utf8",
});
console.log(JSON.stringify(printed));

// A shell feature the direct spawn cannot express: the argument text is
// interpreted by the shell (no quoting happens on the way in).
const glob = execFileSync("printf", ["%s", "$((6 * 7))"], {
  shell: true,
  encoding: "utf8",
});
console.log(JSON.stringify(glob));

// No encoding option: Node answers the captured stdout Buffer.
const raw = execFileSync("printf", ["abc"], { shell: true });
console.log(Buffer.isBuffer(raw), raw.toString());

// `shell: false` is execFileSync's default and takes the direct path.
const direct = execFileSync("printf", ["direct"], { shell: false, encoding: "utf8" });
console.log(JSON.stringify(direct));
