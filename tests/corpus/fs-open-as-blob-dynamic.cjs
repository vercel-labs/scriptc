// fs.openAsBlob from untyped code: every argument arrives as a dynamic
// value, the way a JavaScript caller's shapes reach the runtime — the
// synchronous ladder (options object, its `type` string, the path's type
// and null bytes, the stat) runs on values the compiler cannot type, and
// the file-backed Blob's members come back through dynamic slots.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const any = (value) => /** @type {any} */ (value);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-open-as-blob-dyn-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello world");
const clean = (text) => String(text).split(dir).join("<dir>");

function attempt(label, run) {
  try {
    const value = run();
    console.log(label, "ok", value instanceof Promise);
  } catch (error) {
    console.log(label, "throw", error.code, "|", clean(error.message));
  }
}

// A wrapper in another module of the program: parameters are `any`, so the
// call site crosses into the runtime with dynamic arguments.
const open = (target, options) => fs.openAsBlob(target, options);

attempt("missing args", () => fs.openAsBlob());
attempt("undefined options", () => open(file, undefined));
attempt("null options", () => open(file, null));
attempt("array options", () => open(file, [1]));
attempt("string options", () => open(file, "x"));
attempt("string object", () => open(file, new String("x")));
attempt("function options", () => open(file, function () {}));
attempt("empty options", () => open(file, {}));
attempt("type string", () => open(file, { type: "A/B" }));
attempt("type number", () => open(file, { type: 7 }));
attempt("type null", () => open(file, { type: null }));
attempt("type getter", () =>
  open(file, {
    get type() {
      throw new Error("boom");
    },
  }),
);
attempt("order", () => open(9, { type: 9 }));
attempt("number path", () => open(9));
attempt("boolean path", () => open(true));
attempt("symbol path", () => open(Symbol("p")));
attempt("no path", () => open());
attempt("empty path", () => open(""));
attempt("missing file", () => open(path.join(dir, "gone.txt")));
attempt("scheme", () => open(new URL("https://example.invalid/x")));
attempt("nul path", () => open("a\0b"));
attempt("nul bytes", () => open(Buffer.from("a\0b")));

async function main() {
  const holder = any({ blob: await fs.openAsBlob(file, any({ type: "Text/Plain" })) });
  const blob = holder.blob;
  console.log("blob", blob instanceof Blob, blob.size, JSON.stringify(blob.type));
  console.log("name", String(blob.name), await blob.text());
  console.log("slice", await any(blob.slice(6)).text(), blob.slice(0, 5).size);
  console.log("bytes", (await any(blob).bytes()).length);

  // The untyped ladder keeps the file-backed laziness: a dynamic slice after
  // the file changed answers the NotReadableError.
  const lazy = any({ blob: await fs.openAsBlob(file) });
  fs.writeFileSync(file, "HELLO WORLD");
  try {
    await lazy.blob.text();
  } catch (error) {
    console.log("lazy", any(error).name);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

void main();
