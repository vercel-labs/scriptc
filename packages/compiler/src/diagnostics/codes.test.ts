import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DIAGNOSTIC_CODES, RESERVED_DIAGNOSTIC_CODES, RETIRED_DIAGNOSTIC_CODES } from "./codes.js";
import { FENCE_CODES, UNSUPPORTED } from "./diagnostic.js";

const here = import.meta.dirname;
const packagesDir = join(here, "../../..");
const codesSource = readFileSync(join(here, "codes.ts"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(e.parentPath, e.name));
}

// Every non-test source file that can name a code.
const sources = [
  ...sourceFiles(join(packagesDir, "compiler/src")),
  ...sourceFiles(join(packagesDir, "cli/src")),
]
  .filter((file) => file !== join(here, "codes.ts"))
  .map((file) => ({ file: file.slice(packagesDir.length), text: readFileSync(file, "utf8") }));

const active = new Set(Object.keys(DIAGNOSTIC_CODES));
const retired = new Set(Object.keys(RETIRED_DIAGNOSTIC_CODES));
const reserved = new Set(Object.keys(RESERVED_DIAGNOSTIC_CODES));

/** The keys of one table in codes.ts, as written (duplicates included). */
function writtenKeys(table: string): string[] {
  const start = codesSource.indexOf(`export const ${table} = {`);
  const end = codesSource.indexOf("\n}", start);
  return [...codesSource.slice(start, end).matchAll(/^ {2}(SC\d{4}):/gm)].map((m) => m[1]!);
}

test.each(["DIAGNOSTIC_CODES", "RETIRED_DIAGNOSTIC_CODES", "RESERVED_DIAGNOSTIC_CODES"])(
  "%s is written once per code, in numeric order",
  (table) => {
    const keys = writtenKeys(table);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual([...new Set(keys)].toSorted());
  },
);

test("a code is active, retired or reserved, never two of them", () => {
  for (const code of retired) expect(active.has(code) || reserved.has(code), code).toBe(false);
  for (const code of reserved) expect(active.has(code), code).toBe(false);
});

test("every code the sources name has a row in codes.ts", () => {
  const missing: string[] = [];
  for (const { file, text } of sources) {
    for (const [code] of text.matchAll(/\bSC\d{4}\b/g)) {
      if (!active.has(code) && !retired.has(code) && !reserved.has(code)) {
        missing.push(`${code} (${file})`);
      }
    }
  }
  expect(missing, "claim each code in packages/compiler/src/diagnostics/codes.ts").toEqual([]);
});

test("no source produces a retired code", () => {
  const produced: string[] = [];
  for (const { file, text } of sources) {
    for (const [, code] of text.matchAll(/["'`](SC\d{4})["'`]/g)) {
      if (retired.has(code!)) produced.push(`${code} (${file})`);
    }
  }
  expect(produced).toEqual([]);
});

test("every active code is used by some source", () => {
  const seen = new Set(sources.flatMap(({ text }) => text.match(/\bSC\d{4}\b/g) ?? []));
  const unused = [...active].filter((code) => !seen.has(code));
  expect(unused, "retire codes nothing produces any more").toEqual([]);
});

test("the construct tables only name active codes", () => {
  for (const code of [...Object.keys(UNSUPPORTED), ...Object.keys(FENCE_CODES)]) {
    expect(active.has(code), code).toBe(true);
  }
});

test("every band in use is documented in diagnostic.ts", () => {
  const header = readFileSync(join(here, "diagnostic.ts"), "utf8");
  for (const band of new Set([...active].map((code) => code[2]))) {
    expect(header, `SC${band}xxx`).toContain(`SC${band}xxx`);
  }
});
