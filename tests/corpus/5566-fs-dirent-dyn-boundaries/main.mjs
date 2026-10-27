// Dirent rows crossing from a typed module into untyped JavaScript keep
// Node's Dirent prototype, keys and inspect form.
import * as fs from "node:fs";
import { list, show } from "./rows.ts";

function tail(path) {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
}
const dir = `/tmp/scr-dirent-dyn-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(`${dir}/sub`, { recursive: true });
fs.writeFileSync(`${dir}/a.txt`, "x");
const home = process.cwd();
process.chdir(dir);

const rows = list(".");
console.log(rows.map((d) => [d.name, d.isFile(), d.isDirectory(), d.isSymbolicLink()]));
console.log(rows.map((d) => Object.keys(d)), JSON.stringify(rows));
console.log(rows[0]);
show(".");

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
