// fs-extra compiles from scriptc's built-in implementation; Node runs the
// real package. node_modules vendors fs-extra 9.0.0 with its dependencies
// (graceful-fs, jsonfile, universalify, at-least-node) and @types/fs-extra
// 9.0.13, unmodified (MIT). The program reads fs-extra through its default
// import, a namespace import and named imports: fs's re-exported members in
// promise and callback form, fs.promises, streams, and the extras (mkdirs,
// copy, remove, pathExists, the JSON helpers, outputFile, emptyDir, move),
// the modes of binary and JSON writes, and the sync copy and move checks.
import fs from "fs-extra";
import * as fsx from "fs-extra";
// Named imports use the names Node detects in fs-extra's CommonJS source.
import { copy, outputFile, pathExists, remove } from "fs-extra";
import * as os from "node:os";
import * as path from "node:path";

function shown(root: string, text: string): string {
  return text.split(root).join("<root>");
}

async function readStream(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    stream.on("data", (chunk) => {
      text += String(chunk);
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptc-fs-extra-"));
  const file = path.join(root, "a.txt");

  await fs.writeFile(file, "hello\n");
  await fs.appendFile(file, "world\n");
  console.log(JSON.stringify(await fs.readFile(file, "utf8")));
  console.log((await fs.readFile(file)).length, fs.existsSync(file), fs.existsSync(root + "-missing"));
  console.log((await fs.stat(file)).size, (await fs.lstat(file)).isFile(), fs.statSync(root).isDirectory());
  await fs.chmod(file, 0o640);
  console.log(((await fs.stat(file)).mode & 0o777).toString(8));

  const link = path.join(root, "link.txt");
  await fs.symlink(file, link);
  console.log(shown(root, await fs.readlink(link)), (await fs.lstat(link)).isSymbolicLink());

  await fs.ensureDir(path.join(root, "deep", "er"));
  await fs.mkdirp(path.join(root, "made", "by", "mkdirp"));
  await fs.writeFile(path.join(root, "deep", "er", "leaf.txt"), "leaf");
  console.log((await fs.readdir(root)).sort().join(","));

  const data = path.join(root, "data.json");
  await fs.writeJson(data, { a: 1, list: [true, null, "x"] }, { spaces: 2 });
  console.log(JSON.stringify(await fs.readFile(data, "utf8")));
  console.log(JSON.stringify(await fs.readJson(data)));
  await fs.outputJson(path.join(root, "out", "nested", "o.json"), { ok: true });
  console.log(JSON.stringify(fs.readJSONSync(path.join(root, "out", "nested", "o.json"))));
  await outputFile(path.join(root, "out2", "z.txt"), "zed");
  console.log(await fs.readFile(path.join(root, "out2", "z.txt"), "utf8"));
  console.log(fs.readJsonSync(file, { throws: false }));
  fs.writeFileSync(path.join(root, "bom.json"), '\uFEFF{"bom":true}');
  console.log(JSON.stringify(fs.readJsonSync(path.join(root, "bom.json"))));

  await fs.copy(path.join(root, "deep"), path.join(root, "copied"));
  await copy(file, path.join(root, "copied", "a-copy.txt"));
  await fsx.copy(file, path.join(root, "copied", "b-copy.txt"));
  console.log((await fs.readdir(path.join(root, "copied"))).sort().join(","));
  console.log(await fs.readFile(path.join(root, "copied", "er", "leaf.txt"), "utf8"));
  console.log(await pathExists(path.join(root, "copied", "er")), await fs.pathExists(root + "-missing"));
  try {
    await fs.copy(path.join(root, "deep"), path.join(root, "deep", "er", "inner"));
  } catch (err) {
    console.log(shown(root, (err as Error).message));
  }
  try {
    await fs.copy(file, file);
  } catch (err) {
    console.log((err as Error).message);
  }

  await fs.move(path.join(root, "out2"), path.join(root, "moved"));
  console.log(await fs.pathExists(path.join(root, "out2")), await fs.pathExists(path.join(root, "moved", "z.txt")));
  try {
    await fs.move(path.join(root, "moved"), path.join(root, "copied"));
  } catch (err) {
    console.log((err as Error).message);
  }
  await fs.emptyDir(path.join(root, "copied"));
  console.log((await fs.readdir(path.join(root, "copied"))).length);

  // Modes of binary and JSON writes, and the sync copy and move checks.
  await fs.writeFile(path.join(root, "bytes.bin"), Buffer.from([1, 2, 3]), { mode: 0o600 });
  await fs.outputFile(path.join(root, "out3", "bytes.bin"), new Uint8Array([4, 5]), { mode: 0o600 });
  fs.writeJsonSync(path.join(root, "private.json"), { a: 1 }, { mode: 0o600 });
  fs.outputJsonSync(path.join(root, "out4", "private.json"), { b: 2 }, { mode: 0o600 });
  for (const name of ["bytes.bin", "out3/bytes.bin", "private.json", "out4/private.json"])
    console.log(name, (fs.statSync(path.join(root, name)).mode & 0o777).toString(8));
  const selfLink = path.join(root, "self-link");
  fs.symlinkSync(path.join(root, "deep"), selfLink);
  try {
    fs.copySync(path.join(root, "deep"), path.join(selfLink, "inner"));
  } catch (err) {
    console.log(shown(root, (err as Error).message));
  }
  try {
    fs.moveSync(path.join(root, "deep"), path.join(selfLink, "inner"));
  } catch (err) {
    console.log(shown(root, (err as Error).message));
  }
  try {
    fs.moveSync(file, file, { overwrite: true });
  } catch (err) {
    console.log((err as Error).message);
  }
  console.log(fs.existsSync(file), fs.existsSync(path.join(root, "deep", "inner")));

  // A symlink source over an existing destination entry: a regular file is
  // kept and the copy fails with EEXIST; a destination symlink is replaced.
  const linkSrc = path.join(root, "link-src");
  fs.mkdirSync(linkSrc);
  fs.symlinkSync(file, path.join(linkSrc, "entry"));
  for (const sync of [true, false]) {
    const linkDest = path.join(root, sync ? "link-dest-sync" : "link-dest-async");
    fs.mkdirSync(linkDest);
    fs.writeFileSync(path.join(linkDest, "entry"), "kept");
    try {
      if (sync) fs.copySync(linkSrc, linkDest, { overwrite: false });
      else await fs.copy(linkSrc, linkDest, { overwrite: false });
    } catch (err) {
      console.log((err as NodeJS.ErrnoException).code, shown(root, (err as Error).message));
    }
    const entry = path.join(linkDest, "entry");
    console.log(fs.readFileSync(entry, "utf8"), fs.lstatSync(entry).isSymbolicLink());
  }
  const relinkDest = path.join(root, "relink-dest");
  fs.mkdirSync(relinkDest);
  fs.symlinkSync(data, path.join(relinkDest, "entry"));
  fs.copySync(linkSrc, relinkDest);
  console.log(shown(root, fs.readlinkSync(path.join(relinkDest, "entry"))));

  // A destination directory symlink back into the source tree: each entry
  // is checked against its destination, so the copy stops there instead
  // of replacing the source's own file.
  const loopSrc = path.join(root, "loop-src");
  fs.mkdirSync(path.join(loopSrc, "sub"), { recursive: true });
  fs.writeFileSync(path.join(loopSrc, "sub", "keep.txt"), "source");
  const loopDest = path.join(root, "loop-dest");
  fs.mkdirSync(loopDest);
  fs.symlinkSync(path.join(loopSrc, "sub"), path.join(loopDest, "sub"));
  for (const sync of [true, false]) {
    try {
      if (sync) fs.copySync(loopSrc, loopDest);
      else await fs.copy(loopSrc, loopDest);
    } catch (err) {
      console.log(shown(root, (err as Error).message));
    }
    console.log(fs.readFileSync(path.join(loopSrc, "sub", "keep.txt"), "utf8"));
  }

  console.log(await readStream(file));
  console.log((await fs.promises.readFile(file, "utf8")).length);
  console.log(fs.readFileSync(file, "utf8").length);

  try {
    await fs.readFile(path.join(root, "missing.txt"), "utf8");
  } catch (err) {
    console.log((err as NodeJS.ErrnoException).code);
  }

  fs.readFile(file, "utf8", (err, text) => {
    console.log("callback", err === null, text.length);
    fs.ensureDir(path.join(root, "from-callback"), (dirErr) => {
      console.log("callback ensureDir", dirErr === null, fs.existsSync(path.join(root, "from-callback")));
      void remove(root).then(async () => {
        console.log("removed", await fs.pathExists(root));
      });
    });
  });
}

main();
