// fs functions given file: URL paths: the URL converts as fileURLToPath
// converts it, so names with spaces and non-ASCII characters reach the same
// file, and URLs with another scheme, a host or an encoded separator throw
// Node's errors.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fs-url-")));
const at = (name: string): URL => pathToFileURL(path.join(dir, name));
// Arguments after a URL path are evaluated before the URL converts.
function logged(name: string): URL {
  console.log("evaluated", name);
  return at(name);
}
function mode(): number {
  console.log("evaluated mode");
  return 0o600;
}
// A later argument that reassigns an earlier argument's variable runs after
// that argument was read.
let uid = -1;
function bumpUid(): number {
  uid = 123456;
  return -1;
}

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      console.log(label, error.name, code, clean(error.message));
    }
  }
}

const file = at("a b ü.txt");
fs.writeFileSync(file, "hello");
console.log(fs.readFileSync(file, "utf8"));
console.log(fs.readFileSync(file).length);
console.log(fs.readFileSync(file, { encoding: "utf8" }));
console.log(fs.readFileSync(file, "base64"));
fs.appendFileSync(file, " world");
fs.writeFileSync(at("bytes.bin"), new Uint8Array([1, 2, 3]));
fs.writeFileSync(at("mode.txt"), "m", { mode: 0o600 });
console.log(fs.readFileSync(path.join(dir, "a b ü.txt"), "utf8"));
console.log(fs.statSync(file).size, fs.lstatSync(file).isFile(), fs.statSync(at("bytes.bin")).size);
console.log(fs.statSync(at("missing"), { throwIfNoEntry: false }) === undefined);
fs.accessSync(file);
fs.accessSync(file, fs.constants.R_OK);
fs.chmodSync(file, 0o644);
console.log((fs.statSync(file).mode & 0o777).toString(8));

fs.mkdirSync(at("sub/deep"), { recursive: true });
fs.mkdirSync(at("plain"));
console.log(fs.readdirSync(at("sub")));
console.log(fs.readdirSync(at("sub"), { withFileTypes: true }).map((entry) => entry.name));
fs.copyFileSync(file, at("sub/copy.txt"));
fs.renameSync(at("sub/copy.txt"), at("sub/moved.txt"));
console.log(fs.readFileSync(at("sub/moved.txt"), "utf8"));
fs.truncateSync(at("sub/moved.txt"), 4);
console.log(fs.readFileSync(at("sub/moved.txt"), "utf8"));
const fd = fs.openSync(at("sub/moved.txt"), "r");
console.log(typeof fd);
fs.closeSync(fd);
console.log(clean(fs.realpathSync(at("sub/../sub/moved.txt"))));
console.log(clean(fs.realpathSync.native(at("sub"))));
const temp = fs.mkdtempSync(at("tmp-"));
console.log(path.dirname(temp) === dir, path.basename(temp).length);
fs.rmdirSync(pathToFileURL(temp));
const opened = fs.opendirSync(at("sub"));
console.log(opened.path === path.join(dir, "sub"));
opened.closeSync();
fs.unlinkSync(at("sub/moved.txt"));
fs.rmSync(at("sub"), { recursive: true, force: true });
fs.rmSync(at("plain"), { recursive: true });
console.log(fs.readdirSync(dir).sort());

attempt("scheme", () => fs.readFileSync(new URL("http://example.com/a.txt"), "utf8"));
attempt("host", () => fs.statSync(new URL("file://example.com/a.txt")));
attempt("separator", () => fs.readFileSync(new URL("file:///tmp/a%2Fb"), "utf8"));
attempt("lowercase separator", () => fs.unlinkSync(new URL("file:///tmp/a%2fb")));
attempt("null byte", () => fs.readFileSync(new URL("file:///tmp/a%00b")));
attempt("missing", () => fs.readFileSync(at("missing.txt"), "utf8"));
attempt("both bad", () => fs.copyFileSync(new URL("http://a/"), new URL("file://b/c")));
attempt("rename", () => fs.renameSync(at("missing.txt"), at("other.txt")));
attempt("mkdir", () => {
  fs.mkdirSync(new URL("ftp://a/b"), { recursive: true });
});
attempt("later effects", () => fs.copyFileSync(new URL("http://a/"), logged("dest.txt")));
attempt("later mode", () => fs.chmodSync(new URL("http://a/"), mode()));
attempt("chmod", () => fs.chmodSync(new URL("data:text/plain,a"), 0o600));
attempt("chown order", () => fs.chownSync(file, uid, bumpUid()));
console.log("uid", uid);
uid = -1;
attempt("chown order scheme", () => fs.chownSync(new URL("http://a/"), uid, bumpUid()));
console.log("uid", uid);
// A later argument with effects inside a type-only wrapper runs once.
let modeCalls = 0;
function countedMode(): number {
  modeCalls++;
  return 0o600;
}
attempt("satisfies", () => fs.chmodSync(file, countedMode() satisfies number));
attempt("as", () => fs.chmodSync(file, countedMode() as number));
attempt("non-null", () => fs.chmodSync(file, countedMode()!));
console.log("mode calls", modeCalls);

fs.rmSync(dir, { recursive: true, force: true });
console.log("done", fs.existsSync(dir));
