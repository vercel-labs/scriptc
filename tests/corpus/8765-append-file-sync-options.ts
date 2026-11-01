// Static three-argument fs.appendFileSync: utf8's string and object
// spellings, the "a" flag the append already opens with, evaluation order
// (path, data, then the option values the record holds), creation of a
// missing file, and an undocumented side-effect-free key dropping like
// Node drops it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-append-options-"));
const file = path.join(dir, "log.txt");
const APPEND = { encoding: "utf-8", flag: "a" } as const;

const order: string[] = [];
function writePath(label: string): string {
  order.push(label);
  return file;
}
function writeData(label: string, value: string): string {
  order.push(label);
  return value;
}
function encoding(label: string): "utf8" {
  order.push(label);
  return "utf8";
}

// The bare-encoding spellings and the options record's encoding key.
fs.appendFileSync(file, "a", "utf8");
fs.appendFileSync(file, "b", "utf-8");
fs.appendFileSync(file, "c", { encoding: "utf8" });
fs.appendFileSync(file, "d", { encoding: "utf-8" });

// The flag the runtime already opens with, alone and beside the encoding.
fs.appendFileSync(file, "e", { flag: "a" });
fs.appendFileSync(file, "f", APPEND);
console.log("first:", JSON.stringify(fs.readFileSync(file, "utf8")));

// Path, data and the option values evaluate in call order.
fs.appendFileSync(writePath("path"), writeData("data", "g"), { encoding: encoding("encoding") });
console.log("order:", order.join(","), JSON.stringify(fs.readFileSync(file, "utf8")));

// An append CREATES the file when it is missing, and appends to whatever
// a previous write left behind.
const fresh = path.join(dir, "fresh.txt");
fs.appendFileSync(fresh, "x", { encoding: "utf8" });
fs.appendFileSync(fresh, "y");
console.log("fresh:", JSON.stringify(fs.readFileSync(fresh, "utf8")));

const seeded = path.join(dir, "seeded.txt");
fs.writeFileSync(seeded, "seed\n");
fs.appendFileSync(seeded, "tail\n", { encoding: "utf8" });
console.log("seeded:", JSON.stringify(fs.readFileSync(seeded, "utf8")));

// Undocumented, side-effect-free option keys drop exactly like Node.
fs.appendFileSync(file, "h", { ignored: <T>(value: T): T => value });
console.log("dropped:", JSON.stringify(fs.readFileSync(file, "utf8")));

// Node's syscall failures still surface (only the leading code is printed:
// the message carries the random temporary directory).
const badPath = path.join(dir, "missing", "nested.txt");
try {
  fs.appendFileSync(badPath, "boom", { encoding: "utf8" });
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  console.log("bad path code:", text.split(":")[0]);
}

fs.rmSync(dir, { recursive: true, force: true });
