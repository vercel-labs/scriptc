// access and truncate take Node's F_OK/0 defaults for an omitted argument,
// an explicit undefined, and a `number | undefined` value in both the
// synchronous and promise forms; null keeps access's F_OK default while
// truncate rejects it.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-truncate-"));
const file = path.join(dir, "f.txt");
fs.writeFileSync(file, "hello");

const omittedMode: number | undefined = undefined;
const writeMode: number | undefined = 2;
const omittedLength: number | undefined = undefined;
const length3: number | undefined = 3;

fs.accessSync(file);
fs.accessSync(file, omittedMode);
fs.accessSync(file, writeMode);
console.log("access", fs.statSync(file).size);

fs.truncateSync(file, undefined);
console.log("truncate undefined", fs.statSync(file).size);
fs.truncateSync(file, omittedLength);
console.log("truncate omitted", fs.statSync(file).size);
fs.truncateSync(file, length3);
console.log("truncate length3", fs.statSync(file).size);
fs.truncateSync(file, -1);
console.log("truncate negative", fs.statSync(file).size);

async function main(): Promise<void> {
  await fsp.access(file, omittedMode);
  await fsp.access(file, writeMode);
  console.log("promise access");
  await fsp.truncate(file, undefined);
  console.log("promise truncate undefined", fs.statSync(file).size);
  await fsp.truncate(file, length3);
  console.log("promise truncate length3", fs.statSync(file).size);
  await fsp.truncate(file, omittedLength);
  console.log("promise truncate omitted", fs.statSync(file).size);
  fs.rmSync(dir, { recursive: true, force: true });
}

main();
