import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = fs.mkdtempSync(join(tmpdir(), "scriptc-mkdir-"));
const under = (name: string): string => join(root, name);

function show(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "ok", value === undefined ? "undefined" : String(value).replace(root, "<root>"));
  } catch (error) {
    const e = error as { name?: string; code?: string; message?: string };
    console.log(label, e.name, e.code, String(e.message).replace(root, "<root>"));
  }
}

const isDir = (path: string): boolean => fs.statSync(path).isDirectory();
const perm = (path: string): number => fs.statSync(path).mode & 0o777;

// The single-directory forms answer undefined; the path is created with the
// mode the options name (a number or an octal string).
show("plain", () => fs.mkdirSync(under("plain")));
console.log("plain dir", isDir(under("plain")));
show("mode number", () => fs.mkdirSync(under("mode-number"), 0o700));
console.log("mode number dir", isDir(under("mode-number")));
show("mode octal string", () => fs.mkdirSync(under("mode-string"), "700"));
console.log("mode octal string dir", isDir(under("mode-string")));
show("mode object number", () => fs.mkdirSync(under("obj-number"), { mode: 0o750 }));
show("mode object octal string", () => fs.mkdirSync(under("obj-string"), { mode: "750" }));
show("options null", () => fs.mkdirSync(under("null-options"), null));
const truthy: any = true;
show("options true", () => fs.mkdirSync(under("true-options"), truthy));
const falsy: any = false;
show("options false", () => fs.mkdirSync(under("false-options"), falsy));
show("recursive false", () => fs.mkdirSync(under("flat"), { recursive: false }));

// The recursive walk answers the first directory it created, and undefined
// when everything already existed. A chmod'd directory pins the mode the
// walk used (the process umask applies to mkdir itself).
show("recursive true", () => fs.mkdirSync(under("deep/a/b"), { recursive: true }));
console.log("recursive true dirs", isDir(under("deep")), isDir(under("deep/a")), isDir(under("deep/a/b")));
show("recursive true again", () => fs.mkdirSync(under("deep/a/b"), { recursive: true }));
const walked: string | undefined = fs.mkdirSync(under("walked/x/y"), { recursive: true });
console.log("recursive value", walked === under("walked"), isDir(under("walked/x/y")));
const walkedExisting: string | undefined = fs.mkdirSync(under("walked/x"), { recursive: true });
console.log("recursive value existing", walkedExisting === undefined);
show("recursive mode", () => fs.mkdirSync(under("rmode/a"), { recursive: true, mode: 0o700 }));
fs.chmodSync(under("rmode"), 0o755);
show("recursive mode string", () => fs.mkdirSync(under("rmode2/a"), { recursive: true, mode: "700" }));

// Node's option ladder: path first, then the options' own validation.
show("exists", () => fs.mkdirSync(under("plain")));
show("missing parent", () => fs.mkdirSync(under("nope/a")));
show("file exists", () => fs.mkdirSync(join(root, "plain", "..", "plain")));
show("bad octal", () => fs.mkdirSync(under("bad"), "999"));
show("empty octal", () => fs.mkdirSync(under("bad"), ""));
show("octal overflow", () => fs.mkdirSync(under("bad"), "77777777777777"));
show("negative mode", () => fs.mkdirSync(under("bad"), -1));
show("fraction mode", () => fs.mkdirSync(under("bad"), 1.5));
show("object bad octal", () => fs.mkdirSync(under("bad"), { mode: "999" }));
show("object octal overflow", () => fs.mkdirSync(under("bad"), { mode: "77777777777777" }));
show("object negative mode", () => fs.mkdirSync(under("bad"), { mode: -1 }));
show("object fraction mode", () => fs.mkdirSync(under("bad"), { mode: 1.5 }));
const badRecursive: any = "yes";
show("object bad recursive", () => fs.mkdirSync(under("bad"), { recursive: badRecursive }));
const badMode: any = null;
show("object null mode", () => fs.mkdirSync(under("bad"), { mode: badMode, recursive: false }));
show("missing path and bad mode", () => fs.mkdirSync(under("nope/b"), { mode: -1 }));
console.log("no stray dirs", fs.existsSync(under("bad")), fs.existsSync(under("nope")));

// A flag the compiler cannot fold still runs Node's ladder at run time.
const dynamicOptions: number | { recursive: boolean } = { recursive: true };
show("dynamic options", () => fs.mkdirSync(under("dynamic/a"), dynamicOptions));
show("dynamic mode", () => fs.mkdirSync(under("dynamic-mode"), "750" as number | string));
console.log("dynamic dirs", isDir(under("dynamic/a")), isDir(under("dynamic-mode")));

fs.rmSync(root, { recursive: true, force: true });
