// fs.cpSync: files, recursive directories, the force / errorOnExist /
// mode / filter / preserveTimestamps options, and directory merges.
// Paths are relative to a scratch directory so messages are stable.
import * as fs from "node:fs";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
}
const root = `/tmp/scr-cpsync-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root);
const home = process.cwd();
process.chdir(root);

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    const names = fs.readdirSync(d).sort();
    for (const name of names) {
      const p = `${d}/${name}`;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) {
        out.push(`${p}/`);
        walk(p);
      } else if (st.isSymbolicLink()) {
        out.push(`${p} -> ${fs.readlinkSync(p).split(root).join("<root>")}`);
      } else {
        out.push(`${p} = ${fs.readFileSync(p, "utf8")}`);
      }
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
    console.log(label, err.name, err.code, err.message);
  }
}

fs.mkdirSync("src/sub/deep", { recursive: true });
fs.writeFileSync("src/a.txt", "a");
fs.writeFileSync("src/sub/b.txt", "b");
fs.writeFileSync("src/sub/deep/c.txt", "c");
fs.writeFileSync("file.txt", "file");

// A single file, into a missing parent directory.
fs.cpSync("file.txt", "out/nested/file.txt");
console.log(tree("out"));

// A directory tree.
fs.cpSync("src", "copy", { recursive: true });
console.log(tree("copy"));

// force (the default) overwrites; force: false keeps the existing file.
fs.writeFileSync("other.txt", "other");
fs.cpSync("other.txt", "out/nested/file.txt");
console.log(fs.readFileSync("out/nested/file.txt", "utf8"));
fs.writeFileSync("other.txt", "changed");
fs.cpSync("other.txt", "out/nested/file.txt", { force: false });
console.log(fs.readFileSync("out/nested/file.txt", "utf8"));
attempt("errorOnExist", () =>
  fs.cpSync("other.txt", "out/nested/file.txt", { force: false, errorOnExist: true }),
);

// Merging into an existing directory: force overwrites, force: false skips.
fs.writeFileSync("src/a.txt", "a2");
fs.writeFileSync("copy/extra.txt", "extra");
fs.cpSync("src", "copy", { recursive: true, force: false });
console.log(tree("copy"));
fs.cpSync("src", "copy", { recursive: true });
console.log(tree("copy"));
attempt("dir errorOnExist", () =>
  fs.cpSync("src", "copy", { recursive: true, force: false, errorOnExist: true }),
);

// COPYFILE_EXCL through mode.
attempt("mode excl", () => fs.cpSync("other.txt", "out/nested/file.txt", { mode: fs.constants.COPYFILE_EXCL }));
fs.cpSync("other.txt", "fresh.txt", { mode: fs.constants.COPYFILE_EXCL });
console.log(fs.readFileSync("fresh.txt", "utf8"));

// filter: called for the top-level paths and each entry, in order.
const seen: string[] = [];
fs.cpSync("src", "filtered", {
  recursive: true,
  filter: (from: string, to: string) => {
    seen.push(`${from} -> ${to}`);
    return !from.endsWith("b.txt");
  },
});
console.log(seen.sort());
console.log(tree("filtered"));
fs.cpSync("src", "skipped", { recursive: true, filter: () => false });
console.log(fs.existsSync("skipped"));

// preserveTimestamps keeps the source mtime on files.
const stamp = new Date("2020-01-02T03:04:05Z");
fs.utimesSync("file.txt", stamp, stamp);
fs.cpSync("file.txt", "stamped.txt", { preserveTimestamps: true });
console.log(new Date(fs.statSync("stamped.txt").mtimeMs).toISOString());
fs.cpSync("file.txt", "unstamped.txt");
console.log(fs.statSync("unstamped.txt").mtimeMs === stamp.getTime());

// A file: URL source.
fs.cpSync(new URL(`file://${root}/file.txt`), "url.txt");
console.log(fs.readFileSync("url.txt", "utf8"));

process.chdir(home);
fs.rmSync(root, { recursive: true, force: true });
