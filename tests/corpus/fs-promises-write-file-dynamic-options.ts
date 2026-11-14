// fs/promises.writeFile and appendFile with an options record whose shape the
// call site does not pin down: the encoding ladder over string data (hex,
// base64, base64url, ucs2, and the "buffer" pseudo-encoding Buffer.from
// rejects), flag names and numbers, flush, the mode ladder, view data, the
// getOptions primitive gate, the signal and abort checks, and the open(2)
// errors. Each case reports the file's bytes afterwards.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-fsp-writeopts-"));
const file = path.join(dir, "file.txt");

// Keeps the record's shape out of the call's static type.
const opts = (value: any): any => value;
// Keeps a value the types would reject out of the argument's static type.
const dyn = (value: any): any => value;

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

function bytes(): string {
  try {
    return fs.readFileSync(file).toString("hex");
  } catch {
    return "<missing>";
  }
}

async function attempt(label: string, seed: string, run: () => Promise<unknown>): Promise<void> {
  fs.writeFileSync(file, Buffer.from(seed, "hex"));
  try {
    await run();
    console.log(label, "ok", JSON.stringify(bytes()));
  } catch (error) {
    if (error instanceof Error) {
      const errno = error as NodeJS.ErrnoException;
      console.log(
        label,
        error.name,
        JSON.stringify(errno.code),
        JSON.stringify(errno.syscall),
        JSON.stringify(clean(error.message)),
        JSON.stringify(bytes()),
      );
    } else {
      console.log(label, "non-error", JSON.stringify(bytes()));
    }
  }
}

await attempt("latin1", "", () => fsp.writeFile(file, "héllo", opts({ encoding: "latin1" })));
await attempt("utf8", "", () => fsp.writeFile(file, "héllo", opts({ encoding: "utf8" })));
await attempt("hex", "", () => fsp.writeFile(file, "48656c6c6f", opts({ encoding: "hex" })));
await attempt("base64", "", () => fsp.writeFile(file, "SGk=", opts({ encoding: "base64" })));
await attempt("base64url", "", () => fsp.writeFile(file, "aGk", opts({ encoding: "base64url" })));
await attempt("ucs2", "", () => fsp.writeFile(file, "hi", opts({ encoding: "ucs2" })));
// Buffer.from refuses to encode *into* "buffer", the name assertEncoding
// lets through.
await attempt("buffer name", "aa", () => fsp.writeFile(file, "hi", opts({ encoding: "buffer" })));
await attempt("bogus name", "aa", () => fsp.writeFile(file, "hi", opts({ encoding: "bogus" })));
// assertEncoding passes falsy non-strings; truthy ones are invalid.
await attempt("encoding 0", "aa", () => fsp.writeFile(file, "hi", opts({ encoding: 0 })));
await attempt("encoding false", "aa", () => fsp.writeFile(file, "hi", opts({ encoding: false })));
await attempt("encoding null", "aa", () => fsp.writeFile(file, "hi", opts({ encoding: null })));
await attempt("encoding true", "aa", () => fsp.writeFile(file, "hi", opts({ encoding: true })));

// getOptions' primitive gate: a string is the encoding-only spelling, a
// function is the defaults, and the other primitives are rejected.
await attempt("options string", "aa", () => fsp.writeFile(file, "6869", opts("hex")));
await attempt("options function", "aa", () => fsp.writeFile(file, "hi", opts(() => undefined)));
await attempt("options true", "aa", () => fsp.writeFile(file, "hi", opts(true)));
await attempt("options number", "aa", () => fsp.writeFile(file, "hi", opts(1)));

// `options.flag || "w"`, with the name table and validateInt32 behind it.
await attempt("flag append", "aabb", () => fsp.writeFile(file, "!", opts({ flag: "a" })));
await attempt("flag nothing", "aabb", () => fsp.writeFile(file, "!", opts({ flag: "r" })));
await attempt("flag existing", "aabb", () => fsp.writeFile(file, "!", opts({ flag: "wx" })));
await attempt("flag name", "aabb", () => fsp.writeFile(file, "!", opts({ flag: "zz" })));
await attempt("flag null", "aabb", () => fsp.writeFile(file, "!", opts({ flag: null })));
await attempt("flag number", "aabb", () => fsp.writeFile(file, "!", opts({ flag: 1 })));
await attempt("flag fractional", "aabb", () => fsp.writeFile(file, "!", opts({ flag: 1.5 })));
await attempt("flag boolean", "aabb", () => fsp.writeFile(file, "!", opts({ flag: true })));

