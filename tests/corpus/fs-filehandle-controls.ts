// FileHandle's control members: sync/datasync, truncate (the omitted and
// fractional lengths), chmod, readv/writev over several buffers, utimes
// (numbers, Dates and numeric strings), and the fd property. Each checks a
// closed handle first (EBADF, "file closed"), and the numeric arguments run
// Node's validateInteger ladder.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "filehandle-controls-"));
const file = join(dir, "data.txt");
fs.writeFileSync(file, "0123456789");

async function report(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    const value = await action();
    console.log(label, JSON.stringify(value === undefined ? "ok" : value));
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log(label, JSON.stringify([err.code ?? null, err.message.split(dir).join("<dir>")]));
  }
}

async function main(): Promise<void> {
  const h = await fsp.open(file, "r+");
  await report("sync", () => h.sync());
  await report("datasync", () => h.datasync());
  await report("truncate omitted", async () => (await h.truncate(), (await h.stat()).size));
  await report("truncate 3", async () => (await h.truncate(3), (await h.stat()).size));
  await report("truncate -1", () => h.truncate(-1));
  await report("truncate 1.5", () => h.truncate(1.5));
  await report("chmod", async () => ((await h.chmod(0o640)), (await h.stat()).mode & 0o777));
  await report("chmod -1", () => h.chmod(-1));
  await report("chmod 1.5", () => h.chmod(1.5));
  await report("writev", async () => {
    const result = await h.writev([Buffer.from("ab"), Buffer.from("cd")], 0);
    return [result.bytesWritten, (await h.stat()).size];
  });
  await report("readv", async () => {
    const buffers = [Buffer.alloc(2), Buffer.alloc(2)];
    const result = await h.readv(buffers, 0);
    return [result.bytesRead, buffers.map((b) => b.toString()).join("")];
  });
  await report("readv none", async () => (await h.readv([], 0)).bytesRead);
  await report("utimes numbers", async () => {
    await h.utimes(1000, 2000);
    const s = await h.stat();
    return [s.atimeMs, s.mtimeMs];
  });
  await report("utimes dates", async () => {
    await h.utimes(new Date(3000), new Date(4000));
    const s = await h.stat();
    return [s.atimeMs, s.mtimeMs];
  });
  await report("utimes strings", async () => {
    await h.utimes("1500", "1600");
    const s = await h.stat();
    return [s.atimeMs, s.mtimeMs];
  });
  await report("utimes invalid", () => h.utimes("zz", 0));
  await report("fd", async () => typeof h.fd === "number" && h.fd >= 3);
  await h.close();
  await report("fd after close", async () => typeof h.fd);
  await report("sync closed", () => h.sync());
  await report("datasync closed", () => h.datasync());
  await report("truncate closed", () => h.truncate(1));
  await report("chmod closed", () => h.chmod(0o600));
  await report("readv closed", () => h.readv([Buffer.alloc(1)], 0));
  await report("utimes closed", () => h.utimes(1, 2));
  await report("stat closed", async () => ((await h.stat()), "stats"));
  fs.rmSync(dir, { recursive: true, force: true });
}

await main();
