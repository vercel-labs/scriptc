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

// '?' cannot name a Windows directory; the legal set (space, '#', '%', ü)
// still exercises percent-encoding on that platform.
const dirName = process.platform === "win32" ? "sub dir #% ü" : "sub dir #%? ü";
const root = mkdtempSync(join(tmpdir(), "runtime-dce-inspect-"));
const dir = join(root, dirName);
mkdirSync(dir);
// A relative chdir: getcwd still answers the absolute path the encoder sees.
process.chdir(root);
process.chdir(dirName);

const href = pathToFileURL(process.cwd()).href;
const error = new Error("boom");
error.stack = `Error: boom\n    at demo (${href}/main.ts:1:1)\n    at other (${href}/x y.js:2:2)`;
const rendered = util.inspect(error, { colors: true, depth: 0 });
// The random directory component, whichever separator the platform's tmpdir
// uses (win32 answers with backslashes).
const marker = root.split(/[\\/]/).pop() ?? root;
console.log(rendered.split(marker).join("<TMP>"));

process.chdir(tmpdir());
rmSync(root, { recursive: true, force: true });
