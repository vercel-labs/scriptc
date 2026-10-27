// fs.cpSync and fs/promises cp over a directory chain 400 levels deep (its
// deepest path stays under macOS's 1024-byte PATH_MAX), from a module with
// top-level await (its code runs on a fiber stack).
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
}
const root = `/tmp/scr-cp-deep-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root);
const home = process.cwd();
process.chdir(root);

const depth = 400;
let path = "src";
for (let i = 0; i < depth; i++) path += "/d";
fs.mkdirSync(path, { recursive: true });
fs.writeFileSync(`${path}/leaf.txt`, "leaf");

function count(dir: string): number {
  let levels = 0;
  let at = dir;
  while (fs.existsSync(`${at}/d`)) {
    at += "/d";
    levels += 1;
  }
  return levels;
}

fs.cpSync("src", "sync", { recursive: true });
console.log("sync", count("sync"), fs.readFileSync(`sync${path.slice(3)}/leaf.txt`, "utf8"));
fs.cpSync("src", "filtered", { recursive: true, filter: () => true });
console.log("filtered", count("filtered"));
await fsp.cp("src", "promise", { recursive: true });
console.log("promise", count("promise"));

process.chdir(home);
fs.rmSync(root, { recursive: true, force: true });
