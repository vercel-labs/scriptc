// process.cwd stored as a value: one identity across the global, named,
// namespace and default forms, Node's name and length, and the directory
// read when it is called.
import { cwd } from "node:process";
import * as processModule from "node:process";
import processDefault from "node:process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const get = process.cwd;
console.log(typeof get, get.name, get.length);
console.log(get === cwd, get === processModule.cwd, get === processDefault.cwd);
console.log(get() === process.cwd(), cwd() === process.cwd());

const start = get();
const dir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-cwd-value-")));
process.chdir(dir);
console.log(get() === dir, cwd() === dir, [0].map(() => get())[0] === dir);
process.chdir(start);
console.log(get() === start);
rmSync(dir, { recursive: true });
