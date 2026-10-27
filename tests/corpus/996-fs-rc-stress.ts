// RC stress: file contents flowing through arrays, records, closures, and
// exception paths — the sanitized lane (ASan + RC audit) proves the
// library's ownership contract leaks nothing even when fs errors unwind
// mid-expression.
import {
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
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      rmSync(dir + "/" + name);
    }
    rmdirSync(dir);
  }
  mkdirSync(dir);
}
const scratch = "tmp-996-" + tail(process.argv[1]) + "-" + process.pid;
freshDir(scratch);

// Contents into an array, back through map/filter/join.
const paths: string[] = [];
for (let i = 0; i < 5; i = i + 1) {
  const p = scratch + "/doc" + i + ".txt";
  writeFileSync(p, "body-" + i + "-αβγ");
  paths.push(p);
}
const bodies = paths.map((p) => readFileSync(p, "utf8"));
console.log(bodies.length, bodies.join("|").length);
console.log(bodies.filter((b) => b.includes("3")).length);

// Contents into a record and a closure.
const doc = { name: tail(paths[0]), body: readFileSync(paths[0], "utf8") };
console.log(doc.name, doc.body === "body-0-αβγ");
const stamp = (s: string): string => doc.body + ":" + s;
console.log(stamp("x"), stamp(doc.name));

// Exception paths with disk-sourced strings in flight: loadOrThrow throws
// its own value after a successful read, and readFileSync itself throws for
// the missing/empty cases — every unwind releases the temps it bypasses.
function loadOrThrow(path: string): string {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) {
    throw "empty: " + path;
  }
  return text;
}
let survived = 0;
let recovered = 0;
for (const p of paths) {
  try {
    survived = survived + loadOrThrow(p).length;
  } catch {
    recovered = recovered + 1;
  }
}
try {
  survived = survived + loadOrThrow(scratch + "/missing.txt").length;
} catch {
  recovered = recovered + 1;
}
writeFileSync(scratch + "/empty.txt", "");
try {
  survived = survived + loadOrThrow(scratch + "/empty.txt").length;
} catch {
  recovered = recovered + 1;
}
console.log(survived, recovered);

// Rethrow with content from disk riding the exception cell.
try {
  try {
    loadOrThrow(scratch + "/missing.txt");
  } catch {
    throw readFileSync(paths[4], "utf8") + "!";
  }
} catch {
  console.log("outer caught the rethrown content");
}

for (const name of readdirSync(scratch)) {
  rmSync(scratch + "/" + name);
}
rmdirSync(scratch);
console.log(existsSync(scratch));
