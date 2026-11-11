// The fs/promises operations that take no options (or only a numeric mode):
// access, chmod, chown, lchown, unlink, rename, rmdir, truncate, utimes,
// lutimes, link, symlink, readlink, copyFile, rm. Success fulfills; every
// failure rejects with Node's error — code, syscall and message — and the
// call itself never throws synchronously.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-ops-"));
const file = path.join(dir, "f.txt");
const other = path.join(dir, "g.txt");
const missing = path.join(dir, "missing.txt");
const linkPath = path.join(dir, "link");
const symPath = path.join(dir, "sym");
const sub = path.join(dir, "sub");
fs.writeFileSync(file, "0123456789");

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

function report(label: string, error: unknown): void {
  if (error instanceof Error) {
    const errno = error as NodeJS.ErrnoException;
    console.log(label, error.name, errno.code, errno.syscall, clean(error.message));
  } else {
    console.log(label, "non-error");
  }
}

async function settle(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(label, "fulfilled");
  } catch (error) {
    report(label, error);
  }
}

const uid = -1;
const gid = -1;

await settle("access", () => fsp.access(file));
await settle("access R", () => fsp.access(file, fs.constants.R_OK));
await settle("access W", () => fsp.access(file, fs.constants.W_OK));
await settle("access RWX", () => fsp.access(file, fs.constants.R_OK | fs.constants.W_OK));
await settle("access 8", () => fsp.access(file, 8));
await settle("access -1", () => fsp.access(file, -1));
await settle("access 1.5", () => fsp.access(file, 1.5));
await settle("access NaN", () => fsp.access(file, NaN));
await settle("access missing", () => fsp.access(missing));

await settle("chmod", () => fsp.chmod(file, 0o640));
console.log("mode", (fs.statSync(file).mode & 0o777).toString(8));
await settle("chmod 0o7777", () => fsp.chmod(file, 0o7777));
console.log("mode", (fs.statSync(file).mode & 0o7777).toString(8));
await settle("chmod -1", () => fsp.chmod(file, -1));
await settle("chmod 1.5", () => fsp.chmod(file, 1.5));
await settle("chmod missing", () => fsp.chmod(missing, 0o644));

await settle("chown", () => fsp.chown(file, uid, gid));
await settle("chown 1.5", () => fsp.chown(file, 1.5, gid));
await settle("chown -2", () => fsp.chown(file, -2, gid));
await settle("chown big gid", () => fsp.chown(file, uid, 4294967296));
await settle("chown missing", () => fsp.chown(missing, uid, gid));
await settle("lchown", () => fsp.lchown(file, uid, gid));
await settle("lchown -2", () => fsp.lchown(file, -1, -2));
await settle("lchown missing", () => fsp.lchown(missing, uid, gid));

await settle("unlink", () => fsp.unlink(other));
fs.writeFileSync(other, "x");
await settle("unlink exists", () => fsp.unlink(other));
console.log("unlinked", fs.existsSync(other));
await settle("unlink again", () => fsp.unlink(other));
fs.mkdirSync(sub);
await settle("unlink dir", () => fsp.unlink(sub));

fs.writeFileSync(other, "fresh");
await settle("rename", () => fsp.rename(other, path.join(dir, "renamed.txt")));
console.log("renamed", fs.existsSync(path.join(dir, "renamed.txt")), fs.existsSync(other));
await settle("rename missing", () => fsp.rename(missing, path.join(dir, "nope.txt")));
await settle("rename onto dir", () => fsp.rename(path.join(dir, "renamed.txt"), sub));
console.log("content", fs.readFileSync(file, "utf8"));

await settle("truncate", () => fsp.truncate(file, 4));
console.log("content", fs.readFileSync(file, "utf8"));
await settle("truncate default", () => fsp.truncate(file));
console.log("size", fs.statSync(file).size);
fs.writeFileSync(file, "0123456789");
await settle("truncate -3", () => fsp.truncate(file, -3));
console.log("size", fs.statSync(file).size);
await settle("truncate 1.5", () => fsp.truncate(file, 1.5));
await settle("truncate NaN", () => fsp.truncate(file, NaN));
await settle("truncate missing", () => fsp.truncate(missing, 1.5));
await settle("truncate dir", () => fsp.truncate(sub));

