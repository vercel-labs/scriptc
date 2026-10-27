// fs.cpSync and fs/promises cp errors: option validation, path
// validation, and the copy errors, whose class, message, code and own
// keys differ between the synchronous and the promise form, as in Node.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

const any = (value) => /** @type {any} */ (value);

function tail(path) {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
}
const root = `/tmp/scr-cp-errors-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root);
const home = process.cwd();
process.chdir(root);
fs.mkdirSync("src/sub", { recursive: true });
fs.writeFileSync("src/a.txt", "a");
fs.writeFileSync("file.txt", "f");
fs.writeFileSync("b.txt", "b");

function describe(label, e) {
  const keys = Object.keys(e);
  console.log(label, e instanceof Error, e.name, e.code, JSON.stringify(e.message), keys);
  if (keys.includes("info")) console.log("  info", e.info, e.errno, e.syscall, e.path, String(e));
  else if (keys.includes("errno")) console.log("  errno", e.errno, e.syscall, e.path);
}
function sync(label, run) {
  try {
    run();
    console.log(label, "ok");
  } catch (e) {
    describe(label, e);
  }
}
async function promised(label, run) {
  try {
    await run();
    console.log(label, "ok");
  } catch (e) {
    describe(label, e);
  }
}

sync("options type", () => fs.cpSync("file.txt", "x.txt", any(5)));
sync("options null", () => fs.cpSync("file.txt", "x.txt", any(null)));
sync("recursive type", () => fs.cpSync("file.txt", "x.txt", any({ recursive: 1 })));
sync("force type", () => fs.cpSync("file.txt", "x.txt", any({ force: "yes" })));
sync("mode range", () => fs.cpSync("file.txt", "x.txt", { mode: 99 }));
sync("mode type", () => fs.cpSync("file.txt", "x.txt", any({ mode: "1" })));
sync("option pair", () => fs.cpSync("file.txt", "x.txt", { dereference: true, verbatimSymlinks: true }));
sync("filter type", () => fs.cpSync("file.txt", "x.txt", any({ filter: 1 })));
sync("filter promise", () => fs.cpSync("file.txt", "x.txt", any({ filter: async () => true })));
sync("filter throws", () =>
  fs.cpSync("file.txt", "x.txt", {
    filter: () => {
      throw new Error("no copy");
    },
  }),
);
sync("src type", () => fs.cpSync(any(5), "x.txt"));
sync("dest type", () => fs.cpSync("file.txt", any({})));
sync("src nul", () => fs.cpSync("file\0.txt", "x.txt"));
sync("validation order", () => fs.cpSync(any(5), any(6), any({ force: 1 })));

sync("same", () => fs.cpSync("src", "src", { recursive: true }));
sync("not recursive", () => fs.cpSync("src", "out"));
sync("dir to file", () => fs.cpSync("src", "file.txt", { recursive: true }));
sync("file to dir", () => fs.cpSync("file.txt", "src"));
sync("into self", () => fs.cpSync("src", "src/sub/inner", { recursive: true }));
sync("missing", () => fs.cpSync("missing.txt", "x.txt"));
sync("exists", () => fs.cpSync("file.txt", "b.txt", { force: false, errorOnExist: true }));
fs.cpSync("src", "copy", { recursive: true });
sync("dir file exists", () => fs.cpSync("src", "copy", { recursive: true, force: false, errorOnExist: true }));
fs.rmSync("copy/a.txt");
fs.mkdirSync("copy/a.txt");
sync("dir entry kind", () => fs.cpSync("src", "copy", { recursive: true }));

await promised("p options type", () => fsp.cp("file.txt", "x.txt", any(5)));
await promised("p src type", () => fsp.cp(any(5), "x.txt"));
await promised("p same", () => fsp.cp("src", "src", { recursive: true }));
await promised("p not recursive", () => fsp.cp("src", "out"));
await promised("p dir to file", () => fsp.cp("src", "file.txt", { recursive: true }));
await promised("p file to dir", () => fsp.cp("file.txt", "src"));
await promised("p into self", () => fsp.cp("src", "src/sub/inner", { recursive: true }));
await promised("p missing", () => fsp.cp("missing.txt", "x.txt"));
await promised("p exists", () => fsp.cp("file.txt", "b.txt", { force: false, errorOnExist: true }));
await promised("p dir exists", () => fsp.cp("src", "copy", { recursive: true, force: false, errorOnExist: true }));
await promised("p dir entry kind", () => fsp.cp("src", "copy", { recursive: true }));

// The copy takes the source's mode, and a Buffer path works.
function access(path) {
  const can = (mode) => {
    try {
      fs.accessSync(path, mode);
      return true;
    } catch {
      return false;
    }
  };
  return [can(fs.constants.R_OK), can(fs.constants.W_OK), can(fs.constants.X_OK)];
}
fs.chmodSync("b.txt", 0o500);
fs.cpSync("b.txt", any(Buffer.from("moded.txt")));
console.log(access("moded.txt"));
fs.chmodSync("src/sub", 0o500);
fs.cpSync("src", "moded-dir", { recursive: true });
console.log(access("moded-dir/sub"));
fs.chmodSync("src/sub", 0o700);
fs.chmodSync("moded-dir/sub", 0o700);

process.chdir(home);
fs.rmSync(root, { recursive: true, force: true });
