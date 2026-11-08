// Under @types/node: an option member a synchronous child launch does not
// read on this platform (`windowsHide`, `maxBuffer`) is still evaluated, in
// its place among the command, the arguments and the other members, as Node
// evaluates an object literal. A call and a getter run; a plain value has
// nothing to run. With a literal environment and with a checked-dynamic one.
import { execFileSync, execSync, spawnSync } from "node:child_process";

const trail: string[] = [];
function flag(step: string, value: boolean): boolean {
  trail.push(step);
  return value;
}
function text(step: string, value: string): string {
  trail.push(step);
  return value;
}
function count(step: string, value: number): number {
  trail.push(step);
  return value;
}
class Shutter {
  get closed(): boolean {
    trail.push("getter");
    return true;
  }
}
const shutter = new Shutter();
const still = process.argv.length < 99;
const fixed = { TRAY: "fixed" };
const loose: any = JSON.parse('{"TRAY":"loose"}');
const script = 'printf %s "$TRAY"';

function show(label: string, out: string): void {
  console.log(label, JSON.stringify(out), trail.join(">"));
  trail.length = 0;
}

show(
  "spawnSync fixed call",
  spawnSync(text("file", "/bin/sh"), ["-c", script], {
    encoding: "utf8",
    env: fixed,
    windowsHide: flag("hide", true),
    timeout: count("timeout", 20000),
  }).stdout,
);
show(
  "spawnSync fixed getter",
  spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", windowsHide: shutter.closed, env: fixed })
    .stdout,
);
show(
  "spawnSync fixed plain",
  spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: fixed, windowsHide: still }).stdout,
);
show(
  "spawnSync loose call",
  spawnSync("/bin/sh", ["-c", text("script", script)], {
    encoding: "utf8",
    cwd: text("cwd", "/"),
    windowsHide: flag("hide", false),
    env: loose,
  }).stdout,
);
show(
  "spawnSync loose getter",
  spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: loose, windowsHide: shutter.closed })
    .stdout,
);
show(
  "spawnSync loose plain",
  spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: loose, windowsHide: still }).stdout,
);
show(
  "spawnSync alone call",
  spawnSync("/bin/sh", ["-c", "printf bare"], { windowsHide: flag("hide", true), encoding: "utf8" })
    .stdout,
);

show(
  "execFileSync fixed call",
  execFileSync(text("file", "/bin/sh"), ["-c", script], {
    encoding: "utf8",
    timeout: count("timeout", 20000),
    windowsHide: flag("hide", true),
    env: fixed,
    maxBuffer: count("buffer", 1048576),
  }),
);
show(
  "execFileSync fixed getter",
  execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: fixed, windowsHide: shutter.closed }),
);
show(
  "execFileSync fixed plain",
  execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: fixed, windowsHide: still }),
);
show(
  "execFileSync loose call",
  execFileSync("/bin/sh", ["-c", text("script", script)], {
    encoding: "utf8",
    windowsHide: flag("hide", true),
    cwd: text("cwd", "/"),
    env: loose,
  }),
);
show(
  "execFileSync loose getter",
  execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", windowsHide: shutter.closed, env: loose }),
);
show(
  "execFileSync loose plain",
  execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: loose, windowsHide: still }),
);

show(
  "execSync fixed call",
  execSync(text("command", script), {
    encoding: "utf8",
    env: fixed,
    windowsHide: flag("hide", true),
    cwd: text("cwd", "/"),
  }),
);
show(
  "execSync fixed getter",
  execSync(script, { encoding: "utf8", windowsHide: shutter.closed, env: fixed }),
);
show("execSync fixed plain", execSync(script, { encoding: "utf8", env: fixed, windowsHide: still }));
show(
  "execSync loose call",
  execSync(script, {
    encoding: "utf8",
    maxBuffer: count("buffer", 1048576),
    env: loose,
    windowsHide: flag("hide", false),
    timeout: count("timeout", 20000),
  }),
);
show(
  "execSync loose getter",
  execSync(script, { encoding: "utf8", env: loose, windowsHide: shutter.closed }),
);
show("execSync loose plain", execSync(script, { encoding: "utf8", env: loose, windowsHide: still }));