await attempt("flush", "aabb", () => fsp.writeFile(file, "!", opts({ flush: true })));
await attempt("flush null", "aabb", () => fsp.writeFile(file, "!", opts({ flush: null })));
await attempt("flush number", "aabb", () => fsp.writeFile(file, "!", opts({ flush: 1 })));

// parseFileMode: a number or an octal string, validated as uint32.
await attempt("mode number", "aabb", () => fsp.writeFile(file, "!", opts({ mode: 0o600 })));
await attempt("mode string", "aabb", () => fsp.writeFile(file, "!", opts({ mode: "640" })));
await attempt("mode negative", "aabb", () => fsp.writeFile(file, "!", opts({ mode: -1 })));
await attempt("mode fractional", "aabb", () => fsp.writeFile(file, "!", opts({ mode: 1.5 })));
await attempt("mode boolean", "aabb", () => fsp.writeFile(file, "!", opts({ mode: true })));
console.log(
  "modes",
  (fs.statSync(file).mode & 0o777).toString(8),
);

// The data: a view's bytes are written as-is, an encoding is not applied to
// them, and anything else is ERR_INVALID_ARG_TYPE after the record.
await attempt("data view", "aabb", () => fsp.writeFile(file, new Uint8Array([0x61, 0x62]), opts({})));
await attempt("data view encoding", "aabb", () =>
  fsp.writeFile(file, new Uint8Array([0x61, 0x62]), opts({ encoding: "hex" })),
);
await attempt("data number", "aabb", () => fsp.writeFile(file, dyn(5), opts({})));
await attempt("data null", "aabb", () => fsp.writeFile(file, dyn(null), opts({})));

// The abort check runs before the open.
const stopped = new AbortController();
stopped.abort(new Error("stop"));
await attempt("aborted", "aabb", () => fsp.writeFile(file, "A", opts({ signal: stopped.signal })));
await attempt("signal bad", "aabb", () => fsp.writeFile(file, "A", opts({ signal: {} })));
await attempt("signal null", "aabb", () => fsp.writeFile(file, "A", opts({ signal: null })));
await attempt("signal live", "aabb", () => fsp.writeFile(file, "A", opts({ signal: new AbortController().signal })));

// open(2)'s own error, after every record check passed.
await attempt("missing parent", "aabb", () =>
  fsp.writeFile(path.join(dir, "missing", "file.txt"), "A", opts({ mode: 1.5 })),
);
await attempt("missing parent ok", "aabb", () =>
  fsp.writeFile(path.join(dir, "missing", "file.txt"), "A", opts({})),
);

// appendFile: the flag defaults to "a" but the record may still choose
// truncation, and the encoding ladder is the same.
await attempt("append", "aabb", () => fsp.appendFile(file, "!", opts({})));
await attempt("append encoding", "aabb", () => fsp.appendFile(file, "21", opts({ encoding: "hex" })));
await attempt("append flag", "aabb", () => fsp.appendFile(file, "Z", opts({ flag: "w" })));
await attempt("append flush", "aabb", () => fsp.appendFile(file, "!", opts({ flush: true })));
await attempt("append function", "aabb", () => fsp.appendFile(file, "?", opts(() => undefined)));
await attempt("append flush number", "aabb", () => fsp.appendFile(file, "?", opts({ flush: 1 })));
const created = path.join(dir, "created.txt");
fs.rmSync(created, { force: true });
await fsp.appendFile(created, "N", opts({ mode: 0o640 }));
console.log("append created", fs.readFileSync(created, "utf8"), (fs.statSync(created).mode & 0o777).toString(8));

// The three argument expressions are evaluated left to right, whether the
// record takes the general path or the utf8-only fast path.
const order: string[] = [];
function at<T>(label: string, value: T): T {
  order.push(label);
  return value;
}
await fsp.writeFile(at("path", file), at("data", "6475"), at("options", { encoding: at("encoding", "hex") }));
console.log("order", order.join(","), bytes());
order.length = 0;
await fsp.writeFile(at("path", file), at("data", "x"), at("options", { encoding: "utf8" }));
console.log("fast order", order.join(","), bytes());

fs.rmSync(dir, { recursive: true, force: true });
console.log("done", !fs.existsSync(dir));
