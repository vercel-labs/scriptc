// fs.existsSync over a URL held in an `any`.
// @normalize-pid
// A URL converts to a file path, so a file: URL answers whether the file
// exists, and a URL that names no file (https:) answers false. Node
// reports no DEP0187 for a URL, and the value form does not either.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const scratch = path.join(os.tmpdir(), `scr-exists-url-${process.pid} a%b.txt`);
fs.writeFileSync(scratch, "x");

const present: any = pathToFileURL(scratch);
const absent: any = new URL(pathToFileURL(scratch + ".absent").href);
const remote: any = new URL("https://example.com/");
const directory: any = pathToFileURL(os.tmpdir());

console.log("file url:", fs.existsSync(present));
console.log("missing file url:", fs.existsSync(absent));
console.log("https url:", fs.existsSync(remote));
console.log("directory url:", fs.existsSync(directory));
console.log("again:", fs.existsSync(present));

fs.unlinkSync(scratch);
