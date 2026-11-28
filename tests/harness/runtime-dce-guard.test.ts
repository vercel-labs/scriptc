/* The runtime's pay-for-what-you-use floor.
 *
 * A program pays for the runtime units its own facts select, and no
 * others: a compiled program's link line comes from the lowered module's
 * features (executableLinkFeatures), so a minimal program must not select
 * scr_abort.c, the event-target unit or the symbol unit. This reads the
 * unit list off the external link recipe the compiler publishes
 * (`nativeLinkInfo`, the same answer `--print native-link-info` shows), so
 * it is linker- and platform-independent; a stripped-size ceiling in
 * scripts/runtime-size-budget.json is the backstop that catches byte
 * growth no unit list explains (the URL and path units, for instance, are
 * still loose objects on every link line, so only bytes show whether the
 * sections that used them are gone).
 *
 * The http and AbortController programs on the other side prove the
 * selectors still select: a program that reads IncomingMessage's signal
 * through a computed key keeps the abort units (T1-1), and constructing an
 * AbortController outside http keeps them too. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/runtime-dce-guard");
const budgetPath = join(repoRoot, "scripts/runtime-size-budget.json");

const TARGET = "linux-x64-gnu";
// The pack the compiler links against on this host, and the recipe it
// publishes for it: both exist only in a checkout that built the Linux x64
// runtime pack.
const available =
  process.platform === "linux" &&
  process.arch === "x64" &&
  (() => {
    try {
      statSync(join(repoRoot, "packages/runtime-linux-x64-gnu/runtime-pack.json"));
      return true;
    } catch {
      return false;
    }
  })();

/** A fixture and the runtime units its link must (or must not) name. The
 * patterns match object basenames: `scr_url.o`, `scr_event_target.o`, and
 * so on. `forbidden` grows as each Tier 1 change lands; the units named
 * here are the ones the size claim is made of. */
interface Fixture {
  id: string;
  entry: string;
  forbidden: readonly RegExp[];
  required?: readonly RegExp[];
}

const FIXTURES: readonly Fixture[] = [
  {
    id: "hello",
    entry: "tests/harness/fixtures/runtime-dce/hello.ts",
    // A string-printing program uses no abort, event-target, symbol or
    // http unit, and never inspects a value. (The URL and path units are
    // still passed on every link line as loose base objects; cutting that
    // list is a separate change.)
    forbidden: [
      /^scr_abort\.o$/,
      /^scr_event_target\.o$/,
      /^scr_events_emitter\.o$/,
      /^scr_symbol\.o$/,
      /^scr_http\.o$/,
      /^scr_tls\.o$/,
      /^scr_inspect\.o$/,
    ],
  },
  {
    id: "n-body",
    entry: "benchmarks/runtime/workloads/n-body.ts",
    // Typed arithmetic and console output: no abort, event target,
    // symbol, http or inspect unit.
    forbidden: [
      /^scr_abort\.o$/,
      /^scr_event_target\.o$/,
      /^scr_events_emitter\.o$/,
      /^scr_symbol\.o$/,
      /^scr_http\.o$/,
      /^scr_tls\.o$/,
      /^scr_inspect\.o$/,
    ],
  },
  {
    id: "dynamic-properties",
    entry: "benchmarks/runtime/workloads/dynamic-properties.mjs",
    // Checked-dynamic property reads: T1-1 drops the abort, event-target,
    // emitter, handle and symbol units (only http's message has a signal
    // the dyn handle dispatches). T1-2's URL/path win is byte-level, so
    // the stripped-size ceiling below is its guard.
    forbidden: [
      /^scr_abort\.o$/,
      /^scr_event_target\.o$/,
      /^scr_events_emitter\.o$/,
      /^scr_dyn_handle\.o$/,
      /^scr_symbol\.o$/,
      /^scr_assert\.o$/,
      /^scr_http\.o$/,
      /^scr_tls\.o$/,
    ],
  },
  {
    id: "http-signal",
    entry: "tests/corpus/runtime-dce-http-signal-dynamic.cjs",
    forbidden: [],
    // node:http plus a computed key read keeps the abort unit (and the
    // symbol/emitter units its LINK_FEATURE_REQUIREMENTS pull in).
    required: [/^scr_abort\.o$/, /^scr_event_target\.o$/, /^scr_symbol\.o$/, /^scr_http\.o$/],
  },
  {
    id: "abort-controller",
    entry: "tests/corpus/runtime-dce-abort-controller.ts",
    forbidden: [],
    // AbortController outside http still selects the abort unit.
    required: [/^scr_abort\.o$/],
  },
  {
    id: "inspect-stack",
    entry: "tests/corpus/runtime-dce-inspect-stack-cwd.ts",
    forbidden: [],
    // The program inspects a colored stack and builds a file URL: the
    // inspect and URL units still exist and are still selected when a
    // program uses them (the guard's patterns name real objects).
    required: [/^scr_inspect\.o$/, /^scr_url\.o$/, /^scr_path\.o$/],
  },
];

