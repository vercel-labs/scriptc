import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { jsonValueEnd } from "../src/frontend/ts7/semantic-json.js";

const sources = join(import.meta.dirname, "../native");
const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";

/** jsonValueEnd's result, or -1 where it throws. */
function expectedEnd(bytes: Uint8Array, start: number): number {
  try {
    return jsonValueEnd(bytes, start);
  } catch {
    return -1;
  }
}

/** A deterministic generator, so a failing case can be reproduced. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const ALPHABET = ["{", "}", "[", "]", '"', "\\", ",", " ", "\n", "\t", "a", "1", "n", ":", "é"];

function cases(): { bytes: Uint8Array; start: number }[] {
  const next = random(1);
  const out: { bytes: Uint8Array; start: number }[] = [];
  const texts = [
    "",
    '""',
    '"unclosed',
    '"\\"',
    '"\\\\"',
    '"a\\"b"',
    '"\\\\\\""',
    "null",
    "null,",
    "123 ",
    '{"id":1}',
    '{"id":1,"name":"a}b"}',
    '[{"id":1},null,{"id":2,"declarations":["1.2./a.ts","3.4./b \\"c\\".ts"]}]',
    '{"id":1,"nested":{"list":[1,{"x":"]"}]}}, next',
    "{",
    "[[]",
    "}",
    "]",
    ",",
    " ",
  ];
  for (const text of texts) {
    const bytes = Buffer.from(text, "utf8");
    for (let start = 0; start <= bytes.length; start++) out.push({ bytes, start });
  }
  for (let n = 0; n < 4000; n++) {
    let text = "";
    const length = Math.floor(next() * 40);
    for (let k = 0; k < length; k++) text += ALPHABET[Math.floor(next() * ALPHABET.length)];
    const bytes = Buffer.from(text, "utf8");
    out.push({ bytes, start: Math.floor(next() * (bytes.length + 1)) });
  }
  const reply = JSON.stringify(
    Array.from({ length: 200 }, (_, id) =>
      id % 7 === 0
        ? null
        : { id, name: `name ${id} "q" \\ {[`, declarations: [`${id}.80./src/a ${id}.ts`] },
    ),
  );
  const bytes = Buffer.from(reply, "utf8");
  for (let start = 0; start < bytes.length; start += 3) out.push({ bytes, start });
  return out;
}

/** The native scanner's results for `all`, from a harness built in `dir`. */
function nativeEnds(
  dir: string,
  all: { bytes: Uint8Array; start: number }[],
  timeout?: number,
): number[] {
  const harness = join(dir, "scan" + (process.platform === "win32" ? ".exe" : ""));
  execFileSync("clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(process.env["SCRIPTC_SAN"] === "1" ? ["-fsanitize=address,undefined"] : []),
    join(sources, "ts7-json.test.c"),
    join(sources, "ts7-process.c"),
    "-o",
    harness,
  ]);
  const chunks: Buffer[] = [];
  for (const { bytes, start } of all) {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(bytes.length, 0);
    header.writeUInt32LE(start, 4);
    chunks.push(header, Buffer.from(bytes));
  }
  const output = execFileSync(harness, {
    input: Buffer.concat(chunks),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(timeout === undefined ? {} : { timeout }),
  });
  return output.trim().split(/\r?\n/).map(Number);
}

test("the native scanner finds the value ends jsonValueEnd finds", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-json-"));
  try {
    const all = cases();
    const actual = nativeEnds(dir, all);
    expect(actual.length).toBe(all.length);
    for (let k = 0; k < all.length; k++) {
      const { bytes, start } = all[k]!;
      const expected = expectedEnd(bytes, start);
      if (actual[k] !== expected)
        expect({ text: Buffer.from(bytes).toString("utf8"), start, end: actual[k] }).toEqual({
          text: Buffer.from(bytes).toString("utf8"),
          start,
          end: expected,
        });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the native scanner reads strings with many escapes in one pass", () => {
  const dir = mkdtempSync(join(tempRoot, "scriptc-ts7-json-"));
  try {
    // Strings of 2,000,000 escapes each: newlines, backslashes and quotes,
    // alone and as a member of an object.
    const strings = ["\\n", "\\\\", '\\"'].map((escape) => `"${escape.repeat(2_000_000)}"`);
    const all = [
      ...strings.map((text) => ({ bytes: Buffer.from(text, "utf8"), start: 0 })),
      ...strings.map((text) => ({ bytes: Buffer.from(`{"value":${text}},1`, "utf8"), start: 0 })),
    ];
    // A scan that searched for the closing quote again after each escape
    // would take minutes here.
    const actual = nativeEnds(dir, all, 60_000);
    expect(actual).toEqual(all.map(({ bytes, start }) => expectedEnd(bytes, start)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
