// readFileSync's options record through the typed surface: a bare encoding
// selects a string, an encoding key with no flag reads the whole file, and
// a flag alone selects a Buffer. A flag is a documented name or open(2)
// bits, so "w+" truncates before the read and "r+" reads an existing file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-opts-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello");

console.log("encoding string", fs.readFileSync(file, "utf8"));
console.log("encoding record", fs.readFileSync(file, { encoding: "utf8" }));
const bytes: Buffer = fs.readFileSync(file, { flag: "r" });
console.log("flag record", bytes.length, bytes.toString("utf8"));
const nullEncoding: Buffer = fs.readFileSync(file, { encoding: null });
console.log("encoding null", nullEncoding.length);
console.log("encoding + flag", fs.readFileSync(file, { encoding: "latin1", flag: "r" }));
const text: string = fs.readFileSync(file, { encoding: "utf8", flag: "r+" });
console.log("typed string", text.length, text);

const fresh = path.join(dir, "b.txt");
fs.writeFileSync(fresh, "0123456789");
console.log("flag w+", JSON.stringify(fs.readFileSync(fresh, { encoding: "utf8", flag: "w+" })));
console.log("after w+", fs.statSync(fresh).size);

console.log("bits", fs.readFileSync(file, { flag: 0 }).length);
console.log("unknown key", fs.readFileSync(file, { encoding: "utf8", other: true }));

fs.rmSync(dir, { recursive: true, force: true });
