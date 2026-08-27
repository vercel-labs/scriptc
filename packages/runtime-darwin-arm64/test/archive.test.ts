import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDeterministicArchive } from "../scripts/archive.mjs";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.runIf(process.platform === "darwin")("runtime-pack archives", () => {
  test("ignore input timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-archive-"));
    dirs.push(dir);
    const member = join(dir, "member.o");
    const first = join(dir, "first.a");
    const second = join(dir, "second.a");
    await writeFile(member, "runtime-pack archive member\n");

    await utimes(member, new Date(1_000), new Date(1_000));
    await createDeterministicArchive("ar", first, [member]);
    await utimes(member, new Date(2_000), new Date(2_000));
    await createDeterministicArchive("ar", second, [member]);

    expect(await readFile(second)).toEqual(await readFile(first));
  });
});
