// Dirent rows used from untyped JavaScript: the readdirSync result is a
// dynamic value, so each row carries Node's Dirent prototype. The type
// probes are callable, the keys and JSON form are name and parentPath,
// and util.inspect shows the Dirent class and its Symbol(type) key.
import * as fs from "node:fs";

function tail(path) {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
}
const dir = `/tmp/scr-dirent-untyped-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(`${dir}/sub`, { recursive: true });
fs.writeFileSync(`${dir}/a.txt`, "x");
fs.writeFileSync(`${dir}/b.txt`, "y");

const home = process.cwd();
process.chdir(dir);
const entries = fs.readdirSync(".", { withFileTypes: true });
entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

console.log(entries.map((d) => d.isFile()));
console.log(entries.map((d) => d.isDirectory()));
for (const d of entries) {
  console.log(
    d.name,
    d.parentPath,
    d.isSymbolicLink(),
    d.isFIFO(),
    d.isSocket(),
    d.isBlockDevice(),
    d.isCharacterDevice(),
  );
}
console.log(entries.filter((d) => d.isFile()).map((d) => d.name).join(","));

const first = entries[0];
console.log(Object.keys(first));
console.log(JSON.stringify(first), JSON.stringify(entries));
console.log(entries.map((d) => [typeof d.isFile, d.isFile.name, d.isFile.length]));
console.log(entries.map((d) => [Object.prototype.hasOwnProperty.call(d, "isFile"), "isFile" in d]));
const keys = [];
for (const key in first) keys.push(key);
console.log(keys);
console.log(entries.map((d) => Object.getOwnPropertySymbols(d).map((s) => s.toString())));

console.log(first);
console.log(entries);
console.log(entries.map((d) => ({ ...d }))[0]);
console.log(Object.getPrototypeOf(first) === Object.getPrototypeOf(entries[1]));
const probe = Object.getPrototypeOf(first).isDirectory;
console.log(probe.call(entries[2]), probe.call({}));
try {
  probe.call(undefined);
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}

process.chdir(home);
fs.rmSync(dir, { recursive: true, force: true });
