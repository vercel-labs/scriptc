// fs/promises' path operations: the documented option forms and the error
// shapes each one reports. Every case prints the error code, the syscall,
// the path as the operation names it, and the message with the temporary
// directory replaced, so the compiled binary and Node compare byte-for-byte.
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "scr-fsp-path-"));
const shown = (text: string): string => text.split(root).join("<root>");

function report(label: string, err: unknown): void {
  const e = err as NodeJS.ErrnoException;
  console.log(label, e.code, e.syscall, shown(String(e.path)), shown(e.message));
}

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const value = await fn();
    console.log(label, "ok", typeof value);
  } catch (e) {
    report(label, e);
  }
}

async function main(): Promise<void> {
  const file = join(root, "file.txt");
  await fsp.writeFile(file, "content");
  await fsp.symlink("file.txt", join(root, "link.txt"));

  // access: each mode constant, a missing path, and invalid modes.
  await run("access-ok", () => fsp.access(file, fs.constants.F_OK));
  await run("access-rw", () => fsp.access(file, fs.constants.R_OK | fs.constants.W_OK));
  await run("access-x", () => fsp.access(file, fs.constants.X_OK));
  await run("access-missing", () => fsp.access(join(root, "missing")));
  await run("access-frac", () => fsp.access(file, 1.5));
  await run("access-neg", () => fsp.access(file, -1));

  // chown/lchown: the uid/gid validation happens after the path.
  await run("chown-frac", () => fsp.chown(file, 1.5, 0));
  await run("chown-neg", () => fsp.chown(file, 0, -1));
  await run("chown-missing", () => fsp.chown(join(root, "missing"), 0, 0));
  await run("lchown-frac", () => fsp.lchown(file, 0, 1.5));
  await run("lchown-link", () => fsp.lchown(join(root, "link.txt"), 0, 0));

  // link/symlink: success, an existing destination, a missing target.
  await run("link-ok", async () => {
    await fsp.link(file, join(root, "hard.txt"));
    return (await fsp.readFile(join(root, "hard.txt"), "utf8")).length;
  });
  await run("link-exists", () => fsp.link(file, join(root, "hard.txt")));
  await run("link-missing", () => fsp.link(join(root, "missing"), join(root, "hard2.txt")));
  await run("symlink-missing-parent", () => fsp.symlink("file.txt", join(root, "no/such/link")));
  await run("symlink-type", () => fsp.symlink("file.txt", join(root, "typed.txt"), "file"));

  // readlink: string and Buffer encodings, a non-symlink, a missing path.
  await run("readlink-ok", () => fsp.readlink(join(root, "link.txt"), "utf8"));
  await run("readlink-buffer", async () => {
    const target = await fsp.readlink(join(root, "link.txt"), { encoding: "buffer" });
    return `${target.length}:${target.toString("utf8")}`;
  });
  await run("readlink-notlink", () => fsp.readlink(file));
  await run("readlink-missing", () => fsp.readlink(join(root, "missing")));

  // rename: success and a missing source.
  await run("rename-ok", async () => {
    await fsp.rename(join(root, "hard.txt"), join(root, "renamed.txt"));
    return (await fsp.readFile(join(root, "renamed.txt"), "utf8")).length;
  });
  await run("rename-missing", () => fsp.rename(join(root, "missing"), join(root, "x")));

  // truncate: shrink, grow, and the length validation.
  await run("truncate-shrink", async () => {
    await fsp.truncate(file, 3);
    return await fsp.readFile(file, "utf8");
  });
  await run("truncate-grow", async () => {
    await fsp.truncate(file, 5);
    return (await fsp.readFile(file)).length;
  });
  await run("truncate-neg", () => fsp.truncate(file, -1));
  await run("truncate-frac", () => fsp.truncate(file, 1.5));
  await run("truncate-missing", () => fsp.truncate(join(root, "missing"), 0));

  // unlink: a file, a directory, and a missing path.
  await run("unlink-file", async () => {
    await fsp.writeFile(join(root, "gone.txt"), "x");
    await fsp.unlink(join(root, "gone.txt"));
    return await fsp.readdir(root).then((n) => n.includes("gone.txt"));
  });
  await run("unlink-dir", async () => {
    await fsp.mkdir(join(root, "adir"));
    await fsp.unlink(join(root, "adir"));
  });
  await run("unlink-missing", () => fsp.unlink(join(root, "missing")));

  // utimes/lutimes: Date, number and string times, an invalid time, and
  // the missing-path error.
  const when = new Date(1_700_000_000_000);
  await run("utimes-date", () => fsp.utimes(file, when, when));
  await run("utimes-number", () => fsp.utimes(file, 1_700_000_000, 1_700_000_000));
  await run("utimes-string", () => fsp.utimes(file, "2023-11-14T22:13:20.000Z", when));
  await run("utimes-nan", () => fsp.utimes(file, Number.NaN, when));
  await run("utimes-baddate", () => fsp.utimes(file, new Date(Number.NaN), when));
  await run("utimes-missing", () => fsp.utimes(join(root, "missing"), when, when));
  await run("lutimes-link", () => fsp.lutimes(join(root, "link.txt"), when, when));
  await run("lutimes-frac", () => fsp.lutimes(file, 1.5, when));

  // statfs: the documented fields, bigint form, and a missing path.
  await run("statfs", async () => {
    const s = await fsp.statfs(root);
    return `${s.type}:${typeof s.bsize}:${s.blocks > 0}`;
  });
  await run("statfs-bigint", async () => {
    const s = await fsp.statfs(root, { bigint: true });
    return `${typeof s.type}:${typeof s.bsize}`;
  });
  await run("statfs-missing", () => fsp.statfs(join(root, "missing")));
}

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
