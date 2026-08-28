import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDeterministicArchive } from "../scripts/archive.mjs";

const dirs: string[] = [];

function memberMetadata(bytes: Buffer) {
  const entries: { timestamp: string; uid: string; gid: string; mode: string }[] = [];
  let offset = Buffer.byteLength("!<arch>\n");
  while (offset < bytes.length) {
    const size = Number(bytes.subarray(offset + 48, offset + 58).toString("ascii").trim());
    entries.push({
      timestamp: bytes.subarray(offset + 16, offset + 28).toString("ascii").trim(),
      uid: bytes.subarray(offset + 28, offset + 34).toString("ascii").trim(),
      gid: bytes.subarray(offset + 34, offset + 40).toString("ascii").trim(),
      mode: bytes.subarray(offset + 40, offset + 48).toString("ascii").trim(),
    });
    offset += 60 + size + (size % 2);
  }
  return entries;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.runIf(process.platform === "darwin")("runtime-pack archives", () => {
  test("normalize timestamps, ownership, and modes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-archive-"));
    dirs.push(dir);
    const member = join(dir, "member.o");
    const first = join(dir, "first.a");
    const second = join(dir, "second.a");
    await writeFile(member, "runtime-pack archive member\n");

    await chmod(member, 0o600);
    await utimes(member, new Date(1_000), new Date(1_000));
    await createDeterministicArchive("ar", first, [member]);
    await utimes(member, new Date(2_000), new Date(2_000));
    await createDeterministicArchive("ar", second, [member]);

    const firstBytes = await readFile(first);
    expect(await readFile(second)).toEqual(firstBytes);
    const metadata = memberMetadata(firstBytes);
    expect(metadata.length).toBeGreaterThanOrEqual(1);
    expect(metadata.every((entry) =>
      entry.timestamp === "0" && entry.uid === "0" && entry.gid === "0" &&
      entry.mode === "100644"
    )).toBe(true);
  });
});