await settle("utimes numbers", () => fsp.utimes(file, 1000, 2000));
console.log(
  "times",
  Math.round(fs.statSync(file).atimeMs),
  Math.round(fs.statSync(file).mtimeMs),
);
await settle("utimes dates", () => fsp.utimes(file, new Date(3000), new Date(4000)));
console.log(
  "dates",
  Math.round(fs.statSync(file).atimeMs),
  Math.round(fs.statSync(file).mtimeMs),
);
await settle("utimes strings", () => fsp.utimes(file, "5000", "6000"));
console.log(
  "strings",
  Math.round(fs.statSync(file).atimeMs),
  Math.round(fs.statSync(file).mtimeMs),
);
await settle("utimes NaN", () => fsp.utimes(file, NaN, 0));
await settle("utimes missing", () => fsp.utimes(missing, 0, 0));
await settle("lutimes", () => fsp.lutimes(file, 7000, 8000));
console.log("lutimes", Math.round(fs.statSync(file).mtimeMs));
await settle("lutimes missing", () => fsp.lutimes(missing, 0, 0));

await settle("link", () => fsp.link(file, linkPath));
console.log("linked", fs.statSync(linkPath).ino === fs.statSync(file).ino);
await settle("link exists", () => fsp.link(file, linkPath));
await settle("link missing", () => fsp.link(missing, path.join(dir, "x")));
await settle("symlink", () => fsp.symlink(file, symPath));
console.log("symlinked", fs.readlinkSync(symPath) === file);
await settle("symlink exists", () => fsp.symlink(file, symPath));
await settle("symlink type", () => fsp.symlink(file, path.join(dir, "s2"), "dir"));
console.log("symlink type", fs.lstatSync(path.join(dir, "s2")).isSymbolicLink());
await settle("symlink bad type", () => fsp.symlink(file, path.join(dir, "s3"), "bogus"));

await settle("readlink", async () => {
  console.log("readlink value", (await fsp.readlink(symPath)) === file);
});
await settle("readlink hex", async () => {
  console.log(
    "readlink hex",
    (await fsp.readlink(symPath, "hex")) === Buffer.from(file).toString("hex"),
  );
});
await settle("readlink buffer", async () => {
  const raw = await fsp.readlink(symPath, { encoding: "buffer" });
  console.log("readlink buffer", raw instanceof Buffer, raw.toString() === file);
});
await settle("readlink missing", () => fsp.readlink(missing));
await settle("readlink plain file", () => fsp.readlink(file));

await settle("copyFile", () => fsp.copyFile(file, path.join(dir, "copy.txt")));
console.log("copied", fs.readFileSync(path.join(dir, "copy.txt"), "utf8"));
await settle("copyFile exists", () => fsp.copyFile(file, path.join(dir, "copy.txt")));
await settle("copyFile excl", () =>
  fsp.copyFile(file, path.join(dir, "copy.txt"), fs.constants.COPYFILE_EXCL),
);
await settle("copyFile missing", () => fsp.copyFile(missing, path.join(dir, "copy2.txt")));
await settle("copyFile dir", () => fsp.copyFile(file, sub));
await settle("copyFile to self", () => fsp.copyFile(file, file));

fs.mkdirSync(path.join(dir, "empty"));
console.log("rmdir setup", true);
await settle("rmdir", () => fsp.rmdir(path.join(dir, "empty")));
console.log("rmdir gone", fs.existsSync(path.join(dir, "empty")));
await settle("rmdir again", () => fsp.rmdir(path.join(dir, "empty")));
await settle("rmdir non-empty", () => fsp.rmdir(dir));
await settle("rmdir file", () => fsp.rmdir(file));

await settle("rm file", () => fsp.rm(file));
console.log("rm file gone", fs.existsSync(file));
await settle("rm missing", () => fsp.rm(missing));
await settle("rm missing force", () => fsp.rm(missing, { force: true }));
fs.mkdirSync(path.join(dir, "tree", "deep"), { recursive: true });
fs.writeFileSync(path.join(dir, "tree", "deep", "leaf.txt"), "leaf");
await settle("rm dir no recursive", () => fsp.rm(path.join(dir, "tree")));
await settle("rm dir recursive", () => fsp.rm(path.join(dir, "tree"), { recursive: true }));
console.log("rm dir gone", fs.existsSync(path.join(dir, "tree")));

fs.rmSync(dir, { recursive: true, force: true });
console.log("removed", fs.existsSync(dir));
