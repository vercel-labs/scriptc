import { execFile, execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = import.meta.dirname;
const bin = join(testDir, "build", "test_intl_utf16");

// The ICU unit's WTF-8 decode (scr_intl_utf16.h), built with ASan so a
// unit written past the count it reports fails the run.
beforeAll(async () => {
  await mkdir(join(testDir, "build"), { recursive: true });
  await execFileAsync("clang", [
    "-std=c11",
    "-O1",
    "-Wall",
    "-Wextra",
    "-fsanitize=address",
    "-I",
    join(testDir, "../src"),
    "-o",
    bin,
    join(testDir, "test_intl_utf16.c"),
  ]);
}, 120_000);

const CASES: number[][] = [
  [0x61, 0x62],
  [0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80],
  [0x61, 0xff, 0x62],
  [0xc0, 0xaf],
  [0xc1, 0xbf, 0x41],
  [0xe0, 0x80, 0x80],
  [0xe0, 0x9f, 0xbf],
  [0xf0, 0x80, 0x80, 0x41],
  [0xf0, 0x8f, 0xbf, 0xbf],
  [0xf4, 0x90, 0x80, 0x80],
  [0xf5, 0x80, 0x80, 0x80],
  [0x80, 0xbf, 0x20],
  [0xe2, 0x82],
  [0xe2, 0x82, 0x41],
  [0xf0, 0x9f, 0x98],
  [0xf0, 0x9f],
  [0xc3],
  [0x74, 0x72, 0x75, 0x6e, 0x63, 0xe2, 0x82],
  [0x67, 0x6f, 0xff, 0xe0, 0x80, 0x77, 0x6f],
];

/** A WTF-8 lone surrogate (ED A0..BF xx) decodes to its unit, and its
 * truncated prefix is one maximal subpart; every other sequence decodes as
 * Node's TextDecoder decodes it. */
const SURROGATES: [number[], string][] = [
  [[0x73, 0xed, 0xa0, 0x80, 0x78], "0073 d800 0078"],
  [[0xed, 0xbf, 0xbf], "dfff"],
  [[0xed, 0xa0], "fffd"],
];

function hexUnits(text: string): string {
  return [...Array(text.length).keys()]
    .map((i) => text.charCodeAt(i).toString(16).padStart(4, "0"))
    .join(" ");
}

test("malformed sequences decode to U+FFFD as Node's UTF-8 decoder does, and the count is the units written", () => {
  const all = [...CASES, ...SURROGATES.map(([bytes]) => bytes)];
  const input = all.map((bytes) => Buffer.from(bytes).toString("hex")).join("\n") + "\n";
  const lines = execFileSync(bin, [], { input, encoding: "utf8" }).trimEnd().split("\n");
  const decoder = new TextDecoder();
  expect(lines).toEqual([
    ...CASES.map((bytes) => hexUnits(decoder.decode(Uint8Array.from(bytes)))),
    ...SURROGATES.map(([, units]) => units),
  ]);
});
