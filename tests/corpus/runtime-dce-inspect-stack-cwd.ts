// A colored error stack marks the working directory through
// pathToFileURL(cwd).href: a directory carrying a space, '#', '%', '?' and
// non-ASCII bytes must encode exactly as Node's pathToFileURL spells it.
// The frames here carry the href rather than the raw path, so the coloring
// matches only through that encoding: any encoder the inspect unit uses for
// the working directory must spell it byte-for-byte as pathToFileURL does.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as util from "node:util";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "runtime-dce-inspect-"));
const dir = join(root, "sub dir #%? ü");
mkdirSync(dir);
process.chdir(dir);

const href = pathToFileURL(process.cwd()).href;
const error = new Error("boom");
error.stack = `Error: boom\n    at demo (${href}/main.ts:1:1)\n    at other (${href}/x y.js:2:2)`;
const rendered = util.inspect(error, { colors: true, depth: 0 });
const marker = root.slice(root.lastIndexOf("/") + 1);
console.log(rendered.split(marker).join("<TMP>"));

process.chdir(tmpdir());
rmSync(root, { recursive: true, force: true });
