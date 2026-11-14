// FileHandle whole-file reads and writes over the encoding ladder: every
// BufferEncoding name, the "buffer" pseudo-encoding Buffer.from refuses, the
// options record's own order (getOptions' type gate, assertEncoding, the
// signal's type, the flush checkbox, then the data), the abort check before
// the first byte, and the fallbacks of write(string, position, encoding).
// Each case reports the scratch file's bytes, so stdout decides them.
import * as fs from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-fh-encodings-"));
const file = path.join(dir, "file.bin");

// Keeps the record's shape out of the call's static type, as Node's own
// callers can.
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
        JSON.stringify(clean(error.message)),
        JSON.stringify(bytes()),
      );
    } else {
      console.log(label, "non-error", JSON.stringify(bytes()));
    }
  }
}

/* Every handle the cases below open is closed, including when the call
 * under test rejects, so Node's garbage-collection warnings cannot differ
 * between the two runs. */
async function onHandle(mode: string, run: (handle: FileHandle) => Promise<void>): Promise<void> {
  const handle = await open(file, mode);
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

async function readWith(
  label: string,
  run: (handle: FileHandle) => Promise<unknown>,
): Promise<void> {
  const handle = await open(file, "r");
  try {
    const value = await run(handle);
    if (typeof value === "string") {
      console.log("read", label, "text", JSON.stringify(value));
    } else {
      const buffer = value as Buffer;
      console.log("read", label, "bytes", buffer.toString("hex"));
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    console.log(
      "read",
      label,
      error instanceof Error ? error.name : "value",
      JSON.stringify(errno.code),
      JSON.stringify(String(error instanceof Error ? error.message : error)),
    );
  } finally {
    await handle.close();
  }
}

// readFile decodes every BufferEncoding name, and the bare form answers the
// bytes. Each read starts at the descriptor's current offset (here 0).
fs.writeFileSync(file, "héllo wörld");
for (const encoding of [
  "utf8",
  "utf-8",
  "latin1",
  "binary",
  "ascii",
  "base64",
  "base64url",
  "hex",
  "ucs2",
  "ucs-2",
  "utf16le",
  "UTF8",
] as BufferEncoding[]) {
  await readWith(encoding, (handle) => handle.readFile(encoding));
}
await readWith("buffer", (handle) => handle.readFile());
await readWith("{ encoding }", (handle) => handle.readFile({ encoding: "latin1" }));
// assertEncoding passes the name "buffer", and StringDecoder refuses it.
await readWith("buffer name", (handle) => handle.readFile("buffer" as BufferEncoding));
await readWith("{ buffer name }", (handle) => handle.readFile({ encoding: "buffer" as BufferEncoding }));
await readWith("bogus name", (handle) => handle.readFile("bogus" as BufferEncoding));

// writeFile encodes string data in the record's name and writes a view's
// bytes as they are.
await attempt("write latin1", "", () =>
  onHandle("w", (handle) => handle.writeFile("héllo", { encoding: "latin1" })),
);
await attempt("write latin1 short", "", () => onHandle("w", (handle) => handle.writeFile("héllo", "latin1")));
await attempt("write utf8", "", () => onHandle("w", (handle) => handle.writeFile("héllo")));
await attempt("write null options", "", () => onHandle("w", (handle) => handle.writeFile("héllo", null)));
await attempt("write hex", "", () =>
  onHandle("w", (handle) => handle.writeFile("48656c6c6f", { encoding: "hex" })),
);
await attempt("write base64url", "", () =>
  onHandle("w", (handle) => handle.writeFile("aGk", { encoding: "base64url" })),
);
await attempt("write ucs2", "", () =>
  onHandle("w", (handle) => handle.writeFile("hi", { encoding: "ucs2" })),
);
await attempt("write empty name", "", () =>
  onHandle("w", (handle) => handle.writeFile("héllo", { encoding: "" as BufferEncoding })),
);
await attempt("write buffer name", "aa", () =>
  onHandle("w", (handle) => handle.writeFile("hi", { encoding: "buffer" as BufferEncoding })),
);
await attempt("write buffer name string", "aa", () =>
  onHandle("w", (handle) => handle.writeFile("hi", "buffer" as BufferEncoding)),
);
await attempt("write bogus name", "aa", () =>
  onHandle("w", (handle) => handle.writeFile("hi", { encoding: "bogus" as BufferEncoding })),
);
// assertEncoding passes falsy non-strings (the encode then defaults to
// utf8); truthy ones are invalid names.
await attempt("write encoding 0", "", () => onHandle("w", (handle) => handle.writeFile("hi", opts({ encoding: 0 }))));
await attempt("write encoding false", "", () =>
  onHandle("w", (handle) => handle.writeFile("hi", opts({ encoding: false }))),
);
await attempt("write encoding true", "aa", () =>
  onHandle("w", (handle) => handle.writeFile("hi", opts({ encoding: true }))),
);
await attempt("write view", "", () =>
  onHandle("w", (handle) => handle.writeFile(new Uint8Array([0x61, 0x62]), opts({ encoding: "buffer" }))),
);
await attempt("write view bogus", "aa", () =>
  onHandle("w", (handle) => handle.writeFile(new Uint8Array([0x61, 0x62]), opts({ encoding: "bogus" }))),
);

// getOptions' primitive gate, then the signal's type and the flush boolean,
// each reported before the data is read.
await attempt("options number", "aa", () => onHandle("w", (handle) => handle.writeFile("hi", opts(5))));
await attempt("options true", "aa", () => onHandle("w", (handle) => handle.writeFile("hi", opts(true))));
await attempt("encoding before flush", "aa", () =>
  onHandle("w", (handle) => handle.writeFile("hi", opts({ encoding: "bogus", flush: 1 }))),
);
await attempt("signal before flush", "aa", () =>
  onHandle("w", (handle) => handle.writeFile("hi", opts({ signal: null, flush: 1 }))),
);
await attempt("flush before data", "aa", () =>
  onHandle("w", (handle) => handle.writeFile(dyn(5), opts({ flush: "yes" }))),
);
await attempt("flush true", "", () => onHandle("w", (handle) => handle.writeFile("hi", opts({ flush: true }))));
await attempt("flush null", "", () => onHandle("w", (handle) => handle.writeFile("hi", opts({ flush: null }))));
await attempt("flush number", "aa", () =>
  onHandle("w", (handle) => handle.writeFile("hi", opts({ flush: 1 }))),
);
await attempt("data number", "aa", () => onHandle("w", (handle) => handle.writeFile(dyn(5), opts({}))));
await attempt("data null", "aa", () => onHandle("w", (handle) => handle.writeFile(dyn(null), opts({}))));

// The abort check runs after the encode and before the first byte.
const stopped = new AbortController();
stopped.abort(new Error("stop"));
await attempt("aborted", "aabb", () =>
  onHandle("r+", (handle) => handle.writeFile("A", opts({ signal: stopped.signal }))),
);
await attempt("aborted buffer name", "aabb", () =>
  onHandle("r+", (handle) => handle.writeFile("A", opts({ encoding: "buffer", signal: stopped.signal }))),
);
await attempt("signal bad", "aabb", () =>
  onHandle("r+", (handle) => handle.writeFile("A", opts({ signal: {} }))),
);
await attempt("signal live", "", () =>
  onHandle("w", (handle) => handle.writeFile("A", opts({ signal: new AbortController().signal }))),
);

// A handle's writeFile never truncates or opens: flag and mode are ignored,
// and the bytes land at the descriptor's current offset.
await attempt("flag ignored", "aabbccdd", () =>
  onHandle("r+", (handle) => handle.writeFile("Z", opts({ flag: 5, mode: "bogus" }))),
);
await attempt("append at offset", "aabbccdd", () => onHandle("a", (handle) => handle.writeFile("Z")));
await attempt("append encoding", "aabb", () =>
  onHandle("a", (handle) => handle.appendFile("é", { encoding: "latin1" })),
);
await attempt("append bogus", "aabb", () =>
  onHandle("a", (handle) => handle.appendFile("é", { encoding: "bogus" as BufferEncoding })),
);

// A closed handle reports its EBADF before any argument is looked at.
await attempt("closed bad encoding", "aa", async () => {
  const handle = await open(file, "w");
  await handle.close();
  await handle.writeFile("hi", { encoding: "bogus" as BufferEncoding });
});

// write(string, position, encoding) normalizes the name and falls back to
// utf8 for one it does not know.
for (const encoding of ["utf8", "latin1", "ucs2", "bogus", "buffer"] as BufferEncoding[]) {
  await attempt(`write string ${JSON.stringify(encoding)}`, "", async () => {
    await onHandle("w", async (handle) => {
      const result = await handle.write("é", 0, encoding);
      console.log("write string count", JSON.stringify(encoding), result.bytesWritten, JSON.stringify(result.buffer));
    });
  });
}

// The data's own encoding of a whole-file write advances the descriptor, so
// two writes in a row append to each other.
await attempt("two writes append", "", () =>
  onHandle("w", async (handle) => {
    await handle.writeFile("ab", { encoding: "hex" });
    await handle.writeFile("cd", { encoding: "hex" });
  }),
);

fs.rmSync(dir, { recursive: true, force: true });
console.log("done", !fs.existsSync(dir));