interface Budget {
  note: string;
  allowance: { percent: number; bytes: number };
  targets: Record<string, Record<string, number>>;
}

function readBudget(): Budget {
  return JSON.parse(readFileSync(budgetPath, "utf8")) as Budget;
}

const describeDce = available ? describe : describe.skip;

describeDce("the runtime pays for what a program uses", () => {
  const budget = available ? readBudget() : null;
  const linkUnits = new Map<string, string[]>();

  for (const fixture of FIXTURES) {
    test(`${fixture.id} selects the units its facts name`, async () => {
      const outDir = join(cacheDir, fixture.id);
      const result = await compile(join(repoRoot, fixture.entry), {
        outPath: join(outDir, "program.o"),
        outDir,
        outputKind: "obj",
        nativeLinkInfo: true,
        optimization: "release",
      });
      if (!result.ok)
        throw new Error(
          `${fixture.id}: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}`,
        );
      const info = result.artifact.nativeLinkInfo;
      if (info === undefined) throw new Error(`${fixture.id}: no native link info`);
      const units = info.runtime_pack.objects.map((object) => object.path.split("/").pop()!);
      linkUnits.set(fixture.id, units);
      const selected = (pattern: RegExp) => units.filter((unit) => pattern.test(unit));
      for (const pattern of fixture.forbidden)
        expect(selected(pattern), `${fixture.id} must not select ${pattern}`).toEqual([]);
      for (const pattern of fixture.required ?? [])
        expect(selected(pattern).length, `${fixture.id} must select ${pattern}`).toBeGreaterThan(0);
    });
  }

  test("the stripped executables stay within their recorded ceiling", async () => {
    for (const fixture of FIXTURES) {
      const outDir = join(cacheDir, `${fixture.id}-exe`);
      const result = await compile(join(repoRoot, fixture.entry), {
        outPath: join(outDir, fixture.id),
        outDir,
        optimization: "release",
        strip: true,
      });
      if (!result.ok)
        throw new Error(
          `${fixture.id}: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}`,
        );
      const size = statSync(result.binaryPath).size;
      const recorded = budget!.targets[TARGET]?.[fixture.id];
      expect(recorded, `${fixture.id} has no recorded size in ${budgetPath}`).toBeTypeOf("number");
      const ceiling =
        recorded +
        Math.max(budget!.allowance.bytes, Math.round((recorded * budget!.allowance.percent) / 100));
      expect(
        size,
        `${fixture.id} stripped executable is ${size} B, past ${recorded} B + allowance (${ceiling} B); record the new size in ${budgetPath} only with the change that grows it`,
      ).toBeLessThanOrEqual(ceiling);
    }
  });
});

// A typo in a pattern (scr_urls.o) would make a forbidden check pass
// forever, so every pattern must name an object the release pack ships.
test.skipIf(!available)("the guard's patterns name objects the release pack ships", () => {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, "packages/runtime-linux-x64-gnu/runtime-pack.json"), "utf8"),
  ) as { flavors: Record<string, { runtime_units: { source: string }[] }> };
  const shipped = new Set(
    manifest.flavors["release"]!.runtime_units.map((unit) => unit.source.replace(/\.c$/, ".o")),
  );
  expect(shipped.size).toBeGreaterThan(0);
  for (const fixture of FIXTURES)
    for (const pattern of [...fixture.forbidden, ...(fixture.required ?? [])])
      expect(
        [...shipped].some((unit) => pattern.test(unit)),
        `${pattern} names no object the release pack ships`,
      ).toBe(true);
});
