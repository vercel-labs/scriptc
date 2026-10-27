// URL paths whose conversion would run in a different order than Node's.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

const url = new URL("file:///tmp/fs-url-path-fences");
const recursive = process.argv.length > 9;

// Node validates the options before the path.
fs.mkdirSync(url, { recursive });
void fsp.mkdir(url, { recursive });
// A literal's members are lowered one by one, so they cannot be evaluated
// ahead of the conversion as one value.
console.log(fs.statSync(url, { throwIfNoEntry: process.argv.length > 9 }));
// fs.promises checks the string source inside the call, after the
// conversion would have run.
void fsp.copyFile("/tmp/source", url);
