import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RuntimePackError } from "../runtime-pack-core.js";
import { stageImportBitcode, stageImportBitcodeSync } from "./import-bitcode.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const ORIGINAL = Buffer.from("original bitcode");
const SWAPPED = Buffer.from("tampered bitcode");

/** A pack directory holding one bitcode artifact, its manifest entry, and a
 * private staging directory. */
function pack(bytes: Buffer) {
  const root = mkdtempSync(join(tmpdir(), "scriptc-bitcode-pack-"));
  const stage = mkdtempSync(join(tmpdir(), "scriptc-bitcode-stage-"));
  directories.push(root, stage);
  const artifact = {
    path: "artifacts/speed/runtime/default/scr_map.import.bc",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  mkdirSync(join(root, "artifacts/speed/runtime/default"), { recursive: true });
  writeFileSync(join(root, artifact.path), bytes);
  return { root, stage, artifact };
}

test("a selected bitcode artifact is staged as a private verified copy", async () => {
  const { root, stage, artifact } = pack(ORIGINAL);
  const [staged] = await stageImportBitcode(root, [artifact], stage);
  expect(staged).toBeDefined();
  expect(readFileSync(staged!)).toEqual(ORIGINAL);
  expect(statSync(staged!).mode & 0o777).toBe(0o400);
  expect(staged!.startsWith(stage)).toBe(true);
});

test("a same-size bitcode file swapped after selection fails the build", async () => {
  const { root, stage, artifact } = pack(ORIGINAL);
  expect(SWAPPED.length).toBe(ORIGINAL.length);
  writeFileSync(join(root, artifact.path), SWAPPED);
  expect(() => stageImportBitcodeSync(root, [artifact], stage)).toThrow(RuntimePackError);
  await expect(stageImportBitcode(root, [artifact], stage)).rejects.toThrow(RuntimePackError);
});

test("a bitcode file of the wrong size fails the build", () => {
  const { root, stage, artifact } = pack(ORIGINAL);
  writeFileSync(join(root, artifact.path), Buffer.from("short"));
  expect(() => stageImportBitcodeSync(root, [artifact], stage)).toThrow(/wrong size/);
});

test("a missing bitcode file fails the build", async () => {
  const { root, stage, artifact } = pack(ORIGINAL);
  rmSync(join(root, artifact.path));
  expect(() => stageImportBitcodeSync(root, [artifact], stage)).toThrow(/missing/);
  await expect(stageImportBitcode(root, [artifact], stage)).rejects.toThrow(/missing/);
});
