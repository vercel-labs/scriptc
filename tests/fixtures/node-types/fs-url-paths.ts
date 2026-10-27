import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "node-types-url-"));
const file = pathToFileURL(join(dir, "a b.txt"));
writeFileSync(file, "hello");
console.log(readFileSync(file, "utf8"), readFileSync(file).length, statSync(file).size);
rmSync(pathToFileURL(dir), { recursive: true });
