// fsPromises.chmod from untyped code: parseFileMode's whole ladder — a
// number in 0..2^32-1 or an octal string, then Node's exact errors for
// everything else — reached through the checked-dynamic lane. The path is
// validated before the mode, and lchmod is Node's Linux stub, rejecting
// with ERR_METHOD_NOT_IMPLEMENTED before either argument is looked at.
import { chmod, lchmod, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "fsp-chmod-js-"));
const file = join(root, "f.txt");
const missing = join(root, "missing.txt");
await writeFile(file, "x");

const clean = (text) => text.split(root).join("<dir>");
const perms = async () => ((await stat(file)).mode & 0o777).toString(8);

const attempt = async (label, run) => {
  try {
    const value = await run();
    console.log(label, "ok", value === undefined ? "undefined" : String(value));
  } catch (error) {
    const e = error;
    console.log(label, "threw", e.name, e.code, JSON.stringify(clean(e.message)));
  }
};

// The mode ladder: numbers in range and octal strings pass.
await attempt("mode number", () => chmod(file, 0o600));
console.log("after number", await perms());
await attempt("mode octal", () => chmod(file, "644"));
console.log("after octal", await perms());
await attempt("mode leading zero", () => chmod(file, "0640"));
console.log("after leading zero", await perms());

// Everything else: validateUint32's wording, or the octal-string wording.
await attempt("mode 0o644 string", () => chmod(file, "0o644"));
await attempt("mode rw", () => chmod(file, "rw"));
await attempt("mode empty", () => chmod(file, ""));
await attempt("mode negative", () => chmod(file, -1));
await attempt("mode too large", () => chmod(file, 2 ** 32));
await attempt("mode fraction", () => chmod(file, 1.5));
await attempt("mode NaN", () => chmod(file, NaN));
await attempt("mode null", () => chmod(file, null));
await attempt("mode undefined", () => chmod(file, undefined));
await attempt("mode boolean", () => chmod(file, true));
await attempt("mode record", () => chmod(file, {}));
await attempt("mode buffer", () => chmod(file, Buffer.from("644")));

// The path is validated first: its own error wins over a bad mode.
await attempt("missing bad mode", () => chmod(missing, "rw"));
await attempt("missing good mode", () => chmod(missing, 0o644));
await attempt("path number", () => chmod(123, 0o644));

// lchmod rejects with the stub whatever the arguments are.
await attempt("lchmod octal", () => lchmod(file, "644"));
await attempt("lchmod bad mode", () => lchmod(file, "rw"));
await attempt("lchmod missing", () => lchmod(missing, 0o644));
await attempt("lchmod path number", () => lchmod(123, 0o644));

await rm(root, { recursive: true, force: true });
