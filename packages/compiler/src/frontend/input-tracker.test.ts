import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  FrontendInputTracker,
  frontendInputsStillMatch,
  trackedAccessibleEntries,
  trackedDirectoryExists,
  trackedFileExists,
  trackedReadFile,
  validFrontendInputSnapshot,
} from "./input-tracker.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
