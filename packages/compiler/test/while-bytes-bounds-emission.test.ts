import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-while-bounds-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, {
      outDir: dir,
      outPath,
      outputKind: "llvm",
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The body of `name`'s definition: the borrowed-argument one when there is
 * one, else the plain one. */
function body(ll: string, name: string): string {
  const definition = (prefix: string): number =>
    ll.search(new RegExp(`define [^\\n]*@${prefix}_${name}\\(`));
  const start = definition("sc_bf") >= 0 ? definition("sc_bf") : definition("sc_f");
  expect(start).toBeGreaterThanOrEqual(0);
  return ll.slice(start, ll.indexOf("\n}\n", start));
}

/** The number of bounds-checked element reads and writes in a function. */
function checks(ll: string, name: string): number {
  return body(ll, name).split("label %bytes.index.valid").length - 1;
}

/** Checked element reads classified by the consumer of the byte they load:
 * `fadd` for the read whose byte is added to the running total, `fcmp` for
 * the one the nested loop's condition compares. A versioned loop emits two
 * copies of the body, and this counts the copies of a read by what consumes
 * it, so a copy that lost its check is visible without counting labels. */
function checkedReads(ll: string, name: string, use: "fadd" | "fcmp"): number {
  const fn = body(ll, name);
  const marker = "label %bytes.index.valid";
  let count = 0;
  for (let at = fn.indexOf(marker); at >= 0; at = fn.indexOf(marker, at + 1)) {
    const rest = fn.slice(at);
    const add = rest.indexOf("fadd double");
    const compare = rest.indexOf("fcmp oeq");
    if (add < 0 && compare < 0) continue;
    const consumer = compare < 0 || (add >= 0 && add < compare) ? "fadd" : "fcmp";
    if (consumer === use) count++;
  }
  return count;
}

test("reads from the end of a typed array in a while loop are proven in bounds", async () => {
  const ll = await emitLlvm(`
function code(c: number): number {
  switch (c) {
    case 65: return 84;
    case 84: return 65;
  }
  return 0;
}
function reversed(line: Uint8Array): number {
  const len = line.length;
  const right = len - 1;
  let i = 0;
  let total = 0;
  while (i < len) {
    let c = line[right - i]!;
    i++;
    if (c === 10) {
      if (i === len) break;
      c = line[right - i]!;
      i++;
    }
    total += code(c);
  }
  return total;
}
function pairs(values: Uint16Array): number {
  let i = 0;
  let total = 0;
  while (values.length > i) {
    i += 2;
    total += values[i - 2]!;
    if (i < values.length) total += values[values.length - 1 - i]!;
  }
  return total;
}
console.log(reversed(new Uint8Array([65, 10, 84])), pairs(new Uint16Array([1, 2, 3])));
`);
  expect(checks(ll, "reversed")).toBe(0);
  expect(checks(ll, "pairs")).toBe(0);
});

test("reads a while loop does not keep in bounds keep their checks", async () => {
  const ll = await emitLlvm(`
function inclusive(line: Uint8Array): number {
  const len = line.length;
  let i = 0;
  let total = 0;
  while (i <= len) {
    total += line[len - i]!;
    i++;
  }
  return total;
}
function unguarded(line: Uint8Array): number {
  const right = line.length - 1;
  let i = 0;
  let total = 0;
  while (i < line.length) {
    total += line[right - i]!;
    i++;
    total += line[right - i]!;
  }
  return total;
}
function ahead(values: Uint16Array): number {
  let i = 0;
  let total = 0;
  while (i < values.length) {
    i += 2;
    total += values[i - 1]!;
  }
  return total;
}
function nested(line: Uint8Array): number {
  const len = line.length;
  let i = 0;
  let total = 0;
  while (i < len) {
    const c = line[len - 1 - i]!;
    i++;
    while (i < len && line[len - 1 - i]! === c) i++;
    total += line[len - 1 - i]!;
  }
  return total;
}
function comma(line: Uint8Array): number {
  const len = line.length;
  let i = 0;
  let total = 0;
  while (i < len) {
    if ((i++, i > 0)) total += line[len - 1 - i]!;
    total += line[len - 1 - i]!;
  }
  return total;
}
console.log(
  comma(new Uint8Array(2)),
  inclusive(new Uint8Array(2)),
  unguarded(new Uint8Array(2)),
  ahead(new Uint16Array(3)),
  nested(new Uint8Array(3)),
);
`);
  // The increment in the comma expression is not a statement of the
  // body, so the loop has no bound and both reads keep their checks.
  expect(checks(ll, "comma")).toBe(2);
  expect(checks(ll, "inclusive")).toBe(1);
  // The read before the increment is in bounds; the one after it is not.
  expect(checks(ll, "unguarded")).toBe(1);
  expect(checks(ll, "ahead")).toBe(1);
  // The read before the nested loop is in bounds. The nested loop's
  // condition is not a bound, and the read after the loop can be at -1.
  // The outer loop is versioned for the nested condition's read, so its
  // body is emitted twice: the checked copy keeps both reads' checks, and
  // the proven copy keeps the read after the loop, which the guard cannot
  // bound (i can reach len and put the index at -1).
  expect(checks(ll, "nested")).toBe(3);
  // Both copies of the read after the loop still add a checked byte to the
  // total, and only the checked copy keeps the condition's read.
  expect(checkedReads(ll, "nested", "fadd")).toBe(2);
  expect(checkedReads(ll, "nested", "fcmp")).toBe(1);
});
