// An unannotated `let` with no initializer keeps the type its assignments
// give it through control flow, including a `null` assigned in a `catch`
// arm: `let stat; try { stat = lstatSync(".") } catch { stat = null }`
// holds `Stats | null`, and narrowing reads the handle arm.
import { lstatSync, readFileSync } from "node:fs";
import * as path from "node:path";

let stat;
try {
  stat = lstatSync(".");
} catch {
  stat = null;
}
console.log("file scope:", stat === null ? 0 : stat.isDirectory());

function missingFile(): string {
  let data;
  try {
    data = readFileSync(path.join(".", "no-such-file-here.txt"), "utf8");
  } catch {
    data = null;
  }
  return data === null ? "missing" : data;
}
console.log("local scope:", missingFile());

function presentFile(): string {
  let value;
  try {
    value = path.basename("/scratch/dir/name.txt");
  } catch {
    value = null;
  }
  return value === null ? "none" : value.toUpperCase();
}
console.log("local value:", presentFile());

// A `let` whose assignments agree without any null arm keeps that type.
let count;
if (process.argv.length > 1) {
  count = 1;
} else {
  count = 2;
}
console.log("plain:", count + 1);

// A single write keeps the written handle type.
let once;
once = lstatSync(".");
console.log("single:", once.size > 0);
