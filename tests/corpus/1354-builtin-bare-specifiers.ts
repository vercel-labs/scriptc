// Bare and node:-prefixed builtin specifiers are the SAME module ("fs" ≡
// "node:fs"), and aliased named imports lower through the alias. A small
// fs round-trip through bare-"fs" bindings proves the unification end to
// end; the scratch directory is derived from argv[1]'s tail so the
// concurrently-running Node and native sides never collide (see 992).
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, rmdirSync } from "fs";
import { join as j, basename } from "path";
import { platform as plat } from "os";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") {
    i = i - 1;
  }
  return path.slice(i + 1);
}

const scratch = "tmp-1354-" + tail(process.argv[1]) + "-" + process.pid;
if (existsSync(scratch)) {
  if (existsSync(j(scratch, "f.txt"))) {
    rmSync(j(scratch, "f.txt"));
  }
  rmdirSync(scratch);
}
mkdirSync(scratch);

const file = j(scratch, "f.txt");
writeFileSync(file, "bare specifiers\n");
console.log(readFileSync(file, "utf8") === "bare specifiers\n");
console.log(basename(file));
console.log(plat() === process.platform);

rmSync(file);
rmdirSync(scratch);
console.log(existsSync(scratch));
