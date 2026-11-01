// fs.existsSync probe loop over the same entry four ways: a string path and a
// Buffer path, each present and absent, so the typed call and the value form
// are both measured.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scale = Number(process.argv[2] ?? "1");
const rounds = 50000 * scale;
const present = path.join(os.tmpdir(), `scriptc-bench-exists-${process.pid}`);
fs.writeFileSync(present, "x");
const absent = `${present}.missing`;
const presentBuffer = Buffer.from(present, "utf8");
const absentBuffer = Buffer.from(absent, "utf8");

let hits = 0;
for (let i = 0; i < rounds; i++) {
  if (fs.existsSync(present)) hits++;
  if (fs.existsSync(presentBuffer)) hits++;
  if (fs.existsSync(absent)) hits++;
  if (fs.existsSync(absentBuffer)) hits++;
}
console.log(hits, rounds);
fs.unlinkSync(present);
