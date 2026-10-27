import { constants } from "node:buffer";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { readTextParts, writeTextParts } from "./text-parts.js";

const scratch = mkdtempSync(join(tmpdir(), "scriptc-text-parts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("parts join to the file's text, each within the part length", async () => {
  // Multi-byte sequences and surrogate pairs straddle the 1 MiB reads and
  // the 8-unit parts.
  const unit = "abéc中\u{1f600}d";
  const text = unit.repeat(90_000);
  const path = join(scratch, "mixed.ll");
  writeFileSync(path, text);
  const parts = await readTextParts(path, 8);
  expect(parts.join("")).toBe(text);
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(8);
    const last = part.charCodeAt(part.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  }
  // Each part encodes on its own, so writing them back reproduces the file.
  const copy = join(scratch, "copy.ll");
  await writeTextParts(copy, parts);
  expect(await readFile(copy, "utf8")).toBe(text);
});

test("an empty file has no parts", async () => {
  const path = join(scratch, "empty.ll");
  writeFileSync(path, "");
  expect(await readTextParts(path)).toEqual([]);
});

test("a file past the engine's string limit reads in parts", async () => {
  // A sparse file: its bytes are NUL characters, valid UTF-8, and cost no
  // disk space.
  const path = join(scratch, "huge.ll");
  const size = constants.MAX_STRING_LENGTH + 1;
  writeFileSync(path, "");
  truncateSync(path, size);
  await expect(readFile(path, "utf8")).rejects.toThrow(RangeError);
  const parts = await readTextParts(path);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.reduce((length, part) => length + part.length, 0)).toBe(size);
}, 120_000);
