// writeFileSync and appendFileSync over a file descriptor instead of a path:
// the two arms Node runs for string data under a utf8 encoding and for
// everything else, the descriptor range check that only the general arm
// performs, the flag and mode parsing that only the string-utf8 arm reaches,
// and the fsync that arm skips.
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-write-fd-"));
const file = (name: string): string => path.join(dir, name);
const text = (name: string): string => fs.readFileSync(file(name), "utf8");
const bytes = (name: string): string => fs.readFileSync(file(name)).toString("hex");
const enc = (name: string): BufferEncoding => name as BufferEncoding;

const report = (label: string, e: unknown): void => {
  if (e instanceof Error) {
    console.log(label, e.name, (e as NodeJS.ErrnoException).code, e.message.split(dir).join("<dir>"));
  } else console.log(label, "non-error", String(e));
};

// The descriptor stays open: each call writes from the current offset.
const fd = fs.openSync(file("fd.txt"), "w");
fs.writeFileSync(fd, "one");
fs.writeFileSync(fd, "two", "latin1");
fs.writeFileSync(fd, Buffer.from([0x2d]));
fs.writeFileSync(fd, "héllo", { encoding: "latin1" });
fs.closeSync(fd);
console.log("descriptor:", bytes("fd.txt"));

// appendFileSync over a descriptor is a plain write from the current
// offset; the flag it forces is "a" but the descriptor keeps its own.
const app = fs.openSync(file("append.txt"), "w");
fs.writeFileSync(app, "head-");
fs.appendFileSync(app, "tail");
fs.appendFileSync(app, new Uint8Array([0x2e]), { encoding: enc("buffer") });
fs.appendFileSync(app, "zz", { flag: "zz" });
fs.appendFileSync(app, "-end", { encoding: "latin1", mode: -1 });
fs.closeSync(app);
console.log("append:", text("append.txt"));

// The option values are evaluated in source order, before the write.
const order: string[] = [];
const echo = <T>(label: string, value: T): T => {
  order.push(label);
  return value;
};
const ordered = fs.openSync(file("order.txt"), "w");
fs.writeFileSync(ordered, echo("data", "v"), {
  mode: echo("mode", 0o600),
  encoding: echo("encoding", "latin1"),
  flush: echo("flush", false),
});
fs.closeSync(ordered);
console.log("order:", order.join(","), text("order.txt"));

// The encoding is validated before the descriptor is touched.
const bad = fs.openSync(file("bad.txt"), "w");
try {
  fs.writeFileSync(bad, "x", { encoding: enc("nope") });
} catch (e) {
  report("encoding-unknown", e);
}
try {
  fs.writeFileSync(bad, "x", { encoding: enc("buffer") });
} catch (e) {
  report("string-as-buffer", e);
}
fs.writeFileSync(bad, new Uint8Array([1, 2]), { encoding: enc("base64") });
fs.closeSync(bad);
console.log("bytes:", bytes("bad.txt"));

// A missing descriptor: the utf8 string arm reports the write failure
// without a path, and the general arm rejects the descriptor range first.
const plainFd = (label: string, run: () => void): void => {
  try {
    run();
    console.log(label, "ok");
  } catch (e) {
    report(label, e);
  }
};
plainFd("fd-utf8", () => fs.writeFileSync(-1, "x"));
plainFd("fd-utf8-named", () => fs.writeFileSync(-1, "x", { encoding: "utf8" }));
plainFd("fd-utf8-dash", () => fs.writeFileSync(-1, "x", "utf-8"));
plainFd("fd-append-utf8", () => fs.appendFileSync(-1, "x"));
plainFd("fd-record", () => fs.writeFileSync(-1, "x", {}));
plainFd("fd-latin1", () => fs.writeFileSync(-1, "x", { encoding: "latin1" }));
plainFd("fd-latin1-bare", () => fs.writeFileSync(-1, "x", "latin1"));
plainFd("fd-flush-only", () => fs.writeFileSync(-1, "x", { flush: true }));
plainFd("fd-empty-utf8", () => fs.writeFileSync(-1, ""));
plainFd("fd-empty-latin1", () => fs.writeFileSync(-1, "", { encoding: "latin1" }));
plainFd("fd-empty-flush", () => fs.writeFileSync(-1, "", { flush: true }));

// Only an int32 counts as a descriptor; anything else is a path of the
// wrong type, on both arms.
plainFd("fd-fractional", () => fs.writeFileSync(1.5, "x"));
plainFd("fd-nan", () => fs.writeFileSync(NaN, "x"));
plainFd("fd-overflow", () => fs.writeFileSync(4294967295, "x", { encoding: "latin1" }));

// The utf8 string arm parses the flag and the mode; the general arm does
// not look at either.
const flags = fs.openSync(file("flags.txt"), "w");
plainFd("fast-flag", () => fs.writeFileSync(flags, "x", { encoding: "utf8", flag: "zz" }));
plainFd("fast-flag-empty", () => fs.writeFileSync(flags, "x", { encoding: "utf8", flag: "" }));
plainFd("fast-mode", () => fs.writeFileSync(flags, "x", { encoding: "utf8", mode: 1e20 }));
plainFd("slow-flag", () => fs.writeFileSync(flags, "x", { encoding: "latin1", flag: "zz" }));
plainFd("append-flag", () => fs.appendFileSync(flags, "x", { encoding: "utf8", flag: "zz" }));
plainFd("append-mode", () => fs.appendFileSync(flags, "x", { encoding: "utf8", mode: -1 }));
fs.closeSync(flags);
console.log("flags:", text("flags.txt"));

// An encoding value whose type also admits undefined is absent at run time
// here: the record is read as written, so the general arm decides.
const pick = (value: string | undefined): string | undefined => value;
plainFd("maybe-undefined", () =>
  fs.writeFileSync(-1, "x", { encoding: pick(undefined) as BufferEncoding }),
);
plainFd("maybe-utf8", () => fs.writeFileSync(-1, "x", { encoding: pick("utf8") as BufferEncoding }));

// A pipe cannot be fsynced: the general arm's flush fails, the utf8 string
// arm never fsyncs. mkfifo gives a pipe on every non-Windows platform.
if (process.platform !== "win32") {
  const fifo = file("pipe");
  execFileSync("mkfifo", [fifo]);
  const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const writer = fs.openSync(fifo, "w");
  plainFd("pipe-flush", () => fs.writeFileSync(writer, "p", { flush: true }));
  plainFd("pipe-flush-utf8", () => fs.writeFileSync(writer, "q", { encoding: "utf8", flush: true }));
  plainFd("pipe-append-flush", () => fs.appendFileSync(writer, "r", "utf8"));
  fs.closeSync(writer);
  fs.closeSync(reader);
}

// A shared helper's string|Uint8Array parameter picks the entry from the
// live tag, as on the path forms.
function writeEither(target: number, data: string | Uint8Array): void {
  fs.writeFileSync(target, data, { encoding: "latin1" });
}
const either = fs.openSync(file("either.txt"), "w");
writeEither(either, "ab");
writeEither(either, new Uint8Array([0x63]));
fs.closeSync(either);
console.log("either:", bytes("either.txt"));

fs.rmSync(dir, { recursive: true, force: true });
console.log("removed:", !fs.existsSync(dir));
