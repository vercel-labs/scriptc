// fs.cp (callback) and fs/promises cp: results and errors reach the
// callback after the calling code finishes; the promise form merges
// directories, takes async filters, and keeps timestamps.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

function tail(path: string): string {
  let i = path.length - 1;
  while (i >= 0 && path.charAt(i) !== "/" && path.charAt(i) !== "\\") i = i - 1;
  return path.slice(i + 1);
}
const root = `/tmp/scr-cp-async-${tail(process.argv[1] === undefined ? "x" : process.argv[1])}-${process.pid}`;
if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root);
const home = process.cwd();
process.chdir(root);

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = `${d}/${name}`;
      if (fs.statSync(p).isDirectory()) {
        out.push(`${p}/`);
        walk(p);
      } else {
        out.push(`${p} = ${fs.readFileSync(p, "utf8")}`);
      }
    }
  };
  walk(dir);
  return out;
}

fs.mkdirSync("src/sub", { recursive: true });
fs.writeFileSync("src/a.txt", "a");
fs.writeFileSync("src/sub/b.txt", "b");
fs.writeFileSync("file.txt", "file");

await new Promise<void>((resolve) => {
  fs.cp("file.txt", "cb.txt", (err) => {
    console.log("callback", err, fs.readFileSync("cb.txt", "utf8"));
    resolve();
  });
  console.log("after call");
});

await new Promise<void>((resolve) => {
  fs.cp("src", "cb-dir", { recursive: true }, (err) => {
    console.log("dir callback", err, tree("cb-dir"));
    resolve();
  });
});

await new Promise<void>((resolve) => {
  fs.cp("src", "nope", (err) => {
    const e = err as NodeJS.ErrnoException;
    console.log("error callback", e.name, e.code, e.message);
    resolve();
  });
});

try {
  fs.cp("file.txt", "x.txt", { recursive: true }, undefined as unknown as () => void);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("missing callback", err.name, err.code, err.message);
}

// The promise form: filters may be async, merges overwrite by default.
const seen: string[] = [];
await fsp.cp("src", "p-dir", {
  recursive: true,
  filter: async (from: string) => {
    seen.push(from);
    return !from.endsWith("b.txt");
  },
});
console.log(seen.sort(), tree("p-dir"));

fs.writeFileSync("src/a.txt", "a2");
await fsp.cp("src", "p-dir", { recursive: true, force: false });
console.log(tree("p-dir"));
await fsp.cp("src", "p-dir", { recursive: true });
console.log(tree("p-dir"));

const stamp = new Date("2021-05-06T07:08:09.123Z");
fs.utimesSync("file.txt", stamp, stamp);
await fsp.cp("file.txt", "p-stamped.txt", { preserveTimestamps: true });
console.log(new Date(fs.statSync("p-stamped.txt").mtimeMs).toISOString());
// The source tree gets fixed times: its own times come from the clock, and
// whether a copy equals them depends on their sub-millisecond digits.
fs.utimesSync("src/a.txt", stamp, stamp);
fs.utimesSync("src", stamp, stamp);
await fsp.cp("src", "p-stamped-dir", { recursive: true, preserveTimestamps: true });
for (const path of ["p-stamped-dir", "p-stamped-dir/a.txt"])
  console.log(path, new Date(fs.statSync(path).mtimeMs).toISOString());

const rejected = await fsp.cp("missing", "x").then(
  () => "fulfilled",
  (e: NodeJS.ErrnoException) => `${e.code} ${e.message}`,
);
console.log(rejected);

process.chdir(home);
fs.rmSync(root, { recursive: true, force: true });
