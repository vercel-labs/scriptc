// readdirSync: Node returns names in OS order (unsorted), so the corpus
// checks MEMBERSHIP via includes() and never prints the order. Scratch
// paths derive from argv[1]'s tail (see 992) for parallel safety.
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      rmSync(dir + "/" + name);
    }
    rmdirSync(dir);
  }
  mkdirSync(dir);
}
const scratch = "tmp-993-" + tail(process.argv[1]) + "-" + process.pid;
freshDir(scratch);

console.log(readdirSync(scratch).length); // fresh dir is empty
writeFileSync(scratch + "/b.txt", "b");
writeFileSync(scratch + "/a.txt", "a");
mkdirSync(scratch + "/sub");
writeFileSync(scratch + "/sub/inner.txt", "inner");

const names = readdirSync(scratch);
console.log(names.length);
console.log(names.includes("a.txt"), names.includes("b.txt"), names.includes("sub"));
console.log(names.includes("c.txt"), names.includes("."), names.includes(".."));

// Names compose with ordinary array machinery.
const txt = names.filter((n) => n.endsWith(".txt"));
console.log(txt.length, txt.includes("sub"));
let total = 0;
for (const n of readdirSync(scratch + "/sub")) {
  total = total + n.length;
}
console.log(total); // "inner.txt"

rmSync(scratch + "/sub/inner.txt");
rmdirSync(scratch + "/sub");
console.log(readdirSync(scratch).includes("sub"));
rmSync(scratch + "/a.txt");
rmSync(scratch + "/b.txt");
console.log(readdirSync(scratch).length);
rmdirSync(scratch);
console.log(existsSync(scratch));
