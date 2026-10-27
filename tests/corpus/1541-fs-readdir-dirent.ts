// readdirSync(path, { withFileTypes: true }): Dirent rows — name,
// parentPath (the path argument as given, Node's rule), and the type
// probes isFile/isDirectory/isSymbolicLink (no symlinkSync lowering
// exists to mint a link, so the probe pins the false answers). OS order
// is unguaranteed
// (993's rule), so the corpus sorts by name before printing. The
// portless workspace-glob idiom rides on top: filter(isDirectory) then
// map(name).
import * as fs from "node:fs";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") {
    i = i - 1;
  }
  return path.slice(i + 1);
}
const dir = `/tmp/scr-dirent-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir);
fs.mkdirSync(`${dir}/sub-a`);
fs.mkdirSync(`${dir}/sub-b`);
fs.writeFileSync(`${dir}/file.txt`, "x");

const entries = fs.readdirSync(dir, { withFileTypes: true });
const rows: string[] = [];
for (const e of entries) {
  rows.push(`${e.name} dir=${e.isDirectory()} file=${e.isFile()} link=${e.isSymbolicLink()} parent=${e.parentPath === dir}`);
}
rows.sort();
for (const row of rows) console.log(row);

// The portless glob shape: filter on a probe + a name test, then map.
const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("sub-")).map((e) => e.name);
dirs.sort();
console.log(dirs.join(","), entries.length);

// The error path throws Node's scandir errno error, catchably.
try {
  fs.readdirSync(`${dir}/missing`, { withFileTypes: true });
  console.log("no-throw");
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  console.log("caught", code === undefined ? "?" : code);
}
fs.rmSync(dir, { recursive: true, force: true });
