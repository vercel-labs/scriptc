// Sync fs round-trips (write/read/append, unicode content, existsSync)
// inside a scratch directory derived from THIS process's own identity: the
// harness runs Node and the native binary CONCURRENTLY in one cwd, and
// argv[1]'s trailing segment differs between the two (script name vs binary
// name), so the sides never touch the same paths.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") {
    i = i - 1;
  }
  return path.slice(i + 1);
}
function freshDir(dir: string): void {
  // A crashed earlier run may have left the directory behind: empty it out
  // (this suite only ever creates plain files inside) and start clean.
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      rmSync(dir + "/" + name);
    }
    rmdirSync(dir);
  }
  mkdirSync(dir);
}
const scratch = "tmp-992-" + tail(process.argv[1]) + "-" + process.pid;
freshDir(scratch);

const file = scratch + "/notes.txt";
console.log(existsSync(file));
writeFileSync(file, "héllo 🌍\n");
console.log(existsSync(file));
const first = readFileSync(file, "utf8");
console.log(first === "héllo 🌍\n", first.length);

appendFileSync(file, "second line\n");
const second = readFileSync(file, "utf8");
console.log(second.length, second.startsWith("héllo"), second.endsWith("line\n"));
console.log(second.indexOf("🌍"), second.charCodeAt(6));

// Overwrite truncates; the empty file reads back as "".
writeFileSync(file, "");
console.log(readFileSync(file, "utf8") === "", existsSync(file));

// Contents round-trip through a second file byte-for-byte.
writeFileSync(scratch + "/copy.txt", second);
console.log(readFileSync(scratch + "/copy.txt", "utf8") === second);

rmSync(file);
console.log(existsSync(file));
rmSync(scratch + "/copy.txt");
rmdirSync(scratch);
console.log(existsSync(scratch));
