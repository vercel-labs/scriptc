/* SCRIPTC_UNITS=split's cold half (M1-3): a split build is a whole-program
 * build — the design's fallback — so its LLVM is byte-identical to a plain
 * build's, and it stores each non-app unit's lowered IR under the unit's key.
 * The stored slice must decode with the IR codec and name nothing it does not
 * hold, or a warm build would splice incomplete IR. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { decodeModuleBinary } from "../../packages/compiler/src/ir/codec.js";
import { missingUnitIrReferences } from "../../packages/compiler/src/units/ir.js";

const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/corpus/2447-island-boundary-slots/main.ts");
const work = mkdtempSync(join(tmpdir(), "scriptc-units-split-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Compile with `mode`, returning the LLVM text written and the `scriptc
 * units` line. `cacheDir` lets two builds share one store (a cold build and
 * the warm build after it); by default each build has its own. */
async function build(
  mode: "plain" | "split",
  name: string = mode,
  cacheDir: string = join(work, name),
): Promise<{ llvm: string; line: string | null }> {
  const cache = cacheDir;
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const out = join(work, `${name}.ll`);
  const lines: string[] = [];
  const write = process.stderr.write;
  const previousCache = process.env["SCRIPTC_CACHE_DIR"];
  const previousUnits = process.env["SCRIPTC_UNITS"];
  process.env["SCRIPTC_CACHE_DIR"] = cache;
  if (mode === "split") process.env["SCRIPTC_UNITS"] = "split";
  else delete process.env["SCRIPTC_UNITS"];
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.startsWith("scriptc units ")) {
      lines.push(text);
      return true;
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await compile(entry, {
      outputKind: "llvm",
      outPath: out,
      outDir: work,
      optimization: "dev",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics[0]));
    return { llvm: readFileSync(out, "utf8"), line: lines[0] ?? null };
  } finally {
    process.stderr.write = write;
    if (previousCache === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
    else process.env["SCRIPTC_CACHE_DIR"] = previousCache;
    if (previousUnits === undefined) delete process.env["SCRIPTC_UNITS"];
    else process.env["SCRIPTC_UNITS"] = previousUnits;
  }
}

test("a split build's output matches a plain build's and it stores unit IR", async () => {
  const plain = await build("plain");
  expect(plain.line).toBeNull();
  const split = await build("split");
  expect(split.line).not.toBeNull();
  expect(split.llvm).toBe(plain.llvm);

  const report = JSON.parse(split.line!.slice("scriptc units ".length)) as {
    entries: { id: string; app: boolean; ir: { bytes: number; functions: number } | null }[];
  };
  const stored = report.entries.filter((entry) => !entry.app);
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.every((entry) => entry.ir !== null)).toBe(true);
  // The app's functions are regenerated every build, so the app stores none.
  expect(report.entries.filter((entry) => entry.app).every((entry) => entry.ir === null)).toBe(
    true,
  );

  const store = join(work, "split", "units-v2");
  let slices = 0;
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = join(store, entry.name, "meta.json");
    let parsed: { ir?: { digest: string } };
    try {
      parsed = JSON.parse(readFileSync(meta, "utf8")) as { ir?: { digest: string } };
    } catch {
      continue;
    }
    if (parsed.ir === undefined) continue;
    const bytes = readFileSync(join(store, entry.name, "ir.bin"));
    expect(bytes.length).toBeGreaterThan(0);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(parsed.ir.digest);
    const module = decodeModuleBinary(bytes);
    expect(missingUnitIrReferences(module)).toEqual([]);
    expect(module.functions.length).toBeGreaterThan(0);
    slices++;
  }
  expect(slices).toBe(stored.length);
});

test("a second split build in the same store is the fallback and still matches plain", async () => {
  // Until the warm path lands, every split build lowers the whole program —
  // the design's fallback — so the build after a cold one must still produce
  // the plain build's LLVM, while its entries report that a later build would
  // find them.
  const plain = await build("plain", "plain-warm");
  const store = join(work, "shared");
  await build("split", "split-cold", store);
  const warm = await build("split", "split-warm", store);
  expect(warm.llvm).toBe(plain.llvm);
  const report = JSON.parse(warm.line!.slice("scriptc units ".length)) as {
    entries: { app: boolean; wouldHit: boolean | null }[];
  };
  const units = report.entries.filter((entry) => !entry.app);
  expect(units.length).toBeGreaterThan(0);
  expect(units.every((entry) => entry.wouldHit === true)).toBe(true);
});
