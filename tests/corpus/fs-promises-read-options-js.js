// fsPromises.readFile options from untyped code: Node's getOptions ladder
// accepts an encoding string, an object (or array, or function) of members,
// and a nullish value, rejects every other kind with ERR_INVALID_ARG_TYPE,
// validates the encoding name before anything else, then the signal, and
// only then opens with the flag. The encoding picks the result kind; a
// write-only flag opens and fails the read.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "fsp-read-js-"));
const file = join(root, "f.txt");
const missing = join(root, "missing.txt");
await writeFile(file, "hello");

const clean = (text) => text.split(root).join("<dir>").replace(/fsp-read-js-[A-Za-z0-9]{6}/g, "fsp-read-js-<name>");

const show = (label, value) => {
  if (value instanceof Uint8Array) console.log(label, "bytes", value.length, Buffer.from(value).toString("utf8"));
  else console.log(label, JSON.stringify(value));
};

const attempt = async (label, run) => {
  try {
    show(label, await run());
  } catch (error) {
    const e = error;
    console.log(label, "threw", e.name, e.code, e.syscall === undefined ? "-" : e.syscall, JSON.stringify(clean(e.message)));
  }
};

// The options kind: anything but a string, an object-ish value, or a nullish
// one is Node's ERR_INVALID_ARG_TYPE.
await attempt("number", () => readFile(file, 42));
await attempt("boolean", () => readFile(file, true));
await attempt("nullish", () => readFile(file, null));
await attempt("array", () => readFile(file, []));
await attempt("unknown key", () => readFile(file, { nope: 1 }));

// The encoding name is validated first: a bad name wins over a bad flag.
await attempt("bad encoding", () => readFile(file, { encoding: "bogus" }));
await attempt("encoding number", () => readFile(file, { encoding: 5 }));
await attempt("encoding empty", () => readFile(file, { encoding: "" }));
await attempt("encoding buffer", () => readFile(file, { encoding: "buffer" }));
await attempt("buffer shorthand", () => readFile(file, "buffer"));
await attempt("bad encoding and flag", () => readFile(file, { flag: "zw", encoding: "bogus" }));
await attempt("bad flag", () => readFile(file, { flag: "zw" }));

// A stored record reads at the call.
const stored = { encoding: "bogus" };
await attempt("stored bad encoding", () => readFile(file, stored));

// The signal member: an AbortSignal is required, and an aborted one
// rejects before the open.
await attempt("signal object", () => readFile(file, { signal: {} }));
await attempt("signal null", () => readFile(file, { signal: null }));
await attempt("signal function", () => readFile(file, { signal: () => {} }));
await attempt("signal true", () => readFile(file, { signal: { aborted: true } }));
await attempt("signal false", () => readFile(file, { signal: { aborted: false } }));
await attempt("signal undefined", () => readFile(file, { signal: undefined }));
const controller = new AbortController();
controller.abort();
await attempt("signal aborted", () => readFile(file, { signal: controller.signal }));

// The options ladders run before the path: a bad encoding wins over a path
// that cannot be validated, and the path's own error follows.
await attempt("bad path bad encoding", () => readFile(123, { encoding: "bogus" }));
await attempt("bad path", () => readFile(123, {}));
await attempt("buffer path", () => readFile(Buffer.from(file)));

// The flag: a numeric value is a raw open flag, and a write-only open
// leaves the read with EBADF.
await attempt("flag number", () => readFile(file, { flag: 0 }));
await attempt("flag null", () => readFile(file, { flag: null }));
await attempt("flag r plus", () => readFile(file, { flag: "r+" }));

await rm(root, { recursive: true, force: true });
