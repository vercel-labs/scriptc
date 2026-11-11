// fs.realpath's option record and path argument for values the static
// signature does not accept: "buffer" answers a Buffer, an unknown encoding
// and a non-record option throw at the call, null means the defaults, a
// missing callback is its own error, and a failed walk calls the callback
// with the error alone. The plain form coerces a non-string path with
// `path += ''` and walks it, naming the first missing component with syscall
// "lstat" and a link cycle in "stat"; the native binding validates the path
// (a number throws, a file URL converts) and reports through realpath(2).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realpath-dyn-"));
const file = path.join(dir, "file.txt");
const link = path.join(dir, "link.txt");
const missing = path.join(dir, "missing.txt");
fs.writeFileSync(file, "x");
fs.symlinkSync(file, link);

const clean = (text) => String(text).split(dir).join("<dir>");

function t(label, run) {
  try {
    run();
    console.log(label, "accepted");
  } catch (error) {
    console.log(label, error.name, error.code, clean(error.message));
  }
}

// Options are validated before the callback and the path.
const noop = () => {};
t("unknown encoding", () => fs.realpath(link, "bogus", noop));
t("number options", () => fs.realpath(link, 5, noop));
t("boolean options", () => fs.realpath(link, true, noop));
t("missing callback", () => fs.realpath(link, "utf8"));
t("native missing callback", () => fs.realpath.native(link, { encoding: "utf8" }));
t("symbol path", () => fs.realpath(Symbol("s"), noop));
t("native number path", () => fs.realpath.native(5, noop));
t("native no callback", () => fs.realpath.native(link));
process.chdir(dir);

function resolve(label, run) {
  return new Promise((done) => {
    run((error, resolved) => {
      const shape = error
        ? "error " + error.code
        : Buffer.isBuffer(resolved)
          ? "buffer " + clean(resolved.toString("utf8"))
          : "string " + typeof resolved + " " + clean(resolved);
      console.log(label, shape);
      done(true);
    });
  });
}

function failure(label, run) {
  return new Promise((done) => {
    run((error) => {
      console.log(label, error.code, error.syscall, clean(error.message), JSON.stringify(clean(error.path)));
      done(true);
    });
  });
}

(async () => {
  await resolve("buffer encoding", (callback) => fs.realpath(link, "buffer", callback));
  await resolve("native buffer", (callback) => fs.realpath.native(link, { encoding: "buffer" }, callback));
  await resolve("null options", (callback) => fs.realpath(link, null, callback));
  await resolve("empty encoding", (callback) => fs.realpath(link, "", callback));
  // On success the second argument is produced; on failure Node passes the
  // error alone, so the resolved value is undefined.
  await resolve("missing entry", (callback) => fs.realpath(missing, callback));
  await resolve("missing native", (callback) => fs.realpath.native(missing, callback));
  // The plain form's `path += ''` and path.resolve: the walk's error names
  // the resolved path, while the binding's names the path as given.
  await failure("numeric path", (callback) => fs.realpath(5, callback));
  await failure("null path", (callback) => fs.realpath(null, callback));
  await failure("buffer path", (callback) => fs.realpath(Buffer.from("missing"), callback));
  await failure("url path", (callback) => fs.realpath(new URL("file://" + missing), callback));
  await failure("native url path", (callback) => fs.realpath.native(new URL("file://" + missing), callback));
  await failure("nested missing", (callback) => fs.realpath("nested/dir/file", callback));
  fs.symlinkSync(path.join(dir, "loopb"), path.join(dir, "loopa"));
  fs.symlinkSync(path.join(dir, "loopa"), path.join(dir, "loopb"));
  await failure("plain loop", (callback) => fs.realpath("loopa", callback));
  await failure("native loop", (callback) => fs.realpath.native("loopa", callback));
})();
