import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { joinedParts, textSlices, writeTextPartsSync } from "./text-file.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("text slices keep surrogate pairs whole and escape as the whole text does", () => {
  const text = 'ab😀cé😀😀\ud800x"\\\n' + "z".repeat(5);
  for (let length = 2; length <= 8; length++) {
    const slices = [...textSlices(text, length)];
    expect(slices.join("")).toBe(text);
    for (const slice of slices) {
      expect(slice.length).toBeLessThanOrEqual(length);
      const last = slice.charCodeAt(slice.length - 1);
      // A lone high surrogate of the text may end a slice; a pair's never does.
      if (last >= 0xd800 && last <= 0xdbff) expect(slice.endsWith("\ud800")).toBe(true);
    }
    expect(slices.map((slice) => JSON.stringify(slice).slice(1, -1)).join("")).toBe(
      JSON.stringify(text).slice(1, -1),
    );
  }
  expect([...textSlices("")]).toEqual([]);
});

test("a part larger than one slice is written as its UTF-8 bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-text-file-"));
  directories.push(dir);
  // A surrogate pair across the first slice boundary (1 MiB units).
  const large = "a".repeat(1024 * 1024 - 1) + "😀" + "b".repeat(1024 * 1024 + 3);
  const path = join(dir, "out.txt");
  const seen: string[] = [];
  writeTextPartsSync(path, ["head,", large, "", "tail"], (slice) => seen.push(slice));
  const expected = Buffer.from("head," + large + "tail", "utf8");
  expect(readFileSync(path).equals(expected)).toBe(true);
  expect(seen.join("")).toBe("head," + large + "tail");
  expect(Math.max(...seen.map((slice) => slice.length))).toBeLessThanOrEqual(1024 * 1024);
});

test("small parts join into batches and a long part passes through whole", () => {
  const small = Array.from({ length: 3000 }, (_, index) => `line ${index}\n`);
  const long = "x".repeat(2 * 1024 * 1024);
  const parts = [...small, long, "tail"];
  const joined = [...joinedParts(parts)];
  expect(joined.join("")).toBe(parts.join(""));
  expect(joined.length).toBeLessThan(5);
  expect(joined).toContain("tail");
});
