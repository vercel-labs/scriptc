// @normalize-pid
// fs/promises' directory and file mutation operations: the documented
// option forms (encoding, mode, flag, flush, signal, recursive, retry
// knobs) and the errors each reports, with the temporary directory
// replaced so Node and the compiled binary compare byte-for-byte.
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "scr-fsp-mut-"));
// mkdtemp picks its own random suffix, so an error naming an attempted
// temporary directory masks the six characters and keeps the rest.
const shown = (text: string): string =>
  text
    .split(root)
    .join("<root>")
    .replace(/tmpb?-[A-Za-z0-9]{6}\b/g, (name) => `${name.slice(0, -6)}XXXXXX`);

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

  // appendFile: an encoding, a mode and a flag; bytes; a missing parent.
  await run("append-text", async () => {
    await fsp.appendFile(file, "!", { encoding: "utf8", mode: 0o600, flag: "a" });
    return await fsp.readFile(file, "utf8");
  });
  await run("append-bytes", async () => {
    await fsp.appendFile(file, new Uint8Array([46]), { flag: "a" });
    return (await fsp.readFile(file)).length;
  });
  await run("append-missing-parent", () => fsp.appendFile(join(root, "no/such.txt"), "x"));
  await run("append-bad-encoding", () => fsp.appendFile(file, "x", { encoding: "nope" as BufferEncoding }));
  await run("append-flush", async () => {
    await fsp.appendFile(file, "?", { flag: "a", flush: true });
    return (await fsp.readFile(file, "utf8")).length;
  });
  await run("append-aborted", () => {
    const controller = new AbortController();
    controller.abort();
    return fsp.appendFile(file, "x", { signal: controller.signal });
  });

  // copyFile: the exclusive mode, a missing source, a directory target.
  await run("copy-excl", async () => {
    await fsp.copyFile(file, join(root, "copy.txt"), fs.constants.COPYFILE_EXCL);
    return (await fsp.readFile(join(root, "copy.txt"), "utf8")).length;
  });
  await run("copy-exists", () => fsp.copyFile(file, join(root, "copy.txt"), fs.constants.COPYFILE_EXCL));
  await run("copy-missing", () => fsp.copyFile(join(root, "missing"), join(root, "x.txt")));
  await run("copy-onto-dir", () => fsp.copyFile(file, root));
  await run("copy-ficlone", async () => {
    await fsp.copyFile(file, join(root, "clone.txt"), fs.constants.COPYFILE_FICLONE);
    return (await fsp.readFile(join(root, "clone.txt"), "utf8")).length;
  });

  // writeFile: encoding, mode and flag, flush, an aborted signal, and a
  // missing parent.
  await run("write-options", async () => {
    await fsp.writeFile(join(root, "opt.txt"), "0123456789", {
      encoding: "utf8",
      mode: 0o640,
      flag: "w",
      flush: true,
    });
    const mode = (await fsp.stat(join(root, "opt.txt"))).mode & 0o777;
    return mode.toString(8);
  });
  await run("write-append-flag", async () => {
    await fsp.writeFile(join(root, "opt.txt"), "!", { flag: "a" });
    return (await fsp.readFile(join(root, "opt.txt"), "utf8")).length;
  });
  await run("write-bytes-flush", async () => {
    await fsp.writeFile(join(root, "bytes.bin"), new Uint8Array([1, 2, 3]), { flush: true });
    return (await fsp.readFile(join(root, "bytes.bin"))).length;
  });
  await run("write-aborted", () => {
    const controller = new AbortController();
    controller.abort();
    return fsp.writeFile(join(root, "aborted.txt"), "x", { signal: controller.signal });
  });
  await run("write-missing-parent", () => fsp.writeFile(join(root, "no/such.txt"), "x"));

  // mkdir: plain, recursive, a mode, and the existing-entry errors.
  await run("mkdir", () => fsp.mkdir(join(root, "one")));
  await run("mkdir-exists", () => fsp.mkdir(join(root, "one")));
  await run("mkdir-recursive", () => fsp.mkdir(join(root, "deep/a/b"), { recursive: true, mode: 0o750 }));
  await run("mkdir-recursive-exists", async () => {
    const made = await fsp.mkdir(join(root, "deep/a/b"), { recursive: true });
    return made === undefined;
  });
  await run("mkdir-nested-norec", () => fsp.mkdir(join(root, "deep/x/y")));
  await run("mkdir-octal-mode", async () => {
    await fsp.mkdir(join(root, "octal"), "750");
    return ((await fsp.stat(join(root, "octal"))).mode & 0o777).toString(8);
  });

  // mkdtemp: utf8 and Buffer answers, and a prefix whose parent is missing.
  await run("mkdtemp-text", async () => {
    const dir = await fsp.mkdtemp(join(root, "tmp-"));
    return dir.startsWith(join(root, "tmp-")) && dir.length > join(root, "tmp-").length;
  });
  await run("mkdtemp-buffer", async () => {
    const dir = await fsp.mkdtemp(join(root, "tmpb-"), { encoding: "buffer" });
    return Buffer.isBuffer(dir) && dir.toString("utf8").startsWith(join(root, "tmpb-"));
  });
  await run("mkdtemp-missing-parent", () => fsp.mkdtemp(join(root, "no/tmp-")));

  // opendir: bufferSize and encoding, reading to the end, a file, and a
  // closed Dir.
  await run("opendir-read", async () => {
    await fsp.writeFile(join(root, "seen.txt"), "x");
    const dir = await fsp.opendir(root, { bufferSize: 32, encoding: "utf8" });
    const names: string[] = [];
    for await (const entry of dir) names.push(entry.name);
    return names.sort().join(",");
  });
  await run("opendir-file", () => fsp.opendir(file));
  await run("opendir-closed", async () => {
    const dir = await fsp.opendir(root);
    await dir.close();
    await dir.close();
  });

  // open: flags and a missing path, then the handle's own reads and writes.
  await run("open-write", async () => {
    const handle = await fsp.open(join(root, "handle.txt"), "w", 0o600);
    try {
      const { bytesWritten } = await handle.write("abc", 0, "utf8");
      return bytesWritten;
    } finally {
      await handle.close();
    }
  });
  await run("open-read", async () => {
    const handle = await fsp.open(join(root, "handle.txt"), "r");
    try {
      const buffer = Buffer.alloc(8);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return `${bytesRead}:${buffer.toString("utf8", 0, bytesRead)}`;
    } finally {
      await handle.close();
    }
  });
  await run("open-missing", () => fsp.open(join(root, "missing"), "r"));
  await run("open-bad-flag", () => fsp.open(join(root, "flags.txt"), "pw"));
  await run("open-excl-exists", () => fsp.open(file, "wx"));

  // rmdir/rm: the non-empty error, recursive removal, force, and the retry
  // knobs' validation.
  await run("rmdir-nonempty", () => fsp.rmdir(join(root, "deep")));
  await run("rmdir-recursive", async () => {
    await fsp.rmdir(join(root, "deep"), { recursive: true, maxRetries: 1 });
    return fs.existsSync(join(root, "deep"));
  });
  await run("rmdir-missing", () => fsp.rmdir(join(root, "missing")));
  await run("rmdir-retry-delay", async () => {
    await fsp.mkdir(join(root, "rd"));
    return fsp.rmdir(join(root, "rd"), { recursive: true, maxRetries: 0, retryDelay: 5 });
  });
  await run("rm-dir-norec", async () => {
    await fsp.mkdir(join(root, "norec"));
    return fsp.rm(join(root, "norec"));
  });
  await run("rm-missing", () => fsp.rm(join(root, "missing")));
  await run("rm-force", async () => {
    await fsp.rm(join(root, "missing"), { force: true });
    return true;
  });
  await run("rm-tree", async () => {
    await fsp.mkdir(join(root, "tree/a"), { recursive: true });
    await fsp.writeFile(join(root, "tree/a/f.txt"), "x");
    await fsp.rm(join(root, "tree"), { recursive: true, force: true, maxRetries: 2, retryDelay: 1 });
    return fs.existsSync(join(root, "tree"));
  });
  await run("rm-bad-retries", async () => {
    await fsp.mkdir(join(root, "rt"));
    return fsp.rm(join(root, "rt"), { recursive: true, maxRetries: 1.5 });
  });
  await run("rm-bad-delay", () => fsp.rm(join(root, "rt2"), { retryDelay: -1 }));
  await run("rmdir-bad-retries", () => fsp.rmdir(join(root, "rt3"), { maxRetries: -1 }));
}

main().then(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
