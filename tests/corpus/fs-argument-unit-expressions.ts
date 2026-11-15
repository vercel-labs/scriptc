// fs/promises calls whose explicitly supplied argument holds only undefined
// read the call's default in its place, but the argument expression still
// evaluates, in argument order, before the call: JavaScript evaluates the
// whole argument list first. The counter below proves each expression ran.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-args-"));
const source = path.join(dir, "a.txt");
fs.writeFileSync(source, "a");

const seen: string[] = [];
function absent(label: string): undefined {
  seen.push(label);
  return undefined;
}

await fsp.copyFile(source, path.join(dir, "b.txt"), absent("copyFile"));
console.log("copied", fs.readFileSync(path.join(dir, "b.txt"), "utf8"));

await fsp.mkdir(path.join(dir, "made"), absent("mkdir"));
await fsp.mkdir(path.join(dir, "made-direct"), { mode: absent("mkdir-mode") });
console.log("made", fs.existsSync(path.join(dir, "made")), fs.existsSync(path.join(dir, "made-direct")));

console.log("realpath", (await fsp.realpath(source, absent("realpath"))) === fs.realpathSync(source));
await fsp.mkdtemp(path.join(dir, "tmp-"), absent("mkdtemp"));
console.log("evaluated", seen.join(","));

fs.rmSync(dir, { recursive: true, force: true });
console.log("removed", fs.existsSync(dir));
