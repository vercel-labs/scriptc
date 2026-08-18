import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  FrontendInputTracker,
  frontendInputsStillMatch,
  trackedAccessibleEntries,
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
