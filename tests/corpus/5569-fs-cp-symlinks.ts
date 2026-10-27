// fs.cpSync and fs/promises cp with symbolic links: a top-level link,
// links inside a copied directory (relative and absolute targets),
// verbatimSymlinks, dereference, and replacing an existing link.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
}
const root = `/tmp/scr-cp-links-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root);
const home = process.cwd();
process.chdir(root);
const real = fs.realpathSync(root);

function show(path: string): string {
  const st = fs.lstatSync(path);
  if (st.isSymbolicLink()) return `${path} -> ${fs.readlinkSync(path).split(real).join("<root>")}`;
  if (st.isDirectory()) return `${path}/`;
  return `${path} = ${fs.readFileSync(path, "utf8")}`;
}
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = `${d}/${name}`;
      out.push(show(p));
      if (!fs.lstatSync(p).isSymbolicLink() && fs.statSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}
function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.name, err.code, err.message.split(real).join("<root>"));
  }
}

fs.mkdirSync("src/sub", { recursive: true });
fs.writeFileSync("src/a.txt", "a");
fs.writeFileSync("src/sub/b.txt", "b");
fs.writeFileSync("target.txt", "t");
fs.symlinkSync("a.txt", "src/rel-link");
fs.symlinkSync("sub", "src/dir-link");
fs.symlinkSync(`${real}/target.txt`, "src/abs-link");
fs.symlinkSync("target.txt", "top-link");

// A top-level link copies as a link; its relative target is resolved.
fs.cpSync("top-link", "copied-link");
console.log(show("copied-link"));
fs.cpSync("top-link", "verbatim-link", { verbatimSymlinks: true });
console.log(show("verbatim-link"));
// With dereference, the binding's path check treats a link as a directory.
attempt("deref file link", () => fs.cpSync("top-link", "deref.txt", { dereference: true }));
fs.cpSync("top-link", "deref.txt", { dereference: true, recursive: true });
console.log(show("deref.txt"));

// Links inside a directory: the synchronous copy points each one at its
// canonical absolute target.
fs.cpSync("src", "sync-copy", { recursive: true });
console.log(tree("sync-copy"));
fs.cpSync("src", "sync-verbatim", { recursive: true, verbatimSymlinks: true });
console.log(tree("sync-verbatim"));

// The promise form resolves relative targets against the link's directory.
await fsp.cp("src", "async-copy", { recursive: true });
console.log(tree("async-copy"));
await fsp.cp("src", "async-verbatim", { recursive: true, verbatimSymlinks: true });
console.log(tree("async-verbatim"));
await fsp.cp("src", "async-deref", { recursive: true, dereference: true });
console.log(tree("async-deref"));

// Replacing an existing link, and a link onto a regular file.
fs.symlinkSync("src/a.txt", "other-link");
fs.cpSync("top-link", "other-link");
console.log(show("other-link"));
attempt("link onto file", () => fs.cpSync("top-link", "target.txt"));
attempt("sync link in dir onto file", () => {
  fs.mkdirSync("merge", { recursive: true });
  fs.writeFileSync("merge/rel-link", "file");
  fs.cpSync("src", "merge", { recursive: true });
});

process.chdir(home);
fs.rmSync(root, { recursive: true, force: true });
