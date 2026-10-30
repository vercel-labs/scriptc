import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile } from "../src/index.js";

// Programs whose units add the entries unit records carry (lifted closures
// and helpers, interned helper names, statement counts, generic demands,
// virtual edges) and grow tables that leave a unit without a record (new
// records and unions, generic instances, key-order notes).
const PROGRAMS = [
  "1003-json-parse-unions.ts",
  "1200-regex-test-basics.ts",
  "1304-errors-uncaught.ts",
  "1573-tdz-scalar-forward-capture.ts",
  "1631-inspect-arrays.ts",
  "4900-console-instances.ts",
  "5047-generator-delegation-iterables-typed.ts",
  "5390-interface-loop-element-lifetimes.ts",
  "6496-key-order-built-and-parsed.ts",
  "6916-index-record-spread-overrides.ts",
  "6951-unknown-cast-class-methods.ts",
  // Units without records rebuild a shared helper in place.
  "class-computed-key-descriptors.ts",
];

async function lower(program: string, dir: string, label: string): Promise<string> {
  const entry = join(import.meta.dirname, "../../../tests/corpus", program);
  const outPath = join(dir, `${program}.${label}.ir.json`);
  const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return readFile(outPath, "utf8");
}

afterEach(() => {
  delete process.env["SCRIPTC_LOWER_JOURNAL"];
});

test("units that keep what their records carry give the IR lowering gives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-recorded-lowering-"));
  try {
    for (const program of PROGRAMS) {
      delete process.env["SCRIPTC_LOWER_JOURNAL"];
      const plain = await lower(program, dir, "plain");
      process.env["SCRIPTC_LOWER_JOURNAL"] = "serial";
      const recorded = await lower(program, dir, "recorded");
      expect(recorded, program).toBe(plain);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("two builds of a program write the same records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-recorded-lowering-dump-"));
  try {
    const dumps: string[] = [];
    for (const label of ["first", "second"]) {
      process.env["SCRIPTC_LOWER_JOURNAL_DUMP"] = join(dir, label);
      await lower("1573-tdz-scalar-forward-capture.ts", dir, label);
      dumps.push(await readFile(join(dir, label, "records.jsonl"), "utf8"));
    }
    expect(dumps[0]!.length).toBeGreaterThan(0);
    expect(dumps[1]).toBe(dumps[0]);
    for (const line of dumps[0]!.trimEnd().split("\n"))
      expect(typeof (JSON.parse(line) as { name: unknown }).name).toBe("string");
  } finally {
    delete process.env["SCRIPTC_LOWER_JOURNAL_DUMP"];
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

/** The reasons in a program's records that leave units without one. */
async function recordReasons(program: string, dir: string): Promise<Set<string>> {
  process.env["SCRIPTC_LOWER_JOURNAL_DUMP"] = join(dir, program);
  try {
    await lower(program, dir, "dump");
  } finally {
    delete process.env["SCRIPTC_LOWER_JOURNAL_DUMP"];
  }
  const reasons = new Set<string>();
  for (const line of (await readFile(join(dir, program, "records.jsonl"), "utf8"))
    .trimEnd()
    .split("\n"))
    for (const reason of (JSON.parse(line) as { reasons?: string[] }).reasons ?? [])
      reasons.add(reason);
  return reasons;
}

test("units that register reachable units or add class fields have no record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-recorded-lowering-reasons-"));
  try {
    // A function-local class registers its members as reachable units.
    expect(await recordReasons("5945-local-class-observed-methods.ts", dir)).toContain(
      "unitRegistrations",
    );
    // Object.freeze of a class instance adds the class's integrity field.
    expect(await recordReasons("6004-class-instance-integrity.ts", dir)).toContain(
      "classLayoutChanges",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
