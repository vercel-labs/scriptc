// @requires-libnode
// The working directory is one state for the program and the package it
// runs in a Node island. Node caches process.cwd() until its own
// process.chdir runs, so a directory the program changes to must reach
// island code too, and the other way round.
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chdir, cwdName, resolved } from "process-state";

const root = realpathSync(mkdtempSync(join(tmpdir(), "island-cwd-")));
mkdirSync(join(root, "first"));
mkdirSync(join(root, "second"));
mkdirSync(join(root, "third"));
const here = (): string => basename(process.cwd());

process.chdir(join(root, "first"));
// The first island call starts Node, in the directory the program is in.
console.log(cwdName(), here());
process.chdir(join(root, "second"));
console.log(cwdName(), here(), resolved("file.txt"));
chdir(join(root, "third"));
console.log(cwdName(), here());
process.chdir("../first");
console.log(cwdName(), here(), resolved("file.txt"));
chdir("../second");
process.chdir("../third");
console.log(cwdName(), here());

process.chdir(tmpdir());
rmSync(root, { recursive: true });
