import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDeterministicArchive } from "../scripts/archive.mjs";
import { installRuntimePack, withBuildLock } from "../scripts/build-state.mjs";

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
  test("serializes concurrent pack builders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-build-lock-"));
    dirs.push(dir);
    const lock = join(dir, "build.lock");
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = withBuildLock(lock, async () => {
      events.push("first:start");
      firstStarted();
      await firstMayFinish;
      events.push("first:end");
    }, { retryMilliseconds: 5 });
    await firstDidStart;
    const second = withBuildLock(lock, async () => {
      events.push("second:start");
      events.push("second:end");
    }, { retryMilliseconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("installs a staged pack over the previous complete pair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-build-install-"));
    dirs.push(dir);
    const outputRoot = join(dir, "artifacts");
    const manifestPath = join(dir, "runtime-pack.json");
    const stagedOutputRoot = join(dir, "stage", "artifacts");
    const stagedManifestPath = join(dir, "stage", "runtime-pack.json");
    await Promise.all([mkdir(outputRoot), mkdir(stagedOutputRoot, { recursive: true })]);
    await Promise.all([
      writeFile(join(outputRoot, "runtime.o"), "old object"),
      writeFile(manifestPath, "old manifest"),
      writeFile(join(stagedOutputRoot, "runtime.o"), "new object"),
      writeFile(stagedManifestPath, "new manifest"),
    ]);

    await installRuntimePack({
      outputRoot,
      manifestPath,
      stagedOutputRoot,
      stagedManifestPath,
      backupRoot: join(dir, "artifacts.backup"),
      backupManifestPath: join(dir, "manifest.backup"),
    });

    expect(await readFile(join(outputRoot, "runtime.o"), "utf8")).toBe("new object");
    expect(await readFile(manifestPath, "utf8")).toBe("new manifest");
    expect(await stat(join(dir, "artifacts.backup")).then(() => true, () => false)).toBe(false);
  });

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
