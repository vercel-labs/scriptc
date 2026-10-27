import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  FrontendInputTracker,
  frontendInputsSemanticallyMatch,
  frontendInputsStillMatch,
  trackedAccessibleEntries,
  trackedDirectoryExists,
  trackedFileExists,
  markFrontendInputsUnstable,
  trackedReadFile,
  validFrontendInputSnapshot,
} from "./input-tracker.js";

const scratch: string[] = [];

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("semantic validation reads non-source dependencies once and still invalidates edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const dependency = join(dir, "dependency.d.ts");
  const previous = "export const answer = 1;\n";
  const current = `// comment\n${previous}`;
  await writeFile(source, previous);
  await writeFile(dependency, "export declare const value: number;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(source);
    trackedReadFile(dependency);
  });
  const snapshot = tracker.snapshot();
  await writeFile(source, current);
  const reads = vi.mocked(fs.readFileSync);
  reads.mockClear();
  const equivalent = vi.fn(() => true);
  const sources = new Map([[source, previous]]);

  const result = frontendInputsSemanticallyMatch(snapshot, sources, equivalent);
  expect(result?.currentSources).toEqual(new Map([[source, current]]));
  expect(result?.changed).toEqual([{ path: source, previous, current }]);
  expect(equivalent).toHaveBeenCalledExactlyOnceWith(source, previous, current);
  expect(reads.mock.calls.filter(([path]) => path === dependency)).toHaveLength(1);

  await writeFile(dependency, "export declare const value: string;\n");
  reads.mockClear();
  expect(frontendInputsSemanticallyMatch(snapshot, sources, equivalent)).toBeNull();
  expect(reads.mock.calls.filter(([path]) => path === dependency)).toHaveLength(1);
});

test("an equivalent edit of a file whose raw text the frontend read does not match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  const previous = "export const answer = 1;\n";
  await writeFile(source, previous);
  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    trackedReadFile(source);
    tracker.record({ op: "text", path: source });
  });
  const snapshot = tracker.snapshot();
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  await writeFile(source, `// comment\n${previous}`);
  const equivalent = vi.fn(() => true);
  expect(
    frontendInputsSemanticallyMatch(snapshot, new Map([[source, previous]]), equivalent),
  ).toBeNull();
  expect(equivalent).not.toHaveBeenCalled();
});

test("tracked frontend reads invalidate on byte edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const file = join(dir, "entry.ts");
  await writeFile(file, "export const answer = 1;\n");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedReadFile(file)).toContain("answer"));
  const snapshot = tracker.snapshot();
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await writeFile(file, "export const answer = 2;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed frontend reads invalidate when the same file becomes readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const file = join(dir, "unreadable.ts");
  await writeFile(file, "export const repaired = true;\n");
  await chmod(file, 0o000);

  const tracker = new FrontendInputTracker();
  const result = tracker.run(() => trackedReadFile(file));
  if (result !== null) {
    // Windows and privileged test users may not enforce POSIX mode bits.
    await chmod(file, 0o600);
    return;
  }
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "read-error", path: file });
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await chmod(file, 0o600);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed resolution candidates invalidate when a file appears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const candidate = join(dir, "dependency.ts");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedFileExists(candidate)).toBe(false));
  const snapshot = tracker.snapshot();
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await writeFile(candidate, "export const loaded = true;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("a candidate appearing during the frontend prevents cache publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const candidate = join(dir, "dependency.ts");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedFileExists(candidate)).toBe(false));
  await writeFile(candidate, "export const loaded = true;\n");
  tracker.run(() => expect(trackedReadFile(candidate)).toContain("loaded"));

  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(false);
  expect(validFrontendInputSnapshot(snapshot)).toBe(false);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("an opaque host query can decline frontend cache publication", () => {
  const tracker = new FrontendInputTracker();
  tracker.run(() => markFrontendInputsUnstable());
  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(false);
  expect(validFrontendInputSnapshot(snapshot)).toBe(false);
});

