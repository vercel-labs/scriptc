// Repeated writeFileSync and appendFileSync calls that pass option records:
// every write names its encoding and its open(2) flag, the form whose options
// path this workload measures. Both files live under one temporary directory
// and the totals are printed so the bytes the calls wrote are checked.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-write-options-"));
const file = path.join(dir, "data.txt");
const appended = path.join(dir, "append.txt");

const payloads: string[] = [];
for (let i = 0; i < 32; i++) payloads.push(`record ${i} of the write workload `);

let written = 0;
for (let i = 0; i < 20000; i++) {
  const data = payloads[i & 31]!;
  fs.writeFileSync(file, data, { encoding: "utf8", flag: "w+" });
  written += data.length;
}

for (let i = 0; i < 5000; i++) fs.appendFileSync(appended, "appended line\n", { flag: "a", encoding: "utf8" });

console.log(`wrote ${written} bytes, file ${fs.statSync(file).size} bytes`);
console.log(`appended ${fs.statSync(appended).size} bytes`);

fs.rmSync(dir, { recursive: true, force: true });
