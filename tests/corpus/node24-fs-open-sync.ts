import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = fs.mkdtempSync(join(tmpdir(), "scriptc-open-"));
const under = (name: string): string => join(root, name);

function show(label: string, run: () => unknown): void {
  try {
    console.log(label, "ok", String(run()));
  } catch (error) {
    const e = error as { name?: string; code?: string; message?: string };
    console.log(label, e.name, e.code, String(e.message).replace(root, "<root>"));
  }
}

/** The error's identity without its message, for shapes whose inspected
 * receipt the runtime only approximates. */
function code(label: string, run: () => unknown): void {
  try {
    console.log(label, "ok", String(run()));
  } catch (error) {
    const e = error as { name?: string; code?: string };
    console.log(label, e.name, e.code);
  }
}

function withFd(label: string, flags: string | number, use: (fd: number) => void): void {
  const fd = fs.openSync(under("probe.txt"), flags);
  try {
    use(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log(label, "opened");
}

fs.writeFileSync(under("data.txt"), "one\ntwo\n");

// The string flag grammar reads and writes the same files Node does.
show("read", () => fs.readFileSync(under("data.txt"), "utf8"));
show("write", () => {
  const fd = fs.openSync(under("written.txt"), "w");
  fs.writeFileSync(fd, "written");
  fs.closeSync(fd);
  return fs.readFileSync(under("written.txt"), "utf8");
});
show("append", () => {
  const fd = fs.openSync(under("data.txt"), "a");
  fs.writeFileSync(fd, "three\n");
  fs.closeSync(fd);
  return fs.readFileSync(under("data.txt"), "utf8").length;
});
show("exclusive creates", () => {
  const fd = fs.openSync(under("excl.txt"), "wx");
  fs.closeSync(fd);
  return fs.existsSync(under("excl.txt"));
});
show("exclusive exists", () => fs.openSync(under("excl.txt"), "wx"));
show("missing", () => fs.openSync(under("absent.txt"), "r"));
show("directory", () => fs.openSync(under(""), "r") >= 0);
show("null byte path", () => fs.openSync(under("nul\0byte.txt"), "r"));

// The creation mode is a number or an octal string.
show("mode number", () => {
  const fd = fs.openSync(under("mode-number.txt"), "w", 0o600);
  fs.closeSync(fd);
  return fs.statSync(under("mode-number.txt")).mode & 0o777;
});
show("mode octal string", () => {
  const fd = fs.openSync(under("mode-string.txt"), "w", "640");
  fs.closeSync(fd);
  return fs.statSync(under("mode-string.txt")).mode & 0o777;
});
show("mode bad octal", () => fs.openSync(under("bad.txt"), "w", "999"));
show("mode empty octal", () => fs.openSync(under("bad.txt"), "w", ""));
show("mode octal overflow", () => fs.openSync(under("bad.txt"), "w", "77777777777777"));
show("mode range", () => fs.openSync(under("bad.txt"), "w", 4294967296));
show("mode negative", () => fs.openSync(under("bad.txt"), "w", -1));
show("mode fraction", () => fs.openSync(under("bad.txt"), "w", 1.5));
show("flag bad string", () => fs.openSync(under("bad.txt"), "qq"));
show("flag upper case", () => fs.openSync(under("bad.txt"), "R"));

// Numeric flags reach open(2) as Node's binding passes them: the
// fs.constants bits are open(2)'s own.
const writeCreate = fs.constants.O_WRONLY | fs.constants.O_CREAT;
show("numeric flags", () => {
  const fd = fs.openSync(under("numeric.txt"), writeCreate, 0o600);
  fs.closeSync(fd);
  return fs.existsSync(under("numeric.txt"));
});
show("numeric flags mode", () => {
  const fd = fs.openSync(under("numeric-mode.txt"), fs.constants.O_WRONLY | fs.constants.O_CREAT, "644");
  fs.closeSync(fd);
  return fs.statSync(under("numeric-mode.txt")).mode & 0o777;
});
show("numeric read only", () => fs.openSync(under("data.txt"), fs.constants.O_RDONLY) >= 0);
show("numeric missing", () => fs.openSync(under("absent.txt"), fs.constants.O_RDONLY));
show("numeric fraction", () => fs.openSync(under("bad.txt"), 1.5));
show("numeric huge", () => fs.openSync(under("bad.txt"), 2147483648));
show("numeric negative", () => fs.openSync(under("bad.txt"), -5));
const badFlags: any = true;
show("flag boolean", () => fs.openSync(under("bad.txt"), badFlags));
// The message's inspected receipt of an object is a documented divergence
// (the runtime prints "{ ... }"), so this case pins the error's identity.
const objectFlags: any = {};
code("flag object", () => fs.openSync(under("bad.txt"), objectFlags));
const nullFlags: any = null;
show("flag null", () => fs.openSync(under("null-flags.txt"), nullFlags) >= 0);
const undefinedMode: any = null;
show("mode null", () => fs.openSync(under("null-mode.txt"), "w", undefinedMode) >= 0);

withFd("with fd", "w", (fd) => {
  console.log("fd is number", typeof fd === "number", fd >= 0);
});

console.log("no stray files", fs.existsSync(under("bad.txt")));
fs.rmSync(root, { recursive: true, force: true });