test("directory enumeration invalidates workspace discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await mkdir(packages);

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedAccessibleEntries(packages)?.directories).toEqual([]));
  const snapshot = tracker.snapshot();
  await mkdir(join(packages, "new-member"));
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("compiler outputs do not invalidate a fresh output directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const generatedRoot = join(dir, "generated");
  const outDir = join(generatedRoot, "nested");
  const generated = join(outDir, "entry.lib.c");

  const tracker = new FrontendInputTracker();
  tracker.run(() => {
    expect(trackedAccessibleEntries(dir)?.directories).toEqual([]);
    expect(trackedDirectoryExists(generatedRoot)).toBe(false);
    expect(trackedDirectoryExists(outDir)).toBe(false);
    expect(trackedAccessibleEntries(outDir)).toBeNull();
  });
  const snapshot = tracker.snapshot();
  const exclusions = {
    outputPaths: [generated],
    outputDirectories: [dir, generatedRoot, outDir],
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(generated, "/* generated */\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(true);

  await writeFile(join(outDir, "new-source.ts"), "export const appeared = true;\n");
  expect(frontendInputsStillMatch(snapshot, exclusions)).toBe(false);
});

test("failed directory enumeration invalidates when the operation starts succeeding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await writeFile(packages, "not a directory\n");

  const tracker = new FrontendInputTracker();
  tracker.run(() => expect(trackedAccessibleEntries(packages)).toBeNull());
  const snapshot = tracker.snapshot();
  expect(snapshot.probes).toContainEqual({ op: "entries-error", path: packages });
  expect(frontendInputsStillMatch(snapshot)).toBe(true);

  await rm(packages);
  await mkdir(packages);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("failed directory enumeration invalidates when access is restored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const packages = join(dir, "packages");
  await mkdir(packages);
  await writeFile(join(packages, "member.ts"), "export const member = true;\n");
  await chmod(packages, 0o000);

  try {
    const tracker = new FrontendInputTracker();
    const result = tracker.run(() => trackedAccessibleEntries(packages));
    if (result !== null) return; // Windows and privileged users may ignore POSIX mode bits.

    const snapshot = tracker.snapshot();
    expect(snapshot.probes).toContainEqual({ op: "entries-error", path: packages });
    expect(frontendInputsStillMatch(snapshot)).toBe(true);

    await chmod(packages, 0o700);
    expect(frontendInputsStillMatch(snapshot)).toBe(false);
  } finally {
    await chmod(packages, 0o700);
  }
});

test("synchronous tracking restores parents after throws and propagates unstable inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const first = join(dir, "first.ts");
  const second = join(dir, "second.ts");
  await writeFile(first, "export const first = 1;");
  await writeFile(second, "export const second = 2;");
  const parent = new FrontendInputTracker();
  const child = new FrontendInputTracker();
  parent.runSynchronous(() => {
    expect(() =>
      child.runSynchronous(() => {
        trackedReadFile(first);
        markFrontendInputsUnstable();
        throw new Error("interrupted");
      }),
    ).toThrow("interrupted");
    trackedReadFile(second);
  });
  expect(
    parent
      .snapshot()
      .probes.filter((probe) => probe.op === "file")
      .map((probe) => probe.path),
  ).toEqual([first, second]);
  expect(parent.snapshot().stable).toBe(false);
  const before = parent.snapshot();
  trackedFileExists(join(dir, "outside.ts"));
  expect(parent.snapshot()).toEqual(before);
});

test("a settled file is checked by its identity, and any write invalidates it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const written = fs.statSync(source);
  // The file was last changed long enough before the read.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5000);
  const tracker = new FrontendInputTracker();
  try {
    tracker.run(() => trackedReadFile(source));
  } finally {
    vi.useRealTimers();
  }
  const snapshot = tracker.snapshot();
  const probe = snapshot.probes.find((entry) => entry.op === "file");
  expect(probe?.op === "file" && probe.identity !== undefined).toBe(true);
  expect(validFrontendInputSnapshot(snapshot)).toBe(true);
  const reads = vi.mocked(fs.readFileSync);
  reads.mockClear();
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  expect(reads.mock.calls.filter(([path]) => path === source)).toHaveLength(0);
  // A same-size rewrite that restores the modification time still changes
  // the change time.
  await writeFile(source, "export const answer = 2;\n");
  fs.utimesSync(source, written.atime, written.mtime);
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("a settled file an earlier run read keeps that run's digest until it is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const settledRead = (tracker: FrontendInputTracker, later: number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + later);
    try {
      tracker.runSynchronous(() => trackedReadFile(source));
    } finally {
      vi.useRealTimers();
    }
    const probe = tracker.snapshot().probes.find((entry) => entry.op === "file");
    return probe?.op === "file" ? probe : undefined;
  };
  const first = settledRead(new FrontendInputTracker(), 5000)!;
  expect(first.identity).toBeDefined();
  // A digest only the previous snapshot holds shows it was not computed again.
  const marker = "f".repeat(64);
  const previous = { version: 1 as const, stable: true, probes: [{ ...first, digest: marker }] };
  expect(settledRead(new FrontendInputTracker(previous), 5000)?.digest).toBe(marker);
  await writeFile(source, "export const answer = 2;\n");
  const rewritten = settledRead(new FrontendInputTracker(previous), 10000);
  expect(rewritten?.identity).not.toBe(first.identity);
  expect(rewritten?.digest).toBe(
    createHash("sha256").update("export const answer = 2;\n").digest("hex"),
  );
});

test("a file changed shortly before the read is hashed on every check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(source));
  const snapshot = tracker.snapshot();
  const probe = snapshot.probes.find((entry) => entry.op === "file");
  expect(probe?.op === "file" && probe.identity).toBeUndefined();
  const reads = vi.mocked(fs.readFileSync);
  reads.mockClear();
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  expect(reads.mock.calls.filter(([path]) => path === source)).toHaveLength(1);
});

test("a read before and a read after a file settles record one probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  // The first read comes right after the write, the second once the file
  // has been unchanged long enough for its identity to stand for it.
  tracker.run(() => trackedReadFile(source));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5000);
  try {
    tracker.run(() => trackedReadFile(source));
  } finally {
    vi.useRealTimers();
  }
  const snapshot = tracker.snapshot();
  expect(snapshot.stable).toBe(true);
  const probe = snapshot.probes.find((entry) => entry.op === "file");
  expect(probe?.op === "file" && probe.identity !== undefined).toBe(true);
  expect(frontendInputsStillMatch(snapshot)).toBe(true);
  // The identity still invalidates the snapshot on any write.
  await writeFile(source, "export const answer = 2;\n");
  expect(frontendInputsStillMatch(snapshot)).toBe(false);
});

test("two reads of a file that saw different content prevent cache publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-inputs-"));
  scratch.push(dir);
  const source = join(dir, "entry.ts");
  await writeFile(source, "export const answer = 1;\n");
  const tracker = new FrontendInputTracker();
  tracker.run(() => trackedReadFile(source));
  await writeFile(source, "export const answer = 2;\n");
  tracker.run(() => trackedReadFile(source));
  expect(tracker.snapshot().stable).toBe(false);
});
