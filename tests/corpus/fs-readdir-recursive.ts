// readdirSync(path, { recursive: true }) lists every entry below the path,
// relative to it: the path's own entries first, then each directory's in the
// order its entry was listed. A symlink to a directory is followed.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "readdir-recursive-"));
writeFileSync(join(root, "a.txt"), "a");
mkdirSync(join(root, "b", "d"), { recursive: true });
writeFileSync(join(root, "b", "c.txt"), "c");
writeFileSync(join(root, "b", "d", "e.txt"), "e");
mkdirSync(join(root, "empty"));
mkdirSync(join(root, "z"));
writeFileSync(join(root, "z", "y.txt"), "y");
symlinkSync(join(root, "b", "d"), join(root, "link"));

console.log(readdirSync(root, { recursive: true }).join(" "));
console.log(readdirSync(root, { recursive: false }).join(" "));
console.log(readdirSync(`${root}/b/`, { recursive: true }).join(" "));

let deep = false;
for (const flag of [false, true]) {
  deep = flag;
  console.log(deep, readdirSync(join(root, "z"), { recursive: deep }).length);
}
console.log(readdirSync(join(root, "empty"), { recursive: true }).length);

// A flag expression typed `true` or `false` still evaluates, once.
let probes = 0;
function yes(): true {
  probes++;
  return true;
}
function no(): false {
  probes++;
  return false;
}
console.log(
  readdirSync(join(root, "b"), { recursive: yes() }).length,
  readdirSync(join(root, "b"), { recursive: no() }).length,
  probes,
);

try {
  readdirSync(join(root, "missing"), { recursive: true });
} catch (e) {
  console.log((e as NodeJS.ErrnoException).code);
}

rmSync(root, { recursive: true });
